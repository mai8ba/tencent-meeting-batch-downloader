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

function detailCtx() {
  const ctx = vm.createContext({ console, chrome: { runtime: { onMessage: { addListener() {} } } }, TextEncoder });
  vm.runInContext(detailSrc, ctx);
  return ctx.TMeetDetail;
}
function serviceCtx() {
  const ctx = vm.createContext({ console, URL, TextEncoder, btoa: (s) => Buffer.from(s, 'binary').toString('base64') });
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

test('toBase64：中文 UTF-8 正确编码，解码回原文', () => {
  const s = serviceCtx();
  const b64 = s.toBase64('麦爸00:02 听歌能听到吗？');
  const back = Buffer.from(b64, 'base64').toString('utf8');
  assert.equal(back, '麦爸00:02 听歌能听到吗？');
});

test('detailTab：只认会议详情页 cw/crm，不认清单页', () => {
  const s = serviceCtx();
  assert.equal(s.detailTab({ url: 'https://meeting.tencent.com/cw/abc123' }), true);
  assert.equal(s.detailTab({ url: 'https://meeting.tencent.com/crm/abc123' }), true);
  assert.equal(s.detailTab({ url: 'https://meeting.tencent.com/user-center/meeting-record' }), false);
  assert.equal(s.detailTab({ url: 'https://evil.test/cw/abc' }), false);
});
