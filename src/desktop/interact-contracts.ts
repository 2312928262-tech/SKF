/**
 * M18 · GUI 有限交互契约（按 gui-interact.md 设计）
 *
 * 与 M17 桌面只读工具并列；本文件定义：
 *   - 不可变执行计划（Plan）模型
 *   - 三层窗口指纹（identityFingerprint / stateFingerprint / contextFingerprint）
 *   - 审批参数 hash（approvalInputHashOf）
 *   - 派发屏障状态机（PENDING → DISPATCH_RESERVED → CALL_RETURNED → POST_VERIFIED）
 *   - 动作原语枚举（UIA Pattern 集合）
 *
 * 持久化：execution_plans 表（runtime.sqlite migration v5），
 * 字段 planId / workspaceRoot / windowFingerprint / stepsJson / approvalInputHash /
 *        currentStepIndex / status / createdAt / expiresAt / consumedBy。
 *
 * 命名空间：与 M17 一致（desktop.* / clipboard.* 不与 file.* / mcp/* 重名）；
 * M18 新增 desktop.interact.{observe,prepare,execute,status,cancel,reconcile} 六个 ToolSpec。
 *
 * 审批纪律（gui-interact.md 第 7 节）：
 *   approvalInputHash = SHA256("SKF.desktop.interact.approval" || version || canonical(binding))
 *   其中 binding = 协议版本 + 适配器版本 + 窗口指纹 + 序列 + 输入承诺 + 风险 + 限制 + 展示摘要。
 *
 * 红线：密钥不允许作为 desktop.interact 的输入（API Key / 密码 / 私钥 / 恢复码 / 令牌等）；
 * schema 校验阶段拒收（不是 warn 也不是过滤，是 INPUT_INVALID 直接拒绝）。
 */

import { createHash } from 'node:crypto';
import type { JSONValue } from '../runtime/contracts.js';

// ── 动作原语（gui-interact.md 4.1-4.2 表）──────────────────────────────

export const INTERACT_PRIMITIVES = [
  'observe.window',          // 只读：读窗口身份 + 受限 UIA 树
  'assert.window',           // 只读：验证窗口指纹与上下文
  'assert.element',          // 只读：验证目标唯一存在及属性约束
  'assert.state',            // 只读：验证适配器声明的状态契约
  'wait.state',              // 只读：等待一个已批准的状态出现（有限超时，不派发）
  'window.activate',         // 副作用：受限窗口激活
  'element.focus',           // 副作用：SetFocus
  'button.invoke',           // 副作用：InvokePattern（按钮或白名单控件）
  'input.set_value',         // 副作用：ValuePattern.SetValue（确切值，默认禁止追加/拼接）
  'toggle.set',              // 副作用：TogglePattern（绑定目标状态 + 批准转换次数）
  'item.select',             // 副作用：SelectionItemPattern（首版只允许明确单项选择）
  'container.expand',        // 副作用：ExpandCollapsePattern
  'container.collapse',      // 副作用：ExpandCollapsePattern
  'item.scroll_into_view',   // 副作用：ScrollItemPattern（仅定位已确定元素，不用于探索）
  'menu.invoke_item',        // 副作用：组合展开→选择→调用
] as const;
export type InteractPrimitive = (typeof INTERACT_PRIMITIVES)[number];

/** 副作用原语集合（其余为只读原语）。 */
export const INTERACT_EFFECT_PRIMITIVES: ReadonlySet<InteractPrimitive> = new Set<InteractPrimitive>([
  'window.activate', 'element.focus', 'button.invoke', 'input.set_value',
  'toggle.set', 'item.select', 'container.expand', 'container.collapse',
  'item.scroll_into_view', 'menu.invoke_item',
]);

// ── 风险等级 ────────────────────────────────────────────────────────────

export const INTERACT_RISKS = ['read', 'low', 'standard', 'publish'] as const;
export type InteractRisk = (typeof INTERACT_RISKS)[number];

/** publish 类必须单独即时审批（gui-interact.md 7.4）；不能继承普通长序列授权。 */
export const INTERACT_PUBLISH_PRIMITIVES: ReadonlySet<InteractPrimitive> = new Set<InteractPrimitive>([
  'button.invoke', // 仅当调用目标被适配器标为 publish 动作（如发送/发布/支付）
]);

// ── 执行计划（不可变）───────────────────────────────────────────────────

export interface InteractPlan {
  /** 计划 ID（SKF 分配，不采信客户端自报）。 */
  planId: string;
  /** 协议版本。 */
  schemaVersion: 1;
  /** 创建时间（ISO）。 */
  createdAt: string;
  /** 过期时间（ISO）。审批后未在 expiresAt 前执行 = EXPIRED。 */
  expiresAt: string;
  /** 适配器 ID（SKF 分配）。首版 = 'builtin'。 */
  adapterId: string;
  /** 适配器版本。 */
  adapterVersion: string;
  /** 目标窗口指纹（hash，已规范化编码）。 */
  windowFingerprint: string;
  /** 审批展示摘要（供 UI 展示）。 */
  displaySummary: string;
  /** 计划动作序列（不可变）。 */
  steps: readonly InteractStep[];
  /** 风险等级。 */
  risk: InteractRisk;
  /** 是否包含 publish 类动作。 */
  containsPublish: boolean;
  /** 总超时（ms，含 dispatch + post-verify）。 */
  totalTimeoutMs: number;
  /** 单步硬超时（ms）。 */
  perStepTimeoutMs: number;
  /** 完整审批 hash。 */
  approvalHash: string;
  /** 防重放 nonce。 */
  nonce: string;
}

export interface InteractStep {
  /** 步骤 ID（plan 内稳定）。 */
  stepId: string;
  /** 序号（0-based）。 */
  index: number;
  /** 动作原语。 */
  primitive: InteractPrimitive;
  /** 目标选择器（适配器声明；运行时唯一解析）。 */
  selector: InteractSelector;
  /** 输入承诺（确切值；HMAC 仅低熵敏感内容；密钥不接受）。 */
  inputCommit: InteractInputCommit;
  /** 前置条件（断言表达式，按适配器声明验证）。 */
  preconditions: readonly string[];
  /** 过渡条件（动作期间允许的状态变化集合）。 */
  transitionAllow: readonly string[];
  /** 后置条件（动作完成后必须满足）。 */
  postconditions: readonly string[];
  /** 风险等级（覆盖 plan.risk 的特殊情况，如按钮 invoke 触发布）。 */
  riskOverride?: InteractRisk;
  /** 该步超时不超 perStepTimeoutMs。 */
  stepTimeoutMs?: number;
}

export interface InteractSelector {
  /** 选择器类型（adapter-defined；首版 = 'automationId' / 'name' / 'path'）。 */
  type: 'automationId' | 'name' | 'path';
  value: string;
  /** 必经的祖先锚点（控件类型）。 */
  ancestorControlType?: string;
  /** 必须存在的兄弟语义锚点。 */
  siblingAnchors?: ReadonlyArray<{ controlType: string; name?: string }>;
  /** 必须满足的可用性约束。 */
  mustBeEnabled?: boolean;
}

export type InteractInputCommit =
  | { kind: 'none' }
  | { kind: 'text'; value: string; /** 是否经 HMAC 承诺（低熵敏感内容如账户 ID）。 */ hmac?: boolean }
  | { kind: 'state'; value: 'on' | 'off' | 'toggle'; toggleCount?: number };

// ── 窗口指纹（gui-interact.md 5）────────────────────────────────────────

export interface WindowIdentityFingerprint {
  /** 当前 Windows 用户 SID。 */
  userSid: string;
  /** SKF 本次运行实例随机 ID。 */
  skfInstanceId: string;
  /** 进程 PID。 */
  pid: number;
  /** 进程创建时间（ms epoch）。 */
  processStartedAt: number;
  /** 可执行文件规范路径。 */
  executablePath: string;
  /** 可执行文件 sha256（Hex lower；空 = 未核对）。 */
  executableSha256: string;
  /** 签名验证结果（unsigned / valid / invalid / unknown）。 */
  signatureState: 'unsigned' | 'valid' | 'invalid' | 'unknown';
  /** 发布者（Common Name）。 */
  publisher: string;
  /** 进程完整性级别。 */
  integrityLevel: 'low' | 'medium' | 'high' | 'system' | 'unknown';
  /** 顶层窗口 HWND（首版不直接保存，仅 ephemeralId）。 */
  topLevelHwnd: string;
  /** 窗口类名。 */
  windowClass: string;
  /** UIA 框架 ID。 */
  uiaFrameworkId: string;
}

export interface WindowStateFingerprint {
  /** 受保护 UIA 子树 sha256（规范化编码后）。 */
  protectedSubtreeHash: string;
  /** 关键业务上下文（账户、文档、工作区、收件人、金额等）。 */
  businessContext: ReadonlyArray<{ key: string; redactedValue: string; state: 'present' | 'redacted' | 'unavailable' }>;
  /** 模态状态。 */
  modalState: 'none' | 'modal' | 'modeless';
  /** 焦点归属（前台应用类名；如不可知 = 'unknown'）。 */
  focusOwner: string;
}

export interface WindowContextFingerprint {
  /** BoundingRectangle。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 显示器 ID（首版 = 'unknown'）。 */
  displayId: string;
  /** DPI（首版 = 96 默认）。 */
  dpi: number;
  /** 会话状态。 */
  sessionState: 'console' | 'rdp' | 'locked' | 'unknown';
}

export interface WindowFingerprint {
  identity: WindowIdentityFingerprint;
  state: WindowStateFingerprint;
  context: WindowContextFingerprint;
  /** 指纹规则版本（hash 包含此字段）。 */
  ruleVersion: string;
}

/** 计算 windowFingerprint = SHA256(domain || version || canonical(...)) */
export function windowFingerprintHashOf(fp: WindowFingerprint): string {
  const canonical = stableCanonical(fp);
  return createHash('sha256')
    .update('SKF.desktop.interact.fingerprint' + '|' + fp.ruleVersion + '|' + canonical, 'utf8')
    .digest('hex');
}

// ── 审批 hash ──────────────────────────────────────────────────────────

/** 审批绑定对象（与 gui-interact.md 7.1 表对齐）。 */
export interface InteractApprovalBinding {
  schemaVersion: number;
  adapterId: string;
  adapterVersion: string;
  windowFingerprint: string;
  /** 步骤数与步骤摘要（仅元数据，不含原文）。 */
  stepCount: number;
  stepSummaries: ReadonlyArray<{ index: number; primitive: string; risk: string; hasInputText: boolean }>;
  risk: InteractRisk;
  containsPublish: boolean;
  totalTimeoutMs: number;
  perStepTimeoutMs: number;
  /** 一次性的 nonce + SKF 实例 + 用户 + session。 */
  nonce: string;
  skfInstanceId: string;
  userSid: string;
  sessionId: string;
  /** 任务 ID + 上游审批上下文。 */
  taskId: string;
  /** 展示文案（不可信数据，仅供人类阅读，不入 hash 密钥部分）。 */
  displaySummary: string;
}

/** 计算 approvalInputHash = SHA256("SKF.desktop.interact.approval" || version || canonical(binding)) */
export function interactApprovalHashOf(binding: InteractApprovalBinding): string {
  const canonical = stableCanonical(binding);
  return createHash('sha256')
    .update('SKF.desktop.interact.approval' + '|1|' + canonical, 'utf8')
    .digest('hex');
}

// ── 派发屏障状态机（gui-interact.md 8.2）───────────────────────────────

export const DISPATCH_BARRIER_STATES = [
  'PENDING',           // 已记账，未进入派发路径
  'DISPATCH_RESERVED', // 已持久派发屏障，调用即将发出
  'CALL_RETURNED',     // 调用返回（成功/失败/超时/未确定）
  'POST_VERIFIED',     // 后置条件验证完成（成功/失败有充分证据）
] as const;
export type DispatchBarrierState = (typeof DISPATCH_BARRIER_STATES)[number];

export const DISPATCH_TRANSITIONS: Readonly<Record<DispatchBarrierState, readonly DispatchBarrierState[]>> = {
  PENDING: ['DISPATCH_RESERVED', 'CALL_RETURNED', 'POST_VERIFIED'], // 准备未发出可直接跳到 POST_VERIFIED（来自准备验证）
  DISPATCH_RESERVED: ['CALL_RETURNED'],
  CALL_RETURNED: ['POST_VERIFIED'],
  POST_VERIFIED: [],
};

// ── 执行状态机 ──────────────────────────────────────────────────────────

export const EXECUTION_STATES = [
  'PREPARED',            // 计划已记账，待审批
  'AWAITING_APPROVAL',   // 副作用需审批，未决
  'APPROVED',            // 已审批，可执行
  'RUNNING',             // 正在执行
  'SUCCEEDED',           // 全部动作成功
  'STOPPED_CHANGED',     // 界面/上下文偏离契约
  'EXPIRED',             // 授权或计划过期
  'CANCELLED',           // 取消后续动作
  'FAILED_NOT_DISPATCHED', // 已证明当前动作未派发
  'FAILED_VERIFIED',     // 业务失败（含已知部分副作用）
  'UNKNOWN',             // 动作可能发生，无法确认结果
  'RECOVERY_REQUIRED',   // 需人工核对
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

// ── 错误码白名单（M18）──────────────────────────────────────────────────

export const INTERACT_PUBLIC_ERROR_CODES = [
  'INTERACT_PLAN_NOT_FOUND',
  'INTERACT_PLAN_EXPIRED',
  'INTERACT_INVALID_PRIMITIVE',
  'INTERACT_INVALID_SELECTOR',
  'INTERACT_INVALID_INPUT',
  'INTERACT_SECRET_INPUT_FORBIDDEN',
  'INTERACT_WINDOW_FINGERPRINT_MISMATCH',
  'INTERACT_ELEMENT_NOT_UNIQUE',
  'INTERACT_ELEMENT_NOT_FOUND',
  'INTERACT_STATE_VIOLATION',
  'INTERACT_DISPATCH_BARRIER_FAILED',
  'INTERACT_TIMEOUT',
  'INTERACT_CANCELLED',
  'INTERACT_PUBLISH_REQUIRES_SEPARATE_APPROVAL',
  'INTERACT_DISPATCH_LOST',
  'INTERACT_RECOVERY_REQUIRED',
  'INTERACT_ADAPTER_NOT_REGISTERED',
  'INTERACT_ADAPTER_VERSION_CHANGED',
] as const;
export type InteractPublicErrorCode = (typeof INTERACT_PUBLIC_ERROR_CODES)[number];

// ── 工具 stable 序列化（不允许 undefined/函数；对象键排序）────────────

function stableCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite in canonical');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stableCanonical).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableCanonical(obj[k])).join(',') + '}';
  }
  throw new Error(`unsupported type in canonical: ${typeof value}`);
}

/** 简单密钥模式检测（与 M17 snapshot 脱敏同源；非完备）。 */
const SECRET_PATTERN = /^(sk-[a-z0-9]{8,}|ghp_[a-z0-9]{16,}|gho_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|password\s*[:=]\s*\S{4,}|token\s*[:=]\s*\S{8,}|secret\s*[:=]\s*\S{8,})/i;

/** 校验输入承诺不含裸密钥；返回 { ok: false, reason } 当疑似密钥时。 */
export function validateInputCommitNotSecret(text: string): { ok: true } | { ok: false; reason: string } {
  if (typeof text !== 'string' || text.length === 0) return { ok: true };
  if (SECRET_PATTERN.test(text)) {
    return { ok: false, reason: 'input looks like a secret/private key/token; use a dedicated auth flow instead' };
  }
  return { ok: true };
}

/** Helper：把 plan 转 JSONValue（账本序列化）。 */
export function planToJsonValue(plan: InteractPlan): JSONValue {
  return JSON.parse(JSON.stringify(plan)) as JSONValue;
}
