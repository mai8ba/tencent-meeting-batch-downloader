/* MAIN world：仅观察页面自身已经成功返回的数据，不记录 Cookie/请求头。 */
(() => {
  'use strict';
  if (window.__tmeetSharedObserver) return;
  window.__tmeetSharedObserver = true;
  let ready = false, buffer = [], bufferedBytes = 0, overflow = false;
  window.addEventListener('tmeet.shared.ready', () => {
    ready = true;
    if (overflow) { window.dispatchEvent(new CustomEvent('tmeet.shared.capture', { detail: JSON.stringify({ path: '/minutes/detail', data: {}, captureError: '早期逐字稿响应过多，请重新打开课程页重试，不能用缺页内容导出' }) })); buffer = []; return; }
    const pending = buffer; buffer = [];
    bufferedBytes = 0;
    for (const detail of pending) window.dispatchEvent(new CustomEvent('tmeet.shared.capture', { detail }));
  });
  function eligible(value) {
    try {
      const u = new URL(value, location.href);
      return u.origin === 'https://meeting.tencent.com' &&
        /\/(minutes\/detail|common-record-info|get-multi-record-file)$/.test(u.pathname);
    } catch { return false; }
  }
  function emit(url, data) {
    if (!eligible(url)) return;
    let detail = JSON.stringify({ path: new URL(url, location.href).pathname, data });
    if (detail.length > 10000000) detail = JSON.stringify({ path: '/minutes/detail', data: {}, captureError: '逐字稿响应超过处理上限，请使用原页面核对导出；不能忽略大响应后用缺页内容导出' });
    if (ready) window.dispatchEvent(new CustomEvent('tmeet.shared.capture', { detail }));
    else {
      bufferedBytes += detail.length;
      if (buffer.length >= 64 || bufferedBytes > 24000000) { overflow = true; buffer = []; return; }
      if (!overflow) buffer.push(detail);
    }
  }
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = nativeFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
    if (eligible(url)) promise.then(response => {
      if (response.ok) response.clone().json().then(data => emit(url, data)).catch(() => {});
    }).catch(() => {});
    return promise;
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    urls.set(this, String(url)); return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = urls.get(this);
    if (eligible(url)) this.addEventListener('load', () => {
      if (this.status < 200 || this.status >= 300) return;
      try { emit(url, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* 不是 JSON */ }
    }, { once: true });
    return send.apply(this, args);
  };
  window.dispatchEvent(new CustomEvent('tmeet.shared.observer-ready'));
})();
