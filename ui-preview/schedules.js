'use strict';

/**
 * 定时任务视图：列表 / 启停 / 新建 / 手动触发 / 运行详情（firings）。
 * 时区明确为 IANA 名；手动触发走正常 task.start 流程（预算/审批不绕过）。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2 } = window.SKF_IPC2;
  const { friendlyError, formatTime } = UI;

  const listEl = document.getElementById('sched-list');
  const nameInput = document.getElementById('sched-name');
  const cronInput = document.getElementById('sched-cron');
  const tzInput = document.getElementById('sched-tz');
  const goalInput = document.getElementById('sched-goal');
  const wsInput = document.getElementById('sched-workspace');
  const createBtn = document.getElementById('sched-create');

  const FIRING_STATE_TEXT = {
    pending: '待触发', dispatched: '已派发', skipped: '已跳过', awaiting_approval: '待审批',
    dispatched_failed: '派发失败', manual_resolved: '已人工处理',
  };

  async function load() {
    listEl.innerHTML = '<div class="empty-block">读取定时任务…</div>';
    try {
      const data = await rpc2('schedule.list', { limit: 100 });
      render(data.schedules || []);
    } catch (error) {
      const fe = friendlyError(error);
      listEl.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'error-box';
      box.textContent = fe.text + '。' + fe.next;
      listEl.appendChild(box);
    }
  }

  function render(schedules) {
    listEl.innerHTML = '';
    if (!schedules.length) {
      listEl.innerHTML = '<div class="empty-block">还没有定时任务。上面新建一个。</div>';
      return;
    }
    for (const s of schedules) listEl.appendChild(renderItem(s));
  }

  function renderItem(s) {
    const card = document.createElement('div');
    card.className = 'sched-item';
    const head = document.createElement('div');
    head.className = 's-head';
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = s.name;
    const state = document.createElement('span');
    state.className = 'badge ' + (s.enabled ? 'st-succeeded' : 'st-cancelled');
    state.textContent = s.enabled ? '启用' : '停用';
    head.append(name, state);

    const cron = document.createElement('div');
    cron.className = 's-cron';
    const sess = UI.state.sessions.find((x) => x.id === s.sessionId);
    cron.textContent = `${s.cronExpr} · 时区 ${s.timezone} · ${sess ? '会话 ' + sess.name : '会话 ' + (s.sessionId || '—')}`;
    card.append(head, cron);

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    const toggle = document.createElement('button');
    toggle.className = 'small';
    toggle.textContent = s.enabled ? '停用' : '启用';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await rpc2(s.enabled ? 'schedule.disable' : 'schedule.enable', { id: s.id });
        await load();
      } catch (error) {
        const fe = friendlyError(error);
        alert(fe.text + '\n' + fe.next);
        toggle.disabled = false;
      }
    });
    actions.appendChild(toggle);

    const runOnce = document.createElement('button');
    runOnce.className = 'small primary';
    runOnce.textContent = '发起一次';
    runOnce.title = '手动触发：走正常 task.start 流程（预算/审批不绕过）';
    runOnce.addEventListener('click', async () => {
      runOnce.disabled = true;
      try {
        const full = await rpc2('schedule.get', { id: s.id });
        const sc = full.schedule;
        await rpc2('task.start', {
          input: sc.input,
          workspaceRoot: sc.workspaceRoot,
          provider: sc.provider,
          model: sc.model,
          ...(sc.sessionId ? { sessionId: sc.sessionId } : {}),
          ...(sc.scope ? { scope: sc.scope } : {}),
        });
        UI.switchView('tasks');
      } catch (error) {
        const fe = friendlyError(error);
        alert(fe.text + '\n' + fe.next);
      } finally {
        runOnce.disabled = false;
      }
    });
    actions.appendChild(runOnce);

    const detail = document.createElement('button');
    detail.className = 'small';
    detail.textContent = '运行详情';
    detail.addEventListener('click', async () => {
      const box = document.getElementById('sched-detail-' + s.id);
      if (box) { box.remove(); detail.textContent = '运行详情'; return; }
      detail.textContent = '收起';
      const d = document.createElement('div');
      d.className = 'task-detail';
      d.id = 'sched-detail-' + s.id;
      d.innerHTML = '<div class="hint">读取触发记录…</div>';
      card.appendChild(d);
      try {
        const firings = await rpc2('schedule.firings', { id: s.id, limit: 20 });
        d.innerHTML = '';
        const title = document.createElement('h4');
        title.textContent = '最近触发记录';
        d.appendChild(title);
        const list = (firings.firings || []);
        if (!list.length) {
          const none = document.createElement('div');
          none.className = 'hint';
          none.textContent = '还没有触发记录。';
          d.appendChild(none);
        }
        for (const f of list) {
          const row = document.createElement('div');
          row.className = 's-cron';
          row.style.marginBottom = '4px';
          row.textContent = `${formatTime(f.scheduledAtUtc)} · ${FIRING_STATE_TEXT[f.state] || f.state}${f.taskId ? ' · 任务 ' + f.taskId : ''}${f.errorCode ? ' · ' + f.errorCode : ''}`;
          d.appendChild(row);
        }
      } catch (error) {
        const fe = friendlyError(error);
        d.innerHTML = '';
        const e = document.createElement('div');
        e.className = 'error-box';
        e.textContent = fe.text;
        d.appendChild(e);
      }
    });
    actions.appendChild(detail);

    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      if (!confirm(`删除定时任务「${s.name}」？删除后不再触发。`)) return;
      del.disabled = true;
      try { await rpc2('schedule.delete', { id: s.id }); await load(); }
      catch (error) {
        const fe = friendlyError(error);
        alert(fe.text + '\n' + fe.next);
        del.disabled = false;
      }
    });
    actions.appendChild(del);

    card.appendChild(actions);
    return card;
  }

  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const cronExpr = cronInput.value.trim();
    const timezone = tzInput.value.trim();
    const goal = goalInput.value.trim();
    const workspaceRoot = wsInput.value.trim();
    if (!name || !cronExpr || !timezone || !goal || !workspaceRoot) { alert('请填写完整：名称、cron、时区、目标、工作目录。'); return; }
    const ping = UI.state.ping || {};
    createBtn.disabled = true;
    try {
      await rpc2('schedule.create', {
        name, cronExpr, timezone,
        input: { goal },
        provider: ping.provider || 'kimi',
        model: ping.model || 'kimi',
        workspaceRoot,
        ...(UI.currentSession() ? { sessionId: UI.currentSession().id, scope: UI.currentSession().scope } : {}),
      });
      nameInput.value = '';
      goalInput.value = '';
      await load();
    } catch (error) {
      const fe = friendlyError(error);
      alert(fe.text + '\n' + fe.next);
    } finally {
      createBtn.disabled = false;
    }
  });

  window.SKF_VIEWS.schedules = {
    init() { return load(); },
    onShow() { load().catch(() => {}); },
  };
})();
