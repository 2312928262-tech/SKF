/**
 * Kimi K3 Provider — 国内主模型（moonshot API，直连不走代理）
 * =====================================================
 * endpoint: https://api.moonshot.cn/v1/
 * DOC(2026-09-08 核查): platform.kimi.ai/docs/api/tool-use — 支持 Tool Use/Function Calling，
 *   OpenAI 兼容，tool_calls[].function.arguments 为 JSON 字符串，finish_reason=tool_calls；
 *   示例参数名为 max_tokens。contextWindowTokens 未按官方文档确认 ⇒ null。
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

const DEFAULT_MODEL = 'kimi-k3';
const DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1/';

export interface KimiProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class KimiProvider implements Provider, ProviderAdapter {
  name: ProviderName = 'kimi';
  private client: OpenAI;
  private model: string;
  private secret: string;

  constructor(opts: KimiProviderOptions) {
    this.secret = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || DEFAULT_BASE_URL,
      timeout: 300_000,
      maxRetries: 0, // SDK 自动重试关闭；重试只能由 ModelGateway 显式策略开启
    });
  }

  get modelName(): string { return this.model; }

  setModel(model: string) {
    this.model = model || DEFAULT_MODEL;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    // DOC: platform.kimi.ai/docs/api/tool-use（2026-09-08 核查）
    return { tools: true, streaming: true, cancel: true, usage: true, contextWindowTokens: null };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return completeOpenAICompat(this.client as unknown as OpenAICompatLike, { provider: 'kimi', model: this.model, maxTokensParam: 'max_tokens', reasoning: true }, req);
  }

  async think(req: ThinkRequest): Promise<ThinkResponse> {
    return thinkViaComplete('kimi', this.model, this, req, { timeoutMs: 300_000 });
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
