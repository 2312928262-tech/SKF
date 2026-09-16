import type { RuntimeStore } from '../runtime/runtime-store.js';
import {
  failureSignatureOf,
  shanghaiDay,
  successSampleHit,
  type ReviewTrigger,
} from './contracts.js';
import type { EvidenceSnapshot } from './evidence-snapshot.js';

/**
 * M13 · 复盘频率筛选（事件筛选，不是每任务必调模型）。
 *
 * 默认策略（可配置起点，不是质量定律）：
 * - 首现失败签名 / 恢复异常 / 验收失败：优先复盘
 * - 同类失败按 24h 窗口聚合：窗口内只累计样本，不重复复盘
 * - 普通成功：确定性抽样 10%
 * - 无实质执行的取消：跳过
 * - 每日自动复盘 ≤5 次独立限额（Asia/Shanghai 日界）；显式请求跳过抽样但不绕过预算
 */

export interface ReviewPolicyConfig {
  /** 每日自动复盘次数上限（默认 5）。 */
  dailyAutoLimit: number;
  /** 成功抽样百分比 0..100（默认 10）。 */
  successSamplePct: number;
  /** 同失败签名聚合窗口（默认 24h）。 */
  signatureWindowMs: number;
  /** 当前时间注入（测试用假时钟）。 */
  now?: () => Date;
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicyConfig = {
  dailyAutoLimit: 5,
  successSamplePct: 10,
  signatureWindowMs: 24 * 3_600_000,
};

export type ReviewDecision =
  | { review: true; trigger: ReviewTrigger; failureSignature: string | null }
  | { review: false; skipReason: string; trigger: ReviewTrigger | null; failureSignature: string | null };

function signatureOf(snapshot: EvidenceSnapshot): string | null {
  if (snapshot.finalState !== 'failed') return null;
  const toolNames = snapshot.operations.filter((op) => op.state === 'failed').map((op) => op.toolName);
  return failureSignatureOf(snapshot.errorCode, toolNames);
}

/** 决策是否复盘（不写库；配额消耗由 LearningService 在同事务内完成）。 */
export function decideReview(
  store: RuntimeStore,
  snapshot: EvidenceSnapshot,
  opts: ReviewPolicyConfig & { explicit?: boolean },
): ReviewDecision {
  const cfg = { ...DEFAULT_REVIEW_POLICY, ...opts };
  const now = (cfg.now ?? (() => new Date()))();
  const explicit = opts.explicit === true;
  const signature = signatureOf(snapshot);

  // 无实质执行的取消：默认跳过（没有任何工具操作的 cancelled 学不到东西）。
  if (snapshot.finalState === 'cancelled' && snapshot.operations.length === 0) {
    return { review: false, skipReason: 'no_substance_cancel', trigger: null, failureSignature: null };
  }

  let trigger: ReviewTrigger | null = null;
  if (explicit) {
    trigger = 'explicit';
  } else if (snapshot.acceptanceOk === false) {
    trigger = 'acceptance_failure';
  } else if (snapshot.recoveryAnomaly) {
    trigger = 'recovery_anomaly';
  } else if (snapshot.finalState === 'failed' && signature) {
    // 失败签名窗口聚合：首现优先；窗口内已复盘过只累计样本。
    const row = store.db
      .prepare('SELECT windowStartUtc, lastReviewedAt FROM learning_failure_signatures WHERE signature = ?')
      .get(signature) as { windowStartUtc: string; lastReviewedAt: string | null } | undefined;
    if (!row) {
      trigger = 'first_failure_signature';
    } else {
      const windowStart = Date.parse(row.windowStartUtc);
      const inWindow = now.getTime() - windowStart < cfg.signatureWindowMs;
      if (inWindow && row.lastReviewedAt) {
        return { review: false, skipReason: 'signature_window_aggregated', trigger: 'repeated_failure', failureSignature: signature };
      }
      trigger = row.lastReviewedAt ? 'repeated_failure' : 'first_failure_signature';
    }
  } else if (snapshot.finalState === 'succeeded') {
    if (!successSampleHit(snapshot.taskId, cfg.successSamplePct)) {
      return { review: false, skipReason: 'success_not_sampled', trigger: 'success_sample', failureSignature: null };
    }
    trigger = 'success_sample';
  } else {
    // cancelled 但有实质执行（有操作记录）：按失败签名逻辑归并到恢复异常外的兜底。
    return { review: false, skipReason: 'cancelled_no_priority_signal', trigger: null, failureSignature: null };
  }

  // 每日自动复盘独立限额：explicit 不占自动配额（但仍受 ModelGateway 预算约束）。
  if (trigger !== 'explicit') {
    const day = shanghaiDay(now);
    const quota = store.db.prepare('SELECT autoReviews FROM learning_review_quota WHERE day = ?').get(day) as
      | { autoReviews: number }
      | undefined;
    if ((quota?.autoReviews ?? 0) >= cfg.dailyAutoLimit) {
      return { review: false, skipReason: 'daily_quota_exhausted', trigger, failureSignature: signature };
    }
  }
  return { review: true, trigger, failureSignature: signature };
}

/** 复盘完成后回写签名窗口（同事务；lastReviewedAt 置位后窗口内同签名只累计样本）。 */
export function recordSignatureReviewed(store: RuntimeStore, signature: string, taskId: string, now: Date = new Date()): void {
  const row = store.db
    .prepare('SELECT sampleTaskIds, windowStartUtc, count FROM learning_failure_signatures WHERE signature = ?')
    .get(signature) as { sampleTaskIds: string; windowStartUtc: string; count: number } | undefined;
  if (!row) {
    store.db
      .prepare(
        'INSERT INTO learning_failure_signatures (signature, firstTaskId, sampleTaskIds, windowStartUtc, lastReviewedAt, count) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(signature, taskId, JSON.stringify([taskId]), now.toISOString(), now.toISOString());
    return;
  }
  const samples = JSON.parse(row.sampleTaskIds) as string[];
  if (!samples.includes(taskId)) samples.push(taskId);
  store.db
    .prepare('UPDATE learning_failure_signatures SET lastReviewedAt = ?, sampleTaskIds = ?, count = ? WHERE signature = ?')
    .run(now.toISOString(), JSON.stringify(samples.slice(-20)), row.count + 1, signature);
}

/** 只累计样本不更新 lastReviewedAt（窗口内重复失败）。 */
export function recordSignatureSample(store: RuntimeStore, signature: string, taskId: string): void {
  const row = store.db
    .prepare('SELECT sampleTaskIds, count FROM learning_failure_signatures WHERE signature = ?')
    .get(signature) as { sampleTaskIds: string; count: number } | undefined;
  if (!row) {
    store.db
      .prepare(
        'INSERT INTO learning_failure_signatures (signature, firstTaskId, sampleTaskIds, windowStartUtc, lastReviewedAt, count) VALUES (?, ?, ?, ?, NULL, 1)',
      )
      .run(signature, taskId, JSON.stringify([taskId]), new Date().toISOString());
    return;
  }
  const samples = JSON.parse(row.sampleTaskIds) as string[];
  if (!samples.includes(taskId)) samples.push(taskId);
  store.db
    .prepare('UPDATE learning_failure_signatures SET sampleTaskIds = ?, count = ? WHERE signature = ?')
    .run(JSON.stringify(samples.slice(-20)), row.count + 1, signature);
}

/** 消耗一次自动复盘配额（同事务；返回消耗后计数）。 */
export function consumeAutoQuota(store: RuntimeStore, now: Date = new Date()): number {
  const day = shanghaiDay(now);
  store.db
    .prepare(
      'INSERT INTO learning_review_quota (day, autoReviews) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET autoReviews = autoReviews + 1',
    )
    .run(day);
  const row = store.db.prepare('SELECT autoReviews FROM learning_review_quota WHERE day = ?').get(day) as { autoReviews: number };
  return row.autoReviews;
}
