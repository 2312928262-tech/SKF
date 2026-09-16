// M18 · GUI 有限交互验收测试
//
// 覆盖：prepare 生成计划+approvalHash / 计划持久化 / execute 审批门 / 审批 hash 绑定 /
// 密钥输入拒绝 / 计划过期 / 发布类单独审批 / cancel / status / reconcile / 派发屏障 /
// 命名空间 / schema 严格 / 错误码白名单。
//
// 约束：零网络 / 零付费 / 零真实 Windows UIA；全部 FakeUiaBridge + InteractService。
// 隔离副本 D:/SKF-Work/dev；测试根目录 mkdtemp（prefix skf-m18-）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
import { FakeLauncherBridge } from '../dist/desktop/launcher.js';
import { InteractService } from '../dist/desktop/interact-service.js';
import { buildInteractTools } from '../dist/desktop/interact-tools.js';
import { windowFingerprintHashOf } from '../dist/desktop/interact-contracts.js';

function makeFingerprint() {
  const fp = {
    identity: {
      userSid: 'S-1-5-21-test',
      skfInstanceId: 'skf-m18',
      pid: 4242,
      processStartedAt: Date.now() - 10000,
      executablePath: 'C:/Windows/System32/notepad.exe',
      executableSha256: '',
      signatureState: 'unsigned',
      publisher: 'Microsoft',
      integrityLevel: 'medium',
      topLevelHwnd: 'hwnd-1',
      windowClass: 'Notepad',
      uiaFrameworkId: 'Win32',
    },
    state: {
      protectedSubtreeHash: 'deadbeef',
      businessContext: [{ key: 'document', redactedValue: 'untitled.txt', state: 'present' }],
      modalState: 'none',
      focusOwner: 'Notepad',
    },
    context: {
      rect: { x: 0, y: 0, width: 800, height: 600 },
      displayId: 'unknown',
      dpi: 96,
      sessionState: 'console',
    },
    ruleVersion: '1',
  };
  return { fp, hash: windowFingerprintHashOf(fp) };
}

async function makeEnv(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m18-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm18-test');
  const toolRegistry = new ToolRegistry();
  const fakeUia = new FakeUiaBridge([]);
  const fakeClipboard = new FakeClipboardBridge();
  const fakeLauncher = new FakeLauncherBridge([]);
  const desktop = new DesktopRegistry({ uia: fakeUia, clipboard: fakeClipboard, launcher: fakeLauncher });
  registerDesktopTools(toolRegistry, desktop);

  const fingerprint = opts.fingerprint ?? makeFingerprint();
  const interactService = new InteractService({ store, uia: fakeUia, logger: opts.logger });
  const interactTools = buildInteractTools({
    service: interactService,
    resolveFingerprint: () => fingerprint.fp,
  });
  for (const spec of interactTools) toolRegistry.register(spec);

  const taskId = opts.taskId ?? 'task-m18';
  service.createTask({
    id: taskId,
    input: { goal: opts.goal ?? 'M18 验收任务' },
    sessionId: 's-m18',
    scope: 'skf-test',
    workspaceRoot: ws,
    provider: 'fake',
    model: 'fake-scripted-1',
  });

  return {
    root, ws, store, service, toolRegistry, fakeUia, fakeClipboard, fakeLauncher, desktop,
    interactService, fingerprint, taskId,
    cleanup: () => cleanup(root, store),
  };
}

async function cleanup(root, store) {
  try { store.close(); } catch { /* closed */ }
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m18-[a-zA-Z0-9]+$/);
  for (let i = 0; i < 5; i++) {
    try { await rm(absolute, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 80 * (i + 1))); }
  }
}

const execTool = (env, name, args, extra = {}) =>
  env.toolRegistry.execute(`t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, args, {
    taskId: env.taskId,
    workspaceRoot: env.ws,
    authorization: { ...localDeliveryAuthorization(env.ws), allowedMcpTools: [] },
    ...(extra.hasApproved !== undefined ? { hasApproved: extra.hasApproved } : {}),
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
  });

// ── T01: prepare 生成计划 + approvalHash ──────────────────────────────

test('T01 prepare 生成不可变计划，返回 planId + approvalHash', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'desktop.interact.prepare', {
      steps: [
        { primitive: 'observe.window' },
        { primitive: 'button.invoke', selector: { type: 'automationId', value: 'btn-ok' } },
      ],
      risk: 'standard',
    });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.ok(parsed.planId.startsWith('interact-'));
    assert.match(parsed.approvalHash, /^[a-f0-9]{64}$/);
    assert.equal(parsed.steps, 2);
  } finally { await env.cleanup(); }
});

// ── T02: 计划持久化到 execution_plans 表 ─────────────────────────────

test('T02 prepare 后计划持久化到 execution_plans（state=PREPARED）', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'observe.window' }],
      risk: 'read',
    });
    const parsed = JSON.parse(r.content);
    const row = env.store.db.prepare('SELECT * FROM execution_plans WHERE planId = ?').get(parsed.planId);
    assert.ok(row, 'plan row exists');
    assert.equal(row.state, 'PREPARED');
    assert.equal(row.containsPublish, 0);
    assert.equal(row.risk, 'read');
  } finally { await env.cleanup(); }
});

// ── T03: execute 无审批 → APPROVAL_REQUIRED ──────────────────────────

test('T03 execute 是 external_write，无审批 → APPROVAL_REQUIRED', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'button.invoke', selector: { type: 'name', value: 'OK' } }],
    });
    const { planId, approvalHash } = JSON.parse(prep.content);
    const r = await execTool(env, 'desktop.interact.execute', { planId, approvalHash });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
  } finally { await env.cleanup(); }
});

// ── T04: execute 审批 hash 一致 → 放行执行 → SUCCEEDED ──────────────

test('T04 execute 审批 hash 一致 → SUCCEEDED', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'button.invoke', selector: { type: 'name', value: 'OK' } }],
    });
    const { planId, approvalHash } = JSON.parse(prep.content);
    const r = await execTool(env, 'desktop.interact.execute', { planId, approvalHash }, {
      hasApproved: (h) => h === approvalHash,
    });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.state, 'SUCCEEDED');
    assert.equal(parsed.completed, true);
    assert.equal(parsed.completedSteps, 1);
  } finally { await env.cleanup(); }
});

// ── T05: execute 审批 hash 不一致 → 拒绝（APPROVAL_REQUIRED 安全门）────

test('T05 execute 审批 hash 不一致 → APPROVAL_REQUIRED（审批门拦截）', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'button.invoke', selector: { type: 'name', value: 'OK' } }],
    });
    const { planId, approvalHash } = JSON.parse(prep.content);
    const wrongHash = 'a'.repeat(64);
    // 审批系统只记录了 plan 的真实 approvalHash；execute 传 wrongHash → hasApproved 不匹配 → APPROVAL_REQUIRED
    const r = await execTool(env, 'desktop.interact.execute', { planId, approvalHash: wrongHash }, {
      hasApproved: (h) => h === approvalHash,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
  } finally { await env.cleanup(); }
});

// ── T06: 密钥输入被拒 ────────────────────────────────────────────────

test('T06 密钥输入被拒（INTERACT_SECRET_INPUT_FORBIDDEN）', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'input.set_value', selector: { type: 'name', value: 'pwd' }, inputText: 'sk-abcdef1234567890' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INTERACT_SECRET_INPUT_FORBIDDEN');
  } finally { await env.cleanup(); }
});

// ── T07: 计划过期 → INTERACT_PLAN_EXPIRED ────────────────────────────

test('T07 计划过期（expiresAt 已过）→ INTERACT_PLAN_EXPIRED', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'observe.window' }],
      planTimeoutMs: 1000, // 最小合法值；等待超过 1s 后过期
    });
    assert.equal(prep.ok, true);
    const { planId, approvalHash } = JSON.parse(prep.content);
    await new Promise((r) => setTimeout(r, 1200)); // 确保过期
    const r = await execTool(env, 'desktop.interact.execute', { planId, approvalHash }, {
      hasApproved: (h) => h === approvalHash,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INTERACT_PLAN_EXPIRED');
  } finally { await env.cleanup(); }
});

// ── T08: 发布类动作单独审批 ──────────────────────────────────────────

test('T08 发布类动作（risk=publish）执行时 → INTERACT_PUBLISH_REQUIRES_SEPARATE_APPROVAL', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'button.invoke', selector: { type: 'name', value: 'Send' } }],
      risk: 'publish',
    });
    const { planId, approvalHash } = JSON.parse(prep.content);
    const r = await execTool(env, 'desktop.interact.execute', { planId, approvalHash }, {
      hasApproved: (h) => h === approvalHash,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INTERACT_PUBLISH_REQUIRES_SEPARATE_APPROVAL');
  } finally { await env.cleanup(); }
});

// ── T09: cancel → CANCELLED ───────────────────────────────────────────

test('T09 cancel 禁止后续派发（不撤回已发出）', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'observe.window' }],
    });
    const { planId } = JSON.parse(prep.content);
    const r = await execTool(env, 'desktop.interact.cancel', { planId });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.state, 'CANCELLED');
  } finally { await env.cleanup(); }
});

// ── T10: status / reconcile 查询 ──────────────────────────────────────

test('T10 status 返回计划状态；reconcile 返回派发屏障', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'observe.window' }],
    });
    const { planId } = JSON.parse(prep.content);
    const st = await execTool(env, 'desktop.interact.status', { planId });
    assert.equal(st.ok, true);
    assert.equal(JSON.parse(st.content).state, 'PREPARED');
    const rc = await execTool(env, 'desktop.interact.reconcile', { planId });
    assert.equal(rc.ok, true);
    assert.equal(JSON.parse(rc.content).state, 'PREPARED');
  } finally { await env.cleanup(); }
});

// ── T11: 派发屏障：execute 成功后 barrier POST_VERIFIED ──────────────

test('T11 execute 成功后派发屏障全部 POST_VERIFIED', async () => {
  const env = await makeEnv();
  try {
    const prep = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'button.invoke', selector: { type: 'name', value: 'OK' } }],
    });
    const { planId, approvalHash } = JSON.parse(prep.content);
    const r = await execTool(env, 'desktop.interact.execute', { planId, approvalHash }, {
      hasApproved: (h) => h === approvalHash,
    });
    assert.equal(r.ok, true);
    const row = env.store.db.prepare('SELECT perStepBarrier FROM execution_plans WHERE planId = ?').get(planId);
    const barriers = JSON.parse(row.perStepBarrier);
    assert.equal(barriers.length, 1);
    assert.equal(barriers[0].state, 'POST_VERIFIED');
  } finally { await env.cleanup(); }
});

// ── T12: 命名空间：desktop.interact.* 不与 desktop.windows 等冲突 ────

test('T12 命名空间：desktop.interact.* 与 M17 工具不重名', async () => {
  const env = await makeEnv();
  try {
    for (const name of ['desktop.windows', 'desktop.snapshot', 'clipboard.read', 'clipboard.write', 'desktop.launch',
      'desktop.interact.prepare', 'desktop.interact.execute', 'desktop.interact.status',
      'desktop.interact.cancel', 'desktop.interact.reconcile', 'desktop.interact.observe']) {
      assert.ok(env.toolRegistry.has(name), `has ${name}`);
    }
    assert.throws(() => env.toolRegistry.register({
      name: 'desktop.interact.prepare',
      effect: 'read', description: 'dup', inputSchema: {}, fields: {},
      run: async () => ({ content: {}, artifactIds: [] }),
    }), /TOOL_NAME_CONFLICT/);
  } finally { await env.cleanup(); }
});

// ── T13: schema 严格 + 非法 primitive ────────────────────────────────

test('T13 schema 严格：未知 primitive / 空 steps 拒绝', async () => {
  const env = await makeEnv();
  try {
    const r1 = await execTool(env, 'desktop.interact.prepare', {
      steps: [{ primitive: 'evil.destroy' }],
    });
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'INTERACT_INVALID_PRIMITIVE');

    const r2 = await execTool(env, 'desktop.interact.prepare', { steps: [] });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'INTERACT_INVALID_INPUT');
  } finally { await env.cleanup(); }
});

// ── T14: 错误码白名单 ────────────────────────────────────────────────

test('T14 M18 错误码全部在 IPC_V2_PUBLIC_ERRORS 白名单内', async () => {
  const { IPC_V2_PUBLIC_ERRORS } = await import('../dist/runtime/ipc-v2.js');
  const codes = ['INTERACT_PLAN_NOT_FOUND', 'INTERACT_PLAN_EXPIRED', 'INTERACT_INVALID_PRIMITIVE',
    'INTERACT_INVALID_SELECTOR', 'INTERACT_INVALID_INPUT', 'INTERACT_SECRET_INPUT_FORBIDDEN',
    'INTERACT_WINDOW_FINGERPRINT_MISMATCH', 'INTERACT_ELEMENT_NOT_UNIQUE', 'INTERACT_ELEMENT_NOT_FOUND',
    'INTERACT_STATE_VIOLATION', 'INTERACT_DISPATCH_BARRIER_FAILED', 'INTERACT_TIMEOUT',
    'INTERACT_CANCELLED', 'INTERACT_PUBLISH_REQUIRES_SEPARATE_APPROVAL', 'INTERACT_DISPATCH_LOST',
    'INTERACT_RECOVERY_REQUIRED', 'INTERACT_ADAPTER_NOT_REGISTERED', 'INTERACT_ADAPTER_VERSION_CHANGED'];
  for (const code of codes) assert.ok(IPC_V2_PUBLIC_ERRORS.has(code), `${code} in whitelist`);
});

// ── T15: 端到端 AgentLoop 调用 prepare → succeeded ────────────────────

test('T15 端到端：AgentLoop 调用 desktop.interact.prepare（read）→ succeeded + 回灌', async () => {
  const env = await makeEnv();
  try {
    const fixturePath = join(env.root, 'steps.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(fixturePath, JSON.stringify({
      steps: [
        { toolCalls: [{ id: 'call-1', name: 'desktop.interact.prepare', arguments: { steps: [{ primitive: 'observe.window' }] } }], usage: { inputTokens: 3, outputTokens: 4 } },
        { expectToolResults: ['call-1'], text: 'plan prepared', usage: { inputTokens: 5, outputTokens: 6 } },
      ],
    }), 'utf8'));
    const provider = new FakeScriptedProvider({ fixturePath, enabled: true });
    const deps = {
      service: env.service,
      provider,
      tools: env.toolRegistry,
      authorization: { ...localDeliveryAuthorization(env.ws), allowedMcpTools: [] },
      approvalTtlMsFor: () => 1_800_000,
    };
    const result = await runAgentLoop(deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.toolCalls, 1);
    const messages = env.service.listMessages(env.taskId);
    const toolMsg = messages.find((m) => m.role === 'tool' && m.toolCallId === 'call-1');
    assert.ok(toolMsg, 'tool message 回灌');
    const payload = JSON.parse(toolMsg.content);
    assert.ok(payload.planId.startsWith('interact-'));
  } finally { await env.cleanup(); }
});

// ── T16: 计划不存在 → INTERACT_PLAN_NOT_FOUND ────────────────────────

test('T16 查询不存在的计划 → INTERACT_PLAN_NOT_FOUND', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'desktop.interact.status', { planId: 'interact-nonexistent' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INTERACT_PLAN_NOT_FOUND');
  } finally { await env.cleanup(); }
});
