'use strict';
importScripts('site-adapter.js', 'license.js', 'shared-core.js', 'shared-docx.js', 'shared-service.js', 'download-journal.js', 'detail-service.js');
const licensing = TMeetLicense.createManager(chrome.storage.local);
// 测试桩可能未加载 detail-service；缺它时只禁用逐字稿新链路，不影响其余功能。
const detailService = typeof TMeetDetailService !== 'undefined'
  ? TMeetDetailService.create({ licensing, logger: (...a) => console.info('[detail]', ...a), ensureOffscreen })
  : null;
/* v1.8.13：本扩展自己发起的下载（逐字稿 = downloads.download + blob 链接）要认领"期望文件名"。
 * 原因：onDeterminingFilename 监听器一旦调用 suggest()，download() 传入的 filename 就作废，
 * 名字会退化成 blob 链接尾段（f66522b9-... 那种 UUID）。登记簿在 detail-service 里（可单测），
 * 这里只认领；缺模块时退化成 null，走原有逻辑。 */
const claimOwnDownload = (item) => (typeof TMeetDetailService !== 'undefined' ? TMeetDetailService.claimOwnDownload(item) : null);
let offscreenCreating;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('file-check.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) return;
  offscreenCreating ||= chrome.offscreen.createDocument({ url: 'file-check.html', reasons: ['DOM_PARSER', 'BLOBS'], justification: '读取用户选择的本地下载文件，校验Word正文和视频结构' }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}
async function verifyLocal(filename, kind, size) {
  await ensureOffscreen();
  let timeout;
  try { return await Promise.race([
    chrome.runtime.sendMessage({ type: 'tmeet.file-check', filename, kind, size }),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('本地校验超时，请检查目录权限或文件大小')), 20000); })
  ]); } finally { clearTimeout(timeout); }
}
/** 只查"下载文件夹是否已授权"，供面板在流程第 ② 步就给出提示，而不是等导出时失败。 */
async function localStatus() {
  await ensureOffscreen();
  let timeout;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type: 'tmeet.file-status' }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('读取下载目录状态超时')), 5000); })
    ]);
    return result || { granted: false, name: '', permission: 'none' };
  } finally { clearTimeout(timeout); }
}
/** 目录一致性实测：授权目录里能不能找到这个绝对路径（交给离屏文档读句柄）。 */
async function localContains(filename) {
  await ensureOffscreen();
  let timeout;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type: 'tmeet.file-contains', filename }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('目录比对超时')), 20000); })
    ]);
    return !!result?.matched;
  } catch { return false; } finally { clearTimeout(timeout); }
}
const journal = TMeetJournal.create(chrome, verifyLocal);
const sharedService = TMeetSharedService.create(chrome, licensing, journal);

/**
 * 推断浏览器当前的下载根目录（绝对路径）。
 *
 * 为什么需要它：File System Access 的目录句柄不暴露真实路径，
 * 插件没法把"用户授权的文件夹"和"浏览器实际下载的文件夹"直接对上。
 * 但 chrome.downloads 的记录里有绝对路径 —— 取最近一次下载完成的文件，
 * 剥掉本插件自己加的层级（腾讯会议录制下载/<日期>_<类型>/）就是下载根目录。
 *
 * 注意：这里只读路径，不改任何下载设置。
 */
function downloadRootOf(filename) {
  const p = String(filename || '').replace(/\\/g, '/');
  const m = p.match(/^(.*)\/腾讯会议录制下载\/[^/]+\/[^/]+$/);
  return (m ? m[1] : p.replace(/\/[^/]*$/, '')).replace(/\//g, '\\');
}
async function browserDownloadDir() {
  try {
    const items = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
    const hit = items.find(i => i.filename && i.state === 'complete' && i.exists !== false) || items.find(i => i.filename);
    if (!hit) return { path: '', name: '', file: '' };
    const path = downloadRootOf(hit.filename);
    return { path, name: path.split(/[\\/]/).pop() || '', file: hit.filename };
  } catch (e) {
    return { path: '', name: '', file: '', error: e.message };
  }
}
// 授权门槛缓存：录制页过去每翻一页、每个待导出条目都要联网校时一次（每次 3 发 HEAD）。
// 真正的拦截点是 acquire/prepare，它们仍逐次校验，所以缓存 30 秒不会放宽授权边界。
// 只用 Date.now() 判断缓存是否过期，不参与"当前时间"的结论 —— 时间始终来自联网校时。
let authCache = null;
async function requireLicense(maxAge = 30000) {
  const now = Date.now();
  if (authCache && now - authCache.at < maxAge) return authCache.status;
  const status = await licensing.require();
  authCache = { at: now, status };
  return status;
}
function meetingSource(value) {
  try {
    const url = new URL(value);
    return ['https:', 'blob:'].includes(url.protocol) &&
      new URL(url.protocol === 'blob:' ? url.pathname : url.href).hostname === 'meeting.tencent.com';
  } catch { return false; }
}
function isMeetingDownload(item) { return meetingSource(item.referrer) || meetingSource(item.url); }
let namingQueue = Promise.resolve();
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Chrome 要求 return true 的回调必须"suggest 恰好一次"，重复调用会报
  // "suggest was already called"；这里统一收口，异常路径也不会漏掉 suggest。
  let suggested = false;
  const reply = value => { if (suggested) return; suggested = true; suggest(value); };

  // v1.8.13：先认领"本扩展自己发起、且登记过实名"的下载（逐字稿）。
  // 必须放在最前面且同步返回，否则下面那套视频命名逻辑会把它的名字冲掉。
  const registered = claimOwnDownload(item);
  if (registered) {
    reply({ filename: registered, conflictAction: 'uniquify' });
    return true;
  }

  // 在事件到达时固定课程，避免并发准备下一门课程后串名。
  const leaseSnapshot = chrome.storage.session.get('batchLease');
  namingQueue = namingQueue.then(async () => {
    const intended = await sharedService.filename(item);
    if (intended) { reply({ filename: intended, conflictAction: 'uniquify' }); return; }
    if (item.byExtensionId === chrome.runtime.id || !isMeetingDownload(item)) { reply(); return; }
    const [{ config }, license, { batchLease }] = await Promise.all([chrome.storage.local.get('config'), licensing.status(), leaseSnapshot]);
    if (!license.active) { reply(); return; }
    let name = (item.filename || '').split(/[\\/]/).pop() || 'file';
    const leaseKey = 'download.ticket.' + batchLease?.ticket;
    const prior = (await chrome.storage.session.get(leaseKey))[leaseKey];
    // baseline 只在 prepare 写入；租约刚建立时显式兜底，避免中间态抛错让命名整体失败。
    const baseline = Array.isArray(batchLease?.baseline) ? batchLease.baseline : [];
    if (batchLease?.target?.name && (!prior || prior.id === item.id) && !baseline.includes(item.id) && (!item.startTime || item.startTime >= batchLease.since)) {
      const ext = TMeetSite.extensionOf(name, item.mime);
      const title = String(batchLease.target.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 140) || '课程';
      name = `${title}_${TMeetSite.isTranscriptExt(ext) ? '逐字稿' : '视频'}.${ext}`;
      await chrome.storage.session.set({ [leaseKey]: { id: item.id, name } });
    }
    if (!config?.autoClassify) { reply({ filename: name, conflictAction: 'uniquify' }); return; }
    const date = new Date(item.startTime || Date.now());
    const pad = n => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    reply({ filename: `腾讯会议录制下载/${day}_${TMeetSite.kindLabel(name)}/${name}`, conflictAction: 'uniquify' });
  }).catch(error => { console.error('下载命名失败', error.message); reply(); });
  return true;
});
// 消息串行化避免多标签页同时获得租约。会话存储跨 worker 休眠保留。
// 注意：所有会写 session 存储的操作（batchLease / shared.task.*）都必须经过本队列，
// 否则两个 handle 会各自读到旧副本再写回，造成"下载记录凭空消失"。
let queue = Promise.resolve();
chrome.downloads.onCreated?.addListener(item => {
  queue = queue.then(async () => {
    await sharedService.created(item);
    const { batchLease } = await chrome.storage.session.get('batchLease');
    const baseline = Array.isArray(batchLease?.baseline) ? batchLease.baseline : [];
    if (batchLease?.journalKey && !batchLease.shared) console.info('[SW][导出调试] ' + JSON.stringify({ step: 'download.created', id: item.id, state: item.state, hasReferrer: !!item.referrer, recognized: isMeetingDownload(item) }));
    if (batchLease?.journalKey && !batchLease.shared && isMeetingDownload(item) && !baseline.includes(item.id) && (!item.startTime || item.startTime >= batchLease.since)) {
      const r = await journal.get(batchLease.journalKey);
      if (r?.pending && !r.ids?.length) {
        await journal.attachItem(batchLease.journalKey, item);
        if ((await chrome.storage.session.get('stopped.' + batchLease.owner))['stopped.' + batchLease.owner]) await journal.pause([batchLease.journalKey]);
      }
    }
  }).catch(console.error);
});
async function handle(message, sender) {
  // 扩展页面可能带查询串（local-audit.html?pick=1），比较时必须先去掉，否则会被判成非法来源。
  const isPage = (url, file) => typeof url === 'string' && url.split('#')[0].split('?')[0] === chrome.runtime.getURL(file);
  const popup = sender.id === chrome.runtime.id && isPage(sender.url, 'popup.html');
  const sharedView = sender.id === chrome.runtime.id && isPage(sender.url, 'shared.html');
  const page = sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && meetingSource(sender.url);
  const audit = sender.id === chrome.runtime.id && isPage(sender.url, 'local-audit.html');
  // 工作台（batch.html）是主界面：选目录、看清单、开始导出都在那边，需要拿到本地授权状态。
  const batch = sender.id === chrome.runtime.id && isPage(sender.url, 'batch.html');
  if (!popup && !page && !sharedView && !audit && !batch) throw new Error('不允许的调用来源');
  if (message.op === 'open-panel') {
    // 优先把工作台开成录制页里的面板：录制页保持前台，导出才不会被
    // 定时器节流或 Memory Saver 冻结。没有录制页时才退回独立工作台。
    if (!popup && !page && !sharedView && !audit && !batch) throw new Error('不允许的调用来源');
    const list = await chrome.tabs.query({ url: 'https://meeting.tencent.com/user-center/meeting-record*' });
    const tab = list.find(t => t.url && /\/user-center\/meeting-record\/?$/.test(t.url)) || list[0];
    if (tab) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'tmeet.panel', action: 'open' });
        if (res?.ok) return { ok: true, mode: 'panel', tabId: tab.id };
      } catch { /* 页面脚本失联，退回独立工作台 */ }
    }
    return { ok: true, mode: 'tab', url: chrome.runtime.getURL('batch.html') };
  }
  if (message.op === 'open-batch') {
    // 工作台只留一个：重复打开时聚焦已有的那个，避免两个页面各自显示不同进度。
    const url = chrome.runtime.getURL('batch.html');
    const { batchTabId } = await chrome.storage.session.get('batchTabId');
    if (Number.isInteger(batchTabId)) {
      try {
        const existing = await chrome.tabs.get(batchTabId);
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
        return { tabId: existing.id, reused: true };
      } catch { /* 已关闭，重新创建 */ }
    }
    const tab = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.set({ batchTabId: tab.id });
    return { tabId: tab.id };
  }
  if (message.op === 'open-audit') {
    const base = chrome.runtime.getURL('local-audit.html');
    const params = [];
    if (message.pick) params.push('pick=1');
    if (message.close) params.push('close=1');
    const url = base + (params.length ? '?' + params.join('&') : '');
    // 选目录必须用普通标签页：chrome.windows.create 的 popup 窗口里选出的目录，
    // 离屏文档读不到句柄/权限（实测会出现"选完就掉"），所以这里不能图省事用 popup。
    if (message.pick) {
      const { pickTabId } = await chrome.storage.session.get('pickTabId');
      if (Number.isInteger(pickTabId)) {
        try {
          const existing = await chrome.tabs.get(pickTabId);
          await chrome.tabs.update(existing.id, { active: true });
          await chrome.windows.update(existing.windowId, { focused: true });
          return { tabId: existing.id };
        } catch { /* 已关闭 */ }
      }
      const tab = await chrome.tabs.create({ url, active: true });
      await chrome.storage.session.set({ pickTabId: tab.id });
      return { tabId: tab.id };
    }
    // 全量校验页是常规标签页：重复点击时聚焦已开的页面。
    const { auditTabId } = await chrome.storage.session.get('auditTabId');
    if (Number.isInteger(auditTabId)) {
      try {
        const existing = await chrome.tabs.get(auditTabId);
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
        return { tabId: existing.id };
      } catch { /* 已关闭，重新创建 */ }
    }
    const tab = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.set({ auditTabId: tab.id });
    return { tabId: tab.id };
  }
  if (message.op === 'journal.clear-pending') {
    // 工作台也要能解除：不然用户得跳到「全量校验」页逐条点，而列表上又看不出该点哪条。
    if (!audit && !batch && !page) throw new Error('不允许的操作');
    const keys = [...new Set([...(Array.isArray(message.keys) ? message.keys : []), message.key])]
      .filter(k => typeof k === 'string' && journal.parse(k));
    // 也允许按 { scope, fileId, kind } 指定：录制页只知道课程标识，不该去拼内部 key 格式。
    if (!keys.length && message.scope && message.fileId && message.kind) {
      keys.push(journal.key(message.scope, message.fileId, message.kind));
    }
    if (!keys.length) throw new Error('参数无效');
    const { batchLease } = await chrome.storage.session.get('batchLease');
    if (batchLease) throw new Error('请先停止运行中的导出任务');
    let cleared = 0;
    for (const key of keys) if (await journal.clearPending(key)) cleared++;
    return { cleared };
  }
  if (message.op === 'journal.pending') {
    // 列出"点了导出但结果不明"的课程：这些不能自动重试（可能已经下过），
    // 必须由用户确认后再放行，否则会一直卡在"跳过"状态永远导不出来。
    if (!page && !sharedView && !batch) throw new Error('不允许的操作');
    const keys = await journal.pending();
    return { pending: keys.map(k => ({ key: k, ...journal.parse(k) })).filter(item => item.fileId) };
  }
  if (message.op === 'journal.check') {
    if ((!page && !sharedView) || !['own', 'shared'].includes(message.scope) || typeof message.id !== 'string' || !['video', 'transcript'].includes(message.kind)) throw new Error('校验参数无效');
    const k = journal.key(message.scope, message.id, message.kind);
    if (message.resume) {
      await licensing.require();
      const { batchLease } = await chrome.storage.session.get('batchLease');
      if (batchLease?.owner !== sender.tab?.id) throw new Error('请先开始导出任务');
      if ((await chrome.storage.session.get('stopped.' + sender.tab.id))['stopped.' + sender.tab.id]) throw new Error('任务已停止');
      await chrome.storage.session.set({ batchLease: { ...batchLease, keys: [...new Set([...(batchLease.keys || []), k])] } });
    }
    const result = message.resume ? await journal.resume(k) : message.target ? await journal.adopt(k, { ...message.target, type: message.kind }) : await journal.check(k, message.kind);
    return { result };
  }
  if (message.op === 'journal.exported') {
    // 只返回已通过正文校验的课程标识，供工作台/录制页恢复"已下载"标记；不返回路径或文件内容。
    if (!page && !sharedView && !batch) throw new Error('不允许的操作');
    const list = await journal.verified();
    return { exported: list.map(journal.parse).filter(Boolean).map(({ scope, fileId, kind }) => ({ scope, fileId, kind })) };
  }
  if (message.op === 'open-download-folder') {
    // 只给扩展页面用：页面里的 content script 没有这个入口，不必开放。
    if (!popup && !sharedView && !audit && !batch) throw new Error('不允许的调用来源');
    // 优先定位最近一条本插件产生的下载，直接打开它所在的文件夹（用户可能选的不是默认下载目录）；
    // 没有下载记录时退回浏览器默认下载目录。
    // File System Access 拿到的句柄不暴露真实路径，所以这是唯一能"打开用户选的那个目录"的办法。
    try {
      const recent = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 10 });
      const hit = recent.find(item => item.state === 'complete' && isMeetingDownload(item));
      if (hit) { chrome.downloads.show(hit.id); return { opened: 'file', filename: hit.filename }; }
    } catch { /* 落到默认目录 */ }
    chrome.downloads.showDefaultFolder();
    return { opened: 'folder' };
  }
  if (message.op === 'local.status') {
    // 工作台/弹窗打开时先问一句"下载文件夹授权了吗"，未授权就在底栏提示，不要拖到导出时才失败。
    // 授权页自己也查一次：它写完句柄后要确认离屏文档真的读得到，否则不能关页面假装成功。
    if (!popup && !page && !sharedView && !audit && !batch) throw new Error('不允许的调用来源');
    try { return { dir: await localStatus() }; }
    catch (e) { return { dir: { granted: false, name: '', error: e.message } }; }
  }
  if (message.op === 'local.match') {
    // 目录一致性实测：授权目录里能不能找到这个绝对路径。
    // 面板跑在录制页（网页源），读不到扩展源的目录句柄，所以必须由这边问离屏文档。
    if (!popup && !page && !sharedView && !audit && !batch) throw new Error('不允许的调用来源');
    const filename = String(message.filename || '');
    if (!filename) return { matched: false };
    return { matched: await localContains(filename) };
  }
  if (message.op === 'open-dir-picker') {
    // content script 里不能调 showDirectoryPicker（File System Access 只对扩展页开放），
    // 所以面板第 ② 步弹一个小窗口去选，选完自动关，不用开工作台大标签页。
    if (!popup && !page && !sharedView && !batch) throw new Error('不允许的调用来源');
    const url = chrome.runtime.getURL('batch.html') + '?pick=1';
    const win = await chrome.windows.create({ url, type: 'popup', width: 560, height: 400, focused: true });
    return { ok: true, windowId: win?.id };
  }
  if (message.op === 'open-url') {
    // 只放行"下载设置"这一类固定地址，避免变成任意导航通道。
    if (!popup && !page && !sharedView && !batch) throw new Error('不允许的调用来源');
    const url = String(message.url || '');
    if (!/^(chrome|edge):\/\/(downloads|settings\/downloads)$/.test(url)) throw new Error('不允许的地址');
    await chrome.tabs.create({ url });
    return { ok: true };
  }
  if (message.op === 'local.dir-info') {
    // 授权状态 + 浏览器实际下载位置。两者对不上时，用户必须先改，不然导出会
    // "文件已下载但插件读不到"，整批卡在第一项。
    if (!popup && !page && !sharedView && !audit && !batch) throw new Error('不允许的调用来源');
    try {
      const dir = await localStatus();
      const browser = await browserDownloadDir();
      return { dir: { ...dir, downloadPath: browser.path, downloadName: browser.name, recentFile: browser.file } };
    } catch (e) {
      return { dir: { granted: false, name: '', error: e.message } };
    }
  }
  if (audit) throw new Error('不允许的操作');
  if (message.op === 'open-shared') {
    const url = chrome.runtime.getURL('shared.html');
    const { sharedControlTabId } = await chrome.storage.session.get('sharedControlTabId');
    if (Number.isInteger(sharedControlTabId)) {
      try {
        const existing = await chrome.tabs.get(sharedControlTabId);
        if (existing.url === url) {
          await chrome.tabs.update(existing.id, { active: true });
          await chrome.windows.update(existing.windowId, { focused: true });
          return { tabId: existing.id };
        }
      } catch { /* 原控制页已关闭，创建新页面 */ }
    }
    const tab = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.set({ sharedControlTabId: tab.id });
    return { tabId: tab.id };
  }
  if (typeof message.op === 'string' && message.op.startsWith('shared.')) return sharedService.handle(message, sender, sharedView);
  // v1.8.8：详情页逐字稿（打开详情页→抓 DOM→存 txt）。只允许扩展内部页面与录制页调用。
  if (typeof message.op === 'string' && message.op.startsWith('detail.')) {
    if (!popup && !page && !sharedView && !audit && !batch) throw new Error('不允许的调用来源');
    if (!detailService) return { ok: false, error: '逐字稿模块未加载，请重新加载扩展' };
    return detailService.handle(message, sender);
  }
  if (message.op === 'open-recordings') {
    const url = 'https://meeting.tencent.com/user-center/meeting-record';
    const tabs = await chrome.tabs.query({ url: url + '*' });
    const exact = tabs.filter(t => { try { return new URL(t.url).pathname.replace(/\/$/, '') === '/user-center/meeting-record'; } catch { return false; } });
    // 先挑"脚本还活着"的页面：扩展重载（⟳）之后旧页面里的脚本会失联，
    // 把用户聚焦到那种页面上，他只会看到工作台一直说"没连接"。
    let live = null;
    for (const t of exact) {
      try {
        const pong = await chrome.tabs.sendMessage(t.id, { type: 'tmeet.ping' });
        if (pong?.ready) { live = t; break; }
      } catch { /* 失联的旧页面，跳过 */ }
    }
    const fallback = exact.find(t => t.active) || exact[0];
    const target = live || fallback;
    if (!target) {
      const tab = await chrome.tabs.create({ url });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId: tab.id, created: true };
    }
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    // 全部都是失联的旧页面：顺手刷新一下，用户点一次第 1 步就能连上，不用自己去按 F5。
    if (!live) await chrome.tabs.reload(target.id).catch(() => {});
    return { tabId: target.id, reloaded: !live };
  }
  if (message.op === 'focus-recording-tab') {
    // 把录制页切到前台并把窗口唤回（最小化也算）。
    // 为什么需要：腾讯会议的「更多」菜单是 hover 才渲染的，页面不可见时菜单不出现，
    // 导出会直接卡在"找不到导出"。录制页自己拿不到 chrome.tabs，只能由后台代劳。
    if (!Number.isInteger(sender.tab?.id)) throw new Error('不允许的调用来源');
    await chrome.tabs.update(sender.tab.id, { active: true });
    const win = await chrome.windows.get(sender.tab.windowId).catch(() => null);
    if (win) await chrome.windows.update(win.id, { focused: true, state: 'normal' }).catch(() => {});
    // 顺手把录制页里的面板展开：用户被切过去时第一眼就能看到进度，
    // 而不是面对一个空白的录制页再去找悬浮球。
    await chrome.tabs.sendMessage(sender.tab.id, { type: 'tmeet.panel', action: 'open' }).catch(() => {});
    return { ok: true, tabId: sender.tab.id };
  }
  if (message.op === 'license.status') return { license: await licensing.status() };
  if (message.op === 'license.activate') { authCache = null; return { license: await licensing.activate(message.token) }; }
  if (message.op === 'authorize') return { license: await requireLicense() };
  if (message.op === 'local-ready') {
    const result = await verifyLocal('__tmeet_permission_probe__.docx', 'transcript');
    if (result.needsFolder) throw new Error(result.reason);
    return {};
  }
  if (!Number.isInteger(sender.tab?.id) || !meetingSource(sender.url)) throw new Error('不允许的调用来源');
  const owner = sender.tab.id;
  const { batchLease } = await chrome.storage.session.get('batchLease');
  if (message.op === 'acquire') {
    await licensing.require();
    await chrome.storage.session.remove('stopped.' + owner);
    if (batchLease && !(batchLease.owner === owner && batchLease.documentId && batchLease.documentId !== sender.documentId)) throw new Error('另一个腾讯会议标签页正在导出，请先停止任务或关闭该标签页');
    const running = await chrome.downloads.search({ state: 'in_progress', limit: 0 });
    // 索引替代 storage.local.get(null)：只读一个扁平数组，库变大也不再拖慢开始任务。
    const tracked = new Set(await journal.ids());
    if (running.some(i => isMeetingDownload(i) && !tracked.has(i.id))) throw new Error('仍有腾讯会议文件在传输，请等待完成或在浏览器中取消后再开始新批次');
    await chrome.storage.session.set({ batchLease: { owner, documentId: sender.documentId, keys: [] } });
    return {};
  }
  if (!batchLease || batchLease.owner !== owner) throw new Error('任务租约已失效，请重新开始');
  if (message.op === 'release') { await chrome.storage.session.remove('batchLease'); return {}; }
  if (message.op === 'prepare') {
    await licensing.require();
    if ((await chrome.storage.session.get('stopped.' + owner))['stopped.' + owner]) throw new Error('任务已停止');
    const target = message.target;
    if (!target?.fileId || !['video', 'transcript'].includes(target.type)) throw new Error('课程信息无效');
    const journalKey = journal.key('own', target.fileId, target.type);
    await journal.begin(journalKey, { ...target, owner });
    const since = new Date(Date.now() - 1000).toISOString();
    const items = await chrome.downloads.search({ startedAfter: since, limit: 0 });
    const ticket = crypto.randomUUID();
    await chrome.storage.session.set({ batchLease: { ...batchLease, owner, ticket, since, journalKey, keys: [...new Set([...(batchLease.keys || []), journalKey])], baseline: items.map(i => i.id), target: message.target && { name: String(message.target.name || '').slice(0, 200), fileId: String(message.target.fileId || '').slice(0, 200), type: message.target.type } } });
    return { ticket };
  }
  if (message.op === 'detect') {
    if (!message.ticket || message.ticket !== batchLease.ticket) throw new Error('下载识别窗口已失效');
    const items = await chrome.downloads.search({ startedAfter: batchLease.since, limit: 0 });
    const baseline = new Set(batchLease.baseline || []);
    const claims = batchLease.claims || {}, sources = batchLease.sources || {};
    const candidates = items.filter(i => !baseline.has(i.id) && isMeetingDownload(i) && (!claims[i.id] || claims[i.id].ticket === message.ticket));
    if (candidates.length === 1 && batchLease.target?.fileId) {
      const item = candidates[0], source = downloadSource(item), fileId = batchLease.target.fileId;
      if (source && sources[source] && sources[source] !== fileId) {
        // 这是本扩展刚触发的重复下载，立即停止，不按新课程名假报完成。
        if (item.state === 'in_progress') await chrome.downloads.cancel(item.id).catch(() => {});
        throw new Error('检测到当前课程返回了上一门课程的视频地址，已停止重复下载；请刷新录制目录后重新采集');
      }
      if (batchLease.journalKey) await journal.attachItem(batchLease.journalKey, item);
      claims[item.id] = { ticket: message.ticket, fileId };
      if (source) sources[source] = fileId;
      await chrome.storage.session.set({ batchLease: { ...batchLease, claims, sources } });
    }
    return { items: candidates.map(summary) };
  }
  if (message.op === 'status') {
    if (!Array.isArray(message.ids) || message.ids.length > 8 || !message.ids.every(Number.isInteger)) throw new Error('下载标识无效');
    const lists = await Promise.all(message.ids.map(id => chrome.downloads.search({ id })));
    return { items: lists.flat().map(summary) };
  }
  throw new Error('未知操作');
}
function downloadSource(item) {
  try {
    const url = new URL(item.finalUrl || item.url);
    url.hash = '';
    // 同一录制重新导出时签名会变化；签名不能把旧视频伪装成新课程。
    for (const name of [...url.searchParams.keys()]) if (/^(sign|signature|token|auth_key|t|ts|timestamp|expires?|expiry|expiration|q-sign.*)$/i.test(name)) url.searchParams.delete(name);
    url.searchParams.sort();
    return url.href;
  } catch { return ''; }
}
function summary(item) { return { id: item.id, state: item.state, error: item.error, paused: item.paused, bytesReceived: item.bytesReceived, exists: item.exists, fileSize: item.fileSize }; }
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'tmeet') return;
  const debugStarted = Date.now();
  const debugReply = (ok, error) => {
    if (['acquire', 'prepare', 'release', 'local-ready', 'journal.clear-pending'].includes(message.op) || !ok) console.info('[SW][导出调试] ' + JSON.stringify({ op: message.op, ok, ms: Date.now() - debugStarted, error }));
  };
  // 停止不排在联网授权和校验请求后面：先发停止信号，再暂停本批已关联的文件。
  if (message.op === 'stop-batch') {
    (async () => {
      if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || !meetingSource(sender.url) && sender.url !== chrome.runtime.getURL('shared.html')) throw new Error('不允许的操作');
      await chrome.storage.session.set({ ['stopped.' + sender.tab.id]: true });
      const { batchLease } = await chrome.storage.session.get('batchLease');
      if (batchLease?.owner === sender.tab.id) await journal.pause(batchLease.keys || []);
      return {};
    })().then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message })); return true;
  }
  queue = queue.then(() => handle(message, sender)).then(
    result => { debugReply(true); respond({ ok: true, ...result }); }, error => { debugReply(false, error.message); respond({ ok: false, error: error.message }); }
  );
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  queue = queue.then(async () => {
    const { batchLease, batchTabId } = await chrome.storage.session.get(['batchLease', 'batchTabId']);
    if (batchLease?.owner === tabId) await chrome.storage.session.remove('batchLease');
    // 工作台被关掉后要能重新打开，否则会一直去 get 一个不存在的 tab。
    if (batchTabId === tabId) await chrome.storage.session.remove('batchTabId');
    await sharedService.removed(tabId);
  }).catch(console.error);
});
