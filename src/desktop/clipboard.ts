/**
 * M17 · 剪贴板桥
 *
 * 真实 Windows 实现：通过 node-addon 或子进程调 OS API（OpenClipboard / SetClipboardData）；
 * 首版不接 RealUiaBridge 同样的策略——占位 + Fake。
 *
 * 接口严格分离 readText / writeText：read 是 read 工具，write 是 external_write（跨应用共享），
 * 必须走 M14 已有的 hasApproved(inputHash) 审批门。
 */

import { RuntimeError } from '../runtime/contracts.js';
import { MAX_CLIPBOARD_TEXT_BYTES, type ClipboardBridge, type ClipboardHealthInfo, type ClipboardReadResult, type ClipboardWriteResult } from './contracts.js';

// ── RealClipboard（Windows 占位；首版未启用）───────────────────────────

export class RealClipboardBridge implements ClipboardBridge {
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
  }

  private ensureWindows(): void {
    if (this.platform !== 'win32') throw new RuntimeError('CLIPBOARD_UNAVAILABLE', 'clipboard bridge only available on win32');
  }

  async health(): Promise<ClipboardHealthInfo> {
    if (this.platform !== 'win32') return { state: 'unavailable', detail: 'platform != win32' };
    return { state: 'unavailable', detail: 'RealClipboardBridge not enabled (windows helper pending); use FakeClipboardBridge in test/dev' };
  }

  async readText(): Promise<ClipboardReadResult> {
    this.ensureWindows();
    throw new RuntimeError('CLIPBOARD_UNAVAILABLE', 'RealClipboardBridge.readText not implemented in first release');
  }

  async writeText(_text: string): Promise<ClipboardWriteResult> {
    this.ensureWindows();
    throw new RuntimeError('CLIPBOARD_UNAVAILABLE', 'RealClipboardBridge.writeText not implemented in first release');
  }
}

// ── FakeClipboardBridge（测试/dev；进程内存储；零 OS 副作用）──────────

export class FakeClipboardBridge implements ClipboardBridge {
  private content: string = '';
  public readonly stats = { read: 0, write: 0 };

  /** 强制健康状态（默认 ok）。 */
  constructor(private readonly healthState: ClipboardHealthInfo = { state: 'ok', detail: null }) {}

  setHealth(state: ClipboardHealthInfo): void {
    // 允许覆盖健康状态（仅测试用；真实部署不可变）。
    (this as unknown as { healthState: ClipboardHealthInfo }).healthState = state;
  }

  async health(): Promise<ClipboardHealthInfo> {
    return this.healthState;
  }

  async readText(): Promise<ClipboardReadResult> {
    this.stats.read += 1;
    if (this.healthState.state !== 'ok') {
      throw new RuntimeError('CLIPBOARD_UNAVAILABLE', this.healthState.detail ?? 'clipboard not available');
    }
    if (this.content === '') return { status: 'empty', text: '', byteLength: 0 };
    return { status: 'ok', text: this.content, byteLength: Buffer.byteLength(this.content, 'utf8') };
  }

  async writeText(text: string): Promise<ClipboardWriteResult> {
    this.stats.write += 1;
    if (this.healthState.state !== 'ok') {
      throw new RuntimeError('CLIPBOARD_UNAVAILABLE', this.healthState.detail ?? 'clipboard not available');
    }
    if (typeof text !== 'string') throw new RuntimeError('TOOL_ARGS_INVALID', 'text must be string');
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > MAX_CLIPBOARD_TEXT_BYTES) {
      throw new RuntimeError('TOOL_INPUT_LIMIT', `clipboard text > ${MAX_CLIPBOARD_TEXT_BYTES} bytes`);
    }
    this.content = text;
    return { status: 'ok', byteLength };
  }
}
