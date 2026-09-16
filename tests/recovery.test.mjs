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
import { ProviderError } from '../dist/providers/protocol.js';
import { runAgentLoop } from '../dist/runtime/agent-loop.js';
import { ModelGateway } from '../dist/runtime/model-gateway.js';
import {
  TaskControllerRegistry,
  requestTaskCancel,
  finalizeCancelled,
  resumePreflight,
  resumeTask,
  resolveUnknownOperation,
  flushPendingMemoryOutbox,
  exportTaskEvidence,
  listArtifacts,
} from '../dist/runtime/recovery.js';

// M07 验收：取消、恢复与不确定副作用。
// 精确故障点：工具前 / provider 响应中 / rename 后结果前 / 结果后事件前 /
// 记忆 outbox 前后；每点验证磁盘实物与账本（model_calls/operations/artifacts/
// events/outbox），不只看返回文案。全部 fake provider / 临时目录，零网络零付费。

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m07-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function waitAbort(signal, fallbackMs = 5000) {
  return new Promise((resolvePromise) => {
    if (signal.aborted) return resolvePromise();
    signal.addEventListener('abort', resolvePromise, { once: true });
    const t = setTimeout(resolvePromise, fallbackMs);
    t.unref?.();
  });
}

/** provider 响应中阻塞直到 abort：观测取消是否及时到达底层。 */
function blockingProvider(observed) {
  return {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete(req) {
      observed.started = Date.now();
      await waitAbort(req.signal);
      observed.aborted = req.signal.aborted;
      observed.latencyMs = Date.now() - observed.started;
      throw new ProviderError('PROVIDER_ABORTED');
    },
  };
}

async function makeEnv(fixtureSteps, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m07-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ steps: fixtureSteps }), 'utf8');
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm07-test');
  const registry = new ToolRegistry();
  const provider = opts.provider ?? new FakeScriptedProvider({ fixturePath: fixture, enabled: true });
  const toolCallsSeen = [];
  const origExecute = registry.execute.bind(registry);
  registry.execute = async (callId, name, args, ctx) => {
    toolCallsSeen.push(name);
    if (opts.beforeToolExecute) await opts.beforeToolExecute(name);
    return origExecute(callId, name, args, ctx);
  };
  const controllers = opts.controllers ?? new TaskControllerRegistry();
  const taskId = opts.taskId ?? 'task-m07';
  service.createTask({
    id: taskId,
    input: { goal: opts.goal ?? 'M07 取消恢复测试' },
    sessionId: 's-m07',
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
    controllers,
    ...(opts.gateway ? { gateway: opts.gateway } : {}),
    ...(opts.flushMemoryOutbox ? { flushMemoryOutbox: opts.flushMemoryOutbox } : {}),
  };
  return { root, ws, store, service, registry, provider, controllers, taskId, deps, toolCallsSeen };
}

const QUOTE_MD = '# 报价说明\n\n- 设计服务费：800 元\n';
const QUOTE_ACCEPTANCE = {
  kind: 'file_deliverable',
  files: [{ path: 'quote.md', minBytes: 10, mustContain: ['报价说明'] }],
};

// ── C01：queued 任务取消（先持久意图再完成；重复取消幂等）────────────

test('C01 queued 取消：意图+终态事件+outbox 落库；重复取消幂等；不再执行任何副作用', async () => {
  let providerCalls = 0;
  const counting = {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete() {
      providerCalls += 1;
      throw new Error('不应被调用');
    },
  };
  const env = await makeEnv([], { provider: counting });
  try {
    const first = await requestTaskCancel(env.service, env.taskId, { reason: 'user-stop' });
    assert.equal(first.state, 'cancelled');
    assert.equal(first.idempotent, false);
    assert.equal(first.artifacts.length, 0);

    const task = env.service.getTask(env.taskId);
    assert.equal(task.state, 'cancelled');
    assert.equal(task.errorCode, 'TASK_CANCELLED');

    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    assert.equal(events.filter((e) => e.type === 'task.cancel_requested').length, 1);
    assert.equal(events.filter((e) => e.type === 'task.cancelled').length, 1);
    const outbox = env.store.db.prepare('SELECT * FROM outbox WHERE taskId = ?').get(env.taskId);
    assert.equal(outbox.kind, 'memory_writeback');
    assert.equal(JSON.parse(outbox.payload).state, 'cancelled');

    // 重复取消幂等：不加事件、不报错
    const second = await requestTaskCancel(env.service, env.taskId, {});
    assert.equal(second.state, 'cancelled');
    assert.equal(second.idempotent, true);
    const eventsAfter = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId && e.type === 'task.cancel_requested');
    assert.equal(eventsAfter.length, 1);

    // 取消后再跑 loop：终态去重，零模型调用、零工具、磁盘空
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'cancelled');
    assert.equal(providerCalls, 0);
    assert.deepEqual(env.toolCallsSeen, []);
    await assert.rejects(readFile(join(env.ws, 'quote.md')));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── C02：工具前取消（abort 到达工具入口，file.write 未执行）──────────

test('C02 工具前取消：TOOL_CANCELLED，磁盘无文件，任务 cancelled 终态 CAS', async () => {
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }], usage: { inputTokens: 5, outputTokens: 3 } },
      { expectToolResults: ['call-1'], text: '不该走到这里' },
    ],
    {
      acceptance: QUOTE_ACCEPTANCE,
      beforeToolExecute: async () => {
        // 取消在「操作已持久、工具将执行」这一精确点到达
        await requestTaskCancel(env.service, env.taskId, { controllers: env.controllers, reason: 'stop-before-tool' });
      },
    },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'cancelled');
    assert.equal(result.errorCode, 'TASK_CANCELLED');

    // 工具入口看到 aborted signal → TOOL_CANCELLED；副作用未发生
    assert.deepEqual(env.toolCallsSeen, ['file.write']);
    await assert.rejects(readFile(join(env.ws, 'quote.md')));
    const op = env.service.getOperation(`op:${env.taskId}:call-1`);
    assert.equal(op.state, 'failed');
    assert.equal(op.result.error.code, 'TOOL_CANCELLED');

    // 账本：模型步已结算；任务 cancelled；artifact 为零（没发生过写）
    const call = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ?').get(env.taskId);
    assert.equal(call.state, 'settled');
    assert.equal(result.artifacts.length, 0);
    assert.equal(env.service.getTask(env.taskId).state, 'cancelled');
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    assert.ok(events.some((e) => e.type === 'task.cancel_requested'));
    assert.ok(events.some((e) => e.type === 'task.cancelled'));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── C03：provider 响应中取消（abort 及时到达；迟到回调不复活任务）─────

test('C03 provider 响应中取消：abort 及时生效，调用记 uncertain 不记免费，终态拒绝迟到回写', async () => {
  const observed = {};
  const env = await makeEnv([], { provider: blockingProvider(observed), goal: '响应中取消' });
  try {
    const loopPromise = runAgentLoop(env.deps, env.taskId);
    await waitFor(() => observed.started !== undefined);
    const cancel = await requestTaskCancel(env.service, env.taskId, { controllers: env.controllers });
    assert.equal(cancel.state, 'cancelling', '本进程有活跃 worker：取消意图已持久，worker 在检查点完成');

    const result = await loopPromise;
    assert.equal(result.state, 'cancelled');
    // 本地控制动作及时生效：abort 直接到达在途 provider（远小于 5s 兜底）
    assert.equal(observed.aborted, true);
    assert.ok(observed.latencyMs < 1000, `abort latency ${observed.latencyMs}ms`);

    // 已发请求被取消 = 费用 uncertain（可能已计费），绝不记 failed/免费
    const call = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ?').get(env.taskId);
    assert.equal(call.state, 'uncertain');
    assert.equal(call.settledCostMicros, null);

    // 终态 CAS：迟到的成功回调不能复活任务
    assert.equal(env.service.getTask(env.taskId).state, 'cancelled');
    assert.throws(() => env.service.transitionTask(env.taskId, 'succeeded'), /TASK_TERMINAL/);
    assert.throws(() => env.service.transitionTask(env.taskId, 'running'), /TASK_TERMINAL/);
    assert.equal(env.service.getTask(env.taskId).state, 'cancelled');
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    assert.ok(events.some((e) => e.type === 'task.cancelled'));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── C04：写入已提交后取消——cancelled 仍列出已完成 artifact（不假称零影响）──

test('C04 file 写已提交不能撤回：取消后 artifact 照列、磁盘实物保留', async () => {
  const observed = {};
  let calls = 0;
  const composite = {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete(req) {
      calls += 1;
      if (calls === 1) {
        return {
          provider: 'fake',
          model: 'fake-x',
          assistant: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }],
          },
          finishReason: 'tool_calls',
          usage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: null, source: 'provider' },
        };
      }
      observed.started = Date.now();
      await waitAbort(req.signal);
      observed.aborted = req.signal.aborted;
      throw new ProviderError('PROVIDER_ABORTED');
    },
  };
  const env = await makeEnv([], { provider: composite, acceptance: QUOTE_ACCEPTANCE });
  try {
    const loopPromise = runAgentLoop(env.deps, env.taskId);
    await waitFor(() => observed.started !== undefined);
    await requestTaskCancel(env.service, env.taskId, { controllers: env.controllers });
    const result = await loopPromise;

    assert.equal(result.state, 'cancelled');
    // 已提交的写不撤回：磁盘实物保留，artifact 照列
    const onDisk = await readFile(join(env.ws, 'quote.md'), 'utf8');
    assert.equal(onDisk, QUOTE_MD);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].relativePath, 'quote.md');
    assert.equal(result.artifacts[0].sha256, sha256(Buffer.from(QUOTE_MD, 'utf8')));
    const cancelEvent = env.service.listEvents(0, 100).find((e) => e.taskId === env.taskId && e.type === 'task.cancelled');
    assert.deepEqual(cancelEvent.safePayload.artifacts, ['quote.md']);
    // 第二模型步已发被取消 → uncertain；第一笔正常结算
    const calls2 = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ? ORDER BY createdAt ASC').all(env.taskId);
    assert.equal(calls2.length, 2);
    assert.equal(calls2[0].state, 'settled');
    assert.equal(calls2[1].state, 'uncertain');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── R02：rename 后结果前崩溃 → interrupted → resume 预检 → 实物补记 ────

test('R02 rename 后结果前：interrupted 经 resumeTask 恢复，实物一致补记不重写', async () => {
  const args = { path: 'r.md', content: '# 恢复验证\n内容一致。\n' };
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-r', name: 'file.write', arguments: args }] },
      { expectToolResults: ['call-r'], text: '恢复完成' },
    ],
    { acceptance: { kind: 'file_deliverable', files: [{ path: 'r.md', mustContain: ['恢复验证'] }] } },
  );
  try {
    // 崩溃现场：原子 rename 已发生（文件在磁盘上），结果未落库（op 停在 running）
    await writeFile(join(env.ws, 'r.md'), args.content, 'utf8');
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-r`, taskId: env.taskId, callId: 'call-r', toolName: 'file.write', input: args });
    env.service.transitionOperation(`op:${env.taskId}:call-r`, 'running');
    // 重启：recover() 只标识 interrupted，不自动重试
    env.service.recover();
    assert.equal(env.service.getTask(env.taskId).state, 'interrupted');

    // 用户显式继续：预检 → interrupted → queued → 循环实物补记
    const pre = await resumePreflight(env.service, env.taskId, {});
    assert.equal(pre.ok, true);
    const resumed = await resumeTask(env.service, env.taskId, {});
    assert.equal(resumed.ok, true);
    assert.equal(resumed.state, 'queued');

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(env.toolCallsSeen, ['file.stat'], '只核对实物，不重复 file.write');
    const op = env.service.getOperation(`op:${env.taskId}:call-r`);
    assert.equal(op.state, 'succeeded');
    assert.equal(op.result.recovered, true);
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    assert.ok(events.some((e) => e.type === 'task.resumed'));
    assert.ok(events.some((e) => e.type === 'task.tool_recovered'));
    assert.equal((await readFile(join(env.ws, 'r.md'), 'utf8')), args.content, '实物不被重写改动');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── R03：结果后事件前崩溃——op 已 succeeded、tool message 缺失 → 账本重放 ──

test('R03 结果后事件前：op 成功但 tool message 缺失，重放账本结果且工具零执行', async () => {
  const args = { path: 'a.md', content: 'hello m07' };
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: args }] },
      { expectToolResults: ['call-1'], text: '完成' },
    ],
    { goal: '结果后事件前' },
  );
  try {
    await writeFile(join(env.ws, 'a.md'), args.content, 'utf8');
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-1`, taskId: env.taskId, callId: 'call-1', toolName: 'file.write', input: args });
    env.service.transitionOperation(`op:${env.taskId}:call-1`, 'running');
    env.service.transitionOperation(`op:${env.taskId}:call-1`, 'succeeded', {
      result: { path: 'a.md', byteLength: Buffer.byteLength(args.content), sha256: sha256(Buffer.from(args.content, 'utf8')), created: true },
    });

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(env.toolCallsSeen, [], '结果已持久：零工具重执行');
    const toolMsgs = env.service.listMessages(env.taskId).filter((m) => m.role === 'tool' && m.toolCallId === 'call-1');
    assert.equal(toolMsgs.length, 1, '回灌恰一次');
    assert.match(toolMsgs[0].content, /"created":true/);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── M01：记忆 outbox 前后——pending 只补投递，不重跑任务/工具 ──────────

test('M01 outbox 前/后：记忆故障留 pending，恢复只补投递一次，终态与产物不动', async () => {
  let flushAttempts = 0;
  const env = await makeEnv(
    [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'quote.md', content: QUOTE_MD } }] },
      { expectToolResults: ['call-1'], text: 'done' },
    ],
    {
      acceptance: QUOTE_ACCEPTANCE,
      flushMemoryOutbox: async () => {
        flushAttempts += 1;
        throw new Error('vault unavailable');
      },
    },
  );
  try {
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.memoryOutboxPending, true);
    assert.equal(flushAttempts, 1);

    // 恢复：只补投递，幂等键防重；任务与工具零重跑
    const recovery = await flushPendingMemoryOutbox(env.service, env.taskId, async () => {});
    assert.equal(recovery.delivered, 1);
    assert.equal(recovery.pending, 0);
    const rows = env.store.db.prepare('SELECT * FROM outbox WHERE taskId = ?').all(env.taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'done');

    const again = await runAgentLoop(env.deps, env.taskId);
    assert.equal(again.state, 'succeeded');
    assert.deepEqual(env.toolCallsSeen, ['file.write']);
    assert.equal(flushAttempts, 1, '终态重入不再投递');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── P01：恢复预检矩阵（目录/实物/租约/取消意图/不确定调用预算）──────────

test('P01 preflight：workspaceRoot 缺失 → RESUME_WORKSPACE_MISSING 阻止恢复', async () => {
  const env = await makeEnv([], {});
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.recover();
    await rm(env.ws, { recursive: true, force: true });
    const pre = await resumePreflight(env.service, env.taskId, {});
    assert.equal(pre.ok, false);
    assert.equal(pre.block.code, 'RESUME_WORKSPACE_MISSING');
    const resumed = await resumeTask(env.service, env.taskId, {});
    assert.equal(resumed.ok, false);
    assert.equal(env.service.getTask(env.taskId).state, 'interrupted', '被阻止时不改变状态');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('P01 preflight：artifact 实物被替换 → RESUME_ARTIFACT_MISMATCH（不拿同名文件当旧产物）', async () => {
  const env = await makeEnv([], {});
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:c1`, taskId: env.taskId, callId: 'c1', toolName: 'file.write', input: { path: 'q.md', content: 'orig' } });
    env.service.transitionOperation(`op:${env.taskId}:c1`, 'running');
    env.service.transitionOperation(`op:${env.taskId}:c1`, 'succeeded', { result: { path: 'q.md', byteLength: 4, sha256: sha256(Buffer.from('orig')) } });
    env.service.registerArtifact({ id: 'art-1', taskId: env.taskId, operationId: `op:${env.taskId}:c1`, relativePath: 'q.md', byteLength: 4, sha256: sha256(Buffer.from('orig')) });
    env.service.recover();
    // 目录被“还原”成同名不同内容的文件
    await writeFile(join(env.ws, 'q.md'), 'tampered', 'utf8');
    const pre = await resumePreflight(env.service, env.taskId, {});
    assert.equal(pre.ok, false);
    assert.equal(pre.block.code, 'RESUME_ARTIFACT_MISMATCH');
    assert.deepEqual(pre.block.staleArtifacts, ['q.md']);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('P01 preflight：reserved 调用费用 uncertain；无授权不恢复，授权后新 callId 发新请求不重发', async () => {
  let providerCallIds = [];
  const counting = {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete(req) {
      providerCallIds.push(req.callId);
      return {
        provider: 'fake',
        model: 'fake-x',
        assistant: { role: 'assistant', content: '恢复后继续完成' },
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null, source: 'provider' },
      };
    },
  };
  const env = await makeEnv([], { provider: counting, goal: '不确定调用恢复' });
  try {
    // 崩溃现场：provider 请求已持久预留（可能已计费）但无响应
    env.service.transitionTask(env.taskId, 'running');
    env.service.recordModelCall({ id: `mc:${env.taskId}:1`, taskId: env.taskId, purpose: 'chat', provider: 'fake', model: 'fake-x' });
    env.service.recover();

    const noRetry = await resumePreflight(env.service, env.taskId, {});
    assert.equal(noRetry.ok, false);
    assert.equal(noRetry.block.code, 'MODEL_CALL_UNCERTAIN_REVIEW');
    assert.deepEqual(noRetry.block.uncertainCalls, [`mc:${env.taskId}:1`]);

    const noBudget = await resumePreflight(env.service, env.taskId, { retryUncertain: true });
    assert.equal(noBudget.ok, false);
    assert.equal(noBudget.block.code, 'BUDGET_REAUTH_REQUIRED');

    // 用户选择重试 + 预算重新获准 → 放行
    const resumed = await resumeTask(env.service, env.taskId, { retryUncertain: true, budgetReauthorized: true });
    assert.equal(resumed.ok, true);
    // 旧调用保留 uncertain 账本（不无证据退款成 0）
    const oldCall = env.store.db.prepare('SELECT * FROM model_calls WHERE id = ?').get(`mc:${env.taskId}:1`);
    assert.equal(oldCall.state, 'uncertain');
    assert.equal(oldCall.settledCostMicros, null);

    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    // 同一请求绝不重发：新步骤用新 callId
    assert.deepEqual(providerCallIds, [`mc:${env.taskId}:2`]);
    const newCall = env.store.db.prepare('SELECT * FROM model_calls WHERE id = ?').get(`mc:${env.taskId}:2`);
    assert.equal(newCall.state, 'settled');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('P01 preflight：租约被其他实例持有 → LEASE_HELD 阻止恢复', async () => {
  const env = await makeEnv([], {});
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.recover();
    const other = new TaskService(env.store, 'other-instance');
    const { fencingToken } = other.claimTask(env.taskId, 60_000);
    const pre = await resumePreflight(env.service, env.taskId, {});
    assert.equal(pre.ok, false);
    assert.equal(pre.block.code, 'LEASE_HELD');
    other.releaseLease(`task:${env.taskId}`, fencingToken);
    const after = await resumePreflight(env.service, env.taskId, {});
    assert.equal(after.ok, true);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('P01 preflight：崩溃前有取消意图 → RESUME_CANCEL_INTENT，恢复不复活，可完成取消', async () => {
  const env = await makeEnv([], {});
  try {
    env.service.transitionTask(env.taskId, 'running');
    // 有活跃 worker 的取消停在 cancelling（worker 未及 finalize 就崩溃）
    const ghost = new TaskControllerRegistry();
    ghost.register(env.taskId, new AbortController());
    const cancel = await requestTaskCancel(env.service, env.taskId, { controllers: ghost });
    assert.equal(cancel.state, 'cancelling');
    env.service.recover();
    assert.equal(env.service.getTask(env.taskId).state, 'interrupted');

    const pre = await resumePreflight(env.service, env.taskId, {});
    assert.equal(pre.ok, false);
    assert.equal(pre.block.code, 'RESUME_CANCEL_INTENT');

    // 尊重取消意图：完成取消而不是恢复执行
    const done = await requestTaskCancel(env.service, env.taskId, {});
    assert.equal(done.state, 'cancelled');
    assert.equal(env.service.getTask(env.taskId).state, 'cancelled');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── X01：external_write unknown 不自动重放，人工核对后显式了结 ──────────

test('X01 external_write unknown：恢复阻塞等待人工核对，resolveUnknownOperation 后可恢复，第三方副作用零重放', async () => {
  const env = await makeEnv([{ text: '人工核对后任务收尾' }], { goal: '外部副作用对账' });
  try {
    // 崩溃现场：向第三方发消息的操作结果未知（SKF 不能保证第三方 exactly-once）
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-x`, taskId: env.taskId, callId: 'call-x', toolName: 'message.send', input: { to: 'user', text: 'hi' } });
    env.service.transitionOperation(`op:${env.taskId}:call-x`, 'running');
    env.service.transitionOperation(`op:${env.taskId}:call-x`, 'unknown');
    env.service.recover();

    const pre = await resumePreflight(env.service, env.taskId, {});
    assert.equal(pre.ok, false);
    assert.equal(pre.block.code, 'RECOVERY_NEEDS_MANUAL_REVIEW');
    assert.deepEqual(pre.block.unknownOperations, [`message.send:op:${env.taskId}:call-x`]);

    // 人工核对第三方实物（此处：确认未送达）→ 显式了结为 failed
    resolveUnknownOperation(env.service, `op:${env.taskId}:call-x`, {
      decision: 'failed',
      result: { error: { code: 'THIRD_PARTY_NOT_DELIVERED', retryable: false } },
    });
    const op = env.service.getOperation(`op:${env.taskId}:call-x`);
    assert.equal(op.state, 'failed');
    assert.equal(op.result.error.code, 'THIRD_PARTY_NOT_DELIVERED');
    assert.ok(env.service.listEvents(0, 100).some((e) => e.type === 'task.operation_resolved'));

    const resumed = await resumeTask(env.service, env.taskId, {});
    assert.equal(resumed.ok, true);
    const result = await runAgentLoop(env.deps, env.taskId);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(env.toolCallsSeen, [], '外部副作用绝不自动重放');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

test('X02 循环内遇到 external unknown：任务停下保持非终态等待核对，不自动重放不假装成功', async () => {
  const env = await makeEnv(
    [{ toolCalls: [{ id: 'call-x', name: 'message.send', arguments: { to: 'user', text: 'hi' } }] }],
    { goal: '循环内外部 unknown' },
  );
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.createOperation({ id: `op:${env.taskId}:call-x`, taskId: env.taskId, callId: 'call-x', toolName: 'message.send', input: { to: 'user', text: 'hi' } });
    env.service.transitionOperation(`op:${env.taskId}:call-x`, 'running');
    env.service.transitionOperation(`op:${env.taskId}:call-x`, 'unknown');

    await assert.rejects(runAgentLoop(env.deps, env.taskId), /RECOVERY_NEEDS_MANUAL_REVIEW/);
    assert.equal(env.service.getTask(env.taskId).state, 'running', '保持非终态：等待人工核对');
    assert.equal(env.service.getOperation(`op:${env.taskId}:call-x`).state, 'unknown');
    assert.deepEqual(env.toolCallsSeen, []);
    // 清理：人工取消，不留僵尸
    await requestTaskCancel(env.service, env.taskId, {});
    assert.equal(env.service.getTask(env.taskId).state, 'cancelled');
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── G01：gateway 路径取消——账本 uncertain（预算口径保守）─────────────

test('G01 gateway 路径 provider 响应中取消：model_calls 记 uncertain，任务 cancelled', async () => {
  const observed = {};
  const provider = blockingProvider(observed);
  const env = await makeEnv([], { provider, goal: 'gateway 取消' });
  try {
    const gateway = new ModelGateway({
      store: env.store,
      service: env.service,
      config: { mode: 'call-limit', expensiveProviders: new Set(), maxRetries: 0 },
    });
    gateway.registerProvider({ name: 'fake', adapter: provider, model: 'fake-x', local: false, verified: true });
    env.deps.gateway = gateway;

    const loopPromise = runAgentLoop(env.deps, env.taskId);
    await waitFor(() => observed.started !== undefined);
    await requestTaskCancel(env.service, env.taskId, { controllers: env.controllers });
    const result = await loopPromise;

    assert.equal(result.state, 'cancelled');
    assert.equal(observed.aborted, true);
    const call = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ?').get(env.taskId);
    assert.equal(call.state, 'uncertain', '发出后取消：保守占额，不 release 不记 failed');
    assert.equal(call.settledCostMicros, null);
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId);
    assert.ok(events.some((e) => e.type === 'task.cancelled'));
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── E01：证据导出（恢复被阻/schema 出口）──────────────────────────

test('E01 exportTaskEvidence：任务全量证据可导出供人工审查', async () => {
  const env = await makeEnv([], {});
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.recordModelCall({ id: `mc:${env.taskId}:1`, taskId: env.taskId, purpose: 'chat', provider: 'fake', model: 'fake-x' });
    env.service.recover();
    const doc = exportTaskEvidence(env.service, env.taskId);
    assert.equal(doc.schemaVersion, 7);
    assert.equal(doc.task.id, env.taskId);
    assert.equal(doc.task.state, 'interrupted');
    assert.equal(doc.modelCalls.length, 1);
    assert.equal(doc.modelCalls[0].state, 'reserved');
    assert.ok(Array.isArray(doc.events) && doc.events.length > 0);
    assert.ok(Array.isArray(doc.operations));
    assert.ok(doc.exportedAt);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});

// ── finalizeCancelled 幂等（无 worker 直推 + 重复进入）────────────────

test('finalizeCancelled 幂等：重复完成取消不重复事件/outbox，artifact 照列', async () => {
  const env = await makeEnv([], {});
  try {
    env.service.transitionTask(env.taskId, 'running');
    env.service.transitionTask(env.taskId, 'cancelling', { event: { type: 'task.cancel_requested', payload: { reason: 'test' } } });
    const first = await finalizeCancelled(env.service, env.taskId, {});
    assert.equal(first.state, 'cancelled');
    const second = await finalizeCancelled(env.service, env.taskId, {});
    assert.equal(second.state, 'cancelled');
    const events = env.service.listEvents(0, 100).filter((e) => e.taskId === env.taskId && e.type === 'task.cancelled');
    assert.equal(events.length, 1, '终态事件只生效一次');
    const outboxRows = env.store.db.prepare('SELECT * FROM outbox WHERE taskId = ?').all(env.taskId);
    assert.equal(outboxRows.length, 1);
  } finally {
    env.store.close();
    await cleanupTestRoot(env.root);
  }
});
