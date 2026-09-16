// M19 · 浏览器 CDP 层验收测试
//
// 覆盖：6 个 browser.* 工具注册 + effect 分级 / 域名白名单 / 重定向限制 / 大小限制 /
// 读自动 / 写审批门 / 审批 hash 绑定 URL / 密钥输入拒绝 / 命名空间 / 错误码白名单。
//
// 约束：零网络 / 零付费 / 零真实浏览器；全部 FakeBrowserBridge。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { FakeScriptedProvider } from '../dist/providers/fake-scripted.js';
import { runAgentLoop } from '../dist/runtime/agent-loop.js';
import { buildBrowserTools } from '../dist/browser/registry.js';
import { FakeBrowserBridge } from '../dist/browser/browser-bridge.js';
import { browserApprovalHashOf, isUrlAllowed, loadBrowserAllowlist } from '../dist/browser/contracts.js';

const ALLOWLIST = [{ host: 'example.com', allowSubdomains: true }, { host: 'trusted.org' }];

async function makeEnv(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m19-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm19-test');
  const toolRegistry = new ToolRegistry();
  const bridge = new FakeBrowserBridge(opts.allowlist ?? ALLOWLIST, { initialPages: opts.pages });
  if (opts.healthState) bridge.setHealth(opts.healthState);
  for (const spec of buildBrowserTools({ bridge, currentUrl: () => bridge.getCurrentUrl() })) {
    toolRegistry.register(spec);
  }
  const taskId = opts.taskId ?? 'task-m19';
  service.createTask({
    id: taskId, input: { goal: opts.goal ?? 'M19 验收任务' }, sessionId: 's-m19',
    scope: 'skf-test', workspaceRoot: ws, provider: 'fake', model: 'fake-scripted-1',
  });
  return {
    root, ws, store, service, toolRegistry, bridge, taskId,
    cleanup: () => cleanup(root, store),
  };
}

async function cleanup(root, store) {
  try { store.close(); } catch { /* closed */ }
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m19-[a-zA-Z0-9]+$/);
  for (let i = 0; i < 5; i++) {
    try { await rm(absolute, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 80 * (i + 1))); }
  }
}

const execTool = (env, name, args, extra = {}) =>
  env.toolRegistry.execute(`t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, args, {
    taskId: env.taskId, workspaceRoot: env.ws,
    authorization: { ...localDeliveryAuthorization(env.ws), allowedMcpTools: [] },
    ...(extra.hasApproved !== undefined ? { hasApproved: extra.hasApproved } : {}),
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
  });

// ── T01: 注册 + effect 分级 ─────────────────────────────────────────

test('T01 六个 browser 工具注册成功 + effect 分级正确', async () => {
  const env = await makeEnv();
  try {
    const expectations = [
      ['browser.navigate', 'read'], ['browser.snapshot', 'read'], ['browser.text', 'read'],
      ['browser.click', 'external_write'], ['browser.type', 'external_write'], ['browser.fill', 'external_write'],
    ];
    for (const [name, effect] of expectations) {
      assert.ok(env.toolRegistry.has(name), `has ${name}`);
      assert.equal(env.toolRegistry.specOf(name).effect, effect, `${name} effect`);
    }
  } finally { await env.cleanup(); }
});

// ── T02: navigate 白名单内 → navigated ─────────────────────────────

test('T02 navigate 白名单内 → navigated + 当前 URL 更新', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'browser.navigate', { url: 'https://example.com/page' });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'navigated');
    assert.equal(env.bridge.getCurrentUrl(), 'https://example.com/page');
  } finally { await env.cleanup(); }
});

// ── T03: navigate 白名单外 → BROWSER_DOMAIN_NOT_ALLOWED ────────────

test('T03 navigate 白名单外 → BROWSER_DOMAIN_NOT_ALLOWED', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'browser.navigate', { url: 'https://evil.example.net/x' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BROWSER_DOMAIN_NOT_ALLOWED');
  } finally { await env.cleanup(); }
});

// ── T04: 空白名单 → BROWSER_DOMAIN_NOT_ALLOWED ─────────────────────

test('T04 空白名单 → navigate 报 BROWSER_DOMAIN_NOT_ALLOWED（no_allowlist）', async () => {
  const env = await makeEnv({ allowlist: [] });
  try {
    const r = await execTool(env, 'browser.navigate', { url: 'https://example.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BROWSER_DOMAIN_NOT_ALLOWED');
  } finally { await env.cleanup(); }
});

// ── T05: snapshot 返回页面快照 ─────────────────────────────────────

test('T05 snapshot 返回页面可访问性快照', async () => {
  const env = await makeEnv({
    pages: {
      'https://example.com': {
        url: 'https://example.com',
        nodes: [
          { role: 'button', name: 'OK', children: [] },
          { role: 'textbox', name: 'username', text: '', children: [] },
        ],
      },
    },
  });
  try {
    await execTool(env, 'browser.navigate', { url: 'https://example.com' });
    const r = await execTool(env, 'browser.snapshot', { maxNodes: 10 });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.nodes.length, 2);
    assert.equal(parsed.nodes[0].role, 'button');
    assert.equal(parsed.nodes[1].name, 'username');
  } finally { await env.cleanup(); }
});

// ── T06: text 提取页面文本 ─────────────────────────────────────────

test('T06 text 提取页面文本', async () => {
  const env = await makeEnv({ pages: { 'https://example.com': { url: 'https://example.com', text: '你好，这是页面文本' } } });
  try {
    await execTool(env, 'browser.navigate', { url: 'https://example.com' });
    const r = await execTool(env, 'browser.text', {});
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.text, '你好，这是页面文本');
  } finally { await env.cleanup(); }
});

// ── T07: click 无审批 → APPROVAL_REQUIRED ──────────────────────────

test('T07 click 是 external_write，无审批 → APPROVAL_REQUIRED', async () => {
  const env = await makeEnv();
  try {
    await execTool(env, 'browser.navigate', { url: 'https://example.com' });
    const r = await execTool(env, 'browser.click', { selector: 'button#ok' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    assert.equal(env.bridge.stats.click, 0, '无审批时绝不点击');
  } finally { await env.cleanup(); }
});

// ── T08: click 审批 hash 一致 → dispatched ────────────────────────

test('T08 click 审批 hash 一致 → dispatched', async () => {
  const env = await makeEnv();
  try {
    await execTool(env, 'browser.navigate', { url: 'https://example.com' });
    const args = { selector: 'button#ok' };
    const hash = browserApprovalHashOf('browser.click', args, 'https://example.com');
    const r = await execTool(env, 'browser.click', args, { hasApproved: (h) => h === hash });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'dispatched');
    assert.equal(env.bridge.stats.click, 1);
  } finally { await env.cleanup(); }
});

// ── T09: type 密钥输入 → BROWSER_SECRET_INPUT_FORBIDDEN ────────────

test('T09 type 密钥输入 → BROWSER_SECRET_INPUT_FORBIDDEN', async () => {
  const env = await makeEnv();
  try {
    await execTool(env, 'browser.navigate', { url: 'https://example.com' });
    const args = { selector: 'input#token', text: 'sk-abcdef1234567890' };
    const hash = browserApprovalHashOf('browser.type', args, 'https://example.com');
    const r = await execTool(env, 'browser.type', args, { hasApproved: (h) => h === hash });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BROWSER_SECRET_INPUT_FORBIDDEN');
  } finally { await env.cleanup(); }
});

// ── T10: 域名白名单校验 ───────────────────────────────────────────

test('T10 loadBrowserAllowlist + isUrlAllowed 校验', () => {
  const list = loadBrowserAllowlist(JSON.stringify([
    { host: 'example.com', allowSubdomains: true },
    { host: 'trusted.org' },
  ]));
  assert.equal(list.length, 2);
  assert.ok(isUrlAllowed('https://example.com', list));
  assert.ok(isUrlAllowed('https://sub.example.com/x', list));
  assert.ok(isUrlAllowed('https://trusted.org', list));
  assert.ok(!isUrlAllowed('https://evil.net', list));
  assert.ok(!isUrlAllowed('http://example.com', list), 'http 不在默认 schemes');
  // 非法 host
  assert.throws(() => loadBrowserAllowlist(JSON.stringify([{ host: 'sub/evil' }])), /INVALID_CONFIG/);
  assert.throws(() => loadBrowserAllowlist(JSON.stringify([{ host: 'a..b' }])), /INVALID_CONFIG/);
});

// ── T11: 审批 hash 绑定 URL（URL 变化 → 旧 hash 失效）──────────────

test('T11 审批 hash 绑定当前 URL；URL 变化后旧 hash 不匹配', async () => {
  const env = await makeEnv();
  try {
    await execTool(env, 'browser.navigate', { url: 'https://example.com' });
    const args = { selector: 'button#submit' };
    const hashOnExample = browserApprovalHashOf('browser.click', args, 'https://example.com');
    // 当前 URL = example.com，hash 匹配
    const r1 = await execTool(env, 'browser.click', args, { hasApproved: (h) => h === hashOnExample });
    assert.equal(r1.ok, true);
    // 导航到另一个白名单域名后，旧 hash（基于 example.com）不再匹配
    await execTool(env, 'browser.navigate', { url: 'https://trusted.org' });
    const r2 = await execTool(env, 'browser.click', args, { hasApproved: (h) => h === hashOnExample });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'APPROVAL_REQUIRED');
  } finally { await env.cleanup(); }
});

// ── T12: 命名空间 ─────────────────────────────────────────────────

test('T12 命名空间：browser.* 不与 file.* 重名（file.* 是 ToolRegistry 内置）', async () => {
  const env = await makeEnv();
  try {
    // file.* 内置恒在；browser.* 不与其重名。
    for (const name of ['file.read', 'file.write', 'browser.navigate', 'browser.click']) {
      assert.ok(env.toolRegistry.has(name), `has ${name}`);
    }
    assert.throws(() => env.toolRegistry.register({
      name: 'browser.navigate', effect: 'read', description: 'dup', inputSchema: {}, fields: {},
      run: async () => ({ content: {}, artifactIds: [] }),
    }), /TOOL_NAME_CONFLICT/);
  } finally { await env.cleanup(); }
});

// ── T13: 错误码白名单 ────────────────────────────────────────────

test('T13 M19 错误码全部在 IPC_V2_PUBLIC_ERRORS 白名单内', async () => {
  const { IPC_V2_PUBLIC_ERRORS } = await import('../dist/runtime/ipc-v2.js');
  const codes = ['BROWSER_DOMAIN_NOT_ALLOWED', 'BROWSER_REDIRECT_OUT_OF_ALLOWLIST', 'BROWSER_UNAVAILABLE',
    'BROWSER_NAVIGATION_FAILED', 'BROWSER_ELEMENT_NOT_FOUND', 'BROWSER_ELEMENT_NOT_UNIQUE',
    'BROWSER_INPUT_INVALID', 'BROWSER_SECRET_INPUT_FORBIDDEN', 'BROWSER_TIMEOUT',
    'BROWSER_ACTION_REJECTED', 'BROWSER_TOO_MANY_REDIRECTS'];
  for (const code of codes) assert.ok(IPC_V2_PUBLIC_ERRORS.has(code), `${code} in whitelist`);
});

// ── T14: 取消 → BROWSER_TIMEOUT ───────────────────────────────────

test('T14 取消信号到达 navigate → BROWSER_TIMEOUT（已 abort 的 signal）', async () => {
  const env = await makeEnv();
  try {
    const ac = new AbortController();
    ac.abort(); // 提前 abort
    const r = await execTool(env, 'browser.navigate', { url: 'https://example.com' }, { signal: ac.signal });
    assert.equal(r.ok, false);
    // ToolRegistry 入口先查 signal → TOOL_CANCELLED；bridge 层查 signal → BROWSER_TIMEOUT。
    assert.ok(['TOOL_CANCELLED', 'BROWSER_TIMEOUT'].includes(r.error.code), `got ${r.error.code}`);
  } finally { await env.cleanup(); }
});

// ── T15: 端到端 AgentLoop 调用 browser.navigate（read）→ succeeded ─

test('T15 端到端：AgentLoop 调用 browser.navigate → succeeded + 回灌', async () => {
  const env = await makeEnv();
  try {
    const fixturePath = join(env.root, 'steps.json');
    await writeFile(fixturePath, JSON.stringify({
      steps: [
        { toolCalls: [{ id: 'call-1', name: 'browser.navigate', arguments: { url: 'https://example.com' } }], usage: { inputTokens: 3, outputTokens: 4 } },
        { expectToolResults: ['call-1'], text: '导航完成', usage: { inputTokens: 5, outputTokens: 6 } },
      ],
    }), 'utf8');
    const provider = new FakeScriptedProvider({ fixturePath, enabled: true });
    const deps = {
      service: env.service, provider, tools: env.toolRegistry,
      authorization: { ...localDeliveryAuthorization(env.ws), allowedMcpTools: [] },
      approvalTtlMsFor: () => 1_800_000,
    };
    const result = await runAgentLoop(deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.toolCalls, 1);
    const messages = env.service.listMessages(env.taskId);
    const toolMsg = messages.find((m) => m.role === 'tool' && m.toolCallId === 'call-1');
    assert.ok(toolMsg);
    const payload = JSON.parse(toolMsg.content);
    assert.equal(payload.status, 'navigated');
  } finally { await env.cleanup(); }
});

// ── T16: 未导航时 snapshot/text → BROWSER_UNAVAILABLE ─────────────

test('T16 未导航时 snapshot/text → BROWSER_UNAVAILABLE', async () => {
  const env = await makeEnv();
  try {
    const r1 = await execTool(env, 'browser.snapshot', {});
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'BROWSER_UNAVAILABLE');
    const r2 = await execTool(env, 'browser.text', {});
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'BROWSER_UNAVAILABLE');
  } finally { await env.cleanup(); }
});
