import { randomUUID } from 'node:crypto';
import { appendEvent } from './events.js';
import { RuntimeError, inputHashOf, stableStringify, type JSONValue } from './contracts.js';
import { parseAcceptance, describeAcceptance, verifyAcceptance, type AcceptanceSpec, type VerificationFailure } from './artifact-verifier.js';
import {
  MEMORY_OUTBOX_KIND,
  TaskControllerRegistry,
  deliverMemoryOutbox,
  enqueueMemoryOutbox,
  finalizeCancelled,
  latestMemoryOutbox,
  listArtifacts,
  progressSig,
  reconcileInterruptedOperation,
  type MemoryOutboxEntry,
} from './recovery.js';
import type { TaskRecord, TaskService } from './task-service.js';
import type { ModelGateway } from './model-gateway.js';
import type { ProviderAdapter, CompletionResult, ModelMessage, ToolCall, ToolSchema } from '../providers/protocol.js';
import type { ToolRegistry } from '../tools/registry.js';
import { bridgeToolsOfInput, mcpToolsOfInput } from '../tools/registry.js';
import type { TaskAuthorization } from '../tools/policy.js';

/**
 * M05 · 真实 AgentLoop（02-CONTRACTS.md F 节 / 03-TASK-CARDS M05）。
 *
 * 固定顺序：先持久请求/操作 → 执行 → 持久结果 → 回灌同 ID tool message。
 * - 上限默认 8 模型步 / 12 工具次 / 总 10 分钟（保护上限，非用户预算；任务可更小，
 *   没有任何参数能让单次运行超过这里代码钉死的绝对上限）。
 * - callId ↔ operationId 稳定映射（op:<taskId>:<callId>）；同 call+同 args 返回已持久
 *   结果不重复执行；同 ID 改 args 报 REQUEST_ID_CONFLICT。
 * - 验收由任务 acceptance 定义（artifact-verifier），模型说「已写」但没发工具 → 不成功；
 *   一次有限纠正后仍无证据 → ACCEPTANCE_NOT_MET。
 * - 连续 2 次相同规范化工具名+args+结果且无新 artifact → NO_PROGRESS。
 * - 终态在单事务内写状态+事件+memory outbox；记忆写回失败保留交付产物，
 *   outbox 留 pending 等恢复，绝不为此重放工具副作用。
 * - provider 429/5xx 首版不自动重试（02-F）；崩溃遗留 reserved 调用标 uncertain，
 *   不静默重发可能已计费的请求。
 */

// 绝对上限：limits 配置只能调小，不能调大（未经授权不得扩大，03-M05.2）。
export const ABSOLUTE_LOOP_LIMITS = { maxModelSteps: 8, maxToolCalls: 12, maxDurationMs: 600_000 } as const;

export interface AgentLoopLimits {
  maxModelSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
}

function clampLimits(overrides?: Partial<AgentLoopLimits>): AgentLoopLimits {
  const pick = (value: number | undefined, fallback: number, ceiling: number, field: string): number => {
    const v = value ?? fallback;
    if (!Number.isSafeInteger(v) || v < 1 || v > ceiling) {
      throw new RuntimeError('INVALID_INPUT', `limits.${field} must be 1..${ceiling}`);
    }
    return v;
  };
  return {
    maxModelSteps: pick(overrides?.maxModelSteps, ABSOLUTE_LOOP_LIMITS.maxModelSteps, ABSOLUTE_LOOP_LIMITS.maxModelSteps, 'maxModelSteps'),
    maxToolCalls: pick(overrides?.maxToolCalls, ABSOLUTE_LOOP_LIMITS.maxToolCalls, ABSOLUTE_LOOP_LIMITS.maxToolCalls, 'maxToolCalls'),
    maxDurationMs: pick(overrides?.maxDurationMs, ABSOLUTE_LOOP_LIMITS.maxDurationMs, ABSOLUTE_LOOP_LIMITS.maxDurationMs, 'maxDurationMs'),
  };
}

export interface AgentLoopDeps {
  service: TaskService;
  provider: ProviderAdapter;
  /** M06：提供时所有模型调用经 ModelGateway（预算预留/结算/路由/重试策略）；
   *  缺省走 provider 直调，仅供测试 adapter 使用，不是生产路径。 */
  gateway?: ModelGateway;
  tools: ToolRegistry;
  /** 任务级授权表；root 必须与任务 workspaceRoot 一致（PolicyGate 复核）。 */
  authorization: TaskAuthorization;
  /** M07：在途任务的取消句柄。注册后 requestTaskCancel 能把 abort 送达本循环。 */
  controllers?: TaskControllerRegistry;
  limits?: Partial<AgentLoopLimits>;
  /** 记忆上下文（M01 MemoryAdapter.prepare 的 system 文本）；缺省时用内置最小规则。 */
  prepareContext?: (task: TaskRecord) => Promise<string | null>;
  /** 终态 memory outbox 的实际投递；缺省 = 留在 pending 由调用方稍后处理。 */
  flushMemoryOutbox?: (entry: MemoryOutboxEntry) => Promise<void>;
  logger?: (line: string) => void;
  maxOutputTokens?: number;
  /** 最终 provider 请求（messages+tools 序列化）字节兜底；超限拒绝发送。 */
  maxRequestBytes?: number;
  /** 终态 memory outbox 的附加摘要字段（如聊天轮次的 message/reply/channel/provider）；
   *  缺省 = 通用任务摘要。 */
  memoryOutboxExtra?: (task: TaskRecord) => Record<string, JSONValue>;
  /** M14：副作用审批 TTL 查询（按工具名，默认 30 分钟；supervisor 接 mcpRegistry.getApprovalTtl）。 */
  approvalTtlMsFor?: (toolName: string) => number;
  /** M13：学习闭环检查点 hooks（缺省 = 影子模式未激活，循环行为与 M12 完全一致）。 */
  learning?: LearningLoopHooks;
}

export interface AgentLoopResult {
  taskId: string;
  /** M14：waiting_approval = 副作用工具待审批，任务非终态停车（approve 后泵复跑）。 */
  state: 'succeeded' | 'failed' | 'cancelled' | 'waiting_approval';
  errorCode: string | null;
  modelSteps: number;
  toolCalls: number;
  artifacts: Array<{ id: string; relativePath: string; byteLength: number; sha256: string }>;
  finalText: string;
  /** 终态已落库但记忆写回未确认（产物保留，恢复时只补写不重放工具）。 */
  memoryOutboxPending: boolean;
  /** M14：waiting_approval 时携带待决审批信息（UI/IPC 展示）。 */
  pendingApproval?: { approvalId: string; inputHash: string; tool: string };
}

/** M13 · 学习闭环运行时检查点 hooks（LearningService 实现；缺省 = 特性关闭，零行为变化）。
 *  保证的是「没有通过检查就不能继续特定动作或报告成功」，不是保证模型内在遵守建议。 */
export interface LearningLoopHooks {
  /** 任务规划后登记检查点（幂等；candidate 不登记硬检查点）。 */
  onTaskPlanned?(task: TaskRecord): void;
  /** deterministic guard：返回 blockReason ⇒ 本次工具操作失败回灌，模型可纠正。 */
  beforeToolCall?(task: TaskRecord, call: ToolCall): { blockReason: string } | null;
  /** 工具成功后更新检查点状态。 */
  afterToolCall?(task: TaskRecord, call: ToolCall, operationId: string, ok: boolean): void;
  /** 报告成功前的硬检查点终裁；未过 ⇒ 一次纠正机会，再不过 ⇒ CHECKPOINT_NOT_MET。 */
  beforeFinalizeSuccess?(task: TaskRecord): { ok: true } | { ok: false; correction: string; reason: string };
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024;
const TOOL_TIMEOUT_MS = 30_000;

const DEFAULT_SYSTEM =
  '你是 SKF 的文件交付助手。只能用提供的工具在任务工作区内读写文件；' +
  '交付以磁盘实物验收为准，只在文本里声称完成不会被接受。';

// ── DB 只读小查询（与 TaskService 同库，统计口径跨重启一致）──────────────

function countRows(service: TaskService, table: 'model_calls' | 'operations' | 'artifacts', taskId: string): number {
  const row = service.store.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE taskId = ?`).get(taskId) as { c: number };
  return row.c;
}

function reservedModelCallIds(service: TaskService, taskId: string): string[] {
  const rows = service.store.db
    .prepare("SELECT id FROM model_calls WHERE taskId = ? AND state = 'reserved'")
    .all(taskId) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function getOperationByCallId(service: TaskService, taskId: string, callId: string):
  | { id: string; inputHash: string; state: string; toolName: string; result: string | null }
  | undefined {
  return service.store.db
    .prepare('SELECT id, inputHash, state, toolName, result FROM operations WHERE taskId = ? AND callId = ?')
    .get(taskId, callId) as { id: string; inputHash: string; state: string; toolName: string; result: string | null } | undefined;
}

function hasToolMessage(service: TaskService, taskId: string, toolCallId: string): boolean {
  return !!service.store.db
    .prepare("SELECT 1 FROM messages WHERE taskId = ? AND role = 'tool' AND toolCallId = ? LIMIT 1")
    .get(taskId, toolCallId);
}

function lastAssistantText(service: TaskService, taskId: string): string {
  const row = service.store.db
    .prepare("SELECT content FROM messages WHERE taskId = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1")
    .get(taskId) as { content: string } | undefined;
  return row?.content ?? '';
}

/** M14：历史最后一条 assistant 消息里尚无 tool 结果的悬空 toolCalls
 *  （审批挂起复跑/崩溃在工具执行前）；补驱动它们后才允许发新模型调用——
 *   dangling tool_calls 直接发给真实 API 是协议错误。 */
function danglingToolCalls(service: TaskService, taskId: string): ToolCall[] {
  const messages = service.listMessages(taskId);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const calls = lastAssistant?.toolCalls as unknown as ToolCall[] | undefined;
  if (!calls?.length) return [];
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  return calls.filter((call) => !answered.has(call.id));
}

function toModelMessages(rows: ReturnType<TaskService['listMessages']>): ModelMessage[] {
  return rows.map((row) => {
    if (row.role === 'tool') {
      return { role: 'tool', content: row.content, toolCallId: row.toolCallId as string, name: row.name as string };
    }
    if (row.role === 'assistant') {
      const toolCalls = row.toolCalls === null ? undefined : (row.toolCalls as unknown as ToolCall[]);
      const reasoningContent = typeof row.reasoningContent === 'string' && row.reasoningContent ? row.reasoningContent : undefined;
      return {
        role: 'assistant',
        content: row.content,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls?.length ? { toolCalls } : {}),
      };
    }
    return { role: row.role as 'system' | 'user', content: row.content };
  });
}

/** 工具调用摘要（UI/事件用）：只取 path/query/url/filename/executable/selector 等安全字段，
 *  绝不回显 content/text 等可能含隐私或密钥的字段。 */
function toolCallSummary(tool: string, args: JSONValue): string {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return tool;
  const a = args as Record<string, JSONValue>;
  const safe =
    typeof a.path === 'string' ? a.path :
    typeof a.query === 'string' ? `"${a.query.slice(0, 40)}"` :
    typeof a.url === 'string' ? a.url :
    typeof a.filename === 'string' ? a.filename :
    typeof a.executable === 'string' ? a.executable :
    typeof a.selector === 'string' ? a.selector :
    '';
  return safe ? `${tool} ${safe}` : tool;
}

// ── 主循环 ───────────────────────────────────────────────

export async function runAgentLoop(deps: AgentLoopDeps, taskId: string): Promise<AgentLoopResult> {
  const { service, provider, tools } = deps;
  const limits = clampLimits(deps.limits);
  const maxOutputTokens = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxRequestBytes = deps.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const log = (line: string) => deps.logger?.(line);

  const snapshot = (task: TaskRecord): AgentLoopResult => ({
    taskId,
    state: task.state === 'succeeded' ? 'succeeded' : task.state === 'cancelled' || task.state === 'cancelling' ? 'cancelled' : 'failed',
    errorCode: task.errorCode,
    modelSteps: countRows(service, 'model_calls', taskId),
    toolCalls: countRows(service, 'operations', taskId),
    artifacts: listArtifacts(service, taskId),
    finalText: lastAssistantText(service, taskId),
    memoryOutboxPending: service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId),
  });

  // M07：cancelling → cancelled 的终态 CAS（迟到回调不复活）；已提交的 artifact 照列。
  const finalizeCancelledResult = async (): Promise<AgentLoopResult> => {
    const outcome = await finalizeCancelled(service, taskId, { flushMemoryOutbox: deps.flushMemoryOutbox });
    return {
      taskId,
      state: 'cancelled',
      errorCode: 'TASK_CANCELLED',
      modelSteps: countRows(service, 'model_calls', taskId),
      toolCalls: countRows(service, 'operations', taskId),
      artifacts: outcome.artifacts,
      finalText: lastAssistantText(service, taskId),
      memoryOutboxPending: service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId),
    };
  };

  // F.1 claim lease；确认未取消；持久 running 事件。
  const { fencingToken } = service.claimTask(taskId, limits.maxDurationMs);
  try {
    let task = service.getTask(taskId);
    if (!task) throw new RuntimeError('TASK_NOT_FOUND', taskId);
    if (task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled') {
      // 跨重启去重：终态任务直接返回账本结果，不重新执行任何副作用。
      return snapshot(task);
    }
    if (task.state !== 'queued' && task.state !== 'running') {
      throw new RuntimeError('INVALID_TRANSITION', `runAgentLoop from ${task.state}`);
    }
    if (task.state === 'queued') {
      task = service.transitionTask(taskId, 'running', { event: { type: 'task.running', payload: { limits: limits as unknown as JSONValue } } });
    }

    // 崩溃遗留的 reserved 模型调用：可能已计费也可能没有，标 uncertain，绝不静默重发。
    for (const id of reservedModelCallIds(service, taskId)) {
      service.settleModelCall(id, { state: 'uncertain' });
      return finalizeFailed(deps, task, 'MODEL_CALL_UNCERTAIN', `${id} reserved across restart; refusing silent re-send`);
    }

    // 验收定义来自任务创建时的可信输入；形状非法 = 调用方错误，直接失败不跑模型。
    let acceptance: AcceptanceSpec | null = null;
    if (task.acceptance !== null) acceptance = parseAcceptance(task.acceptance);

    // F.2 记忆上下文 + 原始任务目标/验收进入消息（仅新任务；恢复时沿用已持久历史）。
    if (service.listMessages(taskId).length === 0) {
      const goal = extractGoal(task.input);
      const systemText = (await deps.prepareContext?.(task)) ?? DEFAULT_SYSTEM;
      const userParts = [`任务目标：${goal}`];
      if (acceptance) userParts.push(describeAcceptance(acceptance));
      userParts.push('可用工具见 tools 列表；只能操作任务工作区内的文件。');
      service.store.transaction(() => {
        service.appendMessage(taskId, { role: 'system', content: systemText });
        service.appendMessage(taskId, { role: 'user', content: userParts.join('\n\n') });
      });
    }

    // M13：检查点登记（新任务与恢复任务都走；INSERT OR IGNORE 幂等）。
    deps.learning?.onTaskPlanned?.(task);

    const deadlineAt = Date.now() + limits.maxDurationMs;
    const abort = new AbortController();
    // M07：注册取消句柄；requestTaskCancel 先持久意图再 abort 这里。
    deps.controllers?.register(taskId, abort);
    const abortTimer = setTimeout(() => abort.abort(), limits.maxDurationMs);
    abortTimer.unref?.();

    let correctionUsed = false;
    let learningCorrectionUsed = false;
    let prevProgress: { sig: string; artifactCount: number } | null = null;

    try {
      for (;;) {
        // 取消/时限检查（M07：cancelling 由本循环完成终态 CAS；cancelled 直接读账本）。
        task = service.getTask(taskId)!;
        if (task.state === 'cancelled') return snapshot(task);
        if (task.state === 'cancelling') return finalizeCancelledResult();
        if (Date.now() > deadlineAt) {
          return finalizeFailed(deps, task, 'LOOP_DEADLINE_EXCEEDED', `>${limits.maxDurationMs}ms`);
        }

        // M14：悬空 toolCalls 先补驱动（waiting_approval 复跑/崩溃恢复），再发新模型调用。
        const dangling = danglingToolCalls(service, taskId);
        if (dangling.length > 0) {
          for (const call of dangling) {
            if (!getOperationByCallId(service, taskId, call.id) && countRows(service, 'operations', taskId) >= limits.maxToolCalls) {
              return finalizeFailed(deps, task, 'TOOL_LIMIT_EXCEEDED', `>${limits.maxToolCalls} tool calls`);
            }
            const outcome = await executeToolCall(deps, task, call, abort.signal, deadlineAt);
            if (outcome.cancelled) continue;
            if (outcome.approvalPending) return finalizeWaitingApproval(deps, task, outcome.approvalPending);
            if (outcome.conflict) return finalizeFailed(deps, task, 'REQUEST_ID_CONFLICT', outcome.conflict);
            if (outcome.progress) {
              const artifactCount = countRows(service, 'artifacts', taskId);
              if (prevProgress && prevProgress.sig === outcome.progress.sig && prevProgress.artifactCount === artifactCount) {
                return finalizeFailed(deps, task, 'NO_PROGRESS', `repeat ${call.name} with identical args+result and no new artifact`);
              }
              prevProgress = { sig: outcome.progress.sig, artifactCount };
            }
          }
          continue;
        }

        const modelSteps = countRows(service, 'model_calls', taskId);
        if (modelSteps >= limits.maxModelSteps) {
          return finalizeFailed(deps, task, 'STEP_LIMIT_EXCEEDED', `${modelSteps} >= ${limits.maxModelSteps}`);
        }

        // F.3 持久 callId → 预留账本 → 发请求 → settle 与 assistant 消息同事务落库。
        const callId = `mc:${taskId}:${modelSteps + 1}`;
        const messages = toModelMessages(service.listMessages(taskId));
        // M09/M14：桥接与 MCP 工具只在本任务显式授权名单内广播；file.* 基础工具恒在。
        const toolSchemas: ToolSchema[] = tools.listSchemas(bridgeToolsOfInput(task.input), mcpToolsOfInput(task.input)).map((s) => ({
          name: s.name,
          description: s.description,
          inputSchema: s.inputSchema,
          effect: s.effect,
          timeoutMs: TOOL_TIMEOUT_MS,
          maxOutputBytes: 96_000,
        }));
        const requestBytes = Buffer.byteLength(
          stableStringify({ messages, tools: toolSchemas.map((t) => t.name) } as unknown as JSONValue),
          'utf8',
        );
        if (requestBytes > maxRequestBytes) {
          return finalizeFailed(deps, task, 'CONTEXT_BUDGET_EXCEEDED', `${requestBytes} > ${maxRequestBytes}`);
        }

        let completion: CompletionResult;
        if (deps.gateway) {
          // M06 生产路径：gateway 负责预留/路由/重试/结算；超预算在发网络前拒绝。
          try {
            const gw = await deps.gateway.complete({
              callId,
              taskId,
              purpose: 'chat',
              route: { provider: task.provider, model: task.model, allowExpensive: taskAllowsExpensive(task.input) },
              messages,
              tools: toolSchemas,
              maxOutputTokens,
              signal: abort.signal,
              deadlineAt,
            });
            completion = gw.completion;
          } catch (error) {
            const code = (error as { code?: string })?.code ?? 'MODEL_REQUEST_FAILED';
            // M07：取消/时限错误落在 gateway 账本（发出后取消=uncertain，未发出=release）；
            // 任务已进取消流程时不改写为 failed，交给循环顶的取消终态 CAS。
            const current = service.getTask(taskId)!;
            if (current.state === 'cancelling' || current.state === 'cancelled') continue;
            return finalizeFailed(deps, task, code, error instanceof Error ? error.message : String(error));
          }
          service.store.transaction(() => {
            service.appendMessage(taskId, {
              role: 'assistant',
              content: completion.assistant.content,
              ...(completion.assistant.reasoningContent ? { reasoningContent: completion.assistant.reasoningContent } : {}),
              ...(completion.assistant.toolCalls?.length ? { toolCalls: completion.assistant.toolCalls as unknown as JSONValue } : {}),
            });
            appendEvent(service.store, taskId, 'task.model_step', {
              callId,
              step: modelSteps + 1,
              finishReason: completion.finishReason,
              toolCalls: completion.assistant.toolCalls?.length ?? 0,
            });
          });
        } else {
        service.recordModelCall({ id: callId, taskId, purpose: 'chat', provider: task.provider, model: task.model });
        try {
          completion = await provider.complete({ callId, taskId, messages, tools: toolSchemas, maxOutputTokens, signal: abort.signal, deadlineAt });
        } catch (error) {
          const code = (error as { code?: string })?.code ?? 'MODEL_REQUEST_FAILED';
          // M07：取消信号在请求发出后生效 = 费用不确定（可能已计费），记 uncertain 不记 failed。
          service.settleModelCall(callId, { state: code === 'PROVIDER_ABORTED' ? 'uncertain' : 'failed' });
          const current = service.getTask(taskId)!;
          if (current.state === 'cancelling' || current.state === 'cancelled') continue;
          return finalizeFailed(deps, task, code, error instanceof Error ? error.message : String(error));
        }
        service.store.transaction(() => {
          service.settleModelCall(callId, { state: 'settled', usage: completion!.usage as unknown as JSONValue });
          service.appendMessage(taskId, {
            role: 'assistant',
            content: completion!.assistant.content,
            ...(completion!.assistant.reasoningContent ? { reasoningContent: completion!.assistant.reasoningContent } : {}),
            ...(completion!.assistant.toolCalls?.length ? { toolCalls: completion!.assistant.toolCalls as unknown as JSONValue } : {}),
          });
          appendEvent(service.store, taskId, 'task.model_step', {
            callId,
            step: modelSteps + 1,
            finishReason: completion!.finishReason,
            toolCalls: completion!.assistant.toolCalls?.length ?? 0,
          });
        });
        }

        const assistant = completion.assistant;

        // F.5 有 toolCalls：schema+policy → 稳定 operationId → 先持久后执行 → 回灌同 ID tool message。
        if (assistant.toolCalls?.length) {
          for (const call of assistant.toolCalls) {
            if (!getOperationByCallId(service, taskId, call.id) && countRows(service, 'operations', taskId) >= limits.maxToolCalls) {
              return finalizeFailed(deps, task, 'TOOL_LIMIT_EXCEEDED', `>${limits.maxToolCalls} tool calls`);
            }
            const outcome = await executeToolCall(deps, task, call, abort.signal, deadlineAt);
            if (outcome.cancelled) continue; // 工具前取消检查：交给循环顶完成取消终态
            if (outcome.approvalPending) return finalizeWaitingApproval(deps, task, outcome.approvalPending);
            if (outcome.conflict) return finalizeFailed(deps, task, 'REQUEST_ID_CONFLICT', outcome.conflict);
            if (outcome.progress) {
              const artifactCount = countRows(service, 'artifacts', taskId);
              if (prevProgress && prevProgress.sig === outcome.progress.sig && prevProgress.artifactCount === artifactCount) {
                return finalizeFailed(deps, task, 'NO_PROGRESS', `repeat ${call.name} with identical args+result and no new artifact`);
              }
              prevProgress = { sig: outcome.progress.sig, artifactCount };
            }
          }
          continue;
        }

        // F.4 无 toolCalls：按 acceptance 验收；不接受文本声称。
        if (acceptance === null) {
          if (!assistant.content.trim()) return finalizeFailed(deps, task, 'EMPTY_RESPONSE', 'no toolCalls and empty final text');
          const gate = deps.learning?.beforeFinalizeSuccess?.(task);
          if (gate && !gate.ok) {
            if (!learningCorrectionUsed) {
              learningCorrectionUsed = true;
              service.appendMessage(taskId, { role: 'user', content: gate.correction });
              continue;
            }
            return finalizeFailed(deps, task, 'CHECKPOINT_NOT_MET', gate.reason);
          }
          return finalizeSucceeded(deps, task, []);
        }
        const verification = await verifyAcceptance({
          workspaceRoot: task.workspaceRoot,
          acceptance,
          artifacts: listArtifacts(service, taskId),
        });
        service.store.transaction(() => {
          appendEvent(service.store, taskId, 'task.acceptance', {
            ok: verification.ok,
            failures: verification.failures.slice(0, 8) as unknown as JSONValue,
          });
        });
        if (verification.ok) {
          const gate = deps.learning?.beforeFinalizeSuccess?.(task);
          if (gate && !gate.ok) {
            if (!learningCorrectionUsed) {
              learningCorrectionUsed = true;
              service.appendMessage(taskId, { role: 'user', content: gate.correction });
              continue;
            }
            return finalizeFailed(deps, task, 'CHECKPOINT_NOT_MET', gate.reason);
          }
          return finalizeSucceeded(deps, task, verification.verified.map((v) => v.path));
        }
        if (!correctionUsed) {
          correctionUsed = true;
          service.appendMessage(taskId, { role: 'user', content: correctionMessage(verification.failures) });
          continue;
        }
        return finalizeFailed(deps, task, 'ACCEPTANCE_NOT_MET', verification.failures.map((f) => `${f.path}:${f.code}`).join('; '));
      }
    } finally {
      clearTimeout(abortTimer);
      deps.controllers?.unregister(taskId, abort);
    }
  } finally {
    service.releaseLease(`task:${taskId}`, fencingToken);
  }
}

// ── 单步工具执行（幂等 + 恢复 + M14 副作用审批）─────────────────────

interface ToolCallOutcome {
  conflict?: string;
  progress?: { sig: string };
  /** 工具前终态检查发现任务已在取消流程：不开始新副作用。 */
  cancelled?: boolean;
  /** M14：副作用工具待审批（操作停在 prepared = 请求从未发出，审批后可安全复跑）。 */
  approvalPending?: { approvalId: string; inputHash: string; tool: string };
}

/** M14：inputHash 已有 approved 审批（任务内长效；过期只拦 pending 的决定时刻）。 */
function hasApprovedApproval(service: TaskService, taskId: string, inputHash: string): boolean {
  return !!service.store.db
    .prepare("SELECT id FROM approvals WHERE taskId = ? AND inputHash = ? AND decision = 'approved'")
    .get(taskId, inputHash);
}

/** M14：幂等登记 pending 审批（同 taskId+inputHash 复用；批准绝不来自工具结果/网页文本）。 */
function ensureApprovalRequested(
  deps: AgentLoopDeps,
  task: TaskRecord,
  operationId: string,
  tool: string,
  inputHash: string,
  effect: 'external_write' | 'process',
): string {
  const { service } = deps;
  const existing = service.store.db
    .prepare("SELECT id FROM approvals WHERE taskId = ? AND inputHash = ? AND decision = 'pending'")
    .get(task.id, inputHash) as { id: string } | undefined;
  if (existing) return existing.id;
  const seq = (service.store.db.prepare('SELECT COUNT(*) AS c FROM approvals WHERE taskId = ?').get(task.id) as { c: number }).c;
  const id = `appr:${task.id}:${seq + 1}`;
  const ttlMs = deps.approvalTtlMsFor?.(tool) ?? 1_800_000;
  service.requestApproval({ id, taskId: task.id, operationId, inputHash, effect, ttlMs });
  return id;
}

async function executeToolCall(
  deps: AgentLoopDeps,
  task: TaskRecord,
  call: ToolCall,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<ToolCallOutcome> {
  const { service, tools } = deps;
  const taskId = task.id;
  const operationId = `op:${taskId}:${call.id}`;
  const inputHash = inputHashOf(call.arguments as JSONValue);
  // UI/事件展示：effect 等级 + 脱敏摘要（不随参数变化，仅展示用）。
  const effect = tools.specOf(call.name)?.effect ?? 'read';
  const summary = toolCallSummary(call.name, call.arguments as JSONValue);

  // M07 工具前检查：取消意图已持久化时不开始任何新副作用。
  const stateBefore = service.getTask(taskId)!.state;
  if (stateBefore === 'cancelling' || stateBefore === 'cancelled') return { cancelled: true };

  const feedBack = (content: string): void => {
    if (!hasToolMessage(service, taskId, call.id)) {
      service.appendMessage(taskId, { role: 'tool', content, toolCallId: call.id, name: call.name });
    }
  };

  // 入口不变量：operation 处于 prepared（新建或崩溃遗留 prepared 的安全重试）。
  // M14：MCP 请求只在 transitionOperation('running') 之后才会发出——
  // prepared ⟹ 请求从未发送，审批挂起/崩溃恢复都可安全重驱，重驱时审批门照常复核。
  const executeFresh = async (): Promise<{ content?: string; progress?: { sig: string }; approvalPending?: ToolCallOutcome['approvalPending'] }> => {
    // M14 · 副作用审批门（编排层）：批准前不进入 running（请求绝不发出）。
    // MCP 与 desktop/browser/media 副作用工具统一走这里（approvalInputHash 绑定参数 hash）。
    const spec = tools.specOf(call.name);
    if (spec?.approvalInputHash && (spec.effect === 'external_write' || spec.effect === 'process')) {
      let approvalHash: string;
      if (spec.mcp) {
        let validated: Record<string, JSONValue>;
        try {
          validated = spec.validateArgsFn!(call.arguments as JSONValue);
        } catch (error) {
          const code = error instanceof RuntimeError ? error.code : 'TOOL_ARGS_INVALID';
          service.store.transaction(() => {
            service.transitionOperation(operationId, 'failed', { result: { error: { code, retryable: false } } });
            appendEvent(service.store, taskId, 'task.tool', { callId: call.id, tool: call.name, effect, summary, ok: false, code });
          });
          const content = stableStringify({ error: { code, retryable: false } });
          feedBack(content);
          return { content, progress: { sig: progressSig(call, content) } };
        }
        approvalHash = spec.approvalInputHash(validated);
      } else {
        // 非 MCP 副作用工具：raw args 直接绑定（字段级严格校验在 registry.execute 执行时复核，fail-closed）。
        approvalHash = spec.approvalInputHash(call.arguments as Record<string, JSONValue>);
      }
      if (!hasApprovedApproval(service, taskId, approvalHash)) {
        const approvalId = ensureApprovalRequested(deps, task, operationId, call.name, approvalHash, spec.effect as 'external_write' | 'process');
        return { approvalPending: { approvalId, inputHash: approvalHash, tool: call.name } };
      }
    }

    // M13 · deterministic 检查点 guard（获准硬检查点：不通过则阻断本次操作，模型可纠正）。
    const checkpointBlock = deps.learning?.beforeToolCall?.(task, call);
    if (checkpointBlock) {
      service.store.transaction(() => {
        service.transitionOperation(operationId, 'failed', { result: { error: { code: 'CHECKPOINT_BLOCKED', retryable: false } } });
        appendEvent(service.store, taskId, 'task.tool', { callId: call.id, tool: call.name, effect, summary, ok: false, code: 'CHECKPOINT_BLOCKED' });
      });
      const content = stableStringify({ error: { code: 'CHECKPOINT_BLOCKED', retryable: false, detail: checkpointBlock.blockReason } });
      feedBack(content);
      return { content, progress: { sig: progressSig(call, content) } };
    }

    service.transitionOperation(operationId, 'running');
    const result = await tools.execute(call.id, call.name, call.arguments as JSONValue, {
      taskId,
      workspaceRoot: task.workspaceRoot,
      authorization: deps.authorization,
      operationId,
      signal,
      deadlineAt,
      logger: deps.logger,
      // M14 · 审批门（执行层复核）：即使有人旁路编排层直调 registry，副作用仍被锁。
      hasApproved: (hash) => hasApprovedApproval(service, taskId, hash),
    });
    if (!result.ok && (result.error?.code === 'MCP_RESPONSE_LOST' || (result.error?.code === 'MCP_PROTOCOL_VIOLATION' && spec?.mcp && (spec.effect === 'external_write' || spec.effect === 'process')))) {
      // 请求已发响应丢失（超时/断线/协议违规且是副作用工具）：副作用不确定 =>
      // operation unknown + 任务停车等人工核对（M07 出口），绝不自动重发。
      service.store.transaction(() => {
        service.transitionOperation(operationId, 'unknown');
        appendEvent(service.store, taskId, 'task.operation_needs_review', { callId: call.id, tool: call.name, operationId });
      });
      throw new RuntimeError('RECOVERY_NEEDS_MANUAL_REVIEW', `${call.name} ${call.id}: response lost after request sent; resolve via resolveUnknownOperation`);
    }
    if (result.ok) {
      const parsed = JSON.parse(result.content) as Record<string, JSONValue>;
      service.store.transaction(() => {
        service.transitionOperation(operationId, 'succeeded', { result: parsed });
        // artifact 只能挂到已成功的操作（M03/M04 语义）；登记内容与磁盘实物由验收器复核。
        if (call.name === 'file.write' && typeof parsed.path === 'string' && typeof parsed.sha256 === 'string' && typeof parsed.byteLength === 'number') {
          service.registerArtifact({
            id: randomUUID(),
            taskId,
            operationId,
            relativePath: parsed.path,
            byteLength: parsed.byteLength,
            sha256: parsed.sha256,
          });
        }
        appendEvent(service.store, taskId, 'task.tool', { callId: call.id, tool: call.name, effect, summary, ok: true });
      });
      // M13：硬检查点状态更新（require_prior_read/require_post_verify 的通过判定）。
      deps.learning?.afterToolCall?.(task, call, operationId, true);
    } else {
      service.store.transaction(() => {
        service.transitionOperation(operationId, 'failed', { result: { error: result.error ?? { code: 'TOOL_INTERNAL', retryable: false } } });
        appendEvent(service.store, taskId, 'task.tool', { callId: call.id, tool: call.name, effect, summary, ok: false, code: result.error?.code ?? 'TOOL_INTERNAL' });
      });
    }
    const content = result.ok ? result.content : stableStringify({ error: result.error ?? { code: 'TOOL_INTERNAL', retryable: false } });
    feedBack(content);
    return { content, progress: { sig: progressSig(call, content) } };
  };

  const existing = getOperationByCallId(service, taskId, call.id);
  if (existing) {
    // 同 ID 改 args：冲突，重试不得随机换参数（M03 语义透传）。
    if (existing.inputHash !== inputHash) {
      return { conflict: `callId ${call.id} reused with different args` };
    }
    if (existing.state === 'succeeded' || existing.state === 'failed') {
      // 跨重启去重：同 call+同 args 返回已持久结果，不重复执行工具。
      feedBack(existing.result ?? '');
      return {};
    }
    // 崩溃遗留在 prepared/running/unknown：M07 重启对账（recovery.ts），不假定副作用没发生。
    const reconciled = await reconcileInterruptedOperation(
      { service, tools, authorization: deps.authorization, logger: deps.logger },
      task,
      call,
      existing.id,
      existing.state,
      { feedBack, executeFresh: () => executeFresh() },
    );
    if (reconciled.needsReview) {
      // external_write unknown：任务停下等人工核对，保持非终态（不自动重放、不假装成功）。
      throw new RuntimeError('RECOVERY_NEEDS_MANUAL_REVIEW', `${call.name} ${call.id}: unknown external effect; resolve via resolveUnknownOperation`);
    }
    if (reconciled.approvalPending) return { approvalPending: reconciled.approvalPending };
    return reconciled.progress ? { progress: reconciled.progress } : {};
  }

  service.createOperation({ id: operationId, taskId, callId: call.id, toolName: call.name, input: call.arguments as JSONValue });
  const fresh = await executeFresh();
  if (fresh.approvalPending) return { approvalPending: fresh.approvalPending };
  return { progress: fresh.progress };
}

/** M14：副作用审批挂起：任务 running → waiting_approval 停车（非终态，不写记忆 outbox）；
 *  操作停在 prepared（请求从未发出），approve 后 worker 泵复跑，审批门复核后放行。 */
async function finalizeWaitingApproval(
  deps: AgentLoopDeps,
  task: TaskRecord,
  pending: { approvalId: string; inputHash: string; tool: string },
): Promise<AgentLoopResult> {
  const { service } = deps;
  const taskId = task.id;
  // 取消意图先到：不挂审批，直接走取消终态。
  const current = service.getTask(taskId)!;
  if (current.state === 'cancelling' || current.state === 'cancelled') {
    const outcome = await finalizeCancelled(service, taskId, { flushMemoryOutbox: deps.flushMemoryOutbox });
    return {
      taskId,
      state: 'cancelled',
      errorCode: 'TASK_CANCELLED',
      modelSteps: countRows(service, 'model_calls', taskId),
      toolCalls: countRows(service, 'operations', taskId),
      artifacts: outcome.artifacts,
      finalText: lastAssistantText(service, taskId),
      memoryOutboxPending: service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId),
    };
  }
  service.store.transaction(() => {
    service.transitionTask(taskId, 'waiting_approval', {
      event: {
        type: 'task.approval_requested',
        payload: { approvalId: pending.approvalId, inputHash: pending.inputHash, tool: pending.tool, effect: deps.tools.specOf(pending.tool)?.effect ?? 'external_write', summary: toolCallSummary(pending.tool, null) },
      },
    });
  });
  deps.logger?.(`task ${taskId} waiting_approval: ${pending.tool} approval=${pending.approvalId}`);
  return {
    taskId,
    state: 'waiting_approval',
    errorCode: 'APPROVAL_REQUIRED',
    modelSteps: countRows(service, 'model_calls', taskId),
    toolCalls: countRows(service, 'operations', taskId),
    artifacts: listArtifacts(service, taskId),
    finalText: lastAssistantText(service, taskId),
    memoryOutboxPending: false,
    pendingApproval: pending,
  };
}

async function finalizeSucceeded(deps: AgentLoopDeps, task: TaskRecord, verifiedPaths: string[]): Promise<AgentLoopResult> {
  const { service } = deps;
  const taskId = task.id;
  // M07 写入后终态 CAS：取消意图先到时不许 succeeded 覆盖 cancelling/cancelled。
  const current = service.getTask(taskId)!;
  if (current.state === 'cancelling' || current.state === 'cancelled') {
    const outcome = await finalizeCancelled(service, taskId, { flushMemoryOutbox: deps.flushMemoryOutbox });
    return {
      taskId,
      state: 'cancelled',
      errorCode: 'TASK_CANCELLED',
      modelSteps: countRows(service, 'model_calls', taskId),
      toolCalls: countRows(service, 'operations', taskId),
      artifacts: outcome.artifacts,
      finalText: lastAssistantText(service, taskId),
      memoryOutboxPending: service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId),
    };
  }
  service.store.transaction(() => {
    for (const artifact of listArtifacts(service, taskId)) {
      service.markArtifactVerified(artifact.id);
    }
    service.transitionTask(taskId, 'succeeded', {
      event: {
        type: 'task.succeeded',
        payload: {
          verified: verifiedPaths as unknown as JSONValue,
          artifacts: listArtifacts(service, taskId).length,
          modelSteps: countRows(service, 'model_calls', taskId),
          toolCalls: countRows(service, 'operations', taskId),
        },
      },
    });
    enqueueMemoryOutbox(service, task, 'succeeded', null, deps.memoryOutboxExtra?.(task));
  });
  const delivered = await deliverMemoryOutbox(service, latestMemoryOutbox(service, taskId), deps.flushMemoryOutbox);
  deps.logger?.(`task ${taskId} succeeded (memory outbox ${delivered ? 'done' : 'pending'})`);
  return {
    taskId,
    state: 'succeeded',
    errorCode: null,
    modelSteps: countRows(service, 'model_calls', taskId),
    toolCalls: countRows(service, 'operations', taskId),
    artifacts: listArtifacts(service, taskId),
    finalText: lastAssistantText(service, taskId),
    memoryOutboxPending: !delivered && service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId),
  };
}

async function finalizeFailed(deps: AgentLoopDeps, task: TaskRecord, errorCode: string, detail: string): Promise<AgentLoopResult> {
  const { service } = deps;
  const taskId = task.id;
  // M07 写入后终态 CAS：取消意图先到时不许 failed 覆盖 cancelling/cancelled。
  const current = service.getTask(taskId)!;
  if (current.state === 'cancelling' || current.state === 'cancelled') {
    const outcome = await finalizeCancelled(service, taskId, { flushMemoryOutbox: deps.flushMemoryOutbox });
    return {
      taskId,
      state: 'cancelled',
      errorCode: 'TASK_CANCELLED',
      modelSteps: countRows(service, 'model_calls', taskId),
      toolCalls: countRows(service, 'operations', taskId),
      artifacts: outcome.artifacts,
      finalText: lastAssistantText(service, taskId),
      memoryOutboxPending: service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId),
    };
  }
  service.store.transaction(() => {
    service.transitionTask(taskId, 'failed', {
      errorCode,
      event: { type: 'task.failed', payload: { errorCode, detail: detail.slice(0, 500) } },
    });
    enqueueMemoryOutbox(service, task, 'failed', errorCode, deps.memoryOutboxExtra?.(task));
  });
  const delivered = await deliverMemoryOutbox(service, latestMemoryOutbox(service, taskId), deps.flushMemoryOutbox);
  deps.logger?.(`task ${taskId} failed: ${errorCode} ${detail} (memory outbox ${delivered ? 'done' : 'pending'})`);
  const finalTask = service.getTask(taskId)!;
  return {
    taskId,
    state: 'failed',
    errorCode,
    modelSteps: countRows(service, 'model_calls', taskId),
    toolCalls: countRows(service, 'operations', taskId),
    artifacts: listArtifacts(service, taskId),
    finalText: lastAssistantText(service, taskId),
    memoryOutboxPending: !delivered && service.pendingOutbox(MEMORY_OUTBOX_KIND).some((e) => (e as { taskId?: string }).taskId === taskId),
  };
}

function correctionMessage(failures: VerificationFailure[]): string {
  const lines = failures.slice(0, 8).map((f) => `- ${f.path}: ${f.code}（${f.detail}）`);
  return [
    '验收未通过（以磁盘实物核验为准）：',
    ...lines,
    '请使用可用工具实际完成上述交付，然后用文本汇报。只在文本中声称完成不会被接受。这是唯一一次纠正机会。',
  ].join('\n');
}

/** 昂贵模型升级授权只能来自任务输入的显式策略（任务创建方的可信输入）。 */
function taskAllowsExpensive(input: JSONValue): boolean {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const policy = (input as Record<string, JSONValue>).policy;
    if (policy !== null && typeof policy === 'object' && !Array.isArray(policy)) {
      return (policy as Record<string, JSONValue>).allowExpensive === true;
    }
  }
  return false;
}

function extractGoal(input: JSONValue): string {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const goal = (input as Record<string, JSONValue>).goal;
    if (typeof goal === 'string' && goal.trim()) return goal;
  }
  return stableStringify(input).slice(0, 1000);
}
