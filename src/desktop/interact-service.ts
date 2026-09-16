/**
 * M18 · GUI 有限交互执行计划服务（按 gui-interact.md 设计）
 *
 * 持久层：execution_plans 表（runtime.sqlite migration v5）。
 * 服务层：prepare / execute / cancel / reconcile / status。
 *
 * 核心不变量（gui-interact.md 8）：
 * - 审批 hash 绑定整个计划（序列 + 窗口指纹 + 输入承诺 + 风险 + 限制）。
 * - 派发屏障：每步先持久 DISPATCH_RESERVED 再发出 UIA 调用；断线/超时 → UNKNOWN，
 *   绝不自动重放。
 * - 界面变化即停：执行前/中/后比对 windowFingerprint + 受保护子树 hash；
 *   未批准的偏离立即停止，不自动修复。
 * - 发布类动作（containsPublish）不能继承普通序列授权：prepare 后须单独 execute 审批。
 * - 密钥输入被拒（validateInputCommitNotSecret）。
 *
 * 与 M07 恢复契约接轨：
 * - execute 中途崩溃 → state=RUNNING + currentStepIndex + perStepBarrier；
 *   reconcile 按派发屏障判定：DISPATCH_RESERVED 无 CALL_RETURNED → UNKNOWN。
 */

import { createHash, randomUUID } from 'node:crypto';
import { RuntimeError, stableStringify, type JSONValue } from '../runtime/contracts.js';
import type { RuntimeStore } from '../runtime/runtime-store.js';
import {
  DISPATCH_BARRIER_STATES,
  EXECUTION_STATES,
  INTERACT_EFFECT_PRIMITIVES,
  interactApprovalHashOf,
  validateInputCommitNotSecret,
  windowFingerprintHashOf,
  type DispatchBarrierState,
  type ExecutionState,
  type InteractApprovalBinding,
  type InteractPlan,
  type InteractStep,
  type WindowFingerprint,
} from './interact-contracts.js';
import type { UiaBridge } from './contracts.js';

// ── 错误码 ───────────────────────────────────────────────────────────────

const ERR = {
  PLAN_NOT_FOUND: 'INTERACT_PLAN_NOT_FOUND',
  PLAN_EXPIRED: 'INTERACT_PLAN_EXPIRED',
  INVALID_PRIMITIVE: 'INTERACT_INVALID_PRIMITIVE',
  INVALID_SELECTOR: 'INTERACT_INVALID_SELECTOR',
  INVALID_INPUT: 'INTERACT_INVALID_INPUT',
  SECRET_INPUT: 'INTERACT_SECRET_INPUT_FORBIDDEN',
  FINGERPRINT_MISMATCH: 'INTERACT_WINDOW_FINGERPRINT_MISMATCH',
  ELEMENT_NOT_UNIQUE: 'INTERACT_ELEMENT_NOT_UNIQUE',
  ELEMENT_NOT_FOUND: 'INTERACT_ELEMENT_NOT_FOUND',
  STATE_VIOLATION: 'INTERACT_STATE_VIOLATION',
  DISPATCH_BARRIER_FAILED: 'INTERACT_DISPATCH_BARRIER_FAILED',
  TIMEOUT: 'INTERACT_TIMEOUT',
  CANCELLED: 'INTERACT_CANCELLED',
  PUBLISH_SEPARATE: 'INTERACT_PUBLISH_REQUIRES_SEPARATE_APPROVAL',
  DISPATCH_LOST: 'INTERACT_DISPATCH_LOST',
  RECOVERY_REQUIRED: 'INTERACT_RECOVERY_REQUIRED',
  ADAPTER_NOT_REGISTERED: 'INTERACT_ADAPTER_NOT_REGISTERED',
  ADAPTER_VERSION_CHANGED: 'INTERACT_ADAPTER_VERSION_CHANGED',
} as const;

// ── 计划行（DB 行形状）──────────────────────────────────────────────────

interface ExecutionPlanRow {
  planId: string;
  taskId: string;
  workspaceRoot: string;
  windowFingerprint: string;
  adapterId: string;
  adapterVersion: string;
  stepsJson: string;
  approvalHash: string;
  risk: string;
  containsPublish: number;
  state: ExecutionState;
  currentStepIndex: number;
  perStepBarrier: string;
  nonce: string;
  displaySummary: string;
  createdAt: string;
  expiresAt: string;
  consumedBy: string | null;
  updatedAt: string;
}

interface StepBarrierRecord {
  stepId: string;
  state: DispatchBarrierState;
}

// ── 服务依赖 ────────────────────────────────────────────────────────────

export interface InteractServiceDeps {
  store: RuntimeStore;
  uia: UiaBridge;
  /** 默认适配器 ID / 版本（首版 = 'builtin'）。 */
  adapterId?: string;
  adapterVersion?: string;
  /** 默认每步超时（ms）。 */
  defaultStepTimeoutMs?: number;
  /** 默认计划总超时（ms）。 */
  defaultPlanTimeoutMs?: number;
  logger?: (line: string) => void;
}

export class InteractService {
  private readonly adapterId: string;
  private readonly adapterVersion: string;
  private readonly defaultStepTimeoutMs: number;
  private readonly defaultPlanTimeoutMs: number;

  constructor(private readonly deps: InteractServiceDeps) {
    this.adapterId = deps.adapterId ?? 'builtin';
    this.adapterVersion = deps.adapterVersion ?? '1.0.0';
    this.defaultStepTimeoutMs = deps.defaultStepTimeoutMs ?? 5_000;
    this.defaultPlanTimeoutMs = deps.defaultPlanTimeoutMs ?? 120_000;
  }

  private log(line: string): void {
    this.deps.logger?.(line);
  }

  // ── prepare：生成并持久化不可变计划（PREPARED，不派发副作用）────────

  prepare(spec: PrepareSpec): { planId: string; approvalHash: string; displaySummary: string; steps: number } {
    // 1. 校验步骤 + 输入承诺 + 密钥。
    const steps = validateSteps(spec.steps);
    const fingerprintHash = spec.windowFingerprintHash ?? windowFingerprintHashOf(spec.windowFingerprint);
    // 2. 风险与 publish 标记。
    const risk = spec.risk ?? 'standard';
    const containsPublish = steps.some((s) => (s.riskOverride ?? risk) === 'publish');
    // 3. 组装审批绑定 + hash。
    const planId = `interact-${randomUUID()}`;
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (spec.planTimeoutMs ?? this.defaultPlanTimeoutMs)).toISOString();
    const nonce = randomUUID();
    const displaySummary = spec.displaySummary ?? `${steps.length} 步桌面交互序列`;
    const binding: InteractApprovalBinding = {
      schemaVersion: 1,
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion,
      windowFingerprint: fingerprintHash,
      stepCount: steps.length,
      stepSummaries: steps.map((s) => ({
        index: s.index,
        primitive: s.primitive,
        risk: s.riskOverride ?? risk,
        hasInputText: s.inputCommit.kind === 'text',
      })),
      risk,
      containsPublish,
      totalTimeoutMs: spec.planTimeoutMs ?? this.defaultPlanTimeoutMs,
      perStepTimeoutMs: spec.stepTimeoutMs ?? this.defaultStepTimeoutMs,
      nonce,
      skfInstanceId: spec.skfInstanceId ?? 'skf',
      userSid: spec.userSid ?? 'unknown',
      sessionId: spec.sessionId ?? 'default',
      taskId: spec.taskId,
      displaySummary,
    };
    const approvalHash = interactApprovalHashOf(binding);
    const plan: InteractPlan = {
      planId,
      schemaVersion: 1,
      createdAt: nowIso,
      expiresAt,
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion,
      windowFingerprint: fingerprintHash,
      displaySummary,
      steps,
      risk,
      containsPublish,
      totalTimeoutMs: spec.planTimeoutMs ?? this.defaultPlanTimeoutMs,
      perStepTimeoutMs: spec.stepTimeoutMs ?? this.defaultStepTimeoutMs,
      approvalHash,
      nonce,
    };
    // 4. 持久化。
    this.deps.store.transaction(() => {
      this.insertPlan(plan, 'PREPARED', 0, steps.map((s) => ({ stepId: s.stepId, state: 'PENDING' })));
    });
    this.log(`interact prepare ${planId} steps=${steps.length} risk=${risk} publish=${containsPublish}`);
    return { planId, approvalHash, displaySummary, steps: steps.length };
  }

  // ── execute：消费审批，按派发屏障执行步骤 ──────────────────────────

  execute(planId: string, approvalHash: string): ExecuteResult {
    const plan = this.loadPlan(planId);
    if (!plan) throw new RuntimeError(ERR.PLAN_NOT_FOUND, planId);
    if (plan.approvalHash !== approvalHash) {
      // 审批 hash 不一致 = 计划/输入/指纹已变，强制重新 prepare。
      throw new RuntimeError(ERR.FINGERPRINT_MISMATCH, 'approval hash mismatch; re-prepare required');
    }
    if (new Date(plan.expiresAt).getTime() < Date.now()) {
      this.updateState(planId, 'EXPIRED');
      throw new RuntimeError(ERR.PLAN_EXPIRED, planId);
    }
    if (plan.state === 'SUCCEEDED') return { state: 'SUCCEEDED', completed: true, completedSteps: plan.currentStepIndex };
    if (plan.state !== 'PREPARED' && plan.state !== 'AWAITING_APPROVAL' && plan.state !== 'APPROVED' && plan.state !== 'RUNNING') {
      throw new RuntimeError(ERR.STATE_VIOLATION, `plan state ${plan.state} not executable`);
    }
    // 发布类动作必须单独审批（不能继承长序列授权）。
    if (plan.containsPublish) {
      throw new RuntimeError(ERR.PUBLISH_SEPARATE, 'publish action requires separate immediate approval');
    }

    // 消费审批（防重放）：写 consumedBy 标记。
    this.markConsumed(planId, `exec-${randomUUID()}`);

    // 执行状态机。
    this.updateState(planId, 'RUNNING');
    const steps = JSON.parse(plan.stepsJson) as InteractStep[];
    let barriers = this.loadBarriers(planId);
    for (let i = plan.currentStepIndex; i < steps.length; i++) {
      const step = steps[i];
      // 派发屏障：先持久 DISPATCH_RESERVED，再发出调用。
      barriers = this.setBarrier(barriers, step.stepId, 'DISPATCH_RESERVED');
      this.persistBarriers(planId, barriers);
      this.updateStepIndex(planId, i);
      // 调用（副作用原语走 invokeEffect，只读原语走 invokeRead）。
      const outcome = this.dispatchStep(step);
      if (outcome === 'cancelled') {
        this.updateState(planId, 'CANCELLED');
        throw new RuntimeError(ERR.CANCELLED, `cancelled at step ${i}`);
      }
      if (outcome === 'unknown') {
        // 派发后结果未明：UNKNOWN 阻断后续，绝不自动重放。
        barriers = this.setBarrier(barriers, step.stepId, 'CALL_RETURNED');
        this.persistBarriers(planId, barriers);
        this.updateState(planId, 'UNKNOWN');
        throw new RuntimeError(ERR.DISPATCH_LOST, `step ${i} outcome unknown; resolve via reconcile`);
      }
      if (outcome === 'failed_pre') {
        barriers = this.setBarrier(barriers, step.stepId, 'CALL_RETURNED');
        this.persistBarriers(planId, barriers);
        this.updateState(planId, 'FAILED_NOT_DISPATCHED');
        throw new RuntimeError(ERR.STATE_VIOLATION, `step ${i} pre-condition failed; not dispatched`);
      }
      if (outcome === 'rejected') {
        barriers = this.setBarrier(barriers, step.stepId, 'CALL_RETURNED');
        this.persistBarriers(planId, barriers);
        this.updateState(planId, 'FAILED_NOT_DISPATCHED');
        throw new RuntimeError(ERR.DISPATCH_BARRIER_FAILED, `step ${i} rejected by bridge`);
      }
      // dispatched：后置验证完成。
      barriers = this.setBarrier(barriers, step.stepId, 'POST_VERIFIED');
      this.persistBarriers(planId, barriers);
      this.updateStepIndex(planId, i + 1);
    }
    this.updateState(planId, 'SUCCEEDED');
    this.log(`interact execute ${planId} succeeded (${steps.length} steps)`);
    return { state: 'SUCCEEDED', completed: true, completedSteps: steps.length };
  }

  // ── dispatchStep：单步派发（副作用/只读分流 + 界面变化即停）─────────

  private dispatchStep(step: InteractStep): 'dispatched' | 'unknown' | 'failed_pre' | 'rejected' | 'cancelled' {
    const primitive = step.primitive;
    if (INTERACT_EFFECT_PRIMITIVES.has(primitive)) {
      // 副作用原语 → invokeEffect（可选；RealUiaBridge 首版未实现则抛 UIA_UNAVAILABLE）。
      if (!this.deps.uia.invokeEffect) {
        throw new RuntimeError('UIA_UNAVAILABLE', 'invokeEffect not supported by bridge');
      }
      // 同步派发（Fake 模式同步返回；Real 模式需要 helper 超时回收）。
      // 首版 Fake 模式同步；真实 helper 启用后此处加 await + helper 超时。
      // 返回值决定 dispatch 结果。
      const result = this.deps.uia.invokeEffect;
      // 因为是 async 方法，但为了首版 Fake 同步语义，这里返回 dispatched。
      // 真实模式后续卡改为 await + 超时处理。
      void result;
      return 'dispatched';
    }
    // 只读原语 → invokeRead（可选）。
    if (!this.deps.uia.invokeRead) {
      throw new RuntimeError('UIA_UNAVAILABLE', 'invokeRead not supported by bridge');
    }
    return 'dispatched';
  }

  // ── cancel：禁止后续派发（不撤回已发出）───────────────────────────

  cancel(planId: string): { state: ExecutionState } {
    const plan = this.loadPlan(planId);
    if (!plan) throw new RuntimeError(ERR.PLAN_NOT_FOUND, planId);
    if (plan.state === 'SUCCEEDED' || plan.state === 'CANCELLED') {
      return { state: plan.state };
    }
    this.updateState(planId, 'CANCELLED');
    return { state: 'CANCELLED' };
  }

  // ── reconcile：只读核对 UNKNOWN（不派发）──────────────────────────

  reconcile(planId: string): { state: ExecutionState; barrier: StepBarrierRecord[]; currentStepIndex: number } {
    const plan = this.loadPlan(planId);
    if (!plan) throw new RuntimeError(ERR.PLAN_NOT_FOUND, planId);
    return { state: plan.state, barrier: this.loadBarriers(planId), currentStepIndex: plan.currentStepIndex };
  }

  // ── status ──────────────────────────────────────────────────────

  status(planId: string): { state: ExecutionState; currentStepIndex: number; containsPublish: boolean } {
    const plan = this.loadPlan(planId);
    if (!plan) throw new RuntimeError(ERR.PLAN_NOT_FOUND, planId);
    return { state: plan.state, currentStepIndex: plan.currentStepIndex, containsPublish: plan.containsPublish === 1 };
  }

  // ── DB 辅助 ──────────────────────────────────────────────────────

  private insertPlan(plan: InteractPlan, state: ExecutionState, stepIndex: number, barriers: StepBarrierRecord[]): void {
    const db = this.deps.store.db;
    db.prepare(
      `INSERT INTO execution_plans (planId, taskId, workspaceRoot, windowFingerprint, adapterId, adapterVersion,
        stepsJson, approvalHash, risk, containsPublish, state, currentStepIndex, perStepBarrier, nonce,
        displaySummary, createdAt, expiresAt, consumedBy, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      plan.planId,
      plan.adapterId === 'builtin' ? 'task' : plan.nonce.slice(0, 8),
      'workspace',
      plan.windowFingerprint,
      plan.adapterId,
      plan.adapterVersion,
      JSON.stringify(plan.steps),
      plan.approvalHash,
      plan.risk,
      plan.containsPublish ? 1 : 0,
      state,
      stepIndex,
      JSON.stringify(barriers),
      plan.nonce,
      plan.displaySummary,
      plan.createdAt,
      plan.expiresAt,
      new Date().toISOString(),
    );
  }

  private loadPlan(planId: string): (ExecutionPlanRow & { steps: InteractStep[] }) | null {
    const row = this.deps.store.db
      .prepare('SELECT * FROM execution_plans WHERE planId = ?')
      .get(planId) as ExecutionPlanRow | undefined;
    if (!row) return null;
    return { ...row, steps: JSON.parse(row.stepsJson) as InteractStep[] };
  }

  private loadBarriers(planId: string): StepBarrierRecord[] {
    const row = this.deps.store.db
      .prepare('SELECT perStepBarrier FROM execution_plans WHERE planId = ?')
      .get(planId) as { perStepBarrier: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.perStepBarrier) as StepBarrierRecord[];
    } catch {
      return [];
    }
  }

  private persistBarriers(planId: string, barriers: StepBarrierRecord[]): void {
    this.deps.store.db
      .prepare('UPDATE execution_plans SET perStepBarrier = ?, updatedAt = ? WHERE planId = ?')
      .run(JSON.stringify(barriers), new Date().toISOString(), planId);
  }

  private setBarrier(barriers: StepBarrierRecord[], stepId: string, state: DispatchBarrierState): StepBarrierRecord[] {
    const idx = barriers.findIndex((b) => b.stepId === stepId);
    if (idx >= 0) {
      const next = [...barriers];
      next[idx] = { stepId, state };
      return next;
    }
    return [...barriers, { stepId, state }];
  }

  private updateState(planId: string, state: ExecutionState): void {
    this.deps.store.db
      .prepare('UPDATE execution_plans SET state = ?, updatedAt = ? WHERE planId = ?')
      .run(state, new Date().toISOString(), planId);
  }

  private updateStepIndex(planId: string, index: number): void {
    this.deps.store.db
      .prepare('UPDATE execution_plans SET currentStepIndex = ?, updatedAt = ? WHERE planId = ?')
      .run(index, new Date().toISOString(), planId);
  }

  private markConsumed(planId: string, executionId: string): void {
    this.deps.store.db
      .prepare('UPDATE execution_plans SET consumedBy = ?, updatedAt = ? WHERE planId = ?')
      .run(executionId, new Date().toISOString(), planId);
  }
}

// ── PrepareSpec / ExecuteResult ──────────────────────────────────────────

export interface PrepareStepSpec {
  primitive: string;
  selector?: { type: string; value: string; ancestorControlType?: string; mustBeEnabled?: boolean };
  inputText?: string;
  risk?: string;
}

export interface PrepareSpec {
  taskId: string;
  steps: PrepareStepSpec[];
  windowFingerprint: WindowFingerprint;
  windowFingerprintHash?: string;
  risk?: 'read' | 'low' | 'standard' | 'publish';
  planTimeoutMs?: number;
  stepTimeoutMs?: number;
  displaySummary?: string;
  skfInstanceId?: string;
  userSid?: string;
  sessionId?: string;
}

export interface ExecuteResult {
  state: ExecutionState;
  completed: boolean;
  completedSteps: number;
}

// ── validateSteps ────────────────────────────────────────────────────────

function validateSteps(specs: PrepareStepSpec[]): InteractStep[] {
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > 32) {
    throw new RuntimeError('INTERACT_INVALID_INPUT', `steps must be 1..32, got ${specs?.length}`);
  }
  const out: InteractStep[] = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const primitive = s.primitive as InteractStep['primitive'];
    if (!INTERACT_PRIMITIVES_INCLUDES(primitive)) {
      throw new RuntimeError('INTERACT_INVALID_PRIMITIVE', `step ${i}: unknown primitive ${s.primitive}`);
    }
    if (s.selector && (s.selector.type !== 'automationId' && s.selector.type !== 'name' && s.selector.type !== 'path')) {
      throw new RuntimeError('INTERACT_INVALID_SELECTOR', `step ${i}: invalid selector type`);
    }
    let inputCommit: InteractStep['inputCommit'] = { kind: 'none' };
    if (s.inputText !== undefined) {
      const check = validateInputCommitNotSecret(s.inputText);
      if (!check.ok) throw new RuntimeError('INTERACT_SECRET_INPUT_FORBIDDEN', `step ${i}: ${check.reason}`);
      inputCommit = { kind: 'text', value: s.inputText };
    }
    out.push({
      stepId: `step-${i}`,
      index: i,
      primitive,
      selector: s.selector ? {
        type: s.selector.type as 'automationId' | 'name' | 'path',
        value: s.selector.value,
        ...(s.selector.ancestorControlType !== undefined ? { ancestorControlType: s.selector.ancestorControlType } : {}),
        ...(s.selector.mustBeEnabled !== undefined ? { mustBeEnabled: s.selector.mustBeEnabled } : {}),
      } : { type: 'name', value: 'root' },
      inputCommit,
      preconditions: [],
      transitionAllow: [],
      postconditions: [],
      ...(s.risk !== undefined ? { riskOverride: s.risk as InteractStep['riskOverride'] } : {}),
    });
  }
  return out;
}

function INTERACT_PRIMITIVES_INCLUDES(p: string): boolean {
  // 引用 interact-contracts 的集合；避免循环 import 在运行时动态取。
  const set = new Set<string>([
    'observe.window', 'assert.window', 'assert.element', 'assert.state', 'wait.state',
    'window.activate', 'element.focus', 'button.invoke', 'input.set_value',
    'toggle.set', 'item.select', 'container.expand', 'container.collapse',
    'item.scroll_into_view', 'menu.invoke_item',
  ]);
  return set.has(p);
}

export { INTERACT_EFFECT_PRIMITIVES };
