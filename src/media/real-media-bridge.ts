/**
 * M26 · 真实媒体桥（RealMediaBridge）
 *
 *   media.image      → ComfyUI（127.0.0.1:8188）API 出图 → 落盘 workspaceRoot + sha256。
 *   media.transcribe → faster-whisper（f5tts venv）转写。
 *   media.tts        → CosyVoice2（cosyvoice venv）零样本克隆配音（SKF固定参考音）。
 *   media.vram.manage→ ComfyUI /free 释放显存（load=按需隐式加载）。
 *
 * 纪律（与 M16 一致）：
 *   - 产物落盘后 sha256 + 相对路径登记 artifact（registry 层复用 M04；错误路径绝不登记）。
 *   - 本地组件零付费；客户素材不出门。
 *   - 未装/不可用如实报 MEDIA_UNAVAILABLE 并写清缺什么，绝不假装成功。
 *   - 显存用时加载 / 显式 release 释放，不自动释放。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeError } from '../runtime/contracts.js';
import {
  MAX_IMAGE_PROMPT_LENGTH,
  MAX_TTS_TEXT_LENGTH,
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

export interface RealMediaBridgeOptions {
  /** ComfyUI base URL。 */
  comfyuiUrl?: string;
  /** API 工作流 JSON（含 prompt 节点 "6"、负向 "7"、latent "5"）。 */
  comfyuiWorkflow?: string;
  /** faster-whisper venv 解释器 + 转写脚本。 */
  whisperPython?: string;
  whisperScript?: string;
  /** CosyVoice2 venv 解释器 + 配音脚本。 */
  ttsPython?: string;
  ttsScript?: string;
  timeoutMs?: number;
  logger?: (line: string) => void;
}

const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

export class RealMediaBridge implements MediaBridge {
  private readonly comfyuiUrl: string;
  private readonly comfyuiWorkflow: string;
  private readonly whisperPython: string;
  private readonly whisperScript: string;
  private readonly ttsPython: string;
  private readonly ttsScript: string;
  private readonly timeoutMs: number;
  private readonly logger?: (line: string) => void;

  constructor(opts: RealMediaBridgeOptions) {
    this.comfyuiUrl = (opts.comfyuiUrl ?? DEFAULT_COMFYUI_URL).replace(/\/+$/, '');
    this.comfyuiWorkflow = opts.comfyuiWorkflow ?? 'D:/AI/workflows/sdxl_txt2img_api.json';
    this.whisperPython = opts.whisperPython ?? 'D:/AI/venvs/f5tts/Scripts/python.exe';
    this.whisperScript = opts.whisperScript ?? join(import.meta.dirname, '..', '..', 'scripts', 'bridge', 'whisper-transcribe.py');
    this.ttsPython = opts.ttsPython ?? 'D:/AI/venvs/cosyvoice/Scripts/python.exe';
    this.ttsScript = opts.ttsScript ?? join(import.meta.dirname, '..', '..', 'scripts', 'bridge', 'cosyvoice-tts.py');
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.logger = opts.logger;
  }

  private log(line: string): void {
    this.logger?.(line);
  }

  private async comfyuiUp(): Promise<boolean> {
    try {
      const res = await fetch(this.comfyuiUrl + '/system_stats', { signal: AbortSignal.timeout(3_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async health(): Promise<MediaHealthInfo> {
    if (await this.comfyuiUp()) return { state: 'ok', detail: 'ComfyUI reachable at ' + this.comfyuiUrl };
    return { state: 'unavailable', detail: 'ComfyUI not reachable at ' + this.comfyuiUrl };
  }

  async generateImage(opts: MediaImageOptions, signal?: AbortSignal): Promise<MediaImageResult> {
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted');
    if (opts.prompt.length > MAX_IMAGE_PROMPT_LENGTH) throw new RuntimeError('MEDIA_INPUT_INVALID', 'prompt too long');
    if (!(await this.comfyuiUp())) {
      return { status: 'unavailable', relativePath: null, sha256: null, byteLength: null, detail: 'ComfyUI not reachable at ' + this.comfyuiUrl };
    }
    let workflow: Record<string, { inputs: Record<string, unknown> }>;
    try {
      workflow = JSON.parse(readFileSync(this.comfyuiWorkflow, 'utf8'));
    } catch (err) {
      return { status: 'unavailable', relativePath: null, sha256: null, byteLength: null, detail: 'workflow not found: ' + this.comfyuiWorkflow };
    }
    // 补丁：prompt 节点 "6"、负向 "7"、latent "5"（SDXL/Flux 通用）。
    if (workflow['6']?.inputs) workflow['6'].inputs.text = opts.prompt;
    if (opts.negativePrompt !== undefined && workflow['7']?.inputs) workflow['7'].inputs.text = opts.negativePrompt;
    if (opts.width !== undefined && workflow['5']?.inputs) workflow['5'].inputs.width = opts.width;
    if (opts.height !== undefined && workflow['5']?.inputs) workflow['5'].inputs.height = opts.height;

    try {
      const submit = await fetch(this.comfyuiUrl + '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: 'skf-m26-' + Date.now() }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!submit.ok) return { status: 'failed', relativePath: null, sha256: null, byteLength: null, detail: 'submit failed HTTP ' + submit.status };
      const submitted = (await submit.json()) as { prompt_id?: string };
      const promptId = submitted.prompt_id;
      if (!promptId) return { status: 'failed', relativePath: null, sha256: null, byteLength: null, detail: 'no prompt_id returned' };

      // 轮询 /history/{id} 直到 completed 或 error。
      const deadline = Date.now() + this.timeoutMs;
      let imageRef: { filename: string; subfolder: string; type: string } | null = null;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted');
        await new Promise((r) => setTimeout(r, 2_000));
        const hist = await fetch(this.comfyuiUrl + `/history/${promptId}`, { signal: AbortSignal.timeout(60_000) });
        if (!hist.ok) continue;
        const h = (await hist.json()) as Record<string, { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }>;
        const entry = h[promptId];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') {
          return { status: 'failed', relativePath: null, sha256: null, byteLength: null, detail: 'comfyui workflow error' };
        }
        if (entry.status?.completed) {
          for (const out of Object.values(entry.outputs ?? {})) {
            const img = out?.images?.[0];
            if (img) { imageRef = img; break; }
          }
          break;
        }
      }
      if (!imageRef) return { status: 'failed', relativePath: null, sha256: null, byteLength: null, detail: 'no image produced within timeout' };

      // 下载图片。
      const q = new URLSearchParams({ filename: imageRef.filename, subfolder: imageRef.subfolder, type: imageRef.type });
      const imgRes = await fetch(this.comfyuiUrl + '/view?' + q.toString(), { signal: AbortSignal.timeout(120_000) });
      if (!imgRes.ok) return { status: 'failed', relativePath: null, sha256: null, byteLength: null, detail: 'download failed HTTP ' + imgRes.status };
      const buf = Buffer.from(await imgRes.arrayBuffer());

      // 落盘到 workspaceRoot + sha256。
      const outDir = opts.outputRoot ?? '.';
      const outPath = join(outDir, opts.filename);
      writeFileSync(outPath, buf);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      this.log(`media.image -> ${opts.filename} ${buf.length}B sha256=${sha256}`);
      return { status: 'generated', relativePath: opts.filename, sha256, byteLength: buf.length, detail: null };
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      return { status: 'failed', relativePath: null, sha256: null, byteLength: null, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  async synthesizeSpeech(opts: MediaTtsOptions, signal?: AbortSignal): Promise<MediaTtsResult> {
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted');
    if (opts.text.length > MAX_TTS_TEXT_LENGTH) throw new RuntimeError('MEDIA_INPUT_INVALID', 'text too long');
    if (!existsSync(this.ttsPython)) {
      return { status: 'unavailable', relativePath: null, sha256: null, byteLength: null, detail: 'CosyVoice2 venv missing: ' + this.ttsPython };
    }
    if (!existsSync(this.ttsScript)) {
      return { status: 'unavailable', relativePath: null, sha256: null, byteLength: null, detail: 'TTS script missing: ' + this.ttsScript };
    }
    const outDir = opts.outputRoot ?? '.';
    const outPath = join(outDir, opts.filename);
    try {
      await this.runPython(this.ttsPython, [this.ttsScript, '--text', opts.text, '--out', outPath], this.timeoutMs, signal);
      const buf = readFileSync(outPath);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      this.log(`media.tts -> ${opts.filename} ${buf.length}B sha256=${sha256}`);
      return { status: 'generated', relativePath: opts.filename, sha256, byteLength: buf.length, detail: null };
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      return { status: 'failed', relativePath: null, sha256: null, byteLength: null, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  async transcribe(opts: MediaTranscribeOptions, signal?: AbortSignal): Promise<MediaTranscribeResult> {
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted');
    if (!existsSync(this.whisperPython)) {
      return { status: 'unavailable', text: '', detail: 'faster-whisper venv missing: ' + this.whisperPython };
    }
    if (!existsSync(this.whisperScript)) {
      return { status: 'unavailable', text: '', detail: 'whisper script missing: ' + this.whisperScript };
    }
    const audioPath = opts.workspaceRoot ? join(opts.workspaceRoot, opts.audioPath) : opts.audioPath;
    if (!existsSync(audioPath)) {
      return { status: 'failed', text: '', detail: 'audio not found: ' + opts.audioPath };
    }
    try {
      const stdout = await this.runPython(this.whisperPython, [this.whisperScript, '--audio', audioPath], this.timeoutMs, signal);
      const parsed = JSON.parse(stdout) as { status?: string; text?: string; detail?: string };
      if (parsed.status === 'ok' && typeof parsed.text === 'string') {
        return { status: 'ok', text: parsed.text, detail: null };
      }
      return { status: 'failed', text: '', detail: parsed.detail ?? 'whisper returned no text' };
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      return { status: 'failed', text: '', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  async manageVram(opts: MediaVramOptions, signal?: AbortSignal): Promise<MediaVramResult> {
    if (signal?.aborted) throw new RuntimeError('MEDIA_TIMEOUT', 'aborted');
    if (opts.action === 'load') {
      // ComfyUI 按需隐式加载模型（下次生成时）；无通用预载 API，如实说明。
      return { status: 'ok', action: 'load', detail: 'models load on demand at next generation' };
    }
    if (!(await this.comfyuiUp())) {
      return { status: 'unavailable', action: 'release', detail: 'ComfyUI not reachable at ' + this.comfyuiUrl };
    }
    try {
      const res = await fetch(this.comfyuiUrl + '/free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { status: 'failed', action: 'release', detail: 'free failed HTTP ' + res.status };
      this.log('media.vram -> released');
      return { status: 'ok', action: 'release', detail: null };
    } catch (err) {
      return { status: 'failed', action: 'release', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  /** 运行 python 子进程，收集 stdout（JSON），硬超时 kill。 */
  private runPython(python: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(python, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => {
        finish(() => {
          try { child.kill(); } catch { /* noop */ }
          reject(new RuntimeError('MEDIA_TIMEOUT', `python timeout after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      const onAbort = () => {
        finish(() => {
          try { child.kill(); } catch { /* noop */ }
          reject(new RuntimeError('MEDIA_TIMEOUT', 'aborted'));
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => finish(() => reject(new RuntimeError('MEDIA_UNAVAILABLE', 'spawn failed: ' + err.message))));
      child.on('close', (code) => {
        finish(() => {
          signal?.removeEventListener('abort', onAbort);
          if (code !== 0) reject(new RuntimeError('MEDIA_UNAVAILABLE', `python exited ${code}: ${stderr.slice(0, 300)}`));
          else resolve(stdout);
        });
      });
    });
  }
}
