/**
 * M19 · 浏览器工具装配（browser.* 六个 ToolSpec → ToolRegistry）
 *
 * 读工具（navigate/snapshot/text）走 read effect（默认任务授权可调用）；
 * 写工具（click/type/fill）走 external_write，须 hasApproved(inputHash)。
 * 审批 hash = browserApprovalHashOf(tool, args, currentUrl)；写工具当前页面 URL 变化 ⇒ 旧审批失效。
 */

import { RuntimeError, type Effect, type JSONValue } from '../runtime/contracts.js';
import type { ToolSpec } from '../tools/registry.js';
import { BROWSER_TOOL_EFFECT, browserApprovalHashOf, type BrowserBridge } from './contracts.js';

export interface BrowserToolDeps {
  bridge: BrowserBridge;
  /** 当前页面 URL 解析器（Fake 桥测试可读；Real 桥从 bridge 取）。 */
  currentUrl: () => string | null;
}

export function buildBrowserTools(deps: BrowserToolDeps): ToolSpec[] {
  return [
    buildNavigate(deps),
    buildSnapshot(deps),
    buildText(deps),
    buildClick(deps),
    buildType(deps),
    buildFill(deps),
  ];
}

function buildNavigate(deps: BrowserToolDeps): ToolSpec {
  return {
    name: 'browser.navigate',
    effect: 'read',
    description: 'Navigate to a URL on the allowlist. Read effect; redirects across allowlist are blocked.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: { url: { type: 'string', maxLength: 2048 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 } },
    },
    fields: {
      url: { kind: 'string', required: true, maxLength: 2048 },
      timeoutMs: { kind: 'integer', required: false, min: 100, max: 60000 },
    },
    run: async (args) => {
      const result = await deps.bridge.navigate({ url: String(args.url), ...(args.timeoutMs !== undefined ? { timeoutMs: Number(args.timeoutMs) } : {}) });
      if (result.status === 'denied') throw new RuntimeError('BROWSER_DOMAIN_NOT_ALLOWED', result.detail ?? '');
      if (result.status === 'failed') throw new RuntimeError('BROWSER_NAVIGATION_FAILED', result.detail ?? '');
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

function buildSnapshot(deps: BrowserToolDeps): ToolSpec {
  return {
    name: 'browser.snapshot',
    effect: 'read',
    description: 'Read an accessibility snapshot of the current page.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { selector: { type: 'string', maxLength: 512 }, maxNodes: { type: 'integer', minimum: 1, maximum: 500 } },
    },
    fields: {
      selector: { kind: 'string', required: false, maxLength: 512 },
      maxNodes: { kind: 'integer', required: false, min: 1, max: 500 },
    },
    run: async (args) => {
      const result = await deps.bridge.snapshot({ ...(args.selector !== undefined ? { selector: String(args.selector) } : {}), ...(args.maxNodes !== undefined ? { maxNodes: Number(args.maxNodes) } : {}) });
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

function buildText(deps: BrowserToolDeps): ToolSpec {
  return {
    name: 'browser.text',
    effect: 'read',
    description: 'Extract the text content of the current page.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { maxBytes: { type: 'integer', minimum: 1, maximum: 65536 } },
    },
    fields: { maxBytes: { kind: 'integer', required: false, min: 1, max: 65536 } },
    run: async (args) => {
      const result = await deps.bridge.text({ ...(args.maxBytes !== undefined ? { maxBytes: Number(args.maxBytes) } : {}) });
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

function buildClick(deps: BrowserToolDeps): ToolSpec {
  return {
    name: 'browser.click',
    effect: 'external_write',
    description: 'Click an element on the current page. Side effect; requires approval bound to selector + current URL.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['selector'],
      properties: { selector: { type: 'string', maxLength: 512 }, index: { type: 'integer', minimum: 0, maximum: 64 } },
    },
    fields: {
      selector: { kind: 'string', required: true, maxLength: 512 },
      index: { kind: 'integer', required: false, min: 0, max: 64 },
    },
    approvalInputHash: (validated) => browserApprovalHashOf('browser.click', validated as unknown as JSONValue, deps.currentUrl() ?? ''),
    run: async (args) => {
      const result = await deps.bridge.click({ selector: String(args.selector), ...(args.index !== undefined ? { index: Number(args.index) } : {}) });
      if (result.status === 'denied') throw new RuntimeError('BROWSER_ACTION_REJECTED', result.detail ?? '');
      if (result.status === 'failed_pre') throw new RuntimeError('BROWSER_ELEMENT_NOT_FOUND', result.detail ?? '');
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

function buildType(deps: BrowserToolDeps): ToolSpec {
  return {
    name: 'browser.type',
    effect: 'external_write',
    description: 'Type text into an element on the current page. Side effect; requires approval; secret-like input is rejected.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['selector', 'text'],
      properties: { selector: { type: 'string', maxLength: 512 }, text: { type: 'string', maxLength: 65536 }, append: { type: 'boolean' } },
    },
    fields: {
      selector: { kind: 'string', required: true, maxLength: 512 },
      text: { kind: 'string', required: true, maxLength: 65536 },
      append: { kind: 'boolean', required: false },
    },
    approvalInputHash: (validated) => browserApprovalHashOf('browser.type', validated as unknown as JSONValue, deps.currentUrl() ?? ''),
    run: async (args) => {
      const result = await deps.bridge.type({ selector: String(args.selector), text: String(args.text), ...(args.append !== undefined ? { append: args.append === true } : {}) });
      if (result.status === 'denied') throw new RuntimeError('BROWSER_ACTION_REJECTED', result.detail ?? '');
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}

function buildFill(deps: BrowserToolDeps): ToolSpec {
  return {
    name: 'browser.fill',
    effect: 'external_write',
    description: 'Fill a form field on the current page. Side effect; requires approval; secret-like value is rejected.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['selector', 'value'],
      properties: { selector: { type: 'string', maxLength: 512 }, value: { type: 'string', maxLength: 65536 } },
    },
    fields: {
      selector: { kind: 'string', required: true, maxLength: 512 },
      value: { kind: 'string', required: true, maxLength: 65536 },
    },
    approvalInputHash: (validated) => browserApprovalHashOf('browser.fill', validated as unknown as JSONValue, deps.currentUrl() ?? ''),
    run: async (args) => {
      const result = await deps.bridge.fill({ selector: String(args.selector), value: String(args.value) });
      if (result.status === 'denied') throw new RuntimeError('BROWSER_ACTION_REJECTED', result.detail ?? '');
      return { content: result as unknown as JSONValue, artifactIds: [] };
    },
  };
}
