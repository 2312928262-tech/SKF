import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { runDoctor, formatDoctorText } from '../dist/runtime/doctor.js';

// M09 验收：doctor 只读诊断。
// 覆盖 D01 全绿路径（可写目录/DB verify/provider 存在性/桥与 Ollama 可选）、
// D02 缺失路径（无 key/无主档 → 必需项失败）、D03 CLI e2e（--json 退出码 + 无泄密）。
// 临时目录与桩探测，零网络、零真实配置接触。

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR_SCRIPT = join(DEV_ROOT, 'scripts', 'doctor.mjs');

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m09d-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const FAKE_KIMI = 'kimi-fake-key-value-0123456789abcdef';
const FAKE_DEEPSEEK = 'deepseek-fake-key-value-abcdef0123456789';

// ── D01：全绿路径 + 只返回存在/缺失（不泄密）─────────────────────────

test('D01 doctor 全绿：目录可读写/DB quick_check/schema/provider 仅存在性/桥与 Ollama 可选报告；输出零 key 材料', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09d-'));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault');
  const configDir = join(dataDir, 'config');
  await mkdir(configDir, { recursive: true });
  await mkdir(vault, { recursive: true });
  await writeFile(join(configDir, 'config.env'), `DEEPSEEK_API_KEY=${FAKE_DEEPSEEK}\n`, 'utf8');
  // 建一个真实 runtime.sqlite 供 verify
  const store = new RuntimeStore(join(dataDir, 'runtime.sqlite'));
  store.close();
  try {
    const report = await runDoctor({
      env: { KIMI_API_KEY: FAKE_KIMI, SKF_DATA_DIR: dataDir, SKF_MEMORY_ROOT: vault },
      dataDir,
      vaultRoot: vault,
      configCandidates: [join(configDir, 'config.env')],
      probeBridge: async () => ({ state: 'unavailable', reason: 'OpenClaw CLI 未找到（测试）', version: null, checkedAt: null }),
      probeOllama: async () => false,
    });
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId['node.runtime'].ok, true);
    assert.equal(byId['dirs.data'].ok, true);
    assert.match(byId['dirs.data'].status, /可读写/);
    assert.equal(byId['dirs.vault'].ok, true);
    assert.equal(byId['db.runtime'].ok, true);
    assert.match(byId['db.runtime'].status, /quick_check=ok · schema v7/);
    assert.equal(byId['providers.config'].ok, true);
    assert.match(byId['providers.config'].status, /kimi:已配置/);
    assert.match(byId['providers.config'].status, /deepseek:已配置/);
    assert.match(byId['providers.config'].status, /astra:缺失/);
    // 可选：unavailable 如实报告但不判死刑
    assert.equal(byId['bridge.openclaw'].required, false);
    assert.match(byId['bridge.openclaw'].status, /unavailable/);
    assert.equal(byId['ollama.reachable'].required, false);
    // 泄密检查：报告与文本渲染都不得包含任何 key 材料
    const serialized = JSON.stringify(report) + formatDoctorText(report);
    assert.ok(!serialized.includes(FAKE_KIMI), 'report leaks kimi key');
    assert.ok(!serialized.includes(FAKE_DEEPSEEK), 'report leaks deepseek key');
    assert.ok(!/API_KEY\s*=\s*\S/i.test(serialized), 'report must not print KEY=value pairs');
    // 目录写探测零残留
    const { readdirSync } = await import('node:fs');
    assert.ok(!readdirSync(dataDir).some((f) => f.startsWith('.skf-doctor-probe')), 'probe file must not remain');
  } finally {
    await cleanupTestRoot(root);
  }
});

// ── D02：缺失路径 —— 无 key/无主档 → 必需项失败；缺 DB/数据目录可恢复 ──

test('D02 doctor 缺失：无任何 provider key 且主档不存在 → report.ok=false；DB 缺失视为首次运行不判失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09d-'));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault-missing');
  await mkdir(dataDir, { recursive: true });
  try {
    const report = await runDoctor({
      env: { SKF_DATA_DIR: dataDir, SKF_MEMORY_ROOT: vault },
      dataDir,
      vaultRoot: vault,
      configCandidates: [join(dataDir, 'config', 'config.env')],
      probeBridge: async () => ({ state: 'disabled', reason: 'SKF_OPENCLAW_BRIDGE=0', version: null, checkedAt: null }),
      probeOllama: async () => false,
    });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId['providers.config'].ok, false);
    assert.equal(byId['providers.config'].required, true);
    assert.equal(byId['dirs.vault'].ok, false);
    assert.equal(byId['db.runtime'].ok, true); // 首次运行自动创建
    assert.match(byId['db.runtime'].status, /尚不存在/);
    assert.equal(byId['bridge.openclaw'].ok, true); // disabled 是合法显式状态
    assert.equal(report.ok, false);
  } finally {
    await cleanupTestRoot(root);
  }
});

// ── D03：CLI e2e —— --json 输出与退出码 ───────────────────────────

test('D03 doctor.mjs CLI：--json 可解析；必需项全过退出 0，缺 key 退出 1；stdout 零泄密', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09d-'));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault');
  await mkdir(vault, { recursive: true });
  const store = new RuntimeStore(join(dataDir, 'runtime.sqlite'));
  store.close();
  const baseEnv = {
    PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, COMSPEC: process.env.COMSPEC,
    SKF_DATA_DIR: dataDir, SKF_MEMORY_ROOT: vault,
    SKF_OPENCLAW_BRIDGE_CMD: 'definitely-not-exists-openclaw-m09',
  };
  try {
    // 全过（带假 key，桩 bridge 不可用但可选）
    const okRun = spawn(process.execPath, [DOCTOR_SCRIPT, '--json'], { env: { ...baseEnv, KIMI_API_KEY: FAKE_KIMI }, windowsHide: true });
    let okOut = '';
    okRun.stdout.on('data', (b) => (okOut += b));
    const okCode = await new Promise((r) => okRun.on('exit', r));
    assert.equal(okCode, 0, okOut.slice(-400));
    const report = JSON.parse(okOut);
    assert.equal(report.ok, true);
    assert.ok(!okOut.includes(FAKE_KIMI), 'doctor stdout leaks key material');
    const bridgeCheck = report.checks.find((c) => c.id === 'bridge.openclaw');
    assert.match(bridgeCheck.status, /unavailable/);

    // 缺 key → 必需项失败 → 退出 1
    const failRun = spawn(process.execPath, [DOCTOR_SCRIPT, '--json'], { env: baseEnv, windowsHide: true });
    let failOut = '';
    failRun.stdout.on('data', (b) => (failOut += b));
    const failCode = await new Promise((r) => failRun.on('exit', r));
    assert.equal(failCode, 1);
    const failReport = JSON.parse(failOut);
    assert.equal(failReport.ok, false);
    assert.equal(failReport.checks.find((c) => c.id === 'providers.config').ok, false);
  } finally {
    await cleanupTestRoot(root);
  }
});
