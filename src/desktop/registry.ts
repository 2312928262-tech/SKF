/**
 * M17 · DesktopRegistry：把 uia-bridge / clipboard / launcher 装配成 ToolSpec 注册到 ToolRegistry。
 *
 * 命名空间：desktop.* / clipboard.* 不可能遮蔽 file.*（ToolRegistry.register 校验）；
 * 重复注册抛 TOOL_NAME_CONFLICT（同 MCP 纪律）。
 *
 * effect 分级（与 contracts.DESKTOP_TOOL_EFFECT 一致）：
 *   desktop.windows  / desktop.snapshot / clipboard.read → read（默认任务授权可调用）
 *   clipboard.write → external_write（M14 approval hash 绑定；TaskAuthorization.allowedEffects 不需要包含）
 *   desktop.launch   → process（同上）
 *
 * 审批 hash：clipboard.write / desktop.launch 经 ToolRegistry.execute 时已走 hasApproved(hash)；
 *  hash = sha256(toolName + canonical(args))。Fake 模式下 hasApproved 由调用方注入。
 */

import { RuntimeError, stableStringify, type Effect, type JSONValue } from '../runtime/contracts.js';
import { approvalInputHashOf, MAX_CLIPBOARD_TEXT_BYTES, MAX_LAUNCH_ARG_BYTES, MAX_LAUNCH_ARGS, MAX_WINDOWS_IN_RESULT, MAX_SNAPSHOT_NODES, MAX_SNAPSHOT_DEPTH, MAX_SNAPSHOT_BYTES, type ClipboardBridge, type LaunchBridge, type UiaBridge } from './contracts.js';

// ── ToolSpec 形状（复用 tools/registry.ts 的 FieldSpec 类型，避免双源不兼容）────────────

import type { FieldSpec } from '../tools/registry.js';

export interface DesktopToolSpec {
  name: string;
  effect: Effect;
  description: string;
  inputSchema: JSONValue;
  fields: Record<string, FieldSpec>;
  approvalInputHash?: (validatedArgs: Record<string, JSONValue>) => string;
  run(args: Record<string, JSONValue>, ctx: RunContext): Promise<{ content: JSONValue; artifactIds: string[] }>;
}

export interface RunContext {
  signal?: AbortSignal;
  logger?: (line: string) => void;
}

// ── DesktopRegistry：装配 → 提供 ToolSpec[] 与 spawn IPC 上下文 ───────────

export interface DesktopRegistryOptions {
  uia: UiaBridge;
  clipboard: ClipboardBridge;
  launcher: LaunchBridge;
}

export class DesktopRegistry {
  private readonly specs: Map<string, DesktopToolSpec> = new Map();

  constructor(private readonly opts: DesktopRegistryOptions) {
    for (const spec of this.buildSpecs()) {
      if (this.specs.has(spec.name)) throw new RuntimeError('TOOL_NAME_CONFLICT', spec.name);
      this.specs.set(spec.name, spec);
    }
  }

  /** 供 ToolRegistry 装配：返回全部 desktop.* / clipboard.* 的 ToolSpec（宿主负责 register）。 */
  toolSpecs(): DesktopToolSpec[] {
    return [...this.specs.values()];
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  specOf(name: string): DesktopToolSpec | undefined {
    return this.specs.get(name);
  }

  private buildSpecs(): DesktopToolSpec[] {
    return [
      this.buildWindowsSpec(),
      this.buildSnapshotSpec(),
      this.buildClipboardReadSpec(),
      this.buildClipboardWriteSpec(),
      this.buildLaunchSpec(),
    ];
  }

  // ── desktop.windows ────────────────────────────────────────────────

  private buildWindowsSpec(): DesktopToolSpec {
    return {
      name: 'desktop.windows',
      effect: 'read',
      description: 'List top-level windows visible to the Windows UIA bridge (read-only; excludes the SKF process).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          restrictPids: { type: 'array', items: { type: 'integer' }, maxItems: 32 },
          visibleOnly: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_WINDOWS_IN_RESULT },
        },
      },
      fields: {
        restrictPids: { kind: 'integerArray', required: false, min: 1, max: 4_294_967_295, maxItems: 32 },
        visibleOnly: { kind: 'boolean', required: false },
        limit: { kind: 'integer', required: false, min: 1, max: MAX_WINDOWS_IN_RESULT },
      },
      run: async (args, ctx) => {
        const opts = {
          ...(args.restrictPids !== undefined ? { restrictPids: NumberArr(args.restrictPids, 'restrictPids') } : {}),
          ...(args.visibleOnly !== undefined ? { visibleOnly: args.visibleOnly === true } : {}),
          ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
        };
        const windows = await this.opts.uia.listWindows(opts, ctx.signal);
        ctx.logger?.(`desktop.windows -> ${windows.length} windows`);
        return { content: { windows, total: windows.length } as unknown as JSONValue, artifactIds: [] };
      },
    };
  }

  // ── desktop.snapshot ───────────────────────────────────────────────

  private buildSnapshotSpec(): DesktopToolSpec {
    return {
      name: 'desktop.snapshot',
      effect: 'read',
      description: 'Read a bounded UIA tree of the given window. Returns nodes (controlType, name, children, …); values are not_requested by default.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ephemeralId'],
        properties: {
          ephemeralId: { type: 'string', maxLength: 256 },
          view: { type: 'string', enum: ['control', 'content'] },
          textPolicy: { type: 'string', enum: ['structureOnly', 'semantic'] },
          maxNodes: { type: 'integer', minimum: 1, maximum: MAX_SNAPSHOT_NODES },
          maxDepth: { type: 'integer', minimum: 0, maximum: MAX_SNAPSHOT_DEPTH },
          maxBytes: { type: 'integer', minimum: 1024, maximum: MAX_SNAPSHOT_BYTES },
        },
      },
      fields: {
        ephemeralId: { kind: 'string', required: true, maxLength: 256 },
        view: { kind: 'string', required: false, maxLength: 16, enum: ['control', 'content'] },
        textPolicy: { kind: 'string', required: false, maxLength: 16, enum: ['structureOnly', 'semantic'] },
        maxNodes: { kind: 'integer', required: false, min: 1, max: MAX_SNAPSHOT_NODES },
        maxDepth: { kind: 'integer', required: false, min: 0, max: MAX_SNAPSHOT_DEPTH },
        maxBytes: { kind: 'integer', required: false, min: 1024, max: MAX_SNAPSHOT_BYTES },
      },
      run: async (args, ctx) => {
        const limits: { maxNodes?: number; maxDepth?: number; maxBytes?: number } = {};
        if (args.maxNodes !== undefined) limits.maxNodes = Number(args.maxNodes);
        if (args.maxDepth !== undefined) limits.maxDepth = Number(args.maxDepth);
        if (args.maxBytes !== undefined) limits.maxBytes = Number(args.maxBytes);
        const result = await this.opts.uia.snapshot({
          ephemeralId: String(args.ephemeralId),
          ...(args.view !== undefined ? { view: args.view as 'control' | 'content' } : {}),
          ...(args.textPolicy !== undefined ? { textPolicy: args.textPolicy as 'structureOnly' | 'semantic' } : {}),
          ...(Object.keys(limits).length > 0 ? { limits } : {}),
        }, ctx.signal);
        ctx.logger?.(`desktop.snapshot -> ${result.nodes.length} nodes status=${result.status}`);
        return { content: result as unknown as JSONValue as JSONValue, artifactIds: [] };
      },
    };
  }

  // ── clipboard.read ─────────────────────────────────────────────────

  private buildClipboardReadSpec(): DesktopToolSpec {
    return {
      name: 'clipboard.read',
      effect: 'read',
      description: 'Read the current text content of the OS clipboard. Returns { status: "ok"|"empty"|"unavailable", text, byteLength }.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      fields: {},
      run: async (_args, ctx) => {
        const result = await this.opts.clipboard.readText();
        ctx.logger?.(`clipboard.read -> ${result.status} (${result.byteLength}B)`);
        return { content: result as unknown as JSONValue, artifactIds: [] };
      },
    };
  }

  // ── clipboard.write ────────────────────────────────────────────────

  private buildClipboardWriteSpec(): DesktopToolSpec {
    return {
      name: 'clipboard.write',
      effect: 'external_write',
      description: 'Write text to the OS clipboard. External effect — approval gate (inputHash) required; cannot be invoked without prior approval.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', maxLength: MAX_CLIPBOARD_TEXT_BYTES } },
      },
      fields: {
        text: { kind: 'string', required: true, maxLength: MAX_CLIPBOARD_TEXT_BYTES },
      },
      approvalInputHash: (validated) => approvalInputHashOf('clipboard.write', validated as unknown as JSONValue),
      run: async (args, ctx) => {
        const text = String(args.text);
        const result = await this.opts.clipboard.writeText(text);
        ctx.logger?.(`clipboard.write -> ${result.status} (${result.byteLength}B)`);
        return { content: { ...result, byteLength: result.byteLength } as unknown as JSONValue, artifactIds: [] };
      },
    };
  }

  // ── desktop.launch ─────────────────────────────────────────────────

  private buildLaunchSpec(): DesktopToolSpec {
    return {
      name: 'desktop.launch',
      effect: 'process',
      description: 'Launch a whitelisted executable with bounded args. Process effect — approval gate (inputHash) required.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['executable'],
        properties: {
          executable: { type: 'string', maxLength: 256 },
          args: { type: 'array', items: { type: 'string' }, maxItems: MAX_LAUNCH_ARGS },
          cwd: { type: 'string', maxLength: 1024 },
          detached: { type: 'boolean' },
        },
      },
      fields: {
        executable: { kind: 'string', required: true, maxLength: 256 },
        args: { kind: 'stringArray', required: false, maxItems: MAX_LAUNCH_ARGS, maxItemBytes: MAX_LAUNCH_ARG_BYTES },
        cwd: { kind: 'string', required: false, maxLength: 1024 },
        detached: { kind: 'boolean', required: false },
      },
      approvalInputHash: (validated) => approvalInputHashOf('desktop.launch', validated as unknown as JSONValue),
      run: async (args, ctx) => {
        const arrArgs = args.args !== undefined ? StringArr(args.args, 'args') : [];
        const result = await this.opts.launcher.launch({
          executable: String(args.executable),
          ...(arrArgs.length > 0 ? { args: arrArgs } : {}),
          ...(args.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
          ...(args.detached !== undefined ? { detached: args.detached === true } : {}),
        });
        ctx.logger?.(`desktop.launch -> ${result.status} pid=${result.pid ?? '-'}`);
        // denied / failed 是工具执行失败（不是成功返回）；调起方调包以传递错误码。
        if (result.status !== 'started') {
          throw new RuntimeError(result.status === 'denied' ? 'LAUNCH_DENIED' : 'LAUNCH_UNAVAILABLE', result.detail ?? `launch ${result.status}`);
        }
        return { content: result as unknown as JSONValue, artifactIds: [] };
      },
    };
  }
}

// ── 工具方法：把数组字段（restictPids / args）从 JSONValue 安全转回原生数组 ──

function NumberArr(v: JSONValue, name: string): number[] {
  if (!Array.isArray(v)) throw new RuntimeError('TOOL_ARGS_INVALID', `${name} not array`);
  return v.map((item) => {
    const n = typeof item === 'number' ? item : Number(item);
    if (!Number.isSafeInteger(n)) throw new RuntimeError('TOOL_ARGS_INVALID', `${name} item not integer`);
    return n;
  });
}

function StringArr(v: JSONValue, name: string): string[] {
  if (!Array.isArray(v)) throw new RuntimeError('TOOL_ARGS_INVALID', `${name} not array`);
  return v.map((item) => {
    if (typeof item !== 'string') throw new RuntimeError('TOOL_ARGS_INVALID', `${name} item not string`);
    return item;
  });
}

// ── 把 DesktopToolSpec 适配为 ToolRegistry.ToolSpec ──────────────────────────

/**
 * 适配器：把 desktop registry 的 spec 转为 ToolRegistry.ToolSpec
 * （保留 schema / effect / run；补 workspaceRoot 不需要 —— desktop 工具不碰文件系统）。
 */
export function toToolRegistrySpec(spec: DesktopToolSpec): import('../tools/registry.js').ToolSpec {
  return {
    name: spec.name,
    effect: spec.effect,
    description: spec.description,
    inputSchema: spec.inputSchema,
    fields: spec.fields,
    ...(spec.approvalInputHash ? { approvalInputHash: spec.approvalInputHash } : {}),
    run: async (args, _rootReal, ctx) => {
      // ToolRegistry 已做 schema/cancellation 校验；这里只剩执行。
      return spec.run(args, { signal: ctx.signal, logger: ctx.logger });
    },
  };
}

/** 标记 helper（用于 IPC 错误码白名单的生成与校验）。 */
export const DESKTOP_PUBLIC_ERROR_CODES = [
  'UIA_UNAVAILABLE',
  'SECURE_DESKTOP_OR_SESSION_UNAVAILABLE',
  'HELPER_FAILED',
  'CLIPBOARD_UNAVAILABLE',
  'LAUNCH_DENIED',
  'LAUNCH_UNAVAILABLE',
  'TARGET_NOT_FOUND',
  'TARGET_CHANGED',
] as const;
export type DesktopPublicErrorCode = (typeof DESKTOP_PUBLIC_ERROR_CODES)[number];

/** 把 DesktopRegistry 装配到 ToolRegistry（统一在 supervisor 启动时调用）。 */
export function registerDesktopTools(registry: import('../tools/registry.js').ToolRegistry, desktop: DesktopRegistry): void {
  for (const spec of desktop.toolSpecs()) {
    registry.register(toToolRegistrySpec(spec));
  }
}

/** 标记导出（用于稳定序列化审批 hash）。 */
export function stableDesktopArgs(tool: string, args: JSONValue): string {
  return `${tool}:` + stableStringify(args);
}
