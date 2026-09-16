// M02 验收：provider 协议统一。
// 全部 fake/合成 fixture，无任何网络与云调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { FakeScriptedProvider } from '../dist/providers/fake-scripted.js';
import { MockProvider } from '../dist/providers/mock.js';
import {
  completeOpenAICompat,
  mapCompletionResponse,
  mapProviderError,
  mapUsage,
  normalizeToolCalls,
  toOpenAIMessages,
  ProviderError,
} from '../dist/providers/protocol.js';

const FIXTURE = resolve(import.meta.dirname, 'fixtures/fake-two-turn.json');

function makeReq(overrides = {}) {
  return {
    callId: 'c1',
    taskId: 't1',
    messages: [{ role: 'user', content: '在工作区创建报价说明' }],
    tools: [{
      name: 'file.write', description: '写文件', inputSchema: { type: 'object' },
      effect: 'workspace_write', timeoutMs: 5000, maxOutputBytes: 100000,
    }],
    maxOutputTokens: 1000,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    ...overrides,
  };
}

test('fake 双轮协议：file.write 调用 → 同 ID tool result 回灌 → 文本收尾', async () => {
  const fake = new FakeScriptedProvider({ fixturePath: FIXTURE, enabled: true });
  const r1 = await fake.complete(makeReq());
  assert.equal(r1.finishReason, 'tool_calls');
  assert.equal(r1.assistant.toolCalls?.length, 1);
  const call = r1.assistant.toolCalls[0];
  assert.equal(call.id, 'call-write-1');
  assert.equal(call.name, 'file.write');
  assert.deepEqual(call.arguments, { path: 'report.md', content: '# 报价说明\n\n测试内容' });
  assert.equal(r1.usage.source, 'provider');
  assert.equal(r1.usage.inputTokens, 120);

  // 第二轮：assistant.toolCalls 原样保留 + 匹配 toolCallId 的 tool 结果
  const r2 = await fake.complete(makeReq({
    callId: 'c2',
    messages: [
      { role: 'user', content: '在工作区创建报价说明' },
      r1.assistant,
      { role: 'tool', toolCallId: 'call-write-1', name: 'file.write', content: 'ok: report.md written' },
    ],
  }));
  assert.equal(r2.text ?? r2.assistant.content, '文件已经写好并通过校验。');
  assert.equal(r2.finishReason, 'stop');
  assert.equal(r2.usage.cachedInputTokens, 50);
});

test('tool result ID 不匹配：fake 断言失败', async () => {
  const fake = new FakeScriptedProvider({ fixturePath: FIXTURE, enabled: true });
  await fake.complete(makeReq());
  await assert.rejects(
    fake.complete(makeReq({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-write-1', name: 'file.write', arguments: {} }] },
        { role: 'tool', toolCallId: 'call-WRONG', name: 'file.write', content: 'ok' },
      ],
    })),
    (err) => err instanceof ProviderError && err.code === 'FAKE_EXPECTATION_FAILED',
  );
});

test('故障注入全集：空响应/截断/拒绝/非JSON参数/重复ID/断流', async () => {
  const run = async (step) => {
    const fake = new FakeScriptedProvider({ enabled: true });
    fake['steps'] = [step];
    return fake.complete(makeReq());
  };
  // 空响应
  await assert.rejects(run({ empty: true }), (e) => e.code === 'EMPTY_RESPONSE');
  // length 截断：保留文本与 finishReason，不谎称成功
  const trunc = await run({ text: '半句话', finishReason: 'length' });
  assert.equal(trunc.finishReason, 'length');
  assert.equal(trunc.assistant.content, '半句话');
  // 拒绝
  const refusal = await run({ text: '不能执行该请求', finishReason: 'refusal' });
  assert.equal(refusal.finishReason, 'refusal');
  // 非 JSON arguments：保留原文不崩（下游 schema 校验负责拒绝）
  const badArgs = await run({ toolCalls: [{ name: 'fs', argumentsRaw: '{not json' }] });
  assert.equal(badArgs.assistant.toolCalls[0].arguments, '{not json');
  // 重复 call ID：结构化错误
  await assert.rejects(
    run({ toolCalls: [{ id: 'dup', name: 'a', arguments: {} }, { id: 'dup', name: 'b', arguments: {} }] }),
    (e) => e.code === 'TOOL_CALL_ID_DUPLICATE',
  );
  // provider 断流
  await assert.rejects(run({ error: 'PROVIDER_STREAM_BROKEN' }), (e) => e.code === 'PROVIDER_STREAM_BROKEN');
  // usage 未知：null + unknown，不补 0
  const unknown = await run({ text: 'hi' });
  assert.deepEqual(unknown.usage, { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' });
});

test('fake 生产 fail-closed：未启用或无 fixture ⇒ PROVIDER_NOT_CONFIGURED', async () => {
  const off = new FakeScriptedProvider({ fixturePath: FIXTURE, enabled: false });
  await assert.rejects(off.complete(makeReq()), (e) => e.code === 'PROVIDER_NOT_CONFIGURED');
  const noFixture = new FakeScriptedProvider({ enabled: true });
  await assert.rejects(noFixture.complete(makeReq()), (e) => e.code === 'PROVIDER_NOT_CONFIGURED');
});

test('normalizeToolCalls：缺 id 生成稳定 id（重试不换号）', () => {
  const a = normalizeToolCalls([{ name: 'fs', arguments: {} }], 'resp-9');
  const b = normalizeToolCalls([{ name: 'fs', arguments: {} }], 'resp-9');
  assert.equal(a[0].id, b[0].id);
  assert.equal(a[0].id, 'resp-9:call:0');
});

test('mapUsage：缺失记 null；cached 是子集不重复计', () => {
  assert.deepEqual(mapUsage(undefined), { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' });
  assert.deepEqual(mapUsage({ prompt_tokens: 100, completion_tokens: 20 }), {
    inputTokens: 100, outputTokens: 20, cachedInputTokens: null, source: 'provider',
  });
  // deepseek 口径：prompt_cache_hit_tokens
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 40 }).cachedInputTokens, 40);
  // openai 口径：prompt_tokens_details.cached_tokens；超出 input 时截断
  assert.equal(
    mapUsage({ prompt_tokens: 30, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80 } }).cachedInputTokens,
    30,
  );
});

test('mapCompletionResponse：空 choices、finish_reason 映射、tool_calls 解析', () => {
  const cfg = { provider: 'fake', model: 'm', maxTokensParam: 'max_tokens' };
  assert.throws(() => mapCompletionResponse({ choices: [] }, cfg), (e) => e.code === 'EMPTY_RESPONSE');
  const r = mapCompletionResponse({
    id: 'resp-1',
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'file.write', arguments: '{"a":1}' } }] },
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }, cfg);
  assert.equal(r.finishReason, 'tool_calls');
  assert.equal(r.assistant.content, '');
  assert.deepEqual(r.assistant.toolCalls[0], { id: 'x1', name: 'file.write', arguments: { a: 1 } });
});

test('toOpenAIMessages：tool 消息与 assistant.toolCalls 成组保留', () => {
  const msgs = toOpenAIMessages([
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'k1', name: 'fs', arguments: { p: 1 } }] },
    { role: 'tool', toolCallId: 'k1', name: 'fs', content: 'done' },
  ]);
  assert.equal(msgs[2].tool_calls[0].function.arguments, '{"p":1}');
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'k1', content: 'done' });
});

test('mapProviderError：状态码/中止/超时/连接错误映射', () => {
  assert.equal(mapProviderError({ status: 401, message: 'x' }).code, 'PROVIDER_AUTH_FAILED');
  assert.equal(mapProviderError({ status: 403, message: 'x' }).code, 'PROVIDER_AUTH_FAILED');
  assert.equal(mapProviderError({ status: 429, message: 'x' }).code, 'PROVIDER_RATE_LIMITED');
  assert.equal(mapProviderError({ status: 503, message: 'x' }).code, 'PROVIDER_SERVER_ERROR');
  assert.equal(mapProviderError({ status: 400, message: 'x' }).code, 'PROVIDER_BAD_REQUEST');
  assert.equal(mapProviderError({ name: 'APIUserAbortError' }).code, 'PROVIDER_ABORTED');
  assert.equal(mapProviderError({ name: 'AbortError' }).code, 'PROVIDER_ABORTED');
  assert.equal(mapProviderError({ name: 'APIConnectionTimeoutError' }).code, 'PROVIDER_TIMEOUT');
  assert.equal(mapProviderError({ name: 'APIConnectionError' }).code, 'PROVIDER_UNREACHABLE');
  assert.equal(mapProviderError(new Error('weird')).code, 'MODEL_REQUEST_FAILED');
  const pe = new ProviderError('KEEP_ME');
  assert.equal(mapProviderError(pe), pe);
});

test('AbortSignal/timeout 直达底层；deadline 已过不发请求', async () => {
  let seen = null;
  const stubClient = {
    chat: { completions: { create: async (params, options) => {
      seen = { params, options };
      return { id: 'r', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } },
  };
  const controller = new AbortController();
  const deadlineAt = Date.now() + 60_000;
  await completeOpenAICompat(stubClient, { provider: 'stub', model: 'm', maxTokensParam: 'max_tokens' },
    makeReq({ signal: controller.signal, deadlineAt }));
  assert.equal(seen.options.signal, controller.signal);
  assert.ok(seen.options.timeout > 50_000 && seen.options.timeout <= 60_000, 'timeout 应等于剩余 deadline');

  // 中止传播：底层等待 signal，abort 后映射 PROVIDER_ABORTED
  const abortClient = {
    chat: { completions: { create: (_p, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })));
    }) } },
  };
  const c2 = new AbortController();
  const pending = completeOpenAICompat(abortClient, { provider: 'stub', model: 'm', maxTokensParam: 'max_tokens' },
    makeReq({ signal: c2.signal, deadlineAt: Date.now() + 60_000 }));
  c2.abort();
  await assert.rejects(pending, (e) => e.code === 'PROVIDER_ABORTED');

  // deadline 已过：不发网络请求
  let called = false;
  const neverClient = { chat: { completions: { create: async () => { called = true; } } } };
  await assert.rejects(
    completeOpenAICompat(neverClient, { provider: 'stub', model: 'm', maxTokensParam: 'max_tokens' },
      makeReq({ deadlineAt: Date.now() - 1 })),
    (e) => e.code === 'PROVIDER_DEADLINE_EXCEEDED',
  );
  assert.equal(called, false);
});

test('think 兼容入口：mock 走 complete，usage 标 estimated，无 5 层装饰文案', async () => {
  const mock = new MockProvider();
  const resp = await mock.think({ userMessage: '你好', turn: 1 });
  assert.equal(resp.provider, 'mock');
  assert.ok(resp.text.includes('[mock]'));
  assert.ok(!resp.text.includes('5 层'), 'mock 不得再宣称 统一记忆');
  assert.equal((await mock.capabilities()).tools, false);
});
