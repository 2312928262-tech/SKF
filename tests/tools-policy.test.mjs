import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { authorizeEffect, localDeliveryAuthorization } from '../dist/tools/policy.js';

// M04 验收：有边界的 file 工具 + PolicyGate。
// 覆盖：创建→读回 hash 一致、覆盖竞态不损坏文件、路径穿越/symlink-junction 拒绝、
// 未知工具/多余参数/超大参数拒绝、取消与 deadline、分页、日志脱敏、授权表。
// 全部在本机临时目录，无网络、无付费调用。

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-v2-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const wsReal = await realpath(ws);
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const service = new TaskService(store, 'm04-test');
  const registry = new ToolRegistry();
  const logs = [];
  service.createTask({
    id: 'task-m04',
    input: { goal: 'file tools test' },
    sessionId: 's',
    scope: 'skf-test',
    workspaceRoot: ws,
    provider: 'fake',
    model: 'fake-scripted-1',
  });
  const ctx = (overrides = {}) => ({
    taskId: 'task-m04',
    workspaceRoot: ws,
    authorization: localDeliveryAuthorization(ws),
    logger: (line) => logs.push(line),
    ...overrides,
  });
  return { root, ws, wsReal, store, service, registry, logs, ctx };
}

test('create → read back：hash 一致，artifact 登记进 runtime.sqlite', async () => {
  const env = await makeEnv();
  const { registry, service, store, ctx } = env;
  try {
    // 走 M03 operations：工具成功后 artifact 才能挂到 succeeded 操作
    service.createOperation({ id: 'op-1', taskId: 'task-m04', callId: 'call-1', toolName: 'file.write', input: { path: 'notes/a.md', content: 'hello SKF' } });
    service.transitionOperation('op-1', 'running');
    const content = 'hello SKF';
    const write = await registry.execute('call-1', 'file.write', { path: 'notes/a.md', content }, ctx({
      operationId: 'op-1',
      registerArtifact: (rec) => {
        service.transitionOperation('op-1', 'succeeded');
        service.registerArtifact(rec);
      },
    }));
    assert.equal(write.ok, true, write.error?.code);
    const written = JSON.parse(write.content);
    assert.equal(written.path, 'notes/a.md');
    assert.equal(written.created, true);
    assert.equal(written.sha256, sha256(Buffer.from(content, 'utf8')));
    assert.equal(written.artifactIds.length, 1);
    const artifact = store.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(written.artifactIds[0]);
    assert.equal(artifact.relativePath, 'notes/a.md');
    assert.equal(artifact.sha256, written.sha256);
    assert.equal(artifact.byteLength, Buffer.byteLength(content, 'utf8'));

    const read = await registry.execute('call-2', 'file.read', { path: 'notes/a.md' }, ctx());
    assert.equal(read.ok, true, read.error?.code);
    const back = JSON.parse(read.content);
    assert.equal(back.content, content);
    assert.equal(back.sha256, written.sha256);
    assert.equal(back.truncated, false);

    const stat = await registry.execute('call-3', 'file.stat', { path: 'notes/a.md' }, ctx());
    assert.equal(stat.ok, true);
    assert.equal(JSON.parse(stat.content).sha256, written.sha256);

    // artifact 挂在未成功操作上必须被拒绝（错误路径不得提前落 artifact-success）
    service.createOperation({ id: 'op-x', taskId: 'task-m04', callId: 'call-x', toolName: 'file.write', input: { path: 'z', content: 'z' } });
    assert.throws(
      () => service.registerArtifact({ id: 'a-x', taskId: 'task-m04', operationId: 'op-x', relativePath: 'z', byteLength: 1, sha256: sha256('z') }),
      /OPERATION_NOT_SUCCEEDED/,
    );
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});

test('file.write 覆盖规则：create-only / expectedSha256 不一致拒绝 / 一致放行', async () => {
  const env = await makeEnv();
  const { registry, store, ctx } = env;
  try {
    const first = await registry.execute('c1', 'file.write', { path: 'f.txt', content: 'v1' }, ctx());
    assert.equal(first.ok, true);
    const h1 = JSON.parse(first.content).sha256;

    // create-only：无 expectedSha256 拒绝
    const dup = await registry.execute('c2', 'file.write', { path: 'f.txt', content: 'v2' }, ctx());
    assert.equal(dup.ok, false);
    assert.equal(dup.error.code, 'FILE_EXISTS');

    // hash 不符：HASH_CONFLICT，文件不被写掉
    const conflict = await registry.execute('c3', 'file.write', { path: 'f.txt', content: 'v2', expectedSha256: sha256('wrong') }, ctx());
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'HASH_CONFLICT');
    assert.equal(await readFile(join(env.ws, 'f.txt'), 'utf8'), 'v1');

    // hash 一致：放行，读回新 hash
    const ok = await registry.execute('c4', 'file.write', { path: 'f.txt', content: 'v2', expectedSha256: h1 }, ctx());
    assert.equal(ok.ok, true, ok.error?.code);
    assert.equal(JSON.parse(ok.content).created, false);
    assert.equal(await readFile(join(env.ws, 'f.txt'), 'utf8'), 'v2');

    // 非法 expectedSha256 格式
    const bad = await registry.execute('c5', 'file.write', { path: 'f.txt', content: 'v3', expectedSha256: 'xyz' }, ctx());
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'TOOL_ARGS_INVALID');
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});

test('覆盖竞态：提交前目标被并行修改 → HASH_CONFLICT，用户文件不损坏、临时文件清干净', async () => {
  const env = await makeEnv();
  const { registry, store, ctx } = env;
  try {
    const first = await registry.execute('c1', 'file.write', { path: 'race.txt', content: 'v1' }, ctx());
    const h1 = JSON.parse(first.content).sha256;

    // 模拟用户/另一进程在临时文件写好后、rename 前改了目标
    const raced = await registry.execute(
      'c2',
      'file.write',
      { path: 'race.txt', content: 'v2-agent', expectedSha256: h1 },
      ctx({ hooks: { beforeCommit: (target) => writeFile(target, 'v3-user-edit', 'utf8') } }),
    );
    assert.equal(raced.ok, false);
    assert.equal(raced.error.code, 'HASH_CONFLICT');
    // 用户的并行修改原样保留，没有被 agent 的 v2 覆盖
    assert.equal(await readFile(join(env.ws, 'race.txt'), 'utf8'), 'v3-user-edit');
    // 临时文件清理干净
    const leftovers = (await readdir(env.ws)).filter((f) => f.includes('.skf-tmp-'));
    assert.deepEqual(leftovers, []);

    // create-only 竞态：检查时不存在、提交前出现 → 同样冲突且不覆盖
    const raced2 = await registry.execute(
      'c3',
      'file.write',
      { path: 'new.txt', content: 'agent' },
      ctx({ hooks: { beforeCommit: (target) => writeFile(target, 'user', 'utf8') } }),
    );
    assert.equal(raced2.ok, false);
    assert.equal(raced2.error.code, 'HASH_CONFLICT');
    assert.equal(await readFile(join(env.ws, 'new.txt'), 'utf8'), 'user');
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});

test('路径防护：穿越 / 绝对越界 / UNC / 设备名 / junction 逃逸全部拒绝', async () => {
  const env = await makeEnv();
  const { registry, store, ctx } = env;
  try {
    const cases = [
      ['../escape.txt', 'PATH_OUTSIDE_ROOT'],
      ['sub/../../escape.txt', 'PATH_OUTSIDE_ROOT'],
      [join(env.root, 'outside.txt'), 'PATH_OUTSIDE_ROOT'], // 绝对路径越界
      ['\\\\\\\\server\\\\share\\\\x.txt'.replace(/\\\\/g, '\\'), 'PATH_UNC'], // \\server\share\x.txt
      ['NUL', 'PATH_DEVICE'],
      ['sub/COM1.txt', 'PATH_DEVICE'],
    ];
    for (const [path, code] of cases) {
      const w = await registry.execute('w', 'file.write', { path, content: 'x' }, ctx());
      assert.equal(w.ok, false, path);
      assert.equal(w.error.code, code, `${path} -> ${w.error.code}`);
      const r = await registry.execute('r', 'file.read', { path }, ctx());
      assert.equal(r.ok, false, path);
      assert.equal(r.error.code, code, `read ${path} -> ${r.error.code}`);
    }
    // 盘符相对路径不可判定 → 拒绝
    const drv = await registry.execute('w', 'file.write', { path: 'C:foo.txt', content: 'x' }, ctx());
    assert.equal(drv.error.code, 'PATH_INVALID');

    // 绝对路径在 root 内：允许
    const inside = await registry.execute('w', 'file.write', { path: join(env.wsReal, 'abs-inside.txt'), content: 'ok' }, ctx());
    assert.equal(inside.ok, true, inside.error?.code);

    // junction 逃逸：root 内链接指向 root 外目录（Windows junction 通常不需要管理员）
    const outsideDir = join(env.root, 'outside');
    await mkdir(outsideDir, { recursive: true });
    const linkPath = join(env.ws, 'link-out');
    let made = true;
    try {
      symlinkSync(outsideDir, linkPath, 'junction');
    } catch {
      made = false;
    }
    if (made) {
      const wj = await registry.execute('w', 'file.write', { path: 'link-out/evil.txt', content: 'x' }, ctx());
      assert.equal(wj.ok, false);
      assert.equal(wj.error.code, 'PATH_OUTSIDE_ROOT');
      const rj = await registry.execute('r', 'file.read', { path: 'link-out/evil.txt' }, ctx());
      assert.equal(rj.error.code, 'PATH_OUTSIDE_ROOT');
      // 穿越到 junction 的祖父级也不行
      const lj = await registry.execute('l', 'file.list', { path: 'link-out' }, ctx());
      assert.equal(lj.error.code, 'PATH_OUTSIDE_ROOT');
    }
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});

test('schema 严格：未知工具 / 多余字段（含模型塞 workspaceRoot）/ 超大参数拒绝', async () => {
  const env = await makeEnv();
  const { registry, store, ctx } = env;
  try {
    // exec/openclaw 首版不注册给 AgentLoop
    for (const name of ['exec', 'openclaw', 'shell', 'file.delete']) {
      const r = await registry.execute('c', name, { path: 'a' }, ctx());
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'UNKNOWN_TOOL', name);
    }
    // 多余字段拒绝；模型无法在 args 重定义 root
    const extra = await registry.execute('c', 'file.read', { path: 'a', workspaceRoot: 'D:/' }, ctx());
    assert.equal(extra.error.code, 'TOOL_ARGS_INVALID');
    const wrongType = await registry.execute('c', 'file.read', { path: 1 }, ctx());
    assert.equal(wrongType.error.code, 'TOOL_ARGS_INVALID');
    const missing = await registry.execute('c', 'file.write', { path: 'a' }, ctx());
    assert.equal(missing.error.code, 'TOOL_ARGS_INVALID');
    // 超大序列化参数
    const huge = await registry.execute('c', 'file.write', { path: 'a.txt', content: 'x'.repeat(2_000_000) }, ctx());
    assert.equal(huge.error.code, 'TOOL_INPUT_LIMIT');
    // 单字段超上限
    const bigField = await registry.execute('c', 'file.write', { path: 'a.txt', content: 'x'.repeat(1_100_000) }, ctx());
    assert.equal(bigField.error.code, 'TOOL_INPUT_LIMIT');
    const bigPath = await registry.execute('c', 'file.read', { path: 'a'.repeat(2000) }, ctx());
    assert.equal(bigPath.error.code, 'TOOL_INPUT_LIMIT');
    // 非对象 args
    const notObj = await registry.execute('c', 'file.read', 'nope', ctx());
    assert.equal(notObj.error.code, 'TOOL_ARGS_INVALID');
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});

test('长输出分页：read 截断带 nextOffset，拼回原文件 hash 一致；list 截断标记', async () => {
  const env = await makeEnv();
  const { registry, store, ctx } = env;
  try {
    // 100KB 含中文内容
    const body = 'SKF'.repeat(200) + 'x'.repeat(100_000);
    await registry.execute('w', 'file.write', { path: 'big.txt', content: body }, ctx());
    const fullHash = sha256(Buffer.from(body, 'utf8'));

    let offset = 0;
    let collected = '';
    let pages = 0;
    for (;;) {
      const r = await registry.execute(`r${pages}`, 'file.read', { path: 'big.txt', offsetBytes: offset, maxBytes: 10_000 }, ctx());
      assert.equal(r.ok, true, r.error?.code);
      const page = JSON.parse(r.content);
      assert.equal(page.sha256, fullHash, '每页都带整文件 hash');
      assert.ok(Buffer.byteLength(r.content, 'utf8') <= 96_000, '结果序列化在硬上限内');
      collected += page.content;
      pages++;
      if (!page.truncated) break;
      assert.ok(page.nextOffsetBytes > offset, '分页必须前进');
      offset = page.nextOffsetBytes;
      assert.ok(pages < 100, '分页收敛');
    }
    assert.ok(pages > 1, '确实分了多页');
    assert.equal(sha256(Buffer.from(collected, 'utf8')), fullHash, '分页拼接=原文件');

    // offset 越界
    const over = await registry.execute('r', 'file.read', { path: 'big.txt', offsetBytes: 999_999_999 }, ctx());
    assert.equal(over.error.code, 'TOOL_ARGS_INVALID');

    // list 截断
    for (let i = 0; i < 5; i++) await registry.execute(`w${i}`, 'file.write', { path: `d/${i}.txt`, content: String(i) }, ctx());
    const list = await registry.execute('l', 'file.list', { path: 'd', maxEntries: 2 }, ctx());
    const listed = JSON.parse(list.content);
    assert.equal(listed.entries.length, 2);
    assert.equal(listed.truncated, true);
    assert.equal(listed.totalEntries, 5);
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});

test('取消与 deadline：开始前即拒绝；授权表外效果 → POLICY_DENIED / TOOL_UNAVAILABLE', async () => {
  const env = await makeEnv();
  const { registry, store, ctx, ws } = env;
  try {
    const ac = new AbortController();
    ac.abort();
    const cancelled = await registry.execute('c', 'file.read', { path: 'a' }, ctx({ signal: ac.signal }));
    assert.equal(cancelled.error.code, 'TOOL_CANCELLED');

    const late = await registry.execute('c', 'file.read', { path: 'a' }, ctx({ deadlineAt: Date.now() - 1000 }));
    assert.equal(late.error.code, 'TOOL_DEADLINE_EXCEEDED');

    // 只授权 read 的任务：写 → POLICY_DENIED
    const readOnly = await registry.execute('c', 'file.write', { path: 'a.txt', content: 'x' }, ctx({ authorization: { workspaceRoot: ws, allowedEffects: ['read'] } }));
    assert.equal(readOnly.error.code, 'POLICY_DENIED');

    // external_write / process 无适配器 → unavailable，不模拟完成
    for (const effect of ['external_write', 'process']) {
      assert.throws(() => authorizeEffect(effect, localDeliveryAuthorization(ws)), new RegExp('TOOL_UNAVAILABLE'));
    }
    assert.doesNotThrow(() => authorizeEffect('workspace_write', localDeliveryAuthorization(ws)));

    // 授权表 root 与执行上下文不一致 → 拒绝（换 root 不能沿用旧授权）
    const swapped = await registry.execute('c', 'file.read', { path: 'a' }, ctx({ authorization: { workspaceRoot: 'D:/elsewhere', allowedEffects: ['read'] } }));
    assert.equal(swapped.error.code, 'POLICY_DENIED');
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});

test('日志脱敏：file.write 内容不进日志；错误只有 code 不含文件内容', async () => {
  const env = await makeEnv();
  const { registry, store, ctx, logs } = env;
  try {
    const secret = 'TOP-SECRET-SKF-do-not-log';
    const r = await registry.execute('c1', 'file.write', { path: 's.txt', content: secret }, ctx());
    assert.equal(r.ok, true);
    const conflict = await registry.execute('c2', 'file.write', { path: 's.txt', content: secret }, ctx());
    assert.equal(conflict.error.code, 'FILE_EXISTS');
    assert.ok(logs.length >= 2, '有日志行');
    for (const line of logs) {
      assert.ok(!line.includes(secret), `日志不得含文件内容: ${line}`);
    }
    assert.ok(logs.some((line) => line.includes(sha256(Buffer.from(secret, 'utf8')))), '日志保留内容 hash 供核对');
    assert.ok(conflict.content === '', '失败结果不回内容');
  } finally {
    store.close();
    await cleanupTestRoot(env.root).catch(() => {});
  }
});
