import { stableStringify, type JSONValue } from '../runtime/contracts.js';
import type { TaskRecord, TaskService } from '../runtime/task-service.js';
import { sha256Text } from './contracts.js';

/**
 * M13 · 终态证据快照。
 *
 * 快照是复盘的唯一输入（复盘模型只读快照，不给业务执行工具权限）：
 * 任务目标/验收结果/工具操作与错误/产物哈希/预算摘要/恢复状态。
 * hash 覆盖快照全部内容；台账在终态后不变 ⇒ 重建同 hash（幂等键稳定）。
 */

const RESULT_CLIP = 2000;
const EVENT_PAYLOAD_CLIP = 600;
const MAX_EVENTS_IN_SNAPSHOT = 60;

export interface EvidenceSnapshot {
  schemaVersion: 1;
  taskId: string;
  goal: string;
  scope: string;
  provider: string;
  model: string;
  finalState: 'succeeded' | 'failed' | 'cancelled';
  errorCode: string | null;
  acceptance: JSONValue | null;
  /** null = 无验收定义；true/false 来自 task.acceptance 事件（实物核验结果）。 */
  acceptanceOk: boolean | null;
  operations: Array<{
    id: string;
    callId: string;
    toolName: string;
    state: string;
    inputHash: string;
    resultSummary: string;
  }>;
  artifacts: Array<{ relativePath: string; byteLength: number; sha256: string; verifiedAt: string | null }>;
  modelCalls: Array<{ id: string; purpose: string; state: string; provider: string; model: string; settledCostMicros: number | null }>;
  events: Array<{ type: string; payload: string }>;
  approvals: Array<{ effect: string; decision: string }>;
  /** 派生标志（复盘筛选与候选校验的硬依据） */
  hasOperationEvidence: boolean;
  /** external_write/process 副作用不确定（operation unknown）：禁产出成功类候选。 */
  uncertainExternal: boolean;
  /** 恢复异常：interrupted/needs_review/recovered/uncertain 任一。 */
  recoveryAnomaly: boolean;
  budgetSummary: { settledMicros: number; uncertainCalls: number };
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function goalOf(task: TaskRecord): string {
  const input = task.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const goal = (input as Record<string, JSONValue>).goal;
    if (typeof goal === 'string' && goal.trim()) return goal.slice(0, 500);
  }
  return stableStringify(task.input).slice(0, 500);
}

/** 构建终态证据快照（纯读台账，零模型调用）。任务必须已终态。 */
export function buildEvidenceSnapshot(service: TaskService, task: TaskRecord): EvidenceSnapshot {
  const store = service.store;
  const operations = (
    store.db
      .prepare('SELECT id, callId, toolName, state, inputHash, result FROM operations WHERE taskId = ? ORDER BY startedAt ASC, id ASC')
      .all(task.id) as unknown as Array<{ id: string; callId: string; toolName: string; state: string; inputHash: string; result: string | null }>
  ).map((op) => ({
    id: op.id,
    callId: op.callId,
    toolName: op.toolName,
    state: op.state,
    inputHash: op.inputHash,
    resultSummary: clip(op.result ?? '', RESULT_CLIP),
  }));
  const artifacts = (
    store.db
      .prepare('SELECT relativePath, byteLength, sha256, verifiedAt FROM artifacts WHERE taskId = ? ORDER BY relativePath ASC')
      .all(task.id) as unknown as Array<{ relativePath: string; byteLength: number; sha256: string; verifiedAt: string | null }>
  );
  const modelCalls = (
    store.db
      .prepare('SELECT id, purpose, state, provider, model, settledCostMicros FROM model_calls WHERE taskId = ? ORDER BY createdAt ASC, id ASC')
      .all(task.id) as unknown as Array<{ id: string; purpose: string; state: string; provider: string; model: string; settledCostMicros: number | null }>
  );
  const events = (
    store.db
      .prepare('SELECT type, safePayload FROM events WHERE taskId = ? ORDER BY eventSeq ASC')
      .all(task.id) as unknown as Array<{ type: string; safePayload: string }>
  )
    // learning.* 事件是复盘自身的副产品；纳入快照会让「登记复盘」改变快照 hash，破坏幂等键。
    .filter((e) => !e.type.startsWith('learning.'))
    .slice(-MAX_EVENTS_IN_SNAPSHOT)
    .map((e) => ({ type: e.type, payload: clip(e.safePayload, EVENT_PAYLOAD_CLIP) }));
  const approvals = (
    store.db
      .prepare('SELECT effect, decision FROM approvals WHERE taskId = ? ORDER BY expiresAt ASC')
      .all(task.id) as unknown as Array<{ effect: string; decision: string }>
  );

  let acceptanceOk: boolean | null = null;
  for (const e of events) {
    if (e.type !== 'task.acceptance') continue;
    try {
      const payload = JSON.parse(e.payload) as { ok?: unknown };
      if (typeof payload.ok === 'boolean') acceptanceOk = payload.ok;
    } catch {
      // 截断的 payload 解析失败：保持上一有效值
    }
  }
  if (task.acceptance !== null && acceptanceOk === null) {
    // 有验收定义但无验收事件（如提前失败）：按未通过处理前的中立值 null 保留，
    // 筛选器只认明确的 false（验收失败事件真实发生过）。
    acceptanceOk = null;
  }

  const uncertainExternal = operations.some((op) => op.state === 'unknown');
  const recoveryAnomaly =
    uncertainExternal ||
    modelCalls.some((c) => c.state === 'uncertain') ||
    events.some((e) => e.type === 'task.operation_needs_review' || e.payload.includes('"recovered":true'));
  const settledMicros = modelCalls.reduce((sum, c) => sum + (c.settledCostMicros ?? 0), 0);
  const uncertainCalls = modelCalls.filter((c) => c.state === 'uncertain').length;

  return {
    schemaVersion: 1,
    taskId: task.id,
    goal: goalOf(task),
    scope: task.scope,
    provider: task.provider,
    model: task.model,
    finalState: task.state as 'succeeded' | 'failed' | 'cancelled',
    errorCode: task.errorCode,
    acceptance: task.acceptance,
    acceptanceOk,
    operations,
    artifacts,
    modelCalls,
    events,
    approvals,
    hasOperationEvidence: operations.some((op) => op.state === 'succeeded'),
    uncertainExternal,
    recoveryAnomaly,
    budgetSummary: { settledMicros, uncertainCalls },
  };
}

export function snapshotHash(snapshot: EvidenceSnapshot): string {
  return sha256Text(stableStringify(snapshot as unknown as JSONValue));
}
