import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { RuntimeError } from '../runtime/contracts.js';

/**
 * M04 · 有边界的文件访问（02-CONTRACTS.md E 节）。
 * 路径 canonicalize 后核对真实父路径；拒绝穿越 / UNC / 设备路径 / junction / symlink 逃逸。
 * 写入走 临时文件 → fsync → 提交前复核旧 hash → 原子替换 → 读回校验。
 * 首版是个人应用路径防护，不是 OS sandbox：恶意进程的句柄级竞态不在本层承诺范围内。
 */

const WINDOWS = process.platform === 'win32';

/** 组件级 DOS 设备名（NUL、CON、COM1…），无论扩展名一律拒绝。 */
const DOS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sha256HexBytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256HexBytes(await readFile(path));
}

/** 任务创建时由可信调用方固定 root；realpath 一次，后续所有校验以真实根为准。 */
export async function openWorkspaceRoot(root: string): Promise<{ rootReal: string }> {
  if (typeof root !== 'string' || root.length === 0 || root.length > 1024) {
    throw new RuntimeError('PATH_ROOT_INVALID', 'workspaceRoot');
  }
  let rootReal: string;
  try {
    rootReal = await realpath(resolve(root));
  } catch {
    throw new RuntimeError('PATH_ROOT_MISSING', 'workspaceRoot');
  }
  return { rootReal };
}

function startsInside(rootReal: string, candidate: string): boolean {
  const rootCmp = WINDOWS ? rootReal.toLowerCase() : rootReal;
  const candCmp = WINDOWS ? candidate.toLowerCase() : candidate;
  return candCmp === rootCmp || candCmp.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep);
}

/**
 * 把模型给的 absolute/relative 输入路径 canonicalize 到 root 内。
 * - 拒绝：NUL、UNC（\\ 或 // 开头）、设备路径（\\.\ \\?\）、盘符相对路径（C:foo）、DOS 设备名组件；
 * - 越界：resolve 后不在 rootReal 内 → PATH_OUTSIDE_ROOT；
 * - 逃逸：最近已存在祖先（写入时）或目标自身（存在时）的 realpath 不在 rootReal 内
 *   → PATH_OUTSIDE_ROOT（junction/symlink 指向 root 外）。
 * 返回 root 内相对路径（统一 posix 分隔，供 artifact 登记）与待操作的绝对路径。
 */
export async function resolveWithinRoot(
  rootReal: string,
  inputPath: string,
  opts: { forWrite?: boolean } = {},
): Promise<{ relativePath: string; absolutePath: string }> {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 1024) {
    throw new RuntimeError('PATH_INVALID', 'path');
  }
  if (inputPath.includes(String.fromCharCode(0))) throw new RuntimeError('PATH_INVALID', 'NUL');
  if (inputPath.startsWith('\\\\') || inputPath.startsWith('//')) {
    throw new RuntimeError('PATH_UNC', inputPath.slice(0, 32));
  }
  if (/^[a-zA-Z]:(?![\\/])/.test(inputPath)) {
    // C:foo 盘符相对路径，实际目标取决于每盘符 cwd，不可判定 → 拒绝
    throw new RuntimeError('PATH_INVALID', 'drive-relative');
  }
  const candidate = resolve(rootReal, inputPath);
  if (!startsInside(rootReal, candidate)) throw new RuntimeError('PATH_OUTSIDE_ROOT', inputPath.slice(0, 64));

  for (const segment of relative(rootReal, candidate).split(sep)) {
    if (DOS_DEVICE_NAME.test(segment)) throw new RuntimeError('PATH_DEVICE', segment);
  }

  // 真实父路径核对：找最近已存在祖先做 realpath，任一 junction/symlink 指到 root 外即拒绝。
  // 祖先与 candidate 之间尚不存在的层级由我们 mkdir 创建，不存在被替换为链接的窗口。
  let probe = opts.forWrite ? dirname(candidate) : candidate;
  for (;;) {
    if (!startsInside(rootReal, probe)) throw new RuntimeError('PATH_OUTSIDE_ROOT', inputPath.slice(0, 64));
    try {
      const probeReal = await realpath(probe);
      if (!startsInside(rootReal, probeReal)) throw new RuntimeError('PATH_OUTSIDE_ROOT', `link escape: ${inputPath.slice(0, 64)}`);
      break;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw new RuntimeError('PATH_NOT_FOUND', inputPath.slice(0, 64));
      probe = parent;
    }
  }

  const rel = relative(rootReal, candidate).split(sep).join('/');
  return { relativePath: rel, absolutePath: candidate };
}

export interface AtomicWriteOptions {
  rootReal: string;
  inputPath: string;
  content: Buffer;
  /** 缺省 = create-only；覆盖已有文件必须等于当前内容 hash，否则 HASH_CONFLICT。 */
  expectedSha256?: string;
  /** 测试注入：提交前复核的时机钩子，用于模拟并行修改竞态。不暴露在工具参数里。 */
  hooks?: { beforeCommit?: (targetAbsolutePath: string) => void | Promise<void> };
}

export interface AtomicWriteResult {
  relativePath: string;
  sha256: string;
  byteLength: number;
  created: boolean;
}

/**
 * 原子写 + 校验：
 * 1) 目标已存在：create-only → FILE_EXISTS；hash 不符 → HASH_CONFLICT（保护用户并行修改）。
 * 2) 同目录临时文件（唯一名）写入 + fsync。
 * 3) 提交前复核目标 hash/存在性没变（beforeCommit 钩子给测试注入竞态）。
 * 4) rename 原子替换（同卷）；读回校验 sha256 与字节数，不符报 WRITE_VERIFY_FAILED。
 * 任何失败路径清理临时文件；绝不留下半截目标文件，也不登记 artifact。
 */
export async function atomicWriteVerified(opts: AtomicWriteOptions): Promise<AtomicWriteResult> {
  const { rootReal, content } = opts;
  if (opts.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(opts.expectedSha256)) {
    throw new RuntimeError('TOOL_ARGS_INVALID', 'expectedSha256');
  }
  const { relativePath, absolutePath } = await resolveWithinRoot(rootReal, opts.inputPath, { forWrite: true });
  const contentHash = sha256HexBytes(content);

  const existing = await lstat(absolutePath).catch(() => null);
  if (existing) {
    if (existing.isDirectory()) throw new RuntimeError('PATH_NOT_FILE', relativePath);
    if (opts.expectedSha256 === undefined) throw new RuntimeError('FILE_EXISTS', relativePath);
    const current = await sha256File(absolutePath);
    if (current !== opts.expectedSha256) throw new RuntimeError('HASH_CONFLICT', relativePath);
  }

  const parent = dirname(absolutePath);
  await mkdir(parent, { recursive: true });
  const tempPath = `${parent}${sep}.skf-tmp-${randomUUID()}.tmp`;

  const cleanup = async () => {
    await rm(tempPath, { force: true }).catch(() => {});
  };

  try {
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(content);
      await handle.sync(); // fsync：落盘后才允许替换目标
    } finally {
      await handle.close();
    }

    if (opts.hooks?.beforeCommit) await opts.hooks.beforeCommit(absolutePath);

    // 提交前复核：目标状态必须与初次检查一致，否则是并行修改，放弃本次写入。
    const recheck = await lstat(absolutePath).catch(() => null);
    if (opts.expectedSha256 === undefined) {
      if (recheck) throw new RuntimeError('HASH_CONFLICT', `${relativePath} appeared during write`);
    } else {
      if (!recheck || recheck.isDirectory()) throw new RuntimeError('HASH_CONFLICT', `${relativePath} removed during write`);
      const current = await sha256File(absolutePath);
      if (current !== opts.expectedSha256) throw new RuntimeError('HASH_CONFLICT', relativePath);
    }

    await rename(tempPath, absolutePath);

    const written = await readFile(absolutePath);
    if (written.length !== content.length || sha256HexBytes(written) !== contentHash) {
      throw new RuntimeError('WRITE_VERIFY_FAILED', relativePath);
    }
    return { relativePath, sha256: contentHash, byteLength: content.length, created: !existing };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
