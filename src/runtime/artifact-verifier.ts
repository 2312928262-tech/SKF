import { lstat, readFile } from 'node:fs/promises';
import { RuntimeError, type JSONValue } from './contracts.js';
import { openWorkspaceRoot, resolveWithinRoot, sha256HexBytes } from '../tools/safe-files.js';

/**
 * M05 · 可信验收器（02-CONTRACTS.md F.4 / 03-TASK-CARDS M05）。
 *
 * 验收由任务创建时可信调用方写入的 acceptance 定义，不由模型文本宣布。
 * file deliverable 核实：存在、相对路径范围、字节数、SHA-256，可加文本/JSON 检查。
 * 另外核对本任务已登记 artifact 与磁盘实物一致（ARTIFACT_STALE），
 * 防止「登记了成功但实物被改/不在」被当成完成。
 *
 * acceptance 形状（严格校验，多余字段拒绝）：
 * {
 *   "kind": "file_deliverable",
 *   "files": [{
 *     "path": "quote.md",              // 必填，任务 workspaceRoot 内相对路径
 *     "minBytes": 1,                   // 可选
 *     "maxBytes": 100000,              // 可选
 *     "sha256": "<64 hex>",            // 可选，精确内容钉死
 *     "mustContain": ["报价"],          // 可选，UTF-8 文本子串
 *     "mustBeJson": false              // 可选，要求可 JSON.parse
 *   }]
 * }
 */

export interface AcceptanceFileSpec {
  path: string;
  minBytes?: number;
  maxBytes?: number;
  sha256?: string;
  mustContain?: string[];
  mustBeJson?: boolean;
}

export interface AcceptanceSpec {
  kind: 'file_deliverable';
  files: AcceptanceFileSpec[];
}

export interface VerificationFailure {
  path: string;
  code: string;
  detail: string;
}

export interface VerifiedFile {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface VerificationOutcome {
  ok: boolean;
  failures: VerificationFailure[];
  verified: VerifiedFile[];
}

const ACCEPTANCE_FILE_FIELDS = new Set(['path', 'minBytes', 'maxBytes', 'sha256', 'mustContain', 'mustBeJson']);

/** 严格解析 acceptance；形状非法抛 ACCEPTANCE_INVALID（创建任务的可信调用方写错了，不是模型问题）。 */
export function parseAcceptance(raw: JSONValue): AcceptanceSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeError('ACCEPTANCE_INVALID', 'object expected');
  }
  const obj = raw as Record<string, JSONValue>;
  for (const key of Object.keys(obj)) {
    if (key !== 'kind' && key !== 'files') throw new RuntimeError('ACCEPTANCE_INVALID', `unknown field ${key}`);
  }
  if (obj.kind !== 'file_deliverable') throw new RuntimeError('ACCEPTANCE_INVALID', `kind ${String(obj.kind)}`);
  if (!Array.isArray(obj.files) || obj.files.length < 1 || obj.files.length > 32) {
    throw new RuntimeError('ACCEPTANCE_INVALID', 'files must be 1..32 entries');
  }
  const files: AcceptanceFileSpec[] = obj.files.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}] object expected`);
    }
    const rec = entry as Record<string, JSONValue>;
    for (const key of Object.keys(rec)) {
      if (!ACCEPTANCE_FILE_FIELDS.has(key)) throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}] unknown field ${key}`);
    }
    if (typeof rec.path !== 'string' || rec.path.length === 0 || rec.path.length > 1024) {
      throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}].path`);
    }
    const spec: AcceptanceFileSpec = { path: rec.path };
    for (const bound of ['minBytes', 'maxBytes'] as const) {
      const value = rec[bound];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}].${bound}`);
        }
        spec[bound] = value;
      }
    }
    if (spec.minBytes !== undefined && spec.maxBytes !== undefined && spec.minBytes > spec.maxBytes) {
      throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}] minBytes > maxBytes`);
    }
    if (rec.sha256 !== undefined) {
      if (typeof rec.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(rec.sha256)) {
        throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}].sha256`);
      }
      spec.sha256 = rec.sha256;
    }
    if (rec.mustContain !== undefined) {
      if (!Array.isArray(rec.mustContain) || rec.mustContain.length > 16 || rec.mustContain.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 4096)) {
        throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}].mustContain`);
      }
      spec.mustContain = rec.mustContain as string[];
    }
    if (rec.mustBeJson !== undefined) {
      if (typeof rec.mustBeJson !== 'boolean') throw new RuntimeError('ACCEPTANCE_INVALID', `files[${index}].mustBeJson`);
      spec.mustBeJson = rec.mustBeJson;
    }
    return spec;
  });
  return { kind: 'file_deliverable', files };
}

/** 给模型看的验收要求文本（任务目标的一部分；判定仍以 verifyAcceptance 为准）。 */
export function describeAcceptance(spec: AcceptanceSpec): string {
  const lines = spec.files.map((file) => {
    const parts = [`- ${file.path}`];
    if (file.minBytes !== undefined) parts.push(`至少 ${file.minBytes} 字节`);
    if (file.maxBytes !== undefined) parts.push(`至多 ${file.maxBytes} 字节`);
    if (file.sha256) parts.push(`SHA-256 必须等于 ${file.sha256}`);
    if (file.mustContain?.length) parts.push(`必须包含文本: ${file.mustContain.map((s) => JSON.stringify(s)).join(', ')}`);
    if (file.mustBeJson) parts.push('必须是合法 JSON');
    return parts.join('；');
  });
  return ['交付验收（以磁盘实物核验为准，文本声称不算完成）：', ...lines].join('\n');
}

async function verifyOneFile(rootReal: string, spec: AcceptanceFileSpec): Promise<{ ok: boolean; failures: VerificationFailure[]; verified?: VerifiedFile }> {
  const failures: VerificationFailure[] = [];
  let resolved: { relativePath: string; absolutePath: string };
  try {
    resolved = await resolveWithinRoot(rootReal, spec.path);
  } catch (error) {
    return { ok: false, failures: [{ path: spec.path, code: 'ACCEPTANCE_PATH_INVALID', detail: error instanceof RuntimeError ? error.code : 'resolve failed' }] };
  }
  const st = await lstat(resolved.absolutePath).catch(() => null);
  if (!st) return { ok: false, failures: [{ path: spec.path, code: 'FILE_MISSING', detail: 'not found on disk' }] };
  if (st.isDirectory()) return { ok: false, failures: [{ path: spec.path, code: 'NOT_A_FILE', detail: 'is a directory' }] };
  const buf = await readFile(resolved.absolutePath);
  const sha256 = sha256HexBytes(buf);
  if (spec.minBytes !== undefined && buf.length < spec.minBytes) {
    failures.push({ path: spec.path, code: 'BYTES_BELOW_MIN', detail: `${buf.length} < ${spec.minBytes}` });
  }
  if (spec.maxBytes !== undefined && buf.length > spec.maxBytes) {
    failures.push({ path: spec.path, code: 'BYTES_ABOVE_MAX', detail: `${buf.length} > ${spec.maxBytes}` });
  }
  if (spec.sha256 !== undefined && sha256 !== spec.sha256) {
    failures.push({ path: spec.path, code: 'HASH_MISMATCH', detail: `${sha256.slice(0, 12)}… != ${spec.sha256.slice(0, 12)}…` });
  }
  if (spec.mustContain?.length) {
    const text = buf.toString('utf8');
    for (const needle of spec.mustContain) {
      if (!text.includes(needle)) failures.push({ path: spec.path, code: 'CONTENT_MISSING', detail: `missing ${JSON.stringify(needle.slice(0, 80))}` });
    }
  }
  if (spec.mustBeJson) {
    try {
      JSON.parse(buf.toString('utf8'));
    } catch {
      failures.push({ path: spec.path, code: 'INVALID_JSON', detail: 'JSON.parse failed' });
    }
  }
  if (failures.length) return { ok: false, failures };
  return { ok: true, failures, verified: { path: resolved.relativePath, byteLength: buf.length, sha256 } };
}

/**
 * 核验 acceptance + 已登记 artifact 的磁盘实物。artifact 来自 runtime.sqlite（只读），
 * 登记行与实物不一致 = ARTIFACT_STALE（成功登记后实物被改/删，不能当完成）。
 */
export async function verifyAcceptance(opts: {
  workspaceRoot: string;
  acceptance: AcceptanceSpec;
  artifacts: Array<{ relativePath: string; byteLength: number; sha256: string }>;
}): Promise<VerificationOutcome> {
  const { rootReal } = await openWorkspaceRoot(opts.workspaceRoot);
  const failures: VerificationFailure[] = [];
  const verified: VerifiedFile[] = [];
  for (const spec of opts.acceptance.files) {
    const result = await verifyOneFile(rootReal, spec);
    failures.push(...result.failures);
    if (result.verified) verified.push(result.verified);
  }
  for (const artifact of opts.artifacts) {
    try {
      const resolved = await resolveWithinRoot(rootReal, artifact.relativePath);
      const st = await lstat(resolved.absolutePath).catch(() => null);
      if (!st || st.isDirectory()) {
        failures.push({ path: artifact.relativePath, code: 'ARTIFACT_STALE', detail: 'registered artifact missing on disk' });
        continue;
      }
      const buf = await readFile(resolved.absolutePath);
      if (sha256HexBytes(buf) !== artifact.sha256 || buf.length !== artifact.byteLength) {
        failures.push({ path: artifact.relativePath, code: 'ARTIFACT_STALE', detail: 'registered artifact content changed on disk' });
      }
    } catch (error) {
      failures.push({ path: artifact.relativePath, code: 'ARTIFACT_STALE', detail: error instanceof RuntimeError ? error.code : 'verify failed' });
    }
  }
  return { ok: failures.length === 0, failures, verified };
}
