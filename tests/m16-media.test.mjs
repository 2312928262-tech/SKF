// M16 · 媒体工具验收测试
// 覆盖：注册/effect 分级 / 出图产物 hash 登记 / TTS 产物 hash 登记 / 转写 /
// 显存管理审批门 / 命名空间 / 错误码白名单 / 产物路径安全。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { buildMediaTools } from '../dist/media/registry.js';
import { FakeMediaBridge } from '../dist/media/media-bridge.js';
import { validateSafeBasename } from '../dist/media/contracts.js';

async function makeEnv(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skf-m16-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm16-test');
  const toolRegistry = new ToolRegistry();
  const bridge = new FakeMediaBridge();
  if (opts.healthState) bridge.setHealth(opts.healthState);
  for (const spec of buildMediaTools({ bridge })) toolRegistry.register(spec);
  const taskId = opts.taskId ?? 'task-m16';
  service.createTask({
    id: taskId, input: { goal: opts.goal ?? 'M16 验收任务' }, sessionId: 's-m16',
    scope: 'skf-test', workspaceRoot: ws, provider: 'fake', model: 'fake-scripted-1',
  });
  return { root, ws, store, service, toolRegistry, bridge, taskId, cleanup: () => cleanup(root, store) };
}

async function cleanup(root, store) {
  try { store.close(); } catch { /* closed */ }
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m16-[a-zA-Z0-9]+$/);
  for (let i = 0; i < 5; i++) {
    try { await rm(absolute, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 80 * (i + 1))); }
  }
}

const execTool = (env, name, args, extra = {}) =>
  env.toolRegistry.execute(`t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, args, {
    taskId: env.taskId, workspaceRoot: env.ws,
    authorization: { ...localDeliveryAuthorization(env.ws), allowedMcpTools: [] },
    ...(extra.hasApproved !== undefined ? { hasApproved: extra.hasApproved } : {}),
    ...(extra.registerArtifact !== undefined ? { registerArtifact: extra.registerArtifact } : {}),
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
  });

// ── T01: 注册 + effect 分级 ─────────────────────────────────────────

test('T01 四个 media 工具注册成功 + effect 分级正确', async () => {
  const env = await makeEnv();
  try {
    const expectations = [
      ['media.image', 'workspace_write'],
      ['media.tts', 'workspace_write'],
      ['media.transcribe', 'read'],
      ['media.vram.manage', 'process'],
    ];
    for (const [name, effect] of expectations) {
      assert.ok(env.toolRegistry.has(name), `has ${name}`);
      assert.equal(env.toolRegistry.specOf(name).effect, effect, `${name} effect`);
    }
  } finally { await env.cleanup(); }
});

// ── T02: media.image 出图 + 产物 hash 登记 ─────────────────────────

test('T02 media.image 出图 → 产物 sha256 登记 artifact', async () => {
  const env = await makeEnv();
  try {
    const artifacts = [];
    const r = await execTool(env, 'media.image', { prompt: '一只猫', filename: 'cat.png' }, {
      registerArtifact: (rec) => artifacts.push(rec),
    });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'generated');
    assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
    assert.ok(parsed.byteLength > 0);
    // 产物 hash 登记到 artifact
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].relativePath, 'cat.png');
    assert.equal(artifacts[0].sha256, parsed.sha256);
  } finally { await env.cleanup(); }
});

// ── T03: media.tts 产物 hash 登记 ──────────────────────────────────

test('T03 media.tts 产物 sha256 登记 artifact', async () => {
  const env = await makeEnv();
  try {
    const artifacts = [];
    const r = await execTool(env, 'media.tts', { text: '你好世界', filename: 'hello.wav' }, {
      registerArtifact: (rec) => artifacts.push(rec),
    });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'generated');
    assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].relativePath, 'hello.wav');
  } finally { await env.cleanup(); }
});

// ── T04: media.transcribe 转写 ─────────────────────────────────────

test('T04 media.transcribe 转写音频为文本', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'media.transcribe', { audioPath: 'input.wav' });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'ok');
    assert.ok(parsed.text.length > 0);
  } finally { await env.cleanup(); }
});

// ── T05: media.vram.manage 无审批 → APPROVAL_REQUIRED ──────────────

test('T05 media.vram.manage 是 process，无审批 → APPROVAL_REQUIRED', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'media.vram.manage', { action: 'load', gb: 8 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    assert.equal(env.bridge.stats.vram, 0, '无审批时绝不执行显存操作');
  } finally { await env.cleanup(); }
});

// ── T06: media.vram.manage 审批 hash 一致 → ok ─────────────────────

test('T06 media.vram.manage 审批 hash 一致 → ok', async () => {
  const env = await makeEnv();
  try {
    const { createHash } = await import('node:crypto');
    const args = { action: 'release', gb: 0 };
    const hash = createHash('sha256').update('media.vram.manage:' + JSON.stringify(args), 'utf8').digest('hex');
    const r = await execTool(env, 'media.vram.manage', args, { hasApproved: (h) => h === hash });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.action, 'release');
  } finally { await env.cleanup(); }
});

// ── T07: 产物路径安全（basename 非法字符拒绝）─────────────────────

test('T07 validateSafeBasename 拒绝路径分隔符/控制字符/点边缘', () => {
  assert.equal(validateSafeBasename('a/b.png').ok, false);
  assert.equal(validateSafeBasename('a\\b.png').ok, false);
  assert.equal(validateSafeBasename('.hidden.png').ok, false);
  assert.equal(validateSafeBasename('ok.png').ok, true);
});

// ── T08: 命名空间 ─────────────────────────────────────────────────

test('T08 命名空间：media.* 不与 file.*/desktop.*/browser.*/web.* 重名', async () => {
  const env = await makeEnv();
  try {
    for (const name of ['file.read', 'media.image', 'media.tts', 'media.transcribe', 'media.vram.manage']) {
      assert.ok(env.toolRegistry.has(name), `has ${name}`);
    }
    assert.throws(() => env.toolRegistry.register({
      name: 'media.image', effect: 'workspace_write', description: 'dup', inputSchema: {}, fields: {},
      run: async () => ({ content: {}, artifactIds: [] }),
    }), /TOOL_NAME_CONFLICT/);
  } finally { await env.cleanup(); }
});

// ── T09: 错误码白名单 ────────────────────────────────────────────

test('T09 M16 错误码全部在 IPC_V2_PUBLIC_ERRORS 白名单内', async () => {
  const { IPC_V2_PUBLIC_ERRORS } = await import('../dist/runtime/ipc-v2.js');
  const codes = ['MEDIA_UNAVAILABLE', 'MEDIA_IMAGE_FAILED', 'MEDIA_TTS_FAILED', 'MEDIA_TRANSCRIBE_FAILED',
    'MEDIA_VRAM_FAILED', 'MEDIA_INPUT_INVALID', 'MEDIA_TIMEOUT', 'MEDIA_ARTIFACT_MISSING', 'MEDIA_PATH_INVALID'];
  for (const code of codes) assert.ok(IPC_V2_PUBLIC_ERRORS.has(code), `${code} in whitelist`);
});

// ── T10: 非法 basename → MEDIA_PATH_INVALID ────────────────────────

test('T10 非法 basename（路径分隔符）→ MEDIA_PATH_INVALID', async () => {
  const env = await makeEnv();
  try {
    const r = await execTool(env, 'media.image', { prompt: 'x', filename: 'a/b.png' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'MEDIA_PATH_INVALID');
  } finally { await env.cleanup(); }
});

// ── T11: 媒体桥 unhealthy → MEDIA_UNAVAILABLE ─────────────────────

test('T11 媒体桥 unhealthy → MEDIA_UNAVAILABLE', async () => {
  const env = await makeEnv({ healthState: { state: 'unavailable', detail: 'no gpu' } });
  try {
    const r = await execTool(env, 'media.transcribe', { audioPath: 'x.wav' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'MEDIA_UNAVAILABLE');
  } finally { await env.cleanup(); }
});
