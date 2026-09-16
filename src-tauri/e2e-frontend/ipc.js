'use strict';

/**
 * SKF UI 共享内核：桥接、事件中心、错误中文映射、格式化、页头状态。
 * 依赖 markdown.js 的 SKF_MARKDOWN（escapeHtml）。chat/tasks/memory 三个视图挂到 window.SKF_VIEWS。
 */

const MD = window.SKF_MARKDOWN;

// ── 错误中文映射：每个码都给「发生了什么 + 下一步怎么办」──────────────

const ERROR_TEXT = {
  TAURI_BRIDGE_MISSING: ['桌面桥不可用', '请从 SKF 桌面应用打开；浏览器预览只能看样式。'],
  PROTOCOL_MISMATCH: ['桌面桥版本不匹配', '请重启应用；仍不行则重新安装同一版本。'],
  REQUEST_FAILED: ['请求未完成', '检查连接后再试；反复失败请看日志。'],
  PARSE_ERROR: ['请求格式不被接受', '请重启应用；这是程序内部问题，可反馈。'],
  FRAME_TOO_LARGE: ['单条消息太大', '缩短内容后再试。'],
  BUSY: ['上一项仍在进行', '等它完成，或先取消在途任务。'],
  INVALID_INPUT: ['输入不被接受', '检查填写内容（长度/格式）后再试。'],
  INVALID_MESSAGE: ['消息为空或太长', '消息需在 16000 字以内。'],
  TASK_NOT_FOUND: ['任务不存在', '可能来自旧数据；刷新列表。'],
  TASK_TERMINAL: ['任务已结束', '终态任务不能再操作；可新建任务。'],
  TASK_CANCELLED: ['任务已取消', '如需重做，请新建任务。'],
  INVALID_TRANSITION: ['任务状态不允许这个操作', '刷新界面看最新状态。'],
  PROVIDER_NOT_CONFIGURED: ['当前大脑还没配置（缺 API Key）', '配置后再试，或切到已配置的大脑。'],
  PROVIDER_UNAVAILABLE: ['这个大脑不可用（未配置或未验证）', '换大脑，或检查它的配置。'],
  PROVIDER_NOT_WHITELISTED: ['不在允许的大脑名单里', '选择列表中的大脑。'],
  PROVIDER_NOT_VERIFIED: ['大脑尚未通过连通验证', '检查网络/代理后再试。'],
  PROVIDER_AUTH_FAILED: ['大脑拒绝了 API Key', '检查密钥是否正确、是否过期。'],
  PROVIDER_RATE_LIMITED: ['模型限流', '稍等片刻再试。'],
  PROVIDER_TIMEOUT: ['模型响应超时', '检查网络后重试。'],
  PROVIDER_DEADLINE_EXCEEDED: ['模型超过时限未响应', '重试；反复出现换更快的大脑。'],
  PROVIDER_UNREACHABLE: ['连不上模型服务', '检查网络/代理设置。'],
  PROVIDER_SERVER_ERROR: ['模型服务自身出错', '稍后再试。'],
  PROVIDER_BAD_REQUEST: ['模型拒绝了请求内容', '缩短或改写任务描述后再试。'],
  PROVIDER_ABORTED: ['已按你的取消中断', '这次调用没有重发；费用记为待核对，不记免费。'],
  MODEL_REQUEST_FAILED: ['模型调用失败，未自动重试', '检查连接后再试。'],
  EMPTY_RESPONSE: ['模型返回空内容，未自动重试', '换个问法或稍后再试。'],
  DAILY_CALL_LIMIT: ['今天云端调用次数已到上限', '明天自动恢复，或调高每日次数上限。'],
  CALL_LIMIT_EXCEEDED: ['云端调用次数到上限', '明天自动恢复，或调整上限。'],
  DAILY_BUDGET_EXCEEDED: ['今日预算不足', '本次未发起调用；调高每日预算或改小任务。'],
  BUDGET_EXCEEDED: ['预算不足', '本次未发起调用；调整预算或改小任务。'],
  BUDGET_UNAVAILABLE: ['预算模块不可用', '重启应用；这是保护性停止，不会扣费。'],
  BUDGET_REAUTH_REQUIRED: ['恢复前需要重新授权预算', '勾选预算授权后再恢复。'],
  TARIFF_NOT_CONFIGURED: ['严格金额模式缺少该模型价目', '配置价目，或把预算模式改为按次数。'],
  LOCAL_ONLY_MODE: ['当前是仅本地模式', '云模型被禁用；切回正常预算模式。'],
  EXPENSIVE_UPGRADE_NOT_AUTHORIZED: ['贵模型未获授权', '在任务策略里显式授权后再用。'],
  CONTEXT_BUDGET_EXCEEDED: ['任务上下文太大', '缩小任务范围或删减参考资料。'],
  TASK_INTERRUPTED: ['任务被中断（如应用退出），没有自动重试', '核对状态后可手动恢复；费用不确定的调用不会重发。'],
  MODEL_CALL_UNCERTAIN_REVIEW: ['上次模型调用费用不确定', '请核对后勾选确认再恢复；系统不会自动重发同一请求。'],
  RECOVERY_NEEDS_MANUAL_REVIEW: ['有操作的实际结果未知（可能已生效）', '先人工核对文件/外部系统，再在任务里标记核对结果。'],
  RESUME_INPUT_MISMATCH: ['任务输入已被改动', '为安全起见不恢复；可新建任务。'],
  RESUME_CANCEL_INTENT: ['存在未完成的取消意图', '任务保持取消；如需重做请新建。'],
  RESUME_WORKSPACE_MISSING: ['工作目录不存在了', '恢复目录或新建任务。'],
  RESUME_ARTIFACT_MISMATCH: ['产物文件与记录不一致（可能被改过）', '人工核对文件后再决定。'],
  APPROVAL_NOT_FOUND: ['审批不存在或已处理', '刷新任务看最新状态。'],
  APPROVAL_EXPIRED: ['审批已过期', '不会自动通过；重新发起操作。'],
  APPROVAL_INPUT_CONFLICT: ['审批内容与登记不一致', '已拒绝转移批准；请重新审查。'],
  WORKSPACE_INVALID: ['工作目录无效或不存在', '填一个真实存在的目录绝对路径。'],
  POLICY_DENIED: ['任务授权不允许这个操作', '检查任务授权范围。'],
  TOOL_UNAVAILABLE: ['这个工具当前不可用', '外部写入/进程执行未开放；用工作区内文件任务。'],
  ACCEPTANCE_NOT_MET: ['模型声称完成但验收证据不足', '没有标记完成；可让它补充或人工核对。'],
  NO_PROGRESS: ['任务连续没有新进展，已停止', '避免浪费；换个描述重试。'],
  MEMORY_UNAVAILABLE: ['记忆主档暂时不可用', '不阻塞使用；写回会在恢复后自动补投。'],
  MEMORY_WRITEBACK_QUEUED: ['记忆写回已排队', '主档恢复后自动补投，无需操作。'],
  MEMORY_BACKUP_FAILED: ['记忆备份失败', '检查数据盘剩余空间后再试。'],
  LEASE_HELD: ['另一个 SKF 实例正在运行此任务', '关闭另一个实例，或等租约过期。'],
  IPC_V2_UNAVAILABLE: ['任务通道未就绪', '重启应用。'],
  PROTOCOL_VERSION_UNSUPPORTED: ['协议版本不支持', '应用与内核版本不匹配，请使用同一版本。'],
  OPERATION_NOT_FOUND: ['要核对的操作不存在', '刷新任务看最新状态。'],
  PATH_NOT_FOUND: ['文件不存在（可能已被移动或删除）', '刷新任务产物列表。'],
  NOT_A_FILE: ['目标不是普通文件', '只能打开文件。'],
};

/** 统一错误展示：{text, next}；未知码原样显示但给通用下一步。 */
function friendlyError(error) {
  const code = String(error && error.message ? error.message : error || '');
  const hit = ERROR_TEXT[code];
  if (hit) return { code, text: hit[0], next: hit[1] };
  return { code, text: code || '未知错误', next: '重试；反复出现请反馈这段文字。' };
}

// ── 格式化 ─────────────────────────────────────────────────────────

/** 微美元 → 人类可读。null/undefined = 金额未知（绝不显示成 $0）。 */
function formatMicros(micros) {
  if (micros === null || micros === undefined) return '金额未知';
  const usd = micros / 1_000_000;
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return '$' + usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

const TASK_STATE_TEXT = {
  queued: '排队中', running: '运行中', waiting_provider: '等待模型', waiting_approval: '待确认',
  cancelling: '取消中', cancelled: '已取消', succeeded: '已完成', failed: '失败', interrupted: '已中断',
};
const IN_FLIGHT_STATES = ['queued', 'running', 'waiting_provider', 'waiting_approval', 'cancelling'];

// ── Tauri 桥 ───────────────────────────────────────────────────────

const invoke = () => window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

async function rpc(action, data = {}) {
  const inv = invoke();
  if (!inv) throw new Error('TAURI_BRIDGE_MISSING');
  const response = await inv('call_supervisor', { request: { id: crypto.randomUUID(), action, data } });
  if (!response || !response.ok) throw new Error((response && response.error) || 'REQUEST_FAILED');
  return response.data;
}

async function rpc2(action, data = {}) {
  const inv = invoke();
  if (!inv) throw new Error('TAURI_BRIDGE_MISSING');
  const response = await inv('call_supervisor', { request: { id: crypto.randomUUID(), action, data, protocol: 2 } });
  if (!response || !response.ok) throw new Error((response && response.error) || 'REQUEST_FAILED');
  return response.data;
}

// ── 事件中心（eventSeq 去重；断线 events.since 补齐；权威是 events 表）──

const skfEventListeners = new Set();
let lastEventSeq = 0;

function dispatchSkfEvent(event) {
  const seq = Number(event && event.eventSeq);
  if (!Number.isSafeInteger(seq)) return;
  if (seq <= lastEventSeq) return; // 去重：同一事件只生效一次
  lastEventSeq = seq;
  for (const fn of [...skfEventListeners]) {
    try { fn(event); } catch { /* 监听者错误不影响事件流 */ }
  }
}

function onSkfEvent(fn) {
  skfEventListeners.add(fn);
  return () => skfEventListeners.delete(fn);
}

/**
 * 断线/刷新后按 lastEventSeq 补发。积压超过一页时直接快进到 latestSeq：
 * 事件只驱动增量刷新，任务真实状态以 task.get/task.list 为准，不丢正确性。
 */
async function resyncSkfEvents() {
  const result = await rpc2('events.since', { afterSeq: lastEventSeq, limit: 1000 });
  const events = result.events || [];
  for (const event of events) dispatchSkfEvent(event);
  if (typeof result.latestSeq === 'number' && result.latestSeq > lastEventSeq) {
    lastEventSeq = result.latestSeq; // 积压快进：状态由任务查询兜底
  }
  return result;
}

if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
  window.__TAURI__.event.listen('skf-event', (e) => dispatchSkfEvent(e.payload));
}

// ── 页头：连接状态 + 预算 + 当前大脑 ────────────────────────────────

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  budgetPill: document.getElementById('budget-pill'),
  modelSelect: document.getElementById('model-select'),
  modelCurrent: document.getElementById('model-current'),
  modelHint: document.getElementById('model-hint'),
  bridgeWarn: document.getElementById('bridge-warn'),
};

const state = {
  ready: false,
  ping: null, // 最近一次 v2 ping 数据
};

function setStatus(kind, text) {
  els.status.classList.remove('ready', 'error');
  if (kind) els.status.classList.add(kind);
  els.statusText.textContent = text;
}

const BUDGET_MODE_TEXT = {
  'strict-money': '按金额', 'call-limit': '按次数', 'local-only': '仅本地',
};

/** 预算胶囊：已知估算 / 预留 / 待结算 / 剩余；金额未知明示，缓存折扣非承诺。 */
function renderBudgetPill(ping) {
  const pill = els.budgetPill;
  const budget = ping && ping.budget;
  if (!budget) {
    pill.innerHTML = '<b>预算</b> 不可用';
    pill.title = '预算模块不可用（保护性停止，不会扣费）';
    return;
  }
  const daily = budget.daily || { spent: 0, reserved: 0, uncertain: 0, calls: 0 };
  const parts = [`<b>今日</b> 已用 ${formatMicros(daily.spent)}`];
  if (daily.reserved > 0) parts.push(`预留 ${formatMicros(daily.reserved)}`);
  if (daily.uncertain > 0) parts.push(`待核对 ${formatMicros(daily.uncertain)}`);
  const callLimit = ping.dailyCloudCallLimit;
  if (typeof callLimit === 'number') {
    parts.push(`次数 ${ping.cloudCallsToday ?? daily.calls}/${callLimit}`);
  } else {
    parts.push(`次数 ${ping.cloudCallsToday ?? daily.calls}`);
  }
  pill.innerHTML = parts.join(' · ');
  const moneyLimit = ping.dailyMoneyLimitMicros;
  const remain = typeof moneyLimit === 'number' ? `剩余约 ${formatMicros(Math.max(0, moneyLimit - daily.spent - daily.reserved - daily.uncertain))}` : '未设金额上限';
  pill.title = [
    `预算模式：${BUDGET_MODE_TEXT[budget.mode] || budget.mode}`,
    `已用/预留/待核对是按配置价目的估算（缓存命中可能有折扣，非供应商账单承诺）；${remain}。`,
    daily.uncertain > 0 ? '待核对 = 调用结果不确定，保守占位，绝不记成免费。' : '',
  ].filter(Boolean).join('\n');
}

function renderModelRow(ping) {
  if (els.modelCurrent) {
    els.modelCurrent.textContent = ping.model ? `当前模型 ${ping.model}` : `当前 ${ping.provider}`;
  }
  if (els.modelSelect && ping.provider && [...els.modelSelect.options].some((o) => o.value === ping.provider)) {
    els.modelSelect.value = ping.provider;
  }
}

async function refreshPing() {
  const ping = await rpc2('ping');
  state.ping = ping;
  state.ready = ping.status === 'ready';
  setStatus(
    state.ready ? 'ready' : 'error',
    state.ready
      ? `已连接 · ${ping.provider} · v${ping.version}${ping.configured === false ? ' · 模型未配置' : ''}`
      : '未就绪',
  );
  renderBudgetPill(ping);
  renderModelRow(ping);
  document.querySelectorAll('[data-needs-ready]').forEach((el) => { el.disabled = !state.ready; });
  return ping;
}

async function health() {
  try {
    await refreshPing();
  } catch (error) {
    state.ready = false;
    const fe = friendlyError(error);
    setStatus('error', fe.text);
    if (!invoke()) els.bridgeWarn.hidden = false;
  }
}

// 模型切换：只影响下一任务；在途任务持自己的 provider/model 快照（M03），提示不改。
if (els.modelSelect) {
  els.modelSelect.addEventListener('change', async () => {
    if (!state.ready) return;
    const target = els.modelSelect.value;
    els.modelSelect.disabled = true;
    try {
      const result = await rpc('provider', { name: target });
      const ping = await refreshPing();
      let inFlight = 0;
      try {
        const list = await rpc2('task.list', { limit: 50 });
        inFlight = (list.tasks || []).filter((t) => t.kind !== 'chat' && IN_FLIGHT_STATES.includes(t.state)).length;
      } catch { /* 列表失败不影响切换 */ }
      if (els.modelHint) {
        els.modelHint.hidden = false;
        els.modelHint.textContent = inFlight > 0
          ? `已切换 · 在途 ${inFlight} 个任务仍用原模型，新任务起用 ${ping.model || result.provider}`
          : `已切换 · 新任务起用 ${ping.model || result.provider}`;
      }
    } catch (error) {
      if (els.modelSelect && state.ping) els.modelSelect.value = state.ping.provider;
      const fe = friendlyError(error);
      setStatus('error', fe.text);
      if (els.modelHint) { els.modelHint.hidden = false; els.modelHint.textContent = fe.next; }
    } finally {
      els.modelSelect.disabled = false;
    }
  });
}

// ── 页签切换 ───────────────────────────────────────────────────────

const tabs = {
  chat: { btn: document.getElementById('tab-chat'), view: document.getElementById('view-chat') },
  tasks: { btn: document.getElementById('tab-tasks'), view: document.getElementById('view-tasks') },
  memory: { btn: document.getElementById('tab-memory'), view: document.getElementById('view-memory') },
};
let activeTab = 'chat';
function switchTab(name) {
  activeTab = name;
  for (const [key, tab] of Object.entries(tabs)) {
    tab.btn.classList.toggle('active', key === name);
    tab.view.hidden = key !== name;
  }
  if (window.SKF_VIEWS && window.SKF_VIEWS[name] && window.SKF_VIEWS[name].onShow) {
    window.SKF_VIEWS[name].onShow();
  }
}
for (const [name, tab] of Object.entries(tabs)) {
  tab.btn.addEventListener('click', () => switchTab(name));
}

/** 任务页签角标：在途任务数。 */
function setTasksBadge(count) {
  const badge = document.getElementById('tab-tasks-badge');
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

// ── 导出 ───────────────────────────────────────────────────────────

window.SKF_IPC2 = {
  rpc, rpc2, onSkfEvent, resyncSkfEvents,
  get lastEventSeq() { return lastEventSeq; },
};
window.SKF_UI = {
  MD, friendlyError, formatMicros, formatBytes, formatTime,
  TASK_STATE_TEXT, IN_FLIGHT_STATES,
  state, health, refreshPing, switchTab, setTasksBadge,
  get activeTab() { return activeTab; },
};

window.SKF_VIEWS = window.SKF_VIEWS || {};

// ── 启动：连接 → 事件补发 → 各视图初始化（终态从持久任务恢复）──────

document.addEventListener('DOMContentLoaded', async () => {
  await health();
  try {
    await resyncSkfEvents();
  } catch { /* 补发失败不阻塞；推送与查询仍会工作 */ }
  for (const view of Object.values(window.SKF_VIEWS)) {
    if (view && typeof view.init === 'function') {
      try { await view.init(); } catch { /* 单视图失败不影响其他 */ }
    }
  }
});
