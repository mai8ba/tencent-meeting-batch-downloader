const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function modules() {
  const context = vm.createContext({ URL, TextEncoder, Uint8Array, DataView, btoa, crypto: require('node:crypto').webcrypto });
  for (const name of ['site-adapter.js', 'shared-core.js', 'shared-docx.js', 'shared-service.js']) vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  return context;
}
const api = modules().TMeetShared;
const sample = `群里无关说明，请忽略。
结营仪式回放：
录制: 测试结营课
日期: 2026-10-21 19:30:38
录制文件：https://meeting.tencent.com/crm/courseA
密码：0707
1.第一天课程回放
录制: 测试第一课
日期: 2026-10-12 19:31:22
录制文件：https://meeting.tencent.com/crm/courseB
密码：0123
2.第二天课程回放
录制: 测试第二课
日期: 2026-10-13 12:31:37
录制文件：https://meeting.tencent.com/crm/courseC
密码：0707`;

test('紧邻无空行、额外标题及说明文字不打乱课程和密码配对', () => {
  const items = api.parse(sample);
  assert.equal(items.length, 3);
  assert.deepEqual(Array.from(items, x => x.password), ['0707', '0123', '0707']);
  assert.deepEqual(Array.from(items, x => x.title), ['测试结营课', '测试第一课', '测试第二课']);
  assert.equal(items[1].date, '2026-10-12 19:31:22');
});
test('兼容 Markdown 粗体、引用、全角空格、零宽字符及 CRLF', () => {
  const items = api.parse('> **录制：**\u3000测试课\r\n> **录制文件：** <https://meeting.tencent.com/cw/tes\u200btA>\r\n> **密码：** 0707');
  assert.equal(items[0].title, '测试课'); assert.equal(items[0].password, '0707');
});
test('同一分享的 crm/cw 路径合并，保留带前导零的密码', () => {
  const items = api.parse(sample + '\n重复发一次：https://meeting.tencent.com/cw/courseA\n密码：0707');
  assert.equal(items.length, 3); assert.equal(items[0].password, '0707');
});
test('重复课程密码冲突显式报错', () => {
  assert.throws(() => api.parse(sample + '\nhttps://meeting.tencent.com/cw/courseA\n密码：9999'), /不同密码/);
});
test('只识别指定 HTTPS 分享路径，拒绝伪造域名和本地地址', () => {
  assert.equal(api.parse('https://meeting.tencent.com.evil.test/crm/a javascript:bad file:///a').length, 0);
  assert.equal(api.shareURL('https://meeting.tencent.com/user-center/meeting-record'), null);
  assert.equal(api.shareURL('http://meeting.tencent.com/crm/a'), null);
});
test('分享 id 允许连字符与下划线，不再被截断成前半段', () => {
  const items = api.parse('录制: 带连字符\nhttps://meeting.tencent.com/crm/abc-def_123\n密码：0707');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'abc-def_123');
  assert.equal(items[0].password, '0707');
  assert.equal(api.shareURL('https://meeting.tencent.com/cw/abc-def_123').pathname, '/cw/abc-def_123');
});
test('无标题密码的纯链接仍能生成课程清单', () => {
  const items = api.parse('查看：https://meeting.tencent.com/ct/courseA。说明无关。');
  assert.equal(items.length, 1); assert.equal(items[0].password, ''); assert.match(items[0].title, /courseA/);
});
test('兼容字段前编号及密码的括号、引号、反引号', () => {
  const result = api.parse('1、录制：测试\n2.录制文件：HTTPS://meeting.tencent.com/crm/testA\n3.密码：（0707）');
  assert.equal(result[0].title, '测试'); assert.equal(result[0].password, '0707');
  assert.equal(api.parse('https://meeting.tencent.com/crm/testB\n密码：`0123`')[0].password, '0123');
});
test('粘贴时丢失换行的单行文字仍能按字段拆分', () => {
  const items = api.parse('额外说明 录制: 第一课 日期: 2026-10-23 10:00:00 录制文件: https://meeting.tencent.com/crm/testA 密码: 0707 录制: 第二课 日期: 2026-10-24 10:00:00 录制文件: https://meeting.tencent.com/crm/testB 密码: 0123');
  assert.equal(items.length, 2); assert.equal(items[0].title, '第一课'); assert.equal(items[1].password, '0123');
  assert.equal(items[0].date, '2026-10-23 10:00:00');
});
test('视频链接校验拒绝不可信域名、伪造域名和流式清单', () => {
  for (const value of ['https://evil.test/a.mp4', 'https://qq.com.evil.test/a.mp4', 'file:///a.mp4', 'https://cdn.qq.com/a.m3u8', 'blob:https://meeting.tencent.com/a']) assert.equal(api.mediaURL(value), null);
  assert.equal(api.mediaURL('https://cdn.qq.com/a.mp4?sig=temporary'), 'https://cdn.qq.com/a.mp4?sig=temporary');
});
test('转写词语拼为段落，保留中文、发言人及毫秒时间戳', () => {
  const data = { code: 0, more: false, minutes: { paragraphs: [{ pid: 'p1', start_time: 1234, speaker: { user_name: '老师' }, sentences: [{ words: [{ text: '你好' }, { text: '，世界。' }] }] }] } };
  const result = api.extract('/wemeet-cloudrecording-webapi/v1/minutes/detail', data);
  assert.equal(result.complete, true); assert.equal(result.segments[0].text, '你好，世界。');
  assert.equal(result.segments[0].speaker, '老师'); assert.equal(result.segments[0].start, 1234);
  data.more = true; assert.equal(api.extract('/x/minutes/detail', data).complete, false);
  delete data.more; assert.equal(api.extract('/x/minutes/detail', data).complete, false);
});
test('权限失败响应不能被当成可下载数据', () => {
  assert.equal(Object.keys(api.extract('/x/common-record-info', { code: -1, data: { allow_download: true } })).length, 0);
});
test('密码验证前空录制列表的 allow_download=false 不误判为分享者禁止下载', () => {
  const first = api.extract('/x/common-record-info', { code: 0, data: { allow_download: false, recordings: [] } });
  assert.equal(first.allowVideo, undefined);
  const opened = api.extract('/x/common-record-info', { code: 0, data: { allow_download: false, recordings: [{ id: 'record' }] } });
  assert.equal(opened.allowVideo, false);
});

function observerHarness() {
  const handlers = new Map(), emitted = [];
  const response = { ok: true, clone: () => ({ json: async () => ({ code: 0, more: false, minutes: { paragraphs: [] } }) }) };
  let originalPromise;
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  class XHR { open() {} send() {} }
  const window = {
    fetch() { originalPromise = Promise.resolve(response); return originalPromise; },
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    dispatchEvent(event) { if (event.type === 'tmeet.shared.capture') emitted.push(event.detail); for (const fn of handlers.get(event.type) || []) fn(event); }
  };
  const ctx = vm.createContext({ window, location: { href: 'https://meeting.tencent.com/cw/test' }, URL, CustomEvent, XMLHttpRequest: XHR });
  vm.runInContext(fs.readFileSync(path.join(root, 'shared-observer.js'), 'utf8'), ctx);
  return { window, emitted, ready() { window.dispatchEvent(new CustomEvent('tmeet.shared.ready')); }, promise: () => originalPromise };
}
test('MAIN 观察脚本不依赖隔离世界变量，保留原 fetch Promise 并发送响应', async () => {
  const h = observerHarness(); h.ready();
  const result = h.window.fetch('/wemeet-cloudrecording-webapi/v1/minutes/detail');
  assert.equal(result, h.promise()); await new Promise(setImmediate);
  assert.equal(JSON.parse(h.emitted[0]).path, '/wemeet-cloudrecording-webapi/v1/minutes/detail');
});
test('隔离脚本晚就绪时重放早到的响应，不漏掉小响应', async () => {
  const h = observerHarness(); h.window.fetch('/wemeet-cloudrecording-webapi/v1/minutes/detail');
  await new Promise(setImmediate); assert.equal(h.emitted.length, 0);
  h.ready(); assert.equal(h.emitted.length, 1);
});
test('观察脚本不会捕获无关网络响应', async () => {
  const h = observerHarness(); h.ready(); h.window.fetch('https://example.com/minutes/detail');
  await new Promise(setImmediate); assert.equal(h.emitted.length, 0);
});
test('DOCX 为真实 ZIP，OOXML 转义且保留文本及时间戳', () => {
  const context = modules();
  const bytes = Buffer.from(context.TMeetDocx.create('课程 & 标题', '2026-10-23', [{ start: 65000, speaker: '老师', text: '<script>纯文本</script>' }]));
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  let offset = 0, document;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const begin = offset + 30 + nameLength + extra;
    if (name === 'word/document.xml') document = bytes.subarray(begin, begin + length).toString();
    offset = begin + length;
  }
  assert.match(document, /课程 &amp; 标题/); assert.match(document, /&lt;script&gt;纯文本/); assert.match(document, /00:01:05/);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
});
function service() {
  const context = modules(), data = {}, downloads = [], tabs = new Map(); let next = 100, active = true;
  let segmentReads = 0, segmentWrites = 0;
  const isSegment = k => typeof k === 'string' && k.startsWith('shared.segments.');
  const storage = {
    async get(k) { if (isSegment(k)) segmentReads++; return structuredClone(k === null ? data : { [k]: data[k] }); },
    async set(v) { if (Object.keys(v).some(isSegment)) segmentWrites++; Object.assign(data, structuredClone(v)); },
    async remove(k) { delete data[k]; }
  };
  const chrome = { runtime: { id: 'extension' }, storage: { session: storage, local: storage },
    tabs: { async create(options) { const tab = { id: ++next, windowId: 1, ...options }; tabs.set(tab.id, tab); return tab; },
      async update(id, values) { if (!tabs.has(id)) throw new Error('missing'); Object.assign(tabs.get(id), values); return tabs.get(id); }, async remove(id) { tabs.delete(id); }, async sendMessage() { return { ok: true }; } },
    windows: { async update() {} }, downloads: {
      async search(query) { return downloads.filter(d => query.id !== undefined ? d.id === query.id : query.state ? d.state === query.state : true); },
      async download(options) { const d = { id: downloads.length + 1, state: 'in_progress', ...options }; downloads.push(d); return d.id; }
    }
  };
  const manager = context.TMeetSharedService.create(chrome, { async require() { if (!active) throw new Error('未激活'); } });
  const owner = { tab: { id: 1 }, url: 'chrome-extension://extension/shared.html' };
  const call = (op, extra = {}, sender = owner, isView = true) => manager.handle({ op, ...extra }, sender, isView);
  const open = async () => { await call('shared.begin'); return (await call('shared.open', { item: { id: 'courseA', url: 'https://meeting.tencent.com/crm/courseA', title: '测试课程', password: '0707' } })).job.tabId; };
  const capture = (tabId, delta) => call('shared.capture', { delta }, { tab: { id: tabId }, url: 'https://meeting.tencent.com/cw/courseA' }, false);
  return { manager, call, open, capture, data, downloads, tabs, disable: () => { active = false; },
    get segmentReads() { return segmentReads; }, get segmentWrites() { return segmentWrites; } };
}
test('密码只发给本扩展创建的课程页；未知标签页没有密码', async () => {
  const h = service(), tabId = await h.open();
  assert.equal((await h.call('shared.probe', {}, { tab: { id: tabId }, url: 'https://meeting.tencent.com/cw/courseA' }, false)).password, '0707');
  assert.equal((await h.call('shared.probe', {}, { tab: { id: 999 }, url: 'https://meeting.tencent.com/cw/courseA' }, false)).enabled, false);
});
test('未取得全文时拒绝导出；接收末页后合并去重生成 DOCX', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { segments: [{ id: '1', start: 0, text: '第一段' }], complete: false });
  await assert.rejects(h.call('shared.download', { tabId, kind: 'transcript' }), /完整逐字稿/);
  await h.capture(tabId, { segments: [{ id: '1', start: 0, text: '第一段' }, { id: '2', start: 1000, text: '第二段' }], complete: true });
  assert.equal((await h.call('shared.status', { tabId })).job.segmentCount, 2);
  const result = await h.call('shared.download', { tabId, kind: 'transcript' });
  assert.equal(result.ids.length, 1); assert.match(h.downloads[0].filename, /逐字稿.docx$/);
  assert.match(h.downloads[0].url, /^data:application\/vnd.openxmlformats/);
});
test('设备授权过期后后台拒绝新下载', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { segments: [{ id: '1', start: 0, text: '全文' }], complete: true }); h.disable();
  await assert.rejects(h.call('shared.download', { tabId, kind: 'transcript' }), /未激活/);
});
test('分享者禁止视频下载时后台拒绝，允许后保存真实下载 ID', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { allowVideo: false, videos: [{ url: 'https://cdn.qq.com/test.mp4' }] });
  await assert.rejects(h.call('shared.download', { tabId, kind: 'video' }), /未开放/);
  await h.capture(tabId, { allowVideo: true });
  const result = await h.call('shared.download', { tabId, kind: 'video' });
  assert.equal(result.ids[0], 1);
  assert.equal((await h.call('shared.download-status', { tabId })).items[0].state, 'in_progress');
  h.downloads[0].state = 'complete';
  assert.equal((await h.call('shared.download-status', { tabId })).items[0].state, 'complete');
});
test('同一课程重试不重复下载已完成或传输中的文件', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { allowVideo: true, videos: [{ url: 'https://cdn.qq.com/test.mp4' }] });
  await h.call('shared.download', { tabId, kind: 'video' });
  await h.call('shared.download', { tabId, kind: 'video' });
  assert.equal(h.downloads.length, 1);
  h.downloads[0].state = 'interrupted';
  await assert.rejects(h.call('shared.download', { tabId, kind: 'video' }), /中断/);
  await h.call('shared.download', { tabId, kind: 'video', retry: true });
  assert.equal(h.downloads.length, 2);
});
test('其他控制页不能读取或下载本页课程', async () => {
  const h = service(), tabId = await h.open();
  await assert.rejects(h.call('shared.status', { tabId }, { tab: { id: 2 } }, true), /不存在/);
});
test('课程标签页切换到其他分享后停止采集，防止串课程', async () => {
  const h = service(), tabId = await h.open();
  const result = await h.call('shared.capture', { delta: { segments: [{ id: '1', text: '错误课程' }] } }, { tab: { id: tabId }, url: 'https://meeting.tencent.com/cw/courseB' }, false);
  assert.equal(result.enabled, false); assert.match((await h.call('shared.status', { tabId })).job.error, /另一分享/);
});
test('原网页下载按钮回退能关联下载 ID，并排除其他分享的下载', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { allowVideo: true, hasDownloadButton: true });
  assert.equal((await h.call('shared.download', { tabId, kind: 'video' })).pending, true);
  await h.manager.created({ id: 99, referrer: 'https://meeting.tencent.com/cw/courseB' });
  assert.equal((await h.call('shared.status', { tabId })).job.downloads.video.length, 0);
  await h.manager.created({ id: 100, referrer: 'https://meeting.tencent.com/cw/courseA' });
  assert.equal((await h.call('shared.status', { tabId })).job.downloads.video[0], 100);
});
test('停止批次时清除待确认的原网页下载状态', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { allowVideo: true, hasDownloadButton: true });
  await h.call('shared.download', { tabId, kind: 'video' });
  assert.ok(h.data.sharedNativePending);
  await h.call('shared.end'); assert.equal(h.data.sharedNativePending, undefined);
});
test('上一批已有下载 ID 仍在传输时，不能开启新批次叠加并发', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { allowVideo: true, videos: [{ url: 'https://cdn.qq.com/test.mp4' }] });
  await h.call('shared.download', { tabId, kind: 'video' }); await h.call('shared.end');
  await assert.rejects(h.call('shared.begin'), /仍在传输/);
  h.downloads[0].state = 'complete'; await h.call('shared.begin');
});



test('未开始批次时打开课程也创建带密码的受管任务', async () => {
  const h = service();
  const { job } = await h.call('shared.view', { item: { url: 'https://meeting.tencent.com/crm/courseA', title: '课程标题', password: '0707' } });
  assert.equal((await h.call('shared.probe', {}, { tab: { id: job.tabId }, url: 'https://meeting.tencent.com/cw/courseA' }, false)).password, '0707');
  assert.equal(h.data.batchLease, undefined);
});
test('网页原生下载的默认DOCX名按分享课程命名，其他课程不串名', async () => {
  const h = service(); await h.open();
  assert.equal(await h.manager.filename({ id: 901, filename: '下载.docx', referrer: 'https://meeting.tencent.com/cw/courseA' }), '腾讯会议分享课程/测试课程_courseA_逐字稿.docx');
  assert.equal(await h.manager.filename({ id: 902, filename: '下载.docx', referrer: 'https://meeting.tencent.com/cw/courseB' }), null);
  assert.equal(await h.manager.filename({ id: 901, filename: '下载.docx', referrer: '' }), '腾讯会议分享课程/测试课程_courseA_逐字稿.docx');
});
test('程序生成DOCX下载记录持久保存课程名称，缺失referrer仍可恢复', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { complete: true, segments: [{ id: 'p', text: '测试' }] });
  const { ids } = await h.call('shared.download', { tabId, kind: 'transcript' });
  assert.equal(await h.manager.filename({ id: ids[0], filename: '下载.docx', url: h.downloads[0].url }), '腾讯会议分享课程/测试课程_courseA_逐字稿.docx');
});
test('状态轮询只读元数据，不反复搬运逐字稿正文', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { segments: [{ id: '1', start: 0, text: '一' }], complete: true });
  const reads = h.segmentReads;
  for (let i = 0; i < 5; i++) assert.equal((await h.call('shared.status', { tabId })).job.segmentCount, 1);
  assert.equal(h.segmentReads, reads, '状态轮询不能读 IndexedDB 正文');
  await h.call('shared.download', { tabId, kind: 'transcript' });
  assert.ok(h.segmentReads > reads, '只有真正生成 DOCX 时才允许读正文');
});
test('页面状态/视频地址更新不重写整份正文', async () => {
  const h = service(), tabId = await h.open();
  await h.capture(tabId, { segments: [{ id: '1', start: 0, text: '一' }], complete: true });
  const writes = h.segmentWrites;
  await h.capture(tabId, { pageStatus: '正在读取课程数据' });
  await h.capture(tabId, { allowVideo: true, hasDownloadButton: true });
  await h.capture(tabId, { videos: [{ url: 'https://cdn.qq.com/a.mp4' }] });
  assert.equal(h.segmentWrites, writes, '元数据更新不能重写正文');
  await h.capture(tabId, { segments: [{ id: '2', start: 1000, text: '二' }] });
  assert.equal(h.segmentWrites, writes + 1, '正文变化必须落库，不能丢分页');
});
test('逐字稿 base64 分块编码与标准实现一致', () => {
  const context = modules();
  for (const text of ['', 'a', 'ab', 'abc', '中文内容', 'x'.repeat(9001)]) {
    const bytes = new Uint8Array(Buffer.from(text));
    assert.equal(context.TMeetSharedService.toBase64(bytes), Buffer.from(text).toString('base64'));
  }
});
test('录制信息字段无法识别时带回诊断键名，便于定位站点改版', () => {
  const context = modules();
  const out = context.TMeetShared.extract('/wemeet/common-record-info', { code: 0, data: { foo: 1, bar: 2 } });
  assert.match(out.diagnostic, /foo,bar/);
  const normal = context.TMeetShared.extract('/wemeet/common-record-info', { code: 0, data: { allow_download: true, recordings: [{ download_url: 'https://cdn.qq.com/a.mp4' }] } });
  assert.equal(normal.diagnostic, undefined);
});
