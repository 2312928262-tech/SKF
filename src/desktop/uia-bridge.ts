/**
 * M17 · UIA 桥（按 uia-snapshot.md 设计；TS 侧只负责抽象与命令构造）
 *
 * 真实 Windows 实现是独立 Rust helper（src-tauri/src/desktop_bridge.rs）：
 *   - COM 初始化（MTA）、CUIAutomation 实例、ElementFromHandleBuildCache
 *   - 增量广度优先遍历 Control View，按 limits 截断
 *   - helper 加入 Rust 父进程持有的 Job Object（KILL_ON_JOB_CLOSE），父死收树
 *   - 单次请求独立 helper，首版同一桌面会话最多一个采集任务
 *   - 两阶段属性读取：阶段 A 最小元数据，阶段 B 允许的文本（按 textPolicy）
 *
 * TS 侧本文件交付：
 *   - UiaBridge 接口的 FakeUiaBridge 实现（测试用，无副作用；可控窗口列表/快照）
 *   - RealUiaBridge 占位：所有路径抛 UIA_UNAVAILABLE + 解释"Windows helper 未启用"
 *     ——首版不接入真实 UIA（依赖 Windows COM 会话，测试环境不可重现；
 *     真实部署由后续卡位打开），但保留接口契约 + 错误模型让 ToolRegistry 完整联通。
 */

import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../runtime/contracts.js';
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_DEPTH,
  MAX_SNAPSHOT_NODES,
  MAX_WINDOWS_IN_RESULT,
  type UiaBridge,
  type UiaHealthInfo,
  type UiaListOptions,
  type UiaSnapshotNode,
  type UiaSnapshotOptions,
  type UiaSnapshotResult,
  type UiaWindowInfo,
  type UiaInvokeReadOptions,
  type UiaInvokeReadResult,
  type UiaInvokeEffectOptions,
  type UiaInvokeEffectResult,
} from './contracts.js';

// ── RealUiaBridge（Windows 占位；首版不接 Rust helper）──────────────────

export class RealUiaBridge implements UiaBridge {
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
  }

  private ensureWindows(): void {
    if (this.platform !== 'win32') {
      throw new RuntimeError('UIA_UNAVAILABLE', 'uia bridge only available on win32');
    }
  }

  async health(): Promise<UiaHealthInfo> {
    if (this.platform !== 'win32') {
      return { state: 'uia_unavailable', detail: 'platform != win32' };
    }
    // 首版：未启用 Rust helper 时如实汇报，不假装可用。
    return { state: 'uia_unavailable', detail: 'RealUiaBridge not enabled (rust helper pending); use FakeUiaBridge in test/dev' };
  }

  async listWindows(_opts: UiaListOptions): Promise<UiaWindowInfo[]> {
    this.ensureWindows();
    throw new RuntimeError('UIA_UNAVAILABLE', 'RealUiaBridge.listWindows not implemented in first release');
  }

  async snapshot(_opts: UiaSnapshotOptions): Promise<UiaSnapshotResult> {
    this.ensureWindows();
    throw new RuntimeError('UIA_UNAVAILABLE', 'RealUiaBridge.snapshot not implemented in first release');
  }
}

// ── FakeUiaBridge（测试/dev；确定性、可控、零副作用）──────────────────

export interface FakeWindowSpec {
  ephemeralId?: string;
  pid: number;
  title: string;
  className?: string;
  isVisible?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  /** 简化的节点列表：[{controlType, name, children?}]；空数组 = 叶子。 */
  tree?: FakeTreeSpec[];
}

export interface FakeTreeSpec {
  controlType: string;
  name?: string;
  enabled?: boolean;
  offscreen?: boolean;
  children?: FakeTreeSpec[];
}

export class FakeUiaBridge implements UiaBridge {
  private readonly windows: FakeWindowSpec[];
  /** 健康状态（默认 ok；测试可注入 helper_failed / uia_unavailable）。 */
  private healthState: UiaHealthInfo = { state: 'ok', detail: null };
  /** 操作计数器（测试断言调用次数）。 */
  public readonly stats = { list: 0, snapshot: 0, invokeRead: 0, invokeEffect: 0 };
  /** M18：可注入的交互行为（测试用；真实 UiaBridge 走 Rust helper）。 */
  private readonly interactHandler?: FakeInteractHandler;

  constructor(windows: FakeWindowSpec[] = [], interactHandler?: FakeInteractHandler) {
    this.windows = windows;
    this.interactHandler = interactHandler;
  }

  setHealth(state: UiaHealthInfo): void {
    this.healthState = state;
  }

  async health(): Promise<UiaHealthInfo> {
    return this.healthState;
  }

  async listWindows(opts: UiaListOptions, signal?: AbortSignal): Promise<UiaWindowInfo[]> {
    this.stats.list += 1;
    if (signal?.aborted) throw new RuntimeError('TOOL_CANCELLED', 'aborted before listWindows');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('TOOL_CANCELLED', 'aborted during listWindows');
    if (this.healthState.state !== 'ok') {
      throw new RuntimeError(this.mapHealthToCode(this.healthState.state), this.healthState.detail ?? '');
    }
    const visibleOnly = opts.visibleOnly ?? false;
    const restrict = new Set(opts.restrictPids ?? []);
    const limit = Math.min(opts.limit ?? MAX_WINDOWS_IN_RESULT, MAX_WINDOWS_IN_RESULT);
    const out: UiaWindowInfo[] = [];
    for (const w of this.windows) {
      if (restrict.size > 0 && !restrict.has(w.pid)) continue;
      const isVisible = w.isVisible ?? true;
      if (visibleOnly && !isVisible) continue;
      out.push({
        ephemeralId: w.ephemeralId ?? `win-${w.pid}-${out.length}`,
        pid: w.pid,
        title: w.title,
        className: w.className ?? 'Window',
        isVisible,
        rect: w.rect ?? { x: 0, y: 0, width: 800, height: 600 },
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async snapshot(opts: UiaSnapshotOptions, signal?: AbortSignal): Promise<UiaSnapshotResult> {
    this.stats.snapshot += 1;
    const startedAt = Date.now();
    if (signal?.aborted) throw new RuntimeError('TOOL_CANCELLED', 'aborted before snapshot');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('TOOL_CANCELLED', 'aborted during snapshot');
    if (this.healthState.state !== 'ok') {
      throw new RuntimeError(this.mapHealthToCode(this.healthState.state), this.healthState.detail ?? '');
    }
    const win = this.windows.find((w) => (w.ephemeralId ?? `win-${w.pid}-${this.windows.indexOf(w)}`) === opts.ephemeralId);
    if (!win) {
      throw new RuntimeError('TARGET_NOT_FOUND', `window ${opts.ephemeralId} not found`);
    }
    const maxNodes = Math.min(opts.limits?.maxNodes ?? MAX_SNAPSHOT_NODES, MAX_SNAPSHOT_NODES);
    const maxDepth = Math.min(opts.limits?.maxDepth ?? MAX_SNAPSHOT_DEPTH, MAX_SNAPSHOT_DEPTH);
    const maxBytes = Math.min(opts.limits?.maxBytes ?? MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES);
    const textPolicy = opts.textPolicy ?? 'semantic';
    const view = opts.view ?? 'control';

    const nodes: UiaSnapshotNode[] = [];
    let counter = 0;
    let truncated = false;
    let truncationReason: string | null = null;
    const seed = (spec: FakeTreeSpec | undefined, parentId: string | null, depth: number): string | null => {
      if (!spec) return null;
      if (nodes.length >= maxNodes) { truncated = true; truncationReason = truncationReason ?? 'max_nodes'; return null; }
      if (depth > maxDepth) { truncated = true; truncationReason = truncationReason ?? 'max_depth'; return null; }
      const id = `n-${counter++}`;
      const childIds: string[] = [];
      nodes.push({
        id,
        parentId,
        childIds,
        depth,
        controlType: spec.controlType,
        name: nameState(spec.name, textPolicy),
        value: { state: 'not_requested' },
        isEnabled: spec.enabled ?? null,
        isOffscreen: spec.offscreen ?? null,
        readStatus: 'ok',
        childrenState: 'complete',
      });
      for (const child of spec.children ?? []) {
        const childId = seed(child, id, depth + 1);
        if (childId) childIds.push(childId);
        if (nodes.length >= maxNodes) {
          // 把当前节点标 truncated 让 caller 知道还有未读完的后代
          const node = nodes.find((n) => n.id === id);
          if (node) node.childrenState = 'truncated';
          break;
        }
      }
      return id;
    };

    let rootNodeId: string | null = null;
    if (win.tree && win.tree.length > 0) {
      const rootSpec = win.tree[0];
      const rootId = seed(rootSpec, null, 0);
      rootNodeId = rootId;
    }

    // 字节估算（按 JSON 长度逼近；超限则整体退回 partial）。
    const approx = JSON.stringify({ nodes }).length;
    if (approx > maxBytes) {
      truncated = true;
      truncationReason = truncationReason ?? 'max_bytes';
    }

    return {
      schemaVersion: 1,
      snapshotId: randomUUID(),
      capturedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: truncated ? 'partial' : 'ok',
      target: {
        ephemeralId: opts.ephemeralId,
        pid: win.pid,
        title: win.title,
      },
      rootNodeId,
      nodes,
      completeness: {
        reason: truncationReason,
        totalObserved: nodes.length,
        maxNodes,
        maxDepth,
      },
      warnings: [],
    };
  }

  private mapHealthToCode(state: UiaHealthInfo['state']): string {
    switch (state) {
      case 'uia_unavailable':
        return 'UIA_UNAVAILABLE';
      case 'secure_desktop_or_session_unavailable':
        return 'SECURE_DESKTOP_OR_SESSION_UNAVAILABLE';
      case 'helper_failed':
        return 'HELPER_FAILED';
      default:
        return 'UIA_UNAVAILABLE';
    }
  }

  // ── M18 · invokeRead / invokeEffect（可注入行为；无 handler 时默认拒绝）──

  async invokeRead(opts: UiaInvokeReadOptions, signal?: AbortSignal): Promise<UiaInvokeReadResult> {
    this.stats.invokeRead += 1;
    if (signal?.aborted) throw new RuntimeError('TOOL_CANCELLED', 'aborted before invokeRead');
    if (this.healthState.state !== 'ok') {
      throw new RuntimeError(this.mapHealthToCode(this.healthState.state), this.healthState.detail ?? '');
    }
    if (!this.interactHandler) {
      throw new RuntimeError('UIA_UNAVAILABLE', 'no interact handler attached');
    }
    return this.interactHandler.read(opts);
  }

  async invokeEffect(opts: UiaInvokeEffectOptions, signal?: AbortSignal): Promise<UiaInvokeEffectResult> {
    this.stats.invokeEffect += 1;
    if (signal?.aborted) throw new RuntimeError('TOOL_CANCELLED', 'aborted before invokeEffect');
    if (this.healthState.state !== 'ok') {
      throw new RuntimeError(this.mapHealthToCode(this.healthState.state), this.healthState.detail ?? '');
    }
    if (!this.interactHandler) {
      throw new RuntimeError('UIA_UNAVAILABLE', 'no interact handler attached');
    }
    return this.interactHandler.effect(opts);
  }
}

/** M18 · 可注入的交互行为（测试/dev；真实 UiaBridge 走 Rust helper）。 */
export interface FakeInteractHandler {
  read(opts: UiaInvokeReadOptions): Promise<UiaInvokeReadResult>;
  effect(opts: UiaInvokeEffectOptions): Promise<UiaInvokeEffectResult>;
}

function nameState(name: string | undefined, policy: 'structureOnly' | 'semantic'): UiaSnapshotNode['name'] {
  if (name === undefined || name === '') return { state: 'empty' };
  if (policy === 'structureOnly') return { state: 'not_requested' };
  // semantic 策略：原样返回（测试场景无可疑模式；真实实现需要做密钥/路径正则过滤）。
  if (/sk-[a-z0-9]{12,}|password|token/i.test(name)) return { state: 'redacted' };
  return { state: 'present', text: name };
}
