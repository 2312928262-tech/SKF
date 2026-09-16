/**
 * OpenRouter Provider — 一个 key 调多家模型
 * DOC(2026-09-08): OpenAI 兼容；工具支持取决于上游模型（能力标注按当前默认模型）；
 *   usage 字段随上游变化，缺失记 null。contextWindowTokens 按模型而异 ⇒ null。
 * 价格不在代码里写死，见 runtime/usage.ts 版本化配置。
 */

import OpenAI from 'openai';
import type { Provider, ThinkRequest, ThinkResponse, ProviderName } from './types.js';
import {
  completeOpenAICompat,
  type OpenAICompatLike,
  type CompletionRequest,
  type CompletionResult,
  type ProviderAdapter,
  type ProviderCapabilities,
} from './protocol.js';
import { thinkViaComplete } from './think-compat.js';

// 模型别名（不含价格宣传；实测限制记 HANDOFF knownFacts）
const MODEL_MAP: Record<string, string> = {
  mistral: 'mistralai/mistral-large-2512',
  mistral_medium: 'mistralai/mistral-medium-3-5',
  deepseek: 'deepseek/deepseek-v4-pro',
  deepseek_flash: 'deepseek/deepseek-v4-flash',
  qwen_max: 'qwen/qwen3.8-max',
  qwen: 'qwen/qwen3.8-flash',
  llama: 'meta-llama/llama-3.1-70b-instruct',
  claude: 'anthropic/claude-sonnet-4',
  gpt5: 'openai/gpt-5.5',
};

export class OpenRouterProvider implements Provider, ProviderAdapter {
  name: ProviderName = 'openrouter';
  private client: OpenAI;
  private model: string;
  private apiKey: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || MODEL_MAP.mistral;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'HTTP-Referer': 'https://SKF.local', 'X-Title': 'SKF' },
      timeout: 180_000,
      maxRetries: 0,
    });
  }

  get modelName(): string { return this.model; }

  setModel(model: keyof typeof MODEL_MAP | string) {
    this.model = MODEL_MAP[model] || model;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    // 工具/缓存口径随上游模型变化；保守标注，未确认项为 null/false 由 M06 探测确认
    return { tools: true, streaming: true, cancel: true, usage: true, contextWindowTokens: null };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return completeOpenAICompat(this.client as unknown as OpenAICompatLike, { provider: 'openrouter', model: this.model, maxTokensParam: 'max_tokens' }, req);
  }

  async think(req: ThinkRequest): Promise<ThinkResponse> {
    return thinkViaComplete('openrouter', this.model, this, req);
  }

  async isReady(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
