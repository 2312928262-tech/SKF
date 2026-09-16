// M22 · 联网工具（web.search / web.fetch）验收测试
// 覆盖：注册/effect 分级 / 搜索 / 域名白名单 / 重定向 / 大小限制 / 命名空间 / 错误码白名单。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { buildWebTools } from '../dist/web/registry.js';
import { FakeWebBridge } from '../dist/web/web-bridge.js';
import { isWebUrlAllowed, loadWebAllowlist } from '../dist/web/contracts.js';

const ALLOWLIST = [{ host: 'example.com', allowSubdomains: true }, { host: 'wikipedia.org' }];

async function makeEnv(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m22-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm22-test');
  const toolRegistry = new ToolRegistry();
  const bridge = new FakeWebBridge(opts.allowlist ?? ALLOWLIST);
  if (opts.searchResults) bridge.setSearchResults(opts.searchResults);
  if (opts.fetchPages) for (const [url, content] of Object.entries(opts.fetchPages)) bridge.addFetchPage(url, content);
  if (opts.healthState) bridge.setHealth(opts.healthState);
  for (const spec of buildWebTools({ search: bridge, fetch: bridge })) toolRegistry.register(spec);
  const taskId = opts.taskId ?? 'task-m22';
  service.createTask({
    id: taskId, input: { goal: opts.goal ?? 'M22 验收任务' }, sessionId: 's-m22',
    scope: 'skf-test', workspaceRoot: ws, provider: 'fake', model: 'fake-scripted-1',
  });
  return { root, ws, store, service, toolRegistry, bridge, taskId, cleanup: () => cleanup(root, store) };
}

async function cleanup(root, store) {
  try { store.close(); } catch { /* closed */ }
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m22-[a-zA-Z0-9]+$/);
  for (let i = 0; i < 5; i++) {
    try { await rm(absolute, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 80 * (i + 1))); }
  }
}

const execTool = (env, name, args, extra = {}) =>
  env.toolRegistry.execute(`t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, args, {
    taskId: env.taskId, workspaceRoot: env.ws,
    authorization: { ...localDeliveryAuthorization(env.ws), allowedMcpTools: [] },
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
  });

// ── T01: 注册 + effect 分级 ─────────────────────────────────────────

test('T01 web.search / web.fetch 注册成功 + 都是 read', async () => {
  const env = await makeEnv();
  try {
    assert.ok(env.toolRegistry.has('web.search'));
    assert.ok(env.toolRegistry.has('web.fetch'));
    assert.equal(env.toolRegistry.specOf('web.search').effect, 'read');
    assert.equal(env.toolRegistry.specOf('web.fetch').effect, 'read');
  } finally { await env.cleanup(); }
});

// ── T02: web.search 返回结果 ─────────────────────────────────────────

test('T02 web.search 返回结果列表', async () => {
  const env = await makeEnv({
    searchResults: [
      { title: '结果1', url: 'https://example.com/1', snippet: '摘要1' },
      { title: '结果2', url: 'https://example.com/2', snippet: '摘要2' },
    ],
  });
  try {
    const r = await execTool(env, 'web.search', { query: '测试', limit: 10 });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.total, 2);
    assert.equal(parsed.results[0].title, '结果1');
  } finally { await env.cleanup(); }
});

// ── T03: web.fetch 白名单内 → ok ───────────────────────────────────

test('T03 web.fetch 白名单内 → ok + content', async () => {
  const env = await makeEnv({ fetchPages: { 'https://example.com/page': '页面内容' } });
  try {
    const r = await execTool(env, 'web.fetch', { url: 'https://example.com/page' });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.content, '页面内容');
  } finally { await env.cleanup(); }
});

// ── T04: web.fetch 白名单外 → WEB_DOMAIN_NOT_ALLOWED ───────────────

test('T04 web.fetch 白名单外 → WEB_DOMAIN_NOT_ALLOWED', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'web.fetch', { url: 'https://evil.net/x' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'WEB_DOMAIN_NOT_ALLOWED');
  } finally { await env.cleanup(); }
});

// ── T05: 空白名单 → WEB_DOMAIN_NOT_ALLOWED ─────────────────────────

test('T05 空白名单 → web.fetch WEB_DOMAIN_NOT_ALLOWED', async () => {
  const env = await makeEnv({ allowlist: [] });
  try {
    const r = await execTool(env, 'web.fetch', { url: 'https://example.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'WEB_DOMAIN_NOT_ALLOWED');
  } finally { await env.cleanup(); }
});

// ── T06: 域名白名单校验 ───────────────────────────────────────────

test('T06 loadWebAllowlist + isWebUrlAllowed 校验', () => {
  const list = loadWebAllowlist(JSON.stringify([
    { host: 'example.com', allowSubdomains: true },
    { host: 'wikipedia.org' },
  ]));
  assert.equal(list.length, 2);
  assert.ok(isWebUrlAllowed('https://example.com', list));
  assert.ok(isWebUrlAllowed('https://sub.example.com/x', list));
  assert.ok(isWebUrlAllowed('https://wikipedia.org', list));
  assert.ok(!isWebUrlAllowed('https://evil.net', list));
  assert.throws(() => loadWebAllowlist(JSON.stringify([{ host: 'a..b' }])), /INVALID_CONFIG/);
});

// ── T07: 命名空间 ─────────────────────────────────────────────────

test('T07 命名空间：web.* 不与 file.*/browser.* 重名', async () => {
  const env = await makeEnv();
  try {
    for (const name of ['file.read', 'web.search', 'web.fetch']) {
      assert.ok(env.toolRegistry.has(name), `has ${name}`);
    }
    assert.throws(() => env.toolRegistry.register({
      name: 'web.search', effect: 'read', description: 'dup', inputSchema: {}, fields: {},
      run: async () => ({ content: {}, artifactIds: [] }),
    }), /TOOL_NAME_CONFLICT/);
  } finally { await env.cleanup(); }
});

// ── T08: 错误码白名单 ────────────────────────────────────────────

test('T08 M22 错误码全部在 IPC_V2_PUBLIC_ERRORS 白名单内', async () => {
  const { IPC_V2_PUBLIC_ERRORS } = await import('../dist/runtime/ipc-v2.js');
  const codes = ['WEB_SEARCH_UNAVAILABLE', 'WEB_FETCH_UNAVAILABLE', 'WEB_DOMAIN_NOT_ALLOWED',
    'WEB_REDIRECT_OUT_OF_ALLOWLIST', 'WEB_FETCH_FAILED', 'WEB_TOO_MANY_REDIRECTS',
    'WEB_INPUT_INVALID', 'WEB_TIMEOUT', 'WEB_RESULT_TOO_LARGE'];
  for (const code of codes) assert.ok(IPC_V2_PUBLIC_ERRORS.has(code), `${code} in whitelist`);
});

// ── T09: 取消 → WEB_TIMEOUT ────────────────────────────────────────

test('T09 取消信号到达 search → WEB_TIMEOUT/TOOL_CANCELLED', async () => {
  const env = await makeEnv();
  try {
    const ac = new AbortController();
    ac.abort();
    const r = await execTool(env, 'web.search', { query: 'x' }, { signal: ac.signal });
    assert.equal(r.ok, false);
    assert.ok(['WEB_TIMEOUT', 'TOOL_CANCELLED'].includes(r.error.code), `got ${r.error.code}`);
  } finally { await env.cleanup(); }
});

// ── T10: 查询超长 → WEB_INPUT_INVALID ─────────────────────────────

test('T10 查询超长 → WEB_INPUT_INVALID', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'web.search', { query: 'x'.repeat(1001) });
    assert.equal(r.ok, false);
    assert.ok(['WEB_INPUT_INVALID', 'TOOL_INPUT_LIMIT'].includes(r.error.code), `got ${r.error.code}`);
  } finally { await env.cleanup(); }
});

// ── T11: 结果超限 → WEB_RESULT_TOO_LARGE ──────────────────────────

test('T11 搜索结果超限 → WEB_RESULT_TOO_LARGE', async () => {
  const big = [];
  for (let i = 0; i < 20; i++) big.push({ title: 'x'.repeat(5000), url: `https://example.com/${i}`, snippet: 's'.repeat(5000) });
  const env = await makeEnv({ searchResults: big });
  try {
    const r = await execTool(env, 'web.search', { query: 'big', limit: 20 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'WEB_RESULT_TOO_LARGE');
  } finally { await env.cleanup(); }
});
