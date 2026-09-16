'use strict';

/**
 * 预算面板：预算四态 + 已用/预留/待核对 + 统计周期 + 限制说明。
 * 四态是视觉提示；最终以后端校验为准。预算未知是数据获取状态，不是第五种业务状态。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2 } = window.SKF_IPC2;
  const { friendlyError, formatMicros, BUDGET_MODE_TEXT, BUDGET_STATE_TEXT } = UI;

  const panel = document.getElementById('budget-panel');

  function stateClass(st) {
    return 'budget-card b-' + st;
  }

  function row(k, v) {
    const r = document.createElement('div');
    r.className = 'row';
    const kk = document.createElement('span');
    kk.className = 'k';
    kk.textContent = k;
    const vv = document.createElement('span');
    vv.className = 'v';
    vv.textContent = v;
    r.append(kk, vv);
    return r;
  }

  async function load() {
    panel.innerHTML = '<div class="empty-block">读取预算…</div>';
    let status;
    try {
      status = await rpc2('budget.status');
    } catch (error) {
      const fe = friendlyError(error);
      panel.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'error-box';
      box.textContent = fe.code === 'BUDGET_UNAVAILABLE' ? '预算模块不可用（保护性停止，不会扣费）。' : fe.text + '。' + fe.next;
      panel.appendChild(box);
      return;
    }
    const ping = UI.state.ping || {};
    const daily = status.daily || { spent: 0, reserved: 0, uncertain: 0, calls: 0 };
    const moneyLimit = ping.dailyMoneyLimitMicros;
    const callLimit = ping.dailyCloudCallLimit;
    const full = { ...status, dailyMoneyLimitMicros: moneyLimit, dailyCallLimit: callLimit };
    const st = UI.budgetStateOf(full);
    const [stText, stNext] = BUDGET_STATE_TEXT[st];

    panel.innerHTML = '';
    const card = document.createElement('div');
    card.className = stateClass(st);
    const stateLine = document.createElement('div');
    stateLine.className = 'state';
    const pill = document.createElement('span');
    pill.className = 'pill';
    const stateText = document.createElement('span');
    stateText.textContent = stText;
    stateLine.append(pill, stateText);
    card.appendChild(stateLine);

    const explain = document.createElement('div');
    explain.className = 'hint';
    explain.style.marginTop = '4px';
    explain.textContent = stNext + '（最终以后端校验为准）';
    card.appendChild(explain);

    const rows = document.createElement('div');
    rows.className = 'rows';
    rows.appendChild(row('预算模式', BUDGET_MODE_TEXT[status.mode] || status.mode));
    rows.appendChild(row('统计周期', `${status.day || '—'}（Asia/Shanghai 跨日）`));
    rows.appendChild(row('已结算估算', formatMicros(daily.spent)));
    rows.appendChild(row('预留', formatMicros(daily.reserved)));
    rows.appendChild(row('待核对', formatMicros(daily.uncertain)));
    rows.appendChild(row('今日调用次数', String(daily.calls)));
    rows.appendChild(row('金额上限', typeof moneyLimit === 'number' ? formatMicros(moneyLimit) : '未设金额上限'));
    rows.appendChild(row('次数上限', typeof callLimit === 'number' ? String(callLimit) : '未设次数上限'));
    if (typeof moneyLimit === 'number') {
      rows.appendChild(row('剩余约', formatMicros(Math.max(0, moneyLimit - daily.spent - daily.reserved - daily.uncertain))));
    }
    card.appendChild(rows);

    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginTop = '10px';
    note.textContent = '已用/预留/待核对是按配置价目的估算（缓存命中可能有折扣，非供应商账单承诺）；待核对 = 调用结果不确定，保守占位，绝不记成免费。金额上限未配置时不虚构。';
    card.appendChild(note);

    panel.appendChild(card);
  }

  window.SKF_VIEWS.budget = {
    init() { return load(); },
    onShow() { load().catch(() => {}); },
  };
})();
