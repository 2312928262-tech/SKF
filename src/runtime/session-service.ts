import { randomUUID } from 'node:crypto';
import { RuntimeError, nowIso } from './contracts.js';
import type { RuntimeStore } from './runtime-store.js';

/**
 * M23 · 会话持久层：多会话 CRUD 与隔离边界。
 *
 * - 每个会话有独立 id + scope；scope 由后端生成（绝不从 name 派生），重命名不改 scope。
 * - 归档只改可见性（archived=1），不删历史、不取消在途任务、不清记忆。
 * - 默认会话由 ensureDefault 惰性引导（id=默认 sessionId、scope=默认 memory scope），
 *   让旧聊天任务（沿用历史 sessionId/scope 约定）自然归属默认会话，不产生孤儿历史。
 */

const ID_PATTERN = /^[^\x00-\x1f\\/]{1,256}$/;
const SCOPE_PATTERN = /^[^\x00-\x1f\\/]{1,256}$/;

export interface SessionRecord {
  id: string;
  name: string;
  scope: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

interface SessionRow {
  id: string;
  name: string;
  scope: string;
  archived: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    archived: row.archived === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
  };
}

function requireName(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new RuntimeError('INVALID_INPUT', 'session name must be 1..256 chars');
  }
}

export class SessionService {
  constructor(readonly store: RuntimeStore) {}

  private getRow(id: string): SessionRow | undefined {
    return this.store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  }

  /** 惰性引导默认会话：不存在则创建（幂等）。 */
  ensureDefault(id: string, scope: string, name = '默认会话'): SessionRecord {
    if (!ID_PATTERN.test(id)) throw new RuntimeError('INVALID_INPUT', 'default session id');
    if (!SCOPE_PATTERN.test(scope)) throw new RuntimeError('INVALID_INPUT', 'default session scope');
    const existing = this.getRow(id);
    if (existing) return toSessionRecord(existing);
    return this.createSession({ id, name, scope });
  }

  /**
   * 创建会话。id/scope 可选（缺省由后端生成：id=session-<uuid>、scope=skf:session:<id>）。
   * 同 id 同 (name, scope) 幂等返回原记录；同 id 改内容拒绝（与任务幂等语义一致）。
   */
  createSession(req: { id?: string; name: string; scope?: string }): SessionRecord {
    requireName(req.name);
    const id = req.id ?? `session-${randomUUID()}`;
    if (!ID_PATTERN.test(id)) throw new RuntimeError('INVALID_INPUT', 'session id');
    const scope = req.scope ?? `skf:session:${id}`;
    if (!SCOPE_PATTERN.test(scope)) throw new RuntimeError('INVALID_INPUT', 'session scope');
    const name = req.name.trim();
    return this.store.transaction(() => {
      const existing = this.getRow(id);
      if (existing) {
        if (existing.scope === scope && existing.name === name) return toSessionRecord(existing);
        throw new RuntimeError('SESSION_EXISTS', id);
      }
      const scopeClash = this.store.db.prepare('SELECT id FROM sessions WHERE scope = ?').get(scope) as { id: string } | undefined;
      if (scopeClash) throw new RuntimeError('SESSION_EXISTS', `scope ${scope} already used by ${scopeClash.id}`);
      const now = nowIso();
      this.store.db
        .prepare('INSERT INTO sessions (id, name, scope, archived, createdAt, updatedAt, lastMessageAt) VALUES (?, ?, ?, 0, ?, ?, NULL)')
        .run(id, name, scope, now, now);
      return toSessionRecord(this.getRow(id)!);
    });
  }

  listSessions(opts: { archived?: boolean; limit?: number } = {}): SessionRecord[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
    const rows = (
      opts.archived === undefined
        ? this.store.db.prepare('SELECT * FROM sessions ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, createdAt DESC LIMIT ?').all(limit)
        : this.store.db.prepare('SELECT * FROM sessions WHERE archived = ? ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, createdAt DESC LIMIT ?').all(opts.archived ? 1 : 0, limit)
    ) as unknown as SessionRow[];
    return rows.map(toSessionRecord);
  }

  getSession(id: string): SessionRecord | null {
    const row = this.getRow(id);
    return row ? toSessionRecord(row) : null;
  }

  getSessionByScope(scope: string): SessionRecord | null {
    const row = this.store.db.prepare('SELECT * FROM sessions WHERE scope = ?').get(scope) as unknown as SessionRow | undefined;
    return row ? toSessionRecord(row) : null;
  }

  /** 重命名：只改 name 与 updatedAt，scope 不变。 */
  renameSession(id: string, name: string): SessionRecord {
    requireName(name);
    const clean = name.trim();
    return this.store.transaction(() => {
      const row = this.getRow(id);
      if (!row) throw new RuntimeError('SESSION_NOT_FOUND', id);
      this.store.db.prepare('UPDATE sessions SET name = ?, updatedAt = ? WHERE id = ?').run(clean, nowIso(), id);
      return toSessionRecord(this.getRow(id)!);
    });
  }

  /** 归档/恢复：只改可见性；不删历史、不取消任务、不改 scope。 */
  setArchived(id: string, archived: boolean): SessionRecord {
    return this.store.transaction(() => {
      const row = this.getRow(id);
      if (!row) throw new RuntimeError('SESSION_NOT_FOUND', id);
      this.store.db.prepare('UPDATE sessions SET archived = ?, updatedAt = ? WHERE id = ?').run(archived ? 1 : 0, nowIso(), id);
      return toSessionRecord(this.getRow(id)!);
    });
  }

  /** 聊天成功时推进 lastMessageAt（会话列表按最近活跃排序）。 */
  touch(id: string): void {
    const now = nowIso();
    this.store.db.prepare('UPDATE sessions SET lastMessageAt = ?, updatedAt = ? WHERE id = ?').run(now, now, id);
  }
}
