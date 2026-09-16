// M02-fix 验收：推理模型 reasoning_content 全链路（deepseek/kimi thinking 模式）。
// 根因：deepseek-v4-pro / kimi-k3 为推理模型，多轮工具对话必须把 assistant 上一轮的
//   reasoning_content 原样传回，否则 400（"reasoning_content ... must be passed back"）。
// 覆盖：响应解析捕获 → 持久化（migration v7 + appendMessage/listMessages）→
//   回灌 toModelMessages → toOpenAIMessages 回写 → 第二轮 200。
// 全部合成 fixture / 本机临时目录，零网络、零付费调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  completeOpenAICompat,
  mapCompletionResponse,
  toOpenAIMessages,
} from '../dist/providers/protocol.js';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { runAgentLoop } from '../dist/runtime/agent-loop.js';

const DEEPSEEK_REASONING = '让我先读一下工作区的现有文件，再决定写入内容。';
const KIMI_REASONING = '先确认工作区里是否已有同名文件，避免覆盖。';

function makeReq(overrides = {}) {
  return {
    callId: 'c1',
    taskId: 't1',
    messages: [{ role: 'user', content: '看看工作区' }],
    tools: [{
      name: 'file.read', description: '读文件', inputSchema: { type: 'object' },
      effect: 'read', timeoutMs: 5000, maxOutputBytes: 100000,
    }],
    maxOutputTokens: 1000,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    ...overrides,
  };
}

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  await rm(absolute, { recursive: true, force: true });
}

// ── 1. 响应解析：reasoning_content 落到 assistant.reasoningContent ──

test('mapCompletionResponse：捕获 reasoning_content，缺失不注入空字段', () => {
  const cfg = { provider: 'deepseek', model: 'deepseek-v4-pro', maxTokensParam: 'max_tokens' };
  const r = mapCompletionResponse({
    id: 'ds-1',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: '',
        reasoning_content: DEEPSEEK_REASONING,
        tool_calls: [{ id: 'call-ds-1', type: 'function', function: { name: 'file.read', arguments: '{"path":"."}' } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, cfg);
  assert.equal(r.assistant.reasoningContent, DEEPSEEK_REASONING);
  assert.equal(r.assistant.content, '');
  assert.equal(r.assistant.toolCalls[0].id, 'call-ds-1');

  const plain = mapCompletionResponse({
    id: 'x-1',
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }, { provider: 'astra', model: 'gpt-6-astra', maxTokensParam: 'max_completion_tokens' });
  assert.equal('reasoningContent' in plain.assistant, false);
});

// ── 2. 序列化：仅推理 provider 回写 reasoning_content，非推理不回写 ──

test('toOpenAIMessages：reasoning=true 原样回写；非推理不回写无关字段', () => {
  const assistant = { role: 'assistant', content: '', reasoningContent: DEEPSEEK_REASONING, toolCalls: [{ id: 'k1', name: 'file.read', arguments: { path: '.' } }] };
  const withReasoning = toOpenAIMessages([assistant], { reasoning: true });
  assert.equal(withReasoning[0].reasoning_content, DEEPSEEK_REASONING);
  assert.equal(withReasoning[0].content, '');
  assert.equal(withReasoning[0].tool_calls[0].id, 'k1');

  const withoutReasoning = toOpenAIMessages([assistant]);
  assert.equal('reasoning_content' in withoutReasoning[0], false);
});

// ── 3/4. deepseek & kimi 两轮工具对话：回写后第二轮 200 ─────────

function twoTurnStub(reasoningText, provider, model, label) {
  const seen = [];
  const stub = {
    seen,
    chat: { completions: { create: async (params) => {
      seen.push(params);
      if (seen.length === 1) {
        return {
          id: `${label}-1`,
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: '',
              reasoning_content: reasoningText,
              tool_calls: [{ id: `call-${label}-1`, type: 'function', function: { name: 'file.read', arguments: '{"path":"."}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        };
      }
      const assistantMsg = params.messages.find((m) => m.role === 'assistant');
      assert.equal(assistantMsg.reasoning_content, reasoningText, `${label} 第二轮必须原样回写 reasoning_content`);
      assert.equal(assistantMsg.content, '');
      assert.equal(assistantMsg.tool_calls[0].id, `call-${label}-1`);
      return {
        id: `${label}-2`,
        choices: [{ finish_reason: 'stop', message: { content: '工作区读取完成。' } }],
        usage: { prompt_tokens: 200, completion_tokens: 20 },
      };
    } } },
  };
  return { stub, cfg: { provider, model, maxTokensParam: 'max_tokens', reasoning: true } };
}

test('deepseek 两轮工具对话：reasoning_content 原样回写，第二轮 200', async () => {
  const { stub, cfg } = twoTurnStub(DEEPSEEK_REASONING, 'deepseek', 'deepseek-v4-pro', 'ds');
  const r1 = await completeOpenAICompat(stub, cfg, makeReq());
  assert.equal(r1.assistant.reasoningContent, DEEPSEEK_REASONING);
  assert.equal(r1.assistant.toolCalls[0].id, 'call-ds-1');

  const r2 = await completeOpenAICompat(stub, cfg, makeReq({
    messages: [
      { role: 'user', content: '看看工作区' },
      r1.assistant,
      { role: 'tool', toolCallId: 'call-ds-1', name: 'file.read', content: 'ok' },
    ],
  }));
  assert.equal(r2.finishReason, 'stop');
  assert.equal(r2.assistant.content, '工作区读取完成。');
  assert.equal(stub.seen.length, 2);
});

test('kimi-k3 两轮工具对话：reasoning_content 原样回写，第二轮 200', async () => {
  const { stub, cfg } = twoTurnStub(KIMI_REASONING, 'kimi', 'kimi-k3', 'km');
  const r1 = await completeOpenAICompat(stub, cfg, makeReq());
  assert.equal(r1.assistant.reasoningContent, KIMI_REASONING);
  assert.equal(r1.assistant.toolCalls[0].id, 'call-km-1');

  const r2 = await completeOpenAICompat(stub, cfg, makeReq({
    messages: [
      { role: 'user', content: '看看工作区' },
      r1.assistant,
      { role: 'tool', toolCallId: 'call-km-1', name: 'file.read', content: 'ok' },
    ],
  }));
  assert.equal(r2.finishReason, 'stop');
  assert.equal(r2.assistant.content, '工作区读取完成。');
  assert.equal(stub.seen.length, 2);
});

// ── 5. 持久化：migration v7 列 + 跨重启（close/reopen）不丢 ─────────

test('messages.reasoningContent 跨重启持久化：schema v7，reasoning 原样保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m02fix-'));
  const dbPath = join(root, 'runtime.sqlite');
  let store;
  let service;
  try {
    store = new RuntimeStore(dbPath);
    assert.equal(store.schemaVersion(), 7);
    service = new TaskService(store, 'm02fix');
    service.createTask({
      id: 't-rc', input: { goal: '持久化验证' }, sessionId: 's', scope: 'skf-test',
      workspaceRoot: root, provider: 'deepseek', model: 'deepseek-v4-pro',
    });
    service.appendMessage('t-rc', { role: 'user', content: 'u' });
    service.appendMessage('t-rc', {
      role: 'assistant', content: '', reasoningContent: DEEPSEEK_REASONING,
      toolCalls: [{ id: 'call-rc-1', name: 'file.read', arguments: { path: '.' } }],
    });
    service.appendMessage('t-rc', { role: 'tool', content: 'ok', toolCallId: 'call-rc-1', name: 'file.read' });
    store.close();

    // 模拟跨重启：同路径重开
    store = new RuntimeStore(dbPath);
    service = new TaskService(store, 'm02fix');
    const msgs = service.listMessages('t-rc');
    const assistant = msgs.find((m) => m.role === 'assistant');
    assert.equal(assistant.reasoningContent, DEEPSEEK_REASONING);
    assert.equal(assistant.toolCalls[0].id, 'call-rc-1');
    // 非 assistant 消息 reasoningContent 为 null，不误注入
    assert.equal(msgs.find((m) => m.role === 'user').reasoningContent, null);
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

// ── 6. AgentLoop 全链路：推理 provider 的 reasoningContent 落库并在第二轮回传 ─

test('AgentLoop 推理 provider：reasoningContent 落库 + 第二轮原样回传，交付成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m02fix-loop-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });

  const calls = [];
  const provider = {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete(req) {
      calls.push(req.messages);
      if (calls.length === 1) {
        return {
          provider: 'deepseek', model: 'deepseek-v4-pro',
          assistant: {
            role: 'assistant', content: '',
            reasoningContent: '需要把报价说明写到工作区 rc.md 文件里。',
            toolCalls: [{ id: 'call-rc-1', name: 'file.write', arguments: { path: 'rc.md', content: '# rc\n报价说明\n' } }],
          },
          finishReason: 'tool_calls',
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, source: 'provider' },
        };
      }
      const assistantMsg = req.messages.find((m) => m.role === 'assistant');
      assert.equal(assistantMsg.reasoningContent, '需要把报价说明写到工作区 rc.md 文件里。', '第二轮必须回传 reasoningContent');
      assert.ok(assistantMsg.toolCalls?.length, '第二轮必须回传 tool_calls');
      return {
        provider: 'deepseek', model: 'deepseek-v4-pro',
        assistant: { role: 'assistant', content: '报价说明已写入 rc.md。' },
        finishReason: 'stop',
        usage: { inputTokens: 20, outputTokens: 6, cachedInputTokens: null, source: 'provider' },
      };
    },
  };

  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm02fix-loop');
  const registry = new ToolRegistry();
  const taskId = 'task-rc';
  service.createTask({
    id: taskId,
    input: { goal: '写一个报价说明文件' },
    sessionId: 's-loop',
    scope: 'skf-test',
    workspaceRoot: ws,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    acceptance: { kind: 'file_deliverable', files: [{ path: 'rc.md', minBytes: 1, mustContain: ['rc'] }] },
  });

  try {
    const result = await runAgentLoop({
      service,
      provider,
      tools: registry,
      authorization: localDeliveryAuthorization(ws),
      flushMemoryOutbox: async () => {},
    }, taskId);

    assert.equal(result.state, 'succeeded');
    assert.equal(result.modelSteps, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(calls.length, 2);

    // reasoningContent 已持久化到消息历史
    const msgs = service.listMessages(taskId);
    const assistant = msgs.find((m) => m.role === 'assistant' && m.toolCalls !== null);
    assert.equal(assistant.reasoningContent, '需要把报价说明写到工作区 rc.md 文件里。');
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});
