import { randomUUID } from 'node:crypto';
import {
  EFFECTS,
  RuntimeError,
  inputHashOf,
  nowIso,
  stableStringify,
  type JSONValue,
} from '../runtime/contracts.js';
import { appendEvent } from '../runtime/events.js';
import type { RuntimeStore } from '../runtime/runtime-store.js';
import { parseCron, validateTimezone, nextFireUtc } from './cron.js';

/**
 * M15 · 调度持久化层（schedules + schedule_firings）。
 *
 * 不变量：
 * - schedules.generation 单调递增（每次 update 自增 1）；旧的 generation 永远保留（历史 firing
 *   与当前 generation 解绑后仍能命中唯一键，不会重新触发）。
 * - schedule_firings 主键 cron:<scheduleId>:<generation>:<scheduledAtUtc>——计划时刻（UTC）非轮询时刻。
 *   进程崩溃后用同一键补发：唯一约束保证 exactly-once。
 * - schedule_firings.state: pending → dispatched | skipped | awaiting_approval | dispatched_failed | manual_resolved
 * - 错过补偿（restart 后发现 dueAt <= now 且 state=pending）由 dispatcher.computeMissedCompensation 决定
 *   skip / latest / bounded_all（N），用户须逐卡确认。
 */

export type MissedStrategy = 'skip' | 'latest' | 'bounded_all';

export const MISSED_STRATEGIES: readonly MissedStrategy[] = ['skip', 'latest', 'bounded_all'];

export interface ScheduleRecord {
  id: string;
  name: string;
  cronExpr: string;
  timezone: string;
  input: JSONValue;
  provider: string;
  model: string;
  sessionId: string;
  scope: string;
  workspaceRoot: string;
  enabled: boolean;
  generation: number;
  missedStrategy: MissedStrategy;
  missedBound: number;
  /** 计划授权：定时器在指定时刻发起任务；E/P 副作用仍走 M14 审批门（输入里 mcpTools/bridgeTools 点名）。 */
  scheduledEffect: 'workspace_write' | 'external_write' | 'process' | 'read';
  /** 调度层级审批 TTL（毫秒）；M14 tool approval TTL 独立（按工具查）。 */
  firingApprovalTtlMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface FiringRecord {
  id: string;
  scheduleId: string;
  generation: number;
  scheduledAtUtc: string;
  state:
    | 'pending'
    | 'dispatched'
    | 'skipped'
    | 'awaiting_approval'
    | 'dispatched_failed'
    | 'manual_resolved';
  taskId: string | null;
  attempt: number;
  errorCode: string | null;
  decidedAt: string | null;
  firedAtUtc: string | null;
  completedAtUtc: string | null;
  /** 错过的原因（仅 missed 时填）：'missed_skip' | 'missed_latest' | 'missed_bounded_all' | null */
  missedReason: string | null;
}

interface ScheduleRow {
  id: string;
  name: string;
  cronExpr: string;
  timezone: string;
  input: string;
  provider: string;
  model: string;
  sessionId: string;
  scope: string;
  workspaceRoot: string;
  enabled: number;
  generation: number;
  missedStrategy: string;
  missedBound: number;
  scheduledEffect: string;
  firingApprovalTtlMs: number;
  createdAt: string;
  updatedAt: string;
}

interface FiringRow {
  id: string;
  scheduleId: string;
  generation: number;
  scheduledAtUtc: string;
  state: string;
  taskId: string | null;
  attempt: number;
  errorCode: string | null;
  decidedAt: string | null;
  firedAtUtc: string | null;
  completedAtUtc: string | null;
  missedReason: string | null;
}

const ID_PATTERN = /^[^\x00-\x1f\\/]{1,256}$/;
const NAME_PATTERN = /^[^\x00-\x1f\\/]{1,256}$/;

function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new RuntimeError('INVALID_INPUT', field);
}

function requireName(value: string, field: string): void {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) throw new RuntimeError('INVALID_INPUT', field);
}

export interface CreateScheduleInput {
  id?: string;
  name: string;
  cronExpr: string;
  timezone: string;
  input: JSONValue;
  provider: string;
  model: string;
  sessionId?: string;
  scope?: string;
  workspaceRoot: string;
  enabled?: boolean;
  missedStrategy?: MissedStrategy;
  missedBound?: number;
  scheduledEffect?: ScheduleRecord['scheduledEffect'];
  firingApprovalTtlMs?: number;
}

const DEFAULT_FIRING_APPROVAL_TTL_MS = 30 * 60 * 1000;

export class ScheduleService {
  /** 默认 = new Date()；测试可注入假时钟以免与真实墙钟耦合。 */
  now: () => Date = () => new Date();

  constructor(readonly store: RuntimeStore) {}

  // ── CRUD ───────────────────────────────────────────

  createSchedule(req: CreateScheduleInput): ScheduleRecord {
    requireName(req.name, 'name');
    requireText(req.cronExpr, 'cronExpr', 256);
    requireText(req.timezone, 'timezone', 64);
    validateTimezone(req.timezone);
    // 解析一次确认合法；存入 cronExpr 原文即可，重启会再 parse。
    parseCron(req.cronExpr);
    requireText(req.provider, 'provider', 128);
    requireText(req.model, 'model', 128);
    requireText(req.workspaceRoot, 'workspaceRoot', 1024);
    const missedStrategy = req.missedStrategy ?? 'latest';
    if (!MISSED_STRATEGIES.includes(missedStrategy)) {
      throw new RuntimeError('INVALID_INPUT', 'missedStrategy must be skip|latest|bounded_all');
    }
    const missedBound = req.missedBound ?? 8;
    if (!Number.isSafeInteger(missedBound) || missedBound < 1 || missedBound > 256) {
      throw new RuntimeError('INVALID_INPUT', 'missedBound must be 1..256');
    }
    const scheduledEffect = req.scheduledEffect ?? 'workspace_write';
    if (!EFFECTS.includes(scheduledEffect)) {
      throw new RuntimeError('INVALID_INPUT', 'scheduledEffect must be one of read|workspace_write|external_write|process');
    }
    const ttl = req.firingApprovalTtlMs ?? DEFAULT_FIRING_APPROVAL_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 24 * 60 * 60 * 1000) {
      throw new RuntimeError('INVALID_INPUT', 'firingApprovalTtlMs must be 60000..86400000');
    }
    const inputCanonical = stableStringify(req.input);
    const id = req.id ?? `sched-${randomUUID()}`;
    requireId(id, 'id');
    const sessionId = req.sessionId ?? 'skf-scheduler';
    const scope = req.scope ?? 'skf-scheduler';
    const enabled = req.enabled === false ? 0 : 1;
    return this.store.transaction(() => {
      const existing = this.store.db.prepare('SELECT id FROM schedules WHERE id = ?').get(id) as { id: string } | undefined;
      if (existing) throw new RuntimeError('REQUEST_ID_CONFLICT', `schedule ${id} exists`);
      const now = nowIso();
      this.store.db
        .prepare(
          `INSERT INTO schedules (id, name, cronExpr, timezone, input, provider, model, sessionId, scope, workspaceRoot,
                                  enabled, generation, missedStrategy, missedBound, scheduledEffect, firingApprovalTtlMs,
                                  createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          req.name,
          req.cronExpr,
          req.timezone,
          inputCanonical,
          req.provider,
          req.model,
          sessionId,
          scope,
          req.workspaceRoot,
          enabled,
          missedStrategy,
          missedBound,
          scheduledEffect,
          ttl,
          now,
          now,
        );
      // 预登记下一次 firing（pending），让后续启动立即能在 firings 表里看到下一次计划时刻。
      const next = nextFireUtc(parseCron(req.cronExpr), req.timezone, this.now());
      this.recordFiringInternal(id, 1, next.toISOString(), 'pending');
      appendEvent(this.store, id, 'schedule.created', {
        cronExpr: req.cronExpr,
        timezone: req.timezone,
        nextScheduledAtUtc: next.toISOString(),
      });
      return this.getScheduleInternal(id)!;
    });
  }

  getSchedule(id: string): ScheduleRecord | null {
    return this.getScheduleInternal(id);
  }

  listSchedules(limit = 100): ScheduleRecord[] {
    const capped = Math.min(Math.max(1, limit), 1000);
    const rows = this.store.db
      .prepare('SELECT * FROM schedules ORDER BY createdAt ASC, id ASC LIMIT ?')
      .all(capped) as unknown as ScheduleRow[];
    return rows.map(toScheduleRecord);
  }

  setEnabled(id: string, enabled: boolean): ScheduleRecord {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(id) as { enabled: number } | undefined;
      if (!row) throw new RuntimeError('SCHEDULE_NOT_FOUND', id);
      const next = enabled ? 1 : 0;
      const now = nowIso();
      this.store.db.prepare('UPDATE schedules SET enabled = ?, updatedAt = ? WHERE id = ?').run(next, now, id);
      appendEvent(this.store, id, 'schedule.enabled', { enabled: next === 1 });
      return this.getScheduleInternal(id)!;
    });
  }

  /**
   * 更新 cron/时区/输入等任意子集。每次 update 自增 generation —— 历史 firing 的
   * (scheduleId, generation, scheduledAtUtc) 唯一键保持不变，旧 firing 不会被新 generation 误取消。
   */
  updateSchedule(
    id: string,
    patch: Partial<Pick<CreateScheduleInput, 'cronExpr' | 'timezone' | 'input' | 'name' | 'missedStrategy' | 'missedBound' | 'scheduledEffect' | 'firingApprovalTtlMs'>>,
  ): ScheduleRecord {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
      if (!row) throw new RuntimeError('SCHEDULE_NOT_FOUND', id);
      const next: Partial<ScheduleRow> = {};
      if (patch.cronExpr !== undefined) {
        requireText(patch.cronExpr, 'cronExpr', 256);
        parseCron(patch.cronExpr);
        next.cronExpr = patch.cronExpr;
      }
      if (patch.timezone !== undefined) {
        requireText(patch.timezone, 'timezone', 64);
        validateTimezone(patch.timezone);
        next.timezone = patch.timezone;
      }
      if (patch.input !== undefined) next.input = stableStringify(patch.input);
      if (patch.name !== undefined) {
        requireName(patch.name, 'name');
        next.name = patch.name;
      }
      if (patch.missedStrategy !== undefined) {
        if (!MISSED_STRATEGIES.includes(patch.missedStrategy)) {
          throw new RuntimeError('INVALID_INPUT', 'missedStrategy');
        }
        next.missedStrategy = patch.missedStrategy;
      }
      if (patch.missedBound !== undefined) {
        if (!Number.isSafeInteger(patch.missedBound) || patch.missedBound < 1 || patch.missedBound > 256) {
          throw new RuntimeError('INVALID_INPUT', 'missedBound');
        }
        next.missedBound = patch.missedBound;
      }
      if (patch.scheduledEffect !== undefined) {
        if (!EFFECTS.includes(patch.scheduledEffect)) {
          throw new RuntimeError('INVALID_INPUT', 'scheduledEffect');
        }
        next.scheduledEffect = patch.scheduledEffect;
      }
      if (patch.firingApprovalTtlMs !== undefined) {
        if (!Number.isSafeInteger(patch.firingApprovalTtlMs) || patch.firingApprovalTtlMs < 60_000 || patch.firingApprovalTtlMs > 24 * 60 * 60 * 1000) {
          throw new RuntimeError('INVALID_INPUT', 'firingApprovalTtlMs');
        }
        next.firingApprovalTtlMs = patch.firingApprovalTtlMs;
      }
      const fields = Object.keys(next);
      if (fields.length === 0) return toScheduleRecord(row);
      const setSql = fields.map((f) => `${f} = ?`).join(', ');
      const newGen = row.generation + 1;
      const values: Array<string | number | null> = fields.map((f) => (next as Record<string, unknown>)[f] as string | number | null);
      const now = nowIso();
      this.store.db
        .prepare(`UPDATE schedules SET ${setSql}, generation = ?, updatedAt = ? WHERE id = ?`)
        .run(...values, newGen, now, id);
      appendEvent(this.store, id, 'schedule.updated', { generation: newGen, fields });
      // 在新 generation 下预登记下一次 firing（pending）。
      const fresh = this.getScheduleInternal(id)!;
      const nextFire = nextFireUtc(parseCron(fresh.cronExpr), fresh.timezone, this.now());
      this.recordFiringInternal(id, fresh.generation, nextFire.toISOString(), 'pending');
      return fresh;
    });
  }

  deleteSchedule(id: string): void {
    // 不删 firings 历史；只删 schedules 行（FK 由 schedules→firings 的级联负责）。
    this.store.transaction(() => {
      const result = this.store.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      if (Number(result.changes) !== 1) throw new RuntimeError('SCHEDULE_NOT_FOUND', id);
      appendEvent(this.store, id, 'schedule.deleted', {});
    });
  }

  // ── firings ────────────────────────────────────────

  /**
   * 任务终态回调（由 worker 触发）：定位 taskId 关联的 firing → 标记终态 → 预登记下一次。
   * waiting_approval 任务不在此收尾——它只是把 firing 标 awaiting_approval，
   * 上层 approve 后任务进入 running 终态时再次回调。
   */
  completeFiringForTask(
    taskId: string,
    terminal: { state: 'succeeded' | 'failed' | 'cancelled' | 'waiting_approval'; errorCode: string | null },
  ): void {
    this.store.transaction(() => {
      const firing = this.store.db
        .prepare('SELECT * FROM schedule_firings WHERE taskId = ? ORDER BY scheduledAtUtc DESC LIMIT 1')
        .get(taskId) as FiringRow | undefined;
      if (!firing) return; // 与 schedule 无关的任务，静默忽略。
      const now = nowIso();
      if (terminal.state === 'waiting_approval') {
        if (firing.state === 'dispatched') {
          this.store.db
            .prepare("UPDATE schedule_firings SET state = 'awaiting_approval' WHERE id = ?")
            .run(firing.id);
          appendEvent(this.store, firing.scheduleId, 'schedule.firing_awaiting_approval', { firingId: firing.id, taskId });
        }
        return;
      }
      const nextState: 'dispatched' | 'dispatched_failed' | 'manual_resolved' =
        terminal.state === 'succeeded' ? 'dispatched' : terminal.state === 'cancelled' ? 'manual_resolved' : 'dispatched_failed';
      // 已终态的 firing 不重复收尾（dispatched_failed 可能被 resolveUnknownOperation 覆盖）。
      if (firing.state === 'dispatched' || firing.state === 'awaiting_approval') {
        this.store.db
          .prepare(
            `UPDATE schedule_firings
             SET state = ?, errorCode = COALESCE(?, errorCode), completedAtUtc = ?
             WHERE id = ?`,
          )
          .run(nextState, terminal.errorCode ?? null, now, firing.id);
        appendEvent(this.store, firing.scheduleId, 'schedule.firing_completed', {
          firingId: firing.id,
          taskId,
          state: nextState,
          errorCode: terminal.errorCode,
        });
        // 成功或可重试失败后预登记下一次（pending）。
        const fresh = this.getScheduleInternal(firing.scheduleId);
        if (fresh && fresh.enabled) {
          const parsed = parseCron(fresh.cronExpr);
          const next = nextFireUtc(parsed, fresh.timezone, this.now());
          this.recordFiringInternal(fresh.id, fresh.generation, next.toISOString(), 'pending');
        }
      }
    });
  }

  /**
   * M15 验收要求：审批 TTL 到期 = APPROVAL_EXPIRED，迟到批准失败；不自动重试该 firing。
   * 暴露给 task.approve / 恢复预检：若 firing 已超过 schedule.firingApprovalTtlMs 且任务
   * 仍 waiting_approval，把 firing 标 manual_resolved + 任务标 failed(APPROVAL_EXPIRED)。
   * 调用方在 task.approve 之前先检查；如果已经过期就拒绝 approve。
   */
  expireAwaitingApproval(firingId: string, reason: string = 'APPROVAL_EXPIRED'): boolean {
    return this.store.transaction(() => {
      const firing = this.store.db
        .prepare('SELECT * FROM schedule_firings WHERE id = ?')
        .get(firingId) as FiringRow | undefined;
      if (!firing) return false;
      if (firing.state !== 'awaiting_approval') return false;
      const now = nowIso();
      this.store.db
        .prepare("UPDATE schedule_firings SET state = 'manual_resolved', errorCode = ?, completedAtUtc = ? WHERE id = ?")
        .run(reason, now, firingId);
      appendEvent(this.store, firing.scheduleId, 'schedule.firing_completed', { firingId, state: 'manual_resolved', errorCode: reason });
      return true;
    });
  }


  private recordFiringInternal(
    scheduleId: string,
    generation: number,
    scheduledAtUtc: string,
    state: FiringRecord['state'],
  ): { id: string; created: boolean } {
    const id = `cron:${scheduleId}:${generation}:${scheduledAtUtc}`;
    const existing = this.store.db
      .prepare('SELECT id, state FROM schedule_firings WHERE id = ?')
      .get(id) as { id: string; state: string } | undefined;
    if (existing) return { id, created: false };
    this.store.db
      .prepare(
        `INSERT INTO schedule_firings (id, scheduleId, generation, scheduledAtUtc, state, taskId, attempt, errorCode,
                                       decidedAt, firedAtUtc, completedAtUtc, missedReason)
         VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(id, scheduleId, generation, scheduledAtUtc, state);
    return { id, created: true };
  }

  /** 把 firing 标为 dispatched；返回唯一键。taskId 与 attempt 在调用方写入。 */
  markFiringDispatched(firingId: string, info: { taskId: string; firedAtUtc: string }): FiringRecord {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM schedule_firings WHERE id = ?').get(firingId) as FiringRow | undefined;
      if (!row) throw new RuntimeError('FIRING_NOT_FOUND', firingId);
      if (row.state !== 'pending') {
        throw new RuntimeError('INVALID_TRANSITION', `firing ${row.state} → dispatched`);
      }
      this.store.db
        .prepare(
          `UPDATE schedule_firings
           SET state = 'dispatched', taskId = ?, attempt = attempt + 1, firedAtUtc = ?
           WHERE id = ?`,
        )
        .run(info.taskId, info.firedAtUtc, firingId);
      appendEvent(this.store, row.scheduleId, 'schedule.fired', {
        firingId,
        scheduledAtUtc: row.scheduledAtUtc,
        taskId: info.taskId,
      });
      return this.getFiringInternal(firingId)!;
    });
  }

  /** 把 firing 标为 awaiting_approval；上层调用方需保证 taskId 已绑定。 */
  markFiringAwaitingApproval(firingId: string): FiringRecord {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM schedule_firings WHERE id = ?').get(firingId) as FiringRow | undefined;
      if (!row) throw new RuntimeError('FIRING_NOT_FOUND', firingId);
      if (row.state !== 'pending') throw new RuntimeError('INVALID_TRANSITION', row.state);
      this.store.db.prepare("UPDATE schedule_firings SET state = 'awaiting_approval' WHERE id = ?").run(firingId);
      return this.getFiringInternal(firingId)!;
    });
  }

  /** 把 firing 标为 skipped；missedReason 由 dispatcher 计算后填入。 */
  markFiringSkipped(firingId: string, reason: string): FiringRecord {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM schedule_firings WHERE id = ?').get(firingId) as FiringRow | undefined;
      if (!row) throw new RuntimeError('FIRING_NOT_FOUND', firingId);
      if (row.state !== 'pending') throw new RuntimeError('INVALID_TRANSITION', row.state);
      const now = nowIso();
      this.store.db
        .prepare(
          `UPDATE schedule_firings
           SET state = 'skipped', missedReason = ?, completedAtUtc = ?
           WHERE id = ?`,
        )
        .run(reason, now, firingId);
      appendEvent(this.store, row.scheduleId, 'schedule.skipped', {
        firingId,
        scheduledAtUtc: row.scheduledAtUtc,
        reason,
      });
      return this.getFiringInternal(firingId)!;
    });
  }

  markFiringCompleted(firingId: string, info: { state: 'dispatched' | 'dispatched_failed' | 'manual_resolved'; errorCode?: string }): FiringRecord {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM schedule_firings WHERE id = ?').get(firingId) as FiringRow | undefined;
      if (!row) throw new RuntimeError('FIRING_NOT_FOUND', firingId);
      // dispatched → dispatched(终态) 或 dispatched_failed（任务执行失败）；awaiting_approval → manual_resolved。
      if (info.state === 'dispatched' && row.state !== 'dispatched' && row.state !== 'awaiting_approval') {
        throw new RuntimeError('INVALID_TRANSITION', row.state);
      }
      const now = nowIso();
      this.store.db
        .prepare(
          `UPDATE schedule_firings
           SET state = ?, errorCode = COALESCE(?, errorCode), completedAtUtc = ?
           WHERE id = ?`,
        )
        .run(info.state, info.errorCode ?? null, now, firingId);
      appendEvent(this.store, row.scheduleId, 'schedule.firing_completed', {
        firingId,
        scheduledAtUtc: row.scheduledAtUtc,
        state: info.state,
        errorCode: info.errorCode ?? null,
      });
      return this.getFiringInternal(firingId)!;
    });
  }

  /**
   * 列出 due 的 pending firings（scheduledAtUtc <= nowUtc）。按 schedule 升序 + 时间升序，
   * 方便 dispatcher 串行处理每个 schedule。
   */
  listDueFirings(nowUtc: Date, limit = 200): FiringRecord[] {
    const rows = this.store.db
      .prepare(
        `SELECT f.* FROM schedule_firings f
         JOIN schedules s ON s.id = f.scheduleId
         WHERE f.state = 'pending' AND s.enabled = 1 AND f.scheduledAtUtc <= ?
         ORDER BY f.scheduledAtUtc ASC, f.scheduleId ASC
         LIMIT ?`,
      )
      .all(nowUtc.toISOString(), Math.min(Math.max(1, limit), 1000)) as unknown as FiringRow[];
    return rows.map(toFiringRecord);
  }

  /** 列出指定 schedule 的所有 firings（按时间升序）。 */
  listFiringsForSchedule(scheduleId: string, limit = 200): FiringRecord[] {
    const rows = this.store.db
      .prepare('SELECT * FROM schedule_firings WHERE scheduleId = ? ORDER BY scheduledAtUtc ASC LIMIT ?')
      .all(scheduleId, Math.min(Math.max(1, limit), 1000)) as unknown as FiringRow[];
    return rows.map(toFiringRecord);
  }

  getFiring(firingId: string): FiringRecord | null {
    return this.getFiringInternal(firingId);
  }

  /**
   * 在某 schedule 当前 generation 下预约下一次 firing（pending）。不修改旧 firings。
   * 由 dispatcher 在每次触发成功后调用，保证 firings 表里始终能看到未来一次计划时刻。
   */
  enqueueNextFiring(scheduleId: string, fromUtc: Date): FiringRecord {
    const schedule = this.getScheduleInternal(scheduleId);
    if (!schedule) throw new RuntimeError('SCHEDULE_NOT_FOUND', scheduleId);
    const parsed = parseCron(schedule.cronExpr);
    const next = nextFireUtc(parsed, schedule.timezone, fromUtc);
    const { id } = this.recordFiringInternal(scheduleId, schedule.generation, next.toISOString(), 'pending');
    return this.getFiringInternal(id)!;
  }

  /** 启动恢复：把所有 enabled=1 且 state=pending 的 firing 检查 missed，按策略标记 skipped / 保留 latest。 */
  recoverMissedFirings(nowUtc: Date): { scanned: number; skipped: number; latestKept: number; boundedKept: number } {
    const due = this.listDueFirings(nowUtc, 1000);
    let scanned = 0;
    let skipped = 0;
    let latestKept = 0;
    let boundedKept = 0;
    // 按 schedule 分组。
    const grouped = new Map<string, FiringRecord[]>();
    for (const f of due) {
      scanned += 1;
      const list = grouped.get(f.scheduleId) ?? [];
      list.push(f);
      grouped.set(f.scheduleId, list);
    }
    for (const [scheduleId, firings] of grouped) {
      const schedule = this.getScheduleInternal(scheduleId);
      if (!schedule) continue;
      // firings 已按 scheduledAtUtc ASC 排序。
      switch (schedule.missedStrategy) {
        case 'skip': {
          for (const f of firings) {
            this.markFiringSkipped(f.id, 'missed_skip');
            skipped += 1;
          }
          break;
        }
        case 'latest': {
          for (const f of firings.slice(0, -1)) {
            this.markFiringSkipped(f.id, 'missed_latest');
            skipped += 1;
          }
          latestKept += firings.length > 0 ? 1 : 0;
          break;
        }
        case 'bounded_all': {
          const keep = firings.slice(-schedule.missedBound);
          for (const f of firings) {
            if (keep.includes(f)) {
              boundedKept += 1;
            } else {
              this.markFiringSkipped(f.id, 'missed_bounded_all');
              skipped += 1;
            }
          }
          break;
        }
      }
    }
    return { scanned, skipped, latestKept, boundedKept };
  }

  // ── 内取 ─────────────────────────────────────────

  private getScheduleInternal(id: string): ScheduleRecord | null {
    const row = this.store.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    return row ? toScheduleRecord(row) : null;
  }

  private getFiringInternal(id: string): FiringRecord | null {
    const row = this.store.db.prepare('SELECT * FROM schedule_firings WHERE id = ?').get(id) as FiringRow | undefined;
    return row ? toFiringRecord(row) : null;
  }
}

function toScheduleRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    input: JSON.parse(row.input) as JSONValue,
    provider: row.provider,
    model: row.model,
    sessionId: row.sessionId,
    scope: row.scope,
    workspaceRoot: row.workspaceRoot,
    enabled: row.enabled === 1,
    generation: row.generation,
    missedStrategy: row.missedStrategy as MissedStrategy,
    missedBound: row.missedBound,
    scheduledEffect: row.scheduledEffect as ScheduleRecord['scheduledEffect'],
    firingApprovalTtlMs: row.firingApprovalTtlMs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFiringRecord(row: FiringRow): FiringRecord {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    generation: row.generation,
    scheduledAtUtc: row.scheduledAtUtc,
    state: row.state as FiringRecord['state'],
    taskId: row.taskId,
    attempt: row.attempt,
    errorCode: row.errorCode,
    decidedAt: row.decidedAt,
    firedAtUtc: row.firedAtUtc,
    completedAtUtc: row.completedAtUtc,
    missedReason: row.missedReason,
  };
}

function requireText(value: string, field: string, max: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new RuntimeError('INVALID_INPUT', field);
  }
}

// Re-export inputHashOf for callers who want to bind a firing → task input hash.
export { inputHashOf };
