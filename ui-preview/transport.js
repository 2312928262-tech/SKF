'use strict';
(function () {
  const PROTOCOL = 1;
  let csrf = null, authenticating = null;
  const native = () => window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  function safeError(code) { return new Error(typeof code === 'string' && /^[A-Z_]{2,64}$/.test(code) ? code : 'MANAGEMENT_FAILED'); }
  async function fetchJson(method, path, body, paired = true) {
    if (paired) await authenticate();
    let response;
    try { response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', headers: { 'X-SKF-Protocol': String(PROTOCOL), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-SKF-CSRF': csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw safeError('INSTANCE_UNREACHABLE'); }
    let result; try { result = await response.json(); } catch { throw safeError('INSTANCE_PROTOCOL_INVALID'); }
    if (!response.ok) { if (response.status === 401) { csrf = null; authenticating = null; } throw safeError(result.error); }
    return result;
  }
  async function pair() {
    return new Promise((resolve, reject) => {
      const dialog = document.createElement('dialog');
      const form = document.createElement('form'); form.autocomplete = 'off';
      const title = document.createElement('h3'); title.textContent = '配对此浏览器';
      const text = document.createElement('p'); text.textContent = '在本机终端运行 skf pair，输入 120 秒有效的一次性配对码；不会写入浏览器持久存储。';
      const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.setAttribute('aria-label', '一次性配对码');
      const button = document.createElement('button'); button.type = 'submit'; button.textContent = '配对';
      const error = document.createElement('p'); error.setAttribute('role', 'alert');
      form.append(title, text, input, button, error); dialog.append(form); document.body.append(dialog); dialog.showModal();
      dialog.addEventListener('cancel', () => { input.value = ''; dialog.remove(); reject(safeError('PAIRING_CANCELLED')); });
      form.addEventListener('submit', async (event) => { event.preventDefault(); button.disabled = true; let code = input.value; input.value = ''; try { const result = await fetchJson('POST', '/v1/pair', { code }, false); csrf = result.csrf; dialog.close(); dialog.remove(); resolve(); } catch (e) { error.textContent = e.message; } finally { code = ''; button.disabled = false; } });
    });
  }
  async function authenticate() {
    if (csrf) return;
    if (!authenticating) authenticating = (async () => {
      try { const session = await fetchJson('GET', '/v1/session', undefined, false); csrf = session.csrf; }
      catch (e) { if (e.message !== 'AUTH_REQUIRED') throw e; await pair(); }
      const h = await fetchJson('GET', '/v1/handshake', undefined, false);
      if (h.protocol !== PROTOCOL || h.schemaVersion !== 1) { csrf = null; throw safeError('MANAGEMENT_PROTOCOL_UNSUPPORTED'); }
    })().catch(e => { authenticating = null; throw e; });
    await authenticating;
  }
  async function call(method, path, body) {
    if (native()) {
      const response = await native()('call_supervisor', { request: { id: crypto.randomUUID(), action: 'management', data: { protocol: PROTOCOL, method, path, body } } });
      if (!response || !response.ok) throw safeError(response && response.error);
      return response.data;
    }
    return fetchJson(method, path, body);
  }
  window.SKF_MANAGEMENT = { call, protocol: PROTOCOL };
  window.SKF_TRANSPORT = { invoke: async (command, payload) => { if (command !== 'call_supervisor') throw safeError('ACTION_DENIED'); return fetchJson('POST', '/v1/rpc', payload.request); } };
  const clearSecrets = () => { document.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; }); };
  window.addEventListener('pagehide', () => { clearSecrets(); csrf = null; authenticating = null; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearSecrets(); });
})();
