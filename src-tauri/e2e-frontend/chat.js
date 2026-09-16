'use strict';

/**
 * 对话视图：与 CLI 同一聊天内核（v1 chat action）。
 * 等待是真实等待（计时器），不伪造打字流——当前 provider 不支持 streaming，
 * 进度以任务页的真实阶段事件为准。
 */
(function () {
  const { rpc } = window.SKF_IPC2;
  const { friendlyError, formatTime } = window.SKF_UI;
  const MD = window.SKF_MARKDOWN;

  const thread = document.getElementById('chat-thread');
  const emptyHint = document.getElementById('chat-empty');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('message');
  const send = document.getElementById('send');
  const check = document.getElementById('check');
  const clear = document.getElementById('clear');

  let busy = false;
  let waitTimer = null;

  function lockUI(value) {
    busy = value;
    send.disabled = value || !window.SKF_UI.state.ready;
    input.disabled = value || !window.SKF_UI.state.ready;
    clear.disabled = value;
    check.disabled = value;
  }

  function removeEmpty() {
    const el = document.getElementById('chat-empty');
    if (el) el.remove();
  }

  function scrollDown() {
    thread.scrollTop = thread.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  }

  function appendMsg(role, text) {
    removeEmpty();
    const box = document.createElement('div');
    box.className = 'msg ' + role;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? '你' : 'SKF';
    const body = document.createElement('div');
    body.className = 'body';
    if (role === 'user') {
      body.textContent = text; // 用户输入原样纯文本
    } else {
      body.innerHTML = MD.renderMarkdown(text); // 模型输出走 sanitize 渲染
    }
    box.append(who, body);
    thread.appendChild(box);
    scrollDown();
    return box;
  }

  function appendMeta(text) {
    const line = document.createElement('div');
    line.className = 'msg meta-line';
    line.textContent = text;
    thread.appendChild(line);
    scrollDown();
  }

  function appendError(error) {
    removeEmpty();
    const fe = friendlyError(error);
    const box = document.createElement('div');
    box.className = 'msg bot';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'SKF';
    const body = document.createElement('div');
    body.className = 'body';
    const err = document.createElement('div');
    err.className = 'error-box';
    const main = document.createElement('div');
    main.textContent = fe.text;
    const next = document.createElement('div');
    next.className = 'next';
    next.textContent = '下一步：' + fe.next;
    err.append(main, next);
    body.appendChild(err);
    box.append(who, body);
    thread.appendChild(box);
    scrollDown();
  }

  function showWaiting() {
    removeEmpty();
    const box = document.createElement('div');
    box.className = 'msg bot waiting';
    const started = Date.now();
    box.textContent = 'SKF正在等待模型响应…（0 秒）。当前大脑不支持逐字输出，这是真实等待，不是演示。';
    thread.appendChild(box);
    scrollDown();
    waitTimer = setInterval(() => {
      box.textContent = `SKF正在等待模型响应…（${Math.floor((Date.now() - started) / 1000)} 秒）。当前大脑不支持逐字输出，这是真实等待，不是演示。`;
    }, 1000);
    return box;
  }

  function hideWaiting(box) {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  async function restoreHistory() {
    let result;
    try {
      result = await rpc('history');
    } catch {
      return; // 历史不可读不阻塞聊天
    }
    const tasks = result.tasks || [];
    for (const t of tasks) {
      appendMsg('user', t.message);
      if (t.text) {
        appendMsg('bot', t.text);
      } else {
        appendError(t.error || 'TASK_INTERRUPTED');
      }
      const metaBits = [t.model || t.provider || '', formatTime(t.startedAt)].filter(Boolean);
      if (t.memoryWarning) metaBits.push('记忆写回待补（恢复后自动补投）');
      if (metaBits.length) appendMeta(metaBits.join(' · '));
    }
  }

  async function chat(text) {
    if (busy || !window.SKF_UI.state.ready) return;
    lockUI(true);
    appendMsg('user', text);
    input.value = '';
    const waiting = showWaiting();
    try {
      const result = await rpc('chat', { message: text });
      hideWaiting(waiting);
      appendMsg('bot', result.text || '（模型返回了空内容）');
      const usage = result.usage;
      const counts = usage ? ` · 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} token` : '';
      const estimate = usage && usage.costSource === 'configured-estimate'
        ? ` · 估算 ${window.SKF_UI.formatMicros(Math.round(usage.cost * 1_000_000))}（按配置价目，非账单）`
        : '';
      appendMeta(`${result.model || result.provider || ''}${counts}${estimate} · 已保存${result.memoryWarning ? ' · 记忆写回待补' : ''}`);
      window.SKF_UI.refreshPing().catch(() => {}); // 预算胶囊同步
    } catch (error) {
      hideWaiting(waiting);
      appendError(error);
    } finally {
      lockUI(false);
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return; // 防重复提交
    chat(text);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text && !busy && window.SKF_UI.state.ready) chat(text);
    }
  });

  check.addEventListener('click', () => window.SKF_UI.health().then(() => lockUI(false)));

  clear.addEventListener('click', () => {
    thread.innerHTML = '<div id="chat-empty">对话会在此显示。Enter 发送，Shift+Enter 换行。</div>';
  });

  window.SKF_VIEWS.chat = {
    async init() {
      await restoreHistory();
      lockUI(false);
      send.disabled = !window.SKF_UI.state.ready;
      input.disabled = !window.SKF_UI.state.ready;
    },
    onReadyChange() {
      if (!busy) {
        send.disabled = !window.SKF_UI.state.ready;
        input.disabled = !window.SKF_UI.state.ready;
      }
    },
  };
})();
