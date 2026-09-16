/**
 * M16 · 媒体桥（RealMediaBridge 占位 + FakeMediaBridge 测试）
 *
 * 真实实现 = 本地媒体服务（ComfyUI / TTS / Whisper）；首版占位（health=unavailable）。
 * FakeMediaBridge：确定性、可控、零网络零 GPU，覆盖测试。
 */

import { createHash } from 'node:crypto';
import { RuntimeError } from '../runtime/contracts.js';
import {
  MAX_IMAGE_PROMPT_LENGTH,
  MAX_TTS_TEXT_LENGTH,
  MAX_VRAM_GB,
  validateSafeBasename,
  type MediaBridge,
  type MediaHealthInfo,
  type MediaImageOptions,
  type MediaImageResult,
  type MediaTtsOptions,
  type MediaTtsResult,
  type MediaTranscribeOptions,
  type MediaTranscribeResult,
  type MediaVramOptions,
  type MediaVramResult,
} from './contracts.js';

// ── RealMediaBridge（占位；首版不启动真实媒体服务）────────────────────

export class RealMediaBridge implements MediaBridge {
  async health(): Promise<MediaHealthInfo> {
    return { state: 'unavailable', detail: 'RealMediaBridge not enabled (ComfyUI/TTS/Whisper pending); use FakeMediaBridge in test/dev' };
  }
  async generateImage(_opts: MediaImageOptions): Promise<MediaImageResult> {
    throw new RuntimeError('MEDIA_UNAVAILABLE', 'RealMediaBridge.generateImage not implemented in first release');
  }
  async synthesizeSpeech(_opts: MediaTtsOptions): Promise<MediaTtsResult> {
    throw new RuntimeError('MEDIA_UNAVAILABLE', 'RealMediaBridge.synthesizeSpeech not implemented in first release');
  }
  async transcribe(_opts: MediaTranscribeOptions): Promise<MediaTranscribeResult> {
    throw new RuntimeError('MEDIA_UNAVAILABLE', 'RealMediaBridge.transcribe not implemented in first release');
  }
  async manageVram(_opts: MediaVramOptions): Promise<MediaVramResult> {
    throw new RuntimeError('MEDIA_UNAVAILABLE', 'RealMediaBridge.manageVram not implemented in first release');
  }
}

// ── FakeMediaBridge（测试；确定性、可控、零副作用）────────────────────

export class FakeMediaBridge implements MediaBridge {
  private healthState: MediaHealthInfo = { state: 'ok', detail: null };
  public readonly stats = { image: 0, tts: 0, transcribe: 0, vram: 0 };
  private imageResults: Map<string, MediaImageResult> = new Map();
  private ttsResults: Map<string, MediaTtsResult> = new Map();
  private transcribeResults: Map<string, MediaTranscribeResult> = new Map();

  setHealth(state: MediaHealthInfo): void {
    (this as unknown as { healthState: MediaHealthInfo }).healthState = state;
  }

  setImageResult(prompt: string, result: MediaImageResult): void {
    this.imageResults.set(prompt, result);
  }
  setTtsResult(text: string, result: MediaTtsResult): void {
    this.ttsResults.set(text, result);
  }
  setTranscribeResult(path: string, result: MediaTranscribeResult): void {
    this.transcribeResults.set(path, result);
  }

  async health(): Promise<MediaHealthInfo> {
    return this.healthState;
  }

  async generateImage(opts: MediaImageOptions, signal?: AbortSignal): Promise<MediaImageResult> {
    this.stats.image += 1;
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted before image');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted during image');
    if (this.healthState.state !== 'ok') throw new RuntimeError('MEDIA_UNAVAILABLE', this.healthState.detail ?? '');
    if (opts.prompt.length > MAX_IMAGE_PROMPT_LENGTH) throw new RuntimeError('MEDIA_INPUT_INVALID', 'prompt too long');
    const nameCheck = validateSafeBasename(opts.filename);
    if (!nameCheck.ok) throw new RuntimeError('MEDIA_PATH_INVALID', nameCheck.reason);
    return this.imageResults.get(opts.prompt) ?? this.defaultImageResult(opts.filename, opts.prompt);
  }

  async synthesizeSpeech(opts: MediaTtsOptions, signal?: AbortSignal): Promise<MediaTtsResult> {
    this.stats.tts += 1;
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted before tts');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted during tts');
    if (this.healthState.state !== 'ok') throw new RuntimeError('MEDIA_UNAVAILABLE', this.healthState.detail ?? '');
    if (opts.text.length > MAX_TTS_TEXT_LENGTH) throw new RuntimeError('MEDIA_INPUT_INVALID', 'text too long');
    const nameCheck = validateSafeBasename(opts.filename);
    if (!nameCheck.ok) throw new RuntimeError('MEDIA_PATH_INVALID', nameCheck.reason);
    return this.ttsResults.get(opts.text) ?? this.defaultTtsResult(opts.filename, opts.text);
  }

  async transcribe(opts: MediaTranscribeOptions, signal?: AbortSignal): Promise<MediaTranscribeResult> {
    this.stats.transcribe += 1;
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted before transcribe');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted during transcribe');
    if (this.healthState.state !== 'ok') throw new RuntimeError('MEDIA_UNAVAILABLE', this.healthState.detail ?? '');
    return this.transcribeResults.get(opts.audioPath) ?? { status: 'ok', text: 'transcribed text', detail: null };
  }

  async manageVram(opts: MediaVramOptions, signal?: AbortSignal): Promise<MediaVramResult> {
    this.stats.vram += 1;
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted before vram');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted during vram');
    if (this.healthState.state !== 'ok') throw new RuntimeError('MEDIA_UNAVAILABLE', this.healthState.detail ?? '');
    if (opts.action !== 'load' && opts.action !== 'release') throw new RuntimeError('MEDIA_INPUT_INVALID', 'action must be load|release');
    if (opts.gb !== undefined && (opts.gb < 0 || opts.gb > MAX_VRAM_GB)) throw new RuntimeError('MEDIA_INPUT_INVALID', 'gb out of range');
    return { status: 'ok', action: opts.action, detail: null };
  }

  private defaultImageResult(filename: string, prompt: string): MediaImageResult {
    const content = `fake-image:${prompt}`;
    const buf = Buffer.from(content, 'utf8');
    return {
      status: 'generated',
      relativePath: filename,
      sha256: createHash('sha256').update(buf).digest('hex'),
      byteLength: buf.length,
      detail: null,
    };
  }

  private defaultTtsResult(filename: string, text: string): MediaTtsResult {
    const content = `fake-audio:${text}`;
    const buf = Buffer.from(content, 'utf8');
    return {
      status: 'generated',
      relativePath: filename,
      sha256: createHash('sha256').update(buf).digest('hex'),
      byteLength: buf.length,
      detail: null,
    };
  }
}
