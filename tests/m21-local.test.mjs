// M21 · local provider 适配器验收测试
// 覆盖：LocalProvider capabilities / complete 走 OpenAI 兼容（本地 HTTP server）/
// 零成本计费口径（ModelGateway local=true 不耗金额）/ brain 注册 local。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { LocalProvider } from '../dist/providers/local.js';
import { ModelGateway } from '../dist/runtime/model-gateway.js';

async function startFakeLocalServer() {
  let callCount = 0;
  const server = createServer((req, res) => {
    if (req.url && req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-model' }] }));
      return;
    }
    if (req.url && req.url.includes('/chat/completions')) {
      callCount++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-local-1',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'local-reply' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    getCallCount: () => callCount,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function cleanup(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  for (let i = 0; i < 5; i++) {
    try { await rm(absolute, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 80 * (i + 1))); }
  }
}

test('T01 LocalProvider capabilities', async () => {
  const p = new LocalProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'local-model' });
  const caps = await p.capabilities();
  assert.equal(caps.tools, true);
  assert.equal(caps.streaming, true);
  assert.equal(caps.usage, true);
  assert.equal(caps.contextWindowTokens, null);
  assert.equal(p.modelName, 'local-model');
});

test('T02 LocalProvider.complete 走 OpenAI 兼容端点', async () => {
  const env = await startFakeLocalServer();
  try {
    const p = new LocalProvider({ baseUrl: env.baseUrl, model: 'local-model' });
    const ac = new AbortController();
    const result = await p.complete({
      callId: 'c1', taskId: 't1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [], maxOutputTokens: 512,
      signal: ac.signal, deadlineAt: Date.now() + 60_000,
    });
    assert.equal(result.provider, 'local');
    assert.equal(result.model, 'local-model');
    assert.equal(result.assistant.content, 'local-reply');
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 5);
    assert.equal(result.usage.cachedInputTokens, 2);
    assert.equal(env.getCallCount(), 1);
  } finally { await env.close(); }
});

test('T03 LocalProvider.complete 工具调用解析', async () => {
  let receivedTools = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      receivedTools = parsed.tools;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-local-2',
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'file.write', arguments: '{"path":"a.md","content":"x"}' } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const p = new LocalProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'local-model' });
    const ac = new AbortController();
    const result = await p.complete({
      callId: 'c2', taskId: 't2',
      messages: [{ role: 'user', content: 'write file' }],
      tools: [{ name: 'file.write', description: 'd', inputSchema: { type: 'object' }, effect: 'workspace_write', timeoutMs: 30000, maxOutputBytes: 96000 }],
      maxOutputTokens: 512, signal: ac.signal, deadlineAt: Date.now() + 60_000,
    });
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.assistant.toolCalls.length, 1);
    assert.equal(result.assistant.toolCalls[0].name, 'file.write');
    assert.deepEqual(result.assistant.toolCalls[0].arguments, { path: 'a.md', content: 'x' });
    assert.ok(receivedTools, 'tools passed to endpoint');
    assert.equal(receivedTools[0].function.name, 'file.write');
  } finally { await new Promise((r) => server.close(r)); }
});

test('T04 ModelGateway local=true 不耗金额不计云调用次数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m21-'));
  try {
    const store = new RuntimeStore(join(root, 'runtime.sqlite'));
    const service = new TaskService(store, 'm21');
    const gateway = new ModelGateway({
      store, service,
      config: { mode: 'call-limit', defaultProvider: 'local', expensiveProviders: new Set(['astra']), maxRetries: 0, dailyCallLimit: 10 },
      logger: () => {},
    });
    const p = new LocalProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'local-model' });
    gateway.registerProvider({ name: 'local', adapter: p, model: 'local-model', local: true, verified: false });
    const status = gateway.status();
    assert.equal(status.daily.calls, 0, 'local provider not counted in cloud calls');
    store.close();
  } finally { await cleanup(root); }
});

test('T05 Brain 在 SKF_LOCAL=1 时注册 local provider', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.SKF_LOCAL = '1';
    process.env.SKF_LOCAL_BASE_URL = 'http://127.0.0.1:1/v1';
    const { Brain } = await import('./dist/brain.js');
    const b = new Brain({ provider: 'local', systemPrompt: '', debug: false });
    const list = b.listProviders();
    if (!list.includes('local')) throw new Error('local not registered: ' + list.join(','));
    if (b.adapterFor('local') === null) throw new Error('local adapter null');
    console.log('OK');
  `], { cwd: 'D:/SKF-Work/dev', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});
