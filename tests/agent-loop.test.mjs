import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { FakeScriptedProvider } from '../dist/providers/fake-scripted.js';
import { runAgentLoop, ABSOLUTE_LOOP_LIMITS } from '../dist/runtime/agent-loop.js';
import { parseAcceptance, verifyAcceptance } from '../dist/runtime/artifact-verifier.js';

// M05 验收：真实 AgentLoop + 可信产物验证。
// 覆盖 L01（两轮文件交付成功）、L02（模型谎称已写必须失败）、L03（NO_PROGRESS）、
// 跨重启去重、同 ID 改 args 冲突、崩溃遗留写操作的实物核对恢复、步数/工具/时限上限、
// 终态事务事件 + memory outbox（含记忆故障保留产物）、验收器单元行为。
// 全部 fake provider / 本机临时目录，零网络、零付费调用。

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m05-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

async function makeEnv(fixtureSteps, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m05-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ steps: fixtureSteps }), 'utf8');
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm05-test');
  const registry = new ToolRegistry();
  const provider = opts.provider ?? new FakeScriptedProvider({ fixturePath: fixture, enabled: true });
  const toolCallsSeen = [];
  const origExecute = registry.execute.bind(registry);
  registry.execute = async (callId, name, args, ctx) => {
    toolCallsSeen.push(name);
    return origExecute(callId, name, args, ctx);
  };
  const taskId = opts.taskId ?? 'task-m05';
  service.createTask({
    id: taskId,
    input: { goal: opts.goal ?? '创建报价说明 Markdown' },
    sessionId: 's-m05',
    scope: 'skf-test',
    workspaceRoot: ws,
    provider: 'fake',
    model: 'fake-scripted-1',
    ...(opts.acceptance !== undefined ? { acceptance: opts.acceptance } : {}),
  });
  const deps = {
    service,
    provider,
    tools: registry,
    authorization: localDeliveryAuthorization(ws),
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.flushMemoryOutbox ? { flushMemoryOutbox: opts.flushMemoryOutbox } : {}),
  };
  return { root, ws, store, service, registry, provider, taskId, deps, toolCallsSeen };
}

const QUOTE_MD = '# 报价说明\n\n- 设计服务费：800 元\n- 交付周期：5 个工作日\n\n以最终确认为准。\n';
const QUOTE_ACCEPTANCE = {
  kind: 'file_deliverable',
  files: [{ path: 'quote.md', minBytes: 20, mustContain: ['报价说明', '800'] }],
};

// ── L01：创建 → 读回验证 → 返回 artifact，两轮历史完整 ─────────────

test('L01 两轮完整交付：fake 校验同 ID tool message，artifact 登记+核验，双步账本', async () => {
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }], usage: { inputTokens: 10, outputTokens: 5 } },
      { expectToolResults: ['call-1'], text: '报价说明已创建，文件 quote.md 在工作区内。', usage: { inputTokens: 30, outputTokens: 12 } },
    ],
    { acceptance: QUOTE_ACCEPTANCE, flushMemoryOutbox: async () => {} },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.errorCode, null);
    assert.equal(result.modelSteps, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.memoryOutboxPending, false);

    // 实物：文件真实存在且 hash 与 artifact 一致
    const onDisk = await readFile(join(env.ws, 'quote.md'));
    assert.equal(onDisk.toString('utf8'), QUOTE_MD);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].relativePath, 'quote.md');
    assert.equal(result.artifacts[0].sha256, sha256(onDisk));
    const artifactRow = env.store.db.prepare('SELECT * FROM artifacts WHERE taskId = ?').get(env.taskId);
    assert.ok(artifactRow.verifiedAt, 'artifact must be marked verified');

    // 消息历史：system/user/assistant(toolCalls)/tool(同 callId)/assistant(final)
    const messages = env.service.listMessages(env.taskId);
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
    const toolMsg = messages[3];
    assert.equal(toolMsg.toolCallId, 'call-1');
    assert.equal(toolMsg.name, 'file.write');
    const toolPayload = JSON.parse(toolMsg.content);
    assert.equal(toolPayload.sha256, sha256(onDisk));

    // 两个模型步骤均有账本（fake zero-cost ledger，usage 口径保留）
    const calls = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ? ORDER BY createdAt ASC').all(env.taskId);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.state === 'settled'));
    assert.deepEqual(JSON.parse(calls[0].usage), { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, source: 'provider' });

    // 终态事件 + memory outbox 已投递
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    assert.ok(events.some((e) => e.type === 'task.running'));
    assert.ok(events.some((e) => e.type === 'task.tool'));
    assert.ok(events.some((e) => e.type === 'task.acceptance' && e.safePayload.ok === true));
    assert.ok(events.some((e) => e.type === 'task.succeeded'));
    const outbox = env.store.db.prepare('SELECT * FROM outbox WHERE taskId = ?').get(env.taskId);
    assert.equal(outbox.kind, 'memory_writeback');
    assert.equal(outbox.state, 'done');

    // 跨重启去重：终态任务再跑 = 直接返回账本结果，不再发模型/工具
    const again = await runAgentLoop(env.deps, env.taskId);
    assert.equal(again.state, 'succeeded');
    assert.equal(again.modelSteps, 2);
    assert.deepEqual(env.toolCallsSeen, ['file.write']);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── L02：模型谎称「已写」但不发工具 → 一次纠正后仍无证据 → 失败 ─────

test('L02 模型谎称已写但不发工具：不接受文本声称，纠正一次后 ACCEPTANCE_NOT_MET', async () => {
  const env = await makeEnv(
    [
      { text: '已写入 quote.md，任务完成。' },
      { text: '确认文件已经写好了。' },
    ],
    { acceptance: QUOTE_ACCEPTANCE },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'ACCEPTANCE_NOT_MET');
    assert.equal(result.toolCalls, 0);
    assert.equal(result.modelSteps, 2, 'original + one bounded correction');
    assert.equal(result.artifacts.length, 0);
    // 真实响应与纠正消息都持久化
    const messages = env.service.listMessages(env.taskId);
    const roles = messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'user', 'assistant']);
    assert.match(messages[3].content, /验收未通过/);
    assert.match(messages[3].content, /唯一一次纠正机会/);
    assert.equal(result.finalText, '确认文件已经写好了。');
    // 磁盘上确实没有文件
    await assert.rejects(readFile(join(env.ws, 'quote.md')));
    const task = env.service.getTask(env.taskId);
    assert.equal(task.state, 'failed');
    assert.equal(task.errorCode, 'ACCEPTANCE_NOT_MET');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── L03：连续 2 次相同工具+args+结果无新证据 → NO_PROGRESS ──────────

test('L03 循环相同工具+args+结果：第二次即 NO_PROGRESS，不超上限', async () => {
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'c1', name: 'file.list', arguments: { path: '.' } }] },
      { expectToolResults: ['c1'], toolCalls: [{ id: 'c2', name: 'file.list', arguments: { path: '.' } }] },
      { text: '不该走到这里' },
    ],
    { acceptance: QUOTE_ACCEPTANCE },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'NO_PROGRESS');
    assert.equal(result.modelSteps, 2);
    assert.equal(result.toolCalls, 2);
    assert.ok(result.modelSteps <= ABSOLUTE_LOOP_LIMITS.maxModelSteps);
    assert.ok(result.toolCalls <= ABSOLUTE_LOOP_LIMITS.maxToolCalls);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 跨重启去重：同 call+同 args 返回已持久结果，不重复执行工具 ──────

test('重放同 callId 同 args：返回账本结果，工具执行次数为 0', async () => {
  const args = { path: 'a.md', content: 'hello' };
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: args }] },
      { expectToolResults: ['call-1'], text: '已完成' },
    ],
    { goal: '重复执行防护' },
  );
  try {
    // 模拟崩溃前已完成的成功操作（结果已持久，tool message 丢失）
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-1`, taskId: env.taskId, callId: 'call-1', toolName: 'file.write', input: args });
    env.service.transitionOperation(`op:${env.taskId}:call-1`, 'running');
    env.service.transitionOperation(`op:${env.taskId}:call-1`, 'succeeded', {
      result: { path: 'a.md', byteLength: 5, sha256: sha256(Buffer.from('hello', 'utf8')), created: true },
    });

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(env.toolCallsSeen.length, 0, 'no tool re-execution');
    // 回灌的是账本里的旧结果
    const toolMsg = env.service.listMessages(env.taskId).find((m) => m.role === 'tool');
    assert.equal(toolMsg.toolCallId, 'call-1');
    assert.match(toolMsg.content, /"created":true/);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 同 ID 改 args → 冲突 ─────────────────────────────────────────

test('同 callId 改 args：REQUEST_ID_CONFLICT，任务失败', async () => {
  const env = await makeEnv(
    [{ toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'b.md', content: 'changed' } }] }],
    { goal: '冲突检测' },
  );
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-1`, taskId: env.taskId, callId: 'call-1', toolName: 'file.write', input: { path: 'a.md', content: 'original' } });
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'REQUEST_ID_CONFLICT');
    assert.equal(env.toolCallsSeen.length, 0);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 崩溃遗留写操作：按磁盘实物补记，不重复写入 ─────────────────────

test('running 状态遗留 + 磁盘实物一致：补记 succeeded+artifact，不重复 file.write', async () => {
  const args = { path: 'r.md', content: '# 恢复验证\n内容一致。\n' };
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-r', name: 'file.write', arguments: args }] },
      { expectToolResults: ['call-r'], text: '恢复完成' },
    ],
    { acceptance: { kind: 'file_deliverable', files: [{ path: 'r.md', mustContain: ['恢复验证'] }] } },
  );
  try {
    // 崩溃现场：操作 running，文件实际已写成功
    await writeFile(join(env.ws, 'r.md'), args.content, 'utf8');
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-r`, taskId: env.taskId, callId: 'call-r', toolName: 'file.write', input: args });
    env.service.transitionOperation(`op:${env.taskId}:call-r`, 'running');

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(env.toolCallsSeen, ['file.stat'], '只核对实物，不重放写副作用');
    const op = env.service.getOperation(`op:${env.taskId}:call-r`);
    assert.equal(op.state, 'succeeded');
    assert.equal(op.result.recovered, true);
    assert.equal(op.result.created, false);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].sha256, sha256(Buffer.from(args.content, 'utf8')));
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    assert.ok(events.some((e) => e.type === 'task.tool_recovered'));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 崩溃遗留 reserved 模型调用：uncertain 后失败，不静默重发 ──────

test('reserved 模型调用崩溃遗留：标 uncertain 后 MODEL_CALL_UNCERTAIN，不重发请求，费用不记 0', async () => {
  let providerCalls = 0;
  const countingProvider = {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete() {
      providerCalls += 1;
      return {
        provider: 'fake',
        model: 'fake-scripted-1',
        assistant: { role: 'assistant', content: '不该被发出' },
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, source: 'provider' },
      };
    },
  };
  const env = await makeEnv([], { provider: countingProvider, goal: '恢复语义' });
  try {
    // 崩溃现场：任务 running，模型请求已持久预留（reserved）但未回响应、未落 settled
    env.service.transitionTask(env.taskId, 'running');
    env.service.recordModelCall({ id: `mc:${env.taskId}:1`, taskId: env.taskId, purpose: 'chat', provider: 'fake', model: 'fake-scripted-1' });

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'MODEL_CALL_UNCERTAIN');
    assert.equal(providerCalls, 0, '绝不静默重发可能已计费的请求');

    // 账本：reserved → uncertain；usage 保持 NULL，settledCostMicros 保持 NULL（不无证据记成 0）
    const call = env.store.db.prepare('SELECT * FROM model_calls WHERE id = ?').get(`mc:${env.taskId}:1`);
    assert.equal(call.state, 'uncertain');
    assert.equal(call.usage, null);
    assert.equal(call.settledCostMicros, null);

    // 任务/事件一致：failed + errorCode + 终态事件 + outbox 落库
    const task = env.service.getTask(env.taskId);
    assert.equal(task.state, 'failed');
    assert.equal(task.errorCode, 'MODEL_CALL_UNCERTAIN');
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    const failedEvent = events.find((e) => e.type === 'task.failed');
    assert.ok(failedEvent, 'terminal event persisted');
    assert.equal(failedEvent.safePayload.errorCode, 'MODEL_CALL_UNCERTAIN');
    const outbox = env.store.db.prepare('SELECT * FROM outbox WHERE taskId = ?').get(env.taskId);
    assert.equal(outbox.kind, 'memory_writeback');

    // 重入安全：终态去重，仍零请求
    const again = await runAgentLoop(env.deps, env.taskId);
    assert.equal(again.state, 'failed');
    assert.equal(providerCalls, 0);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 崩溃遗留操作：prepared 状态 + 实物不一致 → 保守失败 ────────────

test('prepared 遗留写操作 + 磁盘实物不一致：OPERATION_OUTCOME_UNKNOWN，实物不动，不重放写', async () => {
  const args = { path: 'p.md', content: 'AAAA 预期内容' };
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-p', name: 'file.write', arguments: args }] },
      { expectToolResults: ['call-p'], text: '收到，改用其他方式处理' },
    ],
    { goal: '遗留操作保守了结' },
  );
  try {
    // 崩溃现场：操作只到 prepared（未执行或执行结果未知），磁盘上是别的内容
    await writeFile(join(env.ws, 'p.md'), 'BBBB 用户自己的内容', 'utf8');
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-p`, taskId: env.taskId, callId: 'call-p', toolName: 'file.write', input: args });

    const result = await runAgentLoop(env.deps, env.taskId);
    // 不假定副作用没发生：核对实物不一致 → 保守 failed，绝不重放写
    assert.deepEqual(env.toolCallsSeen, ['file.stat'], '只核对实物，不执行 file.write');
    const op = env.service.getOperation(`op:${env.taskId}:call-p`);
    assert.equal(op.state, 'failed');
    assert.equal(op.result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
    // 实物原样保留，结果回灌同 ID tool message 后模型继续
    assert.equal(await readFile(join(env.ws, 'p.md'), 'utf8'), 'BBBB 用户自己的内容');
    const toolMsg = env.service.listMessages(env.taskId).find((m) => m.role === 'tool');
    assert.equal(toolMsg.toolCallId, 'call-p');
    assert.match(toolMsg.content, /OPERATION_OUTCOME_UNKNOWN/);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.artifacts.length, 0, '失败路径不得登记 artifact');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 崩溃遗留非写工具：一律保守失败，不自动重放 ────────────────────

test('running 遗留只读工具：OPERATION_OUTCOME_UNKNOWN，不自动重放，结果回灌后任务继续', async () => {
  const args = { path: 'a.md' };
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-x', name: 'file.read', arguments: args }] },
      { expectToolResults: ['call-x'], text: '明白，读取结果未知，我直接给出结论' },
    ],
    { goal: '只读工具遗留' },
  );
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-x`, taskId: env.taskId, callId: 'call-x', toolName: 'file.read', input: args });
    env.service.transitionOperation(`op:${env.taskId}:call-x`, 'running');

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(env.toolCallsSeen.length, 0, '只读工具遗留也不自动重放');
    const op = env.service.getOperation(`op:${env.taskId}:call-x`);
    assert.equal(op.state, 'failed');
    assert.equal(op.result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
    const toolMsg = env.service.listMessages(env.taskId).find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /OPERATION_OUTCOME_UNKNOWN/);
    assert.equal(result.state, 'succeeded');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 上限：步数 / 工具次 / 时限 / 绝对上限不可扩大 ──────────────────

test('STEP_LIMIT_EXCEEDED：模型步数到顶即失败，不再发请求', async () => {
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'c1', name: 'file.list', arguments: { path: '.' } }] },
      { expectToolResults: ['c1'], toolCalls: [{ id: 'c2', name: 'file.list', arguments: { path: '.', maxEntries: 5 } }] },
    ],
    { limits: { maxModelSteps: 2 }, acceptance: QUOTE_ACCEPTANCE },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'STEP_LIMIT_EXCEEDED');
    assert.equal(result.modelSteps, 2);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('TOOL_LIMIT_EXCEEDED：工具次到顶即失败', async () => {
  const env = await makeEnv(
    [
      {
        toolCalls: [
          { id: 'c1', name: 'file.list', arguments: { path: '.' } },
          { id: 'c2', name: 'file.list', arguments: { path: '.', maxEntries: 3 } },
        ],
      },
    ],
    { limits: { maxToolCalls: 1 }, acceptance: QUOTE_ACCEPTANCE },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'TOOL_LIMIT_EXCEEDED');
    assert.equal(result.toolCalls, 1);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('LOOP_DEADLINE_EXCEEDED：慢模型超过总时限即失败', async () => {
  const slowProvider = {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete() {
      await new Promise((r) => setTimeout(r, 60));
      return {
        provider: 'fake',
        model: 'fake-slow',
        assistant: { role: 'assistant', content: '等一下' },
        finishReason: 'stop',
        usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' },
      };
    },
  };
  const env = await makeEnv([], { provider: slowProvider, limits: { maxDurationMs: 20 }, acceptance: QUOTE_ACCEPTANCE });
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'LOOP_DEADLINE_EXCEEDED');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('上限只能调小：超过绝对上限直接拒绝', async () => {
  const env = await makeEnv([], { limits: { maxModelSteps: ABSOLUTE_LOOP_LIMITS.maxModelSteps + 1 } });
  try {
    await assert.rejects(runAgentLoop(env.deps, env.taskId), /INVALID_INPUT/);
    await assert.rejects(
      runAgentLoop({ ...env.deps, limits: { maxDurationMs: ABSOLUTE_LOOP_LIMITS.maxDurationMs + 1 } }, env.taskId),
      /INVALID_INPUT/,
    );
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 终态事务：记忆故障保留交付产物，outbox 留 pending ──────────────

test('记忆写回故障：任务仍 succeeded、产物保留、outbox pending 且重放安全', async () => {
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }] },
      { expectToolResults: ['call-1'], text: 'done' },
    ],
    {
      acceptance: QUOTE_ACCEPTANCE,
      flushMemoryOutbox: async () => {
        throw new Error('vault unavailable');
      },
    },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded', '记忆故障不改变已核验的交付终态');
    assert.equal(result.memoryOutboxPending, true);
    // 产物完好
    const onDisk = await readFile(join(env.ws, 'quote.md'), 'utf8');
    assert.equal(onDisk, QUOTE_MD);
    const outbox = env.store.db.prepare('SELECT * FROM outbox WHERE taskId = ?').get(env.taskId);
    assert.equal(outbox.state, 'pending');
    assert.equal(outbox.attempts, 1);
    assert.match(outbox.lastError, /vault unavailable/);
    // 恢复路径只补写不重放工具：终态重入零副作用
    const again = await runAgentLoop(env.deps, env.taskId);
    assert.equal(again.state, 'succeeded');
    assert.deepEqual(env.toolCallsSeen, ['file.write']);
    // 模拟恢复后的补投递：同一幂等键标 done，不产生第二条 outbox
    env.service.markOutbox(outbox.id, { state: 'done' });
    const rows = env.store.db.prepare('SELECT COUNT(*) AS c FROM outbox WHERE taskId = ?').get(env.taskId);
    assert.equal(rows.c, 1);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── 验收器单元行为 ───────────────────────────────────────────────

test('parseAcceptance 严格校验：坏 kind/多余字段/边界矛盾全拒', async () => {
  assert.throws(() => parseAcceptance({ kind: 'other', files: [{ path: 'a' }] }), /ACCEPTANCE_INVALID/);
  assert.throws(() => parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'a', bogus: 1 }] }), /ACCEPTANCE_INVALID/);
  assert.throws(() => parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'a', minBytes: 10, maxBytes: 5 }] }), /ACCEPTANCE_INVALID/);
  assert.throws(() => parseAcceptance({ kind: 'file_deliverable', files: [] }), /ACCEPTANCE_INVALID/);
  const ok = parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'a.md', sha256: sha256(Buffer.from('x')) }] });
  assert.equal(ok.files[0].path, 'a.md');
});

test('verifyAcceptance：存在/字节/hash/文本/路径越界/artifact 实物核对', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m05-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  try {
    const content = '# 报价\n金额 800 元\n';
    await writeFile(join(ws, 'q.md'), content, 'utf8');
    const goodHash = sha256(Buffer.from(content, 'utf8'));

    const pass = await verifyAcceptance({
      workspaceRoot: ws,
      acceptance: parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'q.md', minBytes: 5, sha256: goodHash, mustContain: ['800'] }] }),
      artifacts: [{ relativePath: 'q.md', byteLength: Buffer.byteLength(content), sha256: goodHash }],
    });
    assert.equal(pass.ok, true);
    assert.equal(pass.verified[0].sha256, goodHash);

    const badHash = await verifyAcceptance({
      workspaceRoot: ws,
      acceptance: parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'q.md', sha256: sha256(Buffer.from('other')) }] }),
      artifacts: [],
    });
    assert.equal(badHash.ok, false);
    assert.equal(badHash.failures[0].code, 'HASH_MISMATCH');

    const missing = await verifyAcceptance({
      workspaceRoot: ws,
      acceptance: parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'nope.md' }] }),
      artifacts: [],
    });
    assert.equal(missing.failures[0].code, 'FILE_MISSING');

    const escape = await verifyAcceptance({
      workspaceRoot: ws,
      acceptance: parseAcceptance({ kind: 'file_deliverable', files: [{ path: '../outside.md' }] }),
      artifacts: [],
    });
    assert.equal(escape.failures[0].code, 'ACCEPTANCE_PATH_INVALID');

    const stale = await verifyAcceptance({
      workspaceRoot: ws,
      acceptance: parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'q.md' }] }),
      artifacts: [{ relativePath: 'q.md', byteLength: 3, sha256: sha256(Buffer.from('tampered')) }],
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.failures[0].code, 'ARTIFACT_STALE');

    const needText = await verifyAcceptance({
      workspaceRoot: ws,
      acceptance: parseAcceptance({ kind: 'file_deliverable', files: [{ path: 'q.md', mustContain: ['不存在的内容'] }] }),
      artifacts: [],
    });
    assert.equal(needText.failures[0].code, 'CONTENT_MISSING');
  } finally {
    await cleanupTestRoot(root);
  }
});
