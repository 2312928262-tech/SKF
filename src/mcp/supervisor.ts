import { spawn, type ChildProcess } from 'node:child_process';
import { RuntimeError, type JSONValue } from '../runtime/contracts.js';
import { JsonRpcPeer } from './jsonrpc.js';

/**
 * M14 · McpServerSupervisor：单个本地 stdio MCP server 的进程树生命周期。
 *
 * - Windows 进程树管理走 JobLauncher（Job Object KILL_ON_JOB_CLOSE）：
 *   启动器死/被杀 => 整棵树（含孙进程）由 OS 清理，绝不只靠 child.kill。
 * - 三段超时分离：start（进程拉起+管道就绪）/ handshake（initialize）/ call（单次 tools 调用）。
 * - 有上限指数退避重启 + 熔断：连续失败 maxRestartAttempts 次 => circuit_open，
 *   冷却期内的调用直接 MCP_CIRCUIT_OPEN（不起进程），冷却后允许一次半开试探。
 * - 重启 server ≠ 重放调用：崩溃时在途调用一律以 MCP_RESPONSE_LOST 拒绝；
 *   新实例握手成功后只接受新调用，历史调用由账本层（operation unknown + M07 人工核对）处理。
 * - server 自报的 protocolVersion/name/version 只作日志与协议协商记录，绝不用于命名与授权。
 */

export type McpSupervisorState =
  | 'stopped'
  | 'starting'
  | 'handshaking'
  | 'ready'
  | 'restarting'
  | 'circuit_open'
  | 'failed';

export interface McpServerTimeouts {
  startMs: number;
  handshakeMs: number;
  callMs: number;
}

export interface McpRestartPolicy {
  maxRestartAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 连续失败达到阈值 => 熔断。 */
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  /** 稳定运行超过该时长后，退避计数清零（健康 server 偶发崩溃不烧重启预算）。 */
  stableResetMs: number;
}

export const DEFAULT_MCP_TIMEOUTS: McpServerTimeouts = { startMs: 10_000, handshakeMs: 5_000, callMs: 30_000 };
export const DEFAULT_MCP_RESTART: McpRestartPolicy = {
  maxRestartAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
  stableResetMs: 30_000,
};

/** SKF 支持的 MCP 协议版本（initialize 协商白名单）。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpSupervisorDeps {
  /** JobLauncher.exe 绝对路径（Windows 必须；缺失 => 启动失败，不退化成裸 spawn）。 */
  launcherPath: string;
  logger?: (line: string) => void;
  /** initialize 完成后的回调（registry 做 tools/list 发现）。 */
  onReady?: () => void;
  /** notifications/tools/list_changed 到达时回调（registry 触发重新发现+热变更检测）。 */
  onToolsListChanged?: () => void;
  /** 状态变化回调（ping/诊断用）。 */
  onStateChange?: (state: McpSupervisorState) => void;
}

export interface McpSpawnSpec {
  serverId: string;
  command: string;
  args: readonly string[];
  /** 最小环境（SKF 侧白名单合并；绝不继承 SKF 进程 env 防密钥外泄）。 */
  env: Record<string, string>;
  timeouts: McpServerTimeouts;
  restart: McpRestartPolicy;
  maxLineBytes?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class McpServerSupervisor {
  private state: McpSupervisorState = 'stopped';
  private child: ChildProcess | null = null;
  private peer: JsonRpcPeer | null = null;
  private stoppingIntentionally = false;
  private consecutiveFailures = 0;
  private restartAttempts = 0;
  private readyAt = 0;
  private circuitOpenedAt = 0;
  private halfOpenInFlight = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** 测试与审计计数：实际拉起进程的次数。 */
  private spawnCount = 0;
  /** initialize 协商结果（只读记录，不用于授权）。 */
  private negotiated: { protocolVersion: string; serverName: string; serverVersion: string } | null = null;

  constructor(
    private readonly spec: McpSpawnSpec,
    private readonly deps: McpSupervisorDeps,
  ) {}

  get currentState(): McpSupervisorState {
    return this.state;
  }

  get spawns(): number {
    return this.spawnCount;
  }

  get negotiatedInfo(): { protocolVersion: string; serverName: string; serverVersion: string } | null {
    return this.negotiated;
  }

  private setState(next: McpSupervisorState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.onStateChange?.(next);
    this.deps.logger?.(`mcp ${this.spec.serverId}: state -> ${next}`);
  }

  /** 启动并完成 initialize 握手；已在 ready/进行中时幂等返回。 */
  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'starting' || this.state === 'handshaking') {
      throw new RuntimeError('MCP_START_IN_PROGRESS', this.spec.serverId);
    }
    if (this.state === 'circuit_open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < this.spec.restart.circuitCooldownMs) {
        throw new RuntimeError('MCP_CIRCUIT_OPEN', `${this.spec.serverId}: cooling down ${this.spec.restart.circuitCooldownMs - elapsed}ms`);
      }
      if (this.halfOpenInFlight) throw new RuntimeError('MCP_START_IN_PROGRESS', 'half-open probe');
      this.halfOpenInFlight = true;
    }
    try {
      await this.spawnAndHandshake();
      this.consecutiveFailures = 0;
      this.readyAt = Date.now();
      this.halfOpenInFlight = false;
      this.setState('ready');
      this.deps.onReady?.();
    } catch (error) {
      this.halfOpenInFlight = false;
      this.consecutiveFailures++;
      await this.teardownProcess();
      if (this.consecutiveFailures >= this.spec.restart.circuitFailureThreshold) {
        this.circuitOpenedAt = Date.now();
        this.setState('circuit_open');
      } else {
        this.setState('failed');
      }
      throw error;
    }
  }

  /** 进程退出时的同步尽力收树（'exit' 事件只能同步）：杀启动器 => Job Object 收整棵树。 */
  killNow(): void {
    this.stoppingIntentionally = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.child?.kill();
    } catch {
      /* 已退出 */
    }
  }

  /** 优雅停止：关 stdin 给优雅窗口，超时杀启动器（Job Object 收树）。幂等。 */
  async stop(graceMs = 3_000): Promise<void> {
    this.stoppingIntentionally = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return;
    }
    this.peer?.failAll('MCP_SERVER_STOPPED', 'supervisor stopping');
    try {
      child.stdin?.end();
    } catch {
      /* 管道已断 */
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      // 杀启动器：Job 句柄随启动器进程关闭 => KILL_ON_JOB_CLOSE 收掉整棵树。
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 2_000);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.teardownProcess();
    this.setState('stopped');
  }

  private async teardownProcess(): Promise<void> {
    this.peer?.failAll('MCP_RESPONSE_LOST', 'transport torn down');
    this.peer = null;
    this.child = null;
  }

  /** 发出 JSON-RPC 调用；状态不就绪时快速失败，绝不排队等待中自动重连重放。 */
  async call(method: string, params: JSONValue, timeoutMs?: number): Promise<JSONValue> {
    if (this.state === 'circuit_open') {
      throw new RuntimeError('MCP_CIRCUIT_OPEN', this.spec.serverId);
    }
    if (this.state !== 'ready' || !this.peer) {
      throw new RuntimeError('MCP_SERVER_UNAVAILABLE', `${this.spec.serverId}: ${this.state}`);
    }
    try {
      return await this.peer.call(method, params, timeoutMs ?? this.spec.timeouts.callMs);
    } catch (error) {
      // 传输死亡/超时：请求可能已被 server 处理也可能没有——调用方（账本层）
      // 必须把这类失败当 unknown 处理，本层绝不自动重发同一请求。
      if (error instanceof RuntimeError && (error.code === 'MCP_CALL_TIMEOUT' || error.code === 'MCP_TRANSPORT_ERROR')) {
        throw new RuntimeError('MCP_RESPONSE_LOST', `${method}: ${error.message}`);
      }
      throw error;
    }
  }

  /** 进程意外退出后的有上限退避重启；只恢复传输，绝不重放任何调用。 */
  private scheduleRestart(): void {
    if (this.stoppingIntentionally) return;
    // 稳定运行超 stableResetMs 后才崩 = 健康 server 偶发事故，退避计数清零；
    // 起即崩（如 fixture 50ms 退出）不清零，预算烧尽进熔断。
    if (this.readyAt > 0 && Date.now() - this.readyAt > this.spec.restart.stableResetMs) {
      this.restartAttempts = 0;
    }
    if (this.restartAttempts >= this.spec.restart.maxRestartAttempts) {
      this.consecutiveFailures = this.spec.restart.circuitFailureThreshold;
      this.circuitOpenedAt = Date.now();
      this.setState('circuit_open');
      this.deps.logger?.(`mcp ${this.spec.serverId}: restart attempts exhausted -> circuit_open`);
      return;
    }
    const attempt = this.restartAttempts + 1;
    const delay = Math.min(this.spec.restart.baseDelayMs * 2 ** (attempt - 1), this.spec.restart.maxDelayMs);
    this.setState('restarting');
    this.deps.logger?.(`mcp ${this.spec.serverId}: restart #${attempt} in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartAttempts = attempt;
      this.start().catch((error) => {
        this.deps.logger?.(`mcp ${this.spec.serverId}: restart #${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
        // start() 已计 consecutiveFailures；熔断由 start/下次 scheduleRestart 收敛。
        if (this.state === 'failed') this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private async spawnAndHandshake(): Promise<void> {
    this.setState(this.state === 'restarting' ? 'restarting' : 'starting');
    this.stoppingIntentionally = false;

    const launcherArgs = ['--', this.spec.command, ...this.spec.args];
    const child = spawn(this.deps.launcherPath, launcherArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.spec.env,
    });
    this.child = child;
    this.spawnCount++;

    // start 超时：spawn 错误/立即退出 = 启动失败。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeError('MCP_START_TIMEOUT', `${this.spec.serverId} >${this.spec.timeouts.startMs}ms`)), this.spec.timeouts.startMs);
      timer.unref?.();
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new RuntimeError('MCP_START_FAILED', error.message));
      });
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new RuntimeError('MCP_START_FAILED', `exited immediately with code ${code}`));
      });
    });

    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-500);
    });

    const peer = new JsonRpcPeer(child.stdout!, child.stdin!, {
      ...(this.spec.maxLineBytes !== undefined ? { maxLineBytes: this.spec.maxLineBytes } : {}),
      onNotification: (method) => {
        if (method === 'notifications/tools/list_changed') this.deps.onToolsListChanged?.();
      },
      onProtocolViolation: (detail) => {
        this.deps.logger?.(`mcp ${this.spec.serverId}: protocol violation: ${detail} -> killing process tree`);
        this.negotiated = null;
        // 协议违规 = server 不可信：杀树并进熔断计次，不再自动重启（恶意行为不奖励重连）。
        this.consecutiveFailures = this.spec.restart.circuitFailureThreshold;
        this.circuitOpenedAt = Date.now();
        this.setState('circuit_open');
        try {
          this.child?.kill();
        } catch {
          /* 已退出 */
        }
      },
      logger: this.deps.logger,
    });
    this.peer = peer;

    child.once('exit', (code, signal) => {
      this.deps.logger?.(`mcp ${this.spec.serverId}: launcher exited code=${code} signal=${signal}`);
      peer.failAll('MCP_RESPONSE_LOST', `process exited code=${code}`);
      this.child = null;
      this.peer = null;
      if (this.stoppingIntentionally) return;
      if (this.state === 'circuit_open') return; // 协议违规已进熔断
      this.scheduleRestart();
    });

    // handshake 超时：initialize 必须在窗口内完成。
    this.setState('handshaking');
    let initResult: Record<string, JSONValue>;
    try {
      const raw = await peer.call(
        'initialize',
        {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: {},
          clientInfo: { name: 'skf', version: '0.4.4' },
        },
        this.spec.timeouts.handshakeMs,
      );
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new RuntimeError('MCP_HANDSHAKE_FAILED', 'initialize result not an object');
      initResult = raw as Record<string, JSONValue>;
    } catch (error) {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      throw error instanceof RuntimeError ? error : new RuntimeError('MCP_HANDSHAKE_FAILED', String(error));
    }
    const protocolVersion = typeof initResult.protocolVersion === 'string' ? initResult.protocolVersion : null;
    if (!protocolVersion || !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      throw new RuntimeError('MCP_PROTOCOL_VERSION_UNSUPPORTED', String(protocolVersion));
    }
    const serverInfo = initResult.serverInfo;
    const serverName =
      serverInfo !== null && typeof serverInfo === 'object' && !Array.isArray(serverInfo) && typeof (serverInfo as Record<string, JSONValue>).name === 'string'
        ? ((serverInfo as Record<string, JSONValue>).name as string).slice(0, 80)
        : 'unknown';
    const serverVersion =
      serverInfo !== null && typeof serverInfo === 'object' && !Array.isArray(serverInfo) && typeof (serverInfo as Record<string, JSONValue>).version === 'string'
        ? ((serverInfo as Record<string, JSONValue>).version as string).slice(0, 40)
        : 'unknown';
    // server 自报身份只进日志，绝不用于命名/授权（命名由 SKF 注册分配）。
    this.negotiated = { protocolVersion, serverName, serverVersion };
    this.deps.logger?.(`mcp ${this.spec.serverId}: handshake ok protocol=${protocolVersion} selfReported=${serverName}@${serverVersion} (untrusted)`);
    peer.notify('notifications/initialized');
    if (stderrTail.trim()) this.deps.logger?.(`mcp ${this.spec.serverId}: stderr tail: ${stderrTail.trim().slice(0, 200)}`);
  }
}
