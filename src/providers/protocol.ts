/**
 * Provider 协议统一（M02 · 02-C 契约）
 *
 * - 所有模型调用统一为 ProviderAdapter.complete(CompletionRequest)。
 * - 旧 think 文本调用只是 complete 的兼容封装（thinkViaComplete），不是第二套协议。
 * - OpenAI 兼容端点共享映射代码，但每个 provider 的参数名/能力以各自官方文档为准配置，
 *   不假设行为一致（见各 provider 文件头的 DOC 注记与日期）。
 * - 业务层（supervisor/brain）不得再出现 any、不得私自读 providers Map。
 */

export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };
export type Effect = 'read' | 'workspace_write' | 'external_write' | 'process';

export interface ToolCall {
  id: string;
  name: string;
  arguments: JSONValue;
}

export interface ToolResultMessage {
  callId: string;
  operationId: string;
  ok: boolean;
  content: string;
  artifactIds: string[];
  error?: { code: string; retryable: boolean };
}

export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoningContent?: string }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** input 的子集，不得重复相加。 */
  cachedInputTokens: number | null;
  source: 'provider' | 'estimated' | 'unknown';
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JSONValue;
  effect: Effect;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CompletionRequest {
  callId: string;
  taskId: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  maxOutputTokens: number;
  signal: AbortSignal;
  deadlineAt: number;
}

export interface CompletionResult {
  responseId?: string;
  provider: string;
  model: string;
  assistant: Extract<ModelMessage, { role: 'assistant' }>;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'refusal' | 'unknown';
  usage: Usage;
}

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  cancel: boolean;
  usage: boolean;
  /** 未按官方文档/实测确认时为 null，不得编数。 */
  contextWindowTokens: number | null;
}

export interface ProviderAdapter {
  capabilities(): Promise<ProviderCapabilities>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

// ─────────────────────────────────────
// 错误码
// ─────────────────────────────────────

export class ProviderError extends Error {
  code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** 把 SDK/网络异常映射为稳定 code；不在 shell 层解析原始错误文本。 */
export function mapProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const anyErr = err as { name?: string; message?: string; status?: number; code?: string };
  const name = anyErr?.name ?? '';
  const message = anyErr?.message ?? String(err);
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;

  if (name === 'APIUserAbortError' || name === 'AbortError' || /aborted/i.test(message)) {
    return new ProviderError('PROVIDER_ABORTED');
  }
  if (name === 'APIConnectionTimeoutError' || /timed?\s*out/i.test(message)) {
    return new ProviderError('PROVIDER_TIMEOUT');
  }
  if (name === 'APIConnectionError') return new ProviderError('PROVIDER_UNREACHABLE');
  if (status === 401 || status === 403) return new ProviderError('PROVIDER_AUTH_FAILED');
  if (status === 429) return new ProviderError('PROVIDER_RATE_LIMITED');
  if (status !== undefined && status >= 500) return new ProviderError('PROVIDER_SERVER_ERROR', `HTTP ${status}`);
  if (status !== undefined && status >= 400) return new ProviderError('PROVIDER_BAD_REQUEST', `HTTP ${status}`);
  return new ProviderError('MODEL_REQUEST_FAILED', message.slice(0, 200));
}

// ─────────────────────────────────────
// 工具调用解析（真实 provider 与 fake 共用同一套校验）
// ─────────────────────────────────────

export interface RawToolCall {
  id?: string;
  name: string;
  /** 已解析的 JSON 或原始字符串（非 JSON 时保留原文，交给下游 schema 校验拒绝）。 */
  arguments: JSONValue;
}

/**
 * 规范化工具调用：
 * - provider 没给 id：用 responseId+序号生成稳定 id，重试不换号；
 * - 重复 id：TOOL_CALL_ID_DUPLICATE（不让悬空/错位调用进入历史）；
 * - arguments 是字符串：能解析则解析，不能解析保留原文（JSONValue 允许 string）。
 */
export function normalizeToolCalls(raw: RawToolCall[], responseSeed: string): ToolCall[] {
  const seen = new Set<string>();
  return raw.map((call, index) => {
    const id = call.id?.trim() || `${responseSeed}:call:${index}`;
    if (seen.has(id)) throw new ProviderError('TOOL_CALL_ID_DUPLICATE', id);
    seen.add(id);
    let args = call.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // 保留原始字符串；工具层 schema 校验会以结构化错误拒绝，而不是在这里崩。
        args = call.arguments;
      }
    }
    return { id, name: call.name, arguments: args ?? {} };
  });
}

// ─────────────────────────────────────
// OpenAI 兼容端点映射（参数名/能力由各 provider 自行配置）
// ─────────────────────────────────────

export interface OpenAICompatLike {
  chat: {
    completions: {
      create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
    };
  };
}

export interface OpenAICompatConfig {
  provider: string;
  model: string;
  /** kimi/deepseek/openrouter 用 max_tokens；astra(OpenAI 新模型) 用 max_completion_tokens。 */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /** 推理模型（deepseek-v4-pro/kimi-k3 等 thinking 模式）：assistant 消息需原样回写
   *  reasoning_content，否则多轮工具对话 400（"reasoning_content ... must be passed back"）。 */
  reasoning?: boolean;
  extraParams?: Record<string, unknown>;
}

export function toOpenAIMessages(
  messages: ModelMessage[],
  opts: { reasoning?: boolean } = {},
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content };
      // 仅推理类 provider 回写；非推理 provider 不回写无关字段（避免协议拒绝）。
      if (opts.reasoning && m.reasoningContent) {
        msg.reasoning_content = m.reasoningContent;
      }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      return msg;
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAITools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

const FINISH_REASONS: Record<string, CompletionResult['finishReason']> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  length: 'length',
  content_filter: 'refusal',
  refusal: 'refusal',
};

/** usage 映射：缺失记 null 不补 0；cached 是 input 子集，超出则截断，绝不重复相加。 */
export function mapUsage(raw: unknown): Usage {
  const u = raw as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null | undefined;
  if (!u) return { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' };
  const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null;
  const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : null;
  let cached =
    typeof u.prompt_cache_hit_tokens === 'number'
      ? u.prompt_cache_hit_tokens
      : typeof u.prompt_tokens_details?.cached_tokens === 'number'
        ? (u.prompt_tokens_details.cached_tokens as number)
        : null;
  if (cached !== null && input !== null) cached = Math.max(0, Math.min(cached, input));
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, source: 'provider' };
}

/** 把 OpenAI 兼容响应映射为 CompletionResult；空 choices 报 EMPTY_RESPONSE。 */
export function mapCompletionResponse(response: unknown, cfg: OpenAICompatConfig): CompletionResult {
  const r = response as {
    id?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
      };
    }>;
    usage?: unknown;
  };
  const choice = r?.choices?.[0];
  if (!choice || !choice.message) throw new ProviderError('EMPTY_RESPONSE');
  const seed = r.id || `${cfg.provider}:${cfg.model}`;
  const rawCalls = (choice.message.tool_calls ?? [])
    .filter((tc) => tc.function?.name)
    .map((tc) => ({
      id: tc.id,
      name: tc.function!.name as string,
      arguments: typeof tc.function!.arguments === 'string' ? tc.function!.arguments : '{}',
    }));
  const toolCalls = rawCalls.length ? normalizeToolCalls(rawCalls, seed) : undefined;
  const reasoningContent = choice.message.reasoning_content ?? undefined;
  const finishReason = FINISH_REASONS[choice.finish_reason ?? ''] ?? (toolCalls?.length ? 'tool_calls' : 'unknown');
  return {
    responseId: r.id,
    provider: cfg.provider,
    model: cfg.model,
    assistant: {
      role: 'assistant',
      content: choice.message.content ?? '',
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    },
    finishReason,
    usage: mapUsage(r.usage),
  };
}

/**
 * 统一的 complete 实现：deadline 先验、AbortSignal/timeout 直达底层、错误码映射。
 * SDK 自动重试在 client 构造时关闭（maxRetries: 0），重试策略只能由未来的 ModelGateway 显式开启。
 */
export async function completeOpenAICompat(
  client: OpenAICompatLike,
  cfg: OpenAICompatConfig,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const remaining = req.deadlineAt - Date.now();
  if (remaining <= 0) throw new ProviderError('PROVIDER_DEADLINE_EXCEEDED');
  const params: Record<string, unknown> = {
    model: cfg.model,
    messages: toOpenAIMessages(req.messages, { reasoning: cfg.reasoning }),
    [cfg.maxTokensParam]: req.maxOutputTokens,
    ...(cfg.extraParams ?? {}),
  };
  if (req.tools.length) {
    params.tools = toOpenAITools(req.tools);
    params.tool_choice = 'auto';
  }
  try {
    const response = await client.chat.completions.create(params, {
      signal: req.signal,
      timeout: remaining,
    });
    return mapCompletionResponse(response, cfg);
  } catch (err) {
    throw mapProviderError(err);
  }
}
