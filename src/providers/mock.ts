/**
 * Mock Provider — 测试用假大脑（不调任何网络）
 * 文本回复；usage 是字符数估算（source=estimated），不是 token 计数。
 */

import type { Provider, ThinkRequest, ThinkResponse } from './types.js';
import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
  ProviderCapabilities,
} from './protocol.js';
import { thinkViaComplete } from './think-compat.js';

export class MockProvider implements Provider, ProviderAdapter {
  name = 'mock' as const;

  async capabilities(): Promise<ProviderCapabilities> {
    return { tools: false, streaming: false, cancel: true, usage: false, contextWindowTokens: null };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    await new Promise((r) => setTimeout(r, 50));
    const user = req.messages.filter((m) => m.role === 'user').at(-1);
    const question = user && 'content' in user ? String(user.content) : '';
    const text = `[mock] 测试大脑收到（${req.callId}）：「${question.slice(0, 30)}${question.length > 30 ? '…' : ''}」。不花钱，只验证链路。`;
    return {
      responseId: `mock-${req.callId}`,
      provider: 'mock',
      model: 'mock-0.2',
      assistant: { role: 'assistant', content: text },
      finishReason: 'stop',
      usage: { inputTokens: question.length, outputTokens: text.length, cachedInputTokens: null, source: 'estimated' },
    };
  }

  async think(req: ThinkRequest): Promise<ThinkResponse> {
    return thinkViaComplete('mock', 'mock-0.2', this, req);
  }

  async isReady(): Promise<boolean> {
    return true;
  }
}
