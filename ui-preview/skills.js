'use strict';

/**
 * 技能视图：列表 / 搜索 / 详情（说明 + 触发词 + 权限提示）。
 * 触发词可复制或填入输入框；填入不等于自动执行。技能通过「发起任务」经正常流程调用。
 */
(function () {
  const UI = window.SKF_UI;
  const { rpc2 } = window.SKF_IPC2;
  const { friendlyError } = UI;

  const listEl = document.getElementById('skill-list');
  const form = document.getElementById('skill-search-form');
  const queryInput = document.getElementById('skill-query');

  async function load(query) {
    listEl.innerHTML = '<div class="empty-block">读取技能…</div>';
    try {
      const data = query
        ? await rpc2('skill.search', { query, limit: 50 })
        : await rpc2('skill.list');
      const skills = data.skills || [];
      render(skills);
    } catch (error) {
      const fe = friendlyError(error);
      listEl.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'error-box';
      box.textContent = fe.text + '。' + fe.next;
      listEl.appendChild(box);
    }
  }

  function render(skills) {
    listEl.innerHTML = '';
    if (!skills.length) {
      listEl.innerHTML = '<div class="empty-block">没有匹配的技能。技能放在数据目录 skills/ 下，以 SKILL.md 声明。</div>';
      return;
    }
    for (const s of skills) listEl.appendChild(renderSkill(s));
  }

  function renderSkill(s) {
    const card = document.createElement('div');
    card.className = 'skill-item';
    const head = document.createElement('div');
    head.className = 's-head';
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = s.name;
    const id = document.createElement('span');
    id.className = 'hint';
    id.style.fontFamily = 'var(--mono)';
    id.textContent = s.id;
    head.append(name, id);

    const desc = document.createElement('div');
    desc.className = 'hint';
    desc.textContent = s.description || '（无描述）';

    card.append(head, desc);

    const triggers = s.triggers || [];
    if (triggers.length) {
      const tline = document.createElement('div');
      tline.className = 's-triggers';
      const label = document.createElement('span');
      label.textContent = '触发词：';
      tline.appendChild(label);
      for (const t of triggers) {
        const chip = document.createElement('span');
        chip.className = 'trigger-chip';
        chip.textContent = t;
        chip.title = '点击填入输入框（填入不等于自动执行）';
        chip.addEventListener('click', () => {
          UI.switchView('chat');
          const msg = document.getElementById('message');
          if (msg) { msg.value = (msg.value ? msg.value + ' ' : '') + t; msg.focus(); }
        });
        tline.appendChild(chip);
      }
      card.appendChild(tline);
    }

    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginTop = '6px';
    note.textContent = '技能正文只作参考注入，不改变权限/审批门/预算；调用仍走任务流程。';
    card.appendChild(note);

    return card;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(queryInput.value.trim()).catch(() => {});
  });

  window.SKF_VIEWS.skills = {
    init() { return load(''); },
    onShow() { load(queryInput.value.trim()).catch(() => {}); },
  };
})();
