// ============================================================
// 腾讯会议录制批量下载助手 - content script (v1.8.17)
// 注入到 https://meeting.tencent.com/user-center/meeting-record
//
// 本文件只做"执行引擎"：
//   1) 采集清单：设置每页条数(最大30) → 自动翻页读取全部文件
//   2) 导出选中：按页码分组导航 → hover「更多」→ 点「导出」
//   界面全部移到扩展工作台 batch.html，那边通过 tmeet.batch 消息驱动这里，
//   这里用 tmeet.live 把进度推回去。页面上只留一个悬浮球（打开工作台）。
//
// 站点选择器一律走 site-adapter.js（TMeetSite），本文件不再写死类名，
// 腾讯会议改版时只需要改适配层。
// ============================================================
(() => {
  'use strict';

  // ---------- 默认配置 ----------
  const DEFAULT_CONFIG = {
    pageSize: 30,          // 每页条数（页面支持 10/20/30）
    maxConcurrent: 2,
    clickDelay: 2500,      // 每次导出间隔(ms)，防风控
    autoClassify: false,   // 下载自动分类（background 配合）
  };
  // 工作台（batch.html / popup.html）连进来的来源白名单。
  const UI_PAGES = ['batch.html', 'popup.html'];

  let CONFIG = { ...DEFAULT_CONFIG };

  // ---------- 运行状态 ----------
  const state = {
    collected: [],
    selected: new Set(),
    collectionPageSize: 30,
    stopped: false,          // 采集到的全部文件
    collecting: false,
    licenseActive: false,
    exporting: false,
    exportedSet: new Set(), // 本次会话已导出成功的 fileId（标记用）
    verifiedSet: new Set(), // 历史已通过正文校验的 "fileId|type"，跨会话恢复
    localGranted: false,    // 下载文件夹是否已授权（工作台底栏显示）
    localKnown: false,      // 是否拿到了明确的授权结论（查询失败时为 false）
    localName: '',
    licenseKnown: false,    // 授权状态是否已查过（工作台首次打开时补查一次）
    pendingList: [],        // [{ key, fileId, kind }] 待核对记录：上次点了导出但结果不明
    pendingAt: 0,           // 上次查询时间（10 秒内复用）
    filter: { type: 'all', keyword: '' },
  };

  // ---------- 工作台进度（推送给 batch.html） ----------
  // phase: idle | collecting | verifying | exporting | done | error
  const live = { phase: 'idle', message: '', total: 0, done: 0, failed: 0, active: 0, percent: 0, at: 0 };
  let lastPush = 0;

  function setLive(patch, { throttle = 0 } = {}) {
    Object.assign(live, patch, { at: Date.now() });
    // 高频进度节流：250ms 内合并，避免每条都发一次跨上下文消息。
    const now = Date.now();
    if (throttle && now - lastPush < throttle) return;
    lastPush = now;
    pushLive();
    paintFab();
  }

  function pushLive() {
    const payload = { ...live, collectedCount: state.collected.length };
    // 同页面板：content script 之间收不到 chrome.runtime 消息，必须直接回调，
    // 否则导出期间面板的进度条会一直停在起点，看着像没动。
    try { globalThis.__tmeetPanelLive?.({ type: 'tmeet.live', live: payload }); } catch { /* 面板未就绪，忽略 */ }
    // 工作台没打开时没有接收方，sendMessage 会 reject，这里静默忽略。
    try {
      const result = chrome.runtime.sendMessage({ type: 'tmeet.live', live: payload });
      if (result?.catch) result.catch(() => {});
    } catch { /* 扩展重载后上下文失效，忽略 */ }
  }


  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('[腾讯会议批量下载助手]', ...a);

  // 悬浮球在 Shadow DOM 里，查询要走 shadow root；单元测试里没有悬浮球，退回 document。
  let fabScope = null;
  function $fab(selector) {
    if (fabScope) return fabScope.querySelector(selector);
    return document.querySelector(selector) || (selector[0] === '#' ? document.getElementById(selector.slice(1)) : null);
  }

  // ---------- 持久化 ----------
  async function loadState() {
    try {
      const data = await chrome.storage.local.get('config');
      if (data.config) CONFIG = { ...DEFAULT_CONFIG, ...data.config, pageSize: 30 };
      // 旧版 exportedIds 仅代表点击过，不能当作下载完成。
      // 旧完成标记没有校验正文，升级后不再信任；每次开始导出重新核对磁盘。
      state.exportedSet = new Set();
      const { ownDraftV3 } = await chrome.storage.local.get('ownDraftV3');
      if (ownDraftV3?.collected?.length) {
        state.collected = ownDraftV3.collected; state.selected = new Set(ownDraftV3.selected || []);
        state.collectionPageSize = ownDraftV3.pageSize || 30;
      }
      // 历史已校验记录：刷新页面/第二天再打开时，不把已下载的课再全选一遍。
      try {
        const { exported } = await rpc('journal.exported');
        state.verifiedSet = new Set((exported || []).filter(x => x.scope === 'own').map(x => x.fileId + '|' + x.kind));
      } catch (e) { log('读取已校验记录失败', e); }
    } catch (e) { log('读取存储失败', e); }
  }

  async function saveDraft() { await chrome.storage.local.set({ ownDraftV3: { collected: state.collected, selected: [...state.selected], pageSize: state.collectionPageSize } }); }
  // 采集时每页都全量写一次草稿；改为合并写入，避免长清单把主线程拖慢。
  let draftTimer = null;
  function scheduleDraft(delay = 1200) {
    if (draftTimer) return;
    draftTimer = setTimeout(() => { draftTimer = null; void saveDraft().catch(log); }, delay);
  }
  async function saveExported() {
    try {
      await saveDraft();
    } catch (e) { log('保存存储失败', e); }
  }

  // ============================================================
  // 页面 DOM 操作（选择器全部来自 TMeetSite）
  // ============================================================
  const S = TMeetSite.s;

  // 获取当前页所有录制行（含无会议号的录音/上传文件）
  function getRows() {
    return [...document.querySelectorAll(S.recordRow)].filter(
      (tr) => tr.querySelector(S.recordMore) && (tr.innerText || '').trim()
    );
  }

  // 解析单行数据
  function parseRow(row) {
    const text = row.innerText || '';
    let name = '';
    const nameEl = row.querySelector(S.recordTitle);
    if (nameEl) name = nameEl.innerText.trim();
    if (!name) {
      name = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '未知文件';
    }
    const checkLabel = row.querySelector(S.recordFileCheck);
    const fileId = checkLabel ? checkLabel.getAttribute('name') || '' : '';
    // 会议号在页面中显示为「448 436 389」带空格
    const meetingRaw = (text.match(/会议号[:：][ \t]*(\d{3}[ \t]*\d{3}[ \t]*\d{3})/) || [])[1] || '';
    const meetingId = meetingRaw.replace(/\s/g, '');
    const time = (text.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/) || [])[0] || '';
    const size = (text.match(/([\d.]+)\s*(?:MB|GB|KB)/i) || [])[0] || '';
    // v1.8.6：按"文件大小"列判断有没有视频（有 MB/GB 数字 = 有视频），不看名字。
    // 同一场录制的「转写_xxx」行没大小、「xxx」行有大小，会议号相同。
    const video = TMeetSite.hasVideo(size);
    return {
      fileId,
      name,
      meetingId,
      time,
      size,
      hasVideo: video,
      type: video ? 'video' : 'transcript',
    };
  }

  // 设置每页条数
  /** 从一段文案里取第一个数字（"30"、"30 条/页"、"每页 30 条" 都能读出 30）。 */
  function firstNumber(value) {
    const match = /(\d+)/.exec(String(value == null ? '' : value));
    return match ? Number(match[1]) : null;
  }

  /** 当前每页条数；读不出来返回 null，不猜。 */
  function readPageSize() {
    const el = document.querySelector(S.pageSizeValue);
    if (!el) return null;
    const n = firstNumber(el.innerText || el.textContent);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * 在下拉里找"每页 N 条"的选项。
   * 站点文案可能只是 "30"，也可能带单位（"30 条/页"）——只比数字，否则永远设置失败。
   */
  function findPageSizeOption(size) {
    const header = document.querySelector(S.pageSizeHeader);
    // 优先在下拉容器内找，避免误命中分页页码等数值相同的 li。
    const scopes = [];
    const box = header && header.closest('.met-pagination__select');
    if (box) scopes.push(box);
    scopes.push(document);
    for (const scope of scopes) {
      const hit = [...scope.querySelectorAll(S.pageSizeOption)].find((li) => {
        const r = li.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        return firstNumber(li.innerText || li.textContent) === size;
      });
      if (hit) return hit;
    }
    return null;
  }

  async function setPageSize(size) {
    checkStopped();
    const header = document.querySelector(S.pageSizeHeader);
    // 单页列表可能不显示分页控件。
    if (!header) return getRows().length > 0 && !document.querySelector(S.pageChoose);
    // 已经是目标条数就别去动下拉：一点就可能把用户正在看的列表重置掉。
    if (readPageSize() === size) return true;
    const before = signature();
    const mayStaySame = getActivePage() === 1 && !findNextBtn() && getRows().length <= size;

    const deadline = performance.now() + 8000;
    let opened = false;
    while (performance.now() < deadline) {
      checkStopped();
      // 下拉可能已经是展开状态（用户自己开过）：这时再点表头反而会把选项收起来。
      let option = findPageSizeOption(size);
      if (!option) {
        if (!opened) { header.click(); opened = true; await sleep(300); }
        option = findPageSizeOption(size);
      }
      if (option) {
        option.click();
        const until = performance.now() + 5000;
        while (performance.now() < until) {
          checkStopped();
          if (readPageSize() === size) {
            await waitRowsStable(15000, mayStaySame ? null : before);
            return true;
          }
          await sleep(100);
        }
      }
      if (opened) { document.body.click(); opened = false; await sleep(200); }
    }
    return false;
  }

  /**
   * 采集时按 30 条/页记下的页码，在别的每页条数下等价于第几页。
   * 用绝对序号换算，站点改了每页条数也不会导错课。
   */
  function rebasePages(items, from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
    for (const item of items) {
      const index = (item.page - 1) * from + (item.rowIndex || 0);
      item.page = Math.floor(index / to) + 1;
    }
  }

  // 获取当前激活页码
  function getActivePage() {
    const el = document.querySelector(S.pageActive);
    return el ? parseInt(el.innerText.trim(), 10) : 1;
  }

  function checkStopped() {
    if (state.stopped) throw new Error('已停止；下载断点已保留，可再次开始继续');
  }

  function signature() {
    return JSON.stringify(getRows().map(row => {
      const r = parseRow(row);
      return [r.fileId, r.name, r.time];
    }));
  }

  async function waitRowsStable(timeout = 15000, previous = null, target = null) {
    let last = null, stableSince = 0;
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      checkStopped();
      const sig = signature();
      if ((target === null || getActivePage() === target) &&
          (previous === null || sig !== previous) && getRows().length > 0) {
        if (sig !== last) { last = sig; stableSince = performance.now(); }
        else if (performance.now() - stableSince >= 600) return getRows().length;
      } else { last = null; }
      await sleep(150);
    }
    throw new Error('列表加载超时，请确认网络、登录状态及页面是否有录制');
  }

  function findDirectionBtn(direction) {
    return [...document.querySelectorAll(S.pageButton)].find(b =>
      !b.disabled && b.getAttribute('aria-disabled') !== 'true' &&
      !/disabled/i.test(b.className) &&
      (b.querySelector('i')?.getAttribute('aria-label') || '').includes(direction));
  }
  const findNextBtn = () => findDirectionBtn('arrowright');

  async function movePage(button, target) {
    const before = signature();
    button.click();
    await waitRowsStable(15000, before, target);
    return true;
  }

  async function gotoNextPage() {
    const btn = findNextBtn();
    return btn ? movePage(btn, getActivePage() + 1) : false;
  }

  async function gotoPage(target) {
    for (let steps = 0; steps < 10000; steps++) {
      checkStopped();
      const current = getActivePage();
      if (current === target) return true;
      const direct = [...document.querySelectorAll(S.pageItem)]
        .find(l => (l.innerText || '').trim() === String(target));
      const btn = direct || findDirectionBtn(current < target ? 'arrowright' : 'arrowleft');
      if (!btn) return false;
      await movePage(btn, direct ? target : current + (current < target ? 1 : -1));
    }
    throw new Error('翻页次数超出限制');
  }

  function updateBusy() {
    paintFab();
    pushLive();
  }

  /**
   * 只更新授权状态，不再操作任何界面。
   * 工作台自己会查一次 local.status；这里的结论用于兜底和快照返回。
   */
  async function refreshDirStatus() {
    try {
      const { dir } = await rpc('local.status');
      state.localGranted = !!dir?.granted;
      state.localKnown = !!dir;
      state.localName = dir?.name || '';
    } catch (e) {
      state.localGranted = false;
      state.localKnown = false;
    }
    return { granted: state.localGranted, name: state.localName, known: state.localKnown };
  }


  /**
   * 待核对课程：上次点了导出但没确认下载结果的记录。
   * 这类课程不能重复点（可能已经下过），但一直卡着就永远导不出来，
   * 所以要能把它们列给用户看，由用户确认后一次性放行。
   */
  async function refreshPending(force = false) {
    if (!force && Date.now() - (state.pendingAt || 0) < 10000) return state.pendingList;
    try {
      const { pending } = await rpc('journal.pending');
      state.pendingList = (pending || [])
        .filter(item => item.scope === 'own')
        .map(item => ({ key: item.key, fileId: item.fileId, kind: item.kind }));
      state.pendingAt = Date.now();
    } catch (e) { log('读取待核对列表失败', e); }
    return state.pendingList;
  }

  // ============================================================
  // 1. 采集清单
  // ============================================================
  async function collect() {
    if (state.collecting || state.exporting) return { started: false, error: '任务正在运行，请先停止' };
    state.collecting = true;
    state.stopped = false;
    updateBusy();
    setLive({ phase: 'collecting', message: '正在准备采集…', total: 0, done: 0, failed: 0, active: 0, percent: 0 });
    const seen = new Set();
    state.selected.clear();
    state.collectionPageSize = 30;
    state.collected = [];

    // 终态不在这里直接推：必须先清掉 state.collecting，否则工作台收到 done 立刻拉快照，
    // 会读回 busy:true 并永久锁在"任务运行中"（筛选、再次采集全被挡住）。
    let outcome = null;
    try {
      await rpc('authorize');
      setLive({ message: '设置每页 ' + state.collectionPageSize + ' 条…' });
      const ok = await setPageSize(state.collectionPageSize);
      if (!ok) throw new Error('无法设置每页条数');

      // 回到第1页开始采集
      if (!(await gotoPage(1))) throw new Error('无法返回第 1 页');
      await waitRowsStable();
      let page = getActivePage();

      while (true) {
        checkStopped();
        await rpc('authorize');
        const rows = getRows();
        rows.forEach((row, idx) => {
          const info = parseRow(row);
          if (!info.fileId) throw new Error("录制缺少唯一标识，已停止采集以避免漏项");
          if (!seen.has(info.fileId)) {
            seen.add(info.fileId);
            // 已验证过的课程不再默认勾选，避免隔天打开时被全选重复导出。
            if (!state.exportedSet.has(info.fileId) && !state.verifiedSet.has(info.fileId + '|' + info.type)) state.selected.add(info.fileId);
            state.collected.push({ ...info, page, rowIndex: idx });
          }
        });
        scheduleDraft();
        setLive({
          phase: 'collecting',
          message: `已采集 ${state.collected.length} 项，正在读取第 ${page} 页…`,
          done: state.collected.length,
          total: state.collected.length,
        }, { throttle: 300 });

        const next = findNextBtn();
        if (!next) break;
        const moved = await gotoNextPage();
        if (!moved) throw new Error('翻页失败，采集未完成');
        page++;
      }

      // 采集完成，回到第1页
      if (!(await gotoPage(1))) throw new Error('无法返回第 1 页');
      // v1.8.14：采集完不再自动勾选整批（同一语义：筛类目 ≠ 替人选）。
      // 清空上一轮的勾选，让用户按自己的需要勾。
      state.selected.clear();
      outcome = {
        phase: 'done',
        message: `采集完成：共 ${state.collected.length} 项（请勾选要导出的课程）`,
        total: state.collected.length,
        done: state.collected.length,
        percent: 100,
      };
      // 采集完把工作台推到前台：接下来在网页里搜索、勾选、导出。
      // 优先就地展开面板（录制页保持前台，导出不会被浏览器冻结）。
      // 采集完不再自动把工作台拍在页面上（那会挡住录制页）。
      // 改成在贴边把手上挂个角标，用户想看时自己点开。
      if (globalThis.TMeetPanel?.setBadge) {
        globalThis.TMeetPanel.setBadge(`${state.collected.length} 项`);
      } else {
        void openBatch();
      }
      return { started: true, count: state.collected.length };
    } catch (e) {
      log('采集失败', e);
      outcome = { phase: 'error', message: '采集失败：' + (e.message || e) };
      throw e;
    } finally {
      try { await saveDraft(); } catch (e) { log('保存进度失败', e); }
      state.collecting = false;
      updateBusy();
      // 顺序很关键：标志先落地，再报终态。反过来会让工作台读到"还在跑"的快照。
      if (outcome) setLive(outcome);
    }
  }

  // ============================================================
  // 2. 清单筛选 + 勾选（界面在工作台 batch.html，这里只算数据）
  // ============================================================
  function filteredItems() {
    const { type, keyword } = state.filter;
    const kw = keyword.trim().toLowerCase();
    // v1.8.6：按"文件大小"列区分——没大小=纯逐字稿，有 MB 数字=含视频。
    // 逐字稿：所有行都能导（带视频的行也有逐字稿）；视频：只显示有大小的行。
    return state.collected.filter((c) => {
      if (type === 'video' && !c.hasVideo) return false;
      if (kw && !((c.name || '').toLowerCase().includes(kw) || String(c.meetingId || '').includes(kw))) return false;
      return true;
    });
  }

  function isExported(item) {
    return state.exportedSet.has(item.fileId) || state.verifiedSet.has(item.fileId + '|' + item.type);
  }

  /**
   * 当前状态快照。工作台每次操作后都用它重绘，
   * 保证"清单 / 勾选 / 已下载 / 进度"只有这里一份真相。
   */
  function snapshot() {
    return {
      ok: true,
      collected: state.collected,
      filtered: filteredItems().map(c => c.fileId),
      selected: [...state.selected],
      exported: state.collected.filter(isExported).map(c => c.fileId + '|' + c.type),
      filter: { ...state.filter },
      licenseActive: state.licenseActive,
      busy: state.collecting || state.exporting,
      live: { ...live },
      pending: state.pendingList.map(item => ({ fileId: item.fileId, kind: item.kind })),
      dir: { granted: state.localGranted, name: state.localName, checked: state.localKnown },
    };
  }

  /** 统一的勾选入口：工作台只说"想怎么选"，怎么算由这里决定。 */
  function applySelect({ mode, id, selected } = {}) {
    const visible = filteredItems();
    if (mode === 'set' && id) {
      if (selected) state.selected.add(id); else state.selected.delete(id);
    } else if (mode === 'all') {
      for (const c of visible) if (!isExported(c)) state.selected.add(c.fileId);
    } else if (mode === 'none') {
      state.selected.clear();
    } else if (mode === 'invert') {
      for (const c of visible) {
        if (state.selected.has(c.fileId)) state.selected.delete(c.fileId);
        else if (!isExported(c)) state.selected.add(c.fileId);
      }
    }
    // 勾选是低频操作，直接落盘：用户可能勾完立刻刷新录制页，落在防抖窗口里就白选了。
    void saveDraft().catch(log);
    const skipped = mode === 'all' ? visible.filter(isExported).length : 0;
    return { ...snapshot(), skipped };
  }

  // 获取勾选的文件
  function getSelected() {
    return state.collected.filter(c => state.selected.has(c.fileId));
  }


  // ============================================================
  // 3. 导出选中项
  // ============================================================
  async function rpc(op, extra = {}) {
    const startedAt = performance.now();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'tmeet', op, ...extra });
    } catch (e) {
      // 扩展被重新加载（⟳）或更新时，本页的扩展上下文当场作废，
      // 后续所有消息都会抛 "Extension context invalidated."。
      // 直接把英文原文甩给用户没有意义，翻成一句能照做的话。
      const raw = e?.message || String(e);
      if (/Extension context invalidated|Could not establish connection|message port closed/i.test(raw)) {
        const friendly = new Error('扩展刚刚被重新加载，页面里的插件已失效。请按 F5 刷新本页后继续（已导出的文件不受影响）');
        friendly.contextInvalidated = true;
        throw friendly;
      }
      throw e;
    }
    if (['acquire', 'prepare', 'journal.clear-pending', 'release'].includes(op) || !response?.ok) console.info('[CS][导出调试] ' + JSON.stringify({ step: 'rpc.' + op, ms: Math.round(performance.now() - startedAt), ok: !!response?.ok, error: response?.error }));
    if (!response?.ok) throw new Error(response?.error || '后台无响应，请重新加载扩展和页面');
    return response;
  }

  const ownExporter = TMeetOwnExport.create({ rpc, checkStopped, sleep });

  /**
   * 录制页必须在前台，站点菜单才点得开。
   *
   * 腾讯会议的「更多」菜单是 **hover 才渲染**的（DOM 里平时根本不存在「导出」这项）。
   * 而页面处于隐藏状态（标签页在后台 / 浏览器窗口最小化）时：
   *   1) hover 根本不触发 → 菜单不弹 → 找不到「导出」；
   *   2) 后台标签页还会被 Chrome 节流、甚至 Memory Saver 冻结。
   * 所以这里把"页面不可见"从"直接失败"改成"自动处理"：
   *   - 导出开始时：让后台把录制页切到前台（后台拿得到 sender.tab.id）；
   *   - 导出中途被切走：挂起等待，切回来自动继续，不报错也不丢进度。
   */
  function isVisible() {
    // 拿不到 visibilityState（某些测试环境）时按"可见"处理：
    // 宁可少一次保护，也不能平白把用户的导出挂起。
    const state = document.visibilityState;
    return !state || state === 'visible';
  }

  /** 等页面重新可见；返回 false 表示超时放弃。 */
  function waitForVisible(timeoutMs = 10 * 60 * 1000, label = '导出') {
    if (isVisible()) return Promise.resolve(true);
    setLive({
      phase: 'exporting',
      message: `${label}已暂停：录制页不在前台（窗口最小化也算），切回「我的录制」就会自动继续`,
    });
    return new Promise((resolve) => {
      const started = Date.now();
      let settled = false;
      const cleanup = () => document.removeEventListener('visibilitychange', onChange);
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ok);
      };
      const onChange = () => {
        if (!isVisible()) return;
        setLive({ phase: 'exporting', message: '录制页已回到前台，继续导出…' });
        finish(true);
      };
      // 用 setTimeout 递归而不是 setInterval：环境更宽容（某些测试桩只有 setTimeout）。
      const poll = () => {
        if (settled) return;
        if (isVisible()) { onChange(); return; }
        if (Date.now() - started > timeoutMs) { finish(false); return; }
        setTimeout(poll, 500);
      };
      document.addEventListener('visibilitychange', onChange);
      setTimeout(poll, 500);
    });
  }

  /** 把录制页切到前台并聚焦窗口（后台来做，content script 没有 chrome.tabs）。 */
  async function focusRecordingTab() {
    try {
      await rpc('focus-recording-tab');
    } catch (e) {
      log('切前台失败', e);
    }
  }

  /**
   * v1.9.0 逐字稿导出：清单页的"导出"只有视频，逐字稿必须进详情页拿。
   * 结构：生产者按页顺序「点标题开详情页」，把已打开的标签丢进队列；
   *       3 个消费者并行「抓取→存txt→关标签」。打开串行（清单页只有一个，不能同时翻），
   *       抓取并行——长批量的时间主要花在抓取和等页面加载，这里能快 2~3 倍。
   * 视频链路（exportSelected）一行不动。
   */
  const TRANSCRIPT_CONCURRENCY = 3; // 同时抓取的详情页数量；开太多 Chrome 会卡、也可能被限流

  async function exportTranscriptsViaDetail() {
    if (state.exporting || state.collecting) return { started: false, error: '任务正在运行，请先停止' };
    const targets = getSelected();
    if (!targets.length) return { started: false, error: '还没有勾选任何课程' };
    const total = targets.length;
    let done = 0, failed = 0, lastError = '';
    state.exporting = true;
    state.stopped = false;
    updateBusy();
    const paint = (msg, percent) => setLive({
      phase: 'exporting', message: msg, total, done, failed, active: 0,
      percent: percent === undefined ? (total ? Math.round(((done + failed) / total) * 100) : 0) : percent,
    }, { throttle: 200 });
    paint(`准备导出 ${total} 项逐字稿（同时处理 ${TRANSCRIPT_CONCURRENCY} 个）…`, 0);

    // 同一场录制在列表里常有两行（视频行 + 转写行），会议号相同 ⇒ 逐字稿只有一份，去重。
    const seen = new Set();
    const unique = targets.filter((t) => {
      const key = t.meetingId || ('name:' + t.name);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    // 待抓取队列（元素：{detail, target}），生产/消费之间共享
    const queue = [];
    let producing = true; // 生产者还在开详情页
    let produceError = null;

    // 消费者：并行抓取
    async function consume() {
      while (true) {
        if (state.stopped) return;
        const job = queue.shift();
        if (!job) {
          if (!producing) return;      // 生产结束且队列空 ⇒ 收工
          await sleep(200);            // 队列暂时空，等生产者
          continue;
        }
        const { detail, target } = job;
        try {
          paint(`正在读取逐字稿：${target.name}（完成 ${done + failed}/${unique.length}）`);
          const captured = await rpc('detail.capture', { tabId: detail.id });
          if (!captured?.ok) throw new Error(captured?.error || '读取逐字稿失败');
          await rpc('detail.save', { content: captured.text, name: target.name, meetingId: target.meetingId });
          state.exportedSet.add(target.fileId);
          done++;
          await saveDraft();
        } catch (e) {
          failed++;
          lastError = e?.message || String(e);
          log('逐字稿失败', target.name, e);
        } finally {
          await rpc('detail.closeTab', { tabId: detail.id }).catch(() => {});
          paint(`已完成 ${done + failed}/${unique.length}（成功 ${done}，失败 ${failed}）`);
        }
      }
    }

    // 生产者：按页分组，逐页翻、逐行点标题开详情页，打开即入队
    async function produce() {
      const byPage = new Map();
      for (const t of unique) {
        const p = t.page || 1;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p).push(t);
      }
      const pages = [...byPage.keys()].sort((a, b) => a - b);
      for (const page of pages) {
        checkStopped();
        if (!(await gotoPage(page))) { failed += byPage.get(page).length; lastError = `第 ${page} 页翻页失败`; continue; }
        await waitRowsStable();
        for (const target of byPage.get(page)) {
          checkStopped();
          // 控制同时打开的详情页数量，避免一口气开上百个标签把浏览器拖死
          while (queue.length >= TRANSCRIPT_CONCURRENCY * 2 && !state.stopped) await sleep(150);
          const row = getRows().find((r) => parseRow(r).fileId === target.fileId);
          if (!row) { failed++; lastError = '未找到该行：' + target.name; log('逐字稿：未找到行', target.name); continue; }
          paint(`打开详情页：${target.name}`);
          const before = await rpc('detail.listTabs').then((r) => r.tabs || []).catch(() => []);
          const beforeIds = new Set(before.map((t) => t.id));
          (row.querySelector(S.recordTitle) || row).click();
          let detail = null;
          for (let w = 0; w < 50; w++) { // 等新详情页出现，最多 15 秒
            checkStopped();
            await sleep(300);
            const now = await rpc('detail.listTabs').then((r) => r.tabs || []).catch(() => []);
            detail = now.find((t) => !beforeIds.has(t.id));
            if (detail) break;
          }
          if (!detail) { failed++; lastError = '未检测到详情页：' + target.name; log('逐字稿：未检测到详情页', target.name); continue; }
          queue.push({ detail, target });
        }
      }
      producing = false;
    }

    try {
      const prod = produce().catch((e) => { produceError = e; producing = false; });
      const consumers = Array.from({ length: Math.min(TRANSCRIPT_CONCURRENCY, unique.length) }, () => consume());
      await Promise.all([prod, ...consumers]);
      if (produceError) throw produceError;
      const tip = failed && lastError ? `（最后错误：${lastError}）` : '';
      setLive({
        phase: failed ? 'error' : 'done',
        message: `逐字稿导出结束：成功 ${done}，失败 ${failed}，共 ${unique.length} 项${tip}`,
        total: unique.length, done, failed, active: 0, percent: 100,
      });
    } catch (e) {
      log('逐字稿导出中断', e);
      setLive({ phase: 'error', message: `${e.message}；已成功 ${done} 项`, total: unique.length, done, failed, active: 0, percent: 100 });
    } finally {
      // 停止/出错时：关掉已打开但没来得及抓的详情页，别在浏览器里留一堆标签。
      for (const job of queue.splice(0)) {
        await rpc('detail.closeTab', { tabId: job.detail.id }).catch(() => {});
      }
      state.exporting = false;
      updateBusy();
    }
    return { started: true, total: unique.length, done, failed };
  }

  async function exportSelected() {
    if (state.exporting || state.collecting) return { started: false, error: '任务正在运行，请先停止' };
    const targets = getSelected();
    if (!targets.length) return { started: false, error: '还没有勾选任何课程' };
    const total = targets.length;
    let done = 0, failed = 0, lease = false;
    // 同 collect()：终态要等 state.exporting 清掉之后再推，否则工作台会读回 busy:true 卡死。
    let outcome = null, failure = '', unclicked = null;
    const active = new Map();
    const transfers = new Map();
    // 进度按"已处理文件个数"推进：视频大小差几十倍，按字节算会长时间停在 1%。
    function paint(text, forcePercent, phase = 'exporting') {
      const percent = forcePercent === undefined
        ? (total ? Math.min(100, Math.round(((done + failed) / total) * 100)) : 0)
        : forcePercent;
      setLive({ phase, message: text, total, done, failed, active: active.size, percent }, { throttle: 200 });
    }
    const show = () => paint(`已完成 ${done + failed}/${total}（成功 ${done}，失败 ${failed}，传输中 ${active.size}）`);
    // 先给一个可见状态：后面还要联网校时、建租约、恢复每页条数，加起来可能好几秒。
    // 这期间界面必须显示"在准备"，否则用户会以为点了没反应。
    setLive({ phase: 'verifying', message: `准备导出 ${total} 项：正在确认授权…`, total, done: 0, failed: 0, active: 0, percent: 0 });
    state.exporting = true;
    state.stopped = false;
    updateBusy();
    // ── 录制页必须在前台，否则站点菜单点不开 ────────────────────
    // 工作台可能在独立页/别的窗口里，录制页就是后台页：hover 不触发、
    // 菜单不渲染、还会被 Chrome 冻结。这里直接把录制页拉到前台。
    if (!isVisible()) {
      setLive({ phase: 'verifying', message: '正在把录制页切到前台（站点菜单需要页面在前台才能点开）…', total, done: 0, failed: 0, active: 0, percent: 0 });
      await focusRecordingTab();
      const ok = await waitForVisible(30000, '准备导出');
      if (!ok) {
        setLive({ phase: 'error', message: '录制页始终没有回到前台，无法导出。请切到「我的录制」标签页后重试', total, done: 0, failed: 0, active: 0, percent: 0 });
        state.exporting = false;
        updateBusy();
        return { started: false, error: '录制页不在前台，请切到「我的录制」标签页后重试' };
      }
    }
    setLive({ phase: 'verifying', message: '正在核对已下载记录…', total, done: 0, failed: 0, active: 0, percent: 0 });
    const config = { ...CONFIG };
    const limit = Math.max(1, Math.min(8, Math.floor(Number(config.maxConcurrent)) || 3));
    async function refresh() {
      checkStopped();
      if (!active.size) return;
      const { items } = await rpc('status', { ids: [...active.keys()] });
      let changed = false;
      for (const [id, target] of active) {
        const item = items.find(x => x.id === id);
        if (item?.paused) throw new Error('下载已暂停，请点击继续导出');
        if (item?.state === 'in_progress') {
          const previous = transfers.get(id);
          if (!previous || previous.bytes !== item.bytesReceived) transfers.set(id, { bytes: item.bytesReceived, changed: performance.now() });
          else if (performance.now() - previous.changed > 10 * 60000) throw new Error('传输10分钟无进度，请检查网络；断点已保留');
          continue;
        }
        active.delete(id);
        const { result } = await rpc('journal.check', { scope: 'own', id: target.fileId, kind: target.type, target });
        if (item?.state === 'complete' && result.state === 'verified') {
          done++; state.exportedSet.add(target.fileId);
          state.verifiedSet.add(target.fileId + '|' + target.type);
          state.selected.delete(target.fileId); changed = true;
        } else {
          failed++; target.exportError = result.results?.map(r => r.reason).join('；') || '下载未通过本地校验';
          if (item?.state === 'complete') throw new Error(target.name + '：' + target.exportError + '，已停止后续导出，请核对浏览器下载列表');
          if (item?.state === 'interrupted') throw new Error('下载中断：' + (item.error || '请检查网络与服务器状态') + '；已保留断点，请稍后继续');
        }
      }
      if (changed) await saveExported();
      show();
    }
    try {
      await saveDraft();
      await rpc('acquire'); lease = true;
      const ordered = [...targets].sort((a, b) => a.page - b.page);
      // 站点改了每页条数时，采集时记的页码就对不上了。这里按绝对序号换算，
      // 换算结果只存在本次任务里，不去改清单本身。
      const pageMap = new Map();
      const pageSize = state.collectionPageSize;
      if (!(await setPageSize(pageSize))) {
        // 每页条数设置失败不该整批停：那是站点下拉框的问题，跟用户操作无关。
        // 能读出当前条数就换算页码继续导出，读不出才给一句能照做的提示。
        const current = readPageSize();
        if (!current) {
          throw new Error(`无法把每页条数恢复到 ${pageSize}（读不到当前值）。请在录制页把每页条数改成 ${pageSize} 后重试`);
        }
        for (const item of ordered) {
          const index = (item.page - 1) * pageSize + (item.rowIndex || 0);
          pageMap.set(item.fileId, Math.floor(index / current) + 1);
        }
        ordered.sort((a, b) => pageMap.get(a.fileId) - pageMap.get(b.fileId));
        log('每页条数与采集时不一致，已按绝对序号换算页码', pageSize, '→', current);
        setLive({ phase: 'verifying', message: `每页条数已变为 ${current} 条，正在换算页码继续导出…`, total, done: 0, failed: 0, active: 0, percent: 0 });
      }

      // 阶段 1：只校验，不点任何导出按钮。
      // 大视频重复下一次代价极高，所以先把"已存在的认领掉、能续传的接上"，剩下的才导出。
      const pending = [];
      for (let i = 0; i < ordered.length; i++) {
        const target = ordered[i];
        checkStopped();
        target.uniqueTitle = state.collected.filter(t => t.name === target.name && t.type === target.type).length === 1;
        paint(`正在核对已下载记录 ${i + 1}/${ordered.length}：${target.name}`.slice(0, 90), undefined, 'verifying');
        const { result } = await rpc('journal.check', { scope: 'own', id: target.fileId, kind: target.type, target });
        if (result.state === 'verified') {
          done++;
          state.exportedSet.add(target.fileId);
          state.verifiedSet.add(target.fileId + '|' + target.type);
          state.selected.delete(target.fileId);
          await saveDraft();
          show();
          continue;
        }
        if (result.state === 'needs-folder') throw new Error(result.results?.map(r => r.reason).join('；') || '需要重新确认下载文件夹（已不再使用本地校验，请刷新页面后重试）');
        // 上次点了但没确认：跳过这一项，其余继续，不整批停。
        if (result.state === 'uncertain') {
          failed++;
          target.exportError = '上次点击后下载结果不明，已跳过；请到“全量校验 / 续导”核对';
          await saveDraft();
          show();
          continue;
        }
        pending.push({ target, result });
      }
      await saveDraft();
      // 全被跳过时必须说清楚"为什么一项都没下"，否则用户只会觉得导出又没跑。
      const skipped = failed
        ? `，${failed} 项因上次结果不明被跳过（在列表里点「允许重试」可解除）`
        : '';
      if (pending.length) {
        paint(`校验完成：${done} 项本机已存在无需重复，${pending.length} 项开始导出${skipped}`);
      } else if (failed) {
        setLive({
          phase: 'error',
          message: `一项都没导出：${failed} 项全部因"上次点击后结果不明"被跳过。请在列表里点「允许重试」或「全部允许重试」后再试`,
          total, done, failed, active: 0, percent: 100,
        });
      } else {
        paint(`校验完成：全部 ${total} 项都已在本机通过校验，无需重复下载`, 100, 'done');
      }

      // 阶段 2：只处理校验没过或需要续传的项。
      for (const entry of pending) {
        const target = entry.target;
        let result = entry.result;
        checkStopped();
        // 页面被切走（切窗口/最小化）时挂起等待：站点菜单需要页面在前台才渲染，
        // 否则 hover 不触发 → 菜单不弹 → 找不到「导出」，整批卡住。
        if (!isVisible()) {
          const back = await waitForVisible();
          if (!back) throw new Error('录制页长时间没有回到前台，导出已暂停；请切到「我的录制」页面后重试');
          checkStopped();
        }
        while (active.size >= limit) { await refresh(); if (active.size >= limit) await sleep(500); }
        if (['running', 'paused'].includes(result.state) || result.results?.some(r => r.resumable)) {
          result = (await rpc('journal.check', { scope: 'own', id: target.fileId, kind: target.type, target, resume: true })).result;
          for (const id of result.ids || []) active.set(id, target);
          await refresh(); continue;
        }
        await rpc('authorize');
        checkStopped();
        while (active.size >= limit) { await refresh(); if (active.size >= limit) await sleep(500); }
        const pageNo = pageMap.get(target.fileId) || target.page;
        if (!(await gotoPage(pageNo))) throw new Error('无法导航到第 ' + pageNo + ' 页');
        await waitRowsStable();
        const row = getRows().find(r => parseRow(r).fileId === target.fileId);
        if (!row) {
          // 列表在操作期间被服务端重排/筛选过：明确记在课程上，不能让用户只看到"失败 N"。
          failed++;
          target.exportError = `第 ${pageNo} 页未找到该课程（列表可能已变化），请重新采集`;
          await saveDraft(); show(); continue;
        }
        // 在点击之前记录下载快照，防止小文件瞬间下载完导致漏报。
        const { ticket } = await rpc('prepare', { target: { name: target.name, fileId: target.fileId, type: target.type } });
        let clicked = false;
        try { clicked = await triggerExport(row, target, ticket); }
        catch (e) {
          log('触发导出异常', e);
          target.exportError = e.message;
          if (!e.exportRequested) unclicked = target;
          throw e;
        }
        if (!clicked) {
          // 根本没点下去，不能记成"已点击但结果不明"：留着 pending 会让这门课以后每次导出都被跳过。
          unclicked = target;
          target.exportError = '更多菜单未找到可点击的“导出”，本次没有发送导出点击' +
            (document.visibilityState === 'hidden' ? '（录制页当时不在前台，站点菜单不会弹出：请保持「我的录制」页面在前台再导出）' : '');
          throw new Error(target.exportError + '；请查看录制页当前菜单');
        }
        let download = null;
        const deadline = performance.now() + 90000;
        while (performance.now() < deadline) {
          checkStopped();
          const result = await rpc('detect', { ticket });
          if (result.items.length > 1) throw new Error('同时出现多个下载，无法确定对应关系；请核对浏览器下载列表');
          if (result.items.length === 1) { download = result.items[0]; break; }
          await sleep(300);
        }
        // 点击后不自动重试，避免服务端延迟导致重复下载。
        if (!download) throw new Error('90 秒内未检测到可识别的下载。请检查下载权限、导出弹窗和浏览器下载列表，再手工重试');
        await ownExporter.closePrevious();
        active.set(download.id, target);
        await refresh();
        await sleep(Math.max(2500, Number(config.clickDelay) || 2500));
      }
      let lastProgress = performance.now();
      while (active.size) { const count = active.size; await refresh(); if (active.size < count) lastProgress = performance.now(); if (performance.now() - lastProgress > 30 * 60000) throw new Error('下载等待超过30分钟，已保存进度，请检查网络后继续'); if (active.size) await sleep(500); }
      outcome = !pending.length && failed
        ? { phase: 'error', message: `未发送新下载：${failed} 项因上次点击后结果不明被跳过，请先核对文件并点「允许重试」`, total, done, failed, active: 0, percent: 100 }
        : { phase: 'done', message: `任务结束：成功 ${done}，失败 ${failed}，共 ${total} 项`, total, done, failed, active: 0, percent: 100 };
    } catch (e) {
      log('导出停止', e);
      state.stopped = true;
      // 不向上抛：错误已经通过 live 推给工作台，调用方再用 try/catch 包一层只会重复报告。
      failure = e.message;
      outcome = {
        phase: 'error',
        message: `${e.message}；已确认完成 ${done}，失败 ${failed}，待核对 ${active.size}`,
        total, done, failed, active: active.size,
      };
    } finally {
      if (lease) { try { if (state.stopped) await rpc('stop-batch'); await rpc('release'); } catch (e) { log(e); } }
      // 后台禁止运行时解除待核对，必须在释放租约后撤回确定未点击的记录。
      // 已点击菜单/确认按钮但结果未知时保留记录，避免下一次重复下载。
      if (unclicked) {
        try { await rpc('journal.clear-pending', { scope: 'own', fileId: unclicked.fileId, kind: unclicked.type }); }
        catch (e) {
          const why = e?.contextInvalidated
            ? '扩展刚被重新加载，页面里的插件已失效（请按 F5 刷新本页）'
            : (e?.message || String(e));
          if (outcome) outcome.message += '；待核对记录撤回失败：' + why;
          log('撤回待核对记录失败', e);
        }
      }
      try { await saveDraft(); } catch (e) { log('保存进度失败', e); }
      state.exporting = false;
      updateBusy();
      // 先清 busy 再报终态，理由同 collect()。
      if (outcome) setLive(outcome);
      // 这一批可能新产生/解除了待核对记录，重新拉一次列表给工作台。
      void refreshPending(true).then(() => pushLive());
    }
    return failure ? { started: true, total, error: failure } : { started: true, total };
  }

  // 关闭所有残留的 hover 菜单（对每个更多图标派发 mouseout/mouseleave）
  function closeAllMenus() {
    document.querySelectorAll(S.recordMore).forEach((m) => {
      const r = m.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.x, clientY: r.y };
      m.dispatchEvent(new MouseEvent('mouseout', o));
      m.dispatchEvent(new MouseEvent('mouseleave', o));
    });
  }

  // hover 更多 → 点导出
  async function triggerExport(row, target, ticket) {
    checkStopped();
    // 菜单是 hover 渲染的，页面不可见时菜单压根不出现 —— 先确保可见再点。
    if (!isVisible()) {
      const back = await waitForVisible();
      if (!back) throw new Error('录制页不在前台，无法打开导出菜单；请切到「我的录制」页面后重试');
      checkStopped();
    }
    await ownExporter.closePrevious();
    if (parseRow(row).fileId !== target.fileId) throw new Error('课程行已变化，停止导出以避免下载错课');
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(400);

    const more =
      row.querySelector(S.recordMoreExact) ||
      row.querySelector(S.recordMoreLoose) ||
      row.querySelector(S.recordMore);
    if (!more) throw new Error('未找到当前课程的“更多”图标，本次没有发送导出点击');
    console.info('[CS][导出调试] ' + JSON.stringify({ step: 'more.found', kind: target.type, page: target.page }));
    setLive({ phase: 'exporting', message: '正在打开导出菜单：' + target.name });

    const menuVisible = el => {
      if (!el.isConnected) return false;
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && style.opacity !== '0';
    };

    let lastOldVisible = new Set();
    const menuDeadline = performance.now() + 5000;
    // hover 触发菜单（重试2次）
    for (let attempt = 0; attempt < 2; attempt++) {
      checkStopped();
      if (performance.now() >= menuDeadline) break;
      setLive({ phase: 'exporting', message: `正在打开导出菜单（第 ${attempt + 1}/2 次）：${target.name}` });
      // 每次重试前先关闭所有残留菜单，避免点到上一行的旧菜单
      closeAllMenus();
      await sleep(300);
      checkStopped();
      const oldVisible = new Set([...document.querySelectorAll(S.menuOption)].filter(li => {
        return menuVisible(li) && (li.innerText || '').trim() === TMeetSite.text.exportMenu;
      }));
      lastOldVisible = oldVisible;

      const rect = more.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      };
      more.dispatchEvent(new MouseEvent('mouseover', opts));
      more.dispatchEvent(new MouseEvent('mouseenter', opts));
      more.dispatchEvent(new MouseEvent('mousemove', opts));

      // 只接受唯一新出现的导出菜单，避免按坐标猜测而点击错误文件。
      let item = null;
      for (let i = 0; i < 10 && performance.now() < menuDeadline; i++) {
        await sleep(200);
        checkStopped();
        const candidates = [...document.querySelectorAll(S.menuOption)].filter(
          (li) => {
            return !oldVisible.has(li) && menuVisible(li) && (li.innerText || '').trim() === TMeetSite.text.exportMenu;
          }
        );
        if (candidates.length === 1) {
          item = candidates[0];
          break;
        }
      }
      if (item) {
        checkStopped();
        setLive({ phase: 'exporting', message: '已找到导出菜单，正在确认激活有效期：' + target.name });
        await rpc('authorize');
        // 授权可能等待联网校时。用户期间点了停止，不能再发送新的导出点击。
        checkStopped();
        if (parseRow(row).fileId !== target.fileId) throw new Error('课程行已变化，停止导出以避免下载错课');
        if (!menuVisible(item)) throw new Error('授权等待期间导出菜单已关闭，本次没有发送导出点击');
        console.info('[CS][导出调试] ' + JSON.stringify({ step: 'menu.click', kind: target.type }));
        item.click();
        setLive({ phase: 'exporting', message: '已点击导出菜单，正在确认弹窗或等待下载：' + target.name });
        try { await ownExporter.submit(target, ticket, state.collected); }
        catch (e) { e.exportRequested = true; throw e; }
        return true;
      }
    }
    // hover 两次都找不到“导出”：补一次“点击更多图标”，兼容站点把菜单触发方式改成 click 的情况。
    // 只点当前行的更多图标（fileId 已校验），不做宽泛坐标猜测，不会点到别的课程。
    {
      closeAllMenus();
      await sleep(300);
      try { more.click(); } catch (e) { log('点击更多图标异常', e); }
      for (let i = 0; i < 8; i++) {
        await sleep(200);
        const tapped = [...document.querySelectorAll(S.menuOption)].filter(
          (li) => menuVisible(li) && (li.innerText || '').trim() === TMeetSite.text.exportMenu
        );
        if (tapped.length === 1) {
          const item = tapped[0];
          checkStopped();
          await rpc('authorize');
          if (parseRow(row).fileId !== target.fileId) throw new Error('课程行已变化，停止导出以避免下载错课');
          if (!menuVisible(item)) throw new Error('授权等待期间导出菜单已关闭，本次没有发送导出点击');
          console.info('[CS][导出调试] ' + JSON.stringify({ step: 'menu.click', via: 'tap', kind: target.type }));
          item.click();
          setLive({ phase: 'exporting', message: '已点击导出菜单，正在确认弹窗或等待下载：' + target.name });
          try { await ownExporter.submit(target, ticket, state.collected); }
          catch (e) { e.exportRequested = true; throw e; }
          return true;
        }
      }
    }
    // 仅收集控件结构，不记录页面正文、URL、下载签名或账号信息。
    // 把结果带回现有错误提示，避免调试连接不可用时只能重复看到同一条泛化报错。
    const matched = [...document.querySelectorAll(S.menuOption)]
      .filter(el => (el.textContent || '').trim() === TMeetSite.text.exportMenu);
    const visible = matched.filter(menuVisible);
    const describe = el => ({
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList].slice(0, 6).map(v => v.slice(0, 80)),
      parentTag: el.parentElement?.tagName.toLowerCase() || '',
      parentClasses: el.parentElement ? [...el.parentElement.classList].slice(0, 6).map(v => v.slice(0, 80)) : [],
      visible: menuVisible(el),
    });
    const other = [...document.querySelectorAll(S.menuDiagnostic)]
      .filter(el => (el.textContent || '').trim() === TMeetSite.text.exportMenu &&
        ![...el.children].some(child => (child.textContent || '').trim() === TMeetSite.text.exportMenu));
    // 关键补齐：把"当前到底显示了哪些菜单项"也带回来，一次就能区分两种根因——
    //   a) 菜单根本没弹出（visibleMenu 为空，且 matched/visible 都是 0）→ 是 hover 没生效；
    //   b) 弹出了但文案/容器变了（visibleMenu 里能看到新文案，例如"下载"取代"导出"）→ 改选择器。
    const menuScope = 'ul.met-list--option, .met-tooltip, [role="menu"], ul[class*="list"], ul[class*="menu"], ul[class*="option"], [class*="dropdown"], [class*="Dropdown"], [class*="popup"], [class*="Popup"]';
    const visibleMenu = [...document.querySelectorAll(menuScope + ' li, ' + menuScope + ' [role="menuitem"]')]
      .filter(menuVisible)
      .filter(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .slice(0, 24)
      .map(el => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20),
        tag: el.tagName.toLowerCase(),
        cls: [...el.classList].slice(0, 4).join('.'),
      }));
    const moreDesc = {
      tag: more.tagName.toLowerCase(),
      cls: [...more.classList].join(' '),
      aria: more.getAttribute('aria-label') || '',
    };
    const evidence = {
      step: 'menu.not-found', more: moreDesc, matched: matched.length, visible: visible.length,
      pageHidden: document.visibilityState === 'hidden',
      excludedOld: visible.filter(el => lastOldVisible.has(el)).length,
      visibleMenu, other: other.slice(0, 8).map(describe),
    };
    console.info('[CS][导出调试] ' + JSON.stringify(evidence));
    throw new Error('更多菜单未找到可点击的“导出”，本次没有发送导出点击；现场诊断：' + JSON.stringify(evidence));
  }

  // ============================================================
  // 工作台入口 + 页面上的悬浮球
  //
  // 界面全部搬到 batch.html（扩展页面）：那边能选下载文件夹、能长列表滚动，
  // 也不会被腾讯会议的样式和 z-index 影响。页面上只留一颗小球，点了就开工作台。
  // ============================================================
  async function openBatch() {
    // 面板已注入就地展开（录制页保持前台）；否则退回独立工作台标签页。
    if (globalThis.TMeetPanel) { globalThis.TMeetPanel.open(); return; }
    try { await rpc('open-batch'); } catch (e) { log('打开工作台失败', e); }
  }

  function paintFab() {
    const btn = $fab('.tmeet-fab');
    if (!btn) return;
    const badge = $fab('.tmeet-badge');
    if (!badge) return;
    const phase = live.phase;
    const busy = ['collecting', 'verifying', 'exporting'].includes(phase);
    btn.classList.toggle('busy', busy);
    btn.classList.toggle('done', phase === 'done');
    btn.classList.toggle('err', phase === 'error');
    if (busy) {
      badge.hidden = false;
      // 采集阶段还没有总数，显示已读条数；导出阶段显示百分比。
      badge.textContent = phase === 'collecting'
        ? String(live.done || 0)
        : Math.round(live.percent || 0) + '%';
      btn.title = live.message || '任务运行中…（点击打开工作台）';
      return;
    }
    badge.hidden = true;
    btn.title = (phase === 'done' || phase === 'error') && live.message
      ? live.message + '（点击打开工作台）'
      : '打开批量下载工作台';
  }

  function createFab() {
    if (document.getElementById('tmeet-batch-fab')) return;
    const host = document.createElement('div');
    host.id = 'tmeet-batch-fab';
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .tmeet-fab {
          position: relative;
          width: 48px; height: 48px;
          border: none; border-radius: 14px;
          background: linear-gradient(135deg, #1f6feb, #4a91ff);
          color: #fff;
          display: grid; place-items: center;
          font-size: 20px; line-height: 1;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(16,24,40,.22);
          transition: transform .14s ease, box-shadow .14s ease, background .14s ease;
          font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .tmeet-fab:hover { transform: translateY(-1px) scale(1.04); box-shadow: 0 8px 22px rgba(16,24,40,.28); }
        .tmeet-fab:active { transform: scale(.98); }
        .tmeet-fab.done { background: linear-gradient(135deg, #1a9c63, #43c08d); }
        .tmeet-fab.err { background: linear-gradient(135deg, #d93a3a, #ef6a6a); }
        .tmeet-badge {
          position: absolute; top: -6px; right: -6px;
          min-width: 20px; height: 20px; padding: 0 5px;
          border-radius: 999px;
          background: #17181a; color: #fff;
          font-size: 11px; font-weight: 600;
          display: grid; place-items: center;
          border: 2px solid #fff;
          font-variant-numeric: tabular-nums;
        }
        .tmeet-badge[hidden] { display: none; }
        .tmeet-fab.busy::after {
          content: ''; position: absolute; inset: -3px;
          border-radius: 17px;
          border: 2px solid rgba(31,111,235,.35);
          animation: pulse 1.6s ease-out infinite;
        }
        @keyframes pulse { 0% { opacity: .9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.22); } }
      </style>
      <button class="tmeet-fab" type="button" title="打开批量下载工作台">📥<span class="tmeet-badge" hidden></span></button>
    `;
    shadow.querySelector('.tmeet-fab').addEventListener('click', () => {
      // 面板已注入（panel.js）就地展开；没注入成功时退回打开独立工作台。
      if (globalThis.TMeetPanel) globalThis.TMeetPanel.toggle();
      else void openBatch();
    });
    document.body.appendChild(host);
    fabScope = shadow;
    paintFab();
  }

  // ============================================================
  // 与工作台的消息接口
  //
  // 工作台只描述"想干什么"，数据与状态都以这里为准：
  //   snapshot 取全量状态 / filter 改筛选 / select 改勾选 /
  //   collect 开始采集 / export 开始导出 / stop 停止 / reset 清空
  // ============================================================
  function fromUiPage(sender) {
    if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
    const url = sender.url.split('#')[0].split('?')[0];
    return UI_PAGES.some((file) => url === chrome.runtime.getURL(file));
  }

  async function allState() {
    if (!state.licenseKnown) await refreshLicense();
    await refreshPending();
    return snapshot();
  }

  function stopTask() {
    state.stopped = true;
    void rpc('stop-batch').catch(log);
  }

  function resetTask() {
    state.collected = [];
    state.selected = new Set();
    state.filter = { type: 'all', keyword: '' };
    state.exportedSet = new Set();
    setLive({ phase: 'idle', message: '', total: 0, done: 0, failed: 0, active: 0, percent: 0 });
  }

  /**
   * 导出前的硬性前置条件。
   * 必须在消息里同步判完：如果这里不通过却回了 started:true，工作台会把按钮变成
   * "导出中…"、进度条停在"正在校验"，然后永远等不到任何进度 —— 看起来就是"点了没反应"。
   */
  async function preflightExport() {
    if (state.collecting || state.exporting) return { ok: false, error: '任务正在运行，请先停止' };
    if (!state.licenseActive) await refreshLicense();
    if (!state.licenseActive) return { ok: false, error: '授权未通过' };
    if (!state.selected.size) return { ok: false, error: '还没有勾选任何课程' };
    // 勾了但全都不在清单里（清空清单后残留）也算没选
    if (!getSelected().length) return { ok: false, error: '勾选的课程已不在清单里，请重新采集' };
    // 不再要求"授权下载文件夹"：判定只看浏览器下载记录，不读文件内容。
    return { ok: true, total: getSelected().length };
  }

  /** 处理一条 tmeet.batch 指令。独立页与同页面板走同一条路径，避免两套逻辑漂移。 */
  function handleBatch(message, respond) {
    const action = message.action;
    const reply = (task) => {
      Promise.resolve().then(task).then(
        (result) => respond(result || { ok: true }),
        (error) => respond({ ok: false, error: error?.message || String(error) })
      );
      return true;
    };
    if (action === 'snapshot') return reply(() => allState());
    if (action === 'filter') return reply(async () => {
      if (typeof message.filterType === 'string' && ['all', 'video', 'transcript'].includes(message.filterType)) {
        if (message.filterType !== state.filter.type) {
          // v1.8.14：类型按钮只筛类目，绝不替用户勾选。
          // 以前这里会调 applyTypeSelection 把当前类目整批勾上，用户看到"我只是点了筛选，
          // 怎么就自动选中了"。现在勾选只由用户点复选框/全选按钮触发。
          state.filter.type = message.filterType;
          await saveDraft();
        }
      }
      if (typeof message.keyword === 'string') {
        state.filter.keyword = message.keyword;
        scheduleDraft(600);
      }
      return snapshot();
    });
    if (action === 'select') return reply(() => applySelect(message));
    if (action === 'collect') return reply(async () => {
      if (state.collecting || state.exporting) return { ok: false, error: '任务正在运行，请先停止' };
      if (!state.licenseActive) await refreshLicense();
      if (!state.licenseActive) return { ok: false, error: '授权未通过' };
      void collect().catch((e) => log('采集失败', e));
      return { ok: true, started: true };
    });
    if (action === 'export') return reply(async () => {
      // 前置条件不通过就直接报错，绝不能回 started:true 让工作台空等。
      const check = await preflightExport();
      if (!check.ok) return { ok: false, error: check.error };
      // v1.8.8：仅逐字稿走详情页新链路；"全部/仅视频"仍走原视频导出，代码零改动。
      const runner = state.filter.type === 'transcript' ? exportTranscriptsViaDetail : exportSelected;
      void runner().catch((e) => log('导出中断', e));
      return { ok: true, started: true, total: check.total };
    });
    if (action === 'stop') return reply(() => { stopTask(); return { ok: true }; });
    if (action === 'clearPending') return reply(async () => {
      if (state.collecting || state.exporting) return { ok: false, error: '任务运行中，请先停止再操作' };
      await refreshPending(true);
      if (!state.pendingList.length) return { ok: false, error: '当前没有待核对的课程' };
      const byId = new Map(state.pendingList.map(item => [item.fileId + '|' + item.kind, item]));
      const targets = message.all
        ? state.pendingList
        : (Array.isArray(message.items) ? message.items : [])
          .map(item => byId.get(item.fileId + '|' + item.kind))
          .filter(Boolean);
      if (!targets.length) return { ok: false, error: '没找到对应的待核对记录' };
      const { cleared = 0 } = await rpc('journal.clear-pending', { keys: targets.map(item => item.key) });
      // 解除后把课程上的旧提示一并抹掉，否则列表还挂着"已跳过"的红字。
      const hit = new Set(targets.map(item => item.fileId + '|' + item.kind));
      for (const item of state.collected) {
        if (hit.has(item.fileId + '|' + item.type)) delete item.exportError;
      }
      await refreshPending(true);
      void saveDraft().catch(log);
      return { ...snapshot(), cleared };
    });
    if (action === 'reset') return reply(() => { resetTask(); return snapshot(); });
    if (action === 'refreshDir') return reply(async () => { await refreshDirStatus(); return snapshot(); });
    return reply(() => ({ ok: false, error: '未知操作：' + action }));
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    // 轻量握手：后台/工作台用它区分"页面还活着"和"扩展重载前的旧页面（脚本已失联）"。
    // 不区分的话，用户按过扩展刷新后，工作台会一直说"没打开录制页"，而页面明明开着。
    if (message?.type === 'tmeet.ping') { respond({ ok: true, ready: true, href: location.href }); return; }
    if (message?.type === 'tmeet.panel') {
      // 后台代 popup 遥控面板（把工作台开在录制页里，而不是再开一个标签页）。
      if (sender?.id !== chrome.runtime.id || sender.tab) { respond({ ok: false, error: '不允许的调用来源' }); return; }
      if (!globalThis.TMeetPanel) { respond({ ok: false, error: '面板未注入，请刷新录制页（F5）' }); return; }
      if (message.action === 'close') globalThis.TMeetPanel.close(); else globalThis.TMeetPanel.open();
      respond({ ok: true });
      return;
    }
    if (message?.type !== 'tmeet.batch' || !fromUiPage(sender)) return;
    return handleBatch(message, respond);
  });

  /**
   * 同页面板（panel.js 注入的 Shadow DOM 工作台）直接调用引擎。
   *
   * 为什么要这么做：导出的每一步都在录制页脚本里跑。工作台如果是独立标签页，
   * 用户一看工作台，录制页就成了后台标签页 —— Chrome 会把定时器节流到 1s/60s，
   * 更狠的是 Memory Saver 直接把页面 JS 冻结，导出看着就像卡死。
   * 面板和录制页同页 ⇒ 页面始终前台，这两个问题物理上不存在。
   */
  globalThis.TMeetEngine = Object.freeze({
    send: (action, payload = {}) => new Promise((resolve) => {
      const handled = handleBatch({ type: 'tmeet.batch', action, ...payload }, resolve);
      if (!handled) resolve(null);
    }),
  });

  // ============================================================
  // 初始化
  // ============================================================
  async function refreshLicense() {
    try {
      const { license } = await rpc('license.status');
      state.licenseActive = !!license?.active;
      state.licenseKnown = true;
    } catch (e) { state.licenseKnown = false; }
    return state.licenseActive;
  }

  async function init() {
    await loadState();
    await refreshLicense();
    void refreshPending(true);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.config) CONFIG = { ...DEFAULT_CONFIG, ...changes.config.newValue, pageSize: 30 };
      // 工作台选完目录会写这个信号：这里同步一下状态，快照里就不会再说"未授权"。
      if (changes.localDir) void refreshDirStatus().then(() => pushLive());
    });
    // 等录制列表出现再挂悬浮球：没列表时挂上去也只是个点不动的球。
    let tries = 0;
    const timer = setInterval(() => {
      if (document.getElementById('tmeet-batch-fab')) { clearInterval(timer); return; }
      const rows = getRows();
      if (rows.length || tries++ > 20) {
        clearInterval(timer);
        createFab();
        if (!rows.length) {
          const hasLogin = TMeetSite.text.recordingLogin.test(document.body.innerText || '');
          log(hasLogin ? '请先登录腾讯会议' : '未检测到录制列表，请确认在「我的录制」页');
        }
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
