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
  if (message.type !== 'tmeet.file-check') return;
  TMeetFiles.verify(message.filename, message.kind, message.size).then(reply, e => reply({ valid: false, reason: e.message }));
  return true;
});
