import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { TaskStore } from '../dist/runtime/task-store.js';
import { ChatService } from '../dist/runtime/chat-service.js';
import { estimateAstraCost } from '../dist/runtime/usage.js';
import { FactExtractor } from '../dist/memory/extractor.js';

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  const relative = absolute.slice(base.length + 1);
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(relative, /^skf-(ipc|tasks)-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

const entry = process.env.SKF_TEST_ENTRY || resolve(import.meta.dirname, '../dist/supervisor.js');
function start(root) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { NODE_ENV: 'test', SKF_SKIP_ENV: '1', SKF_DATA_DIR: join(root, 'data'),
    XIAOLIU_PROVIDER: 'mock', SKF_ALLOW_MOCK: '1',
    SKF_MEMORY_ROOT: join(root, 'vault'), SKF_MEMORY_SEMANTIC: '0',
    // M13：旧 e2e 不覆盖学习闭环；后台复盘泵会拉长子进程退出窗口（EBUSY 竞态），钉死关闭。
    SKF_LEARNING: '0' });
  const child = spawn(process.env.SKF_TEST_NODE || process.execPath, [entry, '--ipc'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const requests = new Map();
  let stderr = '';
  child.stderr.on('data', b => stderr += b);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    // A single non-JSON debug line on stdout fails the test.
    const reply = JSON.parse(line);
    const pending = requests.get(reply.id);
    if (pending) { requests.delete(reply.id); pending(reply); }
  });
  let seq = 0;
  return {
    child,
    rpc(action, data = {}, id = 'request-' + ++seq) {
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => reject(new Error('IPC_TIMEOUT: ' + stderr.slice(-300))), 10000);
        requests.set(id, value => { clearTimeout(timer); resolveReply(value); });
        child.stdin.write(JSON.stringify({ id, action, data }) + '\n');
      });
    },
    async close() {
      const ended = once(child, 'exit');
      child.stdin.end();
      await ended;
      lines.close();
    },
  };
}

test('desktop IPC persists chat, survives restart, rejects duplicates and stays responsive', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-ipc-'));
  let worker = start(root);
  try {
    const ping = await worker.rpc('ping');
    assert.equal(ping.data.provider, 'mock');
    assert.equal(ping.data.configured, false);
    const pending = worker.rpc('chat', { message: 'remember this unique sample' }, 'durable-1');
    const health = await worker.rpc('ping');
    assert.equal(health.data.busy, true);
    assert.equal((await worker.rpc('chat', { message: 'second' })).error, 'BUSY');
    const first = await pending;
    assert.equal(first.ok, true);
    assert.equal((await worker.rpc('chat', { message: 'remember this unique sample' }, 'durable-1')).data.text, first.data.text);
    assert.equal((await worker.rpc('chat', { message: 'changed' }, 'durable-1')).error, 'REQUEST_ID_CONFLICT');
    assert.equal((await worker.rpc('history')).data.tasks.length, 1);
    // M01：新通道只写统一主档。主档 writeback-queue 有已完成写回；
    // 旧 L1-L5（SKF_DATA_DIR/memory/02-work 等）不再创建、不双写。
    const writebacks = await readdir(join(root, 'vault', 'writeback-queue'));
    assert.ok(writebacks.filter((x) => x.endsWith('.done.json')).length >= 1, 'expected committed writeback in vault');
    assert.equal(existsSync(join(root, 'data', 'memory')), false, 'legacy L1-L5 store must not be created');
    assert.equal((await worker.rpc('provider', { name: 'astra' })).error, 'PROVIDER_UNAVAILABLE');
    assert.equal((await worker.rpc('execute', {})).error, 'ACTION_DENIED');
    await worker.close();
    worker = start(root);
    assert.equal((await worker.rpc('history')).data.tasks[0].text, first.data.text);
    assert.equal((await worker.rpc('chat', { message: 'remember this unique sample' }, 'durable-1')).data.text, first.data.text);
    assert.equal((await worker.rpc('history')).data.tasks.length, 1);
    assert.deepEqual((await readdir(root)).sort(), ['data', 'vault']);
  } finally {
    await worker.close();
    // Only delete the exact directory allocated by mkdtemp for this test.
    await cleanupTestRoot(root);
  }
});

test('interrupted tasks do not auto-run; cloud quota includes attempted requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-tasks-'));
  try {
    const original = new TaskStore(root);
    await original.init();
    await original.save({ id: 'interrupted', message: 'old', provider: 'astra', status: 'running', startedAt: new Date().toISOString() });
    const store = new TaskStore(root);
    await store.init();
    let calls = 0;
    const service = new ChatService({ store, provider: () => 'astra', maxDailyCloudCalls: 1,
      think: async () => { calls++; throw new Error('must not run'); }, remember: async () => {} });
    await assert.rejects(service.chat('interrupted', 'old'), /TASK_INTERRUPTED/);
    await assert.rejects(service.chat('new', 'new message'), /DAILY_CALL_LIMIT/);
    assert.equal(calls, 0);
    assert.equal(store.history()[0].status, 'interrupted');
  } finally { await cleanupTestRoot(root); }
});

test('missing tariffs stay unknown and cached input uses its own configured rate', () => {
  const keys = ['SKF_ASTRA_INPUT_USD_PER_M', 'SKF_ASTRA_OUTPUT_USD_PER_M', 'SKF_ASTRA_CACHED_USD_PER_M'];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(estimateAstraCost(1000, 100, 500), undefined);
    process.env[keys[0]] = '10'; process.env[keys[1]] = '50';
    assert.equal(estimateAstraCost(1000, 100, 500), undefined);
    process.env[keys[2]] = '1';
    assert.equal(estimateAstraCost(1000, 100, 500), 0.0105);
  } finally { keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]); }
});

test('saved facts remain searchable without any cloud credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-tasks-'));
  try {
    const facts = new FactExtractor({ model:'unused', factsDir:root });
    await facts.init();
    await writeFile(join(root, 'facts.jsonl'), JSON.stringify({ id:'fact-1', text:'offline sample', category:'project', verified:true }) + '\n');
    assert.equal((await facts.query({ keyword:'offline' }))[0].text, 'offline sample');
    await assert.rejects(facts.extractFromTurn('hello', 'hi', '1'), /FACT_EXTRACTION_NOT_CONFIGURED/);
  } finally { await cleanupTestRoot(root); }
});
