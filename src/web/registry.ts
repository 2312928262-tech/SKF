/**
 * M22 · 联网工具装配（web.search / web.fetch → ToolRegistry）
 *
 * 都是 read 工具（读自动）；写操作不在首版范围。
 * web.fetch 域名白名单 + 重定向 + 大小限制。
 */

import { RuntimeError, type JSONValue } from '../runtime/contracts.js';
import type { ToolSpec } from '../tools/registry.js';
import { type WebFetchBridge, type WebSearchBridge } from './contracts.js';

export interface WebToolDeps {
  search: WebSearchBridge;
  fetch: WebFetchBridge;
}

export function buildWebTools(deps: WebToolDeps): ToolSpec[] {
  return [buildSearch(deps), buildFetch(deps)];
}

function buildSearch(deps: WebToolDeps): ToolSpec {
  return {
    name: 'web.search',
    effect: 'read',
    description: 'Search the web and return a bounded list of results. Read effect.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    fields: {
      query: { kind: 'string', required: true, maxLength: 1000 },
      limit: { kind: 'integer', required: false, min: 1, max: 20 },
    },
    run: async (args) => {
      const result = await deps.search.search({ query: String(args.query), ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}) });
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

function buildFetch(deps: WebToolDeps): ToolSpec {
  return {
    name: 'web.fetch',
    effect: 'read',
    description: 'Fetch a URL on the allowlist and extract text content. Read effect; redirects across allowlist are blocked.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: {
        url: { type: 'string', maxLength: 2048 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 262144 },
      },
    },
    fields: {
      url: { kind: 'string', required: true, maxLength: 2048 },
      maxBytes: { kind: 'integer', required: false, min: 1, max: 262144 },
    },
    run: async (args) => {
      const result = await deps.fetch.fetch({ url: String(args.url), ...(args.maxBytes !== undefined ? { maxBytes: Number(args.maxBytes) } : {}) });
      if (result.status === 'denied') throw new RuntimeError('WEB_DOMAIN_NOT_ALLOWED', result.detail ?? '');
      if (result.status === 'failed') throw new RuntimeError('WEB_FETCH_FAILED', result.detail ?? '');
      if (result.status === 'redirected') throw new RuntimeError('WEB_REDIRECT_OUT_OF_ALLOWLIST', result.detail ?? '');
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}
