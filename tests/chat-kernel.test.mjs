import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ModelGateway } from '../dist/runtime/model-gateway.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { FakeScriptedProvider } from '../dist/providers/fake-scripted.js';
import { runAgentLoop } from '../dist/runtime/agent-loop.js';
import { TaskControllerRegistry, requestTaskCancel } from '../dist/runtime/recovery.js';
import { runChatTurn, listChatHistory } from '../dist/runtime/chat-kernel.js';

// M09 验收：同一聊天内核贯通 CLI/IPC（task-service + model-gateway 一本账）。
// 覆盖 K01 聊天任务全账本+幂等、K02 聊天与文件任务同一预算账本、K03 取消语义、
// K04 崩溃遗留 interrupted 不静默重发、K05 IPC e2e（v1 chat/history、旧历史并入、
// 断网+桥不可用下纯本地文件任务、显式桥接任务不假装完成）、K06 --once e2e 无旧双写。
// 全部 fake provider / 本机临时目录，零网络、零付费调用。

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = join(DEV_ROOT, 'dist', 'supervisor.js');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m09-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function makeKernelEnv(fixtureSteps, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09-'));
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ steps: fixtureSteps }), 'utf8');
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm09-test');
  const provider = new FakeScriptedProvider({ fixturePath: fixture, enabled: true });
  const gateway = new ModelGateway({
    store,
    service,
    config: { mode: 'call-limit', defaultProvider: 'fake', expensiveProviders: new Set(['astra']), maxRetries: 0 },
  });
  gateway.registerProvider({
    name: 'fake',
    adapter: provider,
    model: 'fake-scripted',
    local: opts.fakeLocal ?? true,
    verified: true,
  });
  const controllers = new TaskControllerRegistry();
  const flushed = [];
  const deps = {
    service,
    gateway,
    controllers,
    tools: new ToolRegistry(),
    adapterFor: (name) => (name === 'fake' ? provider : null),
    prepareContext: opts.prepareContext ?? (async () => null),
    flushMemoryOutbox:
      opts.flushMemoryOutbox === undefined
        ? async (entry) => { flushed.push(entry); }
        : opts.flushMemoryOutbox,
    fallbackSystem: '测试 system 提示',
    defaultProvider: () => 'fake',
    modelFor: () => 'fake-scripted',
    providerAvailable: (name) => name === 'fake',
  };
  return { root, store, service, provider, gateway, controllers, deps, flushed };
}

const chatReq = (over = {}) => ({
  id: over.id ?? `chat-${randomUUID()}`,
  message: over.message ?? '你好，内核',
  sessionId: 's-m09',
  scope: 'skf-test',
  channel: 'cli',
  ...over,
});

function taskEvents(service, taskId) {
  return service.listEvents(0, 1000).filter((event) => event.taskId === taskId);
}

// ── K01：聊天任务全账本 + 幂等重放 + 输入冲突 ─────────────────────

test('K01 聊天轮次是同一内核任务：事件/消息/模型调用/记忆 outbox 全账本，同 ID 幂等零副作用', async () => {
  const env = await makeKernelEnv([{ text: 'fake 回复：你好！', usage: { inputTokens: 12, outputTokens: 7 } }]);
  try {
    const req = chatReq({ id: 'chat-k01' });
    const result = await runChatTurn(env.deps, req);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.idempotent, false);
    assert.equal(result.text, 'fake 回复：你好！');
    assert.equal(result.provider, 'fake');
    assert.equal(result.toolCallsIgnored, 0);
    assert.equal(result.memoryOutboxPending, false);

    // 任务 + 状态 + 消息（system/user/assistant）
    const task = env.service.getTask('chat-k01');
    assert.equal(task.state, 'succeeded');
    assert.equal(task.provider, 'fake');
    assert.equal(task.workspaceRoot, '-'); // 聊天不接触文件系统
    const input = task.input;
    assert.equal(input.kind, 'chat');
    assert.equal(input.channel, 'cli');
    const messages = env.service.listMessages('chat-k01');
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.equal(messages[0].content, '测试 system 提示'); // fallbackSystem（prepareContext 返回 null）
    assert.equal(messages[1].content, '你好，内核');
    assert.equal(messages[2].content, 'fake 回复：你好！');

    // 事件与文件任务同一张 events 表、同一词汇
    const events = taskEvents(env.service, 'chat-k01');
    assert.deepEqual(events.map((e) => e.type), ['task.created', 'task.running', 'task.model_step', 'task.succeeded']);

    // 模型调用进同一 model_calls 预算账本
    const calls = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ?').all('chat-k01');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'mc:chat-k01:1');
    assert.equal(calls[0].purpose, 'chat');
    assert.equal(calls[0].state, 'settled');
    assert.deepEqual(JSON.parse(calls[0].usage), { inputTokens: 12, outputTokens: 7, cachedInputTokens: null, source: 'provider' });

    // 记忆 outbox：幂等键 + chat 摘要 payload + 已投递
    const outbox = env.store.db.prepare('SELECT * FROM outbox WHERE taskId = ?').get('chat-k01');
    assert.equal(outbox.id, 'mem:chat-k01');
    assert.equal(outbox.kind, 'memory_writeback');
    assert.equal(outbox.state, 'done');
    const payload = JSON.parse(outbox.payload);
    assert.equal(payload.chat.message, '你好，内核');
    assert.equal(payload.chat.reply, 'fake 回复：你好！');
    assert.equal(payload.chat.channel, 'cli');
    assert.equal(env.flushed.length, 1);

    // 幂等重放：同 ID 同输入返回账本结果，零新事件、零新调用、零新投递
    const eventsBefore = env.service.listEvents(0, 1000).length;
    const replay = await runChatTurn(env.deps, req);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.text, 'fake 回复：你好！');
    assert.deepEqual(replay.usage, { inputTokens: 12, outputTokens: 7, cachedInputTokens: null, source: 'provider' });
    assert.equal(env.service.listEvents(0, 1000).length, eventsBefore);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS c FROM model_calls').get().c, 1);
    assert.equal(env.flushed.length, 1);

    // 同 ID 改输入：REQUEST_ID_CONFLICT
    await assert.rejects(runChatTurn(env.deps, chatReq({ id: 'chat-k01', message: '完全不同的输入' })), (e) => e.code === 'REQUEST_ID_CONFLICT');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── K02：聊天与文件任务同一预算账本（CLI/GUI 同一事件与预算账本）──────

test('K02 聊天轮次与 AgentLoop 文件任务共用同一 model_calls 预算账本', async () => {
  const env = await makeKernelEnv(
    [
      { text: '聊天回复一' }, // chat
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'a.md', content: '# A\n' } }] }, // agent step1
      { expectToolResults: ['call-1'], text: '写好了' }, // agent step2
    ],
    { fakeLocal: false }, // 非 local：daily.calls 必须把它计入（ locals 不计）
  );
  try {
    const ws = join(env.root, 'ws');
    await mkdir(ws, { recursive: true });
    await runChatTurn(env.deps, chatReq({ id: 'chat-k02' }));
    const taskId = 'task-k02';
    env.service.createTask({
      id: taskId,
      input: { goal: '写 a.md' },
      sessionId: 's-m09',
      scope: 'skf-test',
      workspaceRoot: ws,
      provider: 'fake',
      model: 'fake-scripted',
    });
    const loop = await runAgentLoop(
      {
        service: env.service,
        provider: env.provider,
        gateway: env.gateway,
        tools: new ToolRegistry(),
        authorization: localDeliveryAuthorization(ws),
      },
      taskId,
    );
    assert.equal(loop.state, 'succeeded');

    // 同一本账：3 次调用（chat 1 + agent 2）全部在同一 model_calls 表
    const total = env.store.db.prepare('SELECT COUNT(*) AS c FROM model_calls').get().c;
    assert.equal(total, 3);
    const daily = env.gateway.status().daily;
    assert.equal(daily.calls, 3, 'daily ledger must count chat + agent steps in one book');
    // 事件也在同一张表
    const eventTaskIds = new Set(env.service.listEvents(0, 1000).map((e) => e.taskId));
    assert.ok(eventTaskIds.has('chat-k02') && eventTaskIds.has(taskId));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── K03：取消语义复用 M07（在途聊天取消 = uncertain，不记免费）─────────

test('K03 在途聊天取消：abort 到达 provider，model_calls uncertain，任务 cancelled', async () => {
  const env = await makeKernelEnv([{ delayMs: 30_000, text: '不该到达的回复' }]);
  try {
    const pending = runChatTurn(env.deps, chatReq({ id: 'chat-k03' }));
    await sleep(150);
    const cancel1 = await requestTaskCancel(env.service, 'chat-k03', { controllers: env.controllers });
    assert.equal(cancel1.state, 'cancelling');
    await assert.rejects(pending, (e) => e.code === 'TASK_CANCELLED');
    const task = env.service.getTask('chat-k03');
    assert.equal(task.state, 'cancelled');
    // 发出后取消：费用 uncertain（可能已计费），不记 failed 不记免费
    const call = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ?').get('chat-k03');
    assert.equal(call.state, 'uncertain');
    // 重复取消幂等
    const cancel2 = await requestTaskCancel(env.service, 'chat-k03', { controllers: env.controllers });
    assert.equal(cancel2.idempotent, true);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── K04：崩溃遗留 interrupted 聊天不静默重发 ──────────────────────

test('K04 崩溃遗留：interrupted 聊天轮次标 uncertain 后拒绝静默重发，新轮次用新 ID', async () => {
  const env = await makeKernelEnv([{ text: '第二次回复' }]);
  try {
    // 模拟崩溃：任务停在 running + 一条 reserved 调用（请求可能已发出）
    const input = { kind: 'chat', message: '你好', channel: 'ipc' };
    env.service.createTask({
      id: 'chat-k04',
      input,
      sessionId: 's-m09',
      scope: 'skf-test',
      workspaceRoot: '-',
      provider: 'fake',
      model: 'fake-scripted',
    });
    env.service.transitionTask('chat-k04', 'running');
    env.service.recordModelCall({ id: 'mc:chat-k04:1', taskId: 'chat-k04', purpose: 'chat', provider: 'fake', model: 'fake-scripted' });
    // 重启 recover：running → interrupted（只标识，不重试）
    env.service.recover();
    assert.equal(env.service.getTask('chat-k04').state, 'interrupted');

    // 同 ID 再访问：先把 reserved 标 uncertain，然后拒绝静默重发
    await assert.rejects(runChatTurn(env.deps, chatReq({ id: 'chat-k04', message: '你好', channel: 'ipc' })), (e) => e.code === 'TASK_INTERRUPTED');
    const call = env.store.db.prepare('SELECT * FROM model_calls WHERE id = ?').get('mc:chat-k04:1');
    assert.equal(call.state, 'uncertain');
    // 零新模型调用（fake fixture 一步都未消耗）
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS c FROM model_calls').get().c, 1);

    // 用户的新轮次用新 ID 正常完成
    const fresh = await runChatTurn(env.deps, chatReq({ id: 'chat-k04-new', message: '你好', channel: 'ipc' }));
    assert.equal(fresh.text, '第二次回复');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── K05：IPC e2e —— v1 chat/history、旧历史并入、断网+桥不可用的本地任务 ──

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
  close() {
    this.rl.close();
    for (const entry of this.pending.values()) entry.resolve({ id: '', ok: false, error: 'CLIENT_CLOSED' });
    this.pending.clear();
  }
}

test('K05 IPC e2e：v1 chat 走内核；旧历史并入同一账本；断网+桥不可用时本地文件任务正常、桥接任务如实失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09-'));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault');
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const legacyDir = join(dataDir, 'tasks');
  await mkdir(legacyDir, { recursive: true });
  // 旧格式聊天历史（tasks-json-v1），原文件必须在导入后保持只读不变
  const legacyId = createHash('sha256').update('legacy-1').digest('hex');
  const legacyDoc = {
    id: legacyId,
    message: '旧聊天记录问题',
    provider: 'kimi',
    startedAt: '2026-09-01T10:00:00.000Z',
    status: 'completed',
    response: { text: '旧聊天记录回答', provider: 'kimi', model: 'kimi-k3' },
  };
  await writeFile(join(legacyDir, `${legacyId}.json`), JSON.stringify(legacyDoc), 'utf8');
  const legacyFileBefore = await readFile(join(legacyDir, `${legacyId}.json`), 'utf8');

  const fixture = join(root, 'fixture.json');
  await writeFile(
    fixture,
    JSON.stringify({
      steps: [
        { text: 'IPC 内核回复', usage: { inputTokens: 9, outputTokens: 4 } }, // v1 chat
        { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'note.md', content: '# 笔记\n' } }] }, // file task
        { expectToolResults: ['call-1'], text: '笔记已写入工作区。' },
        { toolCalls: [{ id: 'call-2', name: 'openclaw.status', arguments: {} }] }, // bridge task
        { expectToolResults: ['call-2'], text: '桥接当前不可用，已如实汇报。' },
      ],
    }),
    'utf8',
  );
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
    // 断网仿真：任何意外云出口都会被死代理快速失败；fake 本身零网络。
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    // 网关未运行仿真：桥接命令指向不存在的二进制。
    SKF_OPENCLAW_BRIDGE_CMD: 'definitely-not-exists-openclaw-m09',
  };
  delete env.KIMI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  const child = spawn(process.execPath, [SUPERVISOR, '--ipc'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new IpcClient(child);
  try {
    // 1) ping：内核就绪；桥接清楚标 unavailable（可选能力，不影响启动）。
    //    启动探测是后台异步的（不阻塞启动），等它落定再断言状态。
    let ping;
    for (let i = 0; i < 30; i++) {
      ping = await client.call('ping');
      if (ping.capabilities.openclawBridge.state !== 'unprobed') break;
      await sleep(100);
    }
    assert.equal(ping.status, 'ready');
    assert.equal(ping.capabilities.chatKernel, true);
    assert.equal(ping.capabilities.openclawBridge.state, 'unavailable');
    assert.match(ping.capabilities.openclawBridge.reason ?? '', /未找到|探测/);

    // 2) v1 chat：走内核，响应形状保持 v1 兼容
    const chatFrame = await client.request('chat', { message: '你好 IPC' }, { id: 'chat-e2e-1' });
    assert.equal(chatFrame.ok, true, `v1 chat failed: ${JSON.stringify(chatFrame)}`);
    assert.equal(chatFrame.data.text, 'IPC 内核回复');
    assert.equal(chatFrame.data.provider, 'fake');
    assert.equal(chatFrame.data.state, 'succeeded');
    assert.equal(chatFrame.data.proposedToolCount, 0);
    assert.equal(chatFrame.data.execution, 'enabled');
    assert.equal(chatFrame.data.memoryWarning, false);
    // v1 幂等：同 ID 同消息直接返回账本结果（无新事件）
    const again = await client.request('chat', { message: '你好 IPC' }, { id: 'chat-e2e-1' });
    assert.equal(again.ok, true);
    assert.equal(again.data.text, 'IPC 内核回复');
    // 同 ID 改消息：REQUEST_ID_CONFLICT
    const conflict = await client.request('chat', { message: '别的消息' }, { id: 'chat-e2e-1' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, 'REQUEST_ID_CONFLICT');

    // 3) 纯本地文件任务（断网 + 无 OpenClaw）：端到端成功
    const start = await client.call('task.start', {
      id: 'task-e2e-note',
      input: { goal: '写 note.md' },
      workspaceRoot: ws,
      provider: 'fake',
    });
    assert.equal(start.created, true);
    let noteTask;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      noteTask = (await client.call('task.get', { taskId: 'task-e2e-note' })).task;
      if (noteTask.state === 'succeeded' || noteTask.state === 'failed') break;
    }
    assert.equal(noteTask.state, 'succeeded');
    assert.equal((await readFile(join(ws, 'note.md'), 'utf8')), '# 笔记\n');

    // 4) 显式桥接任务：桥不可用时不假装完成，账本如实记 TOOL_UNAVAILABLE
    await client.call('task.start', {
      id: 'task-e2e-bridge',
      input: { goal: '查看 OpenClaw 状态', bridgeTools: ['openclaw.status'] },
      workspaceRoot: ws,
      provider: 'fake',
    });
    let toolEvent;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const events = (await client.call('events.since', { afterSeq: 0, limit: 1000, taskId: 'task-e2e-bridge' })).events;
      toolEvent = events.find((e) => e.type === 'task.tool');
      if (toolEvent) break;
    }
    assert.ok(toolEvent, 'bridge tool event missing');
    assert.equal(toolEvent.safePayload.ok, false);
    assert.equal(toolEvent.safePayload.code, 'TOOL_UNAVAILABLE');
    // 未授权名单外的桥接工具：task.start 直接 INVALID_INPUT
    await assert.rejects(
      client.call('task.start', { input: { goal: 'x', bridgeTools: ['openclaw.browser.navigate'] }, workspaceRoot: ws, provider: 'fake' }),
      (e) => e.code === 'INVALID_INPUT',
    );

    // 5) v1 history：旧历史（并入）+ 新聊天同一视图；旧文件只读未变
    const historyFrame = await client.request('history');
    assert.equal(historyFrame.ok, true);
    const history = historyFrame.data.tasks;
    const legacyEntry = history.find((t) => t.id === legacyId);
    assert.ok(legacyEntry, 'legacy chat history must appear after import');
    assert.equal(legacyEntry.message, '旧聊天记录问题');
    assert.equal(legacyEntry.text, '旧聊天记录回答'); // 回复内容随消息一并并入
    assert.equal(legacyEntry.model, 'kimi-k3'); // 原模型名保留
    assert.equal(legacyEntry.status, 'completed');
    const newEntry = history.find((t) => t.id === 'chat-e2e-1');
    assert.ok(newEntry, 'new kernel chat must appear in v1 history');
    assert.equal(newEntry.text, 'IPC 内核回复');
    assert.equal(newEntry.status, 'completed');
    assert.equal(await readFile(join(legacyDir, `${legacyId}.json`), 'utf8'), legacyFileBefore);
    assert.equal((await readdir(legacyDir)).length, 1, 'no new tasks/*.json may be written (no legacy dual path)');
  } finally {
    client.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
    await cleanupTestRoot(root);
  }
});

// ── K06：--once e2e —— CLI 聊天走内核，无旧 tasks.json 双写 ─────────

test('K06 --once：CLI 聊天经同一内核入账，不产生旧 tasks/*.json 双写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09-'));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault');
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ steps: [{ text: 'once 内核回复' }] }), 'utf8');
  const env = {
    PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, COMSPEC: process.env.COMSPEC,
    NODE_ENV: 'test', SKF_SKIP_ENV: '1', SKF_DATA_DIR: dataDir,
    XIAOLIU_PROVIDER: 'fake', SKF_FAKE_PROVIDER: '1', SKF_FAKE_FIXTURE: fixture,
    SKF_MEMORY_ROOT: vault, SKF_MEMORY_SEMANTIC: '0', SKF_MEMORY_SCOPE: 'skf-test',
    SKF_BUDGET_MODE: 'call-limit',
    SKF_LEARNING: '0',
    SKF_OPENCLAW_BRIDGE_CMD: 'definitely-not-exists-openclaw-m09',
  };
  const run = spawn(process.execPath, [SUPERVISOR, '--once', '--test', '冒烟：CLI 聊天内核'], { cwd: root, env, windowsHide: true });
  let out = '';
  let err = '';
  run.stdout.on('data', (b) => (out += b));
  run.stderr.on('data', (b) => (err += b));
  const code = await new Promise((r) => run.on('exit', r));
  try {
    assert.equal(code, 0, `--once exit ${code}; stderr tail: ${err.slice(-600)}`);
    assert.ok(out.includes('once 内核回复'), 'stdout must contain the fake reply');
    // 聊天轮次已入统一账本（runtime.sqlite）
    const store = new RuntimeStore(join(dataDir, 'runtime.sqlite'));
    try {
      const tasks = store.db.prepare("SELECT id, input FROM tasks WHERE json_extract(input, '$.kind') = 'chat'").all();
      assert.equal(tasks.length, 1);
      const input = JSON.parse(tasks[0].input);
      assert.equal(input.channel, 'once');
      const state = store.db.prepare('SELECT state FROM tasks WHERE id = ?').get(tasks[0].id).state;
      assert.equal(state, 'succeeded');
      const calls = store.db.prepare('SELECT COUNT(*) AS c FROM model_calls').get().c;
      assert.equal(calls, 1);
      // --test：outbox 已标 done 但真实主档零接触（投递 no-op）
      const outbox = store.db.prepare('SELECT state FROM outbox').get();
      assert.equal(outbox.state, 'done');
    } finally {
      store.close();
    }
    // 无旧 tasks/*.json 双写（目录根本没创建）
    await assert.rejects(readdir(join(dataDir, 'tasks')), /ENOENT/);
  } finally {
    await cleanupTestRoot(root);
  }
});
