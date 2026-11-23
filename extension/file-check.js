/* 离屏文档消息入口：只接受扩展自身（service worker / 扩展页面）的请求。
 *
 * 来源判定用 sender.tab：内容脚本一定带 tab，扩展上下文一定不带。
 * 之前用 sender.url === background.js 做白名单，一旦浏览器对 SW 消息给出别的 URL
 * （例如 chrome-extension://<id>/），本地校验就会全线失败 —— 所有下载都判"正文不通过"。
 */
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message) return;
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'tmeet.file-status') {
    TMeetFiles.status().then(reply, e => reply({ granted: false, name: '', error: e.message }));
    return true;
  }
  if (message.type === 'tmeet.file-contains') {
    // 只回答"授权目录里有没有这个文件"，不返回内容：供面板做目录一致性实测。
    TMeetFiles.contains(message.filename).then(
      matched => reply({ matched: !!matched }),
      () => reply({ matched: false })
    );
    return true;
  }
  // v1.8.11：MV3 的 service worker 里没有 URL.createObjectURL，逐字稿没法在后台建 blob。
  // 官方分工：offscreen 只用 Web API（建 blob 链接），service worker 做 chrome.*（下载）。
  // offscreen 里 chrome.downloads 是不可用的，所以这里只把 blob 链接交回后台。
  if (message.type === 'tmeet.blob-url') {
    try {
      reply(createBlobUrl(message));
    } catch (e) {
      reply({ ok: false, error: e?.message || String(e) });
    }
    return true;
  }
  if (message.type !== 'tmeet.file-check') return;
  TMeetFiles.verify(message.filename, message.kind, message.size).then(reply, e => reply({ valid: false, reason: e.message }));
  return true;
});

/** 在本页（有 DOM）把文本建成 blob 链接，交给后台去下载；2 分钟后自动回收。 */
function createBlobUrl(message) {
  const text = String(message.content == null ? '' : message.content);
  if (!text.trim()) throw new Error('内容为空');
  const bytes = new TextEncoder().encode(text);
  // v1.8.12：加 UTF-8 BOM(EF BB BF)。纯 UTF-8 无 BOM 时，Excel / WPS / Windows 记事本
  // 会按 GBK 打开，中文全成"锟斤拷"。带上 BOM，它们才能正确识别成 UTF-8。
  const payload = new Uint8Array(3 + bytes.length);
  payload[0] = 0xEF; payload[1] = 0xBB; payload[2] = 0xBF;
  payload.set(bytes, 3);
  const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* 已失效忽略 */ } }, 120000);
  return { ok: true, url };
}
