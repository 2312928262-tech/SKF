/**
 * DeepSeek Provider — 国内直连副模型（OpenAI 兼容）
 * =====================================================
 * endpoint: https://api.deepseek.com/v1
 * DOC(2026-09-08 核查): api-docs.deepseek.com — 支持 Function Calling；
 *   max_tokens 默认 4096（Beta 可到 8192）；usage 含 prompt_cache_hit_tokens
 *  （缓存命中是 prompt_tokens 子集，不重复计）。contextWindowTokens 未确认 ⇒ null。
 * 代理纪律: 国内 API 强制直连，不跟随全局 HTTPS_PROXY（代理只给 astra 用）。
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

const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

export interface DeepseekProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class DeepseekProvider implements Provider, ProviderAdapter {
  name: ProviderName = 'deepseek';
  private client: OpenAI;
  private model: string;
  private secret: string;

  constructor(opts: DeepseekProviderOptions) {
    this.secret = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || DEFAULT_BASE_URL,
      timeout: 300_000,
      maxRetries: 0,
    });
  }

  get modelName(): string { return this.model; }

  setModel(model: string) {
    this.model = model || DEFAULT_MODEL;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    // DOC: api-docs.deepseek.com Function Calling（2026-09-08 核查）
    return { tools: true, streaming: true, cancel: true, usage: true, contextWindowTokens: null };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return completeOpenAICompat(this.client as unknown as OpenAICompatLike, { provider: 'deepseek', model: this.model, maxTokensParam: 'max_tokens', reasoning: true }, req);
  }

  async think(req: ThinkRequest): Promise<ThinkResponse> {
    return thinkViaComplete('deepseek', this.model, this, req, { timeoutMs: 300_000 });
  }

  async isReady(): Promise<boolean> {
    if (!this.secret) return false;
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
