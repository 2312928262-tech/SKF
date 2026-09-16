'use strict';

/**
 * 任务视图：真实进度（事件驱动）+ 产物（已校验）+ 操作（取消/恢复/审批）。
 * 阶段进度来自 events 表（task.model_step/task.tool/...）；模型文本自述与
 * 「文件已交付」严格分离——只有 artifacts 表登记（写入后读回校验）的才标已校验。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2, onSkfEvent } = window.SKF_IPC2;
  const { friendlyError, formatBytes, formatTime, TASK_STATE_TEXT, IN_FLIGHT_STATES } = UI;
  const MD = window.SKF_MARKDOWN;

  const listEl = document.getElementById('task-list');
  const newPanel = document.getElementById('task-new');
  const goalInput = document.getElementById('task-goal');
  const wsInput = document.getElementById('task-workspace');
  const startBtn = document.getElementById('task-start');

  const expanded = new Set(); // 展开详情的 taskId
  const detailCache = new Map(); // taskId -> 最近一次 task.get（避免事件风暴重复渲染）
  let knownTasks = []; // 最近一次 task.list
  let starting = false;
  let listTimer = null;
  const detailTimers = new Map();

  // ── 节流刷新：事件可能很密，查询限频（事件积压不放大成查询风暴）───

  function scheduleListRefresh() {
    if (listTimer) return;
    listTimer = setTimeout(() => {
      listTimer = null;
      refreshList().catch(() => {});
    }, 1200);
  }

  function scheduleDetailRefresh(taskId) {
    if (detailTimers.has(taskId)) return;
    detailTimers.set(taskId, setTimeout(() => {
      detailTimers.delete(taskId);
      if (expanded.has(taskId)) refreshDetail(taskId).catch(() => {});
    }, 350));
  }

  onSkfEvent((event) => {
    if (!event || typeof event.taskId !== 'string') return;
    if (event.type.startsWith('task.') || event.type.startsWith('approval.')) {
      scheduleListRefresh();
      if (expanded.has(event.taskId)) scheduleDetailRefresh(event.taskId);
    }
  });

  // ── 新建任务 ─────────────────────────────────────────────────────

  wsInput.value = localStorage.getItem('skf.lastWorkspace') || '';

  startBtn.addEventListener('click', async () => {
    if (starting) return; // 防重复提交
    const goal = goalInput.value.trim();
    const workspaceRoot = wsInput.value.trim();
    if (!goal) { goalInput.focus(); return; }
    if (!workspaceRoot) { wsInput.focus(); return; }
    starting = true;
    startBtn.disabled = true;
    try {
      const result = await rpc2('task.start', { input: { goal }, workspaceRoot });
      localStorage.setItem('skf.lastWorkspace', workspaceRoot);
      goalInput.value = '';
      newPanel.open = false;
      expanded.add(result.taskId);
      await refreshList();
      await refreshDetail(result.taskId);
    } catch (error) {
      showStartError(error);
    } finally {
      starting = false;
      startBtn.disabled = false;
    }
  });

  function showStartError(error) {
    const fe = friendlyError(error);
    let box = newPanel.querySelector('.error-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'error-box';
      newPanel.querySelector('.form-grid').appendChild(box);
    }
    box.innerHTML = '';
    const main = document.createElement('div');
    main.textContent = fe.text;
    const next = document.createElement('div');
    next.className = 'next';
    next.textContent = '下一步：' + fe.next;
    box.append(main, next);
    setTimeout(() => box.remove(), 8000);
  }

  // ── 列表 ─────────────────────────────────────────────────────────

  async function refreshList() {
    const result = await rpc2('task.list', { limit: 50 });
    const tasks = (result.tasks || []).filter((t) => t.kind !== 'chat');
    knownTasks = tasks;
    UI.setTasksBadge(tasks.filter((t) => IN_FLIGHT_STATES.includes(t.state)).length);
    renderList();
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!knownTasks.length) {
      listEl.innerHTML = '<div class="empty-block">还没有任务。上面新建一个，或从对话里了解能做什么。</div>';
      return;
    }
    for (const task of knownTasks) {
      listEl.appendChild(renderCard(task));
      if (expanded.has(task.id)) {
        const cached = detailCache.get(task.id);
        if (cached) renderDetail(task.id, cached);
        else refreshDetail(task.id).catch(() => {});
      }
    }
  }

  function stepLineText(task) {
    const detail = detailCache.get(task.id);
    if (!detail) {
      if (task.state === 'queued') return '等待开始…';
      if (IN_FLIGHT_STATES.includes(task.state)) return '进行中…';
      return TASK_STATE_TEXT[task.state] || task.state;
    }
    const counts = detail.counts || { modelSteps: 0, toolCalls: 0 };
    switch (task.state) {
      case 'queued': return '排队中，等待工作线程';
      case 'running':
      case 'waiting_provider':
        return counts.modelSteps > 0
          ? `模型第 ${counts.modelSteps} 步 · 工具 ${counts.toolCalls} 次`
          : '准备中（读取任务与记忆上下文）';
      case 'waiting_approval': return '有一个操作等你确认';
      case 'cancelling': return '正在取消（在途副作用先落账）';
      case 'succeeded': return `完成 · 模型 ${counts.modelSteps} 步 · 工具 ${counts.toolCalls} 次`;
      case 'failed': return `失败 · ${friendlyError(task.errorCode).text}`;
      case 'cancelled': return '已取消（已提交产物照列）';
      case 'interrupted': return '被中断（如应用退出），未自动重试';
      default: return task.state;
    }
  }

  function renderCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.id = 'task-card-' + task.id;

    const head = document.createElement('div');
    head.className = 'head';
    const badge = document.createElement('span');
    badge.className = 'badge st-' + task.state;
    badge.textContent = TASK_STATE_TEXT[task.state] || task.state;
    const goal = document.createElement('span');
    goal.className = 'goal';
    goal.textContent = task.goal || '（无描述）';
    head.append(badge, goal);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${task.provider}/${task.model} · ${formatTime(task.createdAt)}`;

    const step = document.createElement('div');
    step.className = 'step-line';
    step.textContent = stepLineText(task);

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    const toggle = document.createElement('button');
    toggle.className = 'small';
    toggle.textContent = expanded.has(task.id) ? '收起' : '详情';
    toggle.addEventListener('click', async () => {
      if (expanded.has(task.id)) {
        expanded.delete(task.id);
        const detail = document.getElementById('task-detail-' + task.id);
        if (detail) detail.remove();
        toggle.textContent = '详情';
      } else {
        expanded.add(task.id);
        toggle.textContent = '收起';
        await refreshDetail(task.id);
      }
    });
    actions.appendChild(toggle);

    if (['queued', 'running', 'waiting_provider', 'waiting_approval', 'cancelling'].includes(task.state)) {
      const cancel = document.createElement('button');
      cancel.className = 'small danger';
      cancel.textContent = task.state === 'cancelling' ? '取消中…' : '取消';
      cancel.disabled = task.state === 'cancelling';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true; // 取消幂等，按钮只防连点
        cancel.textContent = '取消中…';
        try {
          await rpc2('task.cancel', { taskId: task.id });
        } catch (error) {
          cancel.disabled = false;
          cancel.textContent = '取消';
          alert(friendlyError(error).text + '\n' + friendlyError(error).next);
        }
        scheduleDetailRefresh(task.id);
        scheduleListRefresh();
      });
      actions.appendChild(cancel);
    }

    card.append(head, sub, step, actions);
    return card;
  }

  // ── 详情 ─────────────────────────────────────────────────────────

  async function refreshDetail(taskId) {
    const detail = await rpc2('task.get', { taskId });
    detailCache.set(taskId, detail);
    // 同步卡片摘要行（步骤计数可能变了）
    const summary = knownTasks.find((t) => t.id === taskId);
    if (summary) {
      summary.state = detail.task.state;
      summary.errorCode = detail.task.errorCode;
      const card = document.getElementById('task-card-' + taskId);
      if (card) {
        const oldBadge = card.querySelector('.badge');
        oldBadge.className = 'badge st-' + detail.task.state;
        oldBadge.textContent = TASK_STATE_TEXT[detail.task.state] || detail.task.state;
        card.querySelector('.step-line').textContent = stepLineText(summary);
        const oldActions = card.querySelector('.task-actions');
        const newCard = renderCard(summary);
        oldActions.replaceWith(newCard.querySelector('.task-actions'));
      }
    }
    renderDetail(taskId, detail);
  }

  function renderDetail(taskId, detail) {
    const card = document.getElementById('task-card-' + taskId);
    if (!card) return;
    let box = document.getElementById('task-detail-' + taskId);
    if (!box) {
      box = document.createElement('div');
      box.className = 'task-detail';
      box.id = 'task-detail-' + taskId;
      card.appendChild(box);
    }
    box.innerHTML = '';

    // 失败/错误：中文映射 + 下一步
    if (detail.task.state === 'failed' && detail.task.errorCode) {
      box.appendChild(errorBox(detail.task.errorCode));
    }

    // 待确认审批
    for (const approval of detail.pendingApprovals || []) {
      box.appendChild(approvalRow(taskId, approval));
    }

    // 中断恢复
    if (detail.task.state === 'interrupted') {
      box.appendChild(resumeBox(taskId));
    }

    // 产物（已校验）
    const artifacts = detail.artifacts || [];
    const artBlock = document.createElement('div');
    artBlock.className = 'detail-block';
    const artTitle = document.createElement('h4');
    artTitle.textContent = artifacts.length ? `产物（${artifacts.length} 个 · 写入后已读回校验）` : '产物';
    artBlock.appendChild(artTitle);
    if (!artifacts.length) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = detail.task.state === 'succeeded'
        ? '这个任务没有登记文件产物。模型自述不等于文件已交付。'
        : '任务结束后，校验过的文件会列在这里。';
      artBlock.appendChild(none);
    }
    for (const artifact of artifacts) {
      artBlock.appendChild(artifactRow(detail.task.workspaceRoot, artifact));
    }
    box.appendChild(artBlock);

    // 模型回复（明确标注：文本自述不代表文件完成）
    if (detail.finalText) {
      const textBlock = document.createElement('div');
      textBlock.className = 'detail-block';
      const title = document.createElement('h4');
      title.textContent = '模型回复（文本自述；文件以上面已校验产物为准）';
      const body = document.createElement('div');
      body.className = 'msg bot';
      const inner = document.createElement('div');
      inner.className = 'body';
      inner.innerHTML = MD.renderMarkdown(detail.finalText);
      body.appendChild(inner);
      textBlock.append(title, body);
      box.appendChild(textBlock);
    }

    // 记忆写回待补
    if (detail.memoryOutboxPending) {
      const mem = document.createElement('div');
      mem.className = 'check-line';
      mem.textContent = '记忆写回待补：主档恢复后自动补投，无需操作。';
      box.appendChild(mem);
    }

    // 预算（本任务）
    renderTaskBudget(box, taskId);

    // 事件时间线
    renderTimeline(box, taskId);
  }

  function errorBox(code) {
    const fe = friendlyError(code);
    const box = document.createElement('div');
    box.className = 'error-box';
    const main = document.createElement('div');
    main.textContent = fe.text;
    const next = document.createElement('div');
    next.className = 'next';
    next.textContent = '下一步：' + fe.next;
    box.append(main, next);
    return box;
  }

  const EFFECT_TEXT = { read: '读取', workspace_write: '工作区写入', external_write: '外部写入', process: '进程执行' };

  function approvalRow(taskId, approval) {
    const row = document.createElement('div');
    row.className = 'approval-row';
    const label = document.createElement('span');
    label.textContent = `待确认：${EFFECT_TEXT[approval.effect] || approval.effect} 操作`;
    const ok = document.createElement('button');
    ok.className = 'small primary';
    ok.textContent = '批准';
    const no = document.createElement('button');
    no.className = 'small danger';
    no.textContent = '拒绝';
    let decided = false;
    const decide = async (decision) => {
      if (decided) return; // 防重复提交
      decided = true;
      ok.disabled = true;
      no.disabled = true;
      try {
        await rpc2('task.approve', { approvalId: approval.id, inputHash: approval.inputHash, decision });
      } catch (error) {
        const fe = friendlyError(error);
        alert(fe.text + '\n' + fe.next);
      }
      refreshDetail(taskId).catch(() => {});
      scheduleListRefresh();
    };
    ok.addEventListener('click', () => decide('approved'));
    no.addEventListener('click', () => decide('rejected'));
    row.append(label, ok, no);
    return row;
  }

  function resumeBox(taskId) {
    const box = document.createElement('div');
    box.className = 'detail-block';
    const title = document.createElement('h4');
    title.textContent = '恢复任务';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '中断的任务不会自动重试。恢复前会做安全检查；费用不确定的旧调用不会重发（以新调用继续）。';
    const go = document.createElement('button');
    go.className = 'small primary';
    go.textContent = '尝试恢复';
    const blocks = document.createElement('div');
    box.append(title, hint, go, blocks);

    let retryUncertain = null;
    let budgetReauth = null;

    go.addEventListener('click', async () => {
      go.disabled = true;
      blocks.innerHTML = '';
      try {
        const result = await rpc2('task.resume', {
          taskId,
          retryUncertain: retryUncertain ? retryUncertain.checked : false,
          budgetReauthorized: budgetReauth ? budgetReauth.checked : false,
        });
        if (result.accepted) {
          hint.textContent = '已恢复，任务重新排队。';
          scheduleListRefresh();
          scheduleDetailRefresh(taskId);
          return;
        }
        const block = result.block || {};
        const fe = friendlyError(block.code || 'TASK_INTERRUPTED');
        blocks.appendChild(errorBox(block.code || 'TASK_INTERRUPTED'));
        if (block.code === 'MODEL_CALL_UNCERTAIN_REVIEW') {
          retryUncertain = document.createElement('input');
          retryUncertain.type = 'checkbox';
          const line = document.createElement('label');
          line.className = 'check-line';
          line.append(retryUncertain, document.createTextNode('我已了解：旧调用费用不确定，恢复会以新调用继续（旧请求绝不重发）'));
          blocks.appendChild(line);
        }
        if (block.code === 'BUDGET_REAUTH_REQUIRED' || block.code === 'MODEL_CALL_UNCERTAIN_REVIEW') {
          budgetReauth = document.createElement('input');
          budgetReauth.type = 'checkbox';
          const line = document.createElement('label');
          line.className = 'check-line';
          line.append(budgetReauth, document.createTextNode('我确认预算仍然有效，重新授权'));
          blocks.appendChild(line);
        }
        hint.textContent = '恢复被阻止：' + fe.next;
      } catch (error) {
        const fe = friendlyError(error);
        blocks.appendChild(errorBox(error.message));
        hint.textContent = fe.next;
      } finally {
        go.disabled = false;
        go.textContent = '再次尝试恢复';
      }
    });
    return box;
  }

  function artifactRow(workspaceRoot, artifact) {
    const row = document.createElement('div');
    row.className = 'artifact';
    const path = document.createElement('span');
    path.className = 'path';
    const sep = workspaceRoot.includes('\\') ? '\\' : '/';
    const fullPath = workspaceRoot.replace(/[\\/]+$/, '') + sep + artifact.relativePath.replace(/[\\/]+/g, sep);
    path.textContent = artifact.relativePath;
    path.title = fullPath;
    const hash = document.createElement('span');
    hash.className = 'hash';
    hash.textContent = `${formatBytes(artifact.byteLength)} · sha256 ${String(artifact.sha256).slice(0, 12)}…`;
    const verified = document.createElement('span');
    verified.className = 'badge st-succeeded';
    verified.textContent = artifact.verifiedAt ? '已校验' : '已登记';
    verified.title = artifact.verifiedAt ? `读回校验时间 ${artifact.verifiedAt}` : '旧记录无校验时间';
    const open = document.createElement('button');
    open.className = 'small';
    open.textContent = '打开';
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
        if (!inv) throw new Error('TAURI_BRIDGE_MISSING');
        await inv('open_artifact', { path: fullPath });
      } catch (error) {
        const fe = friendlyError({ message: String((error && error.message) || error).split(':')[0] });
        alert(fe.text + '\n' + fe.next);
      } finally {
        open.disabled = false;
      }
    });
    row.append(verified, path, hash, open);
    return row;
  }

  async function renderTaskBudget(box, taskId) {
    const block = document.createElement('div');
    block.className = 'detail-block';
    const title = document.createElement('h4');
    title.textContent = '费用（本任务）';
    const line = document.createElement('div');
    line.className = 'hint';
    line.textContent = '读取中…';
    block.append(title, line);
    box.appendChild(block);
    try {
      const status = await rpc2('budget.status', { taskId });
      const task = status.task;
      if (!task || task.calls === 0) {
        line.textContent = '本任务还没有模型调用。';
        return;
      }
      const parts = [
        `已结算估算 ${UI.formatMicros(task.spent)}`,
        task.reserved > 0 ? `预留 ${UI.formatMicros(task.reserved)}` : '',
        task.uncertain > 0 ? `待核对 ${UI.formatMicros(task.uncertain)}` : '',
        `调用 ${task.calls} 次`,
      ].filter(Boolean);
      line.textContent = parts.join(' · ');
      line.title = '按配置价目的估算；缓存命中可能有折扣（非承诺）；待核对 = 结果不确定，保守占位不记免费。';
    } catch {
      line.textContent = '费用状态暂时读不到。';
    }
  }

  async function renderTimeline(box, taskId) {
    const block = document.createElement('div');
    block.className = 'detail-block';
    const title = document.createElement('h4');
    title.textContent = '进度记录';
    const list = document.createElement('div');
    list.className = 'timeline';
    list.textContent = '读取中…';
    block.append(title, list);
    box.appendChild(block);
    try {
      const result = await rpc2('events.since', { afterSeq: 0, limit: 1000, taskId });
      const events = (result.events || []).slice(-40);
      list.innerHTML = '';
      if (!events.length) {
        list.textContent = '还没有事件。';
        return;
      }
      for (const event of events) {
        const row = document.createElement('div');
        row.className = 't-line';
        const time = document.createElement('span');
        time.className = 't-time';
        time.textContent = formatTime(event.at) + ' ';
        row.appendChild(time);
        row.appendChild(document.createTextNode(describeEvent(event)));
        list.appendChild(row);
      }
      list.scrollTop = list.scrollHeight;
    } catch {
      list.textContent = '事件暂时读不到。';
    }
  }

  function describeEvent(event) {
    const p = event.safePayload || {};
    switch (event.type) {
      case 'task.created': return `任务创建（${p.provider}/${p.model}）`;
      case 'task.state': return `状态 ${TASK_STATE_TEXT[p.from] || p.from} → ${TASK_STATE_TEXT[p.to] || p.to}`;
      case 'task.running': return '开始执行';
      case 'task.model_step': return `模型第 ${p.step} 步完成${p.toolCalls ? `（请求 ${p.toolCalls} 个工具）` : ''}`;
      case 'task.tool': return p.ok ? `工具 ${p.tool} 成功` : `工具 ${p.tool} 失败（${p.code || '未知'}）`;
      case 'task.acceptance': return p.ok ? '产物验收通过' : '产物验收未通过';
      case 'task.succeeded': return '任务完成';
      case 'task.failed': return `任务失败（${p.errorCode || '未知'}）`;
      case 'task.cancel_requested': return '收到取消请求';
      case 'task.cancelled': return '已取消';
      case 'task.resumed': return '已恢复重新排队';
      case 'task.operation_needs_review': return '有操作结果未知，需人工核对';
      case 'task.operation_resolved': return '未知操作已人工核对';
      case 'task.tool_recovered': return '中断遗留操作已核对实物补记';
      case 'approval.decided': return `审批${p.decision === 'approved' ? '通过' : p.decision === 'rejected' ? '拒绝' : '过期'}`;
      case 'task.legacy_imported': return '旧数据导入';
      default: return event.type;
    }
  }

  // ── 视图生命周期 ─────────────────────────────────────────────────

  window.SKF_VIEWS.tasks = {
    async init() {
      await refreshList().catch(() => {});
      // 自动展开第一个在途任务（刷新页面后立刻看到进度）
      const active = knownTasks.find((t) => IN_FLIGHT_STATES.includes(t.state));
      if (active && !expanded.has(active.id)) {
        expanded.add(active.id);
        renderList();
      }
    },
    onShow() {
      refreshList().catch(() => {});
      for (const id of expanded) refreshDetail(id).catch(() => {});
    },
  };
})();
