import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// M12 验收缺口补测（04 矩阵）：
// P02 provider 不支持工具 → chat 可用、toolExecution 如实 false、执行任务创建前拒绝，
//     绝不退化成「从自由文本猜命令」（聊天里模型发 toolCalls 只计数不执行）。
// M04 向量服务不可用 → 关键词仍可查、semanticStatus=fallback、失败队列可见可显式重试，
//     embedding 只有本地 127.0.0.1 端点（注入 embedder 计次证明零云端调用）。
// 全程真实子进程 node dist/supervisor.js --ipc / vendored 记忆 runtime，隔离 temp 目录，零网络零付费。

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = join(DEV_ROOT, 'dist', 'supervisor.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m12-[a-zA-Z0-9]+$/);
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
      if (this.stderr.length > 100_000) this.stderr = this.stderr.slice(-50_000);
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
      return;
    }
    if (frame && typeof frame.id === 'string' && this.pending.has(frame.id)) {
      this.pending.get(frame.id).resolve(frame);
      this.pending.delete(frame.id);
    }
  }

  request(action, data = {}, protocol) {
    const id = randomUUID();
    const frame = { id, action, data };
    if (protocol !== undefined) frame.protocol = protocol;
    const promise = new Promise((resolvePromise) => this.pending.set(id, { resolve: resolvePromise }));
    this.child.stdin.write(JSON.stringify(frame) + '\n');
    return promise;
  }

  async call(action, data = {}) {
    const frame = await this.request(action, data, 2);
    if (!frame.ok) {
      const error = new Error(frame.error);
      error.code = frame.error;
      throw error;
    }
    return frame.data;
  }

  close() {
    this.rl.close();
    for (const entry of this.pending.values()) entry.resolve({ id: '', ok: false, error: 'CLIENT_CLOSED' });
    this.pending.clear();
  }
}

async function spawnSupervisor(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m12-'));
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ steps: opts.fixtureSteps ?? [{ text: 'fake 回复。' }] }), 'utf8');
  const env = {
    ...process.env,
    SKF_DATA_DIR: dataDir,
    SKF_SKIP_ENV: '1',
    NODE_ENV: 'test',
    SKF_ALLOW_MOCK: '1',
    SKF_FAKE_PROVIDER: '1',
    SKF_FAKE_FIXTURE: fixture,
    XIAOLIU_PROVIDER: opts.provider ?? 'fake',
    SKF_MEMORY_ROOT: join(root, 'vault'),
    SKF_MEMORY_SEMANTIC: '0',
    SKF_MEMORY_SCOPE: 'skf-test',
    SKF_BUDGET_MODE: 'call-limit',
    SKF_LEARNING: '0',
    SKF_OPENCLAW_BRIDGE: '0',
  };
  delete env.KIMI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  const child = spawn(process.execPath, [SUPERVISOR, '--ipc'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: root });
  const client = new IpcClient(child);
  return { root, ws, child, client };
}

async function stopChild(child, client) {
  client.close();
  if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
}

// ── P02：mock（tools:false）→ toolExecution 如实 false；执行任务创建前拒绝；chat 可用 ──

test('P02 mock 大脑：ping 如实 toolExecution=false，task.start 拒 PROVIDER_TOOLS_UNSUPPORTED，chat 仍可用', async () => {
  const env = await spawnSupervisor({ provider: 'mock' });
  try {
    const ping = await env.client.call('ping');
    assert.equal(ping.provider, 'mock');
    assert.equal(ping.capabilities.toolExecution, false, '无工具大脑不得宣称可执行任务');

    const denied = await env.client.request('task.start', {
      input: { goal: '在工作区创建文件' },
      workspaceRoot: env.ws,
      provider: 'mock',
    }, 2);
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'PROVIDER_TOOLS_UNSUPPORTED');

    // 拒绝发生在创建前：账本里不得留下这个任务
    const listed = await env.client.call('task.list', { limit: 10 });
    assert.equal(listed.tasks.length, 0);

    // chat 可用（不执行工具，只文本回复）
    const chat = await env.client.request('chat', { message: '你好，自我介绍' });
    assert.equal(chat.ok, true);
    assert.match(chat.data.text, /mock/);
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('P02 fake 大脑工具能力 true；切到 mock 后 ping 如实翻转且默认执行任务被拒', async () => {
  const env = await spawnSupervisor({
    provider: 'fake',
    fixtureSteps: [{ text: '第一轮。' }, { text: '第二轮。' }],
  });
  try {
    const ping1 = await env.client.call('ping');
    assert.equal(ping1.capabilities.toolExecution, true);

    const switched = await env.client.request('provider', { name: 'mock' });
    assert.equal(switched.ok, true);
    assert.equal(switched.data.switched, true);

    const ping2 = await env.client.call('ping');
    assert.equal(ping2.provider, 'mock');
    assert.equal(ping2.capabilities.toolExecution, false, '切换后必须如实反映新大脑能力');

    const denied = await env.client.request('task.start', {
      input: { goal: '默认大脑执行文件任务' },
      workspaceRoot: env.ws,
    }, 2);
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'PROVIDER_TOOLS_UNSUPPORTED');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

test('P02 聊天执行工具：模型发 file.write → 工作区落盘，toolCalls 已执行', async () => {
  const env = await spawnSupervisor({
    provider: 'fake',
    fixtureSteps: [
      { toolCalls: [{ id: 'call-guess', name: 'file.write', arguments: { path: 'guessed.md', content: '写好了' } }] },
      { expectToolResults: ['call-guess'], text: '文件已写入。' },
    ],
  });
  try {
    const chat = await env.client.request('chat', { message: '帮我写个文件' });
    assert.equal(chat.ok, true);
    assert.equal(chat.data.state, 'succeeded');
    assert.equal(chat.data.execution, 'enabled');
    assert.match(chat.data.text, /文件已写入/);
    // 工具已执行（不是被忽略）：气泡里带名称+effect+状态
    assert.equal(chat.data.toolCalls.length, 1);
    assert.equal(chat.data.toolCalls[0].tool, 'file.write');
    assert.equal(chat.data.toolCalls[0].effect, 'workspace_write');
    assert.equal(chat.data.toolCalls[0].status, 'ok');
    assert.equal(chat.data.toolCallsIgnored, 0);

    // 账本如实记录工具执行（task.tool ok=true）
    const events = (await env.client.call('events.since', { afterSeq: 0, limit: 200 })).events;
    const toolEvent = events.find((e) => e.type === 'task.tool');
    assert.ok(toolEvent, '聊天轮次应有 task.tool 事件');
    assert.equal(toolEvent.safePayload.tool, 'file.write');
    assert.equal(toolEvent.safePayload.ok, true);
    assert.equal(toolEvent.safePayload.effect, 'workspace_write');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── M04：向量服务不可用 → 关键词可查、失败队列可见可重试、零云端 embedding ──

test('M04 向量离线：关键词仍可查、semanticStatus=fallback、失败队列可见、显式重试恢复', async () => {
  const { MemoryVault } = await import('../vendor/memory-runtime/store.mjs');
  const { retrieve, indexPending, retryIndex } = await import('../vendor/memory-runtime/retrieve.mjs');
  const root = await mkdtemp(join(tmpdir(), 'skf-m12-'));
  const source = [{ kind: 'user', locator: 'synthetic-m12:user' }];
  const offlineEmbedder = async () => {
    throw new Error('LOCAL_EMBEDDING_UNAVAILABLE');
  };
  // 1024 维假向量：第一维 1.0，与任何同形向量 cosine=1（>=0.25 阈值）
  const fakeVector = Array(1024).fill(0);
  fakeVector[0] = 1;
  let onlineCalls = 0;
  const onlineEmbedder = async (inputs) => {
    onlineCalls += 1;
    return inputs.map(() => fakeVector);
  };
  const vault = new MemoryVault(root);
  try {
    const rec = vault.record({ text: '向量离线时关键词检索仍然可用', kind: 'reference', trust: 'legacy', source }, 'm04-rec');

    // 1) 索引失败：失败队列可见（state=failed + 错误原因），记录本体完好
    const first = await indexPending(vault, { embedder: offlineEmbedder });
    assert.equal(first.failed, 1);
    const job = vault.db.prepare('SELECT state, attempts, error FROM embedding_jobs WHERE recordId = ?').get(rec.id);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /LOCAL_EMBEDDING_UNAVAILABLE/);
    assert.equal(vault.get(rec.id).text, '向量离线时关键词检索仍然可用');

    // 2) 先用在线假向量补上索引，再模拟检索期离线 → fallback，关键词命中仍在
    const indexed = await indexPending(vault, { embedder: onlineEmbedder });
    // 注意：failed 状态的 job attempts<3 仍会被再次尝试
    assert.ok(indexed.completed >= 1);
    const degraded = await retrieve(vault, '关键词检索', { embedder: offlineEmbedder, semantic: true });
    assert.equal(degraded.semanticStatus, 'fallback');
    assert.equal(degraded.hits.length, 1);
    assert.ok(degraded.hits[0].channels.includes('keyword'));

    // 3) 语义恢复后：同库同查询 ready，命中带 semantic 通道
    const recovered = await retrieve(vault, '关键词检索', { embedder: onlineEmbedder, semantic: true });
    assert.equal(recovered.semanticStatus, 'ready');
    assert.equal(recovered.hits.length, 1);
    assert.ok(recovered.hits[0].channels.includes('semantic'));

    // 4) 失败队列的显式重试路径：再制造一次失败 → retryIndex 精确复位 → 重做成功
    await indexPending(vault, { embedder: offlineEmbedder }); // 无 pending（已 done），幂等空转
    vault.db.prepare("UPDATE embedding_jobs SET state='failed', attempts=1, error='LOCAL_EMBEDDING_UNAVAILABLE' WHERE recordId = ?").run(rec.id);
    const reset = retryIndex(vault, { ids: [rec.id], operationId: 'm04-retry' });
    assert.equal(reset.reset, 1);
    const redone = await indexPending(vault, { embedder: onlineEmbedder });
    assert.equal(redone.completed, 1);
    assert.equal(redone.pending, 0);

    // 5) embedding 只发生在注入的本地 embedder，调用次数完全可数（零云端）
    assert.ok(onlineCalls >= 2 && onlineCalls <= 6, `embedder 调用应可数，实际 ${onlineCalls}`);
  } finally {
    vault.close();
    await cleanupTestRoot(root);
  }
});

test('M04 vendored runtime 的 embedding 端点只有本地回环（静态防云回归）', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(join(DEV_ROOT, 'vendor', 'memory-runtime', 'retrieve.mjs'), 'utf8');
  assert.match(src, /http:\/\/127\.0\.0\.1:11434\/api\/embed/);
  const urls = [...src.matchAll(/https?:\/\/[^\s'"]+/g)].map((m) => m[0]);
  for (const url of urls) {
    assert.ok(url.startsWith('http://127.0.0.1'), `embedding 不得出现非回环端点: ${url}`);
  }
});
