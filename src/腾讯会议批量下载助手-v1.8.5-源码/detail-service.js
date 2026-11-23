/* 详情页逐字稿批量下载编排（v1.8.8）
 *
 * 清单页的导出只有视频，逐字稿要进详情页拿。本模块：
 *   1. detail.capture —— 让指定详情页 tab 抓取逐字稿（content script 干），回传文本；
 *   2. detail.save   —— 把文本用 data URL 存成 .txt，放"腾讯会议录制下载/日期_逐字稿/"；
 *   3. detail.ping   —— 探测详情页脚本是否已就绪（等页面加载）。
 *
 * 只接受本扩展内部调用（manifest 的 cw/crm content script 与录制页）。
 * 授权沿用 licensing.require()：3天试用/激活码一并生效。
 */
(() => {
  'use strict';

  function toBase64(str) {
    // 逐字稿是中文 UTF-8，先转义成字节再 base64（btoa 只收 Latin-1）。
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function safeName(name) {
    return String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || '逐字稿';
  }

  function detailTab(tab) {
    try {
      const u = new URL(tab?.url || '');
      return u.origin === 'https://meeting.tencent.com' && /^\/(cw|crm)\//.test(u.pathname);
    } catch { return false; }
  }

  async function sendPing(tabId, tries = 40, delayMs = 300) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'tmeet.detail.ping' });
        if (r?.ok) return true;
      } catch { /* 页面还没注入好，继续等 */ }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }

  function create({ licensing, logger = () => {} }) {
    async function handle(message, sender) {
      const op = message.op;

      if (op === 'detail.ping') {
        const tab = await chrome.tabs.get(message.tabId).catch(() => null);
        return { ok: !!tab && detailTab(tab) && !!tab.id };
      }

      // 列出当前打开的详情页（供清单页对比"点标题前后"，找出新开的那个）
      if (op === 'detail.listTabs') {
        const tabs = await chrome.tabs.query({ url: ['https://meeting.tencent.com/cw/*', 'https://meeting.tencent.com/crm/*'] });
        return { ok: true, tabs: tabs.filter(detailTab).map(t => ({ id: t.id, url: t.url, title: t.title })) };
      }

      if (op === 'detail.closeTab') {
        const tabId = Number(message.tabId);
        if (Number.isInteger(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
        return { ok: true };
      }

      if (op === 'detail.capture') {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) return { ok: false, error: '标签页参数无效' };
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || !detailTab(tab)) return { ok: false, error: '目标不是腾讯会议详情页' };
        await licensing.require();
        const ready = await sendPing(tabId);
        if (!ready) return { ok: false, error: '详情页脚本未就绪，请刷新该页后重试' };
        let result;
        try {
          result = await chrome.tabs.sendMessage(tabId, { type: 'tmeet.detail.capture' });
        } catch (e) {
          return { ok: false, error: '读取逐字稿失败：' + (e?.message || String(e)) };
        }
        return result && typeof result === 'object'
          ? result
          : { ok: false, error: '逐字稿回传格式无效' };
      }

      if (op === 'detail.save') {
        const content = String(message.content == null ? '' : message.content);
        if (!content.trim()) return { ok: false, error: '逐字稿内容为空，未保存' };
        const name = safeName(message.name);
        const day = new Date().toISOString().slice(0, 10);
        const filename = `腾讯会议录制下载/${day}_逐字稿/${name}_逐字稿.txt`;
        const url = 'data:text/plain;charset=utf-8;base64,' + toBase64(content);
        try {
          const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
          logger('detail.save', { id, filename, bytes: content.length });
          return { ok: true, id, filename };
        } catch (e) {
          return { ok: false, error: '保存逐字稿失败：' + (e?.message || String(e)) };
        }
      }

      return { ok: false, error: '未知操作：' + op };
    }
    return Object.freeze({ handle });
  }

  globalThis.TMeetDetailService = Object.freeze({ create, toBase64, safeName, detailTab });
})();
