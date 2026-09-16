/**
 * M26 · 真实 Playwright 浏览器桥（RealPlaywrightBridge）
 *
 * 用 playwright + chromium（本地安装）驱动真实浏览器，替换 FakeBrowserBridge。
 *   - 读（navigate/snapshot/text）走 read effect（自动）；写（click/type/fill）走
 *     external_write 审批门（不变，在 ToolRegistry / registry.ts 层）。
 *   - 域名白名单：navigate 前 + 导航后（拦截跨白名单重定向）双检；
 *     不在白名单 = denied → BROWSER_DOMAIN_NOT_ALLOWED。
 *   - BROWSER_SECRET_INPUT_FORBIDDEN：type/fill 文本疑似密钥直接拒绝（与 M18/M19 同源）。
 *   - 重定向上限 MAX_REDIRECTS；超限 BROWSER_TOO_MANY_REDIRECTS。
 *   - 进程管理：浏览器进程由本桥持有，dispose() 关闭（supervisor 退出时收尾）。
 *   - 不可用如实报：playwright/chromium 缺失或启动失败 → health 返回 unavailable，
 *     各方法抛 BROWSER_UNAVAILABLE，绝不假装成功。
 */

import { RuntimeError } from '../runtime/contracts.js';
import {
  MAX_PAGE_TEXT_BYTES,
  MAX_REDIRECTS,
  MAX_SNAPSHOT_NODES,
  MAX_URL_LENGTH,
  isUrlAllowed,
  validateBrowserInputNotSecret,
  type BrowserActionResult,
  type BrowserAllowlistEntry,
  type BrowserBridge,
  type BrowserClickOptions,
  type BrowserFillOptions,
  type BrowserHealthInfo,
  type BrowserNavigateOptions,
  type BrowserNavigateResult,
  type BrowserSnapshotNode,
  type BrowserSnapshotOptions,
  type BrowserSnapshotResult,
  type BrowserTextOptions,
  type BrowserTextResult,
  type BrowserTypeOptions,
} from './contracts.js';

interface PlaywrightTypes {
  chromium: typeof import('playwright').chromium;
}

export interface RealPlaywrightBridgeOptions {
  allowlist: readonly BrowserAllowlistEntry[];
  /** headless 默认 true；测试可覆盖。 */
  headless?: boolean;
  /** 启动超时（ms）。 */
  launchTimeoutMs?: number;
  logger?: (line: string) => void;
}

export class RealPlaywrightBridge implements BrowserBridge {
  private browser: unknown | null = null;
  private page: unknown | null = null;
  private currentUrl: string | null = null;
  private launchError: string | null = null;
  private readonly headless: boolean;
  private readonly launchTimeoutMs: number;
  private readonly logger?: (line: string) => void;

  constructor(private readonly opts: RealPlaywrightBridgeOptions) {
    this.headless = opts.headless ?? true;
    this.launchTimeoutMs = opts.launchTimeoutMs ?? 30_000;
    this.logger = opts.logger;
  }

  private log(line: string): void {
    this.logger?.(line);
  }

  private async ensureBrowser(): Promise<{ browser: unknown; page: unknown }> {
    if (this.browser && this.page) return { browser: this.browser, page: this.page };
    if (this.launchError) throw new RuntimeError('BROWSER_UNAVAILABLE', this.launchError);
    let pw: PlaywrightTypes;
    try {
      pw = await import('playwright');
    } catch (err) {
      this.launchError = 'playwright not installed: ' + (err instanceof Error ? err.message : String(err));
      throw new RuntimeError('BROWSER_UNAVAILABLE', this.launchError);
    }
    try {
      const browser = await pw.chromium.launch({ headless: this.headless, timeout: this.launchTimeoutMs });
      const context = await (browser as { newContext: () => Promise<unknown> }).newContext();
      const page = await (context as { newPage: () => Promise<unknown> }).newPage();
      this.browser = browser;
      this.page = page;
      this.log('browser: chromium launched');
      return { browser, page };
    } catch (err) {
      this.launchError = 'chromium launch failed: ' + (err instanceof Error ? err.message : String(err));
      throw new RuntimeError('BROWSER_UNAVAILABLE', this.launchError);
    }
  }

  /** 关闭浏览器进程树（supervisor 退出收尾用）。 */
  async dispose(): Promise<void> {
    try {
      await (this.browser as { close?: () => Promise<void> } | null)?.close?.();
    } catch { /* 已退出 */ }
    this.browser = null;
    this.page = null;
  }

  /** 当前页面 URL（审批 hash 绑定用）。 */
  getCurrentUrl(): string | null {
    return this.currentUrl;
  }

  async health(): Promise<BrowserHealthInfo> {
    if (this.opts.allowlist.length === 0) {
      return { state: 'no_allowlist', detail: 'browser-allowlist.json empty or missing', allowlistSize: 0 };
    }
    try {
      await this.ensureBrowser();
      return { state: 'ok', detail: null, allowlistSize: this.opts.allowlist.length };
    } catch (err) {
      return { state: 'unavailable', detail: err instanceof Error ? err.message : String(err), allowlistSize: this.opts.allowlist.length };
    }
  }

  async navigate(opts: BrowserNavigateOptions, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted');
    if (opts.url.length > MAX_URL_LENGTH) throw new RuntimeError('BROWSER_INPUT_INVALID', 'url too long');
    if (!isUrlAllowed(opts.url, this.opts.allowlist)) {
      return { status: 'denied', finalUrl: opts.url, redirectCount: 0, detail: 'domain not in allowlist' };
    }
    const { page } = await this.ensureBrowser();
    const p = page as {
      goto: (url: string, o: unknown) => Promise<{ request?: () => unknown; url: () => string }>;
      url: () => string;
    };
    try {
      const response = await p.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 15_000 });
      // 计算重定向次数（沿 request.redirectedFrom 链，调用方法而非取方法引用）。
      let redirectCount = 0;
      let req: { redirectedFrom?: () => unknown } | null = (response?.request?.() ?? null) as { redirectedFrom?: () => unknown } | null;
      while (req && typeof req.redirectedFrom === 'function' && req.redirectedFrom()) {
        redirectCount += 1;
        req = req.redirectedFrom() as { redirectedFrom?: () => unknown } | null;
      }
      if (redirectCount > MAX_REDIRECTS) {
        return { status: 'failed', finalUrl: this.currentUrl ?? opts.url, redirectCount, detail: 'too many redirects' };
      }
      const finalUrl = p.url();
      // 跨白名单重定向阻止（导航后终检）。
      if (!isUrlAllowed(finalUrl, this.opts.allowlist)) {
        return { status: 'denied', finalUrl, redirectCount, detail: 'redirected out of allowlist' };
      }
      this.currentUrl = finalUrl;
      return { status: redirectCount > 0 ? 'redirected' : 'navigated', finalUrl, redirectCount, detail: null };
    } catch (err) {
      return { status: 'failed', finalUrl: opts.url, redirectCount: 0, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  async snapshot(opts: BrowserSnapshotOptions, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted');
    const { page } = await this.ensureBrowser();
    const p = page as { evaluate: (expr: string) => Promise<unknown>; url: () => string };
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    try {
      const expr = `(() => {
        const MAX = ${Math.min(opts.maxNodes ?? MAX_SNAPSHOT_NODES, MAX_SNAPSHOT_NODES)};
        const roleMap = { button:'button', a:'link', input:'textbox', textarea:'textbox', select:'combobox',
          img:'img', h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading',
          ul:'list', ol:'list', li:'listitem', table:'table', nav:'navigation', main:'main',
          form:'form', label:'label', p:'paragraph', span:'generic', div:'generic', section:'generic' };
        const roleOf = (el) => { const r = el.getAttribute && el.getAttribute('role'); if (r) return r;
          const t = (el.tagName||'').toLowerCase(); if (t==='input' && el.type==='checkbox') return 'checkbox';
          if (t==='input' && el.type==='radio') return 'radio'; return roleMap[t] || 'generic'; };
        const nameOf = (el) => { if (el.getAttribute) { const al = el.getAttribute('aria-label'); if (al) return al;
          const alt = el.getAttribute('alt'); if (alt) return alt; } return ''; };
        const textOf = (el) => (el.innerText || el.textContent || '').trim();
        const nodes = []; let counter = 0;
        const walk = (el, parentId) => { if (!el || nodes.length >= MAX) return null;
          const id = 'n-' + (counter++);
          const node = { id, role: roleOf(el), name: nameOf(el), text: null, isEnabled: !el.disabled, childrenIds: [] };
          nodes.push(node);
          const kids = el.children ? Array.from(el.children) : [];
          if (kids.length === 0) { const t = textOf(el); if (t) node.text = t.slice(0,200); }
          for (const child of kids) { const cid = walk(child, id); if (cid) node.childrenIds.push(cid); }
          return id; };
        walk(document.body || document.documentElement, null);
        return nodes;
      })()`;
      const raw = await p.evaluate(expr);
      const axNodes = (raw as Array<Record<string, unknown>>) ?? [];
      const nodes: BrowserSnapshotNode[] = axNodes.map((n) => ({
        id: String(n.id ?? ''),
        role: String(n.role ?? 'generic'),
        name: n.name !== undefined && n.name !== null ? String(n.name) : null,
        text: n.text !== undefined && n.text !== null ? String(n.text) : null,
        isEnabled: n.isEnabled === undefined || n.isEnabled === null ? null : n.isEnabled === true,
        childrenIds: (n.childrenIds as Array<unknown> ?? []).map(String),
      }));
      const truncated = nodes.length >= (opts.maxNodes ?? MAX_SNAPSHOT_NODES);
      return {
        status: truncated ? 'partial' : 'ok',
        url: p.url(),
        nodes,
        completeness: { reason: truncated ? 'max_nodes' : null, totalObserved: nodes.length },
      };
    } catch (err) {
      throw new RuntimeError('BROWSER_UNAVAILABLE', (err instanceof Error ? err.message : String(err)).slice(0, 200));
    }
  }

  async text(opts: BrowserTextOptions, signal?: AbortSignal): Promise<BrowserTextResult> {
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted');
    const { page } = await this.ensureBrowser();
    const p = page as { locator: (sel: string) => { innerText: () => Promise<string> }; url: () => string };
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    try {
      const raw = await p.locator('body').innerText();
      const text = String(raw ?? '');
      const maxBytes = Math.min(opts.maxBytes ?? MAX_PAGE_TEXT_BYTES, MAX_PAGE_TEXT_BYTES);
      const slice = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
      return { status: 'ok', url: p.url(), text: slice, byteLength: Buffer.byteLength(slice, 'utf8') };
    } catch (err) {
      throw new RuntimeError('BROWSER_UNAVAILABLE', (err instanceof Error ? err.message : String(err)).slice(0, 200));
    }
  }

  async click(opts: BrowserClickOptions, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted');
    const { page } = await this.ensureBrowser();
    const p = page as { locator: (sel: string) => { nth: (i: number) => { click: () => Promise<void> } } };
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    if (!opts.selector) throw new RuntimeError('BROWSER_ELEMENT_NOT_FOUND', 'selector required');
    try {
      await p.locator(opts.selector).nth(opts.index ?? 0).click();
      return { status: 'dispatched', detail: null };
    } catch (err) {
      return { status: 'failed_pre', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  async type(opts: BrowserTypeOptions, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted');
    const check = validateBrowserInputNotSecret(opts.text);
    if (!check.ok) throw new RuntimeError('BROWSER_SECRET_INPUT_FORBIDDEN', check.reason);
    const { page } = await this.ensureBrowser();
    const p = page as { locator: (sel: string) => { nth: (i: number) => { fill?: (v: string) => Promise<void>; pressSequentially?: (v: string) => Promise<void> } } };
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    try {
      const target = p.locator(opts.selector).nth(0);
      if (opts.append) {
        await target.pressSequentially?.(opts.text);
      } else {
        await target.fill?.(opts.text);
      }
      return { status: 'dispatched', detail: null };
    } catch (err) {
      return { status: 'failed_pre', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  async fill(opts: BrowserFillOptions, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted');
    const check = validateBrowserInputNotSecret(opts.value);
    if (!check.ok) throw new RuntimeError('BROWSER_SECRET_INPUT_FORBIDDEN', check.reason);
    const { page } = await this.ensureBrowser();
    const p = page as { locator: (sel: string) => { nth: (i: number) => { fill: (v: string) => Promise<void> } } };
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    try {
      await p.locator(opts.selector).nth(0).fill(opts.value);
      return { status: 'dispatched', detail: null };
    } catch (err) {
      return { status: 'failed_pre', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }
}
