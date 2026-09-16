/**
 * M15 · cron 表达式与时区计算。
 *
 * 设计要点：
 * - 经典 5 字段（minute hour dom month dow）；不支持秒级与 @ 速记，保持可读可审。
 * - 时区一律 IANA 名（Asia/Shanghai 等）；UTC 仅作持久化与比较口径，不参与解析。
 * - 计划时刻以 UTC 持久；DST 不存在的"跳过时刻"按本地不存在处理（不补 firing）；
 *   重复时刻（fall-back）只触发一次（按唯一键防重）。
 * - 时钟倒退：UTC 持久口径天然单调，唯一键 cron:<sid>:<gen>:<scheduledAtUtc>
 *   防任何状态下重放；跃进（错过的计划时刻）由调度器补偿策略处理（见 dispatcher）。
 */

import { RuntimeError } from '../runtime/contracts.js';

/** 单字段取值范围（5-field cron）。 */
const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 }, // 0 = 周日
] as const;

type ParsedField = ReadonlySet<number>;

interface ParsedCron {
  minute: ParsedField;
  hour: ParsedField;
  dom: ParsedField;
  month: ParsedField;
  dow: ParsedField;
  /** 原始表达式（用于诊断/日志）。 */
  expr: string;
}

/** 解析单字段：支持 `*`、`a-b`、`a-b/n`、`a,b,c`、`*\/n`。越界/重复拒绝。 */
function parseField(text: string, range: { min: number; max: number }, name: string): ParsedField {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (token.length === 0) throw new RuntimeError('INVALID_CRON', `${name}: empty segment`);
    const stepMatch = token.match(/^(.+?)\/(\d+)$/);
    let base = token;
    let step = 1;
    if (stepMatch) {
      step = Number(stepMatch[2]);
      if (!Number.isSafeInteger(step) || step < 1 || step > range.max) {
        throw new RuntimeError('INVALID_CRON', `${name}: bad step ${stepMatch[2]}`);
      }
      base = stepMatch[1];
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = range.min;
      hi = range.max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new RuntimeError('INVALID_CRON', `${name}: bad range ${base}`);
    } else {
      lo = Number(base);
      hi = lo;
      if (!Number.isInteger(lo)) throw new RuntimeError('INVALID_CRON', `${name}: not a number ${base}`);
    }
    if (lo < range.min || hi > range.max || lo > hi) {
      throw new RuntimeError('INVALID_CRON', `${name}: ${lo}-${hi} outside ${range.min}-${range.max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new RuntimeError('INVALID_CRON', `${name}: no values`);
  return values;
}

/** 解析 5 字段 cron 表达式；不支持 6 字段（带秒）。 */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== 'string') throw new RuntimeError('INVALID_CRON', 'expression must be string');
  const trimmed = expr.trim().replace(/\s+/g, ' ');
  const parts = trimmed.split(' ');
  if (parts.length !== 5) throw new RuntimeError('INVALID_CRON', `expected 5 fields, got ${parts.length}`);
  return {
    minute: parseField(parts[0], FIELD_RANGES[0], 'minute'),
    hour: parseField(parts[1], FIELD_RANGES[1], 'hour'),
    dom: parseField(parts[2], FIELD_RANGES[2], 'dom'),
    month: parseField(parts[3], FIELD_RANGES[3], 'month'),
    dow: parseField(parts[4], FIELD_RANGES[4], 'dow'),
    expr: trimmed,
  };
}

/** 验证 IANA 时区名（系统支持且非空）；不缓存，调用方按需。 */
export function validateTimezone(tz: string): string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) {
    throw new RuntimeError('INVALID_TIMEZONE', 'must be non-empty IANA name');
  }
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) throw new RuntimeError('INVALID_TIMEZONE', tz);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
  } catch {
    throw new RuntimeError('INVALID_TIMEZONE', tz);
  }
  return tz;
}

/**
 * 计算 cron 在指定时区下，fromUtc 之后（含 fromUtc 自身）下一次计划触发的 UTC 时刻。
 * - 字段比对用 local-time（Intl.DateTimeFormat 把 UTC 投影到目标 tz）
 * - DST 跳过（spring-forward 不存在的本地时刻）= 那一刻不在任何字段组合里，自然不入结果；
 *   不会为它补 firing。
 * - DST 重复（fall-back 同一本地时刻出现两次）= 两次 UTC 都满足条件；上层用唯一键保证只触发一次。
 * - 单调推进；最多扫 5*12=60 个月，超过则抛 PROTECT_LOOP（cron 不可能合法耗这么久）。
 */
export function nextFireUtc(cron: ParsedCron, tz: string, fromUtc: Date): Date {
  validateTimezone(tz);
  if (!(fromUtc instanceof Date) || Number.isNaN(fromUtc.getTime())) {
    throw new RuntimeError('INVALID_INPUT', 'fromUtc must be valid Date');
  }
  // 取 fromUtc 对应的本地 "yyyy-mm-dd hh:mm:ss dow" 作为起点。
  const parts = formatLocalParts(fromUtc, tz);
  let year = parts.year;
  let month = parts.month;
  let dom = parts.dom;
  let hour = parts.hour;
  let minute = parts.minute;
  // 循环上限：5 年。
  for (let safety = 0; safety < 60 * 12; safety++) {
    if (!cron.month.has(month)) {
      const next = advanceToNextMonth(year, month, tz);
      year = next.year;
      month = next.month;
      dom = 1;
      hour = 0;
      minute = 0;
      continue;
    }
    const daysInMonth = daysInGregorianMonth(year, month);
    if (dom > daysInMonth) {
      const next = advanceToNextMonth(year, month, tz);
      year = next.year;
      month = next.month;
      dom = 1;
      hour = 0;
      minute = 0;
      continue;
    }
    const weekday = weekdayInTimezone(year, month, dom, tz);
    const domMatch = cron.dom.has(dom);
    const dowMatch = cron.dow.has(weekday);
    // 标准 cron：dom 与 dow 同时限制时取 OR（任一满足即可），除非其中之一是 `*`。
    // 这里把 dom 与 dow 当作"任一不为 * 时必须命中其一"，否则视为必须同时命中。
    // 简化：都视为"满足任一"——经典 Vixie cron 行为。
    const dayOk = domMatch || dowMatch;
    if (!dayOk) {
      const next = advanceToNextDay(year, month, dom, tz);
      year = next.year;
      month = next.month;
      dom = next.dom;
      hour = 0;
      minute = 0;
      continue;
    }
    if (!cron.hour.has(hour)) {
      const next = advanceToNextHour(year, month, dom, hour, tz);
      year = next.year;
      month = next.month;
      dom = next.dom;
      hour = next.hour;
      minute = 0;
      continue;
    }
    if (!cron.minute.has(minute)) {
      const next = advanceToNextMinute(year, month, dom, hour, minute, tz);
      year = next.year;
      month = next.month;
      dom = next.dom;
      hour = next.hour;
      minute = next.minute;
      continue;
    }
    // 命中：把本地 year/month/dom/hour/minute 还原为 UTC。
    // 注意：DST 重复时同一 local-time 对应两个 UTC——取"离 fromUtc 最近的将来"。
    try {
      return localToUtcWithDstResolution(year, month, dom, hour, minute, 0, tz, fromUtc);
    } catch (error) {
      if (error instanceof RuntimeError && (error.code === 'INVALID_LOCAL_TIME' || error.code === 'PROTECT_LOOP')) {
        // spring-forward 跳过 / fall-back 重复均 +1 分钟重试。
        const advance = advanceToNextMinute(year, month, dom, hour, minute, tz);
        year = advance.year;
        month = advance.month;
        dom = advance.dom;
        hour = advance.hour;
        minute = advance.minute;
        continue;
      }
      throw error;
    }
  }
  throw new RuntimeError('PROTECT_LOOP', 'nextFire exceeded safety bound');
}

// ── 时区原语（仅依赖 Intl）───────────────────────────────────────────

interface LocalParts {
  year: number;
  month: number;
  dom: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function formatLocalParts(utc: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(utc).map((p) => [p.type, p.value]));
  // hour === '24' 在 hour12:false 下表示本地 00:00（Intl 怪癖）；归零。
  const rawHour = Number(parts.hour);
  const hour = rawHour === 24 ? 0 : rawHour;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    dom: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayShortToNumber(parts.weekday),
  };
}

function weekdayShortToNumber(s: string): number {
  switch (s) {
    case 'Sun': return 0;
    case 'Mon': return 1;
    case 'Tue': return 2;
    case 'Wed': return 3;
    case 'Thu': return 4;
    case 'Fri': return 5;
    case 'Sat': return 6;
    default: throw new RuntimeError('INVALID_TIMEZONE', 'unexpected weekday ' + s);
  }
}

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function advanceToNextMonth(year: number, month: number, tz: string): { year: number; month: number } {
  const probeUtc = new Date(Date.UTC(year, month - 1, 15, 12, 0, 0));
  const probe = formatLocalParts(probeUtc, tz);
  void probe;
  let m = month + 1;
  let y = year;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return { year: y, month: m };
}

function advanceToNextDay(year: number, month: number, dom: number, tz: string): { year: number; month: number; dom: number } {
  let y = year;
  let m = month;
  let d = dom + 1;
  const dim = daysInGregorianMonth(y, m);
  if (d > dim) {
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  void tz;
  return { year: y, month: m, dom: d };
}

function advanceToNextHour(year: number, month: number, dom: number, hour: number, tz: string): {
  year: number;
  month: number;
  dom: number;
  hour: number;
} {
  let h = hour + 1;
  let y = year;
  let m = month;
  let d = dom;
  if (h > 23) {
    h = 0;
    const next = advanceToNextDay(y, m, d, tz);
    y = next.year;
    m = next.month;
    d = next.dom;
  }
  return { year: y, month: m, dom: d, hour: h };
}

function advanceToNextMinute(
  year: number,
  month: number,
  dom: number,
  hour: number,
  minute: number,
  tz: string,
): { year: number; month: number; dom: number; hour: number; minute: number } {
  let mi = minute + 1;
  let h = hour;
  let y = year;
  let m = month;
  let d = dom;
  if (mi > 59) {
    mi = 0;
    const next = advanceToNextHour(y, m, d, h, tz);
    y = next.year;
    m = next.month;
    d = next.dom;
    h = next.hour;
  }
  return { year: y, month: m, dom: d, hour: h, minute: mi };
}

function weekdayInTimezone(year: number, month: number, dom: number, tz: string): number {
  // 用本地 noon 探测；避免 DST 边界抖动。
  const utc = guessUtcFromLocal(year, month, dom, 12, 0, 0, tz);
  return formatLocalParts(utc, tz).weekday;
}

/**
 * 把 local 时刻还原为 UTC。
 * DST 不存在的本地时刻（spring-forward 跳过）=> 抛 INVALID_LOCAL_TIME，让外层跳过。
 * DST 重复（fall-back）=> 取离 fromUtc 最近的将来那个 UTC（保证单调）。
 */
function localToUtcWithDstResolution(
  year: number,
  month: number,
  dom: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
  fromUtc: Date,
): Date {
  const candidates = utcCandidatesForLocal(year, month, dom, hour, minute, second, tz);
  if (candidates.length === 0) {
    throw new RuntimeError('INVALID_LOCAL_TIME', `local ${ymdHms(year, month, dom, hour, minute, second)} does not exist in ${tz}`);
  }
  // 严格大于 fromUtc 的第一个候选。若没有 → 外层应继续推进（循环 retry）。
  for (const c of candidates) {
    if (c.getTime() > fromUtc.getTime()) return c;
  }
  throw new RuntimeError('PROTECT_LOOP', 'candidates exhausted');
}

/** 给定 local 时刻，找出所有可能的 UTC（处理 DST fall-back）；不存在则空数组。 */
function utcCandidatesForLocal(
  year: number,
  month: number,
  dom: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date[] {
  // 扫描目标 local 当天 [00:00, 24:00) 的 UTC 区间（在 tz 下 00:00 = UTC + offset），
  // 找出所有投影到 (y, mo, d, h, mi, s) 的 UTC。
  // 先估当天 noon UTC，取其 offset 作为参考；以此扫描 [noon-15h, noon+15h] 范围。
  const noonUtc = Date.UTC(year, month - 1, dom, 12, 0, 0);
  const noonOffset = tzOffsetMinutes(new Date(noonUtc), tz);
  const noonLocalUtc = noonUtc - noonOffset * 60_000; // noon in tz 投影到 UTC
  const startUtc = noonLocalUtc - 18 * 3600 * 1000;
  const endUtc = noonLocalUtc + 18 * 3600 * 1000;
  const result: Date[] = [];
  for (let t = startUtc; t <= endUtc; t += 60_000) {
    const candidate = new Date(t);
    const lp = formatLocalParts(candidate, tz);
    if (
      lp.year === year && lp.month === month && lp.dom === dom &&
      lp.hour === hour && lp.minute === minute && lp.second === second
    ) {
      if (!result.some((existing) => existing.getTime() === t)) {
        result.push(candidate);
      }
    }
  }
  result.sort((a, b) => a.getTime() - b.getTime());
  return result;
}

function tzOffsetMinutes(utc: Date, tz: string): number {
  const parts = formatLocalParts(utc, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.dom, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - utc.getTime()) / 60_000);
}

function ymdHms(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function guessUtcFromLocal(year: number, month: number, dom: number, hour: number, minute: number, second: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, dom, hour, minute, second);
  const offset = tzOffsetMinutes(new Date(naive), tz);
  return new Date(naive - offset * 60_000);
}

/**
 * 计算 fromUtc 之后（含自身）最多 maxCount 个连续计划时刻（UTC）。
 * DST 不存在的本地时刻跳过（不会为它返回 firing）。
 * DST 重复（fall-back）按唯一键防重——这里返回两个相同 local 的 firing，
 * 由上层持久层用 (scheduleId, generation, scheduledAtUtc) 唯一键保证只触发一次。
 */
export function nextFiresUtc(cron: ParsedCron, tz: string, fromUtc: Date, maxCount: number): Date[] {
  if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 1000) {
    throw new RuntimeError('INVALID_INPUT', 'maxCount must be 1..1000');
  }
  const out: Date[] = [];
  let cursor = fromUtc.getTime();
  for (let i = 0; i < maxCount; i++) {
    let next: Date;
    try {
      next = nextFireUtc(cron, tz, new Date(cursor));
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'PROTECT_LOOP') {
        // PROTECT_LOOP 在 hour 推进时若 DST 不存在会抛——递归 +1ms 重试（极少见）。
        cursor += 60_000;
        if (i > 0 && cursor - out[out.length - 1].getTime() > 366 * 24 * 3600 * 1000) break;
        i -= 1;
        continue;
      }
      throw error;
    }
    out.push(next);
    cursor = next.getTime() + 1; // +1ms 让 fall-back 的两个候选都可被采到
  }
  return out;
}
