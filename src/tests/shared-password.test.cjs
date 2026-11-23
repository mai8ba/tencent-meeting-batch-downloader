const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function page(options = {}) {
  let clock = 0, open = false, failure = '', clicks = 0, frameworkClicks = 0, controlled = '', pointer = false, result;
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } preventDefault() {} stopPropagation() {} }
  const listeners = new Map();
  const window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatchEvent(event) { if (event.type === 'tmeet.shared.password-result') result(JSON.parse(event.detail)); else listeners.get(event.type)?.(event); }
  };
  class HTMLInputElement {
    get value() { return this._value || ''; } set value(v) { this._value = v; }
    focus() {} blur() {} dispatchEvent() {}
    getBoundingClientRect() { return { width: 200, height: 30 }; }
    getAttribute() { return ''; }
    closest() { return scope; }
  }
  const input = new HTMLInputElement();
  Object.assign(input, { type: options.login ? 'password' : 'text', placeholder: options.login ? '账号密码' : '请输入访问密码', name: '', id: '', labels: [], maxLength: -1, isConnected: true,
    '__reactProps$input': { onChange(e) { controlled = e.target.value; if (options.masked) input.value = '•••' + controlled.slice(-1); } }
  });
  const finish = () => {
    assert.equal(controlled, '0707', '提交前必须同步受控组件中的密码');
    if (options.wrong) failure = '密码错误'; else if (!options.never) open = true;
  };
  const button = {
    innerText: '前往查看', className: '', disabled: !!options.disabled, parentElement: null,
    getBoundingClientRect() { return { width: 200, height: 40 }; }, getAttribute() { return ''; }, focus() {},
    dispatchEvent(e) { if (e.type === 'pointerdown') pointer = true; },
    click() { clicks++; if (!options.reactOnly && (!options.pointer || pointer)) finish(); },
    '__reactProps$button': { onClick() { frameworkClicks++; finish(); } }
  };
  const scope = { className: 'record-password', get innerText() { return options.login ? '账号登录' : '访问密码 前往查看 ' + failure; },
    querySelectorAll(selector) { return selector === 'input' ? [input] : [button]; }
  };
  input.parentElement = scope;
  const document = {
    body: { get innerText() { return options.challenge ? '请完成安全验证' : open ? '逐字稿 播放' : scope.innerText; } },
    querySelectorAll(selector) { return open ? [] : selector === 'input' ? [input] : [button]; }
  };
  const ctx = vm.createContext({ window, document, HTMLInputElement, Event, InputEvent: Event, KeyboardEvent: Event, MouseEvent: Event, PointerEvent: Event, CustomEvent: Event,
    getComputedStyle() { return { visibility: 'visible' }; }, performance: { now: () => clock }, setTimeout(fn, ms) { clock += ms; queueMicrotask(fn); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'site-adapter.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared-password.js'), 'utf8'), ctx);
  const send = () => new Promise(resolve => { result = resolve; window.dispatchEvent(new Event('tmeet.shared.password', { detail: JSON.stringify({ id: 'test', password: '0707' }) })); });
  return { send, input, button, advance(ms) { clock += ms; }, get counts() { return { clicks, frameworkClicks }; }, get open() { return open; } };
}
test('密码填入后触发完整指针点击，确认密码门消失才报告打开', async () => {
  const p = page({ pointer: true }); const r = await p.send();
  assert.equal(r.state, 'opened'); assert.equal(p.open, true); assert.equal(p.counts.clicks, 1);
});
test('普通click被页面忽略时不假报成功，延迟后调用同一按钮框架处理器', async () => {
  const p = page({ reactOnly: true });
  assert.equal((await p.send()).state, 'awaiting-open'); assert.equal(p.open, false);
  p.advance(4000); assert.equal((await p.send()).state, 'opened');
  assert.deepEqual(p.counts, { clicks: 1, frameworkClicks: 1 });
});
test('按钮暂时禁用时等待启用，不消耗点击次数', async () => {
  const p = page({ disabled: true }); assert.equal((await p.send()).state, 'waiting-button'); assert.equal(p.counts.clicks, 0);
  p.button.disabled = false; assert.equal((await p.send()).state, 'opened');
});
test('密码错误后停止重试', async () => {
  const p = page({ wrong: true }); assert.equal((await p.send()).state, 'wrong-password');
  p.advance(5000); assert.equal((await p.send()).state, 'wrong-password'); assert.equal(p.counts.clicks, 1);
});
test('安全验证时不点击提交', async () => {
  const p = page({ challenge: true }); assert.equal((await p.send()).state, 'challenge'); assert.equal(p.counts.clicks, 0);
});
test('页面持续不响应时三次后明确失败，禁止无限重试', async () => {
  const p = page({ never: true });
  assert.equal((await p.send()).state, 'awaiting-open'); p.advance(4000);
  assert.equal((await p.send()).state, 'awaiting-open'); p.advance(4000);
  assert.equal((await p.send()).state, 'submit-failed'); p.advance(4000);
  assert.equal((await p.send()).state, 'submit-failed');
  assert.deepEqual(p.counts, { clicks: 1, frameworkClicks: 2 });
});
test('账号登录密码框不作为录制访问密码处理', async () => {
  const p = page({ login: true }); assert.equal((await p.send()).state, 'waiting'); assert.equal(p.input.value, ''); assert.equal(p.counts.clicks, 0);
});

test('腾讯会议将DOM密码遮罩为•••7时仍提交原密码并点击进入', async () => {
  const p = page({ masked: true, pointer: true });
  assert.equal((await p.send()).state, 'opened');
  assert.equal(p.input.value, '•••7'); assert.equal(p.open, true); assert.equal(p.counts.clicks, 1);
});
test('遮罩输入遇到原生点击失效时仍可恢复框架提交且不使用遮罩作为密码', async () => {
  const p = page({ masked: true, reactOnly: true });
  assert.equal((await p.send()).state, 'awaiting-open'); p.advance(4000);
  assert.equal((await p.send()).state, 'opened'); assert.equal(p.open, true);
});
