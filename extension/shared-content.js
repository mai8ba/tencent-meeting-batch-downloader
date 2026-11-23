/* ISOLATED world：只为本扩展创建的课程标签页提供密码填入与数据转送。 */
(() => {
  'use strict';
  const S = TMeetSite.s;
  let enabled = false, password = '', passwordState = '', passwordBusy = false, passwordSequence = 0, tabClicked = false, lastUI = '', queued = [], sending = false;
  let lastVideo = '', lastNative = null, nativeRequested = false, nativeFollowed = false;
  async function rpc(op, extra = {}) {
    const result = await chrome.runtime.sendMessage({ type: 'tmeet', op, ...extra });
    if (!result?.ok) throw new Error(result?.error || '后台无响应');
    return result;
  }
  async function flush() {
    if (!enabled || sending || !queued.length) return;
    sending = true;
    const values = queued; queued = [];
    try {
      for (const delta of values) {
        let error;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await rpc('shared.capture', { delta }); error = null; break; }
          catch (e) { error = e; await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
        }
        if (error) { enabled = false; console.error('逐字稿数据保存失败，请重新打开课程页', error.message); throw error; }
      }
    }
    catch (e) { void rpc('shared.capture', { delta: { captureError: '逐字稿数据转送失败，请重新打开课程页后重试' } }).catch(() => {}); }
    finally { sending = false; if (queued.length) void flush(); }
  }
  window.addEventListener('tmeet.shared.capture', event => {
    if (typeof event.detail !== 'string' || event.detail.length > 10000000) return;
    try {
      const payload = JSON.parse(event.detail);
      if (typeof payload.path !== 'string' || !/\/(minutes\/detail|common-record-info|get-multi-record-file)$/.test(payload.path)) return;
      const delta = payload.captureError ? { captureError: String(payload.captureError).slice(0, 300) } : TMeetShared.extract(payload.path, payload.data);
      if (!Object.keys(delta).length) return;
      if (queued.length >= 64) { queued = [{ captureError: '逐字稿待保存响应过多，已停止以避免缺页导出；请重新打开课程页' }]; }
      else queued.push(delta);
      if (enabled) void flush();
    } catch { /* 忽略非本协议事件 */ }
  });
  window.addEventListener('tmeet.shared.observer-ready', () => window.dispatchEvent(new CustomEvent('tmeet.shared.ready')));
  window.dispatchEvent(new CustomEvent('tmeet.shared.ready'));
  function visible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function downloadButton() {
    return [...document.querySelectorAll(S.linkButton)]
      .find(el => visible(el) && !el.disabled && TMeetSite.text.sharedDownload.test((el.innerText || '').trim()));
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'tmeet.shared.action' || sender.id !== chrome.runtime.id || !enabled) return;
    if (message.action !== 'download') return;
    const button = downloadButton();
    if (!button) { respond({ ok: false, error: '未找到视频下载按钮，请打开原页面查看' }); return; }
    nativeRequested = true; nativeFollowed = false;
    button.click(); respond({ ok: true });
  });
  window.addEventListener('tmeet.shared.password-result', event => {
    try {
      const result = JSON.parse(event.detail);
      if (result.id !== String(passwordSequence)) return;
      passwordBusy = false; passwordState = result.state || '';
    } catch { /* 忽略非协议事件 */ }
  });
  async function inspect() {
    if (!enabled || !document.body) return;
    const input = [...document.querySelectorAll(S.pageInput)].find(el => visible(el) && (/访问密码|提取码|访问码|密码/.test([el.placeholder, el.getAttribute('aria-label'), el.closest(S.passwordScope)?.innerText, el.parentElement?.innerText].join(' '))));
    if (password && !passwordBusy && !['wrong-password', 'challenge', 'submit-failed'].includes(passwordState)) {
      passwordBusy = true;
      const id = String(++passwordSequence);
      window.dispatchEvent(new CustomEvent('tmeet.shared.password', { detail: JSON.stringify({ id, password }) }));
      setTimeout(() => { if (String(passwordSequence) === id) passwordBusy = false; }, 5000);
    }
    if (!input && !tabClicked) {
      const tab = [...document.querySelectorAll(S.transcriptTab)].find(el => visible(el) && TMeetSite.text.transcriptTab.test(el.innerText.trim()));
      if (tab) { tabClicked = true; tab.click(); }
    }
    const video = document.querySelector(S.video);
    const src = video?.currentSrc || video?.src || '';
    const url = TMeetShared.mediaURL(src);
    if (url && url !== lastVideo) { lastVideo = url; void rpc('shared.capture', { delta: { videos: [{ url, name: '' }] } }).catch(() => {}); }
    const available = !!downloadButton();
    if (available !== lastNative) { lastNative = available; void rpc('shared.capture', { delta: { hasDownloadButton: available } }).catch(() => {}); }
    if (nativeRequested && !nativeFollowed) {
      const option = [...document.querySelectorAll(S.menuItem)].find(el => visible(el) && TMeetSite.text.sharedDownloadOption.test((el.innerText || '').trim()));
      if (option) {
        nativeFollowed = true;
        void rpc('shared.authorize-native').then(result => { if (result.enabled) option.click(); }).catch(() => {});
      }
    }
    const text = (document.body.innerText || '').slice(0, 12000);
    const status = input ? (/密码.*错误|密码不正确/.test(text) ? '密码未通过，请打开课程页核对密码' : passwordState === 'challenge' ? '请打开课程页完成安全验证' : passwordState === 'submit-failed' ? '密码已填入，但前往查看未成功，请打开课程页检查' : passwordState === 'awaiting-open' ? '已点击前往查看，正在确认课程是否打开' : '正在自动填写访问密码并等待按钮就绪')
      : /扫码登录|登录后.*(?:查看|访问)|请先登录/.test(text) ? '需要登录，请打开课程页完成登录'
      : /访问.*(?:失效|过期)|录制.*(?:不存在|已删除)/.test(text) ? '分享可能已失效，请打开课程页确认'
      : /正在转写|转写中|转写.*生成中/.test(text) ? '逐字稿尚在生成，请稍后重试' : '正在读取课程数据';
    if (status !== lastUI) { lastUI = status; void rpc('shared.capture', { delta: { pageStatus: status } }).catch(() => {}); }
  }
  rpc('shared.probe').then(result => {
    enabled = !!result.enabled;
    if (!enabled) { queued = []; return; }
    password = result.password || '';
    void flush();
    // 前 60 秒高频（密码门、转写标签页加载），之后降频：inspect 会读 innerText 强制同步
    // 布局，800ms 一次在多课程并行时会让主线程持续抖动。
    const startedAt = performance.now();
    const nextDelay = () => {
      if (nativeRequested && !nativeFollowed) return 500;
      if (passwordBusy) return 800;
      return performance.now() - startedAt < 60000 ? 800 : 2500;
    };
    const tick = async () => {
      if (!document.documentElement.isConnected) return;
      try { await inspect(); } catch { /* 单次失败不终止观察 */ }
      setTimeout(tick, nextDelay());
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void tick(); }, { once: true });
    else void tick();
  }).catch(() => { queued = []; });
})();
