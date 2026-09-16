import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { SessionService } from '../dist/runtime/session-service.js';

// M23 验收：多会话 + 后端会话 CRUD + 严格隔离。
// 覆盖：sessions 表（migration v6）、SessionService CRUD/幂等/scope 唯一/重命名不改 scope、
// 归档只改可见性不删历史不取消任务、IPC v2 session.* 白名单+错误码、
// chat 绑定 sessionId/scope、session.history 分页、A/B 消息与记忆不串线、重启后会话列表恢复。
// 全部 fake provider / 本机临时目录，零网络、零付费调用。

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = join(DEV_ROOT, 'dist', 'supervisor.js');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m23-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ── IPC 客户端（测试侧，模拟 Rust 桥行为）─────────────────────────

class IpcClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.stderr = '';
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000);
    });
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.onLine(line));
  }

  onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame && typeof frame === 'object' && frame.event) {
      this.events.push(frame.event);
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.pred(frame.event)) {
          clearTimeout(waiter.timer);
          this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
          waiter.resolve(frame.event);
        }
      }
      return;
    }
    if (frame && typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      entry.resolve(frame);
    }
  }

  request(action, data = {}, opts = {}) {
    const id = opts.id ?? randomUUID();
    const frame = { id, action, data };
    if (opts.protocol !== undefined) frame.protocol = opts.protocol;
    const promise = new Promise((resolvePromise) => this.pending.set(id, { resolve: resolvePromise }));
    this.child.stdin.write(JSON.stringify(frame) + '\n');
    return promise;
  }

  async call(action, data = {}, opts = {}) {
    const frame = await this.request(action, data, { ...opts, protocol: 2 });
    if (!frame.ok) {
      const error = new Error(frame.error);
      error.code = frame.error;
      throw error;
    }
    return frame.data;
  }

  waitForEvent(pred, timeoutMs = 15_000, label = 'event') {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`timeout waiting ${label}; stderr tail: ${this.stderr.slice(-800)}`)), timeoutMs);
      this.eventWaiters.push({ pred, resolve: resolvePromise, timer });
    });
  }

  close() {
    this.rl.close();
    for (const entry of this.pending.values()) entry.resolve({ id: '', ok: false, error: 'CLIENT_CLOSED' });
    this.pending.clear();
  }
}

async function spawnSupervisor(opts = {}) {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), 'skf-m23-')));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault');
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ steps: opts.fixtureSteps ?? [{ text: 'fake 默认回复。' }] }), 'utf8');
  const env = {
    ...process.env,
    SKF_DATA_DIR: dataDir,
    SKF_SKIP_ENV: '1',
    NODE_ENV: 'test',
    SKF_ALLOW_MOCK: '1',
    SKF_FAKE_PROVIDER: '1',
    SKF_FAKE_FIXTURE: fixture,
    XIAOLIU_PROVIDER: 'fake',
    SKF_MEMORY_ROOT: vault,
    SKF_MEMORY_SEMANTIC: '0',
    SKF_MEMORY_SCOPE: 'skf-test',
    SKF_BUDGET_MODE: 'call-limit',
    SKF_LEARNING: '0',
  };
  delete env.KIMI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  const child = spawn(process.execPath, [SUPERVISOR, '--ipc'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new IpcClient(child);
  const exited = new Promise((resolvePromise) => child.once('exit', (code) => resolvePromise(code)));
  return { root, dataDir, vault, ws, fixture, child, client, exited };
}

async function stopChild(child, client, signal = 'SIGKILL') {
  client.close();
  if (child.exitCode === null) child.kill(signal);
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
}

// ── 单元测试：SessionService + migration v6 ──────────────────────

test('T01 sessions 表存在且 schemaVersion=7，CRUD 往返一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m23-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  try {
    assert.equal(store.schemaVersion(), 7);
    const svc = new SessionService(store);
    const s = svc.createSession({ name: '  测试会话  ' });
    assert.match(s.id, /^session-[0-9a-f-]+$/);
    assert.equal(s.name, '测试会话');
    assert.equal(s.scope, `skf:session:${s.id}`);
    assert.equal(s.archived, false);
    assert.equal(s.lastMessageAt, null);
    assert.deepEqual(svc.getSession(s.id), s);
    assert.equal(svc.listSessions().length, 1);
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

test('T02 createSession 幂等：同 id 同内容返回原记录；改内容 SESSION_EXISTS；scope 冲突 SESSION_EXISTS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m23-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  try {
    const svc = new SessionService(store);
    const a = svc.createSession({ id: 's-a', name: 'A', scope: 'skf:session:a' });
    const replay = svc.createSession({ id: 's-a', name: 'A', scope: 'skf:session:a' });
    assert.deepEqual(replay, a);
    assert.throws(() => svc.createSession({ id: 's-a', name: 'A2', scope: 'skf:session:a' }), /SESSION_EXISTS/);
    // 不同 id 但 scope 撞车
    assert.throws(() => svc.createSession({ id: 's-b', name: 'B', scope: 'skf:session:a' }), /SESSION_EXISTS/);
    assert.equal(svc.listSessions().length, 1);
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

test('T03 重命名不改 scope；归档/恢复只改可见性；touch 更新 lastMessageAt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m23-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  try {
    const svc = new SessionService(store);
    const a = svc.createSession({ id: 's-a', name: 'A', scope: 'skf:session:a' });
    const renamed = svc.renameSession('s-a', 'A-重命名');
    assert.equal(renamed.name, 'A-重命名');
    assert.equal(renamed.scope, 'skf:session:a'); // scope 不变
    const archived = svc.setArchived('s-a', true);
    assert.equal(archived.archived, true);
    assert.equal(archived.scope, 'skf:session:a');
    assert.equal(svc.listSessions({ archived: false }).length, 0);
    assert.equal(svc.listSessions({ archived: true }).length, 1);
    const restored = svc.setArchived('s-a', false);
    assert.equal(restored.archived, false);
    const beforeTouch = svc.getSession('s-a').lastMessageAt;
    assert.equal(beforeTouch, null);
    svc.touch('s-a');
    assert.ok(svc.getSession('s-a').lastMessageAt !== null);
    assert.throws(() => svc.renameSession('missing', 'x'), /SESSION_NOT_FOUND/);
    assert.throws(() => svc.setArchived('missing', true), /SESSION_NOT_FOUND/);
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

test('T04 ensureDefault 惰性引导默认会话（幂等，旧任务归属默认会话）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m23-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  try {
    const svc = new SessionService(store);
    const first = svc.ensureDefault('skf-ipc', 'skf-test');
    assert.equal(first.id, 'skf-ipc');
    assert.equal(first.scope, 'skf-test');
    const second = svc.ensureDefault('skf-ipc', 'skf-test');
    assert.deepEqual(second, first);
    assert.equal(svc.listSessions().length, 1);
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

// ── IPC e2e：session.* + 隔离 + 归档/重启 ─────────────────────────

test('S01 session.create/list/get 往返；默认会话已引导；SESSION_NOT_FOUND 白名单', async () => {
  const env = await spawnSupervisor();
  try {
    const created = await env.client.call('session.create', { name: '会话一' });
    assert.match(created.session.id, /^session-/);
    assert.equal(created.session.archived, false);
    assert.equal(created.session.scope, `skf:session:${created.session.id}`);

    const got = await env.client.call('session.get', { id: created.session.id });
    assert.deepEqual(got.session, created.session);

    const list = await env.client.call('session.list', {});
    // 默认会话 + 新建会话
    assert.ok(list.sessions.length >= 2);
    assert.ok(list.sessions.some((s) => s.id === 'skf-ipc' && s.scope === 'skf-test'));
    assert.ok(list.sessions.some((s) => s.id === created.session.id));

    await assert.rejects(() => env.client.call('session.get', { id: 'missing' }), (e) => e.code === 'SESSION_NOT_FOUND');
    await assert.rejects(() => env.client.call('session.history', { sessionId: 'missing' }), (e) => e.code === 'SESSION_NOT_FOUND');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('S02 session.rename 不改 scope；archive/restore 只改可见性', async () => {
  const env = await spawnSupervisor();
  try {
    const created = await env.client.call('session.create', { name: '原名' });
    const id = created.session.id;
    const scope = created.session.scope;
    const renamed = await env.client.call('session.rename', { id, name: '新名' });
    assert.equal(renamed.session.name, '新名');
    assert.equal(renamed.session.scope, scope);

    const archived = await env.client.call('session.archive', { id });
    assert.equal(archived.session.archived, true);
    assert.equal(archived.session.scope, scope);

    const active = await env.client.call('session.list', { archived: false });
    assert.ok(!active.sessions.some((s) => s.id === id));
    const all = await env.client.call('session.list', { archived: true });
    assert.ok(all.sessions.some((s) => s.id === id && s.archived === true));

    const restored = await env.client.call('session.restore', { id });
    assert.equal(restored.session.archived, false);
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('S03 A/B 聊天消息不串线：chat 绑定 sessionId，session.history 按会话过滤', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      { text: 'A 的回复。' },
      { text: 'B 的回复。' },
      { text: '默认会话的回复。' },
    ],
  });
  try {
    const a = (await env.client.call('session.create', { name: 'A' })).session;
    const b = (await env.client.call('session.create', { name: 'B' })).session;

    // v1 chat 绑定 sessionId（scope 由服务端查得）
    const ra = await env.client.request('chat', { message: '这是 A 的消息', sessionId: a.id });
    assert.equal(ra.ok, true);
    assert.equal(ra.data.sessionId, a.id);
    assert.equal(ra.data.scope, a.scope);

    const rb = await env.client.request('chat', { message: '这是 B 的消息', sessionId: b.id });
    assert.equal(rb.ok, true);
    assert.equal(rb.data.sessionId, b.id);

    const ha = await env.client.call('session.history', { sessionId: a.id });
    assert.equal(ha.entries.length, 1);
    assert.equal(ha.entries[0].message, '这是 A 的消息');
    assert.equal(ha.entries[0].sessionId, a.id);

    const hb = await env.client.call('session.history', { sessionId: b.id });
    assert.equal(hb.entries.length, 1);
    assert.equal(hb.entries[0].message, '这是 B 的消息');
    assert.equal(hb.entries[0].sessionId, b.id);

    // 未指定 sessionId 的 chat 回退默认会话
    const rd = await env.client.request('chat', { message: '默认会话消息' });
    assert.equal(rd.ok, true);
    assert.equal(rd.data.sessionId, 'skf-ipc');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('S04 session.history 分页（afterSeq/limit 游标向更早翻页，无重复无丢失）', async () => {
  const steps = [];
  for (let i = 0; i < 5; i++) steps.push({ text: `回复 ${i}` });
  const env = await spawnSupervisor({ fixtureSteps: steps });
  try {
    const a = (await env.client.call('session.create', { name: 'A' })).session;
    for (let i = 0; i < 5; i++) {
      const r = await env.client.request('chat', { message: `消息 ${i}`, sessionId: a.id });
      assert.equal(r.ok, true);
    }
    // 第一页：最新 2 条（升序返回）
    const p1 = await env.client.call('session.history', { sessionId: a.id, limit: 2 });
    assert.equal(p1.entries.length, 2);
    assert.equal(p1.entries[0].message, '消息 3');
    assert.equal(p1.entries[1].message, '消息 4');
    assert.equal(p1.hasMore, true);
    assert.ok(p1.nextSeq);

    const p2 = await env.client.call('session.history', { sessionId: a.id, limit: 2, afterSeq: p1.nextSeq });
    assert.equal(p2.entries.length, 2);
    assert.equal(p2.entries[0].message, '消息 1');
    assert.equal(p2.entries[1].message, '消息 2');
    assert.equal(p2.hasMore, true);

    const p3 = await env.client.call('session.history', { sessionId: a.id, limit: 2, afterSeq: p2.nextSeq });
    assert.equal(p3.entries.length, 1);
    assert.equal(p3.entries[0].message, '消息 0');
    assert.equal(p3.hasMore, false);
    assert.equal(p3.nextSeq, null);

    // 无重复：三页拼起来恰好 5 条且内容唯一
    const all = [...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.message);
    assert.equal(new Set(all).size, 5);
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('S05 归档不取消运行中的任务；任务照常 succeeded', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'note.md', content: '# 笔记\n' } }], usage: { inputTokens: 10, outputTokens: 5 } },
      { expectToolResults: ['call-1'], text: '笔记已创建。', usage: { inputTokens: 20, outputTokens: 8 } },
    ],
  });
  try {
    const a = (await env.client.call('session.create', { name: 'A' })).session;
    const start = await env.client.call('task.start', {
      id: 'task-s05',
      input: { goal: '创建 note.md' },
      workspaceRoot: env.ws,
      provider: 'fake',
      sessionId: a.id,
      scope: a.scope,
    });
    assert.ok(['queued', 'running'].includes(start.state));
    // 任务启动后立刻归档会话：归档只改可见性，不得取消在途任务。
    const archived = await env.client.call('session.archive', { id: a.id });
    assert.equal(archived.session.archived, true);
    // 任务必须照常推进到 succeeded（若被取消，这里会超时）。
    await env.client.waitForEvent((e) => e.taskId === 'task-s05' && e.type === 'task.succeeded', 15_000, 'task.succeeded despite archive');
    const got = await env.client.call('task.get', { taskId: 'task-s05' });
    assert.equal(got.task.state, 'succeeded');
    assert.equal(got.task.sessionId, a.id);
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('S06 重启后会话列表恢复（持久化）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m23-'));
  let env = await spawnSupervisor({ root });
  let aId;
  try {
    const a = (await env.client.call('session.create', { name: '持久会话' })).session;
    aId = a.id;
    await env.client.call('session.rename', { id: aId, name: '持久会话-改' });
  } finally {
    await stopChild(env.child, env.client);
  }
  // 同一 dataDir 重启
  env = await spawnSupervisor({ root });
  try {
    const list = await env.client.call('session.list', {});
    const hit = list.sessions.find((s) => s.id === aId);
    assert.ok(hit, '重启后会话仍在');
    assert.equal(hit.name, '持久会话-改');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(root);
  }
});

test('S07 A/B 记忆 scope 不串线：会话写回各自 scope，检索互不可见', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      { text: 'A 的回复。' },
      { text: 'B 的回复。' },
    ],
  });
  try {
    const a = (await env.client.call('session.create', { name: 'A' })).session;
    const b = (await env.client.call('session.create', { name: 'B' })).session;
    assert.notEqual(a.scope, b.scope);

    await env.client.request('chat', { message: 'the kumquat is orange colored', sessionId: a.id });
    await env.client.request('chat', { message: 'the wombat is an australian marsupial', sessionId: b.id });

    const hitA = await env.client.call('memory.search', { query: 'kumquat', scope: a.scope });
    const episodesA = (hitA.hits || []).filter((h) => h.kind === 'episode');
    assert.ok(episodesA.length > 0, 'A scope 检索到 A 的 episode');
    assert.ok(episodesA.every((h) => h.scope === a.scope));

    const missInB = await env.client.call('memory.search', { query: 'kumquat', scope: b.scope });
    assert.ok(!(missInB.hits || []).some((h) => h.scope === a.scope), 'B scope 搜不到 A 的 kumquat 记录');

    const hitB = await env.client.call('memory.search', { query: 'wombat', scope: b.scope });
    assert.ok((hitB.hits || []).some((h) => h.scope === b.scope), 'B scope 检索到 B 的 episode');
    assert.ok(!(hitB.hits || []).some((h) => h.scope === a.scope));
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('S08 SESSION_EXISTS 白名单透传', async () => {
  const env = await spawnSupervisor();
  try {
    await env.client.call('session.create', { id: 'dup-session', name: 'A', scope: 'skf:session:dup' });
    await assert.rejects(
      () => env.client.call('session.create', { id: 'dup-session', name: 'B', scope: 'skf:session:dup' }),
      (e) => e.code === 'SESSION_EXISTS',
    );
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});
