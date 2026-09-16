import type { RuntimeStore } from './runtime-store.js';
import { RuntimeError, stableStringify, type JSONValue } from './contracts.js';

/**
 * M03 · 事件流。eventSeq 整数递增 PK 是唯一排序依据（不用墙钟）；
 * UI 断线按 eventsSince(afterSeq) 补发。payload 只放安全摘要，限制字节数。
 */

const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

export interface EventRecord {
  eventSeq: number;
  taskId: string;
  type: string;
  safePayload: JSONValue;
  at: string;
}

/** 必须在 store.transaction 内调用（或自身包一层），与状态变更同生共死。 */
export function appendEvent(store: RuntimeStore, taskId: string, type: string, safePayload: JSONValue): number {
  if (!/^[a-z][a-z0-9_.:-]{0,63}$/.test(type)) throw new RuntimeError('INVALID_EVENT_TYPE', type);
  const payload = stableStringify(safePayload);
  if (Buffer.byteLength(payload, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new RuntimeError('EVENT_PAYLOAD_TOO_LARGE', type);
  }
  const result = store.db
    .prepare('INSERT INTO events (taskId, type, safePayload, at) VALUES (?, ?, ?, ?)')
    .run(taskId, type, payload, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function eventsSince(store: RuntimeStore, afterSeq: number, limit = 200): EventRecord[] {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RuntimeError('INVALID_INPUT', 'afterSeq');
  const capped = Math.min(Math.max(1, limit), 1000);
  const rows = store.db
    .prepare('SELECT eventSeq, taskId, type, safePayload, at FROM events WHERE eventSeq > ? ORDER BY eventSeq ASC LIMIT ?')
    .all(afterSeq, capped) as unknown as Array<{ eventSeq: number; taskId: string; type: string; safePayload: string; at: string }>;
  return rows.map((row) => ({
    eventSeq: row.eventSeq,
    taskId: row.taskId,
    type: row.type,
    safePayload: JSON.parse(row.safePayload) as JSONValue,
    at: row.at,
  }));
}
