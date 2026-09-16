'use strict';

/**
 * M25-ui · 聊天工具调用与审批卡片渲染（共享组件，防注入）。
 *
 * 只返回 HTML 字符串；chat.js 注入后负责绑定折叠/复制/批准事件。
 * 纯函数，浏览器（window.SKF_TOOLCALLS）与 Node（module.exports）双端可用。
 *
 * - effect 徽章配色：read=灰蓝、workspace_write=蓝、external_write=橙、process=红
 * - 状态：ok=成功 / failed=失败 / approval_pending=待审批 / running=执行中
 * - 长摘要折叠展开；失败可展开看错误码。
 * - 审批卡：参数 hash 全值等宽可复制 + 批准/暂不批准按钮。
 *
 * 安全：所有动态内容（工具名/摘要/错误码/hash）先 HTML 实体转义再进输出，
 * 与 markdown.js 同一防注入模型；后端只给脱敏摘要 + 权威 hash，UI 不重构参数。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SKF_TOOLCALLS = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function () {
  // effect 徽章配色（语义 token 不直接反转颜色；色值见 index.html .fx-*）
  const EFFECTS = {
    read: { label: '读取', risk: '低风险（只读）', cls: 'fx-read' },
    workspace_write: { label: '工作区写入', risk: '中风险（工作区内写入）', cls: 'fx-workspace' },
    external_write: { label: '外部写入', risk: '高风险（外部写入）', cls: 'fx-external' },
    process: { label: '进程执行', risk: '高风险（进程执行）', cls: 'fx-process' },
  };
  const STATUS = {
    ok: { label: '成功', cls: 'ok' },
    failed: { label: '失败', cls: 'failed' },
    approval_pending: { label: '待审批', cls: 'pending' },
    running: { label: '执行中', cls: 'running' },
  };

  const SUMMARY_FOLD_LEN = 100;

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function effectOf(effect) {
    return EFFECTS[effect] || { label: effect || '读取', risk: '', cls: 'fx-read' };
  }
  function statusOf(status) {
    return STATUS[status] || { label: status || '—', cls: '' };
  }

  /**
   * 单条工具调用行（HTML 字符串）。
   * tc: { tool, effect, status, summary, code? }（code 仅失败时由 events 富化而来）。
   */
  function toolCallRowHtml(tc) {
    const e = effectOf(tc.effect);
    const st = statusOf(tc.status);
    const tool = escapeHtml(tc.tool || '（未知工具）');
    const summary = String(tc.summary || '');
    const code = String(tc.code || '');
    const longSummary = summary.length > SUMMARY_FOLD_LEN;
    const hasDetail = longSummary || (tc.status === 'failed' && !!code);

    const parts = [];
    parts.push('<div class="tool-call" data-status="' + escapeHtml(tc.status || '') + '">');
    parts.push('  <div class="tc-head">');
    parts.push('    <span class="tc-tool">' + tool + '</span>');
    parts.push('    <span class="fx ' + e.cls + '" title="' + escapeHtml(e.risk) + '">' + escapeHtml(e.label) + '</span>');
    parts.push('    <span class="tc-status ' + st.cls + '">' + escapeHtml(st.label) + '</span>');
    if (hasDetail) {
      parts.push('    <button type="button" class="small ghost tc-toggle">展开</button>');
    }
    parts.push('  </div>');
    if (summary) {
      parts.push('  <div class="tc-summary">' + escapeHtml(longSummary ? summary.slice(0, SUMMARY_FOLD_LEN) + '…' : summary) + '</div>');
    }
    if (hasDetail) {
      parts.push('  <div class="tc-detail" hidden>');
      if (longSummary) parts.push('    <div class="tc-summary-full">' + escapeHtml(summary) + '</div>');
      if (tc.status === 'failed' && code) {
        parts.push('    <div class="tc-code-line"><span class="tc-code-label">错误码</span> <code class="tc-code">' + escapeHtml(code) + '</code></div>');
      }
      parts.push('  </div>');
    }
    parts.push('</div>');
    return parts.join('\n');
  }

  /** 工具调用块（HTML 字符串）；空数组返回空串。 */
  function toolCallsBlockHtml(toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return '';
    const rows = toolCalls.map(toolCallRowHtml).join('\n');
    return '<div class="toolblock"><div class="toolblock-head">工具调用</div>' + rows + '</div>';
  }

  /**
   * 内嵌审批卡（HTML 字符串）。
   * pa: { approvalId, inputHash, tool, effect, summary? }
   * opts: { sessionName?, taskId? }
   */
  function approvalCardHtml(pa, opts = {}) {
    const e = effectOf(pa.effect);
    const tool = escapeHtml(pa.tool || '（待确认工具）');
    const summary = String(pa.summary || '');
    const hash = escapeHtml(pa.inputHash || '');
    const sessionName = escapeHtml(opts.sessionName || '');
    const taskId = escapeHtml(opts.taskId || '');
    const parts = [];
    parts.push('<div class="approval-card-inline">');
    parts.push('  <div class="aci-head">');
    parts.push('    <span class="fx ' + e.cls + '">' + escapeHtml(e.label) + '</span>');
    parts.push('    <span class="aci-title">等待你的审批</span>');
    parts.push('  </div>');
    parts.push('  <div class="aci-meta">' + escapeHtml(e.risk) + ' · 工具 <span class="aci-tool">' + tool + '</span></div>');
    if (summary && summary !== pa.tool) {
      parts.push('  <div class="aci-summary"><span class="aci-k">操作摘要（脱敏）</span>' + escapeHtml(summary) + '</div>');
    }
    parts.push('  <div class="aci-hash">');
    parts.push('    <span class="aci-k">参数 hash（全值）</span>');
    parts.push('    <code class="aci-hash-code">' + hash + '</code>');
    parts.push('    <button type="button" class="small ghost aci-copy" data-hash="' + hash + '">复制</button>');
    parts.push('  </div>');
    if (sessionName || taskId) {
      parts.push('  <div class="aci-context">' + (sessionName ? '会话 ' + sessionName : '') + (taskId ? (sessionName ? ' · ' : '') + '任务 ' + taskId : '') + '</div>');
    }
    parts.push('  <div class="aci-actions">');
    parts.push('    <button type="button" class="primary aci-approve">批准本次操作</button>');
    parts.push('    <button type="button" class="aci-defer">暂不批准</button>');
    parts.push('  </div>');
    parts.push('  <div class="aci-hint">批准绑定此 hash；参数变化、过期或状态变化后旧批准自动失效。暂不批准不发送拒绝，不等于取消任务。</div>');
    parts.push('</div>');
    return parts.join('\n');
  }

  return { EFFECTS, STATUS, escapeHtml, effectOf, statusOf, toolCallRowHtml, toolCallsBlockHtml, approvalCardHtml };
});
