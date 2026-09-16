'use strict';

/**
 * 记忆视图（最小功能）：按项目查、看来源/确认状态、更正、归档/恢复、备份。
 * 主流程不出现数据库路径与操作 ID——那些只在「诊断详情」里。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2 } = window.SKF_IPC2;
  const { friendlyError, formatTime } = UI;

  const header = document.getElementById('mem-header');
  const form = document.getElementById('mem-search-form');
  const queryInput = document.getElementById('mem-query');
  const includeArchived = document.getElementById('mem-include-archived');
  const results = document.getElementById('mem-results');
  const searchBtn = document.getElementById('mem-search');

  const TRUST_TEXT = {
    user_confirmed: '用户确认', tool_observed: '工具观察', legacy: '历史记录', candidate: '候选',
  };
  const KIND_TEXT = {
    fact: '事实', preference: '偏好', lesson: '经验', episode: '经历', reference: '资料', decision: '决定',
  };

  let searching = false;
  let backingUp = false;
  let lastHits = [];

  // ── 头部：范围/可用性/统计/备份 ──────────────────────────────────

  async function renderHeader() {
    header.innerHTML = '<span class="mem-stat">读取中…</span>';
    let status;
    try {
      status = await rpc2('memory.status');
    } catch (error) {
      const fe = friendlyError(error);
      header.innerHTML = '';
      const stat = document.createElement('span');
      stat.className = 'mem-stat';
      stat.textContent = fe.code === 'MEMORY_UNAVAILABLE'
        ? '记忆主档暂不可用：不阻塞对话与任务；写回会排队自动补投。'
        : `记忆状态读取失败：${fe.text}`;
      header.appendChild(stat);
      return;
    }
    const ping = UI.state.ping || {};
    const caps = ping.capabilities || {};
    const counts = { active: 0, archived: 0 };
    for (const row of (status.stats && status.stats.records) || []) {
      if (row.status === 'active') counts.active += row.count;
      if (row.status === 'archived') counts.archived += row.count;
    }
    header.innerHTML = '';
    const items = [
      ['项目', status.scope || '—'],
      ['有效记录', String(counts.active)],
      ['已归档', String(counts.archived)],
      ['待写回', String(status.outboxPending ?? (caps.memoryOutboxPending || 0))],
    ];
    for (const [k, v] of items) {
      const el = document.createElement('span');
      el.className = 'mem-stat';
      el.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = v;
      el.append(k + ' ', b);
      header.appendChild(el);
    }
    const backup = document.createElement('button');
    backup.className = 'small';
    backup.textContent = '备份记忆';
    backup.title = '生成主档的只读快照（不影响使用）';
    backup.addEventListener('click', () => doBackup(backup));
    header.appendChild(backup);
    const result = document.createElement('span');
    result.className = 'mem-stat';
    result.id = 'mem-backup-result';
    result.hidden = true;
    header.appendChild(result);
  }

  async function doBackup(button) {
    if (backingUp) return;
    backingUp = true;
    button.disabled = true;
    button.textContent = '备份中…';
    const result = document.getElementById('mem-backup-result');
    try {
      const data = await rpc2('memory.backup');
      result.hidden = false;
      result.innerHTML = '';
      const ok = document.createElement('b');
      ok.textContent = '备份完成';
      result.appendChild(ok);
      // 路径与细节只进诊断，不占主流程
      const diag = document.createElement('details');
      diag.className = 'diag';
      const summary = document.createElement('summary');
      summary.textContent = '诊断详情';
      const pre = document.createElement('pre');
      pre.textContent = `快照文件：${data.file}`;
      diag.append(summary, pre);
      result.appendChild(diag);
    } catch (error) {
      const fe = friendlyError(error);
      result.hidden = false;
      result.textContent = fe.text + '。' + fe.next;
    } finally {
      backingUp = false;
      button.disabled = false;
      button.textContent = '备份记忆';
    }
  }

  // ── 搜索 ─────────────────────────────────────────────────────────

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (searching) return; // 防重复提交
    const query = queryInput.value.trim();
    if (!query) return;
    searching = true;
    searchBtn.disabled = true;
    results.innerHTML = '<div class="empty-block">搜索中…</div>';
    try {
      const data = await rpc2('memory.search', { query, limit: 12, includeArchived: includeArchived.checked });
      lastHits = data.hits || [];
      renderHits(data);
    } catch (error) {
      const fe = friendlyError(error);
      results.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'error-box';
      const main = document.createElement('div');
      main.textContent = fe.text;
      const next = document.createElement('div');
      next.className = 'next';
      next.textContent = '下一步：' + fe.next;
      box.append(main, next);
      results.appendChild(box);
    } finally {
      searching = false;
      searchBtn.disabled = false;
    }
  });

  function renderHits(data) {
    results.innerHTML = '';
    if (!lastHits.length) {
      results.innerHTML = '<div class="empty-block">没有匹配的记录。换个关键词，或勾选「包含已归档」。</div>';
      return;
    }
    if (data.semanticStatus && data.semanticStatus !== 'ready' && data.semanticStatus !== 'disabled') {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.style.marginBottom = '8px';
      hint.textContent = '语义检索暂不可用，本次用的是关键词匹配。';
      results.appendChild(hint);
    }
    lastHits.forEach((hit, index) => results.appendChild(renderHit(hit, index)));
  }

  function renderHit(hit, index) {
    const card = document.createElement('div');
    card.className = 'mem-hit' + (hit.status === 'archived' ? ' archived' : '');

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = hit.text.length > 280 && !card.dataset.open
      ? hit.text.slice(0, 280) + '…'
      : hit.text;

    const badges = document.createElement('div');
    badges.className = 'badges';
    const badgeList = [
      TRUST_TEXT[hit.trust] || hit.trust,
      KIND_TEXT[hit.kind] || hit.kind,
    ];
    if (hit.slot) badgeList.push('槽位 ' + hit.slot);
    if (hit.status === 'archived') badgeList.push('已归档');
    if (hit.pinned) badgeList.push('已钉住');
    for (const label of badgeList) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = label;
      badges.appendChild(b);
    }

    const src = document.createElement('div');
    src.className = 'src';
    const sources = (hit.source || []).map((s) => `${s.kind}:${s.locator}`).join('；');
    src.textContent = `${formatTime(hit.createdAt)} · 来源 ${sources || '—'}`;

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const toggle = document.createElement('button');
    toggle.className = 'small';
    toggle.textContent = '详情';
    toggle.addEventListener('click', () => {
      const detail = card.querySelector('.mem-detail');
      if (detail) {
        detail.remove();
        toggle.textContent = '详情';
      } else {
        card.appendChild(renderDetail(hit, index));
        toggle.textContent = '收起';
      }
    });
    actions.appendChild(toggle);
    card.append(text, badges, src, actions);
    return card;
  }

  function renderDetail(hit, index) {
    const detail = document.createElement('div');
    detail.className = 'mem-detail';

    const full = document.createElement('div');
    full.className = 'text';
    full.textContent = hit.text;
    detail.appendChild(full);

    const srcLines = document.createElement('div');
    srcLines.className = 'src';
    srcLines.textContent = `记录于 ${hit.createdAt || '—'}${hit.updatedAt && hit.updatedAt !== hit.createdAt ? ' · 更新于 ' + hit.updatedAt : ''}`;
    detail.appendChild(srcLines);

    const row = document.createElement('div');
    row.className = 'task-actions';

    if (hit.status !== 'archived') {
      const correct = document.createElement('button');
      correct.className = 'small';
      correct.textContent = '更正';
      correct.addEventListener('click', () => detail.appendChild(renderCorrectForm(hit, index)));
      const archive = document.createElement('button');
      archive.className = 'small danger';
      archive.textContent = '归档';
      archive.title = '归档后默认搜索不再出现，可随时恢复';
      let confirming = false;
      archive.addEventListener('click', async () => {
        if (!confirming) {
          confirming = true;
          archive.textContent = '确认归档？';
          setTimeout(() => { confirming = false; archive.textContent = '归档'; }, 4000);
          return;
        }
        archive.disabled = true;
        try {
          await rpc2('memory.archive', { ids: [hit.id], reason: '用户在记忆页归档' });
          rerunSearch();
        } catch (error) {
          const fe = friendlyError(error);
          alert(fe.text + '\n' + fe.next);
          archive.disabled = false;
        }
      });
      row.append(correct, archive);
    } else {
      const restore = document.createElement('button');
      restore.className = 'small primary';
      restore.textContent = '恢复';
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        try {
          await rpc2('memory.restore', { id: hit.id });
          rerunSearch();
        } catch (error) {
          const fe = friendlyError(error);
          alert(fe.text + '\n' + fe.next);
          restore.disabled = false;
        }
      });
      row.appendChild(restore);
    }

    detail.appendChild(row);

    // 诊断：记录 ID 等只在这里出现
    const diag = document.createElement('details');
    diag.className = 'diag';
    const summary = document.createElement('summary');
    summary.textContent = '诊断详情';
    const pre = document.createElement('pre');
    pre.textContent = `记录 ID：${hit.id}\n信任级别：${hit.trust} · 状态：${hit.status} · 置信度：${hit.confidence}`;
    diag.append(summary, pre);
    detail.appendChild(diag);

    return detail;
  }

  function renderCorrectForm(hit, index) {
    const formBox = document.createElement('div');
    formBox.className = 'detail-block';
    const title = document.createElement('h4');
    title.textContent = '更正这条记录（旧记录归档，新记录标记为你确认的）';
    const textarea = document.createElement('textarea');
    textarea.maxLength = 4000;
    textarea.value = hit.text;
    const reason = document.createElement('input');
    reason.type = 'text';
    reason.maxLength = 1000;
    reason.placeholder = '更正原因（可选）';
    const row = document.createElement('div');
    row.className = 'task-actions';
    const submit = document.createElement('button');
    submit.className = 'small primary';
    submit.textContent = '提交更正';
    const cancel = document.createElement('button');
    cancel.className = 'small';
    cancel.textContent = '取消';
    let submitting = false;
    submit.addEventListener('click', async () => {
      if (submitting) return; // 防重复提交
      const text = textarea.value.trim();
      if (!text) return;
      submitting = true;
      submit.disabled = true;
      try {
        await rpc2('memory.correct', { id: hit.id, text, reason: reason.value.trim() || undefined });
        rerunSearch();
      } catch (error) {
        const fe = friendlyError(error);
        alert(fe.text + '\n' + fe.next);
        submitting = false;
        submit.disabled = false;
      }
    });
    cancel.addEventListener('click', () => formBox.remove());
    row.append(submit, cancel);
    formBox.append(title, textarea, reason, row);
    return formBox;
  }

  function rerunSearch() {
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    renderHeader().catch(() => {});
  }

  // ── 视图生命周期 ─────────────────────────────────────────────────

  window.SKF_VIEWS.memory = {
    init() {
      renderHeader().catch(() => {});
    },
    onShow() {
      renderHeader().catch(() => {});
    },
  };
})();
