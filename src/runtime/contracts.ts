import { createHash } from 'node:crypto';

/**
 * M03 · 持久执行账本契约（02-CONTRACTS.md C/D 节）。
 * 状态语义、幂等与终态规则不得在本文件以外悄悄改变。
 */

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };

// ── 任务状态机（02-D，封闭集合）──────────────────────────

export const TASK_STATES = [
  'queued', 'running', 'waiting_approval', 'waiting_provider',
  'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['succeeded', 'failed', 'cancelled'];

/** 公开转换表。崩溃恢复专属转换（running/waiting_provider/cancelling → interrupted）不在这里。 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['running', 'cancelling'],
  running: ['waiting_provider', 'waiting_approval', 'cancelling', 'succeeded', 'failed'],
  waiting_provider: ['running', 'cancelling'],
  waiting_approval: ['running', 'failed', 'cancelling'],
  cancelling: ['cancelled'],
  cancelled: [],
  succeeded: [],
  failed: [],
  interrupted: ['queued', 'cancelling'],
};

export const RECOVERY_INTERRUPT_SOURCES: readonly TaskState[] = ['running', 'waiting_provider', 'cancelling'];

export function isTerminalTaskState(state: TaskState) {
  return TERMINAL_TASK_STATES.includes(state);
}

// ── 工具操作状态机 ─────────────────────────────────────

export const OPERATION_STATES = ['prepared', 'running', 'succeeded', 'failed', 'unknown'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const OPERATION_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  prepared: ['running', 'failed'],
  running: ['succeeded', 'failed', 'unknown'],
  // unknown = 超时后副作用不确定；只能经产物核查后显式了结，绝不自动重试。
  unknown: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

// ── 副作用与审批 ───────────────────────────────────────

export const EFFECTS = ['read', 'workspace_write', 'external_write', 'process'] as const;
export type Effect = (typeof EFFECTS)[number];

export const APPROVAL_DECISIONS = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// ── 模型调用（purpose 白名单，02-G）────────────────────

export const MODEL_CALL_PURPOSES = ['chat', 'planning', 'summary', 'extraction', 'review'] as const;
export type ModelCallPurpose = (typeof MODEL_CALL_PURPOSES)[number];

export const MODEL_CALL_STATES = ['reserved', 'settled', 'uncertain', 'failed'] as const;
export type ModelCallState = (typeof MODEL_CALL_STATES)[number];

// ── 稳定序列化与 hash ──────────────────────────────────

/** 稳定 JSON：对象键递归排序；拒绝 undefined/函数/循环。输入 hash 必须使用它，不能用 JSON.stringify 原样。 */
export function stableStringify(value: JSONValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RuntimeError('INVALID_INPUT', 'non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = (value as Record<string, JSONValue>)[key];
        if (item === undefined) throw new RuntimeError('INVALID_INPUT', `undefined field ${key}`);
        return JSON.stringify(key) + ':' + stableStringify(item);
      });
    return '{' + entries.join(',') + '}';
  }
  throw new RuntimeError('INVALID_INPUT', `unsupported type ${typeof value}`);
}

export function inputHashOf(value: JSONValue): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}
