/**
 * M17 · 进程启动白名单桥
 *
 * 真实实现：由 config/desktop-launch.json 提供白名单（executable basename + 可选 sha256）；
 * 启动器走 SKF 进程外子进程（spawn 后即脱离，不接管生命周期，与 M14 MCP JobLauncher 不同）。
 * 首版 Fake 模式：只记录调用 + 返回确定性 pid，永不真正 spawn。
 *
 * 红线：白名单为空 = 任何 launch 都被拒（LAUNCH_DENIED），不接受"默认全开"。
 * 启动调用本身：preSpawn 白名单校验 → hash 绑定（已在 ToolRegistry.execute 内）→ spawn → 返回 pid。
 * 取消/deadline：SKF 退出时 Fake 模式无进程可杀；真实现由调用方提供 signal。
 */

import { RuntimeError } from '../runtime/contracts.js';
import {
  LAUNCH_WHITELIST,
  MAX_LAUNCH_ARG_BYTES,
  MAX_LAUNCH_ARGS,
  type LaunchBridge,
  type LaunchHealthInfo,
  type LaunchOptions,
  type LaunchResult,
} from './contracts.js';

// ── 启动白名单条目 ─────────────────────────────────────────────────────

export interface LaunchWhitelistEntry {
  /** executable basename（不含路径）；首版仅按 basename 匹配，避免路径伪造。 */
  basename: string;
  /** 可选：sha256 of the executable（Hex, lower）；配置后启动前校验，未配置 = 仅按 basename 放行。 */
  expectedSha256?: string;
}

export function loadLaunchWhitelist(json: string | null | undefined): LaunchWhitelistEntry[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (error) {
    throw new RuntimeError('INVALID_CONFIG', `desktop-launch.json parse failed: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new RuntimeError('INVALID_CONFIG', 'desktop-launch.json must be array');
  const out: LaunchWhitelistEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new RuntimeError('INVALID_CONFIG', 'launch entry must be object');
    const obj = entry as Record<string, unknown>;
    if (typeof obj.basename !== 'string' || obj.basename.length === 0 || obj.basename.length > 64) {
      throw new RuntimeError('INVALID_CONFIG', 'launch entry basename invalid');
    }
    if (obj.basename.includes('/') || obj.basename.includes('\\')) {
      throw new RuntimeError('INVALID_CONFIG', 'launch entry basename must not contain path separator');
    }
    if (obj.expectedSha256 !== undefined) {
      if (typeof obj.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(obj.expectedSha256)) {
        throw new RuntimeError('INVALID_CONFIG', 'launch entry expectedSha256 must be 64-char hex');
      }
      out.push({ basename: obj.basename, expectedSha256: obj.expectedSha256 });
    } else {
      out.push({ basename: obj.basename });
    }
  }
  // 去重（basename 唯一）：保留首次出现。
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.basename) ? false : (seen.add(e.basename), true)));
}

// ── RealLauncherBridge（Windows 占位；首版未启用）──────────────────────

export class RealLauncherBridge implements LaunchBridge {
  constructor(private readonly whitelist: LaunchWhitelistEntry[] = []) {}

  async health(): Promise<LaunchHealthInfo> {
    return {
      state: this.whitelist.length > 0 ? 'ok' : 'no_whitelist',
      detail: this.whitelist.length > 0 ? null : 'desktop-launch.json empty or missing',
      whitelistSize: this.whitelist.length,
    };
  }

  async launch(_opts: LaunchOptions): Promise<LaunchResult> {
    // 首版不实际 spawn：仅做白名单校验 + 返回失败说明。
    // 真实部署需要单独的 helper + Job Object 进程树管理（与 MCP JobLauncher 同源）。
    throw new RuntimeError('LAUNCH_UNAVAILABLE', 'RealLauncherBridge not implemented in first release');
  }
}

// ── FakeLauncherBridge（测试/dev；记录调用 + 确定性 pid）────────────────

export class FakeLauncherBridge implements LaunchBridge {
  public readonly stats = { launch: 0 };
  /** 启动结果模拟器（按 executable basename 决定 status/pid）。 */
  private readonly simulator: Map<string, LaunchResult> = new Map();
  /** 健康状态（默认 ok 当白名单非空）。 */
  private readonly whitelist: LaunchWhitelistEntry[];

  constructor(whitelist: LaunchWhitelistEntry[] = []) {
    this.whitelist = whitelist;
  }

  setSimulated(basename: string, result: LaunchResult): void {
    this.simulator.set(basename, result);
  }

  /** 测试用：读取调用记录（顺序）。 */
  readonly calls: LaunchOptions[] = [];

  async health(): Promise<LaunchHealthInfo> {
    return {
      state: this.whitelist.length > 0 ? 'ok' : 'no_whitelist',
      detail: this.whitelist.length > 0 ? null : 'desktop-launch.json empty or missing',
      whitelistSize: this.whitelist.length,
    };
  }

  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    this.stats.launch += 1;
    this.calls.push({ ...opts, args: opts.args ?? [] });
    // 白名单校验：basename 必须匹配；optional sha256 跳过（Fake 无文件）。
    const base = basenameOf(opts.executable);
    const entry = this.whitelist.find((w) => w.basename === base);
    if (!entry) {
      return { status: 'denied', pid: null, detail: `executable ${base} not in whitelist` };
    }
    // 参数硬上限（不在这里拒绝，只记录——ToolRegistry.execute 已经做了 schema 校验）。
    if (opts.args && opts.args.length > MAX_LAUNCH_ARGS) {
      return { status: 'failed', pid: null, detail: `args > ${MAX_LAUNCH_ARGS}` };
    }
    for (const arg of opts.args ?? []) {
      if (Buffer.byteLength(arg, 'utf8') > MAX_LAUNCH_ARG_BYTES) {
        return { status: 'failed', pid: null, detail: `arg > ${MAX_LAUNCH_ARG_BYTES} bytes` };
      }
    }
    const sim = this.simulator.get(base) ?? { status: 'started', pid: 10000 + this.stats.launch, detail: null };
    return sim;
  }
}

function basenameOf(executable: string): string {
  // 兼容 Windows \\ 与 Unix / 路径分隔符；只取最后一段。
  const norm = executable.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 静态白名单常量（首版占位 — 测试用），可被 supervisor 注入覆盖。 */
export const DEFAULT_LAUNCH_WHITELIST: readonly string[] = LAUNCH_WHITELIST;
