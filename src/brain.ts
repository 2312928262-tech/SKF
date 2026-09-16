/**
 * 大脑路由（M02 统一协议版）
 *
 * - 所有 provider 同时实现旧 think 兼容接口与 ProviderAdapter.complete；
 *   业务层只能用本类暴露的方法，不再私自访问 providers Map，也没有 any。
 * - AstraProvider 用异步 create()（dynamic import proxy agent），保持懒初始化：
 *   首次 think/complete 时才 await init。
 */

import { MockProvider } from './providers/mock.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { AstraProvider } from './providers/astra.js';
import { DeepseekProvider } from './providers/deepseek.js';
import { KimiProvider } from './providers/kimi.js';
import { FakeScriptedProvider } from './providers/fake-scripted.js';
import { LocalProvider } from './providers/local.js';
import type { Provider, ThinkRequest, ThinkResponse, ProviderName } from './providers/types.js';
import type { CompletionRequest, CompletionResult, ProviderAdapter, ProviderCapabilities } from './providers/protocol.js';
import type { ModelGateway } from './runtime/model-gateway.js';

type RegisteredProvider = Provider & ProviderAdapter & { modelName?: string };

export interface BrainOpts {
  provider: ProviderName;
  systemPrompt: string;
  debug?: boolean;
}

export class Brain {
  private current: RegisteredProvider;
  private providers: Map<ProviderName, RegisteredProvider>;
  private systemPrompt: string;
  private debug: boolean;
  private astraInitPromise: Promise<AstraProvider> | null = null;
  private capsCache = new Map<ProviderName, ProviderCapabilities>();
  /** M06：设置后所有调用经 ModelGateway（唯一生产出口）。 */
  private gateway: ModelGateway | null = null;
  /** true 时云 provider 没有 gateway 一律 BUDGET_UNAVAILABLE（fail-closed，不绕过预算）。 */
  requireGateway = false;

  constructor(opts: BrainOpts) {
    this.systemPrompt = opts.systemPrompt;
    this.debug = !!opts.debug;
    this.providers = new Map();

    this.providers.set('mock', new MockProvider());
    const orKey = process.env.OPENROUTER_API_KEY;
    if (orKey && orKey !== 'your-key-here') {
      this.providers.set('openrouter', new OpenRouterProvider({ apiKey: orKey }));
    }

    // Astra：占位 provider，首次调用时异步初始化
    const astraKey = process.env.OPENAI_API_KEY;
    if (astraKey && astraKey.startsWith('sk-')) {
      this.providers.set('astra', this.makeAstraPlaceholder(astraKey));
    }

    // Kimi K3：国内主模型（moonshot API，直连不挂代理）
    const kimiKey = process.env.KIMI_API_KEY;
    if (kimiKey && kimiKey.length > 20) {
      this.providers.set('kimi', new KimiProvider({ apiKey: kimiKey }));
    }
    const dsKey = process.env.DEEPSEEK_API_KEY;
    if (dsKey && dsKey.length > 20) {
      this.providers.set('deepseek', new DeepseekProvider({ apiKey: dsKey }));
    }

    // fake：只在 test/dev 明确模式注册（生产 fail-closed）
    if (process.env.NODE_ENV === 'test' || process.env.SKF_FAKE_PROVIDER === '1') {
      this.providers.set('fake', new FakeScriptedProvider({ fixturePath: process.env.SKF_FAKE_FIXTURE }));
    }

    // local：OpenAI 兼容本地端点（vLLM 等）；SKF_LOCAL=1 时注册。
    if (process.env.SKF_LOCAL === '1' || process.env.SKF_LOCAL_BASE_URL) {
      this.providers.set('local', new LocalProvider());
    }

    const p = this.providers.get(opts.provider);
    if (!p) {
      // 让 UI 活着以便切换 provider，但绝不把 mock 冒充真模型。
      this.current = {
        name: opts.provider,
        async think() { throw new Error('PROVIDER_NOT_CONFIGURED'); },
        async isReady() { return false; },
        async capabilities(): Promise<ProviderCapabilities> {
          return { tools: false, streaming: false, cancel: false, usage: false, contextWindowTokens: null };
        },
        async complete() { throw new Error('PROVIDER_NOT_CONFIGURED'); },
      };
    } else {
      this.current = p;
    }

    if (this.debug) {
      console.log(`[brain] 当前大脑: ${this.current.name}`);
      console.log(`[brain] 可用大脑: ${Array.from(this.providers.keys()).join(', ')}`);
    }
  }

  /** M27 registered configuration adapters: no management operations enter the tool registry. */
  registerManaged(provider: RegisteredProvider) { this.providers.set(provider.name, provider); }

  /** 占位 provider：首次调用时才 init real astra */
  private makeAstraPlaceholder(secret: string): RegisteredProvider {
    const self = this;
    return {
      name: 'astra',
      modelName: 'gpt-6-astra', // ModelGateway 预留快照用；init 后由真实 provider 接管
      async think(req: ThinkRequest): Promise<ThinkResponse> {
        const real = await self.ensureAstra(secret);
        return real.think(req);
      },
      async isReady(): Promise<boolean> {
        const real = await self.ensureAstra(secret);
        return real.isReady();
      },
      async capabilities(): Promise<ProviderCapabilities> {
        const real = await self.ensureAstra(secret);
        return real.capabilities();
      },
      async complete(req: CompletionRequest): Promise<CompletionResult> {
        const real = await self.ensureAstra(secret);
        return real.complete(req);
      },
    };
  }

  private async ensureAstra(secret: string): Promise<AstraProvider> {
    if (this.astraInitPromise) return this.astraInitPromise;

    this.astraInitPromise = (async (): Promise<AstraProvider> => {
      try {
        const real = await AstraProvider.create({ apiKey: secret });
        this.providers.set('astra', real);
        if (this.debug) console.log('[brain] astra provider initialized');
        return real;
      } catch (err) {
        console.error('[brain] astra init failed:', err);
        this.astraInitPromise = null; // 允许重试
        throw err;
      }
    })();

    return this.astraInitPromise;
  }

  setProvider(name: ProviderName) {
    const p = this.providers.get(name);
    if (!p) throw new Error(`provider ${name} 未初始化`);
    this.current = p;
  }

  get providerName(): ProviderName { return this.current.name; }
  get configured(): boolean { return this.current.name !== 'mock' && this.providers.has(this.current.name); }

  /** 已注册的 provider 名（只读枚举，不暴露 Map 本体）。 */
  listProviders(): ProviderName[] {
    return Array.from(this.providers.keys());
  }

  /** 指定大脑的协议能力；未注册返回 null。结果进缓存供同步快照使用。 */
  async capabilitiesFor(name: ProviderName): Promise<ProviderCapabilities | null> {
    const p = this.providers.get(name);
    if (!p) return null;
    const caps = await p.capabilities();
    this.capsCache.set(name, caps);
    return caps;
  }

  /** M12(P02)：ping/任务创建闸门的同步能力快照；由 capabilitiesFor 预热/刷新，未预热返回 null。 */
  cachedCapabilities(name: ProviderName): ProviderCapabilities | null {
    return this.capsCache.get(name) ?? null;
  }

  /** 当前大脑的协议能力。 */
  capabilities(): Promise<ProviderCapabilities> {
    return this.current.capabilities();
  }

  /** M06：接入 ModelGateway；之后 think/thinkWith/complete 全部走预算与路由。 */
  setGateway(gateway: ModelGateway): void {
    this.gateway = gateway;
  }

  /** 指定 provider 的协议适配器（gateway 注册用，不暴露 Map 本体）。 */
  adapterFor(name: ProviderName): ProviderAdapter | null {
    return this.providers.get(name) ?? null;
  }

  /** 指定 provider 的当前模型名（gateway 预留快照用）。 */
  modelFor(name: ProviderName): string | null {
    const p = this.providers.get(name) as unknown as { modelName?: string } | undefined;
    if (!p) return null;
    if (typeof p.modelName === 'string') return p.modelName;
    const fallback: Record<string, string> = { mock: 'mock-0.2', fake: 'fake-scripted' };
    return fallback[name] ?? null;
  }

  private assertBudgetEgress(name: ProviderName): void {
    if (this.gateway || !this.requireGateway) return;
    if (name === 'mock' || name === 'fake') return; // 本地/测试 provider 不耗金额
    throw new Error('BUDGET_UNAVAILABLE');
  }

  /** 统一协议入口。生产路径必须经 ModelGateway（agent-loop 自带 gateway 时不走这里）。 */
  complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.gateway) {
      return this.gateway
        .complete({
          callId: req.callId,
          taskId: req.taskId,
          purpose: 'chat',
          route: { provider: this.current.name },
          messages: req.messages,
          tools: req.tools,
          maxOutputTokens: req.maxOutputTokens,
          signal: req.signal,
          deadlineAt: req.deadlineAt,
        })
        .then((r) => r.completion);
    }
    this.assertBudgetEgress(this.current.name);
    return this.current.complete(req);
  }

  /** 指定大脑调用（/astra 等顾问通道），不经过 providers Map 私读。
   *  用户显式输入 /astra 即为昂贵升级授权；预算与价目仍由 gateway 强制。 */
  async thinkWith(name: ProviderName, req: ThinkRequest): Promise<ThinkResponse> {
    const p = this.providers.get(name);
    if (!p) throw new Error('PROVIDER_UNAVAILABLE');
    if (this.gateway) {
      const r = await this.gateway.completeText({
        taskId: `sys:${name}`,
        purpose: 'review',
        route: { provider: name, allowExpensive: true },
        system: req.context,
        user: req.userMessage,
        turn: req.turn,
      });
      return gatewayTextToThink(r, name);
    }
    this.assertBudgetEgress(name);
    return p.think(req);
  }

  async think(userMessage: string, opts: { context?: string; turn: number }): Promise<ThinkResponse> {
    const context = [this.systemPrompt, opts.context].filter(Boolean).join('\n\n---\n\n');
    if (this.gateway) {
      const r = await this.gateway.completeText({
        taskId: 'sys:chat',
        purpose: 'chat',
        route: { provider: this.current.name },
        system: context || undefined,
        user: userMessage,
        turn: opts.turn,
      });
      return gatewayTextToThink(r, this.current.name);
    }
    this.assertBudgetEgress(this.current.name);
    const req: ThinkRequest = { userMessage, context, turn: opts.turn };
    return this.current.think(req);
  }
}

/** gateway 文本结果 → 旧 ThinkResponse（金额是配置估算，缺失保持未知不是 0）。 */
function gatewayTextToThink(
  r: {
    text: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null };
    cost: { settledMicros: number | null; amountKnown: boolean };
    model: string;
    finishReason: ThinkResponse['finishReason'];
  },
  provider: ProviderName,
): ThinkResponse {
  const cost = r.cost.amountKnown && r.cost.settledMicros !== null ? r.cost.settledMicros / 1_000_000 : undefined;
  return {
    text: r.text,
    ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}),
    usage: {
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cachedInputTokens: r.usage.cachedInputTokens,
      ...(cost === undefined ? {} : { cost, costSource: 'configured-estimate' as const }),
    },
    provider,
    model: r.model,
    finishReason: r.finishReason,
  };
}
