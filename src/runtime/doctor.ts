import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { probeOnce, type BridgeStatus } from '../tools/openclaw-bridge.js';

/**
 * M09 · doctor 只读诊断（03-TASK-CARDS M09.4）。
 *
 * - 只读：不改配置、不写数据库、不动主档；唯一写动作是「目录可读写」探测
 *   （在数据目录内创建后立即删除一个 .skf-doctor-probe-* 文件，不留痕）。
 * - 只返回存在/缺失：provider key、代理、配置一律不报值、不报长度、不报前缀；
 *   不打印 secret、不打印环境全文。
 * - 桥接与 Ollama 是可选诊断（required=false）：unavailable 如实报告但不判死刑；
 *   必需项失败才退出码 1。
 */

export interface DoctorCheck {
  id: string;
  name: string;
  /** true = 失败会让退出码为 1；false = 可选能力，如实报告。 */
  required: boolean;
  ok: boolean;
  /** 存在/缺失/版本等安全摘要（绝不含 secret 或环境变量值）。 */
  status: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  node: string;
  platform: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  vaultRoot?: string;
  /** config.env 候选路径（默认按 dataDir 推导，与 loadEnvironment 同一顺序）。 */
  configCandidates?: string[];
  ollamaUrl?: string;
  /** 测试注入；默认真实探测。 */
  probeBridge?: () => Promise<BridgeStatus>;
  probeOllama?: (url: string, timeoutMs: number) => Promise<boolean>;
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  return resolve(env.SKF_DATA_DIR || (process.platform === 'win32' ? 'D:\\SKF-data' : './.skf-data'));
}

function defaultVaultRoot(env: NodeJS.ProcessEnv): string {
  return resolve(env.SKF_MEMORY_ROOT || (process.platform === 'win32' ? 'D:\\Xiaoliu-Memory\\vault' : './.xiaoliu-memory/vault'));
}

function defaultConfigCandidates(dataDir: string): string[] {
  return [join(dataDir, 'config', 'config.env'), join(dataDir, 'config.env')];
}

/** 与 loadEnvironment 同一候选规则，但只读解析，不写入 process.env。 */
function readConfigPresence(candidates: string[], env: NodeJS.ProcessEnv): Record<string, boolean> {
  const keys = ['KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;
  const present: Record<string, boolean> = {};
  for (const key of keys) {
    const fromEnv = env[key] !== undefined && env[key]!.trim() !== '';
    if (fromEnv) {
      present[key] = true;
      continue;
    }
    let fromFile = false;
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      const content = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match && match[1] === key && match[2].trim().replace(/^["']|["']$/g, '') !== '') {
          fromFile = true;
          break;
        }
      }
      if (fromFile) break;
    }
    present[key] = fromFile;
  }
  return present;
}

/** 目录可读写探测：创建后立即删除，finally 保证零残留。 */
function probeWritableDir(dir: string): { ok: boolean; status: string } {
  if (!existsSync(dir)) {
    return { ok: true, status: `不存在（首次运行自动创建）: ${dir}` };
  }
  if (!statSync(dir).isDirectory()) {
    return { ok: false, status: `路径存在但不是目录: ${dir}` };
  }
  try {
    readdirSync(dir);
  } catch (error) {
    return { ok: false, status: `不可读: ${(error as Error).message.slice(0, 120)}` };
  }
  const probe = join(dir, `.skf-doctor-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'probe', 'utf8');
    readFileSync(probe, 'utf8');
    return { ok: true, status: `可读写: ${dir}` };
  } catch (error) {
    return { ok: false, status: `不可写: ${(error as Error).message.slice(0, 120)}` };
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* 探测文件清理失败不掩盖结论 */
    }
  }
}

function checkRuntimeDb(dbPath: string): DoctorCheck {
  if (!existsSync(dbPath)) {
    return { id: 'db.runtime', name: 'runtime.sqlite 执行账本', required: true, ok: true, status: '尚不存在（首次运行自动创建+迁移）' };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const quick = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    const integrity = (quick?.quick_check ?? '').toLowerCase() === 'ok';
    const versionRow = db.prepare('SELECT MAX(version) AS v FROM migration_versions').get() as { v: number | null } | undefined;
    const version = versionRow?.v ?? 0;
    return {
      id: 'db.runtime',
      name: 'runtime.sqlite 执行账本',
      required: true,
      ok: integrity && version >= 1,
      status: integrity ? `quick_check=ok · schema v${version}` : `quick_check 失败: ${quick?.quick_check ?? 'unknown'}`,
      ...(integrity ? {} : { fix: '备份后联系维护；不要手改 sqlite' }),
    };
  } catch (error) {
    return {
      id: 'db.runtime',
      name: 'runtime.sqlite 执行账本',
      required: true,
      ok: false,
      status: `只读打开失败: ${(error as Error).message.slice(0, 120)}`,
      fix: '确认没有进程占用或文件损坏；可从备份恢复',
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* 关闭失败不掩盖结论 */
    }
  }
}

async function defaultProbeOllama(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal, redirect: 'error' });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

function skfVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? defaultDataDir(env);
  const vaultRoot = opts.vaultRoot ?? defaultVaultRoot(env);
  const candidates = opts.configCandidates ?? defaultConfigCandidates(dataDir);
  const checks: DoctorCheck[] = [];
  const version = skfVersion();

  // 1. Node 运行时（node:sqlite 是账本硬依赖）
  const major = Number(process.version.replace(/^v/, '').split('.')[0]);
  let sqliteOk = false;
  try {
    const probe = new DatabaseSync(':memory:');
    probe.close();
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
  checks.push({
    id: 'node.runtime',
    name: 'Node.js 运行时',
    required: true,
    ok: major >= 22 && sqliteOk,
    status: `${process.version} · node:sqlite ${sqliteOk ? '可用' : '不可用'}`,
    ...(major >= 22 && sqliteOk ? {} : { fix: '安装 Node >= 22.5（建议 24）' }),
  });

  // 2. 数据目录可读写（探测文件即时删除）
  const dataProbe = probeWritableDir(dataDir);
  checks.push({ id: 'dirs.data', name: 'SKF 数据目录', required: true, ok: dataProbe.ok, status: dataProbe.status, ...(dataProbe.ok ? {} : { fix: '检查 SKF_DATA_DIR 权限' }) });

  // 3. 统一主档目录（用户数据，只读检查，不做写探测）
  let vaultOk = false;
  let vaultStatus: string;
  if (!existsSync(vaultRoot)) {
    vaultStatus = `不存在: ${vaultRoot}`;
  } else {
    try {
      readdirSync(vaultRoot);
      vaultOk = true;
      vaultStatus = `存在且可读: ${vaultRoot}`;
    } catch (error) {
      vaultStatus = `不可读: ${(error as Error).message.slice(0, 120)}`;
    }
  }
  checks.push({ id: 'dirs.vault', name: '统一记忆主档目录', required: true, ok: vaultOk, status: vaultStatus, ...(vaultOk ? {} : { fix: '确认 SKF_MEMORY_ROOT；缺失时 SKF 会进入无记忆降级模式' }) });

  // 4. runtime.sqlite 只读 verify
  checks.push(checkRuntimeDb(join(dataDir, 'runtime.sqlite')));

  // 5. provider 配置存在性（只报存在/缺失，绝不报值）
  const presence = readConfigPresence(candidates, env);
  const configured = {
    kimi: presence.KIMI_API_KEY === true,
    deepseek: presence.DEEPSEEK_API_KEY === true,
    astra: presence.OPENAI_API_KEY === true,
    openrouter: presence.OPENROUTER_API_KEY === true,
  };
  const anyConfigured = configured.kimi || configured.deepseek || configured.astra || configured.openrouter;
  const summary = (Object.keys(configured) as Array<keyof typeof configured>)
    .map((name) => `${name}:${configured[name] ? '已配置' : '缺失'}`)
    .join(' · ');
  const configFile = candidates.find((file) => existsSync(file));
  checks.push({
    id: 'providers.config',
    name: '模型 provider 配置（仅存在性）',
    required: true,
    ok: anyConfigured,
    status: `${summary}${configFile ? ` · 配置文件: ${configFile}` : ''}`,
    ...(anyConfigured ? {} : { fix: '在 config.env 配置至少一个模型 key（如 KIMI_API_KEY）' }),
  });

  // 6. Ollama 本地可达（可选）
  const ollamaUrl = opts.ollamaUrl ?? 'http://127.0.0.1:11434/api/tags';
  const probeOllama = opts.probeOllama ?? defaultProbeOllama;
  const ollamaOk = await probeOllama(ollamaUrl, 800);
  checks.push({
    id: 'ollama.reachable',
    name: 'Ollama 本地端点',
    required: false,
    ok: ollamaOk,
    status: ollamaOk ? `可达: ${ollamaUrl}` : `不可达: ${ollamaUrl}（未安装或未启动，仅影响本地模型选项）`,
  });

  // 7. OpenClaw 桥接状态（可选；启动不依赖）
  const probeBridge = opts.probeBridge ?? (() => probeOnce({ enabled: env.SKF_OPENCLAW_BRIDGE !== '0', ...(env.SKF_OPENCLAW_BRIDGE_CMD ? { command: env.SKF_OPENCLAW_BRIDGE_CMD } : {}) }));
  const bridge = await probeBridge();
  checks.push({
    id: 'bridge.openclaw',
    name: 'OpenClaw 桥接（增强）',
    required: false,
    ok: bridge.state === 'available' || bridge.state === 'disabled',
    status:
      bridge.state === 'available'
        ? `available · ${bridge.version ?? 'version unknown'}`
        : bridge.state === 'disabled'
          ? 'disabled（SKF_OPENCLAW_BRIDGE=0）'
          : `unavailable · ${bridge.reason ?? '未知原因'}（本地任务不受影响）`,
  });

  return {
    ok: checks.every((check) => check.ok || !check.required),
    version,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    checks,
  };
}

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m' };

export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`${C.bold}${C.cyan}SKF doctor v${report.version}（只读诊断，不含密钥/环境全文）${C.reset}`);
  lines.push('');
  for (const check of report.checks) {
    const icon = check.ok ? `${C.green}✓${C.reset}` : check.required ? `${C.red}✗${C.reset}` : `${C.yellow}○${C.reset}`;
    const tag = check.required ? '' : `${C.gray}（可选）${C.reset}`;
    lines.push(`  ${icon} ${C.bold}${check.name}${C.reset}${tag}`);
    lines.push(`     ${C.gray}${check.status}${C.reset}`);
    if (!check.ok && check.fix) lines.push(`     ${C.yellow}→ ${check.fix}${C.reset}`);
  }
  lines.push('');
  lines.push(report.ok ? `${C.green}✅ 必需项全部通过${C.reset}` : `${C.red}❌ 有必需项未通过，按提示修复${C.reset}`);
  return lines.join('\n');
}

/** CLI 入口：--json 输出机器可读报告；退出码 = 必需项是否全过。 */
export async function main(argv: string[] = []): Promise<number> {
  const report = await runDoctor();
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatDoctorText(report) + '\n');
  }
  return report.ok ? 0 : 1;
}
