/**
 * M18 · GUI 有限交互 ToolSpec 装配（按 gui-interact.md）
 *
 * 六个子操作（ToolRegistry 命名空间 desktop.interact.*）：
 *   desktop.interact.prepare    read           生成不可变执行计划（不副作用），返回 planId + approvalHash
 *   desktop.interact.execute    external_write  消费审批执行计划（所有桌面变更 = E/P 副作用，须审批）
 *   desktop.interact.status     read           查询计划执行状态
 *   desktop.interact.cancel     read           禁止后续派发（不撤回已发出）
 *   desktop.interact.reconcile  read           只读核对 UNKNOWN（不派发）
 *   desktop.interact.observe    read           只读取窗口身份/受保护子树（为 prepare 提供指纹依据）
 *
 * 审批 hash = interactApprovalHashOf(binding)；execute 必须 hasApproved(hash)。
 * 发布类动作（containsPublish）在 prepare 阶段不拒绝，但 execute 阶段强制单独审批
 * （不能继承普通长序列授权）——由 InteractService.execute 抛 INTERACT_PUBLISH_REQUIRES_SEPARATE_APPROVAL。
 */

import { RuntimeError, type Effect, type JSONValue } from '../runtime/contracts.js';
import type { ToolSpec } from '../tools/registry.js';
import { interactApprovalHashOf, type InteractApprovalBinding, type WindowFingerprint } from './interact-contracts.js';
import { InteractService, type PrepareSpec } from './interact-service.js';

export interface InteractToolDeps {
  service: InteractService;
  /** 当前窗口指纹解析器（observe 用）；首版由调用方注入 fake 实现。 */
  resolveFingerprint?: (ephemeralId: string) => WindowFingerprint | null;
}

export function buildInteractTools(deps: InteractToolDeps): ToolSpec[] {
  return [
    buildPrepare(deps),
    buildExecute(deps),
    buildStatus(deps),
    buildCancel(deps),
    buildReconcile(deps),
    buildObserve(deps),
  ];
}

// ── desktop.interact.prepare ─────────────────────────────────────────────

function buildPrepare(deps: InteractToolDeps): ToolSpec {
  return {
    name: 'desktop.interact.prepare',
    effect: 'read',
    description: 'Compile an immutable desktop interaction plan from a bounded action sequence (no side effects). Returns planId + approvalHash.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['steps'],
      properties: {
        steps: { type: 'array', items: { type: 'object' }, maxItems: 32 },
        risk: { type: 'string', enum: ['read', 'low', 'standard', 'publish'] },
        planTimeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        stepTimeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
        displaySummary: { type: 'string', maxLength: 500 },
      },
    },
    fields: {
      steps: { kind: 'json', required: true, maxBytes: 32_768 },
      risk: { kind: 'string', required: false, maxLength: 16, enum: ['read', 'low', 'standard', 'publish'] },
      planTimeoutMs: { kind: 'integer', required: false, min: 1000, max: 600000 },
      stepTimeoutMs: { kind: 'integer', required: false, min: 100, max: 60000 },
      displaySummary: { kind: 'string', required: false, maxLength: 500 },
    },
    run: async (args) => {
      const stepsRaw = args.steps;
      if (!Array.isArray(stepsRaw)) throw new RuntimeError('INTERACT_INVALID_INPUT', 'steps must be array');
      const steps = stepsRaw.map((raw) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new RuntimeError('INTERACT_INVALID_INPUT', 'step must be object');
        }
        const s = raw as Record<string, JSONValue>;
        return {
          primitive: String(s.primitive ?? ''),
          ...(s.selector !== null && s.selector !== undefined && typeof s.selector === 'object'
            ? { selector: s.selector as unknown as PrepareSpec['steps'][number]['selector'] }
            : {}),
          ...(typeof s.inputText === 'string' ? { inputText: s.inputText } : {}),
          ...(typeof s.risk === 'string' ? { risk: s.risk } : {}),
        };
      });
      const fingerprint = deps.resolveFingerprint
        ? deps.resolveFingerprint('foreground')
        : null;
      if (!fingerprint) throw new RuntimeError('INTERACT_INVALID_INPUT', 'window fingerprint required for prepare');
      const result = deps.service.prepare({
        taskId: 'task-interact',
        steps,
        windowFingerprint: fingerprint,
        ...(typeof args.risk === 'string' ? { risk: args.risk as PrepareSpec['risk'] } : {}),
        ...(typeof args.planTimeoutMs === 'number' ? { planTimeoutMs: args.planTimeoutMs } : {}),
        ...(typeof args.stepTimeoutMs === 'number' ? { stepTimeoutMs: args.stepTimeoutMs } : {}),
        ...(typeof args.displaySummary === 'string' ? { displaySummary: args.displaySummary } : {}),
      });
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

// ── desktop.interact.execute ─────────────────────────────────────────────

function buildExecute(deps: InteractToolDeps): ToolSpec {
  return {
    name: 'desktop.interact.execute',
    effect: 'external_write',
    description: 'Consume a prior approval and execute the exact approved plan (bounded action sequence). Side effect; requires approval bound to plan hash.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['planId', 'approvalHash'],
      properties: {
        planId: { type: 'string', maxLength: 256 },
        approvalHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
    fields: {
      planId: { kind: 'string', required: true, maxLength: 256 },
      approvalHash: { kind: 'string', required: true, maxLength: 64, pattern: '^[a-f0-9]{64}$' },
    },
    approvalInputHash: (validated) => String(validated.approvalHash),
    run: async (args) => {
      const result = deps.service.execute(String(args.planId), String(args.approvalHash));
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

// ── desktop.interact.status ──────────────────────────────────────────────

function buildStatus(deps: InteractToolDeps): ToolSpec {
  return {
    name: 'desktop.interact.status',
    effect: 'read',
    description: 'Query execution state of an interact plan.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['planId'],
      properties: { planId: { type: 'string', maxLength: 256 } },
    },
    fields: { planId: { kind: 'string', required: true, maxLength: 256 } },
    run: async (args) => {
      const result = deps.service.status(String(args.planId));
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

// ── desktop.interact.cancel ──────────────────────────────────────────────

function buildCancel(deps: InteractToolDeps): ToolSpec {
  return {
    name: 'desktop.interact.cancel',
    effect: 'read',
    description: 'Forbid further dispatch of a plan (does not retract already-issued calls).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['planId'],
      properties: { planId: { type: 'string', maxLength: 256 } },
    },
    fields: { planId: { kind: 'string', required: true, maxLength: 256 } },
    run: async (args) => {
      const result = deps.service.cancel(String(args.planId));
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

// ── desktop.interact.reconcile ───────────────────────────────────────────

function buildReconcile(deps: InteractToolDeps): ToolSpec {
  return {
    name: 'desktop.interact.reconcile',
    effect: 'read',
    description: 'Read-only reconciliation of an UNKNOWN plan (inspect dispatch barrier without dispatching).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['planId'],
      properties: { planId: { type: 'string', maxLength: 256 } },
    },
    fields: { planId: { kind: 'string', required: true, maxLength: 256 } },
    run: async (args) => {
      const result = deps.service.reconcile(String(args.planId));
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

// ── desktop.interact.observe ─────────────────────────────────────────────

function buildObserve(deps: InteractToolDeps): ToolSpec {
  return {
    name: 'desktop.interact.observe',
    effect: 'read',
    description: 'Read window identity and protected subtree for a given window (no side effects).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ephemeralId'],
      properties: {
        ephemeralId: { type: 'string', maxLength: 256 },
        maxNodes: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
    fields: {
      ephemeralId: { kind: 'string', required: true, maxLength: 256 },
      maxNodes: { kind: 'integer', required: false, min: 1, max: 500 },
    },
    run: async (args) => {
      const fingerprint = deps.resolveFingerprint
        ? deps.resolveFingerprint(String(args.ephemeralId))
        : null;
      if (!fingerprint) throw new RuntimeError('INTERACT_ELEMENT_NOT_FOUND', `window ${args.ephemeralId} not found`);
      return {
        content: { fingerprint: fingerprint as unknown as JSONValue, available: true },
        artifactIds: [],
      };
    },
  };
}
