import { appendEvent } from './events.js';
import { RuntimeError, inputHashOf, type Effect, type JSONValue } from './contracts.js';
import {
  MEMORY_OUTBOX_KIND,
  deliverMemoryOutbox,
  enqueueMemoryOutbox,
  finalizeCancelled,
  latestMemoryOutbox,
  type MemoryOutboxEntry,
  type TaskControllerRegistry,
} from './recovery.js';
import type { TaskRecord, TaskService } from './task-service.js';
import type { GatewayCost, ModelGateway } from './model-gateway.js';
import type { ProviderAdapter, Usage } from '../providers/protocol.js';
import { runAgentLoop, type AgentLoopResult } from './agent-loop.js';
import type { TaskAuthorization } from '../tools/policy.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * M09 · 同一聊天内核：CLI 普通聊天、/astra、IPC v1 chat 全部收敛到
 * task-service + model-gateway 这一条执行路径（03-TASK-CARDS M09.1）。
 *
 * - 每轮聊天是一个 kind:'chat' 的任务：幂等创建（同 ID 同输入返回账本结果，
 *   零新副作用；同 ID 改输入 REQUEST_ID_CONFLICT），queued→running→终态，
 *   事件与文件任务共用同一张 events 表，模型调用共用同一张 model_calls 预算账本。
 * - 模型调用只经 ModelGateway.complete（tools: []）：预算预检/预留/结算/取消
 *   uncertain 语义与 AgentLoop 完全一致；业务层没有第二条 provider 通道。
 * - 聊天不执行任何工具：模型若在纯聊天里返回 toolCalls，只计数并如实告知
 *   （toolCallsIgnored），绝不走旧的“单次执行后不回灌”分支；文件交付出
 *   桌面/IPC 的 task.start 在工作区内完成。
 * - 取消与崩溃语义复用 M07：controllers 注册后 task.cancel 可中止在途调用
 *   （发出后取消 = 费用 uncertain）；崩溃遗留 running 由 recover() 标
 *   interrupted，reserved 调用在下次同 ID 访问时标 uncertain，绝不静默重发。
 * - 终态单事务：状态 + 事件 + memory outbox（幂等键 mem:<taskId>，payload 带
 *   chat 摘要）；写回失败保留结果，outbox pending 等补写，不重放模型调用。
 */

const DEFAULT_CHAT_SYSTEM = '你是SKF的 SKF 聊天内核。可以用已提供的工具读文件、查网页、在会话工作区内写文件；有外部副作用（剪贴板/浏览器点击/启动程序等）的操作必须先经用户审批。';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export type ChatChannel = 'cli' | 'ipc' | 'once';

export interface ChatTurnRequest {
  /** 调用方选定的幂等键（IPC 用请求帧 id；CLI 用会话内唯一 id）。 */
  id: string;
  message: string;
  sessionId: string;
  scope: string;
  channel: ChatChannel;
  /** chat（普通聊天）| review（/astra 顾问，用户显式输入即昂贵授权）。 */
  purpose?: 'chat' | 'review';
  route?: { provider?: string; model?: string; allowExpensive?: boolean };
  /** 展示与记忆写回用的轮次标记。 */
  turn?: number;
  /** 记忆写回提示（如 'astra' 顾问通道）。 */
  consult?: string;
  /** 覆盖 system（/astra 顾问提示词）；设置后不再做记忆 prepare。 */
  systemOverride?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ChatToolCallRecord {
  callId: string;
  tool: string;
  effect: Effect;
  status: 'ok' | 'failed' | 'approval_pending';
  summary: string;
}

export interface ChatTurnResult {
  taskId: string;
  state: 'succeeded' | 'waiting_approval';
  /** true = 账本重放（同 ID 同输入），零新事件、零新模型调用。 */
  idempotent: boolean;
  text: string;
  provider: string;
  model: string;
  usage: Usage;
  cost: GatewayCost;
  /** 本轮已执行的工具调用（名称+effect 等级+状态+摘要），供聊天气泡渲染；长输出折叠由 UI 处理。 */
  toolCalls: ChatToolCallRecord[];
  /** 兼容旧字段：工具已执行，恒为 0。 */
  toolCallsIgnored: number;
  memoryOutboxPending: boolean;
  /** waiting_approval 时携带待决审批信息（审批卡片内嵌聊天流）。 */
  pendingApproval?: { approvalId: string; inputHash: string; tool: string; effect: Effect; summary: string };
}

export interface ChatKernelDeps {
  service: TaskService;
  /** 必填；缺失由 supervisor 在装配期 fail-closed（BUDGET_UNAVAILABLE）。 */
  gateway: ModelGateway;
  controllers?: TaskControllerRegistry;
  /** 记忆上下文（MemoryAdapter.prepare / legacy gather 的完整 system 文本）；
   *  返回 null 时退回 fallbackSystem。 */
  prepareContext?: (task: TaskRecord) => Promise<string | null>;
  fallbackSystem?: string;
  flushMemoryOutbox?: (entry: MemoryOutboxEntry) => Promise<void>;
  defaultProvider: () => string;
  modelFor: (name: string) => string | null;
  providerAvailable: (name: string) => boolean;
  /** 已注册的工具面（file/desktop/browser/media/web/mcp/bridge 全部）。 */
  tools: ToolRegistry;
  /** provider 适配器（runAgentLoop 类型要求；gateway 路径下不直调）。 */
  adapterFor: (name: string) => ProviderAdapter | null;
  /** 会话工作区（workspace_write 工具落盘根）；缺省 '-'（无文件系统，写工具将被拒）。 */
  workspaceRootFor?: (sessionId: string) => string;
  /** 副作用审批 TTL 查询（按工具名，默认 30 分钟）。 */
  approvalTtlMsFor?: (toolName: string) => number;
  /** 已登记的桥接工具名（chat 授权其 read 面；副作用仍审批）。 */
  bridgeTools?: () => string[];
  /** 已登记的 MCP 工具名（chat 授权其 read 面；副作用仍审批）。 */
  mcpTools?: () => string[];
  logger?: (line: string) => void;
}

function chatInput(req: ChatTurnRequest, deps: ChatKernelDeps): JSONValue {
  const bridge = deps.bridgeTools?.() ?? [];
  const mcp = deps.mcpTools?.() ?? [];
  return {
    kind: 'chat',
    message: req.message,
    channel: req.channel,
    // B：chat 授权全量工具面（read/workspace_write 直行；external_write/process 走审批）。
    // 仅在有登记时写入，避免无桥/MCP 环境把空数组塞进 input 改变幂等 hash。
    ...(bridge.length ? { bridgeTools: bridge } : {}),
    ...(mcp.length ? { mcpTools: mcp } : {}),
    ...(req.consult !== undefined ? { consult: req.consult } : {}),
  } as JSONValue;
}

function messageOf(task: TaskRecord): string {
  const input = task.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const message = (input as Record<string, JSONValue>).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

function lastAssistantText(service: TaskService, taskId: string): string {
  const row = service.store.db
    .prepare("SELECT content FROM messages WHERE taskId = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1")
    .get(taskId) as { content: string } | undefined;
  return row?.content ?? '';
}

interface LedgerCallRow {
  usage: string | null;
  state: string;
  reservedCostMicros: number | null;
  settledCostMicros: number | null;
  currency: string | null;
  tariff: string | null;
}

function lastModelCall(service: TaskService, taskId: string): LedgerCallRow | undefined {
  return service.store.db
    .prepare('SELECT usage, state, reservedCostMicros, settledCostMicros, currency, tariff FROM model_calls WHERE taskId = ? ORDER BY createdAt DESC, id DESC LIMIT 1')
    .get(taskId) as LedgerCallRow | undefined;
}

function ledgerUsage(row: LedgerCallRow | undefined): Usage {
  if (!row?.usage) return { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' };
  try {
    const parsed = JSON.parse(row.usage) as Partial<Usage>;
    return {
      inputTokens: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : null,
      outputTokens: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : null,
      cachedInputTokens: typeof parsed.cachedInputTokens === 'number' ? parsed.cachedInputTokens : null,
      source: 'provider',
    };
  } catch {
    return { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' };
  }
}

function ledgerCost(row: LedgerCallRow | undefined): GatewayCost {
  let tariffVersion: string | null = null;
  if (row?.tariff) {
    try {
      const parsed = JSON.parse(row.tariff) as { tariffVersion?: unknown };
      if (typeof parsed.tariffVersion === 'string') tariffVersion = parsed.tariffVersion;
    } catch {
      /* 保持 null */
    }
  }
  return {
    reservedMicros: row?.reservedCostMicros ?? null,
    settledMicros: row?.settledCostMicros ?? null,
    currency: row?.currency ?? null,
    tariffVersion,
    amountKnown: row?.state === 'settled' && row?.settledCostMicros !== null && row?.settledCostMicros !== undefined,
    source: 'configured-estimate',
    usage: ledgerUsage(row),
  };
}

function outboxPendingFor(service: TaskService, taskId: string): boolean {
  return service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId);
}

/** 会话工作区授权：read + workspace_write 直行（root 内），external_write/process 走审批（M14 hasApproved）。 */
function chatAuthorization(workspaceRoot: string, deps: ChatKernelDeps): TaskAuthorization {
  return {
    workspaceRoot,
    allowedEffects: ['read', 'workspace_write'],
    allowedBridgeTools: deps.bridgeTools?.() ?? [],
    allowedMcpTools: deps.mcpTools?.() ?? [],
  };
}

/** 从 task.tool 事件读回本轮工具调用（名称+effect+状态+脱敏摘要），供聊天气泡渲染。 */
function listChatToolCalls(service: TaskService, taskId: string): ChatToolCallRecord[] {
  const rows = service.store.db
    .prepare("SELECT safePayload FROM events WHERE taskId = ? AND type = 'task.tool' ORDER BY eventSeq ASC")
    .all(taskId) as unknown as Array<{ safePayload: string }>;
  return rows.map((row) => {
    const p = JSON.parse(row.safePayload) as { callId?: string; tool?: string; effect?: string; summary?: string; ok?: boolean };
    return {
      callId: p.callId ?? '',
      tool: p.tool ?? '',
      effect: (p.effect as Effect) ?? 'read',
      status: p.ok ? 'ok' : 'failed',
      summary: p.summary ?? p.tool ?? '',
    };
  });
}

function emptyCost(): GatewayCost {
  return {
    reservedMicros: null,
    settledMicros: null,
    currency: null,
    tariffVersion: null,
    amountKnown: false,
    source: 'configured-estimate',
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' },
  };
}

/** 从 approvals + operations 表读回待决审批（审批卡片字段）。 */
function pendingApprovalOf(deps: ChatKernelDeps, taskId: string): ChatTurnResult['pendingApproval'] {
  const row = deps.service.store.db
    .prepare("SELECT id, inputHash, effect, operationId FROM approvals WHERE taskId = ? AND decision = 'pending' ORDER BY expiresAt ASC LIMIT 1")
    .get(taskId) as { id: string; inputHash: string; effect: string; operationId: string | null } | undefined;
  if (!row) return undefined;
  const op = row.operationId
    ? (deps.service.store.db.prepare('SELECT toolName FROM operations WHERE id = ?').get(row.operationId) as { toolName: string } | undefined)
    : undefined;
  const tool = op?.toolName ?? '';
  return { approvalId: row.id, inputHash: row.inputHash, tool, effect: (row.effect as Effect) ?? 'external_write', summary: tool };
}

/** runAgentLoop 类型要求 provider；chat 恒走 gateway，此 stub 仅在 gateway 缺失时兜底。 */
function unavailableAdapter(name: string): ProviderAdapter {
  return {
    async capabilities() {
      return { tools: true, streaming: false, cancel: true, usage: true, contextWindowTokens: null };
    },
    async complete() {
      throw new RuntimeError('PROVIDER_UNAVAILABLE', name);
    },
  };
}

/** 账本重放：终态任务直接返回持久化结果，不重新执行任何副作用。 */
function replayResult(deps: ChatKernelDeps, task: TaskRecord): ChatTurnResult {
  const call = lastModelCall(deps.service, task.id);
  return {
    taskId: task.id,
    state: 'succeeded',
    idempotent: true,
    text: lastAssistantText(deps.service, task.id),
    provider: task.provider,
    model: task.model,
    usage: ledgerUsage(call),
    cost: ledgerCost(call),
    toolCalls: listChatToolCalls(deps.service, task.id),
    toolCallsIgnored: 0,
    memoryOutboxPending: outboxPendingFor(deps.service, task.id),
  };
}

/** 崩溃遗留的 reserved 调用：可能已计费，标 uncertain，绝不静默重发（M07 语义）。 */
function markReservedUncertain(service: TaskService, taskId: string): void {
  const rows = service.store.db
    .prepare("SELECT id FROM model_calls WHERE taskId = ? AND state = 'reserved'")
    .all(taskId) as unknown as Array<{ id: string }>;
  for (const row of rows) service.settleModelCall(row.id, { state: 'uncertain' });
}

async function runTextOnlyTurn(deps: ChatKernelDeps, req: ChatTurnRequest): Promise<ChatTurnResult> {
  const { service } = deps;
  if (!req.message.trim() || req.message.length > 16_000) throw new RuntimeError('INVALID_MESSAGE');

  const provider = req.route?.provider ?? deps.defaultProvider();
  if (!deps.providerAvailable(provider)) throw new RuntimeError('PROVIDER_UNAVAILABLE', provider);
  const model = req.route?.model ?? deps.modelFor(provider) ?? provider;
  const purpose = req.purpose ?? 'chat';
  const input = chatInput(req, deps);

  // 幂等语义：同 ID 同输入返回账本结果；同 ID 改输入拒绝；崩溃遗留不静默重发。
  const prior = service.getTask(req.id);
  if (prior) {
    if (prior.inputHash !== inputHashOf(input)) throw new RuntimeError('REQUEST_ID_CONFLICT', req.id);
    if (prior.state === 'succeeded') return replayResult(deps, prior);
    if (prior.state === 'failed') throw new RuntimeError(prior.errorCode ?? 'MODEL_REQUEST_FAILED');
    if (prior.state === 'cancelled') throw new RuntimeError(prior.errorCode ?? 'TASK_CANCELLED');
    if (prior.state === 'interrupted') {
      markReservedUncertain(service, prior.id);
      throw new RuntimeError('TASK_INTERRUPTED', `${req.id}: chat turn interrupted; start a new turn instead of silent re-send`);
    }
    throw new RuntimeError('REQUEST_IN_PROGRESS', req.id);
  }

  const task = service.createTask({
    id: req.id,
    input,
    sessionId: req.sessionId,
    scope: req.scope,
    workspaceRoot: '-', // 聊天不接触文件系统；与 gateway 系统通道同一约定
    provider,
    model,
  });

  // 创建与 running 转换之间不 await，崩溃窗口最小；遗留 queued 由 worker 跳过（聊天是调用方同步驱动）。
  service.transitionTask(task.id, 'running', {
    event: { type: 'task.running', payload: { channel: req.channel, purpose } },
  });

  // system：systemOverride > prepareContext > fallbackSystem > 内置最小提示。
  let system = req.systemOverride ?? null;
  if (system === null && deps.prepareContext) {
    system = await deps.prepareContext(service.getTask(task.id)!);
  }
  if (system === null) system = deps.fallbackSystem ?? DEFAULT_CHAT_SYSTEM;

  service.store.transaction(() => {
    service.appendMessage(task.id, { role: 'system', content: system! });
    service.appendMessage(task.id, { role: 'user', content: req.message });
  });

  const abort = new AbortController();
  deps.controllers?.register(task.id, abort);
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();

  const fail = async (code: string, detail: string): Promise<never> => {
    const current = service.getTask(task.id)!;
    if (current.state === 'cancelling' || current.state === 'cancelled') {
      await finalizeCancelled(service, task.id, { ...(deps.flushMemoryOutbox ? { flushMemoryOutbox: deps.flushMemoryOutbox } : {}) });
      throw new RuntimeError('TASK_CANCELLED', detail);
    }
    service.store.transaction(() => {
      service.transitionTask(task.id, 'failed', {
        errorCode: code,
        event: { type: 'task.failed', payload: { errorCode: code, detail: detail.slice(0, 500) } },
      });
      enqueueMemoryOutbox(service, current, 'failed', code, { chat: chatPayload(req, '', provider) });
    });
    await deliverMemoryOutbox(service, latestMemoryOutbox(service, task.id), deps.flushMemoryOutbox);
    throw new RuntimeError(code, detail);
  };

  try {
    let gw;
    try {
      gw = await deps.gateway.complete({
        callId: `mc:${task.id}:1`,
        taskId: task.id,
        purpose,
        route: { provider, model, ...(req.route?.allowExpensive === true ? { allowExpensive: true } : {}) },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: req.message },
        ],
        tools: [],
        maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        signal: abort.signal,
        deadlineAt: Date.now() + timeoutMs,
      });
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'MODEL_REQUEST_FAILED';
      await fail(code, error instanceof Error ? error.message : String(error));
    }

    const completion = gw!.completion;
    const ignored = completion.assistant.toolCalls?.length ?? 0;
    const current = service.getTask(task.id)!;
    if (current.state === 'cancelling' || current.state === 'cancelled') {
      // 写入后终态 CAS：取消意图先到，不允许 succeeded 覆盖（M07）。
      await finalizeCancelled(service, task.id, { ...(deps.flushMemoryOutbox ? { flushMemoryOutbox: deps.flushMemoryOutbox } : {}) });
      throw new RuntimeError('TASK_CANCELLED');
    }
    service.store.transaction(() => {
      service.appendMessage(task.id, {
        role: 'assistant',
        content: completion.assistant.content,
        ...(ignored > 0 ? { toolCalls: completion.assistant.toolCalls as unknown as JSONValue } : {}),
      });
      appendEvent(service.store, task.id, 'task.model_step', {
        callId: `mc:${task.id}:1`,
        step: 1,
        finishReason: completion.finishReason,
        toolCalls: ignored,
      });
      service.transitionTask(task.id, 'succeeded', {
        event: {
          type: 'task.succeeded',
          payload: { channel: req.channel, purpose, toolCallsIgnored: ignored },
        },
      });
      enqueueMemoryOutbox(service, current, 'succeeded', null, { chat: chatPayload(req, completion.assistant.content, provider) });
    });
    const delivered = await deliverMemoryOutbox(service, latestMemoryOutbox(service, task.id), deps.flushMemoryOutbox);
    return {
      taskId: task.id,
      state: 'succeeded',
      idempotent: false,
      text: completion.assistant.content,
      provider: gw!.provider,
      model: gw!.model,
      usage: completion.usage,
      cost: gw!.cost,
      toolCalls: [],
      toolCallsIgnored: ignored,
      memoryOutboxPending: !delivered && outboxPendingFor(service, task.id),
    };
  } finally {
    clearTimeout(timer);
    deps.controllers?.unregister(task.id, abort);
  }
}

/** 普通聊天：全量工具面 + effect 分级 + 审批，复用 AgentLoop 工具闭环（预算/恢复/审批）。
 *  review（/astra 顾问）是纯文本昂贵通道，不执行工具，走 runTextOnlyTurn。 */
export async function runChatTurn(deps: ChatKernelDeps, req: ChatTurnRequest): Promise<ChatTurnResult> {
  if (req.purpose === 'review') return runTextOnlyTurn(deps, req);
  return runToolLoopTurn(deps, req);
}

async function runToolLoopTurn(deps: ChatKernelDeps, req: ChatTurnRequest): Promise<ChatTurnResult> {
  const { service } = deps;
  if (!req.message.trim() || req.message.length > 16_000) throw new RuntimeError('INVALID_MESSAGE');

  const provider = req.route?.provider ?? deps.defaultProvider();
  if (!deps.providerAvailable(provider)) throw new RuntimeError('PROVIDER_UNAVAILABLE', provider);
  const model = req.route?.model ?? deps.modelFor(provider) ?? provider;
  const workspaceRoot = deps.workspaceRootFor?.(req.sessionId) ?? '-';
  const input = chatInput(req, deps);

  const prior = service.getTask(req.id);
  if (prior) {
    if (prior.inputHash !== inputHashOf(input)) throw new RuntimeError('REQUEST_ID_CONFLICT', req.id);
    if (prior.state === 'succeeded') return replayResult(deps, prior);
    if (prior.state === 'failed') throw new RuntimeError(prior.errorCode ?? 'MODEL_REQUEST_FAILED');
    if (prior.state === 'cancelled') throw new RuntimeError(prior.errorCode ?? 'TASK_CANCELLED');
    if (prior.state === 'interrupted') {
      markReservedUncertain(service, prior.id);
      throw new RuntimeError('TASK_INTERRUPTED', `${req.id}: chat turn interrupted; start a new turn instead of silent re-send`);
    }
    // 审批未决：返回当前待决审批卡片（不推进、不重跑）。
    if (prior.state === 'waiting_approval') return waitingApprovalResult(deps, prior);
    // running：审批通过后（decideApproval 推进到 running）恢复循环继续执行。
  } else {
    service.createTask({
      id: req.id,
      input,
      sessionId: req.sessionId,
      scope: req.scope,
      workspaceRoot,
      provider,
      model,
    });
  }

  const task = service.getTask(req.id)!;

  // system：systemOverride > prepareContext > fallbackSystem > 内置最小提示（仅新任务播种；恢复沿用已持久历史）。
  if (service.listMessages(req.id).length === 0) {
    let system = req.systemOverride ?? null;
    if (system === null && deps.prepareContext) system = await deps.prepareContext(task);
    if (system === null) system = deps.fallbackSystem ?? DEFAULT_CHAT_SYSTEM;
    service.store.transaction(() => {
      service.appendMessage(req.id, { role: 'system', content: system! });
      service.appendMessage(req.id, { role: 'user', content: req.message });
    });
  }

  const providerAdapter = deps.adapterFor(provider);
  const result = await runAgentLoop(
    {
      service,
      provider: providerAdapter ?? unavailableAdapter(provider),
      gateway: deps.gateway,
      tools: deps.tools,
      authorization: chatAuthorization(workspaceRoot, deps),
      ...(deps.controllers ? { controllers: deps.controllers } : {}),
      ...(deps.approvalTtlMsFor ? { approvalTtlMsFor: deps.approvalTtlMsFor } : {}),
      ...(deps.flushMemoryOutbox ? { flushMemoryOutbox: deps.flushMemoryOutbox } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      limits: { maxDurationMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      memoryOutboxExtra: (t) => ({ chat: chatPayload(req, lastAssistantText(service, t.id), provider) }),
    },
    req.id,
  );

  return mapChatLoopResult(deps, req, result);
}

function mapChatLoopResult(deps: ChatKernelDeps, req: ChatTurnRequest, result: AgentLoopResult): ChatTurnResult {
  const { service } = deps;
  const taskId = req.id;
  if (result.state === 'waiting_approval') {
    const task = service.getTask(taskId)!;
    const pending = result.pendingApproval;
    return {
      taskId,
      state: 'waiting_approval',
      idempotent: false,
      text: '',
      provider: task.provider,
      model: task.model,
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' },
      cost: emptyCost(),
      toolCalls: listChatToolCalls(service, taskId),
      toolCallsIgnored: 0,
      memoryOutboxPending: false,
      pendingApproval: pending
        ? { approvalId: pending.approvalId, inputHash: pending.inputHash, tool: pending.tool, effect: deps.tools.specOf(pending.tool)?.effect ?? 'external_write', summary: pending.tool }
        : undefined,
    };
  }
  if (result.state === 'cancelled') throw new RuntimeError('TASK_CANCELLED');
  if (result.state === 'failed') throw new RuntimeError(result.errorCode ?? 'MODEL_REQUEST_FAILED');

  const task = service.getTask(taskId)!;
  const call = lastModelCall(service, taskId);
  return {
    taskId,
    state: 'succeeded',
    idempotent: false,
    text: result.finalText,
    provider: task.provider,
    model: task.model,
    usage: ledgerUsage(call),
    cost: ledgerCost(call),
    toolCalls: listChatToolCalls(service, taskId),
    toolCallsIgnored: 0,
    memoryOutboxPending: result.memoryOutboxPending,
  };
}

function waitingApprovalResult(deps: ChatKernelDeps, task: TaskRecord): ChatTurnResult {
  const pending = pendingApprovalOf(deps, task.id);
  return {
    taskId: task.id,
    state: 'waiting_approval',
    idempotent: true,
    text: '',
    provider: task.provider,
    model: task.model,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unknown' },
    cost: emptyCost(),
    toolCalls: listChatToolCalls(deps.service, task.id),
    toolCallsIgnored: 0,
    memoryOutboxPending: outboxPendingFor(deps.service, task.id),
    ...(pending ? { pendingApproval: pending } : {}),
  };
}

function chatPayload(req: ChatTurnRequest, reply: string, provider: string): JSONValue {
  return {
    message: req.message.slice(0, 500),
    reply: reply.slice(0, 1000),
    channel: req.channel,
    provider,
    ...(req.turn !== undefined ? { turn: req.turn } : {}),
    ...(req.consult !== undefined ? { consult: req.consult } : {}),
  } as JSONValue;
}

// ── 历史视图（v1 history / IPC recent）：聊天与旧导入同一张表 ──────────

export interface ChatHistoryEntry {
  id: string;
  sessionId: string;
  message: string;
  text: string;
  provider: string;
  model: string;
  usage: Usage | null;
  state: string;
  errorCode: string | null;
  createdAt: string;
  channel: string | null;
  memoryOutboxPending: boolean;
}

/** v1 history：runtime.sqlite 里的聊天任务（含旧 tasks/*.json 隔离导入），时间升序取最近 limit 条。 */
export function listChatHistory(service: TaskService, limit = 30): ChatHistoryEntry[] {
  return listChatPage(service, { sessionId: null, afterSeq: undefined, limit }).entries;
}

interface ChatRow {
  id: string;
  input: string;
  provider: string;
  model: string;
  state: string;
  errorCode: string | null;
  createdAt: string;
  sessionId: string;
  scope: string;
}

function chatEntryFromRow(service: TaskService, row: ChatRow): ChatHistoryEntry {
  const input = JSON.parse(row.input) as { message?: unknown; channel?: unknown };
  const call = lastModelCall(service, row.id);
  return {
    id: row.id,
    sessionId: row.sessionId,
    message: typeof input.message === 'string' ? input.message : '',
    text: lastAssistantText(service, row.id),
    provider: row.provider,
    model: row.model,
    usage: call ? ledgerUsage(call) : null,
    state: row.state,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    channel: typeof input.channel === 'string' ? input.channel : null,
    memoryOutboxPending: outboxPendingFor(service, row.id),
  } satisfies ChatHistoryEntry;
}

/** 分页游标（不透明）：JSON 编码 (createdAt, id)，避免同毫秒时间戳的分页丢失/重复。 */
function encodeHistoryCursor(createdAt: string, id: string): string {
  return JSON.stringify([createdAt, id]);
}

function decodeHistoryCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const arr = JSON.parse(cursor) as unknown;
    if (Array.isArray(arr) && arr.length === 2 && typeof arr[0] === 'string' && typeof arr[1] === 'string') {
      return { createdAt: arr[0], id: arr[1] };
    }
  } catch {
    /* 非法游标视为从最新开始 */
  }
  return null;
}

export interface SessionHistoryPage {
  entries: ChatHistoryEntry[];
  hasMore: boolean;
  /** 下一页游标（“更早”方向）；无更多时为 null。 */
  nextSeq: string | null;
}

const CHAT_KINDS = "('chat', 'legacy_chat_import')";

/**
 * M23 · 按会话分页的聊天历史（时间升序返回；afterSeq 传入上一页 nextSeq 以向更早方向翻页）。
 * sessionId 为 null 时退化为全局历史（v1 history 兼容）。
 */
export function listChatPage(
  service: TaskService,
  opts: { sessionId?: string | null; afterSeq?: string; limit?: number },
): SessionHistoryPage {
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
  const cursor = opts.afterSeq ? decodeHistoryCursor(opts.afterSeq) : null;
  const sessionId = opts.sessionId ?? null;

  const rows = (
    sessionId === null
      ? cursor === null
        ? service.store.db
            .prepare(
              `SELECT id, input, provider, model, state, errorCode, createdAt, sessionId, scope FROM tasks
               WHERE json_extract(input, '$.kind') IN ${CHAT_KINDS}
               ORDER BY createdAt DESC, id DESC LIMIT ?`,
            )
            .all(limit + 1)
        : service.store.db
            .prepare(
              `SELECT id, input, provider, model, state, errorCode, createdAt, sessionId, scope FROM tasks
               WHERE json_extract(input, '$.kind') IN ${CHAT_KINDS}
                 AND (createdAt < ? OR (createdAt = ? AND id < ?))
               ORDER BY createdAt DESC, id DESC LIMIT ?`,
            )
            .all(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
      : cursor === null
        ? service.store.db
            .prepare(
              `SELECT id, input, provider, model, state, errorCode, createdAt, sessionId, scope FROM tasks
               WHERE sessionId = ? AND json_extract(input, '$.kind') IN ${CHAT_KINDS}
               ORDER BY createdAt DESC, id DESC LIMIT ?`,
            )
            .all(sessionId, limit + 1)
        : service.store.db
            .prepare(
              `SELECT id, input, provider, model, state, errorCode, createdAt, sessionId, scope FROM tasks
               WHERE sessionId = ? AND json_extract(input, '$.kind') IN ${CHAT_KINDS}
                 AND (createdAt < ? OR (createdAt = ? AND id < ?))
               ORDER BY createdAt DESC, id DESC LIMIT ?`,
            )
            .all(sessionId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
  ) as unknown as ChatRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const entries = page.map((row) => chatEntryFromRow(service, row)).reverse(); // 时间升序
  const nextSeq = hasMore && page.length > 0 ? encodeHistoryCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
  return { entries, hasMore, nextSeq };
}
