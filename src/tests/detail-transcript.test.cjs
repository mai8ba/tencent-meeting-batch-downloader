/* v1.8.8 详情页逐字稿：纯函数单测。
 * 覆盖：段落收集去重、兜底文本收集、txt 组装、文件名清洗、base64(UTF-8 中文)。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const detailSrc = fs.readFileSync(path.join(root, 'detail-transcript.js'), 'utf8');
const serviceSrc = fs.readFileSync(path.join(root, 'detail-service.js'), 'utf8');

function detailCtx(listeners = {}, doc = null) {
  const win = { addEventListener(type, fn) { (listeners[type] ||= []).push(fn); } };
  const ctx = vm.createContext({
    console, TextEncoder, setTimeout,
    location: { href: 'https://meeting.tencent.com/cw/test' },
    window: win,
    document: doc,
    chrome: { runtime: { onMessage: { addListener() {} } } },
  });
  vm.runInContext(detailSrc, ctx);
  return ctx.TMeetDetail;
}
// 造一个 paragraphs 段落（接口原始结构）
function apiPara(pid, seconds, speaker, txt) {
  return { pid, start_time: seconds * 1000, speaker: { user_name: speaker }, sentences: [{ words: [{ text: txt }] }] };
}
function fireCapture(listeners, payload) {
  for (const fn of listeners['tmeet.shared.capture'] || []) fn({ detail: JSON.stringify(payload) });
}
function serviceCtx() {
  const ctx = vm.createContext({
    console, TextEncoder, URL, setTimeout: () => 0,
    Blob: class { constructor(parts) { this.parts = parts; } },
    chrome: {
      downloads: { download() { return 1; } },
      runtime: { sendMessage() { return Promise.resolve({ ok: true, id: 1 }); } },
    },
  });
  ctx.URL.createObjectURL = () => 'blob:stub';
  ctx.URL.revokeObjectURL = () => {};
  vm.runInContext(serviceSrc, ctx);
  return ctx.TMeetDetailService;
}

// 极简节点：只实现抓取脚本用到的 API
function node(attrs = {}, textValue = '', children = []) {
  return {
    attrs, children,
    get textContent() { return textValue + children.map(c => c.textContent).join(''); },
    getAttribute(k) { return attrs[k] ?? null; },
    querySelector(sel) { return find(this, sel); },
    querySelectorAll(sel) { return findAll(this, sel); },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    isConnected: true,
  };
}
function match(node, sel) {
  const m = /^\[class\*="([^"]+)"\]$/.exec(sel);
  if (m) return String(node.attrs.class || '').includes(m[1]);
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const p = /^\[([^=]+)="([^"]+)"\]$/.exec(sel);
    if (p) return node.attrs[p[1]] === p[2];
    const q = /^\[([^=\]]+)\]$/.exec(sel);
    if (q) return node.attrs[q[1]] !== undefined;
  }
  return node.attrs.tag === sel.toLowerCase();
}
function findAll(root, sel) {
  const out = [];
  for (const c of root.children) {
    for (const s of sel.split(',').map(x => x.trim())) if (match(c, s)) out.push(c);
    out.push(...findAll(c, sel));
  }
  return out;
}
function find(root, sel) { return findAll(root, sel)[0] || null; }

test('collectVisible：按 class 取发言人/时间/正文，并用 data-pid 去重', () => {
  const d = detailCtx();
  const para = (pid, speaker, time, body) => node({ class: 'paragraph-module_paragraph', 'data-pid': String(pid) }, '', [
    node({ class: 'speaker-name' }, speaker),
    node({ class: 'p-start-time' }, time),
    node({ class: 'paragraph-module_sentences' }, body),
  ]);
  const container = node({}, '', [
    para(1, '麦爸', '00:02', '听歌能听到吗？'),
    para(2, '张连军', '00:07', '能听到吃完饭了吗？'),
    para(2, '张连军', '00:07', '能听到吃完饭了吗？'), // 重复 pid
  ]);
  const got = d.collectVisible(container);
  assert.equal(got.length, 2, '重复 pid 被去掉');
  // 跨 vm 上下文对象原型不同，逐字段比较而不是 deepEqual
  assert.equal(got[0].pid, 1);
  assert.equal(got[0].speaker, '麦爸');
  assert.equal(got[0].time, '00:02');
  assert.equal(got[0].text, '听歌能听到吗？');
});

test('collectVisible：没有 data-pid 时用 时间+正文 做键，同样去重', () => {
  const d = detailCtx();
  const para = (time, body) => node({ class: 'paragraph-module_paragraph' }, '', [
    node({ class: 'p-start-time' }, time),
    node({ class: 'paragraph-module_sentences' }, body),
  ]);
  const container = node({}, '', [para('00:03', '甲'), para('00:03', '甲')]);
  assert.equal(d.collectVisible(container).length, 1);
});

test('format：拼成 [时间] 发言人：正文 的纯文本', () => {
  const d = detailCtx();
  const out = d.format([
    { pid: 1, speaker: '麦爸', time: '00:02', text: '听歌能听到吗？' },
    { pid: 2, speaker: '', time: '', text: '无时间的一行' },
  ]);
  assert.equal(out, '[00:02] 麦爸：听歌能听到吗？\n无时间的一行\n');
});

test('safeName：文件名非法字符替换、去空白、限长、空名兜底', () => {
  const s = serviceCtx();
  assert.equal(s.safeName('军哥云咖啡'), '军哥云咖啡');
  assert.equal(s.safeName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
  assert.equal(s.safeName('  多  空格  '), '多 空格');
  assert.equal(s.safeName(''), '逐字稿');
  assert.ok(s.safeName('x'.repeat(500)).length <= 160);
});

test('detailTab：只认会议详情页 cw/crm，不认清单页', () => {
  const s = serviceCtx();
  assert.equal(s.detailTab({ url: 'https://meeting.tencent.com/cw/abc123' }), true);
  assert.equal(s.detailTab({ url: 'https://meeting.tencent.com/crm/abc123' }), true);
  assert.equal(s.detailTab({ url: 'https://meeting.tencent.com/user-center/meeting-record' }), false);
  assert.equal(s.detailTab({ url: 'https://evil.test/cw/abc' }), false);
});

test('msToClock：毫秒时间戳转 mm:ss', () => {
  const d = detailCtx();
  assert.equal(d.msToClock(0), '00:00');
  assert.equal(d.msToClock(2000), '00:02');
  assert.equal(d.msToClock(65000), '01:05');
  assert.equal(d.msToClock(3661000), '61:01');
  assert.equal(d.msToClock(null), '00:00');
});

test('fromApiData：解析 /minutes/detail 接口结构成段落（接口快路）', () => {
  const d = detailCtx();
  const payload = {
    code: 0,
    minutes: {
      paragraphs: [
        { pid: 1, start_time: 2000, speaker: { user_name: '麦爸' }, sentences: [{ words: [{ text: '听歌' }, { text: '能听到吗？' }] }] },
        { pid: 2, start_time: 7000, speaker: { user_name: '张连军' }, sentences: [{ words: [{ text: '能听到' }] }] },
        { pid: 3, start_time: 9000, speaker: {}, sentences: [] }, // 正文空，丢弃
      ],
    },
  };
  const got = d.fromApiData(payload);
  assert.equal(got.length, 3 - 1, '空正文段落被丢掉');
  assert.equal(got[0].pid, 1);
  assert.equal(got[0].time, '00:02');
  assert.equal(got[0].speaker, '麦爸');
  assert.equal(got[0].text, '听歌能听到吗？');
  assert.equal(got[1].time, '00:07');
  assert.equal(d.format(got), '[00:02] 麦爸：听歌能听到吗？\n[00:07] 张连军：能听到\n');
});

test('fromApiData：data.data.minutes 嵌套结构也能解析；code 非0 拒绝', () => {
  const d = detailCtx();
  const nested = { code: 0, data: { detail: { minutes: { paragraphs: [
    { pid: 5, start_time: 1000, speaker: { user_name: '甲' }, sentences: [{ words: [{ text: '内容' }] }] },
  ] } } } };
  assert.equal(d.fromApiData(nested).length, 1);
  assert.equal(d.fromApiData({ code: 401, minutes: { paragraphs: [] } }).length, 0, '接口报错不解析');
  assert.equal(d.fromApiData(null).length, 0);
});

test('接口快路：分页响应按 pid 累积合并，乱序也还原，complete 后一次取全文', async () => {
  const listeners = {};
  // 用假 DOM：当前已在逐字稿标签，避免 clickTranscriptTab 走 DOM
  const activeTab = { class: 'tab', 'aria-selected': 'true' };
  activeTab.textContent = '逐字稿';
  const doc = { querySelector() { return activeTab; }, querySelectorAll() { return []; } };
  const d = detailCtx(listeners, doc);
  // 第一页（more=1，还有下一页），pid 3、4
  fireCapture(listeners, { path: '/minutes/detail', data: { code: 0, more: 1, minutes: { paragraphs: [
    apiPara(3, 30, '乙', '第三段'), apiPara(4, 40, '丙', '第四段'),
  ] } } });
  // 第二页（more=0 最后一页）乱序到达，pid 1、2
  fireCapture(listeners, { path: '/minutes/detail', data: { code: 0, more: 0, minutes: { paragraphs: [
    apiPara(2, 20, '甲', '第二段'), apiPara(1, 10, '麦爸', '第一段'),
  ] } } });
  const r = await d.capture();
  assert.equal(r.ok, true);
  assert.equal(r.source, 'api', '走了接口快路，不是 DOM 兜底');
  assert.equal(r.count, 4, '两页 4 段都拿到，没有只留最后一页');
  assert.equal(r.text, '[00:10] 麦爸：第一段\n[00:20] 甲：第二段\n[00:30] 乙：第三段\n[00:40] 丙：第四段\n');
  delete global.document;
});

test('接口快路：真实的长接口路径（带 /wemeet-cloudrecording-webapi 前缀）也能命中', async () => {
  // v1.8.9 曾把判断写成 === '/minutes/detail'，真实路径带前缀导致永远不匹配、全部退回爬取。
  const listeners = {};
  const activeTab = { class: 'tab', 'aria-selected': 'true' };
  activeTab.textContent = '逐字稿';
  const doc = { querySelector() { return activeTab; }, querySelectorAll() { return []; } };
  const d = detailCtx(listeners, doc);
  fireCapture(listeners, {
    path: '/wemeet-cloudrecording-webapi/v1/minutes/detail',
    data: { code: 0, more: 0, minutes: { paragraphs: [apiPara(1, 2, '麦爸', '听歌能听到吗？')] } },
  });
  const r = await d.capture();
  assert.equal(r.ok, true);
  assert.equal(r.source, 'api');
  assert.equal(r.text, '[00:02] 麦爸：听歌能听到吗？\n');
});

// 造一个"只记录后台委托给离屏页建链接、以及随后真正的下载"的上下文
function saveCtx() {
  let sent = null, dl = null;
  const ctx = vm.createContext({
    console, TextEncoder, URL, setTimeout: () => 0,
    chrome: {
      runtime: { sendMessage(msg) { sent = msg; return Promise.resolve({ ok: true, url: 'blob:ext/1' }); } },
      downloads: { download(o) { dl = o; return Promise.resolve(9); } },
    },
  });
  vm.runInContext(serviceSrc, ctx);
  return { s: ctx.TMeetDetailService, getSent: () => sent, getDl: () => dl };
}

test('localDate / transcriptFilename：本地日期，文件名前缀带 YYYYMMDD', () => {
  const s = serviceCtx();
  // 固定一个本地时间点验证格式（月份/日期补零）
  const d = s.localDate(new Date(2026, 0, 5, 23, 30)); // 2026-01-05 23:30 本地
  assert.equal(d.folder, '2026-01-05');
  assert.equal(d.stamp, '20260105');
  assert.equal(
    s.transcriptFilename({ stem: '448436389', day: d }),
    '腾讯会议录制下载/2026-01-05_逐字稿/20260105_448436389_逐字稿.txt'
  );
});

test('detail.save：文件名 = 日期_课程名_会议号_逐字稿.txt，后台用离屏链接下载', async () => {
  const { s, getSent, getDl } = saveCtx();
  const r = await s.create({ licensing: { require: async () => {} } }).handle(
    { op: 'detail.save', content: '麦爸 听歌能听到吗？', name: '菲菲辅导麦爸', meetingId: '235 263 476' },
    {}
  );
  assert.equal(r.ok, true);
  const sent = getSent();
  assert.equal(sent.type, 'tmeet.blob-url', '先请离屏页建 blob 链接');
  const dl = getDl();
  assert.equal(dl.url, 'blob:ext/1', '后台用离屏返回的 blob 链接下载');
  assert.match(dl.filename, /^腾讯会议录制下载\/\d{4}-\d{2}-\d{2}_逐字稿\/\d{8}_菲菲辅导麦爸_235263476_逐字稿\.txt$/);
  assert.ok(dl.filename.includes('菲菲辅导麦爸'), '课程名必须在文件名里，否则下载列表认不出是哪门课');
});

test('v1.8.14 transcriptStem：课程名+会议号；超长截断；缺一项时不留下多余下划线', () => {
  const s = serviceCtx();
  assert.equal(s.transcriptStem({ name: '菲菲辅导麦爸', meetingId: '235 263 476' }), '菲菲辅导麦爸_235263476');
  assert.equal(s.transcriptStem({ name: '只有课程名', meetingId: '' }), '只有课程名');
  assert.equal(s.transcriptStem({ name: '', meetingId: '448436389' }), '448436389');
  assert.equal(s.transcriptStem({}), '逐字稿', '两头都缺时退回通用名');
  // 课程名里的非法字符被替换，超长截断到 60 字（会议号仍保留）
  const stem = s.transcriptStem({ name: 'a/b:c'.repeat(40), meetingId: '123456789' });
  assert.ok(!/[\\/:*?"<>|]/.test(stem), '文件名不含非法字符：' + stem);
  assert.ok(stem.endsWith('_123456789'), '会议号要留在末尾');
  assert.ok(stem.split('_123456789')[0].length <= 60, '课程名截断到 60 字');
});

test('v1.8.13 实名登记：下载前登记会议号文件名，监听器能认领到同一个名字（防退化成 UUID）', async () => {
  const { s, getDl } = saveCtx();
  await s.create({ licensing: { require: async () => {} } }).handle(
    { op: 'detail.save', content: '正文', name: '课程', meetingId: '448436389' }, {}
  );
  const claimed = s.claimOwnDownload({ url: getDl().url });
  assert.ok(claimed && claimed.endsWith('_448436389_逐字稿.txt'), '认领到会议号命名：' + claimed);
  assert.equal(claimed, getDl().filename, 'onDeterminingFilename 认领的名字必须与 download() 传入的一致');
  // 同一链接只认领一次，避免并发下载串名
  assert.equal(s.claimOwnDownload({ url: getDl().url }), null, '重复认领返回 null');
});

test('v1.8.13 claimOwnDownload：未登记的下载返回 null，不干扰视频链路默认命名', () => {
  const s = serviceCtx();
  assert.equal(s.claimOwnDownload({ url: 'blob:chrome-extension://abc/not-registered' }), null);
  assert.equal(s.claimOwnDownload(null), null);
  assert.equal(s.claimOwnDownload({}), null);
});

test('v1.8.13 background：实名认领必须排在"本扩展下载空 suggest"之前', () => {
  const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const listenerAt = bg.indexOf('onDeterminingFilename.addListener');
  const claimAt = bg.indexOf('const registered = claimOwnDownload(item)');
  const blankAt = bg.indexOf('item.byExtensionId === chrome.runtime.id');
  assert.ok(listenerAt > 0 && claimAt > 0 && blankAt > 0, '三处代码都应存在');
  assert.ok(claimAt > listenerAt, '认领要写在 onDeterminingFilename 监听器内部');
  assert.ok(claimAt < blankAt, '认领必须在空 suggest 分支之前，否则名字又被冲成 UUID');
});

test('detail.save：没有会议号时退回安全化课程名（仍带日期前缀）', async () => {
  const { s, getDl } = saveCtx();
  await s.create({ licensing: { require: async () => {} } }).handle(
    { op: 'detail.save', content: '正文', name: 'a/b:c', meetingId: '' }, {}
  );
  assert.match(getDl().filename, /\/\d{8}_a-b-c_逐字稿\.txt$/);
});

test('离屏页 createBlobUrl：内容带 UTF-8 BOM，Excel/记事本不再乱码', async () => {
  const fileCheckSrc = fs.readFileSync(path.join(root, 'file-check.js'), 'utf8');
  let listener = null, captured = null;
  const ctx = vm.createContext({
    console, TextEncoder, setTimeout: () => 0,
    URL: { createObjectURL: () => 'blob:offscreen', revokeObjectURL: () => {} },
    Blob: class { constructor(parts) { captured = parts[0]; } },
    chrome: { runtime: { id: 'ext-test', onMessage: { addListener(fn) { listener = fn; } } } },
    TMeetFiles: {},
  });
  vm.runInContext(fileCheckSrc, ctx);
  const reply = await new Promise((resolve) => {
    listener({ type: 'tmeet.blob-url', content: '麦爸 你好，这是逐字稿' }, { id: 'ext-test' }, resolve);
  });
  assert.equal(reply.ok, true);
  assert.equal(captured[0], 0xEF, 'BOM 第 1 字节');
  assert.equal(captured[1], 0xBB, 'BOM 第 2 字节');
  assert.equal(captured[2], 0xBF, 'BOM 第 3 字节');
  assert.equal(Buffer.from(captured.slice(3)).toString('utf8'), '麦爸 你好，这是逐字稿', '去掉 BOM 后是正确 UTF-8');
});

test('detail.save：内容含 U+FFFD（解码失败）时拒绝保存，不写出乱码', async () => {
  const { s } = saveCtx();
  const r = await s.create({ licensing: { require: async () => {} } }).handle(
    { op: 'detail.save', content: '麦爸 \uFFFD 你好', name: 'x', meetingId: '123456789' }, {}
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /异常字符/);
});
