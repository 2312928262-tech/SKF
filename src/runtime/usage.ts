/**
 * 版本化价目配置（M02）。价格只从环境配置读，不在代码里写宣传数字；
 * 缺价目时金额保持未知，绝不显示成 0。
 */

/** 价目口径版本：改任何一个 key 的语义时必须升级。 */
export const TARIFF_VERSION = '2026-09-08.1';

export interface TariffKeys {
  input: string;
  output: string;
  cached?: string;
}

/** 各 provider 的价目 env key；未列出的 provider = 未配置价目。 */
export const TARIFF_KEYS: Record<string, TariffKeys> = {
  astra: { input: 'SKF_ASTRA_INPUT_USD_PER_M', output: 'SKF_ASTRA_OUTPUT_USD_PER_M', cached: 'SKF_ASTRA_CACHED_USD_PER_M' },
  kimi: { input: 'SKF_KIMI_INPUT_USD_PER_M', output: 'SKF_KIMI_OUTPUT_USD_PER_M', cached: 'SKF_KIMI_CACHED_USD_PER_M' },
  deepseek: { input: 'SKF_DEEPSEEK_INPUT_USD_PER_M', output: 'SKF_DEEPSEEK_OUTPUT_USD_PER_M', cached: 'SKF_DEEPSEEK_CACHED_USD_PER_M' },
};

const rate = (key: string, env: NodeJS.ProcessEnv = process.env) => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** 价目快照：预留时冻结，结算必须用同一快照（价目中途改变不回溯已预留调用）。 */
export interface TariffSnapshot {
  version: string;
  currency: string;
  /** 每百万 token 的 currency 价格（micros = tokens × perM）。 */
  inputPerM: number;
  outputPerM: number;
  /** 缓存命中价；null = 未配置（有缓存时金额未知，不猜）。 */
  cachedPerM: number | null;
}

/** 从环境配置解析某 provider 的价目快照；input/output 任一缺失 = 无价目（null）。 */
export function resolveTariff(provider: string, env: NodeJS.ProcessEnv = process.env): TariffSnapshot | null {
  const keys = TARIFF_KEYS[provider];
  if (!keys) return null;
  const inputPerM = rate(keys.input, env);
  const outputPerM = rate(keys.output, env);
  if (inputPerM === undefined || outputPerM === undefined) return null;
  const cachedPerM = keys.cached ? (rate(keys.cached, env) ?? null) : null;
  return { version: TARIFF_VERSION, currency: 'USD', inputPerM, outputPerM, cachedPerM };
}

/** Configured estimates only; missing tariffs remain unknown, never displayed as zero. */
export function estimateAstraCost(input: number, output: number, cached: number) {
  const inputRate = rate('SKF_ASTRA_INPUT_USD_PER_M');
  const outputRate = rate('SKF_ASTRA_OUTPUT_USD_PER_M');
  const cachedRate = rate('SKF_ASTRA_CACHED_USD_PER_M');
  if (inputRate === undefined || outputRate === undefined || (cached > 0 && cachedRate === undefined)) return undefined;
  return ((input - cached) * inputRate + output * outputRate + cached * (cachedRate ?? 0)) / 1_000_000;
}

/** 通用版估算：cached 是 input 子集，按已配置缓存价计，缺失 cached 价目且有缓存时返回未知。 */
export function estimateCost(provider: string, input: number, output: number, cached: number) {
  const keys = TARIFF_KEYS[provider];
  if (!keys) return undefined;
  const inputRate = rate(keys.input);
  const outputRate = rate(keys.output);
  const cachedRate = keys.cached ? rate(keys.cached) : undefined;
  if (inputRate === undefined || outputRate === undefined) return undefined;
  if (cached > 0 && keys.cached && cachedRate === undefined) return undefined;
  return ((input - cached) * inputRate + output * outputRate + cached * (cachedRate ?? 0)) / 1_000_000;
}

/** 该 provider 的必需价目是否已配置（UI 显示「金额已知/未知」用）。 */
export function tariffConfigured(provider: string): boolean {
  const keys = TARIFF_KEYS[provider];
  if (!keys) return false;
  return rate(keys.input) !== undefined && rate(keys.output) !== undefined;
}
