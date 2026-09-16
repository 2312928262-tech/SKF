import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService, defaultConfigDir, defaultDataDir } from '../config/config-service.js';

export function loadEnvironment() {
  if (process.env.SKF_SKIP_ENV === '1' && process.env.SKF_MANAGED_INSTANCE !== '1') return;
  if (process.env.SKF_MANAGED_INSTANCE === '1' || existsSync(join(defaultConfigDir(), 'models.json'))) {
    const paths = new ConfigService().paths();
    process.env.SKF_DATA_DIR = paths.dataDir;
    process.env.SKF_MEMORY_ROOT = paths.memoryRoot;
    return; // credentialRef is read at request time; never copy credential file into process.env.
  }
  if (process.env.SKF_SKIP_ENV === '1') return;
  const explicit = process.env.SKF_DATA_DIR;
  const candidates = explicit
    ? [join(explicit, 'config', 'config.env'), join(explicit, 'config.env')]
    : [join(process.cwd(), '.env'), join(homedir(), '.skf', 'config', 'config.env'), join(homedir(), '.skf', 'config.env')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    break;
  }
}

export function dataRoot() {
  return resolve(process.env.SKF_DATA_DIR || defaultDataDir());
}

export function positiveInt(name: string, fallback: number, max = 1_000_000) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('INVALID_CONFIG_' + name);
  return value;
}

// ─────────────────────────────────────
// 统一记忆（M01）
// ─────────────────────────────────────

export type MemoryMode = 'vault' | 'legacy';

/** vault（默认）= 只写统一主档；legacy = 回退到旧 L1-L5 聊天路径，主档只读不动。 */
export function memoryMode(): MemoryMode {
  const raw = (process.env.SKF_MEMORY_MODE || 'vault').trim();
  if (raw !== 'vault' && raw !== 'legacy') throw new Error('INVALID_CONFIG_SKF_MEMORY_MODE');
  return raw;
}

/** 统一主档根目录（用户数据，独立于安装目录）。 */
export function memoryRoot() {
  return resolve(process.env.SKF_MEMORY_ROOT || join(dataRoot(), 'vault'));
}

export function memoryScope() {
  return process.env.SKF_MEMORY_SCOPE || 'skf';
}

/** IPC / CLI 共用同一套 sessionId 规则；恢复原任务须沿用原 sessionId。 */
export function memorySessionId(channel: 'ipc' | 'cli') {
  return process.env.SKF_SESSION_ID || `skf-${channel}`;
}

// ─────────────────────────────────────
// 预算与路由（M06）
// ─────────────────────────────────────

export type BudgetMode = 'strict-money' | 'call-limit' | 'local-only';

/**
 * 预算模式：strict-money = 无价目拒绝云调用；call-limit（默认）= 只保证次数/输出上限，
 * 金额可能未知且必须明示；local-only = 只许本地/测试 provider。
 * 没有用户金额配置时不自设任何虚构月预算。
 */
export function budgetMode(): BudgetMode {
  const raw = (process.env.SKF_BUDGET_MODE || 'call-limit').trim();
  if (raw !== 'strict-money' && raw !== 'call-limit' && raw !== 'local-only') {
    throw new Error('INVALID_CONFIG_SKF_BUDGET_MODE');
  }
  return raw;
}

/** 十进制金额字符串 → 整数微货币；负数/NaN/爆精度一律 INVALID_CONFIG。 */
function decimalToMicros(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(text)) throw new Error('INVALID_CONFIG_' + name);
  const micros = Math.round(Number(text) * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros < 1) throw new Error('INVALID_CONFIG_' + name);
  return micros;
}

/** 每日金额上限（微 USD）；未配置 = 无金额上限，不是 0 也不是虚构值。 */
export function budgetDailyMicros() {
  return decimalToMicros('SKF_BUDGET_DAILY_USD');
}

/** 单任务金额上限（微 USD）。 */
export function budgetTaskMicros() {
  return decimalToMicros('SKF_BUDGET_PER_TASK_USD');
}

/** 昂贵 provider 名单：常规路由不选，升级必须任务策略显式授权。 */
export function expensiveProviders(): Set<string> {
  const raw = process.env.SKF_EXPENSIVE_PROVIDERS;
  const list = (raw === undefined ? 'astra' : raw).split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(list);
}

/** ModelGateway 统一重试策略：默认 0（关闭）；只能在这里显式开启。 */
export function gatewayMaxRetries() {
  const raw = process.env.SKF_GATEWAY_RETRIES;
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 3) throw new Error('INVALID_CONFIG_SKF_GATEWAY_RETRIES');
  return value;
}

// ─────────────────────────────────────
// OpenClaw 可选桥接（M09）
// ─────────────────────────────────────

/** 桥接默认开启但启动不依赖；'0' 完全关闭（不发起任何探测进程）。 */
export function openclawBridgeEnabled() {
  return process.env.SKF_OPENCLAW_BRIDGE !== '0';
}

/** 桥接命令名（默认 openclaw；测试可指向临时假 CLI）。 */
export function openclawBridgeCommand() {
  return process.env.SKF_OPENCLAW_BRIDGE_CMD || 'openclaw';
}

function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** vendored 记忆 runtime（包内代码，可按版本审计；不含 vault/requests/backups）。 */
export function memoryVendorDir() {
  return resolve(process.env.SKF_MEMORY_VENDOR_DIR || join(packageRoot(), 'vendor', 'memory-runtime'));
}

/** 本地写回 outbox：主档暂不可用时排队，下次 prepare 前幂等重放。 */
export function memoryOutboxDir() {
  return resolve(process.env.SKF_MEMORY_OUTBOX_DIR || join(dataRoot(), 'memory-outbox'));
}

/** prepare 输入预算：UTF-8 字节上限，不是 provider token。 */
export function memoryMaxInputBytes() {
  return positiveInt('SKF_MEMORY_MAX_BYTES', 18000, 500_000);
}

/** 本地 bge-m3 语义检索；'0' 时只走关键词（无嵌入服务的环境/测试）。 */
export function memorySemantic() {
  return process.env.SKF_MEMORY_SEMANTIC !== '0';
}

// ─────────────────────────────────────
// M17 · 桌面工具层
// ─────────────────────────────────────

/** 桌面启动白名单配置文件（默认 <dataRoot>/config/desktop-launch.json，缺失 = launch 工具永远 LAUNCH_DENIED）。 */
export function desktopLaunchConfigPath() {
  return resolve(process.env.SKF_DESKTOP_LAUNCH_CONFIG || join(dataRoot(), 'config', 'desktop-launch.json'));
}

/**
 * 桌面工具开关：默认 '0'（Real 桥未启用；Fake 桥由 supervisor 在 dev/test 装配）。
 * '1' 启用 RealUiaBridge/RealClipboardBridge（Windows helper 待后续卡位打开）。
 * 任何模式都装配 ToolRegistry —— 只是 Real 桥的 health/调用会抛 UIA_UNAVAILABLE/CLIPBOARD_UNAVAILABLE，
 * 上层按"诚实不可用"处理，绝不假装成功。
 */
export function desktopEnabled() {
  return process.env.SKF_DESKTOP === '1';
}

// ─────────────────────────────────────
// M19 · 浏览器 CDP 层
// ─────────────────────────────────────

/** 浏览器域名白名单配置文件（默认 <dataRoot>/config/browser-allowlist.json，缺失 = 浏览器工具 BROWSER_DOMAIN_NOT_ALLOWED）。 */
export function browserAllowlistConfigPath() {
  return resolve(process.env.SKF_BROWSER_ALLOWLIST || join(dataRoot(), 'config', 'browser-allowlist.json'));
}

/** 浏览器工具开关：默认 '0'（RealPlaywrightBridge 未启用；Fake 桥由 supervisor 在 dev/test 装配）。 */
export function browserEnabled() {
  return process.env.SKF_BROWSER === '1';
}

// ─────────────────────────────────────
// M22 · 联网工具
// ─────────────────────────────────────

/** 联网域名白名单配置文件（默认 <dataRoot>/config/web-allowlist.json，缺失 = web.fetch WEB_DOMAIN_NOT_ALLOWED）。 */
export function webAllowlistConfigPath() {
  return resolve(process.env.SKF_WEB_ALLOWLIST || join(dataRoot(), 'config', 'web-allowlist.json'));
}

/** 联网工具开关：默认 '0'（RealWebBridge 未启用；Fake 桥由 supervisor 在 dev/test 装配）。 */
export function webEnabled() {
  return process.env.SKF_WEB === '1';
}

// ─────────────────────────────────────
// M16 · 媒体工具
// ─────────────────────────────────────

/** 媒体工具开关：默认 '0'（RealMediaBridge 未启用；Fake 桥由 supervisor 在 dev/test 装配）。 */
export function mediaEnabled() {
  return process.env.SKF_MEDIA === '1';
}

/** ComfyUI API 基地址（media.image / media.vram.manage）。 */
export function comfyuiUrl() {
  return (process.env.SKF_COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
}

/** ComfyUI API 工作流 JSON（prompt 节点 6 / 负向 7 / latent 5）。 */
export function comfyuiWorkflowPath() {
  return resolve(process.env.SKF_COMFYUI_WORKFLOW || join(dataRoot(), 'config', 'sdxl_txt2img_api.json'));
}

/** faster-whisper venv 解释器（media.transcribe）。 */
export function whisperPythonPath() {
  return process.env.SKF_WHISPER_PYTHON || '';
}

/** CosyVoice2 venv 解释器（media.tts）。 */
export function ttsPythonPath() {
  return process.env.SKF_TTS_PYTHON || '';
}

/** 转写/配音脚本（包内 scripts/bridge/）。 */
export function whisperScriptPath() {
  return resolve(process.env.SKF_WHISPER_SCRIPT || join(packageRoot(), 'scripts', 'bridge', 'whisper-transcribe.py'));
}
export function ttsScriptPath() {
  return resolve(process.env.SKF_TTS_SCRIPT || join(packageRoot(), 'scripts', 'bridge', 'cosyvoice-tts.py'));
}

/** UIA 助手（bin/UiaHelper.exe）与 JobLauncher（bin/JobLauncher.exe）。 */
export function uiaHelperPath() {
  return resolve(process.env.SKF_UIA_HELPER || join(packageRoot(), 'bin', 'UiaHelper.exe'));
}
export function uiaLauncherPath() {
  return resolve(process.env.SKF_UIA_LAUNCHER || join(packageRoot(), 'bin', 'JobLauncher.exe'));
}

// ─────────────────────────────────────
// MCP 工具层（M14）
// ─────────────────────────────────────

/** MCP 白名单配置文件；默认 <dataRoot>/config/mcp-servers.json，缺失 = 特性关闭。 */
export function mcpConfigPath() {
  return resolve(process.env.SKF_MCP_CONFIG || join(dataRoot(), 'config', 'mcp-servers.json'));
}

/** JobLauncher.exe（Windows Job Object 进程树托管）；包内 bin/，测试可用 SKF_MCP_LAUNCHER 覆盖。 */
export function mcpLauncherPath() {
  return resolve(process.env.SKF_MCP_LAUNCHER || join(packageRoot(), 'bin', 'JobLauncher.exe'));
}

// ─────────────────────────────────────
// M13 · 学习闭环（影子模式）
// ─────────────────────────────────────

/** 影子模式开关：默认开启（只观察/记录/评估，不改策略不触发真实任务）；'0' 完全关闭。 */
export function learningEnabled() {
  return process.env.SKF_LEARNING !== '0';
}

/** 每日自动复盘次数独立限额（默认 5；Asia/Shanghai 日界，与前台预算分离）。 */
export function reviewDailyLimit() {
  return positiveInt('SKF_REVIEW_DAILY_LIMIT', 5, 100);
}

/** 普通成功抽样百分比（默认 10；确定性 hash 抽样，可复现）。 */
export function reviewSuccessSamplePct() {
  const raw = process.env.SKF_REVIEW_SAMPLE_PCT;
  if (raw === undefined || raw.trim() === '') return 10;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new Error('INVALID_CONFIG_SKF_REVIEW_SAMPLE_PCT');
  return value;
}

/** 复盘模型路由覆盖（缺省走 gateway 默认路由 = 用户主模型 kimi-k3；绝不自动升级昂贵）。 */
export function reviewRoute(): { provider?: string; model?: string } {
  const provider = process.env.SKF_REVIEW_PROVIDER?.trim();
  const model = process.env.SKF_REVIEW_MODEL?.trim();
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}
