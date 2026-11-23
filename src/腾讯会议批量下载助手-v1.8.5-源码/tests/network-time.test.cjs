const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'network-time.js'), 'utf8');
const base = Date.UTC(2026, 9, 23, 12);
function api() {
  class LocalClock extends Date { static now() { throw new Error('电脑时间不可用'); } }
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, Date: LocalClock });
  vm.runInContext(source, context);
  return context.TMeetNetworkTime;
}
function response(time = base, extra = {}) {
  return { ok: true, redirected: false,
    headers: { get: name => name === 'date' ? new Date(time).toUTCString() : null }, ...extra };
}
const create = fetcher => api().createClock({ fetcher, monotonic: () => 10, nonce: () => 'random-test', timeoutMs: 100 });

test('至少两个 HTTPS 服务器时间一致才通过，不读取本地日期', async () => {
  const clock = create(async () => response());
  assert.equal(await clock.now(), base + 1000);
});
test('一个时间源失败可以由其余两个校验', async () => {
  const clock = create(async url => { if (url.includes('www.qq.com')) throw new Error('unreachable'); return response(); });
  assert.equal(await clock.now(), base + 1000);
});
test('单个时间源成功不足以授权', async () => {
  const clock = create(async url => { if (!url.includes('www.qq.com')) throw new Error('offline'); return response(); });
  await assert.rejects(clock.now(), /联网时间/);
});
test('时间源分歧大于五秒且无一致的两个来源时拒绝', async () => {
  let i = 0;
  const clock = create(async () => response(base + i++ * 60000));
  await assert.rejects(clock.now(), /联网时间/);
});
test('容忍一个异常旧时间源，采用另两个来源', async () => {
  const clock = create(async url => response(url.includes('www.qq.com') ? base - 86400000 : base));
  assert.equal(await clock.now(), base + 1000);
});
test('并发校时合并；每轮仍发新请求，离线不使用上次成功值', async () => {
  let calls = 0, online = true;
  const clock = create(async () => { calls++; if (!online) throw new Error('offline'); return response(); });
  await Promise.all([clock.now(), clock.now(), clock.now()]);
  assert.equal(calls, 3);
  online = false;
  await assert.rejects(clock.now(), /联网时间/);
  assert.equal(calls, 6);
});
test('网络请求不发送 Cookie、设备码和激活码，禁用缓存且允许跟随同源跳转', async () => {
  const clock = create(async (url, options) => {
    assert.ok(url.startsWith('https://'));
    assert.equal(new URL(url).searchParams.get('tmeet_time'), 'random-test');
    assert.equal(new URL(url).searchParams.size, 1);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'follow');
    assert.equal(options.method, 'HEAD');
    return response();
  });
  await clock.now();
});
test('同源重定向仍可完成校时', async () => {
  const clock = create(async url => response(base, { url: new URL('/home', url).href }));
  assert.equal(await clock.now(), base + 1000);
});
test('只有主源可用且往返延迟很小时允许单源校时', async () => {
  const clock = create(async url => { if (!url.includes('meeting.tencent.com')) throw new Error('offline'); return response(); });
  assert.equal(await clock.now(), base + 1000);
});
test('只有主源可用但往返延迟过大时仍拒绝，避免慢速中间人放大窗口', async () => {
  let monotonic = 0;
  const clock = api().createClock({ fetcher: async url => { if (!url.includes('meeting.tencent.com')) throw new Error('offline'); monotonic += 600; return response(); }, monotonic: () => monotonic, nonce: () => 'r', timeoutMs: 5000 });
  await assert.rejects(clock.now(), /联网时间/);
});
for (const [name, value] of [
  ['缓存响应', response(base, { headers: { get: n => n === 'age' ? '60' : new Date(base).toUTCString() } })],
  ['无日期', response(base, { headers: { get: () => null } })],
  ['非法日期', response(base, { headers: { get: n => n === 'date' ? 'invalid' : null } })],
  ['HTTP失败', response(base, { ok: false })],
  ['重定向到其他站点', response(base, { url: 'https://evil.example/' })]
]) {
  test(name + '默认拒绝，不使用本地时间兜底', async () => {
    await assert.rejects(create(async () => value).now(), /联网时间/);
  });
}
test('网络挂起时在截止时间拒绝并取消全部请求', async () => {
  const signals = [];
  const clock = create((_, options) => { signals.push(options.signal); return new Promise(() => {}); });
  await assert.rejects(clock.now(), /联网时间/);
  assert.ok(signals.every(s => s.aborted));
});
test('往返延迟计入保守时间上界', async () => {
  let monotonic = 0;
  const clock = api().createClock({ fetcher: async () => { monotonic += 100; return response(); }, monotonic: () => monotonic, nonce: () => 'r', timeoutMs: 5000 });
  assert.ok(await clock.now() >= base + 1100);
});
