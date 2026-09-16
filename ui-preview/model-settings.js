'use strict';
(function () {
  const api = (...args) => window.SKF_MANAGEMENT.call(...args);
  const presets = { kimi: ['https://api.moonshot.cn/v1', 'kimi-k3'], deepseek: ['https://api.deepseek.com/v1', 'deepseek-v4-pro'], openai: ['https://api.openai.com/v1', 'gpt-4.1'], ollama: ['http://127.0.0.1:11434/v1', ''], vllm: ['http://127.0.0.1:8000/v1', ''], compatible: ['', ''] };
  const el = (tag, text, attrs = {}) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; Object.assign(e, attrs); return e; };
  function input(label, type = 'text', value = '') { const box = el('label', label + ' '); box.style.display = 'block'; box.style.margin = '10px 0'; const i = el('input', undefined, { type, value, autocomplete: 'off' }); i.setAttribute('aria-label', label); box.append(i); return { box, input: i }; }
  function button(label, action) { const b = el('button', label, { type: 'button' }); b.addEventListener('click', async () => { b.disabled = true; try { await action(); } catch (e) { alert(e.message); } finally { b.disabled = false; } }); return b; }
  function modal(title) { const d = el('dialog'); d.style.cssText = 'padding:24px;max-width:720px;width:90vw;max-height:90vh;overflow:auto;border:1px solid #D7DEE7;border-radius:12px;margin:auto'; const h = el('h2', title), content = el('div'), error = el('p'); error.setAttribute('role', 'alert'); error.style.color = '#B42318'; const close = button('取消', () => d.close()); const clear = () => { d.querySelectorAll('input[type=password]').forEach(i => { i.value = ''; }); }; d.addEventListener('close', () => { clear(); d.remove(); }); d.addEventListener('cancel', clear); d.append(h, content, error, close); document.body.append(d); d.showModal(); return { d, content, error, close }; }
  async function changed() {
    const box = document.getElementById('settings-model');
    if (box) box.inert = true;
    try { if (box) await render(box); if (window.SKF_UI) { await window.SKF_UI.health(); await window.SKF_UI.refreshSessions().catch(() => {}); } }
    finally { if (box) box.inert = false; }
  }
  function modelFields(model = {}) { const id = input('模型记录 ID', 'text', model.id || ''), modelId = input('准确模型 ID', 'text', model.modelId || ''), context = input('上下文 tokens（未知留空）', 'number', model.contextWindowTokens || ''), tools = input('已确认支持工具调用（不等于工具授权）', 'checkbox'), vision = input('已确认支持视觉', 'checkbox'); tools.input.checked = model.tools === true; vision.input.checked = model.vision === true; return { nodes: [id.box, modelId.box, context.box, tools.box, vision.box], id, modelId, context, tools, vision, value: () => ({ id: id.input.value, modelId: modelId.input.value, contextWindowTokens: context.input.value ? Number(context.input.value) : null, tools: tools.input.checked, vision: vision.input.checked }) }; }
  async function wizard(setup = false) {
    const status = await api('GET', '/v1/setup/status');
    const m = modal(setup ? 'SKF 首次连接向导' : '添加连接与模型'); const pages = [], progress = el('p'); let step = 0;
    const labels = ['检测配置来源', '选择 Provider', '确认端点', '隐藏输入密钥', '选择模型', '数据目录', '可选连通测试', '确认保存', '完成'];
    for (const title of labels) { const page = el('section'); page.append(el('h3', title)); pages.push(page); }
    pages[0].append(el('pre', JSON.stringify(status, null, 2)), el('p', '旧配置只检测、不读取迁移凭据；已有数据/任务需要单独迁移审查。引导不修改 E/P 审批门。'));
    const adapterLabel = el('label', 'Provider '), adapter = el('select'); adapter.setAttribute('aria-label', 'Provider'); Object.keys(presets).forEach(p => adapter.append(el('option', p, { value: p }))); adapter.value = 'ollama'; adapterLabel.append(adapter);
    const pid = input('连接 ID', 'text', 'ollama'), name = input('连接名称', 'text', '本地模型'); pages[1].append(adapterLabel, pid.box, name.box);
    const endpoint = input('API 端点', 'url', presets.ollama[0]), trust = input('我信任此端点接收本次输入的凭据', 'checkbox'); pages[2].append(endpoint.box, trust.box, el('p', '非 loopback HTTP 被拒绝；不跟随鉴权重定向；自定义端点不会沿用官方 key。更改端点会清空已填密钥。'));
    const key = input('API 密钥（隐藏；Ollama 可留空）', 'password'); key.input.spellcheck = false; pages[3].append(key.box, el('p', '只有替换，没有读取/显示/复制。不会保存表单草稿；离开页面自动清空。'));
    const mf = modelFields({ id: 'default-model' }); const discovered = el('p'); pages[4].append(...mf.nodes, button('发现模型（不推理）', async () => { try { const r = await draft('/v1/setup/discover'); discovered.textContent = r.models.join(' · ') || '未返回模型，请手填准确 ID。'; } catch (e) { discovered.textContent = e.message + '；可手填准确模型 ID。'; } }), discovered);
    const data = input('本地数据目录', 'text', status.dataDir); data.input.disabled = !setup; pages[5].append(data.box, el('p', '配置目录独立保留：' + status.configDir + '。数据目录不支持 OneDrive/UNC；修改已有数据位置需要专门迁移。'));
    const paid = input('我理解最小推理可能产生费用，并同意本次测试', 'checkbox'), result = el('p', '未验证：可跳过测试离线保存。'); pages[6].append(el('p', '真实云模型测试可能计费；默认不调用，不会安装模型。'), paid.box, button('运行一次最小测试', async () => { if (!paid.input.checked) throw new Error('PAID_TEST_CONFIRM_REQUIRED'); result.textContent = JSON.stringify(await draft('/v1/setup/test', { confirmPaid: true, model: { ...mf.value(), providerId: pid.input.value } })); }), result);
    const summary = el('pre'); pages[7].append(summary, el('p', '默认模型仅影响新会话。已有会话和在途请求继续绑定原模型；工具授权与无人值守发布权限不变。'));
    pages[8].append(el('p', '已保存。使用 skf start 启动/连接同一 Supervisor；此窗口关闭不会停止它。'), button('完成', () => m.d.close()));
    function provider() { return { id: pid.input.value, name: name.input.value, adapter: adapter.value, baseUrl: endpoint.input.value }; }
    async function draft(path, extra = {}) { const body = { expectedRevision: status.revision, provider: provider(), key: key.input.value || undefined, acknowledgeCustomEndpoint: trust.input.checked, ...extra }; try { return await api('POST', path, body); } finally { body.key = undefined; } }
    const back = button('上一步', () => { step--; show(); });
    const next = button('下一步', async () => {
      m.error.textContent = '';
      if (step === 7) {
        let body = { expectedRevision: status.revision, provider: provider(), key: key.input.value || undefined, acknowledgeCustomEndpoint: trust.input.checked };
        try {
          if (setup) await api('POST', '/v1/setup/commit', { ...body, model: { ...mf.value(), providerId: pid.input.value }, dataDir: data.input.value });
          else { const r = await api('POST', '/v1/providers', body); await api('POST', '/v1/models', { expectedRevision: r.revision, model: { ...mf.value(), providerId: pid.input.value } }); }
          key.input.value = ''; step = 8; await changed(); show();
        } catch (e) { m.error.textContent = e.message + '：配置可能已被其他前端修改，请刷新核对后重试。'; }
        finally { body.key = undefined; key.input.value = ''; }
      } else { step++; show(); }
    });
    function show() { pages.forEach((p, i) => { p.hidden = i !== step; }); progress.textContent = step + '/8 · ' + labels[step]; back.hidden = step === 0 || step === 8; next.hidden = step === 8; next.textContent = step === 7 ? '原子保存' : '下一步'; summary.textContent = JSON.stringify({ provider: provider(), model: mf.value(), dataDir: data.input.value, credential: key.input.value ? '********' : '未提供', validation: result.textContent }, null, 2); }
    adapter.addEventListener('change', () => { endpoint.input.value = presets[adapter.value][0]; mf.modelId.input.value = presets[adapter.value][1]; pid.input.value = adapter.value; key.input.value = ''; trust.input.checked = false; });
    endpoint.input.addEventListener('input', () => { key.input.value = ''; trust.input.checked = false; });
    m.content.append(progress, ...pages, back, next); show();
  }
  async function testModel(model, revision) { const m = modal('测试模型 ' + model.modelId), paid = input('同意可能计费的最小推理（不勾选只检查协议/鉴权/模型列表）', 'checkbox'); m.content.append(paid.box, button('开始测试', async () => { const r = await api('POST', '/v1/models/' + model.id + '/test', { expectedRevision: revision, inference: paid.input.checked, confirmPaid: paid.input.checked }); m.error.textContent = r.code + ' · ' + r.latencyMs + ' ms'; await changed(); })); }
  async function replaceKey(provider, revision) { const m = modal('替换密钥'), key = input('新密钥', 'password'), trust = input('确认向此端点发送新密钥', 'checkbox'); m.content.append(el('p', provider.baseUrl + ' · 生效来源：' + provider.credentialSource), key.box, trust.box, button('保存新密钥', async () => { if (!trust.input.checked) throw new Error('CUSTOM_ENDPOINT_CONFIRM_REQUIRED'); const body = { expectedRevision: revision, key: key.input.value, acknowledgeCustomEndpoint: true }; try { await api('PUT', '/v1/providers/' + provider.id + '/credential', body); m.d.close(); await changed(); } finally { body.key = undefined; key.input.value = ''; } })); }
  async function editProvider(provider, revision) { const m = modal('编辑连接'), name = input('连接名称', 'text', provider.name), url = input('API 端点', 'url', provider.baseUrl), ack = input('更改端点时删除旧凭据，稍后重新输入', 'checkbox'); m.content.append(name.box, url.box, ack.box, button('保存连接', async () => { await api('PATCH', '/v1/providers/' + provider.id, { expectedRevision: revision, patch: { name: name.input.value, baseUrl: url.input.value }, acknowledgeCredentialRemoval: ack.input.checked }); m.d.close(); await changed(); })); }
  async function editModel(model, revision, providerId) { const m = modal(model ? '编辑模型' : '添加模型'), f = modelFields(model || {}); if (model) f.id.input.disabled = true; m.content.append(...f.nodes, button('保存模型', async () => { const value = f.value(); if (model) { const { id, ...patch } = value; await api('PATCH', '/v1/models/' + model.id, { expectedRevision: revision, patch }); } else await api('POST', '/v1/models', { expectedRevision: revision, model: { ...value, providerId } }); m.d.close(); await changed(); })); }
  async function render(box) {
    try {
      const [status, registry, connections] = await Promise.all([api('GET', '/v1/setup/status'), api('GET', '/v1/models'), api('GET', '/v1/providers')]);
      box.replaceChildren(el('h3', '模型与 API'), el('p', '默认切换仅影响新会话；现有会话及在途任务保持模型快照。'));
      if (status.overrides.length) box.append(el('p', '由环境变量覆盖：' + status.overrides.map(x => x.name).join('、') + '。受覆盖凭据禁止假成功替换。'));
      const select = el('select'); select.setAttribute('aria-label', '新会话默认模型'); registry.models.forEach(m => select.append(el('option', m.modelId + ' · ' + m.id, { value: m.id }))); select.value = registry.defaultModelRef || '';
      box.append(select, button('设置新会话默认模型', async () => { await api('PUT', '/v1/models/default', { expectedRevision: registry.revision, id: select.value }); await changed(); }), button(status.configured ? '添加连接向导' : '开始首次配置', () => wizard(!status.configured)));
      for (const p of connections.providers) { const section = el('section'); section.className = 'card'; section.append(el('h4', p.name + ' · ' + p.adapter), el('p', p.baseUrl), el('p', '凭据：' + (p.credentialMask || '未提供') + ' · 来源：' + p.credentialSource), button('替换密钥 · ' + p.id, () => replaceKey(p, registry.revision)), button('编辑连接 · ' + p.id, () => editProvider(p, registry.revision)), button('添加模型 · ' + p.id, () => editModel(null, registry.revision, p.id)), button('测试连接 · ' + p.id, async () => { const r = await api('POST', '/v1/providers/' + p.id + '/test', { expectedRevision: registry.revision, inference: false }); alert(r.code); await changed(); }), button('删除连接 · ' + p.id, async () => { if (!confirm('仅无模型引用时可删除连接及其凭据，继续？')) return; await api('DELETE', '/v1/providers/' + p.id, { expectedRevision: registry.revision }); await changed(); })); box.append(section); }
      for (const model of registry.models) { const section = el('section'); section.className = 'card'; section.append(el('h4', model.modelId + (registry.defaultModelRef === model.id ? ' · 默认' : '')), el('p', model.providerId + ' · context ' + (model.contextWindowTokens || '未知') + ' · tools ' + model.tools + ' · vision ' + model.vision), el('p', model.lastTest ? model.lastTest.code + ' · ' + model.lastTest.at + ' · ' + model.lastTest.latencyMs + 'ms' : '尚未验证'), button('测试模型 · ' + model.id, () => testModel(model, registry.revision)), button('编辑模型 · ' + model.id, () => editModel(model, registry.revision)), button('删除模型 · ' + model.id, async () => { if (!confirm('删除模型记录？默认模型须先切换。')) return; await api('DELETE', '/v1/models/' + model.id, { expectedRevision: registry.revision }); await changed(); })); box.append(section); }
    } catch (e) { box.replaceChildren(el('h3', '模型与 API'), el('p', e.message)); }
  }
  let setupShown = false;
  async function ensureSetup() { const status = await api('GET', '/v1/setup/status'); if (!status.configured && !setupShown) { setupShown = true; await wizard(true); } }
  window.SKF_MODELS = { render, ensureSetup, wizard };
  document.addEventListener('DOMContentLoaded', () => { ensureSetup().catch(() => {}); });
  document.addEventListener('skf:configuration-changed', () => { changed().catch(() => {}); });
})();
