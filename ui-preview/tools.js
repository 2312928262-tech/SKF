'use strict';

/**
 * 工具视图：能力总览（不直接调用）。工具通过「发起任务」经正常流程调用；
 * 本页只展示命名空间、能力与权限提示。发布类动作即使可找到也不降低无人值守限制。
 */
(function () {
  const UI = window.SKF_UI;
  const container = document.getElementById('tools-info');

  const GROUPS = [
    {
      name: 'Desktop · 桌面操作',
      items: ['desktop.windows（列窗口 · 只读）', 'desktop.snapshot（窗口快照 · 只读）', 'clipboard.read（读剪贴板 · 只读）', 'clipboard.write（写剪贴板 · 需审批）', 'desktop.launch（启动程序 · 需审批 + 白名单）', 'desktop.interact.*（GUI 有限交互 · 副作用需审批）'],
      note: '写剪贴板 / 启动程序 / GUI 副作用都走审批门；发布类动作需单独审批。',
    },
    {
      name: 'Browser · 浏览器（CDP）',
      items: ['browser.navigate（导航 · 只读，域名白名单）', 'browser.snapshot（页面快照 · 只读）', 'browser.text（取正文 · 只读）', 'browser.click / type / fill（交互 · 需审批）'],
      note: '域名白名单 + 跨域重定向阻止；type/fill 疑似密钥输入会被拒绝。',
    },
    {
      name: 'Media · 媒体处理',
      items: ['media.image（本地出图）', 'media.tts（本地语音合成）', 'media.transcribe（语音转写 · 只读）', 'media.vram.manage（显存管理 · 需审批）'],
      note: '本地生成不调用云端，产物 sha256 + 登记 artifact。',
    },
    {
      name: 'Web · 联网',
      items: ['web.search（检索 · 只读，域名白名单）', 'web.fetch（抓取 · 只读，域名白名单）'],
      note: '域名白名单 + 大小限制 + 跨域重定向阻止。',
    },
    {
      name: 'File · 工作区文件',
      items: ['file.read / write / list / stat（仅限任务工作目录）'],
      note: '路径穿越/符号链接逃逸全拒；写入默认 create-only，覆盖需 expectedSha256。',
    },
    {
      name: 'MCP · 本地工具服务器',
      items: ['mcp/<server>/<tool>（白名单 stdio server）'],
      note: '副作用审批绑定执行快照 hash；结果标不可信外部数据。',
    },
  ];

  function render() {
    container.innerHTML = '';
    for (const g of GROUPS) {
      const card = document.createElement('div');
      card.className = 'tool-group';
      const h = document.createElement('h3');
      h.textContent = g.name;
      const ul = document.createElement('ul');
      for (const item of g.items) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      }
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = g.note;
      card.append(h, ul, note);
      container.appendChild(card);
    }
    const go = document.createElement('div');
    go.className = 'card';
    go.style.gridColumn = '1 / -1';
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '工具不在此直接执行。要使用某个工具，请到「任务」页发起任务，把工具写入目标描述或参数；E/P 副作用审批、预算、无人值守限制均由后端裁决。';
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = '去发起任务';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', () => UI.switchView('tasks'));
    go.append(p, btn);
    container.appendChild(go);
  }

  window.SKF_VIEWS.tools = {
    init() { render(); },
    onShow() {},
  };
})();
