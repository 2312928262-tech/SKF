import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { appendEvent } from './events.js';
import {
  RuntimeError,
  inputHashOf,
  isTerminalTaskState,
  sha256Hex,
  stableStringify,
  type JSONValue,
  type TaskState,
} from './contracts.js';
import type { RuntimeStore } from './runtime-store.js';
import type { TaskRecord, TaskService } from './task-service.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { TaskAuthorization } from '../tools/policy.js';
import type { ToolCall } from '../providers/protocol.js';

/**
 * M07 · 取消、恢复与不确定副作用（02-CONTRACTS.md D/F 节 / 03-TASK-CARDS M07）。
 *
 * 取消语义：
 * - requestTaskCancel 先把取消意图持久化（非终态 → cancelling，事件 task.cancel_requested），
 *   再发 AbortController.abort；重复取消幂等（终态/已取消直接返回现状，不报错）。
 * - 本进程有活跃 worker（controller 已注册）时由 worker 在检查点完成取消（保证在途
 *   副作用先落账）；无活跃 worker 时取消方自己把 cancelling → cancelled 推完。
 * - 终态 CAS：一切任务状态转换走 TASK_TRANSITIONS + revision CAS，迟到的 provider
 *   响应/工具回调只能补事实（消息/操作结果），绝不把终态任务复活成 running/succeeded。
 * - file 写已提交不能撤回：cancelled 任务的结果仍列出已完成 artifact，不假称零影响。
 *
 * 重启对账（reconcileInterruptedOperation）：
 * - prepared（工具从未被调用）：可安全重试；file.write 先核对实物——已发生补记、
 *   实物冲突标 OPERATION_OUTCOME_UNKNOWN 等人工决定，绝不重复覆盖用户内容。
 * - succeeded/failed：重用账本结果（调用方处理，不在本函数）。
 * - running 无结果：转 unknown；file.write 按期望 hash 核对实物补记，其余保守
 *   failed(OPERATION_OUTCOME_UNKNOWN)，不自动重放。
 * - external_write/未知工具 unknown：绝不自动重放，任务明确等待人工核对
 *   （RECOVERY_NEEDS_MANUAL_REVIEW）。SKF 可以恢复自己的计算，但不能保证第三方
 *   系统 exactly-once——已发出的消息/支付可能已生效，重发可能重复。人工核对后
 *   用 resolveUnknownOperation 显式了结。
 *
 * 恢复（resumePreflight/resumeTask）：
 * - 只在用户显式继续时发生：interrupted → queued 前验证工作目录存在可读写、
 *   输入 hash 未损坏、artifact 实物 hash 仍一致（不读取新目录中的“同名文件”当旧
 *   artifact）、授权 root 一致、租约未被其他实例持有、无未决取消意图。
 * - provider 已发但无结果（reserved）费用记 uncertain；resume 默认阻塞
 *   （MODEL_CALL_UNCERTAIN_REVIEW），只有用户显式选择重试且预算重新获准才放行；
 *   放行后旧调用保留 uncertain 账本，循环用新 callId 发新请求，绝不重发同一请求。
 * - schema 不兼容由 RuntimeStore 打开时 DB_SCHEMA_TOO_NEW 阻止；被阻塞的恢复可用
 *   exportTaskEvidence 导出完整任务证据供人工审查。
 */

// ── TaskController：在途任务的取消句柄 ─────────────────────

export class TaskControllerRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(taskId: string, controller: AbortController): void {
    this.controllers.set(taskId, controller);
  }

  unregister(taskId: string, controller: AbortController): void {
    if (this.controllers.get(taskId) === controller) this.controllers.delete(taskId);
  }

  has(taskId: string): boolean {
    return this.controllers.has(taskId);
  }

  /** 只发信号；取消意图必须先已持久化（requestTaskCancel 保证顺序）。 */
  abort(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  signal(taskId: string): AbortSignal | undefined {
    return this.controllers.get(taskId)?.signal;
  }
}

// ── 共享小查询 ─────────────────────────────────────────

export interface ArtifactInfo {
  id: string;
  relativePath: string;
  byteLength: number;
  sha256: string;
  /** M10：登记时的读回校验时间（ISO）；旧记录可能为 null。 */
  verifiedAt: string | null;
}

export function listArtifacts(service: TaskService, taskId: string): ArtifactInfo[] {
  return service.store.db
    .prepare('SELECT id, relativePath, byteLength, sha256, verifiedAt FROM artifacts WHERE taskId = ? ORDER BY relativePath ASC')
    .all(taskId) as unknown as ArtifactInfo[];
}

function countRows(store: RuntimeStore, table: 'model_calls' | 'operations', taskId: string): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE taskId = ?`).get(taskId) as { c: number };
  return row.c;
}

export function progressSig(call: ToolCall, resultContent: string): string {
  return sha256Hex(`${call.name}|${stableStringify(call.arguments as JSONValue)}|${resultContent}`);
}

// ── memory outbox（终态写回幂等键；从 agent-loop 收编）───────

export const MEMORY_OUTBOX_KIND = 'memory_writeback';

export interface MemoryOutboxEntry {
  id: string;
  taskId: string;
  kind: string;
  payload: JSONValue;
}

export function enqueueMemoryOutbox(
  service: TaskService,
  task: TaskRecord,
  state: 'succeeded' | 'failed' | 'cancelled',
  errorCode: string | null,
  /** M09：调用方附加的摘要字段（如聊天轮次的 message/reply/channel 裁剪）。 */
  extra?: Record<string, JSONValue>,
): void {
  service.enqueueOutbox({
    id: `mem:${task.id}`,
    taskId: task.id,
    kind: MEMORY_OUTBOX_KIND,
    payload: {
      taskId: task.id,
      sessionId: task.sessionId,
      scope: task.scope,
      state,
      errorCode,
      goal: extractGoal(task.input).slice(0, 500),
      artifacts: listArtifacts(service, task.id) as unknown as JSONValue,
      ...extra,
    },
  });
}

export function latestMemoryOutbox(service: TaskService, taskId: string): MemoryOutboxEntry | null {
  const row = service.store.db
    .prepare("SELECT id, taskId, kind, payload FROM outbox WHERE taskId = ? AND kind = ? AND state = 'pending'")
    .get(taskId, MEMORY_OUTBOX_KIND) as { id: string; taskId: string; kind: string; payload: string } | undefined;
  return row ? { id: row.id, taskId: row.taskId, kind: row.kind, payload: JSON.parse(row.payload) as JSONValue } : null;
}

/** 记忆投递失败只影响 outbox 状态；任务终态与交付产物不回滚，恢复只补写。 */
export async function deliverMemoryOutbox(
  service: TaskService,
  entry: MemoryOutboxEntry | null,
  flush?: (entry: MemoryOutboxEntry) => Promise<void>,
): Promise<boolean> {
  if (!entry || !flush) return false;
  try {
    await flush(entry);
    service.markOutbox(entry.id, { state: 'done' });
    return true;
  } catch (error) {
    service.markOutbox(entry.id, {
      state: 'failed',
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
    return false;
  }
}

/** 恢复路径的记忆补投递：只处理 pending outbox，绝不重跑任务或工具。 */
export async function flushPendingMemoryOutbox(
  service: TaskService,
  taskId: string,
  flush: (entry: MemoryOutboxEntry) => Promise<void>,
): Promise<{ delivered: number; pending: number }> {
  let delivered = 0;
  for (;;) {
    const entry = latestMemoryOutbox(service, taskId);
    if (!entry) break;
    const ok = await deliverMemoryOutbox(service, entry, flush);
    if (!ok) break;
    delivered++;
  }
  return { delivered, pending: service.pendingOutbox(MEMORY_OUTBOX_KIND).filter((e) => (e as { taskId?: string }).taskId === taskId).length };
}

function extractGoal(input: JSONValue): string {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const goal = (input as Record<string, JSONValue>).goal;
    if (typeof goal === 'string' && goal.trim()) return goal;
  }
  return stableStringify(input).slice(0, 1000);
}

// ── 取消 ───────────────────────────────────────────────

export interface CancelOutcome {
  taskId: string;
  state: TaskState;
  /** true = 取消前已是终态/已取消，本次调用什么都没改（重复取消幂等）。 */
  idempotent: boolean;
  /** 已提交的副作用不撤回：取消后仍列出已完成 artifact。 */
  artifacts: ArtifactInfo[];
}

/**
 * task.cancel：先持久取消意图，再发 abort。
 * - 终态/已取消：幂等返回现状（02-I 重复取消幂等）。
 * - 本进程有活跃 worker：abort 交给 worker 在检查点完成取消（在途副作用先落账）。
 * - 无活跃 worker（queued/interrupted/另一进程的 worker）：取消方直接推完
 *   cancelling → cancelled；另一进程的迟到 worker 只能补事实，不能复活任务。
 */
export async function requestTaskCancel(
  service: TaskService,
  taskId: string,
  opts: {
    controllers?: TaskControllerRegistry;
    reason?: string;
    flushMemoryOutbox?: (entry: MemoryOutboxEntry) => Promise<void>;
  } = {},
): Promise<CancelOutcome> {
  const task = service.getTask(taskId);
  if (!task) throw new RuntimeError('TASK_NOT_FOUND', taskId);
  if (isTerminalTaskState(task.state)) {
    return { taskId, state: task.state, idempotent: true, artifacts: listArtifacts(service, taskId) };
  }
  // M08 补：意图已持久化、worker 正在 finalize 时重复取消必须幂等（02-I），
  // 不能再走 transitionTask('cancelling')（非法跳转会把重复取消变成 500）。
  if (task.state === 'cancelling') {
    opts.controllers?.abort(taskId); // 重发 abort 无害：确保信号确实到达
    return { taskId, state: 'cancelling', idempotent: true, artifacts: listArtifacts(service, taskId) };
  }
  // 1) 先持久取消意图（cancelling 对其余一切非终态可达；终态上面已拦截）。
  service.transitionTask(taskId, 'cancelling', {
    errorCode: 'TASK_CANCELLED',
    event: { type: 'task.cancel_requested', payload: { reason: opts.reason ?? 'user-request' } },
  });
  // 2) 再发 abort。
  const aborted = opts.controllers?.abort(taskId) ?? false;
  if (aborted) {
    // 本进程 worker 会在检查点 finalize（在途 provider/工具副作用先落账）。
    return { taskId, state: 'cancelling', idempotent: false, artifacts: listArtifacts(service, taskId) };
  }
  // 3) 无活跃 worker：自己推完取消。
  return finalizeCancelled(service, taskId, opts);
}

/**
 * cancelling → cancelled 的终态 CAS（worker 检查点与无 worker 取消共用）。
 * 幂等：已 cancelled 直接返回现状。结果列出已完成 artifact（已发生不撤回）。
 */
export async function finalizeCancelled(
  service: TaskService,
  taskId: string,
  opts: { flushMemoryOutbox?: (entry: MemoryOutboxEntry) => Promise<void> } = {},
): Promise<CancelOutcome> {
  let task = service.getTask(taskId);
  if (!task) throw new RuntimeError('TASK_NOT_FOUND', taskId);
  const alreadyCancelled = task.state === 'cancelled';
  if (task.state === 'cancelling') {
    service.store.transaction(() => {
      service.transitionTask(taskId, 'cancelled', {
        errorCode: 'TASK_CANCELLED',
        event: {
          type: 'task.cancelled',
          payload: {
            artifacts: listArtifacts(service, taskId).map((a) => a.relativePath) as unknown as JSONValue,
            modelSteps: countRows(service.store, 'model_calls', taskId),
            toolCalls: countRows(service.store, 'operations', taskId),
          },
        },
      });
      enqueueMemoryOutbox(service, task!, 'cancelled', 'TASK_CANCELLED');
    });
    task = service.getTask(taskId)!;
    await deliverMemoryOutbox(service, latestMemoryOutbox(service, taskId), opts.flushMemoryOutbox);
  }
  return {
    taskId,
    state: task.state,
    idempotent: alreadyCancelled,
    artifacts: listArtifacts(service, taskId),
  };
}

// ── 重启 operation 对账 ──────────────────────────────────

/** 本工具面内可核对/可安全重试的工具；其余一律按外部副作用对待。 */
const LOCAL_RECONCILABLE_TOOLS: ReadonlySet<string> = new Set(['file.read', 'file.write', 'file.list', 'file.stat']);

export interface ReconcileDeps {
  service: TaskService;
  tools: ToolRegistry;
  authorization: TaskAuthorization;
  logger?: (line: string) => void;
}

export interface ReconcileHooks {
  /** 回灌同 ID tool message（缺失才追加）。 */
  feedBack(content: string): void;
  /** prepared 确认未开始后的安全重试：调用方执行工具并持久化结果。
   *  M14：副作用工具可能返回 approvalPending（审批门复核不通过，操作继续停 prepared）。 */
  executeFresh(call: ToolCall, operationId: string): Promise<{
    content?: string;
    progress?: { sig: string };
    approvalPending?: { approvalId: string; inputHash: string; tool: string };
  }>;
}

export interface ReconcileOutcome {
  content?: string;
  progress?: { sig: string };
  /** 外部副作用 unknown：任务必须停下等人工核对（不自动重放、不假装没发生）。 */
  needsReview?: boolean;
  /** M14：重驱 prepared 副作用操作时发现审批仍未决，任务回 waiting_approval。 */
  approvalPending?: { approvalId: string; inputHash: string; tool: string };
}

/**
 * 崩溃遗留操作的可信了结。副作用宁可保守标 unknown，也绝不假定没发生（02-F）；
 * 已发生的写按实物补记，不重复覆盖；未开始的 prepared 可以安全重试。
 */
export async function reconcileInterruptedOperation(
  deps: ReconcileDeps,
  task: TaskRecord,
  call: ToolCall,
  operationId: string,
  state: string,
  hooks: ReconcileHooks,
): Promise<ReconcileOutcome> {
  const { service, tools } = deps;
  const taskId = task.id;
  const args = call.arguments as Record<string, JSONValue>;

  // 外部/未知工具：external_write unknown 不自动重放，任务明确等待人工核对。
  // SKF 不能保证第三方 exactly-once：已发出的副作用可能已生效，重发可能重复。
  if (!LOCAL_RECONCILABLE_TOOLS.has(call.name)) {
    // M14：任何工具的 prepared ⟹ 请求从未发出（transitionOperation('running') 只在
    // executeFresh 审批门之后发生）——审批挂起/崩溃遗留的 prepared 均可安全重驱，
    // 重驱时编排层审批门照常复核，绝不绕过审批。
    if (state === 'prepared') {
      return hooks.executeFresh(call, operationId);
    }
    // running/unknown：副作用已可能发出，不自动重放，任务明确等待人工核对。
    service.store.transaction(() => {
      const current = service.getOperation(operationId) as { state: string } | null;
      if (current && current.state === 'running') service.transitionOperation(operationId, 'unknown');
      appendEvent(service.store, taskId, 'task.operation_needs_review', { callId: call.id, tool: call.name, operationId });
    });
    deps.logger?.(`operation ${operationId} (${call.name}) unknown external effect; waiting for manual review`);
    return { needsReview: true };
  }

  const markOutcomeUnknown = (): ReconcileOutcome => {
    service.store.transaction(() => {
      if (state === 'running') service.transitionOperation(operationId, 'unknown');
      service.transitionOperation(operationId, 'failed', {
        result: { error: { code: 'OPERATION_OUTCOME_UNKNOWN', retryable: false } },
      });
    });
    const content = stableStringify({ error: { code: 'OPERATION_OUTCOME_UNKNOWN', retryable: false } });
    hooks.feedBack(content);
    return { content };
  };

  if (call.name === 'file.write' && typeof args.path === 'string' && typeof args.content === 'string') {
    const contentBuf = Buffer.from(args.content, 'utf8');
    const expected = createHash('sha256').update(contentBuf).digest('hex');
    const check = await tools.execute(`${call.id}:verify`, 'file.stat', { path: args.path }, {
      taskId,
      workspaceRoot: task.workspaceRoot,
      authorization: deps.authorization,
      logger: deps.logger,
    });
    if (check.ok) {
      const statResult = JSON.parse(check.content) as { sha256?: string | null; byteLength?: number | null };
      if (statResult.sha256 === expected) {
        // 已发生：按实物补记 succeeded + artifact，不重复写入（恢复不重复工具副作用）。
        const result = {
          path: args.path,
          byteLength: statResult.byteLength ?? contentBuf.length,
          sha256: expected,
          created: false,
          recovered: true,
        };
        service.store.transaction(() => {
          moveOperationToSucceeded(service, operationId, state, result as unknown as JSONValue);
          service.registerArtifact({
            id: randomUUID(),
            taskId,
            operationId,
            relativePath: args.path as string,
            byteLength: result.byteLength,
            sha256: expected,
          });
          appendEvent(service.store, taskId, 'task.tool_recovered', { callId: call.id, tool: call.name, via: 'disk-evidence' });
        });
        const content = stableStringify(result as unknown as JSONValue);
        hooks.feedBack(content);
        return { content, progress: { sig: progressSig(call, content) } };
      }
      // 实物冲突（用户/他人内容）：人工决定，绝不重复覆盖。
      return markOutcomeUnknown();
    }
    // 磁盘无此文件：prepared = 工具从未被调用，可安全重试；
    // running/unknown = 已调用但无结果，副作用不确定，保守了结。
    if (state === 'prepared') {
      return hooks.executeFresh(call, operationId);
    }
    return markOutcomeUnknown();
  }

  // 只读本地工具：prepared 未开始可安全重试；running/unknown 保守（不假定没执行）。
  if (state === 'prepared') {
    return hooks.executeFresh(call, operationId);
  }
  return markOutcomeUnknown();
}

/** 把遗留操作推进到 succeeded：按当前状态走合法迁移路径。 */
function moveOperationToSucceeded(service: TaskService, operationId: string, state: string, result: JSONValue): void {
  if (state === 'prepared') service.transitionOperation(operationId, 'running');
  else if (state === 'running') service.transitionOperation(operationId, 'unknown');
  service.transitionOperation(operationId, 'succeeded', { result });
}

/** 人工核对了结 unknown 操作（external_write 等）：核对第三方实物后显式登记结果。 */
export function resolveUnknownOperation(
  service: TaskService,
  operationId: string,
  outcome: {
    decision: 'succeeded' | 'failed';
    result?: JSONValue;
    artifact?: { relativePath: string; byteLength: number; sha256: string };
  },
): void {
  service.store.transaction(() => {
    const op = service.getOperation(operationId) as { state: string; taskId: string } | null;
    if (!op) throw new RuntimeError('OPERATION_NOT_FOUND', operationId);
    if (op.state !== 'unknown') throw new RuntimeError('INVALID_TRANSITION', `operation ${op.state} != unknown`);
    const result =
      outcome.result ??
      (outcome.decision === 'failed'
        ? ({ error: { code: 'MANUAL_REVIEW_REJECTED', retryable: false } } as JSONValue)
        : ({ manual: true } as JSONValue));
    service.transitionOperation(operationId, outcome.decision, { result });
    if (outcome.decision === 'succeeded' && outcome.artifact) {
      service.registerArtifact({
        id: randomUUID(),
        taskId: op.taskId,
        operationId,
        relativePath: outcome.artifact.relativePath,
        byteLength: outcome.artifact.byteLength,
        sha256: outcome.artifact.sha256,
      });
    }
    appendEvent(service.store, op.taskId, 'task.operation_resolved', {
      operationId,
      decision: outcome.decision,
      by: 'manual-review',
    });
  });
}

// ── 恢复预检与执行 ─────────────────────────────────────

export interface ResumeBlock {
  code: string;
  detail: string;
  unknownOperations?: string[];
  uncertainCalls?: string[];
  staleArtifacts?: string[];
}

export interface ResumePreflightResult {
  ok: boolean;
  block?: ResumeBlock;
}

/**
 * interrupted → queued 前的恢复预检（02-D：用户继续且恢复检查通过）。
 * 任何一项不通过都阻止恢复；exportTaskEvidence 可导出供人工审查。
 */
export async function resumePreflight(
  service: TaskService,
  taskId: string,
  opts: {
    /** 调用方持有的任务授权 root；与任务快照不一致 = 越权恢复。 */
    authorizationRoot?: string;
    /** 用户显式选择重试不确定调用。 */
    retryUncertain?: boolean;
    /** 重试不确定调用的预算已重新获准。 */
    budgetReauthorized?: boolean;
    now?: number;
  } = {},
): Promise<ResumePreflightResult> {
  const block = (code: string, detail: string, extra: Partial<ResumeBlock> = {}): ResumePreflightResult => ({
    ok: false,
    block: { code, detail, ...extra },
  });

  const task = service.getTask(taskId);
  if (!task) throw new RuntimeError('TASK_NOT_FOUND', taskId);
  if (task.state !== 'interrupted') {
    return block('INVALID_TRANSITION', `resume requires interrupted, got ${task.state}`);
  }
  // 输入完整性：hash 损坏的任务不恢复。
  if (inputHashOf(task.input) !== task.inputHash) {
    return block('RESUME_INPUT_MISMATCH', 'stored input no longer matches inputHash');
  }
  // 未决取消意图：崩溃前用户已要求取消的任务不复活（取消复活是停线事故）。
  const lastIntent = service.store.db
    .prepare(
      "SELECT type FROM events WHERE taskId = ? AND type IN ('task.cancel_requested','task.resumed') ORDER BY eventSeq DESC LIMIT 1",
    )
    .get(taskId) as { type: string } | undefined;
  if (lastIntent?.type === 'task.cancel_requested') {
    return block('RESUME_CANCEL_INTENT', 'cancel was requested before interruption; finalize cancel instead of resuming');
  }
  // 工作目录：必须存在、是目录、可读写；不拿新目录的同名文件当旧 artifact（下面 hash 核对）。
  let rootReal: string;
  try {
    rootReal = await realpath(task.workspaceRoot);
    const st = await stat(rootReal);
    if (!st.isDirectory()) return block('RESUME_WORKSPACE_MISSING', `${task.workspaceRoot} is not a directory`);
    await access(rootReal, constants.R_OK | constants.W_OK);
  } catch {
    return block('RESUME_WORKSPACE_MISSING', `${task.workspaceRoot} missing or inaccessible`);
  }
  // 授权 root 与任务快照一致（权限）。
  if (opts.authorizationRoot !== undefined && opts.authorizationRoot !== task.workspaceRoot) {
    return block('POLICY_DENIED', 'authorization root mismatch with task workspaceRoot');
  }
  // 租约：其他实例持有有效租约时不恢复。
  const lease = service.store.db
    .prepare('SELECT ownerInstanceId, expiresAt FROM leases WHERE name = ?')
    .get(`task:${taskId}`) as { ownerInstanceId: string; expiresAt: number } | undefined;
  const now = opts.now ?? Date.now();
  if (lease && lease.expiresAt > now && lease.ownerInstanceId !== service.instanceId) {
    return block('LEASE_HELD', `task lease held by ${lease.ownerInstanceId}`);
  }
  // artifact 实物核对：记录过的产物必须仍与登记 hash 一致（防恢复到被替换的目录）。
  const stale: string[] = [];
  for (const artifact of listArtifacts(service, taskId)) {
    try {
      const buf = await readFile(join(rootReal, artifact.relativePath));
      if (createHash('sha256').update(buf).digest('hex') !== artifact.sha256) stale.push(artifact.relativePath);
    } catch {
      stale.push(artifact.relativePath);
    }
  }
  if (stale.length > 0) {
    return block('RESUME_ARTIFACT_MISMATCH', 'recorded artifacts no longer match disk', { staleArtifacts: stale });
  }
  // external_write/未知工具 unknown：不自动重放，任务明确等待人工核对。
  const unknownOps = service.store.db
    .prepare("SELECT id, toolName FROM operations WHERE taskId = ? AND state = 'unknown'")
    .all(taskId) as unknown as Array<{ id: string; toolName: string }>;
  const needsReview = unknownOps.filter((op) => !LOCAL_RECONCILABLE_TOOLS.has(op.toolName));
  if (needsReview.length > 0) {
    return block('RECOVERY_NEEDS_MANUAL_REVIEW', 'unknown external effects are never auto-replayed; resolve via resolveUnknownOperation', {
      unknownOperations: needsReview.map((op) => `${op.toolName}:${op.id}`),
    });
  }
  // provider 已发但无结果：费用 uncertain；默认不恢复（不重发同一贵请求），
  // 除非用户显式选择重试且预算重新获准。
  const reserved = service.store.db
    .prepare("SELECT id FROM model_calls WHERE taskId = ? AND state = 'reserved'")
    .all(taskId) as unknown as Array<{ id: string }>;
  const uncertain = service.store.db
    .prepare("SELECT id FROM model_calls WHERE taskId = ? AND state = 'uncertain'")
    .all(taskId) as unknown as Array<{ id: string }>;
  const uncertainIds = [...reserved.map((r) => r.id), ...uncertain.map((r) => r.id)];
  if (uncertainIds.length > 0) {
    if (!opts.retryUncertain) {
      return block('MODEL_CALL_UNCERTAIN_REVIEW', 'provider request may have been billed; resume would issue a NEW call and never resend the same request', {
        uncertainCalls: uncertainIds,
      });
    }
    if (!opts.budgetReauthorized) {
      return block('BUDGET_REAUTH_REQUIRED', 'retrying uncertain calls requires fresh budget authorization', {
        uncertainCalls: uncertainIds,
      });
    }
  }
  return { ok: true };
}

export interface ResumeOutcome {
  ok: boolean;
  taskId: string;
  state?: TaskState;
  block?: ResumeBlock;
}

/**
 * 恢复执行：预检全过才把 interrupted → queued（事件 task.resumed）。
 * 遗留 reserved 调用在同一事务内标 uncertain（保守占额），循环后续用新 callId
 * 发新请求；同一请求绝不重发。
 */
export async function resumeTask(
  service: TaskService,
  taskId: string,
  opts: Parameters<typeof resumePreflight>[2] = {},
): Promise<ResumeOutcome> {
  const pre = await resumePreflight(service, taskId, opts);
  if (!pre.ok) return { ok: false, taskId, block: pre.block };
  service.store.transaction(() => {
    const reserved = service.store.db
      .prepare("SELECT id FROM model_calls WHERE taskId = ? AND state = 'reserved'")
      .all(taskId) as unknown as Array<{ id: string }>;
    for (const row of reserved) {
      // 已发无结果：费用保守记 uncertain，不无证据退款成 0，也不重发。
      service.settleModelCall(row.id, { state: 'uncertain' });
    }
    service.transitionTask(taskId, 'queued', {
      event: {
        type: 'task.resumed',
        payload: {
          retryUncertain: opts.retryUncertain === true,
          uncertainMarked: reserved.map((r) => r.id) as unknown as JSONValue,
        },
      },
    });
  });
  return { ok: true, taskId, state: 'queued' };
}

// ── 证据导出（schema 不兼容/恢复被阻时的人工审查出口）─────────

export function exportTaskEvidence(service: TaskService, taskId: string): JSONValue {
  const task = service.getTask(taskId);
  if (!task) throw new RuntimeError('TASK_NOT_FOUND', taskId);
  const rows = (sql: string) => service.store.db.prepare(sql).all(taskId) as unknown as JSONValue[];
  return {
    schemaVersion: service.store.schemaVersion(),
    exportedAt: new Date().toISOString(),
    task: task as unknown as JSONValue,
    messages: service.listMessages(taskId) as unknown as JSONValue,
    operations: rows('SELECT * FROM operations WHERE taskId = ? ORDER BY startedAt ASC, id ASC'),
    artifacts: rows('SELECT * FROM artifacts WHERE taskId = ? ORDER BY relativePath ASC'),
    modelCalls: rows('SELECT * FROM model_calls WHERE taskId = ? ORDER BY createdAt ASC, id ASC'),
    outbox: rows('SELECT * FROM outbox WHERE taskId = ? ORDER BY createdAt ASC, id ASC'),
    approvals: rows('SELECT * FROM approvals WHERE taskId = ? ORDER BY expiresAt ASC, id ASC'),
    events: service.listEvents(0, 1000).filter((e) => e.taskId === taskId) as unknown as JSONValue,
  } as JSONValue;
}
