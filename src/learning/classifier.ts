import { RuntimeError, type JSONValue } from '../runtime/contracts.js';
import {
  MAX_CANDIDATES_PER_REVIEW,
  parseCheckpointDefinition,
  type CheckpointDefinition,
  type Classification,
  type ExperienceKind,
} from './contracts.js';

/**
 * M13 · 三类仲裁（直击 Hermes #30220）。
 *
 * 先拆混合段落，再对单条按语义判：
 * - 完整操作契约 → skill
 * - 否则具有条件性建议/约束 → lesson
 * - 否则属于可核验描述 → fact
 * - 都不满足 → 拒收
 * 本质上是流程但字段缺失：保持 skill + incomplete，绝不降格塞进 fact。
 * 模型 kindHint 与代码语义判定分歧：classification_pending，不注入执行上下文。
 *
 * 字段验证由代码完成；模型输出只是提案，不能直接决定发布状态。
 */

export interface SkillStructured {
  preconditions: string[];
  steps: string[];
  tools: string[];
  acceptance: string;
  failureHandling: string;
}

export interface LessonStructured {
  condition: string;
  advice: string;
  rationale: string;
  exceptions: string;
}

export interface FactStructured {
  subject: string;
  assertion: string;
  validScope: string;
  validUntil: string | null;
}

export type StructuredBody =
  | { kind: 'skill'; body: SkillStructured }
  | { kind: 'lesson'; body: LessonStructured }
  | { kind: 'fact'; body: FactStructured };

export interface RawCandidate {
  kindHint: ExperienceKind | null;
  text: string;
  structured: Partial<Record<ExperienceKind, JSONValue>>;
  evidenceRefs: string[];
  suggestedCheckpoints: CheckpointDefinition[];
  classificationReason: string;
}

export interface ClassifiedCandidate {
  kind: ExperienceKind;
  classification: Classification;
  classificationReason: string;
  text: string;
  structured: SkillStructured | LessonStructured | FactStructured;
  evidenceRefs: string[];
  suggestedCheckpoints: CheckpointDefinition[];
}

export type CandidateOutcome =
  | { status: 'accepted'; candidate: ClassifiedCandidate }
  | { status: 'pending'; kind: ExperienceKind; text: string; reason: string; raw: RawCandidate }
  | { status: 'rejected'; reason: string; raw: RawCandidate | null };

// ── 字段级校验 ─────────────────────────────────────────

function isStringList(value: JSONValue | undefined, min: number, max: number): value is JSONValue[] & string[] {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500)
  );
}

function isText(value: JSONValue | undefined, max = 1000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** skill 完整操作契约：前置/步骤/工具/验收/失败处理 五项齐全。 */
export function isCompleteSkillContract(raw: JSONValue | undefined): raw is JSONValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, JSONValue>;
  return (
    isStringList(obj.preconditions, 1, 20) &&
    isStringList(obj.steps, 1, 30) &&
    isStringList(obj.tools, 1, 20) &&
    isText(obj.acceptance) &&
    isText(obj.failureHandling)
  );
}

/** skill 部分字段（本质上是流程但缺字段 → incomplete，不降格）。 */
function hasAnySkillField(raw: JSONValue | undefined): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, JSONValue>;
  return obj.steps !== undefined || obj.preconditions !== undefined || obj.tools !== undefined;
}

function parseSkill(raw: JSONValue): SkillStructured | 'incomplete' | null {
  if (isCompleteSkillContract(raw)) {
    const obj = raw as Record<string, JSONValue>;
    return {
      preconditions: (obj.preconditions as string[]).map((s) => s.trim()),
      steps: (obj.steps as string[]).map((s) => s.trim()),
      tools: (obj.tools as string[]).map((s) => s.trim()),
      acceptance: (obj.acceptance as string).trim(),
      failureHandling: (obj.failureHandling as string).trim(),
    };
  }
  return hasAnySkillField(raw) ? 'incomplete' : null;
}

function isLessonShape(raw: JSONValue | undefined): raw is JSONValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, JSONValue>;
  return isText(obj.condition) && isText(obj.advice) && isText(obj.rationale) && (obj.exceptions === undefined || isText(obj.exceptions));
}

function parseLesson(raw: JSONValue): LessonStructured | null {
  if (!isLessonShape(raw)) return null;
  const obj = raw as Record<string, JSONValue>;
  return {
    condition: (obj.condition as string).trim(),
    advice: (obj.advice as string).trim(),
    rationale: (obj.rationale as string).trim(),
    exceptions: typeof obj.exceptions === 'string' ? obj.exceptions.trim() : '',
  };
}

function isFactShape(raw: JSONValue | undefined): raw is JSONValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, JSONValue>;
  return (
    isText(obj.subject) &&
    isText(obj.assertion, 2000) &&
    isText(obj.validScope) &&
    (obj.validUntil === undefined || obj.validUntil === null || (typeof obj.validUntil === 'string' && /^\d{4}-\d{2}-\d{2}/.test(obj.validUntil)))
  );
}

function parseFact(raw: JSONValue): FactStructured | null {
  if (!isFactShape(raw)) return null;
  const obj = raw as Record<string, JSONValue>;
  return {
    subject: (obj.subject as string).trim(),
    assertion: (obj.assertion as string).trim(),
    validScope: (obj.validScope as string).trim(),
    validUntil: typeof obj.validUntil === 'string' ? obj.validUntil : null,
  };
}

// ── 单条语义判定 ───────────────────────────────────────

type SemanticVerdict =
  | { kind: 'skill'; classification: 'classified'; structured: SkillStructured }
  | { kind: 'skill'; classification: 'incomplete'; structured: SkillStructured | null }
  | { kind: 'lesson'; classification: 'classified'; structured: LessonStructured }
  | { kind: 'fact'; classification: 'classified'; structured: FactStructured }
  | { kind: 'rejected' };

/** 单条原子陈述的语义判定（优先级 skill > lesson > fact 只用于单条语义重叠时，不是可信度排序）。 */
export function judgeSingleKind(kind: ExperienceKind, raw: JSONValue): SemanticVerdict {
  if (kind === 'skill') {
    const parsed = parseSkill(raw);
    if (parsed === 'incomplete') return { kind: 'skill', classification: 'incomplete', structured: null };
    if (parsed) return { kind: 'skill', classification: 'classified', structured: parsed };
    return { kind: 'rejected' };
  }
  if (kind === 'lesson') {
    const parsed = parseLesson(raw);
    return parsed ? { kind: 'lesson', classification: 'classified', structured: parsed } : { kind: 'rejected' };
  }
  const parsed = parseFact(raw);
  return parsed ? { kind: 'fact', classification: 'classified', structured: parsed } : { kind: 'rejected' };
}

/** 混合候选拆分：structured 含多个 kind 字段 ⇒ 按 kind 拆成原子候选（保留各自结构段与关联文本）。 */
export function splitMixedCandidate(raw: RawCandidate): Array<{ kind: ExperienceKind; body: JSONValue }> {
  const kinds = (['skill', 'lesson', 'fact'] as const).filter((k) => raw.structured[k] !== undefined);
  return kinds.map((kind) => ({ kind, body: raw.structured[kind]! }));
}

/** 单条候选仲裁：拆混合 → 逐条语义判 → kindHint 一致性核对。 */
export function classifyCandidate(raw: RawCandidate): CandidateOutcome[] {
  const parts = splitMixedCandidate(raw);
  if (parts.length === 0) return [{ status: 'rejected', reason: 'no_structured_body', raw }];
  const outcomes: CandidateOutcome[] = [];
  for (const part of parts) {
    const verdict = judgeSingleKind(part.kind, part.body);
    if (verdict.kind === 'rejected') {
      outcomes.push({ status: 'rejected', reason: `malformed_${part.kind}_fields`, raw });
      continue;
    }
    // 类型分歧：模型声明的 kindHint 与代码语义判定不同 ⇒ classification_pending 不注入。
    if (raw.kindHint !== null && raw.kindHint !== verdict.kind) {
      outcomes.push({
        status: 'pending',
        kind: verdict.kind,
        text: raw.text,
        reason: `hint=${raw.kindHint} semantic=${verdict.kind}`,
        raw,
      });
      continue;
    }
    outcomes.push({
      status: 'accepted',
      candidate: {
        kind: verdict.kind,
        classification: verdict.classification,
        classificationReason: raw.classificationReason,
        text: raw.text,
        structured: verdict.structured ?? ({} as never),
        evidenceRefs: raw.evidenceRefs,
        suggestedCheckpoints: raw.suggestedCheckpoints,
      },
    });
  }
  return outcomes;
}

// ── 复盘模型输出解析（严格形状）─────────────────────────

function parseKindHint(raw: JSONValue | undefined): ExperienceKind | null {
  if (raw === 'skill' || raw === 'lesson' || raw === 'fact') return raw;
  return null;
}

function parseEvidenceRefs(raw: JSONValue | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && /^[a-z]+:[^\s]{1,200}$/.test(item)).slice(0, 12);
}

function parseCheckpoints(raw: JSONValue | undefined): CheckpointDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: CheckpointDefinition[] = [];
  for (const item of raw.slice(0, 6)) {
    try {
      out.push(parseCheckpointDefinition(item));
    } catch {
      // 非法检查点定义丢弃（模型输出不可信；只有过代码校验的才可能进入人工审核）
    }
  }
  return out;
}

export interface ParsedReviewOutput {
  candidates: RawCandidate[];
  reviewNotes: string;
  truncated: boolean;
}

/** 解析复盘模型文本输出：必须是单个 JSON 对象 {candidates[], reviewNotes?}。 */
export function parseReviewOutput(text: string): ParsedReviewOutput {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new RuntimeError('REVIEW_OUTPUT_INVALID', 'no json object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new RuntimeError('REVIEW_OUTPUT_INVALID', 'json parse failed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimeError('REVIEW_OUTPUT_INVALID', 'object expected');
  }
  const obj = parsed as Record<string, unknown>;
  const rawCandidates = obj.candidates;
  if (!Array.isArray(rawCandidates)) throw new RuntimeError('REVIEW_OUTPUT_INVALID', 'candidates must be array');
  const reviewNotes = typeof obj.reviewNotes === 'string' ? obj.reviewNotes.slice(0, 2000) : '';
  const truncated = rawCandidates.length > MAX_CANDIDATES_PER_REVIEW;
  const candidates: RawCandidate[] = rawCandidates.slice(0, MAX_CANDIDATES_PER_REVIEW).map((item) => {
    const c = (item ?? {}) as Record<string, unknown>;
    const structured = (c.structured ?? {}) as Record<string, JSONValue>;
    return {
      kindHint: parseKindHint(c.kindHint as JSONValue),
      text: typeof c.text === 'string' ? c.text.slice(0, 2000) : '',
      structured: {
        skill: structured.skill,
        lesson: structured.lesson,
        fact: structured.fact,
      } as Partial<Record<ExperienceKind, JSONValue>>,
      evidenceRefs: parseEvidenceRefs(c.evidenceRefs as JSONValue),
      suggestedCheckpoints: parseCheckpoints(c.suggestedCheckpoints as JSONValue),
      classificationReason: typeof c.classificationReason === 'string' ? c.classificationReason.slice(0, 500) : '',
    };
  });
  if (candidates.some((c) => !c.text.trim())) throw new RuntimeError('REVIEW_OUTPUT_INVALID', 'candidate text required');
  return { candidates, reviewNotes, truncated };
}
