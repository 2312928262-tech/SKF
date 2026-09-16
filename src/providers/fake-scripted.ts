/**
 * FakeScriptedProvider — 纯本地 fixture 驱动的假模型（M02）。
 *
 * - 只读本地 JSON fixture，不发起任何网络调用。
 * - 只能在 test/dev 明确模式启用：NODE_ENV=test 或 SKF_FAKE_PROVIDER=1，
 *   否则 complete 一律 PROVIDER_NOT_CONFIGURED（生产 fail-closed）。
 * - fixture 步骤可断言「上一轮的工具结果带着同一个 call ID 回来了」，
 *   不满足则 FAKE_EXPECTATION_FAILED —— 这是协议闭环的验收钩子。
 *
 * fixture 格式：
 * {
 *   "steps": [
 *     { "toolCalls": [{ "id": "call-1", "name": "file.write", "arguments": {"path":"a.md","content":"..."} }] },
 *     { "expectToolResults": ["call-1"], "text": "写好了" },
 *     { "error": "PROVIDER_STREAM_BROKEN" },
 *     { "empty": true },
 *     { "text": "半句", "finishReason": "length" },
 *     { "toolCalls": [{ "name": "fs", "argumentsRaw": "{not json" }] },
 *     { "usage": { "inputTokens": 10, "outputTokens": 5, "cachedInputTokens": null } }
 *   ]
 * }
 */

import { readFileSync } from 'node:fs';
import type { Provider, ProviderName, ThinkRequest, ThinkResponse } from './types.js';
import { thinkViaComplete } from './think-compat.js';
import {
  normalizeToolCalls,
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ProviderAdapter,
  type ProviderCapabilities,
  type Usage,
} from './protocol.js';

interface FakeStep {
  expectToolResults?: string[];
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments?: unknown; argumentsRaw?: string }>;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'refusal';
  usage?: { inputTokens?: number | null; outputTokens?: number | null; cachedInputTokens?: number | null };
  error?: string;
  empty?: boolean;
  /** M08：模拟慢模型的阻塞毫秒数（1..120000）；等待尊重 AbortSignal。 */
  delayMs?: number;
}

export interface FakeScriptedOptions {
  fixturePath?: string;
  /** 不传时按环境判定：NODE_ENV=test 或 SKF_FAKE_PROVIDER=1。 */
  enabled?: boolean;
}

export class FakeScriptedProvider implements Provider, ProviderAdapter {
  readonly name: ProviderName = 'fake';
  private steps: FakeStep[] | null = null;
  private cursor = 0;
  private enabled: boolean;

  constructor(opts: FakeScriptedOptions = {}) {
    this.enabled = opts.enabled ?? (process.env.NODE_ENV === 'test' || process.env.SKF_FAKE_PROVIDER === '1');
    if (opts.fixturePath) {
      const parsed = JSON.parse(readFileSync(opts.fixturePath, 'utf8')) as { steps?: FakeStep[] };
      if (!Array.isArray(parsed.steps)) throw new ProviderError('FAKE_FIXTURE_INVALID', opts.fixturePath);
      this.steps = parsed.steps;
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.enabled || !this.steps) throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'fake fixture');
    const step = this.steps[this.cursor++];
    if (!step) throw new ProviderError('FAKE_SCRIPT_EXHAUSTED', `step #${this.cursor}`);

    if (step.expectToolResults) {
      const got = req.messages.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId);
      for (const expected of step.expectToolResults) {
        if (!got.includes(expected)) {
          throw new ProviderError(
            'FAKE_EXPECTATION_FAILED',
            `expected tool result for ${expected}, got [${got.join(', ')}]`,
          );
        }
      }
    }
    // M08：阻塞步（慢模型仿真）。等待期间尊重 AbortSignal；中止抛 PROVIDER_ABORTED，
    // 与真实 provider 的取消语义一致（费用是否发生由上层账本按 uncertain 处理）。
    if (step.delayMs !== undefined) {
      if (!Number.isSafeInteger(step.delayMs) || step.delayMs < 1 || step.delayMs > 120_000) {
        throw new ProviderError('FAKE_FIXTURE_INVALID', 'delayMs must be 1..120000');
      }
      await new Promise<void>((resolvePromise, rejectPromise) => {
        if (req.signal.aborted) {
          rejectPromise(new ProviderError('PROVIDER_ABORTED'));
          return;
        }
        const cleanup = () => {
          clearTimeout(timer);
          req.signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          rejectPromise(new ProviderError('PROVIDER_ABORTED'));
        };
        const timer = setTimeout(() => {
          cleanup();
          resolvePromise();
        }, step.delayMs);
        req.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (step.error) throw new ProviderError(step.error);
    if (step.empty) throw new ProviderError('EMPTY_RESPONSE');

    const rawCalls = (step.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.argumentsRaw !== undefined ? tc.argumentsRaw : (tc.arguments as never ?? {}),
    }));
    const toolCalls = rawCalls.length ? normalizeToolCalls(rawCalls, `fake:${this.cursor}`) : undefined;
    const usage: Usage = step.usage
      ? {
          inputTokens: step.usage.inputTokens ?? null,
          outputTokens: step.usage.outputTokens ?? null,
          cachedInputTokens: step.usage.cachedInputTokens ?? null,
          source: 'provider',
        }
      : { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' };
    return {
      responseId: `fake-resp-${this.cursor}`,
      provider: 'fake',
      model: 'fake-scripted',
      assistant: { role: 'assistant', content: step.text ?? '', ...(toolCalls ? { toolCalls } : {}) },
      finishReason: step.finishReason ?? (toolCalls?.length ? 'tool_calls' : 'stop'),
      usage,
    };
  }

  async think(req: ThinkRequest): Promise<ThinkResponse> {
    return thinkViaComplete('fake', 'fake-scripted', this, req);
  }

  async isReady(): Promise<boolean> {
    return this.enabled && this.steps !== null;
  }
}
