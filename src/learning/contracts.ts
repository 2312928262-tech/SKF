import { createHash } from 'node:crypto';
import { stableStringify, type JSONValue } from '../runtime/contracts.js';

/**
 * M13 · 学习闭环契约（影子模式首版）。
 *
 * 核心边界（GPT-6 Q2，用户拍板）：
 * - 经验不是授权：candidate/confirmed 文本永远过不了 PolicyGate，安全/授权/预算规则
 *   不因经验确认而改变。
 * - 候选不是规则：candidate 仅作标记清楚的参考，不产生硬检查点。
 * - 注入不等于执行：检查点完成状态由运行时/授权流程确认，模型自报无效。
 * - 任务成功不等于经验正确：自动复盘永远写 candidate；晋级只有人工确认一条通道，
 *   且确认绑定具体 revision/contentHash；内容修改生成新 revision，不继承确认状态。
 */

/** 复盘器版本：prompt/校验逻辑任何实质变化都必须递增（幂等键组成部分）。 */
export const REVIEWER_VERSION = 'm13-reviewer-v1';

/** 每次复盘最多产出的候选条数（允许 0 条）。 */
export const MAX_CANDIDATES_PER_REVIEW = 3;

export const EXPERIENCE_KINDS = ['skill', 'lesson', 'fact'] as const;
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

/** 分类仲裁结果（代码字段验证 × 模型 kindHint）：
 *  classified = 字段完整且语义一致；
 *  incomplete = 本质是流程但字段缺失，保持 skill 不降格为 fact（直击 Hermes #30220）；
 *  classification_pending = 类型分歧无法消解，不注入执行上下文。 */
export const CLASSIFICATIONS = ['classified', 'incomplete', 'classification_pending'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CHECKPOINT_KINDS = ['deterministic', 'evidence', 'judgment'] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const CHECKPOINT_STATES = ['pending', 'passed', 'failed', 'not_applicable', 'waived'] as const;
export type CheckpointState = (typeof CHECKPOINT_STATES)[number];

/** enforcement：advisory = 仅参考；approved_checkpoint = 人工确认并审核后可安装硬检查点。
 *  candidate 永远是 advisory（硬约束权限不自动获得）。 */
export const ENFORCEMENTS = ['advisory', 'approved_checkpoint'] as const;
export type Enforcement = (typeof ENFORCEMENTS)[number];

/** SKF 侧经验账本状态（信任权威仍在主档 records.trust；这里是执行层生命周期）。 */
export const EXPERIENCE_STATUSES = ['candidate', 'confirmed', 'disputed', 'deprecated'] as const;
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

export const REVIEW_STATES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REVIEW_TRIGGERS = [
  'first_failure_signature',
  'recovery_anomaly',
  'acceptance_failure',
  'repeated_failure',
  'success_sample',
  'explicit',
] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

// ── 检查点定义（结构化，人工审核后才可生效）─────────────────

/** deterministic：写 path 前必须已有 file.read(path) 的 succeeded operation。 */
export interface RequirePriorReadDefinition {
  type: 'require_prior_read';
  path: string;
}

/** evidence：写 path 后必须有 file.stat/file.read(path) 的 succeeded operation 核验。 */
export interface RequirePostVerifyDefinition {
  type: 'require_post_verify';
  path: string;
}

/** judgment：建议性条款；运行时只记录采用/不适用+理由，不作为成功条件。 */
export interface JudgmentNoteDefinition {
  type: 'judgment_note';
  note: string;
}

export type CheckpointDefinition =
  | RequirePriorReadDefinition
  | RequirePostVerifyDefinition
  | JudgmentNoteDefinition;

export const CHECKPOINT_DEFINITION_TYPES = ['require_prior_read', 'require_post_verify', 'judgment_note'] as const;

export function checkpointKindOf(def: CheckpointDefinition): CheckpointKind {
  if (def.type === 'require_prior_read') return 'deterministic';
  if (def.type === 'require_post_verify') return 'evidence';
  return 'judgment';
}

/** 严格校验检查点定义（模型输出不可信，只有过这关才可能进入人工审核）。 */
export function parseCheckpointDefinition(raw: JSONValue): CheckpointDefinition {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CHECKPOINT_INVALID');
  const obj = raw as Record<string, JSONValue>;
  if (obj.type === 'require_prior_read' || obj.type === 'require_post_verify') {
    if (typeof obj.path !== 'string' || !obj.path || obj.path.length > 512 || obj.path.includes('..')) {
      throw new Error('CHECKPOINT_INVALID');
    }
    if (Object.keys(obj).length !== 2) throw new Error('CHECKPOINT_INVALID');
    return { type: obj.type, path: obj.path };
  }
  if (obj.type === 'judgment_note') {
    if (typeof obj.note !== 'string' || !obj.note || obj.note.length > 1000) throw new Error('CHECKPOINT_INVALID');
    if (Object.keys(obj).length !== 2) throw new Error('CHECKPOINT_INVALID');
    return { type: 'judgment_note', note: obj.note };
  }
  throw new Error('CHECKPOINT_INVALID');
}

/** 硬检查点 = deterministic + evidence；judgment 只记录不阻断。 */
export function isHardCheckpoint(kind: CheckpointKind): boolean {
  return kind === 'deterministic' || kind === 'evidence';
}

// ── 稳定 hash ─────────────────────────────────────────────

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contentFingerprint(kind: ExperienceKind, text: string): string {
  return sha256Text(`m13:fingerprint:${kind}:${text.trim().replace(/\s+/g, ' ').toLowerCase()}`);
}

export function reviewIdOf(taskId: string, snapshotHash: string, reviewerVersion: string = REVIEWER_VERSION): string {
  return `review:${taskId}:${snapshotHash.slice(0, 16)}:${reviewerVersion}`;
}

/** 失败签名：errorCode + 归一化工具模式（同因多次失败聚合成一个签名）。 */
export function failureSignatureOf(errorCode: string | null, toolNames: readonly string[]): string {
  const normalized = [...new Set(toolNames)].sort().join(',');
  return sha256Text(`m13:failure:${errorCode ?? 'NONE'}:${normalized}`).slice(0, 32);
}

/** 成功抽样：确定性 hash(taskId) 取模，可复现（非随机）。 */
export function successSampleHit(taskId: string, pct: number): boolean {
  const hex = sha256Text(`m13:sample:${taskId}`).slice(0, 8);
  return parseInt(hex, 16) % 100 < pct;
}

/** Asia/Shanghai 日界（与 budget-ledger 口径一致：UTC+8，无 DST）。 */
export function shanghaiDay(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

export function stableJson(value: JSONValue): string {
  return stableStringify(value);
}
