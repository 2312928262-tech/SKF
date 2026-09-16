/**
 * M17 · 桌面工具层契约（按 uia-snapshot.md / gui-interact.md 改造）
 *
 * 命名空间：所有桌面工具命名 `desktop.*` 或 `clipboard.*`，
 * 不会与 file.* / mcp/* 重名（ToolRegistry.register 拒绝重复）。
 *
 * effect 分级（与 EFFECT 系统统一）：
 *   - desktop.windows     → read         只读窗口列表，模型可默认调用
 *   - desktop.snapshot    → read         只读 UIA 快照，模型可默认调用
 *   - clipboard.read      → read         读剪贴板，模型可默认调用
 *   - clipboard.write     → external_write 写剪贴板 = 跨应用副作用，必须审批
 *   - desktop.launch      → process      启动进程 = 高风险副作用，必须审批
 *
 * 命名规则：长度 ≤ 64；不允许空名/控制字符；点号不在名称中段避免误解析。
 */

import { createHash } from 'node:crypto';
import type { Effect, JSONValue } from '../runtime/contracts.js';

export const DESKTOP_TOOL_NAMES = [
  'desktop.windows',
  'desktop.snapshot',
  'clipboard.read',
  'clipboard.write',
  'desktop.launch',
] as const;

export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

export const DESKTOP_TOOL_EFFECT: Readonly<Record<DesktopToolName, Effect>> = {
  'desktop.windows': 'read',
  'desktop.snapshot': 'read',
  'clipboard.read': 'read',
  'clipboard.write': 'external_write',
  'desktop.launch': 'process',
};

/** 工具命名正则（与 mcp/* 风格一致；首字符小写字母或 c/d 其次小写，长度 ≤ 64）。 */
export const DESKTOP_TOOL_NAME_PATTERN = /^(desktop|clipboard)\.[a-z][a-z0-9_-]{0,62}$/;

/** 进程启动白名单：每个 launch 工具调用须指定 executableName（仅白名单内的可启动）。 */
export const LAUNCH_WHITELIST: readonly string[] = [
  // 默认全部为空——按部署场景由 SKF_DATA_DIR/config/desktop-launch.json 注入。
  // 保留此常量是占位，防止后期忘了"白名单不可空"的不变量。
];

export const MAX_WINDOWS_IN_RESULT = 100;
export const MAX_SNAPSHOT_NODES = 500;
export const MAX_SNAPSHOT_DEPTH = 12;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_CLIPBOARD_TEXT_BYTES = 64 * 1024;
export const MAX_LAUNCH_ARGS = 32;
export const MAX_LAUNCH_ARG_BYTES = 1024;

/** UIA 桥抽象接口（Windows 真机实现见 uia-bridge.ts#RealUiaBridge；测试用 FakeUiaBridge）。 */
export interface UiaBridge {
  /** 列前台顶层窗口（限 PID 范围 + 自身进程排除 + 标题非空）。 */
  listWindows(opts: UiaListOptions, signal?: AbortSignal): Promise<UiaWindowInfo[]>;
  /** 取指定窗口的 UIA 快照。 */
  snapshot(opts: UiaSnapshotOptions, signal?: AbortSignal): Promise<UiaSnapshotResult>;
  /** 检查桥本身是否可用（COM/会话/前台可读）。 */
  health(): Promise<UiaHealthInfo>;
  /** M18：执行只读动作原语（observe/assert/wait），不派发副作用。 */
  invokeRead?(opts: UiaInvokeReadOptions, signal?: AbortSignal): Promise<UiaInvokeReadResult>;
  /** M18：执行副作用动作原语（invoke/set_value/focus/...）。 */
  invokeEffect?(opts: UiaInvokeEffectOptions, signal?: AbortSignal): Promise<UiaInvokeEffectResult>;
}

export interface UiaListOptions {
  /** 限定进程 PID 集合；空 = 不限制（仍排除自身 SKF 进程）。 */
  restrictPids?: number[];
  /** 仅返回有可见标题的窗口。 */
  visibleOnly?: boolean;
  /** 最大返回数（≤ MAX_WINDOWS_IN_RESULT）。 */
  limit?: number;
}

export interface UiaWindowInfo {
  /** 进程内稳定的窗口 ID（不持久；同进程重启失效）。 */
  ephemeralId: string;
  pid: number;
  /** 窗口标题（已经过最浅脱敏；空字符串保留）。 */
  title: string;
  className: string;
  isVisible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface UiaSnapshotOptions {
  ephemeralId: string;
  /** view = control（默认）/ content；raw 不开放。 */
  view?: 'control' | 'content';
  textPolicy?: 'structureOnly' | 'semantic';
  /** 节点/深度/总字节软上限（≤ 系统硬上限）。 */
  limits?: { maxNodes?: number; maxDepth?: number; maxBytes?: number };
}

export interface UiaSnapshotNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  depth: number;
  controlType: string;
  name: { state: 'present' | 'empty' | 'redacted' | 'not_requested'; text?: string };
  /** 默认 not_requested；fieldValues 文本策略下允许读非敏感值（首版未开放给 agent）。 */
  value: { state: 'present' | 'empty' | 'redacted' | 'not_requested'; text?: string };
  isEnabled: boolean | null;
  isOffscreen: boolean | null;
  readStatus: 'ok' | 'partial' | 'unavailable';
  childrenState: 'complete' | 'truncated' | 'unknown';
}

export interface UiaSnapshotResult {
  schemaVersion: 1;
  snapshotId: string;
  capturedAt: string;
  durationMs: number;
  status: 'ok' | 'partial' | 'error';
  target: { ephemeralId: string; pid: number; title: string };
  rootNodeId: string | null;
  nodes: UiaSnapshotNode[];
  completeness: {
    reason: string | null;
    totalObserved: number;
    maxNodes: number;
    maxDepth: number;
  };
  warnings: string[];
}

export interface UiaHealthInfo {
  /** "ok" = helper 可用；其他为不可用原因（code + 是否可重试）。 */
  state: 'ok' | 'uia_unavailable' | 'secure_desktop_or_session_unavailable' | 'helper_failed';
  detail: string | null;
}

// ── M18 · UIA 动作原语桥（invokeRead / invokeEffect）──────────────────

export interface UiaSelectorSpec {
  type: 'automationId' | 'name' | 'path';
  value: string;
  ancestorControlType?: string;
  siblingAnchors?: ReadonlyArray<{ controlType: string; name?: string }>;
  mustBeEnabled?: boolean;
}

export interface UiaInvokeReadOptions {
  ephemeralId: string;
  primitive: 'observe.window' | 'assert.window' | 'assert.element' | 'assert.state' | 'wait.state';
  selector?: UiaSelectorSpec;
  timeoutMs?: number;
}

export interface UiaInvokeReadResult {
  matched: number;
  summary?: {
    observed: ReadonlyArray<{ controlType: string; name?: string; isEnabled?: boolean | null }>;
  };
  assertionState?: 'ok' | 'mismatch';
  detail: string | null;
  durationMs: number;
}

export interface UiaInvokeEffectOptions {
  ephemeralId: string;
  primitive:
    | 'window.activate' | 'element.focus' | 'button.invoke' | 'input.set_value'
    | 'toggle.set' | 'item.select' | 'container.expand' | 'container.collapse'
    | 'item.scroll_into_view' | 'menu.invoke_item';
  selector: UiaSelectorSpec;
  inputValue?: string;
  timeoutMs?: number;
}

export interface UiaInvokeEffectResult {
  /** 'dispatched' = 已发出 + 后置条件满足；'dispatched_no_post_verify' = 已发出但 post 条件未明；
   *  'failed_pre' = 前置条件失败未发出；'rejected' = 被桥拒绝（无权限/不可用等）。 */
  status: 'dispatched' | 'dispatched_no_post_verify' | 'failed_pre' | 'rejected';
  detail: string | null;
  durationMs: number;
  postSummary?: {
    observed: ReadonlyArray<{ controlType: string; name?: string; isEnabled?: boolean | null }>;
  };
}

/** 剪贴板抽象（同上：RealClipboard / FakeClipboard）。 */
export interface ClipboardBridge {
  readText(): Promise<ClipboardReadResult>;
  writeText(text: string): Promise<ClipboardWriteResult>;
  health(): Promise<ClipboardHealthInfo>;
}

export interface ClipboardReadResult {
  /** 'ok' | 'empty' | 'unavailable'。 */
  status: 'ok' | 'empty' | 'unavailable';
  /** 状态=ok 时为字符串内容；empty/unavailable 时为空串。 */
  text: string;
  byteLength: number;
}

export interface ClipboardWriteResult {
  /** 'ok' | 'unavailable'。 */
  status: 'ok' | 'unavailable';
  byteLength: number;
}

export interface ClipboardHealthInfo {
  state: 'ok' | 'unavailable';
  detail: string | null;
}

/** launch 抽象（白名单 + 参数 hash 审批；不在白名单的 executable 拒收）。 */
export interface LaunchBridge {
  /** 启动白名单内的可执行程序；调用方提供 args + cwd + env。 */
  launch(opts: LaunchOptions): Promise<LaunchResult>;
  health(): Promise<LaunchHealthInfo>;
}

export interface LaunchOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  /** 是否将进程 detach（首版默认 false：SKF 退出时由 helper 收树）。 */
  detached?: boolean;
}

export interface LaunchResult {
  /** 'started' | 'denied' | 'failed'。 */
  status: 'started' | 'denied' | 'failed';
  pid: number | null;
  detail: string | null;
}

export interface LaunchHealthInfo {
  state: 'ok' | 'no_whitelist';
  detail: string | null;
  whitelistSize: number;
}

/** 所有桌面工具 inputSchema 共用整型 schema helper（与 ipc-v2.ts 风格一致）。 */
export type DesktopFieldSpec =
  | { kind: 'string'; required?: boolean; maxLength?: number; enum?: readonly string[]; pattern?: string }
  | { kind: 'integer'; required?: boolean; min?: number; max?: number }
  | { kind: 'boolean'; required?: boolean };

/** 工具输入载荷的稳定序列化（用于审批 hash 绑定）。 */
export function approvalInputHashOf(toolName: string, args: JSONValue): string {
  // 工具全名 + 规范化参数，保证 hash 与 args 一一对应（用于审批绑定）。
  // 输入参数应为稳定 JSON（由 ToolRegistry 校验阶段保证）。
  return createHash('sha256').update(`${toolName}:` + JSON.stringify(args), 'utf8').digest('hex');
}
