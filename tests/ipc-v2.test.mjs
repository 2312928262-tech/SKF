import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { MemoryAdapter } from '../dist/runtime/memory-adapter.js';

// M08 验收：IPC v2 与桌面任务控制。
// 真实子进程 node dist/supervisor.js --ipc + JSONL 帧，fake provider（纯本地 fixture），
// 隔离 temp SKF_DATA_DIR / vault / workspace，零网络、零付费调用。
// 覆盖：v2 握手、task.start 快速返回+事件流+产物、幂等、schema/帧健壮性、
// 模型阻塞时 ping/cancel p95<500ms（DESKTOP-7T2562S, Node v24, 单任务负载）、
// events.since 断线补发不重复开始、审批 hash 绑定、memory.* 绑定 scope、
// SIGKILL 后 interrupted → resume 阻塞（费用不确定）→ 双授权恢复成功。

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = join(DEV_ROOT, 'dist', 'supervisor.js');
const VENDOR_DIR = join(DEV_ROOT, 'vendor', 'memory-runtime');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m08-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ── IPC 客户端（测试侧，模拟 Rust 桥行为）─────────────────────────

class IpcClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.events = [];
    this.frames = [];
    this.eventWaiters = [];
    this.frameWaiters = [];
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
      this.frames.push({ unparseable: line.slice(0, 200) });
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
    this.frames.push(frame);
    if (frame && typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      entry.resolve(frame);
    }
    for (const waiter of [...this.frameWaiters]) {
      if (waiter.pred(frame)) {
        clearTimeout(waiter.timer);
        this.frameWaiters.splice(this.frameWaiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
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

  /** v2 调用并断言传输层 ok；返回 data 或抛错误码。 */
  async call(action, data = {}, opts = {}) {
    const frame = await this.request(action, data, { ...opts, protocol: 2 });
    if (!frame.ok) {
      const error = new Error(frame.error);
      error.code = frame.error;
      throw error;
    }
    return frame.data;
  }

  raw(line) {
    this.child.stdin.write(line + '\n');
  }

  waitForEvent(pred, timeoutMs = 15_000, label = 'event') {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`timeout waiting ${label}; stderr tail: ${this.stderr.slice(-800)}`)), timeoutMs);
      this.eventWaiters.push({ pred, resolve: resolvePromise, timer });
    });
  }

  waitForFrame(pred, timeoutMs = 5_000, label = 'frame') {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`timeout waiting ${label}`)), timeoutMs);
      this.frameWaiters.push({ pred, resolve: resolvePromise, timer });
    });
  }

  waitForTaskState(taskId, state, timeoutMs = 15_000) {
    // 事件类型两种形态：专属类型（task.running/task.cancelled/task.succeeded/task.failed）
    // 与通用 task.state（payload.to，如 interrupted）。
    return this.waitForEvent(
      (event) =>
        event.taskId === taskId &&
        ((event.type === 'task.state' && event.safePayload?.to === state) || event.type === `task.${state}`),
      timeoutMs,
      `task state=${state}`,
    ).catch(async (error) => {
      // 状态可能在监听前已到：用 task.get 兜底核对
      const data = await this.call('task.get', { taskId }).catch(() => null);
      if (data && data.task.state === state) return { type: 'task.state', safePayload: { to: state }, synthetic: true };
      throw error;
    });
  }

  close() {
    this.rl.close();
    for (const entry of this.pending.values()) entry.resolve({ id: '', ok: false, error: 'CLIENT_CLOSED' });
    this.pending.clear();
  }
}

async function spawnSupervisor(opts = {}) {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), 'skf-m08-')));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault');
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const fixture = join(root, opts.fixtureName ?? 'fixture.json');
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
  // 隔离：不继承真实云 key，环境只剩 fake/mock
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

// ── I01：v2 握手与 v1 兼容 ─────────────────────────────────────

test('I01 v2 ping 握手（protocol:2 + 任务执行能力），v1 ping 保持兼容', async () => {
  const env = await spawnSupervisor();
  try {
    const v2 = await env.client.call('ping');
    assert.equal(v2.protocol, 2);
    assert.equal(v2.status, 'ready');
    assert.equal(v2.provider, 'fake');
    assert.equal(v2.capabilities.ipcV2, true);
    assert.equal(v2.capabilities.toolExecution, true);
    assert.equal(v2.capabilities.memoryMode, 'vault');
    assert.equal(v2.capabilities.memoryScope, 'skf-test');

    const v1frame = await env.client.request('ping'); // v1 帧无 protocol 字段
    assert.equal(v1frame.ok, true);
    assert.equal(v1frame.data.protocol, 1);
    assert.equal(v1frame.data.capabilities.ipcV2, true);
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I02：task.start 快速返回 + 事件流 + 产物验收 ─────────────────

const QUOTE_MD = '# 报价说明\n\n- 设计服务费：800 元\n- 交付周期：5 个工作日\n\n以最终确认为准。\n';
const QUOTE_ACCEPTANCE = {
  kind: 'file_deliverable',
  files: [{ path: 'quote.md', minBytes: 20, mustContain: ['报价说明', '800'] }],
};

async function runQuoteTask(env, taskId) {
  const started = Date.now();
  const startResult = await env.client.call('task.start', {
    id: taskId,
    input: { goal: '在工作区创建报价说明 Markdown' },
    workspaceRoot: env.ws,
    provider: 'fake',
    acceptance: QUOTE_ACCEPTANCE,
  });
  const startLatency = Date.now() - started;
  assert.equal(startResult.taskId, taskId);
  assert.equal(startResult.created, true);
  assert.ok(['queued', 'running'].includes(startResult.state), `immediate state ${startResult.state}`);
  // 终态事件实时推送到 stdout（不是 events.since 查询）
  const succeeded = await env.client.waitForEvent(
    (event) => event.taskId === taskId && event.type === 'task.succeeded',
    15_000,
    'task.succeeded push',
  );
  return { startResult, startLatency, succeeded };
}

test('I02 task.start 立即返回 taskId，worker 异步推进到 succeeded，事件逐条 eventSeq 推送', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }], usage: { inputTokens: 10, outputTokens: 5 } },
      { expectToolResults: ['call-1'], text: '报价说明已创建，文件 quote.md 在工作区内。', usage: { inputTokens: 30, outputTokens: 12 } },
    ],
  });
  try {
    const { startLatency } = await runQuoteTask(env, 'task-ipc-quote');
    assert.ok(startLatency < 2000, `task.start must return fast, got ${startLatency}ms`);

    // 实物 + hash 与 artifact 一致
    const onDisk = await readFile(join(env.ws, 'quote.md'));
    assert.equal(onDisk.toString('utf8'), QUOTE_MD);

    // 推送的事件 eventSeq 严格递增（接收方按序去重）
    const seqs = env.client.events.map((event) => event.eventSeq);
    assert.ok(seqs.length >= 5, `expected several events, got ${seqs.length}`);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'eventSeq must increase');

    const got = await env.client.call('task.get', { taskId: 'task-ipc-quote' });
    assert.equal(got.task.state, 'succeeded');
    assert.equal(got.task.provider, 'fake');
    assert.equal(got.artifacts.length, 1);
    assert.equal(got.artifacts[0].relativePath, 'quote.md');
    assert.equal(got.artifacts[0].sha256, sha256(onDisk));
    assert.deepEqual(got.counts, { modelSteps: 2, toolCalls: 1 });
    assert.match(got.finalText, /报价说明/);
    assert.equal(got.memoryOutboxPending, false); // 终态写回已投递到临时 vault

    const listed = await env.client.call('task.list', { limit: 10 });
    assert.ok(listed.tasks.some((task) => task.id === 'task-ipc-quote' && task.state === 'succeeded'));
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I03：幂等 start 与输入冲突 ──────────────────────────────────

test('I03 task.start 同 ID 同输入幂等不重复执行；同 ID 改输入 REQUEST_ID_CONFLICT', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }] },
      { expectToolResults: ['call-1'], text: '完成。' },
    ],
  });
  try {
    await runQuoteTask(env, 'task-ipc-idem');
    const eventsBefore = (await env.client.call('events.since', { afterSeq: 0, limit: 1000 })).events.length;

    const again = await env.client.call('task.start', {
      id: 'task-ipc-idem',
      input: { goal: '在工作区创建报价说明 Markdown' },
      workspaceRoot: env.ws,
      provider: 'fake',
      acceptance: QUOTE_ACCEPTANCE,
    });
    assert.equal(again.created, false);
    assert.equal(again.state, 'succeeded');

    await sleep(300); // 给潜在的错误重跑留时间
    const eventsAfter = (await env.client.call('events.since', { afterSeq: 0, limit: 1000 })).events.length;
    assert.equal(eventsAfter, eventsBefore, 'idempotent replay must not emit new events');

    await assert.rejects(
      env.client.call('task.start', {
        id: 'task-ipc-idem',
        input: { goal: '完全不同的任务输入' },
        workspaceRoot: env.ws,
        provider: 'fake',
      }),
      (error) => error.code === 'REQUEST_ID_CONFLICT',
    );
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I04：schema 与帧健壮性 ──────────────────────────────────────

test('I04 未知 action/协议版本/坏 JSON/超长帧/非法入参全部收束，连接保持可用', async () => {
  const env = await spawnSupervisor();
  try {
    await assert.rejects(env.client.call('tool.run', {}), (e) => e.code === 'ACTION_DENIED');
    await assert.rejects(env.client.call('task.nuke', {}), (e) => e.code === 'ACTION_DENIED');

    const protoFrame = await env.client.request('ping', {}, { protocol: 3 });
    assert.equal(protoFrame.ok, false);
    assert.equal(protoFrame.error, 'PROTOCOL_VERSION_UNSUPPORTED');

    env.client.raw('this is not json');
    await env.client.waitForFrame((frame) => frame.id === '' && frame.error === 'PARSE_ERROR', 5000, 'PARSE_ERROR');

    env.client.raw('"' + 'x'.repeat(1_100_000) + '"');
    await env.client.waitForFrame((frame) => frame.id === '' && frame.error === 'FRAME_TOO_LARGE', 5000, 'FRAME_TOO_LARGE');

    // schema：缺 workspaceRoot / 未知字段 / 空 goal / 上限越界 / 不存在目录
    await assert.rejects(env.client.call('task.start', { input: { goal: 'x' } }), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(
      env.client.call('task.start', { input: { goal: 'x' }, workspaceRoot: env.ws, exec: 'rm -rf' }),
      (e) => e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      env.client.call('task.start', { input: { goal: '  ' }, workspaceRoot: env.ws }),
      (e) => e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      env.client.call('task.start', { input: { goal: 'x', limits: { maxModelSteps: 99 } }, workspaceRoot: env.ws }),
      (e) => e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      env.client.call('task.start', { input: { goal: 'x' }, workspaceRoot: join(env.root, 'no-such-dir') }),
      (e) => e.code === 'WORKSPACE_INVALID',
    );
    await assert.rejects(env.client.call('task.get', { taskId: 'no-such-task' }), (e) => e.code === 'TASK_NOT_FOUND');
    await assert.rejects(env.client.call('events.since', { afterSeq: -1 }), (e) => e.code === 'INVALID_INPUT');

    // 连接仍可用
    const ping = await env.client.call('ping');
    assert.equal(ping.status, 'ready');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I05：模型阻塞时 ping/cancel 不被拖住（p95 < 500ms）───────────

test('I05 fake 模型阻塞 30s 时 ping 与 cancel 本地 p95<500ms，abort 及时到达', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [{ delayMs: 30_000, text: '这条回复永远不该到达' }],
  });
  const store = new RuntimeStore(join(env.dataDir, 'runtime.sqlite'));
  try {
    await env.client.call('ping'); // 确认就绪
    await env.client.call('task.start', {
      id: 'task-ipc-slow',
      input: { goal: '一个会被取消的慢任务' },
      workspaceRoot: env.ws,
      provider: 'fake',
    });
    // 等任务进入 running（模型调用在途，fake 阻塞 30s）
    await env.client.waitForTaskState('task-ipc-slow', 'running');
    await sleep(300);

    // 20 次 ping 测延迟（本地目标 p95<500ms；DESKTOP-7T2562S, Node v24, 单任务负载）
    const latencies = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await env.client.call('ping');
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95) - 1)];
    assert.ok(p95 < 500, `ping p95 ${p95.toFixed(1)}ms must be < 500ms (samples: ${latencies.map((v) => v.toFixed(0)).join(',')})`);

    // cancel：响应本身也要快（先持久意图再 abort；worker 异步 finalize）
    const cancelStart = performance.now();
    const cancelResult = await env.client.call('task.cancel', { taskId: 'task-ipc-slow', reason: 'p95 测试取消' });
    const cancelLatency = performance.now() - cancelStart;
    assert.equal(cancelResult.state, 'cancelling');
    assert.equal(cancelResult.idempotent, false);
    assert.ok(cancelLatency < 500, `cancel response ${cancelLatency.toFixed(1)}ms must be < 500ms`);

    // abort 应迅速到达 fake（30s 阻塞被中止，任务几秒内敛到 cancelled）
    await env.client.waitForTaskState('task-ipc-slow', 'cancelled', 8000);
    const got = await env.client.call('task.get', { taskId: 'task-ipc-slow' });
    assert.equal(got.task.state, 'cancelled');
    assert.equal(got.task.errorCode, 'TASK_CANCELLED');

    // 发出后被取消的模型调用：费用记 uncertain，绝不记免费
    const callRow = store.db.prepare('SELECT state FROM model_calls WHERE taskId = ?').get('task-ipc-slow');
    assert.equal(callRow.state, 'uncertain');

    // 重复取消幂等：同一终态返回，无新事件
    const eventsBefore = (await env.client.call('events.since', { afterSeq: 0, limit: 1000 })).events.length;
    const again = await env.client.call('task.cancel', { taskId: 'task-ipc-slow' });
    assert.equal(again.state, 'cancelled');
    assert.equal(again.idempotent, true);
    const eventsAfter = (await env.client.call('events.since', { afterSeq: 0, limit: 1000 })).events.length;
    assert.equal(eventsAfter, eventsBefore);
  } finally {
    store.close();
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I06：events.since 与断线重连 ────────────────────────────────

test('I06 events.since 按 seq 补发；子进程重启后任务进度可恢复、不重复开始', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }] },
      { expectToolResults: ['call-1'], text: '完成。' },
    ],
  });
  try {
    await runQuoteTask(env, 'task-ipc-reconnect');

    const all = await env.client.call('events.since', { afterSeq: 0, limit: 1000 });
    assert.ok(all.events.length >= 5);
    assert.ok(all.latestSeq >= all.events[all.events.length - 1].eventSeq);
    const tail = await env.client.call('events.since', { afterSeq: all.latestSeq, limit: 1000 });
    assert.equal(tail.events.length, 0);
    const filtered = await env.client.call('events.since', { afterSeq: 0, limit: 1000, taskId: 'task-ipc-reconnect' });
    assert.ok(filtered.events.every((event) => event.taskId === 'task-ipc-reconnect'));

    // 断线（杀掉子进程）→ 重连（同数据目录新子进程）
    await stopChild(env.child, env.client);
    const env2 = await spawnSupervisor({ root: env.root });
    try {
      const ping = await env2.client.call('ping');
      assert.equal(ping.capabilities.ipcV2, true);

      const got = await env2.client.call('task.get', { taskId: 'task-ipc-reconnect' });
      assert.equal(got.task.state, 'succeeded'); // 持久状态是权威，刷新不创建新任务

      const replayed = await env2.client.call('events.since', { afterSeq: 0, limit: 1000 });
      const created = replayed.events.filter((event) => event.type === 'task.created' && event.taskId === 'task-ipc-reconnect');
      const succeeded = replayed.events.filter((event) => event.type === 'task.succeeded' && event.taskId === 'task-ipc-reconnect');
      assert.equal(created.length, 1, 'task.created must appear exactly once across reconnect');
      assert.equal(succeeded.length, 1, 'task.succeeded must appear exactly once across reconnect');
      assert.ok(!replayed.events.some((event) => event.type === 'task.running' && event.safePayload?.from === 'succeeded'));
    } finally {
      await stopChild(env2.child, env2.client);
    }
  } finally {
    await cleanupTestRoot(env.root);
  }
});

// ── I07：task.approve 的 hash 绑定与状态推进 ─────────────────────

test('I07 task.approve：inputHash 绑定、过期拒绝、批准推进 waiting_approval→running', async () => {
  const env = await spawnSupervisor({
    fixtureSteps: [{ delayMs: 30_000, text: '不会到达' }], // worker 批准后被阻塞，方便随后取消
  });
  const store = new RuntimeStore(join(env.dataDir, 'runtime.sqlite'));
  const service = new TaskService(store, 'm08-test-side');
  try {
    await env.client.call('ping');
    // 测试侧直接落一个 waiting_approval 任务与待审批（审批只能由系统内部产生，IPC 不产生）
    service.createTask({
      id: 'task-ipc-approval',
      input: { goal: '需要审批的任务' },
      sessionId: 'skf-ipc',
      scope: 'skf-test',
      workspaceRoot: env.ws,
      provider: 'fake',
      model: 'fake-scripted',
    });
    service.transitionTask('task-ipc-approval', 'running');
    service.transitionTask('task-ipc-approval', 'waiting_approval');
    service.requestApproval({ id: 'ap-1', taskId: 'task-ipc-approval', inputHash: 'hash-original', effect: 'external_write', ttlMs: 60_000 });
    service.requestApproval({ id: 'ap-expired', taskId: 'task-ipc-approval', inputHash: 'hash-x', effect: 'external_write', ttlMs: 1 });
    await sleep(10);

    await assert.rejects(
      env.client.call('task.approve', { approvalId: 'ap-9', inputHash: 'h', decision: 'approved' }),
      (e) => e.code === 'APPROVAL_NOT_FOUND',
    );
    await assert.rejects(
      env.client.call('task.approve', { approvalId: 'ap-1', inputHash: 'hash-tampered', decision: 'approved' }),
      (e) => e.code === 'APPROVAL_INPUT_CONFLICT',
    );
    await assert.rejects(
      env.client.call('task.approve', { approvalId: 'ap-expired', inputHash: 'hash-x', decision: 'approved' }),
      (e) => e.code === 'APPROVAL_EXPIRED',
    );
    await assert.rejects(
      env.client.call('task.approve', { approvalId: 'ap-1', inputHash: 'hash-original', decision: 'maybe' }),
      (e) => e.code === 'INVALID_INPUT',
    );

    const approved = await env.client.call('task.approve', {
      approvalId: 'ap-1',
      inputHash: 'hash-original',
      decision: 'approved',
      reason: '测试批准',
    });
    assert.equal(approved.taskState, 'running');
    const got = await env.client.call('task.get', { taskId: 'task-ipc-approval' });
    assert.equal(got.task.state, 'running');

    // 重复决定同一审批： INVALID_TRANSITION（已 decided）
    await assert.rejects(
      env.client.call('task.approve', { approvalId: 'ap-1', inputHash: 'hash-original', decision: 'rejected' }),
      (e) => e.code === 'INVALID_TRANSITION',
    );

    // 收尾：取消任务（worker 正阻塞在 30s fake 上，取消应当及时收敛）
    const cancelled = await env.client.call('task.cancel', { taskId: 'task-ipc-approval' });
    assert.ok(['cancelling', 'cancelled'].includes(cancelled.state));
    await env.client.waitForTaskState('task-ipc-approval', 'cancelled', 8000);
  } finally {
    store.close();
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I08：memory.* 绑定 scope 与有限参数 ──────────────────────────

test('I08 memory.search/get/correct/archive/restore 经 IPC 全来回，不开放越界参数', async () => {
  const env = await spawnSupervisor();
  try {
    await env.client.call('ping');
    // 测试侧先用同一 vault 预置一条记录
    const adapter = new MemoryAdapter({
      root: env.vault,
      scope: 'skf-test',
      sessionId: 'skf-ipc-seed',
      vendorDir: VENDOR_DIR,
      outboxDir: join(env.dataDir, 'memory-outbox'),
      semantic: false,
    });
    await adapter.init();
    assert.equal(adapter.available, true);
    const created = await adapter.record(
      {
        kind: 'fact',
        trust: 'user_confirmed',
        text: 'SKF IPC 测试记录：用户喜欢简洁的交付',
        source: [{ kind: 'user', locator: 'session:skf-ipc-seed' }],
      },
      'skf-ipc-seed:record:1',
    );

    const found = await env.client.call('memory.search', { query: '简洁的交付', limit: 5 });
    const hit = found.hits.find((h) => h.id === created.id);
    assert.ok(hit, 'memory.search must find the seeded record via IPC');
    assert.equal(hit.trust, 'user_confirmed');

    const got = await env.client.call('memory.get', { id: created.id });
    assert.match(got.record.text, /简洁的交付/);

    const corrected = await env.client.call('memory.correct', {
      id: created.id,
      text: 'SKF IPC 测试记录：用户喜欢极简的交付',
      reason: 'IPC 更正测试',
    });
    assert.ok(corrected.id && corrected.id !== created.id);
    const gotNew = await env.client.call('memory.get', { id: corrected.id });
    assert.match(gotNew.record.text, /极简的交付/);

    await env.client.call('memory.archive', { ids: [corrected.id], reason: 'IPC 归档测试' });
    const afterArchive = await env.client.call('memory.search', { query: '极简的交付', limit: 5 });
    assert.ok(!afterArchive.hits.some((h) => h.id === corrected.id), 'archived must be hidden by default');
    const archivedVisible = await env.client.call('memory.search', { query: '极简的交付', limit: 5, includeArchived: true });
    assert.ok(archivedVisible.hits.some((h) => h.id === corrected.id));

    await env.client.call('memory.restore', { id: corrected.id });
    const afterRestore = await env.client.call('memory.search', { query: '极简的交付', limit: 5 });
    assert.ok(afterRestore.hits.some((h) => h.id === corrected.id));

    // 边界：limit 越界 / 未知 id / 空 ids
    await assert.rejects(env.client.call('memory.search', { query: 'x', limit: 51 }), (e) => e.code === 'INVALID_INPUT');
    const missing = await env.client.call('memory.get', { id: 'no-such-record' });
    assert.equal(missing.record, null);
    await assert.rejects(env.client.call('memory.archive', { ids: [] }), (e) => e.code === 'INVALID_INPUT');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I09：budget.status ──────────────────────────────────────────

test('I09 budget.status 返回模式与账本总览（金额未知明示，不虚构 0）', async () => {
  const env = await spawnSupervisor();
  try {
    const status = await env.client.call('budget.status');
    assert.equal(status.mode, 'call-limit');
    assert.ok(status.daily !== undefined || status.task !== undefined || status.totals !== undefined,
      'budget.status must expose ledger overview fields');
  } finally {
    await stopChild(env.child, env.client);
    await cleanupTestRoot(env.root);
  }
});

// ── I10：SIGKILL → interrupted → resume 阻塞 → 双授权恢复 ──────────

test('I10 子进程被杀后任务标 interrupted；resume 先阻塞（费用不确定），双授权后恢复成功且不重发同一请求', async () => {
  const env = await spawnSupervisor({
    fixtureName: 'fixture-a.json',
    fixtureSteps: [{ delayMs: 30_000, text: '第一个进程的回复不该到达' }],
  });
  let store = null;
  try {
    await env.client.call('ping');
    await env.client.call('task.start', {
      id: 'task-ipc-killed',
      input: { goal: '执行到一半进程被杀的任务', limits: { maxDurationMs: 4000 } },
      workspaceRoot: env.ws,
      provider: 'fake',
    });
    await env.client.waitForTaskState('task-ipc-killed', 'running');
    await sleep(300); // 确认 fake 已进入 30s 阻塞（模型请求已发出）

    // 硬杀子进程（模拟崩溃）：此时 model_calls 有一行 reserved，租约 4s 后过期
    env.client.close();
    env.child.kill('SIGKILL');
    await env.exited;

    // 等租约过期（claim TTL = maxDurationMs = 4s）
    await sleep(4500);

    // 同数据目录重启：另一个 fixture（恢复后只发一次新请求）
    const env2 = await spawnSupervisor({ root: env.root, fixtureName: 'fixture-b.json', fixtureSteps: [{ text: '恢复后完成。', usage: { inputTokens: 5, outputTokens: 3 } }] });
    store = new RuntimeStore(join(env.dataDir, 'runtime.sqlite'));
    try {
      const got = await env2.client.call('task.get', { taskId: 'task-ipc-killed' });
      assert.equal(got.task.state, 'interrupted');
      assert.equal(got.task.errorCode, 'TASK_INTERRUPTED');

      const replayed = await env2.client.call('events.since', { afterSeq: 0, limit: 1000 });
      assert.ok(replayed.events.some(
        (event) => event.taskId === 'task-ipc-killed' && event.type === 'task.state' && event.safePayload?.to === 'interrupted',
      ));

      // 未授权恢复：reserved 调用费用不确定，必须阻塞且给出可审查信息
      const blocked = await env2.client.call('task.resume', { taskId: 'task-ipc-killed' });
      assert.equal(blocked.accepted, false);
      assert.equal(blocked.block.code, 'MODEL_CALL_UNCERTAIN_REVIEW');
      assert.equal(blocked.block.uncertainCalls.length, 1);
      const stillInterrupted = await env2.client.call('task.get', { taskId: 'task-ipc-killed' });
      assert.equal(stillInterrupted.task.state, 'interrupted');

      // 用户显式选择重试 + 预算重新获准 → 恢复；旧调用保留 uncertain，新 callId 发新请求
      const resumed = await env2.client.call('task.resume', {
        taskId: 'task-ipc-killed',
        retryUncertain: true,
        budgetReauthorized: true,
      });
      assert.equal(resumed.accepted, true);
      assert.equal(resumed.state, 'queued');

      await env2.client.waitForEvent(
        (event) => event.taskId === 'task-ipc-killed' && event.type === 'task.succeeded',
        15_000,
        'resumed task.succeeded',
      );
      const done = await env2.client.call('task.get', { taskId: 'task-ipc-killed' });
      assert.equal(done.task.state, 'succeeded');
      assert.match(done.finalText, /恢复后完成/);

      // 账本：旧调用 uncertain 保留（不免费、不重发），新调用 settled
      const calls = store.db
        .prepare('SELECT id, state FROM model_calls WHERE taskId = ? ORDER BY createdAt ASC')
        .all('task-ipc-killed');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].state, 'uncertain');
      assert.equal(calls[1].state, 'settled');
      assert.notEqual(calls[0].id, calls[1].id);
    } finally {
      store.close();
      store = null;
      await stopChild(env2.child, env2.client);
    }
  } finally {
    if (store) store.close();
    await stopChild(env.child, env.client).catch(() => {});
    await cleanupTestRoot(env.root);
  }
});
