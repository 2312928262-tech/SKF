import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import {
  RuntimeError,
  sha256Hex,
  stableStringify,
  TASK_STATES,
  type JSONValue,
  type TaskState,
} from './contracts.js';
import {
  TaskControllerRegistry,
  deliverMemoryOutbox,
  enqueueMemoryOutbox,
  latestMemoryOutbox,
  listArtifacts,
  requestTaskCancel,
  resumeTask,
  type MemoryOutboxEntry,
} from './recovery.js';
import type { EventRecord } from './events.js';
import type { TaskRecord, TaskService } from './task-service.js';
import type { ScheduleService } from '../scheduler/schedule-service.js';
import type { SessionService, SessionRecord } from './session-service.js';
import { listChatPage } from './chat-kernel.js';
import type { ModelGateway } from './model-gateway.js';
import type { MemoryAdapter } from './memory-adapter.js';
import { MemoryError } from './memory-adapter.js';
import { ABSOLUTE_LOOP_LIMITS, runAgentLoop, type AgentLoopLimits, type LearningLoopHooks } from './agent-loop.js';
import type { LearningService } from '../learning/learning-service.js';
import { listExperiences } from '../learning/retrieval.js';
import type { SkillRegistry } from '../skill/registry.js';
import type { ProviderAdapter } from '../providers/protocol.js';
import type { ToolRegistry } from '../tools/registry.js';
import { bridgeToolsOfInput, mcpToolsOfInput } from '../tools/registry.js';
import { localDeliveryAuthorization } from '../tools/policy.js';

/**
 * M08 · IPC v2 与桌面任务控制（02-CONTRACTS.md I 节 / 03-TASK-CARDS M08）。
 *
 * - 请求帧 {id, protocol:2, action, data}；action 白名单 + 运行时 schema 严格校验
 *   （未知字段/类型错误/超限一律 INVALID_INPUT），不开放任意 tool.run 或 SQL。
 * - task.start 快速返回 taskId（持久化 queued 后立即确认），TaskWorker 后台异步推进；
 *   ping/cancel/get 与长模型调用互不阻塞（全异步，无共享await）。
 * - 事件：权威来源是 events 表（eventSeq 递增）。EventBroadcaster 轮询推送
 *   {event:{...}} 帧；断线重连用 events.since(afterSeq) 补发，接收方按 seq 去重。
 * - task.cancel/resume/approve 直接接 M07 的 requestTaskCancel/resumeTask/decideApproval，
 *   取消幂等、恢复预检阻塞原因原样返回，不在这里发明第二套语义。
 * - memory.* 绑定 scope 与有限参数走 MemoryAdapter；budget.status 走 ModelGateway。
 */

// ── 错误码白名单（只把这些暴露给 UI；其余一律 REQUEST_FAILED）─────────

export const IPC_V2_PUBLIC_ERRORS: ReadonlySet<string> = new Set([
  // v1 已有
  'INVALID_ID', 'INVALID_MESSAGE', 'ACTION_DENIED', 'BUSY', 'DAILY_CALL_LIMIT',
  'PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_WHITELISTED', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_TOOLS_UNSUPPORTED',
  'PROVIDER_AUTH_FAILED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_ABORTED',
  'PROVIDER_UNREACHABLE', 'PROVIDER_SERVER_ERROR', 'PROVIDER_BAD_REQUEST', 'PROVIDER_DEADLINE_EXCEEDED',
  'REQUEST_ID_CONFLICT', 'REQUEST_IN_PROGRESS', 'TASK_INTERRUPTED', 'MODEL_REQUEST_FAILED', 'EMPTY_RESPONSE',
  'BUDGET_UNAVAILABLE', 'BUDGET_EXCEEDED', 'DAILY_BUDGET_EXCEEDED', 'CALL_LIMIT_EXCEEDED',
  'TARIFF_NOT_CONFIGURED', 'LOCAL_ONLY_MODE', 'EXPENSIVE_UPGRADE_NOT_AUTHORIZED',
  'CONTEXT_BUDGET_EXCEEDED', 'PROVIDER_NOT_VERIFIED', 'ROUTE_NOT_CONFIGURED',
  // M08 新增（runtime/recovery/worker 语义码）
  'INVALID_INPUT', 'TASK_NOT_FOUND', 'INVALID_TRANSITION', 'CONCURRENT_MODIFICATION', 'TASK_TERMINAL',
  'LEASE_HELD', 'FENCING_TOKEN_STALE', 'POLICY_DENIED', 'WORKSPACE_INVALID',
  'APPROVAL_NOT_FOUND', 'APPROVAL_INPUT_CONFLICT', 'APPROVAL_EXPIRED',
  'RESUME_INPUT_MISMATCH', 'RESUME_CANCEL_INTENT', 'RESUME_WORKSPACE_MISSING', 'RESUME_ARTIFACT_MISMATCH',
  'RECOVERY_NEEDS_MANUAL_REVIEW', 'MODEL_CALL_UNCERTAIN_REVIEW', 'BUDGET_REAUTH_REQUIRED',
  'MEMORY_UNAVAILABLE', 'MEMORY_WRITEBACK_QUEUED',
  'PROTOCOL_VERSION_UNSUPPORTED', 'FRAME_TOO_LARGE', 'PARSE_ERROR', 'IPC_V2_UNAVAILABLE',
  'OPERATION_NOT_FOUND', 'EVENT_PAYLOAD_TOO_LARGE',
  // M09：聊天内核/桥接
  'TASK_CANCELLED', 'TOOL_UNAVAILABLE', 'BRIDGE_COMMAND_FAILED',
  // M14：MCP 工具层
  'MCP_SERVER_NOT_ALLOWED', 'MCP_DUPLICATE_SERVER', 'MCP_PROTOCOL_VIOLATION', 'MCP_SCHEMA_CHANGED',
  'MCP_SCHEMA_UNSUPPORTED', 'MCP_CIRCUIT_OPEN', 'MCP_SERVER_UNAVAILABLE', 'MCP_RESPONSE_LOST',
  'MCP_TOOL_ERROR', 'MCP_CALL_TIMEOUT', 'MCP_TRANSPORT_ERROR', 'MCP_START_FAILED', 'MCP_START_TIMEOUT',
  'MCP_HANDSHAKE_FAILED', 'MCP_PROTOCOL_VERSION_UNSUPPORTED', 'MCP_START_IN_PROGRESS', 'MCP_SERVER_STOPPED',
  'MCP_SERVER_ERROR', 'APPROVAL_REQUIRED', 'TOOL_NAME_CONFLICT',
  // M10：记忆备份
  'MEMORY_BACKUP_FAILED', 'BACKUP_FILE_REQUIRED',
  // M15：调度持久层
  'SCHEDULE_NOT_FOUND', 'FIRING_NOT_FOUND', 'INVALID_CRON', 'INVALID_TIMEZONE',
  'INVALID_LOCAL_TIME', 'PROTECT_LOOP', 'SCHEDULE_DISABLED',
  'SCHEDULE_FIRING_EXPIRED', 'SCHEDULE_FIRING_NOT_PENDING',
  // M13：学习闭环
  'LEARNING_DISABLED', 'EXPERIENCE_NOT_FOUND', 'EXPERIENCE_REVISION_CONFLICT',
  'EXPERIENCE_CONTENT_CONFLICT', 'INVALID_PROMOTION', 'TASK_NOT_TERMINAL',
  'REVIEW_NOT_FOUND', 'REVIEW_OUTPUT_INVALID', 'CHECKPOINT_NOT_MET', 'CHECKPOINT_BLOCKED',
  // M17：桌面工具层
  'UIA_UNAVAILABLE', 'SECURE_DESKTOP_OR_SESSION_UNAVAILABLE', 'HELPER_FAILED',
  'CLIPBOARD_UNAVAILABLE', 'LAUNCH_DENIED', 'LAUNCH_UNAVAILABLE',
  'TARGET_NOT_FOUND', 'TARGET_CHANGED',
  // M18：GUI 有限交互
  'INTERACT_PLAN_NOT_FOUND', 'INTERACT_PLAN_EXPIRED', 'INTERACT_INVALID_PRIMITIVE',
  'INTERACT_INVALID_SELECTOR', 'INTERACT_INVALID_INPUT', 'INTERACT_SECRET_INPUT_FORBIDDEN',
  'INTERACT_WINDOW_FINGERPRINT_MISMATCH', 'INTERACT_ELEMENT_NOT_UNIQUE', 'INTERACT_ELEMENT_NOT_FOUND',
  'INTERACT_STATE_VIOLATION', 'INTERACT_DISPATCH_BARRIER_FAILED', 'INTERACT_TIMEOUT',
  'INTERACT_CANCELLED', 'INTERACT_PUBLISH_REQUIRES_SEPARATE_APPROVAL', 'INTERACT_DISPATCH_LOST',
  'INTERACT_RECOVERY_REQUIRED', 'INTERACT_ADAPTER_NOT_REGISTERED', 'INTERACT_ADAPTER_VERSION_CHANGED',
  // M19：浏览器 CDP 层
  'BROWSER_DOMAIN_NOT_ALLOWED', 'BROWSER_REDIRECT_OUT_OF_ALLOWLIST', 'BROWSER_UNAVAILABLE',
  'BROWSER_NAVIGATION_FAILED', 'BROWSER_ELEMENT_NOT_FOUND', 'BROWSER_ELEMENT_NOT_UNIQUE',
  'BROWSER_INPUT_INVALID', 'BROWSER_SECRET_INPUT_FORBIDDEN', 'BROWSER_TIMEOUT',
  'BROWSER_ACTION_REJECTED', 'BROWSER_TOO_MANY_REDIRECTS',
  // M22：联网工具
  'WEB_SEARCH_UNAVAILABLE', 'WEB_FETCH_UNAVAILABLE', 'WEB_DOMAIN_NOT_ALLOWED',
  'WEB_REDIRECT_OUT_OF_ALLOWLIST', 'WEB_FETCH_FAILED', 'WEB_TOO_MANY_REDIRECTS',
  'WEB_INPUT_INVALID', 'WEB_TIMEOUT', 'WEB_RESULT_TOO_LARGE',
  // M16：媒体工具
  'MEDIA_UNAVAILABLE', 'MEDIA_IMAGE_FAILED', 'MEDIA_TTS_FAILED', 'MEDIA_TRANSCRIBE_FAILED',
  'MEDIA_VRAM_FAILED', 'MEDIA_INPUT_INVALID', 'MEDIA_TIMEOUT', 'MEDIA_ARTIFACT_MISSING',
  'MEDIA_PATH_INVALID',
  // M23：多会话
  'SESSION_NOT_FOUND', 'SESSION_EXISTS',
  // 已审查记忆 runtime 的业务码（原样透传，见 memory-adapter.ts）
  'QUERY_REQUIRED', 'INVALID_CONTEXT_BUDGET', 'MANDATORY_CONTEXT_TOO_LARGE',
  'CONTEXT_BUDGET_INVARIANT_FAILED', 'IDEMPOTENCY_CONFLICT', 'CLOSE_OPERATION_ID_REQUIRED',
  'INVALID_RECORD', 'SOURCE_REQUIRED', 'USER_EVIDENCE_REQUIRED', 'TOOL_EVIDENCE_REQUIRED',
  'PIN_REQUIRES_EVIDENCE', 'SUPERSEDES_TARGET_NOT_ACTIVE', 'INVALID_CONFIDENCE',
  'INVALID_TASK', 'DONE_REQUIRES_EVIDENCE', 'SESSION_SUMMARY_REQUIRED',
  'ARCHIVE_PROTECTED_OR_INVALID', 'ARCHIVE_CHANGED', 'ARCHIVE_OPERATION_ID_REQUIRED',
  'NOT_ARCHIVED', 'RESTORE_CONFLICT', 'INVALID_OPERATION_KEY',
]);

/** 把未知异常收敛成可公开的错误码；细节只进 stderr，不进响应帧。 */
export function toPublicErrorCode(err: unknown): string {
  const code =
    err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : err instanceof Error
        ? err.message
        : '';
  return IPC_V2_PUBLIC_ERRORS.has(code) ? code : 'REQUEST_FAILED';
}

// ── 请求 data 运行时 schema（严格：未知字段拒绝）──────────────────────

type VField =
  | { kind: 'string'; required?: boolean; max?: number; enum?: readonly string[] }
  | { kind: 'integer'; required?: boolean; min?: number; max?: number }
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'json'; required?: boolean; maxBytes?: number }
  | { kind: 'stringArray'; required?: boolean; maxItems?: number; maxItemBytes?: number };

function validate(action: string, data: unknown, fields: Record<string, VField>): Record<string, JSONValue> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new RuntimeError('INVALID_INPUT', `${action}: data object expected`);
  }
  const input = data as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in fields)) throw new RuntimeError('INVALID_INPUT', `${action}: unknown field ${key}`);
  }
  const out: Record<string, JSONValue> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const value = input[key];
    if (value === undefined) {
      if (spec.required) throw new RuntimeError('INVALID_INPUT', `${action}: missing ${key}`);
      continue;
    }
    switch (spec.kind) {
      case 'string': {
        if (typeof value !== 'string') throw new RuntimeError('INVALID_INPUT', `${action}: ${key} not string`);
        if (spec.max !== undefined && value.length > spec.max) throw new RuntimeError('INVALID_INPUT', `${action}: ${key} too long`);
        if (spec.enum && !spec.enum.includes(value)) throw new RuntimeError('INVALID_INPUT', `${action}: ${key} not one of ${spec.enum.join('|')}`);
        out[key] = value;
        break;
      }
      case 'integer': {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          throw new RuntimeError('INVALID_INPUT', `${action}: ${key} not safe integer`);
        }
        if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
          throw new RuntimeError('INVALID_INPUT', `${action}: ${key} out of range`);
        }
        out[key] = value;
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') throw new RuntimeError('INVALID_INPUT', `${action}: ${key} not boolean`);
        out[key] = value;
        break;
      }
      case 'json': {
        let serialized: string;
        try {
          serialized = stableStringify(value as JSONValue);
        } catch {
          throw new RuntimeError('INVALID_INPUT', `${action}: ${key} not strict JSON`);
        }
        if (spec.maxBytes !== undefined && Buffer.byteLength(serialized, 'utf8') > spec.maxBytes) {
          throw new RuntimeError('INVALID_INPUT', `${action}: ${key} too large`);
        }
        out[key] = value as JSONValue;
        break;
      }
      case 'stringArray': {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          throw new RuntimeError('INVALID_INPUT', `${action}: ${key} not string[]`);
        }
        if (spec.maxItems !== undefined && value.length > spec.maxItems) {
          throw new RuntimeError('INVALID_INPUT', `${action}: ${key} too many items`);
        }
        for (const item of value) {
          if (spec.maxItemBytes !== undefined && Buffer.byteLength(item as string, 'utf8') > spec.maxItemBytes) {
            throw new RuntimeError('INVALID_INPUT', `${action}: ${key} item too long`);
          }
        }
        out[key] = value as unknown as JSONValue;
        break;
      }
    }
  }
  return out;
}

/** 任务输入里的可选循环上限：只能比代码钉死的绝对上限更小（02-F）。 */
function validateTaskLimits(input: Record<string, JSONValue>): void {
  const limits = input.limits;
  if (limits === undefined) return;
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new RuntimeError('INVALID_INPUT', 'input.limits object expected');
  }
  const obj = limits as Record<string, JSONValue>;
  for (const key of Object.keys(obj)) {
    if (key !== 'maxModelSteps' && key !== 'maxToolCalls' && key !== 'maxDurationMs') {
      throw new RuntimeError('INVALID_INPUT', `input.limits: unknown field ${key}`);
    }
    const value = obj[key];
    const ceiling = ABSOLUTE_LOOP_LIMITS[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new RuntimeError('INVALID_INPUT', `input.limits.${key} must be 1..${ceiling}`);
    }
  }
}

function taskLimitsOf(input: JSONValue): Partial<AgentLoopLimits> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const limits = (input as Record<string, JSONValue>).limits;
  if (limits === undefined) return undefined;
  return limits as Partial<AgentLoopLimits>;
}

function goalOf(input: JSONValue): string {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const goal = (input as Record<string, JSONValue>).goal;
    if (typeof goal === 'string') return goal;
  }
  return '';
}

/** 任务输入种类：chat/system_channel 由调用方同步驱动或系统挂账，worker 泵绝不接管。 */
function kindOfInput(input: JSONValue): string {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const kind = (input as Record<string, JSONValue>).kind;
    if (typeof kind === 'string') return kind;
  }
  return '';
}

/** M09：input.bridgeTools 必须逐个是已登记桥接工具名（没有“透传全部”）。 */
function validateBridgeTools(input: Record<string, JSONValue>, known: readonly string[]): void {
  const raw = input.bridgeTools;
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > 8) throw new RuntimeError('INVALID_INPUT', 'input.bridgeTools must be an array of at most 8 names');
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128) {
      throw new RuntimeError('INVALID_INPUT', 'input.bridgeTools: names must be non-empty strings');
    }
    if (!known.includes(item)) throw new RuntimeError('INVALID_INPUT', `input.bridgeTools: unknown bridge tool ${item}`);
  }
}

/** M14：input.mcpTools 逐个点名授权校验（mcp/<serverId>/<tool>，必须是已登记工具）。 */
function validateMcpTools(input: Record<string, JSONValue>, known: readonly string[]): void {
  const raw = input.mcpTools;
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > 16) throw new RuntimeError('INVALID_INPUT', 'input.mcpTools must be an array of at most 16 names');
  for (const item of raw) {
    if (typeof item !== 'string' || !/^mcp\/[a-z0-9][a-z0-9-]{0,62}\/[a-zA-Z0-9_-]{1,64}$/.test(item)) {
      throw new RuntimeError('INVALID_INPUT', 'input.mcpTools: names must match mcp/<serverId>/<tool>');
    }
    if (!known.includes(item)) throw new RuntimeError('INVALID_INPUT', `input.mcpTools: unknown mcp tool ${item}`);
  }
}

// ── TaskWorker：queued 任务的异步推进泵 ─────────────────────────────

export interface TaskWorkerDeps {
  service: TaskService;
  adapterFor: (name: string) => ProviderAdapter | null;
  /** null 时 worker 不可用（生产路径必须经 ModelGateway，02-G）。 */
  gateway: ModelGateway | null;
  tools: ToolRegistry;
  controllers: TaskControllerRegistry;
  prepareContext?: (task: TaskRecord) => Promise<string | null>;
  flushMemoryOutbox?: (entry: MemoryOutboxEntry) => Promise<void>;
  /** M14：副作用审批 TTL 查询（按工具名；supervisor 接 mcpRegistry.getApprovalTtl）。 */
  approvalTtlMsFor?: (toolName: string) => number;
  /** M15：任务达到终态后回调（succeeded/failed/cancelled/waiting_approval）；
   *  worker 本身不负责调用其本身——调用在 runAgentLoop 拿到结果后由 runOne 跳发。
   *  这里是 scheduler 的出口：把 schedule_firings 行标终态、预登记下一次。 */
  onTaskTerminal?: (taskId: string, terminal: { state: 'succeeded' | 'failed' | 'cancelled' | 'waiting_approval'; errorCode: string | null }) => void;
  /** M13：学习闭环检查点 hooks（透传进 runAgentLoop；缺省 = 影子模式未激活）。 */
  learning?: LearningLoopHooks;
  logger?: (line: string) => void;
}

export class TaskWorker {
  private queue: string[] = [];
  private pumping = false;

  constructor(private deps: TaskWorkerDeps) {}

  /** task.start/resume/approve 后唤醒泵；幂等，重入安全。 */
  enqueue(taskId: string): void {
    if (!this.queue.includes(taskId)) this.queue.push(taskId);
    void this.pump();
  }

  /** 启动时接管上次遗留的 queued 任务（queued=从未开始，重跑无副作用）。
   *  chat/system_channel 任务不由 worker 驱动（聊天同步执行、系统通道只挂账）。 */
  enqueueQueuedLeftovers(): number {
    const queued = this.deps.service
      .listTasks(1000)
      .filter((task) => task.state === 'queued' && kindOfInput(task.input) !== 'chat' && kindOfInput(task.input) !== 'system_channel');
    for (const task of queued) this.enqueue(task.id);
    return queued.length;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const taskId = this.queue.shift();
        if (taskId === undefined) break;
        try {
          await this.runOne(taskId);
        } catch (error) {
          // 泵绝不因单个任务崩溃；任务状态由 runOne/failRunningTask 负责收敛。
          this.deps.logger?.(`[worker] task ${taskId} escaped pump: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runOne(taskId: string): Promise<void> {
    const { service } = this.deps;
    const task = service.getTask(taskId);
    if (!task || (task.state !== 'queued' && task.state !== 'running')) return;
    const kind = kindOfInput(task.input);
    if (kind === 'chat' || kind === 'system_channel') return; // M09：非 worker 驱动的任务种类
    const provider = this.deps.adapterFor(task.provider);
    if (!provider) {
      this.failRunningTask(task, 'PROVIDER_UNAVAILABLE', task.provider);
      return;
    }
    if (!this.deps.gateway) {
      // 预算出口缺失 = fail-closed（BUDGET_UNAVAILABLE），绝不直调 provider 绕过预算。
      this.failRunningTask(task, 'BUDGET_UNAVAILABLE', 'ModelGateway not initialized');
      return;
    }
    const limits = taskLimitsOf(task.input);
    try {
      const result = await runAgentLoop(
        {
          service,
          provider,
          gateway: this.deps.gateway,
          tools: this.deps.tools,
          // M09/M14：桥接与 MCP 授权来自任务创建时的可信输入（input.bridgeTools/mcpTools），模型不可改。
          authorization: {
            ...localDeliveryAuthorization(task.workspaceRoot),
            allowedBridgeTools: bridgeToolsOfInput(task.input),
            allowedMcpTools: mcpToolsOfInput(task.input),
          },
          controllers: this.deps.controllers,
          ...(limits ? { limits } : {}),
          ...(this.deps.prepareContext ? { prepareContext: this.deps.prepareContext } : {}),
          ...(this.deps.flushMemoryOutbox ? { flushMemoryOutbox: this.deps.flushMemoryOutbox } : {}),
          ...(this.deps.approvalTtlMsFor ? { approvalTtlMsFor: this.deps.approvalTtlMsFor } : {}),
          ...(this.deps.learning ? { learning: this.deps.learning } : {}),
          logger: this.deps.logger,
        },
        taskId,
      );
      // M15：把任务终态推给订阅者（scheduler 用它收尾 firing）。
      this.deps.onTaskTerminal?.(taskId, { state: result.state, errorCode: result.errorCode });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const text = error instanceof Error ? error.message : String(error);
      this.deps.logger?.(`[worker] task ${taskId} loop exited: ${typeof code === 'string' ? code : 'ERROR'} ${text}`);
      // external_write unknown：任务保持非终态等人工核对（M07 语义，不自动重放）。
      // LEASE_HELD：另一实例持有租约，本实例不干预。
      if (code === 'RECOVERY_NEEDS_MANUAL_REVIEW' || code === 'LEASE_HELD') return;
      this.failRunningTask(service.getTask(taskId) ?? task, typeof code === 'string' ? code : 'WORKER_INTERNAL', text);
    }
  }

  /** runAgentLoop 抛出逃出错误时把非终态任务收敛到 failed（终态事务含事件+记忆 outbox）。 */
  private failRunningTask(task: TaskRecord, code: string, detail: string): void {
    const { service } = this.deps;
    const current = service.getTask(task.id) ?? task;
    if (current.state !== 'running' && current.state !== 'waiting_provider' && current.state !== 'waiting_approval') return;
    try {
      service.store.transaction(() => {
        service.transitionTask(current.id, 'failed', {
          errorCode: code,
          event: { type: 'task.failed', payload: { errorCode: code, detail: detail.slice(0, 500) } },
        });
        enqueueMemoryOutbox(service, current, 'failed', code);
      });
      void deliverMemoryOutbox(service, latestMemoryOutbox(service, current.id), this.deps.flushMemoryOutbox);
    } catch (error) {
      this.deps.logger?.(`[worker] finalize failed for ${current.id} itself failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ── EventBroadcaster：eventSeq 递增的实时推送 ───────────────────────

export interface EventBroadcasterDeps {
  service: TaskService;
  /** 写一帧到 stdout；返回 false = 背压（writableLength 已满），本拍停止，下拍续传。 */
  writeFrame: (frame: unknown) => boolean;
  intervalMs?: number;
  maxPerFlush?: number;
}

/**
 * 推送只是加速路径，不是权威：每一帧都来自 events 表，lastSeq 只在帧真正
 * 写出后前进；背压/掉帧不会造成丢失，客户端断线后 events.since 补发去重。
 */
export class EventBroadcaster {
  private lastSeq: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly maxPerFlush: number;

  constructor(private deps: EventBroadcasterDeps) {
    const row = deps.service.store.db.prepare('SELECT COALESCE(MAX(eventSeq), 0) AS m FROM events').get() as { m: number };
    this.lastSeq = row.m;
    this.intervalMs = deps.intervalMs ?? 100;
    this.maxPerFlush = deps.maxPerFlush ?? 500;
  }

  start(): void {
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 请求处理完后立即补一拍，降低事件可见延迟。 */
  flushNow(): void {
    this.flush();
  }

  private flush(): void {
    const events = this.deps.service.listEvents(this.lastSeq, this.maxPerFlush);
    for (const event of events) {
      if (!this.deps.writeFrame({ event })) return; // 背压：lastSeq 不前进，下一拍重发
      this.lastSeq = event.eventSeq;
    }
  }
}

// ── IpcV2Router：action 白名单分发 ──────────────────────────────────

export const IPC_V2_ACTIONS = [
  'ping',
  'session.create', 'session.list', 'session.get', 'session.rename',
  'session.archive', 'session.restore', 'session.history',
  'task.start', 'task.get', 'task.list', 'task.cancel', 'task.resume', 'task.approve',
  'schedule.create', 'schedule.list', 'schedule.get', 'schedule.update',
  'schedule.enable', 'schedule.disable', 'schedule.delete', 'schedule.firings',
  'events.since',
  'memory.search', 'memory.get', 'memory.correct', 'memory.archive', 'memory.restore',
  'memory.status', 'memory.backup',
  'budget.status',
  'learning.status', 'learning.reviews', 'learning.experiences', 'learning.reviewNow',
  'learning.promote', 'learning.dispute', 'learning.revise',
  'skill.list', 'skill.search',
] as const;

export interface IpcV2RouterDeps {
  service: TaskService;
  worker: TaskWorker;
  controllers: TaskControllerRegistry;
  /** vault 模式且 adapter 可用时提供；否则 memory.* 返回 MEMORY_UNAVAILABLE。 */
  memory: MemoryAdapter | null;
  gateway: ModelGateway | null;
  budgetMode: string;
  defaultProvider: () => string;
  defaultSessionId: string;
  defaultScope: string;
  adapterFor: (name: string) => ProviderAdapter | null;
  modelFor: (name: string) => string | null;
  /** M09：已登记的桥接工具名（task.start 校验 input.bridgeTools 用）。 */
  bridgeTools?: () => string[];
  /** M14：已登记的 MCP 工具名（task.start 校验 input.mcpTools 用）。 */
  mcpTools?: () => string[];
  flushMemoryOutbox?: (entry: MemoryOutboxEntry) => Promise<void>;
  /** M15：调度持久层；supervisor 在 scheduleService 不可用时传 null 并在 ping 里声明。 */
  scheduleService?: ScheduleService | null;
  /** M13：学习闭环；null = 影子模式未激活（learning.* 返回 LEARNING_DISABLED）。 */
  learning?: LearningService | null;
  /** M20：skill 机制（只读查询；null = 未装配）。 */
  skills?: SkillRegistry | null;
  /** M23：会话持久层（多会话 CRUD 与隔离）。 */
  sessions: SessionService;
  /** v2 ping 的附加字段（provider/budget/capabilities 等，由 supervisor 组装）。 */
  pingData: () => Record<string, JSONValue>;
  broadcaster?: EventBroadcaster;
  logger?: (line: string) => void;
}

export class IpcV2Router {
  constructor(private deps: IpcV2RouterDeps) {}

  async dispatch(action: string, data: unknown): Promise<JSONValue> {
    let result: JSONValue;
    switch (action) {
      case 'ping':
        result = { protocol: 2, ...this.deps.pingData() };
        break;
      case 'session.create':
        result = this.sessionCreate(data);
        break;
      case 'session.list':
        result = this.sessionList(data);
        break;
      case 'session.get':
        result = this.sessionGet(data);
        break;
      case 'session.rename':
        result = this.sessionRename(data);
        break;
      case 'session.archive':
        result = this.sessionArchive(data, true);
        break;
      case 'session.restore':
        result = this.sessionArchive(data, false);
        break;
      case 'session.history':
        result = this.sessionHistory(data);
        break;
      case 'task.start':
        result = await this.taskStart(data);
        break;
      case 'task.get':
        result = this.taskGet(data);
        break;
      case 'task.list':
        result = this.taskList(data);
        break;
      case 'task.cancel':
        result = await this.taskCancel(data);
        break;
      case 'task.resume':
        result = await this.taskResume(data);
        break;
      case 'task.approve':
        result = this.taskApprove(data);
        break;
      case 'schedule.create':
        result = this.scheduleCreate(data);
        break;
      case 'schedule.list':
        result = this.scheduleList(data);
        break;
      case 'schedule.get':
        result = this.scheduleGet(data);
        break;
      case 'schedule.update':
        result = this.scheduleUpdate(data);
        break;
      case 'schedule.enable':
        result = this.scheduleSetEnabled(data, true);
        break;
      case 'schedule.disable':
        result = this.scheduleSetEnabled(data, false);
        break;
      case 'schedule.delete':
        result = this.scheduleDelete(data);
        break;
      case 'schedule.firings':
        result = this.scheduleFirings(data);
        break;
      case 'events.since':
        result = this.eventsSince(data);
        break;
      case 'memory.search':
        result = await this.memorySearch(data);
        break;
      case 'memory.get':
        result = await this.memoryGet(data);
        break;
      case 'memory.correct':
        result = await this.memoryCorrect(data);
        break;
      case 'memory.archive':
        result = await this.memoryArchive(data);
        break;
      case 'memory.restore':
        result = await this.memoryRestore(data);
        break;
      case 'memory.status':
        result = await this.memoryStatus(data);
        break;
      case 'memory.backup':
        result = await this.memoryBackup(data);
        break;
      case 'budget.status':
        result = this.budgetStatus(data);
        break;
      case 'learning.status':
        result = this.learningStatus();
        break;
      case 'learning.reviews':
        result = this.learningReviews(data);
        break;
      case 'learning.experiences':
        result = this.learningExperiences(data);
        break;
      case 'learning.reviewNow':
        result = this.learningReviewNow(data);
        break;
      case 'learning.promote':
        result = await this.learningPromote(data);
        break;
      case 'learning.dispute':
        result = this.learningDispute(data);
        break;
      case 'learning.revise':
        result = this.learningRevise(data);
        break;
      case 'skill.list':
        result = this.skillList();
        break;
      case 'skill.search':
        result = this.skillSearch(data);
        break;
      default:
        throw new RuntimeError('ACTION_DENIED', action);
    }
    // 请求处理后立刻补一拍事件，缩短 UI 可见延迟。
    this.deps.broadcaster?.flushNow();
    return result;
  }

  // ── session.*（M23 多会话）──────────────────────────────

  private sessionRecordOf(s: SessionRecord): JSONValue {
    return {
      id: s.id,
      name: s.name,
      scope: s.scope,
      archived: s.archived,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastMessageAt: s.lastMessageAt,
    } as unknown as JSONValue;
  }

  private requireSession(id: string) {
    const session = this.deps.sessions.getSession(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', id);
    return session;
  }

  private sessionCreate(data: unknown): JSONValue {
    const d = validate('session.create', data, {
      id: { kind: 'string', max: 256 },
      name: { kind: 'string', required: true, max: 256 },
      scope: { kind: 'string', max: 256 },
    });
    const session = this.deps.sessions.createSession({
      ...(d.id !== undefined ? { id: d.id as string } : {}),
      name: d.name as string,
      ...(d.scope !== undefined ? { scope: d.scope as string } : {}),
    });
    return { session: this.sessionRecordOf(session) };
  }

  private sessionList(data: unknown): JSONValue {
    const d = validate('session.list', data, {
      archived: { kind: 'boolean' },
      limit: { kind: 'integer', min: 1, max: 200 },
    });
    const sessions = this.deps.sessions.listSessions({
      ...(d.archived !== undefined ? { archived: d.archived as boolean } : {}),
      ...(d.limit !== undefined ? { limit: d.limit as number } : {}),
    });
    return { sessions: sessions.map((s) => this.sessionRecordOf(s)) as unknown as JSONValue };
  }

  private sessionGet(data: unknown): JSONValue {
    const d = validate('session.get', data, { id: { kind: 'string', required: true, max: 256 } });
    return { session: this.sessionRecordOf(this.requireSession(d.id as string)) };
  }

  private sessionRename(data: unknown): JSONValue {
    const d = validate('session.rename', data, {
      id: { kind: 'string', required: true, max: 256 },
      name: { kind: 'string', required: true, max: 256 },
    });
    const session = this.deps.sessions.renameSession(d.id as string, d.name as string);
    return { session: this.sessionRecordOf(session) };
  }

  /** archive=true 归档、false 恢复：只改可见性，不删历史/不取消任务/不改 scope。 */
  private sessionArchive(data: unknown, archived: boolean): JSONValue {
    const d = validate(archived ? 'session.archive' : 'session.restore', data, {
      id: { kind: 'string', required: true, max: 256 },
    });
    const session = this.deps.sessions.setArchived(d.id as string, archived);
    return { session: this.sessionRecordOf(session) };
  }

  private sessionHistory(data: unknown): JSONValue {
    const d = validate('session.history', data, {
      sessionId: { kind: 'string', required: true, max: 256 },
      afterSeq: { kind: 'string', max: 512 },
      limit: { kind: 'integer', min: 1, max: 200 },
    });
    const sessionId = d.sessionId as string;
    // 会话不存在也要显式拒绝，避免 UI 拿到空历史后误以为会话存在。
    this.requireSession(sessionId);
    const page = listChatPage(this.deps.service, {
      sessionId,
      ...(d.afterSeq !== undefined ? { afterSeq: d.afterSeq as string } : {}),
      ...(d.limit !== undefined ? { limit: d.limit as number } : {}),
    });
    return {
      sessionId,
      entries: page.entries as unknown as JSONValue,
      hasMore: page.hasMore,
      nextSeq: page.nextSeq,
    };
  }

  // ── task.* ────────────────────────────────────────────

  private async taskStart(data: unknown): Promise<JSONValue> {
    const d = validate('task.start', data, {
      id: { kind: 'string', max: 256 },
      input: { kind: 'json', required: true, maxBytes: 65_536 },
      sessionId: { kind: 'string', max: 256 },
      scope: { kind: 'string', max: 256 },
      workspaceRoot: { kind: 'string', required: true, max: 1024 },
      provider: { kind: 'string', max: 128 },
      model: { kind: 'string', max: 128 },
      acceptance: { kind: 'json', maxBytes: 32_768 },
    });
    const input = d.input as Record<string, JSONValue>;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new RuntimeError('INVALID_INPUT', 'task.start: input object expected');
    }
    const goal = goalOf(d.input);
    if (!goal.trim() || goal.length > 4000) {
      throw new RuntimeError('INVALID_INPUT', 'task.start: input.goal required (1..4000 chars)');
    }
    validateTaskLimits(input);
    validateBridgeTools(input, this.deps.bridgeTools?.() ?? []);
    validateMcpTools(input, this.deps.mcpTools?.() ?? []);
    // workspaceRoot 在任务创建时由可信调用方固定并 canonicalize；模型之后无法重定义。
    let rootReal: string;
    try {
      rootReal = realpathSync(d.workspaceRoot as string);
      if (!statSync(rootReal).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new RuntimeError('WORKSPACE_INVALID', d.workspaceRoot as string);
    }
    const provider = (d.provider as string | undefined) ?? this.deps.defaultProvider();
    const providerAdapter = this.deps.adapterFor(provider);
    if (!providerAdapter) throw new RuntimeError('PROVIDER_UNAVAILABLE', provider);
    // M12(P02)：provider 不支持工具时禁用执行任务——chat 可用，执行在创建前拒绝，
    // 不烧模型步骤，也绝不退化成“从自由文本猜命令”。
    const providerCaps = await providerAdapter.capabilities();
    if (providerCaps.tools !== true) throw new RuntimeError('PROVIDER_TOOLS_UNSUPPORTED', provider);
    const model = (d.model as string | undefined) ?? this.deps.modelFor(provider) ?? provider;
    const taskId = (d.id as string | undefined) ?? `task-${randomUUID()}`;
    const existed = this.deps.service.getTask(taskId) !== null;
    const task = this.deps.service.createTask({
      id: taskId,
      input: d.input,
      sessionId: (d.sessionId as string | undefined) ?? this.deps.defaultSessionId,
      scope: (d.scope as string | undefined) ?? this.deps.defaultScope,
      workspaceRoot: rootReal,
      provider,
      model,
      ...(d.acceptance !== undefined ? { acceptance: d.acceptance } : {}),
    });
    // queued 任务都进泵（新建或幂等重放都安全：runOne 会复核状态，lease 防并发）。
    if (task.state === 'queued') this.deps.worker.enqueue(taskId);
    return { taskId: task.id, state: task.state, created: !existed };
  }

  private taskGet(data: unknown): JSONValue {
    const d = validate('task.get', data, { taskId: { kind: 'string', required: true, max: 256 } });
    const taskId = d.taskId as string;
    const task = this.deps.service.getTask(taskId);
    if (!task) throw new RuntimeError('TASK_NOT_FOUND', taskId);
    const db = this.deps.service.store.db;
    const modelSteps = (db.prepare('SELECT COUNT(*) AS c FROM model_calls WHERE taskId = ?').get(taskId) as { c: number }).c;
    const toolCalls = (db.prepare('SELECT COUNT(*) AS c FROM operations WHERE taskId = ?').get(taskId) as { c: number }).c;
    const lastAssistant = db
      .prepare("SELECT content FROM messages WHERE taskId = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1")
      .get(taskId) as { content: string } | undefined;
    const pendingApprovals = db
      .prepare("SELECT id, operationId, effect, inputHash, expiresAt FROM approvals WHERE taskId = ? AND decision = 'pending' ORDER BY expiresAt ASC")
      .all(taskId) as unknown as JSONValue[];
    return {
      task: {
        id: task.id,
        state: task.state,
        errorCode: task.errorCode,
        provider: task.provider,
        model: task.model,
        sessionId: task.sessionId,
        scope: task.scope,
        workspaceRoot: task.workspaceRoot,
        revision: task.revision,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        kind: kindOfInput(task.input) || 'task',
        goal: goalOf(task.input),
      },
      artifacts: listArtifacts(this.deps.service, taskId) as unknown as JSONValue,
      counts: { modelSteps, toolCalls },
      finalText: lastAssistant?.content ?? '',
      pendingApprovals,
      memoryOutboxPending: this.deps.service
        .pendingOutbox('memory_writeback')
        .some((e) => (e as { taskId?: string }).taskId === taskId),
    };
  }

  private taskList(data: unknown): JSONValue {
    const d = validate('task.list', data, {
      limit: { kind: 'integer', min: 1, max: 200 },
      state: { kind: 'string', enum: TASK_STATES },
    });
    const limit = (d.limit as number | undefined) ?? 50;
    const state = d.state as TaskState | undefined;
    const tasks = this.deps.service
      .listTasks(limit)
      .filter((task) => state === undefined || task.state === state)
      .map((task) => ({
        id: task.id,
        state: task.state,
        errorCode: task.errorCode,
        provider: task.provider,
        model: task.model,
        sessionId: task.sessionId,
        scope: task.scope,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        // M10：kind 供 UI 区分聊天轮次与文件任务（聊天在对话页，不混进任务卡）。
        kind: kindOfInput(task.input) || 'task',
        goal: goalOf(task.input).slice(0, 120),
      }));
    return { tasks: tasks as unknown as JSONValue };
  }

  private async taskCancel(data: unknown): Promise<JSONValue> {
    const d = validate('task.cancel', data, {
      taskId: { kind: 'string', required: true, max: 256 },
      reason: { kind: 'string', max: 500 },
    });
    // M07：先持久意图再 abort；重复取消幂等；已提交 artifact 照列。
    const outcome = await requestTaskCancel(this.deps.service, d.taskId as string, {
      controllers: this.deps.controllers,
      ...(d.reason !== undefined ? { reason: d.reason as string } : {}),
      ...(this.deps.flushMemoryOutbox ? { flushMemoryOutbox: this.deps.flushMemoryOutbox } : {}),
    });
    return {
      taskId: outcome.taskId,
      state: outcome.state,
      idempotent: outcome.idempotent,
      artifacts: outcome.artifacts as unknown as JSONValue,
    };
  }

  private async taskResume(data: unknown): Promise<JSONValue> {
    const d = validate('task.resume', data, {
      taskId: { kind: 'string', required: true, max: 256 },
      retryUncertain: { kind: 'boolean' },
      budgetReauthorized: { kind: 'boolean' },
    });
    const taskId = d.taskId as string;
    // M07：预检全过才 interrupted → queued；阻塞原因（含 unknown 操作/费用不确定）原样返回。
    const outcome = await resumeTask(this.deps.service, taskId, {
      retryUncertain: d.retryUncertain === true,
      budgetReauthorized: d.budgetReauthorized === true,
    });
    if (!outcome.ok) {
      return { accepted: false, taskId, block: outcome.block as unknown as JSONValue };
    }
    this.deps.worker.enqueue(taskId);
    return { accepted: true, taskId, state: outcome.state as string };
  }

  private taskApprove(data: unknown): JSONValue {
    const d = validate('task.approve', data, {
      approvalId: { kind: 'string', required: true, max: 256 },
      inputHash: { kind: 'string', required: true, max: 64 },
      decision: { kind: 'string', required: true, enum: ['approved', 'rejected'] as const },
      reason: { kind: 'string', max: 1000 },
    });
    const approvalId = d.approvalId as string;
    const approval = this.deps.service.getApproval(approvalId);
    if (!approval) throw new RuntimeError('APPROVAL_NOT_FOUND', approvalId);
    // M03：inputHash 必须与登记一致（批准不得转移到改过的 args）；过期不得通过。
    const result = this.deps.service.decideApproval(approvalId, d.decision as 'approved' | 'rejected', {
      inputHash: d.inputHash as string,
      ...(d.reason !== undefined ? { reason: d.reason as string } : {}),
    });
    if (result.taskState === 'running') {
      this.deps.worker.enqueue((approval as { taskId: string }).taskId);
    }
    return { approvalId, decision: d.decision as string, taskState: result.taskState ?? null };
  }

  // ── events.since ──────────────────────────────────────

  private eventsSince(data: unknown): JSONValue {
    const d = validate('events.since', data, {
      afterSeq: { kind: 'integer', min: 0 },
      limit: { kind: 'integer', min: 1, max: 1000 },
      taskId: { kind: 'string', max: 256 },
    });
    const afterSeq = (d.afterSeq as number | undefined) ?? 0;
    const limit = (d.limit as number | undefined) ?? 200;
    let events: EventRecord[] = this.deps.service.listEvents(afterSeq, limit);
    if (d.taskId !== undefined) events = events.filter((event) => event.taskId === d.taskId);
    const latest = this.deps.service.store.db
      .prepare('SELECT COALESCE(MAX(eventSeq), 0) AS m FROM events')
      .get() as { m: number };
    return { events: events as unknown as JSONValue, latestSeq: latest.m };
  }

  // ── memory.*（绑定 scope/有限参数；不开放任意 SQL 或主档路径）──────

  private requireMemory(): MemoryAdapter {
    if (!this.deps.memory) throw new RuntimeError('MEMORY_UNAVAILABLE', 'vault mode not active');
    if (!this.deps.memory.available) throw new RuntimeError('MEMORY_UNAVAILABLE', 'vault not available');
    return this.deps.memory;
  }

  private async memorySearch(data: unknown): Promise<JSONValue> {
    const d = validate('memory.search', data, {
      query: { kind: 'string', required: true, max: 1000 },
      limit: { kind: 'integer', min: 1, max: 50 },
      includeArchived: { kind: 'boolean' },
      scope: { kind: 'string', max: 256 },
    });
    const adapter = this.requireMemory();
    const result = await adapter.search(d.query as string, {
      limit: (d.limit as number | undefined) ?? 12,
      includeArchived: d.includeArchived === true,
      ...(d.scope !== undefined ? { scope: d.scope as string } : {}),
    });
    return result as JSONValue;
  }

  private async memoryGet(data: unknown): Promise<JSONValue> {
    const d = validate('memory.get', data, { id: { kind: 'string', required: true, max: 256 } });
    const adapter = this.requireMemory();
    const record = await adapter.get(d.id as string);
    return { record: (record ?? null) as JSONValue };
  }

  private async memoryCorrect(data: unknown): Promise<JSONValue> {
    const d = validate('memory.correct', data, {
      id: { kind: 'string', required: true, max: 256 },
      text: { kind: 'string', required: true, max: 4000 },
      reason: { kind: 'string', max: 1000 },
    });
    const adapter = this.requireMemory();
    if (!(d.text as string).trim()) throw new RuntimeError('INVALID_INPUT', 'memory.correct: empty text');
    const result = await adapter.correct({
      id: d.id as string,
      text: d.text as string,
      reason: (d.reason as string | undefined) ?? 'user correction via IPC',
      userLocator: 'session:' + adapter.sessionId,
    });
    return result as JSONValue;
  }

  private async memoryArchive(data: unknown): Promise<JSONValue> {
    const d = validate('memory.archive', data, {
      ids: { kind: 'stringArray', required: true, maxItems: 20, maxItemBytes: 256 },
      reason: { kind: 'string', max: 1000 },
      dryRun: { kind: 'boolean' },
    });
    const adapter = this.requireMemory();
    const ids = d.ids as unknown as string[];
    if (ids.length === 0) throw new RuntimeError('INVALID_INPUT', 'memory.archive: empty ids');
    const result = await adapter.archive(ids, {
      dryRun: d.dryRun === true,
      ...(d.reason !== undefined ? { reason: d.reason as string } : {}),
      operationId: `${adapter.sessionId}:archive:ipc:${sha256Hex(ids.join('|')).slice(0, 24)}`,
    });
    return result as JSONValue;
  }

  private async memoryRestore(data: unknown): Promise<JSONValue> {
    const d = validate('memory.restore', data, { id: { kind: 'string', required: true, max: 256 } });
    const adapter = this.requireMemory();
    const result = await adapter.restore(d.id as string);
    return result as JSONValue;
  }

  /** M10：记忆页头部统计（计数信息；不含主档路径与原文）。 */
  private async memoryStatus(data: unknown): Promise<JSONValue> {
    validate('memory.status', data, {});
    const adapter = this.requireMemory();
    const stats = await adapter.status();
    return {
      scope: adapter.scope,
      stats: stats as JSONValue,
      outboxPending: adapter.lastOutbox.failed.length,
    } as unknown as JSONValue;
  }

  /** M10：主档快照备份。路径只能由后端生成（SKF_DATA_DIR/backups/），UI 不可指定。 */
  private async memoryBackup(data: unknown): Promise<JSONValue> {
    validate('memory.backup', data, {});
    const adapter = this.requireMemory();
    try {
      const result = await adapter.backup();
      return result as JSONValue;
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new RuntimeError('MEMORY_BACKUP_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  // ── budget.status ─────────────────────────────────────

  private budgetStatus(data: unknown): JSONValue {
    validate('budget.status', data, {
      taskId: { kind: 'string', max: 256 },
    });
    if (!this.deps.gateway) throw new RuntimeError('BUDGET_UNAVAILABLE', 'ModelGateway not initialized');
    return {
      mode: this.deps.budgetMode,
      ...this.deps.gateway.status(data !== null && typeof data === 'object' && !Array.isArray(data) && (data as Record<string, unknown>).taskId !== undefined
        ? { taskId: (data as Record<string, unknown>).taskId as string }
        : {}),
    } as unknown as JSONValue;
  }

  // ── learning.*（M13 影子模式）─────────────────────────────

  private requireLearning(): LearningService {
    if (!this.deps.learning) throw new RuntimeError('LEARNING_DISABLED');
    return this.deps.learning;
  }

  private learningStatus(): JSONValue {
    return this.requireLearning().status();
  }

  private learningReviews(data: unknown): JSONValue {
    const d = validate('learning.reviews', data, {
      taskId: { kind: 'string', max: 256 },
      limit: { kind: 'integer', min: 1, max: 200 },
    });
    const rows = this.requireLearning().listReviews({ taskId: d.taskId as string | undefined, limit: d.limit as number | undefined });
    return { reviews: rows.map((row) => ({ ...row, snapshot: undefined })) as unknown as JSONValue };
  }

  private learningExperiences(data: unknown): JSONValue {
    const d = validate('learning.experiences', data, {
      status: { kind: 'string', enum: ['candidate', 'confirmed', 'disputed', 'deprecated'] },
      kind: { kind: 'string', enum: ['skill', 'lesson', 'fact'] },
      limit: { kind: 'integer', min: 1, max: 500 },
    });
    const rows = listExperiences(this.requireLearning().store, {
      status: d.status as string | undefined,
      kind: d.kind as string | undefined,
      limit: d.limit as number | undefined,
    });
    return { experiences: rows as unknown as JSONValue };
  }

  private learningReviewNow(data: unknown): JSONValue {
    const d = validate('learning.reviewNow', data, {
      taskId: { kind: 'string', required: true, max: 256 },
    });
    return this.requireLearning().requestReviewNow(d.taskId as string) as unknown as JSONValue;
  }

  private async learningPromote(data: unknown): Promise<JSONValue> {
    const d = validate('learning.promote', data, {
      experienceId: { kind: 'string', required: true, max: 256 },
      revision: { kind: 'integer', required: true, min: 1, max: 1000 },
      contentHash: { kind: 'string', required: true, max: 128 },
      enforcement: { kind: 'string', enum: ['advisory', 'approved_checkpoint'] },
      confirmedBy: { kind: 'string', required: true, max: 256 },
      reason: { kind: 'string', max: 1000 },
    });
    const result = await this.requireLearning().promoteExperience({
      experienceId: d.experienceId as string,
      revision: d.revision as number,
      contentHash: d.contentHash as string,
      ...(d.enforcement !== undefined ? { enforcement: d.enforcement as 'advisory' | 'approved_checkpoint' } : {}),
      confirmedBy: d.confirmedBy as string,
      ...(d.reason !== undefined ? { reason: d.reason as string } : {}),
    });
    return result as unknown as JSONValue;
  }

  private learningDispute(data: unknown): JSONValue {
    const d = validate('learning.dispute', data, {
      experienceId: { kind: 'string', required: true, max: 256 },
      reason: { kind: 'string', required: true, max: 1000 },
      counterTaskId: { kind: 'string', max: 256 },
      by: { kind: 'string', required: true, max: 256 },
    });
    this.requireLearning().disputeExperience({
      experienceId: d.experienceId as string,
      reason: d.reason as string,
      ...(d.counterTaskId !== undefined ? { counterTaskId: d.counterTaskId as string } : {}),
      by: d.by as string,
    });
    return { disputed: d.experienceId } as unknown as JSONValue;
  }

  private learningRevise(data: unknown): JSONValue {
    const d = validate('learning.revise', data, {
      experienceId: { kind: 'string', required: true, max: 256 },
      text: { kind: 'string', required: true, max: 4000 },
      reason: { kind: 'string', required: true, max: 1000 },
      by: { kind: 'string', required: true, max: 256 },
    });
    return this.requireLearning().reviseExperience({
      experienceId: d.experienceId as string,
      text: d.text as string,
      reason: d.reason as string,
      by: d.by as string,
    }) as unknown as JSONValue;
  }

  // ── skill.*（M20 只读查询）──────────────────────────────────────

  private requireSkills(): SkillRegistry {
    if (!this.deps.skills) throw new RuntimeError('ACTION_DENIED', 'skill registry not available');
    return this.deps.skills;
  }

  private skillList(): JSONValue {
    return { skills: this.requireSkills().list() as unknown as JSONValue };
  }

  private skillSearch(data: unknown): JSONValue {
    const d = validate('skill.search', data, {
      query: { kind: 'string', required: true, max: 256 },
      limit: { kind: 'integer', min: 1, max: 100 },
    });
    return { skills: this.requireSkills().search(d.query as string, d.limit as number | undefined) as unknown as JSONValue };
  }

  // ── schedule.* ─────────────────────────────────────

  private requireScheduleService(): ScheduleService {
    if (!this.deps.scheduleService) throw new RuntimeError('ACTION_DENIED', 'schedule service not available');
    return this.deps.scheduleService;
  }

  private scheduleCreate(data: unknown): JSONValue {
    const service = this.requireScheduleService();
    const d = validate('schedule.create', data, {
      id: { kind: 'string', max: 256 },
      name: { kind: 'string', required: true, max: 256 },
      cronExpr: { kind: 'string', required: true, max: 256 },
      timezone: { kind: 'string', required: true, max: 64 },
      input: { kind: 'json', required: true, maxBytes: 65_536 },
      provider: { kind: 'string', required: true, max: 128 },
      model: { kind: 'string', required: true, max: 128 },
      sessionId: { kind: 'string', max: 256 },
      scope: { kind: 'string', max: 256 },
      workspaceRoot: { kind: 'string', required: true, max: 1024 },
      enabled: { kind: 'boolean' },
      missedStrategy: { kind: 'string', enum: ['skip', 'latest', 'bounded_all'] as const },
      missedBound: { kind: 'integer', min: 1, max: 256 },
      scheduledEffect: { kind: 'string', enum: ['read', 'workspace_write', 'external_write', 'process'] as const },
      firingApprovalTtlMs: { kind: 'integer', min: 60_000, max: 86_400_000 },
    });
    const schedule = service.createSchedule({
      ...(d.id !== undefined ? { id: d.id as string } : {}),
      name: d.name as string,
      cronExpr: d.cronExpr as string,
      timezone: d.timezone as string,
      input: d.input as JSONValue,
      provider: d.provider as string,
      model: d.model as string,
      ...(d.sessionId !== undefined ? { sessionId: d.sessionId as string } : {}),
      ...(d.scope !== undefined ? { scope: d.scope as string } : {}),
      workspaceRoot: d.workspaceRoot as string,
      ...(d.enabled !== undefined ? { enabled: d.enabled as boolean } : {}),
      ...(d.missedStrategy !== undefined ? { missedStrategy: d.missedStrategy as 'skip' | 'latest' | 'bounded_all' } : {}),
      ...(d.missedBound !== undefined ? { missedBound: d.missedBound as number } : {}),
      ...(d.scheduledEffect !== undefined ? { scheduledEffect: d.scheduledEffect as 'read' | 'workspace_write' | 'external_write' | 'process' } : {}),
      ...(d.firingApprovalTtlMs !== undefined ? { firingApprovalTtlMs: d.firingApprovalTtlMs as number } : {}),
    });
    return { schedule: schedule as unknown as JSONValue };
  }

  private scheduleList(data: unknown): JSONValue {
    const service = this.requireScheduleService();
    const d = validate('schedule.list', data, { limit: { kind: 'integer', min: 1, max: 200 } });
    const schedules = service.listSchedules((d.limit as number | undefined) ?? 50);
    return { schedules: schedules as unknown as JSONValue };
  }

  private scheduleGet(data: unknown): JSONValue {
    const service = this.requireScheduleService();
    const d = validate('schedule.get', data, { id: { kind: 'string', required: true, max: 256 } });
    const schedule = service.getSchedule(d.id as string);
    if (!schedule) throw new RuntimeError('SCHEDULE_NOT_FOUND', d.id as string);
    return { schedule: schedule as unknown as JSONValue };
  }

  private scheduleUpdate(data: unknown): JSONValue {
    const service = this.requireScheduleService();
    const d = validate('schedule.update', data, {
      id: { kind: 'string', required: true, max: 256 },
      cronExpr: { kind: 'string', max: 256 },
      timezone: { kind: 'string', max: 64 },
      input: { kind: 'json', maxBytes: 65_536 },
      name: { kind: 'string', max: 256 },
      missedStrategy: { kind: 'string', enum: ['skip', 'latest', 'bounded_all'] as const },
      missedBound: { kind: 'integer', min: 1, max: 256 },
      scheduledEffect: { kind: 'string', enum: ['read', 'workspace_write', 'external_write', 'process'] as const },
      firingApprovalTtlMs: { kind: 'integer', min: 60_000, max: 86_400_000 },
    });
    const patch: Record<string, JSONValue> = {};
    if (d.cronExpr !== undefined) patch.cronExpr = d.cronExpr as JSONValue;
    if (d.timezone !== undefined) patch.timezone = d.timezone as JSONValue;
    if (d.input !== undefined) patch.input = d.input;
    if (d.name !== undefined) patch.name = d.name as JSONValue;
    if (d.missedStrategy !== undefined) patch.missedStrategy = d.missedStrategy as JSONValue;
    if (d.missedBound !== undefined) patch.missedBound = d.missedBound as JSONValue;
    if (d.scheduledEffect !== undefined) patch.scheduledEffect = d.scheduledEffect as JSONValue;
    if (d.firingApprovalTtlMs !== undefined) patch.firingApprovalTtlMs = d.firingApprovalTtlMs as JSONValue;
    const schedule = service.updateSchedule(d.id as string, patch as never);
    return { schedule: schedule as unknown as JSONValue };
  }

  private scheduleSetEnabled(data: unknown, enabled: boolean): JSONValue {
    const service = this.requireScheduleService();
    const d = validate(enabled ? 'schedule.enable' : 'schedule.disable', data, {
      id: { kind: 'string', required: true, max: 256 },
    });
    const schedule = service.setEnabled(d.id as string, enabled);
    return { schedule: schedule as unknown as JSONValue };
  }

  private scheduleDelete(data: unknown): JSONValue {
    const service = this.requireScheduleService();
    const d = validate('schedule.delete', data, { id: { kind: 'string', required: true, max: 256 } });
    service.deleteSchedule(d.id as string);
    return { id: d.id as string, deleted: true };
  }

  private scheduleFirings(data: unknown): JSONValue {
    const service = this.requireScheduleService();
    const d = validate('schedule.firings', data, {
      id: { kind: 'string', required: true, max: 256 },
      limit: { kind: 'integer', min: 1, max: 500 },
    });
    const firings = service.listFiringsForSchedule(d.id as string, (d.limit as number | undefined) ?? 100);
    return { firings: firings as unknown as JSONValue };
  }
}
