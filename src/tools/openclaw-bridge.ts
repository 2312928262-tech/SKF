import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeError, type JSONValue } from '../runtime/contracts.js';
import type { ToolSpec } from './registry.js';

/**
 * M09 · OpenClaw 可选桥接（增强能力，不是启动依赖）。
 *
 * 纪律（03-TASK-CARDS M09 / 02-CONTRACTS E 节）：
 * - 注册为可选能力：启动绝不等待 OpenClaw；SKF_OPENCLAW_BRIDGE=0 完全关闭。
 * - readiness 失败清楚标 unavailable，负缓存 60s + 正缓存 10s，绝不进入
 *   重启/重连风暴（本模块没有任何自动重启/自动重试逻辑）。
 * - 增强工具逐个 typed schema + effect policy：首版只登记两个只读诊断工具
 *   （effect=read，零参数，严格 schema 拒绝一切多余字段）。发消息、浏览器、
 *   电脑操控、channels/cron/agents 变更等有外部副作用的能力一律不登记——
 *   它们是 external_write/process，必须等带参数 hash 绑定的审批适配器（M04
 *   语义）才可能开放。绝不做“一键透传所有 OpenClaw 工具”绕过 SKF 授权/记账。
 * - Windows：openclaw 是 npm 全局 .cmd，execFile 不能直接执行（CVE-2024-27980
 *   之后 .cmd 必须走 shell），因此经 ComSpec /d /s /c 调用固定字面量子命令。
 *   本模块只发起固定 argv（--version / status / health），没有任何模型可控参数。
 */

const execFileAsync = promisify(execFile);

const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_INVOKE_TIMEOUT_MS = 15_000;
const NEGATIVE_CACHE_MS = 60_000;
const POSITIVE_CACHE_MS = 10_000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_STDERR_NOTE = 300;

export type BridgeAvailability = 'available' | 'unavailable' | 'disabled' | 'unprobed';

export interface BridgeStatus {
  state: BridgeAvailability;
  /** 人类可读原因（不含环境全文/密钥）；available 时为 null。 */
  reason: string | null;
  /** `openclaw --version` 首行（截断）；未知为 null。 */
  version: string | null;
  checkedAt: string | null;
}

export interface OpenClawBridgeOptions {
  /** false = 完全关闭（SKF_OPENCLAW_BRIDGE=0），不发起任何探测进程。 */
  enabled?: boolean;
  /** 命令名/路径（默认 openclaw；测试指向临时假 CLI）。 */
  command?: string;
  probeTimeoutMs?: number;
  invokeTimeoutMs?: number;
  negativeCacheMs?: number;
  positiveCacheMs?: number;
  logger?: (line: string) => void;
}

interface CacheEntry {
  status: BridgeStatus;
  expiresAt: number;
}

const UNPROBED: BridgeStatus = { state: 'unprobed', reason: null, version: null, checkedAt: null };

export class OpenClawBridge {
  private readonly enabled: boolean;
  private readonly command: string;
  private readonly probeTimeoutMs: number;
  private readonly invokeTimeoutMs: number;
  private readonly negativeCacheMs: number;
  private readonly positiveCacheMs: number;
  private readonly logger?: (line: string) => void;
  private cache: CacheEntry | null = null;
  /** 实际发起的探测进程数（测试断言无重连风暴用）。 */
  private probeAttempts = 0;

  constructor(opts: OpenClawBridgeOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.command = opts.command ?? 'openclaw';
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.invokeTimeoutMs = opts.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    this.negativeCacheMs = opts.negativeCacheMs ?? NEGATIVE_CACHE_MS;
    this.positiveCacheMs = opts.positiveCacheMs ?? POSITIVE_CACHE_MS;
    this.logger = opts.logger;
  }

  get probeCount(): number {
    return this.probeAttempts;
  }

  /** 同步快照（不发起探测）：ping/capabilities 用；从未探测过 = unprobed。 */
  peek(): BridgeStatus {
    if (!this.enabled) {
      return { state: 'disabled', reason: 'SKF_OPENCLAW_BRIDGE=0', version: null, checkedAt: null };
    }
    return this.cache && this.cache.expiresAt > Date.now() ? this.cache.status : { ...UNPROBED };
  }

  /** 异步状态（必要时探测一次；负/正缓存内绝不重复发起）。 */
  async status(forceRefresh = false): Promise<BridgeStatus> {
    if (!this.enabled) {
      return { state: 'disabled', reason: 'SKF_OPENCLAW_BRIDGE=0', version: null, checkedAt: null };
    }
    if (!forceRefresh && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.status;
    }
    return this.probe();
  }

  /** 让缓存立即失效（仅测试/显式用户动作调用；常规路径不自动重试）。 */
  invalidate(): void {
    this.cache = null;
  }

  private async probe(): Promise<BridgeStatus> {
    this.probeAttempts++;
    const checkedAt = new Date().toISOString();
    try {
      const { stdout } = await this.spawn(['--version'], this.probeTimeoutMs);
      const version = stdout.split(/\r?\n/)[0]?.trim().slice(0, 80) || null;
      if (!version) throw new Error('empty --version output');
      const status: BridgeStatus = { state: 'available', reason: null, version, checkedAt };
      this.cache = { status, expiresAt: Date.now() + this.positiveCacheMs };
      return status;
    } catch (error) {
      const reason =
        (error as { code?: unknown })?.code === 'ENOENT'
          ? `OpenClaw CLI 未找到（${this.command}）`
          : (error as { killed?: unknown })?.killed === true || (error as { code?: unknown })?.code === 'ETIMEDOUT'
            ? `OpenClaw 探测超时（${this.probeTimeoutMs}ms）`
            : `OpenClaw 探测失败: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
      const status: BridgeStatus = { state: 'unavailable', reason, version: null, checkedAt };
      this.cache = { status, expiresAt: Date.now() + this.negativeCacheMs };
      return status;
    }
  }

  /** Windows 走 ComSpec 执行 .cmd；其余平台直接 execFile。args 只能是固定字面量。 */
  private spawn(args: readonly string[], timeoutMs: number) {
    if (process.platform === 'win32') {
      const comspec = process.env.ComSpec || 'cmd.exe';
      return execFileAsync(comspec, ['/d', '/s', '/c', this.command, ...args], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
    }
    return execFileAsync(this.command, [...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  }

  /** 已登记的增强工具名（逐个点名；这就是全部，没有透传）。 */
  knownTools(): string[] {
    return CURATED.map((tool) => tool.name);
  }

  /**
   * 逐个 typed schema + effect policy 的桥接工具面（装配进 ToolRegistry）。
   * 可用性在执行时复核：unavailable → TOOL_UNAVAILABLE，绝不模拟完成。
   */
  specs(): ToolSpec[] {
    return CURATED.map((tool) => ({
      name: tool.name,
      effect: 'read' as const,
      bridge: true,
      description: tool.description,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} } as JSONValue,
      fields: {},
      run: async (): Promise<{ content: JSONValue; artifactIds: string[] }> => {
        const status = await this.status();
        if (status.state !== 'available') {
          throw new RuntimeError('TOOL_UNAVAILABLE', `openclaw bridge ${status.state}: ${status.reason ?? 'not probed'}`);
        }
        return this.invoke(tool.name, tool.argv);
      },
    }));
  }

  private async invoke(name: string, argv: readonly string[]): Promise<{ content: JSONValue; artifactIds: string[] }> {
    try {
      const { stdout } = await this.spawn(argv, this.invokeTimeoutMs);
      const buf = Buffer.from(stdout, 'utf8');
      const truncated = buf.length > MAX_OUTPUT_BYTES;
      const output = buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
      this.logger?.(`bridge ${name} -> ok (${buf.length} bytes${truncated ? ', truncated' : ''})`);
      return {
        content: {
          tool: name,
          command: `openclaw ${argv.join(' ')}`,
          exitCode: 0,
          output,
          truncated,
        } as JSONValue,
        artifactIds: [],
      };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 'ENOENT') {
        // 探测说可用但二进制消失：失效缓存，下次调用重新探测（仍无重试循环）。
        this.invalidate();
        throw new RuntimeError('TOOL_UNAVAILABLE', 'openclaw bridge: binary vanished');
      }
      const killed = (error as { killed?: unknown })?.killed === true || code === 'ETIMEDOUT';
      if (killed) throw new RuntimeError('TOOL_UNAVAILABLE', `openclaw bridge: invoke timeout (${this.invokeTimeoutMs}ms)`);
      const stderrNote = String((error as { stderr?: unknown })?.stderr ?? '').slice(0, MAX_STDERR_NOTE);
      // 命令存在但执行失败（如 gateway 未运行）：如实上报，不假装成功。
      throw new RuntimeError('BRIDGE_COMMAND_FAILED', stderrNote || (error instanceof Error ? error.message : String(error)).slice(0, MAX_STDERR_NOTE));
    }
  }
}

/** 首版登记的只读诊断工具（effect=read，零参数）。新增任何有外部副作用的
 *  能力都必须走 approvals 参数 hash 绑定（M04），不得加进这个清单。 */
const CURATED: readonly { name: string; argv: readonly string[]; description: string }[] = [
  {
    name: 'openclaw.status',
    argv: ['status'],
    description:
      'Read-only diagnostic: show OpenClaw gateway/channel/model status as plain text. Optional capability; returns TOOL_UNAVAILABLE when the OpenClaw CLI/gateway is absent.',
  },
  {
    name: 'openclaw.health',
    argv: ['health'],
    description:
      'Read-only diagnostic: fetch health from the running OpenClaw gateway. Optional capability; returns TOOL_UNAVAILABLE or BRIDGE_COMMAND_FAILED when the gateway is not running.',
  },
];

/** 供 doctor 复用的一次性探测（不持有长缓存）。 */
export async function probeOnce(opts: OpenClawBridgeOptions = {}): Promise<BridgeStatus> {
  const bridge = new OpenClawBridge(opts);
  return bridge.status(true);
}
