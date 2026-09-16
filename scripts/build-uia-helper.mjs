#!/usr/bin/env node
/**
 * M26 · 用 Windows 自带 .NET Framework csc.exe 编译 UiaHelper.exe（零新依赖）。
 * - 只在源文件变化或产物缺失时重编（内容 hash 缓存）。
 * - 产物：dev/bin/UiaHelper.exe；清单：dev/bin/uia-helper-manifest.json。
 * - 引用 UIAutomationClient/UIAutomationTypes（.NET 4.x GAC）与 System.Web.Extensions（JSON）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const devRoot = join(here, '..');
const sourcePath = join(here, 'uia-helper', 'UiaHelper.cs');
const binDir = join(devRoot, 'bin');
const outPath = join(binDir, 'UiaHelper.exe');
const manifestPath = join(binDir, 'uia-helper-manifest.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function cscPath() {
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error('csc.exe not found under ' + windir + '\\Microsoft.NET; .NET Framework 4.x is required');
}

/** 在 GAC 里解析程序集 DLL 路径（简单名匹配，取最高版本）。 */
function gacAssemblyPath(name) {
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const roots = [
    join(windir, 'Microsoft.NET', 'assembly', 'GAC_MSIL'),
    join(windir, 'Microsoft.NET', 'assembly', 'GAC_32'),
    join(windir, 'Microsoft.NET', 'assembly', 'GAC_64'),
  ];
  let best = null;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const asmDir = join(root, name);
    if (!existsSync(asmDir)) continue;
    // 遍历子目录（v4.0_x.x.x.x__pubkey）找 DLL。
    for (const verDir of readdirSync(asmDir)) {
      const dll = join(asmDir, verDir, name + '.dll');
      if (existsSync(dll)) {
        if (!best || dll > best) best = dll;
      }
    }
  }
  return best;
}

export function buildUiaHelper({ force = false } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('UiaHelper is Windows-only');
  }
  const source = readFileSync(sourcePath);
  const sourceHash = sha256(source);
  if (!force && existsSync(outPath) && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.sourceSha256 === sourceHash && manifest.outputSha256 === sha256(readFileSync(outPath))) {
      return { path: outPath, rebuilt: false, sourceSha256: sourceHash };
    }
  }
  mkdirSync(binDir, { recursive: true });
  const csc = cscPath();

  const refs = [];
  for (const asm of ['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase']) {
    const p = gacAssemblyPath(asm);
    if (!p) throw new Error('GAC assembly not found: ' + asm);
    refs.push('/r:' + p);
  }

  execFileSync(
    csc,
    ['/nologo', '/optimize+', '/target:exe', `/out:${outPath}`, ...refs, sourcePath],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  const outputHash = sha256(readFileSync(outPath));
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        source: 'scripts/uia-helper/UiaHelper.cs',
        sourceSha256: sourceHash,
        output: 'bin/UiaHelper.exe',
        outputSha256: outputHash,
        compiler: csc,
        references: refs,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return { path: outPath, rebuilt: true, sourceSha256: sourceHash, outputSha256: outputHash };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = buildUiaHelper({ force: process.argv.includes('--force') });
  console.log(JSON.stringify(result));
}
