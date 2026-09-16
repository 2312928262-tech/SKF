// M17 · 桌面工具层验收测试
//
// 全覆盖：FakeUiaBridge / FakeClipboardBridge / FakeLauncherBridge + DesktopRegistry
// → ToolRegistry.execute 端到端（含 schema 严格校验 / 取消 / 命名空间 / 审批 hash /
//   POLICY_DENIED / TOOL_ARGS_INVALID / TOOL_INPUT_LIMIT）。
//
// 约束：零网络 / 零付费 / 零真实 Windows UIA 调用；全部 fake。
// 隔离副本 D:/SKF-Work/dev；测试根目录 mkdtemp（prefix skf-m17-），teardown rm。

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
import { DesktopRegistry, registerDesktopTools } from '../dist/desktop/registry.js';
import { FakeUiaBridge } from '../dist/desktop/uia-bridge.js';
import { FakeClipboardBridge } from '../dist/desktop/clipboard.js';
import { FakeLauncherBridge, loadLaunchWhitelist } from '../dist/desktop/launcher.js';
import { approvalInputHashOf } from '../dist/desktop/contracts.js';

async function makeEnv(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m17-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm17-test');
  const toolRegistry = new ToolRegistry();
  const fakeUia = new FakeUiaBridge(opts.windows ?? []);
  const fakeClipboard = new FakeClipboardBridge(opts.clipboardHealth);
  const fakeLauncher = new FakeLauncherBridge(opts.whitelist ?? []);
  const desktop = new DesktopRegistry({ uia: fakeUia, clipboard: fakeClipboard, launcher: fakeLauncher });
  registerDesktopTools(toolRegistry, desktop);
  const taskId = opts.taskId ?? 'task-m17';
  const fixturePath = join(root, 'steps.json');
  await writeFile(fixturePath, JSON.stringify({ steps: opts.steps ?? [{ text: 'ok', usage: { inputTokens: 3, outputTokens: 4 } }] }), 'utf8');
  const provider = new FakeScriptedProvider({ fixturePath, enabled: true });
  service.createTask({
    id: taskId,
    input: { goal: opts.goal ?? 'M17 验收任务', ...(opts.extraInput ?? {}) },
    sessionId: 's-m17',
    scope: 'skf-test',
    workspaceRoot: ws,
    provider: 'fake',
    model: 'fake-scripted-1',
  });
  const deps = {
    service,
    provider,
    tools: toolRegistry,
    authorization: { ...localDeliveryAuthorization(ws), allowedMcpTools: [] },
    approvalTtlMsFor: () => 1_800_000,
  };
  return {
    root, ws, store, service, toolRegistry, fakeUia, fakeClipboard, fakeLauncher, desktop,
    provider, taskId, deps, cleanup: () => cleanup(root, store),
  };
}

async function cleanup(root, store) {
  // M15 排坑：Windows WAL/锁释放窗口；先关闭 store 再 force rm。
  try { store.close(); } catch { /* may already be closed */ }
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')), 'must clean only tmp dir');
  assert.match(absolute.slice(base.length + 1), /^skf-m17-[a-zA-Z0-9]+$/);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(absolute, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
}

const execTool = (env, name, args, extra = {}) =>
  env.toolRegistry.execute(`t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, args, {
    taskId: env.taskId,
    workspaceRoot: env.ws,
    authorization: env.deps.authorization,
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
    ...(extra.hasApproved !== undefined ? { hasApproved: extra.hasApproved } : {}),
    ...(extra.workspaceRoot !== undefined ? { workspaceRoot: extra.workspaceRoot } : {}),
  });

// ── T01: 工具注册 + 命名空间 + effect 分级 ───────────────────────

test('T01 五个 desktop 工具注册成功 + 命名空间不与 file.* 冲突 + effect 分级正确', async () => {
  const env = await makeEnv();
  try {
    const expectations = [
      ['desktop.windows', 'read'],
      ['desktop.snapshot', 'read'],
      ['clipboard.read', 'read'],
      ['clipboard.write', 'external_write'],
      ['desktop.launch', 'process'],
    ];
    for (const [name, effect] of expectations) {
      assert.ok(env.toolRegistry.has(name), `ToolRegistry has ${name}`);
      const spec = env.toolRegistry.specOf(name);
      assert.ok(spec, `specOf ${name}`);
      assert.equal(spec.effect, effect, `${name} effect`);
    }
    assert.ok(env.toolRegistry.specOf('file.read') !== undefined, 'file.read still registered');
    // 重新注册同名抛 TOOL_NAME_CONFLICT
    assert.throws(() => env.toolRegistry.register({
      name: 'desktop.windows',
      effect: 'read',
      description: 'dup',
      inputSchema: { type: 'object', additionalProperties: false },
      fields: {},
      run: async () => ({ content: {}, artifactIds: [] }),
    }), /TOOL_NAME_CONFLICT/);
  } finally { await env.cleanup(); }
});

// ── T02: desktop.windows ─────────────────────────────────────────

test('T02 desktop.windows 返回窗口列表（read 路径无需审批）', async () => {
  const env = await makeEnv({
    windows: [
      { pid: 1001, title: 'Notepad - hello.txt', className: 'Notepad', isVisible: true, rect: { x: 0, y: 0, width: 800, height: 600 } },
      { pid: 1002, title: 'Calculator', className: 'Calc', isVisible: true, rect: { x: 100, y: 100, width: 320, height: 480 } },
    ],
  });
  try {
    const r = await execTool(env, 'desktop.windows', { limit: 10 });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.total, 2);
    assert.equal(parsed.windows[0].title, 'Notepad - hello.txt');
    assert.equal(parsed.windows[1].pid, 1002);
    assert.equal(env.fakeUia.stats.list, 1);
  } finally { await env.cleanup(); }
});

// ── T03: desktop.snapshot 文本策略脱敏 ───────────────────────────

test('T03 desktop.snapshot 按文本策略脱敏（structureOnly 隐藏名称；token-like name 标 redacted）', async () => {
  const env = await makeEnv({
    windows: [
      {
        pid: 2001, title: 'TestApp',
        tree: [{
          controlType: 'Window', name: 'sk-abcdefghijklmnop (fake token in name)',
          children: [
            { controlType: 'Button', name: 'OK' },
            { controlType: 'Edit', name: 'username' },
          ],
        }],
      },
    ],
  });
  try {
    const r1 = await execTool(env, 'desktop.snapshot', { ephemeralId: 'win-2001-0', textPolicy: 'semantic', maxDepth: 5 });
    assert.equal(r1.ok, true);
    const snap1 = JSON.parse(r1.content);
    assert.equal(snap1.status, 'ok');
    assert.equal(snap1.nodes.length, 3);
    const win = snap1.nodes.find((n) => n.controlType === 'Window');
    assert.equal(win.name.state, 'redacted', 'token-like name 标 redacted');
    const btn = snap1.nodes.find((n) => n.controlType === 'Button');
    assert.equal(btn.name.state, 'present');
    assert.equal(btn.name.text, 'OK');

    const r2 = await execTool(env, 'desktop.snapshot', { ephemeralId: 'win-2001-0', textPolicy: 'structureOnly', maxDepth: 5 });
    const snap2 = JSON.parse(r2.content);
    assert.ok(snap2.nodes.every((n) => n.name.state === 'not_requested'), 'structureOnly 全部 not_requested');
  } finally { await env.cleanup(); }
});

// ── T04: clipboard.read ──────────────────────────────────────────

test('T04 clipboard.read 返回 ok + text + byteLength', async () => {
  const env = await makeEnv();
  try {
    await env.fakeClipboard.writeText('hello world 你好');
    const r = await execTool(env, 'clipboard.read', {});
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.text, 'hello world 你好');
    assert.equal(parsed.byteLength, Buffer.byteLength('hello world 你好', 'utf8'));
  } finally { await env.cleanup(); }
});

// ── T05: clipboard.write 无审批 = APPROVAL_REQUIRED ─────────────

test('T05 clipboard.write 需审批（external_write，无审批 = APPROVAL_REQUIRED）', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'clipboard.write', { text: '跨应用副作用' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    assert.equal(env.fakeClipboard.stats.write, 0, '无审批时绝不写入剪贴板');
  } finally { await env.cleanup(); }
});

// ── T06: clipboard.write 审批 hash 一致 = 放行；改 text = 拒绝 ──

test('T06 clipboard.write 审批 hash 一致 = 放行；改 text 后旧 hash 失效', async () => {
  const env = await makeEnv();
  try {
    const args = { text: '已审批内容' };
    const hash = approvalInputHashOf('clipboard.write', args);

    const r1 = await execTool(env, 'clipboard.write', args);
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'APPROVAL_REQUIRED');

    const r2 = await execTool(env, 'clipboard.write', args, { hasApproved: (h) => h === hash });
    assert.equal(r2.ok, true);
    const parsed2 = JSON.parse(r2.content);
    assert.equal(parsed2.status, 'ok');

    const r3 = await execTool(env, 'clipboard.write', { text: '另一段' }, { hasApproved: (h) => h === hash });
    assert.equal(r3.ok, false);
    assert.equal(r3.error.code, 'APPROVAL_REQUIRED');
  } finally { await env.cleanup(); }
});

// ── T07: desktop.launch 白名单 + 审批门 ──────────────────────────

test('T07 desktop.launch 白名单外/无审批拒绝；审批通过放行；hash 变更拒绝', async () => {
  const env = await makeEnv({ whitelist: [{ basename: 'notepad.exe' }, { basename: 'calc.exe' }] });
  try {
    const args = { executable: 'notepad.exe', args: ['a.txt', 'b.txt'] };
    const hash = approvalInputHashOf('desktop.launch', args);

    // 不在白名单（无论审批如何，都会先被 ToolSpec.run 内 LAUNCH_DENIED；无审批则先 APPROVAL_REQUIRED）
    const r1 = await execTool(env, 'desktop.launch', { executable: 'evil.exe', args: [] });
    assert.equal(r1.ok, false);
    assert.ok(['APPROVAL_REQUIRED', 'LAUNCH_DENIED'].includes(r1.error.code));

    // 白名单内无审批 → APPROVAL_REQUIRED
    const r2 = await execTool(env, 'desktop.launch', args);
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'APPROVAL_REQUIRED');

    // 审批通过 → started
    env.fakeLauncher.setSimulated('notepad.exe', { status: 'started', pid: 4242, detail: null });
    const r3 = await execTool(env, 'desktop.launch', args, { hasApproved: (h) => h === hash });
    assert.equal(r3.ok, true);
    const parsed3 = JSON.parse(r3.content);
    assert.equal(parsed3.status, 'started');
    assert.equal(parsed3.pid, 4242);
    assert.equal(env.fakeLauncher.calls.length, 1);
    assert.deepEqual(env.fakeLauncher.calls[0].args, ['a.txt', 'b.txt']);

    // 改 args → hash 变 → APPROVAL_REQUIRED
    const r4 = await execTool(env, 'desktop.launch', { executable: 'notepad.exe', args: ['c.txt'] }, { hasApproved: (h) => h === hash });
    assert.equal(r4.ok, false);
    assert.equal(r4.error.code, 'APPROVAL_REQUIRED');
  } finally { await env.cleanup(); }
});

// ── T08: 取消信号 → TOOL_CANCELLED ──────────────────────────────

test('T08 取消信号到达时工具执行抛 TOOL_CANCELLED', async () => {
  const env = await makeEnv();
  try {
    const ac = new AbortController();
    const pending = execTool(env, 'desktop.windows', { limit: 5 }, { signal: ac.signal });
    ac.abort();
    const r = await pending;
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TOOL_CANCELLED');
  } finally { await env.cleanup(); }
});

// ── T09: schema 严格 ─────────────────────────────────────────────

test('T09 schema 严格：未知字段/超长/类型/枚举/越界拒绝', async () => {
  const env = await makeEnv();
  try {
    const r1 = await execTool(env, 'desktop.snapshot', { ephemeralId: 'x', extraField: 'fail' });
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'TOOL_ARGS_INVALID');

    const r2 = await execTool(env, 'desktop.snapshot', { ephemeralId: 'x'.repeat(300) });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'TOOL_INPUT_LIMIT');

    const r3 = await execTool(env, 'desktop.snapshot', { ephemeralId: 'x', view: 'raw' });
    assert.equal(r3.ok, false);
    assert.equal(r3.error.code, 'TOOL_ARGS_INVALID');

    const r4 = await execTool(env, 'desktop.snapshot', { ephemeralId: 'x', maxNodes: 99999 });
    assert.equal(r4.ok, false);
    assert.equal(r4.error.code, 'TOOL_ARGS_INVALID');

    const r5 = await execTool(env, 'clipboard.write', { text: 123 });
    assert.equal(r5.ok, false);
    assert.equal(r5.error.code, 'TOOL_ARGS_INVALID');
  } finally { await env.cleanup(); }
});

// ── T10: workspaceRoot 不匹配 → POLICY_DENIED ─────────────────────

test('T10 任务授权 root 与执行 root 不一致 → POLICY_DENIED', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'desktop.windows', { limit: 5 }, { workspaceRoot: 'D:/some/other/root' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'POLICY_DENIED');
  } finally { await env.cleanup(); }
});

// ── T11: clipboard bridge unhealthy → CLIPBOARD_UNAVAILABLE ──────

test('T11 clipboard 桥 unhealthy → 工具执行如实抛 CLIPBOARD_UNAVAILABLE', async () => {
  const env = await makeEnv({ clipboardHealth: { state: 'unavailable', detail: 'os denied' } });
  try {
    const r = await execTool(env, 'clipboard.read', {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'CLIPBOARD_UNAVAILABLE');
  } finally { await env.cleanup(); }
});

// ── T12: UIA bridge unhealthy → UIA_UNAVAILABLE ───────────────────

test('T12 UIA 桥 unhealthy → 工具执行如实抛 UIA_UNAVAILABLE', async () => {
  const env = await makeEnv({ windows: [{ pid: 1, title: 'Test' }] });
  env.fakeUia.setHealth({ state: 'uia_unavailable', detail: 'no uia in this env' });
  try {
    const r = await execTool(env, 'desktop.windows', {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'UIA_UNAVAILABLE');
  } finally { await env.cleanup(); }
});

// ── T13: launch whitelist 校验 ───────────────────────────────────

test('T13 launch whitelist 校验：basename 含路径分隔符 / sha256 非法 → INVALID_CONFIG', () => {
  assert.throws(() => loadLaunchWhitelist(JSON.stringify([{ basename: 'sub/evil.exe' }])), /INVALID_CONFIG/);
  assert.throws(() => loadLaunchWhitelist(JSON.stringify([{ basename: 'sub\\evil.exe' }])), /INVALID_CONFIG/);
  assert.throws(() => loadLaunchWhitelist(JSON.stringify([{ basename: 'ok', expectedSha256: 'not-hex' }])), /INVALID_CONFIG/);
  const ok = loadLaunchWhitelist(JSON.stringify([
    { basename: 'notepad.exe' },
    { basename: 'calc.exe', expectedSha256: 'a'.repeat(64) },
  ]));
  assert.equal(ok.length, 2);
  assert.equal(ok[0].basename, 'notepad.exe');
  assert.equal(ok[1].expectedSha256, 'a'.repeat(64));
});

// ── T14: launch whitelist basename 去重 ──────────────────────────

test('T14 launch whitelist basename 去重（保留首次出现）', () => {
  const out = loadLaunchWhitelist(JSON.stringify([
    { basename: 'notepad.exe' },
    { basename: 'calc.exe' },
    { basename: 'notepad.exe', expectedSha256: 'b'.repeat(64) },
  ]));
  assert.equal(out.length, 2);
  assert.equal(out[0].basename, 'notepad.exe');
  assert.equal(out[0].expectedSha256, undefined);
});

// ── T15: 端到端 AgentLoop ────────────────────────────────────────

test('T15 端到端：AgentLoop 调用 desktop.windows → succeeded + 回灌', async () => {
  const env = await makeEnv({
    windows: [{ pid: 1234, title: 'E2E Test' }],
    steps: [
      { toolCalls: [{ id: 'call-1', name: 'desktop.windows', arguments: { limit: 5 } }], usage: { inputTokens: 3, outputTokens: 4 } },
      { expectToolResults: ['call-1'], text: 'windows 列表已取', usage: { inputTokens: 5, outputTokens: 6 } },
    ],
  });
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.toolCalls, 1);
    const messages = env.service.listMessages(env.taskId);
    const toolMsg = messages.find((m) => m.role === 'tool' && m.toolCallId === 'call-1');
    assert.ok(toolMsg, 'tool message 回灌');
    const payload = JSON.parse(toolMsg.content);
    assert.equal(payload.total, 1);
    assert.equal(payload.windows[0].pid, 1234);
    assert.equal(env.fakeUia.stats.list, 1);
  } finally { await env.cleanup(); }
});

// ── T16: 错误码白名单 ────────────────────────────────────────────

test('T16 M17 错误码全部在 IPC_V2_PUBLIC_ERRORS 白名单内', async () => {
  const { IPC_V2_PUBLIC_ERRORS } = await import('../dist/runtime/ipc-v2.js');
  for (const code of ['UIA_UNAVAILABLE', 'SECURE_DESKTOP_OR_SESSION_UNAVAILABLE', 'HELPER_FAILED',
    'CLIPBOARD_UNAVAILABLE', 'LAUNCH_DENIED', 'LAUNCH_UNAVAILABLE',
    'TARGET_NOT_FOUND', 'TARGET_CHANGED']) {
    assert.ok(IPC_V2_PUBLIC_ERRORS.has(code), `${code} should be in whitelist`);
  }
});

// ── T17: 命名空间不与 file.* 冲突 ───────────────────────────────

test('T17 命名空间白名单：desktop.* / clipboard.* 不与 file.* / mcp/* 重名', async () => {
  const env = await makeEnv();
  try {
    for (const name of ['file.read', 'file.write', 'file.list', 'file.stat']) {
      assert.ok(env.toolRegistry.has(name), `${name} still present`);
    }
    assert.throws(() => env.toolRegistry.register({
      name: 'file.read',
      effect: 'read', description: 'dup', inputSchema: {}, fields: {},
      run: async () => ({ content: {}, artifactIds: [] }),
    }), /TOOL_NAME_CONFLICT/);
  } finally { await env.cleanup(); }
});

// ── T18: 空白名单 health = no_whitelist ──────────────────────────

test('T18 空白名单时 launcher health = no_whitelist；非空 = ok', async () => {
  const empty = new FakeLauncherBridge([]);
  const nonempty = new FakeLauncherBridge([{ basename: 'a.exe' }]);
  const e = await empty.health();
  const n = await nonempty.health();
  assert.equal(e.state, 'no_whitelist');
  assert.equal(n.state, 'ok');
  assert.equal(n.whitelistSize, 1);
});

// ── T19: 多工具不串扰 ────────────────────────────────────────────

test('T19 Fake 桥 stats 精确反映调用次数；多工具不串扰', async () => {
  const env = await makeEnv({ windows: [{ pid: 1, title: 'a' }, { pid: 2, title: 'b' }] });
  try {
    const hash = approvalInputHashOf('clipboard.write', { text: 'x' });
    await execTool(env, 'desktop.windows', { limit: 5 });
    await execTool(env, 'desktop.snapshot', { ephemeralId: 'win-1-0' });
    await execTool(env, 'clipboard.read', {});
    await execTool(env, 'clipboard.write', { text: 'x' }, { hasApproved: (h) => h === hash });

    assert.equal(env.fakeUia.stats.list, 1);
    assert.equal(env.fakeUia.stats.snapshot, 1);
    assert.equal(env.fakeClipboard.stats.read, 1);
    assert.equal(env.fakeClipboard.stats.write, 1);
  } finally { await env.cleanup(); }
});

// ── T20: clipboard.write 超长文本 → TOOL_INPUT_LIMIT ─────────────

test('T20 clipboard.write 超长文本 → TOOL_INPUT_LIMIT', async () => {
  const env = await makeEnv();
  try {
    const bigText = 'a'.repeat(70_000);
    const hash = approvalInputHashOf('clipboard.write', { text: bigText });
    const r = await execTool(env, 'clipboard.write', { text: bigText }, { hasApproved: (h) => h === hash });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TOOL_INPUT_LIMIT');
  } finally { await env.cleanup(); }
});

// ── T21: snapshot 节点数 / 深度 / 字节超限 → partial ──────────────

test('T21 snapshot 超深/超节点 → status=partial，完整性说明明确', async () => {
  // 构造 30 层深 + 50 个兄弟节点的树，maxDepth=10 触发 truncated
  const deepChildren = [];
  for (let i = 0; i < 5; i++) deepChildren.push({ controlType: `Deep${i}`, name: `level-${i}` });
  // 再造 5 层
  let cur = deepChildren[0];
  for (let i = 0; i < 20; i++) {
    const next = { controlType: `Layer${i}`, name: `x${i}`, children: [{ controlType: 'Leaf' }] };
    cur.children = [next];
    cur = next;
  }
  const env = await makeEnv({
    windows: [{ pid: 9999, title: 'DeepApp', tree: [{ controlType: 'Window', name: 'root', children: deepChildren }] }],
  });
  try {
    const r = await execTool(env, 'desktop.snapshot', { ephemeralId: 'win-9999-0', maxDepth: 4, maxNodes: 5, textPolicy: 'semantic' });
    assert.equal(r.ok, true);
    const snap = JSON.parse(r.content);
    assert.equal(snap.status, 'partial');
    assert.ok(snap.completeness.reason !== null);
  } finally { await env.cleanup(); }
});

// ── T22: desktop.windows 找不到 ephemeralId（直接 ID 模式）── 这里只能通过 listWindows 拿到 ID ───

test('T22 UIA 桥对找不到的 ephemeralId → TARGET_NOT_FOUND', async () => {
  const env = await makeEnv({ windows: [{ pid: 1, title: 'A' }] });
  try {
    const r = await execTool(env, 'desktop.snapshot', { ephemeralId: 'non-existent-id' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TARGET_NOT_FOUND');
  } finally { await env.cleanup(); }
});

// ── T23: launch 拒绝（白名单外的 basename） → LAUNCH_DENIED ──────

test('T23 launch 白名单外但有 mock 审批 → 仍然 LAUNCH_DENIED（bridge 层兜底）', async () => {
  const env = await makeEnv({ whitelist: [{ basename: 'notepad.exe' }] });
  try {
    const args = { executable: 'evil.exe' };
    const hash = approvalInputHashOf('desktop.launch', args);
    const r = await execTool(env, 'desktop.launch', args, { hasApproved: (h) => h === hash });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'LAUNCH_DENIED');
  } finally { await env.cleanup(); }
});

// ── T24: 嵌套对象 / 数组参数处理（args/restrictPids） ─────────────

test('T24 desktop.windows restrictPids 数组 + limit 共同工作', async () => {
  const env = await makeEnv({
    windows: [
      { pid: 100, title: 'A' },
      { pid: 200, title: 'B' },
      { pid: 300, title: 'C' },
    ],
  });
  try {
    const r = await execTool(env, 'desktop.windows', { restrictPids: [100, 300], limit: 5 });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.total, 2);
    assert.deepEqual(parsed.windows.map((w) => w.pid).sort(), [100, 300]);
  } finally { await env.cleanup(); }
});

// ── T25: launch 无 args（合法），pid 来自 launcher 模拟器 ────────

test('T25 launch 无 args + 审批 → 成功并透传 pid', async () => {
  const env = await makeEnv({ whitelist: [{ basename: 'note.exe' }] });
  try {
    env.fakeLauncher.setSimulated('note.exe', { status: 'started', pid: 9999, detail: null });
    const args = { executable: 'note.exe' };
    const hash = approvalInputHashOf('desktop.launch', args);
    const r = await execTool(env, 'desktop.launch', args, { hasApproved: (h) => h === hash });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.pid, 9999);
    assert.equal(env.fakeLauncher.calls.length, 1);
    assert.deepEqual(env.fakeLauncher.calls[0].args, []);
  } finally { await env.cleanup(); }
});
