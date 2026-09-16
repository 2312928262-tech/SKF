'use strict';

/**
 * SKF 控制台共享内核：Tauri 桥、事件中心、错误中文映射、格式化、状态管理、
 * 顶部状态栏（连接/预算/上下文/审批）、侧边导航、会话状态与 scope 隔离协调。
 * 各视图挂到 window.SKF_VIEWS；共享状态在 window.SKF_UI.state。
 */

const MD = window.SKF_MARKDOWN;

// ── 错误中文映射：每个码都给「发生了什么 + 下一步怎么办」──────────────

const ERROR_TEXT = {
  TAURI_BRIDGE_MISSING: ['桌面桥不可用', '请从 SKF 桌面应用打开；浏览器预览只能看样式。'],
  PROTOCOL_MISMATCH: ['桌面桥版本不匹配', '请重启应用；仍不行则重新安装同一版本。'],
  REQUEST_FAILED: ['请求未完成', '检查连接后再试；反复失败请看日志。'],
  PARSE_ERROR: ['请求格式不被接受', '请重启应用；这是程序内部问题，可反馈。'],
  FRAME_TOO_LARGE: ['单条消息太大', '缩短内容后再试。'],
  BUSY: ['这个会话已有在途请求', '等它完成，或先取消在途任务。'],
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
  SESSION_NOT_FOUND: ['会话不存在', '可能已被归档或删除；刷新会话列表。'],
  SESSION_EXISTS: ['会话标识冲突', '换一个会话名重试；不要重复提交。'],
  SCHEDULE_NOT_FOUND: ['定时任务不存在', '刷新列表。'],
  FIRING_NOT_FOUND: ['触发记录不存在', '刷新列表。'],
  INVALID_CRON: ['cron 表达式不合法', '检查表达式（如 0 18 * * *）。'],
  INVALID_TIMEZONE: ['时区名不合法', '使用 IANA 时区名，如 Asia/Shanghai。'],
  SCHEDULE_DISABLED: ['定时任务已停用', '启用后再手动触发。'],
  LEARNING_DISABLED: ['学习功能未开启', '影子模式未激活。'],
  EXPERIENCE_NOT_FOUND: ['经验不存在', '刷新列表。'],
  CHECKPOINT_BLOCKED: ['被硬检查点拦截', '任务没有通过检查，不能报告成功。'],
  CHECKPOINT_NOT_MET: ['未满足检查点', '先完成检查要求再继续。'],
};

/** 统一错误展示：{text, next}；未知码原样显示但给通用下一步。 */
function friendlyError(error) {
  const code = String(error && error.message ? error.message : error || '');
  const hit = ERROR_TEXT[code];
  if (hit) return { code, text: hit[0], next: hit[1] };
  return { code, text: code || '未知错误', next: '重试；反复出现请反馈这段文字。' };
}

// ── 格式化 ─────────────────────────────────────────────────────────

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

const BUDGET_MODE_TEXT = { 'strict-money': '按金额', 'call-limit': '按次数', 'local-only': '仅本地' };
const BUDGET_STATE_TEXT = {
  normal: ['预算充足', '正常展示可用操作'],
  warning: ['接近阈值', '提示剩余量，不擅自阻断'],
  limited: ['预算受限', '展示后端限制原因与允许操作'],
  blocked: ['预算已阻断', '禁用明确受限制操作，仍可查看历史'],
  unknown: ['预算未知', '数据获取状态，不是业务状态'],
};

// ── Tauri 桥 ───────────────────────────────────────────────────────

const invoke = () => (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || (window.SKF_TRANSPORT && window.SKF_TRANSPORT.invoke);

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

/** v1 调用（chat/provider/history），允许调用方指定请求 id（作幂等键/事件关联）。 */
async function rpcV1(action, data = {}, id) {
  const inv = invoke();
  if (!inv) throw new Error('TAURI_BRIDGE_MISSING');
  const reqId = id || crypto.randomUUID();
  const response = await inv('call_supervisor', { request: { id: reqId, action, data } });
  if (!response || !response.ok) throw new Error((response && response.error) || 'REQUEST_FAILED');
  return response.data;
}

// ── 事件中心（eventSeq 去重；断线 events.since 补齐；权威是 events 表）──

const skfEventListeners = new Set();
let lastEventSeq = 0;

function dispatchSkfEvent(event) {
  const seq = Number(event && event.eventSeq);
  if (!Number.isSafeInteger(seq)) return;
  if (seq <= lastEventSeq) return;
  lastEventSeq = seq;
  for (const fn of [...skfEventListeners]) {
    try { fn(event); } catch { /* 监听者错误不影响事件流 */ }
  }
}

function onSkfEvent(fn) {
  skfEventListeners.add(fn);
  return () => skfEventListeners.delete(fn);
}

async function resyncSkfEvents() {
  const result = await rpc2('events.since', { afterSeq: lastEventSeq, limit: 1000 });
  const events = result.events || [];
  for (const event of events) dispatchSkfEvent(event);
  if (typeof result.latestSeq === 'number' && result.latestSeq > lastEventSeq) {
    lastEventSeq = result.latestSeq;
  }
  return result;
}

if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
  window.__TAURI__.event.listen('skf-event', (e) => dispatchSkfEvent(e.payload));
}

// ── 全局状态 ───────────────────────────────────────────────────────

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  budgetPill: document.getElementById('budget-pill'),
  ctxPill: document.getElementById('ctx-pill'),
  approvalBadge: document.getElementById('approval-badge'),
  bridgeWarn: document.getElementById('bridge-warn'),
  footVersion: document.getElementById('foot-version'),
};

const state = {
  ready: false,
  ping: null,
  sessions: [],
  currentSessionId: null,
  showArchived: false,
  pendingApprovals: 0,
};

function setStatus(kind, text) {
  els.status.classList.remove('ready', 'error', 'warn');
  if (kind) els.status.classList.add(kind);
  els.statusText.textContent = text;
}

/** 预算四态（视觉提示；最终以后端校验为准；未知是数据获取状态）。 */
function budgetStateOf(status) {
  if (!status) return 'unknown';
  const daily = status.daily || {};
  let ratio = -1;
  if (typeof status.dailyMoneyLimitMicros === 'number' && status.dailyMoneyLimitMicros > 0) {
    const used = (daily.spent || 0) + (daily.reserved || 0) + (daily.uncertain || 0);
    ratio = Math.max(ratio, used / status.dailyMoneyLimitMicros);
  }
  if (typeof status.dailyCallLimit === 'number' && status.dailyCallLimit > 0) {
    ratio = Math.max(ratio, (daily.calls || 0) / status.dailyCallLimit);
  }
  if (ratio < 0) return 'normal';
  if (ratio >= 1) return 'blocked';
  if (ratio >= 0.85) return 'limited';
  if (ratio >= 0.6) return 'warning';
  return 'normal';
}

function renderBudgetPill(ping) {
  const pill = els.budgetPill;
  const budget = ping && ping.budget;
  pill.className = 'chip';
  if (!budget) {
    pill.textContent = '预算不可用';
    pill.title = '预算模块不可用（保护性停止，不会扣费）';
    return;
  }
  const st = budgetStateOf(budget);
  pill.classList.add('budget-' + st);
  const daily = budget.daily || { spent: 0, reserved: 0, uncertain: 0, calls: 0 };
  const parts = [`已用 ${formatMicros(daily.spent)}`];
  if (daily.reserved > 0) parts.push(`预留 ${formatMicros(daily.reserved)}`);
  if (daily.uncertain > 0) parts.push(`待核对 ${formatMicros(daily.uncertain)}`);
  const callLimit = ping.dailyCloudCallLimit;
  parts.push(`次数 ${ping.cloudCallsToday ?? daily.calls}${typeof callLimit === 'number' ? '/' + callLimit : ''}`);
  pill.textContent = '预算 ' + parts.join(' · ');
  const [stText, stNext] = BUDGET_STATE_TEXT[st];
  const moneyLimit = ping.dailyMoneyLimitMicros;
  const remain = typeof moneyLimit === 'number' ? `剩余约 ${formatMicros(Math.max(0, moneyLimit - daily.spent - daily.reserved - daily.uncertain))}` : '未设金额上限';
  pill.title = [
    `预算模式：${BUDGET_MODE_TEXT[budget.mode] || budget.mode}；状态：${stText}（${stNext}）`,
    `已用/预留/待核对是按配置价目的估算（缓存命中可能有折扣，非供应商账单承诺）；${remain}。`,
    daily.uncertain > 0 ? '待核对 = 调用结果不确定，保守占位，绝不记成免费。' : '',
  ].filter(Boolean).join('\n');
}

function renderCtxPill() {
  const s = currentSession();
  if (!s) {
    els.ctxPill.textContent = '上下文读取中…';
    els.ctxPill.title = '';
    return;
  }
  els.ctxPill.textContent = `会话 ${s.name}`;
  els.ctxPill.title = `会话 ID：${s.id}\nscope：${s.scope}\n${s.archived ? '（已归档）' : ''}`;
}

function renderApprovalBadge() {
  const n = state.pendingApprovals;
  els.approvalBadge.textContent = `待审批 ${n}`;
  els.approvalBadge.classList.toggle('has-pending', n > 0);
}

function currentSession() {
  return state.sessions.find((s) => s.id === state.currentSessionId) || null;
}

async function refreshSessions() {
  let list;
  try {
    list = await rpc2('session.list', { limit: 100, ...(state.showArchived ? { archived: true } : {}) });
  } catch (error) {
    // 会话列表不可读不阻塞其余视图
    return;
  }
  state.sessions = list.sessions || [];
  if (!state.currentSessionId || !state.sessions.some((s) => s.id === state.currentSessionId)) {
    state.currentSessionId = state.sessions.length ? state.sessions[0].id : null;
  }
  renderCtxPill();
  const ev = new CustomEvent('skf:sessions', { detail: { sessions: state.sessions } });
  document.dispatchEvent(ev);
  return state.sessions;
}

async function switchSession(id) {
  if (!id || state.currentSessionId === id) return;
  state.currentSessionId = id;
  renderCtxPill();
  document.dispatchEvent(new CustomEvent('skf:session-switched', { detail: { sessionId: id } }));
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
  if (els.footVersion) els.footVersion.textContent = ping.version || '…';
  renderBudgetPill(ping);
  renderModelRow(ping);
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

function renderModelRow(ping) {
  if (window.SKF_MANAGEMENT) {
    window.SKF_MANAGEMENT.call('GET', '/v1/models').then(registry => {
      const select = document.getElementById('model-select'); if (!select) return;
      select.replaceChildren();
      for (const model of registry.models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.modelId + '（新会话默认）'; select.append(option); }
      select.value = registry.defaultModelRef || ''; select.dataset.managedRevision = String(registry.revision); select.disabled = registry.models.length === 0;
    }).catch(() => {});
  }
  const sel = document.getElementById('model-select');
  const cur = document.getElementById('model-current');
  if (cur) {
    cur.textContent = ping.model ? `（当前 ${ping.model}）` : `（当前 ${ping.provider}）`;
  }
  if (sel && ping.provider && [...sel.options].some((o) => o.value === ping.provider)) {
    sel.value = ping.provider;
  }
}

// ── 侧边导航 ───────────────────────────────────────────────────────

const navItems = document.querySelectorAll('nav.sidebar button.nav-item');
let activeView = 'chat';

function switchView(name) {
  activeView = name;
  navItems.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  const view = window.SKF_VIEWS && window.SKF_VIEWS[name];
  if (view && typeof view.onShow === 'function') {
    try { view.onShow(); } catch { /* 单视图失败不影响导航 */ }
  }
}

navItems.forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

function setTasksBadge(count) {
  const badge = document.getElementById('nav-tasks-count');
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

// ── 审批中心协调 ───────────────────────────────────────────────────

function setApprovalCount(n) {
  state.pendingApprovals = Math.max(0, n);
  renderApprovalBadge();
}

els.approvalBadge.addEventListener('click', () => document.dispatchEvent(new CustomEvent('skf:open-approval')));
els.ctxPill.addEventListener('click', () => { if (activeView !== 'chat') switchView('chat'); });
els.budgetPill.addEventListener('click', () => switchView('budget'));

function openApprovalDrawer() {
  document.dispatchEvent(new CustomEvent('skf:open-approval'));
}

// ── 导出 ───────────────────────────────────────────────────────────

window.SKF_IPC2 = { rpc, rpc2, rpcV1, onSkfEvent, resyncSkfEvents, get lastEventSeq() { return lastEventSeq; } };
window.SKF_UI = {
  MD, friendlyError, formatMicros, formatBytes, formatTime,
  TASK_STATE_TEXT, IN_FLIGHT_STATES, BUDGET_MODE_TEXT, BUDGET_STATE_TEXT, budgetStateOf,
  state, currentSession, health, refreshPing, refreshSessions, switchSession, switchView, setTasksBadge,
  setApprovalCount, openApprovalDrawer,
  get activeView() { return activeView; },
};

window.SKF_VIEWS = window.SKF_VIEWS || {};

// ── 启动：连接 → 事件补发 → 会话加载 → 各视图初始化 ───────────────

document.addEventListener('DOMContentLoaded', async () => {
  await health();
  try { await resyncSkfEvents(); } catch { /* 补发失败不阻塞 */ }
  await refreshSessions().catch(() => {});
  // 模型切换：只影响下一任务；在途任务持自己的快照。
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', async () => {
      if (!state.ready) return;
      const target = modelSelect.value;
      modelSelect.disabled = true;
      try {
        if (modelSelect.dataset.managedRevision !== undefined && window.SKF_MANAGEMENT) {
          await window.SKF_MANAGEMENT.call('PUT', '/v1/models/default', { expectedRevision: Number(modelSelect.dataset.managedRevision), id: target });
          document.dispatchEvent(new CustomEvent('skf:configuration-changed'));
        } else await rpc('provider', { name: target });
        const ping = await refreshPing();
        const hint = document.getElementById('model-hint');
        if (hint) {
          hint.hidden = false;
          hint.textContent = `已切换默认 · 新会话起用 ${ping.model || target}；已有会话和在途任务不受影响。`;
        }
      } catch (error) {
        if (modelSelect && state.ping) modelSelect.value = state.ping.provider;
        const fe = friendlyError(error);
        setStatus('error', fe.text);
        const hint = document.getElementById('model-hint');
        if (hint) { hint.hidden = false; hint.textContent = fe.next; }
      } finally {
        modelSelect.disabled = false;
      }
    });
  }
  for (const view of Object.values(window.SKF_VIEWS)) {
    if (view && typeof view.init === 'function') {
      try { await view.init(); } catch { /* 单视图失败不影响其他 */ }
    }
  }
});
