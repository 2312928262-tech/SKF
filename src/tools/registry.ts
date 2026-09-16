import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeError, stableStringify, type Effect, type JSONValue } from '../runtime/contracts.js';
import { authorizeEffect, type TaskAuthorization } from './policy.js';
import { atomicWriteVerified, openWorkspaceRoot, resolveWithinRoot, sha256HexBytes } from './safe-files.js';

/**
 * M04 · ToolRegistry：AgentLoop 唯一可见的有边界工具面（02-CONTRACTS.md C/E 节）。
 * - 只注册 file.read / file.write / file.list / file.stat；首版不注册 exec/openclaw。
 * - 严格 schema：未知工具、额外字段、类型错误、超大参数一律拒绝。
 * - workspaceRoot 来自任务创建时的可信快照（ToolExecutionContext），模型 args 里
 *   没有任何字段能重定义它（多写字段会被 schema 拒绝）。
 * - 开始前查 cancellation 与 deadline；输出 byteLimit 截断 + 分页；日志脱敏。
 * - 错误只回 {code, retryable}，不回模糊成功。
 */

// ── 限额（保护上限，非用户预算）──────────────────────────

export const TOOL_INPUT_MAX_BYTES = 1_500_000; // 序列化 args 总上限
export const FILE_WRITE_MAX_BYTES = 1_000_000; // 单次写入内容上限
export const FILE_READ_DEFAULT_BYTES = 16_384;
export const FILE_READ_MAX_BYTES = 65_536;
export const FILE_LIST_DEFAULT_ENTRIES = 200;
export const FILE_LIST_MAX_ENTRIES = 1000;
export const TOOL_RESULT_MAX_BYTES = 96_000; // 结果序列化回灌模型的硬上限（兜底）

// ── 结果与上下文 ─────────────────────────────────────────

export interface ToolCallResult {
  callId: string;
  operationId: string | null;
  ok: boolean;
  /** 成功时为 JSON 字符串（截断信息在结构内）；失败时为空字符串。 */
  content: string;
  artifactIds: string[];
  error?: { code: string; retryable: boolean; detail?: string };
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  operationId?: string;
  relativePath: string;
  byteLength: number;
  sha256: string;
}

export interface ToolExecutionContext {
  taskId: string;
  /** 可信调用方在任务创建时固定；绝不来自模型 args。 */
  workspaceRoot: string;
  authorization: TaskAuthorization;
  operationId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  registerArtifact?: (rec: ArtifactRecord) => void;
  /** 调试日志出口；入参已脱敏（file.write 的 content 替换为 bytes+sha256）。 */
  logger?: (line: string) => void;
  /** M14：副作用审批查询（账本层注入）：inputHash 已有 approved 审批才返回 true。
   *  缺失 = 无审批渠道，副作用工具一律 APPROVAL_REQUIRED（fail-closed）。 */
  hasApproved?: (inputHash: string) => boolean;
  /** 测试注入竞态钩子；不暴露给模型。 */
  hooks?: { beforeCommit?: (targetAbsolutePath: string) => void | Promise<void> };
}

// ── 严格 schema 校验 ─────────────────────────────────────

export type FieldSpec =
  | { kind: 'string'; required: boolean; maxLength: number; enum?: readonly string[]; pattern?: string }
  | { kind: 'integer'; required: boolean; min: number; max: number }
  | { kind: 'boolean'; required: boolean }
  | { kind: 'stringArray'; required: boolean; maxItems?: number; maxItemBytes?: number }
  | { kind: 'integerArray'; required: boolean; min?: number; max?: number; maxItems?: number }
  | { kind: 'json'; required: boolean; maxBytes?: number };

function validateArgs(raw: JSONValue, tool: string, fields: Record<string, FieldSpec>): Record<string, JSONValue> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: object expected`);
  }
  const input = raw as Record<string, JSONValue>;
  for (const key of Object.keys(input)) {
    if (!(key in fields)) throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: unknown field ${key}`);
  }
  const out: Record<string, JSONValue> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const value = input[key];
    if (value === undefined) {
      if (spec.required) throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: missing ${key}`);
      continue;
    }
    if (spec.kind === 'string') {
      if (typeof value !== 'string') throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not string`);
      if (value.length > spec.maxLength) throw new RuntimeError('TOOL_INPUT_LIMIT', `${tool}: ${key} too long`);
      if (spec.enum && !spec.enum.includes(value)) throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not one of ${spec.enum.join('|')}`);
      if (spec.pattern && !(new RegExp(spec.pattern).test(value))) throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not match pattern`);
    } else if (spec.kind === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
        throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not integer in [${spec.min},${spec.max}]`);
      }
    } else if (spec.kind === 'boolean') {
      if (typeof value !== 'boolean') throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not boolean`);
    } else if (spec.kind === 'stringArray') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not string[]`);
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} too many items`);
      }
      for (const v of value) {
        if (spec.maxItemBytes !== undefined && Buffer.byteLength(v as string, 'utf8') > spec.maxItemBytes) {
          throw new RuntimeError('TOOL_INPUT_LIMIT', `${tool}: ${key} item too long`);
        }
      }
    } else if (spec.kind === 'integerArray') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'number' || !Number.isSafeInteger(v))) {
        throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not integer[]`);
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} too many items`);
      }
      for (const v of value) {
        if ((spec.min !== undefined && (v as number) < spec.min) || (spec.max !== undefined && (v as number) > spec.max)) {
          throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} item out of range`);
        }
      }
    } else {
      // json：任意 JSON 值（已经过 stableStringify 顶层校验），按 maxBytes 限字节。
      let serialized: string;
      try {
        serialized = stableStringify(value as JSONValue);
      } catch {
        throw new RuntimeError('TOOL_ARGS_INVALID', `${tool}: ${key} not valid JSON`);
      }
      if (spec.maxBytes !== undefined && Buffer.byteLength(serialized, 'utf8') > spec.maxBytes) {
        throw new RuntimeError('TOOL_INPUT_LIMIT', `${tool}: ${key} too large`);
      }
    }
    out[key] = value;
  }
  return out;
}

// ── 工具实现 ─────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  effect: Effect;
  description: string;
  /** 供 ModelGateway 广播给 provider 的 JSON Schema（M05 接线）。 */
  inputSchema: JSONValue;
  fields: Record<string, FieldSpec>;
  /** M09：OpenClaw 桥接工具标记。桥接工具还必须在本任务授权表的
   *  allowedBridgeTools 里被逐个点名，否则 POLICY_DENIED；桥不可用时
   *  run 必须抛 TOOL_UNAVAILABLE，绝不模拟完成。 */
  bridge?: boolean;
  /** M14：MCP 工具标记（serverId 由 SKF 注册分配）。 */
  mcp?: { serverId: string; toolName: string };
  /** M14：MCP 工具可用性（schema 热变更吊销后为 false）。 */
  available?: () => boolean;
  /** M14：MCP 工具按快照 schema 的严格参数校验（替代 fields 校验）。 */
  validateArgsFn?: (raw: JSONValue) => Record<string, JSONValue>;
  /** M14：副作用审批绑定的执行快照 hash（工具名+规范化参数+server 配置+schema）。 */
  approvalInputHash?: (validatedArgs: Record<string, JSONValue>) => string;
  run(args: Record<string, JSONValue>, rootReal: string, ctx: ToolExecutionContext): Promise<{ content: JSONValue; artifactIds: string[] }>;
}

/** 任务输入里显式授权的桥接工具名单（可信调用方在任务创建时写入；模型 args 改不了）。 */
export function bridgeToolsOfInput(input: JSONValue): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return [];
  const raw = (input as Record<string, JSONValue>).bridgeTools;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

/** M14：任务输入里显式授权的 MCP 工具名单（mcp/<serverId>/<tool>，任务绑定目录快照）。 */
export function mcpToolsOfInput(input: JSONValue): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return [];
  const raw = (input as Record<string, JSONValue>).mcpTools;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && /^mcp\/[a-z0-9][a-z0-9-]{0,62}\/[a-zA-Z0-9_-]{1,64}$/.test(item));
}

/** 截断 UTF-8 末尾不完整的码元，保证分页 slice 仍是合法字符串。 */
function trimIncompleteUtf8(buf: Buffer): Buffer {
  let end = buf.length;
  for (let i = buf.length - 1; i >= 0 && i >= buf.length - 4; i--) {
    const byte = buf[i];
    if (byte < 0x80) break; // ASCII，完整
    const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0;
    if (expected === 0) continue; // continuation byte，继续找起始字节
    if (buf.length - i < expected) end = i;
    break;
  }
  return buf.subarray(0, end);
}

async function runFileRead(args: Record<string, JSONValue>, rootReal: string): Promise<{ content: JSONValue; artifactIds: string[] }> {
  const { relativePath, absolutePath } = await resolveWithinRoot(rootReal, String(args.path));
  const st = await lstat(absolutePath).catch(() => null);
  if (!st) throw new RuntimeError('PATH_NOT_FOUND', relativePath);
  if (st.isDirectory()) throw new RuntimeError('PATH_NOT_FILE', relativePath);
  const offset = Number(args.offsetBytes ?? 0);
  const maxBytes = Number(args.maxBytes ?? FILE_READ_DEFAULT_BYTES);
  const buf = await readFile(absolutePath);
  if (offset > buf.length) throw new RuntimeError('TOOL_ARGS_INVALID', 'offsetBytes beyond end of file');
  const slice = trimIncompleteUtf8(buf.subarray(offset, Math.min(buf.length, offset + maxBytes)));
  const truncated = offset + slice.length < buf.length;
  return {
    content: {
      path: relativePath,
      byteLength: buf.length,
      sha256: sha256HexBytes(buf),
      offsetBytes: offset,
      content: slice.toString('utf8'),
      truncated,
      nextOffsetBytes: truncated ? offset + slice.length : null,
    },
    artifactIds: [],
  };
}

async function runFileWrite(
  args: Record<string, JSONValue>,
  rootReal: string,
  ctx: ToolExecutionContext,
): Promise<{ content: JSONValue; artifactIds: string[] }> {
  const content = Buffer.from(String(args.content), 'utf8');
  if (content.length > FILE_WRITE_MAX_BYTES) throw new RuntimeError('TOOL_INPUT_LIMIT', 'content');
  const result = await atomicWriteVerified({
    rootReal,
    inputPath: String(args.path),
    content,
    expectedSha256: args.expectedSha256 === undefined ? undefined : String(args.expectedSha256),
    hooks: ctx.hooks,
  });
  // 只有写入+读回校验全部通过才登记 artifact（错误路径不得提前落 artifact-success）。
  const artifactIds: string[] = [];
  if (ctx.registerArtifact) {
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
  return {
    content: {
      path: result.relativePath,
      byteLength: result.byteLength,
      sha256: result.sha256,
      created: result.created,
      artifactIds,
    },
    artifactIds,
  };
}

async function runFileList(args: Record<string, JSONValue>, rootReal: string): Promise<{ content: JSONValue; artifactIds: string[] }> {
  const { relativePath, absolutePath } = await resolveWithinRoot(rootReal, String(args.path ?? '.'));
  const st = await lstat(absolutePath).catch(() => null);
  if (!st) throw new RuntimeError('PATH_NOT_FOUND', relativePath);
  if (!st.isDirectory()) throw new RuntimeError('PATH_NOT_DIRECTORY', relativePath);
  const maxEntries = Number(args.maxEntries ?? FILE_LIST_DEFAULT_ENTRIES);
  const names = (await readdir(absolutePath)).sort();
  const entries: JSONValue[] = [];
  for (const name of names.slice(0, maxEntries)) {
    const child = join(absolutePath, name);
    const childStat = await lstat(child).catch(() => null);
    if (!childStat) continue;
    entries.push({
      path: relativePath === '.' ? name : `${relativePath}/${name}`,
      isDir: childStat.isDirectory(),
      byteLength: childStat.isDirectory() ? null : childStat.size,
    });
  }
  return {
    content: { path: relativePath, entries, truncated: names.length > maxEntries, totalEntries: names.length },
    artifactIds: [],
  };
}

async function runFileStat(args: Record<string, JSONValue>, rootReal: string): Promise<{ content: JSONValue; artifactIds: string[] }> {
  const { relativePath, absolutePath } = await resolveWithinRoot(rootReal, String(args.path));
  const st = await lstat(absolutePath).catch(() => null);
  if (!st) throw new RuntimeError('PATH_NOT_FOUND', relativePath);
  const isDir = st.isDirectory();
  return {
    content: {
      path: relativePath,
      isDir,
      byteLength: isDir ? null : st.size,
      sha256: isDir ? null : sha256HexBytes(await readFile(absolutePath)),
      mtimeMs: Math.round(st.mtimeMs),
    },
    artifactIds: [],
  };
}

export const FILE_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'file.read',
    effect: 'read',
    description: 'Read a UTF-8 text excerpt of a file inside the task workspace. Long files are paged via offsetBytes/maxBytes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', maxLength: 1024 },
        offsetBytes: { type: 'integer', minimum: 0 },
        maxBytes: { type: 'integer', minimum: 1, maximum: FILE_READ_MAX_BYTES },
      },
    },
    fields: {
      path: { kind: 'string', required: true, maxLength: 1024 },
      offsetBytes: { kind: 'integer', required: false, min: 0, max: Number.MAX_SAFE_INTEGER },
      maxBytes: { kind: 'integer', required: false, min: 1, max: FILE_READ_MAX_BYTES },
    },
    run: (args, rootReal) => runFileRead(args, rootReal),
  },
  {
    name: 'file.write',
    effect: 'workspace_write',
    description:
      'Create a file inside the task workspace (create-only by default). Overwriting requires expectedSha256 of the current content. Atomic write with read-back verification.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', maxLength: 1024 },
        content: { type: 'string' },
        expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
    fields: {
      path: { kind: 'string', required: true, maxLength: 1024 },
      content: { kind: 'string', required: true, maxLength: FILE_WRITE_MAX_BYTES + 16 },
      expectedSha256: { kind: 'string', required: false, maxLength: 64 },
    },
    run: (args, rootReal, ctx) => runFileWrite(args, rootReal, ctx),
  },
  {
    name: 'file.list',
    effect: 'read',
    description: 'List one directory inside the task workspace (non-recursive, sorted, capped).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', maxLength: 1024 },
        maxEntries: { type: 'integer', minimum: 1, maximum: FILE_LIST_MAX_ENTRIES },
      },
    },
    fields: {
      path: { kind: 'string', required: false, maxLength: 1024 },
      maxEntries: { kind: 'integer', required: false, min: 1, max: FILE_LIST_MAX_ENTRIES },
    },
    run: (args, rootReal) => runFileList(args, rootReal),
  },
  {
    name: 'file.stat',
    effect: 'read',
    description: 'Stat a path inside the task workspace: type, size, sha256 (files), mtime.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', maxLength: 1024 } },
    },
    fields: { path: { kind: 'string', required: true, maxLength: 1024 } },
    run: (args, rootReal) => runFileStat(args, rootReal),
  },
];

// ── 日志脱敏 ─────────────────────────────────────────────

function redactArgsForLog(tool: string, args: JSONValue): JSONValue {
  if (tool === 'file.write' && args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const input = args as Record<string, JSONValue>;
    if (typeof input.content === 'string') {
      const buf = Buffer.from(input.content, 'utf8');
      return { ...input, content: { redacted: true, bytes: buf.length, sha256: sha256HexBytes(buf) } };
    }
  }
  return args;
}

// ── Registry ─────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  /** additional 只增不改：file.* 基础工具恒在；桥接/MCP 工具由调用方显式装配。 */
  constructor(additional: readonly ToolSpec[] = []) {
    for (const spec of FILE_TOOL_SPECS) this.tools.set(spec.name, spec);
    for (const spec of additional) {
      if (this.tools.has(spec.name)) throw new RuntimeError('TOOL_NAME_CONFLICT', spec.name);
      this.tools.set(spec.name, spec);
    }
  }

  /** M14：注册 MCP 工具（重复名 = 失败；mcp/<serverId>/<tool> 命名使其不可能遮蔽 file.*）。 */
  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) throw new RuntimeError('TOOL_NAME_CONFLICT', spec.name);
    this.tools.set(spec.name, spec);
  }

  specOf(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  /** 广播给 provider 的工具 schema 列表。桥接/MCP 工具只有在本任务显式授权名单里
   *  且当前可用（未被吊销）才出现；exec/openclaw 旧透传不在其中（M09 已拆除）。 */
  listSchemas(bridgeAllow?: readonly string[], mcpAllow?: readonly string[]): Array<{ name: string; description: string; inputSchema: JSONValue; effect: Effect }> {
    return [...this.tools.values()]
      .filter((spec) => !spec.bridge || (bridgeAllow ?? []).includes(spec.name))
      .filter((spec) => !spec.mcp || ((mcpAllow ?? []).includes(spec.name) && (spec.available?.() ?? true)))
      .map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        effect: spec.effect,
      }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(callId: string, name: string, args: JSONValue, ctx: ToolExecutionContext): Promise<ToolCallResult> {
    const fail = (code: string, retryable = false, detail?: string): ToolCallResult => {
      ctx.logger?.(`tool ${name} callId=${callId} task=${ctx.taskId} -> ${code} args=${stableStringify(redactArgsForLog(name, args)).slice(0, 300)}`);
      return {
        callId,
        operationId: ctx.operationId ?? null,
        ok: false,
        content: '',
        artifactIds: [],
        error: detail !== undefined ? { code, retryable, detail } : { code, retryable },
      };
    };

    // 开始前查 cancellation 与 deadline（02-E）。
    if (ctx.signal?.aborted) return fail('TOOL_CANCELLED');
    if (ctx.deadlineAt !== undefined && Date.now() > ctx.deadlineAt) return fail('TOOL_DEADLINE_EXCEEDED');

    const spec = this.tools.get(name);
    if (!spec) return fail('UNKNOWN_TOOL');

    let serializedArgs: string;
    try {
      serializedArgs = stableStringify(args);
    } catch {
      return fail('TOOL_ARGS_INVALID');
    }
    if (Buffer.byteLength(serializedArgs, 'utf8') > TOOL_INPUT_MAX_BYTES) return fail('TOOL_INPUT_LIMIT');

    let validated: Record<string, JSONValue>;
    try {
      validated = spec.validateArgsFn ? spec.validateArgsFn(args) : validateArgs(args, name, spec.fields);
    } catch (error) {
      return fail(error instanceof RuntimeError ? error.code : 'TOOL_ARGS_INVALID');
    }

    try {
      if (spec.mcp) {
        // M14 · MCP 门：任务逐个点名授权 + 未被吊销 + 效果裁定。
        if (!(ctx.authorization.allowedMcpTools ?? []).includes(spec.name)) {
          throw new RuntimeError('POLICY_DENIED', `mcp tool ${spec.name} not in task authorization`);
        }
        if (spec.available && !spec.available()) {
          throw new RuntimeError('MCP_SCHEMA_CHANGED', `${spec.name}: schema hot-change revoked; operator acceptSchemaChange required`);
        }
        if (spec.effect === 'external_write' || spec.effect === 'process') {
          // 副作用：默认审批绑定参数 hash（执行快照）。无审批渠道/未批准 = fail-closed。
          const hash = spec.approvalInputHash!(validated);
          if (!ctx.hasApproved || !ctx.hasApproved(hash)) {
            throw new RuntimeError('APPROVAL_REQUIRED', `${spec.name}: ${spec.effect} requires approval bound to args hash`);
          }
        } else {
          authorizeEffect(spec.effect, ctx.authorization);
        }
      } else if (spec.approvalInputHash && (spec.effect === 'external_write' || spec.effect === 'process')) {
        // M17 · 桌面工具门：非 MCP 但声明审批 hash 的副作用工具（clipboard.write / desktop.launch）
        // 走 hasApproved(inputHash) 门——和 MCP 同套纪律，绝不被 authorizeEffect 误拒。
        const hash = spec.approvalInputHash(validated);
        if (!ctx.hasApproved || !ctx.hasApproved(hash)) {
          throw new RuntimeError('APPROVAL_REQUIRED', `${spec.name}: ${spec.effect} requires approval bound to args hash`);
        }
      } else {
        // PolicyGate：任务授权表内的效果直接放行；external_write/process 无适配器 → unavailable。
        authorizeEffect(spec.effect, ctx.authorization);
      }
      if (spec.bridge && !(ctx.authorization.allowedBridgeTools ?? []).includes(spec.name)) {
        // M09：桥接工具逐个点名授权，不允许从模型 args 或默认放行绕过。
        throw new RuntimeError('POLICY_DENIED', `bridge tool ${spec.name} not in task authorization`);
      }
      if (ctx.authorization.workspaceRoot !== ctx.workspaceRoot) {
        // 授权表与执行上下文 root 必须一致，防止换 root 后沿用旧授权。
        throw new RuntimeError('POLICY_DENIED', 'authorization root mismatch');
      }
      const { rootReal } = await openWorkspaceRoot(ctx.workspaceRoot);
      const { content, artifactIds } = await spec.run(validated, rootReal, ctx);
      const serialized = stableStringify(content);
      if (Buffer.byteLength(serialized, 'utf8') > TOOL_RESULT_MAX_BYTES) {
        // 兜底：工具实现应自行分页截断；超限说明实现有误，失败而不是截掉半个 JSON。
        return fail('TOOL_OUTPUT_LIMIT');
      }
      ctx.logger?.(
        `tool ${name} callId=${callId} task=${ctx.taskId} -> ok args=${stableStringify(redactArgsForLog(name, args)).slice(0, 300)} artifacts=${artifactIds.length}`,
      );
      return { callId, operationId: ctx.operationId ?? null, ok: true, content: serialized, artifactIds };
    } catch (error) {
      if (error instanceof RuntimeError) {
        // M14：只有 MCP_* 错误码透传 detail（server 错误文本等，已消毒截断）；
        // 既有错误码形状保持不变（账本/回灌兼容性）。
        const detail = error.code.startsWith('MCP_') && error.message.includes(': ') ? error.message.slice(error.message.indexOf(': ') + 2).slice(0, 1000) : undefined;
        return fail(error.code, false, detail);
      }
      return fail('TOOL_INTERNAL');
    }
  }
}
