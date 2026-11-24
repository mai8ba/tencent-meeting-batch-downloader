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

  /**
   * v1.8.22 验货：判断一堆段落是否像真逐字稿，防止把播放器 UI / 空态说明当正文存下去。
   * 判据（满足任一即判"不是逐字稿"）：
   *   1) 命中明显的播放器设置面板 / 空态提示文案（放大字体、透明背景、未生成字幕…）
   *   2) 一条带合法时间戳的都没有（真逐字稿每行都有 mm:ss）
   * 真逐字稿的正文里偶尔提到"全屏""字体"这类词很正常，所以只匹配"整句级"的固定短语，
   * 不因单个普通词误杀。
   */
  const UI_NOISE = /(Transparency|不透明半透明背景|白底红绿蓝黄蓝|放大字体|恢复至默认设置|退出全屏或关闭窗口|modal window|输入字幕内容|暂时无生成字幕|未生成\s*总时长|倍速\s*[\d.]+x|加时卡|刷新时间[:：])/i;
  function looksLikeTranscript(entries) {
    if (!Array.isArray(entries) || !entries.length) return false;
    let timed = 0;
    for (const e of entries) {
      const body = String(e?.text || '');
      if (UI_NOISE.test(body) || UI_NOISE.test(String(e?.speaker || ''))) return false;
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(e?.time || '').trim())) timed++;
    }
    return timed > 0;
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

  // ---------- 接口快路：直接解析 /minutes/detail 的 JSON（v1.8.9） ----------
  // 详情页加载时腾讯自己会请求逐字稿接口， MAIN world 的 shared-observer.js 拦截后
  // 派发 tmeet.shared.capture 事件（detail 是 JSON 字符串）。这里缓存下来，
  // 导出时直接读全文，省掉慢速的 DOM 滚动。结构与 shared-core.js 的 segments 一致。
  // 接口是分页的（每次返回一段 paragraphs，data.more 表示还有下一页），必须按 pid
  // 累积合并，不能只留最后一页——否则长逐字稿只剩末尾一段。
  const apiParagraphs = new Map(); // pid -> paragraph（跨页累积去重）
  let apiComplete = false; // 接口声明"没有下一页"了
  window.addEventListener('tmeet.shared.capture', (event) => {
    try {
      const payload = JSON.parse(event.detail);
      // 真实接口是 /wemeet-cloudrecording-webapi/v1/minutes/detail 这种带前缀的完整路径，
      // 必须按"结尾匹配"，写成 === '/minutes/detail' 永远不成立（v1.8.9 就栽在这）。
      if (!/\/minutes\/detail$/.test(String(payload?.path || '')) || !payload.data) return;
      if (payload.data.code !== undefined && Number(payload.data.code) !== 0) return;
      const minutes = payload.data.minutes || payload.data.data?.minutes || payload.data.data?.detail?.minutes;
      const paragraphs = Array.isArray(minutes?.paragraphs) ? minutes.paragraphs : [];
      for (const p of paragraphs) {
        const pid = Number(p?.pid);
        if (Number.isFinite(pid)) apiParagraphs.set(pid, p);
      }
      // more=false/0 表示这是最后一页
      const more = payload.data.more;
      if (more === false || more === 0) apiComplete = true;
    } catch { /* 无关事件 */ }
  });

  /** 毫秒时间戳 → mm:ss（接口 start_time 单位毫秒）。 */
  function msToClock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  /** 把 paragraphs 数组解析成与 DOM 抓取同构的段落数组（供单测与缓存共用）。 */
  function fromParagraphs(paragraphs) {
    const list = Array.isArray(paragraphs) ? paragraphs : [];
    const entries = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i] || {};
      const sentences = Array.isArray(p.sentences) ? p.sentences : [];
      let body = '';
      for (const s of sentences) {
        const words = Array.isArray(s?.words) ? s.words : [];
        for (const w of words) if (typeof w?.text === 'string') body += w.text;
      }
      if (!body.trim()) continue;
      entries.push({
        pid: Number(p.pid) || i,
        speaker: String(p.speaker?.user_name || ''),
        time: msToClock(p.start_time),
        text: body,
      });
    }
    entries.sort((a, b) => a.pid - b.pid); // 分页乱序到达时按段号还原
    return entries;
  }

  /** 把单次 /minutes/detail 接口响应解析成段落数组（兼容旧测试入口）。 */
  function fromApiData(data) {
    if (!data || (data.code !== undefined && Number(data.code) !== 0)) return [];
    const minutes = data.minutes || data.data?.minutes || data.data?.detail?.minutes;
    return fromParagraphs(minutes?.paragraphs);
  }

  /** 从累积缓存取全文；ready=接口已声明无下一页（或已稳定一段时间）。 */
  function cachedTranscript(ready) {
    if (!apiParagraphs.size) return null;
    if (!ready) return null;
    const entries = fromParagraphs([...apiParagraphs.values()]);
    if (!entries.length) return null;
    return { text: format(entries), count: entries.length, source: 'api' };
  }

  /**
   * v1.8.22：返回 { node, exact }。
   * exact=true 才是真正的逐字稿容器；退化到 documentElement 时 exact=false——
   * 这时绝不能跑 collectByText（整页可见文字会把播放器设置面板/空态说明当正文抄下来）。
   */
  function findContainer() {
    const exact =
      document.querySelector('.minutes-module-list') ||
      document.querySelector('[class*="minutes-module-list"]') ||
      document.querySelector('[class*="minutes-list"]');
    if (exact) return { node: exact, exact: true };
    return { node: document.documentElement, exact: false };
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
      const found = findContainer();
      // 真容器要可见才算就绪；documentElement 兜底只用于"确实没有容器但页面还在"的情况。
      if (found.node && visible(found.node)) return found;
      await sleep(300);
    }
    return null;
  }

  /** 滚动收集：反复取当前段落 + 滚到底部，直到不再增长或到底。
   *  allowTextFallback：只有在真逐字稿容器里才允许 collectByText 文本兜底；
   *  退化到整页时强制关闭，否则会把播放器 UI 文字全抄进来（v1.8.22）。
   */
  async function collectAll(container, { maxRounds = 400, settleRounds = 5, allowTextFallback = true } = {}) {
    const all = new Map();
    const keyOf = (e) => e.pid !== null ? 'pid:' + e.pid : (e.time + '|' + e.text).slice(0, 300);
    let lastSize = -1, settle = 0;
    container.scrollTop = 0;
    await sleep(250);
    for (let round = 0; round < maxRounds; round++) {
      let batch = collectVisible(container);
      if (!batch.length && allowTextFallback) batch = collectByText(container);
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
    // 若当前不在逐字稿标签，尝试切过去（点它会触发腾讯请求逐字稿接口）
    const activeText = text(document.querySelector('[role="tab"][aria-selected="true"], [class*="tab"][class*="active"]'));
    const onTranscript = /^(转写|逐字稿|文字转写|Transcript|Transcription)$/i.test(activeText);
    if (!onTranscript) clickTranscriptTab();

    // 快路：等接口全文。分页需到齐——接口声明 complete，或段数连续若干轮不再增长。
    let lastCount = -1, stableRounds = 0;
    for (let i = 0; i < 40; i++) { // 最多约 6 秒
      const ready = apiComplete || (apiParagraphs.size > 0 && apiParagraphs.size === lastCount && stableRounds >= 4);
      const hit = cachedTranscript(ready);
      if (hit) {
        logCapture('api', hit.count);
        return { ok: true, ...hit };
      }
      if (apiParagraphs.size === lastCount) stableRounds++; else { stableRounds = 0; lastCount = apiParagraphs.size; }
      await sleep(150);
    }

    // 兜底：接口没拿到（站点改路径/改动监听失效），退回 DOM 滚动。
    // v1.8.22：只有找到真容器才允许文本兜底；退化到整页时只认 paragraph 节点。
    const found = await waitContainer(12000);
    const entries = found ? await collectAll(found.node, { allowTextFallback: found.exact }) : [];
    if (!entries.length) {
      // 把卡点说清楚：接口没拦到、DOM 也没读到，方便定位而不是只说"失败"。
      const apiHint = apiParagraphs.size ? `接口只拿到 ${apiParagraphs.size} 段` : '接口未拦到逐字稿数据';
      return { ok: false, error: `这场会议没有生成逐字稿，或逐字稿尚未加载（${apiHint}）；请手动点开该会议的「逐字稿」标签确认后再试` };
    }
    // v1.8.22 验货：抓到的是播放器 UI / 空态说明，宁可报失败也不存一份垃圾文件。
    if (!looksLikeTranscript(entries)) {
      return { ok: false, error: '读到的内容不像逐字稿（疑似播放器界面文字或未生成字幕），已跳过不保存；请手动点开该会议的「逐字稿」标签确认' };
    }
    logCapture('dom', entries.length);
    return { ok: true, text: format(entries), count: entries.length, source: 'dom' };
  }

  function logCapture(source, count) {
    try { console.info('[detail] capture via', source, count, 'segments', location.href); } catch { /* noop */ }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'tmeet.detail.ping') { respond({ ok: true, href: location.href }); return; }
    if (message?.type !== 'tmeet.detail.capture') return;
    capture().then(respond).catch((e) => respond({ ok: false, error: e?.message || String(e) }));
    return true; // 异步 respond
  });

  globalThis.TMeetDetail = Object.freeze({ collectVisible, collectByText, looksLikeTranscript, format, msToClock, fromApiData, capture });
})();
