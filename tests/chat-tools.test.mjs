// B 验收：聊天执行全工具（full tool loop）。
// 覆盖 4 类 effect 分级：read（直行）、workspace_write（范围内直行/范围外拒绝）、
//   external_write（审批门，批准才执行、未批准不执行）、process（同审批门）。
// 全部 fake provider + 本机临时目录 + Fake 桥，零网络、零付费、零真实副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ModelGateway } from '../dist/runtime/model-gateway.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { runChatTurn } from '../dist/runtime/chat-kernel.js';
import { DesktopRegistry, registerDesktopTools } from '../dist/desktop/registry.js';
import { FakeUiaBridge } from '../dist/desktop/uia-bridge.js';
import { FakeClipboardBridge } from '../dist/desktop/clipboard.js';
import { FakeLauncherBridge } from '../dist/desktop/launcher.js';

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** 脚本化 fake provider：每步返回 toolCalls 或纯文本，记录收到的 messages。 */
function scriptedProvider(steps) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete(req) {
      calls.push(req.messages);
      const step = steps[i];
      if (!step) throw Object.assign(new Error('scripted provider exhausted'), { code: 'MODEL_REQUEST_FAILED' });
      i += 1;
      if (step.toolCalls) {
        return {
          provider: 'fake', model: 'fake-scripted',
          assistant: { role: 'assistant', content: step.content ?? '', toolCalls: step.toolCalls },
          finishReason: 'tool_calls',
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, source: 'provider' },
        };
      }
      return {
        provider: 'fake', model: 'fake-scripted',
        assistant: { role: 'assistant', content: step.text ?? '' },
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, source: 'provider' },
      };
    },
  };
}

async function makeEnv({ steps, tools, desktop }) {
  const root = await mkdtemp(join(tmpdir(), 'skf-b-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'b-test');
  const provider = scriptedProvider(steps);
  const gateway = new ModelGateway({
    store,
    service,
    config: { mode: 'call-limit', defaultProvider: 'fake', expensiveProviders: new Set(), maxRetries: 0 },
  });
  gateway.registerProvider({ name: 'fake', adapter: provider, model: 'fake-scripted', local: true, verified: true });
  const deps = {
    service,
    gateway,
    tools,
    adapterFor: (name) => (name === 'fake' ? provider : null),
    providerAvailable: (name) => name === 'fake',
    defaultProvider: () => 'fake',
    modelFor: () => 'fake-scripted',
    workspaceRootFor: () => ws,
    approvalTtlMsFor: () => 1_800_000,
    prepareContext: async () => null,
    fallbackSystem: '测试 system',
    flushMemoryOutbox: async () => {},
  };
  return { root, ws, store, service, provider, gateway, deps, desktop };
}

function chatReq(id, message) {
  return { id, message, sessionId: 's-b', scope: 'skf-test', channel: 'cli' };
}

// ── 1. read：直接执行，结果回灌，第二轮收尾 ──────────────────────────

test('read 工具（file.read）：直行 + 结果回灌 + 第二轮收尾', async () => {
  const env = await makeEnv({
    steps: [
      { toolCalls: [{ id: 'call-read', name: 'file.read', arguments: { path: 'a.txt' } }] },
      { text: '读完文件，内容已掌握。' },
    ],
    tools: new ToolRegistry(),
  });
  try {
    await writeFile(join(env.ws, 'a.txt'), '你好世界', 'utf8');
    const result = await runChatTurn(env.deps, chatReq('chat-b-read', '读一下 a.txt'));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.text, '读完文件，内容已掌握。');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'file.read');
    assert.equal(result.toolCalls[0].effect, 'read');
    assert.equal(result.toolCalls[0].status, 'ok');
    // 工具确实执行了（operation succeeded）
    const op = env.service.getOperation('op:chat-b-read:call-read');
    assert.equal(op.state, 'succeeded');
    // 结果回灌进第二轮模型调用（tool message 存在）
    const secondMessages = env.provider.calls[1];
    assert.ok(secondMessages.some((m) => m.role === 'tool' && m.toolCallId === 'call-read'));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 2a. workspace_write 范围内：直接执行落盘 ─────────────────────────

test('workspace_write 范围内（file.write）：直接执行，文件落盘', async () => {
  const env = await makeEnv({
    steps: [
      { toolCalls: [{ id: 'call-write', name: 'file.write', arguments: { path: 'b.txt', content: '你好' } }] },
      { text: '已写入 b.txt。' },
    ],
    tools: new ToolRegistry(),
  });
  try {
    const result = await runChatTurn(env.deps, chatReq('chat-b-write', '写一个 b.txt'));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.toolCalls[0].tool, 'file.write');
    assert.equal(result.toolCalls[0].effect, 'workspace_write');
    assert.equal(result.toolCalls[0].status, 'ok');
    assert.equal(await readFile(join(env.ws, 'b.txt'), 'utf8'), '你好');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 2b. workspace_write 范围外：resolveWithinRoot 拒绝，不越界 ────────

test('workspace_write 范围外（file.write ../）：拒绝不执行，结果回灌', async () => {
  const env = await makeEnv({
    steps: [
      { toolCalls: [{ id: 'call-esc', name: 'file.write', arguments: { path: '../outside.txt', content: 'x' } }] },
      { text: '收到，路径越界写不进去。' },
    ],
    tools: new ToolRegistry(),
  });
  try {
    const result = await runChatTurn(env.deps, chatReq('chat-b-esc', '写 ../outside.txt'));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.toolCalls[0].tool, 'file.write');
    assert.equal(result.toolCalls[0].effect, 'workspace_write');
    assert.equal(result.toolCalls[0].status, 'failed');
    // operation 失败，未落盘越界文件
    const op = env.service.getOperation('op:chat-b-esc:call-esc');
    assert.equal(op.state, 'failed');
    await assert.rejects(readFile(join(env.root, 'outside.txt')));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 3a. external_write：审批门——未批准不执行，批准才执行 ─────────────

function desktopEnv(steps, whitelist = [{ basename: 'notepad.exe' }]) {
  const fakeUia = new FakeUiaBridge([]);
  const fakeClipboard = new FakeClipboardBridge();
  const fakeLauncher = new FakeLauncherBridge(whitelist);
  const desktop = new DesktopRegistry({ uia: fakeUia, clipboard: fakeClipboard, launcher: fakeLauncher });
  const tools = new ToolRegistry();
  registerDesktopTools(tools, desktop);
  return makeEnv({ steps, tools, desktop: { fakeClipboard, fakeLauncher } });
}

test('external_write（clipboard.write）：未批准不执行 → 批准后执行', async () => {
  const env = await desktopEnv([
    { toolCalls: [{ id: 'call-clip', name: 'clipboard.write', arguments: { text: '剪贴板内容' } }] },
    { text: '已写入剪贴板。' },
  ]);
  try {
    const first = await runChatTurn(env.deps, chatReq('chat-b-clip', '写剪贴板'));
    // 副作用工具停车等审批，工具未执行
    assert.equal(first.state, 'waiting_approval');
    assert.equal(first.pendingApproval.tool, 'clipboard.write');
    assert.equal(first.pendingApproval.effect, 'external_write');
    assert.equal(env.desktop.fakeClipboard.stats.write, 0);

    // 批准（绑定参数 hash）
    const decided = env.service.decideApproval(first.pendingApproval.approvalId, 'approved', { inputHash: first.pendingApproval.inputHash });
    assert.equal(decided.taskState, 'running');

    // 重新进入同一轮 → 恢复循环，执行工具，收尾
    const resumed = await runChatTurn(env.deps, chatReq('chat-b-clip', '写剪贴板'));
    assert.equal(resumed.state, 'succeeded');
    assert.equal(resumed.text, '已写入剪贴板。');
    assert.equal(env.desktop.fakeClipboard.stats.write, 1, '批准后 clipboard.write 必须执行');
    const clip = resumed.toolCalls.find((tc) => tc.tool === 'clipboard.write');
    assert.equal(clip.effect, 'external_write');
    assert.equal(clip.status, 'ok');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('external_write（clipboard.write）：拒绝后不执行，任务失败', async () => {
  const env = await desktopEnv([
    { toolCalls: [{ id: 'call-clip', name: 'clipboard.write', arguments: { text: '剪贴板内容' } }] },
    { text: '不该到达' },
  ]);
  try {
    const first = await runChatTurn(env.deps, chatReq('chat-b-clip-rej', '写剪贴板'));
    assert.equal(first.state, 'waiting_approval');

    const decided = env.service.decideApproval(first.pendingApproval.approvalId, 'rejected', { inputHash: first.pendingApproval.inputHash });
    assert.equal(decided.taskState, 'failed');

    // 拒绝后不执行，任务失败（重入抛 APPROVAL_REJECTED）
    await assert.rejects(runChatTurn(env.deps, chatReq('chat-b-clip-rej', '写剪贴板')), (e) => e.code === 'APPROVAL_REJECTED');
    assert.equal(env.desktop.fakeClipboard.stats.write, 0, '未批准绝不执行');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 3b. process：审批门——批准后执行 ─────────────────────────────────

test('process（desktop.launch）：审批门，批准后执行', async () => {
  const env = await desktopEnv([
    { toolCalls: [{ id: 'call-launch', name: 'desktop.launch', arguments: { executable: 'notepad.exe' } }] },
    { text: '已启动记事本。' },
  ]);
  try {
    const first = await runChatTurn(env.deps, chatReq('chat-b-launch', '启动记事本'));
    assert.equal(first.state, 'waiting_approval');
    assert.equal(first.pendingApproval.tool, 'desktop.launch');
    assert.equal(first.pendingApproval.effect, 'process');
    assert.equal(env.desktop.fakeLauncher.stats.launch, 0);

    const decided = env.service.decideApproval(first.pendingApproval.approvalId, 'approved', { inputHash: first.pendingApproval.inputHash });
    assert.equal(decided.taskState, 'running');

    const resumed = await runChatTurn(env.deps, chatReq('chat-b-launch', '启动记事本'));
    assert.equal(resumed.state, 'succeeded');
    assert.equal(env.desktop.fakeLauncher.stats.launch, 1, '批准后 desktop.launch 必须执行');
    const launch = resumed.toolCalls.find((tc) => tc.tool === 'desktop.launch');
    assert.equal(launch.effect, 'process');
    assert.equal(launch.status, 'ok');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});
