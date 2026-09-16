import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { BudgetLedger, shanghaiDayKey, shanghaiDayRange } from '../dist/runtime/budget-ledger.js';
import { ModelGateway, fitMessages, measureRequest, estimateTextTokens } from '../dist/runtime/model-gateway.js';
import { TARIFF_VERSION } from '../dist/runtime/usage.js';
import { ProviderError } from '../dist/providers/protocol.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { FakeScriptedProvider } from '../dist/providers/fake-scripted.js';
import { runAgentLoop } from '../dist/runtime/agent-loop.js';

// M06 验收：全调用预算与路由。
// 整数微货币 / 事务预留并发只许一个 / uncertain 保守 / cached 不双算 / tariff 快照 /
// 跨午夜 Asia/Shanghai / 大数负数 NaN / 成本未知 / 三模式 / 路由不静默升级 /
// 重试默认关闭 / 上下文实算与裁剪 / 全调用扫描无旁路 / agent-loop 经 gateway。
// 全部 stub/fake provider + 本机临时目录，零网络、零付费调用。

const TARIFF_ENV_KEYS = [
  'SKF_KIMI_INPUT_USD_PER_M', 'SKF_KIMI_OUTPUT_USD_PER_M', 'SKF_KIMI_CACHED_USD_PER_M',
  'SKF_ASTRA_INPUT_USD_PER_M', 'SKF_ASTRA_OUTPUT_USD_PER_M', 'SKF_ASTRA_CACHED_USD_PER_M',
];

function saveEnv() {
  const saved = {};
  for (const k of TARIFF_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const k of TARIFF_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
function setKimiTariff({ input = '2', output = '10', cached } = {}) {
  process.env.SKF_KIMI_INPUT_USD_PER_M = input;
  process.env.SKF_KIMI_OUTPUT_USD_PER_M = output;
  if (cached === undefined) delete process.env.SKF_KIMI_CACHED_USD_PER_M;
  else process.env.SKF_KIMI_CACHED_USD_PER_M = cached;
}

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m06-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

/** 测试 stub provider（测试 adapter，不计生产）：可编程 usage/错误/延迟/调用计数。 */
function stubProvider(name, behavior = {}) {
  const stub = {
    name,
    calls: 0,
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete(req) {
      stub.calls++;
      if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
      if (behavior.sequence?.length) {
        const step = behavior.sequence.shift();
        if (step.error) throw new ProviderError(step.error);
        return makeResult(name, req, step);
      }
      if (behavior.error) throw new ProviderError(behavior.error);
      return makeResult(name, req, behavior);
    },
  };
  return stub;
}

function makeResult(name, req, behavior) {
  const usage = behavior.usage === null
    ? { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' }
    : {
        inputTokens: behavior.usage?.inputTokens ?? 10,
        outputTokens: behavior.usage?.outputTokens ?? 5,
        cachedInputTokens: behavior.usage?.cachedInputTokens ?? null,
        source: 'provider',
      };
  return {
    responseId: `${name}-${req.callId}`,
    provider: name,
    model: behavior.model ?? 'stub-1',
    assistant: { role: 'assistant', content: behavior.text ?? 'ok' },
    finishReason: 'stop',
    usage,
  };
}

async function makeEnv(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m06-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm06-test');
  const gateway = new ModelGateway({
    store,
    service,
    config: {
      mode: opts.mode ?? 'call-limit',
      defaultProvider: opts.defaultProvider ?? 'kimi',
      expensiveProviders: new Set(opts.expensive ?? ['astra']),
      maxRetries: opts.maxRetries ?? 0,
      ...(opts.dailyCallLimit !== undefined ? { dailyCallLimit: opts.dailyCallLimit } : {}),
      ...(opts.dailyBudgetMicros !== undefined ? { dailyBudgetMicros: opts.dailyBudgetMicros } : {}),
      ...(opts.taskBudgetMicros !== undefined ? { taskBudgetMicros: opts.taskBudgetMicros } : {}),
      ...(opts.contextLimits ? { contextLimits: opts.contextLimits } : {}),
    },
  });
  service.createTask({
    id: 't1',
    input: { goal: 'budget test' },
    sessionId: 's-m06',
    scope: 'skf-test',
    workspaceRoot: '-',
    provider: 'kimi',
    model: 'kimi-k3',
  });
  const register = (name, stub, { local = false, verified = true, model = 'stub-1' } = {}) =>
    gateway.registerProvider({ name, adapter: stub, model, local, verified });
  return { root, store, service, gateway, register };
}

const completeReq = (over = {}) => ({
  callId: over.callId ?? 'mc:t1:1',
  taskId: 't1',
  purpose: 'chat',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxOutputTokens: 10,
  signal: new AbortController().signal,
  deadlineAt: Date.now() + 60_000,
  ...over,
});

function modelCallRow(store, id) {
  return store.db.prepare('SELECT * FROM model_calls WHERE id = ?').get(id);
}

// ── 1. 整数微货币 + currency + tariffVersion + 价目快照 ─────────────

test('整数微货币结算：usage×价目=整数 micros，currency/tariffVersion/快照随行固化', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  try {
    setKimiTariff({ input: '2', output: '10' });
    const stub = stubProvider('kimi', { usage: { inputTokens: 1000, outputTokens: 100 } });
    env.register('kimi', stub, { model: 'kimi-k3' });
    const result = await env.gateway.complete(completeReq());
    // 1000×2 + 100×10 = 3000 micros（整数，非浮点）
    assert.equal(result.cost.settledMicros, 3000);
    assert.equal(result.cost.currency, 'USD');
    assert.equal(result.cost.tariffVersion, TARIFF_VERSION);
    assert.equal(result.cost.amountKnown, true);
    assert.equal(result.cost.source, 'configured-estimate'); // UI 估算 ≠ 供应商账单
    const row = modelCallRow(env.store, 'mc:t1:1');
    assert.equal(row.state, 'settled');
    assert.equal(row.settledCostMicros, 3000);
    assert.equal(row.currency, 'USD');
    assert.equal(row.tariffVersion, TARIFF_VERSION);
    const snapshot = JSON.parse(row.tariff);
    assert.equal(snapshot.inputPerM, 2);
    assert.equal(snapshot.outputPerM, 10);
    const rawUsage = JSON.parse(row.usage); // 原始 usage 口径保留（账单一列）
    assert.equal(rawUsage.inputTokens, 1000);
    assert.equal(rawUsage.source, 'provider');
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 2. cached 子集不双算（含 clamp 到 input）────────────────────────

test('cached 子集计费：未缓存部分按 input 价 + 缓存按 cached 价 + 输出价，绝不双算', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  try {
    setKimiTariff({ input: '2', output: '10', cached: '1' });
    const stub = stubProvider('kimi', { usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 } });
    env.register('kimi', stub);
    const result = await env.gateway.complete(completeReq());
    // 600×2 + 100×10 + 400×1 = 2600；若双算 cached 会多出 400×2
    assert.equal(result.cost.settledMicros, 2600);

    // cached > input 被 clamp：cached=1500 → 1000
    const stub2 = stubProvider('kimi', { usage: { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 1500 } });
    env.register('kimi', stub2);
    const r2 = await env.gateway.complete(completeReq({ callId: 'mc:t1:2' }));
    assert.equal(r2.cost.settledMicros, 1000); // 0×2 + 0 + 1000×1
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 3. 有缓存无缓存价：金额未知（call-limit）/ uncertain（strict）───

test('cached 价目缺失：call-limit 金额明示未知；strict-money 记 uncertain', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  const strict = await makeEnv();
  try {
    setKimiTariff({ input: '2', output: '10' }); // 无 cached 价
    const usage = { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 };
    const stub = stubProvider('kimi', { usage });
    env.register('kimi', stub);
    const result = await env.gateway.complete(completeReq());
    assert.equal(result.cost.settledMicros, null);
    assert.equal(result.cost.amountKnown, false); // 未知不是 0
    assert.equal(modelCallRow(env.store, 'mc:t1:1').state, 'settled');

    const strictGw = new ModelGateway({
      store: strict.store,
      service: strict.service,
      config: { mode: 'strict-money', defaultProvider: 'kimi', expensiveProviders: new Set(), maxRetries: 0 },
    });
    strictGw.registerProvider({ name: 'kimi', adapter: stubProvider('kimi', { usage }), model: 'kimi-k3', local: false, verified: true });
    const r2 = await strictGw.complete(completeReq());
    assert.equal(modelCallRow(strict.store, 'mc:t1:1').state, 'uncertain'); // strict 下金额算不出 = 保守
    assert.equal(r2.cost.amountKnown, false);
  } finally {
    env.store.close();
    strict.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
    await cleanupTestRoot(strict.root);
  }
});

// ── 4. 并发两请求只剩一份预算仅一个获准；超预算发网络前拒绝 ─────────

test('并发预留不透支：两个并发请求只剩一份预算时仅一个获准，另一个发网络前拒绝', async () => {
  const saved = saveEnv();
  // 'hi' 输入估算 7 tokens + maxOutput 10 → 预留 7×2+10×10 = 114 micros；日预算 150 只够一个
  const env = await makeEnv({ dailyBudgetMicros: 150 });
  try {
    setKimiTariff({ input: '2', output: '10' });
    const stub = stubProvider('kimi', { delayMs: 50, usage: { inputTokens: 7, outputTokens: 10 } });
    env.register('kimi', stub);
    const [a, b] = await Promise.allSettled([
      env.gateway.complete(completeReq({ callId: 'mc:t1:1' })),
      env.gateway.complete(completeReq({ callId: 'mc:t1:2' })),
    ]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one request may pass');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'DAILY_BUDGET_EXCEEDED');
    assert.equal(stub.calls, 1, 'rejected request must never reach the network');
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

test('任务预算超限：发网络前 BUDGET_EXCEEDED，provider 零调用、零账本行', async () => {
  const saved = saveEnv();
  const env = await makeEnv({ taskBudgetMicros: 10 }); // 远低于 114 预留
  try {
    setKimiTariff({ input: '2', output: '10' });
    const stub = stubProvider('kimi');
    env.register('kimi', stub);
    await assert.rejects(() => env.gateway.complete(completeReq()), (err) => {
      assert.equal(err.code, 'BUDGET_EXCEEDED');
      return true;
    });
    assert.equal(stub.calls, 0, 'no network request may be sent');
    const rows = env.store.db.prepare('SELECT COUNT(*) AS c FROM model_calls').get();
    assert.equal(rows.c, 0, 'rejected precheck leaves no reservation');
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 5. 缺 usage / 超时 / 取消 → uncertain 保守；预中止 → release ────

test('缺 usage（null）→ uncertain：预留保守保留，不无证据退款成 0', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  try {
    setKimiTariff({ input: '2', output: '10' });
    const stub = stubProvider('kimi', { usage: null });
    env.register('kimi', stub);
    const result = await env.gateway.complete(completeReq());
    assert.equal(result.cost.amountKnown, false);
    const row = modelCallRow(env.store, 'mc:t1:1');
    assert.equal(row.state, 'uncertain');
    assert.ok(row.reservedCostMicros > 0, 'reservation retained, not refunded to 0');
    assert.equal(row.settledCostMicros, null);
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

test('超时/网络错误（请求可能已发出）→ uncertain；不自动重发', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  try {
    setKimiTariff({ input: '2', output: '10' });
    const stub = stubProvider('kimi', { error: 'PROVIDER_TIMEOUT' });
    env.register('kimi', stub);
    await assert.rejects(() => env.gateway.complete(completeReq()), (err) => {
      assert.equal(err.code, 'PROVIDER_TIMEOUT');
      return true;
    });
    assert.equal(stub.calls, 1, 'no silent retry');
    const row = modelCallRow(env.store, 'mc:t1:1');
    assert.equal(row.state, 'uncertain');
    assert.ok(row.reservedCostMicros > 0);
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

test('预中止（请求尚未发出）→ release：state=failed 且不占任何额度', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  try {
    setKimiTariff({ input: '2', output: '10' });
    const stub = stubProvider('kimi');
    env.register('kimi', stub);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      () => env.gateway.complete(completeReq({ signal: abort.signal })),
      (err) => {
        assert.equal(err.code, 'PROVIDER_ABORTED');
        return true;
      },
    );
    assert.equal(stub.calls, 0);
    const row = modelCallRow(env.store, 'mc:t1:1');
    assert.equal(row.state, 'failed');
    assert.equal(row.reservedCostMicros, null, 'released reservation accounts nothing');
    const status = env.gateway.status({ taskId: 't1' });
    assert.equal(status.task.spent + status.task.reserved + status.task.uncertain, 0);
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 6. tariff 改变：旧调用按快照结算，新调用用新价 ──────────────────

test('tariff 中途改变：已预留调用按快照结算，新调用用新价目', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  try {
    setKimiTariff({ input: '2', output: '10' });
    const usage = { inputTokens: 1000, outputTokens: 100 };
    const stub = stubProvider('kimi', { usage });
    env.register('kimi', stub);
    await env.gateway.complete(completeReq({ callId: 'mc:t1:1' }));
    setKimiTariff({ input: '4', output: '20' }); // 价目改变
    await env.gateway.complete(completeReq({ callId: 'mc:t1:2' }));
    const r1 = modelCallRow(env.store, 'mc:t1:1');
    const r2 = modelCallRow(env.store, 'mc:t1:2');
    assert.equal(r1.settledCostMicros, 3000); // 快照：1000×2+100×10
    assert.equal(r2.settledCostMicros, 6000); // 新价：1000×4+100×20
    assert.equal(JSON.parse(r1.tariff).inputPerM, 2, 'old call keeps snapshot');
    assert.equal(JSON.parse(r2.tariff).inputPerM, 4);
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 7. 跨午夜（固定 Asia/Shanghai）─────────────────────────────────

test('跨午夜按 Asia/Shanghai 分桶：日界 16:00Z，每日次数上限跨日重置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m06-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm06-test');
  try {
    service.createTask({ id: 't1', input: {}, sessionId: 's', scope: 'test', workspaceRoot: '-', provider: 'kimi', model: 'm' });
    const ledger = new BudgetLedger(store);
    // 2026-09-08 16:00:00Z = 2026-09-09 00:00:00 Asia/Shanghai
    const beforeMidnight = Date.UTC(2026, 8, 8, 15, 59, 59);
    const afterMidnight = Date.UTC(2026, 8, 8, 16, 0, 1);
    assert.equal(shanghaiDayKey(beforeMidnight), '2026-09-08');
    assert.equal(shanghaiDayKey(afterMidnight), '2026-09-09');
    const range = shanghaiDayRange('2026-09-09');
    assert.equal(range.startMs, Date.UTC(2026, 8, 8, 16, 0, 0));

    const base = {
      taskId: 't1', purpose: 'chat', provider: 'kimi', model: 'm', local: false,
      worstCase: { inputTokens: 1, outputTokens: 1 }, tariff: null, limits: { dailyCalls: 1 },
    };
    ledger.reserve({ ...base, callId: 'c1', now: beforeMidnight });
    assert.throws(
      () => ledger.reserve({ ...base, callId: 'c2', now: beforeMidnight + 500 }), // 同日 23:59:59.5
      (err) => err.code === 'CALL_LIMIT_EXCEEDED',
    );
    ledger.reserve({ ...base, callId: 'c3', now: afterMidnight }); // 跨日重置
    const s1 = ledger.status({ now: beforeMidnight });
    const s2 = ledger.status({ now: afterMidnight });
    assert.equal(s1.daily.calls, 1, '被拒的 c2 未发出请求，不入账');
    assert.equal(s2.daily.calls, 1);
    assert.equal(s1.timezone, 'Asia/Shanghai');
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

// ── 8. 大数 / 负数 / NaN ────────────────────────────────────────────

test('大数/负数/NaN：预留输入严格拒绝；不可信 usage 记 uncertain 不进账', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m06-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm06-test');
  try {
    service.createTask({ id: 't1', input: {}, sessionId: 's', scope: 'test', workspaceRoot: '-', provider: 'kimi', model: 'm' });
    const ledger = new BudgetLedger(store);
    const base = {
      taskId: 't1', purpose: 'chat', provider: 'kimi', model: 'm', local: false,
      tariff: { version: 't', currency: 'USD', inputPerM: 2, outputPerM: 10, cachedPerM: null },
      limits: {},
    };
    assert.throws(() => ledger.reserve({ ...base, callId: 'n1', worstCase: { inputTokens: -1, outputTokens: 1 } }), /INVALID_INPUT/);
    assert.throws(() => ledger.reserve({ ...base, callId: 'n2', worstCase: { inputTokens: NaN, outputTokens: 1 } }), /INVALID_INPUT/);
    assert.throws(() => ledger.reserve({ ...base, callId: 'n3', worstCase: { inputTokens: 1.5, outputTokens: 1 } }), /INVALID_INPUT/);
    assert.throws(
      () => ledger.reserve({ ...base, callId: 'n4', worstCase: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } }),
      /INVALID_INPUT/,
      'tokens × rate overflow must not silently wrap',
    );
    assert.throws(() => ledger.reserve({ ...base, callId: 'n5', worstCase: { inputTokens: 1, outputTokens: 1 }, limits: { dailyMicros: -5 } }), /INVALID_INPUT/);

    // 不可信 usage（负数/非整数）→ uncertain，绝不按负数结算
    ledger.reserve({ ...base, callId: 'ok1', worstCase: { inputTokens: 10, outputTokens: 10 } });
    const s1 = ledger.settle('ok1', { inputTokens: -3, outputTokens: 5, cachedInputTokens: null, source: 'provider' });
    assert.equal(s1.state, 'uncertain');
    assert.equal(s1.costMicros, null);
    ledger.reserve({ ...base, callId: 'ok2', worstCase: { inputTokens: 10, outputTokens: 10 } });
    const s2 = ledger.settle('ok2', { inputTokens: 10.5, outputTokens: 5, cachedInputTokens: null, source: 'provider' });
    assert.equal(s2.state, 'uncertain');
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

// ── 9. 成本未知：strict-money 拒绝；call-limit 明示未知 ─────────────

test('无价目：strict-money 发网络前 TARIFF_NOT_CONFIGURED；call-limit 放行但金额未知', async () => {
  const saved = saveEnv();
  const env = await makeEnv({ mode: 'strict-money', defaultProvider: 'cloudx' });
  const env2 = await makeEnv({ mode: 'call-limit', defaultProvider: 'cloudx' });
  try {
    const stub = stubProvider('cloudx');
    env.register('cloudx', stub);
    await assert.rejects(() => env.gateway.complete(completeReq()), (err) => {
      assert.equal(err.code, 'TARIFF_NOT_CONFIGURED');
      return true;
    });
    assert.equal(stub.calls, 0, 'strict-money rejects before network');

    const stub2 = stubProvider('cloudx', { usage: { inputTokens: 100, outputTokens: 50 } });
    env2.register('cloudx', stub2);
    const result = await env2.gateway.complete(completeReq());
    assert.equal(result.cost.settledMicros, null);
    assert.equal(result.cost.amountKnown, false); // 明示未知，不是 0
    assert.equal(modelCallRow(env2.store, 'mc:t1:1').state, 'settled');
  } finally {
    env.store.close();
    env2.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
    await cleanupTestRoot(env2.root);
  }
});

// ── 10. local-only 模式 ─────────────────────────────────────────────

test('local-only：云 provider 拒绝；本地 provider 放行且不耗金额不计次数', async () => {
  const saved = saveEnv();
  const env = await makeEnv({ mode: 'local-only', dailyCallLimit: 1 });
  try {
    setKimiTariff({ input: '2', output: '10' });
    env.register('kimi', stubProvider('kimi'));
    env.register('mock', stubProvider('mock', { usage: null }), { local: true });
    await assert.rejects(
      () => env.gateway.complete(completeReq({ route: { provider: 'kimi' } })),
      (err) => err.code === 'LOCAL_ONLY_MODE',
    );
    // 本地调用不受每日云调用次数限制（dailyCallLimit=1，连发两次）
    await env.gateway.complete(completeReq({ route: { provider: 'mock' }, callId: 'mc:t1:1' }));
    await env.gateway.complete(completeReq({ route: { provider: 'mock' }, callId: 'mc:t1:2' }));
    const status = env.gateway.status({ taskId: 't1' });
    assert.equal(status.daily.calls, 0, 'local providers do not count as cloud calls');
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 11. 路由：昂贵授权 / 不静默升级 / 未验证拒绝 ────────────────────

test('路由：昂贵 provider 必须任务策略授权；失败绝不静默换更贵 provider；未验证拒绝', async () => {
  const saved = saveEnv();
  const env = await makeEnv();
  try {
    process.env.SKF_ASTRA_INPUT_USD_PER_M = '50';
    process.env.SKF_ASTRA_OUTPUT_USD_PER_M = '200';
    const astra = stubProvider('astra');
    const kimi = stubProvider('kimi', { error: 'PROVIDER_SERVER_ERROR' });
    env.register('astra', astra);
    env.register('kimi', kimi);

    // 未授权 → 拒绝，且一次都不调用
    await assert.rejects(
      () => env.gateway.complete(completeReq({ route: { provider: 'astra' } })),
      (err) => err.code === 'EXPENSIVE_UPGRADE_NOT_AUTHORIZED',
    );
    assert.equal(astra.calls, 0);

    // 授权 + 预算内 → 放行
    await env.gateway.complete(completeReq({ callId: 'mc:t1:1', route: { provider: 'astra', allowExpensive: true } }));
    assert.equal(astra.calls, 1);

    // 常规 provider 失败 → 错误原样抛出，不静默升级/换 provider
    await assert.rejects(
      () => env.gateway.complete(completeReq({ callId: 'mc:t1:2', route: { provider: 'kimi' } })),
      (err) => err.code === 'PROVIDER_SERVER_ERROR',
    );
    assert.equal(astra.calls, 1, 'no silent failover to a more expensive provider');

    // 未验证的云 provider 不做常规路由
    env.register('mystery', stubProvider('mystery'), { verified: false });
    await assert.rejects(
      () => env.gateway.complete(completeReq({ callId: 'mc:t1:3', route: { provider: 'mystery' } })),
      (err) => err.code === 'PROVIDER_NOT_VERIFIED',
    );
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 12. 重试：默认关闭；只有统一策略可显式开启 ──────────────────────

test('重试默认关闭；显式开启后同 provider 同预留重试，只入账一次', async () => {
  const saved = saveEnv();
  const envOff = await makeEnv();
  const envOn = await makeEnv({ maxRetries: 1 });
  try {
    setKimiTariff({ input: '2', output: '10' });
    // 默认关闭：可重试错误也只试一次
    const flaky1 = stubProvider('kimi', { sequence: [{ error: 'PROVIDER_RATE_LIMITED' }, { text: 'ok' }] });
    envOff.register('kimi', flaky1);
    await assert.rejects(
      () => envOff.gateway.complete(completeReq()),
      (err) => err.code === 'PROVIDER_RATE_LIMITED',
    );
    assert.equal(flaky1.calls, 1, 'retry is OFF by default');
    assert.equal(modelCallRow(envOff.store, 'mc:t1:1').state, 'uncertain');

    // 显式开启：第二次成功；同一份预留，只结算一次
    const flaky2 = stubProvider('kimi', { sequence: [{ error: 'PROVIDER_RATE_LIMITED' }, { usage: { inputTokens: 1000, outputTokens: 100 } }] });
    envOn.register('kimi', flaky2);
    const result = await envOn.gateway.complete(completeReq());
    assert.equal(flaky2.calls, 2);
    assert.equal(result.cost.settledMicros, 3000);
    const rows = envOn.store.db.prepare("SELECT COUNT(*) AS c FROM model_calls WHERE taskId = 't1'").get();
    assert.equal(rows.c, 1, 'one reservation, one settlement');
  } finally {
    envOff.store.close();
    envOn.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(envOff.root);
    await cleanupTestRoot(envOn.root);
  }
});

// ── 13. 上下文：真实序列化计量 / 可选证据先裁 / 工具组成组 / 硬约束拒绝 ──

test('上下文计量与裁剪：真实序列化参与计量，可选证据最旧先裁，工具 call/result 成组保留', async () => {
  const pad40 = 'a'.repeat(40);
  const messages = [
    { role: 'system', content: 'sys' },                                    // 0 hard
    { role: 'user', content: pad40 },                                      // 1 optional evidence
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'file.read', arguments: {} }] }, // 2 optional (group)
    { role: 'tool', content: pad40, toolCallId: 'c1', name: 'file.read' }, // 3 optional (group)
    { role: 'user', content: 'goal' },                                     // 4 hard
  ];
  // 全量 ≈ 80 tokens；限 70 → 只裁 m1，工具组整组保留
  const fit70 = fitMessages(messages, [], 70, new Set([1, 2, 3]));
  assert.deepEqual(fit70.trimmedIndices, [1]);
  assert.deepEqual(fit70.messages.map((m) => m.role), ['system', 'assistant', 'tool', 'user']);
  // 限 40 → m1 不够，再整组裁工具组（call/result 不拆）
  const fit40 = fitMessages(messages, [], 40, new Set([1, 2, 3]));
  assert.deepEqual(fit40.trimmedIndices, [1, 2, 3]);
  assert.deepEqual(fit40.messages.map((m) => m.role), ['system', 'user']);
  // 只裁一半组是禁止的：组内有一条是硬约束 → 整组不动
  assert.throws(() => fitMessages(messages, [], 40, new Set([1, 2])), (err) => err.code === 'CONTEXT_BUDGET_EXCEEDED');
  // 硬约束超限 → 拒绝，不偷偷截用户目标/系统提示
  assert.throws(() => fitMessages(messages, [], 10, new Set([1, 2, 3])), (err) => err.code === 'CONTEXT_BUDGET_EXCEEDED');
  // 协议残缺：有 call 没 result / 悬空 result → 拒绝发送
  assert.throws(() => fitMessages([messages[2]], [], 1000), (err) => err.code === 'CONTEXT_PROTOCOL_INVALID');
  assert.throws(() => fitMessages([messages[3]], [], 1000), (err) => err.code === 'CONTEXT_PROTOCOL_INVALID');

  // 计量是最终 messages+tools 的真实序列化；来源明示为保守启发式
  const m = measureRequest(messages, [{ name: 'file.read', description: 'read', inputSchema: {}, effect: 'read', timeoutMs: 1000, maxOutputBytes: 1000 }]);
  assert.ok(m.serializedBytes > 0);
  assert.ok(m.inputTokensEstimate > 0);
  assert.match(m.source, /^heuristic-chars-v1/);
  assert.ok(estimateTextTokens('你好世界') >= 4, 'CJK 一字符一 token 起步');
});

test('gateway 已确认上下文上限：超限先裁可选证据，硬约束超限在发网络前拒绝', async () => {
  const saved = saveEnv();
  const env = await makeEnv({ contextLimits: { kimi: 40 } });
  try {
    setKimiTariff({ input: '2', output: '10' });
    const stub = stubProvider('kimi');
    env.register('kimi', stub);
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a'.repeat(400) }, // optional，裁掉后才够
      { role: 'user', content: 'goal' },
    ];
    const result = await env.gateway.complete(completeReq({ messages, optionalIndices: [1], maxOutputTokens: 10 }));
    assert.deepEqual(result.measurement.trimmedIndices, [1]);
    assert.equal(stub.calls, 1);

    // 硬约束超限：maxOutput 顶格后输入放不下 → 发网络前拒绝
    await assert.rejects(
      () => env.gateway.complete(completeReq({ callId: 'mc:t1:9', messages, maxOutputTokens: 39 })),
      (err) => err.code === 'CONTEXT_BUDGET_EXCEEDED',
    );
    assert.equal(stub.calls, 1, 'rejected before network');
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

// ── 14. 全调用扫描无旁路 ────────────────────────────────────────────

test('全调用扫描：SDK create 只在 protocol.ts，业务层无第二条出口', async () => {
  const srcRoot = resolve(import.meta.dirname, '../src');
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) await walk(fp);
      else if (entry.name.endsWith('.ts')) {
        const text = await readFile(fp, 'utf8');
        const rel = fp.slice(srcRoot.length + 1).replace(/\\/g, '/');
        if (/chat\.completions\.create\s*\(/.test(text) && rel !== 'providers/protocol.ts') {
          offenders.push(`${rel}: raw SDK create`);
        }
        if (/new OpenAI\s*\(/.test(text) && !rel.startsWith('providers/')) {
          offenders.push(`${rel}: raw OpenAI client`);
        }
      }
    }
  }
  await walk(srcRoot);
  assert.deepEqual(offenders, [], `bypass call sites outside ModelGateway: ${offenders.join('; ')}`);
});

// ── 15. AgentLoop 经 gateway：金额结算 + 预算耗尽失败 ───────────────

const M06_MD = '# 预算说明\n\n- 项目：M06\n';
const M06_ACCEPTANCE = {
  kind: 'file_deliverable',
  files: [{ path: 'note.md', minBytes: 10, mustContain: ['M06'] }],
};

async function makeLoopEnv(fixtureSteps, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m06-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ steps: fixtureSteps }), 'utf8');
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm06-test');
  const gateway = new ModelGateway({
    store,
    service,
    config: {
      mode: 'call-limit',
      defaultProvider: 'kimi',
      expensiveProviders: new Set(['astra']),
      maxRetries: 0,
      ...(opts.taskBudgetMicros !== undefined ? { taskBudgetMicros: opts.taskBudgetMicros } : {}),
    },
  });
  const fake = new FakeScriptedProvider({ fixturePath: fixture, enabled: true });
  gateway.registerProvider({ name: 'kimi', adapter: fake, model: 'kimi-k3', local: false, verified: true });
  service.createTask({
    id: 'task-m06',
    input: { goal: '创建预算说明' },
    sessionId: 's-m06',
    scope: 'skf-test',
    workspaceRoot: ws,
    provider: 'kimi',
    model: 'kimi-k3',
    acceptance: M06_ACCEPTANCE,
  });
  const registry = new ToolRegistry();
  const deps = {
    service,
    provider: fake,
    gateway,
    tools: registry,
    authorization: localDeliveryAuthorization(ws),
    flushMemoryOutbox: async () => {},
  };
  return { root, ws, store, service, gateway, deps };
}

test('AgentLoop 经 ModelGateway：两步调用按 usage 结算整数 micros，产物照验', async () => {
  const saved = saveEnv();
  const env = await makeLoopEnv([
    { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'note.md', content: M06_MD } }], usage: { inputTokens: 10, outputTokens: 5 } },
    { expectToolResults: ['call-1'], text: '已创建 note.md。', usage: { inputTokens: 30, outputTokens: 12 } },
  ]);
  try {
    setKimiTariff({ input: '2', output: '10' });
    const result = await runAgentLoop(env.deps, 'task-m06');
    assert.equal(result.state, 'succeeded');
    const rows = env.store.db.prepare('SELECT * FROM model_calls WHERE taskId = ? ORDER BY createdAt ASC').all('task-m06');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.state), ['settled', 'settled']);
    // 10×2+5×10=70；30×2+12×10=180
    assert.deepEqual(rows.map((r) => r.settledCostMicros), [70, 180]);
    assert.ok(rows.every((r) => r.currency === 'USD' && r.tariffVersion === TARIFF_VERSION));
    const status = env.gateway.status({ taskId: 'task-m06' });
    assert.equal(status.task.spent, 250);
    assert.equal(status.source, 'configured-estimate');
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});

test('AgentLoop 预算耗尽：发网络前任务失败 BUDGET_EXCEEDED，零副作用', async () => {
  const saved = saveEnv();
  const env = await makeLoopEnv(
    [
      { toolCalls: [{ id: 'call-1', name: 'file.write', arguments: { path: 'note.md', content: M06_MD } }] },
      { expectToolResults: ['call-1'], text: 'done' },
    ],
    { taskBudgetMicros: 10 },
  );
  try {
    setKimiTariff({ input: '2', output: '10' });
    const result = await runAgentLoop(env.deps, 'task-m06');
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'BUDGET_EXCEEDED');
    const calls = env.store.db.prepare('SELECT COUNT(*) AS c FROM model_calls WHERE taskId = ?').get('task-m06');
    assert.equal(calls.c, 0, 'rejected precheck leaves no reservation');
    const ops = env.store.db.prepare('SELECT COUNT(*) AS c FROM operations WHERE taskId = ?').get('task-m06');
    assert.equal(ops.c, 0, 'no tool side effects');
    await assert.rejects(readFile(join(env.ws, 'note.md')), /ENOENT/);
  } finally {
    env.store.close();
    restoreEnv(saved);
    await cleanupTestRoot(env.root);
  }
});
