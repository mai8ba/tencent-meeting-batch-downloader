/* 导出弹窗定位回归：
 * 页面框架重建弹窗后，旧节点仍然"存在"但已脱离文档。过去的实现会一直点这个死节点，
 * 表现是"导出按钮点了没反应，最后报按钮未就绪"。这里锁住重新定位与 isConnected 检查。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dom = require('./mini-dom.cjs');

function adapter() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'site-adapter.js'), 'utf8'), context);
  return context.TMeetSite;
}

/** 造一个导出弹窗：标题 + 取消 + 开始导出（可选禁用） */
function dialog(site, { title = '课程A', startDisabled = false, connected = true } = {}) {
  const start = dom.node('button', { text: '开始导出', disabled: startDisabled });
  const node = dom.node('div', {
    className: 'met-modal',
    connected,
    children: [
      dom.node('div', { className: 'meeting-subject', text: title }),
      dom.node('button', { text: '取消' }),
      start
    ]
  });
  return { node, start };
}

function exporter(site, list, detect = () => [], onAuthorize = () => {}) {
  const document = { querySelectorAll: selector => (selector === site.s.exportDialog ? list() : []) };
  const context = vm.createContext({ document, console, TMeetSite: site, MouseEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'own-export.js'), 'utf8'), context);
  return context.TMeetOwnExport.create({ rpc: async op => { if (op === 'authorize') onAuthorize(); return { items: detect() }; }, checkStopped() {}, sleep: async () => {} });
}

const target = { fileId: 'file-9', name: '课程A', type: 'transcript' };

test('弹窗正常：定位唯一弹窗后点一次开始导出', async () => {
  const site = adapter();
  const a = dialog(site);
  const runner = exporter(site, () => [a.node]);
  await runner.submit(target, 'ticket', []);
  assert.equal(a.start.clicks, 1);
});

test('弹窗被框架重建：重新定位到新弹窗，不在脱离文档的旧节点上空点', async () => {
  const site = adapter();
  const stale = dialog(site, { connected: false });
  const fresh = dialog(site);
  let calls = 0;
  const runner = exporter(site, () => (++calls === 1 ? [stale.node] : [fresh.node]));
  await runner.submit(target, 'ticket', []);
  assert.equal(stale.start.clicks, 0, '旧节点不能发生任何点击');
  assert.equal(fresh.start.clicks, 1, '必须点在新弹窗上');
});

test('出现多个导出弹窗时停止，不猜测点哪一个', async () => {
  const site = adapter();
  const a = dialog(site), b = dialog(site, { title: '课程B' });
  const runner = exporter(site, () => [a.node, b.node]);
  await assert.rejects(runner.submit(target, 'ticket', []), /多个导出弹窗/);
  assert.equal(a.start.clicks + b.start.clicks, 0);
});

test('逐字稿直接下载（无弹窗）时按已检测到的下载返回，不报错', async () => {
  const site = adapter();
  const runner = exporter(site, () => [], () => [{ id: 1 }]);
  await runner.submit(target, 'ticket', []);
});

test('开始导出按钮始终不可用时明确失败，不无限等待', async () => {
  const site = adapter();
  const a = dialog(site, { startDisabled: true });
  const runner = exporter(site, () => [a.node]);
  await assert.rejects(runner.submit(target, 'ticket', []), /未就绪/);
  assert.equal(a.start.clicks, 0);
});

test('弹窗标题与当前课程不一致时停止，避免导出上一门课', async () => {
  const site = adapter();
  const a = dialog(site, { title: '课程B' });
  const runner = exporter(site, () => [a.node]);
  await assert.rejects(runner.submit(target, 'ticket', []), /课程名称与当前课程不一致/);
  assert.equal(a.start.clicks, 0);
});

test('校时等待中只重建按钮、不重建弹窗：重新定位新按钮，不能空点旧按钮', async () => {
  const site = adapter(), a = dialog(site), fresh = dom.node('button', { text: '开始导出' });
  let replaced = false;
  const runner = exporter(site, () => [a.node], () => [], () => {
    if (replaced) return; replaced = true;
    a.start.connected = false;
    a.node.children = a.node.children.filter(n => n !== a.start);
    a.node.appendChild(fresh);
  });
  await runner.submit(target, 'ticket', []);
  assert.equal(a.start.clicks, 0, '不能点击已脱离文档的旧按钮');
  assert.equal(fresh.clicks, 1, '应在校时返回后重新查找并点击当前按钮');
});

test('目标类型已选中但控件只读：不因 disabled 而拒绝已就绪的导出', async () => {
  const site = adapter(), a = dialog(site);
  a.node.appendChild(dom.node('label', { text: '逐字稿（Word）', children: [dom.node('input', { attrs: { type: 'checkbox' }, type: 'checkbox', checked: true, disabled: true })] }));
  await exporter(site, () => [a.node]).submit(target, 'ticket', []);
  assert.equal(a.start.clicks, 1);
});
