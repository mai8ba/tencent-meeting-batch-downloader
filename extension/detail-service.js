/* 详情页逐字稿批量下载编排（v1.8.8）
 *
 * 清单页的导出只有视频，逐字稿要进详情页拿。本模块：
 *   1. detail.capture —— 让指定详情页 tab 抓取逐字稿（content script 干），回传文本；
 *   2. detail.save   —— 把官网排版的 Markdown 存成 .md，放"腾讯会议录制下载/日期_逐字稿/"；
 *   3. detail.ping   —— 探测详情页脚本是否已就绪（等页面加载）。
 *
 * 只接受本扩展内部调用（manifest 的 cw/crm content script 与录制页）。
 * 开源版无授权限制；licensing.require() 恒通过，保留调用是为了将来想加限制时不用改结构。
 */
(() => {
  'use strict';

  function safeName(name, maxLen = 160, fallback = '逐字稿') {
    return String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen) || fallback;
  }

  /**
   * 逐字稿文件名主干：课程名 + 会议号。
   * v1.8.14：v1.8.9 起只用会议号（当时要求"跟会议号一致"），但下载列表里看不出是哪门课，
   * 用户选的"菲菲辅导麦爸"变成了纯数字。现在两头都留：课程名给人认，会议号防同名、对得上录制。
   * 课程名截 60 字，避免超长文件名。
   */
  function transcriptStem({ name, meetingId } = {}) {
    const id = String(meetingId == null ? '' : meetingId).replace(/\D/g, '');
    const title = safeName(name, 60, '');
    return [title, id].filter(Boolean).join('_') || '逐字稿';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  /**
   * 本地日期（不用 toISOString —— 那是 UTC，北京时间晚上 8 点后会差一天）。
   * folder: 2026-11-23（目录用）；stamp: 20261123（文件名前缀用）。
   */
  function localDate(now = new Date()) {
    const y = now.getFullYear();
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    return { folder: `${y}-${m}-${d}`, stamp: `${y}${m}${d}` };
  }

  /** 逐字稿相对路径：腾讯会议录制下载/2026-11-23_逐字稿/20261123_课程名_会议号_逐字稿.md
   *  v1.8.23：排版对齐腾讯官网下载的 Markdown，后缀也从 .txt 改为 .md。 */
  function transcriptFilename({ stem, day }) {
    const d = day || localDate();
    return `腾讯会议录制下载/${d.folder}_逐字稿/${d.stamp}_${stem}_逐字稿.md`;
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

  /* v1.8.13 实名登记簿
   * 逐字稿是"扩展自己发起"的下载：下载 URL 用离屏页建的 blob 链接，文件名在 download() 里传。
   * 但 background 的 onDeterminingFilename 监听器只要调用 suggest()，download() 里传的 filename
   * 就作废 —— 旧代码对"本扩展发起"的下载一律空 suggest，名字于是退化成 blob 链接尾段的 UUID
   * （用户看到 f66522b9-7f20-4421-ab0b-a909dd425857 这种文件名）。
   * 解法：下载前把 url → 期望文件名 登记好，监听器在确定文件名那一刻认领并如实 suggest。 */
  const ownNames = new Map();

  function trackOwnDownload(url, filename) {
    const u = String(url == null ? '' : url);
    const f = String(filename == null ? '' : filename);
    if (!u || !f) return;
    if (ownNames.size >= 100) ownNames.clear(); // 兜底防涨，一批远小于此
    ownNames.set(u, f);
  }

  /** 命中则返回期望文件名并清除登记；未登记返回 null（调用方保持原有命名逻辑）。 */
  function claimOwnDownload(item) {
    const keys = [item?.url, item?.finalUrl].filter(Boolean).map(String);
    for (const key of keys) {
      const hit = ownNames.get(key);
      if (!hit) continue;
      for (const k of keys) ownNames.delete(k);
      return hit;
    }
    return null;
  }

  function create({ licensing, logger = () => {}, ensureOffscreen = async () => {} }) {
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
        // v1.8.12：U+FFFD（�）说明上游解码已经失败，存下去只会是乱码。宁可报错让人重试。
        if (content.includes('\uFFFD')) {
          return { ok: false, error: '逐字稿内容含异常字符（读取环节编码出错），已跳过这一项' };
        }
        // v1.8.14：文件名 = 日期_课程名_会议号_逐字稿.txt
        // 课程名给人认，会议号用来区分同名/对上录制。
        const stem = transcriptStem({ name: message.name, meetingId: message.meetingId });
        // 文件名前缀带日期（YYYYMMDD），目录也按日期归档，方便在下载列表里按天区分。
        const filename = transcriptFilename({ stem });
        // v1.8.11：service worker 里没有 URL.createObjectURL（浏览器硬限制）。
        // 由离屏文档建 blob 链接，回到后台用 chrome.downloads 下载（官方推荐分工：
        // offscreen 只做 Web API，chrome.* 全在 service worker）。
        try {
          await ensureOffscreen();
          const blob = await chrome.runtime.sendMessage({ type: 'tmeet.blob-url', content });
          if (!blob?.ok || !blob.url) return { ok: false, error: '保存逐字稿失败：' + (blob?.error || '离屏文档无响应') };
          // v1.8.13：先登记实名，否则下载监听器会把名字冲成 blob 链接尾段的 UUID。
          trackOwnDownload(blob.url, filename);
          const id = await chrome.downloads.download({ url: blob.url, filename, conflictAction: 'uniquify', saveAs: false });
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

  globalThis.TMeetDetailService = Object.freeze({
    create, safeName, detailTab, localDate, transcriptFilename, transcriptStem, trackOwnDownload, claimOwnDownload,
  });
})();
