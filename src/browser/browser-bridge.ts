/**
 * M19 · 浏览器桥（RealPlaywrightBridge 占位 + FakeBrowserBridge 测试）
 *
 * 真实实现 = Playwright CDP 驱动真实 Chrome；首版占位（health 永远 unavailable）。
 * FakeBrowserBridge：确定性、可控、零网络零浏览器，覆盖测试。
 */

import { RuntimeError } from '../runtime/contracts.js';
import {
  MAX_INPUT_TEXT_BYTES,
  MAX_PAGE_TEXT_BYTES,
  MAX_REDIRECTS,
  MAX_SNAPSHOT_BYTES,
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

// ── RealPlaywrightBridge（占位；首版不启动真实 Chrome）──────────────────

export class RealPlaywrightBridge implements BrowserBridge {
  constructor(private readonly allowlist: readonly BrowserAllowlistEntry[] = []) {}

  async health(): Promise<BrowserHealthInfo> {
    if (this.allowlist.length === 0) {
      return { state: 'no_allowlist', detail: 'browser-allowlist.json empty or missing', allowlistSize: 0 };
    }
    return { state: 'unavailable', detail: 'RealPlaywrightBridge not enabled (playwright+chrome pending); use FakeBrowserBridge in test/dev', allowlistSize: this.allowlist.length };
  }

  async navigate(_opts: BrowserNavigateOptions): Promise<BrowserNavigateResult> {
    throw new RuntimeError('BROWSER_UNAVAILABLE', 'RealPlaywrightBridge.navigate not implemented in first release');
  }
  async snapshot(_opts: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> {
    throw new RuntimeError('BROWSER_UNAVAILABLE', 'RealPlaywrightBridge.snapshot not implemented in first release');
  }
  async text(_opts: BrowserTextOptions): Promise<BrowserTextResult> {
    throw new RuntimeError('BROWSER_UNAVAILABLE', 'RealPlaywrightBridge.text not implemented in first release');
  }
  async click(_opts: BrowserClickOptions): Promise<BrowserActionResult> {
    throw new RuntimeError('BROWSER_UNAVAILABLE', 'RealPlaywrightBridge.click not implemented in first release');
  }
  async type(_opts: BrowserTypeOptions): Promise<BrowserActionResult> {
    throw new RuntimeError('BROWSER_UNAVAILABLE', 'RealPlaywrightBridge.type not implemented in first release');
  }
  async fill(_opts: BrowserFillOptions): Promise<BrowserActionResult> {
    throw new RuntimeError('BROWSER_UNAVAILABLE', 'RealPlaywrightBridge.fill not implemented in first release');
  }
}

// ── FakeBrowserBridge（测试；确定性、可控、零副作用）──────────────────

export interface FakePageSpec {
  url: string;
  /** 页面文本。 */
  text?: string;
  /** 可访问性节点树（简化）。 */
  nodes?: FakeNodeSpec[];
}

export interface FakeNodeSpec {
  role: string;
  name?: string;
  text?: string;
  enabled?: boolean;
  children?: FakeNodeSpec[];
}

export class FakeBrowserBridge implements BrowserBridge {
  private pages: Map<string, FakePageSpec> = new Map();
  private currentUrl: string | null = null;
  private healthState: BrowserHealthInfo;
  public readonly stats = { navigate: 0, snapshot: 0, text: 0, click: 0, type: 0, fill: 0 };

  constructor(
    private readonly allowlist: readonly BrowserAllowlistEntry[] = [],
    opts?: { initialPages?: Record<string, FakePageSpec> },
  ) {
    this.healthState = allowlist.length > 0
      ? { state: 'ok', detail: null, allowlistSize: allowlist.length }
      : { state: 'no_allowlist', detail: 'empty allowlist', allowlistSize: 0 };
    if (opts?.initialPages) {
      for (const [url, spec] of Object.entries(opts.initialPages)) this.pages.set(url, spec);
    }
  }

  setHealth(state: BrowserHealthInfo): void {
    (this as unknown as { healthState: BrowserHealthInfo }).healthState = state;
  }

  /** 测试用：注册一个页面。 */
  addPage(url: string, spec: FakePageSpec): void {
    this.pages.set(url, spec);
  }

  /** 测试用：读取当前 URL。 */
  getCurrentUrl(): string | null {
    return this.currentUrl;
  }

  async health(): Promise<BrowserHealthInfo> {
    return this.healthState;
  }

  async navigate(opts: BrowserNavigateOptions, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    this.stats.navigate += 1;
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted before navigate');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted during navigate');
    if (this.healthState.state !== 'ok') {
      throw new RuntimeError(this.healthState.state === 'no_allowlist' ? 'BROWSER_DOMAIN_NOT_ALLOWED' : 'BROWSER_UNAVAILABLE', this.healthState.detail ?? '');
    }
    if (opts.url.length > MAX_URL_LENGTH) throw new RuntimeError('BROWSER_INPUT_INVALID', 'url too long');
    if (!isUrlAllowed(opts.url, this.allowlist)) {
      return { status: 'denied', finalUrl: opts.url, redirectCount: 0, detail: `domain not in allowlist` };
    }
    // 重定向模拟：Fake 桥默认无重定向；测试可注入 redirected 行为（通过 addPage 预置）。
    this.currentUrl = opts.url;
    return { status: 'navigated', finalUrl: opts.url, redirectCount: 0, detail: null };
  }

  async snapshot(opts: BrowserSnapshotOptions, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    this.stats.snapshot += 1;
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted before snapshot');
    if (this.healthState.state !== 'ok') throw new RuntimeError('BROWSER_UNAVAILABLE', this.healthState.detail ?? '');
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    const page = this.pages.get(this.currentUrl);
    const nodes: BrowserSnapshotNode[] = [];
    let counter = 0;
    const maxNodes = Math.min(opts.maxNodes ?? MAX_SNAPSHOT_NODES, MAX_SNAPSHOT_NODES);
    const seed = (spec: FakeNodeSpec | undefined, parentId: string | null): string | null => {
      if (!spec) return null;
      if (nodes.length >= maxNodes) return null;
      const id = `n-${counter++}`;
      const childIds: string[] = [];
      nodes.push({ id, role: spec.role, name: spec.name ?? null, text: spec.text ?? null, isEnabled: spec.enabled ?? null, childrenIds: childIds });
      for (const child of spec.children ?? []) {
        const cid = seed(child, id);
        if (cid) childIds.push(cid);
        if (nodes.length >= maxNodes) break;
      }
      return id;
    };
    if (page?.nodes) for (const n of page.nodes) seed(n, null);
    const approx = JSON.stringify({ nodes }).length;
    const truncated = approx > MAX_SNAPSHOT_BYTES || nodes.length >= maxNodes;
    return {
      status: truncated ? 'partial' : 'ok',
      url: this.currentUrl,
      nodes,
      completeness: { reason: truncated ? 'max_nodes' : null, totalObserved: nodes.length },
    };
  }

  async text(opts: BrowserTextOptions, signal?: AbortSignal): Promise<BrowserTextResult> {
    this.stats.text += 1;
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted before text');
    if (this.healthState.state !== 'ok') throw new RuntimeError('BROWSER_UNAVAILABLE', this.healthState.detail ?? '');
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    const page = this.pages.get(this.currentUrl);
    const text = (page?.text ?? '');
    const maxBytes = Math.min(opts.maxBytes ?? MAX_PAGE_TEXT_BYTES, MAX_PAGE_TEXT_BYTES);
    const buf = Buffer.from(text, 'utf8');
    const slice = buf.subarray(0, maxBytes).toString('utf8');
    return { status: 'ok', url: this.currentUrl, text: slice, byteLength: Buffer.byteLength(slice, 'utf8') };
  }

  async click(opts: BrowserClickOptions, signal?: AbortSignal): Promise<BrowserActionResult> {
    this.stats.click += 1;
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted before click');
    if (this.healthState.state !== 'ok') throw new RuntimeError('BROWSER_UNAVAILABLE', this.healthState.detail ?? '');
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    if (!opts.selector) throw new RuntimeError('BROWSER_ELEMENT_NOT_FOUND', 'selector required');
    return { status: 'dispatched', detail: null };
  }

  async type(opts: BrowserTypeOptions, signal?: AbortSignal): Promise<BrowserActionResult> {
    this.stats.type += 1;
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted before type');
    if (this.healthState.state !== 'ok') throw new RuntimeError('BROWSER_UNAVAILABLE', this.healthState.detail ?? '');
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    const check = validateBrowserInputNotSecret(opts.text);
    if (!check.ok) throw new RuntimeError('BROWSER_SECRET_INPUT_FORBIDDEN', check.reason);
    if (Buffer.byteLength(opts.text, 'utf8') > MAX_INPUT_TEXT_BYTES) throw new RuntimeError('BROWSER_INPUT_INVALID', 'text too long');
    return { status: 'dispatched', detail: null };
  }

  async fill(opts: BrowserFillOptions, signal?: AbortSignal): Promise<BrowserActionResult> {
    this.stats.fill += 1;
    if (signal?.aborted) throw new RuntimeError('BROWSER_TIMEOUT', 'aborted before fill');
    if (this.healthState.state !== 'ok') throw new RuntimeError('BROWSER_UNAVAILABLE', this.healthState.detail ?? '');
    if (!this.currentUrl) throw new RuntimeError('BROWSER_UNAVAILABLE', 'not navigated yet');
    const check = validateBrowserInputNotSecret(opts.value);
    if (!check.ok) throw new RuntimeError('BROWSER_SECRET_INPUT_FORBIDDEN', check.reason);
    return { status: 'dispatched', detail: null };
  }
}
