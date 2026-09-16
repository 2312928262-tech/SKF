// M11 · legacy importer + copy-validate-switch 迁移演练 + 回滚演练。
//
// 纪律：
// - 旧数据只读；import 只写「隔离 staging vault」，验收通过才切 root（rename + 指针文件）。
// - facts/工作记忆/L1 核心/L5 归档一律 trust='legacy' + source 标 legacy:<路径>；
//   旧 verifiedCount 只保留为标签，绝不提升信任级别。
// - 已知测试污染 / 04-graph（旧梦境·图谱层）不进活跃检索；排除项保留原始备份与原因。
// - 中断重跑幂等：确定性 record id + 状态机只记录已完成阶段；半迁移绝不切 root。
// - 报告只写位置/哈希/原因，不写记忆内容或秘密值。
//
// 用法：
//   node scripts/migrate-legacy.mjs run      --source <旧数据根> --work <隔离工作区> [--data-root <新数据根>] [--scope skf] [--vendor <dir>] [--report <file>]
//   node scripts/migrate-legacy.mjs rollback --work <隔离工作区> --restore-to <空目录> [--report <file>]
//   node scripts/migrate-legacy.mjs status   --work <隔离工作区>
//
// 测试钩子（仅测试用，生产不得设置）：
//   SKF_M11_CRASH_AFTER=N   import 阶段第 N 条后 process.exit(3)
//   SKF_M11_CRASH_PHASE=switch-after-rename  rename 后、写指针前 process.exit(3)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

function fail(code, detail) {
  const err = new Error(code + (detail ? ': ' + detail : ''));
  err.code = code;
  throw err;
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { encoding: 'utf8', flush: true });
  renameSync(file + '.tmp', file);
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full, base));
    else if (item.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

// 已知测试污染形态（报告会列出本表；命中即排除出活跃检索）。
const POLLUTION_PATTERNS = [
  ['POLLUTION-SMOKE', /smoke[- ]?test/i],
  ['POLLUTION-ZH-TEST', /测试污染/],
  ['POLLUTION-SELFTEST', /selftest|self-test/i],
  ['POLLUTION-MARKER', /\[test-only\]/i],
];

// 备份范围：迁移相关数据（记忆/任务/配置/新版运行时产物）。日志、jobs、checkpoints、旧备份不进备份。
const BACKUP_INCLUDE = [/^memory\//, /^tasks\//, /^config\//, /^runtime\.sqlite(-shm|-wal)?$/];

async function loadVault(vendorDir, root) {
  const storePath = join(vendorDir, 'store.mjs');
  if (!existsSync(storePath)) fail('VENDOR_MISSING', storePath);
  const { MemoryVault } = await import(pathToFileURL(storePath).href);
  return new MemoryVault(root);
}
async function loadText(vendorDir) {
  return import(pathToFileURL(join(vendorDir, 'text.mjs')).href);
}

// ── 收集旧数据条目（只读）──────────────────────────────────────
function collectItems(source, textLib) {
  const { redact } = textLib;
  const items = [];   // 待导入：{locator, relpath, kind, tag, text, sha256, verifiedCount?}
  const excluded = []; // {path|locator, reason, detail?}
  const deferred = []; // tasks/*.json（应用启动时并入历史账本，不由本工具导入）

  const memRoot = join(source, 'memory');
  const memFiles = walk(memRoot);
  for (const rel of memFiles) {
    const full = join(memRoot, rel);
    const buf = readFileSync(full);
    const hash = sha256(buf);
    const locator = 'legacy:memory/' + rel;
    const lower = rel.toLowerCase();
    if (buf.length === 0 || !buf.toString('utf8').trim()) {
      excluded.push({ path: 'memory/' + rel, sha256: hash, reason: 'EMPTY_SOURCE' });
      continue;
    }
    const text = buf.toString('utf8');
    const isFactsJsonl = rel.startsWith('03-facts/') && lower.endsWith('.jsonl');
    // jsonl 按行判定污染（一行污染不株连全文件）；其他文件整文件判定。
    if (!isFactsJsonl) {
      const pollution = POLLUTION_PATTERNS.find(([, re]) => re.test(text));
      if (pollution) {
        excluded.push({ path: 'memory/' + rel, sha256: hash, reason: 'TEST_POLLUTION', rule: pollution[0] });
        continue;
      }
    }
    if (/^01-core(\.md$|\/)/.test(rel) || (!rel.includes('/') && rel.endsWith('.md'))) {
      items.push({ locator, relpath: 'memory/' + rel, kind: 'identity', tag: 'l1-core', text, sha256: hash });
    } else if (rel.startsWith('02-work/') && lower.endsWith('.md')) {
      items.push({ locator, relpath: 'memory/' + rel, kind: 'episode', tag: 'l2-work', text, sha256: hash });
    } else if (rel.startsWith('03-facts/') && lower.endsWith('.jsonl')) {
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const lineLoc = locator + '#L' + (idx + 1);
        let factText = trimmed, verifiedCount;
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          let obj;
          try { obj = JSON.parse(trimmed); } catch {
            excluded.push({ locator: lineLoc, reason: 'UNPARSEABLE_LINE' });
            return;
          }
          if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
            factText = String(obj.text ?? obj.fact ?? obj.content ?? '');
            const vc = obj.verifiedCount ?? obj.verified ?? obj.confirmations;
            if (Number.isSafeInteger(vc) && vc > 0) verifiedCount = vc;
            if (!factText.trim()) { excluded.push({ locator: lineLoc, reason: 'EMPTY_SOURCE' }); return; }
          } else {
            factText = String(obj);
          }
        }
        const linePollution = POLLUTION_PATTERNS.find(([, re]) => re.test(factText));
        if (linePollution) {
          excluded.push({ locator: lineLoc, reason: 'TEST_POLLUTION', rule: linePollution[0] });
          return;
        }
        items.push({ locator: lineLoc, relpath: 'memory/' + rel, kind: 'fact', tag: 'l3-fact', text: factText, sha256: sha256(factText), verifiedCount });
      });
    } else if (rel.startsWith('04-graph/')) {
      // 旧「梦境/图谱」层：统一主档没有等价物（graph=unavailable），不进活跃检索。
      excluded.push({ path: 'memory/' + rel, sha256: hash, reason: 'GRAPH_UNSUPPORTED', detail: '旧图谱/梦境层不导入活跃检索，原样保留在备份' });
    } else if (rel.startsWith('05-archive/')) {
      if (lower.endsWith('.md')) {
        items.push({ locator, relpath: 'memory/' + rel, kind: 'episode', tag: 'l5-archive', text, sha256: hash, archiveAfter: true });
      } else {
        excluded.push({ path: 'memory/' + rel, sha256: hash, reason: 'UNSUPPORTED_ARCHIVE_ENTRY' });
      }
    } else {
      excluded.push({ path: 'memory/' + rel, sha256: hash, reason: 'UNSUPPORTED_FILE_TYPE' });
    }
  }

  const tasksDir = join(source, 'tasks');
  for (const rel of walk(tasksDir)) {
    if (/^[a-f0-9]{64}\.json$/.test(rel)) deferred.push({ path: 'tasks/' + rel, sha256: sha256(readFileSync(join(tasksDir, rel))) });
    else excluded.push({ path: 'tasks/' + rel, reason: 'UNSUPPORTED_FILE_TYPE' });
  }

  const configDir = join(source, 'config');
  for (const rel of walk(configDir)) {
    if (/\.env$|config\.env$/i.test(rel)) {
      // 凭据文件：只登记位置+哈希，永不读取内容进报告或导入。
      excluded.push({ path: 'config/' + rel, sha256: sha256(readFileSync(join(configDir, rel))), reason: 'CREDENTIALS_NEVER_IMPORTED' });
    } else {
      excluded.push({ path: 'config/' + rel, reason: 'UNSUPPORTED_FILE_TYPE' });
    }
  }

  // 源内重复（同一内容多处出现）：只导第一份，其余标注重复。
  const seen = new Map();
  for (const item of items) {
    const key = item.kind + '\0' + sha256(redact(item.text).trim());
    if (seen.has(key)) {
      excluded.push({ locator: item.locator, reason: 'DUPLICATE_IN_SOURCE', duplicateOf: seen.get(key) });
      item.skip = true;
    } else seen.set(key, item.locator);
  }
  return { items: items.filter((i) => !i.skip), excluded, deferred };
}

// ── 阶段实现 ──────────────────────────────────────────────────
function phaseBackup(source, work) {
  const inventory = [];
  for (const rel of walk(source)) {
    if (!BACKUP_INCLUDE.some((re) => re.test(rel))) continue;
    const buf = readFileSync(join(source, rel));
    inventory.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });
  }
  const rootHash = sha256(inventory.map((e) => e.path + '\0' + e.sha256).join('\n'));
  const backupDir = join(work, 'backup');
  if (existsSync(join(work, 'backup-inventory.json'))) {
    const prior = JSON.parse(readFileSync(join(work, 'backup-inventory.json'), 'utf8'));
    if (prior.rootHash !== rootHash) fail('SOURCE_CHANGED', '迁移期间源数据发生变化；已停止，人工核对后重跑');
    return { rootHash, files: inventory.length, reused: true };
  }
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true });
  for (const e of inventory) {
    const dest = join(backupDir, e.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(source, e.path), dest);
    if (sha256(readFileSync(dest)) !== e.sha256) fail('BACKUP_COPY_MISMATCH', e.path);
  }
  writeJsonAtomic(join(work, 'backup-inventory.json'), { createdAt: nowIso(), source: resolve(source), rootHash, files: inventory });
  return { rootHash, files: inventory.length, reused: false };
}

async function phaseImport(source, work, vendorDir, scope) {
  const textLib = await loadText(vendorDir);
  const { redact } = textLib;
  const { items, excluded, deferred } = collectItems(source, textLib);
  const staging = join(work, 'staging-vault');
  const vault = await loadVault(vendorDir, staging);
  const crashAfter = Number(process.env.SKF_M11_CRASH_AFTER || 0);
  const map = [];
  let processed = 0;
  try {
    for (const item of items) {
      const recordId = 'm11legacy-' + sha256(item.locator).slice(0, 40);
      const text = redact(item.text).trim();
      const tags = ['legacy-import', item.tag];
      if (item.verifiedCount) tags.push('legacy-verified-count:' + item.verifiedCount);
      const input = {
        id: recordId, kind: item.kind, scope, trust: 'legacy', text,
        source: [{ kind: 'reference', locator: item.locator, hash: item.sha256 }],
        tags,
      };
      const existing = vault.db.prepare('SELECT id, status FROM records WHERE id = ?').get(recordId);
      let disposition = 'imported';
      if (existing) {
        disposition = 'deduplicated';
      } else {
        vault.record(input, 'm11-import:' + recordId);
      }
      if (item.archiveAfter) {
        const current = vault.get(recordId);
        if (current && current.status === 'active') {
          vault.archive([recordId], { dryRun: false, reason: 'legacy-import: 源数据中已归档（05-archive）', operationId: 'm11-archive:' + recordId });
        }
      }
      map.push({ locator: item.locator, recordId, kind: item.kind, disposition, archived: item.archiveAfter === true, verifiedCountTag: item.verifiedCount ? 'legacy-verified-count:' + item.verifiedCount : null });
      processed++;
      if (crashAfter && processed >= crashAfter) process.exit(3); // 测试钩子：模拟中断
    }
  } finally {
    vault.close();
  }
  writeJsonAtomic(join(work, 'import-map.json'), { createdAt: nowIso(), scope, map, excluded, deferred });
  return { imported: map.length, excluded: excluded.length, deferred: deferred.length };
}

async function phaseValidate(work, vendorDir, scope, vaultDir) {
  const textLib = await loadText(vendorDir);
  const { hash, redact } = textLib;
  const staging = vaultDir || join(work, 'staging-vault');
  if (!existsSync(staging)) fail('STAGING_VAULT_MISSING');
  const { map } = JSON.parse(readFileSync(join(work, 'import-map.json'), 'utf8'));
  const vault = await loadVault(vendorDir, staging);
  const problems = [];
  try {
    const verify = vault.verify(); // 审计链 + integrity_check
    const stats = vault.stats();
    for (const entry of map) {
      const r = vault.get(entry.recordId);
      if (!r) { problems.push({ recordId: entry.recordId, problem: 'RECORD_MISSING' }); continue; }
      if (r.trust !== 'legacy') problems.push({ recordId: entry.recordId, problem: 'TRUST_NOT_LEGACY' });
      if (r.kind !== entry.kind) problems.push({ recordId: entry.recordId, problem: 'KIND_MISMATCH' });
      if (r.scope !== scope) problems.push({ recordId: entry.recordId, problem: 'SCOPE_MISMATCH' });
      if (entry.archived ? r.status !== 'archived' : r.status !== 'active') problems.push({ recordId: entry.recordId, problem: 'STATUS_MISMATCH:' + r.status });
      if (r.contentHash !== hash(r.text)) problems.push({ recordId: entry.recordId, problem: 'CONTENT_HASH_MISMATCH' });
      const src = (r.source || [])[0];
      if (!src || src.locator !== entry.locator) problems.push({ recordId: entry.recordId, problem: 'SOURCE_LOCATOR_MISMATCH' });
      if (entry.verifiedCountTag && !r.tags.includes(entry.verifiedCountTag)) problems.push({ recordId: entry.recordId, problem: 'VERIFIED_COUNT_TAG_MISSING' });
      if (r.tags.includes('legacy-verified-count') || /legacy-verified-count:\d+/.test(r.tags.join(' '))) {
        // 标签保留旧次数是允许的；信任级别不得因此被提升（上面 TRUST_NOT_LEGACY 已查）。
      }
    }
    // 全部记录必须 legacy（本 vault 是空库导入，不应出现任何确认级记录）。
    const confirmed = vault.db.prepare("SELECT count(*) n FROM records WHERE trust IN ('user_confirmed','tool_observed')").get().n;
    if (confirmed !== 0) problems.push({ problem: 'CONFIRMED_TRUST_PRESENT', count: confirmed });
    if (problems.length) fail('MIGRATION_VALIDATION_FAILED', JSON.stringify(problems.slice(0, 10)));
    return { verify, stats: stats.records, checked: map.length };
  } finally {
    vault.close();
  }
}

function phaseMark(work, validation, backupInfo) {
  const marker = {
    schema: 1,
    completedAt: nowIso(),
    scope: 'skf',
    sourceRootHash: backupInfo.rootHash,
    backup: 'backup/（旧格式原样副本）',
    importedRecords: validation.checked,
    validation: { eventCount: validation.verify.eventCount, auditHead: validation.verify.head },
  };
  writeJsonAtomic(join(work, 'migration-complete.json'), marker);
  return { ...marker, sha256: sha256(readFileSync(join(work, 'migration-complete.json'))) };
}

async function phaseSwitch(work, dataRoot, vendorDir, markerInfo) {
  const staging = join(work, 'staging-vault');
  const target = join(dataRoot, 'vault');
  const pointer = join(dataRoot, 'memory-root.json');
  if (existsSync(staging)) {
    if (existsSync(target)) fail('TARGET_NOT_EMPTY', target);
    // 切换前 checkpoint，保证单文件原子rename。
    const vault = await loadVault(vendorDir, staging);
    try { vault.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { vault.close(); }
    renameSync(staging, target);
    if (process.env.SKF_M11_CRASH_PHASE === 'switch-after-rename') process.exit(3); // 测试钩子
  } else if (!existsSync(target)) {
    fail('SWITCH_STATE_UNKNOWN', 'staging 与 target 都不存在');
  }
  // 目标 vault 复核后再写指针。
  const vault = await loadVault(vendorDir, target);
  let post;
  try { post = vault.verify(); } finally { vault.close(); }
  const pointerData = {
    schema: 1,
    vaultRoot: resolve(target),
    scope: 'skf',
    switchedAt: nowIso(),
    markerSha256: markerInfo.sha256,
    postSwitchAuditHead: post.head,
  };
  writeJsonAtomic(pointer, pointerData);
  copyFileSync(join(work, 'migration-complete.json'), join(dataRoot, 'migration-complete.json'));
  return { target: resolve(target), pointer, postSwitch: post };
}

// ── 命令 ──────────────────────────────────────────────────────
async function cmdRun(args) {
  const source = args.source ? resolve(args.source) : fail('ARGS_REQUIRED', '--source');
  const work = args.work ? resolve(args.work) : fail('ARGS_REQUIRED', '--work');
  const dataRoot = args['data-root'] ? resolve(args['data-root']) : join(work, 'data-root');
  const scope = args.scope || 'skf';
  const vendorDir = args.vendor ? resolve(args.vendor) : resolve(import.meta.dirname, '../vendor/memory-runtime');
  if (!existsSync(source)) fail('SOURCE_MISSING', source);
  mkdirSync(work, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });

  const stateFile = join(work, 'migration-state.json');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { completed: [] };
  const done = (name, extra = {}) => {
    if (!state.completed.includes(name)) state.completed.push(name);
    Object.assign(state, extra, { updatedAt: nowIso() });
    writeJsonAtomic(stateFile, state);
  };
  const report = { startedAt: nowIso(), source, work, dataRoot, scope, phases: {} };

  // 1) backup（总是执行：幂等且校验源未变）
  const backupInfo = phaseBackup(source, work);
  report.phases.backup = backupInfo;
  done('backup', { sourceRootHash: backupInfo.rootHash });

  const staging = join(work, 'staging-vault');
  const target = join(dataRoot, 'vault');
  const mapFile = join(work, 'import-map.json');
  const stagingExists = () => existsSync(staging);
  const targetExists = () => existsSync(target);

  if (targetExists() && !stagingExists() && state.completed.includes('validate')) {
    // 切换已发生（或崩溃在 rename 后指针前）：只对 target 复核并补标记/指针，绝不重导。
    const validation = await phaseValidate(work, vendorDir, scope, target);
    report.phases.import = { skipped: 'ALREADY_SWITCHED' };
    report.phases.validate = { checked: validation.checked, eventCount: validation.verify.eventCount, auditHead: validation.verify.head, records: validation.stats, target: 'switched-vault' };
    const markerInfo = existsSync(join(work, 'migration-complete.json'))
      ? { sha256: sha256(readFileSync(join(work, 'migration-complete.json'), 'utf8')) }
      : phaseMark(work, validation, backupInfo);
    report.phases.mark = { sha256: markerInfo.sha256 };
    report.phases.switch = await phaseSwitch(work, dataRoot, vendorDir, markerInfo);
    done('switch');
  } else if (targetExists()) {
    fail('TARGET_NOT_EMPTY', target);
  } else {
    // 正常路径（含中断后续跑）：import 幂等，validate 不过绝不进 mark/switch。
    if (state.completed.includes('import') && existsSync(mapFile) && stagingExists()) {
      report.phases.import = { skipped: 'IMPORT_ALREADY_DONE' };
    } else {
      report.phases.import = await phaseImport(source, work, vendorDir, scope);
    }
    done('import');

    const validation = await phaseValidate(work, vendorDir, scope);
    report.phases.validate = { checked: validation.checked, eventCount: validation.verify.eventCount, auditHead: validation.verify.head, records: validation.stats };
    done('validate');

    const markerInfo = phaseMark(work, validation, backupInfo);
    report.phases.mark = { sha256: markerInfo.sha256 };
    done('mark');

    report.phases.switch = await phaseSwitch(work, dataRoot, vendorDir, markerInfo);
    done('switch');
  }

  report.finishedAt = nowIso();
  report.verdict = 'MIGRATION_REHEARSAL_OK';
  // 固定位置的结果摘要：rollback 据此找目标 vault（自定义 --report 路径也不影响）。
  writeJsonAtomic(join(work, 'migration-result.json'), { target: report.phases.switch?.target, validated: report.phases.validate?.checked, finishedAt: report.finishedAt });
  const reportFile = args.report ? resolve(args.report) : join(work, 'migration-report.json');
  writeJsonAtomic(reportFile, report);
  process.stdout.write(JSON.stringify({ ok: true, report: reportFile, ...summarize(report) }) + '\n');
}

function summarize(report) {
  return {
    sourceRootHash: report.phases.backup?.rootHash,
    backedUpFiles: report.phases.backup?.files,
    imported: report.phases.import?.imported ?? report.phases.import?.skipped,
    excluded: report.phases.import?.excluded,
    deferredTasks: report.phases.import?.deferred,
    validated: report.phases.validate?.checked,
    target: report.phases.switch?.target,
  };
}

async function cmdRollback(args) {
  const work = args.work ? resolve(args.work) : fail('ARGS_REQUIRED', '--work');
  const restoreTo = args['restore-to'] ? resolve(args['restore-to']) : fail('ARGS_REQUIRED', '--restore-to');
  const vendorDir = args.vendor ? resolve(args.vendor) : resolve(import.meta.dirname, '../vendor/memory-runtime');
  const inventoryFile = join(work, 'backup-inventory.json');
  if (!existsSync(inventoryFile)) fail('BACKUP_MISSING', inventoryFile);
  const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  if (existsSync(restoreTo) && readdirSync(restoreTo).length > 0) fail('RESTORE_NOT_EMPTY', restoreTo);
  mkdirSync(restoreTo, { recursive: true });

  const report = { startedAt: nowIso(), work, restoreTo, steps: {} };

  // 1) 新系统导出（回滚保留新导出，不丢新数据）
  const resultFile = join(work, 'migration-result.json');
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
  const vaultRoot = args.vault ? resolve(args.vault) : result?.target || join(work, 'staging-vault');
  const exportDir = join(restoreTo, 'new-system-export');
  mkdirSync(exportDir, { recursive: true });
  if (existsSync(vaultRoot)) {
    const vault = await loadVault(vendorDir, vaultRoot);
    let exported, verify;
    try {
      verify = vault.verify();
      exported = vault.export(join(exportDir, 'vault-export.json'));
    } finally { vault.close(); }
    // 导出包可还原性：空库 importBundle 实演一次。
    const probeRoot = join(work, 'rollback-probe-vault');
    rmSync(probeRoot, { recursive: true, force: true });
    const probe = await loadVault(vendorDir, probeRoot);
    let restored;
    try {
      restored = probe.importBundle(join(exportDir, 'vault-export.json'));
      probe.verify();
    } finally { probe.close(); }
    rmSync(probeRoot, { recursive: true, force: true });
    report.steps.newSystemExport = { file: exported.file, records: exported.records, checksum: exported.checksum, probeRestored: restored.restoredRecords, auditHead: verify.head };
  } else {
    report.steps.newSystemExport = { skipped: 'NO_TARGET_VAULT' };
  }

  // 2) 旧格式只读恢复：memory/ tasks/ config/ 原样还原（不含任何新 schema 文件）
  const backupDir = join(work, 'backup');
  const restoredFiles = [];
  for (const e of inventory.files) {
    if (/^runtime\.sqlite(-shm|-wal)?$/.test(e.path)) continue; // 新 schema 产物，绝不回灌给旧程序
    const dest = join(restoreTo, e.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(backupDir, e.path), dest);
    const actual = sha256(readFileSync(dest));
    if (actual !== e.sha256) fail('ROLLBACK_HASH_MISMATCH', e.path);
    restoredFiles.push({ path: e.path, sha256: actual });
  }
  report.steps.restoredOldFormat = { files: restoredFiles.length };

  // 3) 旧格式可读性验收：tasks JSON 可解析且字段合法；markdown 可读；无新 schema 文件混入
  const readability = [];
  for (const e of restoredFiles) {
    const full = join(restoreTo, e.path);
    if (/^tasks\/[a-f0-9]{64}\.json$/.test(e.path)) {
      const task = JSON.parse(readFileSync(full, 'utf8'));
      if (!task.id || !task.startedAt || !['completed', 'failed', 'interrupted', 'running'].includes(task.status)) {
        fail('ROLLBACK_TASK_CORRUPT', e.path);
      }
      readability.push({ path: e.path, check: 'legacy-task-json-ok' });
    } else if (e.path.endsWith('.md') || e.path.endsWith('.jsonl')) {
      readFileSync(full, 'utf8');
      readability.push({ path: e.path, check: 'utf8-readable' });
    }
  }
  const leaked = walk(restoreTo).filter((rel) => /\.sqlite(-shm|-wal)?$/i.test(rel) || rel.startsWith('vault/') || rel === 'memory-root.json');
  if (leaked.length) fail('NEW_SCHEMA_LEAKED_TO_ROLLBACK', leaked.join(','));
  report.steps.readability = { checked: readability.length };
  report.steps.noNewSchemaInRollback = true;
  report.finishedAt = nowIso();
  report.verdict = 'ROLLBACK_REHEARSAL_OK';
  const reportFile = args.report ? resolve(args.report) : join(work, 'rollback-report.json');
  writeJsonAtomic(reportFile, report);
  process.stdout.write(JSON.stringify({ ok: true, report: reportFile, restoredOldFormatFiles: report.steps.restoredOldFormat.files, newExportRecords: report.steps.newSystemExport.records ?? null }) + '\n');
}

function cmdStatus(args) {
  const work = args.work ? resolve(args.work) : fail('ARGS_REQUIRED', '--work');
  const stateFile = join(work, 'migration-state.json');
  const out = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { completed: [] };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
try {
  if (command === 'run') await cmdRun(args);
  else if (command === 'rollback') await cmdRollback(args);
  else if (command === 'status') cmdStatus(args);
  else {
    process.stderr.write('usage: migrate-legacy.mjs run|rollback|status --options\n');
    process.exit(2);
  }
} catch (err) {
  process.stderr.write(JSON.stringify({ ok: false, error: err.code || 'MIGRATION_FAILED', message: String(err.message || err).slice(0, 400) }) + '\n');
  process.exit(1);
}
