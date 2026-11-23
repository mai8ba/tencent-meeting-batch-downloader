/* 开源版：没有"激活"这回事。
 *
 * 原版是一个完整的激活面板（设备申请码 / 激活码 / 3 天试用说明），
 * 开源发布后这些全部取消。这里保留 mount() 这个接口只是为了不改调用方：
 * 它不渲染任何 UI，只回报"已激活、随便用"。
 *
 * 想加回来时，把这个文件换回原来的实现即可，其余代码不用动。
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

  function mount(container, onChange = () => {}) {
    // 容器可能已经被删掉了（开源版不需要这个节点），不能因此报错。
    if (container) container.replaceChildren();
    try { onChange({ ...STATUS }); } catch { /* 调用方的回调出错不该影响页面 */ }
    return Object.freeze({
      refresh: async () => ({ ...STATUS }),
      dispose() { if (container) container.replaceChildren(); },
    });
  }

  globalThis.TMeetLicenseUI = Object.freeze({ mount });
})();
