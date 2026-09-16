/**
 * M16 · 媒体工具装配（media.* 四个 ToolSpec → ToolRegistry）
 *
 * media.image / media.tts = workspace_write（产物落盘 + hash 登记 artifact）；
 * media.transcribe = read；media.vram.manage = process（须审批）。
 * 产物 hash 登记：image/tts 产物落盘后登记 artifact（复用 M04 机制；错误路径绝不登记）。
 */

import { createHash, randomUUID } from 'node:crypto';
import { RuntimeError, type JSONValue } from '../runtime/contracts.js';
import type { ToolSpec } from '../tools/registry.js';
import { type MediaBridge } from './contracts.js';

export interface MediaToolDeps {
  bridge: MediaBridge;
}

export function buildMediaTools(deps: MediaToolDeps): ToolSpec[] {
  return [buildImage(deps), buildTts(deps), buildTranscribe(deps), buildVram(deps)];
}

function buildImage(deps: MediaToolDeps): ToolSpec {
  return {
    name: 'media.image',
    effect: 'workspace_write',
    description: 'Generate an image via local ComfyUI. Artifact is written to workspace and hash-registered.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['prompt', 'filename'],
      properties: {
        prompt: { type: 'string', maxLength: 4000 },
        negativePrompt: { type: 'string', maxLength: 4000 },
        filename: { type: 'string', maxLength: 255 },
        width: { type: 'integer', minimum: 64, maximum: 4096 },
        height: { type: 'integer', minimum: 64, maximum: 4096 },
      },
    },
    fields: {
      prompt: { kind: 'string', required: true, maxLength: 4000 },
      negativePrompt: { kind: 'string', required: false, maxLength: 4000 },
      filename: { kind: 'string', required: true, maxLength: 255 },
      width: { kind: 'integer', required: false, min: 64, max: 4096 },
      height: { kind: 'integer', required: false, min: 64, max: 4096 },
    },
    run: async (args, rootReal, ctx) => {
      const result = await deps.bridge.generateImage({
        prompt: String(args.prompt),
        filename: String(args.filename),
        ...(args.negativePrompt !== undefined ? { negativePrompt: String(args.negativePrompt) } : {}),
        ...(args.width !== undefined ? { width: Number(args.width) } : {}),
        ...(args.height !== undefined ? { height: Number(args.height) } : {}),
        outputRoot: rootReal,
      });
      if (result.status !== 'generated') {
        throw new RuntimeError(result.status === 'unavailable' ? 'MEDIA_UNAVAILABLE' : 'MEDIA_IMAGE_FAILED', result.detail ?? '');
      }
      // 产物 hash 登记（错误路径绝不登记；artifact 只挂成功的操作）。
      const artifactIds: string[] = [];
      if (ctx.registerArtifact && result.relativePath && result.sha256 !== null && result.byteLength !== null) {
        const id = randomUUID();
        ctx.registerArtifact({
          id,
          taskId: ctx.taskId,
          operationId: ctx.operationId,
          relativePath: result.relativePath,
          byteLength: result.byteLength,
          sha256: result.sha256,
        });
        artifactIds.push(id);
      }
      return { content: { ...result, artifactIds } as unknown as JSONValue, artifactIds };
    },
  };
}

function buildTts(deps: MediaToolDeps): ToolSpec {
  return {
    name: 'media.tts',
    effect: 'workspace_write',
    description: 'Synthesize speech from text via local TTS. Artifact is written to workspace and hash-registered.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text', 'filename'],
      properties: { text: { type: 'string', maxLength: 4000 }, filename: { type: 'string', maxLength: 255 } },
    },
    fields: {
      text: { kind: 'string', required: true, maxLength: 4000 },
      filename: { kind: 'string', required: true, maxLength: 255 },
    },
    run: async (args, rootReal, ctx) => {
      const result = await deps.bridge.synthesizeSpeech({ text: String(args.text), filename: String(args.filename), outputRoot: rootReal });
      if (result.status !== 'generated') {
        throw new RuntimeError(result.status === 'unavailable' ? 'MEDIA_UNAVAILABLE' : 'MEDIA_TTS_FAILED', result.detail ?? '');
      }
      const artifactIds: string[] = [];
      if (ctx.registerArtifact && result.relativePath && result.sha256 !== null && result.byteLength !== null) {
        const id = randomUUID();
        ctx.registerArtifact({ id, taskId: ctx.taskId, operationId: ctx.operationId, relativePath: result.relativePath, byteLength: result.byteLength, sha256: result.sha256 });
        artifactIds.push(id);
      }
      return { content: { ...result, artifactIds } as unknown as JSONValue, artifactIds };
    },
  };
}

function buildTranscribe(deps: MediaToolDeps): ToolSpec {
  return {
    name: 'media.transcribe',
    effect: 'read',
    description: 'Transcribe an audio file to text via local Whisper. Read effect.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['audioPath'],
      properties: { audioPath: { type: 'string', maxLength: 1024 } },
    },
    fields: { audioPath: { kind: 'string', required: true, maxLength: 1024 } },
    run: async (args, rootReal) => {
      const result = await deps.bridge.transcribe({ audioPath: String(args.audioPath), workspaceRoot: rootReal });
      if (result.status !== 'ok') {
        throw new RuntimeError(result.status === 'unavailable' ? 'MEDIA_UNAVAILABLE' : 'MEDIA_TRANSCRIBE_FAILED', result.detail ?? '');
      }
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

function buildVram(deps: MediaToolDeps): ToolSpec {
  return {
    name: 'media.vram.manage',
    effect: 'process',
    description: 'Load or release GPU VRAM. Process effect; requires approval.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: { action: { type: 'string', enum: ['load', 'release'] }, gb: { type: 'integer', minimum: 0, maximum: 24 } },
    },
    fields: {
      action: { kind: 'string', required: true, maxLength: 8, enum: ['load', 'release'] },
      gb: { kind: 'integer', required: false, min: 0, max: 24 },
    },
    approvalInputHash: (validated) => {
      // 审批 hash 绑定 action + gb（process 副作用走 M14 同套门）。
      return createHash('sha256').update('media.vram.manage:' + JSON.stringify(validated), 'utf8').digest('hex');
    },
    run: async (args) => {
      const result = await deps.bridge.manageVram({
        action: String(args.action) as 'load' | 'release',
        ...(args.gb !== undefined ? { gb: Number(args.gb) } : {}),
      });
      if (result.status !== 'ok') {
        throw new RuntimeError(result.status === 'unavailable' ? 'MEDIA_UNAVAILABLE' : 'MEDIA_VRAM_FAILED', result.detail ?? '');
      }
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}
