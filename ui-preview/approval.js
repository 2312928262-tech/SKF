'use strict';

/**
 * 审批中心抽屉：后台审批聚合可见，不连续抢占焦点。
 * 批准绑定后端当前审批对象（approvalId + inputHash），UI 不自行重构授权参数；
 * 「暂不批准」不发送拒绝动作，不等于取消任务。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2, onSkfEvent } = window.SKF_IPC2;
  const { friendlyError } = UI;

  const mask = document.getElementById('drawer-mask');
  const drawer = document.getElementById('approval-drawer');
  const closeBtn = document.getElementById('approval-close');
  const listEl = document.getElementById('approval-list');

  const EFFECT_TEXT = { read: '读取', workspace_write: '工作区写入', external_write: '外部写入', process: '进程执行' };
  const RISK_TEXT = {
    read: '低风险（只读）',
    workspace_write: '中风险（工作区内写入）',
    external_write: '高风险（外部写入）',
    process: '高风险（进程执行）',
  };

  let known = []; // { taskId, sessionName, approval }
  let loading = false;

  function open() {
    drawer.classList.add('open');
    mask.classList.add('open');
    refresh().catch(() => {});
  }
  function close() {
    drawer.classList.remove('open');
    mask.classList.remove('open');
  }

  closeBtn.addEventListener('click', close);
  mask.addEventListener('click', close);
  document.addEventListener('skf:open-approval', open);

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const list = await rpc2('task.list', { limit: 100 });
      const waiting = (list.tasks || []).filter((t) => t.state === 'waiting_approval' && t.kind !== 'chat');
      const items = [];
      for (const t of waiting) {
        let detail;
        try { detail = await rpc2('task.get', { taskId: t.id }); } catch { continue; }
        const sess = UI.state.sessions.find((s) => s.id === t.sessionId);
        for (const approval of detail.pendingApprovals || []) {
          items.push({ taskId: t.id, sessionName: sess ? sess.name : (t.sessionId || '—'), approval });
        }
      }
      known = items;
      UI.setApprovalCount(items.length);
      render();
    } catch {
      /* 读取失败保持现状 */
    } finally {
      loading = false;
    }
  }

  function render() {
    listEl.innerHTML = '';
    if (!known.length) {
      listEl.innerHTML = '<div class="empty-block">暂无待审批操作。</div>';
      return;
    }
    for (const item of known) listEl.appendChild(renderItem(item));
  }

  function renderItem(item) {
    const a = item.approval;
    const card = document.createElement('div');
    card.className = 'approval-item';

    const head = document.createElement('div');
    head.className = 'a-head';
    head.textContent = `待确认：${EFFECT_TEXT[a.effect] || a.effect} 操作`;

    const meta = document.createElement('div');
    meta.className = 'a-meta';
    meta.textContent = `会话 ${item.sessionName} · 任务 ${item.taskId} · ${RISK_TEXT[a.effect] || ''}`;

    const hash = document.createElement('div');
    hash.className = 'a-hash';
    hash.textContent = '参数 hash：' + a.inputHash;
    hash.title = '完整参数 hash（批准绑定此值，参数变化后旧批准自动失效）';

    const actions = document.createElement('div');
    actions.className = 'a-actions';
    const approve = document.createElement('button');
    approve.className = 'primary';
    approve.textContent = '批准本次操作';
    const defer = document.createElement('button');
    defer.textContent = '暂不批准';
    defer.title = '不发送拒绝动作，不等于取消任务';
    const reject = document.createElement('button');
    reject.className = 'danger';
    reject.textContent = '拒绝';

    let decided = false;
    const decide = async (decision) => {
      if (decided) return;
      decided = true;
      approve.disabled = true;
      defer.disabled = true;
      reject.disabled = true;
      try {
        await rpc2('task.approve', { approvalId: a.id, inputHash: a.inputHash, decision });
      } catch (error) {
        const fe = friendlyError(error);
        alert(fe.text + '\n' + fe.next);
      }
      await refresh();
    };
    approve.addEventListener('click', () => decide('approved'));
    defer.addEventListener('click', () => close());
    reject.addEventListener('click', () => decide('rejected'));
    actions.append(approve, defer, reject);

    card.append(head, meta, hash, actions);
    return card;
  }

  // 事件驱动刷新计数（后台审批出现/消失时不抢焦点）
  onSkfEvent((event) => {
    if (!event) return;
    if (event.type === 'task.state' && event.safePayload && event.safePayload.to === 'waiting_approval') {
      UI.setApprovalCount(UI.state.pendingApprovals + 1);
      if (drawer.classList.contains('open')) refresh().catch(() => {});
    } else if (event.type === 'approval.decided') {
      refresh().catch(() => {});
    }
  });

  window.SKF_VIEWS.approval = {
    init() { refresh().catch(() => {}); },
  };
})();
