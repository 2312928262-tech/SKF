/**
 * M19 · 浏览器 CDP 层契约
 *
 * 命名空间：browser.* 不与 file.* / mcp/* / desktop.* / clipboard.* 重名。
 * 真实驱动 = Playwright CDP（真实 Chrome）；首版 RealPlaywrightBridge 占位，
 * FakeBrowserBridge 覆盖测试（零网络零付费零真实浏览器）。
 *
 * effect 分级：
 *   browser.navigate   read          导航到白名单域名（读=自动）
 *   browser.snapshot   read          页面可访问性快照（读=自动）
 *   browser.text       read          提取页面文本（读=自动）
 *   browser.click      external_write 点击元素（写=审批门）
 *   browser.type       external_write 输入文本（写=审批门）
 *   browser.fill       external_write 填表单字段（写=审批门）
 *
 * 限制（红线）：
 *   - 域名白名单：仅允许访问 allowlist 内的域名；不在白名单 = DOMAIN_NOT_ALLOWED。
 *   - 重定向限制：跨域重定向阻止（REDIRECT_OUT_OF_ALLOWLIST）；同域重定向放行。
 *   - 大小限制：快照/文本/结果有硬上限（MAX_*）。
 *   - 审批 hash 绑定：写工具 args + 当前页面 URL + 域名（同 M14/M18 纪律）。
 *   - 密钥不进任何文件：type/fill 的文本若疑似密钥则拒绝（SECRET_INPUT_FORBIDDEN）。
 */

import { createHash } from 'node:crypto';
import type { Effect, JSONValue } from '../runtime/contracts.js';

export const BROWSER_TOOL_NAMES = [
  'browser.navigate',
  'browser.snapshot',
  'browser.text',
  'browser.click',
  'browser.type',
  'browser.fill',
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export const BROWSER_TOOL_EFFECT: Readonly<Record<BrowserToolName, Effect>> = {
  'browser.navigate': 'read',
  'browser.snapshot': 'read',
  'browser.text': 'read',
  'browser.click': 'external_write',
  'browser.type': 'external_write',
  'browser.fill': 'external_write',
};

export const MAX_URL_LENGTH = 2048;
export const MAX_SNAPSHOT_NODES = 500;
export const MAX_SNAPSHOT_BYTES = 128 * 1024;
export const MAX_PAGE_TEXT_BYTES = 64 * 1024;
export const MAX_INPUT_TEXT_BYTES = 64 * 1024;
export const MAX_REDIRECTS = 5;

/** 域名白名单条目（配置 <dataRoot>/config/browser-allowlist.json）。 */
export interface BrowserAllowlistEntry {
  /** 主域名（小写；不含端口/路径）。 */
  host: string;
  /** 是否允许子域（默认 false）。 */
  allowSubdomains?: boolean;
  /** 允许的 scheme（默认 https）。 */
  schemes?: readonly string[];
}

/** 浏览器桥抽象。 */
export interface BrowserBridge {
  navigate(opts: BrowserNavigateOptions, signal?: AbortSignal): Promise<BrowserNavigateResult>;
  snapshot(opts: BrowserSnapshotOptions, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
  text(opts: BrowserTextOptions, signal?: AbortSignal): Promise<BrowserTextResult>;
  click(opts: BrowserClickOptions, signal?: AbortSignal): Promise<BrowserActionResult>;
  type(opts: BrowserTypeOptions, signal?: AbortSignal): Promise<BrowserActionResult>;
  fill(opts: BrowserFillOptions, signal?: AbortSignal): Promise<BrowserActionResult>;
  health(): Promise<BrowserHealthInfo>;
}

export interface BrowserNavigateOptions {
  url: string;
  timeoutMs?: number;
}

export interface BrowserNavigateResult {
  status: 'navigated' | 'redirected' | 'denied' | 'failed';
  finalUrl: string;
  redirectCount: number;
  detail: string | null;
}

export interface BrowserSnapshotOptions {
  /** 限定选择器（可选）；空 = 全页。 */
  selector?: string;
  maxNodes?: number;
}

export interface BrowserSnapshotResult {
  status: 'ok' | 'partial' | 'unavailable';
  url: string;
  nodes: ReadonlyArray<BrowserSnapshotNode>;
  completeness: { reason: string | null; totalObserved: number };
}

export interface BrowserSnapshotNode {
  id: string;
  role: string;
  name: string | null;
  /** 文本内容（已经过脱敏；截断到单字段上限）。 */
  text: string | null;
  isEnabled: boolean | null;
  childrenIds: string[];
}

export interface BrowserTextOptions {
  maxBytes?: number;
}

export interface BrowserTextResult {
  status: 'ok' | 'unavailable';
  url: string;
  text: string;
  byteLength: number;
}

export interface BrowserClickOptions {
  selector: string;
  /** 目标元素索引（同 selector 多匹配时）。 */
  index?: number;
}

export interface BrowserTypeOptions {
  selector: string;
  text: string;
  /** 是否追加（默认 false = 覆盖）。 */
  append?: boolean;
}

export interface BrowserFillOptions {
  selector: string;
  value: string;
}

export interface BrowserActionResult {
  status: 'dispatched' | 'failed_pre' | 'rejected' | 'denied';
  detail: string | null;
}

export interface BrowserHealthInfo {
  state: 'ok' | 'unavailable' | 'no_allowlist';
  detail: string | null;
  allowlistSize: number;
}

/** 域名白名单加载与校验。 */
export function loadBrowserAllowlist(json: string | null | undefined): BrowserAllowlistEntry[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`INVALID_CONFIG: browser-allowlist.json parse failed: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error('INVALID_CONFIG: browser-allowlist.json must be array');
  const out: BrowserAllowlistEntry[] = [];
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
    const schemes = obj.schemes !== undefined
      ? (Array.isArray(obj.schemes) ? obj.schemes.map((s) => String(s).toLowerCase()) : [])
      : ['https'];
    out.push({
      host,
      ...(obj.allowSubdomains === true ? { allowSubdomains: true } : {}),
      ...(schemes.length > 0 ? { schemes } : { schemes: ['https'] }),
    });
  }
  return out;
}

/** 判断 URL 是否在白名单内。 */
export function isUrlAllowed(url: string, allowlist: readonly BrowserAllowlistEntry[]): boolean {
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

/** 审批 hash：写工具 args + 当前页面 URL + 域名。 */
export function browserApprovalHashOf(tool: string, args: JSONValue, currentUrl: string): string {
  const canonical = JSON.stringify({ tool, args, currentUrl });
  return createHash('sha256').update('SKF.browser.approval|1|' + canonical, 'utf8').digest('hex');
}

/** 密钥模式检测（与 M18 同源）。 */
const SECRET_PATTERN = /^(sk-[a-z0-9]{8,}|ghp_[a-z0-9]{16,}|gho_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|password\s*[:=]\s*\S{4,}|token\s*[:=]\s*\S{8,}|secret\s*[:=]\s*\S{8,})/i;

export function validateBrowserInputNotSecret(text: string): { ok: true } | { ok: false; reason: string } {
  if (typeof text !== 'string' || text.length === 0) return { ok: true };
  if (SECRET_PATTERN.test(text)) return { ok: false, reason: 'input looks like a secret/private key/token; use a dedicated auth flow' };
  return { ok: true };
}

/** 浏览器错误码白名单。 */
export const BROWSER_PUBLIC_ERROR_CODES = [
  'BROWSER_DOMAIN_NOT_ALLOWED',
  'BROWSER_REDIRECT_OUT_OF_ALLOWLIST',
  'BROWSER_UNAVAILABLE',
  'BROWSER_NAVIGATION_FAILED',
  'BROWSER_ELEMENT_NOT_FOUND',
  'BROWSER_ELEMENT_NOT_UNIQUE',
  'BROWSER_INPUT_INVALID',
  'BROWSER_SECRET_INPUT_FORBIDDEN',
  'BROWSER_TIMEOUT',
  'BROWSER_ACTION_REJECTED',
  'BROWSER_TOO_MANY_REDIRECTS',
] as const;
export type BrowserPublicErrorCode = (typeof BROWSER_PUBLIC_ERROR_CODES)[number];
