(() => {
  'use strict';
  function mount(container, onChange = () => {}) {
    container.classList.add('tmeet-license');
    container.innerHTML = `
      <div class="tmeet-license-title">插件激活</div>
      <div class="tmeet-license-status" role="status" aria-live="polite">正在读取激活状态…</div>
      <details class="tmeet-license-details">
      <summary>设备码与激活 / 续费</summary>
      <p>将设备码发给麦爸（mai8ba），找麦爸购买激活码。</p>
      <label>设备码（设备申请码）<input class="tmeet-license-device" readonly aria-label="设备申请码" spellcheck="false" value="正在生成…"></label>
      <button type="button" class="tmeet-license-copy" disabled>复制设备申请码</button>
      <p class="tmeet-license-note">申请码由本地安装标识生成，同一浏览器安装保持不变。</p>
      <label>激活码<textarea class="tmeet-license-token" maxlength="4096" rows="3" spellcheck="false" placeholder="粘贴从麦爸处购买的激活码" aria-label="激活码"></textarea></label>
      <button type="button" class="tmeet-license-activate">验证并激活 / 续费</button>
      <div class="tmeet-license-message" role="status" aria-live="polite"></div>
      <p class="tmeet-license-note">未注册可免费试用 3 天（首次联网起 72 小时）。试用和限时授权按联网时间验证，断网时暂不可用。支持永久有效及原申请码续费。</p>
      </details>`;
    const query = name => container.querySelector('.tmeet-license-' + name);
    let busy = false, refreshing = false, disposed = false;
    let revision = 0;
    let previousActive;
    async function rpc(op, extra = {}) {
      const response = await chrome.runtime.sendMessage({ type: 'tmeet', op, ...extra });
      if (!response?.ok) throw new Error(response?.error || '后台无响应，请重新加载插件');
      return response.license;
    }
    function show(status, activated = false) {
      if (disposed) return;
      const device = query('device');
      if (device.value !== status.requestCode) device.value = status.requestCode || '';
      query('copy').disabled = !status.requestCode;
      const text = status.active && ['limited', 'trial'].includes(status.kind)
        ? (status.kind === 'trial' ? '免费试用 · 截止 ' : '已激活 · 有效至 ') + new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false })
        : status.reason;
      query('status').textContent = text;
      query('status').dataset.active = String(status.active);
      if (activated || previousActive !== status.kind) query('details').open = !status.active;
      previousActive = status.kind;
      onChange(status);
    }
    async function refresh() {
      if (busy || refreshing || disposed) return;
      refreshing = true;
      const current = revision;
      try { const status = await rpc('license.status'); if (current === revision) show(status); }
      catch (e) {
        if (current === revision) {
          query('status').textContent = e.message;
          query('status').dataset.active = 'false';
          query('details').open = true; previousActive = false;
          onChange({ active: false, reason: e.message });
        }
      } finally { refreshing = false; }
    }
    query('copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(query('device').value);
        query('message').textContent = '申请码已复制，请发送给麦爸（mai8ba）购买激活码。';
      } catch {
        query('device').focus(); query('device').select();
        query('message').textContent = '请按 Ctrl+C 复制设备申请码。';
      }
    });
    query('activate').addEventListener('click', async () => {
      if (busy) return;
      const token = query('token').value.trim();
      if (!token) { query('message').textContent = '请先粘贴激活码。'; return; }
      busy = true; revision++;
      query('activate').disabled = true;
      query('message').textContent = '正在验证…';
      try {
        const status = await rpc('license.activate', { token });
        show(status, true); query('token').value = '';
        query('message').textContent = '激活成功，可以开始采集和下载。';
      } catch (e) { query('message').textContent = e.message; }
      finally { busy = false; query('activate').disabled = false; }
    });
    const changed = (changes, area) => {
      if (area === 'local' && changes.tmeetLicenseV1) refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    const timer = setInterval(refresh, 30000);
    refresh();
    return () => {
      disposed = true; clearInterval(timer);
      chrome.storage.onChanged.removeListener(changed);
    };
  }
  globalThis.TMeetLicenseUI = Object.freeze({ mount });
})();
