/**
 * M22 · 联网工具契约（web.search / web.fetch）
 *
 * 命名空间：web.* 不与 file.* / mcp/* / desktop.* / clipboard.* / browser.* 重名。
 * 真实实现 = 外部 HTTP（搜索 API + 页面抓取）；首版 RealWebBridge 占位，
 * FakeWebBridge 覆盖测试（零网络零付费）。
 *
 * effect 分级：
 *   web.search   read  搜索查询（读自动）
 *   web.fetch    read  抓取 URL 内容（读自动）
 * 写操作（如 POST 表单）不在首版范围；若未来加入必须走 external_write 审批门。
 *
 * 限制（红线）：
 *   - 域名白名单：web.fetch 只允许 fetch allowlist 内的域名；不在白名单 = WEB_DOMAIN_NOT_ALLOWED。
 *   - 重定向限制：跨 allowlist 重定向阻止（WEB_REDIRECT_OUT_OF_ALLOWLIST）；MAX_REDIRECTS=5。
 *   - 大小限制：fetch 内容 / 搜索结果有硬上限（MAX_*）。
 *   - 密钥不进任何文件：fetch URL 的 query/header 不含密钥（不做 header 注入；首版无 header）。
 */

import type { Effect } from '../runtime/contracts.js';

export const WEB_TOOL_NAMES = ['web.search', 'web.fetch'] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];

export const WEB_TOOL_EFFECT: Readonly<Record<WebToolName, Effect>> = {
  'web.search': 'read',
  'web.fetch': 'read',
};

export const MAX_SEARCH_QUERY_LENGTH = 1000;
export const MAX_SEARCH_RESULTS = 20;
export const MAX_SEARCH_RESULT_BYTES = 128 * 1024;
export const MAX_FETCH_URL_LENGTH = 2048;
export const MAX_FETCH_CONTENT_BYTES = 256 * 1024;
export const MAX_REDIRECTS = 5;

/** 搜索桥抽象。 */
export interface WebSearchBridge {
  search(opts: WebSearchOptions, signal?: AbortSignal): Promise<WebSearchResult>;
  health(): Promise<WebHealthInfo>;
}

export interface WebSearchOptions {
  query: string;
  limit?: number;
}

export interface WebSearchResult {
  status: 'ok' | 'unavailable';
  results: ReadonlyArray<WebSearchItem>;
  total: number;
}

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

/** 抓取桥抽象。 */
export interface WebFetchBridge {
  fetch(opts: WebFetchOptions, signal?: AbortSignal): Promise<WebFetchResult>;
  health(): Promise<WebHealthInfo>;
}

export interface WebFetchOptions {
  url: string;
  maxBytes?: number;
}

export interface WebFetchResult {
  status: 'ok' | 'denied' | 'redirected' | 'unavailable' | 'failed';
  finalUrl: string;
  /** 提取的文本/markdown（截断到上限）。 */
  content: string;
  byteLength: number;
  redirectCount: number;
  detail: string | null;
}

export interface WebHealthInfo {
  state: 'ok' | 'unavailable' | 'no_allowlist';
  detail: string | null;
  allowlistSize: number;
}

/** 域名白名单复用 browser 的 allowlist 结构（可共用 <dataRoot>/config/web-allowlist.json）。 */
export interface WebAllowlistEntry {
  host: string;
  allowSubdomains?: boolean;
  schemes?: readonly string[];
}

export function loadWebAllowlist(json: string | null | undefined): WebAllowlistEntry[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`INVALID_CONFIG: web-allowlist.json parse failed: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error('INVALID_CONFIG: web-allowlist.json must be array');
  const out: WebAllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new Error('INVALID_CONFIG: allowlist entry must be object');
    const obj = entry as Record<string, unknown>;
    if (typeof obj.host !== 'string' || obj.host.length === 0 || obj.host.length > 253) {
      throw new Error('INVALID_CONFIG: allowlist entry host invalid');
    }
    const host = obj.host.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('INVALID_CONFIG: allowlist entry host has invalid chars');
    if (host.includes('..')) throw new Error('INVALID_CONFIG: allowlist entry host has empty label');
    if (seen.has(host)) continue;
    seen.add(host);
    const schemes = obj.schemes !== undefined ? (Array.isArray(obj.schemes) ? obj.schemes.map((s) => String(s).toLowerCase()) : []) : ['https'];
    out.push({ host, ...(obj.allowSubdomains === true ? { allowSubdomains: true } : {}), ...(schemes.length > 0 ? { schemes } : { schemes: ['https'] }) });
  }
  return out;
}

export function isWebUrlAllowed(url: string, allowlist: readonly WebAllowlistEntry[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  for (const entry of allowlist) {
    const schemeOk = (entry.schemes ?? ['https']).includes(scheme);
    if (!schemeOk) continue;
    if (host === entry.host) return true;
    if (entry.allowSubdomains && host.endsWith('.' + entry.host)) return true;
  }
  return false;
}

/** 联网工具错误码白名单。 */
export const WEB_PUBLIC_ERROR_CODES = [
  'WEB_SEARCH_UNAVAILABLE',
  'WEB_FETCH_UNAVAILABLE',
  'WEB_DOMAIN_NOT_ALLOWED',
  'WEB_REDIRECT_OUT_OF_ALLOWLIST',
  'WEB_FETCH_FAILED',
  'WEB_TOO_MANY_REDIRECTS',
  'WEB_INPUT_INVALID',
  'WEB_TIMEOUT',
  'WEB_RESULT_TOO_LARGE',
] as const;
export type WebPublicErrorCode = (typeof WEB_PUBLIC_ERROR_CODES)[number];
