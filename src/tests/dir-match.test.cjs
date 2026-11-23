/* 目录一致性回归（2026-10-30 真机故障）：
 *
 * 真机症状：导出点击成功、文件也下载了（转写_集体答疑_逐字稿.docx），
 * 但插件在校验阶段报"本地文件不存在或不在所选下载目录"，整批卡在第一项。
 * 根因：第 ② 步授权的目录（"test"）和浏览器实际下载的目录（Downloads）不是同一个。
 *
 * 这组用例锁三件事：
 *   1) 报错必须带上"文件实际在哪儿"，否则用户不知道该改哪个文件夹；
 *   2) 授权目录与下载目录不一致时，导出必须被提前拦下并说清怎么改；
 *   3) 后台能从下载记录反推出浏览器的下载根目录（要剥掉本插件自己加的子目录）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// local-files.js：locate 报错带实际路径；contains 做目录一致性实测
// ---------------------------------------------------------------------------
function apiWithHandle(handle) {
  const state = { value: handle };
  const context = vm.createContext({
    setTimeout,
    indexedDB: {
      open() {
        const request = {};
        setTimeout(() => {
          request.result = {
            transaction() {
              const tx = { oncomplete: null, onerror: null };
              setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
              tx.objectStore = () => ({
                get: () => ({ result: state.value }),
                put: (v) => { state.value = v; return {}; },
              });
              return tx;
            },
            close() {},
          };
          request.onsuccess && request.onsuccess();
        }, 0);
        return request;
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'local-files.js'), 'utf8'), context);
  return context.TMeetFiles;
}
const emptyHandle = (name = 'test') => ({
  name,
  queryPermission: async () => 'granted',
  async getFileHandle() { throw new Error('NotFoundError'); },
  async getDirectoryHandle() { throw new Error('NotFoundError'); },
  async *values() { yield { kind: 'file', name: '别的课程.docx', getFile: async () => ({ name: '别的课程.docx', size: 1 }) }; },
});

test('locate：找不到文件时报错必须带上实际下载路径，用户才知道该授权哪个目录', async () => {
  const files = apiWithHandle(emptyHandle('test'));
  const target = 'C:/Users/me/Downloads/腾讯会议录制下载/20261030_逐字稿/转写_集体答疑_逐字稿.docx';
  await assert.rejects(() => files.locate(target), err => {
    assert.match(err.message, /不存在或不在所选下载目录/);
    assert.match(err.message, /转写_集体答疑_逐字稿\.docx/);
    // 关键：把完整路径带回去
    assert.match(err.message, /实际下载路径：.*Downloads/);
    return true;
  });
});

test('contains：授权目录里没有该文件时返回 false，有则返回 true', async () => {
  const files = apiWithHandle(emptyHandle('test'));
  assert.equal(await files.contains('C:/Users/me/Downloads/转写_集体答疑_逐字稿.docx'), false);
  const hit = {
    name: 'Downloads',
    queryPermission: async () => 'granted',
    async getFileHandle(name) {
      if (name !== '转写_集体答疑_逐字稿.docx') throw new Error('NotFoundError');
      return { getFile: async () => ({ name, size: 1024 }) };
    },
    async getDirectoryHandle() { throw new Error('NotFoundError'); },
    async *values() {},
  };
  const aligned = apiWithHandle(hit);
  assert.equal(await aligned.contains('C:/Users/me/Downloads/转写_集体答疑_逐字稿.docx'), true);
});

// ---------------------------------------------------------------------------
// batch.js：导出前的硬拦截
// ---------------------------------------------------------------------------
function batchUi() {
  const ctx = vm.createContext({
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], hidden: false },
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }), getURL: (f) => 'chrome-extension://x/' + f } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'batch.js'), 'utf8'), ctx);
  return ctx.TMeetBatchUI;
}
const readyState = dir => ({
  starting: false, busy: false, licenseActive: true, connected: true, hasRecordingTab: true,
  collected: [{ fileId: 'a' }], selected: new Set(['a']), dir,
});

test('导出前置不再提"选文件夹"：去掉本地校验后不该再拦目录授权', () => {
  // v1.8.4 起不做本地正文校验，也就不需要 File System Access 的目录授权。
  // 这条防止有人把"请先选择下载文件夹并授权"又加回导出前置里。
  const ui = batchUi();
  const s = readyState({ granted: true, checked: true, name: 'x', needsGesture: false, error: '', downloadPath: '', downloadName: '', recentFile: '', matched: null });
  const reason = ui.exportBlockReason(s);
  assert.equal(reason, '', '前置应该全部通过');
  assert.doesNotMatch(reason, /文件夹|授权|目录/);
});

test('导出前置：没勾选时给出可照做的提示', () => {
  const ui = batchUi();
  const s = readyState({ granted: false, checked: true, name: '', needsGesture: false, error: '' });
  s.selected = new Set();
  assert.match(ui.exportBlockReason(s), /勾选/);
});

// ---------------------------------------------------------------------------
// background.js：从下载记录反推浏览器下载根目录
// ---------------------------------------------------------------------------
function backgroundWithDownloads(downloads) {
  const listeners = {};
  const local = { config: { autoClassify: true } };
  const storage = data => ({
    async get(key) {
      if (key === null) return { ...data };
      if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, data[k]]));
      return { [key]: data[key] };
    },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; }
  });
  const chrome = {
    storage: { local: storage(local), session: storage({}) },
    downloads: {
      async search(q = {}) {
        if (q.id !== undefined) return downloads.filter(d => d.id === q.id);
        const list = [...downloads].sort((a, b) => String(b.startTime || '').localeCompare(String(a.startTime || '')));
        return list.slice(0, q.limit || list.length);
      },
      onDeterminingFilename: { addListener() {} },
      show() {}, showDefaultFolder() {}
    },
    runtime: {
      id: 'test-extension', getURL: file => 'chrome-extension://test-extension/' + file,
      onMessage: { addListener(fn) { listeners.message = fn; } },
      async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; },
      async sendMessage(msg) {
        if (msg?.type === 'tmeet.file-status') return { granted: true, name: 'test', permission: 'granted' };
        return {};
      }
    },
    tabs: { onRemoved: { addListener() {} } },
    offscreen: { async createDocument() { return {}; } }
  };
  const ctx = vm.createContext({
    chrome, URL, Date, console, importScripts() {}, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    TMeetSharedService: { create: () => ({ async filename() { return null; }, async removed() {}, async handle() { throw new Error('不在此桩中'); } }) },
    TMeetLicense: { createManager: () => ({ async status() { return { active: true }; }, async require() { return { active: true }; }, async activate() { throw new Error('不在此桩中'); } }) },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'site-adapter.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'download-journal.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
  const send = (op, extra = {}) => new Promise(resolve => listeners.message(
    { type: 'tmeet', op, ...extra },
    { id: 'test-extension', url: 'chrome-extension://test-extension/batch.html' }, resolve));
  return { send };
}

test('local.dir-info：返回浏览器实际下载位置，并剥掉本插件自己加的子目录', async () => {
  const b = backgroundWithDownloads([
    { id: 1, state: 'complete', exists: true, startTime: '2026-10-30T06:00:00Z', filename: 'C:\\Users\\me\\Downloads\\腾讯会议录制下载\\20261030_逐字稿\\转写_集体答疑_逐字稿.docx' },
  ]);
  const res = await b.send('local.dir-info');
  assert.equal(res.ok, true);
  assert.equal(res.dir.downloadPath, 'C:\\Users\\me\\Downloads');
  assert.equal(res.dir.downloadName, 'Downloads');
  assert.match(res.dir.recentFile, /转写_集体答疑_逐字稿\.docx$/);
  assert.equal(res.dir.granted, true);
});

test('local.dir-info：没有自动分类子目录时，下载根目录就是文件所在目录', async () => {
  const b = backgroundWithDownloads([
    { id: 1, state: 'complete', exists: true, startTime: '2026-10-30T06:00:00Z', filename: 'D:\\下载\\课程A.mp4' },
  ]);
  const res = await b.send('local.dir-info');
  assert.equal(res.dir.downloadPath, 'D:\\下载');
  assert.equal(res.dir.downloadName, '下载');
});

test('local.dir-info：没有下载历史时返回空路径，不报错', async () => {
  const b = backgroundWithDownloads([]);
  const res = await b.send('local.dir-info');
  assert.equal(res.ok, true);
  assert.equal(res.dir.downloadPath, '');
  assert.equal(res.dir.downloadName, '');
});
