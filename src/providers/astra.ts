/**
 * GPT-6 Astra Provider（OpenAI，经代理）
 * DOC(2026-09-08): OpenAI chat completions；新模型参数名 max_completion_tokens；
 *   缓存 token 在 usage.prompt_tokens_details.cached_tokens（prompt_tokens 子集）。
 *   contextWindowTokens 未确认 ⇒ null。
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
import { estimateAstraCost } from '../runtime/usage.js';

const DEFAULT_MODEL = 'gpt-6-astra';

export interface AstraProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

async function loadProxyAgent(): Promise<{ new (url: string): unknown } | null> {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxyUrl) return null;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const mod = req('https-proxy-agent');
    return mod.HttpsProxyAgent || mod.default?.HttpsProxyAgent;
  } catch (e) {
    console.error('[astra] proxy load failed:', e);
    return null;
  }
}

export class AstraProvider implements Provider, ProviderAdapter {
  name: ProviderName = 'astra';
  private client: OpenAI;
  private model: string;
  private secret: string;

  private constructor(client: OpenAI, secret: string, model: string) {
    this.client = client;
    this.secret = secret;
    this.model = model;
  }

  static async create(opts: AstraProviderOptions): Promise<AstraProvider> {
    const model = opts.model || DEFAULT_MODEL;
    const config: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || 'https://api.openai.com/v1',
      defaultHeaders: { 'X-Title': 'SKF-Astra' },
      timeout: 180_000,
      maxRetries: 0,
    };

    const ProxyAgent = await loadProxyAgent();
    if (ProxyAgent) {
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
      (config as { httpAgent?: unknown }).httpAgent = new ProxyAgent(proxyUrl);
    }

    return new AstraProvider(new OpenAI(config), opts.apiKey, model);
  }

  get modelName(): string { return this.model; }

  setModel(model: string) {
    this.model = model || DEFAULT_MODEL;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { tools: true, streaming: true, cancel: true, usage: true, contextWindowTokens: null };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return completeOpenAICompat(
      this.client as unknown as OpenAICompatLike,
      { provider: 'astra', model: this.model, maxTokensParam: 'max_completion_tokens' },
      req,
    );
  }

  async think(req: ThinkRequest): Promise<ThinkResponse> {
    return thinkViaComplete('astra', this.model, this, req, {
      timeoutMs: 180_000,
      estimateCost: (input, output, cached) =>
        input === null || output === null ? undefined : estimateAstraCost(input, output, cached ?? 0),
    });
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
