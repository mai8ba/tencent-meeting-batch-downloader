/* 本地验签 + 限时授权联网校时。仅包含公钥，兼容原生成器。 */
(() => {
  'use strict';
  const PUBLIC_KEY = Object.freeze({
    kty: 'EC', crv: 'P-256',
    x: 'wcKjzGfs35qr_JGPETcWO42sdrvzig35X7QCChyLTYE',
    y: '3pzBDTdpEIY7oZ8VFRkxHN9dv3rp9n8hi3qSRZmxKTY'
  });
  const STORAGE_KEY = 'tmeetLicenseV1';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let verificationKey;

  function decode(part) {
    if (!part || !/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) throw new Error('激活码格式不正确，请完整复制');
    const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  async function verify(token, device) {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('激活码格式不正确');
    const parts = token.trim().split('.');
    if (parts.length !== 2) throw new Error('激活码格式不正确，请完整复制');
    let bytes, signature, payload;
    try {
      bytes = decode(parts[0]); signature = decode(parts[1]);
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { throw new Error('激活码格式不正确，请完整复制'); }
    if (signature.length !== 64) throw new Error('激活码签名无效');
    verificationKey ||= crypto.subtle.importKey('jwk', PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await verificationKey, signature, bytes);
    if (!valid) throw new Error('激活码签名无效，请联系麦爸（mai8ba）');
    if (!payload || payload.version !== 1 || !UUID.test(payload.device) || !UUID.test(payload.id) ||
        !(payload.expiresAt === null || (Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > 0 && payload.expiresAt <= 8640000000000000))) {
      throw new Error('激活码内容或版本不受支持');
    }
    if (payload.device.toLowerCase() !== device.toLowerCase()) throw new Error('激活码不属于本设备，请发送当前设备申请码给麦爸（mai8ba）');
    return Object.freeze({ ...payload });
  }

  // 安装标识只存本地；以产品命名空间派生固定 UUID 申请码，匹配原生成器输入要求。
  async function requestCode(deviceId) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mai8ba:tmeet:v1:' + deviceId.toLowerCase())));
    const bytes = digest.slice(0, 16);
    bytes[6] = (bytes[6] & 15) | 128; // UUID 自定义格式 v8
    bytes[8] = (bytes[8] & 63) | 128;
    const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function createManager(storage, now = () => TMeetNetworkTime.now()) {
    let queue = Promise.resolve();
    let cachedToken, cachedDevice, cachedPayload;
    function serial(fn) {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    }
    async function read() {
      const value = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      let record = value;
      if (!record || !UUID.test(record.deviceId)) {
        record = { deviceId: crypto.randomUUID(), token: '' };
        await storage.set({ [STORAGE_KEY]: record });
      }
      // v1.4.0 的 lastSeen 来自电脑时间，升级后完全忽略，避免旧错误时钟污染。
      const { lastSeen, ...current } = record;
      return { record: current, code: await requestCode(record.deviceId) };
    }

    async function verified(token, code) {
      if (cachedToken !== token || cachedDevice !== code) {
        const payload = await verify(token, code);
        cachedPayload = payload; cachedToken = token; cachedDevice = code;
      }
      return cachedPayload;
    }
    async function describe(context, payload) {
      const base = { requestCode: context.code, active: false, expiresAt: payload?.expiresAt ?? null, kind: 'none' };
      const trial = !payload;
      if (payload?.expiresAt === null) return { ...base, active: true, kind: 'permanent', reason: '已激活 · 永久有效' };
      let time;
      try {
        time = await now();
        if (!Number.isSafeInteger(time) || time < 0) throw new Error('invalid network time');
      } catch {
        return { ...base, kind: 'network', reason: '无法校验联网时间，请检查网络后重试；限时授权暂不可用' };
      }
      const floor = Number.isSafeInteger(context.record.networkFloor) ? context.record.networkFloor : 0;
      time = Math.max(time, floor);
      if (trial) {
        if (!Number.isSafeInteger(context.record.trialStartedAt) || context.record.trialStartedAt < 0) {
          context.record = { ...context.record, trialStartedAt: time, networkFloor: time };
          await storage.set({ [STORAGE_KEY]: context.record });
        }
        payload = { expiresAt: context.record.trialStartedAt + 3 * 86400000 };
        base.expiresAt = payload.expiresAt;
      }
      if (time - floor >= 60000 || (time >= payload.expiresAt && floor < payload.expiresAt)) {
        context.record = { ...context.record, networkFloor: time };
        await storage.set({ [STORAGE_KEY]: context.record });
      }
      base.checkedAt = time;
      if (time >= payload.expiresAt) return { ...base, kind: trial ? 'trial-expired' : 'expired', reason: trial ? '3 天免费试用已结束，请将设备申请码发给麦爸（mai8ba）购买激活码' : '激活已到期，请联系麦爸（mai8ba）续费' };
      if (trial) return { ...base, active: true, kind: 'trial', reason: '免费试用中（共 3 天）' };
      return { ...base, active: true, kind: 'limited', reason: '已激活 · 限时有效' };
    }
    async function statusInternal() {
      const context = await read();
      if (!context.record.token) return describe(context, null);
      let payload;
      try { payload = await verified(context.record.token, context.code); }
      catch (error) { return { requestCode: context.code, active: false, expiresAt: null, kind: 'invalid', reason: error.message }; }
      const status = await describe(context, payload);
      return status;
    }
    return Object.freeze({
      status: () => serial(statusInternal),
      require: () => serial(async () => {
        const status = await statusInternal();
        if (!status.active) throw new Error(status.reason);
        return status;
      }),
      activate: token => serial(async () => {
        const context = await read();
        const payload = await verify(token, context.code);
        const status = await describe(context, payload);
        if (!status.active) throw new Error(status.reason);
        // 防止误粘贴旧码把永久授权或更长有效期降级。
        let previous;
        try { previous = context.record.token ? await verified(context.record.token, context.code) : null; } catch { /* 允许修复损坏记录 */ }
        if (previous && payload.expiresAt !== null &&
            (previous.expiresAt === null || previous.expiresAt > payload.expiresAt)) {
          throw new Error('当前授权有效期更长，无需使用此激活码');
        }
        await storage.set({ [STORAGE_KEY]: { ...context.record, token: token.trim() } });
        return status;
      })
    });
  }
  globalThis.TMeetLicense = Object.freeze({ PUBLIC_KEY, STORAGE_KEY, verify, requestCode, createManager });
})();
