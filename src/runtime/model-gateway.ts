/**
 * M06 · ModelGateway —— SKF 所有模型调用的唯一生产出口（02-CONTRACTS.md G/H 节）。
 *
 * 纪律：
 * - 业务层（supervisor/brain/agent-loop/extractor）不许直接调 provider/SDK；
 *   唯一出口是本类的 complete()/completeText()。测试 adapter（fake/mock/stub）不计生产。
 * - 三模式：strict-money（无价目拒绝云调用）/ call-limit（只保证次数与输出上限，
 *   金额可能未知且明示）/ local-only（只许本地 provider）。没有用户金额配置时
 *   不自设任何虚构月预算。
 * - 预留 → 发请求 → 结算：金额事务由 BudgetLedger 保证；超预算在发网络前拒绝。
 * - 路由：常规选任务/配置指定的低成本已验证 provider；昂贵 provider 必须
 *   任务策略显式授权（allowExpensive）且在预算内；调用失败绝不静默换更贵的 provider。
 * - 重试默认关闭（maxRetries=0，SDK 层已是 0）；只有本类统一策略可显式开启，
 *   且只对可重试错误码、同一 provider、同一 callId 预留重试。
 * - 上下文：最终 messages+tools+system 的真实序列化参与计量；超限先裁调用方标注的
 *   可选证据，硬约束仍超限则拒绝；工具 call/result 成组保留，绝不剪一半。
 */

import { RuntimeError, stableStringify, type JSONValue, type ModelCallPurpose } from './contracts.js';
import { BudgetLedger, type BudgetLimits, type ReserveOutcome } from './budget-ledger.js';
import { resolveTariff, type TariffSnapshot } from './usage.js';
import type { BudgetMode } from './config.js';
import type { RuntimeStore } from './runtime-store.js';
import type { TaskService } from './task-service.js';
import type {
  CompletionRequest,
  CompletionResult,
  ModelMessage,
  ProviderAdapter,
  ToolSchema,
  Usage,
} from '../providers/protocol.js';

// ── token 估算（保守启发式；无 tokenizer 时明确计量来源并留余量）──────

export const TOKEN_MEASURE_SOURCE = 'heuristic-chars-v1:cjk=1,latin/3.5,x1.25,+4/msg';

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  );
}

/** 单段文本的保守 token 估算：CJK 一字符一 token，其余按 3.5 字符/token。 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) other++;
    else if (isCjk(cp)) cjk++;
    else other += 2; // 非 ASCII 非 CJK（emoji/符号）往往更碎，保守按 2 字符/token 的倒数计
  }
  return Math.ceil(cjk + other / 3.5);
}

export interface RequestMeasurement {
  inputTokensEstimate: number;
  serializedBytes: number;
  source: string;
}

/**
 * 最终 messages+tools 的真实序列化计量：字节数来自稳定序列化本体，
 * token 用保守启发式 ×1.25 余量 + 每条消息 4 token 协议开销。
 * 这不是精确 tokenizer；没有已确认上限时不得宣称硬保证（02-H）。
 */
export function measureRequest(messages: ModelMessage[], tools: ToolSchema[]): RequestMeasurement {
  const serialized = stableStringify({ messages, tools } as unknown as JSONValue);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  let tokens = 0;
  for (const m of messages) {
    tokens += 4 + estimateTextTokens(m.content);
    if (m.role === 'assistant' && m.toolCalls) tokens += 4 + estimateTextTokens(stableStringify(m.toolCalls as unknown as JSONValue));
    if (m.role === 'assistant' && m.reasoningContent) tokens += 4 + estimateTextTokens(m.reasoningContent);
  }
  for (const t of tools) {
    tokens += 8 + estimateTextTokens(t.name + t.description + stableStringify(t.inputSchema));
  }
  return { inputTokensEstimate: Math.ceil(tokens * 1.25), serializedBytes: bytes, source: TOKEN_MEASURE_SOURCE };
}

// ── 上下文裁剪：可选证据先裁，工具组原子 ─────────────────

export interface FitResult {
  messages: ModelMessage[];
  trimmedIndices: number[];
}

/**
 * 把 messages 分成原子组：带 toolCalls 的 assistant 与其全部同 ID tool 结果是一组，
 * 其余消息各自成组。组序保持原顺序。协议残缺（有 call 没 result / 悬空 result）
 * 直接 CONTEXT_PROTOCOL_INVALID，不许带病发送。
 */
function buildGroups(messages: ModelMessage[]): number[][] {
  const groups: number[][] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'tool') {
      throw new RuntimeError('CONTEXT_PROTOCOL_INVALID', `tool result at ${i} has no preceding assistant call`);
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const ids = new Set(m.toolCalls.map((tc) => tc.id));
      const group = [i];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        const tm = messages[j] as Extract<ModelMessage, { role: 'tool' }>;
        if (!ids.has(tm.toolCallId)) {
          throw new RuntimeError('CONTEXT_PROTOCOL_INVALID', `tool result ${tm.toolCallId} not in preceding assistant call`);
        }
        ids.delete(tm.toolCallId);
        group.push(j);
        j++;
      }
      if (ids.size > 0) {
        throw new RuntimeError('CONTEXT_PROTOCOL_INVALID', `assistant call missing tool results: ${[...ids].join(',')}`);
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([i]);
      i++;
    }
  }
  return groups;
}

/**
 * 裁剪到 maxInputTokens 以内：只动 optionalIndices 标注的可选证据（最旧优先），
 * 工具组要么整组裁要么整组留；裁完仍超限 = 硬约束超限，CONTEXT_BUDGET_EXCEEDED 拒绝，
 * 不偷偷截用户最新问题或系统提示（02-H）。
 */
export function fitMessages(
  messages: ModelMessage[],
  tools: ToolSchema[],
  maxInputTokens: number,
  optionalIndices: ReadonlySet<number> = new Set(),
): FitResult {
  requireMaxTokens(maxInputTokens);
  const groups = buildGroups(messages);
  const fits = (keep: boolean[]) => {
    const kept: ModelMessage[] = [];
    groups.forEach((group, gi) => {
      if (keep[gi]) for (const idx of group) kept.push(messages[idx]);
    });
    return { kept, tokens: measureRequest(kept, tools).inputTokensEstimate };
  };

  const keep = groups.map(() => true);
  let current = fits(keep);
  const trimmed: number[] = [];
  if (current.tokens > maxInputTokens) {
    for (let gi = 0; gi < groups.length && current.tokens > maxInputTokens; gi++) {
      const group = groups[gi];
      // 整组都在可选集内才裁；含硬约束的组一个都不动。
      if (!group.every((idx) => optionalIndices.has(idx))) continue;
      keep[gi] = false;
      current = fits(keep);
      trimmed.push(...group);
    }
  }
  if (current.tokens > maxInputTokens) {
    throw new RuntimeError(
      'CONTEXT_BUDGET_EXCEEDED',
      `${current.tokens} > ${maxInputTokens} tokens after trimming optional evidence (${TOKEN_MEASURE_SOURCE})`,
    );
  }
  return { messages: current.kept, trimmedIndices: trimmed };
}

function requireMaxTokens(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeError('INVALID_INPUT', 'maxInputTokens must be a positive safe integer');
  }
}

// ── Gateway ─────────────────────────────────────────────

export interface GatewayProviderEntry {
  name: string;
  adapter: ProviderAdapter;
  model: string;
  /** 本地/测试 provider（mock/fake/本地 endpoint）：不耗金额、不计每日云调用次数。 */
  local: boolean;
  /** 已实测可用；常规路由只允许 verified provider（防把没验证过的端点当默认）。 */
  verified: boolean;
}

export interface GatewayConfig {
  mode: BudgetMode;
  /** 常规路由默认 provider；必须是已注册的非昂贵 verified provider。 */
  defaultProvider?: string;
  expensiveProviders: ReadonlySet<string>;
  /** 统一重试策略：默认 0 关闭；只有这里能显式开启。 */
  maxRetries: number;
  dailyCallLimit?: number;
  dailyBudgetMicros?: number;
  taskBudgetMicros?: number;
  /** 已按官方文档确认的输入上限（token）；未确认 = 不宣称硬上限（02-H）。 */
  contextLimits?: Record<string, number>;
  limits?: BudgetLimits;
}

export interface GatewayRoutePolicy {
  provider?: string;
  model?: string;
  /** 昂贵升级授权：必须来自当前任务策略（用户显式选择/任务输入 policy），不能默认 true。 */
  allowExpensive?: boolean;
}

export interface GatewayCompletionRequest {
  callId: string;
  taskId: string;
  purpose: ModelCallPurpose;
  route?: GatewayRoutePolicy;
  messages: ModelMessage[];
  tools: ToolSchema[];
  /** 可裁的可选证据（消息下标）；硬约束（系统/用户目标/工具协议组）不得包含在内。 */
  optionalIndices?: readonly number[];
  maxOutputTokens: number;
  signal: AbortSignal;
  deadlineAt: number;
  /** 覆盖全局上限（如任务输入自带的预算策略）。 */
  limits?: BudgetLimits;
  now?: number;
}

export interface GatewayCost {
  reservedMicros: number | null;
  settledMicros: number | null;
  currency: string | null;
  tariffVersion: string | null;
  /** false = 金额未知（无价目/usage 不可信），UI 必须显示「未知」而不是 0。 */
  amountKnown: boolean;
  /** 永远是配置价目估算；供应商账单一列以原始 usage 为准，两者不混。 */
  source: 'configured-estimate';
  usage: Usage;
}

export interface GatewayCompletionResult {
  completion: CompletionResult;
  cost: GatewayCost;
  measurement: RequestMeasurement & { trimmedIndices: number[] };
  provider: string;
  model: string;
}

const RETRYABLE_CODES = new Set(['PROVIDER_RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_SERVER_ERROR', 'PROVIDER_UNREACHABLE']);

export class ModelGateway {
  readonly ledger: BudgetLedger;
  private providers = new Map<string, GatewayProviderEntry>();
  private ensuredTasks = new Set<string>();

  constructor(
    private deps: {
      store: RuntimeStore;
      service: TaskService;
      config: GatewayConfig;
      logger?: (line: string) => void;
    },
  ) {
    if (!Number.isSafeInteger(deps.config.maxRetries) || deps.config.maxRetries < 0 || deps.config.maxRetries > 3) {
      throw new RuntimeError('INVALID_INPUT', 'maxRetries must be 0..3');
    }
    this.ledger = new BudgetLedger(deps.store);
  }

  registerProvider(entry: GatewayProviderEntry): void {
    this.providers.set(entry.name, entry);
    if (entry.local) this.ledger.addLocalProvider(entry.name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** 系统通道任务（chat/astra/extraction 等非 AgentLoop 调用）挂账用；幂等。 */
  private ensureSystemTask(taskId: string): void {
    if (this.ensuredTasks.has(taskId)) return;
    this.deps.service.createTask({
      id: taskId,
      input: { kind: 'system_channel' } as JSONValue,
      sessionId: 'system',
      scope: 'system',
      workspaceRoot: '-',
      provider: 'system',
      model: 'system',
    });
    this.ensuredTasks.add(taskId);
  }

  // ── 路由 ─────────────────────────────────────────────

  private route(policy: GatewayRoutePolicy | undefined): { entry: GatewayProviderEntry; model: string } {
    const name = policy?.provider ?? this.deps.config.defaultProvider;
    if (!name) throw new RuntimeError('ROUTE_NOT_CONFIGURED', 'no provider requested and no defaultProvider');
    const entry = this.providers.get(name);
    if (!entry) throw new RuntimeError('PROVIDER_UNAVAILABLE', name);
    const mode = this.deps.config.mode;
    if (mode === 'local-only' && !entry.local) {
      throw new RuntimeError('LOCAL_ONLY_MODE', `${name} is a cloud provider`);
    }
    if (this.deps.config.expensiveProviders.has(name) && !policy?.allowExpensive) {
      // 昂贵升级必须被当前任务策略授权；常规路由绝不自动选它。
      throw new RuntimeError('EXPENSIVE_UPGRADE_NOT_AUTHORIZED', name);
    }
    if (!entry.local && !entry.verified) {
      throw new RuntimeError('PROVIDER_NOT_VERIFIED', name);
    }
    return { entry, model: policy?.model ?? entry.model };
  }

  // ── 主入口 ───────────────────────────────────────────

  async complete(req: GatewayCompletionRequest): Promise<GatewayCompletionResult> {
    const { entry, model } = this.route(req.route);
    const mode = this.deps.config.mode;
    const tariff: TariffSnapshot | null = entry.local ? null : resolveTariff(entry.name);
    if (!entry.local && mode === 'strict-money' && !tariff) {
      // strict-money：无价目拒绝云调用并提示配置（不猜价格）。
      throw new RuntimeError('TARIFF_NOT_CONFIGURED', `${entry.name}: set SKF_${entry.name.toUpperCase()}_INPUT/OUTPUT_USD_PER_M`);
    }

    // 上下文：已确认上限才做 token 硬约束；否则只计量（不宣称硬保证，02-H）。
    let messages = req.messages;
    let trimmedIndices: number[] = [];
    const ctxLimit = this.deps.config.contextLimits?.[entry.name] ?? this.deps.config.contextLimits?.['*'];
    if (ctxLimit !== undefined) {
      const maxInput = ctxLimit - req.maxOutputTokens;
      if (maxInput < 1) {
        throw new RuntimeError('CONTEXT_BUDGET_EXCEEDED', `context limit ${ctxLimit} leaves no room for ${req.maxOutputTokens} output tokens`);
      }
      const fit = fitMessages(messages, req.tools, maxInput, new Set(req.optionalIndices ?? []));
      messages = fit.messages;
      trimmedIndices = fit.trimmedIndices;
    }

    const measurement = measureRequest(messages, req.tools);
    const limits: BudgetLimits = {
      taskMicros: req.limits?.taskMicros ?? this.deps.config.taskBudgetMicros,
      dailyMicros: req.limits?.dailyMicros ?? this.deps.config.dailyBudgetMicros,
      dailyCalls: req.limits?.dailyCalls ?? this.deps.config.dailyCallLimit,
    };

    // 事务预留最坏上限；任何超限都在这里、发网络之前拒绝。
    let reservation: ReserveOutcome;
    try {
      reservation = this.ledger.reserve({
        callId: req.callId,
        taskId: req.taskId,
        purpose: req.purpose,
        provider: entry.name,
        model,
        local: entry.local,
        worstCase: { inputTokens: measurement.inputTokensEstimate, outputTokens: req.maxOutputTokens },
        tariff,
        limits,
        now: req.now,
      });
    } catch (error) {
      this.deps.logger?.(`[gateway] precheck rejected ${req.callId}: ${(error as Error).message} (no request sent)`);
      throw error;
    }

    const completionReq: CompletionRequest = {
      callId: req.callId,
      taskId: req.taskId,
      messages,
      tools: req.tools,
      maxOutputTokens: req.maxOutputTokens,
      signal: req.signal,
      deadlineAt: req.deadlineAt,
    };

    // 预中止：请求还没发出，释放预留（有证据未发出）。
    if (req.signal.aborted) {
      this.ledger.release(req.callId);
      this.deps.logger?.(`[gateway] ${req.callId} aborted before send; reservation released`);
      throw new RuntimeError('PROVIDER_ABORTED', 'aborted before request was sent');
    }

    const maxAttempts = 1 + this.deps.config.maxRetries;
    let completion: CompletionResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        completion = await entry.adapter.complete(completionReq);
        break;
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string })?.code ?? 'MODEL_REQUEST_FAILED';
        // PROVIDER_DEADLINE_EXCEEDED 在 provider 层是发请求前抛出的（02-M02 语义）；
        // 只有它能算「未发出」的证据，其余一律按可能已发出处理。
        if (code === 'PROVIDER_DEADLINE_EXCEEDED') {
          this.ledger.release(req.callId);
          this.deps.logger?.(`[gateway] ${req.callId} deadline before send; reservation released`);
          throw error;
        }
        const retryable = RETRYABLE_CODES.has(code);
        if (retryable && attempt < maxAttempts && !req.signal.aborted) {
          this.deps.logger?.(`[gateway] ${req.callId} attempt ${attempt} failed ${code}; explicit retry policy allows ${maxRetriesLeft(maxAttempts, attempt)} more (same provider, same reservation)`);
          continue;
        }
        // 超时/取消/网络错误：请求可能已发出并计费，记 uncertain，不自动重发、不退款。
        this.ledger.markUncertain(req.callId);
        this.deps.logger?.(`[gateway] ${req.callId} failed after send (${code}); marked uncertain, reservation retained`);
        throw error;
      }
    }
    if (!completion) {
      this.ledger.markUncertain(req.callId);
      throw lastError instanceof Error ? lastError : new RuntimeError('MODEL_REQUEST_FAILED');
    }

    const settled = this.ledger.settle(req.callId, completion.usage, { strict: mode === 'strict-money' && !entry.local });
    const amountKnown = settled.state === 'settled' && settled.costMicros !== null;
    return {
      completion,
      cost: {
        reservedMicros: reservation.reservedMicros,
        settledMicros: settled.costMicros,
        currency: reservation.currency,
        tariffVersion: reservation.tariffVersion,
        amountKnown,
        source: 'configured-estimate',
        usage: completion.usage,
      },
      measurement: { ...measurement, trimmedIndices },
      provider: entry.name,
      model,
    };
  }

  // ── 文本便捷入口（legacy think / astra / extractor 通道）────────────

  async completeText(req: {
    taskId: string;
    purpose: ModelCallPurpose;
    route?: GatewayRoutePolicy;
    system?: string;
    user: string;
    turn: number;
    /** 同一 taskId+turn 需要多次调用时（如多轮抽取）的去重随机数。 */
    nonce?: string;
    maxOutputTokens?: number;
    timeoutMs?: number;
    limits?: BudgetLimits;
  }): Promise<{
    text: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    usage: Usage;
    cost: GatewayCost;
    provider: string;
    model: string;
    finishReason: CompletionResult['finishReason'];
  }> {
    this.ensureSystemTask(req.taskId);
    const messages: ModelMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });
    const result = await this.complete({
      callId: `gw:${req.taskId}:${req.turn}${req.nonce ? `:${req.nonce}` : ''}`,
      taskId: req.taskId,
      purpose: req.purpose,
      route: req.route,
      messages,
      tools: [],
      maxOutputTokens: req.maxOutputTokens ?? 4096,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + (req.timeoutMs ?? 180_000),
      limits: req.limits,
    });
    return {
      text: result.completion.assistant.content,
      ...(result.completion.assistant.toolCalls?.length
        ? {
            toolCalls: result.completion.assistant.toolCalls.map((tc) => ({
              name: tc.name,
              args: (tc.arguments ?? {}) as Record<string, unknown>,
            })),
          }
        : {}),
      usage: result.completion.usage,
      cost: result.cost,
      provider: result.provider,
      model: result.model,
      finishReason: result.completion.finishReason,
    };
  }

  /** 当前花费状态（UI）：task/daily 的 spent/reserved/uncertain，估算是配置价目口径。 */
  status(opts: { taskId?: string; now?: number } = {}) {
    return this.ledger.status(opts);
  }
}

function maxRetriesLeft(maxAttempts: number, attempt: number): number {
  return maxAttempts - attempt;
}
