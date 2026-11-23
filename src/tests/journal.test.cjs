const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function harness() {
  const data = {}, downloads = [], calls = [], files = new Map();
  const chrome = { runtime: { id: 'extension' }, storage: { local: {
    async get(k) { return structuredClone(k === null ? data : { [k]: data[k] }); },
    async set(v) { Object.assign(data, structuredClone(v)); }
  } }, downloads: {
    async search(q) { return downloads.filter(d => q.id === undefined || q.id === d.id); },
    async pause(id) { calls.push(['pause', id]); downloads.find(d => d.id === id).paused = true; },
    async resume(id) { calls.push(['resume', id]); const d = downloads.find(d => d.id === id); d.paused = false; d.state = 'in_progress'; }
  } };
  const ctx = vm.createContext({ Date, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'download-journal.js'), 'utf8'), ctx);
  const verify = async (filename, kind, size) => { const f = files.get(filename); return f || { valid: false, reason: '不存在' }; };
  const restart = () => ctx.TMeetJournal.create(chrome, verify), journal = restart();
  const target = { fileId: 'A', name: '私域变现3大抓手', type: 'transcript' };
  return { data, downloads, calls, files, journal, restart, target, k: journal.key('own', 'A', 'transcript') };
}
test('点击前持久保存pending；重启不重复触发未确认下载', async () => {
  const h = harness(); await h.journal.begin(h.k, h.target);
  assert.equal((await h.restart().check(h.k, 'transcript')).state, 'uncertain');
  await assert.rejects(h.restart().begin(h.k, h.target), /上次已点击/);
});
test('不再读文件内容：complete + 字节数对得上就算完成（空模板不再判失败）', async () => {
  // v1.8.4 起去掉本地正文校验：判定只看浏览器下载记录，不再要求授权下载目录。
  const h = harness(); await h.journal.begin(h.k, h.target);
  h.downloads.push({ id: 1, state: 'complete', filename: 'Downloads/empty.docx', fileSize: 40785 });
  await h.journal.attachItem(h.k, h.downloads[0]);
  const done = await h.restart().check(h.k, 'transcript');
  assert.equal(done.state, 'verified');
  assert.match(done.results[0].reason, /未做正文校验/);
});

test('字节数不完整仍然判失败（这是唯一还能拦住的坏结果）', async () => {
  const h = harness(); await h.journal.begin(h.k, h.target);
  h.downloads.push({ id: 1, state: 'complete', filename: 'Downloads/half.docx', totalBytes: 100, bytesReceived: 40 });
  await h.journal.attachItem(h.k, h.downloads[0]);
  const r = await h.restart().check(h.k, 'transcript');
  assert.equal(r.state, 'invalid');
  assert.match(r.results[0].reason, /不完整/);
});

test('文件被删掉（exists=false）不再算已下载', async () => {
  const h = harness(); await h.journal.begin(h.k, h.target);
  h.downloads.push({ id: 1, state: 'complete', filename: 'Downloads/gone.docx', exists: false });
  await h.journal.attachItem(h.k, h.downloads[0]);
  assert.equal((await h.restart().check(h.k, 'transcript')).state, 'invalid');
});

test('小体积逐字稿只给提示，不判失败（5KB 以下提醒可能只生成了标题）', async () => {
  const h = harness(); await h.journal.begin(h.k, h.target);
  h.downloads.push({ id: 1, state: 'complete', filename: 'Downloads/tiny.docx', fileSize: 900 });
  await h.journal.attachItem(h.k, h.downloads[0]);
  const r = await h.restart().check(h.k, 'transcript');
  assert.equal(r.state, 'verified', '不判失败，否则用户会被"下载成功却报错"卡住');
  assert.match(r.results[0].reason, /可能只生成了标题/);
});

test('认领历史下载：同名同族命中就直接算已下载，不打开文件', async () => {
  const h = harness();
  for (let i = 0; i < 7; i++) {
    h.downloads.push({ id: i, filename: `Downloads/私域变现3大抓手_逐字稿${i ? ' (' + i + ')' : ''}.docx`, state: 'complete', referrer: 'https://meeting.tencent.com/' });
  }
  const result = await h.journal.adopt(h.k, h.target);
  assert.equal(result.state, 'verified');
  assert.equal(h.downloads.length, 7, '认领不删除任何历史下载记录');
});

test('下载记录被清理后判 invalid，不再回退去读磁盘', async () => {
  const h = harness(); await h.journal.begin(h.k, h.target);
  await h.journal.attachItem(h.k, { id: 1, filename: 'Downloads/course.docx' });
  h.downloads.length = 0;   // 用户在浏览器里清空了下载记录
  const r = await h.restart().check(h.k, 'transcript');
  assert.equal(r.state, 'invalid');
  assert.match(r.results[0].reason, /下载记录已被清理/);
});

test('停止只暂停指定批次，重启恢复原downloadId，不启动新下载', async () => {
  const h = harness(); await h.journal.begin(h.k, h.target);
  h.downloads.push({ id: 1, state: 'in_progress' }, { id: 2, state: 'in_progress' });
  await h.journal.attach(h.k, 1); await h.journal.pause([h.k]);
  assert.deepEqual(h.calls, [['pause', 1]]);
  assert.equal((await h.restart().check(h.k, 'transcript')).state, 'paused');
  assert.equal((await h.restart().resume(h.k)).state, 'running');
  assert.deepEqual(h.calls.at(-1), ['resume', 1]);
});
test('同名不同课程不从旧文件名自动认领；两个孤本空课仍保留待补救', async () => {
  const h = harness();
  assert.equal((await h.journal.adopt(h.k, { ...h.target, uniqueTitle: false })).state, 'new');
  for (const name of ['Tongs 的云咖啡', '麦爸的海报制作分享课']) {
    h.downloads.push({ id: h.downloads.length + 1, state: 'complete', filename: 'Downloads/' + name + '.docx', referrer: 'https://meeting.tencent.com/' });
    assert.equal((await h.journal.adopt(h.journal.key('own', name, 'transcript'), { ...h.target, name })).state, 'new');
  }
  assert.equal(h.downloads.length, 2);
});

test('下载 ID 与已校验记录写入索引，供后台免全库扫描', async () => {
  const h = harness();
  await h.journal.begin(h.k, h.target);
  h.downloads.push({ id: 7, state: 'complete', filename: 'Downloads/course.docx' });
  await h.journal.attachItem(h.k, h.downloads[0]);
  assert.deepEqual(Array.from(await h.restart().ids()), [7]);
  assert.deepEqual(Array.from(await h.restart().verified()), []);
  assert.equal((await h.journal.check(h.k, 'transcript')).state, 'verified');
  assert.deepEqual(Array.from(await h.restart().verified()), [h.k]);
  // 文件被删掉后索引要同步移除，否则录制页会一直标"已下载"。
  h.downloads[0].exists = false;
  assert.equal((await h.restart().check(h.k, 'transcript')).state, 'invalid');
  assert.deepEqual(Array.from(await h.restart().verified()), []);
  // 重新点击导出时也要先摘掉"已校验"，避免中途显示成功。
  h.downloads[0].exists = true;
  await h.journal.check(h.k, 'transcript');
  await h.journal.begin(h.k, h.target);
  assert.deepEqual(Array.from(await h.journal.verified()), []);
});

test('记录 key 可以双向解析，非记录键返回 null', () => {
  const h = harness();
  assert.deepEqual({ ...h.journal.parse(h.k) }, { scope: 'own', fileId: 'A', kind: 'transcript' });
  const tricky = h.journal.key('shared', 'a:b/c', 'video');
  assert.deepEqual({ ...h.journal.parse(tricky) }, { scope: 'shared', fileId: 'a:b/c', kind: 'video' });
  assert.equal(h.journal.parse('export.v3.ids'), null);
  assert.equal(h.journal.parse('export.v3.own:A:audio'), null);
});

test('待核对索引：点击后进列表、拿到下载 ID 后自动移除、可手动解除', async () => {
  const h = harness();
  await h.journal.begin(h.k, h.target);
  assert.deepEqual(await h.journal.pending(), [h.k], '点了导出就该进待核对列表');
  // 关联到下载 ID = 确认这次点击确实产生了下载，不再是"结果不明"
  h.downloads.push({ id: 101, state: 'in_progress', filename: 'Downloads/a.docx' });
  await h.journal.attach(h.k, 101);
  assert.deepEqual(await h.journal.pending(), [], '拿到下载 ID 后必须移出待核对');

  await h.journal.begin(h.k, h.target);
  assert.deepEqual(await h.journal.pending(), [h.k]);
  assert.equal(await h.journal.clearPending(h.k), true);
  assert.deepEqual(await h.journal.pending(), []);
  const record = await h.journal.get(h.k);
  assert.equal(record.pending, false);
  assert.equal(record.verified, false, '解除待核对不等于通过校验');
});

test('待核对索引缺失时从存量记录补建，升级前卡住的课不会丢', async () => {
  const h = harness();
  // 模拟 v1.7 及更早：只有记录本身，没有 export.v3.pending 这个索引
  await h.journal.save(h.k, { target: h.target, pending: true, ids: [], verified: false });
  delete h.data['export.v3.pending'];
  assert.deepEqual([...(await h.journal.pending())], [h.k], '第一次查询要扫一遍存量记录');
  // 补建后再写一次记录，索引应该照常维护
  delete h.data['export.v3.pending'];
  await h.journal.save(h.k, { target: h.target, pending: true, ids: [] });
  assert.deepEqual([...(await h.journal.pending())], [h.k]);
});

test('解除待核对后可以重新 begin（不再被"上次已点击"挡住）', async () => {
  const h = harness();
  await h.journal.begin(h.k, h.target);
  await assert.rejects(h.journal.begin(h.k, h.target), /上次已点击/);
  await h.journal.clearPending(h.k);
  await h.journal.begin(h.k, h.target);            // 不抛错就说明放行了
  assert.deepEqual(await h.journal.pending(), [h.k]);
});

test('认领已有文件成功时也把待核对移出列表', async () => {
  const h = harness();
  await h.journal.begin(h.k, h.target);
  h.downloads.push({ id: 3, state: 'complete', filename: 'Downloads/私域变现3大抓手_逐字稿.docx', referrer: 'https://meeting.tencent.com/' });
  const result = await h.journal.adopt(h.k, { ...h.target, uniqueTitle: true });
  assert.equal(result.state, 'verified');
  assert.deepEqual(await h.journal.pending(), []);
});
