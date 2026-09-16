import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

// M10 验收（后端断言部分）：UI 依赖的 IPC 面。
// - ping 暴露当前模型名与金额上限（未配置 = null，绝不虚构）
// - memory.status / memory.backup（后端生成路径，UI 不可指定；备份文件有效）
// - task.list/task.get 带 kind（聊天不进任务页）与 artifact 校验时间
// - 新错误码 MEMORY_BACKUP_FAILED 走白名单（不收敛成 REQUEST_FAILED）
// 真实子进程 + fake provider，隔离 temp SKF_DATA_DIR / vault / workspace，零网络零付费。

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = join(DEV_ROOT, 'dist', 'supervisor.js');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m10-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

class IpcClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.events = [];
    this.stderr = '';
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000);
    });
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame && typeof frame === 'object' && frame.event) {
        this.events.push(frame.event);
        return;
      }
      if (frame && typeof frame.id === 'string' && this.pending.has(frame.id)) {
        const entry = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        entry(frame);
      }
    });
  }

  request(action, data = {}, opts = {}) {
    const id = opts.id ?? randomUUID();
    const frame = { id, action, data };
    if (opts.protocol !== undefined) frame.protocol = opts.protocol;
    const promise = new Promise((resolvePromise) => this.pending.set(id, resolvePromise));
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

  close() {
    this.rl.close();
    for (const entry of this.pending.values()) entry({ id: '', ok: false, error: 'CLIENT_CLOSED' });
    this.pending.clear();
  }
}

async function spawnSupervisor(opts = {}) {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), 'skf-m10-')));
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
    SKF_MEMORY_SCOPE: 'skf-m10',
    SKF_BUDGET_MODE: 'call-limit',
    SKF_LEARNING: '0',
    ...(opts.extraEnv || {}),
  };
  delete env.KIMI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  const child = spawn(process.execPath, [SUPERVISOR, '--ipc'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new IpcClient(child);
  return { root, dataDir, vault, ws, fixture, child, client };
}

async function stopChild(child, client) {
  client.close();
  if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
}

// ── U01：ping 暴露模型名与金额上限（未配置 = null）─────────────────

test('U01 v2 ping 带当前模型名；金额上限未配置为 null，配置后为整数微美元', async () => {
  const env = await spawnSupervisor();
  try {
    const ping = await env.client.call('ping');
    assert.equal(ping.provider, 'fake');
    assert.equal(ping.model, 'fake-scripted');
    assert.equal(ping.dailyMoneyLimitMicros, null);
    assert.equal(ping.taskMoneyLimitMicros, null);
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }

  const env2 = await spawnSupervisor({ extraEnv: { SKF_BUDGET_DAILY_USD: '1.25', SKF_BUDGET_PER_TASK_USD: '0.5' } });
  try {
    const ping = await env2.client.call('ping');
    assert.equal(ping.dailyMoneyLimitMicros, 1_250_000);
    assert.equal(ping.taskMoneyLimitMicros, 500_000);
  } finally {
    await stopChild(env2.child, env2.client);
    await cleanupTestRoot(env2.root);
  }
});

// ── U02：memory.status 计数与 scope ─────────────────────────────

test('U02 memory.status 返回 scope 与记录计数（无路径无原文）', async () => {
  const env = await spawnSupervisor();
  try {
    // 先让一次聊天发生，写回一条 episode 到临时 vault
    const chat = await env.client.request('chat', { message: '你好，记一下。' });
    assert.equal(chat.ok, true);
    const status = await env.client.call('memory.status');
    assert.equal(status.scope, 'skf-m10');
    assert.ok(Array.isArray(status.stats.records));
    const total = status.stats.records.reduce((sum, row) => sum + row.count, 0);
    assert.ok(total >= 1, `expected at least 1 record, got ${total}`);
    assert.equal(typeof status.outboxPending, 'number');
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes(env.vault), 'status 不暴露主档路径');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── U03：memory.backup 生成有效快照，UI 不可指定路径 ──────────────

test('U03 memory.backup 在数据目录生成可打开的有效 sqlite；path 字段被拒', async () => {
  const env = await spawnSupervisor();
  try {
    const chat = await env.client.request('chat', { message: '备份前先来一条。' });
    assert.equal(chat.ok, true);

    // UI 试图指定路径：未知字段必须 INVALID_INPUT
    await assert.rejects(
      env.client.call('memory.backup', { path: 'D:/evil.sqlite' }),
      (error) => error.code === 'INVALID_INPUT',
    );

    const backup = await env.client.call('memory.backup');
    assert.equal(typeof backup.file, 'string');
    assert.ok(backup.file.includes(join(env.dataDir)), '备份必须在 SKF_DATA_DIR 下');
    assert.ok(!backup.file.startsWith(resolve(env.vault)), '备份不写进主档目录');
    assert.ok(existsSync(backup.file), '备份文件必须存在');

    // 打开验证：是有效 sqlite 且有记录
    const db = new DatabaseSync(backup.file, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM records').get();
    assert.ok(row.n >= 1, `backup must contain records, got ${row.n}`);
    const integrity = db.prepare('PRAGMA integrity_check').get();
    assert.equal(integrity.integrity_check, 'ok');
    db.close();
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── U04：备份失败走白名单错误码 ──────────────────────────────────

test('U04 备份目标不可写时报 MEMORY_BACKUP_FAILED（不收敛成 REQUEST_FAILED）', async () => {
  const env = await spawnSupervisor();
  try {
    // 在数据目录放一个名为 backups 的普通文件，mkdir 必失败
    await mkdir(env.dataDir, { recursive: true });
    await writeFile(join(env.dataDir, 'backups'), 'occupied');
    await assert.rejects(
      env.client.call('memory.backup'),
      (error) => error.code === 'MEMORY_BACKUP_FAILED' || error.code === 'MEMORY_UNAVAILABLE',
    );
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── U05：task.list 带 kind；聊天轮次标 chat 不进任务页 ─────────────

test('U05 task.list/task.get 带 kind；聊天 kind=chat，文件任务 kind=task', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      // 注意：fake fixture 步骤按调用顺序消耗；先跑文件任务（两步），再聊天（第三步）。
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'note.md', content: '# 笔记\n\n内容。' } }] },
      { expectToolResults: ['call-1'], text: '笔记已创建。' },
      { text: '聊天回复。' },
    ],
  });
  try {
    const started = await env.client.call('task.start', {
      id: 'task-m10-kind',
      input: { goal: '创建笔记文件' },
      workspaceRoot: env.ws,
      provider: 'fake',
    });
    assert.equal(started.created, true);
    // 等文件任务终态
    for (let i = 0; i < 50; i++) {
      const got = await env.client.call('task.get', { taskId: 'task-m10-kind' });
      if (got.task.state === 'succeeded') break;
      await sleep(200);
      if (i === 49) assert.fail('file task did not succeed; stderr: ' + env.client.stderr.slice(-400));
    }

    const chat = await env.client.request('chat', { message: '聊一句。' });
    assert.equal(chat.ok, true);

    const listed = await env.client.call('task.list', { limit: 20 });
    const fileTask = listed.tasks.find((t) => t.id === 'task-m10-kind');
    assert.equal(fileTask.kind, 'task');
    const chatTasks = listed.tasks.filter((t) => t.kind === 'chat');
    assert.ok(chatTasks.length >= 1, 'chat turn must appear as kind=chat');
    assert.ok(chatTasks.every((t) => t.goal === '' || typeof t.goal === 'string'));

    const got = await env.client.call('task.get', { taskId: 'task-m10-kind' });
    assert.equal(got.task.kind, 'task');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── U06：artifact 带读回校验时间 ──────────────────────────────────

test('U06 task.get 的 artifacts 带 verifiedAt（UI 已校验徽章的依据）', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: '# 报价\n\n800 元。' } }] },
      { expectToolResults: ['call-1'], text: '报价已创建。' },
    ],
  });
  try {
    await env.client.call('task.start', {
      id: 'task-m10-artifact',
      input: { goal: '创建报价文件' },
      workspaceRoot: env.ws,
      provider: 'fake',
    });
    let got;
    for (let i = 0; i < 50; i++) {
      got = await env.client.call('task.get', { taskId: 'task-m10-artifact' });
      if (got.task.state === 'succeeded') break;
      await sleep(200);
      if (i === 49) assert.fail('task did not succeed; stderr: ' + env.client.stderr.slice(-400));
    }
    assert.equal(got.artifacts.length, 1);
    assert.equal(got.artifacts[0].relativePath, 'quote.md');
    assert.equal(typeof got.artifacts[0].sha256, 'string');
    assert.ok(got.artifacts[0].verifiedAt, 'verifiedAt must be set after readback verification');
    // 实物与登记一致（UI 链接的文件确实存在且 hash 对得上）
    const { createHash } = await import('node:crypto');
    const onDisk = await readFile(join(env.ws, 'quote.md'));
    assert.equal(createHash('sha256').update(onDisk).digest('hex'), got.artifacts[0].sha256);
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});
