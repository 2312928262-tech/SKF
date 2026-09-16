/**
 * Local Provider — OpenAI 兼容本地端点（供 vLLM/llama.cpp 等本地推理接入，M21）
 * =====================================================
 * endpoint: SKF_LOCAL_BASE_URL（默认 http://localhost:8000/v1，vLLM 默认 OpenAI 兼容端点）
 * 计费口径: 本地零成本 —— ModelGateway 标 local=true，不耗金额、不计每日云调用次数。
 *   （本地推理的"成本"是显存/电费/时间，不是按 token 计费；SKF 不虚构一个金额。）
 * 工具: vLLM 支持 OpenAI 兼容 function calling，capabilities.tools=true。
 * 密钥纪律: 本地端点通常无鉴权，占位 apiKey='local'（不是密钥，不入任何文件）。
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

const DEFAULT_MODEL = 'local-model';
const DEFAULT_BASE_URL = 'http://localhost:8000/v1';

export interface LocalProviderOptions {
  baseUrl?: string;
  model?: string;
}

export class LocalProvider implements Provider, ProviderAdapter {
  name: ProviderName = 'local';
  private client: OpenAI;
  private model: string;

  constructor(opts: LocalProviderOptions = {}) {
    this.model = opts.model || process.env.SKF_LOCAL_MODEL || DEFAULT_MODEL;
    const baseUrl = opts.baseUrl || process.env.SKF_LOCAL_BASE_URL || DEFAULT_BASE_URL;
    this.client = new OpenAI({
      apiKey: 'local', // 本地端点占位，不是密钥；不入文件
      baseURL: baseUrl,
      timeout: 300_000,
      maxRetries: 0,
    });
  }

  get modelName(): string { return this.model; }

  async capabilities(): Promise<ProviderCapabilities> {
    // vLLM OpenAI 兼容端点支持 function calling；contextWindowTokens 未确认 ⇒ null。
    return { tools: true, streaming: true, cancel: true, usage: true, contextWindowTokens: null };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return completeOpenAICompat(
      this.client as unknown as OpenAICompatLike,
      { provider: 'local', model: this.model, maxTokensParam: 'max_tokens' },
      req,
    );
  }

  async think(req: ThinkRequest): Promise<ThinkResponse> {
    return thinkViaComplete('local', this.model, this, req, { timeoutMs: 300_000 });
  }

  async isReady(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
