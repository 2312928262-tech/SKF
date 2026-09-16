'use strict';

/**
 * 会话列表：多会话入口。名称 + 摘要 + 时间 + 未读 + 运行/归档标记；
 * 新建 / 切换 / 重命名 / 归档 / 恢复；独立历史与 scope 由后端保证。
 * 归档只改可见性，不删历史、不取消任务。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2, onSkfEvent } = window.SKF_IPC2;
  const { friendlyError, formatTime } = UI;

  const listEl = document.getElementById('session-list');
  const searchInput = document.getElementById('session-search');
  const newBtn = document.getElementById('session-new');
  const renameBtn = document.getElementById('session-rename');
  const archiveBtn = document.getElementById('session-archive');
  const restoreBtn = document.getElementById('session-restore');
  const showArchivedBtn = document.getElementById('session-show-archived');

  const summaries = new Map(); // sessionId -> 最后一条消息摘要
  const unread = new Map(); // sessionId -> number
  const taskSession = new Map(); // taskId -> sessionId
  let query = '';
  let loading = false;
  let archivedSelection = null; // 已归档视图中选中的待恢复会话

  // ── 任务→会话注册（供事件中心判断未读归属）──
  UI.registerTaskSession = (taskId, sessionId) => {
    if (taskId && sessionId) taskSession.set(taskId, sessionId);
  };

  onSkfEvent((event) => {
    if (!event || typeof event.taskId !== 'string') return;
    if (event.type === 'task.succeeded' || event.type === 'task.failed' || event.type === 'task.cancelled') {
      const sid = taskSession.get(event.taskId);
      if (sid && sid !== UI.state.currentSessionId) {
        unread.set(sid, (unread.get(sid) || 0) + 1);
        render();
      }
    }
  });

  function visibleSessions() {
    let list = UI.state.sessions.filter((s) => s.archived === UI.state.showArchived);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q) || s.scope.toLowerCase().includes(q));
    }
    return list;
  }

  function render() {
    const sessions = visibleSessions();
    listEl.innerHTML = '';
    if (!sessions.length) {
      listEl.innerHTML = `<div class="empty-block">${UI.state.showArchived ? '没有已归档会话。' : '没有会话，点上方 ＋ 新建一个。'}</div>`;
      return;
    }
    for (const s of sessions) {
      listEl.appendChild(renderItem(s));
    }
    renderSessionActions();
  }

  function renderItem(s) {
    const item = document.createElement('button');
    item.className = 'session-item' + (s.id === UI.state.currentSessionId ? ' active' : '') + (s.archived ? ' archived' : '') + (UI.state.showArchived && s.id === archivedSelection ? ' active' : '');
    item.type = 'button';

    const name = document.createElement('div');
    name.className = 's-name';
    const title = document.createElement('span');
    title.className = 's-title';
    title.textContent = s.name;
    name.appendChild(title);
    if (s.archived) {
      const tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = '已归档';
      name.appendChild(tag);
    }

    const summary = document.createElement('div');
    summary.className = 's-summary';
    summary.textContent = summaries.get(s.id) || '（暂无消息）';

    const meta = document.createElement('div');
    meta.className = 's-meta';
    const u = unread.get(s.id) || 0;
    if (u > 0) {
      const ub = document.createElement('span');
      ub.className = 'unread';
      ub.textContent = String(u);
      meta.appendChild(ub);
    }
    meta.appendChild(document.createTextNode(formatTime(s.lastMessageAt || s.createdAt) || '—'));

    item.append(name, summary, meta);
    item.addEventListener('click', () => {
      if (UI.state.showArchived) {
        archivedSelection = s.id;
        render();
        return; // 已归档视图：选中待恢复，不切换
      }
      unread.set(s.id, 0);
      UI.switchSession(s.id);
      render();
    });
    return item;
  }

  function renderSessionActions() {
    const s = UI.currentSession();
    const archivedView = UI.state.showArchived;
    renameBtn.hidden = archivedView || !s;
    archiveBtn.hidden = archivedView || !s;
    restoreBtn.hidden = !archivedView || !archivedSelection;
    if (s) {
      renameBtn.textContent = '重命名';
      archiveBtn.textContent = '归档';
      restoreBtn.textContent = '恢复';
    }
  }

  async function reload() {
    if (loading) return;
    loading = true;
    try {
      await UI.refreshSessions();
      render();
      await loadSummaries();
    } finally {
      loading = false;
    }
  }

  async function loadSummaries() {
    const sessions = visibleSessions();
    for (const s of sessions) {
      if (summaries.has(s.id)) continue;
      try {
        const page = await rpc2('session.history', { sessionId: s.id, limit: 1 });
        const last = (page.entries || [])[page.entries.length - 1];
        if (last) summaries.set(s.id, last.message ? last.message.slice(0, 60) : `回复 ${last.text ? last.text.length : 0} 字`);
        render();
      } catch {
        /* 单会话摘要失败不阻塞 */
      }
    }
  }

  // ── 新建 ──
  newBtn.addEventListener('click', async () => {
    const name = prompt('新会话名称：', '新会话 ' + new Date().toLocaleDateString());
    if (name === null) return;
    const clean = name.trim();
    if (!clean) return;
    newBtn.disabled = true;
    try {
      const result = await rpc2('session.create', { name: clean });
      UI.state.showArchived = false;
      showArchivedBtn.textContent = '已归档';
      await reload();
      UI.switchSession(result.session.id);
      render();
    } catch (error) {
      const fe = friendlyError(error);
      alert(fe.text + '\n' + fe.next);
    } finally {
      newBtn.disabled = false;
    }
  });

  // ── 重命名 ──
  renameBtn.addEventListener('click', async () => {
    const s = UI.currentSession();
    if (!s) return;
    const name = prompt('重命名会话：', s.name);
    if (name === null) return;
    const clean = name.trim();
    if (!clean || clean === s.name) return;
    renameBtn.disabled = true;
    try {
      await rpc2('session.rename', { id: s.id, name: clean });
      await reload();
    } catch (error) {
      const fe = friendlyError(error);
      alert(fe.text + '\n' + fe.next);
    } finally {
      renameBtn.disabled = false;
    }
  });

  // ── 归档 / 恢复 ──
  archiveBtn.addEventListener('click', async () => {
    const s = UI.currentSession();
    if (!s) return;
    if (!confirm(`归档「${s.name}」？归档只改变可见性，不删除历史、不取消任务。`)) return;
    archiveBtn.disabled = true;
    try {
      await rpc2('session.archive', { id: s.id });
      await reload();
    } catch (error) {
      const fe = friendlyError(error);
      alert(fe.text + '\n' + fe.next);
    } finally {
      archiveBtn.disabled = false;
    }
  });

  restoreBtn.addEventListener('click', async () => {
    const id = archivedSelection;
    if (!id) return;
    restoreBtn.disabled = true;
    try {
      await rpc2('session.restore', { id });
      UI.state.showArchived = false;
      archivedSelection = null;
      showArchivedBtn.textContent = '已归档';
      await reload();
    } catch (error) {
      const fe = friendlyError(error);
      alert(fe.text + '\n' + fe.next);
    } finally {
      restoreBtn.disabled = false;
    }
  });

  showArchivedBtn.addEventListener('click', async () => {
    UI.state.showArchived = !UI.state.showArchived;
    showArchivedBtn.textContent = UI.state.showArchived ? '返回会话' : '已归档';
    showArchivedBtn.classList.toggle('active', UI.state.showArchived);
    if (UI.state.showArchived) {
      await UI.refreshSessions().catch(() => {});
    }
    render();
    await loadSummaries();
  });

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim();
    render();
  });

  // 会话变化（聊天/新建/切换）时刷新
  document.addEventListener('skf:sessions', () => render());
  document.addEventListener('skf:session-switched', (e) => {
    const id = e.detail && e.detail.sessionId;
    if (id) { unread.set(id, 0); }
    render();
    document.dispatchEvent(new CustomEvent('skf:summary-update', { detail: { sessionId: id } }));
  });

  // 供 chat.js 更新摘要
  document.addEventListener('skf:set-summary', (e) => {
    const { sessionId, text } = e.detail || {};
    if (sessionId) { summaries.set(sessionId, text ? text.slice(0, 60) : ''); render(); }
  });

  window.SKF_VIEWS.sessions = {
    init() {
      render();
    },
    onShow() {
      reload().catch(() => {});
    },
  };
})();
