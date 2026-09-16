'use strict';

/**
 * M10 E2E 探针 —— 只存在于 e2e 前端副本（D:/SKF-Work/e2e/frontend），
 * 产品 UI（dev/ui-preview）不含此文件。它在真实 Tauri 应用里驱动真实 UI，
 * 把检查结果经 IPC 写成 marker 任务（tasks.input），Node 侧从 runtime.sqlite 读取断言。
 */
(function () {
  const report = [];
  const push = [];
  let quoteId = '';
  // e2e 固定工作区（驱动脚本同样使用此路径；产品与真实数据不在这里）。
  const E2E_WS = 'D:\\SKF-Work\\e2e\\run\\ws';

  const check = (n, ok, d) => report.push({ n, ok: ok ? 1 : 0, d: String(d === undefined ? '' : d).slice(0, 60) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(pred, ms, label) {
    const started = Date.now();
    for (;;) {
      try {
        const value = await pred();
        if (value) return value;
      } catch { /* keep waiting */ }
      if (Date.now() - started > ms) throw new Error('timeout: ' + label);
      await sleep(300);
    }
  }

  function workspace() {
    return E2E_WS;
  }

  async function startTaskViaUI(goal, wsPath) {
    document.getElementById('tab-tasks').click();
    document.getElementById('task-new').open = true;
    document.getElementById('task-goal').value = goal;
    document.getElementById('task-workspace').value = wsPath;
    document.getElementById('task-start').click();
    await sleep(300);
  }

  async function latestTaskWith(text) {
    const list = await SKF_IPC2.rpc2('task.list', { limit: 30 });
    return (list.tasks || []).find((t) => t.kind === 'task' && (t.goal || '').includes(text)) || null;
  }

  async function marker(id, payload) {
    const goal = 'E2E-REPORT ' + JSON.stringify(payload).slice(0, 3600);
    await SKF_IPC2.rpc2('task.start', { id, input: { goal }, workspaceRoot: workspace() });
  }

  async function main() {
    await waitFor(() => window.SKF_UI && window.SKF_UI.state && window.SKF_UI.state.ready === true, 90000, 'ready');
    check('T01 UI 就绪', true);
    // 启动心跳：让 Node 侧区分「应用/桥没起来」与「探针中途失败」。
    await marker('e2e-marker-0', { boot: 1, at: Date.now() });
    SKF_IPC2.onSkfEvent((e) => push.push({ seq: e.eventSeq, type: e.type, taskId: e.taskId }));

    const ping = await SKF_IPC2.rpc2('ping');
    check('T02 v2 ping 经 Rust 桥', ping.provider === 'fake' && ping.model === 'fake-scripted', ping.provider + '/' + ping.model);

    // ── A：报价文件任务（从真实 UI 表单发起）──
    await startTaskViaUI('在工作区创建报价说明 Markdown', workspace());
    const taskA = await waitFor(() => latestTaskWith('报价说明'), 15000, 'task A listed');
    quoteId = taskA.id;
    await waitFor(() => push.some((e) => e.taskId === quoteId && e.type === 'task.succeeded'), 30000, 'A succeeded push');
    check('T03 skf-event 推送 task.succeeded 到达', true, quoteId);
    check('T04 推送含 task.model_step 阶段进度', push.some((e) => e.taskId === quoteId && e.type === 'task.model_step'));
    const seqs = push.map((e) => e.seq);
    check('T05 推送 eventSeq 严格递增', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'n=' + seqs.length);

    const domA = await waitFor(() => {
      const card = document.getElementById('task-card-' + quoteId);
      if (!card) return null;
      const badge = card.querySelector('.badge');
      const art = card.querySelector('.artifact');
      if (!art) return null;
      return {
        badge: badge ? badge.textContent : '',
        verified: art.querySelector('.badge') ? art.querySelector('.badge').textContent : '',
        path: art.querySelector('.path') ? art.querySelector('.path').textContent : '',
      };
    }, 15000, 'A card detail');
    check('T06 任务卡显示已完成', domA.badge === '已完成', domA.badge);
    check('T07 产物显示已校验徽章', domA.verified === '已校验' && domA.path === 'quote.md', domA.verified + ' ' + domA.path);

    const gotA = await SKF_IPC2.rpc2('task.get', { taskId: quoteId });
    check('T08 artifact 登记含 sha256/verifiedAt', !!gotA.artifacts[0].sha256 && !!gotA.artifacts[0].verifiedAt);
    const fullA = gotA.task.workspaceRoot.replace(/[\\/]+$/, '') + '\\' + gotA.artifacts[0].relativePath;
    const opened = await __TAURI__.core.invoke('open_artifact', { path: fullA }).then(() => 'ok').catch((e) => 'err:' + e);
    check('T09 open_artifact 打开真实文件', opened === 'ok', opened);
    const openBad = await __TAURI__.core.invoke('open_artifact', { path: 'https://evil.example/x' }).then(() => 'opened').catch((e) => String(e));
    check('T10 open_artifact 拒绝 URL', /INVALID_PATH|PATH_NOT_FOUND/.test(openBad), openBad);

    const budgetA = await SKF_IPC2.rpc2('budget.status', { taskId: quoteId });
    check('T11 budget.status 本任务 2 次调用', budgetA.task && budgetA.task.calls === 2, JSON.stringify(budgetA.task));
    check('T12 预算胶囊显示今日与次数', /今日/.test(document.getElementById('budget-pill').textContent), document.getElementById('budget-pill').textContent.slice(0, 50));

    // ── LP：长中文嵌套路径产物 ──
    await startTaskViaUI('长路径交付测试', workspace());
    const taskLP = await waitFor(() => latestTaskWith('长路径'), 15000, 'LP listed');
    await waitFor(() => push.some((e) => e.taskId === taskLP.id && e.type === 'task.succeeded'), 30000, 'LP succeeded');
    const gotLP = await SKF_IPC2.rpc2('task.get', { taskId: taskLP.id });
    const lpPath = gotLP.artifacts[0] ? gotLP.artifacts[0].relativePath : '';
    check('T13 长中文路径产物登记', /报价说明-最终确认版\.md$/.test(lpPath), lpPath.slice(-40));

    // ── B：取消慢任务 ──
    await startTaskViaUI('慢任务取消测试', workspace());
    const taskB = await waitFor(() => latestTaskWith('慢任务'), 15000, 'B listed');
    await waitFor(() => push.some((e) => e.taskId === taskB.id && e.type === 'task.running'), 15000, 'B running');
    const cancelBtn = await waitFor(() => {
      const card = document.getElementById('task-card-' + taskB.id);
      return card ? card.querySelector('button.danger') : null;
    }, 15000, 'B cancel button');
    cancelBtn.click();
    await waitFor(() => push.some((e) => e.taskId === taskB.id && e.type === 'task.cancelled'), 20000, 'B cancelled push');
    check('T14 取消事件推送到达且收敛', true, taskB.id);

    // ── 错误中文映射 ──
    await startTaskViaUI('错误映射测试', workspace() + '\\no-such-dir-xyz');
    const errBox = await waitFor(() => document.querySelector('#task-new .error-box'), 10000, 'error box');
    check('T15 错误中文映射含下一步', /工作目录无效或不存在/.test(errBox.textContent) && /下一步/.test(errBox.textContent), errBox.textContent.slice(0, 50));

    // ── 聊天：长中文 + 代码块 sanitize + Enter 发送 ──
    document.getElementById('tab-chat').click();
    await sleep(400);
    const input = document.getElementById('message');
    const diag = { ready: window.SKF_UI.state.ready, disabled: input.disabled };
    check('T16a 聊天输入就绪', diag.ready === true && diag.disabled === false, JSON.stringify(diag));
    input.value = '给我一段代码';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const chatOutcome = await waitFor(() => {
      if (document.querySelector('#chat-thread .msg.bot pre code')) return 'code';
      const err = document.querySelector('#chat-thread .error-box');
      if (err) return 'err:' + err.textContent;
      return '';
    }, 50000, 'chat outcome').catch((e) => 'timeout:' + document.getElementById('chat-thread').textContent.slice(0, 150));
    check('T16 聊天代码块渲染', chatOutcome === 'code', String(chatOutcome).slice(0, 90));
    check('T17 模型输出脚本未注入', !document.querySelector('#chat-thread script'));
    check('T18 脚本以转义文本显示', document.getElementById('chat-thread').innerHTML.includes('&lt;script&gt;'));

    // ── 记忆页 ──
    document.getElementById('tab-memory').click();
    await waitFor(() => document.getElementById('mem-header').textContent.includes('skf-e2e'), 15000, 'mem header');
    check('T19 记忆页头部项目范围', true);
    document.getElementById('mem-query').value = '报价';
    document.getElementById('mem-search-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => document.querySelectorAll('#mem-results .mem-hit').length > 0, 15000, 'mem hits');
    const trust = document.querySelector('#mem-results .mem-hit .badges').textContent;
    check('T20 记忆搜索命中任务写回记录', true);
    check('T21 记录信任级别徽章', /用户确认|工具观察|历史记录|候选/.test(trust), trust.slice(0, 40));
    [...document.querySelectorAll('#mem-header button')].find((b) => b.textContent.includes('备份')).click();
    await waitFor(() => {
      const r = document.getElementById('mem-backup-result');
      return r && !r.hidden && r.textContent.includes('备份完成');
    }, 20000, 'backup');
    check('T22 记忆页备份成功', true);

    // 归档探针：同时是 memory.archive 写路径验证 + 给 Node 侧的精简信号
    const hits = await SKF_IPC2.rpc2('memory.search', { query: '报价', limit: 1 });
    const archiveReason = 'E2E ok=' + report.filter((r) => r.ok).length + '/' + report.length + ' seq=' + SKF_IPC2.lastEventSeq;
    const archived = await SKF_IPC2.rpc2('memory.archive', { ids: [hits.hits[0].id], reason: archiveReason }).then(() => 'ok').catch((e) => String(e));
    check('T23 memory.archive 写路径', archived === 'ok', archived);

    await sleep(4000); // 给 Node 侧时间截记忆页

    // ── 报告（marker 任务 → runtime.sqlite tasks.input）──
    document.getElementById('tab-tasks').click();
    await waitFor(() => document.getElementById('task-card-' + quoteId), 10000, 'quote card back');
    if (!document.getElementById('task-detail-' + quoteId)) {
      const card = document.getElementById('task-card-' + quoteId);
      const toggle = [...card.querySelectorAll('button')].find((b) => b.textContent === '详情');
      if (toggle) toggle.click();
    }
    await sleep(1200);
    try { await SKF_IPC2.resyncSkfEvents(); } catch { /* 补发失败不影响报告 */ }
    const lastSeq = SKF_IPC2.lastEventSeq;
    await marker('e2e-marker-1', {
      v: 1,
      seq: lastSeq,
      vw: window.innerWidth,
      sw: document.documentElement.scrollWidth,
      report,
    });

    // ── 等 Node 调整窗口到 960×600，回报溢出情况 ──
    const resized = await waitFor(() => window.innerWidth <= 1000, 90000, 'resize to 960').catch(() => false);
    await sleep(900);
    await marker('e2e-marker-2', {
      resized: !!resized,
      vw: window.innerWidth,
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    });
  }

  main().catch(async (error) => {
    check('T00 探针流程中断', false, error.message);
    try { await marker('e2e-marker-1', { v: 1, seq: window.SKF_IPC2 ? SKF_IPC2.lastEventSeq : -1, report, crashed: true }); } catch { /* 桥也坏了则由 Node 超时兜底 */ }
  });
})();
