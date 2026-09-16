/**
 * M06 · 预算账本（02-CONTRACTS.md G 节 / 03-TASK-CARDS M06）。
 *
 * - 金额一律整数微货币（micros = 1/1_000_000 currency 单位），带 currency 与 tariffVersion；
 *   不用浮点累计，不把 USD 当别的币种。
 * - 预留最坏上限：按保守输入估算 + maxOutputTokens 与预留时刻的价目快照计算；
 *   任务/每日的 spent+reserved+uncertain 在数据库同一事务内比较，不允许各读一次再各自放行。
 * - 结算按供应商 usage：cached 是 input 子集按缓存价计、绝不双算；预留按未缓存保守计算。
 *   缺 usage / 超时 / 取消 → uncertain（保守保留预留额，不无证据退款成 0）；
 *   尚未发出请求的预检失败 → release（state=failed，不计任何额度），日志说明证据。
 * - 价目中途改变：已预留调用按快照结算，新调用用新价目（tariffVersion 随行固化）。
 * - 跨日按固定 Asia/Shanghai（UTC+8，无夏令时）分桶，不依赖进程本地时区。
 * - 价目缺失：strict-money 由 gateway 在预留前拒绝；call-limit 允许但金额明示未知（null），
 *   绝不是 0。UI 看到的是配置估算，供应商账单一列以原始 usage 为准，两者不混。
 */

import { RuntimeError, stableStringify, type JSONValue, type ModelCallPurpose } from './contracts.js';
import type { RuntimeStore } from './runtime-store.js';
import type { TariffSnapshot } from './usage.js';
import type { Usage } from '../providers/protocol.js';

// ── 微货币整数运算 ──────────────────────────────────────

export function requireMicros(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeError('INVALID_INPUT', `${field} must be a non-negative safe integer (micros)`);
  }
  return value;
}

export function requireTokens(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeError('INVALID_INPUT', `${field} must be a non-negative safe integer (tokens)`);
  }
  return value;
}

/**
 * tokens × perM = micros（因为 perM 是每百万 token 的 currency 价格，乘 1e6 换算后与百万抵消）。
 * 结果必须是非负安全整数；价目或数量异常在这里就炸，不静默进账。
 */
export function costMicros(tokens: number, perM: number): number {
  requireTokens(tokens, 'tokens');
  if (typeof perM !== 'number' || !Number.isFinite(perM) || perM < 0) {
    throw new RuntimeError('INVALID_INPUT', 'tariff rate must be a finite non-negative number');
  }
  const micros = Math.round(tokens * perM);
  if (!Number.isSafeInteger(micros)) {
    throw new RuntimeError('INVALID_INPUT', 'cost overflow: tokens × rate exceeds safe integer micros');
  }
  return micros;
}

/**
 * 按 usage 结算：cached 是 input 子集（截断到 [0, input]），未缓存部分按 input 价、
 * 缓存部分按 cached 价、输出按 output 价。有缓存但没配缓存价 → null（金额未知，不猜）。
 */
export function settleCostMicros(
  tariff: TariffSnapshot,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null },
): number | null {
  const input = requireTokens(usage.inputTokens, 'usage.inputTokens');
  const output = requireTokens(usage.outputTokens, 'usage.outputTokens');
  let cached = usage.cachedInputTokens ?? 0;
  requireTokens(cached, 'usage.cachedInputTokens');
  cached = Math.max(0, Math.min(cached, input));
  if (cached > 0 && tariff.cachedPerM === null) return null;
  return (
    costMicros(input - cached, tariff.inputPerM) +
    costMicros(output, tariff.outputPerM) +
    costMicros(cached, tariff.cachedPerM ?? 0)
  );
}

/** 预留最坏上限：输入按未缓存保守估算，输出按 maxOutputTokens 顶格。 */
export function reserveCostMicros(tariff: TariffSnapshot, worstCase: { inputTokens: number; outputTokens: number }): number {
  return costMicros(worstCase.inputTokens, tariff.inputPerM) + costMicros(worstCase.outputTokens, tariff.outputPerM);
}

// ── 固定 Asia/Shanghai 日桶（UTC+8，无夏令时）────────────

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

export function shanghaiDayKey(epochMs: number): string {
  if (!Number.isFinite(epochMs)) throw new RuntimeError('INVALID_INPUT', 'epochMs');
  const d = new Date(epochMs + SHANGHAI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 某个上海日的 [start, end)（epoch ms）。 */
export function shanghaiDayRange(dayKey: string): { startMs: number; endMs: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new RuntimeError('INVALID_INPUT', 'dayKey');
  const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - SHANGHAI_OFFSET_MS;
  return { startMs, endMs: startMs + DAY_MS };
}

// ── 账本 ───────────────────────────────────────────────

export interface BudgetLimits {
  /** 单任务金额上限（micros，currency 与价目一致）。 */
  taskMicros?: number;
  /** 每日金额上限（micros）。 */
  dailyMicros?: number;
  /** 每日云调用次数上限（不含本地 provider）。 */
  dailyCalls?: number;
}

export interface ReserveRequest {
  callId: string;
  taskId: string;
  purpose: ModelCallPurpose;
  provider: string;
  model: string;
  /** 本地/测试 provider 不耗金额、不计每日云调用次数。 */
  local: boolean;
  worstCase: { inputTokens: number; outputTokens: number };
  tariff: TariffSnapshot | null;
  limits: BudgetLimits;
  now?: number;
}

interface MoneyTotals {
  spent: number;
  reserved: number;
  uncertain: number;
  calls: number;
}

export type BudgetTotals = MoneyTotals;

export interface ReserveOutcome {
  reservedMicros: number | null;
  currency: string | null;
  tariffVersion: string | null;
  /** 本次预留后任务/日累计（含本次），供日志与 UI。 */
  taskTotal: number;
  dailyTotal: number;
}

export class BudgetLedger {
  private localProviders: Set<string>;

  constructor(
    private store: RuntimeStore,
    opts: { localProviders?: ReadonlySet<string> } = {},
  ) {
    this.localProviders = new Set(opts.localProviders ?? []);
  }

  /** 本地/测试 provider 不耗金额、不计每日云调用次数（gateway 注册时同步）。 */
  addLocalProvider(name: string): void {
    this.localProviders.add(name);
  }

  private totals(where: string, params: unknown[]): MoneyTotals {
    const rows = this.store.db
      .prepare(`SELECT state, reservedCostMicros, settledCostMicros FROM model_calls WHERE ${where}`)
      .all(...(params as never[])) as unknown as Array<{
        state: string;
        reservedCostMicros: number | null;
        settledCostMicros: number | null;
      }>;
    let spent = 0;
    let reserved = 0;
    let uncertain = 0;
    for (const row of rows) {
      if (row.state === 'settled') spent += row.settledCostMicros ?? 0;
      else if (row.state === 'reserved') reserved += row.reservedCostMicros ?? 0;
      else if (row.state === 'uncertain') uncertain += row.reservedCostMicros ?? 0;
      if (!Number.isSafeInteger(spent + reserved + uncertain)) {
        throw new RuntimeError('INVALID_INPUT', 'budget totals overflow safe integer micros');
      }
    }
    return { spent, reserved, uncertain, calls: rows.length };
  }

  private taskTotals(taskId: string): MoneyTotals {
    return this.totals('taskId = ?', [taskId]);
  }

  private dailyTotals(dayKey: string): MoneyTotals {
    const { startMs, endMs } = shanghaiDayRange(dayKey);
    const locals = [...this.localProviders];
    const exclude = locals.length ? ` AND provider NOT IN (${locals.map(() => '?').join(',')})` : '';
    return this.totals(
      `createdAt >= ? AND createdAt < ?${exclude}`,
      [new Date(startMs).toISOString(), new Date(endMs).toISOString(), ...locals],
    );
  }

  /**
   * 事务预留：同一事务内重算任务+当日 spent/reserved/uncertain 并与上限比较，
   * 通过才插入 reserved 行。两个并发请求只剩一份预算时，后提交的事务看到
   * 前者已占额度而拒绝 —— 只允许一个获准。任何超限都在发出网络请求之前。
   */
  reserve(req: ReserveRequest): ReserveOutcome {
    const now = req.now ?? Date.now();
    if (!Number.isFinite(now)) throw new RuntimeError('INVALID_INPUT', 'now');
    requireTokens(req.worstCase.inputTokens, 'worstCase.inputTokens');
    requireTokens(req.worstCase.outputTokens, 'worstCase.outputTokens');
    if (req.limits.taskMicros !== undefined) requireMicros(req.limits.taskMicros, 'limits.taskMicros');
    if (req.limits.dailyMicros !== undefined) requireMicros(req.limits.dailyMicros, 'limits.dailyMicros');
    if (req.limits.dailyCalls !== undefined) requireMicros(req.limits.dailyCalls, 'limits.dailyCalls');

    const reservedMicros = req.tariff ? reserveCostMicros(req.tariff, req.worstCase) : null;
    const dayKey = shanghaiDayKey(now);

    return this.store.transaction(() => {
      const existing = this.store.db.prepare('SELECT id FROM model_calls WHERE id = ?').get(req.callId);
      if (existing) throw new RuntimeError('REQUEST_ID_CONFLICT', `model_call ${req.callId}`);
      const task = this.store.db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.taskId);
      if (!task) throw new RuntimeError('TASK_NOT_FOUND', req.taskId);

      const taskTotals = this.taskTotals(req.taskId);
      const dailyTotals = this.dailyTotals(dayKey);
      const committed = (t: MoneyTotals) => t.spent + t.reserved + t.uncertain;

      if (!req.local) {
        if (req.limits.dailyCalls !== undefined && dailyTotals.calls >= req.limits.dailyCalls) {
          throw new RuntimeError('CALL_LIMIT_EXCEEDED', `${dailyTotals.calls} >= ${req.limits.dailyCalls} (${dayKey} Asia/Shanghai)`);
        }
        if (req.limits.taskMicros !== undefined && reservedMicros !== null) {
          if (committed(taskTotals) + reservedMicros > req.limits.taskMicros) {
            throw new RuntimeError(
              'BUDGET_EXCEEDED',
              `task ${req.taskId}: ${committed(taskTotals)} + ${reservedMicros} > ${req.limits.taskMicros} micros`,
            );
          }
        }
        if (req.limits.dailyMicros !== undefined && reservedMicros !== null) {
          if (committed(dailyTotals) + reservedMicros > req.limits.dailyMicros) {
            throw new RuntimeError(
              'DAILY_BUDGET_EXCEEDED',
              `${dayKey} Asia/Shanghai: ${committed(dailyTotals)} + ${reservedMicros} > ${req.limits.dailyMicros} micros`,
            );
          }
        }
      }

      this.store.db
        .prepare(
          `INSERT INTO model_calls (id, taskId, purpose, provider, model, state, reservedCostMicros, settledCostMicros, usage, tariffVersion, createdAt, currency, tariff)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          req.callId,
          req.taskId,
          req.purpose,
          req.provider,
          req.model,
          reservedMicros,
          req.tariff?.version ?? null,
          new Date(now).toISOString(),
          req.tariff?.currency ?? null,
          req.tariff ? stableStringify(req.tariff as unknown as JSONValue) : null,
        );
      return {
        reservedMicros,
        currency: req.tariff?.currency ?? null,
        tariffVersion: req.tariff?.version ?? null,
        taskTotal: committed(taskTotals) + (reservedMicros ?? 0),
        dailyTotal: committed(dailyTotals) + (reservedMicros ?? 0),
      };
    });
  }

  /**
   * 按供应商 usage 结算。usage 缺失/口径不可信（负数、非有限）→ uncertain：
   * 保守保留预留额度，绝不无证据退款成 0。价目用预留时的快照（tariff 列），
   * 价目中途改变不回溯。strict=true（strict-money）时金额算不出 → uncertain。
   */
  settle(callId: string, usage: Usage, opts: { strict?: boolean } = {}): { state: 'settled' | 'uncertain'; costMicros: number | null } {
    const row = this.store.db
      .prepare("SELECT state, tariff FROM model_calls WHERE id = ?")
      .get(callId) as { state: string; tariff: string | null } | undefined;
    if (!row) throw new RuntimeError('MODEL_CALL_NOT_FOUND', callId);
    if (row.state !== 'reserved') throw new RuntimeError('INVALID_TRANSITION', `model_call ${row.state}`);

    const tariff = row.tariff ? (JSON.parse(row.tariff) as TariffSnapshot) : null;
    const untrusted =
      usage.inputTokens === null ||
      usage.outputTokens === null ||
      !Number.isSafeInteger(usage.inputTokens) ||
      !Number.isSafeInteger(usage.outputTokens) ||
      (usage.inputTokens as number) < 0 ||
      (usage.outputTokens as number) < 0 ||
      (usage.cachedInputTokens !== null &&
        (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0));

    let cost: number | null = null;
    let state: 'settled' | 'uncertain' = 'settled';
    if (untrusted) {
      state = 'uncertain';
    } else if (tariff === null) {
      cost = null; // 无价目：金额明示未知（call-limit），不是 0
      if (opts.strict) state = 'uncertain';
    } else {
      cost = settleCostMicros(tariff, {
        inputTokens: usage.inputTokens as number,
        outputTokens: usage.outputTokens as number,
        cachedInputTokens: usage.cachedInputTokens,
      });
      if (cost === null && opts.strict) state = 'uncertain'; // 有缓存无缓存价：金额未知
    }

    const result = this.store.db
      .prepare("UPDATE model_calls SET state = ?, usage = ?, settledCostMicros = ? WHERE id = ? AND state = 'reserved'")
      .run(state, stableStringify(usage as unknown as JSONValue), cost, callId);
    if (Number(result.changes) !== 1) throw new RuntimeError('INVALID_TRANSITION', `model_call ${callId}`);
    return { state, costMicros: cost };
  }

  /** 超时/取消/网络中断等：请求可能已发出，记 uncertain（保守占额），不自动重发。 */
  markUncertain(callId: string): void {
    const result = this.store.db
      .prepare("UPDATE model_calls SET state = 'uncertain' WHERE id = ? AND state = 'reserved'")
      .run(callId);
    if (Number(result.changes) !== 1) throw new RuntimeError('INVALID_TRANSITION', `model_call ${callId}`);
  }

  /**
   * 尚未发出请求的预检失败（预算/上下文/路由/预中止）：释放预留，
   * state=failed 且不计任何金额。仅限有证据证明未发出请求的路径调用。
   */
  release(callId: string): void {
    const result = this.store.db
      .prepare("UPDATE model_calls SET state = 'failed', reservedCostMicros = NULL WHERE id = ? AND state = 'reserved'")
      .run(callId);
    if (Number(result.changes) !== 1) throw new RuntimeError('INVALID_TRANSITION', `model_call ${callId}`);
  }

  /** 当前花费状态（UI 用）：估算是配置价目算的，供应商账单一列以原始 usage 为准。 */
  status(opts: { taskId?: string; now?: number } = {}): {
    day: string;
    timezone: 'Asia/Shanghai';
    task: (BudgetTotals & { taskId: string }) | null;
    daily: BudgetTotals;
    source: 'configured-estimate';
  } {
    const now = opts.now ?? Date.now();
    const dayKey = shanghaiDayKey(now);
    return {
      day: dayKey,
      timezone: 'Asia/Shanghai',
      task: opts.taskId ? { taskId: opts.taskId, ...this.taskTotals(opts.taskId) } : null,
      daily: this.dailyTotals(dayKey),
      source: 'configured-estimate',
    };
  }
}
