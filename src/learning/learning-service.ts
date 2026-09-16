import { randomUUID } from 'node:crypto';
import { appendEvent } from '../runtime/events.js';
import { RuntimeError, stableStringify, type JSONValue } from '../runtime/contracts.js';
import type { RuntimeStore } from '../runtime/runtime-store.js';
import type { TaskRecord, TaskService } from '../runtime/task-service.js';
import type { ModelGateway } from '../runtime/model-gateway.js';
import type { ToolCall } from '../providers/protocol.js';
import { verifyAcceptance } from '../runtime/artifact-verifier.js';
import {
  MAX_CANDIDATES_PER_REVIEW,
  REVIEWER_VERSION,
  checkpointKindOf,
  contentFingerprint,
  isHardCheckpoint,
  parseCheckpointDefinition,
  reviewIdOf,
  sha256Text,
  type CheckpointDefinition,
  type ExperienceKind,
  type ExperienceStatus,
  type ReviewState,
  type ReviewTrigger,
} from './contracts.js';
import { buildEvidenceSnapshot, snapshotHash, type EvidenceSnapshot } from './evidence-snapshot.js';
import {
  DEFAULT_REVIEW_POLICY,
  decideReview,
  consumeAutoQuota,
  recordSignatureReviewed,
  recordSignatureSample,
  type ReviewPolicyConfig,
} from './review-policy.js';
import { classifyCandidate, parseReviewOutput, type ClassifiedCandidate } from './classifier.js';
import {
  buildExperienceBundle,
  getExperience,
  hardCheckpointDefs,
  judgmentDefs,
  type ExperienceRow,
  type InjectedExperience,
} from './retrieval.js';
import { REVIEW_SYSTEM } from './review-prompt.js';

/**
 * M13 · LearningService —— 学习闭环（影子模式，首版只人工确认）。
 *
 * 链路：终态证据快照 → 频率筛选 → 复盘（经 ModelGateway，每日 ≤5 次独立限额）
 * → 三类仲裁 → 候选写主档（trust=candidate 永远）→ 检索注入 ExperienceBundle
 * → AgentLoop 登记/执行检查点 → 执行证据回流 → 人工确认（promotion）。
 *
 * 影子模式纪律：只观察/记录/评估——不自动改策略、不触发真实任务、不自动晋级；
 * 复盘失败绝不改变原任务终态；candidate 不产生硬检查点也软化不了任何既有门。
 */

/** 主档写入通道的最小接口（MemoryAdapter 满足；测试可用内存假实现）。 */
export interface LearningMemorySink {
  record(input: Record<string, unknown>, operationId: string): Promise<{ id: string; status?: string; deduplicated?: boolean }>;
}

export interface LearningServiceDeps {
  store: RuntimeStore;
  service: TaskService;
  /** null = 复盘不可用（BUDGET_UNAVAILABLE 如实标记，绝不旁路）。 */
  gateway: ModelGateway | null;
  /** null = 主档不可用：候选只落 SKF 账本并标记（memoryRecordId=''），恢复后可补。 */
  memory: LearningMemorySink | null;
  policy?: Partial<ReviewPolicyConfig>;
  /** 复盘路由（provider/model）；缺省走 gateway 默认路由，绝不自动升级昂贵。 */
  reviewRoute?: { provider?: string; model?: string };
  reviewerVersion?: string;
  enabled?: boolean;
  /** 复盘输出 token 上限与超时（保护上限，非预算）。 */
  reviewMaxOutputTokens?: number;
  reviewTimeoutMs?: number;
  /** 登记复盘后自动唤醒泵（默认 true）；测试置 false 显式 await pumpReviews()。 */
  autoPump?: boolean;
  logger?: (line: string) => void;
}

export interface ReviewRow {
  id: string;
  taskId: string;
  evidenceSnapshotHash: string;
  reviewerVersion: string;
  triggerKind: ReviewTrigger;
  state: ReviewState;
  skipReason: string | null;
  snapshot: string;
  failureSignature: string | null;
  candidatesProduced: number;
  candidatesRejected: number;
  modelCallId: string | null;
  reviewNotes: string | null;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

interface CheckpointRow {
  id: string;
  taskId: string;
  experienceId: string;
  experienceRevision: number;
  checkpointIndex: number;
  kind: 'deterministic' | 'evidence' | 'judgment';
  definition: string;
  state: 'pending' | 'passed' | 'failed' | 'not_applicable' | 'waived';
  operationId: string | null;
  reason: string | null;
  checkedAt: string | null;
}

const VAULT_KIND_MAP: Record<ExperienceKind, string> = { skill: 'lesson', lesson: 'lesson', fact: 'fact' };

export class LearningService {
  private pumping = false;
  private readonly enabled: boolean;
  private readonly policy: ReviewPolicyConfig;
  private readonly reviewerVersion: string;
  private readonly autoPump: boolean;

  constructor(private deps: LearningServiceDeps) {
    this.enabled = deps.enabled !== false;
    this.policy = { ...DEFAULT_REVIEW_POLICY, ...deps.policy };
    this.reviewerVersion = deps.reviewerVersion ?? REVIEWER_VERSION;
    this.autoPump = deps.autoPump !== false;
  }

  private wakePump(): void {
    if (this.autoPump) void this.pumpReviews();
  }

  /** IPC 只读查询用（learning_experiences 账本）。 */
  get store(): RuntimeStore {
    return this.deps.store;
  }

  // ── 终态回调：快照 → 筛选 → 登记复盘 + 证据回流 ─────────────

  /**
   * 任务终态后调用（TaskWorker.onTaskTerminal 链路）。
   * 复盘触发永远不改变原任务终态；本方法自己的账本写入失败只记日志。
   */
  onTaskTerminal(taskId: string): void {
    if (!this.enabled) return;
    try {
      this.reflowApplications(taskId);
      const task = this.deps.service.getTask(taskId);
      if (!task) return;
      if (task.state !== 'succeeded' && task.state !== 'failed' && task.state !== 'cancelled') return;
      this.registerReview(task, { explicit: false });
    } catch (error) {
      this.deps.logger?.(`[learning] onTaskTerminal ${taskId} failed (task terminal unchanged): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 登记复盘（幂等键 taskId+snapshotHash+reviewerVersion；重复通知/重投不产生重复行）。 */
  private registerReview(task: TaskRecord, opts: { explicit: boolean }): { reviewId: string; state: ReviewState } {
    const snapshot = buildEvidenceSnapshot(this.deps.service, task);
    const hash = snapshotHash(snapshot);
    const reviewId = reviewIdOf(task.id, hash, this.reviewerVersion);
    const decision = decideReview(this.deps.store, snapshot, { ...this.policy, explicit: opts.explicit });
    const now = new Date().toISOString();
    this.deps.store.transaction(() => {
      const existing = this.deps.store.db.prepare('SELECT id, state FROM learning_reviews WHERE id = ?').get(reviewId) as
        | { id: string; state: ReviewState }
        | undefined;
      if (existing) return; // 幂等：同任务同快照同复盘器版本只登记一次
      const state: ReviewState = decision.review ? 'pending' : 'skipped';
      const triggerKind = decision.review ? decision.trigger : (decision.trigger ?? 'explicit');
      this.deps.store.db
        .prepare(
          `INSERT INTO learning_reviews
             (id, taskId, evidenceSnapshotHash, reviewerVersion, triggerKind, state, skipReason, snapshot, failureSignature,
              candidatesProduced, candidatesRejected, modelCallId, reviewNotes, createdAt, completedAt, errorCode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(
          reviewId,
          task.id,
          hash,
          this.reviewerVersion,
          triggerKind,
          state,
          decision.review ? null : decision.skipReason,
          stableStringify(snapshot as unknown as JSONValue),
          decision.failureSignature,
          now,
        );
      appendEvent(this.deps.store, task.id, 'learning.review_registered', {
        reviewId,
        trigger: decision.review ? decision.trigger : decision.trigger,
        state,
        skipReason: decision.review ? null : decision.skipReason,
      } as unknown as JSONValue);
      // 窗口内重复失败：只累计样本，不更新 lastReviewedAt。
      if (!decision.review && decision.skipReason === 'signature_window_aggregated' && decision.failureSignature) {
        recordSignatureSample(this.deps.store, decision.failureSignature, task.id);
      }
    });
    const row = this.deps.store.db.prepare('SELECT state FROM learning_reviews WHERE id = ?').get(reviewId) as { state: ReviewState };
    if (row.state === 'pending') this.wakePump();
    return { reviewId, state: row.state };
  }

  /** 显式复盘请求（IPC）：跳过抽样/签名窗口，不绕过配额与预算。 */
  requestReviewNow(taskId: string): { reviewId: string; state: ReviewState } {
    if (!this.enabled) throw new RuntimeError('LEARNING_DISABLED');
    const task = this.deps.service.getTask(taskId);
    if (!task) throw new RuntimeError('TASK_NOT_FOUND', taskId);
    if (task.state !== 'succeeded' && task.state !== 'failed' && task.state !== 'cancelled') {
      throw new RuntimeError('TASK_NOT_TERMINAL', taskId);
    }
    // 已有 pending/running 的同键复盘：显式请求幂等返回；failed/skipped 的重置为 pending 再来一轮。
    const result = this.registerReview(task, { explicit: true });
    const row = this.deps.store.db.prepare('SELECT id, state, triggerKind FROM learning_reviews WHERE id = ?').get(result.reviewId) as
      | { id: string; state: ReviewState; triggerKind: ReviewTrigger }
      | undefined;
    if (row && (row.state === 'skipped' || row.state === 'failed') && row.triggerKind !== 'explicit') {
      this.deps.store.db
        .prepare("UPDATE learning_reviews SET state = 'pending', triggerKind = 'explicit', skipReason = NULL, completedAt = NULL, errorCode = NULL WHERE id = ?")
        .run(result.reviewId);
      appendEvent(this.deps.store, taskId, 'learning.review_requeued', { reviewId: result.reviewId } as unknown as JSONValue);
      this.wakePump();
      return { reviewId: result.reviewId, state: 'pending' };
    }
    return { reviewId: result.reviewId, state: row?.state ?? result.state };
  }

  // ── 复盘泵（并发 1，前台任务优先：只处理 pending 行）─────────

  /** 启动恢复：running 行重置 pending（崩溃重驱；幂等键保证不生重复候选）。 */
  recoverReviewQueue(): number {
    if (!this.enabled) return 0;
    const result = this.deps.store.db.prepare("UPDATE learning_reviews SET state = 'pending' WHERE state = 'running'").run();
    const n = Number(result.changes);
    if (n > 0) this.wakePump();
    return n;
  }

  async pumpReviews(): Promise<{ processed: number }> {
    if (this.pumping) return { processed: 0 };
    this.pumping = true;
    let processed = 0;
    try {
      for (;;) {
        const next = this.deps.store.db
          .prepare("SELECT id FROM learning_reviews WHERE state = 'pending' ORDER BY createdAt ASC, id ASC LIMIT 1")
          .get() as { id: string } | undefined;
        if (!next) break;
        // CAS：只有仍 pending 才接手（多实例/重入安全）。
        const claimed = this.deps.store.db
          .prepare("UPDATE learning_reviews SET state = 'running' WHERE id = ? AND state = 'pending'")
          .run(next.id);
        if (Number(claimed.changes) !== 1) continue;
        try {
          await this.runReview(next.id);
          processed++;
        } catch (error) {
          const code = (error as { code?: string })?.code ?? 'REVIEW_INTERNAL';
          this.deps.logger?.(`[learning] review ${next.id} escaped: ${code} ${error instanceof Error ? error.message : String(error)}`);
          this.deps.store.db
            .prepare("UPDATE learning_reviews SET state = 'failed', errorCode = ?, completedAt = ? WHERE id = ? AND state = 'running'")
            .run(String(code).slice(0, 80), new Date().toISOString(), next.id);
        }
      }
    } finally {
      this.pumping = false;
    }
    // 复盘产物补主档（异步，失败只记日志，SKF 账本不受影响）。
    if (processed > 0) await this.flushVaultCandidates().catch(() => 0);
    return { processed };
  }

  private async runReview(reviewId: string): Promise<void> {
    const row = this.deps.store.db.prepare('SELECT * FROM learning_reviews WHERE id = ?').get(reviewId) as ReviewRow | undefined;
    if (!row) throw new RuntimeError('REVIEW_NOT_FOUND', reviewId);
    const now = new Date();

    // 配额：非显式触发在发模型调用前原子消耗（注册时的检查只是提前挡，泵里才是终裁）。
    if (row.triggerKind !== 'explicit') {
      const exhausted = this.deps.store.transaction(() => {
        const used = consumeAutoQuota(this.deps.store, now);
        if (used > this.policy.dailyAutoLimit) return true;
        return false;
      });
      if (exhausted) {
        this.deps.store.transaction(() => {
          this.deps.store.db
            .prepare("UPDATE learning_reviews SET state = 'skipped', skipReason = 'daily_quota_exhausted', completedAt = ? WHERE id = ?")
            .run(now.toISOString(), reviewId);
          appendEvent(this.deps.store, row.taskId, 'learning.review_skipped', { reviewId, reason: 'daily_quota_exhausted' } as unknown as JSONValue);
        });
        return;
      }
    }

    if (!this.deps.gateway) {
      this.deps.store.transaction(() => {
        this.deps.store.db
          .prepare("UPDATE learning_reviews SET state = 'failed', errorCode = 'BUDGET_UNAVAILABLE', completedAt = ? WHERE id = ?")
          .run(now.toISOString(), reviewId);
        appendEvent(this.deps.store, row.taskId, 'learning.review_failed', { reviewId, errorCode: 'BUDGET_UNAVAILABLE' } as unknown as JSONValue);
      });
      return;
    }

    const snapshot = JSON.parse(row.snapshot) as EvidenceSnapshot;
    let modelCallId: string | null = null;
    let outputText: string;
    try {
      const callTaskId = `learning-review:${reviewId}`;
      modelCallId = `gw:${callTaskId}:1`;
      const result = await this.deps.gateway.completeText({
        taskId: callTaskId,
        purpose: 'review',
        route: this.deps.reviewRoute ?? {},
        system: REVIEW_SYSTEM,
        user: stableStringify(snapshot as unknown as JSONValue),
        turn: 1,
        maxOutputTokens: this.deps.reviewMaxOutputTokens ?? 2000,
        timeoutMs: this.deps.reviewTimeoutMs ?? 120_000,
      });
      outputText = result.text;
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'MODEL_REQUEST_FAILED';
      this.deps.store.transaction(() => {
        this.deps.store.db
          .prepare('UPDATE learning_reviews SET state = ?, errorCode = ?, modelCallId = ?, completedAt = ? WHERE id = ?')
          .run(code === 'DAILY_BUDGET_EXCEEDED' || code === 'TASK_BUDGET_EXCEEDED' ? 'skipped' : 'failed', code, modelCallId, new Date().toISOString(), reviewId);
        if (code === 'DAILY_BUDGET_EXCEEDED' || code === 'TASK_BUDGET_EXCEEDED') {
          this.deps.store.db.prepare("UPDATE learning_reviews SET skipReason = 'budget_exhausted' WHERE id = ?").run(reviewId);
        }
        appendEvent(this.deps.store, row.taskId, 'learning.review_failed', { reviewId, errorCode: code } as unknown as JSONValue);
      });
      return;
    }

    // 解析 + 仲裁 + 证据校验 + 写候选（同事务；复盘产物绝不改变原任务终态）。
    const parsed = parseReviewOutput(outputText);
    let produced = 0;
    let rejected = 0;
    const rejectReasons: string[] = [];
    this.deps.store.transaction(() => {
      for (const raw of parsed.candidates) {
        const outcomes = classifyCandidate(raw);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            rejected++;
            rejectReasons.push(outcome.reason);
            continue;
          }
          if (outcome.status === 'pending') {
            // 类型分歧：落账本 classification_pending（可审计），不注入执行上下文。
            this.insertExperience({
              kind: outcome.kind,
              classification: 'classification_pending',
              classificationReason: outcome.reason,
              text: outcome.text,
              structured: {},
              evidenceRefs: [],
              suggestedCheckpoints: [],
              snapshot,
              reviewId,
            });
            produced++;
            continue;
          }
          const candidate = outcome.candidate;
          const evidenceVerdict = this.validateCandidateEvidence(candidate, snapshot);
          if (evidenceVerdict !== null) {
            rejected++;
            rejectReasons.push(evidenceVerdict);
            continue;
          }
          this.insertExperience({
            kind: candidate.kind,
            classification: candidate.classification,
            classificationReason: candidate.classificationReason,
            text: candidate.text,
            structured: candidate.structured as unknown as Record<string, JSONValue>,
            evidenceRefs: candidate.evidenceRefs,
            suggestedCheckpoints: candidate.suggestedCheckpoints,
            snapshot,
            reviewId,
          });
          produced++;
        }
      }
      this.deps.store.db
        .prepare(
          "UPDATE learning_reviews SET state = 'succeeded', candidatesProduced = ?, candidatesRejected = ?, modelCallId = ?, reviewNotes = ?, completedAt = ? WHERE id = ?",
        )
        .run(produced, rejected, modelCallId, [parsed.reviewNotes, parsed.truncated ? 'truncated_to_3' : '', rejectReasons.slice(0, 6).join(';')].filter(Boolean).join(' | ').slice(0, 1000), new Date().toISOString(), reviewId);
      appendEvent(this.deps.store, row.taskId, 'learning.review_completed', { reviewId, produced, rejected } as unknown as JSONValue);
      if (row.failureSignature) recordSignatureReviewed(this.deps.store, row.failureSignature, row.taskId, now);
    });
  }

  /** 候选证据校验（代码硬规则）：
   *  - evidenceRefs 必须引用快照中真实存在的 op/artifact/event；
   *  - 无 operation 证据禁生成 skill（任务成功 ≠ 经验正确）；
   *  - uncertainExternal 只许 lesson（外部副作用不确定不得产出成功类经验）。 */
  private validateCandidateEvidence(candidate: ClassifiedCandidate, snapshot: EvidenceSnapshot): string | null {
    if (snapshot.uncertainExternal && candidate.kind !== 'lesson') return 'uncertain_external';
    const opIds = new Set(snapshot.operations.map((op) => op.id));
    const artifactPaths = new Set(snapshot.artifacts.map((a) => a.relativePath));
    const eventTypes = new Set(snapshot.events.map((e) => e.type));
    const validRefs: string[] = [];
    for (const ref of candidate.evidenceRefs) {
      const [prefix, ...rest] = ref.split(':');
      const value = rest.join(':');
      if (prefix === 'op' && opIds.has(ref.slice(3))) validRefs.push(ref);
      else if (prefix === 'op' && opIds.has(value)) validRefs.push(ref);
      else if (prefix === 'artifact' && artifactPaths.has(value)) validRefs.push(ref);
      else if (prefix === 'event' && eventTypes.has(value)) validRefs.push(ref);
    }
    candidate.evidenceRefs = validRefs;
    if (candidate.kind === 'skill') {
      if (!snapshot.hasOperationEvidence) return 'no_operation_evidence';
      const hasOpRef = validRefs.some((ref) => ref.startsWith('op:'));
      if (!hasOpRef) return 'no_operation_evidence';
    }
    return null;
  }

  /** 候选落账本 + 主档（trust=candidate 永远；指纹去重合并来源）。 */
  private insertExperience(input: {
    kind: ExperienceKind;
    classification: 'classified' | 'incomplete' | 'classification_pending';
    classificationReason: string;
    text: string;
    structured: Record<string, JSONValue>;
    evidenceRefs: string[];
    suggestedCheckpoints: CheckpointDefinition[];
    snapshot: EvidenceSnapshot;
    reviewId: string;
  }): string {
    const fingerprint = contentFingerprint(input.kind, input.text);
    const now = new Date().toISOString();
    const existing = this.deps.store.db
      .prepare("SELECT id, sourceTaskIds, evidenceRefs FROM learning_experiences WHERE fingerprint = ? AND status IN ('candidate','confirmed')")
      .get(fingerprint) as { id: string; sourceTaskIds: string; evidenceRefs: string } | undefined;
    if (existing) {
      // 内容指纹去重：合并来源任务与证据引用，不重复灌入同一经验。
      const taskIds = new Set(JSON.parse(existing.sourceTaskIds) as string[]);
      taskIds.add(input.snapshot.taskId);
      const refs = new Set(JSON.parse(existing.evidenceRefs) as string[]);
      for (const ref of input.evidenceRefs) refs.add(ref);
      this.deps.store.db
        .prepare('UPDATE learning_experiences SET sourceTaskIds = ?, evidenceRefs = ?, updatedAt = ? WHERE id = ?')
        .run(JSON.stringify([...taskIds].slice(-40)), JSON.stringify([...refs].slice(-40)), now, existing.id);
      return existing.id;
    }

    const id = `exp:${randomUUID()}`;
    // 主档候选记录：trust=candidate（自动复盘永远 candidate），来源指回复盘记录。
    // 主档不可用：memoryRecordId 置 pending 占位（UNIQUE 约束下空串会撞车），候选仍落 SKF 账本，恢复后补写。
    this.deps.store.db
      .prepare(
        `INSERT INTO learning_experiences
           (id, memoryRecordId, revision, contentHash, kind, classification, classificationReason, text, structured,
            checkpoints, enforcement, status, scope, sourceTaskIds, evidenceRefs, reviewId, validUntil, supersedes,
            fingerprint, createdAt, updatedAt, confirmedAt, confirmedBy)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'advisory', 'candidate', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        `pending:${id}`,
        sha256Text(input.text),
        input.kind,
        input.classification,
        input.classificationReason.slice(0, 500),
        input.text,
        stableStringify(input.structured as unknown as JSONValue),
        stableStringify(input.suggestedCheckpoints as unknown as JSONValue),
        input.snapshot.scope,
        JSON.stringify([input.snapshot.taskId]),
        JSON.stringify(input.evidenceRefs),
        input.reviewId,
        fingerprint,
        now,
        now,
      );
    return id;
  }

  /** 主档候选写入（在 SKF 账本事务提交后调用；失败只记日志，经验仍在 SKF 账本）。 */
  private async publishExperienceToVault(experienceId: string): Promise<void> {
    if (!this.deps.memory) return;
    const row = getExperience(this.deps.store, experienceId);
    if (!row || !row.memoryRecordId.startsWith('pending:')) return;
    try {
      const vaultKind = VAULT_KIND_MAP[row.kind as ExperienceKind];
      const result = await this.deps.memory.record(
        {
          kind: vaultKind,
          trust: 'candidate',
          scope: row.scope === 'global' ? 'global' : row.scope,
          text: `[SKF-M13 ${row.kind}] ${row.text}`,
          source: [{ kind: 'tool', locator: `skf-learning:${row.reviewId}` }],
          tags: ['m13', `kind:${row.kind}`, `review:${row.reviewId}`],
        },
        `m13:candidate:${experienceId}:r${row.revision}`,
      );
      this.deps.store.db
        .prepare('UPDATE learning_experiences SET memoryRecordId = ?, updatedAt = ? WHERE id = ?')
        .run(result.id, new Date().toISOString(), experienceId);
    } catch (error) {
      this.deps.logger?.(`[learning] vault candidate write failed for ${experienceId} (SKF ledger intact): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 复盘成功后批量补主档（泵循环末尾调用一次）。 */
  async flushVaultCandidates(limit = 10): Promise<number> {
    const rows = this.deps.store.db
      .prepare("SELECT id FROM learning_experiences WHERE memoryRecordId LIKE 'pending:%' AND status = 'candidate' LIMIT ?")
      .all(limit) as unknown as Array<{ id: string }>;
    for (const row of rows) await this.publishExperienceToVault(row.id);
    return rows.length;
  }

  // ── 人工确认（首版唯一晋级通道）─────────────────────────────

  /**
   * 人工确认：绑定具体 revision/contentHash；内容修改生成新 revision 不继承确认。
   * enforcement='approved_checkpoint' 需显式给出（审核通过检查点可执行/不越权后才允许）。
   */
  async promoteExperience(req: {
    experienceId: string;
    revision: number;
    contentHash: string;
    enforcement?: 'advisory' | 'approved_checkpoint';
    confirmedBy: string;
    reason?: string;
  }): Promise<{ experienceId: string; memoryRecordId: string }> {
    if (!this.enabled) throw new RuntimeError('LEARNING_DISABLED');
    const row = getExperience(this.deps.store, req.experienceId);
    if (!row) throw new RuntimeError('EXPERIENCE_NOT_FOUND', req.experienceId);
    if (row.revision !== req.revision) throw new RuntimeError('EXPERIENCE_REVISION_CONFLICT', `current r${row.revision}`);
    if (row.contentHash !== req.contentHash) throw new RuntimeError('EXPERIENCE_CONTENT_CONFLICT', 'contentHash mismatch');
    if (row.status === 'confirmed') throw new RuntimeError('INVALID_PROMOTION', 'already confirmed');
    if (row.classification === 'classification_pending') throw new RuntimeError('INVALID_PROMOTION', 'classification_pending not promotable');
    if (row.classification === 'incomplete') throw new RuntimeError('INVALID_PROMOTION', 'incomplete skill contract not promotable');
    const enforcement = req.enforcement ?? 'advisory';
    const checkpoints = JSON.parse(row.checkpoints) as CheckpointDefinition[];
    if (enforcement === 'approved_checkpoint') {
      const hard = checkpoints.filter((def) => isHardCheckpoint(checkpointKindOf(def)));
      if (hard.length === 0) throw new RuntimeError('INVALID_PROMOTION', 'no hard checkpoint to approve');
      for (const def of hard) parseCheckpointDefinition(def as unknown as JSONValue); // 复核可执行形状
    }
    // 主档：新记录 trust=user_confirmed（必须 user 来源）；旧 candidate 记录保留可追溯。
    if (!this.deps.memory) throw new RuntimeError('MEMORY_UNAVAILABLE', 'vault required for promotion');
    const vaultKind = VAULT_KIND_MAP[row.kind as ExperienceKind];
    const confirmed = await this.deps.memory.record(
      {
        kind: vaultKind,
        trust: 'user_confirmed',
        scope: row.scope === 'global' ? 'global' : row.scope,
        text: `[SKF-M13 ${row.kind}] ${row.text}`,
        source: [
          { kind: 'user', locator: req.confirmedBy },
          { kind: 'tool', locator: `skf-learning:${row.reviewId}` },
        ],
        tags: ['m13', `kind:${row.kind}`, 'promoted'],
      },
      `m13:promote:${row.id}:r${row.revision}:${sha256Text(req.contentHash).slice(0, 16)}`,
    );
    const now = new Date().toISOString();
    this.deps.store.transaction(() => {
      const result = this.deps.store.db
        .prepare(
          "UPDATE learning_experiences SET status = 'confirmed', enforcement = ?, memoryRecordId = ?, confirmedAt = ?, confirmedBy = ?, updatedAt = ? WHERE id = ? AND status != 'confirmed'",
        )
        .run(enforcement, confirmed.id, now, req.confirmedBy, now, row.id);
      if (Number(result.changes) !== 1) throw new RuntimeError('CONCURRENT_MODIFICATION', row.id);
      const sourceTasks = JSON.parse(row.sourceTaskIds) as string[];
      appendEvent(this.deps.store, sourceTasks[0] ?? row.id, 'learning.experience_promoted', {
        experienceId: row.id,
        revision: row.revision,
        enforcement,
        confirmedBy: req.confirmedBy,
      } as unknown as JSONValue);
    });
    return { experienceId: row.id, memoryRecordId: confirmed.id };
  }

  /** 候选反证 → 旧经验标 disputed 并暂停其硬检查点发布（暂停 ≠ 确认新结论）。 */
  disputeExperience(req: { experienceId: string; reason: string; counterTaskId?: string; by: string }): void {
    if (!this.enabled) throw new RuntimeError('LEARNING_DISABLED');
    const row = getExperience(this.deps.store, req.experienceId);
    if (!row) throw new RuntimeError('EXPERIENCE_NOT_FOUND', req.experienceId);
    const now = new Date().toISOString();
    this.deps.store.transaction(() => {
      this.deps.store.db
        .prepare("UPDATE learning_experiences SET status = 'disputed', updatedAt = ? WHERE id = ?")
        .run(now, row.id);
      // 暂停该经验的一切 pending 硬检查点（已登记任务内的）：标 not_applicable 并注明争议暂停。
      this.deps.store.db
        .prepare(
          "UPDATE learning_task_checkpoints SET state = 'not_applicable', reason = ?, checkedAt = ? WHERE experienceId = ? AND state = 'pending' AND kind IN ('deterministic','evidence')",
        )
        .run(`disputed: ${req.reason.slice(0, 300)}`, now, row.id);
      appendEvent(this.deps.store, req.counterTaskId ?? (JSON.parse(row.sourceTaskIds) as string[])[0] ?? row.id, 'learning.experience_disputed', {
        experienceId: row.id,
        reason: req.reason.slice(0, 500),
        by: req.by,
        counterTaskId: req.counterTaskId ?? null,
      } as unknown as JSONValue);
    });
  }

  /** 内容修改：生成新 revision（status=candidate，不继承旧 revision 的确认状态）。 */
  reviseExperience(req: {
    experienceId: string;
    text: string;
    structured?: Record<string, JSONValue>;
    checkpoints?: CheckpointDefinition[];
    reason: string;
    by: string;
  }): { experienceId: string; revision: number } {
    if (!this.enabled) throw new RuntimeError('LEARNING_DISABLED');
    const row = getExperience(this.deps.store, req.experienceId);
    if (!row) throw new RuntimeError('EXPERIENCE_NOT_FOUND', req.experienceId);
    if (!req.text.trim() || req.text.length > 4000) throw new RuntimeError('INVALID_INPUT', 'text');
    const id = `exp:${randomUUID()}`;
    const now = new Date().toISOString();
    const revision = row.revision + 1;
    this.deps.store.transaction(() => {
      this.deps.store.db
        .prepare(
          `INSERT INTO learning_experiences
             (id, memoryRecordId, revision, contentHash, kind, classification, classificationReason, text, structured,
              checkpoints, enforcement, status, scope, sourceTaskIds, evidenceRefs, reviewId, validUntil, supersedes,
              fingerprint, createdAt, updatedAt, confirmedAt, confirmedBy)
           VALUES (?, '', ?, ?, ?, 'classified', ?, ?, ?, ?, 'advisory', 'candidate', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          revision,
          sha256Text(req.text),
          row.kind,
          `manual revision: ${req.reason.slice(0, 300)}`,
          req.text,
          stableStringify((req.structured ?? JSON.parse(row.structured)) as unknown as JSONValue),
          stableStringify((req.checkpoints ?? JSON.parse(row.checkpoints)) as unknown as JSONValue),
          row.scope,
          row.sourceTaskIds,
          row.evidenceRefs,
          row.reviewId,
          row.id, // supersedes 旧 revision
          contentFingerprint(row.kind as ExperienceKind, req.text),
          now,
          now,
        );
      appendEvent(this.deps.store, (JSON.parse(row.sourceTaskIds) as string[])[0] ?? row.id, 'learning.experience_revised', {
        experienceId: id,
        supersedes: row.id,
        revision,
        by: req.by,
      } as unknown as JSONValue);
    });
    return { experienceId: id, revision };
  }

  // ── 检索注入与检查点（AgentLoop hooks）───────────────────────

  /** prepare 文本段（worker prepareContext 组合用）。 */
  buildBundleText(task: TaskRecord): string {
    if (!this.enabled) return '';
    const goal = goalTextOf(task);
    if (!goal) return '';
    return buildExperienceBundle(this.deps.store, goal, task.scope).bundleText;
  }

  /** 任务规划后登记检查点（幂等：UNIQUE(taskId, experienceId, checkpointIndex)）。
   *  candidate 只进文本参考不登记；confirmed 登记 judgment；approved_checkpoint 追加硬检查点。 */
  registerTaskCheckpoints(task: TaskRecord): void {
    if (!this.enabled) return;
    const goal = goalTextOf(task);
    if (!goal) return;
    const bundle = buildExperienceBundle(this.deps.store, goal, task.scope);
    const now = new Date().toISOString();
    this.deps.store.transaction(() => {
      for (const exp of bundle.experiences) {
        const defs: Array<{ def: CheckpointDefinition; hard: boolean }> = [
          ...judgmentDefs(exp).map((def) => ({ def, hard: false })),
          ...hardCheckpointDefs(exp).map((def) => ({ def, hard: true })),
        ];
        defs.forEach(({ def }, index) => {
          const id = `ckpt:${task.id}:${exp.id}:${index}`;
          this.deps.store.db
            .prepare(
              `INSERT OR IGNORE INTO learning_task_checkpoints
                 (id, taskId, experienceId, experienceRevision, checkpointIndex, kind, definition, state, operationId, reason, checkedAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
            )
            .run(id, task.id, exp.id, exp.revision, index, checkpointKindOf(def), stableStringify(def as unknown as JSONValue));
        });
      }
      if (bundle.experiences.length > 0) {
        appendEvent(this.deps.store, task.id, 'learning.bundle_injected', {
          experiences: bundle.experiences.map((e) => ({ id: e.id, revision: e.revision, status: e.status, enforcement: e.enforcement })),
        } as unknown as JSONValue);
      }
    });
  }

  private taskCheckpoints(taskId: string, kind?: 'deterministic' | 'evidence' | 'judgment'): CheckpointRow[] {
    const rows = kind
      ? this.deps.store.db.prepare('SELECT * FROM learning_task_checkpoints WHERE taskId = ? AND kind = ?').all(taskId, kind)
      : this.deps.store.db.prepare('SELECT * FROM learning_task_checkpoints WHERE taskId = ?').all(taskId);
    return rows as unknown as CheckpointRow[];
  }

  /** 任务内已成功操作的规范化相对路径集合（operations.result 回读；inputHash 含可选字段不可比）。 */
  private succeededOpPaths(taskId: string, toolName: string): Set<string> {
    const rows = this.deps.store.db
      .prepare("SELECT result FROM operations WHERE taskId = ? AND toolName = ? AND state = 'succeeded'")
      .all(taskId, toolName) as unknown as Array<{ result: string | null }>;
    const paths = new Set<string>();
    for (const row of rows) {
      if (!row.result) continue;
      try {
        const parsed = JSON.parse(row.result) as { path?: unknown };
        if (typeof parsed.path === 'string') paths.add(parsed.path);
      } catch {
        // 结果 JSON 损坏的行跳过（不影响其他行判定）
      }
    }
    return paths;
  }

  private setCheckpoint(id: string, state: CheckpointRow['state'], opts: { operationId?: string; reason?: string } = {}): void {
    this.deps.store.db
      .prepare('UPDATE learning_task_checkpoints SET state = ?, operationId = COALESCE(?, operationId), reason = COALESCE(?, reason), checkedAt = ? WHERE id = ? AND state = \'pending\'')
      .run(state, opts.operationId ?? null, opts.reason ?? null, new Date().toISOString(), id);
  }

  /** deterministic guard：工具执行前阻断（AgentLoop executeFresh 内调用）。
   *  返回 blockReason ⇒ 操作失败回灌，模型可纠正；检查点保持 pending。 */
  beforeToolCall(task: TaskRecord, call: ToolCall): { blockReason: string } | null {
    if (!this.enabled) return null;
    for (const ckpt of this.taskCheckpoints(task.id, 'deterministic')) {
      if (ckpt.state !== 'pending') continue;
      const def = JSON.parse(ckpt.definition) as CheckpointDefinition;
      if (def.type !== 'require_prior_read' || call.name !== 'file.write') continue;
      const args = call.arguments as Record<string, JSONValue>;
      if (normalizeRelPath(String(args.path ?? '')) !== normalizeRelPath(def.path)) continue;
      const readDone = this.succeededOpPaths(task.id, 'file.read').has(normalizeRelPath(def.path));
      if (!readDone) {
        return {
          blockReason: `CHECKPOINT_BLOCKED: 经验 ${ckpt.experienceId} 硬检查点 require_prior_read(${def.path})：写前必须先 file.read 该路径`,
        };
      }
    }
    return null;
  }

  /** 工具成功后更新检查点（AgentLoop 成功分支内调用）。
   *  require_post_verify 允许 failed→passed：gate 拦过一次后模型补核验，如实记为通过。 */
  afterToolCall(task: TaskRecord, call: ToolCall, operationId: string, ok: boolean): void {
    if (!this.enabled || !ok) return;
    const args = call.arguments as Record<string, JSONValue>;
    const callPath = normalizeRelPath(String(args.path ?? ''));
    for (const ckpt of this.taskCheckpoints(task.id)) {
      const def = JSON.parse(ckpt.definition) as CheckpointDefinition;
      const defPath = def.type === 'judgment_note' ? '' : normalizeRelPath(def.path);
      if (def.type === 'require_prior_read' && call.name === 'file.write' && callPath === defPath) {
        if (ckpt.state !== 'pending') continue;
        if (this.succeededOpPaths(task.id, 'file.read').has(defPath)) this.setCheckpoint(ckpt.id, 'passed', { operationId });
      } else if (def.type === 'require_post_verify' && (call.name === 'file.stat' || call.name === 'file.read') && callPath === defPath) {
        if (ckpt.state !== 'pending' && ckpt.state !== 'failed') continue;
        if (this.succeededOpPaths(task.id, 'file.write').has(defPath)) {
          this.deps.store.db
            .prepare("UPDATE learning_task_checkpoints SET state = 'passed', operationId = ?, reason = COALESCE(reason, 'verified_after_correction'), checkedAt = ? WHERE id = ? AND state IN ('pending','failed')")
            .run(operationId, new Date().toISOString(), ckpt.id);
        }
      }
    }
  }

  /** 报告成功前的硬检查点终裁：pending 的可判 not_applicable；确属未过的阻断成功。 */
  beforeFinalizeSuccess(task: TaskRecord): { ok: true } | { ok: false; correction: string; reason: string } {
    if (!this.enabled) return { ok: true };
    const blockers: string[] = [];
    for (const ckpt of this.taskCheckpoints(task.id)) {
      if (ckpt.state !== 'pending') {
        if (ckpt.state === 'failed' && isHardCheckpoint(ckpt.kind)) blockers.push(`${ckpt.experienceId}:${ckpt.kind} failed`);
        continue;
      }
      const def = JSON.parse(ckpt.definition) as CheckpointDefinition;
      if (def.type === 'require_prior_read') {
        // 写被 guard 全程阻断 ⇒ 条件未触发 ⇒ not_applicable（阻断本身已防住违规）。
        this.setCheckpoint(ckpt.id, 'not_applicable', { reason: 'no_compliant_write_completed' });
      } else if (def.type === 'require_post_verify') {
        const wrote = this.succeededOpPaths(task.id, 'file.write').has(normalizeRelPath(def.path));
        if (wrote) {
          this.setCheckpoint(ckpt.id, 'failed', { reason: 'write_without_post_verify' });
          blockers.push(`${ckpt.experienceId}: require_post_verify(${def.path}) 写后未核验`);
        } else {
          this.setCheckpoint(ckpt.id, 'not_applicable', { reason: 'no_write_to_path' });
        }
      } else if (def.type === 'judgment_note') {
        // 判断型：解析模型最终汇报的 SKF-JUDGMENT 标记；不阻断成功。
        const finalText = lastAssistantTextOf(this.deps.service, task.id);
        const mark = parseJudgmentMark(finalText, ckpt.experienceId);
        if (mark) {
          this.setCheckpoint(ckpt.id, mark.state, { reason: mark.reason });
        } else {
          this.setCheckpoint(ckpt.id, 'not_applicable', { reason: 'model_no_report' });
        }
      }
    }
    if (blockers.length > 0) {
      return {
        ok: false,
        reason: blockers.join('; ').slice(0, 400),
        correction:
          `获准硬检查点未通过：${blockers.join('；')}。请用可用工具补齐核验（如 file.stat/file.read），然后汇报。` +
          '硬检查点未过不能报告成功。',
      };
    }
    return { ok: true };
  }

  /** 终态证据回流：每条注入经验一条应用记录（同任务重试 UNIQUE 去重，不算多份独立证据）。 */
  private reflowApplications(taskId: string): void {
    const checkpoints = this.taskCheckpoints(taskId);
    if (checkpoints.length === 0) return;
    const task = this.deps.service.getTask(taskId);
    if (!task || (task.state !== 'succeeded' && task.state !== 'failed' && task.state !== 'cancelled')) return;
    const byExperience = new Map<string, CheckpointRow[]>();
    for (const ckpt of checkpoints) {
      // experienceId 本身含冒号（exp:<uuid>），拼接键用最后一段当 revision。
      const key = `${ckpt.experienceId}#${ckpt.experienceRevision}`;
      const list = byExperience.get(key) ?? [];
      list.push(ckpt);
      byExperience.set(key, list);
    }
    const acceptanceOk = task.state === 'succeeded';
    const now = new Date().toISOString();
    this.deps.store.transaction(() => {
      for (const [key, rows] of byExperience) {
        const splitAt = key.lastIndexOf('#');
        const experienceId = key.slice(0, splitAt);
        const revisionText = key.slice(splitAt + 1);
        const summary = rows.map((r) => ({ kind: r.kind, state: r.state, reason: r.reason }));
        const deviations = rows.filter((r) => r.state === 'failed' || (r.state === 'not_applicable' && r.reason && !r.reason.startsWith('no_')));
        this.deps.store.db
          .prepare(
            `INSERT OR IGNORE INTO learning_applications
               (id, experienceId, experienceRevision, taskId, applicability, checkpointsSummary, acceptanceOk, deviations, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `app:${experienceId}:${revisionText}:${taskId}`,
            experienceId,
            Number(revisionText),
            taskId,
            'injected',
            JSON.stringify(summary),
            acceptanceOk ? 1 : 0,
            deviations.length ? JSON.stringify(deviations.map((d) => ({ kind: d.kind, state: d.state, reason: d.reason }))).slice(0, 1000) : null,
            now,
          );
      }
    });
  }

  // ── 查询（IPC）────────────────────────────────────────

  status(): JSONValue {
    const count = (sql: string, ...params: (string | number)[]) =>
      (this.deps.store.db.prepare(sql).get(...params) as { c: number }).c;
    const today = new Date();
    const day = new Date(today.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    const quota = this.deps.store.db.prepare('SELECT autoReviews FROM learning_review_quota WHERE day = ?').get(day) as
      | { autoReviews: number }
      | undefined;
    return {
      enabled: this.enabled,
      reviewerVersion: this.reviewerVersion,
      dailyAutoLimit: this.policy.dailyAutoLimit,
      todayAutoReviews: quota?.autoReviews ?? 0,
      reviews: {
        pending: count("SELECT COUNT(*) c FROM learning_reviews WHERE state = 'pending'"),
        running: count("SELECT COUNT(*) c FROM learning_reviews WHERE state = 'running'"),
        succeeded: count("SELECT COUNT(*) c FROM learning_reviews WHERE state = 'succeeded'"),
        failed: count("SELECT COUNT(*) c FROM learning_reviews WHERE state = 'failed'"),
        skipped: count("SELECT COUNT(*) c FROM learning_reviews WHERE state = 'skipped'"),
      },
      experiences: {
        candidate: count("SELECT COUNT(*) c FROM learning_experiences WHERE status = 'candidate'"),
        confirmed: count("SELECT COUNT(*) c FROM learning_experiences WHERE status = 'confirmed'"),
        disputed: count("SELECT COUNT(*) c FROM learning_experiences WHERE status = 'disputed'"),
      },
      applications: count('SELECT COUNT(*) c FROM learning_applications'),
    } as unknown as JSONValue;
  }

  listReviews(opts: { taskId?: string; limit?: number } = {}): ReviewRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    if (opts.taskId) {
      return this.deps.store.db
        .prepare('SELECT * FROM learning_reviews WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?')
        .all(opts.taskId, limit) as unknown as ReviewRow[];
    }
    return this.deps.store.db
      .prepare('SELECT * FROM learning_reviews ORDER BY createdAt DESC LIMIT ?')
      .all(limit) as unknown as ReviewRow[];
  }
}

// ── 小工具 ─────────────────────────────────────────────

function goalTextOf(task: TaskRecord): string {
  const input = task.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const goal = (input as Record<string, JSONValue>).goal;
    if (typeof goal === 'string' && goal.trim()) return goal;
  }
  return '';
}

function lastAssistantTextOf(service: TaskService, taskId: string): string {
  const row = service.store.db
    .prepare("SELECT content FROM messages WHERE taskId = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1")
    .get(taskId) as { content: string } | undefined;
  return row?.content ?? '';
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

const JUDGMENT_RE = /SKF-JUDGMENT:\s*(\S+)\s+(adopted|not_applicable|deviated)\s*:?\s*([^\n]*)/g;

function parseJudgmentMark(text: string, experienceId: string): { state: 'passed' | 'failed' | 'not_applicable'; reason: string } | null {
  JUDGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JUDGMENT_RE.exec(text)) !== null) {
    if (match[1] !== experienceId) continue;
    const verdict = match[2];
    const reason = (match[3] ?? '').trim().slice(0, 300);
    if (verdict === 'adopted') return { state: 'passed', reason: reason || 'model_reported_adopted' };
    if (verdict === 'not_applicable') return { state: 'not_applicable', reason: reason || 'model_reported_na' };
    // deviated：模型自行偏离 ⇒ 记录 failed（waived 只能走人工授权，模型不能自我豁免）。
    return { state: 'failed', reason: reason || 'model_reported_deviation' };
  }
  return null;
}

export { MAX_CANDIDATES_PER_REVIEW };
