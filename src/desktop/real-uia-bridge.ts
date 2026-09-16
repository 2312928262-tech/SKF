/**
 * M26 · 真实 Windows UIA 桥（RealUiaBridge）
 *
 * 用 C# 原生助手（scripts/uia-helper/UiaHelper.cs → bin/UiaHelper.exe）经
 * JobLauncher（bin/JobLauncher.exe，Job Object KILL_ON_JOB_CLOSE）托管执行：
 *   - 请求以 base64 走 argv[1] 传入（避免 stdin EOF 与 JobLauncher 中继竞态 + 中文编码）。
 *   - 响应为一行 UTF-8 JSON，经 JobLauncher stdout 中继回 TS。
 *   - 硬超时：SKF 直接 kill JobLauncher → Job Object 关闭 → 助手整树回收（M07 纪律）。
 *   - helper 失败/超时/输出非法 → HELPER_FAILED / UIA_UNAVAILABLE / TARGET_NOT_FOUND，
 *     绝不假装成功。
 *
 * 审批门不变：本桥只负责 UIA 采集与受限动作原语；effect 分级、审批 hash 绑定、
 * 派发屏障、unknown 不重放全部在 ToolRegistry / InteractService 层（M17/M18）不动。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../runtime/contracts.js';
import type {
  UiaBridge,
  UiaHealthInfo,
  UiaListOptions,
  UiaSnapshotOptions,
  UiaSnapshotResult,
  UiaWindowInfo,
  UiaInvokeReadOptions,
  UiaInvokeReadResult,
  UiaInvokeEffectOptions,
  UiaInvokeEffectResult,
} from './contracts.js';

export interface RealUiaBridgeOptions {
  /** UiaHelper.exe 绝对路径。 */
  helperPath: string;
  /** JobLauncher.exe 绝对路径（Windows Job Object 进程树托管）。 */
  launcherPath: string;
  /** 默认硬超时（ms）；snapshot 单设更长。 */
  timeoutMs?: number;
  logger?: (line: string) => void;
}

export class RealUiaBridge implements UiaBridge {
  private readonly helperPath: string;
  private readonly launcherPath: string;
  private readonly timeoutMs: number;
  private readonly logger?: (line: string) => void;

  constructor(opts: RealUiaBridgeOptions) {
    this.helperPath = opts.helperPath;
    this.launcherPath = opts.launcherPath;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.logger = opts.logger;
  }

  private log(line: string): void {
    this.logger?.(line);
  }

  /** 单次调用：JobLauncher -- UiaHelper <base64(req)> → 解析 JSON 响应。 */
  private runCommand(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const b64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      let child;
      try {
        // stdin 保持 open（pipe 且不写不 end）：JobLauncher 把 stdin EOF 视为"父进程失联"，
        // 但本桥请求经 argv base64 传入，不需要 stdin；保持打开避免触发 parentLost。
        child = spawn(this.launcherPath, ['--', this.helperPath, b64], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new RuntimeError('HELPER_FAILED', 'spawn failed: ' + (err instanceof Error ? err.message : String(err))));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          try { child.kill(); } catch { /* 已退出 */ }
          reject(new RuntimeError('HELPER_FAILED', `uia helper timeout after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => {
        finish(() => reject(new RuntimeError('HELPER_FAILED', 'spawn error: ' + err.message)));
      });
      child.on('close', (code) => {
        finish(() => {
          try { child.stdin?.end(); } catch { /* 已关闭 */ }
          if (code !== 0) {
            reject(new RuntimeError('HELPER_FAILED', `uia helper exited ${code}: ${stderr.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(stdout);
            resolve(parsed as Record<string, unknown>);
          } catch {
            reject(new RuntimeError('HELPER_FAILED', `invalid helper output: ${stdout.slice(0, 200)}`));
          }
        });
      });
    });
  }

  private mapHealthError(state: string): UiaHealthInfo {
    if (state === 'ok') return { state: 'ok', detail: null };
    if (state === 'uia_unavailable') return { state: 'uia_unavailable', detail: 'UIA COM unavailable' };
    if (state === 'secure_desktop_or_session_unavailable') return { state: 'secure_desktop_or_session_unavailable', detail: 'secure desktop or session unavailable' };
    return { state: 'helper_failed', detail: 'helper reported ' + state };
  }

  async health(): Promise<UiaHealthInfo> {
    if (process.platform !== 'win32') return { state: 'uia_unavailable', detail: 'platform != win32' };
    try {
      const res = await this.runCommand({ command: 'health' }, 5_000);
      const state = String(res.state ?? 'helper_failed');
      return this.mapHealthError(state);
    } catch (err) {
      return { state: 'helper_failed', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async listWindows(opts: UiaListOptions, signal?: AbortSignal): Promise<UiaWindowInfo[]> {
    if (signal?.aborted) throw new RuntimeError('UIA_UNAVAILABLE', 'aborted');
    const res = await this.runCommand({
      command: 'list-windows',
      ...(opts.restrictPids !== undefined ? { restrictPids: opts.restrictPids } : {}),
      ...(opts.visibleOnly !== undefined ? { visibleOnly: opts.visibleOnly } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      excludePids: [process.pid],
    }, this.timeoutMs);
    this.throwIfError(res);
    const windows = (res.windows as Array<Record<string, unknown>>) ?? [];
    return windows.map((w) => ({
      ephemeralId: String(w.ephemeralId ?? ''),
      pid: Number(w.pid ?? 0),
      title: String(w.title ?? ''),
      className: String(w.className ?? 'Window'),
      isVisible: w.isVisible === true,
      rect: {
        x: Number((w.rect as Record<string, unknown>)?.x ?? 0),
        y: Number((w.rect as Record<string, unknown>)?.y ?? 0),
        width: Number((w.rect as Record<string, unknown>)?.width ?? 0),
        height: Number((w.rect as Record<string, unknown>)?.height ?? 0),
      },
    }));
  }

  async snapshot(opts: UiaSnapshotOptions, signal?: AbortSignal): Promise<UiaSnapshotResult> {
    if (signal?.aborted) throw new RuntimeError('UIA_UNAVAILABLE', 'aborted');
    const res = await this.runCommand({
      command: 'snapshot',
      ephemeralId: opts.ephemeralId,
      ...(opts.view !== undefined ? { view: opts.view } : {}),
      ...(opts.textPolicy !== undefined ? { textPolicy: opts.textPolicy } : {}),
      ...(opts.limits !== undefined ? {
        maxNodes: opts.limits.maxNodes,
        maxDepth: opts.limits.maxDepth,
        maxBytes: opts.limits.maxBytes,
      } : {}),
    }, this.timeoutMs * 2);
    this.throwIfError(res);
    const nodes = (res.nodes as Array<Record<string, unknown>>) ?? [];
    const status = res.status === 'partial' ? 'partial' : res.status === 'error' ? 'error' : 'ok';
    const target = (res.target as Record<string, unknown>) ?? {};
    const completeness = (res.completeness as Record<string, unknown>) ?? {};
    return {
      schemaVersion: 1,
      snapshotId: randomUUID(),
      capturedAt: new Date().toISOString(),
      durationMs: Number(res.durationMs ?? 0),
      status,
      target: {
        ephemeralId: String(target.ephemeralId ?? opts.ephemeralId),
        pid: Number(target.pid ?? 0),
        title: String(target.title ?? ''),
      },
      rootNodeId: res.rootNodeId !== null && res.rootNodeId !== undefined ? String(res.rootNodeId) : null,
      nodes: nodes.map((n) => {
        const nn = (n.name as { state?: string; text?: string } | undefined) ?? { state: 'not_requested' };
        const nameState = (['present', 'empty', 'redacted', 'not_requested'].includes(String(nn.state))
          ? String(nn.state)
          : 'not_requested') as 'present' | 'empty' | 'redacted' | 'not_requested';
        return {
          id: String(n.id ?? ''),
          parentId: n.parentId !== null && n.parentId !== undefined ? String(n.parentId) : null,
          childIds: (n.childIds as Array<unknown> ?? []).map(String),
          depth: Number(n.depth ?? 0),
          controlType: String(n.controlType ?? 'Unknown'),
          name: { state: nameState, ...(nn.text !== undefined ? { text: String(nn.text) } : {}) },
          value: { state: 'not_requested' } as { state: 'present' | 'empty' | 'redacted' | 'not_requested'; text?: string },
          isEnabled: n.isEnabled === undefined || n.isEnabled === null ? null : n.isEnabled === true,
          isOffscreen: n.isOffscreen === undefined || n.isOffscreen === null ? null : n.isOffscreen === true,
          readStatus: (['ok', 'partial', 'unavailable'].includes(String(n.readStatus)) ? String(n.readStatus) : 'ok') as 'ok' | 'partial' | 'unavailable',
          childrenState: (['complete', 'truncated', 'unknown'].includes(String(n.childrenState)) ? String(n.childrenState) : 'complete') as 'complete' | 'truncated' | 'unknown',
        };
      }),
      completeness: {
        reason: completeness.reason !== null && completeness.reason !== undefined ? String(completeness.reason) : null,
        totalObserved: Number(completeness.totalObserved ?? nodes.length),
        maxNodes: Number(completeness.maxNodes ?? 0),
        maxDepth: Number(completeness.maxDepth ?? 0),
      },
      warnings: (res.warnings as Array<unknown> ?? []).map(String),
    };
  }

  async invokeRead(opts: UiaInvokeReadOptions, signal?: AbortSignal): Promise<UiaInvokeReadResult> {
    if (signal?.aborted) throw new RuntimeError('UIA_UNAVAILABLE', 'aborted');
    const res = await this.runCommand({
      command: 'invoke-read',
      ephemeralId: opts.ephemeralId,
      primitive: opts.primitive,
      ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    }, this.timeoutMs);
    this.throwIfError(res);
    const summary = (res.summary as Array<Record<string, unknown>>) ?? [];
    return {
      matched: Number(res.matched ?? 0),
      summary: {
        observed: summary.map((s) => ({
          controlType: String(s.controlType ?? ''),
          name: s.name !== undefined ? String(s.name) : undefined,
          isEnabled: s.isEnabled === undefined || s.isEnabled === null ? null : s.isEnabled === true,
        })),
      },
      assertionState: res.assertionState === 'ok' ? 'ok' : 'mismatch',
      detail: res.detail !== null && res.detail !== undefined ? String(res.detail) : null,
      durationMs: Number(res.durationMs ?? 0),
    };
  }

  async invokeEffect(opts: UiaInvokeEffectOptions, signal?: AbortSignal): Promise<UiaInvokeEffectResult> {
    if (signal?.aborted) throw new RuntimeError('UIA_UNAVAILABLE', 'aborted');
    const res = await this.runCommand({
      command: 'invoke-effect',
      ephemeralId: opts.ephemeralId,
      primitive: opts.primitive,
      selector: opts.selector,
      ...(opts.inputValue !== undefined ? { inputValue: opts.inputValue } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    }, this.timeoutMs);
    this.throwIfError(res);
    const status = res.status as string;
    const postSummary = (res.postSummary as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      status: (['dispatched', 'dispatched_no_post_verify', 'failed_pre', 'rejected'].includes(status) ? status : 'rejected') as UiaInvokeEffectResult['status'],
      detail: res.detail !== null && res.detail !== undefined ? String(res.detail) : null,
      durationMs: Number(res.durationMs ?? 0),
      ...(postSummary.length > 0 ? {
        postSummary: {
          observed: postSummary.map((s) => ({
            controlType: String(s.controlType ?? ''),
            name: s.name !== undefined ? String(s.name) : undefined,
            isEnabled: s.isEnabled === undefined || s.isEnabled === null ? null : s.isEnabled === true,
          })),
        },
      } : {}),
    };
  }

  private throwIfError(res: Record<string, unknown>): void {
    if (res.error) {
      const e = res.error as Record<string, unknown>;
      const code = String(e.code ?? 'HELPER_FAILED');
      const detail = String(e.detail ?? '');
      const mapped = code === 'TARGET_NOT_FOUND' ? 'TARGET_NOT_FOUND' : code === 'UIA_UNAVAILABLE' ? 'UIA_UNAVAILABLE' : 'HELPER_FAILED';
      throw new RuntimeError(mapped, detail);
    }
  }
}
