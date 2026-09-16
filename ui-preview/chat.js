'use strict';

/**
 * 聊天视图：气泡流 + 真实等待态 + 会话绑定 + 历史分页。
 * 等待态依据后端回执/事件：正在提交（已发未回执）→ 正在执行（task.running 事件）；
 * 连接中断显示「状态待核对」，绝不自动重发。模型选择标注「用于下一任务」。
 *
 * M25-ui：新增聊天气泡内工具调用渲染（effect 徽章 + 状态 + 摘要 + 长输出折叠 + 失败错误码）、
 * 内嵌审批卡（hash 全值可复制 + 批准/暂不批准）、批准后同 id 重发 chat resume、
 * 断线状态待核对查询入口。渲染 HTML 复用 window.SKF_TOOLCALLS。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpcV1, rpc2, onSkfEvent } = window.SKF_IPC2;
  const { friendlyError, formatTime, formatMicros } = UI;
  const MD = window.SKF_MARKDOWN;
  const TC = window.SKF_TOOLCALLS || { toolCallRowHtml: () => '', toolCallsBlockHtml: () => '', approvalCardHtml: () => '' };

  const thread = document.getElementById('chat-thread');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('message');
  const send = document.getElementById('send');
  const check = document.getElementById('check');
  const clear = document.getElementById('clear');
  const titleEl = document.getElementById('chat-session-title');
  const scopeEl = document.getElementById('chat-session-scope');
  const countEl = document.getElementById('chat-session-count');

  const busySessions = new Set();
  let nextSeq = null;
  let hasMore = false;
  let currentHistorySession = null;
  let loadingHistory = false;

  // 每轮聊天的内容容器（等待态 + 工具调用 + 审批卡 + 回复 + 元信息），resume 时整块重渲染。
  const turnBlocks = new Map(); // requestId -> HTMLElement

  function lockUI() {
    const s = UI.currentSession();
    const busy = s ? busySessions.has(s.id) : false;
    send.disabled = busy || !UI.state.ready || !s;
    input.disabled = busy || !UI.state.ready || !s;
  }

  function removeEmpty() {
    const el = document.getElementById('chat-empty');
    if (el) el.remove();
  }

  function scrollDown() {
    thread.scrollTop = thread.scrollHeight;
  }

  function appendMsg(role, text, target) {
    const dest = target || thread;
    removeEmpty();
    const box = document.createElement('div');
    box.className = 'msg ' + role;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? '你' : 'SKF';
    const body = document.createElement('div');
    body.className = 'body';
    if (role === 'user') body.textContent = text;
    else body.innerHTML = MD.renderMarkdown(text);
    box.append(who, body);
    dest.appendChild(box);
    scrollDown();
    return box;
  }

  function appendMeta(text, target) {
    const dest = target || thread;
    const line = document.createElement('div');
    line.className = 'msg meta-line';
    line.textContent = text;
    dest.appendChild(line);
    scrollDown();
  }

  // ── 工具调用渲染（M25-ui）──────────────────────────────────────

  function bindToolCallToggles(rootEl) {
    rootEl.querySelectorAll('.tc-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const detail = btn.closest('.tool-call').querySelector('.tc-detail');
        if (!detail) return;
        const willShow = detail.hidden;
        detail.hidden = !willShow;
        btn.textContent = willShow ? '收起' : '展开';
      });
    });
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 复制失败 */ }
    document.body.removeChild(ta);
  }

  function bindCopyButtons(rootEl) {
    rootEl.querySelectorAll('.aci-copy').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const hash = btn.dataset.hash || '';
        try {
          await copyText(hash);
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制'; }, 1500);
        } catch { /* 复制失败保持原样 */ }
      });
    });
  }

  function renderToolCallsBlock(container, toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return;
    const html = TC.toolCallsBlockHtml(toolCalls);
    if (!html) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const block = wrap.firstChild;
    if (block) {
      bindToolCallToggles(block);
      container.appendChild(block);
    }
  }

  /** 失败工具从 events 表补错误码（后端 chat 响应的 toolCalls 不含 code）。
   *  用 latestSeq 探针 + 最新窗口抓该任务最近事件，避开 afterSeq=0 只取最旧事件的陷阱。 */
  async function enrichToolCalls(taskId, toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return toolCalls || [];
    const hasFailed = toolCalls.some((tc) => tc.status === 'failed');
    if (!hasFailed) return toolCalls;
    const codes = new Map();
    try {
      const probe = await rpc2('events.since', { afterSeq: 0, limit: 1 });
      const latestSeq = typeof probe.latestSeq === 'number' ? probe.latestSeq : 0;
      const win = await rpc2('events.since', { afterSeq: Math.max(0, latestSeq - 1000), limit: 1000, taskId });
      for (const ev of win.events || []) {
        if (ev.type === 'task.tool') {
          const p = ev.safePayload || {};
          if (p.callId && p.code) codes.set(p.callId, p.code);
        }
      }
    } catch { /* 富化失败不阻塞渲染 */ }
    return toolCalls.map((tc) => (tc.status === 'failed' && codes.get(tc.callId) ? { ...tc, code: codes.get(tc.callId) } : tc));
  }

  function renderApprovalCardInline(container, pa, session, requestId, message) {
    if (!pa) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = TC.approvalCardHtml(pa, { sessionName: session ? session.name : '', taskId: requestId });
    const card = wrap.firstChild;
    if (!card) return;
    bindCopyButtons(card);
    const approve = card.querySelector('.aci-approve');
    const defer = card.querySelector('.aci-defer');
    const hint = card.querySelector('.aci-hint');
    let decided = false;
    approve.addEventListener('click', async () => {
      if (decided) return;
      decided = true;
      approve.disabled = true;
      defer.disabled = true;
      hint.textContent = '批准提交中…';
      try {
        await rpc2('task.approve', { approvalId: pa.approvalId, inputHash: pa.inputHash, decision: 'approved' });
        hint.textContent = '已批准，正在继续执行…';
        busySessions.add(session.id);
        lockUI();
        await runTurn(session, requestId, message);
        busySessions.delete(session.id);
        lockUI();
        input.focus();
      } catch (error) {
        decided = false;
        approve.disabled = false;
        defer.disabled = false;
        const fe = friendlyError(error);
        hint.textContent = '批准失败：' + fe.text + '（' + fe.next + '）';
      }
    });
    defer.addEventListener('click', () => {
      if (decided) return;
      defer.disabled = true;
      defer.textContent = '已搁置';
      hint.textContent = '已搁置（未发送拒绝，任务保持待审批）。稍后可在审批中心继续处理。';
    });
    container.appendChild(card);
    return card;
  }

  // ── 真实等待态（每轮）──────────────────────────────────────────

  function turnContainer(requestId) {
    let block = turnBlocks.get(requestId);
    if (!block) {
      block = document.createElement('div');
      block.className = 'turn-block';
      thread.appendChild(block);
      turnBlocks.set(requestId, block);
    }
    return block;
  }

  function beginLiveTurn(container) {
    const waitBox = document.createElement('div');
    waitBox.className = 'msg bot waiting';
    waitBox.textContent = '正在提交…';
    container.appendChild(waitBox);
    const liveTools = document.createElement('div');
    liveTools.className = 'toolblock live-tools';
    container.appendChild(liveTools);
    scrollDown();
    return {
      update(text) {
        waitBox.textContent = text;
        scrollDown();
      },
      addToolCall(tc) {
        const html = TC.toolCallRowHtml(tc);
        if (!html) return;
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        const row = wrap.firstChild;
        if (row) {
          bindToolCallToggles(row);
          liveTools.appendChild(row);
        }
        scrollDown();
      },
    };
  }

  async function runTurn(session, requestId, message) {
    const block = turnContainer(requestId);
    block.innerHTML = '';
    const live = beginLiveTurn(block);

    const off = onSkfEvent((event) => {
      if (!event || event.taskId !== requestId) return;
      if (event.type === 'task.running') {
        live.update('正在执行…');
      } else if (event.type === 'task.model_step') {
        const p = event.safePayload || {};
        live.update(typeof p.toolCalls === 'number' && p.toolCalls > 0 ? `正在执行…（请求 ${p.toolCalls} 个工具）` : '正在执行…（模型已返回）');
      } else if (event.type === 'task.tool') {
        const p = event.safePayload || {};
        live.addToolCall({ tool: p.tool, effect: p.effect, status: p.ok ? 'ok' : 'failed', summary: p.summary, code: p.code });
      } else if (event.type === 'task.approval_requested') {
        const p = event.safePayload || {};
        live.update('等待你的审批');
        live.addToolCall({ tool: p.tool, effect: p.effect, status: 'approval_pending', summary: p.summary });
      }
    });

    try {
      const result = await rpcV1('chat', { message, sessionId: session.id }, requestId);
      off();
      block.innerHTML = '';
      await renderTurnResult(block, result, session, requestId, message);
    } catch (error) {
      off();
      block.innerHTML = '';
      appendErrorTo(block, error, isDisconnectError(error) ? 'disconnect' : 'error', requestId);
    }
  }

  async function renderTurnResult(container, result, session, requestId, message) {
    const toolCalls = await enrichToolCalls(requestId, result.toolCalls);
    if (result.state === 'waiting_approval') {
      // 待审批的工具也进工具列表（状态「待审批」）；审批卡内嵌在下方。
      const all = Array.isArray(toolCalls) ? [...toolCalls] : [];
      if (result.pendingApproval) {
        all.push({ tool: result.pendingApproval.tool, effect: result.pendingApproval.effect, status: 'approval_pending', summary: '' });
      }
      renderToolCallsBlock(container, all);
      renderApprovalCardInline(container, result.pendingApproval, session, requestId, message);
      scrollDown();
      return;
    }
    renderToolCallsBlock(container, toolCalls);
    appendMsg('bot', result.text || '（模型返回了空内容）', container);
    const usage = result.usage;
    const counts = usage ? ` · 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} token` : '';
    const estimate = usage && usage.costSource === 'configured-estimate'
      ? ` · 估算 ${formatMicros(Math.round(usage.cost * 1_000_000))}`
      : '';
    appendMeta(`${result.model || result.provider || ''}${counts}${estimate}${result.memoryWarning ? ' · 记忆写回待补' : ''}`, container);
    scrollDown();
  }

  function appendErrorTo(container, error, kind, requestId) {
    const fe = friendlyError(error);
    const box = document.createElement('div');
    box.className = 'msg bot';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'SKF';
    const body = document.createElement('div');
    body.className = 'body';
    const err = document.createElement('div');
    if (kind === 'disconnect') {
      err.className = 'error-box unknown';
      const main = document.createElement('div');
      main.textContent = '状态待核对：连接中断，结果未知。';
      const next = document.createElement('div');
      next.className = 'next';
      next.textContent = '不会自动重发，以免重复任务。';
      const query = document.createElement('button');
      query.className = 'small';
      query.textContent = '查询任务状态';
      query.addEventListener('click', () => queryTaskStatus(requestId, err));
      err.append(main, next, query);
    } else {
      err.className = 'error-box';
      const main = document.createElement('div');
      main.textContent = fe.text;
      const next = document.createElement('div');
      next.className = 'next';
      next.textContent = '下一步：' + fe.next;
      err.append(main, next);
    }
    body.appendChild(err);
    box.append(who, body);
    container.appendChild(box);
    scrollDown();
  }

  async function queryTaskStatus(taskId, errEl) {
    const out = document.createElement('div');
    out.className = 'query-result';
    out.textContent = '查询中…';
    errEl.appendChild(out);
    try {
      const detail = await rpc2('task.get', { taskId });
      out.innerHTML = '';
      const state = detail.task.state;
      const badge = document.createElement('span');
      badge.className = 'badge st-' + state;
      badge.textContent = UI.TASK_STATE_TEXT[state] || state;
      out.appendChild(badge);
      if (state === 'succeeded') {
        out.appendChild(document.createTextNode(' · 已完成'));
        if (detail.finalText) {
          const t = document.createElement('div');
          t.className = 'query-final';
          t.innerHTML = MD.renderMarkdown(detail.finalText);
          out.appendChild(t);
        }
      } else if (state === 'waiting_approval') {
        out.appendChild(document.createTextNode(' · 有一个操作等你审批（可在审批中心处理）'));
      } else if (state === 'failed') {
        out.appendChild(document.createTextNode(' · ' + friendlyError(detail.task.errorCode).text));
      } else if (state === 'interrupted') {
        out.appendChild(document.createTextNode(' · 已中断，未自动重试（可在任务页恢复）'));
      } else {
        out.appendChild(document.createTextNode(' · 当前状态：' + (UI.TASK_STATE_TEXT[state] || state)));
      }
    } catch (e) {
      out.textContent = '查询失败：' + friendlyError(e).text;
    }
  }

  function renderHeader() {
    const s = UI.currentSession();
    if (!s) {
      titleEl.textContent = '（无会话）';
      scopeEl.textContent = 'scope: —';
      countEl.textContent = '';
      return;
    }
    titleEl.textContent = s.name + (s.archived ? '（已归档）' : '');
    scopeEl.textContent = 'scope: ' + s.scope;
    scopeEl.title = s.scope;
    countEl.textContent = s.archived ? '已归档：只读' : '';
  }

  async function loadHistory(sessionId, older) {
    if (loadingHistory) return;
    loadingHistory = true;
    try {
      const page = await rpc2('session.history', {
        sessionId,
        limit: 30,
        ...(older && nextSeq ? { afterSeq: nextSeq } : {}),
      });
      nextSeq = page.nextSeq;
      hasMore = page.hasMore;
      if (!older) {
        thread.innerHTML = '';
        if (!page.entries.length) {
          thread.innerHTML = '<div id="chat-empty">这个会话还没有消息。输入内容开始对话。</div>';
        }
      }
      if (older) {
        removeLoadOlder();
        for (const entry of [...page.entries].reverse()) renderEntry(entry, true);
      } else {
        for (const entry of page.entries) renderEntry(entry, false);
      }
      if (hasMore) renderLoadOlder();
      if (!older) scrollDown();
    } catch (error) {
      /* 历史读取失败不阻塞聊天 */
      if (!older && !thread.querySelector('.msg')) {
        thread.innerHTML = '<div id="chat-empty">历史暂时读不到，仍可继续对话。</div>';
      }
    } finally {
      loadingHistory = false;
    }
  }

  function renderEntry(entry, prepend) {
    const box = document.createElement('div');
    box.className = 'msg user';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = '你';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = entry.message;
    box.append(who, body);
    insert(box, prepend);

    if (entry.text) {
      appendEntryMsg('bot', entry.text, prepend);
    } else if (entry.errorCode) {
      const errBox = document.createElement('div');
      errBox.className = 'msg bot';
      const ewho = document.createElement('div');
      ewho.className = 'who';
      ewho.textContent = 'SKF';
      const ebody = document.createElement('div');
      ebody.className = 'body';
      const fe = friendlyError({ message: entry.errorCode });
      const err = document.createElement('div');
      err.className = 'error-box';
      const main = document.createElement('div');
      main.textContent = fe.text;
      err.appendChild(main);
      ebody.appendChild(err);
      errBox.append(ewho, ebody);
      insert(errBox, prepend);
    }
    const metaBits = [entry.model || entry.provider || '', formatTime(entry.createdAt)].filter(Boolean);
    if (entry.memoryOutboxPending) metaBits.push('记忆写回待补');
    if (metaBits.length) {
      const meta = document.createElement('div');
      meta.className = 'msg meta-line';
      meta.textContent = metaBits.join(' · ');
      insert(meta, prepend);
    }
  }

  function appendEntryMsg(role, text, prepend) {
    const box = document.createElement('div');
    box.className = 'msg ' + role;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? '你' : 'SKF';
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = MD.renderMarkdown(text);
    box.append(who, body);
    insert(box, prepend);
    return box;
  }

  function insert(node, prepend) {
    if (prepend) thread.insertBefore(node, thread.firstChild);
    else thread.appendChild(node);
  }

  function renderLoadOlder() {
    const btn = document.createElement('button');
    btn.id = 'load-older';
    btn.className = 'small ghost';
    btn.style.alignSelf = 'center';
    btn.textContent = '加载更早消息';
    btn.addEventListener('click', async () => {
      const s = UI.currentSession();
      if (s) await loadHistory(s.id, true);
    });
    thread.insertBefore(btn, thread.firstChild);
  }

  function removeLoadOlder() {
    const btn = document.getElementById('load-older');
    if (btn) btn.remove();
  }

  function isDisconnectError(error) {
    const code = String(error && error.message ? error.message : error || '');
    return ['TAURI_BRIDGE_MISSING', 'PROTOCOL_MISMATCH', 'PROTOCOL_VERSION_UNSUPPORTED', 'IPC_V2_UNAVAILABLE'].includes(code);
  }

  async function chat(text) {
    const s = UI.currentSession();
    if (!s || busySessions.has(s.id) || !UI.state.ready) return;
    busySessions.add(s.id);
    lockUI();
    appendMsg('user', text);
    input.value = '';
    const requestId = crypto.randomUUID();
    UI.registerTaskSession(requestId, s.id);
    try {
      await runTurn(s, requestId, text);
    } finally {
      busySessions.delete(s.id);
      lockUI();
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    chat(text);
  });

  input.addEventListener('keydown', (e) => {
    const sendOnEnter = document.getElementById('pref-enter-send')?.checked !== false;
    if (e.key === 'Enter' && !e.shiftKey && sendOnEnter) {
      e.preventDefault();
      const text = input.value.trim();
      if (text) chat(text);
    }
  });

  check.addEventListener('click', () => UI.health().then(() => lockUI()));
  clear.addEventListener('click', () => {
    thread.innerHTML = '<div id="chat-empty">对话会在此显示。Enter 发送，Shift+Enter 换行。</div>';
    nextSeq = null;
    hasMore = false;
    turnBlocks.clear();
  });

  document.addEventListener('skf:session-switched', (e) => {
    const id = e.detail && e.detail.sessionId;
    renderHeader();
    lockUI();
    if (id && id !== currentHistorySession) {
      currentHistorySession = id;
      nextSeq = null;
      hasMore = false;
      turnBlocks.clear();
      loadHistory(id, false).catch(() => {});
    }
  });

  document.addEventListener('skf:sessions', () => {
    renderHeader();
    lockUI();
  });

  window.SKF_VIEWS.chat = {
    async init() {
      renderHeader();
      lockUI();
      const s = UI.currentSession();
      if (s) {
        currentHistorySession = s.id;
        await loadHistory(s.id, false).catch(() => {});
      }
    },
    onShow() {
      const s = UI.currentSession();
      if (s && s.id !== currentHistorySession) {
        currentHistorySession = s.id;
        nextSeq = null;
        hasMore = false;
        loadHistory(s.id, false).catch(() => {});
      }
      renderHeader();
      lockUI();
    },
  };
})();
