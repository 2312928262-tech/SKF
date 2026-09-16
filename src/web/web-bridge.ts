/**
 * M22 · 联网桥（RealWebBridge 占位 + FakeWebBridge 测试）
 *
 * 真实实现 = 外部 HTTP（搜索 API + 页面抓取）；首版占位（health=unavailable）。
 * FakeWebBridge：确定性、可控、零网络，覆盖测试。
 */

import { RuntimeError } from '../runtime/contracts.js';
import {
  MAX_FETCH_CONTENT_BYTES,
  MAX_FETCH_URL_LENGTH,
  MAX_REDIRECTS,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULT_BYTES,
  MAX_SEARCH_RESULTS,
  isWebUrlAllowed,
  type WebAllowlistEntry,
  type WebFetchBridge,
  type WebFetchOptions,
  type WebFetchResult,
  type WebHealthInfo,
  type WebSearchBridge,
  type WebSearchItem,
  type WebSearchOptions,
  type WebSearchResult,
} from './contracts.js';

// ── RealWebBridge（占位；首版不发起真实 HTTP）────────────────────────

export class RealWebBridge implements WebSearchBridge, WebFetchBridge {
  constructor(private readonly allowlist: readonly WebAllowlistEntry[] = []) {}

  async health(): Promise<WebHealthInfo> {
    if (this.allowlist.length === 0) return { state: 'no_allowlist', detail: 'web-allowlist.json empty or missing', allowlistSize: 0 };
    return { state: 'unavailable', detail: 'RealWebBridge not enabled (http pending); use FakeWebBridge in test/dev', allowlistSize: this.allowlist.length };
  }

  async search(_opts: WebSearchOptions): Promise<WebSearchResult> {
    throw new RuntimeError('WEB_SEARCH_UNAVAILABLE', 'RealWebBridge.search not implemented in first release');
  }

  async fetch(_opts: WebFetchOptions): Promise<WebFetchResult> {
    throw new RuntimeError('WEB_FETCH_UNAVAILABLE', 'RealWebBridge.fetch not implemented in first release');
  }
}

// ── FakeWebBridge（测试；确定性、可控、零网络）────────────────────────

export class FakeWebBridge implements WebSearchBridge, WebFetchBridge {
  private healthState: WebHealthInfo;
  public readonly stats = { search: 0, fetch: 0 };
  private searchResults: WebSearchItem[] = [];
  private fetchPages: Map<string, { content: string; finalUrl?: string }> = new Map();

  constructor(private readonly allowlist: readonly WebAllowlistEntry[] = []) {
    this.healthState = allowlist.length > 0
      ? { state: 'ok', detail: null, allowlistSize: allowlist.length }
      : { state: 'no_allowlist', detail: 'empty allowlist', allowlistSize: 0 };
  }

  setHealth(state: WebHealthInfo): void {
    (this as unknown as { healthState: WebHealthInfo }).healthState = state;
  }

  setSearchResults(items: WebSearchItem[]): void {
    this.searchResults = items;
  }

  addFetchPage(url: string, content: string): void {
    this.fetchPages.set(url, { content });
  }

  async health(): Promise<WebHealthInfo> {
    return this.healthState;
  }

  async search(opts: WebSearchOptions, signal?: AbortSignal): Promise<WebSearchResult> {
    this.stats.search += 1;
    if (signal?.aborted) throw new RuntimeError('WEB_TIMEOUT', 'aborted before search');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('WEB_TIMEOUT', 'aborted during search');
    if (this.healthState.state !== 'ok') throw new RuntimeError('WEB_SEARCH_UNAVAILABLE', this.healthState.detail ?? '');
    if (opts.query.length > MAX_SEARCH_QUERY_LENGTH) throw new RuntimeError('WEB_INPUT_INVALID', 'query too long');
    const limit = Math.min(opts.limit ?? 10, MAX_SEARCH_RESULTS);
    const results = this.searchResults.slice(0, limit);
    const approx = JSON.stringify({ results }).length;
    if (approx > MAX_SEARCH_RESULT_BYTES) throw new RuntimeError('WEB_RESULT_TOO_LARGE', 'search results too large');
    return { status: 'ok', results, total: results.length };
  }

  async fetch(opts: WebFetchOptions, signal?: AbortSignal): Promise<WebFetchResult> {
    this.stats.fetch += 1;
    if (signal?.aborted) throw new RuntimeError('WEB_TIMEOUT', 'aborted before fetch');
    await Promise.resolve();
    if (signal?.aborted) throw new RuntimeError('WEB_TIMEOUT', 'aborted during fetch');
    if (this.healthState.state === 'no_allowlist') throw new RuntimeError('WEB_DOMAIN_NOT_ALLOWED', this.healthState.detail ?? '');
    if (this.healthState.state !== 'ok') throw new RuntimeError('WEB_FETCH_UNAVAILABLE', this.healthState.detail ?? '');
    if (opts.url.length > MAX_FETCH_URL_LENGTH) throw new RuntimeError('WEB_INPUT_INVALID', 'url too long');
    if (!isWebUrlAllowed(opts.url, this.allowlist)) {
      return { status: 'denied', finalUrl: opts.url, content: '', byteLength: 0, redirectCount: 0, detail: 'domain not in allowlist' };
    }
    const page = this.fetchPages.get(opts.url);
    const content = page?.content ?? '';
    const maxBytes = Math.min(opts.maxBytes ?? MAX_FETCH_CONTENT_BYTES, MAX_FETCH_CONTENT_BYTES);
    const buf = Buffer.from(content, 'utf8');
    const slice = buf.subarray(0, maxBytes).toString('utf8');
    return {
      status: 'ok',
      finalUrl: page?.finalUrl ?? opts.url,
      content: slice,
      byteLength: Buffer.byteLength(slice, 'utf8'),
      redirectCount: 0,
      detail: null,
    };
  }
}
