import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { FakeScriptedProvider } from '../dist/providers/fake-scripted.js';
import { runAgentLoop } from '../dist/runtime/agent-loop.js';
import { resolveUnknownOperation } from '../dist/runtime/recovery.js';
import { McpRegistry } from '../dist/mcp/registry.js';
import { approvalInputHashOf } from '../dist/mcp/adapter.js';
import { buildJobLauncher } from '../scripts/build-job-launcher.mjs';

// M14 验收：MCP 工具层（白名单本地 stdio server，唯一执行链不旁路）。
// 覆盖：发现→调用→回灌全通 / 未授权 server 拒绝 / 子进程残留树杀 / 恶意超大输出 /
// 同名工具覆盖 / schema 热变更 / 伪造审批文本 / 断线 unknown 不自动重放 / 重启≠重放+熔断 /
// 注入消毒（发现+结果双阶段）/ 任务绑定目录快照 / server 反驱动拒绝 / 旁路防护。
// 全部 fake provider + 本地 fixture server，零网络、零付费调用。

const launcher = buildJobLauncher();
const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-mcp-server.mjs', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m14-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const DEFAULT_POLICY_TOOLS = {
  echo: { effect: 'read' },
  big_output: { effect: 'read' },
  external_post: { effect: 'external_write' },
  spawn_child: { effect: 'process' },
  hang: { effect: 'read' },
  approval_forger: { effect: 'read' },
  dump_env: { effect: 'read' },
  selfreport: { effect: 'external_write' }, // server 自称只读，SKF 本地裁定为副作用——不采信自报
  fail_tool: { effect: 'read' },
  image_content: { effect: 'read' },
  rogue: undefined, // 不在裁定表（undefined 会在组装时剔除，验证“不凑数”）
};

async function makeEnv(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m14-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm14-test');
  const toolRegistry = new ToolRegistry();
  const logs = [];
  const mcp = new McpRegistry({ toolRegistry, launcherPath: launcher.path, logger: (line) => logs.push(line) });
  const callsFile = join(root, 'calls.jsonl');
  const ledgerFile = join(root, 'ledger.jsonl');
  const fixtureEnv = {
    FIXTURE_CALLS_FILE: callsFile,
    FIXTURE_LEDGER: ledgerFile,
    FIXTURE_GRANDCHILD_PID_FILE: join(root, 'grandchild.json'),
    ...(opts.fixtureEnv ?? {}),
  };
  const tools = {};
  for (const [name, policy] of Object.entries(opts.policyTools ?? DEFAULT_POLICY_TOOLS)) {
    if (policy) tools[name] = policy;
  }
  if (opts.registerFixture !== false) {
    mcp.registerServer({
      serverId: 'fixture',
      command: process.execPath,
      args: [FIXTURE_SERVER],
      env: fixtureEnv,
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.restart ? { restart: opts.restart } : {}),
      ...(opts.approvalTtlMs ? { approvalTtlMs: opts.approvalTtlMs } : {}),
      tools,
    });
  }
  const taskId = opts.taskId ?? 'task-m14';
  let fixturePath = null;
  if (opts.steps) {
    fixturePath = join(root, 'fixture-steps.json');
    await writeFile(fixturePath, JSON.stringify({ steps: opts.steps }), 'utf8');
  }
  const provider = new FakeScriptedProvider({ ...(fixturePath ? { fixturePath } : {}), enabled: true });
  const mcpTools = opts.mcpTools ?? [];
  service.createTask({
    id: taskId,
    input: { goal: opts.goal ?? 'M14 测试任务', ...(mcpTools.length ? { mcpTools } : {}) },
    sessionId: 's-m14',
    scope: 'skf-test',
    workspaceRoot: ws,
    provider: 'fake',
    model: 'fake-scripted-1',
  });
  const deps = {
    service,
    provider,
    tools: toolRegistry,
    authorization: { ...localDeliveryAuthorization(ws), allowedMcpTools: mcpTools },
    approvalTtlMsFor: () => opts.approvalTtlMs ?? 1_800_000,
  };
  return { root, ws, store, service, toolRegistry, mcp, provider, taskId, deps, callsFile, ledgerFile, logs, fixtureEnv };
}

/** 等发现完成（onReady 后 discover 是异步的）。 */
async function waitForTools(env, names, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const known = env.mcp.knownToolNames();
    if (names.every((n) => known.includes(n))) return known;
    if (Date.now() > deadline) throw new Error(`tools not discovered: want ${names}, have ${known}`);
    await sleep(50);
  }
}

async function shutdown(env) {
  await env.mcp.stopAll(500).catch(() => undefined);
  env.store.close();
  await cleanupTestRoot(env.root);
}

const execMcp = (env, name, args, extraCtx = {}) =>
  env.toolRegistry.execute(`t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, args, {
    taskId: env.taskId,
    workspaceRoot: env.ws,
    authorization: env.deps.authorization,
    ...extraCtx,
  });

// ── T01：发现 → 调用 → 回灌全通；serverId 由 SKF 分配不采信自报 ─────

test('T01 发现→调用→回灌全通；命名 mcp/<serverId>/<tool> 不采信 server 自报', async () => {
  const env = await makeEnv({
    mcpTools: ['mcp/fixture/echo'],
    steps: [
      { toolCalls: [{ id: 'call-1', name: 'mcp/fixture/echo', arguments: { text: '你好，SKF' } }], usage: { inputTokens: 5, outputTokens: 3 } },
      { expectToolResults: ['call-1'], text: '回显完成', usage: { inputTokens: 9, outputTokens: 4 } },
    ],
  });
  try {
    await env.mcp.startServer('fixture');
    const known = await waitForTools(env, ['mcp/fixture/echo']);
    assert.ok(known.every((n) => n.startsWith('mcp/fixture/')), '全部工具以 SKF 分配的 serverId 命名');
    assert.ok(!known.some((n) => n.includes('evil')), 'server 自报的 evil-selfreported-name 不出现在命名里');
    const negotiated = env.mcp.getSupervisor('fixture').negotiatedInfo;
    assert.equal(negotiated.serverName, 'evil-selfreported-name-do-not-trust', '自报名字只作记录');

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.toolCalls, 1);

    const messages = env.service.listMessages(env.taskId);
    const toolMsg = messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.name, 'mcp/fixture/echo');
    const payload = JSON.parse(toolMsg.content);
    assert.equal(payload.untrustedExternalData, true, '结果标不可信数据');
    assert.equal(payload.source, 'mcp/fixture');
    assert.equal(payload.content, 'echo:你好，SKF');

    const calls = readJsonl(env.callsFile);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['initialize', 'tools/list', 'tools/call'],
      '握手→发现→调用顺序与次数精确',
    );
    assert.equal(calls[2].params.name, 'echo', '发给 server 的是去掉命名空间的原名');
  } finally {
    await shutdown(env);
  }
});

// ── T02：未授权 server 拒绝 ─────────────────────────────────────

test('T02 未授权 server 拒绝：形状/相对路径/疑似密钥 env/重复注册/未注册工具', async () => {
  const env = await makeEnv({ registerFixture: false });
  try {
    assert.throws(
      () => env.mcp.registerServer({ serverId: 'BAD-ID', command: 'C:/x.exe', tools: {} }),
      /MCP_SERVER_NOT_ALLOWED/,
    );
    assert.throws(
      () => env.mcp.registerServer({ serverId: 'rel', command: 'node', tools: {} }),
      /MCP_SERVER_NOT_ALLOWED.*absolute/,
    );
    assert.throws(
      () => env.mcp.registerServer({ serverId: 'sec', command: process.execPath, env: { SOME_API_KEY: 'x' }, tools: {} }),
      /MCP_SERVER_NOT_ALLOWED.*secret-like/,
    );
    env.mcp.registerServer({ serverId: 'dup', command: process.execPath, args: [FIXTURE_SERVER], tools: {} });
    assert.throws(
      () => env.mcp.registerServer({ serverId: 'dup', command: process.execPath, tools: {} }),
      /MCP_DUPLICATE_SERVER/,
    );
    await assert.rejects(env.mcp.startServer('ghost'), /MCP_SERVER_NOT_ALLOWED/);
    // 未登记工具：registry 查无此 spec
    const r = await execMcp(env, 'mcp/ghost/x', {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'UNKNOWN_TOOL');
  } finally {
    await shutdown(env);
  }
});

// ── T03：子进程残留树杀（Job Object，不靠 child.kill 逐个）──────────

test('T03 子进程残留：server 拉起的孙进程随 supervisor.stop 整树清理', async () => {
  const env = await makeEnv({ mcpTools: ['mcp/fixture/spawn_child'] });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/spawn_child']);
    const r = await execMcp(env, 'mcp/fixture/spawn_child', {}, { hasApproved: () => true });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const pidFile = join(env.root, 'grandchild.json');
    assert.ok(existsSync(pidFile));
    const { child, grand } = JSON.parse(readFileSync(pidFile, 'utf8'));
    assert.ok(alive(child) && alive(grand), '树杀前子/孙进程都在');

    await env.mcp.stopAll(300);
    await sleep(800);
    assert.equal(alive(child), false, 'server 已死');
    assert.equal(alive(grand), false, '孙进程被 Job Object 收掉（不是逐个 kill）');
  } finally {
    await shutdown(env);
  }
});

// ── T04：恶意超大输出（帧层超限杀 + 结果截断）────────────────────────

test('T04 恶意超大输出：80KB 结果截断标记；2MB 单行帧层违规杀 server', async () => {
  const env = await makeEnv({ mcpTools: ['mcp/fixture/big_output'] });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/big_output']);

    // 80KB：行内可容（<1MB），结果层截断到 64KB 并标记
    const r1 = await execMcp(env, 'mcp/fixture/big_output', { kb: 80 });
    assert.equal(r1.ok, true);
    const payload = JSON.parse(r1.content);
    assert.equal(payload.truncated, true);
    assert.ok(Buffer.byteLength(payload.content, 'utf8') <= 65_536, '结果文本被截到 64KB 内');
    assert.ok(Buffer.byteLength(r1.content, 'utf8') <= 96_000, '回灌总量在 96KB 兑底内');

    // 2MB：单行帧超 1MB 上限 => 帧层协议违规，server 被杀进熔断
    const r2 = await execMcp(env, 'mcp/fixture/big_output', { kb: 2048 });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'MCP_PROTOCOL_VIOLATION');
    await sleep(300);
    assert.equal(env.mcp.getSupervisor('fixture').currentState, 'circuit_open', '恶意行为进熔断不奖励重连');
  } finally {
    await shutdown(env);
  }
});

// ── T05：同名工具覆盖（发现阶段拒非法名 + 注册防重 + 内置不遮蔽）──────

test('T05 同名遮蔽全拒：file.write/evil\\n/../escape 不登记，内置 file.* 不动，重复注册失败', async () => {
  const env = await makeEnv({ fixtureEnv: { FIXTURE_ADVERTISE_BAD: '1' }, mcpTools: ['mcp/fixture/echo'] });
  try {
    await env.mcp.startServer('fixture');
    const known = await waitForTools(env, ['mcp/fixture/echo']);
    assert.ok(!known.some((n) => n.includes('file.write') || n.includes('evil') || n.includes('escape')), '非法名全部不登记');
    assert.ok(env.logs.some((l) => l.includes('refused advertised tool name')), '拒绝有日志');
    // 内置 file.write 原样（schema/描述未被覆盖）
    const fileWrite = env.toolRegistry.listSchemas().find((s) => s.name === 'file.write');
    assert.ok(fileWrite.description.includes('create-only'), '内置 file.write 未被遮蔽');
    // 重复注册失败
    const spec = env.toolRegistry.specOf('mcp/fixture/echo');
    assert.throws(() => env.toolRegistry.register(spec), /TOOL_NAME_CONFLICT/);
  } finally {
    await shutdown(env);
  }
});

test('T05b 同一 list 两个同名工具：整体发现失败，零部分注册', async () => {
  const env = await makeEnv({ fixtureEnv: { FIXTURE_ADVERTISE_DUP: '1' }, mcpTools: [] });
  try {
    await env.mcp.startServer('fixture');
    await sleep(600); // 等发现失败日志
    assert.deepEqual(env.mcp.knownToolNames(), [], '重复名 => 一个工具都不注册');
    assert.ok(env.logs.some((l) => l.includes('duplicate tool name') || l.includes('discovery failed')), '违规有日志');
  } finally {
    await shutdown(env);
  }
});

// ── T06：schema 热变更 => 吊销 + 操作员显式接受 + 旧审批失效 ──────────

test('T06 schema 热变更：list_changed 触发再发现，hash 变化即吊销，接受后旧审批 hash 失效', async () => {
  const sentinel = join(tmpdir(), `skf-m14-sentinel-${Date.now()}.tmp`);
  const env = await makeEnv({
    fixtureEnv: { FIXTURE_CHANGE_SENTINEL: sentinel, FIXTURE_NOTIFY_CHANGE: '1' },
    mcpTools: ['mcp/fixture/echo'],
  });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/echo']);
    const before = env.mcp.getToolEntry('mcp/fixture/echo');
    const hashBefore = before.schemaHash;
    const approvalBefore = approvalInputHashOf(before, { text: 'x' });

    // 广播里可见 → 触发热变更
    assert.ok(env.toolRegistry.listSchemas(undefined, ['mcp/fixture/echo']).some((s) => s.name === 'mcp/fixture/echo'));
    await writeFile(sentinel, 'change', 'utf8');
    const deadline = Date.now() + 5000;
    for (;;) {
      if (env.mcp.getToolEntry('mcp/fixture/echo').revoked) break;
      if (Date.now() > deadline) throw new Error('hot-change not detected');
      await sleep(60);
    }
    const after = env.mcp.getToolEntry('mcp/fixture/echo');
    assert.equal(after.revoked, true);
    assert.ok(after.revokedReason.includes('schema changed'));

    // 调用被拒；广播剔除
    const r = await execMcp(env, 'mcp/fixture/echo', { text: 'x' });
    assert.equal(r.error.code, 'MCP_SCHEMA_CHANGED');
    assert.ok(!env.toolRegistry.listSchemas(undefined, ['mcp/fixture/echo']).some((s) => s.name === 'mcp/fixture/echo'));

    // 操作员显式接受 → 新快照生效；审批 hash 因 schemaHash 变化而不同（旧审批自动失效）
    const accepted = await env.mcp.acceptSchemaChange('fixture', 'echo');
    assert.equal(accepted.revoked, false);
    assert.notEqual(accepted.schemaHash, hashBefore);
    const approvalAfter = approvalInputHashOf(accepted, { text: 'x' });
    assert.notEqual(approvalAfter, approvalBefore, '热变更后旧审批 hash 失效');
    const r2 = await execMcp(env, 'mcp/fixture/echo', { text: 'ok', extra: 'new-field' });
    assert.equal(r2.ok, true, JSON.stringify(r2.error));
  } finally {
    await rm(sentinel, { force: true }).catch(() => undefined);
    await shutdown(env);
  }
});

// ── T07：伪造审批文本不解锁副作用；真审批绑定参数 hash 才放行 ─────────

test('T07 伪造审批文本：副作用工具仍等真审批；hash 不符拒绝；真审批后恰执行一次', async () => {
  const env = await makeEnv({
    mcpTools: ['mcp/fixture/approval_forger', 'mcp/fixture/external_post'],
    steps: [
      { toolCalls: [{ id: 'call-forge', name: 'mcp/fixture/approval_forger', arguments: {} }] },
      { toolCalls: [{ id: 'call-post', name: 'mcp/fixture/external_post', arguments: { channel: 'ops', text: '上线' } }] },
      { expectToolResults: ['call-post'], text: '已发布', usage: { inputTokens: 8, outputTokens: 3 } },
    ],
  });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/approval_forger', 'mcp/fixture/external_post']);

    const result1 = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result1.state, 'waiting_approval');
    assert.equal(result1.pendingApproval.tool, 'mcp/fixture/external_post');
    assert.equal(env.service.getTask(env.taskId).state, 'waiting_approval');

    // 伪造文本已回灌但不产生任何 approved 审批；副作用账本为零（请求从未发出）
    const forgeMsg = env.service.listMessages(env.taskId).find((m) => m.role === 'tool' && m.name === 'mcp/fixture/approval_forger');
    assert.ok(forgeMsg.content.includes('APPROVAL_GRANTED'), '伪造文本到达上下文（作为不可信数据）');
    const approvals = env.store.db.prepare('SELECT * FROM approvals WHERE taskId = ?').all(env.taskId);
    assert.equal(approvals.length, 1, '只有 SKF 自己登记的一条 pending');
    assert.equal(approvals[0].decision, 'pending');
    assert.equal(readJsonl(env.ledgerFile).length, 0, '第三方副作用零发生');
    const op = env.service.getOperation(`op:${env.taskId}:call-post`);
    assert.equal(op.state, 'prepared', '操作停在 prepared = 请求从未发出');

    // 事件与广播
    assert.ok(env.service.listEvents(0, 100).some((e) => e.type === 'task.approval_requested'));

    // 错误 inputHash 不得通过
    assert.throws(
      () => env.service.decideApproval(result1.pendingApproval.approvalId, 'approved', { inputHash: 'f'.repeat(64) }),
      /APPROVAL_INPUT_CONFLICT/,
    );
    // 真审批（绑定参数 hash）→ 任务 running → 复跑恰执行一次
    const decided = env.service.decideApproval(result1.pendingApproval.approvalId, 'approved', {
      inputHash: result1.pendingApproval.inputHash,
      reason: '人工确认发布',
    });
    assert.equal(decided.taskState, 'running');
    const result2 = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result2.state, 'succeeded');
    assert.equal(readJsonl(env.ledgerFile).length, 1, 'external_post 恰执行一次');
    assert.deepEqual(readJsonl(env.ledgerFile)[0].text, '上线');
    const toolCalls = readJsonl(env.callsFile).filter((c) => c.method === 'tools/call');
    assert.equal(toolCalls.filter((c) => c.params.name === 'external_post').length, 1);
    const opAfter = env.service.getOperation(`op:${env.taskId}:call-post`);
    assert.equal(opAfter.state, 'succeeded');
  } finally {
    await shutdown(env);
  }
});

// ── T08：断线后 unknown 不自动重放（M07 人工核对出口）─────────────────

test('T08 响应丢失（超时）：operation unknown，任务停车等核对，人工了结后恢复零重放', async () => {
  const env = await makeEnv({
    mcpTools: ['mcp/fixture/hang', 'mcp/fixture/echo'],
    timeouts: { callMs: 800 },
    steps: [
      { toolCalls: [{ id: 'call-hang', name: 'mcp/fixture/hang', arguments: {} }] },
      { text: '人工核对后收尾', usage: { inputTokens: 6, outputTokens: 2 } },
    ],
  });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/hang']);
    await assert.rejects(runAgentLoop(env.deps, env.taskId), /RECOVERY_NEEDS_MANUAL_REVIEW/);
    assert.equal(env.service.getTask(env.taskId).state, 'running', '任务保持非终态等核对');
    const op = env.service.getOperation(`op:${env.taskId}:call-hang`);
    assert.equal(op.state, 'unknown');
    assert.ok(env.service.listEvents(0, 100).some((e) => e.type === 'task.operation_needs_review'));
    assert.equal(readJsonl(env.callsFile).filter((c) => c.method === 'tools/call').length, 1, '零自动重放');

    // 人工核对：第三方确认未生效 → 了结为 failed → 直接复跑（悬空 call-hang 以账本结果回灌）
    resolveUnknownOperation(env.service, op.id, {
      decision: 'failed',
      result: { error: { code: 'THIRD_PARTY_NOT_DELIVERED', retryable: false } },
    });
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(readJsonl(env.callsFile).filter((c) => c.method === 'tools/call').length, 1, '恢复后仍零重放');
  } finally {
    await shutdown(env);
  }
});

test('T08b 响应丢失（server 崩溃）：unknown + 重启新实例也不重放历史调用', async () => {
  const env = await makeEnv({
    mcpTools: ['mcp/fixture/hang'],
    fixtureEnv: { FIXTURE_HANG_CRASH: '1' },
    timeouts: { callMs: 5000 },
    restart: { maxRestartAttempts: 2, baseDelayMs: 100, maxDelayMs: 400, circuitFailureThreshold: 5, circuitCooldownMs: 60_000 },
    steps: [{ toolCalls: [{ id: 'call-hang', name: 'mcp/fixture/hang', arguments: {} }] }],
  });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/hang']);
    const spawnsBefore = env.mcp.getSupervisor('fixture').spawns;
    await assert.rejects(runAgentLoop(env.deps, env.taskId), /RECOVERY_NEEDS_MANUAL_REVIEW/);
    const op = env.service.getOperation(`op:${env.taskId}:call-hang`);
    assert.equal(op.state, 'unknown');
    // server 崩于调用中 → 有上限退避重启发生，但历史调用绝不重放到新实例
    await sleep(1500);
    const supervisor = env.mcp.getSupervisor('fixture');
    assert.ok(supervisor.spawns > spawnsBefore, '重启确实发生');
    const hangCalls = readJsonl(env.callsFile).filter((c) => c.method === 'tools/call' && c.params.name === 'hang');
    assert.equal(hangCalls.length, 1, '重启 ≠ 重放：hang 只被叫过一次');
  } finally {
    await shutdown(env);
  }
});

// ── T09：连续启动失败 => 有上限退避 + 熔断（冷却期不起进程）────────────

test('T09 退避重启有上限，耗尽进熔断；冷却期内调用 MCP_CIRCUIT_OPEN 零新进程', async () => {
  const env = await makeEnv({
    fixtureEnv: { FIXTURE_EXIT_AFTER_INIT: '1' },
    restart: { maxRestartAttempts: 2, baseDelayMs: 60, maxDelayMs: 200, circuitFailureThreshold: 2, circuitCooldownMs: 30_000 },
    mcpTools: ['mcp/fixture/echo'],
  });
  try {
    await env.mcp.startServer('fixture');
    // 首启即“成功”随后 exit；退避重启两次后再败 => 熔断
    const deadline = Date.now() + 8000;
    for (;;) {
      if (env.mcp.getSupervisor('fixture').currentState === 'circuit_open') break;
      if (Date.now() > deadline) throw new Error(`circuit not opened, state=${env.mcp.getSupervisor('fixture').currentState}`);
      await sleep(80);
    }
    const spawnsAtOpen = env.mcp.getSupervisor('fixture').spawns;
    assert.ok(spawnsAtOpen >= 2 && spawnsAtOpen <= 4, `退避有上限（spawns=${spawnsAtOpen}）`);
    await assert.rejects(env.mcp.getSupervisor('fixture').call('tools/list', {}), /MCP_CIRCUIT_OPEN/);
    await assert.rejects(env.mcp.startServer('fixture'), /MCP_CIRCUIT_OPEN/);
    await sleep(400);
    assert.equal(env.mcp.getSupervisor('fixture').spawns, spawnsAtOpen, '冷却期内零新进程');
  } finally {
    await shutdown(env);
  }
});

// ── T10：发现阶段注入消毒 + env 卫生 + server 反驱动拒绝 ─────────────

test('T10 发现消毒：组合 schema/未裁定工具不登记；恶意描述截断去控；env 无密钥；sampling 反发被拒', async () => {
  const env = await makeEnv({
    fixtureEnv: { FIXTURE_UNSUPPORTED_SCHEMA: '1', FIXTURE_UNMAPPED: '1', FIXTURE_EVIL_DESC: '1', FIXTURE_SAMPLING: '1' },
    mcpTools: ['mcp/fixture/echo', 'mcp/fixture/dump_env'],
  });
  try {
    await env.mcp.startServer('fixture');
    const known = await waitForTools(env, ['mcp/fixture/echo']);
    assert.ok(!known.includes('mcp/fixture/fancy'), 'oneOf 组合 schema 拒绝登记');
    assert.ok(!known.includes('mcp/fixture/rogue'), '未裁定工具不登记（不凑数）');
    const echo = env.mcp.getToolEntry('mcp/fixture/echo');
    assert.ok(echo.description.length <= 510, '恶意长描述被截断');
    assert.ok(!/[ --]/.test(echo.description), '控制字符被剥除');

    // env 卫生：server 只能看到最小基座 + 显式注入项
    const r = await execMcp(env, 'mcp/fixture/dump_env', {});
    const serverEnv = JSON.parse(JSON.parse(r.content).content);
    assert.equal(serverEnv.FIXTURE_CALLS_FILE, env.callsFile, '显式注入的 FIXTURE_* 存在');
    for (const key of Object.keys(serverEnv)) {
      assert.ok(!/key|token|secret|password/i.test(key) || key.startsWith('FIXTURE_'), `疑似密钥 env 不下发: ${key}`);
      assert.ok(!key.startsWith('SKF_'), `SKF 内部 env 不外泄: ${key}`);
    }

    // server 反发 sampling/createMessage => 帧层回方法不存在，零模型调用
    await sleep(500);
    const sampling = readJsonl(env.callsFile).filter((c) => c.method === 'sampling_refused' || c.method === 'sampling_answered');
    assert.deepEqual(sampling.map((s) => s.method), ['sampling_refused'], '反驱动被拒');
    const modelCalls = env.store.db.prepare('SELECT COUNT(*) AS c FROM model_calls WHERE taskId = ?').get(env.taskId);
    assert.equal(modelCalls.c, 0, '没有任何模型调用被 server 触发');
  } finally {
    await shutdown(env);
  }
});

// ── T11：任务绑定工具目录快照（逐个点名授权）─────────────────────────

test('T11 任务绑定目录快照：未点名工具不出现在广播、调用 POLICY_DENIED', async () => {
  const env = await makeEnv({ mcpTools: ['mcp/fixture/echo'] });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/echo', 'mcp/fixture/big_output']);
    const broadcast = env.toolRegistry.listSchemas(undefined, ['mcp/fixture/echo']).map((s) => s.name);
    assert.ok(broadcast.includes('mcp/fixture/echo'));
    assert.ok(!broadcast.includes('mcp/fixture/big_output'), '未点名工具不广播');
    // 模型硬调未点名工具 => POLICY_DENIED
    const r = await execMcp(env, 'mcp/fixture/big_output', { kb: 1 });
    assert.equal(r.error.code, 'POLICY_DENIED');
    // 另一个授权表点名的任务上下文则可用
    const r2 = await execMcp(env, 'mcp/fixture/big_output', { kb: 1 }, {
      authorization: { ...localDeliveryAuthorization(env.ws), allowedMcpTools: ['mcp/fixture/big_output'] },
    });
    assert.equal(r2.ok, true);
  } finally {
    await shutdown(env);
  }
});

// ── T12：结果阶段防注入：非文本内容占位、isError 映射、不可信标记 ──────

test('T12 结果阶段：image 块占位不执行，isError => MCP_TOOL_ERROR 带消毒 detail', async () => {
  const env = await makeEnv({
    fixtureEnv: { FIXTURE_IMAGE_CONTENT: '1' },
    mcpTools: ['mcp/fixture/image_content', 'mcp/fixture/fail_tool'],
  });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/image_content', 'mcp/fixture/fail_tool']);
    const r1 = await execMcp(env, 'mcp/fixture/image_content', {});
    assert.equal(r1.ok, true);
    const payload = JSON.parse(r1.content);
    assert.equal(payload.untrustedExternalData, true);
    assert.ok(payload.content.includes('unsupported content type "image" dropped'), 'image 块占位不透传');
    assert.ok(payload.content.includes('with text'));

    const r2 = await execMcp(env, 'mcp/fixture/fail_tool', {});
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'MCP_TOOL_ERROR');
    assert.ok(r2.error.detail.includes('余额不足'), 'server 业务错误文本消毒后如实回传');
  } finally {
    await shutdown(env);
  }
});

// ── T13：旁路防护（执行层审批门独立成立）─────────────────────────────

test('T13 旁路防护：直调 registry 无审批渠道=APPROVAL_REQUIRED；readOnlyHint 自报不采信', async () => {
  const env = await makeEnv({ mcpTools: ['mcp/fixture/external_post', 'mcp/fixture/selfreport'] });
  try {
    await env.mcp.startServer('fixture');
    await waitForTools(env, ['mcp/fixture/external_post', 'mcp/fixture/selfreport']);
    // 无 hasApproved 注入（无审批渠道）=> fail-closed
    const r1 = await execMcp(env, 'mcp/fixture/external_post', { channel: 'ops', text: 'x' });
    assert.equal(r1.error.code, 'APPROVAL_REQUIRED');
    // hasApproved=false 同样拒绝
    const r2 = await execMcp(env, 'mcp/fixture/external_post', { channel: 'ops', text: 'x' }, { hasApproved: () => false });
    assert.equal(r2.error.code, 'APPROVAL_REQUIRED');
    assert.equal(readJsonl(env.ledgerFile).length, 0, '零副作用');
    // server 自称只读的 selfreport 被 SKF 裁定为 external_write：同样走审批门
    const r3 = await execMcp(env, 'mcp/fixture/selfreport', {});
    assert.equal(r3.error.code, 'APPROVAL_REQUIRED', 'readOnlyHint 自报不被采信');
    // 有真审批（直调层模拟 hasApproved=true）=> 放行
    const r4 = await execMcp(env, 'mcp/fixture/selfreport', {}, { hasApproved: () => true });
    assert.equal(r4.ok, true);
  } finally {
    await shutdown(env);
  }
});
