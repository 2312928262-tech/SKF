/**
 * M16 · 媒体工具契约（ComfyUI 出图 / TTS / Whisper 转写 / 显存管理）
 *
 * 命名空间：media.* 不与 file.* / mcp/* / desktop.* / clipboard.* / browser.* / web.* 重名。
 * 真实实现 = 本地媒体服务（ComfyUI / TTS 引擎 / Whisper）；首版 RealMediaBridge 占位，
 * FakeMediaBridge 覆盖测试（零网络零付费零真实 GPU）。
 *
 * effect 分级：
 *   media.image       workspace_write  ComfyUI 出图 → 产物落盘 + hash 登记
 *   media.tts         workspace_write  TTS 文本转语音 → 产物落盘 + hash 登记
 *   media.transcribe  read             Whisper 音频转写（读音频，不落产物）
 *   media.vram.manage process          显存加载/释放（进程副作用，须审批）
 *
 * 红线：
 *   - 产物 hash 登记：media.image / media.tts 产物落盘后必须 sha256 + 路径登记 artifact
 *     （复用 M04 artifact 机制；错误路径绝不登记）。
 *   - 显存用时加载 / 打游戏释放：media.vram.manage 显式管理显存，不自动释放（按 HANDOFF
 *     "RTX 5090 v2 24G 显存用时加载不用主动释放" 决策；本卡保留显式 manage 入口）。
 *   - 成本归零客户素材不出门：本地生成，不调用云端；素材不离开本机。
 *   - 密钥不进任何文件：媒体服务端点无密钥（本地）。
 */

import type { Effect } from '../runtime/contracts.js';

export const MEDIA_TOOL_NAMES = ['media.image', 'media.tts', 'media.transcribe', 'media.vram.manage'] as const;
export type MediaToolName = (typeof MEDIA_TOOL_NAMES)[number];

export const MEDIA_TOOL_EFFECT: Readonly<Record<MediaToolName, Effect>> = {
  'media.image': 'workspace_write',
  'media.tts': 'workspace_write',
  'media.transcribe': 'read',
  'media.vram.manage': 'process',
};

export const MAX_IMAGE_PROMPT_LENGTH = 4000;
export const MAX_TTS_TEXT_LENGTH = 4000;
export const MAX_AUDIO_PATH_LENGTH = 1024;
export const MAX_ARTIFACT_PATH_LENGTH = 1024;
export const MAX_VRAM_GB = 24;

/** 媒体桥抽象。 */
export interface MediaBridge {
  generateImage(opts: MediaImageOptions, signal?: AbortSignal): Promise<MediaImageResult>;
  synthesizeSpeech(opts: MediaTtsOptions, signal?: AbortSignal): Promise<MediaTtsResult>;
  transcribe(opts: MediaTranscribeOptions, signal?: AbortSignal): Promise<MediaTranscribeResult>;
  manageVram(opts: MediaVramOptions, signal?: AbortSignal): Promise<MediaVramResult>;
  health(): Promise<MediaHealthInfo>;
}

export interface MediaImageOptions {
  prompt: string;
  /** 负向提示（可选）。 */
  negativePrompt?: string;
  /** 输出文件名（basename；安全，不含路径分隔符）。 */
  filename: string;
  width?: number;
  height?: number;
  /** 输出目录（workspaceRoot 绝对路径；RealMediaBridge 写产物用，Fake 忽略）。 */
  outputRoot?: string;
}

export interface MediaImageResult {
  status: 'generated' | 'failed' | 'unavailable';
  /** 产物相对路径（workspaceRoot 内）。 */
  relativePath: string | null;
  sha256: string | null;
  byteLength: number | null;
  detail: string | null;
}

export interface MediaTtsOptions {
  text: string;
  filename: string;
  /** 输出目录（workspaceRoot 绝对路径；RealMediaBridge 写产物用，Fake 忽略）。 */
  outputRoot?: string;
}

export interface MediaTtsResult {
  status: 'generated' | 'failed' | 'unavailable';
  relativePath: string | null;
  sha256: string | null;
  byteLength: number | null;
  detail: string | null;
}

export interface MediaTranscribeOptions {
  /** 音频文件相对路径（workspaceRoot 内）。 */
  audioPath: string;
  /** workspaceRoot 绝对路径（RealMediaBridge 解析 audioPath 用，Fake 忽略）。 */
  workspaceRoot?: string;
}

export interface MediaTranscribeResult {
  status: 'ok' | 'failed' | 'unavailable';
  text: string;
  detail: string | null;
}

export interface MediaVramOptions {
  /** 'load' 加载显存 / 'release' 释放显存。 */
  action: 'load' | 'release';
  /** 目标显存占用（GB；0 = 释放全部）。 */
  gb?: number;
}

export interface MediaVramResult {
  status: 'ok' | 'failed' | 'unavailable';
  action: 'load' | 'release';
  detail: string | null;
}

export interface MediaHealthInfo {
  state: 'ok' | 'unavailable' | 'no_gpu';
  detail: string | null;
}

/** 媒体错误码白名单。 */
export const MEDIA_PUBLIC_ERROR_CODES = [
  'MEDIA_UNAVAILABLE',
  'MEDIA_IMAGE_FAILED',
  'MEDIA_TTS_FAILED',
  'MEDIA_TRANSCRIBE_FAILED',
  'MEDIA_VRAM_FAILED',
  'MEDIA_INPUT_INVALID',
  'MEDIA_TIMEOUT',
  'MEDIA_ARTIFACT_MISSING',
  'MEDIA_PATH_INVALID',
] as const;
export type MediaPublicErrorCode = (typeof MEDIA_PUBLIC_ERROR_CODES)[number];

/** 校验产物路径/文件名安全（不含路径分隔符/控制字符/URL）。 */
export function validateSafeBasename(name: string): { ok: true } | { ok: false; reason: string } {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return { ok: false, reason: 'basename invalid length' };
  if (/[\\/:*?"<>|]/.test(name)) return { ok: false, reason: 'basename has illegal path chars' };
  if (name.startsWith('.') || name.endsWith('.')) return { ok: false, reason: 'basename has dot edge' };
  return { ok: true };
}
