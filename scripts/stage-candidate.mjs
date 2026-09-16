// M11：staging 构建 + 资源 manifest + 禁打包扫描（fail-closed）。
// 扫描结果只输出文件位置与规则编号，绝不输出匹配到的值。
import { mkdir, readFile, writeFile, cp, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildManifest, scanManifest, PATH_RULES, CONTENT_RULES } from './lib/pack-scan.mjs';
import { assertCurrentCompiledOutput } from './lib/compiled-output.mjs';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'runtime-candidate');
const workDir = join(root, '.work');

const run = (file, args) => {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('STAGE_COMMAND_FAILED');
};

await mkdir(stage, { recursive: true });
await mkdir(workDir, { recursive: true });
run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--outDir', join(stage, 'dist')]);
assertCurrentCompiledOutput(root, join(stage, 'dist'));
await cp(join(root, 'templates', 'prompts'), join(stage, 'prompts'), { recursive: true });
await cp(join(root, 'vendor'), join(stage, 'vendor'), { recursive: true });
await cp(join(root, 'bin'), join(stage, 'bin'), { recursive: true });
await cp(join(root, 'scripts', 'bridge'), join(stage, 'scripts', 'bridge'), { recursive: true });
await cp(join(root, 'scripts', 'config-acl.ps1'), join(stage, 'scripts', 'config-acl.ps1'));
await cp(join(root, 'ui-preview'), join(stage, 'ui-preview'), { recursive: true });
await cp(join(root, 'brand'), join(stage, 'brand'), { recursive: true });
await cp(process.execPath, join(stage, 'node.exe'));

const manifestPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
// Copy only installed production packages recorded in the lockfile, no network or lifecycle scripts.
for (const [key, pkg] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/') || pkg.dev || pkg.devOptional) continue;
  const src = join(root, key);
  try { await access(src); } catch { if (pkg.optional) continue; throw new Error('MISSING_PACKAGE: ' + key); }
  await cp(src, join(stage, key), { recursive: true });
}
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'skf-runtime', version: manifestPkg.version, type: 'module', dependencies: manifestPkg.dependencies }, null, 2), 'utf8');
for (const file of ['dist/supervisor.js', 'dist/runtime/chat-service.js', 'dist/runtime/memory-adapter.js', 'vendor/memory-runtime/integration.mjs', 'vendor/memory-runtime/store.mjs', 'prompts/IDENTITY.md', 'node.exe']) await access(join(stage, file));

// ── 资源 manifest + 禁打包扫描 ────────────────────────────────
const stagingManifest = await buildManifest(stage, { version: manifestPkg.version });
// 记录在案的唯一放行（文件+规则+原因），默认为空；任何新增都必须附原因并写进证据。
const SCAN_ALLOWLIST = [];
const scan = await scanManifest(stage, stagingManifest.files, SCAN_ALLOWLIST);
const scanReport = {
  generatedAt: stagingManifest.generatedAt,
  root: stage,
  pathRules: PATH_RULES.map(([id]) => id),
  contentRules: CONTENT_RULES.map(([id]) => id),
  allowlist: SCAN_ALLOWLIST,
  allowed: scan.allowed,
  blocked: scan.blocked,
  verdict: scan.verdict,
  note: '只记录文件位置与规则编号；匹配到的值永不落盘。',
};
await writeFile(join(workDir, 'staging-scan.json'), JSON.stringify(scanReport, null, 2), 'utf8');
await writeFile(join(workDir, 'staging-manifest.json'), JSON.stringify(stagingManifest, null, 2), 'utf8');
process.stdout.write(`Staged ${stagingManifest.fileCount} files (rootHash ${stagingManifest.rootHash.slice(0, 16)}…), scan ${scan.verdict} (${scan.blocked.length} blocked, ${scan.allowed.length} allowlisted). No credentials, chat logs or cloud calls.\n`);
if (scan.blocked.length > 0) {
  for (const f of scan.blocked) process.stdout.write(`BLOCKED ${f.rule} ${f.path}\n`);
  throw new Error('STAGE_SCAN_BLOCKED');
}
