/**
 * think → complete 兼容封装（M02）。
 * 旧聊天调用点不变，内部统一走 ProviderAdapter.complete；不是第二套协议。
 */

import type { ProviderName, ThinkRequest, ThinkResponse } from './types.js';
import type { ProviderAdapter, CompletionRequest } from './protocol.js';
import { positiveInt } from '../runtime/config.js';

export interface ThinkCompatOptions {
  timeoutMs?: number;
  /** astra 专用：已配置价目时给出 UI 估算（非账单）。 */
  estimateCost?: (input: number | null, output: number | null, cached: number | null) => number | undefined;
}

export async function thinkViaComplete(
  name: ProviderName,
  model: string,
  adapter: ProviderAdapter,
  req: ThinkRequest,
  opts: ThinkCompatOptions = {},
): Promise<ThinkResponse> {
  const messages: CompletionRequest['messages'] = [];
  if (req.context) messages.push({ role: 'system', content: req.context });
  messages.push({ role: 'user', content: req.userMessage });
  const result = await adapter.complete({
    callId: `think:${name}:${req.turn}`,
    taskId: 'chat',
    messages,
    tools: [],
    maxOutputTokens: positiveInt('SKF_MAX_OUTPUT_TOKENS', 4096, 32768),
    signal: new AbortController().signal,
    deadlineAt: Date.now() + (opts.timeoutMs ?? 180_000),
  });
  const { inputTokens, outputTokens, cachedInputTokens } = result.usage;
  const cost = opts.estimateCost?.(inputTokens, outputTokens, cachedInputTokens ?? null);
  return {
    text: result.assistant.content,
    ...(result.assistant.toolCalls?.length
      ? { toolCalls: result.assistant.toolCalls.map((tc) => ({ name: tc.name, args: (tc.arguments ?? {}) as Record<string, unknown> })) }
      : {}),
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      ...(cost === undefined ? {} : { cost, costSource: 'configured-estimate' as const }),
    },
    provider: name,
    model,
    finishReason: result.finishReason,
  };
}
