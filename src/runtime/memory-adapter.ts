/**
 * MemoryAdapter — SKF 接入SKF统一记忆主档（D:/Xiaoliu-Memory/vault）的唯一入口。
 *
 * - 只通过 vendored runtime 的 integration.run() 调用，不暴露 raw SQL。
 * - 主档根目录由配置指定；默认不写安装目录，也不复制另一份真源。
 * - 写回失败进入本地 outbox（SKF_DATA_DIR/memory-outbox），下次 prepare 前幂等重放。
 * - 主档不可用时抛出带 code 的 MemoryError，由调用方进入「有意识无记忆模式」，
 *   绝不回退旧 L1-L5 冒充连续记忆。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 这些 code 来自已审查 runtime，属于可预期的业务错误，原样透传。 */
const KNOWN_CODES = new Set([
  'QUERY_REQUIRED', 'INVALID_CONTEXT_BUDGET', 'MANDATORY_CONTEXT_TOO_LARGE',
  'CONTEXT_BUDGET_INVARIANT_FAILED', 'IDEMPOTENCY_CONFLICT', 'CLOSE_OPERATION_ID_REQUIRED',
  'INVALID_RECORD', 'SOURCE_REQUIRED', 'USER_EVIDENCE_REQUIRED', 'TOOL_EVIDENCE_REQUIRED',
  'PIN_REQUIRES_EVIDENCE', 'SUPERSEDES_TARGET_NOT_ACTIVE', 'INVALID_CONFIDENCE',
  'INVALID_TASK', 'DONE_REQUIRES_EVIDENCE', 'SESSION_SUMMARY_REQUIRED',
  'ARCHIVE_PROTECTED_OR_INVALID', 'ARCHIVE_CHANGED', 'ARCHIVE_OPERATION_ID_REQUIRED',
  'NOT_ARCHIVED', 'RESTORE_CONFLICT', 'INVALID_OPERATION_KEY', 'UNSUPPORTED_SCHEMA',
  'IMPORT_CHECKSUM_FAILED', 'IMPORT_ASSET_INVALID', 'RESTORE_REQUIRES_EMPTY_VAULT',
  'AUDIT_CHAIN_INVALID', 'DATABASE_INTEGRITY_FAILED', 'UNKNOWN_INTEGRATION_COMMAND',
  'EXPLICIT_RETRY_IDS_REQUIRED', 'RETRY_REQUIRES_FAILED_JOB',
]);

export class MemoryError extends Error {
  code: string;
  constructor(code: string, cause?: unknown) {
    super(code);
    this.code = code;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

export interface MemoryAdapterOptions {
  /** 主档 vault 根目录（用户数据，独立配置，不写安装目录）。 */
  root: string;
  /** 检索/写入 scope，例如 'skf'、'client:xx'、'global'。 */
  scope: string;
  /** 稳定 sessionId；恢复原任务时必须沿用原 sessionId。 */
  sessionId: string;
  /** vendored runtime 目录（包内代码，不含用户数据）。 */
  vendorDir: string;
  /** 本地写回 outbox（SKF_DATA_DIR 下），与主档分离。 */
  outboxDir: string;
  /** 本地 bge-m3 语义检索；false 时只用关键词（测试/无嵌入服务时）。 */
  semantic?: boolean;
  /** prepare 输入预算（UTF-8 字节上限，不是 provider token）。 */
  maxInputBytes?: number;
}

export interface PrepareRequest {
  requestId: string;
  query: string;
  system?: string;
  recent?: Array<{ role: string; content: string }>;
  /** M23 多会话隔离：缺省用 adapter 配置的全局 scope/sessionId。 */
  scope?: string;
  sessionId?: string;
}

export interface CloseRequest {
  /** 稳定幂等键，例如 `${sessionId}:close:${taskId}`；同 ID 不同内容会被拒绝。 */
  operationId: string;
  summary: string;
  decisions?: string[];
  pending?: string[];
  constraints?: string[];
  memories?: unknown[];
  tasks?: unknown[];
  /** M23 多会话隔离：缺省用 adapter 配置的全局 scope/sessionId。 */
  scope?: string;
  sessionId?: string;
}

export interface PrepareResult {
  prepared: any;
  /** 本次调用前 outbox 重放结果；failed 非空表示有待补写回。 */
  outbox: { replayed: number; failed: string[] };
}

type RunFn = (command: string, input?: any, options?: { root?: string; workspace?: string }) => Promise<any>;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export class MemoryAdapter {
  readonly root: string;
  readonly scope: string;
  readonly sessionId: string;
  readonly vendorDir: string;
  readonly outboxDir: string;
  readonly semantic: boolean;
  readonly maxInputBytes: number;
  private runFn: RunFn | null = null;
  private initError: unknown = null;
  /** 最近一次 prepare 的完整返回，供 /context 报告使用。 */
  lastPrepare: any = null;
  lastOutbox: { replayed: number; failed: string[] } = { replayed: 0, failed: [] };

  constructor(opts: MemoryAdapterOptions) {
    this.root = resolve(opts.root);
    this.scope = opts.scope;
    this.sessionId = opts.sessionId;
    this.vendorDir = resolve(opts.vendorDir);
    this.outboxDir = resolve(opts.outboxDir);
    this.semantic = opts.semantic !== false;
    this.maxInputBytes = opts.maxInputBytes ?? 18000;
  }

  /** 验证 vendored runtime 可加载且主档可打开。失败进入降级（prepare/close 会抛 MEMORY_UNAVAILABLE）。 */
  async init(): Promise<void> {
    try {
      const run = await this.loadRuntime();
      await run('status', {}, { root: this.root });
    } catch (err) {
      this.initError = err;
    }
  }

  get available(): boolean {
    return this.initError === null;
  }

  private async loadRuntime(): Promise<RunFn> {
    if (this.runFn) return this.runFn;
    if (this.initError) throw new MemoryError('MEMORY_UNAVAILABLE', this.initError);
    const entry = join(this.vendorDir, 'integration.mjs');
    if (!existsSync(entry)) throw new MemoryError('MEMORY_UNAVAILABLE', 'vendored runtime missing: ' + entry);
    try {
      const mod = (await import(pathToFileURL(entry).href)) as { run: RunFn };
      this.runFn = mod.run;
      return this.runFn;
    } catch (err) {
      // node:sqlite 需要 Node 24+；旧版本会在这里失败。
      this.initError = err;
      throw new MemoryError('MEMORY_UNAVAILABLE', err);
    }
  }

  private async run(command: string, input: any = {}): Promise<any> {
    const run = await this.loadRuntime();
    try {
      const envelope = await run(command, input, { root: this.root });
      if (!envelope?.ok) throw new MemoryError('MEMORY_UNAVAILABLE', envelope);
      return envelope;
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (KNOWN_CODES.has(message)) throw new MemoryError(message, err);
      throw new MemoryError('MEMORY_UNAVAILABLE', err);
    }
  }

  /** 重放本地 outbox 中未提交的写回；幂等（同 operationId 同内容直接返回缓存结果）。 */
  private async replayOutbox(): Promise<{ replayed: number; failed: string[] }> {
    const report = { replayed: 0, failed: [] as string[] };
    if (!existsSync(this.outboxDir)) return report;
    for (const name of readdirSync(this.outboxDir).filter((n) => n.endsWith('.pending.json')).sort()) {
      const file = join(this.outboxDir, name);
      try {
        const input = JSON.parse(readFileSync(file, 'utf8'));
        const run = await this.loadRuntime();
        await run('close', input, { root: this.root });
        renameSync(file, file.replace('.pending.json', '.done.json'));
        report.replayed++;
      } catch (err) {
        report.failed.push(name + ': ' + (err instanceof Error ? err.message : String(err)));
      }
    }
    return report;
  }

  async prepare(req: PrepareRequest): Promise<PrepareResult> {
    const outbox = await this.replayOutbox();
    this.lastOutbox = outbox;
    const envelope = await this.run('prepare', {
      requestId: req.requestId,
      sessionId: req.sessionId ?? this.sessionId,
      scope: req.scope ?? this.scope,
      query: req.query,
      system: req.system ?? '',
      recent: (req.recent ?? []).slice(-8),
      maxInputBytes: this.maxInputBytes,
      semantic: this.semantic,
    });
    this.lastPrepare = envelope.result;
    return { prepared: envelope.result, outbox };
  }

  /** 写回会话结果。失败时落本地 outbox 并抛 MEMORY_WRITEBACK_QUEUED。 */
  async close(req: CloseRequest): Promise<any> {
    const input = {
      operationId: req.operationId,
      sessionId: req.sessionId ?? this.sessionId,
      scope: req.scope ?? this.scope,
      summary: req.summary,
      decisions: req.decisions ?? [],
      pending: req.pending ?? [],
      constraints: req.constraints ?? [],
      memories: req.memories ?? [],
      tasks: req.tasks ?? [],
      semantic: this.semantic,
    };
    try {
      const envelope = await this.run('close', input);
      return envelope.result;
    } catch (err) {
      // 业务性拒绝（幂等冲突、校验失败等）是确定结果，直接抛出，不进 outbox。
      if (err instanceof MemoryError && err.code !== 'MEMORY_UNAVAILABLE') throw err;
      // 主档整体不可用：本地 outbox 排队，下次 prepare 重放。
      // 已提交后被投影/索引失败打断的情况由主档 writeback-queue 自愈。
      mkdirSync(this.outboxDir, { recursive: true });
      const file = join(this.outboxDir, sha256(req.operationId) + '.pending.json');
      if (!existsSync(file)) {
        writeFileSync(file + '.tmp', JSON.stringify(input, null, 2), { encoding: 'utf8', flush: true });
        renameSync(file + '.tmp', file);
      }
      throw new MemoryError('MEMORY_WRITEBACK_QUEUED', err);
    }
  }

  async search(query: string, opts: { limit?: number; includeArchived?: boolean; scope?: string } = {}): Promise<any> {
    const envelope = await this.run('search', {
      query,
      scope: opts.scope ?? this.scope,
      limit: opts.limit ?? 12,
      includeArchived: opts.includeArchived === true,
      semantic: this.semantic,
    });
    return envelope.result;
  }

  async get(id: string): Promise<any> {
    const envelope = await this.run('get', { id });
    return envelope.result;
  }

  async status(): Promise<any> {
    const envelope = await this.run('status');
    return envelope.result;
  }

  async verify(): Promise<any> {
    const envelope = await this.run('verify');
    return envelope.result;
  }

  /** 老化建议（只提案，不自动归档）。 */
  async maintain(): Promise<any> {
    const envelope = await this.run('maintain');
    return envelope.result;
  }

  async record(input: Record<string, unknown>, operationId: string): Promise<any> {
    const envelope = await this.run('record', { ...input, scope: input.scope ?? this.scope, operationId });
    return envelope.result;
  }

  /** 记录一轮对话为 episode（legacy trust，不冒充已确认事实）。 */
  async recordEpisode(text: string, turnTag: string, scope?: string): Promise<any> {
    return this.record(
      {
        kind: 'episode',
        trust: 'legacy',
        text,
        ...(scope !== undefined ? { scope } : {}),
        source: [{ kind: 'session_note', locator: 'session:' + this.sessionId }],
        tags: ['skf-turn', turnTag],
      },
      `${this.sessionId}:episode:${sha256(text).slice(0, 24)}`,
    );
  }

  /**
   * 用户更正：新记录 + 旧记录归档（带 slot 的记录走原生 supersedes 原子路径）。
   * 新记录 trust=user_confirmed，必须带 user 来源；本方法只验证结构，证据真实性由调用方负责。
   */
  async correct(opts: { id: string; text: string; reason: string; userLocator: string }): Promise<any> {
    const existing = await this.get(opts.id);
    if (!existing) throw new MemoryError('NOT_ARCHIVED'); // 目标不存在
    const base = {
      kind: existing.kind,
      scope: existing.scope,
      slot: existing.slot ?? undefined,
      trust: 'user_confirmed' as const,
      text: opts.text,
      source: [{ kind: 'user', locator: opts.userLocator }],
      tags: existing.tags ?? [],
    };
    if (existing.slot) {
      // 有 slot：原生原子更正（同事务 supersede + 新记录）。
      return this.record(
        { ...base, supersedes: existing.id, reason: opts.reason },
        `${this.sessionId}:correct:${existing.id}:${sha256(opts.text).slice(0, 16)}`,
      );
    }
    // 无 slot：先写新记录，再把旧记录归档并注明更正关系。
    const created = await this.record(base, `${this.sessionId}:correct-new:${existing.id}:${sha256(opts.text).slice(0, 16)}`);
    await this.archive([existing.id], {
      dryRun: false,
      reason: `corrected-by:${created.id} reason:${opts.reason}`,
      operationId: `${this.sessionId}:correct-archive:${existing.id}:${String(created.id).slice(0, 8)}`,
    });
    return { ...created, corrected: existing.id };
  }

  async archive(ids: string[], opts: { dryRun: boolean; reason?: string; operationId?: string }): Promise<any> {
    const envelope = await this.run('archive', {
      ids,
      dryRun: opts.dryRun,
      reason: opts.reason,
      operationId: opts.operationId,
    });
    return envelope.result;
  }

  async restore(id: string): Promise<any> {
    const envelope = await this.run('restore', { id, operationId: `${this.sessionId}:restore:${id}` });
    return envelope.result;
  }

  /**
   * M10：主档只读快照备份（VACUUM INTO）。目标路径只能由后端生成
   * （SKF_DATA_DIR/backups/ 下带时间戳），UI/模型都不可指定路径。
   */
  async backup(): Promise<any> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = join(this.outboxDir, '..', 'backups');
    mkdirSync(dir, { recursive: true });
    let file = join(dir, `memory-${stamp}.sqlite`);
    if (existsSync(file)) file = join(dir, `memory-${stamp}-${sha256(String(Date.now())).slice(0, 8)}.sqlite`);
    const envelope = await this.run('backup', { file });
    return { ...envelope.result, file };
  }
}
