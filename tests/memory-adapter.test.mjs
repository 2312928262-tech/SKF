// M01 验收：统一记忆主档接入。
// 全部使用隔离临时 vault 与临时 outbox；semantic=false（不依赖本地 bge-m3）；无任何云调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// M11：默认测 dev 的 dist/vendor；设 SKF_TEST_DIST_DIR/SKF_TEST_VENDOR_DIR 时测 MSI 包内实物。
const DIST = process.env.SKF_TEST_DIST_DIR ? resolve(process.env.SKF_TEST_DIST_DIR) : resolve(import.meta.dirname, '../dist');
const VENDOR = process.env.SKF_TEST_VENDOR_DIR ? resolve(process.env.SKF_TEST_VENDOR_DIR) : resolve(import.meta.dirname, '../vendor/memory-runtime');
const { MemoryAdapter, MemoryError } = await import(pathToFileURL(join(DIST, 'runtime/memory-adapter.js')).href);
const { assembleContext, formatContextReport } = await import(pathToFileURL(join(DIST, 'runtime/context-adapter.js')).href);

async function makeTemp() {
  return mkdtemp(join(tmpdir(), 'skf-mem-'));
}
async function cleanup(root) {
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(resolve(tmpdir()).length + 1), /^skf-mem-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}
function adapter(root, scope, sessionId, outboxDir, extra = {}) {
  return new MemoryAdapter({
    root, scope, sessionId, vendorDir: VENDOR, outboxDir,
    semantic: false, maxInputBytes: 18000, ...extra,
  });
}
const userSource = (locator) => [{ kind: 'user', locator }];

test('两份隔离 workspace 共用一份 vault：事实/任务跨适配器可见，幂等安全', async (t) => {
  const root = await makeTemp();
  try {
    const vault = join(root, 'vault');
    const a = adapter(vault, 'skf-test', 'sess-a', join(root, 'out-a'));
    const b = adapter(vault, 'skf-test', 'sess-b', join(root, 'out-b'));
    await a.init(); await b.init();
    assert.equal(a.available, true); assert.equal(b.available, true);

    const fact = await a.record(
      { kind: 'fact', trust: 'user_confirmed', text: 'SKF 合并基线根哈希测试事实 alpha001', source: userSource('test:t1') },
      'test:t1:fact:1',
    );
    assert.ok(fact.id);

    await a.close({
      operationId: 'sess-a:close:task-1',
      summary: 'A 完成基线合并回归测试',
      tasks: [{ id: 'task-m01-test', scope: 'skf-test', title: '验证跨适配器可见性', state: 'pending', nextAction: '用 B 准备确认', evidence: [] }],
    });
    // 幂等：同 operationId 同内容重放不报错、不重复
    await a.close({
      operationId: 'sess-a:close:task-1',
      summary: 'A 完成基线合并回归测试',
      tasks: [{ id: 'task-m01-test', scope: 'skf-test', title: '验证跨适配器可见性', state: 'pending', nextAction: '用 B 准备确认', evidence: [] }],
    });
    // 同 operationId 不同内容必须拒绝
    await assert.rejects(
      a.close({ operationId: 'sess-a:close:task-1', summary: '篡改后的摘要' }),
      (err) => err instanceof MemoryError && err.code === 'IDEMPOTENCY_CONFLICT',
    );

    // B（另一个“框架”）准备同 scope：任务与事实可见
    const prepared = await b.prepare({ requestId: 'b:prepare:1', query: '根哈希' });
    const ids = prepared.prepared.modelInput.evidence.map((e) => e.id);
    assert.ok(ids.includes(fact.id), 'B 应通过检索看到 A 写的事实');
    const taskIds = prepared.prepared.modelInput.tasks.map((x) => x.id);
    assert.ok(taskIds.includes('task-m01-test'), 'B 应看到 A 登记的 pending 任务');

    // search/get 可回读来源
    const hit = await b.search('alpha001');
    assert.equal(hit.hits[0].id, fact.id);
    const got = await b.get(fact.id);
    assert.equal(got.source[0].locator, 'test:t1');

    // source/session/task/idempotency 可回读：session 摘要同 scope 可见
    const prepared2 = await b.prepare({ requestId: 'b:prepare:2', query: '基线合并' });
    // B 的 sessionId 是 sess-b；A 的会话摘要只有同 sessionId 才注入，这里应为 null
    assert.equal(prepared2.prepared.modelInput.sessionSummary, null);
  } finally {
    await cleanup(root);
  }
});

test('scope 隔离：其他客户 scope 不泄露；global 核心所有 scope 可读', async () => {
  const root = await makeTemp();
  try {
    const vault = join(root, 'vault');
    const a = adapter(vault, 'skf-test', 'sess-a', join(root, 'out-a'));
    const other = adapter(vault, 'client:other', 'sess-c', join(root, 'out-c'));
    await a.init(); await other.init();

    const secret = await a.record(
      { kind: 'fact', trust: 'user_confirmed', text: 'client beta 专属机密条款 betaSecret002', scope: 'client:beta', source: userSource('test:t2') },
      'test:t2:fact:1',
    );
    await a.record(
      { kind: 'preference', trust: 'user_confirmed', text: '全局偏好：回答用中文 globalPref003', scope: 'global', slot: 'test-slot', pinned: true, source: userSource('test:t2') },
      'test:t2:pref:1',
    );

    // 同 vault 但 scope=skf-test：看不到 client:beta 的记录
    const r1 = await a.search('betaSecret002');
    assert.equal(r1.hits.length, 0, 'skf-test 不应检索到 client:beta 记录');
    // scope=client:other 同样看不到
    const r2 = await other.search('betaSecret002');
    assert.equal(r2.hits.length, 0, 'client:other 不应检索到 client:beta 记录');
    void secret;

    // global pinned 核心对两个 scope 都注入
    const p1 = await a.prepare({ requestId: 't2:p:1', query: '随便问' });
    assert.ok(p1.prepared.modelInput.core.some((r) => r.text.includes('globalPref003')));
    const p2 = await other.prepare({ requestId: 't2:p:2', query: '随便问' });
    assert.ok(p2.prepared.modelInput.core.some((r) => r.text.includes('globalPref003')));
  } finally {
    await cleanup(root);
  }
});

test('导出到第二路径 verify 并回读', async () => {
  const root = await makeTemp();
  try {
    const vault = join(root, 'vault');
    const a = adapter(vault, 'skf-test', 'sess-a', join(root, 'out-a'));
    await a.init();
    const fact = await a.record(
      { kind: 'decision', trust: 'user_confirmed', text: '迁移回读验证决定 delta004', source: userSource('test:t3') },
      'test:t3:decision:1',
    );
    const verified = await a.verify();
    assert.equal(verified.ok, true);

    const { MemoryVault } = await import(pathToFileURL(join(VENDOR, 'store.mjs')).href);
    const exportFile = join(root, 'portable.json');
    const v1 = new MemoryVault(vault);
    try { v1.export(exportFile); } finally { v1.close(); }

    const restoredRoot = join(root, 'restored');
    const v2 = new MemoryVault(restoredRoot);
    try {
      v2.importBundle(exportFile);
      assert.equal(v2.verify().ok, true);
      const got = v2.get(fact.id);
      assert.ok(got.text.includes('delta004'));
    } finally { v2.close(); }

    // 回读后的库也可通过适配器检索
    const b = adapter(restoredRoot, 'skf-test', 'sess-b', join(root, 'out-b'));
    await b.init();
    const hit = await b.search('delta004');
    assert.equal(hit.hits[0].id, fact.id);
  } finally {
    await cleanup(root);
  }
});

test('字节预算：强制上下文超限拒绝；可选证据先裁；核心不静默截掉', async () => {
  const root = await makeTemp();
  try {
    const vault = join(root, 'vault');
    const tight = adapter(vault, 'skf-test', 'sess-a', join(root, 'out-a'), { maxInputBytes: 1024 });
    await tight.init();
    // system 本身就超过 1024 字节预算 ⇒ 必须拒绝而不是静默截掉
    await assert.rejects(
      tight.prepare({ requestId: 't4:p:1', query: '预算测试', system: 'x'.repeat(4096) }),
      (err) => err instanceof MemoryError && err.code === 'MANDATORY_CONTEXT_TOO_LARGE',
    );

    // ContextAdapter：证据从低相关开始裁，核心超限直接拒绝
    const prepared = {
      requestId: 'fake',
      modelInput: {
        memoryPolicy: '规则', system: '', toolSchemas: [], query: 'q', recent: [], sessionSummary: null, tasks: [],
        core: [{ id: 'c1', kind: 'identity', trust: 'user_confirmed', text: '核心身份' }],
        evidence: Array.from({ length: 20 }, (_, i) => ({ id: 'e' + i, kind: 'fact', trust: 'legacy', text: '证据'.repeat(50) })),
      },
      warnings: [],
    };
    const assembled = assembleContext(prepared, { maxBytes: 4000 });
    assert.ok(assembled.usedBytes <= 4000);
    assert.ok(assembled.sections.evidence < 20, '证据应被裁剪');
    assert.ok(assembled.text.includes('核心身份'), '核心必须保留');
    assert.ok(assembled.warnings.includes('EVIDENCE_TRIMMED_BY_ADAPTER'));

    const hugeCore = {
      requestId: 'fake2',
      modelInput: { ...prepared.modelInput, core: [{ id: 'c2', kind: 'identity', trust: 'user_confirmed', text: '核'.repeat(5000) }], evidence: [] },
      warnings: [],
    };
    assert.throws(() => assembleContext(hugeCore, { maxBytes: 1000 }), /MANDATORY_CONTEXT_TOO_LARGE/);

    // 报告可用且标明口径
    const report = formatContextReport(prepared, assembled);
    assert.match(report, /UTF-8/);
  } finally {
    await cleanup(root);
  }
});

test('主档不可用：任务输入保留 + 写回入 outbox；恢复后幂等重放', async () => {
  const root = await makeTemp();
  try {
    // 用“文件占住 vault 路径”制造不可用（mkdir 冲突）
    const blockedVault = join(root, 'blocked-vault');
    await writeFile(blockedVault, 'not a directory');
    const outbox = join(root, 'out-x');

    const down = adapter(blockedVault, 'skf-test', 'sess-x', outbox);
    await down.init();
    assert.equal(down.available, false);
    await assert.rejects(
      down.prepare({ requestId: 't5:p:1', query: '你好' }),
      (err) => err instanceof MemoryError && err.code === 'MEMORY_UNAVAILABLE',
    );
    await assert.rejects(
      down.close({ operationId: 'sess-x:close:1', summary: '恢复测试会话摘要 zeta005' }),
      (err) => err instanceof MemoryError && err.code === 'MEMORY_WRITEBACK_QUEUED',
    );
    const queued = await readdir(outbox);
    assert.equal(queued.filter((f) => f.endsWith('.pending.json')).length, 1, '写回失败必须入本地 outbox');

    // 恢复主档：同 outbox 的新适配器 prepare 前先重放
    await rm(blockedVault);
    const up = adapter(blockedVault, 'skf-test', 'sess-x', outbox);
    await up.init();
    assert.equal(up.available, true);
    const prepared = await up.prepare({ requestId: 't5:p:2', query: '恢复' });
    assert.equal(prepared.outbox.replayed, 1, 'outbox 应被重放');
    assert.equal(prepared.outbox.failed.length, 0);
    const after = await readdir(outbox);
    assert.equal(after.filter((f) => f.endsWith('.pending.json')).length, 0);
    // 重放后的会话摘要真实存在于主档
    const prepared2 = await up.prepare({ requestId: 't5:p:3', query: '恢复' });
    assert.ok(prepared2.prepared.modelInput.sessionSummary.summary.includes('zeta005'));
  } finally {
    await cleanup(root);
  }
});

test('更正与归档/恢复走主档协议', async () => {
  const root = await makeTemp();
  try {
    const vault = join(root, 'vault');
    const a = adapter(vault, 'skf-test', 'sess-a', join(root, 'out-a'));
    await a.init();
    const old = await a.record(
      { kind: 'fact', trust: 'user_confirmed', text: '旧结论 theta006 已过时', source: userSource('test:t6') },
      'test:t6:fact:1',
    );
    // 用户更正：新记录生效，旧记录归档不删除
    const corrected = await a.correct({ id: old.id, text: '新结论 theta006 已更正', reason: '用户本轮更正', userLocator: 'test:t6' });
    assert.ok(corrected.id);
    const hits = await a.search('theta006');
    assert.ok(hits.hits.some((h) => h.id === corrected.id));
    assert.ok(!hits.hits.some((h) => h.id === old.id), '默认检索不含已归档旧值');
    const archived = await a.search('theta006', { includeArchived: true });
    assert.ok(archived.hits.some((h) => h.id === old.id), '显式 includeArchived 可见旧值');
    // 恢复旧值
    await a.restore(old.id);
    const restored = await a.get(old.id);
    assert.equal(restored.status, 'active');
  } finally {
    await cleanup(root);
  }
});
