import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPROVAL_DECISIONS,
  EFFECTS,
  MODEL_CALL_PURPOSES,
  OPERATION_TRANSITIONS,
  RECOVERY_INTERRUPT_SOURCES,
  RuntimeError,
  TASK_TRANSITIONS,
  inputHashOf,
  isTerminalTaskState,
  nowIso,
  stableStringify,
  type ApprovalDecision,
  type Effect,
  type JSONValue,
  type ModelCallPurpose,
  type ModelCallState,
  type OperationState,
  type TaskState,
} from './contracts.js';
import { appendEvent, eventsSince, type EventRecord } from './events.js';
import type { RuntimeStore } from './runtime-store.js';

/**
 * M03 · 任务服务：幂等创建、CAS 状态转换、消息/步骤/操作/产物/审批/模型调用/outbox、
 * lease 原子竞争 + fencing token、崩溃恢复标识、旧 tasks/*.json 隔离导入演练。
 *
 * 多实例规则（不靠 UI 禁钮）：worker 必须先 claimTask 拿到 fencing token 才能执行任务；
 * 第二实例 claim 同一任务得到 LEASE_HELD，读接口（getTask/listEvents 等）不受影响。
 * 每个任务在创建时固定 provider/model 快照，之后全局切换不影响在途任务。
 */

export interface TaskRecord {
  id: string;
  inputHash: string;
  input: JSONValue;
  sessionId: string;
  scope: string;
  workspaceRoot: string;
  state: TaskState;
  provider: string;
  model: string;
  acceptance: JSONValue | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
}

export interface CreateTaskInput {
  id: string;
  input: JSONValue;
  sessionId: string;
  scope: string;
  workspaceRoot: string;
  provider: string;
  model: string;
  acceptance?: JSONValue;
}

interface TaskRow {
  id: string;
  inputHash: string;
  input: string;
  sessionId: string;
  scope: string;
  workspaceRoot: string;
  state: string;
  provider: string;
  model: string;
  acceptance: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
}

function toTaskRecord(row: TaskRow): TaskRecord {
  return {
    ...row,
    state: row.state as TaskState,
    input: JSON.parse(row.input) as JSONValue,
    acceptance: row.acceptance === null ? null : (JSON.parse(row.acceptance) as JSONValue),
  };
}

const ID_PATTERN = /^[^\x00-\x1f\\/]{1,256}$/;

function requireId(value: string, field: string) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new RuntimeError('INVALID_INPUT', field);
}

function requireText(value: string, field: string, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new RuntimeError('INVALID_INPUT', field);
  }
}

export class TaskService {
  constructor(
    readonly store: RuntimeStore,
    readonly instanceId: string = randomUUID(),
  ) {}

  // ── 任务创建（幂等）──────────────────────────────────

  createTask(req: CreateTaskInput): TaskRecord {
    requireId(req.id, 'id');
    requireText(req.sessionId, 'sessionId', 256);
    requireText(req.scope, 'scope', 256);
    requireText(req.workspaceRoot, 'workspaceRoot', 1024);
    requireText(req.provider, 'provider', 128);
    requireText(req.model, 'model', 128);
    const inputCanonical = stableStringify(req.input);
    const inputHash = inputHashOf(req.input);
    const acceptance = req.acceptance === undefined ? null : stableStringify(req.acceptance);
    return this.store.transaction(() => {
      const existing = this.getTaskRow(req.id);
      if (existing) {
        // 同 ID 同输入：返回原状态，不重建、不改 revision。
        if (existing.inputHash === inputHash) return toTaskRecord(existing);
        throw new RuntimeError('REQUEST_ID_CONFLICT', req.id);
      }
      const now = nowIso();
      this.store.db
        .prepare(
          `INSERT INTO tasks (id, inputHash, input, sessionId, scope, workspaceRoot, state, provider, model, acceptance, revision, createdAt, updatedAt, errorCode)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, NULL)`,
        )
        .run(req.id, inputHash, inputCanonical, req.sessionId, req.scope, req.workspaceRoot, req.provider, req.model, acceptance, now, now);
      appendEvent(this.store, req.id, 'task.created', { state: 'queued', provider: req.provider, model: req.model });
      return toTaskRecord(this.getTaskRow(req.id)!);
    });
  }

  getTask(id: string): TaskRecord | null {
    const row = this.getTaskRow(id);
    return row ? toTaskRecord(row) : null;
  }

  listTasks(limit = 100): TaskRecord[] {
    const rows = this.store.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt ASC, id ASC LIMIT ?')
      .all(Math.min(Math.max(1, limit), 1000)) as unknown as TaskRow[];
    return rows.map(toTaskRecord);
  }

  private getTaskRow(id: string): TaskRow | undefined {
    return this.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  }

  // ── CAS 状态转换 ─────────────────────────────────────

  transitionTask(
    id: string,
    to: TaskState,
    opts: { expectedRevision?: number; errorCode?: string; event?: { type: string; payload: JSONValue } } = {},
  ): TaskRecord {
    return this.store.transaction(() => {
      const row = this.getTaskRow(id);
      if (!row) throw new RuntimeError('TASK_NOT_FOUND', id);
      const from = row.state as TaskState;
      // 终态拒绝一切迟到回调（包括同态写入）。
      if (isTerminalTaskState(from)) throw new RuntimeError('TASK_TERMINAL', `${from} → ${to}`);
      if (opts.expectedRevision !== undefined && row.revision !== opts.expectedRevision) {
        throw new RuntimeError('CONCURRENT_MODIFICATION', `revision ${row.revision} != ${opts.expectedRevision}`);
      }
      if (!TASK_TRANSITIONS[from].includes(to)) {
        throw new RuntimeError('INVALID_TRANSITION', `${from} → ${to}`);
      }
      const now = nowIso();
      const result = this.store.db
        .prepare('UPDATE tasks SET state = ?, revision = revision + 1, updatedAt = ?, errorCode = ? WHERE id = ? AND revision = ?')
        .run(to, now, opts.errorCode ?? null, id, row.revision);
      if (Number(result.changes) !== 1) throw new RuntimeError('CONCURRENT_MODIFICATION', id);
      appendEvent(this.store, id, opts.event?.type ?? 'task.state', opts.event?.payload ?? { from, to });
      return toTaskRecord(this.getTaskRow(id)!);
    });
  }

  // ── 消息（持久 seq 排序）─────────────────────────────

  appendMessage(
    taskId: string,
    message: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: JSONValue; toolCallId?: string; name?: string; reasoningContent?: string },
  ): { seq: number } {
    return this.store.transaction(() => {
      if (!this.getTaskRow(taskId)) throw new RuntimeError('TASK_NOT_FOUND', taskId);
      const row = this.store.db.prepare('SELECT MAX(seq) AS m FROM messages WHERE taskId = ?').get(taskId) as { m: number | null };
      const seq = (row.m ?? 0) + 1;
      this.store.db
        .prepare('INSERT INTO messages (taskId, seq, role, content, toolCalls, toolCallId, name, reasoningContent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          taskId,
          seq,
          message.role,
          message.content,
          message.toolCalls === undefined ? null : stableStringify(message.toolCalls),
          message.toolCallId ?? null,
          message.name ?? null,
          message.reasoningContent ?? null,
        );
      return { seq };
    });
  }

  listMessages(taskId: string) {
    const rows = this.store.db
      .prepare('SELECT seq, role, content, toolCalls, toolCallId, name, reasoningContent FROM messages WHERE taskId = ? ORDER BY seq ASC')
      .all(taskId) as unknown as Array<{ seq: number; role: string; content: string; toolCalls: string | null; toolCallId: string | null; name: string | null; reasoningContent: string | null }>;
    return rows.map((row) => ({
      ...row,
      toolCalls: row.toolCalls === null ? null : (JSON.parse(row.toolCalls) as JSONValue),
    }));
  }

  // ── 步骤与工具操作 ───────────────────────────────────

  startStep(req: { id: string; taskId: string; stepIndex: number; phase: string; requestHash?: string }): void {
    requireId(req.id, 'step.id');
    if (!Number.isSafeInteger(req.stepIndex) || req.stepIndex < 0) throw new RuntimeError('INVALID_INPUT', 'stepIndex');
    this.store.transaction(() => {
      if (!this.getTaskRow(req.taskId)) throw new RuntimeError('TASK_NOT_FOUND', req.taskId);
      this.store.db
        .prepare('INSERT INTO steps (id, taskId, stepIndex, phase, state, requestHash, providerCallId) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(req.id, req.taskId, req.stepIndex, req.phase, 'running', req.requestHash ?? null);
    });
  }

  completeStep(id: string, state: 'succeeded' | 'failed', providerCallId?: string): void {
    const result = this.store.db
      .prepare("UPDATE steps SET state = ?, providerCallId = ? WHERE id = ? AND state = 'running'")
      .run(state, providerCallId ?? null, id);
    if (Number(result.changes) !== 1) throw new RuntimeError('INVALID_TRANSITION', `step ${id}`);
  }

  createOperation(req: { id: string; taskId: string; stepId?: string; callId: string; toolName: string; input: JSONValue }): void {
    requireId(req.id, 'operation.id');
    requireId(req.callId, 'callId');
    requireText(req.toolName, 'toolName', 128);
    const inputHash = inputHashOf(req.input);
    this.store.transaction(() => {
      if (!this.getTaskRow(req.taskId)) throw new RuntimeError('TASK_NOT_FOUND', req.taskId);
      const existing = this.store.db
        .prepare('SELECT id, inputHash FROM operations WHERE taskId = ? AND callId = ?')
        .get(req.taskId, req.callId) as { id: string; inputHash: string } | undefined;
      if (existing) {
        // 同一 callId 重放：同输入幂等，不同输入拒绝（重试不得随机换参数）。
        if (existing.inputHash === inputHash) return;
        throw new RuntimeError('REQUEST_ID_CONFLICT', `operation ${req.callId}`);
      }
      this.store.db
        .prepare('INSERT INTO operations (id, taskId, stepId, callId, toolName, inputHash, state, result, startedAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)')
        .run(req.id, req.taskId, req.stepId ?? null, req.callId, req.toolName, inputHash, 'prepared');
    });
  }

  transitionOperation(id: string, to: OperationState, opts: { result?: JSONValue; now?: string } = {}): void {
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT state FROM operations WHERE id = ?').get(id) as { state: OperationState } | undefined;
      if (!row) throw new RuntimeError('OPERATION_NOT_FOUND', id);
      if (!OPERATION_TRANSITIONS[row.state].includes(to)) {
        throw new RuntimeError('INVALID_TRANSITION', `operation ${row.state} → ${to}`);
      }
      const now = opts.now ?? nowIso();
      const startedAt = to === 'running' ? now : null;
      const completed = to === 'succeeded' || to === 'failed';
      this.store.db
        .prepare(
          `UPDATE operations SET state = ?,
             result = COALESCE(?, result),
             startedAt = COALESCE(?, startedAt),
             completedAt = CASE WHEN ? THEN ? ELSE completedAt END
           WHERE id = ?`,
        )
        .run(to, opts.result === undefined ? null : stableStringify(opts.result), startedAt, completed ? 1 : 0, completed ? now : null, id);
    });
  }

  getOperation(id: string) {
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...row, result: row.result === null ? null : JSON.parse(row.result as string) };
  }

  registerArtifact(req: { id: string; taskId: string; operationId?: string; relativePath: string; byteLength: number; sha256: string }): void {
    requireId(req.id, 'artifact.id');
    if (!/^[a-f0-9]{64}$/.test(req.sha256)) throw new RuntimeError('INVALID_INPUT', 'sha256');
    if (!Number.isSafeInteger(req.byteLength) || req.byteLength < 0) throw new RuntimeError('INVALID_INPUT', 'byteLength');
    if (req.relativePath.includes('..') || /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(req.relativePath)) {
      throw new RuntimeError('INVALID_INPUT', 'relativePath');
    }
    this.store.transaction(() => {
      if (!this.getTaskRow(req.taskId)) throw new RuntimeError('TASK_NOT_FOUND', req.taskId);
      if (req.operationId !== undefined) {
        const op = this.store.db.prepare('SELECT state FROM operations WHERE id = ?').get(req.operationId) as { state: string } | undefined;
        if (!op) throw new RuntimeError('OPERATION_NOT_FOUND', req.operationId);
        // 错误路径不得提前落 artifact-success（02-E）：artifact 只能挂到已成功的操作上。
        if (op.state !== 'succeeded') throw new RuntimeError('OPERATION_NOT_SUCCEEDED', req.operationId);
      }
      this.store.db
        .prepare('INSERT INTO artifacts (id, taskId, operationId, relativePath, byteLength, sha256, verifiedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(req.id, req.taskId, req.operationId ?? null, req.relativePath, req.byteLength, req.sha256);
    });
  }

  markArtifactVerified(id: string, verifiedAt = nowIso()): void {
    const result = this.store.db.prepare('UPDATE artifacts SET verifiedAt = ? WHERE id = ?').run(verifiedAt, id);
    if (Number(result.changes) !== 1) throw new RuntimeError('ARTIFACT_NOT_FOUND', id);
  }

  // ── 审批（参数 hash 绑定，不过期转移）────────────────

  requestApproval(req: { id: string; taskId: string; operationId?: string; inputHash: string; effect: Effect; ttlMs: number; now?: Date }): void {
    requireId(req.id, 'approval.id');
    if (!EFFECTS.includes(req.effect)) throw new RuntimeError('INVALID_INPUT', 'effect');
    if (!Number.isSafeInteger(req.ttlMs) || req.ttlMs < 1) throw new RuntimeError('INVALID_INPUT', 'ttlMs');
    const now = req.now ?? new Date();
    const expiresAt = new Date(now.getTime() + req.ttlMs).toISOString();
    this.store.transaction(() => {
      if (!this.getTaskRow(req.taskId)) throw new RuntimeError('TASK_NOT_FOUND', req.taskId);
      this.store.db
        .prepare("INSERT INTO approvals (id, taskId, operationId, inputHash, effect, decision, reason, expiresAt, decidedAt) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)")
        .run(req.id, req.taskId, req.operationId ?? null, req.inputHash, req.effect, expiresAt);
    });
  }

  /**
   * 批准/拒绝。inputHash 必须与登记一致（批准不得转移到改过的 args）；过期不得通过。
   * 若对应任务正 waiting_approval，同一事务内推进：批准 → running，拒绝 → failed(APPROVAL_REJECTED)。
   */
  decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    req: { inputHash: string; reason?: string; now?: Date } ,
  ): { taskState?: TaskState } {
    const now = req.now ?? new Date();
    // 过期审批先把 expired 标记落库（独立事务提交），再拒绝；不能让拒绝把标记一起回滚。
    const preCheck = this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT taskId, decision, expiresAt FROM approvals WHERE id = ?').get(id) as
        | { taskId: string; decision: ApprovalDecision; expiresAt: string }
        | undefined;
      if (row && row.decision === 'pending' && now.toISOString() > row.expiresAt) {
        this.store.db.prepare("UPDATE approvals SET decision = 'expired', decidedAt = ? WHERE id = ?").run(now.toISOString(), id);
        appendEvent(this.store, row.taskId, 'approval.decided', { approvalId: id, decision: 'expired' });
        return true;
      }
      return false;
    });
    if (preCheck) throw new RuntimeError('APPROVAL_EXPIRED', id);
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
        | { id: string; taskId: string; inputHash: string; decision: ApprovalDecision; expiresAt: string }
        | undefined;
      if (!row) throw new RuntimeError('APPROVAL_NOT_FOUND', id);
      if (row.decision !== 'pending') throw new RuntimeError('INVALID_TRANSITION', `approval ${row.decision}`);
      if (row.inputHash !== req.inputHash) throw new RuntimeError('APPROVAL_INPUT_CONFLICT', id);
      this.store.db
        .prepare('UPDATE approvals SET decision = ?, reason = ?, decidedAt = ? WHERE id = ?')
        .run(decision, req.reason ?? null, now.toISOString(), id);
      appendEvent(this.store, row.taskId, 'approval.decided', { approvalId: id, decision });
      const task = this.getTaskRow(row.taskId);
      if (task && task.state === 'waiting_approval') {
        const to: TaskState = decision === 'approved' ? 'running' : 'failed';
        const nowText = now.toISOString();
        this.store.db
          .prepare('UPDATE tasks SET state = ?, revision = revision + 1, updatedAt = ?, errorCode = ? WHERE id = ? AND revision = ?')
          .run(to, nowText, decision === 'rejected' ? 'APPROVAL_REJECTED' : null, row.taskId, task.revision);
        appendEvent(this.store, row.taskId, 'task.state', { from: 'waiting_approval', to, approvalId: id });
        return { taskState: to };
      }
      return {};
    });
  }

  getApproval(id: string) {
    return (this.store.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined) ?? null;
  }

  // ── 模型调用账本（金额结算是 M06；这里只保证记录与口径字段）──

  recordModelCall(req: {
    id: string;
    taskId: string;
    purpose: ModelCallPurpose;
    provider: string;
    model: string;
    reservedCostMicros?: number;
    tariffVersion?: string;
  }): void {
    requireId(req.id, 'modelCall.id');
    if (!MODEL_CALL_PURPOSES.includes(req.purpose)) throw new RuntimeError('INVALID_PURPOSE', String(req.purpose));
    this.store.transaction(() => {
      if (!this.getTaskRow(req.taskId)) throw new RuntimeError('TASK_NOT_FOUND', req.taskId);
      this.store.db
        .prepare(
          `INSERT INTO model_calls (id, taskId, purpose, provider, model, state, reservedCostMicros, settledCostMicros, usage, tariffVersion, createdAt)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, ?, ?)`,
        )
        .run(req.id, req.taskId, req.purpose, req.provider, req.model, req.reservedCostMicros ?? null, req.tariffVersion ?? null, nowIso());
    });
  }

  /** usage 缺失保持 null，不补 0；中断/不确定调用标 uncertain，不无证据退款成 0。 */
  settleModelCall(id: string, outcome: { state: Exclude<ModelCallState, 'reserved'>; usage?: JSONValue; settledCostMicros?: number }): void {
    const result = this.store.db
      .prepare("UPDATE model_calls SET state = ?, usage = ?, settledCostMicros = ? WHERE id = ? AND state = 'reserved'")
      .run(
        outcome.state,
        outcome.usage === undefined ? null : stableStringify(outcome.usage),
        outcome.settledCostMicros ?? null,
        id,
      );
    if (Number(result.changes) !== 1) throw new RuntimeError('INVALID_TRANSITION', `model_call ${id}`);
  }

  // ── outbox（记忆写回幂等键）──────────────────────────

  enqueueOutbox(req: { id: string; taskId: string; kind: string; payload: JSONValue }): void {
    requireId(req.id, 'outbox.id');
    requireText(req.kind, 'outbox.kind', 128);
    const payload = stableStringify(req.payload);
    this.store.transaction(() => {
      const existing = this.store.db.prepare('SELECT payload FROM outbox WHERE id = ?').get(req.id) as { payload: string } | undefined;
      if (existing) {
        if (existing.payload === payload) return; // 幂等键重放
        throw new RuntimeError('REQUEST_ID_CONFLICT', `outbox ${req.id}`);
      }
      this.store.db
        .prepare("INSERT INTO outbox (id, taskId, kind, payload, state, attempts, lastError, createdAt) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?)")
        .run(req.id, req.taskId, req.kind, payload, nowIso());
    });
  }

  pendingOutbox(kind?: string, limit = 100) {
    const capped = Math.min(Math.max(1, limit), 1000);
    const rows = (
      kind === undefined
        ? this.store.db.prepare("SELECT * FROM outbox WHERE state = 'pending' ORDER BY createdAt ASC, id ASC LIMIT ?").all(capped)
        : this.store.db.prepare("SELECT * FROM outbox WHERE state = 'pending' AND kind = ? ORDER BY createdAt ASC, id ASC LIMIT ?").all(kind, capped)
    ) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload as string) as JSONValue }));
  }

  markOutbox(id: string, outcome: { state: 'done' | 'failed'; lastError?: string }): void {
    const result =
      outcome.state === 'done'
        ? this.store.db.prepare("UPDATE outbox SET state = 'done' WHERE id = ? AND state = 'pending'").run(id)
        : this.store.db
            .prepare("UPDATE outbox SET attempts = attempts + 1, lastError = ? WHERE id = ? AND state = 'pending'")
            .run(outcome.lastError ?? null, id);
    if (Number(result.changes) !== 1) throw new RuntimeError('INVALID_TRANSITION', `outbox ${id}`);
  }

  // ── lease 原子竞争 + fencing token ───────────────────

  /**
   * 竞争 lease。同一 owner 重复获取 = 续约（token 不变）；过期 lease 被新 owner 接管时
   * token 单调递增，旧 owner 的 token 从此作废（FENCING_TOKEN_STALE）。
   */
  acquireLease(name: string, ttlMs: number, now: number = Date.now()): { fencingToken: number } {
    requireText(name, 'lease.name', 256);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RuntimeError('INVALID_INPUT', 'ttlMs');
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT ownerInstanceId, expiresAt, fencingToken FROM leases WHERE name = ?').get(name) as
        | { ownerInstanceId: string; expiresAt: number; fencingToken: number }
        | undefined;
      if (!row) {
        this.store.db
          .prepare('INSERT INTO leases (name, ownerInstanceId, expiresAt, fencingToken) VALUES (?, ?, ?, 1)')
          .run(name, this.instanceId, now + ttlMs);
        return { fencingToken: 1 };
      }
      if (row.ownerInstanceId === this.instanceId && row.expiresAt > now) {
        this.store.db.prepare('UPDATE leases SET expiresAt = ? WHERE name = ? AND fencingToken = ?').run(now + ttlMs, name, row.fencingToken);
        return { fencingToken: row.fencingToken };
      }
      if (row.expiresAt <= now) {
        // CAS：只有仍读到旧 token 时才接管；竞争失败者 changes=0。
        const result = this.store.db
          .prepare('UPDATE leases SET ownerInstanceId = ?, expiresAt = ?, fencingToken = fencingToken + 1 WHERE name = ? AND fencingToken = ?')
          .run(this.instanceId, now + ttlMs, name, row.fencingToken);
        if (Number(result.changes) !== 1) throw new RuntimeError('LEASE_HELD', name);
        const fresh = this.store.db.prepare('SELECT fencingToken FROM leases WHERE name = ?').get(name) as { fencingToken: number };
        return { fencingToken: fresh.fencingToken };
      }
      throw new RuntimeError('LEASE_HELD', `${name} held by ${row.ownerInstanceId}`);
    });
  }

  /** 携带 token 执行关键段前的围栏检查；token 过期/易主都会拒绝。 */
  checkFence(name: string, fencingToken: number, now: number = Date.now()): void {
    const row = this.store.db.prepare('SELECT ownerInstanceId, expiresAt, fencingToken FROM leases WHERE name = ?').get(name) as
      | { ownerInstanceId: string; expiresAt: number; fencingToken: number }
      | undefined;
    if (!row || row.ownerInstanceId !== this.instanceId || row.fencingToken !== fencingToken || row.expiresAt <= now) {
      throw new RuntimeError('FENCING_TOKEN_STALE', name);
    }
  }

  releaseLease(name: string, fencingToken: number): void {
    this.store.db.prepare('DELETE FROM leases WHERE name = ? AND ownerInstanceId = ? AND fencingToken = ?').run(name, this.instanceId, fencingToken);
  }

  /** worker 执行某任务前必须 claim；第二实例得到 LEASE_HELD，只读接口不受影响。 */
  claimTask(taskId: string, ttlMs: number, now: number = Date.now()): { fencingToken: number } {
    if (!this.getTaskRow(taskId)) throw new RuntimeError('TASK_NOT_FOUND', taskId);
    return this.acquireLease(`task:${taskId}`, ttlMs, now);
  }

  checkTaskFence(taskId: string, fencingToken: number, now: number = Date.now()): void {
    this.checkFence(`task:${taskId}`, fencingToken, now);
  }

  // ── 事件 ────────────────────────────────────────────

  listEvents(afterSeq: number, limit?: number): EventRecord[] {
    return eventsSince(this.store, afterSeq, limit);
  }

  // ── 崩溃恢复（只标识，不自动付费重试）─────────────────

  /**
   * 启动时调用：running/waiting_provider/cancelling → interrupted（TASK_INTERRUPTED）；
   * waiting_approval 保留，但已过期的 pending 审批标 expired（不自动通过）。
   * 恢复执行是用户显式动作（interrupted → queued，M07 做预检），这里绝不自动重试。
   */
  recover(now: Date = new Date()): { interrupted: string[]; expiredApprovals: string[] } {
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare(`SELECT id, state FROM tasks WHERE state IN (${RECOVERY_INTERRUPT_SOURCES.map(() => '?').join(',')})`)
        .all(...RECOVERY_INTERRUPT_SOURCES) as unknown as Array<{ id: string; state: TaskState }>;
      const nowText = now.toISOString();
      for (const row of rows) {
        this.store.db
          .prepare("UPDATE tasks SET state = 'interrupted', revision = revision + 1, updatedAt = ?, errorCode = 'TASK_INTERRUPTED' WHERE id = ?")
          .run(nowText, row.id);
        appendEvent(this.store, row.id, 'task.state', { from: row.state, to: 'interrupted', reason: 'TASK_INTERRUPTED' });
      }
      const expired = this.store.db
        .prepare("SELECT id, taskId FROM approvals WHERE decision = 'pending' AND expiresAt < ?")
        .all(nowText) as unknown as Array<{ id: string; taskId: string }>;
      for (const row of expired) {
        this.store.db.prepare("UPDATE approvals SET decision = 'expired', decidedAt = ? WHERE id = ?").run(nowText, row.id);
        appendEvent(this.store, row.taskId, 'approval.decided', { approvalId: row.id, decision: 'expired' });
      }
      return { interrupted: rows.map((r) => r.id), expiredApprovals: expired.map((r) => r.id) };
    });
  }

  // ── 旧 tasks/*.json 隔离导入演练 ─────────────────────

  /**
   * 一次性迁移演练：只读解析旧格式（见 task-store.ts，保留为旧运行时 reader），
   * 保留原 ID 与原始输入 hash；历史聊天映射为终态/interrupted，绝不变成待执行任务。
   * 重复导入幂等（同 ID 同输入跳过）。running（旧崩溃残留）→ interrupted。
   */
  importLegacyChatTasks(rootDir: string): { imported: string[]; skipped: string[] } {
    const LEGACY_STATE: Record<string, TaskState> = {
      completed: 'succeeded',
      failed: 'failed',
      interrupted: 'interrupted',
      running: 'interrupted',
    };
    const imported: string[] = [];
    const skipped: string[] = [];
    this.store.transaction(() => {
      let files: string[] = [];
      try {
        files = readdirSync(rootDir).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
      } catch {
        throw new RuntimeError('LEGACY_STORE_UNREADABLE', rootDir);
      }
      for (const file of files) {
        const legacy = JSON.parse(readFileSync(join(rootDir, file), 'utf8')) as {
          id: string;
          message: string;
          provider: string;
          startedAt: string;
          status: keyof typeof LEGACY_STATE;
          response?: unknown;
          error?: string;
        };
        if (!legacy.id || !legacy.startedAt || !(legacy.status in LEGACY_STATE)) {
          throw new RuntimeError('LEGACY_TASK_CORRUPT', file);
        }
        const input: JSONValue = {
          kind: 'legacy_chat_import',
          message: legacy.message,
          provider: legacy.provider,
          startedAt: legacy.startedAt,
        };
        const inputHash = inputHashOf(input);
        const existing = this.getTaskRow(legacy.id);
        if (existing) {
          if (existing.inputHash !== inputHash) throw new RuntimeError('REQUEST_ID_CONFLICT', legacy.id);
          skipped.push(legacy.id);
          continue;
        }
        const state = LEGACY_STATE[legacy.status];
        const now = nowIso();
        // M09：保留原模型名（history 展示用）；response 缺失回退 'legacy'。
        const legacyModel =
          legacy.response !== null && typeof legacy.response === 'object' && typeof (legacy.response as { model?: unknown }).model === 'string'
            ? ((legacy.response as { model: string }).model ?? 'legacy')
            : 'legacy';
        this.store.db
          .prepare(
            `INSERT INTO tasks (id, inputHash, input, sessionId, scope, workspaceRoot, state, provider, model, acceptance, revision, createdAt, updatedAt, errorCode)
             VALUES (?, ?, ?, 'legacy-import', 'legacy', '', ?, ?, ?, NULL, 0, ?, ?, ?)`,
          )
          .run(legacy.id, inputHash, stableStringify(input), state, legacy.provider, legacyModel, legacy.startedAt, now, legacy.error ?? null);
        appendEvent(this.store, legacy.id, 'task.legacy_imported', { from: 'tasks-json-v1', state });
        // M09：会话内容一并迁入（用户消息 + 助手回复文本），v1 history 由同一张
        // tasks/messages 表供出；usage/金额不进 model_calls（历史已结算过，预算账本不受污染）。
        const responseText =
          legacy.response !== null && typeof legacy.response === 'object' && typeof (legacy.response as { text?: unknown }).text === 'string'
            ? ((legacy.response as { text: string }).text ?? '')
            : '';
        this.store.db
          .prepare('INSERT INTO messages (taskId, seq, role, content, toolCalls, toolCallId, name) VALUES (?, 1, ?, ?, NULL, NULL, NULL)')
          .run(legacy.id, 'user', legacy.message);
        if (responseText) {
          this.store.db
            .prepare('INSERT INTO messages (taskId, seq, role, content, toolCalls, toolCallId, name) VALUES (?, 2, ?, ?, NULL, NULL, NULL)')
            .run(legacy.id, 'assistant', responseText);
        }
        imported.push(legacy.id);
      }
    });
    return { imported, skipped };
  }
}
