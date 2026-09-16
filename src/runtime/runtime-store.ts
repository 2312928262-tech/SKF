import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RuntimeError } from './contracts.js';

/**
 * M03 · runtime.sqlite 存储层。
 * WAL / busy_timeout / synchronous=FULL；schema 只经 migration_versions 显式版本迁移，
 * 初始化与每次升级各自在单事务内完成，失败整体回滚，不允许半建 schema 标成功。
 * 旧版本二进制遇到更高版本库直接拒绝（DB_SCHEMA_TOO_NEW），不写新 schema。
 */

const LATEST_VERSION = 7;

/** v2（M06）：model_calls 金额口径 —— currency + 预留时的价目快照（tariff JSON）。 */
const MIGRATION_V2 = `
ALTER TABLE model_calls ADD COLUMN currency TEXT;
ALTER TABLE model_calls ADD COLUMN tariff TEXT;
`;

/** v3（M15）：持久调度 —— schedules + schedule_firings。
 * - 主键 = cron:<sid>:<generation>:<scheduledAtUtc> 计划时刻（UTC）唯一，跨重启 exactly-once。
 * - generation 随 schedule update 自增；旧 generation 的 firing 仍按唯一键保留，不被新 generation 顶掉。
 * - enabled=0 的 schedule 不触发（dispatcher 会按策略标 skipped），但 firings 历史保留。
 * - scheduledEffect 仅声明 cron 任务的默认 effect；E/P 副作用仍走 M14 tool approval 双层门。
 */
const MIGRATION_V3 = `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cronExpr TEXT NOT NULL,
  timezone TEXT NOT NULL,
  input TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  scope TEXT NOT NULL,
  workspaceRoot TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  generation INTEGER NOT NULL DEFAULT 1,
  missedStrategy TEXT NOT NULL DEFAULT 'latest' CHECK(missedStrategy IN ('skip','latest','bounded_all')),
  missedBound INTEGER NOT NULL DEFAULT 8,
  scheduledEffect TEXT NOT NULL DEFAULT 'workspace_write' CHECK(scheduledEffect IN ('read','workspace_write','external_write','process')),
  firingApprovalTtlMs INTEGER NOT NULL DEFAULT 1800000,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE schedule_firings (
  id TEXT PRIMARY KEY,
  scheduleId TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  scheduledAtUtc TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatched','skipped','awaiting_approval','dispatched_failed','manual_resolved')),
  taskId TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  errorCode TEXT,
  decidedAt TEXT,
  firedAtUtc TEXT,
  completedAtUtc TEXT,
  missedReason TEXT,
  UNIQUE (scheduleId, generation, scheduledAtUtc)
);
CREATE INDEX schedule_firings_due ON schedule_firings(state, scheduledAtUtc);
`;

/** v4（M13）：学习闭环（影子模式）。
 * - learning_reviews：复盘队列即本表；幂等键 (taskId, evidenceSnapshotHash, reviewerVersion) 唯一，
 *   重复终态通知/worker 崩溃/outbox 重投都不会生成重复复盘。
 * - learning_experiences：SKF 侧执行元数据（kind/检查点/enforcement/证据引用）；
 *   信任权威仍在主档 records.trust（candidate 自动复盘永远 candidate；confirmed 只经人工确认）。
 * - learning_task_checkpoints：任务级检查点登记（revision 快照固定，可复现）；
 *   硬检查点状态由运行时确认，模型自报无效。
 * - learning_applications：经验应用证据回流（同任务重试不算多份独立证据，UNIQUE 兜底）。
 * - learning_review_quota：每日自动复盘独立限额（Asia/Shanghai 日界），与前台预算分离。
 */
const MIGRATION_V4 = `
CREATE TABLE learning_reviews (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  evidenceSnapshotHash TEXT NOT NULL,
  reviewerVersion TEXT NOT NULL,
  triggerKind TEXT NOT NULL CHECK(triggerKind IN ('first_failure_signature','recovery_anomaly','acceptance_failure','repeated_failure','success_sample','explicit')),
  state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','skipped')),
  skipReason TEXT,
  snapshot TEXT NOT NULL,
  failureSignature TEXT,
  candidatesProduced INTEGER NOT NULL DEFAULT 0,
  candidatesRejected INTEGER NOT NULL DEFAULT 0,
  modelCallId TEXT,
  reviewNotes TEXT,
  createdAt TEXT NOT NULL,
  completedAt TEXT,
  errorCode TEXT,
  UNIQUE (taskId, evidenceSnapshotHash, reviewerVersion)
);
CREATE INDEX learning_reviews_state ON learning_reviews(state, createdAt);
CREATE TABLE learning_failure_signatures (
  signature TEXT PRIMARY KEY,
  firstTaskId TEXT NOT NULL,
  sampleTaskIds TEXT NOT NULL,
  windowStartUtc TEXT NOT NULL,
  lastReviewedAt TEXT,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE learning_experiences (
  id TEXT PRIMARY KEY,
  memoryRecordId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  contentHash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('skill','lesson','fact')),
  classification TEXT NOT NULL CHECK(classification IN ('classified','incomplete','classification_pending')),
  classificationReason TEXT,
  text TEXT NOT NULL,
  structured TEXT NOT NULL,
  checkpoints TEXT NOT NULL,
  enforcement TEXT NOT NULL DEFAULT 'advisory' CHECK(enforcement IN ('advisory','approved_checkpoint')),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','confirmed','disputed','deprecated')),
  scope TEXT NOT NULL,
  sourceTaskIds TEXT NOT NULL,
  evidenceRefs TEXT NOT NULL,
  reviewId TEXT NOT NULL,
  validUntil TEXT,
  supersedes TEXT,
  fingerprint TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  confirmedAt TEXT,
  confirmedBy TEXT,
  UNIQUE (memoryRecordId, revision)
);
CREATE INDEX learning_experiences_status ON learning_experiences(status, kind);
CREATE INDEX learning_experiences_fingerprint ON learning_experiences(fingerprint, status);
CREATE TABLE learning_task_checkpoints (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  experienceId TEXT NOT NULL REFERENCES learning_experiences(id),
  experienceRevision INTEGER NOT NULL,
  checkpointIndex INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('deterministic','evidence','judgment')),
  definition TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','passed','failed','not_applicable','waived')),
  operationId TEXT,
  reason TEXT,
  checkedAt TEXT,
  UNIQUE (taskId, experienceId, checkpointIndex)
);
CREATE INDEX learning_task_checkpoints_task ON learning_task_checkpoints(taskId, state);
CREATE TABLE learning_applications (
  id TEXT PRIMARY KEY,
  experienceId TEXT NOT NULL,
  experienceRevision INTEGER NOT NULL,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  applicability TEXT NOT NULL,
  checkpointsSummary TEXT NOT NULL,
  acceptanceOk INTEGER,
  deviations TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (experienceId, experienceRevision, taskId)
);
CREATE TABLE learning_review_quota (
  day TEXT PRIMARY KEY,
  autoReviews INTEGER NOT NULL DEFAULT 0
);
`;

/** v5（M18）：GUI 有限交互执行计划（gui-interact.md 8 状态机 + 派发屏障）。
 * - execution_plans：prepare 后持久化的不可变计划；审批/执行/取消/对账全部走本表。
 * - 派发屏障 perStepBarrier = JSON [ {stepId, state} ]，每步 PENDING→DISPATCH_RESERVED→CALL_RETURNED→POST_VERIFIED。
 * - 审批 hash = approvalHash；消费后写 consumedBy（防重放）；窗口指纹 windowFingerprint 变化即停。
 * - 与 M07 恢复契约接轨：执行中崩溃后 state=RUNNING + currentStepIndex，恢复时按派发屏障判定 UNKNOWN。
 */
const MIGRATION_V5 = `
CREATE TABLE execution_plans (
  planId TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  workspaceRoot TEXT NOT NULL,
  windowFingerprint TEXT NOT NULL,
  adapterId TEXT NOT NULL,
  adapterVersion TEXT NOT NULL,
  stepsJson TEXT NOT NULL,
  approvalHash TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('read','low','standard','publish')),
  containsPublish INTEGER NOT NULL DEFAULT 0 CHECK(containsPublish IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','AWAITING_APPROVAL','APPROVED','RUNNING','SUCCEEDED','STOPPED_CHANGED','EXPIRED','CANCELLED','FAILED_NOT_DISPATCHED','FAILED_VERIFIED','UNKNOWN','RECOVERY_REQUIRED')),
  currentStepIndex INTEGER NOT NULL DEFAULT 0,
  perStepBarrier TEXT NOT NULL DEFAULT '[]',
  nonce TEXT NOT NULL,
  displaySummary TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  consumedBy TEXT,
  updatedAt TEXT NOT NULL
);
CREATE INDEX execution_plans_task ON execution_plans(taskId);
`;

/** v6（M23）：多会话 —— sessions 表。
 * - scope 全局唯一，重命名/归档不改 scope；归档只改可见性，不删历史/不取消任务。
 * - 默认会话由 SessionService 惰性引导（id=默认 sessionId、scope=默认 memory scope），
 *   保证旧聊天任务（scope/sessionId 沿用历史约定）自然归属默认会话。
 */
const MIGRATION_V6 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastMessageAt TEXT
);
CREATE INDEX sessions_archived_last ON sessions(archived, lastMessageAt);
`;

/** v7（M02-fix）：推理模型 reasoning_content 持久化。
 * deepseek-v4-pro/kimi-k3 为 thinking 模式，多轮工具对话必须把 assistant 上一轮的
 * reasoning_content 原样传回，否则 400。此前只存 content+tool_calls 会丢推理链，
 * 跨重启重放历史时必然失败；本列让 reasoning_content 与消息同生命周期落库。
 */
const MIGRATION_V7 = `
ALTER TABLE messages ADD COLUMN reasoningContent TEXT;
`;

const MIGRATION_V1 = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  inputHash TEXT NOT NULL,
  input TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  scope TEXT NOT NULL,
  workspaceRoot TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_approval','waiting_provider','cancelling','cancelled','succeeded','failed','interrupted')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  acceptance TEXT,
  revision INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  errorCode TEXT
);
CREATE TABLE messages (
  taskId TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  toolCalls TEXT,
  toolCallId TEXT,
  name TEXT,
  PRIMARY KEY (taskId, seq)
);
CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  stepIndex INTEGER NOT NULL,
  phase TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
  requestHash TEXT,
  providerCallId TEXT,
  UNIQUE (taskId, stepIndex)
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  stepId TEXT REFERENCES steps(id),
  callId TEXT NOT NULL,
  toolName TEXT NOT NULL,
  inputHash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','running','succeeded','failed','unknown')),
  result TEXT,
  startedAt TEXT,
  completedAt TEXT,
  UNIQUE (taskId, callId)
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  operationId TEXT REFERENCES operations(id),
  relativePath TEXT NOT NULL,
  byteLength INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  verifiedAt TEXT
);
CREATE TABLE events (
  eventSeq INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId TEXT NOT NULL,
  type TEXT NOT NULL,
  safePayload TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX events_task ON events(taskId, eventSeq);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  operationId TEXT REFERENCES operations(id),
  inputHash TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('read','workspace_write','external_write','process')),
  decision TEXT NOT NULL CHECK(decision IN ('pending','approved','rejected','expired')),
  reason TEXT,
  expiresAt TEXT NOT NULL,
  decidedAt TEXT
);
CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('chat','planning','summary','extraction','review')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','settled','uncertain','failed')),
  reservedCostMicros INTEGER,
  settledCostMicros INTEGER,
  usage TEXT,
  tariffVersion TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE leases (
  name TEXT PRIMARY KEY,
  ownerInstanceId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  fencingToken INTEGER NOT NULL
);
`;

export class RuntimeStore {
  readonly db: DatabaseSync;
  readonly path: string;
  private inTransaction = false;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    try {
      this.migrate();
    } catch (error) {
      // 构造失败（如 DB_SCHEMA_TOO_NEW）必须释放句柄，否则调用方无法清理文件。
      this.db.close();
      throw error;
    }
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private closed = false;

  /** 当前库 schema 版本（migration_versions MAX）；恢复预检与证据导出用。 */
  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM migration_versions').get() as { v: number | null };
    return row.v ?? 0;
  }

  private migrate() {
    const hasTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_versions'")
      .get();
    if (hasTable) {
      const row = this.db.prepare('SELECT MAX(version) AS v FROM migration_versions').get() as { v: number | null };
      const current = row.v ?? 0;
      if (current > LATEST_VERSION) {
        throw new RuntimeError('DB_SCHEMA_TOO_NEW', `db v${current} > supported v${LATEST_VERSION}`);
      }
      if (current === LATEST_VERSION) return;
    }
    this.transaction(() => {
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS migration_versions (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)',
      );
      const row = this.db.prepare('SELECT MAX(version) AS v FROM migration_versions').get() as { v: number | null };
      const current = row.v ?? 0;
      if (current > LATEST_VERSION) {
        throw new RuntimeError('DB_SCHEMA_TOO_NEW', `db v${current} > supported v${LATEST_VERSION}`);
      }
      if (current < 1) {
        this.db.exec(MIGRATION_V1);
        this.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (1, ?)').run(new Date().toISOString());
      }
      if (current < 2) {
        this.db.exec(MIGRATION_V2);
        this.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (2, ?)').run(new Date().toISOString());
      }
      if (current < 3) {
        this.db.exec(MIGRATION_V3);
        this.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (3, ?)').run(new Date().toISOString());
      }
      if (current < 4) {
        this.db.exec(MIGRATION_V4);
        this.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (4, ?)').run(new Date().toISOString());
      }
      if (current < 5) {
        this.db.exec(MIGRATION_V5);
        this.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (5, ?)').run(new Date().toISOString());
      }
      if (current < 6) {
        this.db.exec(MIGRATION_V6);
        this.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (6, ?)').run(new Date().toISOString());
      }
      if (current < 7) {
        this.db.exec(MIGRATION_V7);
        this.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (7, ?)').run(new Date().toISOString());
      }
    });
  }

  /** 单事务执行；嵌套调用直接复用外层事务。任何异常整体回滚，不留半个事件。 */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败时保留原始错误
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
}
