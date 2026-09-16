#!/usr/bin/env node
/**
 * M14 · 用 Windows 自带 .NET Framework csc.exe 编译 JobLauncher.exe（零新依赖）。
 * - 只在源文件变化或产物缺失时重编（内容 hash 缓存）。
 * - 产物：dev/bin/JobLauncher.exe；清单：dev/bin/job-launcher-manifest.json（源/产物 SHA-256）。
 * - csc.exe 缺失 = 明确失败（Windows 4.x .NET Framework 为 OS 组件，不静默跳过）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const devRoot = join(here, '..');
const sourcePath = join(here, 'job-launcher', 'JobLauncher.cs');
const binDir = join(devRoot, 'bin');
const outPath = join(binDir, 'JobLauncher.exe');
const manifestPath = join(binDir, 'job-launcher-manifest.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function cscPath() {
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`csc.exe not found under ${windir}\\Microsoft.NET; .NET Framework 4.x is required to build JobLauncher`);
}

export function buildJobLauncher({ force = false } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('JobLauncher is Windows-only; non-Windows MCP supervision is not supported in M14');
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
  execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${outPath}`, sourcePath], { stdio: 'pipe' });
  const outputHash = sha256(readFileSync(outPath));
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        source: 'scripts/job-launcher/JobLauncher.cs',
        sourceSha256: sourceHash,
        output: 'bin/JobLauncher.exe',
        outputSha256: outputHash,
        compiler: csc,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return { path: outPath, rebuilt: true, sourceSha256: sourceHash, outputSha256: outputHash };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = buildJobLauncher({ force: process.argv.includes('--force') });
  console.log(JSON.stringify(result));
}
