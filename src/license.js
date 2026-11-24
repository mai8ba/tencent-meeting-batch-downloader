/* 开源版授权：全部限制已取消。
 *
 * 背景：本项目开源发布（MIT 协议），因此不再有任何使用限制 ——
 *   · 不联网校时（也不需要 network-time.js）
 *   · 不要激活码、不限时间、不限机器、不限次数
 *   · 没有任何联网请求与本授权有关的
 *
 * 这里保留和原版完全一样的接口形状（status / require / activate），
 * 这样其余代码一行都不用改，行为也完全一致：
 *   · require() 一律通过（active: true）
 *   · status()  一律返回 active: true
 *   · activate() 变成"什么都不用做"（界面上已经没有激活入口了）
 */
(() => {
  'use strict';

  const STATUS = Object.freeze({
    active: true,
    kind: 'open-source',
    expiresAt: null,
    reason: '开源版 · 无任何使用限制',
    openSource: true,
  });

  function createManager() {
    return Object.freeze({
      status: async () => ({ ...STATUS }),
      require: async () => ({ ok: true, ...STATUS }),
      activate: async () => ({ ok: true, ...STATUS }),
    });
  }

  globalThis.TMeetLicense = Object.freeze({
    PUBLIC_KEY: '',
    STORAGE_KEY: '',
    verify: async () => ({ ...STATUS }),
    requestCode: async () => ({ code: '', deviceId: '' }),
    createManager,
  });
})();
