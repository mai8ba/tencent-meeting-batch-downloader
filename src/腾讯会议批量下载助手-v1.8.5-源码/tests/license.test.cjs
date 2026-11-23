const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'license.js'), 'utf8');
const keyPair = webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const clockStart = Date.UTC(2026, 9, 23, 12);
const storageKey = 'tmeetLicenseV1';

async function harness() {
  const pair = await keyPair;
  const publicKey = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  // 仅在测试隔离上下文注入临时公钥；发行代码始终使用真实公钥。
  const testSource = source.replace(/const PUBLIC_KEY = Object.freeze\(\{[\s\S]*?\}\);/, `const PUBLIC_KEY = Object.freeze(${JSON.stringify(publicKey)});`);
  class LocalClock extends Date { static now() { throw new Error('不允许读取电脑时间'); } }
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, atob, Date: LocalClock });
  vm.runInContext(testSource, context);
  const api = context.TMeetLicense;
  const data = {};
  const storage = { async get(k) { return { [k]: structuredClone(data[k]) }; }, async set(v) { Object.assign(data, structuredClone(v)); } };
  let time = clockStart;
  const manager = api.createManager(storage, () => time);
  const sign = async payload => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes);
    return bytes.toString('base64url') + '.' + Buffer.from(signature).toString('base64url');
  };
  const token = async (expiresAt = null, overrides = {}) => sign({ version: 1, device: (await manager.status()).requestCode, expiresAt, id: webcrypto.randomUUID(), ...overrides });
  return { api, data, storage, manager, token, sign, setTime: value => { time = value; }, restart: () => api.createManager(storage, () => time) };
}

test('设备申请码稳定、格式兼容原生成器、重启不变，不同安装不同', async () => {
  const h = await harness();
  const a = await h.manager.status();
  assert.match(a.requestCode, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.equal(a.kind, 'trial');
  assert.equal(a.active, true);
  assert.equal((await h.restart().status()).requestCode, a.requestCode);
  assert.notEqual((await (await harness()).manager.status()).requestCode, a.requestCode);
});

test('试用持续72小时，重启不重置，到期边界立即失效且不能回拨复活', async () => {
  const h = await harness();
  const initial = await h.manager.require();
  assert.equal(initial.expiresAt, clockStart + 3 * 86400000);
  h.setTime(initial.expiresAt - 1);
  assert.equal((await h.restart().require()).kind, 'trial');
  h.setTime(initial.expiresAt);
  assert.equal((await h.restart().status()).kind, 'trial-expired');
  await assert.rejects(h.manager.require(), /试用已结束/);
  h.setTime(clockStart);
  assert.equal((await h.restart().status()).active, false);
});

test('首次断网不启动试用，恢复联网后启动；试用断网暂停授权', async () => {
  const h = await harness();
  const offline = h.api.createManager(h.storage, async () => { throw new Error('offline'); });
  assert.equal((await offline.status()).kind, 'network');
  assert.equal(h.data[storageKey].trialStartedAt, undefined);
  assert.equal((await h.manager.require()).kind, 'trial');
  await assert.rejects(offline.require(), /联网时间/);
});

test('试用到期后支持限时与永久激活，付费授权到期不回退免费试用', async () => {
  const h = await harness();
  await h.manager.status();
  h.setTime(clockStart + 3 * 86400000);
  await h.manager.activate(await h.token(clockStart + 4 * 86400000));
  assert.equal((await h.manager.require()).kind, 'limited');
  h.setTime(clockStart + 4 * 86400000);
  assert.equal((await h.manager.status()).kind, 'expired');
  await h.manager.activate(await h.token());
  assert.equal((await h.restart().require()).kind, 'permanent');
});

test('并发首次请求只生成一个安装标识', async () => {
  const h = await harness();
  const values = await Promise.all(Array.from({ length: 12 }, () => h.manager.status()));
  assert.equal(new Set(values.map(x => x.requestCode)).size, 1);
});

test('永久授权可离线恢复且不会随时间到期', async () => {
  const h = await harness();
  assert.equal((await h.manager.activate(await h.token())).kind, 'permanent');
  h.setTime(clockStart + 100 * 365 * 86400000);
  assert.equal((await h.restart().require()).active, true);
});

test('限时授权在到期边界立即失效', async () => {
  const h = await harness();
  await h.manager.activate(await h.token(clockStart + 1000));
  h.setTime(clockStart + 999);
  assert.equal((await h.manager.status()).active, true);
  h.setTime(clockStart + 1000);
  assert.equal((await h.manager.status()).kind, 'expired');
  await assert.rejects(h.manager.require(), /到期/);
});

test('已过期激活码被拒绝，不写入激活状态', async () => {
  const h = await harness();
  await assert.rejects(h.manager.activate(await h.token(clockStart - 1)), /到期/);
  assert.equal((await h.manager.status()).kind, 'trial');
});

test('续费沿用申请码，允许永久升级，禁止降级为短期', async () => {
  const h = await harness();
  const first = (await h.manager.status()).requestCode;
  await h.manager.activate(await h.token(clockStart + 1000));
  await h.manager.activate(await h.token(clockStart + 5000));
  await assert.rejects(h.manager.activate(await h.token(clockStart + 2000)), /更长/);
  await h.manager.activate(await h.token());
  await assert.rejects(h.manager.activate(await h.token(clockStart + 10000)), /更长/);
  assert.equal((await h.manager.status()).requestCode, first);
});

test('设备错配拒绝；申请码大小写按同一 UUID 处理', async () => {
  const h = await harness();
  await assert.rejects(h.manager.activate(await h.token(null, { device: webcrypto.randomUUID() })), /不属于本设备/);
  const code = (await h.manager.status()).requestCode;
  assert.equal((await h.manager.activate(await h.token(null, { device: code.toUpperCase() }))).active, true);
});

test('篡改有效期或签名均拒绝且不破坏已有授权', async () => {
  const h = await harness();
  const valid = await h.token(clockStart + 10000);
  await h.manager.activate(valid);
  const [body, signature] = valid.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url'));
  payload.expiresAt = null;
  await assert.rejects(h.manager.activate(Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + signature), /签名/);
  const badSignature = Buffer.from(signature, 'base64url'); badSignature[0] ^= 1;
  await assert.rejects(h.manager.activate(body + '.' + badSignature.toString('base64url')), /签名/);
  assert.equal((await h.manager.status()).expiresAt, clockStart + 10000);
});

test('不同私钥签发的码被拒绝', async () => {
  const h = await harness();
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const bytes = Buffer.from(JSON.stringify({ version: 1, device: (await h.manager.status()).requestCode, id: webcrypto.randomUUID(), expiresAt: null }));
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes);
  await assert.rejects(h.manager.activate(bytes.toString('base64url') + '.' + Buffer.from(sig).toString('base64url')), /签名/);
});

test('未知版本、缺失有效期、字符串日期和异常 id 被拒绝', async () => {
  const h = await harness();
  for (const overrides of [{ version: 2 }, { expiresAt: undefined }, { expiresAt: 'permanent' }, { expiresAt: 0 }, { id: 'bad' }]) {
    await assert.rejects(h.manager.activate(await h.token(null, overrides)), /内容或版本/);
  }
});

test('空值、截断、超长、非 base64 激活码被拒绝', async () => {
  const h = await harness();
  for (const value of ['', null, 'x.y', '💥.abc', 'a'.repeat(5000)]) await assert.rejects(h.manager.activate(value));
});

test('粘贴首尾空白可正常激活，重复激活幂等', async () => {
  const h = await harness(); const token = await h.token();
  await h.manager.activate(' \n' + token + '\n ');
  assert.equal((await h.manager.activate(token)).kind, 'permanent');
});

test('联网时间短暂回退不会降低已记录的联网时间；电脑时钟不参与判定', async () => {
  const h = await harness();
  await h.manager.activate(await h.token(clockStart + 86400000));
  h.setTime(clockStart + 3600000); await h.manager.status();
  h.setTime(clockStart);
  assert.equal((await h.restart().status()).checkedAt, clockStart + 3600000);
  h.setTime(clockStart + 3600000);
  assert.equal((await h.manager.status()).active, true);
});

test('断网立即拒绝限时授权，不能沿用已保存的联网时间', async () => {
  const h = await harness();
  await h.manager.activate(await h.token(clockStart + 86400000));
  const offline = h.api.createManager(h.storage, async () => { throw new Error('offline'); });
  assert.equal((await offline.status()).kind, 'network');
  await assert.rejects(offline.require(), /联网时间/);
  await assert.rejects(offline.activate(await h.token(clockStart + 172800000)), /联网时间/);
  assert.equal((await h.manager.require()).active, true);
});

test('永久授权与设备申请码生成不要求联网', async () => {
  const h = await harness();
  const offline = h.api.createManager(h.storage, async () => { throw new Error('offline'); });
  assert.ok((await offline.status()).requestCode);
  await offline.activate(await h.token());
  assert.equal((await offline.require()).kind, 'permanent');
});

test('升级忽略旧版错误电脑时间 lastSeen，保留设备与授权', async () => {
  const h = await harness();
  await h.manager.activate(await h.token(clockStart + 86400000));
  h.data[storageKey].lastSeen = 8640000000000000;
  assert.equal((await h.restart().require()).active, true);
});

test('已记录的到期时间不因小幅回拨重新有效', async () => {
  const h = await harness();
  await h.manager.activate(await h.token(clockStart + 120000));
  h.setTime(clockStart + 120000); await h.manager.status();
  h.setTime(clockStart + 119000);
  assert.equal((await h.manager.status()).kind, 'expired');
});

test('不足一分钟内到期也立即记录，不因小幅回拨复活', async () => {
  const h = await harness();
  await h.manager.activate(await h.token(clockStart + 1000));
  h.setTime(clockStart + 1000); await h.manager.status();
  h.setTime(clockStart + 999);
  assert.equal((await h.restart().status()).kind, 'expired');
});

test('伪造 active 标志不能授权；损坏 token 返回无效状态', async () => {
  const h = await harness(); await h.manager.status();
  h.data[storageKey].active = true;
  h.setTime(clockStart + 3 * 86400000);
  assert.equal((await h.manager.status()).active, false);
  h.data[storageKey].token = 'bad';
  assert.equal((await h.manager.status()).kind, 'invalid');
});

test('清除本地安装身份后，原码不能激活新安装', async () => {
  const h = await harness(); const token = await h.token();
  delete h.data[storageKey];
  await assert.rejects(h.restart().activate(token), /不属于本设备/);
});

test('存储失败时默认拒绝使用，不假报激活成功', async () => {
  const h = await harness();
  const manager = h.api.createManager({ async get() { throw new Error('storage unavailable'); } });
  await assert.rejects(manager.require(), /storage unavailable/);
});

test('原始 HTML 生成器实际签发的永久/限时码与发行公钥兼容', { skip: !process.env.TMEET_GENERATOR_PATH }, async () => {
  // 私钥只从用户指定文件读入内存，不保存、不打印、不打包。
  const html = fs.readFileSync(process.env.TMEET_GENERATOR_PATH, 'utf8');
  const privateJwk = JSON.parse(html.match(/window\.KECUN_ADMIN_KEY\s*=\s*(\{[^;]+\});/)[1]);
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, atob, Date });
  vm.runInContext(source, context);
  for (const field of ['kty', 'crv', 'x', 'y']) assert.equal(context.TMeetLicense.PUBLIC_KEY[field], privateJwk[field]);
  const device = webcrypto.randomUUID();
  const nodes = new Map();
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { style: {}, value: '', checked: false }); return nodes.get(id); } };
  const generator = vm.createContext({ window: { KECUN_ADMIN_KEY: privateJwk }, document, crypto: webcrypto, TextEncoder, btoa, Date });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  vm.runInContext(scripts.find(x => x.includes("$('generate').onclick")), generator);
  for (const permanent of [true, false]) {
    document.getElementById('device').value = device;
    document.getElementById('permanent').checked = permanent;
    document.getElementById('expires').value = '2099-12-31';
    await document.getElementById('generate').onclick();
    const payload = await context.TMeetLicense.verify(document.getElementById('output').value, device);
    assert.equal(payload.expiresAt === null, permanent);
  }
});
