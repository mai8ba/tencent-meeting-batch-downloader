// 工作台（batch.html / batch.js）与录制页（content.js）之间的契约测试。
// 这里只验证"界面说想干什么 → 数据层怎么算"，不模拟真实 DOM 渲染。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

// ------------------------------------------------------------
// batch.js 的纯函数
// ------------------------------------------------------------
function batchUi() {
  const ctx = vm.createContext({
    // readyState='loading' 让 batch.js 不执行 init()，只留下可测的纯函数。
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], hidden: false },
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }), getURL: (f) => 'chrome-extension://x/' + f } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'batch.js'), 'utf8'), ctx);
  return ctx.TMeetBatchUI;
}

test('工作台转义所有插值到 HTML 的文本', () => {
  const ui = batchUi();
  assert.equal(ui.escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(ui.escapeHtml("a'b&c"), 'a&#39;b&amp;c');
  assert.equal(ui.escapeHtml(null), 'null');
  assert.equal(ui.escapeHtml(123), '123');
});

test('工作台筛选：类型、关键字、以及录制页给出的权威命中集', () => {
  const ui = batchUi();
  const items = [
    { fileId: 'v1', name: '私域变现-视频', type: 'video', meetingId: '628565172' },
    { fileId: 't1', name: '转写_集体备课', type: 'transcript', meetingId: '312125050' },
    { fileId: 't2', name: '转写_私域复盘', type: 'transcript', meetingId: '448436389' }
  ];
  const all = { type: 'all', keyword: '' };
  assert.deepEqual(ui.visibleItems(items, all, []).map(x => x.fileId), ['v1', 't1', 't2']);
  // v1.8.6：类型按钮表示"这次导出什么"，不再按名字过滤列表，
  // 否则名字不带"转写"的录制会被挡住（183 条只挑出 14 条）。
  assert.deepEqual(ui.visibleItems(items, { type: 'transcript', keyword: '' }, []).map(x => x.fileId), ['v1', 't1', 't2']);
  assert.deepEqual(ui.visibleItems(items, { type: 'all', keyword: '私域' }, []).map(x => x.fileId), ['v1', 't2']);
  // 会议号也能搜
  assert.deepEqual(ui.visibleItems(items, { type: 'all', keyword: '312125' }, []).map(x => x.fileId), ['t1']);
  // 录制页说只命中 t1 时，本地即便关键字为空也不能把别的显示出来
  assert.deepEqual(ui.visibleItems(items, all, ['t1']).map(x => x.fileId), ['t1']);
  // 关键字大小写与前后空格不影响结果
  assert.deepEqual(ui.visibleItems(items, { type: 'all', keyword: '  私域  ' }, []).length, 2);
});

test('进度百分比按文件个数算，且始终落在 0–100', () => {
  const ui = batchUi();
  assert.equal(ui.computePercent({ total: 10, done: 3, failed: 2 }), 50);
  assert.equal(ui.computePercent({ total: 0, done: 0, failed: 0 }), 0);
  assert.equal(ui.computePercent({ total: 3, done: 9, failed: 0 }), 100);
  assert.equal(ui.computePercent({ total: 4, done: 1, percent: 25 }), 25);
  assert.equal(ui.computePercent({ total: 4, done: 1, percent: 180 }), 100);
  assert.equal(ui.computePercent(null), 0);
});

// ------------------------------------------------------------
// content.js 的 tmeet.batch 消息接口
// ------------------------------------------------------------
function harness(license = { active: true }, dirGranted = true) {
  const listeners = {};
  const rpcCalls = [];
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const ctx = vm.createContext({
    document, console, Date, performance: { now: () => 0 },
    setTimeout: (fn) => { Promise.resolve().then(fn); return 0; },
    clearTimeout() {},
    TMeetOwnExport: { create: () => ({ async closePrevious() {}, async submit() {} }) },
    chrome: {
      storage: {
        local: { async set() {}, async get() { return {}; } },
        onChanged: { addListener() {} }
      },
      runtime: {
        id: 'test-extension',
        getURL: (f) => 'chrome-extension://test-extension/' + f,
        onMessage: { addListener(fn) { listeners.message = fn; } },
        sendMessage: async () => ({ ok: true })
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'site-adapter.js'), 'utf8'), ctx);
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const end = source.lastIndexOf("  if (document.readyState === 'loading')");
  vm.runInContext(source.slice(0, end) + `
    globalThis.api = { state, live, snapshot, applySelect, filteredItems };
    rpc = async (op, args) => {
      globalThis.__rpc?.(op);
      if (op === 'license.status') return { license: ${JSON.stringify(license)} };
      if (op === 'local.status') return { dir: { granted: ${dirGranted}, name: ${dirGranted ? "'Downloads'" : "''"}, permission: ${dirGranted ? "'granted'" : "'none'"} } };
      if (op === 'journal.pending') return { pending: globalThis.__pending || [] };
      if (op === 'journal.clear-pending') {
        const keys = args?.keys || [];
        globalThis.__pending = (globalThis.__pending || []).filter(x => !keys.includes(x.key));
        return { cleared: keys.length };
      }
      return {};
    };
    const realCollect = collect, realExport = exportSelected;
    collect = async () => { globalThis.__collect = (globalThis.__collect || 0) + 1; return { started: true }; };
    exportSelected = async () => { globalThis.__export = (globalThis.__export || 0) + 1; return { started: true }; };
  })();`, ctx);
  const ui = (file = 'batch.html') => ({ id: 'test-extension', url: 'chrome-extension://test-extension/' + file });
  function send(action, extra = {}, sender = ui()) {
    return new Promise((resolve) => {
      const handled = listeners.message({ type: 'tmeet.batch', action, ...extra }, sender, resolve);
      if (!handled) resolve(null);
    });
  }
  return { ctx, api: ctx.api, send, ui, listeners, rpcCalls, fires: () => ({ collect: ctx.__collect || 0, export: ctx.__export || 0 }) };
}

test('只接受工作台/弹窗发来的指令，其它来源一律忽略', async () => {
  const h = harness();
  assert.equal(await h.send('snapshot', {}, { id: 'test-extension', url: 'https://evil.test/' }), null);
  assert.equal(await h.send('snapshot', {}, { id: 'other-extension', url: 'chrome-extension://other/batch.html' }), null);
  // 页面里的 content script 自己也不算 UI 来源
  assert.equal(await h.send('snapshot', {}, { id: 'test-extension', url: 'https://meeting.tencent.com/user-center/meeting-record', tab: { id: 1 } }), null);
  const ok = await h.send('snapshot');
  assert.equal(ok.ok, true);
});

test('snapshot 一次带回清单、勾选、筛选、已下载和进度', async () => {
  const h = harness();
  h.api.state.collected = [
    { fileId: 'v1', name: '视频1', type: 'video' },
    { fileId: 't1', name: '逐字稿1', type: 'transcript' }
  ];
  h.api.state.selected = new Set(['t1']);
  h.api.state.verifiedSet = new Set(['v1|video']);
  const snap = await h.send('snapshot');
  assert.equal(snap.collected.length, 2);
  assert.deepEqual([...snap.selected], ['t1']);
  assert.deepEqual([...snap.filtered], ['v1', 't1']);
  assert.deepEqual([...snap.exported], ['v1|video']);
  assert.equal(snap.licenseActive, true);
  assert.equal(snap.filter.type, 'all');
  assert.equal(snap.live.phase, 'idle');
});

test('v1.8.14 切类型按钮只筛类目：不替用户勾选，也不改写行的真实类型', async () => {
  const h = harness();
  h.api.state.collected = [
    { fileId: 'v1', name: '玫子', type: 'video', hasVideo: true },      // 视频+逐字稿
    { fileId: 't1', name: '转写_玫子', type: 'transcript', hasVideo: false } // 只有逐字稿
  ];
  // 用户只勾了纯逐字稿那一项，然后切类目
  h.api.state.selected = new Set(['t1']);

  const transcript = await h.send('filter', { filterType: 'transcript' });
  assert.deepEqual([...transcript.selected], ['t1'], '切"仅逐字稿"不能自动勾上视频行');
  assert.deepEqual([...transcript.filtered].sort(), ['t1', 'v1'], '两种行都含逐字稿，都可见');
  assert.equal(h.api.state.collected[0].type, 'video', '含视频的行类型保持真实，不被筛选改写');

  const video = await h.send('filter', { filterType: 'video' });
  assert.deepEqual([...video.selected], ['t1'], '切"仅视频"同样不改勾选');
  assert.deepEqual([...video.filtered], ['v1'], '仅视频：纯逐字稿行不可见');
  assert.equal(h.api.state.collected[0].type, 'video', '类型仍保持真实');

  const all = await h.send('filter', { filterType: 'all' });
  assert.deepEqual([...all.selected], ['t1'], '切"全部"也不改勾选');
  assert.deepEqual([...all.filtered].sort(), ['t1', 'v1'], '全部：都可见');
});

test('关键字筛选不改勾选；非法类型被忽略', async () => {
  const h = harness();
  h.api.state.collected = [
    { fileId: 'v1', name: '私域变现', type: 'video' },
    { fileId: 't1', name: '集体备课', type: 'transcript' }
  ];
  h.api.state.selected = new Set(['v1', 't1']);
  const searched = await h.send('filter', { keyword: '私域' });
  assert.deepEqual([...searched.filtered], ['v1']);
  assert.deepEqual([...searched.selected].sort(), ['t1', 'v1'], '搜索只影响看什么，不影响选什么');
  const bad = await h.send('filter', { filterType: 'audio' });
  assert.equal(bad.filter.type, 'all');
});

test('单条勾选/全选/清空/反选都回传最新勾选集', async () => {
  const h = harness();
  h.api.state.collected = [
    { fileId: 'a', name: 'A', type: 'video' },
    { fileId: 'b', name: 'B', type: 'video' },
    { fileId: 'c', name: 'C', type: 'transcript' }
  ];
  assert.deepEqual([...(await h.send('select', { mode: 'set', id: 'b', selected: true })).selected], ['b']);
  assert.deepEqual([...(await h.send('select', { mode: 'set', id: 'b', selected: false })).selected], []);
  assert.deepEqual([...(await h.send('select', { mode: 'all' })).selected].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...(await h.send('select', { mode: 'invert' })).selected], []);
  assert.deepEqual([...(await h.send('select', { mode: 'all' })).selected].length, 3);
  assert.deepEqual([...(await h.send('select', { mode: 'none' })).selected], []);
});

test('未激活时不放行采集和导出，激活后交给执行引擎并在后台跑', async () => {
  const off = harness({ active: false });
  assert.equal((await off.send('collect')).ok, false);
  assert.equal((await off.send('export')).ok, false);
  assert.deepEqual(off.fires(), { collect: 0, export: 0 });

  const on = harness({ active: true });
  on.api.state.collected = [{ fileId: 'a', name: 'A', type: 'video' }];
  on.api.state.selected = new Set(['a']);
  const collected = await on.send('collect');
  assert.equal(collected.started, true);
  const exported = await on.send('export');
  assert.equal(exported.started, true);
  assert.equal(exported.total, 1);
  // 消息立即返回，真正的采集/导出在后台跑（进度靠 tmeet.live 推）
  assert.deepEqual(on.fires(), { collect: 1, export: 1 });
});

test('没有勾选时导出被拒绝；重复点击不会叠任务', async () => {
  const h = harness();
  h.api.state.collected = [{ fileId: 'a', name: 'A', type: 'video' }];
  const empty = await h.send('export');
  assert.equal(empty.ok, false);
  h.api.state.selected = new Set(['a']);
  h.api.state.exporting = true;
  const busy = await h.send('export');
  // 任务运行中要明确报错，不能回 started:false 让界面以为没事发生
  assert.equal(busy.ok, false);
  assert.match(busy.error, /任务正在运行/);
  assert.deepEqual(h.fires(), { collect: 0, export: 0 }, '任务运行中不能再起一个');
});

test('停止指令把引擎标记为已停止，并转发给后台挂起本批下载', async () => {
  const h = harness();
  const ops = [];
  h.ctx.__rpc = (op) => ops.push(op);
  h.api.state.exporting = true;
  await h.send('stop');
  assert.equal(h.api.state.stopped, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(ops.includes('stop-batch'));
});

test('清空清单会同时清掉勾选、筛选和进度', async () => {
  const h = harness();
  h.api.state.collected = [{ fileId: 'a', name: 'A', type: 'video' }];
  h.api.state.selected = new Set(['a']);
  h.api.state.filter = { type: 'video', keyword: 'A' };
  const after = await h.send('reset');
  assert.equal(after.collected.length, 0);
  assert.deepEqual([...after.selected], []);
  assert.equal(after.filter.type, 'all');
  assert.equal(after.live.phase, 'idle');
});

test('前置条件不通过时导出直接报错，绝不回 started:true 让界面空等', async () => {
  // 这条是 v1.8.0 首个 bug 的回归：工作台曾经因为收到 started:true 而把按钮锁死、
  // 进度条停在"正在校验"，但引擎其实在第一道检查就退出了。
  const empty = harness();
  empty.api.state.collected = [{ fileId: 'a', name: 'A', type: 'video' }];
  empty.api.state.selected = new Set();
  const blocked = await empty.send('export');
  assert.equal(blocked.ok, false, '必须 ok:false，工作台才会弹提示而不是空等');
  assert.match(blocked.error, /勾选/);
  assert.deepEqual(empty.fires(), { collect: 0, export: 0 }, '前置没过就不该启动引擎');

  const fine = harness();
  fine.api.state.collected = [{ fileId: 'a', name: 'A', type: 'video' }];
  fine.api.state.selected = new Set(['a']);
  const ok = await fine.send('export');
  assert.equal(ok.ok, true);
  assert.equal(ok.started, true);
  assert.equal(ok.total, 1);
});

test('勾选的课已不在清单里（清空清单后残留）也会被拦住', async () => {
  const h = harness();
  h.api.state.collected = [];
  h.api.state.selected = new Set(['ghost']);
  const res = await h.send('export');
  assert.equal(res.ok, false);
  assert.match(res.error, /重新采集/);
  assert.deepEqual(h.fires(), { collect: 0, export: 0 });
});

test('采集被任务占用时同样返回 ok:false，不再是 started:false', async () => {
  const h = harness();
  h.api.state.collecting = true;
  const res = await h.send('collect');
  assert.equal(res.ok, false);
  assert.match(res.error, /任务正在运行/);
  assert.deepEqual(h.fires(), { collect: 0, export: 0 });
});

test('待核对课程在快照里单独列出，工作台据此标「待核对 + 允许重试」', async () => {
  const h = harness();
  h.api.state.collected = [
    { fileId: 'a', name: 'A', type: 'transcript' },
    { fileId: 'b', name: 'B', type: 'video' }
  ];
  h.ctx.__pending = [{ key: 'export.v3.own:a:transcript', scope: 'own', fileId: 'a', kind: 'transcript' }];
  const snap = await h.send('snapshot');
  assert.equal(snap.pending.length, 1);
  assert.equal(snap.pending[0].fileId, 'a');
  assert.equal(snap.pending[0].kind, 'transcript');
  // 别的课程不能被误标
  assert.equal(snap.pending.some(x => x.fileId === 'b'), false);
});

test('解除待核对：单条只清指定项，全部则一次清完', async () => {
  const single = harness();
  single.api.state.collected = [{ fileId: 'a', name: 'A', type: 'transcript' }, { fileId: 'b', name: 'B', type: 'video' }];
  single.ctx.__pending = [
    { key: 'export.v3.own:a:transcript', scope: 'own', fileId: 'a', kind: 'transcript' },
    { key: 'export.v3.own:b:video', scope: 'own', fileId: 'b', kind: 'video' }
  ];
  await single.send('snapshot');
  const one = await single.send('clearPending', { items: [{ fileId: 'a', kind: 'transcript' }] });
  assert.equal(one.cleared, 1);
  assert.deepEqual([...one.pending].map(x => x.fileId), ['b'], '只该解除被点的那一条');

  const all = harness();
  all.api.state.collected = [{ fileId: 'a', name: 'A', type: 'transcript' }];
  all.ctx.__pending = [{ key: 'export.v3.own:a:transcript', scope: 'own', fileId: 'a', kind: 'transcript' }];
  await all.send('snapshot');
  const cleared = await all.send('clearPending', { all: true });
  assert.equal(cleared.cleared, 1);
  assert.deepEqual([...cleared.pending], []);
});

test('解除待核对会顺手清掉课程上的旧红字，避免列表继续显示"已跳过"', async () => {
  const h = harness();
  h.api.state.collected = [{ fileId: 'a', name: 'A', type: 'transcript', exportError: '上次点击后下载结果不明，已跳过' }];
  h.api.state.selected = new Set(['a']);
  h.ctx.__pending = [{ key: 'export.v3.own:a:transcript', scope: 'own', fileId: 'a', kind: 'transcript' }];
  await h.send('snapshot');
  const res = await h.send('clearPending', { all: true });
  assert.equal(res.collected[0].exportError, undefined);
});

test('任务运行中不允许解除待核对（会打乱正在跑的批次）', async () => {
  const h = harness();
  h.api.state.exporting = true;
  const res = await h.send('clearPending', { all: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /任务运行中/);
});

test('v1.8.15 列表结构指纹：内容不变则 key 不变（勾选不触发重建），内容变了才变', () => {
  const ui = batchUi();
  const items = [
    { fileId: 'v1', name: '菲菲辅导麦爸', size: '24.10MB', type: 'video', time: '2026-11-20', meetingId: '235263476' },
    { fileId: 't1', name: '转写_菲菲辅导麦爸', size: '', type: 'transcript', time: '2026-11-20', meetingId: '235263476' }
  ];
  const marks = new Map([['v1', 'd'], ['t1', '']]);
  const key1 = ui.listKeyOf(items, 0, marks);
  const key2 = ui.listKeyOf(items, 0, marks);
  assert.equal(key1, key2, '同样内容 → 同样指纹 → 不重建列表');
  // 勾选态不进指纹：全选/反选/单选都不该导致整表重建
  const keyAfterSelect = ui.listKeyOf(items, 0, marks);
  assert.equal(keyAfterSelect, key1, '勾选不影响结构指纹');
  // 内容变了必须变（否则列表不刷新）
  const renamed = [{ ...items[0], name: '改名了' }, items[1]];
  assert.notEqual(ui.listKeyOf(renamed, 0, marks), key1, '名字变了 → 指纹变化');
  const moreMarked = new Map([['v1', 'dp'], ['t1', '']]);
  assert.notEqual(ui.listKeyOf(items, 0, moreMarked), key1, '下载状态变了 → 指纹变化');
  assert.notEqual(ui.listKeyOf(items, 5, marks), key1, '未显示条数变了 → 指纹变化');
});
