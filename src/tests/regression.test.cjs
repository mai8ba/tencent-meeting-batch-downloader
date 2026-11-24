const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dom = require('./mini-dom.cjs');
const root = path.join(__dirname, '..');

function background(shared = {}, authorization = { active: true }) {
  const listeners = {};
  const local = { config: { autoClassify: true } };
  const downloads = [];
  const storage = data => ({
    async get(key) {
      if (key === null) return { ...data };
      // Chrome 的 storage.get 支持数组：返回 {k1: v1, k2: v2}，测试桩保持一致。
      if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, data[k]]));
      return { [key]: data[key] };
    },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; }
  });
  const chrome = {
    storage: { local: storage(local), session: storage(shared) },
    downloads: {
      async cancel(id) { const item = downloads.find(i => i.id === id); if (item) { item.state = 'interrupted'; item.error = 'USER_CANCELED'; } },
      onDeterminingFilename: { addListener(fn) { listeners.filename = fn; } },
      show(id) { (listeners.opened ||= []).push({ type: 'item', id }); },
      showDefaultFolder() { (listeners.opened ||= []).push({ type: 'folder' }); },
      async search(q = {}) {
        if (q.id !== undefined) return downloads.filter(d => d.id === q.id);
        if (q.state) return downloads.filter(d => d.state === q.state);
        if (q.startedAfter !== undefined) return downloads.filter(d => d.startTime > q.startedAfter);
        return downloads.slice(0, q.limit || downloads.length);
      }
    },
    runtime: { id: 'test-extension', getURL: file => 'chrome-extension://test-extension/' + file,
      onMessage: { addListener(fn) { listeners.message = fn; } } },
    tabs: { onRemoved: { addListener(fn) { listeners.removed = fn; } } }
  };
  // 下载回归测试使用授权边界桩；真实签名在 license.test.cjs 中单独验证。
  const ctx = vm.createContext({ chrome, URL, Date, crypto: require('node:crypto').webcrypto, console,
    importScripts() {}, TMeetSharedService: { create: () => ({ async filename() { return null; }, async removed() {}, async handle() { throw new Error('分享服务不在此下载回归桩中'); } }) }, TMeetLicense: { createManager: () => ({
      async status() { return authorization; },
      async require() { if (!authorization.active) throw new Error('未激活或已到期'); return authorization; },
      async activate() { throw new Error('不在此桩中激活'); }
    }) }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'site-adapter.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'download-journal.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
  const send = (op, extra = {}, tab = 1, url = 'https://meeting.tencent.com/user-center/meeting-record') =>
    new Promise(resolve => listeners.message({ type: 'tmeet', op, ...extra, ...(op === 'prepare' ? { target: { fileId: 'fixture', type: 'video', name: 'fixture', ...extra.target } } : {}) }, { id: 'test-extension', tab: { id: tab }, url }, resolve));
  return { listeners, send, downloads, ctx, shared, local };
}

test('停止消息立即暂停本批文件并拦截后续prepare，重新开始沿用原ID恢复', async () => {
  const b = background();
  b.ctx.chrome.downloads.pause = async id => { b.downloads.find(d => d.id === id).paused = true; };
  b.ctx.chrome.downloads.resume = async id => { b.downloads.find(d => d.id === id).paused = false; };
  await b.send('acquire');
  const { ticket } = await b.send('prepare', { target: { fileId: 'A', type: 'video', name: '课程A' } });
  b.downloads.push({ id: 1, state: 'in_progress', referrer: 'https://meeting.tencent.com/', url: 'https://cdn.qq.com/A.mp4', startTime: new Date().toISOString() });
  await b.send('detect', { ticket });
  assert.equal((await b.send('stop-batch')).ok, true);
  assert.equal(b.downloads[0].paused, true);
  assert.equal((await b.send('prepare', { target: { fileId: 'B', type: 'video' } })).ok, false);
  await b.send('release'); await b.send('acquire');
  const resumed = await b.send('journal.check', { scope: 'own', id: 'A', kind: 'video', resume: true });
  assert.equal(resumed.result.state, 'running');
  assert.equal(b.downloads.length, 1); assert.equal(b.downloads[0].paused, false);
});

test('未激活不能授权采集或获得下载租约；到期禁止新下载但可释放任务', async () => {
  const auth = { active: false };
  const b = background({}, auth);
  assert.equal((await b.send('authorize')).ok, false);
  assert.equal((await b.send('acquire')).ok, false);
  auth.active = true;
  assert.equal((await b.send('acquire')).ok, true);
  auth.active = false;
  assert.equal((await b.send('prepare')).ok, false);
  assert.equal((await b.send('release')).ok, true);
});

test('未激活不执行自动分类', async () => {
  const b = background({}, { active: false });
  const result = await new Promise(resolve => b.listeners.filename({ filename: '课程.docx', referrer: 'https://meeting.tencent.com/' }, resolve));
  assert.equal(result, undefined);
});

test('异步分类返回 true；Windows 路径和无关键词 DOCX 正确分类', async () => {
  const b = background();
  let value;
  const result = b.listeners.filename({ filename: 'C:\\Users\\Download\\课程.docx', referrer: 'https://meeting.tencent.com/', startTime: '2026-10-23T00:00:00Z' }, x => { value = x; });
  assert.equal(result, true);
  await new Promise(setImmediate);
  assert.match(value.filename, /逐字稿\/课程.docx$/);
  assert.equal(value.conflictAction, 'uniquify');
});

test('伪造域名和 URL 查询参数不能冒充腾讯会议来源', () => {
  const b = background();
  for (const url of ['https://meeting.tencent.com.evil.test/a', 'https://evil.test/?meeting.tencent.com', 'https://wemeet.evil.test']) {
    assert.equal(vm.runInContext(`meetingSource(${JSON.stringify(url)})`, b.ctx), false);
  }
  assert.equal(vm.runInContext("meetingSource('blob:https://meeting.tencent.com/abc')", b.ctx), true);
});

test('同时申请租约仅一个标签页成功；关闭标签页释放租约', async () => {
  const b = background();
  const results = await Promise.all([b.send('acquire'), b.send('acquire', {}, 2)]);
  assert.deepEqual(results.map(x => x.ok), [true, false]);
  b.listeners.removed(1);
  assert.equal((await b.send('acquire', {}, 2)).ok, true);
});

test('worker 重启后仍保留租约；无效来源被拒绝', async () => {
  const shared = {};
  await background(shared).send('acquire');
  const b = background(shared);
  assert.equal((await b.send('acquire', {}, 2)).ok, false);
  assert.equal((await b.send('acquire', {}, 1, 'https://evil.test')).ok, false);
});

test('快照排除旧下载且能识别瞬间完成的新文件；下载中断保留状态', async () => {
  const b = background();
  const item = (id, state) => ({ id, state, startTime: new Date().toISOString(), referrer: 'https://meeting.tencent.com/' });
  b.downloads.push(item(10, 'complete'));
  await b.send('acquire');
  const { ticket } = await b.send('prepare');
  b.downloads.push(item(11, 'complete'));
  const found = await b.send('detect', { ticket });
  assert.deepEqual(Array.from(found.items, x => x.id), [11]);
  b.downloads[1].state = 'interrupted';
  assert.equal((await b.send('status', { ids: [11] })).items[0].state, 'interrupted');
  assert.equal((await b.send('detect', { ticket: 'wrong' })).ok, false);
});

function content(options = {}) {
  let now = 0;
  class Clock extends Date { static now() { return now; } }
  const elements = new Map();
  const document = {
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    // 页面可见性：默认可见；传 {visibilityState:'hidden'} 可模拟"录制页在后台"。
    visibilityState: options.visibilityState || 'visible',
    addEventListener() {}, removeEventListener() {},
  };
  const ctx = vm.createContext({ document, console, Date: Clock, performance: { now: () => now },
    setTimeout(fn, ms) { now += ms; Promise.resolve().then(fn); },
    TMeetOwnExport: { create: () => ({ async closePrevious() {}, async submit() {} }) },
    chrome: {
      storage: { local: { async set() {}, async get() { return {}; } }, onChanged: { addListener() {} } },
      runtime: { id: 'test-extension', getURL: file => 'chrome-extension://test-extension/' + file, onMessage: { addListener() {} } }
    }
  });
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  vm.runInContext(fs.readFileSync(path.join(root, 'site-adapter.js'), 'utf8'), ctx);
  const end = source.lastIndexOf("  if (document.readyState === 'loading')");
  vm.runInContext(source.slice(0, end) + `
    globalThis.api = { state, parseRow, getSelected, waitRowsStable, gotoPage, exportSelected, collect, triggerExport,
      filteredItems, isExported, snapshot, applySelect, live,
      firstNumber, rebasePages,
      configure: c => Object.assign(CONFIG, c),
      override: o => {
        if (o.getRows) getRows = o.getRows;
        if (o.getActivePage) getActivePage = o.getActivePage;
        if (o.findDirectionBtn) findDirectionBtn = o.findDirectionBtn;
        if (o.rpc) rpc = async (op, args) => op === 'journal.check' ? (o.journal ? o.journal(args) : { result: { state: globalThis.completed?.has(args.id) ? 'verified' : 'new' } }) : (async () => { const result = await o.rpc(op, args); if (op === 'status') { globalThis.completed ||= new Set(); for (const d of result.items) if (d.state === 'complete') globalThis.completed.add(String(d.id)); } return result; })();
        if (o.triggerExport) triggerExport = o.triggerExport;
        if (o.setPageSize) setPageSize = o.setPageSize;
        if (o.waitRowsStable) waitRowsStable = o.waitRowsStable;
        if (o.gotoPage) gotoPage = o.gotoPage;
      }
    };
  })();`, ctx);
  return { api: ctx.api, document, elements, ctx, now: () => now };
}
test('菜单授权等待期间停止：授权返回后不再点击导出', async () => {
  const c = content();
  let shown = false, clicks = 0;
  const menu = {isConnected:true, innerText:'导出', getBoundingClientRect:()=>({width:30,height:20}), click(){clicks++}};
  const more = {getBoundingClientRect:()=>({x:0,y:0,width:20,height:20}), dispatchEvent(event){shown=event.type==='mouseover'||event.type==='mouseenter'||event.type==='mousemove'}};
  c.ctx.window = {};
  c.ctx.MouseEvent = class {constructor(type){this.type=type}};
  c.ctx.getComputedStyle = () => ({visibility:'visible',display:'block',opacity:'1'});
  c.document.querySelectorAll = selector => selector === c.ctx.TMeetSite.s.recordMore ? [more] : (shown ? [menu] : []);
  const course = row('stop-menu');
  const original = course.querySelector;
  course.scrollIntoView = () => {};
  course.querySelector = selector => selector.startsWith('i') ? more : original(selector);
  c.api.override({rpc:async op=>{if(op==='authorize')c.api.state.stopped=true;return {ok:true}}});
  await assert.rejects(c.api.triggerExport(course,{fileId:'stop-menu',name:'测试课程',type:'transcript'},'ticket'), /已停止/);
  assert.equal(clicks,0);
});
function row(id, name = '录制', extra = '') {
  return { innerText: `${name}\n会议号：448 436 389\n2026-10-23 10:00\n${extra}`,
    querySelector(selector) {
      return selector.startsWith('label') ? { getAttribute: () => id } : { innerText: name };
    }
  };
}

test('会议号不吞掉下一行日期；文档扩展名识别', () => {
  const { api } = content();
  const info = api.parseRow(row('1', '课程.docx'));
  assert.equal(info.meetingId, '448436389');
  assert.equal(info.type, 'transcript');
});

test('录制行快照：适配层选择器解析出课程名、唯一标识、会议号、时间与大小', () => {
  const { api } = content();
  const snapshot = dom.node('tr', { children: [
    dom.node('td', { children: [dom.node('label', { className: 'met-form-check', attrs: { name: 'file-9' } })] }),
    dom.node('td', { children: [dom.node('div', { className: 'titleContent', text: '私域变现3大抓手' })] }),
    dom.node('td', { text: '会议号：448 436 389' }),
    dom.node('td', { text: '2026-10-23 10:00' }),
    dom.node('td', { text: '128.5 MB' }),
    dom.node('td', { children: [dom.node('i', { className: 'met-icon more', attrs: { 'aria-label': 'more--outlined' } })] })
  ] });
  const info = api.parseRow(snapshot);
  assert.equal(info.fileId, 'file-9');
  assert.equal(info.name, '私域变现3大抓手');
  assert.equal(info.meetingId, '448436389');
  assert.equal(info.time, '2026-10-23 10:00');
  assert.equal(info.size, '128.5 MB');
  // v1.8.6：按文件大小判类型——有 128.5 MB = 含视频（视频+逐字稿两种都有）
  assert.equal(info.hasVideo, true);
  assert.equal(info.type, 'video');
});

test('录制行快照：文件大小列只有"1个文件"没数字 → 纯逐字稿', () => {
  const { api } = content();
  const rowOnly = dom.node('tr', { children: [
    dom.node('td', { children: [dom.node('label', { className: 'met-form-check', attrs: { name: 'file-t' } })] }),
    dom.node('td', { children: [dom.node('div', { className: 'titleContent', text: '转写_玫子' })] }),
    dom.node('td', { text: '会议号：814 878 152' }),
    dom.node('td', { text: '2026-07-18 08:20' }),
    dom.node('td', { text: '1个文件' }),
    dom.node('td', { children: [dom.node('i', { className: 'met-icon more', attrs: { 'aria-label': 'more--outlined' } })] })
  ] });
  const info = api.parseRow(rowOnly);
  assert.equal(info.size, '');
  assert.equal(info.hasVideo, false);
  assert.equal(info.type, 'transcript');
});

test('菜单根本没点下去：释放租约后才撤回pending，下次不会无故跳过', async () => {
  const c = content(), calls = [];
  let lease = false, cleared = false;
  c.api.state.collected = [{ fileId: '1', page: 1, name: '课程1', type: 'transcript' }]; c.api.state.selected.add('1');
  c.api.override({ getRows: () => [row('1')], setPageSize: async () => true, gotoPage: async () => true, waitRowsStable: async () => 1,
    triggerExport: async () => false,
    rpc: async op => {
      calls.push(op);
      if (op === 'acquire') lease = true;
      if (op === 'release') lease = false;
      if (op === 'prepare') return { ticket: 't' };
      if (op === 'journal.clear-pending') { assert.equal(lease, false, '后台禁止持有租约时撤回'); cleared = true; }
      return {};
    }
  });
  await c.api.exportSelected();
  assert.equal(cleared, true);
  assert.ok(calls.indexOf('release') < calls.indexOf('journal.clear-pending'));
  assert.match(c.api.live.message, /本次没有发送导出点击/);
  assert.equal(c.api.state.selected.has('1'), true);
});

test('全部课程待核对时保留未发送下载的原因，不用“任务结束”覆盖成成功状态', async () => {
  const c = content(); let clicks = 0;
  c.api.state.collected = [{ fileId: '1', page: 1, name: '课程1', type: 'transcript' }]; c.api.state.selected.add('1');
  c.api.override({ setPageSize: async () => true, triggerExport: async () => { clicks++; }, journal: async () => ({ result: { state: 'uncertain' } }), rpc: async () => ({}) });
  await c.api.exportSelected();
  assert.equal(clicks, 0);
  assert.equal(c.api.live.phase, 'error');
  assert.match(c.api.live.message, /未发送新下载.*允许重试/);
  assert.equal(c.api.state.exporting, false);
});

test('菜单已点击后弹窗失败：保留原始原因与待核对，不谎报成菜单未就绪', async () => {
  const c = content(), calls = [];
  c.api.state.collected = [{ fileId: '1', page: 1, name: '课程1', type: 'transcript' }]; c.api.state.selected.add('1');
  c.api.override({ getRows: () => [row('1')], setPageSize: async () => true, gotoPage: async () => true, waitRowsStable: async () => 1,
    triggerExport: async () => { const e = new Error('弹窗中的Word格式不可用'); e.exportRequested = true; throw e; },
    rpc: async op => { calls.push(op); return op === 'prepare' ? { ticket: 't' } : {}; }
  });
  await c.api.exportSelected();
  assert.match(c.api.live.message, /弹窗中的Word格式不可用/);
  assert.equal(c.api.state.collected[0].exportError, '弹窗中的Word格式不可用');
  assert.equal(calls.includes('journal.clear-pending'), false);
  assert.equal(c.api.state.exporting, false);
});

test('课程行在导出时消失：把原因记到课程上，不再静默计入失败', async () => {
  const c = content(); let released = false;
  c.api.state.collected = [{ fileId: '1', page: 1, name: '课程1' }];
  c.api.state.selected.add('1');
  c.api.override({
    getRows: () => [], setPageSize: async () => true, gotoPage: async () => true, waitRowsStable: async () => 0,
    rpc: async op => { if (op === 'release') released = true; return {}; }
  });
  await c.api.exportSelected();
  assert.match(c.api.state.collected[0].exportError, /未找到该课程/);
  assert.equal(released, true);
  assert.equal(c.api.state.exporting, false);
  assert.equal(c.api.state.exportedSet.size, 0);
});

test('同样行数的旧列表不能被当作翻页完成', async () => {
  const c = content();
  c.api.override({ getRows: () => [row(c.now() < 1800 ? 'old' : 'new')], getActivePage: () => 2 });
  const previous = JSON.stringify([['old', '录制', '2026-10-23 10:00']]);
  await c.api.waitRowsStable(5000, previous, 2);
  assert.ok(c.now() >= 2400);
});

test('翻页超时显式失败；停止可打断等待', async () => {
  const c = content();
  c.api.override({ getRows: () => [row('old')] });
  const previous = JSON.stringify([['old', '录制', '2026-10-23 10:00']]);
  await assert.rejects(c.api.waitRowsStable(500, previous), /超时/);
  c.api.state.stopped = true;
  await assert.rejects(c.api.waitRowsStable(), /已停止/);
});

test('折叠页码支持从第 40 页退回第 1 页', async () => {
  const c = content(); let page = 40;
  c.api.override({ getRows: () => [row(String(page))], getActivePage: () => page,
    findDirectionBtn: direction => ({ click() { page += direction === 'arrowleft' ? -1 : 1; } }) });
  assert.equal(await c.api.gotoPage(1), true);
  assert.equal(page, 1);
});

test('不再要求下载文件夹授权：导出直接开始，不再去问 local.status', async () => {
  // v1.8.4 去掉本地正文校验 ⇒ 不再需要 File System Access 的目录句柄。
  // 这条锁住"导出前置里不能又冒出目录授权检查"，否则用户会被迫回去选文件夹。
  const c = content(); const calls = [];
  const rows = [row('a', '课程A')];
  c.api.override({
    getRows: () => rows, setPageSize: async () => true, gotoPage: async () => true, waitRowsStable: async () => 1,
    triggerExport: async () => { throw new Error('不应该走到点击'); },
    rpc: async (op) => {
      calls.push(op);
      if (op === 'prepare') throw new Error('到此即证明前置已放行');
      return {};
    }
  });
  c.api.state.collected = [{ fileId: 'a', name: '课程A', type: 'transcript', page: 1 }];
  c.api.state.selected.add('a');
  const result = await c.api.exportSelected();
  assert.equal(result.started, true, '前置不该再拦目录授权');
  assert.ok(calls.includes('acquire'), '应该一路走到建租约');
  assert.ok(!calls.includes('local.status'), '不能再问目录授权');
});

test('采集本身不再依赖目录授权（授权由工作台在导出前把关）', async () => {
  const c = content(); const calls = [];
  c.api.state.localKnown = true;
  c.api.state.localGranted = false;
  c.api.override({
    getRows: () => [], setPageSize: async () => true, gotoPage: async () => true,
    findDirectionBtn: () => null, waitRowsStable: async () => 1,
    rpc: async (op) => { calls.push(op); return {}; }
  });
  await c.api.collect();
  assert.equal(calls.includes('local.status'), false, '采集不该再查目录授权');
  assert.equal(c.api.live.phase, 'done');
});

test('v1.8.14 类型按钮只筛类目：不动勾选、不改行的真实类型', () => {
  const c = content();
  c.api.state.collected = [
    { fileId: 'v1', name: '课程1', type: 'video', hasVideo: true, meetingId: '', time: '', size: '24MB' },
    { fileId: 't1', name: '转写_课程1', type: 'transcript', hasVideo: false, meetingId: '', time: '', size: '' },
    { fileId: 'v2', name: '课程2', type: 'video', hasVideo: true, meetingId: '', time: '', size: '318MB' },
    { fileId: 't2', name: '转写_课程2', type: 'transcript', hasVideo: false, meetingId: '', time: '', size: '' }
  ];
  // 用户只勾了一项，然后来回切筛选类目
  c.api.state.selected = new Set(['t1']);
  c.api.state.filter.type = 'video';
  assert.deepEqual([...c.api.state.selected], ['t1'], '切到"仅视频"不能替用户改勾选');
  assert.equal(c.api.filteredItems().length, 2, '仅视频：只剩有大小的两行可见');
  // 行的类型是采集时按文件大小判出来的真实信息，筛选不该改写它
  assert.equal(c.api.state.collected.find(x => x.fileId === 'v1').type, 'video', '含视频的行仍是 video');
  assert.equal(c.api.state.collected.find(x => x.fileId === 't1').type, 'transcript', '纯逐字稿行仍是 transcript');

  c.api.state.filter.type = 'transcript';
  assert.deepEqual([...c.api.state.selected], ['t1'], '切到"仅逐字稿"同样不动勾选');
  assert.equal(c.api.filteredItems().length, 4, '仅逐字稿：所有行都含逐字稿，全部可见');
  assert.equal(c.api.state.collected.find(x => x.fileId === 'v1').type, 'video', '类型仍保持真实');
});

test('v1.8.14 切类目不清空勾选，只影响可见范围', () => {
  const c = content();
  c.api.state.collected = [
    { fileId: 'v1', name: '课程1', type: 'video', hasVideo: true, meetingId: '', time: '', size: '24MB' },
    { fileId: 't1', name: '转写_课程1', type: 'transcript', hasVideo: false, meetingId: '', time: '', size: '' }
  ];
  c.api.state.selected = new Set(['t1', 'v1']);
  c.api.state.filter.type = 'transcript';
  assert.equal(c.api.state.selected.size, 2, '勾选原样保留');
  // 全选只作用于当前可见（=筛选后）的项
  c.api.applySelect({ mode: 'none' });
  c.api.state.filter.type = 'video';
  c.api.applySelect({ mode: 'all' });
  assert.deepEqual([...c.api.state.selected], ['v1'], '仅视频下全选只勾可见的含视频行');
});

test('筛选与勾选互不影响；快照把勾选、筛选结果、已下载分开上报', () => {
  const c = content();
  const id = 'x" onclick="bad';
  c.api.state.collected = [
    { fileId: id, name: '<录制>', type: 'video', meetingId: '', time: '', size: '' },
    { fileId: 't1', name: '逐字稿A', type: 'transcript', meetingId: '628565172', time: '', size: '' }
  ];
  c.api.state.selected.add(id);
  // 筛选只改"看哪些"，不改"选哪些"
  c.api.state.filter.keyword = '不存在';
  const filteredOut = c.api.snapshot();
  assert.deepEqual([...filteredOut.filtered], []);
  assert.deepEqual([...filteredOut.selected], [id]);
  assert.equal(c.api.getSelected().length, 1);
  // 非法 fileId 原样保留：转义是渲染层的责任，数据层不能篡改标识
  assert.equal(filteredOut.collected[0].fileId, id);
  c.api.state.filter.keyword = '';
  assert.deepEqual([...c.api.snapshot().filtered].sort(), [id, 't1'].sort());
});

test('applySelect 在当前可见集内全选/反选，已下载的不会被重新勾上', () => {
  const c = content();
  c.api.state.collected = [
    { fileId: 'v1', name: '视频1', type: 'video', hasVideo: true },
    { fileId: 'v2', name: '视频2', type: 'video', hasVideo: true },
    { fileId: 't1', name: '逐字稿1', type: 'transcript', hasVideo: false }
  ];
  c.api.state.filter.type = 'video';
  c.api.state.verifiedSet.add('v2|video');   // v2 已下载
  const all = c.api.applySelect({ mode: 'all' });
  // v1.8.6：仅视频时纯逐字稿行 t1 不可见；v2 已下载被跳过，只剩 v1
  assert.deepEqual([...c.api.state.selected], ['v1']);
  assert.equal(all.skipped, 1);
  assert.equal(all.filtered.length, 2, '可见集只有两条有大小的行');
  const inverted = c.api.applySelect({ mode: 'invert' });
  assert.deepEqual([...c.api.state.selected], [], '反选后已勾的取消，已下载的 v2 不加回');
  // 单条切换：手动勾纯逐字稿行不受可见集限制
  c.api.applySelect({ mode: 'none' });
  c.api.applySelect({ mode: 'set', id: 't1', selected: true });
  assert.deepEqual([...c.api.state.selected], ['t1']);
});

test('并发上限为3；中断时停止后续导出，保留未完成选择并释放租约', async () => {
  const c = content(); c.api.configure({ maxConcurrent: 3 });
  const targets = Array.from({ length: 7 }, (_, i) => ({ fileId: String(i + 1), page: 1 }));
  c.api.state.collected = targets;
  targets.forEach(t => c.api.state.selected.add(t.fileId));
  let id = 0, peak = 0, released = false;
  const pending = new Set();
  c.api.override({ getRows: () => targets.map(t => row(t.fileId)), setPageSize: async () => true,
    gotoPage: async () => true, waitRowsStable: async () => 7, triggerExport: async () => true,
    rpc: async (op, args) => {
      if (op === 'prepare') return { ticket: 't' };
      if (op === 'detect') { pending.add(++id); peak = Math.max(peak, pending.size); return { items: [{ id }] }; }
      if (op === 'release') { released = true; return {}; }
      if (op === 'status') {
        const complete = pending.size >= 3 || id === 7;
        const first = args.ids[0];
        return { items: args.ids.map(n => {
          const terminal = complete && n === first;
          if (terminal) pending.delete(n);
          return { id: n, state: terminal ? (n === 2 ? 'interrupted' : 'complete') : 'in_progress' };
        }) };
      }
      return {};
    }
  });
  await c.api.exportSelected();
  assert.equal(peak, 3);
  assert.equal(c.api.state.exportedSet.size, 1);
  assert.equal(c.api.state.exportedSet.has('2'), false);
  assert.equal(c.api.state.selected.has('2'), true);
  assert.equal(released, true);
  assert.equal(c.api.state.exporting, false);
});

test('并发上限为3；全部校验通过后完成7项并释放租约', async () => {
  const c = content(); c.api.configure({ maxConcurrent: 3 });
  const targets = Array.from({ length: 7 }, (_, i) => ({ fileId: String(i + 1), page: 1 }));
  c.api.state.collected = targets;
  targets.forEach(t => c.api.state.selected.add(t.fileId));
  let id = 0, peak = 0, released = false;
  const pending = new Set();
  c.api.override({ getRows: () => targets.map(t => row(t.fileId)), setPageSize: async () => true,
    gotoPage: async () => true, waitRowsStable: async () => 7, triggerExport: async () => true,
    rpc: async (op, args) => {
      if (op === 'prepare') return { ticket: 't' };
      if (op === 'detect') { pending.add(++id); peak = Math.max(peak, pending.size); return { items: [{ id }] }; }
      if (op === 'release') { released = true; return {}; }
      if (op === 'status') {
        const complete = pending.size >= 3 || id === 7;
        const first = args.ids[0];
        return { items: args.ids.map(n => {
          const terminal = complete && n === first;
          if (terminal) pending.delete(n);
          return { id: n, state: terminal ? 'complete' : 'in_progress' };
        }) };
      }
      return {};
    }
  });
  await c.api.exportSelected();
  assert.equal(peak, 3);
  assert.equal(c.api.state.exportedSet.size, 7);
  assert.equal(c.api.state.exportedSet.has('2'), true);
  assert.equal(c.api.state.selected.has('2'), false);
  assert.equal(released, true);
  assert.equal(c.api.state.exporting, false);
});

test('设置页面失败也恢复 busy 并释放租约', async () => {
  const c = content(); let released = false;
  c.api.state.collected = [{ fileId: '1' }]; c.api.state.selected.add('1');
  c.api.override({ setPageSize: async () => { throw new Error('setup failed'); }, rpc: async op => { if (op === 'release') released = true; return {}; } });
  await c.api.exportSelected();
  assert.equal(released, true);
  assert.equal(c.api.state.exporting, false);
});

test('上一批仍在下载时拒绝开始新批次', async () => {
  const b = background();
  b.downloads.push({ id: 1, state: 'in_progress', referrer: 'https://meeting.tencent.com/' });
  assert.equal((await b.send('acquire')).ok, false);
});

for (const scenario of ['ambiguous', 'timeout', 'stop']) {
  test(`下载识别 ${scenario} 停止任务且不标记完成、不重复点击`, async () => {
    const c = content(); let clicks = 0, released = false;
    c.api.state.collected = [{ fileId: '1', page: 1 }]; c.api.state.selected.add('1');
    c.api.override({ getRows: () => [row('1')], setPageSize: async () => true,
      gotoPage: async () => true, waitRowsStable: async () => 1,
      triggerExport: async () => { clicks++; if (scenario === 'stop') c.api.state.stopped = true; return true; },
      rpc: async op => {
        if (op === 'release') released = true;
        if (op === 'prepare') return { ticket: 't' };
        if (op === 'detect') return { items: scenario === 'ambiguous' ? [{ id: 1 }, { id: 2 }] : [] };
        return {};
      }
    });
    await c.api.exportSelected();
    assert.equal(clicks, 1);
    assert.equal(released, true);
    assert.equal(c.api.state.exportedSet.size, 0);
    assert.equal(c.api.state.exporting, false);
  });
}


test('关闭自动分类仍将网页下载.docx改为课程名，且不会误用下一文件', async () => {
  const b = background(); b.local.config.autoClassify = false;
  await b.send('acquire'); await b.send('prepare', { target: { name: '第一课：价值感' } });
  const item = { id: 801, filename: '下载.docx', startTime: new Date().toISOString(), referrer: 'https://meeting.tencent.com/user-center/meeting-record' };
  const named = await new Promise(resolve => b.listeners.filename(item, resolve));
  assert.equal(named.filename, '第一课：价值感_逐字稿.docx');
  const repeated = await new Promise(resolve => b.listeners.filename(item, resolve));
  assert.equal(repeated.filename, named.filename);
  const next = await new Promise(resolve => b.listeners.filename({ ...item, id: 802 }, resolve));
  assert.equal(next.filename, '下载.docx');
});


test('不同课程重复取得同一视频资源时取消重复下载，签名变化也不能串课', async () => {
  const b = background(); await b.send('acquire');
  let { ticket } = await b.send('prepare', { target: { name: '课程A', fileId: 'A' } });
  b.downloads.push({ id: 1001, url: 'https://cdn.qq.com/courseA.mp4?sign=first&t=1', state: 'complete', startTime: new Date().toISOString(), referrer: 'https://meeting.tencent.com/user-center/meeting-record' });
  assert.equal((await b.send('detect', { ticket })).items.length, 1);
  ({ ticket } = await b.send('prepare', { target: { name: '课程B', fileId: 'B' } }));
  b.downloads.push({ id: 1002, url: 'https://cdn.qq.com/courseA.mp4?sign=changed&t=2', state: 'in_progress', startTime: new Date().toISOString(), referrer: 'https://meeting.tencent.com/user-center/meeting-record' });
  const result = await b.send('detect', { ticket });
  assert.equal(result.ok, false); assert.match(result.error, /上一门课程/); assert.equal(b.downloads[1].state, 'interrupted');
});
test('不同课程对应不同视频地址时分别识别，不混用旧下载ID', async () => {
  const b = background(); await b.send('acquire');
  for (let i = 1; i <= 2; i++) {
    const { ticket } = await b.send('prepare', { target: { name: '课程' + i, fileId: 'f' + i } });
    b.downloads.push({ id: 1100 + i, url: 'https://cdn.qq.com/video-' + i + '.mp4', state: 'complete', startTime: new Date().toISOString(), referrer: 'https://meeting.tencent.com/user-center/meeting-record' });
    assert.deepEqual(Array.from((await b.send('detect', { ticket })).items, x => x.id), [1100 + i]);
  }
});

test('journal.exported 只回已校验课程，且拒绝本地校验页以外的来源', async () => {
  const b = background();
  await b.ctx.chrome.storage.local.set({ 'export.v3.verified': ['export.v3.own:A:transcript', 'export.v3.shared:B:video', '坏的键'] });
  const result = await b.send('journal.exported');
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.exported, x => ({ ...x })), [
    { scope: 'own', fileId: 'A', kind: 'transcript' },
    { scope: 'shared', fileId: 'B', kind: 'video' }
  ]);
  const blocked = await b.send('journal.exported', {}, 1, 'chrome-extension://test-extension/local-audit.html');
  assert.equal(blocked.ok, false);
});

test('页面上只挂一颗悬浮球（Shadow DOM 内），不再注入整块面板', async () => {
  const stub = () => ({
    addEventListener() {}, style: {}, hidden: true, textContent: '', innerHTML: '', title: '',
    classList: { add() {}, remove() {}, toggle() {} }
  });
  let host = null;
  const shadow = { innerHTML: '', querySelector: () => stub(), querySelectorAll: () => [] };
  const document = {
    readyState: 'complete',
    body: { appendChild(node) { host = node; }, innerText: '' },
    createElement() { return { id: '', style: {}, attachShadow: () => shadow, appendChild() {} }; },
    getElementById: () => null, querySelector: () => null,
    querySelectorAll(selector) {
      if (selector !== 'table tbody tr') return [];
      return [{ innerText: '课程A', querySelector: () => ({ innerText: '课程A' }) }];
    },
    addEventListener() {}
  };
  const ctx = vm.createContext({
    document, console, performance: { now: () => 0 },
    setTimeout, clearTimeout, setInterval: fn => { setTimeout(fn, 0); return 1; }, clearInterval() {},
    chrome: {
      storage: { local: { async get() { return {}; }, async set() {} }, onChanged: { addListener() {} } },
      runtime: {
        id: 'test-extension',
        getURL: file => 'chrome-extension://test-extension/' + file,
        sendMessage: async () => ({ ok: true, license: { active: true }, exported: [] }),
        onMessage: { addListener() {} }
      }
    },
    TMeetOwnExport: { create: () => ({ closePrevious: async () => {}, submit: async () => {} }) }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'site-adapter.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), ctx);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(host, '悬浮球宿主节点应挂到 body');
  assert.equal(host.id, 'tmeet-batch-fab');
  assert.match(host.style.cssText, /position:fixed/);
  // 只留一颗球：不再有面板容器、清单列表、授权区
  assert.doesNotMatch(shadow.innerHTML, /tmeet-dl-box|tmeet-list-wrap|tmeet-license-panel/);
  assert.match(shadow.innerHTML, /class="tmeet-fab"/);
  // 样式写在 shadow 内联，不再依赖注入的 content.css
  assert.match(shadow.innerHTML, /<style>/);
});

test('导出前先校验：已存在的课程不点击导出，只有剩余项进入导出', async () => {
  const c = content();
  const targets = [{ fileId: 'a', page: 1, name: '课程A' }, { fileId: 'b', page: 1, name: '课程B' }];
  c.api.state.collected = targets;
  targets.forEach(t => c.api.state.selected.add(t.fileId));
  const checked = [];
  let clicks = 0, downloadId = 0;
  c.api.override({
    getRows: () => targets.map(t => row(t.fileId)), setPageSize: async () => true,
    gotoPage: async () => true, waitRowsStable: async () => 2,
    triggerExport: async () => { clicks++; return true; },
    journal: args => {
      checked.push(args.id);
      if (args.id === 'a') return { result: { state: 'verified' } };
      // b 第一次校验是"没有记录"，点过导出后才变成"通过"
      return { result: { state: clicks > 0 ? 'verified' : 'new' } };
    },
    rpc: async (op) => {
      if (op === 'prepare') return { ticket: 't' };
      if (op === 'detect') return { items: [{ id: ++downloadId }] };
      if (op === 'status') return { items: [{ id: downloadId, state: 'complete' }] };
      return {};
    }
  });
  await c.api.exportSelected();
  assert.deepEqual(checked.slice(0, 2), ['a', 'b'], '两项都必须先校验');
  assert.equal(clicks, 1, '已存在的 a 不能被点击导出');
  assert.equal(c.api.state.exportedSet.has('a'), true);
  assert.equal(c.api.state.exportedSet.has('b'), true);
  assert.equal(c.api.state.exporting, false);
});

test('预检遇到"下载结果不明"只跳过该课程，不把整批停掉', async () => {
  const c = content();
  const targets = [{ fileId: 'a', page: 1, name: '课程A' }, { fileId: 'b', page: 1, name: '课程B' }];
  c.api.state.collected = targets;
  targets.forEach(t => c.api.state.selected.add(t.fileId));
  let clicks = 0, downloadId = 0;
  c.api.override({
    getRows: () => targets.map(t => row(t.fileId)), setPageSize: async () => true,
    gotoPage: async () => true, waitRowsStable: async () => 2,
    triggerExport: async () => { clicks++; return true; },
    journal: args => ({ result: { state: args.id === 'a' ? 'uncertain' : (clicks > 0 ? 'verified' : 'new') } }),
    rpc: async (op) => {
      if (op === 'prepare') return { ticket: 't' };
      if (op === 'detect') return { items: [{ id: ++downloadId }] };
      if (op === 'status') return { items: [{ id: downloadId, state: 'complete' }] };
      return {};
    }
  });
  await c.api.exportSelected();
  assert.equal(clicks, 1, '只导出没问题的 b');
  assert.match(targets[0].exportError, /下载结果不明/);
  assert.equal(c.api.state.exportedSet.has('a'), false);
  assert.equal(c.api.state.exportedSet.has('b'), true);
});

test('授权页带查询串（?pick=1&close=1）仍算内部页面，外部来源被拒', async () => {
  const b = background();
  const ok = await b.send('local.status', {}, 1, 'chrome-extension://test-extension/local-audit.html?pick=1&close=1');
  assert.equal(ok.ok, true);
  // 桩里没有离屏文档，应给出可判定的失败，而不是把整条消息判成非法来源
  assert.equal(ok.dir.granted, false);
  const denied = await b.send('local.status', {}, 1, 'https://evil.test/');
  assert.equal(denied.ok, false);
});

test('打开下载目录：有本插件的下载就定位到该文件，没有就打开默认下载目录', async () => {
  const b = background();
  const batchUrl = 'chrome-extension://test-extension/batch.html';
  const first = await b.send('open-download-folder', {}, 1, batchUrl);
  assert.equal(first.ok, true);
  assert.equal(first.opened, 'folder');
  assert.deepEqual(b.listeners.opened, [{ type: 'folder' }]);

  b.downloads.push({
    id: 7, state: 'complete', filename: 'C:\Users\me\Downloads\课程.docx',
    referrer: 'https://meeting.tencent.com/', startTime: new Date().toISOString()
  });
  const second = await b.send('open-download-folder', {}, 1, batchUrl);
  assert.equal(second.opened, 'file');
  assert.equal(second.filename, 'C:\Users\me\Downloads\课程.docx');
  assert.deepEqual(b.listeners.opened.at(-1), { type: 'item', id: 7 }, '要定位到文件所在目录，而不是笼统打开默认目录');
});

test('打开下载目录不接受页面内 content script 调用（只给扩展页面）', async () => {
  const b = background();
  const denied = await b.send('open-download-folder', {}, 1);
  assert.equal(denied.ok, false);
  assert.deepEqual(b.listeners.opened, undefined, '被拒时不应该真的去打开目录');
});

test('journal.pending 只列待核对记录，页面来源可用；批量解除按 key 生效', async () => {
  const b = background();
  const batchUrl = 'chrome-extension://test-extension/batch.html';
  // 先造一条"点了导出但没确认"的记录
  await b.send('acquire');
  await b.send('prepare', { target: { name: '课程A', fileId: 'A', type: 'transcript' } });
  const listed = await b.send('journal.pending', {}, 1, batchUrl);
  assert.equal(listed.ok, true);
  assert.equal(listed.pending.length, 1);
  assert.equal(listed.pending[0].fileId, 'A');
  assert.equal(listed.pending[0].kind, 'transcript');
  assert.equal(typeof listed.pending[0].key, 'string');

  // 解除前必须先释放租约（运行中不许改记录）
  const blocked = await b.send('journal.clear-pending', { keys: [listed.pending[0].key] }, 1, batchUrl);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /请先停止/);
  await b.send('release');

  const cleared = await b.send('journal.clear-pending', { keys: [listed.pending[0].key] }, 1, batchUrl);
  assert.equal(cleared.cleared, 1);
  const after = await b.send('journal.pending', {}, 1, batchUrl);
  assert.deepEqual(Array.from(after.pending), []);
});

test('journal.pending 拒绝外部来源与索引键注入', async () => {
  const b = background();
  const denied = await b.send('journal.pending', {}, 1, 'https://evil.test/');
  assert.equal(denied.ok, false);
  const bad = await b.send('journal.clear-pending', { keys: ['export.v3.ids', 'export.v3.pending', 'garbage'] }, 1, 'chrome-extension://test-extension/batch.html');
  assert.equal(bad.ok, false, '索引键和非法 key 不能被当成记录删掉');
  assert.match(bad.error, /参数无效/);
});

test('每页条数只比数字：站点文案带单位或前缀都能读出', () => {
  const c = content();
  assert.equal(c.api.firstNumber('30'), 30);
  assert.equal(c.api.firstNumber('30 条/页'), 30);
  assert.equal(c.api.firstNumber('每页 30 条'), 30);
  assert.equal(c.api.firstNumber('  50  '), 50);
  assert.equal(c.api.firstNumber('暂无'), null);
  assert.equal(c.api.firstNumber(''), null);
  assert.equal(c.api.firstNumber(null), null);
});

test('每页条数变化后按绝对序号换算页码，导出的课不会找错行', () => {
  const c = content();
  // 采集时按 30 条/页：第 2 页第 5 项 → 绝对序号 35
  const items = [{ fileId: 'a', page: 2, rowIndex: 4 }];
  c.api.rebasePages(items, 30, 20);
  assert.equal(items[0].page, 2, '绝对序号 35 在 20 条/页下仍是第 2 页');
  const items2 = [{ fileId: 'b', page: 3, rowIndex: 2 }];
  c.api.rebasePages(items2, 30, 20);
  assert.equal(items2[0].page, 4, '绝对序号 62 在 20 条/页下是第 4 页');
  const same = [{ fileId: 'c', page: 3, rowIndex: 2 }];
  c.api.rebasePages(same, 30, 30);
  assert.equal(same[0].page, 3, '条数没变就不该动页码');
});


test('录制页不可见时：先让后台把页面切到前台，再继续导出（不直接失败）', async () => {
  // 真机故障：导出中途页面被切走 → 站点菜单不弹 → "找不到导出"。
  // 期望行为：请求后台切前台，等页面可见后继续，而不是抛错。
  const c = content({ visibilityState: 'hidden' });
  const calls = [];
  const rows = [row('a', '课程A')];
  c.api.override({
    getRows: () => rows, setPageSize: async () => true, gotoPage: async () => true, waitRowsStable: async () => 1,
    triggerExport: async () => { throw new Error('不应该走到点击'); },
    rpc: async (op) => {
      calls.push(op);
      // 后台把录制页切到前台之后，页面就"可见"了
      if (op === 'focus-recording-tab') c.document.visibilityState = 'visible';
      if (op === 'prepare') throw new Error('到此即证明前置已放行');
      return {};
    }
  });
  c.api.state.collected = [{ fileId: 'a', name: '课程A', type: 'transcript', page: 1 }];
  c.api.state.selected.add('a');
  const result = await c.api.exportSelected();
  assert.ok(calls.includes('focus-recording-tab'), '录制页不可见时必须请求后台把它切到前台');
  assert.ok(calls.includes('prepare'), '切到前台后必须继续导出，而不是直接失败');
  assert.equal(result.started, true, '不应因为页面不可见就判定失败');
});
