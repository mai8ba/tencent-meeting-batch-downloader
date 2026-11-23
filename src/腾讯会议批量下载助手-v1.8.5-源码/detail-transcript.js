/* 详情页逐字稿抓取（v1.8.8）
 *
 * 注入到视频详情页（/cw/*、/crm/*）。清单页的"导出"只有视频，逐字稿必须进详情页拿。
 * 收到后台 tmeet.detail.capture 指令后：切到「逐字稿」标签 → 滚动收集全部段落 → 回传纯文本。
 *
 * 抓取逻辑参考公开 userscript（babywbx/Tencent-Meeting-Transcript-Exporter）的 collectAll：
 *   - 容器 .minutes-module-list
 *   - 段落 [class*="paragraph-module_paragraph"]，用 data-pid 去重
 *   - 发言人 [class*="speaker-name"]、时间 [class*="p-start-time"]、正文 [class*="paragraph-module_sentences"]
 * 站点类名会变，所以同时保留"按 class 抓"和"按可见文本兜底"两条路。
 *
 * 本文件只依赖 DOM，不碰 Cookie/请求头，不外传任何数据（结果只回给本扩展后台）。
 */
(() => {
  'use strict';
  if (globalThis.__tmeetDetailTranscript) return;
  globalThis.__tmeetDetailTranscript = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || el.isConnected === false) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // ---------- 纯函数：段落收集（可单测） ----------
  /** 从容器当前可见节点收集段落，按 pid 去重；返回 [{pid,speaker,time,text}]。 */
  function collectVisible(container) {
    const found = new Map();
    const nodes = [...container.querySelectorAll('[class*="paragraph-module_paragraph"]')];
    for (const node of nodes) {
      const pidRaw = node.getAttribute('data-pid');
      const speaker = text(node.querySelector('[class*="speaker-name"]'));
      const time = text(node.querySelector('[class*="p-start-time"]'));
      const body = text(node.querySelector('[class*="paragraph-module_sentences"]'));
      if (!speaker && !time && !body) continue;
      // 没有 data-pid 时用"时间+正文"做键，避免同一段重复。
      const pid = pidRaw && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
      const key = pid !== null ? 'pid:' + pid : (time + '|' + body).slice(0, 300);
      if (found.has(key)) continue;
      found.set(key, { pid, speaker, time, text: body });
    }
    return [...found.values()];
  }

  /** 兜底：从容器内所有可见 div 里挑"发言人+时间+正文"或"纯正文"行。 */
  function collectByText(container) {
    const found = [];
    for (const node of container.querySelectorAll('div, p, span')) {
      if (!visible(node)) continue;
      const children = [...node.children].filter((c) => visible(c)).length;
      if (children > 1) continue; // 只取最内层文本节点，避免父子重复
      const line = text(node);
      if (!line || line.length < 2 || line.length > 5000) continue;
      const match = line.match(/^(.{1,20}?)(\d{1,2}:\d{2}(?::\d{2})?)(.*)$/);
      if (match) found.push({ pid: null, speaker: match[1].trim(), time: match[2], text: match[3].trim() });
      else found.push({ pid: null, speaker: '', time: '', text: line });
    }
    // 去掉被下一条正文完全包含的重复行（"麦爸00:02Hello" 与其后的 "Hello"）
    return found.filter((entry, i) => {
      const next = found[i + 1];
      return !(next && !next.speaker && entry.text && next.text && entry.text.includes(next.text) && entry.time);
    });
  }

  /** 组装成纯文本：每行 "[时间] 发言人：正文"。 */
  function format(entries) {
    const lines = entries.map((e) => {
      const prefix = e.time ? `[${e.time}] ` : '';
      const who = e.speaker ? `${e.speaker}：` : '';
      return prefix + who + (e.text || '').trim();
    }).filter((s) => s.trim());
    return lines.join('\n') + '\n';
  }

  function findContainer() {
    return document.querySelector('.minutes-module-list') ||
      document.querySelector('[class*="minutes-module-list"]') ||
      document.querySelector('[class*="minutes-list"]');
  }

  function clickTranscriptTab() {
    const labels = /^(转写|逐字稿|文字转写|Transcript|Transcription)$/i;
    const candidates = [...document.querySelectorAll('[role="tab"], button, [class*="tab"]')];
    const tab = candidates.find((el) => visible(el) && labels.test(text(el)));
    if (tab) { tab.click(); return true; }
    return false;
  }

  async function waitContainer(timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const c = findContainer();
      if (c && visible(c)) return c;
      await sleep(300);
    }
    return null;
  }

  /** 滚动收集：反复取当前段落 + 滚到底部，直到不再增长或到底。 */
  async function collectAll(container, { maxRounds = 400, settleRounds = 5 } = {}) {
    const all = new Map();
    const keyOf = (e) => e.pid !== null ? 'pid:' + e.pid : (e.time + '|' + e.text).slice(0, 300);
    let lastSize = -1, settle = 0;
    container.scrollTop = 0;
    await sleep(250);
    for (let round = 0; round < maxRounds; round++) {
      let batch = collectVisible(container);
      if (!batch.length) batch = collectByText(container);
      for (const e of batch) {
        const key = keyOf(e);
        if (!all.has(key)) all.set(key, e);
      }
      if (all.size === lastSize) settle++; else { settle = 0; lastSize = all.size; }
      const before = container.scrollTop;
      container.scrollTop += container.clientHeight * 0.8;
      await sleep(180);
      if (Math.abs(container.scrollTop - before) < 2) {
        // 已到底，再取一次收尾
        for (const e of collectVisible(container)) all.set(keyOf(e), e);
        break;
      }
      if (settle >= settleRounds) break;
    }
    container.scrollTop = 0;
    const list = [...all.values()];
    // 有 pid 的按 pid 排；纯文本兜底保持页面顺序
    if (list.every((e) => e.pid !== null)) list.sort((a, b) => a.pid - b.pid);
    return list;
  }

  async function capture() {
    // 若当前不在逐字稿标签，尝试切过去（已在这些标签则无需重复点）
    const activeText = text(document.querySelector('[role="tab"][aria-selected="true"], [class*="tab"][class*="active"]'));
    if (!/^(转写|逐字稿|文字转写|Transcript|Transcription)$/i.test(activeText)) clickTranscriptTab();
    const container = await waitContainer();
    if (!container) return { ok: false, error: '未找到逐字稿面板，请先手动点开「逐字稿」标签' };
    const entries = await collectAll(container);
    if (!entries.length) return { ok: false, error: '逐字稿为空或尚未加载完成，请稍后重试' };
    return { ok: true, text: format(entries), count: entries.length };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'tmeet.detail.ping') { respond({ ok: true, href: location.href }); return; }
    if (message?.type !== 'tmeet.detail.capture') return;
    capture().then(respond).catch((e) => respond({ ok: false, error: e?.message || String(e) }));
    return true; // 异步 respond
  });

  globalThis.TMeetDetail = Object.freeze({ collectVisible, collectByText, format, capture });
})();
