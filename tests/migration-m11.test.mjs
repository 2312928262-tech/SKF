// M11 验收：安装包前的数据迁移与回滚演练。
// 全部在隔离临时目录；CLI 黑盒驱动 scripts/migrate-legacy.mjs；零网络零付费调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'scripts/migrate-legacy.mjs');
const VENDOR = join(ROOT, 'vendor/memory-runtime');
const ENTRY = join(ROOT, 'dist/supervisor.js');
const { RuntimeStore } = await import('../dist/runtime/runtime-store.js');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function makeTemp() { return mkdtemp(join(tmpdir(), 'skf-m11-')); }
async function cleanup(root) {
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(resolve(tmpdir()).length + 1), /^skf-m11-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

function walkSync(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...walkSync(full, base));
    else if (item.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}
function treeHashes(dir) {
  const map = {};
  for (const rel of walkSync(dir)) map[rel] = sha256(readFileSync(join(dir, rel)));
  return map;
}

const TASK_A_ID = sha256('m11-task-a');
const TASK_B_ID = sha256('m11-task-b');

/** 构造含各类边缘情况的旧数据树；返回源目录。 */
async function buildLegacyFixture(base) {
  const src = join(base, 'legacy-source');
  await mkdir(join(src, 'memory/02-work/summaries'), { recursive: true });
  await mkdir(join(src, 'memory/03-facts'), { recursive: true });
  await mkdir(join(src, 'memory/04-graph'), { recursive: true });
  await mkdir(join(src, 'memory/05-archive'), { recursive: true });
  await mkdir(join(src, 'tasks'), { recursive: true });
  await mkdir(join(src, 'config'), { recursive: true });
  await mkdir(join(src, 'logs'), { recursive: true });
  await writeFile(join(src, 'memory/01-core.md'), '# SKF · 核心锚点（L1）\n\n- 名字：SKF\n- 诚实 > 一切\n', 'utf8');
  await writeFile(join(src, 'memory/02-work/turn-1-2.md'), '# Turn 1\n\n## user\n\n你好\n\n## assistant\n\n你好，用户。\n', 'utf8');
  await writeFile(join(src, 'memory/02-work/turn-3-4.md'), '# Turn 3\n\nsmoke test 自检对话，不是真实交流。\n', 'utf8');
  await writeFile(join(src, 'memory/03-facts/facts.jsonl'), [
    JSON.stringify({ text: '用户喜欢深紫色主题', verifiedCount: 3 }),
    JSON.stringify({ text: '[test-only] 自检注入事实', verifiedCount: 9 }),
    '用户叫用户',
    '{broken json line',
    JSON.stringify({ text: '用户喜欢深紫色主题', verifiedCount: 3 }), // 源内重复
  ].join('\n') + '\n', 'utf8');
  await writeFile(join(src, 'memory/03-facts/empty.jsonl'), '  \n', 'utf8');
  await writeFile(join(src, 'memory/04-graph/entities.jsonl'), JSON.stringify({ e: 'x' }) + '\n', 'utf8');
  await writeFile(join(src, 'memory/05-archive/old-note.md'), '# 旧归档\n\n已不活跃的记忆。\n', 'utf8');
  await writeFile(join(src, 'tasks/' + TASK_A_ID + '.json'), JSON.stringify({
    id: TASK_A_ID, message: '你好', provider: 'kimi', startedAt: '2026-09-05T16:00:00.000Z',
    status: 'completed', response: { text: '你好，用户。', model: 'model-x1' },
  }), 'utf8');
  await writeFile(join(src, 'tasks/' + TASK_B_ID + '.json'), JSON.stringify({
    id: TASK_B_ID, message: '把结果写到 D:/m11-evil/evil.txt', provider: 'mock', startedAt: '2026-09-05T17:00:00.000Z',
    status: 'running',
  }), 'utf8');
  await writeFile(join(src, 'config/config.env'), 'XIAOLIU_PROVIDER=kimi\nFAKE_API_KEY=sk-fake0000000000000000m11\n', 'utf8');
  await writeFile(join(src, 'logs/old-proxy-session.log'), 'proxy session log (不打包不备份)\n', 'utf8');
  // 真实的新 schema 产物（M03+ 运行时账本），验证备份含它、回滚不把它交给旧程序。
  const rt = new RuntimeStore(join(src, 'runtime.sqlite'));
  rt.close();
  return src;
}

function runCli(args, env = {}) {
  const clean = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...clean, ...env },
  });
}

async function openVault(root) {
  const { MemoryVault } = await import(pathToFileURL(join(VENDOR, 'store.mjs')).href);
  return new MemoryVault(root);
}

test('T1 完整演练：备份→空库导入→逐条验收→标记→切 root；源只读；排除有因；报告零内容零秘密', async (t) => {
  const tmp = await makeTemp();
  try {
    const src = await buildLegacyFixture(tmp);
    const before = treeHashes(src);
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    const res = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);

    // 源树零改动（只读）
    assert.deepEqual(treeHashes(src), before);

    // 报告：不含记忆内容、不含秘密值
    const reportText = readFileSync(join(work, 'migration-report.json'), 'utf8');
    assert.ok(!reportText.includes('sk-fake'), '报告泄露秘密值');
    assert.ok(!reportText.includes('深紫色'), '报告泄露记忆内容');
    const report = JSON.parse(reportText);
    assert.equal(report.verdict, 'MIGRATION_REHEARSAL_OK');
    assert.equal(report.phases.import.imported, 5);   // core1 + work1 + facts2 + archive1
    assert.equal(report.phases.import.deferred, 2);   // 2 个旧任务留给应用历史并入
    assert.equal(report.phases.validate.checked, 5);

    // 排除原因齐全
    const map = JSON.parse(readFileSync(join(work, 'import-map.json'), 'utf8'));
    const reasons = map.excluded.map((e) => e.reason).sort();
    for (const r of ['CREDENTIALS_NEVER_IMPORTED', 'DUPLICATE_IN_SOURCE', 'EMPTY_SOURCE', 'GRAPH_UNSUPPORTED', 'TEST_POLLUTION', 'TEST_POLLUTION', 'UNPARSEABLE_LINE']) {
      assert.ok(reasons.includes(r), '缺少排除原因 ' + r);
    }

    // 备份：含 memory/tasks/config/runtime.sqlite 清单；不含 logs
    const inv = JSON.parse(readFileSync(join(work, 'backup-inventory.json'), 'utf8'));
    assert.ok(inv.files.some((f) => f.path === 'memory/01-core.md'));
    assert.ok(inv.files.some((f) => f.path === 'runtime.sqlite'));
    assert.ok(!inv.files.some((f) => f.path.startsWith('logs/')), '备份不应包含日志/旧代理会话');
    assert.ok(existsSync(join(work, 'backup/config/config.env')), '备份须保留凭据文件本体（报告只见哈希）');

    // 切换结果
    assert.ok(!existsSync(join(work, 'staging-vault')), 'staging 已切走');
    assert.ok(existsSync(join(dataRoot, 'vault/memory.sqlite')));
    const pointer = JSON.parse(readFileSync(join(dataRoot, 'memory-root.json'), 'utf8'));
    assert.equal(pointer.scope, 'skf');
    assert.ok(existsSync(join(dataRoot, 'migration-complete.json')));

    // vault 内容核验
    const vault = await openVault(join(dataRoot, 'vault'));
    try {
      const rows = vault.db.prepare('SELECT kind, trust, status, tags FROM records ORDER BY kind').all();
      assert.equal(rows.length, 5);
      assert.ok(rows.every((r) => r.trust === 'legacy'), '全部记录必须 legacy 信任级');
      assert.equal(rows.filter((r) => r.kind === 'fact').length, 2);
      assert.equal(rows.filter((r) => r.kind === 'identity').length, 1);
      assert.equal(rows.filter((r) => r.kind === 'episode').length, 2);
      const archived = rows.filter((r) => r.status === 'archived');
      assert.equal(archived.length, 1);
      const factWithVc = rows.find((r) => r.tags.includes('legacy-verified-count:3'));
      assert.ok(factWithVc, 'verifiedCount 只作标签保留');
      // 不得有任何确认级记录
      assert.equal(vault.db.prepare("SELECT count(*) n FROM records WHERE trust IN ('user_confirmed','tool_observed')").get().n, 0);
      vault.verify();
    } finally { vault.close(); }
  } finally { await cleanup(tmp); }
});

test('T2 重跑幂等：二次运行零新记录零新事件', async (t) => {
  const tmp = await makeTemp();
  try {
    const src = await buildLegacyFixture(tmp);
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    assert.equal(runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]).status, 0);
    const vault1 = await openVault(join(dataRoot, 'vault'));
    const count1 = vault1.db.prepare('SELECT count(*) n FROM records').get().n;
    const events1 = vault1.verify().eventCount;
    vault1.close();
    const res = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]);
    assert.equal(res.status, 0, res.stderr);
    const vault2 = await openVault(join(dataRoot, 'vault'));
    try {
      assert.equal(vault2.db.prepare('SELECT count(*) n FROM records').get().n, count1);
      assert.equal(vault2.verify().eventCount, events1);
    } finally { vault2.close(); }
  } finally { await cleanup(tmp); }
});

test('T3 import 中断（第2条后崩溃）：不切 root；重跑补全无重复', async (t) => {
  const tmp = await makeTemp();
  try {
    const src = await buildLegacyFixture(tmp);
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    const crashed = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR], { SKF_M11_CRASH_AFTER: '2' });
    assert.equal(crashed.status, 3);
    assert.ok(existsSync(join(work, 'staging-vault')), '中断后 staging 保留现场');
    assert.ok(!existsSync(join(work, 'migration-complete.json')), '中断不得写完成标记');
    assert.ok(!existsSync(join(dataRoot, 'vault')), '半迁移绝不切 root');
    assert.ok(!existsSync(join(dataRoot, 'memory-root.json')));
    const res = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]);
    assert.equal(res.status, 0, res.stderr);
    const vault = await openVault(join(dataRoot, 'vault'));
    try { assert.equal(vault.db.prepare('SELECT count(*) n FROM records').get().n, 5); } finally { vault.close(); }
  } finally { await cleanup(tmp); }
});

test('T4 验收失败（库被篡改）拒绝切 root', async (t) => {
  const tmp = await makeTemp();
  try {
    const src = await buildLegacyFixture(tmp);
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    // 先中断在 import 完成后（map 未写），再篡改 staging 记录文本。
    const crashed = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR], { SKF_M11_CRASH_AFTER: '5' });
    assert.equal(crashed.status, 3);
    const vault = await openVault(join(work, 'staging-vault'));
    const someId = vault.db.prepare('SELECT id FROM records LIMIT 1').get().id;
    vault.db.prepare("UPDATE records SET text = 'tampered-by-test' WHERE id = ?").run(someId);
    vault.close();
    const res = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /MIGRATION_VALIDATION_FAILED/);
    assert.ok(!existsSync(join(work, 'migration-complete.json')), '验收失败不写标记');
    assert.ok(!existsSync(join(dataRoot, 'vault')), '验收失败绝不切 root');
    assert.ok(!existsSync(join(dataRoot, 'memory-root.json')));
  } finally { await cleanup(tmp); }
});

test('T5 切换中崩溃（rename 后、指针前）：重跑补齐指针并完成', async (t) => {
  const tmp = await makeTemp();
  try {
    const src = await buildLegacyFixture(tmp);
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    const crashed = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR], { SKF_M11_CRASH_PHASE: 'switch-after-rename' });
    assert.equal(crashed.status, 3);
    assert.ok(!existsSync(join(work, 'staging-vault')), 'rename 已发生');
    assert.ok(existsSync(join(dataRoot, 'vault/memory.sqlite')));
    assert.ok(!existsSync(join(dataRoot, 'memory-root.json')), '崩溃点在写指针前');
    const res = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(dataRoot, 'memory-root.json')));
    const vault = await openVault(join(dataRoot, 'vault'));
    try { assert.equal(vault.db.prepare('SELECT count(*) n FROM records').get().n, 5); } finally { vault.close(); }
  } finally { await cleanup(tmp); }
});

test('T6 回滚演练：旧格式原样还原可读；新导出保留且可还原；新 schema 不交给旧程序', async (t) => {
  const tmp = await makeTemp();
  try {
    const src = await buildLegacyFixture(tmp);
    const before = treeHashes(src);
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    assert.equal(runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]).status, 0);
    const restoreTo = join(tmp, 'rollback-out');
    const res = runCli(['rollback', '--work', work, '--restore-to', restoreTo, '--vendor', VENDOR]);
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(readFileSync(join(work, 'rollback-report.json'), 'utf8'));
    assert.equal(report.verdict, 'ROLLBACK_REHEARSAL_OK');
    // 旧格式还原：哈希与源一致（memory/tasks/config；runtime.sqlite 刻意不还原）
    for (const rel of ['memory/01-core.md', 'memory/03-facts/facts.jsonl', 'tasks/' + TASK_A_ID + '.json', 'config/config.env']) {
      assert.equal(sha256(readFileSync(join(restoreTo, rel))), before[rel], rel + ' 还原哈希不一致');
    }
    assert.ok(!existsSync(join(restoreTo, 'runtime.sqlite')), '新 schema 不得回灌旧格式目录');
    assert.ok(!existsSync(join(restoreTo, 'logs')), '日志不在恢复范围');
    // 新系统导出保留 + 探针已实演还原
    assert.equal(report.steps.newSystemExport.records, 5);
    assert.equal(report.steps.newSystemExport.probeRestored, 5);
    assert.ok(existsSync(join(restoreTo, 'new-system-export/vault-export.json')));
    assert.equal(report.steps.noNewSchemaInRollback, true);
  } finally { await cleanup(tmp); }
});

test('T7 新 schema 闸门：高版本 vault 一律 UNSUPPORTED_SCHEMA；迁移路径同样被拒', async (t) => {
  const tmp = await makeTemp();
  try {
    // 子进程内验证（构造器抛错会遗留句柄，子进程退出即释放，不锁测试目录）。
    const vaultRoot = join(tmp, 'vault');
    const make = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {MemoryVault} = await import(${JSON.stringify(pathToFileURL(join(VENDOR, 'store.mjs')).href)});` +
      `const v = new MemoryVault(${JSON.stringify(vaultRoot)});` +
      `v.db.prepare("UPDATE meta SET value='3' WHERE key='schemaVersion'").run(); v.close();`],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(make.status, 0, make.stderr);
    const open = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {MemoryVault} = await import(${JSON.stringify(pathToFileURL(join(VENDOR, 'store.mjs')).href)});` +
      `new MemoryVault(${JSON.stringify(vaultRoot)});`],
      { encoding: 'utf8', windowsHide: true });
    assert.notEqual(open.status, 0);
    assert.match(open.stderr, /UNSUPPORTED_SCHEMA/);

    // 迁移路径：staging 是高版本库时 import 即失败，不切 root。
    const src = await buildLegacyFixture(tmp);
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    const crashed = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR], { SKF_M11_CRASH_AFTER: '1' });
    assert.equal(crashed.status, 3);
    const bump = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {DatabaseSync} = await import('node:sqlite');` +
      `const db = new DatabaseSync(${JSON.stringify(join(work, 'staging-vault/memory.sqlite'))});` +
      `db.prepare("UPDATE meta SET value='9' WHERE key='schemaVersion'").run(); db.close();`],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(bump.status, 0, bump.stderr);
    const res = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /UNSUPPORTED_SCHEMA/);
    assert.ok(!existsSync(join(dataRoot, 'vault')), '高版本库绝不切 root');
  } finally { await cleanup(tmp); }
});

test('T8 生产形态：源即数据根；老任务只进历史不触发工具；旧文件零改动；新 schema 无双写', async (t) => {
  const tmp = await makeTemp();
  let child = null;
  try {
    const src = await buildLegacyFixture(tmp);
    const work = join(tmp, 'work');
    // 生产形态：--data-root 就是旧数据根本身（副本），切换就地完成。
    assert.equal(runCli(['run', '--source', src, '--work', work, '--data-root', src, '--vendor', VENDOR]).status, 0);
    const beforeApp = treeHashes(src);

    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      NODE_ENV: 'test', SKF_SKIP_ENV: '1', SKF_DATA_DIR: src,
      XIAOLIU_PROVIDER: 'mock', SKF_ALLOW_MOCK: '1',
      SKF_MEMORY_ROOT: join(src, 'vault'), SKF_MEMORY_SEMANTIC: '0', SKF_OPENCLAW_BRIDGE: '0',
      // M13：旧 e2e 不覆盖学习闭环；后台复盘泵会拉长子进程退出窗口，钉死关闭。
      SKF_LEARNING: '0',
    });
    child = spawn(process.execPath, [ENTRY, '--ipc'], { cwd: tmp, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map();
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b));
    lines.on('line', (line) => {
      const reply = JSON.parse(line);
      if (reply.id && pending.has(reply.id)) { pending.get(reply.id)(reply); pending.delete(reply.id); }
    });
    let seq = 0;
    const rpc = (action, data = {}) => new Promise((resolveRpc, rejectRpc) => {
      const id = 'm11-' + ++seq;
      pending.set(id, resolveRpc);
      child.stdin.write(JSON.stringify({ id, action, data }) + '\n');
      setTimeout(() => rejectRpc(new Error('RPC_TIMEOUT_' + action)), 20000);
    });

    const ping = await rpc('ping');
    assert.equal(ping.ok, true, stderr);
    const history = await rpc('history');
    const legacy = history.data.tasks.filter((x) => [TASK_A_ID, TASK_B_ID].includes(x.id));
    assert.equal(legacy.length, 2, '旧任务应进入历史视图');
    const taskA = legacy.find((x) => x.id === TASK_A_ID);
    const taskB = legacy.find((x) => x.id === TASK_B_ID);
    assert.equal(taskA.status, 'completed');
    assert.equal(taskA.model, 'model-x1', '保留原模型名');
    assert.equal(taskA.text, '你好，用户。');
    assert.equal(taskB.status, 'interrupted', '旧崩溃残留 running → interrupted，绝不排队执行');

    // 老任务只导历史：不产生任何新副作用文件
    assert.ok(!existsSync('D:/m11-evil/evil.txt'));
    const afterApp = treeHashes(src);
    const allowedNew = new Set(['vault', 'memory-root.json', 'migration-complete.json', 'runtime.sqlite', 'runtime.sqlite-shm', 'runtime.sqlite-wal']);
    for (const rel of Object.keys(afterApp)) {
      const top = rel.split('/')[0];
      if (/^runtime\.sqlite(-shm|-wal)?$/.test(rel)) continue; // 新 schema 账本本就由新程序读写
      if (beforeApp[rel]) {
        assert.equal(afterApp[rel], beforeApp[rel], rel + ' 被改动（旧文件必须只读）');
      } else {
        assert.ok(allowedNew.has(top) || allowedNew.has(rel), '意外新文件 ' + rel);
      }
    }
    // 新 schema 不允许老版写入路径双写：tasks/ 下没有新文件，memory/ L1-L5 零改动
    assert.equal(walkSync(join(src, 'tasks')).length, 2);
    assert.equal(afterApp['memory/01-core.md'], beforeApp['memory/01-core.md']);

    // 重启一次：并入幂等，历史不翻倍
    child.kill();
    await once(child, 'exit');
    child = spawn(process.execPath, [ENTRY, '--ipc'], { cwd: tmp, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines2 = createInterface({ input: child.stdout });
    const pending2 = new Map();
    lines2.on('line', (line) => {
      const reply = JSON.parse(line);
      if (reply.id && pending2.has(reply.id)) { pending2.get(reply.id)(reply); pending2.delete(reply.id); }
    });
    const history2 = await new Promise((resolveRpc, rejectRpc) => {
      pending2.set('m11-h2', resolveRpc);
      child.stdin.write(JSON.stringify({ id: 'm11-h2', action: 'history', data: {} }) + '\n');
      setTimeout(() => rejectRpc(new Error('RPC_TIMEOUT_HISTORY2')), 20000);
    });
    assert.equal(history2.data.tasks.filter((x) => [TASK_A_ID, TASK_B_ID].includes(x.id)).length, 2);
    child.kill();
    await once(child, 'exit');
    child = null;
  } finally {
    if (child) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    await cleanup(tmp);
  }
});

test('T9 真实数据形态：空 facts/空 graph/无 tasks → 正常收束，零事实导入', async (t) => {
  const tmp = await makeTemp();
  try {
    const src = join(tmp, 'real-shape');
    await mkdir(join(src, 'memory/02-work/summaries'), { recursive: true });
    await mkdir(join(src, 'memory/03-facts'), { recursive: true });
    await mkdir(join(src, 'memory/04-graph'), { recursive: true });
    await mkdir(join(src, 'memory/05-archive'), { recursive: true });
    await mkdir(join(src, 'tasks'), { recursive: true });
    await mkdir(join(src, 'config'), { recursive: true });
    await writeFile(join(src, 'memory/01-core.md'), '# SKF · 核心锚点\n\n- 名字：SKF\n', 'utf8');
    await writeFile(join(src, 'memory/02-work/turn-1-2.md'), '# Turn 1\n\n## user\n\n你好\n', 'utf8');
    await writeFile(join(src, 'memory/03-facts/facts.jsonl'), '\n', 'utf8');
    await writeFile(join(src, 'memory/04-graph/entities.jsonl'), '', 'utf8');
    await writeFile(join(src, 'memory/04-graph/relations.jsonl'), '', 'utf8');
    await writeFile(join(src, 'config/config.env'), 'XIAOLIU_PROVIDER=kimi\n', 'utf8');
    const work = join(tmp, 'work');
    const dataRoot = join(tmp, 'data-root');
    const res = runCli(['run', '--source', src, '--work', work, '--data-root', dataRoot, '--vendor', VENDOR]);
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(readFileSync(join(work, 'migration-report.json'), 'utf8'));
    assert.equal(report.phases.import.imported, 2); // core + 1 work
    const map = JSON.parse(readFileSync(join(work, 'import-map.json'), 'utf8'));
    assert.ok(map.excluded.filter((e) => e.reason === 'EMPTY_SOURCE').length >= 3);
    const vault = await openVault(join(dataRoot, 'vault'));
    try {
      assert.equal(vault.db.prepare("SELECT count(*) n FROM records WHERE kind = 'fact'").get().n, 0);
      assert.equal(vault.db.prepare('SELECT count(*) n FROM records').get().n, 2);
    } finally { vault.close(); }
  } finally { await cleanup(tmp); }
});
