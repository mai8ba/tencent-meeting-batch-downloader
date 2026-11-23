/* 兼容垫片（content script 首位加载）
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────
 * 面板模式下，工作台（batch.js）跑在 content script 的**隔离世界**里，
 * 而 `TMeetFiles` 这类全局只在**扩展页**中存在（batch.html 用
 * `<script src="local-files.js">` 加载它）。
 *
 * 一旦出现「旧脚本 + 新页面」的混合状态（扩展资源里 HTML 是 fetch 的、
 * 永远最新；JS 是打包的、只有 ⟳ 重载才更新），旧脚本里的 `TMeetFiles`
 * 引用会直接抛 `ReferenceError: TMeetFiles is not defined`，
 * 表现就是"点任何按钮都报错、界面却看着正常"。
 *
 * 这里给出**降级实现**：拿不到目录句柄就如实说"当前环境不支持"，
 * 而不是让整个面板因为一个 ReferenceError 瘫掉。
 *
 * ⚠️ 本文件必须排在 batch.js 之前注入（manifest 里放在 js 数组首位）。
 */
(() => {
  'use strict';
  if (typeof globalThis.TMeetFiles !== 'undefined') return;
  const REASON = '当前环境不支持本地文件校验（面板模式下不读本地文件）';
  globalThis.TMeetFiles = Object.freeze({
    directory: async () => null,
    root: async () => null,
    status: async () => ({ granted: false, name: '', error: REASON }),
    probe: async () => ({ ok: false, reason: REASON }),
    locate: async () => null,
    contains: async () => false,
    inspect: async () => null,
    verify: async () => ({ valid: false, reason: REASON }),
    documentText: async () => '',
    documentProfile: async () => ({}),
    MIN_TRANSCRIPT_CHARS: 50,
  });
})();
