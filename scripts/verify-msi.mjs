// M11：MSI 全量验证 —— 版本/产品标识一致、管理提取、包内 vs staging 全量 manifest 比对、
// prompts 实物校验、ui-preview 无探针、禁打包扫描（位置+规则，不输出值）、
// 包内 node.exe + JS + 记忆 adapter 完整测试子集。只验证，不安装。
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { mkdir, readdir, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildManifest, scanManifest, PATH_RULES, CONTENT_RULES, sha256 } from './lib/pack-scan.mjs';

const root = resolve(import.meta.dirname, '..');
const workDir = join(root, '.work');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const tauriConf = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const stagedPkg = JSON.parse(await readFile(join(root, 'runtime-candidate/package.json'), 'utf8'));
const version = pkg.version;

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push({ check: name, detail: String(detail).slice(0, 300) });
  return ok;
};

// ── 1) 版本与产品标识一致 ─────────────────────────────────────
check('version.package.json === tauri.conf.json', tauriConf.version === version, `${tauriConf.version} !== ${version}`);
check('version.staged === package.json', stagedPkg.version === version, `${stagedPkg.version} !== ${version}`);
check('productName === SKF', tauriConf.productName === 'SKF', tauriConf.productName);

// ── 2) 管理提取（不安装，不动现有 SKF）────────────────────────
const msi = join(root, `src-tauri/target/release/bundle/msi/SKF_${version}_x64_en-US.msi`);
if (!existsSync(msi)) throw new Error('MSI_MISSING: ' + msi);
const dest = join(workDir, `msi-${version}-verify`);
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
const extract = spawnSync('msiexec.exe', ['/a', msi, '/qn', 'TARGETDIR=' + dest], { windowsHide: true, timeout: 300000 });
if (extract.status !== 0) throw new Error('MSI_EXTRACT_FAILED_' + extract.status);

async function findApp(dir, depth = 0) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isFile() && item.name === 'skf.exe') return dir;
    if (item.isDirectory() && depth < 5 && !['node_modules', 'dist'].includes(item.name)) {
      const found = await findApp(join(dir, item.name), depth + 1);
      if (found) return found;
    }
  }
}
const app = await findApp(dest);
if (!app) throw new Error('MSI_APP_NOT_FOUND');

// ── 3) 包内 manifest vs staging 全量比对 ──────────────────────
const staged = JSON.parse(await readFile(join(workDir, 'staging-manifest.json'), 'utf8'));
check('staging.version === package.json', staged.version === version, staged.version);
const packaged = await buildManifest(app);
const packagedByPath = new Map(packaged.files.map((f) => [f.path, f]));
const stagedToPackaged = (p) => {
  if (p === 'package.json') return 'runtime/package.json';
  if (p === 'node.exe') return 'runtime/node.exe';
  for (const top of ['dist/', 'prompts/', 'vendor/', 'node_modules/', 'brand/']) {
    if (p.startsWith(top)) return 'runtime/' + p;
  }
  return p; // ui-preview/ 原样
};
const missing = [];
const mismatch = [];
const mapped = new Set();
for (const f of staged.files) {
  const target = stagedToPackaged(f.path);
  mapped.add(target);
  const got = packagedByPath.get(target);
  if (!got) missing.push(target);
  else if (got.sha256 !== f.sha256) mismatch.push(target);
}
check('packaged.contains-all-staged', missing.length === 0, missing.slice(0, 10).join(', '));
check('packaged.bytes-identical', mismatch.length === 0, mismatch.slice(0, 10).join(', '));
// 反向：runtime/ 与 ui-preview/ 下不得有 staging 之外的文件（可执行体自身与安装器文件除外）。
const unexpected = packaged.files
  .filter((f) => (f.path.startsWith('runtime/') || f.path.startsWith('ui-preview/')) && !mapped.has(f.path))
  .map((f) => f.path);
check('packaged.no-unexpected-files', unexpected.length === 0, unexpected.slice(0, 10).join(', '));

// ── 4) prompts 实物：dev == staged == packaged ────────────────
const promptsDir = join(root, 'prompts');
const promptMismatches = [];
for (const name of await readdir(promptsDir)) {
  if ((await stat(join(promptsDir, name))).isDirectory()) continue;
  const devBuf = await readFile(join(promptsDir, name));
  const stagedEntry = staged.files.find((f) => f.path === 'prompts/' + name);
  const packagedEntry = packagedByPath.get('runtime/prompts/' + name);
  if (!stagedEntry || !packagedEntry || stagedEntry.sha256 !== sha256(devBuf) || packagedEntry.sha256 !== sha256(devBuf)) {
    promptMismatches.push(name);
  }
}
check('prompts.dev===staged===packaged', promptMismatches.length === 0, promptMismatches.join(', '));
const identity = await readFile(join(app, 'runtime/prompts/IDENTITY.md'), 'utf8');
check('packaged.identity.nonempty', identity.trim().length > 0, 'IDENTITY.md empty');

// ── 5) ui-preview 无探针 + 包内禁打包扫描 ─────────────────────
const probeHits = [];
for (const f of packaged.files.filter((x) => x.path.startsWith('ui-preview/'))) {
  if (/e2e-frontend|e2e-probe/i.test(f.path)) probeHits.push(f.path);
  else if (/\.(js|html|css)$/i.test(f.path)) {
    const text = await readFile(join(app, f.path), 'utf8');
    if (/e2e-probe|__SKF_E2E__/i.test(text)) probeHits.push(f.path + ' (content)');
  }
}
check('ui-preview.no-e2e-probe', probeHits.length === 0, probeHits.join(', '));

const scan = await scanManifest(app, packaged.files);
const scanReport = {
  generatedAt: new Date().toISOString(),
  root: app,
  pathRules: PATH_RULES.map(([id]) => id),
  contentRules: CONTENT_RULES.map(([id]) => id),
  blocked: scan.blocked,
  verdict: scan.verdict,
  note: '只记录文件位置与规则编号；匹配到的值永不落盘。',
};
await writeFile(join(workDir, 'msi-scan.json'), JSON.stringify(scanReport, null, 2), 'utf8');
check('packaged.scan-clean', scan.verdict === 'CLEAN', JSON.stringify(scan.blocked.slice(0, 10)));

// ── 6) 包内 node.exe + JS + 记忆 adapter 完整测试子集 ─────────
const bundledNode = join(app, 'runtime/node.exe');
const bundledEntry = join(app, 'runtime/dist/supervisor.js');
check('packaged.node.exe', existsSync(bundledNode), bundledNode);
check('packaged.entry', existsSync(bundledEntry), bundledEntry);
check('packaged.vendor-memory-runtime', existsSync(join(app, 'runtime/vendor/memory-runtime/store.mjs')), 'runtime/vendor/memory-runtime/store.mjs');

const cleanEnv = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) {
  if (process.env[key]) cleanEnv[key] = process.env[key];
}
function runTest(name, env) {
  const result = spawnSync(process.execPath, ['--test', name], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 300000,
    env: { ...cleanEnv, ...env },
  });
  const tail = (result.stdout || '').split('\n').filter((l) => /(?:#|ℹ)\s+(tests|pass|fail)\s+\d+/.test(l)).map((l) => l.replace(/^\W+/, '')).join(' | ');
  check('packaged-tests.' + name, result.status === 0, (result.stderr || tail || 'exit ' + result.status).slice(0, 300));
  return { status: result.status, tail };
}
const t1 = runTest('tests/runtime.test.mjs', { SKF_TEST_ENTRY: bundledEntry, SKF_TEST_NODE: bundledNode });
const t2 = runTest('tests/memory-adapter.test.mjs', {
  SKF_TEST_DIST_DIR: join(app, 'runtime/dist'),
  SKF_TEST_VENDOR_DIR: join(app, 'runtime/vendor/memory-runtime'),
});

// ── 报告 ─────────────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  version,
  productName: tauriConf.productName,
  identifier: tauriConf.identifier,
  msi,
  msiBytes: (await stat(msi)).size,
  msiSha256: createHash('sha256').update(await readFile(msi)).digest('hex'),
  app,
  stagedFiles: staged.fileCount,
  stagedRootHash: staged.rootHash,
  packagedFiles: packaged.fileCount,
  compare: { missing, mismatch, unexpected },
  promptsVerified: true,
  uiPreviewProbeFree: probeHits.length === 0,
  scan: { verdict: scan.verdict, blocked: scan.blocked.length },
  packagedTests: { 'runtime.test.mjs': t1, 'memory-adapter.test.mjs': t2 },
  installed: false,
  paidApiCalls: 0,
  verdict: failures.length === 0 ? 'PACKAGE_VERIFIED' : 'PACKAGE_VERIFICATION_FAILED',
  failures,
};
await writeFile(join(workDir, 'm11-package-verification.json'), JSON.stringify(report, null, 2), 'utf8');
process.stdout.write(JSON.stringify({ verdict: report.verdict, msiSha256: report.msiSha256.slice(0, 16), stagedFiles: staged.fileCount, packagedFiles: packaged.fileCount, scan: scan.verdict, failures: failures.length }) + '\n');
if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`FAILED ${f.check}: ${f.detail}\n`);
  throw new Error('PACKAGE_VERIFICATION_FAILED');
}
