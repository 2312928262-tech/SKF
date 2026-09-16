'use strict';

/**
 * 设置视图：模型与大脑 / 学习 / 显示与交互 / 连接与诊断。
 * 只读展示为主；学习入口展示 learning.* 状态；诊断展示连接状态与可复制错误信息。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2 } = window.SKF_IPC2;
  const { friendlyError } = UI;

  const modelBox = document.getElementById('settings-model');
  const learningBox = document.getElementById('settings-learning');
  const diagBox = document.getElementById('settings-diag');

  function renderModel() {
    if (window.SKF_MODELS) { void window.SKF_MODELS.render(modelBox); return; }
    const ping = UI.state.ping;
    if (!ping) {
      modelBox.innerHTML = '<h3>模型与大脑</h3><div class="hint">未连接。</div>';
      return;
    }
    const caps = ping.capabilities || {};
    modelBox.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = '模型与大脑';
    modelBox.appendChild(h);
    const rows = [
      ['当前大脑', ping.provider || '—'],
      ['当前模型（用于下一任务）', ping.model || '—'],
      ['已配置', ping.configured === false ? '否（缺 API Key）' : '是'],
      ['版本', ping.version || '—'],
      ['工具执行能力', caps.toolExecution ? '可用' : '不可用'],
      ['记忆模式', caps.memoryMode || '—'],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'hint';
      row.style.marginTop = '4px';
      row.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = k + '：';
      b.style.color = 'var(--text)';
      row.append(b, document.createTextNode(' ' + v));
      modelBox.appendChild(row);
    }
  }

  async function renderLearning() {
    learningBox.innerHTML = '<h3>学习</h3><div class="hint">读取中…</div>';
    try {
      const status = await rpc2('learning.status');
      learningBox.innerHTML = '';
      const h = document.createElement('h3');
      h.textContent = '学习（影子模式）';
      learningBox.appendChild(h);
      const line = document.createElement('div');
      line.className = 'hint';
      line.textContent = '学习闭环首版仅人工确认晋级；候选经验仅作参考，不产生硬约束。';
      learningBox.appendChild(line);
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-family:var(--mono);font-size:11.5px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;overflow-x:auto;margin-top:6px;';
      pre.textContent = JSON.stringify(status, null, 2);
      learningBox.appendChild(pre);
    } catch (error) {
      const fe = friendlyError(error);
      learningBox.innerHTML = '<h3>学习</h3><div class="hint">' + (fe.code === 'LEARNING_DISABLED' ? '学习功能未开启（影子模式未激活）。' : fe.text) + '</div>';
    }
  }

  function renderDiag() {
    diagBox.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = '连接与诊断';
    diagBox.appendChild(h);
    const state = UI.state.ready;
    const line = document.createElement('div');
    line.className = 'hint';
    line.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = state ? '已连接' : '未就绪';
    b.style.color = state ? 'var(--success)' : 'var(--danger)';
    line.append(b, document.createTextNode(' · ' + (document.getElementById('status-text').textContent || '')));
    diagBox.appendChild(line);
    const copy = document.createElement('button');
    copy.className = 'small';
    copy.style.marginTop = '8px';
    copy.textContent = '复制诊断信息';
    copy.addEventListener('click', () => {
      const ping = UI.state.ping || {};
      const text = JSON.stringify({ ready: UI.state.ready, provider: ping.provider, model: ping.model, version: ping.version, capabilities: ping.capabilities }, null, 2);
      try { navigator.clipboard.writeText(text); } catch { /* 忽略 */ }
      copy.textContent = '已复制';
      setTimeout(() => { copy.textContent = '复制诊断信息'; }, 1500);
    });
    diagBox.appendChild(copy);
  }

  document.addEventListener('skf:sessions', () => {});
  window.SKF_VIEWS.settings = {
    init() {
      renderModel();
      renderLearning().catch(() => {});
      renderDiag();
    },
    onShow() {
      renderModel();
      renderLearning().catch(() => {});
      renderDiag();
    },
  };
})();
