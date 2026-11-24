// ============================================================
// 腾讯会议录制批量下载 —— 工作台界面
//
// 页面只负责「看和点」，真正的翻页采集、点击导出、文件校验都在录制页的
// content script 里执行（那边才有页面 DOM）。
//
// 两种运行形态：
//   1) 面板模式（默认）：由 panel.js 注入到录制页的 Shadow DOM 里。
//      和引擎同一个隔离世界，直接调 TMeetEngine，不走跨标签页消息。
//      —— 这是关键：工作台和录制页同页，录制页始终是前台活动页，
//         Chrome 不会节流定时器、也不会 Memory Saver 冻结页面。
//   2) 独立页模式（batch.html，保留作备用入口）：跨标签页用
//      chrome.tabs.sendMessage 通信，进度由 content 主动推送（tmeet.live）。
// ============================================================
(() => {
  'use strict';

  const RENDER_LIMIT = 500;   // 单次渲染上限，再多就用搜索/筛选缩小范围
  const KEY_PREFIX = 'fileId|';

  /**
   * 工作台脚本自身的版本。
   * 存在的唯一理由：**查"改了没生效"**。
   * 扩展资源里 batch.html 是 fetch 的（实时读磁盘，永远最新），
   * 而 batch.js 是打包的（只有 ⟳ 重载才更新）—— 一旦只按 F5，
   * 页面就会跑着「旧 JS + 新 HTML」的混合状态，界面看着正常、按钮却全崩。
   * 这个版本号让外壳能当场比对并说破："你跑的是旧脚本"。
   * ⚠️ 改动本文件时必须同步改这里（tests/panel.test.cjs 有测试守着）。
   */
  const BATCH_JS_VERSION = '1.8.22';
  globalThis.__tmeetBatchVersion = BATCH_JS_VERSION;

  /** 面板模式下节点在影子根里，所有查询都必须从这里起，document 找不到。 */
  const scope = () => globalThis.__tmeetPanelRoot || document;
  const $ = (id) => scope().getElementById(id);
  const inPanel = () => !!globalThis.__tmeetPanelRoot;

  const state = {
    tabId: null,
    collected: [],
    filtered: [],              // 当前筛选命中的 fileId
    selected: new Set(),
    exported: new Set(),       // "fileId|type"：已通过正文校验
    filter: { type: 'all', keyword: '' },
    licenseActive: false,
    busy: false,
    live: null,
    connected: false,
    hasRecordingTab: false,  // 有没有开着录制页（开着但脚本失联要和"没打开"区分开）
    starting: false,       // 点了按钮、还没拿到引擎确认：期间禁止重复点击
    pending: new Set(),    // "fileId|type"：上次点了导出但结果不明，必须人工确认才能重试
  };

  // 停止/继续按钮形态：停止过一次后置 true，按钮变"继续"（点了续导剩下的项）。
  // 这是纯界面状态，不存盘——刷新页面就该回到"停止"。
  let resumeMode = false;

  // ------------------------------------------------------------
  // 与录制页通信
  // ------------------------------------------------------------
  /**
   * 所有可能的录制页，按"最可能是用户在看的那个"排序。
   *
   * 为什么是复数：用户可能开了多个「我的录制」标签页，而且扩展重载（⟳）之后
   * 旧页面里的脚本会失效。只看第一个的话，一旦碰上失联的旧页面，工作台就会永远
   * 显示"没打开录制页"——但页面明明开着，用户完全无从下手。
   */
  async function recordTabs() {
    // 面板模式下工作台就在录制页里，不存在"找哪个标签页"的问题。
    if (inPanel()) return [{ id: 'panel', url: location.href, active: true }];
    const tabs = await chrome.tabs.query({ url: 'https://meeting.tencent.com/user-center/meeting-record*' });
    const exact = tabs.filter((t) => {
      try {
        const url = new URL(t.url);
        return url.hostname === 'meeting.tencent.com' && url.pathname.replace(/\/$/, '') === '/user-center/meeting-record';
      } catch { return false; }
    });
    const score = (t) => (t.active ? 0 : t.id === state.tabId ? 1 : 2);
    return exact.slice().sort((a, b) => score(a) - score(b));
  }

  async function call(action, payload = {}) {
    // 面板模式：和录制页引擎在同一个隔离世界，直接调用。
    // 少一层跨标签页转发，也不会出现"开了两个工作台各自显示不同进度"。
    if (globalThis.TMeetEngine) {
      state.hasRecordingTab = true;
      const res = await globalThis.TMeetEngine.send(action, payload);
      if (!res) throw new Error('录制页没有响应，请刷新页面（F5）后重试');
      if (res.ok === false) throw new Error(res.error || '操作失败');
      return res;
    }
    const tabs = await recordTabs();
    state.hasRecordingTab = tabs.length > 0;
    if (!tabs.length) throw new Error('NO_TAB');
    let dead = 0, lastError = null;
    // 逐个试：某个标签页可能是扩展重载前的旧页面（脚本已失联），换下一个而不是直接放弃。
    for (const tab of tabs) {
      let response;
      try {
        // 加超时：消息发出去但录制页迟迟不回（脚本卡住/页面被判冻结）时，
        // 不能把界面永远晾在"启动中"，必须给用户一句能照做的话。
        response = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { ...payload, type: 'tmeet.batch', action }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 20000)),
        ]);
      } catch (e) {
        if (e?.message === 'TIMEOUT') { dead += 1; lastError = new Error('录制页 20 秒没有回应，请刷新录制页（F5）后重试'); continue; }
        if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(e?.message || '')) {
          dead += 1;
          continue;
        }
        lastError = e;
        continue;
      }
      if (!response) { dead += 1; continue; }
      // 业务错误（授权未通过/任务运行中…）要原样抛给用户，不能当成"这个页面不行"换下一个。
      if (!response.ok) throw new Error(response.message || response.error || '操作失败');
      state.tabId = tab.id;
      return response;
    }
    // 有页面但一个都答不上：几乎一定是扩展重载过、页面还没刷新。
    throw new Error(lastError?.message || (dead ? 'NEED_REFRESH' : 'NO_TAB'));
  }

  async function callQuiet(action, payload) {
    try { return await call(action, payload); } catch { return null; }
  }

  // ------------------------------------------------------------
  // 从录制页拉取快照
  // ------------------------------------------------------------
  function applySnapshot(snapshot) {
    if (!snapshot) return;
    state.collected = snapshot.collected || [];
    state.filter = snapshot.filter || state.filter;
    state.selected = new Set(snapshot.selected || []);
    state.exported = new Set(snapshot.exported || []);
    state.pending = new Set((snapshot.pending || []).map((x) => x.fileId + '|' + x.kind));
    state.filtered = snapshot.filtered || [];
    // 授权是全局状态，和录制页有没有连上无关：这里不从快照覆盖，见 readLicense()。
    // 录制页刚报过终态时，快照里的 busy 可能还是收尾前的瞬间值；
    // 一旦把它翻回 true，界面会永远停在"任务运行中"，筛选和再次采集全被挡住。
    const settled = state.live && ['done', 'error', 'idle'].includes(state.live.phase);
    state.busy = settled ? false : !!snapshot.busy;
    // 本地刚记的错误不要被录制页的 idle 快照盖掉：toast 几秒就消失，进度条要留着原因。
    if (snapshot.live && (snapshot.live.phase !== 'idle' || !state.live || state.live.phase !== 'error')) state.live = snapshot.live;
  }

  // 录制页没打开时，先显示上次采集的清单：至少能看到有什么、哪些已下载。
  // 导出仍然要求录制页在线（要点页面按钮），但界面不会一片空白。
  async function loadOfflineDraft() {
    try {
      const { ownDraftV3 } = await chrome.storage.local.get('ownDraftV3');
      if (!ownDraftV3?.collected?.length) return false;
      state.collected = ownDraftV3.collected;
      state.selected = new Set(ownDraftV3.selected || []);
      state.filtered = state.collected.map((c) => c.fileId);
      try {
        const res = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'journal.exported' });
        if (res?.ok) {
          state.exported = new Set((res.exported || []).filter((x) => x.scope === 'own').map((x) => x.fileId + '|' + x.kind));
        }
      } catch { /* 拿不到已下载标记时只是少个标签，不影响清单 */ }
      return true;
    } catch { return false; }
  }

  async function refresh({ silent = true } = {}) {
    const tabs = await recordTabs();
    state.hasRecordingTab = tabs.length > 0;
    if (!tabs.length) {
      state.connected = false;
      if (!state.collected.length) await loadOfflineDraft();
      render();
      return false;
    }
    const snapshot = await callQuiet('snapshot');
    state.connected = !!snapshot;
    if (snapshot) applySnapshot(snapshot);
    else if (!state.collected.length) await loadOfflineDraft();
    render();
    // “页面开着但脚本失联”和“压根没打开页面”是两件事，提示必须分开，否则用户无从下手。
    if (!snapshot && !silent) {
      toast(state.hasRecordingTab
        ? '录制页面需要刷新：切到「我的录制」按 F5，再回来点第 1 步'
        : '还没打开「我的录制」，点第 1 步开一个', true);
    }
    return !!snapshot;
  }

  // ------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  /** v1.8.15：值没变就不写 DOM。重复赋同样的文本会替换文本节点、引发无谓重排，
   * 而状态同步是每几秒一次、进度是每 200ms 一次，累积起来很可观。 */
  function setText(target, value) {
    const el = typeof target === 'string' ? $(target) : target;
    if (el && el.textContent !== value) el.textContent = value;
  }

  /**
   * 当前应显示的条目。
   * filtered 是录制页算出来的权威结果；本地再按关键字兜一层，
   * 防止快照还没回来时界面闪出不该出现的项。
   */
  function visibleItems(items = state.collected, filter = state.filter, filtered = state.filtered) {
    const keyword = String(filter.keyword || '').trim().toLowerCase();
    const hit = new Set(filtered);
    return items.filter((c) => {
      if (hit.size && !hit.has(c.fileId)) return false;
      // v1.8.6：按"文件大小"列区分——仅视频时，没有大小（纯逐字稿）的行不显示。
      // 逐字稿筛选作用于全部行，由权威 filtered 决定，本地只兜底关键字与视频判据。
      if (filter.type === 'video' && !c.hasVideo) return false;
      if (keyword && !((c.name || '').toLowerCase().includes(keyword) || String(c.meetingId || '').includes(keyword))) return false;
      return true;
    });
  }

  const isExported = (item) => state.exported.has(KEY_PREFIX + item.fileId) ||
    state.exported.has(item.fileId + '|' + item.type);
  const isPending = (item) => state.pending.has(item.fileId + '|' + item.type);

  /** 进度条的百分比：按"已处理文件个数"，不按字节。 */
  function computePercent(live) {
    if (!live) return 0;
    if (live.percent != null) return Math.max(0, Math.min(100, Math.round(live.percent)));
    const total = Math.max(1, Number(live.total) || 1);
    return Math.max(0, Math.min(100, Math.round((((Number(live.done) || 0) + (Number(live.failed) || 0)) / total) * 100)));
  }

  /* v1.8.15：列表分两层渲染，避免"每几秒整表重建一次"。
   * 旧版每次 render() 都 list.innerHTML = 全量字符串。后台每 5 秒同步一次状态，
   * 于是列表不停被推倒重排：看着闪、滚动位置可能跳、鼠标悬停状态也丢。
   * 现在：
   *   ① 结构（有哪些行、每行的名字/大小/标签）—— 只有"结构指纹"变了才重建；
   *   ② 勾选态 —— 每次只同步 class 和 checkbox，不碰 DOM 结构。
   * 指纹里不含勾选态，所以全选/反选/单选都不会触发表格重建。 */
  let listStructureKey = '';

  /**
   * 列表"结构指纹"：只由行的内容决定，不含勾选态。
   * 指纹不变 → 不重建列表 DOM（这是"点勾选不闪屏"的关键）。
   * marks 传入每行的状态标记（已下载/待核对），保持本函数是纯函数、便于单测。
   */
  function listKeyOf(shown, hiddenCount, marks = new Map()) {
    return shown.map((c) => [
      c.fileId, c.name, c.size, c.type, c.time, c.meetingId,
      marks.get(c.fileId) || '', c.exportError || '',
    ].join('')).join('') + '|more:' + hiddenCount;
  }

  /** 只同步勾选态，不重建列表。行数与结构由 renderList 保证。 */
  function syncRowStates() {
    const list = $('list');
    if (!list) return;
    for (const li of list.children) {
      const id = li.dataset?.id;
      if (!id) continue;
      const checked = state.selected.has(id);
      if (li.classList.contains('checked') !== checked) li.classList.toggle('checked', checked);
      const box = li.querySelector('input[type="checkbox"]');
      if (box && box.checked !== checked) box.checked = checked;
    }
  }

  function renderList() {
    const items = visibleItems();
    const shown = items.slice(0, RENDER_LIMIT);
    const list = $('list');
    const empty = $('emptyState');

    if (!state.collected.length) {
      empty.classList.remove('hidden');
      empty.innerHTML = `
        <div class="empty-icon">📥</div>
        <h2>${state.connected ? '还没有采集到课程' : '还没有连接录制页面'}</h2>
        <p>${state.connected
          ? '点上面第 2 步「采集清单」，插件会自动翻页收齐全部条目。<br />采集完就能在这里搜索、筛选、勾选并批量导出。'
          : '点上面第 1 步连上录制目录，然后回来<br />（连上后第 1 步会变绿，第 2 步就能点了）。'}</p>`;
      list.innerHTML = '';
      listStructureKey = '';
      return;
    }
    if (!items.length) {
      empty.classList.remove('hidden');
      empty.innerHTML = `
        <div class="empty-icon">🔍</div>
        <h2>当前筛选没有匹配项</h2>
        <p>换个关键字，或把类型切回「全部」。</p>`;
      list.innerHTML = '';
      listStructureKey = '';
      return;
    }
    empty.classList.add('hidden');

    const marks = new Map(shown.map((c) => [
      c.fileId, (isExported(c) ? 'd' : '') + (isPending(c) ? 'p' : ''),
    ]));
    const key = listKeyOf(shown, items.length - shown.length, marks);
    if (key !== listStructureKey) {
      // 真的变了才重建，并记住滚动位置，避免"同步一下状态就跳回顶部"。
      const wrap = $('listWrap');
      const prevTop = wrap ? wrap.scrollTop : 0;
      list.innerHTML = shown.map((c) => {
        const done = isExported(c);
        const pending = isPending(c);
        const checked = state.selected.has(c.fileId);
        const typeLabel = c.type === 'video' ? '视频' : '逐字稿';
        const meta = [];
        if (c.time) meta.push(escapeHtml(c.time));
        if (c.meetingId) meta.push('会议号 ' + escapeHtml(c.meetingId));
        meta.push(escapeHtml(c.size || '未知大小'));
        // 待核对的课显示"为什么导不了 + 怎么解开"，比一句长红字有用。
        const pendingTag = pending
          ? '<span class="tag warn">待核对</span><button class="retry" type="button" data-retry="1">允许重试</button>'
          : '';
        const errorTag = !pending && c.exportError
          ? `<span class="tag err">${escapeHtml(c.exportError)}</span>`
          : '';
        return `
      <li class="item${checked ? ' checked' : ''}${done ? ' is-exported' : ''}${pending ? ' is-pending' : ''}"
          data-id="${escapeHtml(c.fileId)}" data-type="${c.type}">
        <label class="item-box"><input type="checkbox" ${checked ? 'checked' : ''}></label>
        <div class="item-body">
          <div class="item-head">
            <span class="item-title">${escapeHtml(c.name || '(未命名)')}</span>
            <span class="item-type ${c.type === 'video' ? 'video' : 'transcript'}">${typeLabel}</span>
          </div>
          <div class="item-meta">
            ${meta.map((m) => `<span>${m}</span>`).join('<span class="dot">·</span>')}
            ${done ? '<span class="tag done">已下载</span>' : ''}
            ${pendingTag}
            ${errorTag}
          </div>
        </div>
      </li>`;
      }).join('') + (items.length > shown.length
        ? `<li class="item list-more">还有 ${items.length - shown.length} 项未显示，请用搜索或「仅视频 / 仅逐字稿」缩小范围</li>`
        : '');
      listStructureKey = key;
      if (wrap) wrap.scrollTop = prevTop;
    }
    syncRowStates();
  }

  /**
   * 步骤块的状态：完成的打绿勾；全条只允许一个"该做这一步"的蓝色高亮。
   * 这是整套界面唯一的主操作区，绝不让用户猜顺序 —— 编号就是顺序，蓝色就是现在点它。
   */
  /**
   * 按钮"为什么点不了"。返回空串表示可以点。
   * 之前用 disabled 属性：按钮一旦禁用，浏览器根本不触发 click，
   * 用户看到的就是"点了没反应"，无从判断该先做哪一步。
   */
  /**
   * 纯函数版"为什么现在不能导出"。抽出来是为了能单独测：
   * 目录对不上这条必须是硬拦截，否则用户会白跑一轮 104 项的导出。
   */
  function exportBlockReason(s) {
    if (s.starting) return '正在启动导出，请稍候几秒；若长时间没动静，点「停止」释放后重试';
    if (s.busy) return '任务正在运行，先点「停止」再操作';
    if (!s.licenseActive) return s.connected ? '授权未通过' : '请先完成第 1 步（连接录制目录）';
    if (!s.connected) return s.hasRecordingTab ? '录制页面需要刷新（F5）后再试' : '请先完成第 1 步（连接录制目录）';
    if (!s.collected.length) return '还没有清单：请先点第 2 步「采集清单」';
    if (!s.selected.size) return '还没有勾选任何课程：请在列表里勾选，或点「全选」';
    return '';
  }
  function whyCannotExport() {
    return exportBlockReason(state);
  }
  function whyCannotCollect() {
    if (state.starting) return '正在启动采集，请稍候几秒';
    if (state.busy) return '任务正在运行，先点「停止」再操作';
    if (!state.licenseActive) return state.connected ? '授权未通过' : '请先完成第 1 步（连接录制目录）';
    if (!state.connected) return state.hasRecordingTab ? '录制页面需要刷新（F5）后再试' : '请先完成第 1 步（连接录制目录）';
    return '';
  }
  /** 用 aria-disabled 表达"暂时点不了"，但保留 click 事件，点了必须有解释。 */
  function setBlocked(btn, reason) {
    if (!btn) return;
    // 一律不用 disabled 属性：disabled 的按钮收不到 click，用户就只剩"点了没反应"。
    btn.disabled = false;
    const blocked = !!reason;
    btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    btn.classList.toggle('is-blocked', blocked);
    if (blocked) btn.title = reason;
    else if (btn.dataset.okTitle) btn.title = btn.dataset.okTitle;
  }

  function renderStats() {
    const total = state.collected.length;
    const doneCount = state.collected.filter(isExported).length;
    const selected = state.selected.size;
    const pendingInList = state.collected.filter(isPending).length;

    const needConnect = !state.connected;
    // 未连上录制页时授权状态是"未知"，不能断言"没授权"——那是误导。
    const locked = state.connected && !state.licenseActive;
    const needCollect = state.connected && total === 0 && !locked;
    const canExport = state.connected && total > 0 && selected > 0 && !locked;

    // ① 连接录制目录（独立页模式下是「打开录制主页」）
    const openStep = $('btnOpenRecordings');
    openStep.classList.toggle('is-done', !needConnect);
    openStep.classList.toggle('step-go', needConnect);
    $('recordSub').textContent = needConnect
      ? (inPanel() ? '点这里重连' : (state.hasRecordingTab ? '页面需刷新 (F5)' : '点这里打开'))
      : (inPanel() ? '已连接' : '已打开');

    // ③ 采集清单
    const collectStep = $('btnCollect');
    collectStep.classList.toggle('is-done', total > 0);
    collectStep.classList.toggle('step-go', needCollect);
    // 授权没通过时给相关步骤加黄色提醒（CSS 里早就写好了，一直没接上）。
    collectStep.classList.toggle('needs-attention', locked);
    setBlocked(collectStep, whyCannotCollect());
    $('collectSub').textContent = total
      ? `${total} 项已采集${doneCount ? ` · ${doneCount} 已下载` : ''}`
      : needConnect ? '要把第 1 步做完'
      : locked ? '授权未通过'
      : '点这里开始';

    // 导出主按钮（v1.8.22 起移到勾选区正下方）：不再是步骤方块，而是醒目的主按钮。
    const exportBtn = $('btnExport');
    const exporting = state.busy && state.live?.phase === 'exporting';
    setBlocked(exportBtn, whyCannotExport());
    $('exportSub').textContent = exporting
      ? '· 导出中…'
      : !selected ? '· 先勾选课程'
      : `· 已选 ${selected} 项`;

    // 停止 / 继续：运行中显示"停止"；停下后变成"继续"（点了续导剩下的项）。
    // 从未导出过时保持"停止"并置灰，避免一进来就看到一个没意义的"继续"。
    const stopBtn = $('btnStop');
    const showResume = !state.busy && resumeMode;
    setText(stopBtn, showResume ? '继续' : '停止');
    stopBtn.classList.toggle('is-resume', showResume);
    const stopBlocked = showResume
      ? (whyCannotExport() || '')          // 续导也要有勾选和连接
      : (state.busy ? '' : '当前没有运行中的任务');
    setBlocked(stopBtn, stopBlocked);

    // 选择条：计数与待核对
    const visible = visibleItems().length;
    $('selInfo').textContent = total
      ? `已选 ${selected} · 筛选 ${visible} / 共 ${total}`
      : '未选择';
    setText('pendingCount', String(pendingInList));
    $('pendingBar').classList.toggle('hidden', pendingInList === 0);

    // 开源版：不再有"未激活"这回事，徽章固定显示开源免费。
    const badge = $('licenseBadge');
    setText(badge, '开源版 · 免费');
    badge.className = 'badge ok';

    if (!state.connected) {
      $('sourceLine').textContent = state.hasRecordingTab
        ? '录制页开着但脚本失联（扩展刚重载过）—— 切过去按 F5 刷新，再点第 1 步'
        : state.collected.length
          ? `还没连上录制页 · 显示上次清单 ${state.collected.length} 项（点第 1 步打开）`
          : '还没连上录制目录 —— 点第 1 步';
    } else {
      setText('sourceLine', `已连接录制目录 · ${state.collected.length} 项清单${state.collected.length ? '（改过勾选会自动保存）' : ''}`);
    }
  }

  function renderProgress() {
    const live = state.live;
    const wrap = $('progressWrap');
    const hint = $('exportHint');
    // 导出期间重载扩展（⟳）会当场打断任务并作废页面上下文 —— 在现场说清楚。
    if (hint) {
      const exporting = live && live.phase === 'exporting';
      hint.classList.toggle('hidden', !exporting);
      // v1.8.15：顺带告诉用户文件会落到哪 —— 新用户最常问的就是"导出的文件在哪儿"。
      if (exporting) {
        setText(hint, '导出期间请不要重新加载扩展或刷新本页：重载会当场中断这次导出（已下载的文件不受影响）。'
          + '文件会存进浏览器下载目录下的「腾讯会议录制下载」文件夹（逐字稿在「日期_逐字稿」子目录里）。');
      }
    }
    if (!live || live.phase === 'idle') { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden', 'ok', 'err');
    const bar = $('progressBar');
    const text = $('progressText');
    const total = Math.max(1, Number(live.total) || 1);
    const done = Number(live.done) || 0;
    const failed = Number(live.failed) || 0;
    // 进度每 200ms 推一次，宽度没变就别重复写样式（避免多余的样式重算）。
    const percent = computePercent(live);
    if (bar.style.width !== percent + '%') bar.style.width = percent + '%';

    if (live.phase === 'collecting') {
      setText(text, live.message || `正在采集：已读取 ${done} 项…`);
      return;
    }
    if (live.phase === 'verifying') {
      setText(text, live.message || `正在校验已下载文件 ${done}/${total}…`);
      return;
    }
    if (live.phase === 'exporting') {
      setText(text, live.message || `已完成 ${done}/${total}（成功 ${done}，失败 ${failed}，传输中 ${live.active || 0}）`);
      return;
    }
    if (live.phase === 'done') {
      wrap.classList.add('ok');
      bar.style.width = '100%';
      setText(text, live.message || `任务结束：成功 ${done}，失败 ${failed}，共 ${total} 项`);
      return;
    }
    if (live.phase === 'error') {
      wrap.classList.add('err');
      setText(text, live.message || '任务中断');
    }
  }

  function renderHint() {
    const el = $('hint');
    el.className = 'hint';
    if (!state.licenseActive) { el.textContent = ''; return; }
    if (!state.connected) { el.textContent = state.hasRecordingTab ? '录制页需刷新' : '未连接录制页'; return; }
    // 任务运行时的详细信息在进度条上，这里不再重复，省出横向空间。
    if (state.busy) { el.textContent = ''; return; }
    setText(el, '');
  }

  function render() {
    renderTypeTabs();
    renderStats();
    renderList();
    renderProgress();
    renderHint();
  }

  /** 两个标签的高亮跟随筛选状态；内部兼容态 'all' 显示为"视频"（界面已无"全部"按钮）。 */
  function renderTypeTabs() {
    const group = $('typeFilter');
    if (!group) return;
    const active = state.filter.type === 'transcript' ? 'transcript' : 'video';
    group.querySelectorAll('.seg').forEach((el) => {
      el.classList.toggle('active', el.dataset.type === active);
    });
  }

  // ------------------------------------------------------------
  // 轻提示
  // ------------------------------------------------------------
  let toastTimer;
  function toast(message, isError = false) {
    const el = $('toast');
    setText(el, message);
    el.classList.remove('hidden');
    el.classList.toggle('err', !!isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 3200);
  }

  // ------------------------------------------------------------
  // 目录授权（工作台自己是扩展页面，可以直接选目录）
  // ------------------------------------------------------------
  /** 直接问后台要授权状态。未打开录制页时只有这条路径是准的。 */
  async function readLicense() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'license.status' });
      if (res?.ok) state.licenseActive = !!res.license?.active;
    } catch { /* 查不到就保持原值，不误判成没授权 */ }
    renderStats();
  }

  /**
   * 短时快速轮询连接状态。
   * 用户点完第 1 步一定会切换页面再切回来，这里每秒探一次，
   * 连上就立刻把第 1 步变成已打开，不用等那 5 秒的常规同步。
   */
  let probeTimer = null;
  function probeConnection(seconds = 25) {
    clearInterval(probeTimer);
    let tried = 0;
    probeTimer = setInterval(async () => {
      tried += 1;
      const ok = await refresh();
      if (ok || tried > seconds) clearInterval(probeTimer);
    }, 1000);
  }

  /**
   * 看门狗：state.starting 是"点了按钮、还没拿到引擎确认"的中间态。
   * 万一消息通道断了（扩展重载、录制页失联），它会永远停在 true，
   * 于是按钮永远点不动。这里给它一个上限，超时自动放行并说明。
   */
  let startingSince = 0;
  const _setStarting = (value) => {
    state.starting = value;
    if (value) { startingSince = Date.now(); return; }
    startingSince = 0;
  };
  setInterval(() => {
    if (!state.starting || !startingSince) return;
    if (Date.now() - startingSince < 45000) return;
    _setStarting(false);
    state.busy = false;
    state.live = { phase: 'error', message: '启动超时（45 秒没收到录制页回应）：可能录制页被刷新过或扩展刚重载。请刷新「我的录制」页面后重试', total: 0, done: 0, failed: 0, active: 0, percent: 0 };
    render();
    toast('启动超时，已重置按钮。请刷新「我的录制」页面后重试', true);
  }, 5000);

  // ------------------------------------------------------------
  // 事件绑定
  // ------------------------------------------------------------
  function bind() {
    // ── 全部走事件委托，不再逐个 onclick ──────────────────────────
    // 以前是逐个给按钮赋 onclick：任何一个元素取不到就抛 TypeError，
    // 后面所有按钮全部绑不上 ⇒ 整个面板点了没反应，控制台外毫无痕迹
    // （重载扩展后没按 F5、新旧版本混用时最容易踩）。
    // 现在是一张「id → 动作」表 + 影子根上的一次 click 委托：
    // 少一个元素只是少一个入口，其它按钮照常可用。
    const clickActions = Object.create(null);

    // ── 唯一的 click 委托点 ──────────────────────────────────────
    // 挂在影子根（独立页模式下是 document）上，用捕获阶段：
    // 按钮自己就算 stopPropagation 也漏不掉，也不受"某个元素没绑上"影响。
    scope().addEventListener('click', (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      // 类型筛选：这几个 .seg 没有 id，用 data-type 认
      const seg = target.closest('#typeFilter .seg');
      if (seg && seg.dataset.type) { event.preventDefault(); void applyTypeFilter(seg); return; }
      const node = target.closest('[id]');
      const action = node && clickActions[node.id];
      if (!action) return;
      event.preventDefault();
      try {
        const ret = action(event);
        if (ret && typeof ret.catch === 'function') ret.catch((e) => toast('操作失败：' + (e?.message || e), true));
      } catch (e) {
        toast('操作失败：' + (e?.message || e), true);
      }
    }, true);

    scope().addEventListener('input', (event) => {
      if (event.target?.id === 'fSearch') applyKeyword(event.target.value);
    }, true);

    clickActions.btnDownloadSettings = async () => {
      // 面板模式在 content script 里，没有 chrome.tabs，交给后台开。
      const url = /Edg\//.test(navigator.userAgent) ? 'edge://settings/downloads' : 'chrome://settings/downloads';
      try {
        if (inPanel()) {
          const res = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'open-url', url });
          if (!res?.ok) throw new Error(res?.error || '后台无响应');
        } else {
          await chrome.tabs.create({ url });
        }
      } catch (e) { toast('无法打开下载设置，请在浏览器设置中更改下载位置：' + e.message, true); }
    };
    // 「chrome://downloads」入口：用按钮/链接都走同一条路。
    // 扩展页与面板都打不开 chrome:// 的普通 <a> 跳转（会被浏览器拦），统一交后台开标签页。
    const openDownloadList = async (event) => {
      event?.preventDefault?.();
      const base = /Edg\//.test(navigator.userAgent) ? 'edge://downloads' : 'chrome://downloads';
      try {
        if (inPanel()) {
          const res = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'open-url', url: base });
          if (!res?.ok) throw new Error(res?.error || '后台无响应');
        } else {
          await chrome.tabs.create({ url: base });
        }
      } catch (e) { toast('打不开下载列表：' + e.message, true); }
    };
    clickActions.btnOpenDownloads = openDownloadList;
    // 目录对不上时，用户要做的就一件事：授权浏览器下载的那个文件夹。
    // 直接把路径给他复制，比让他自己在设置里找要快得多。
    // 第 1 步：面板模式只做"重新连一次引擎"。
    // ⚠️ 绝不能让后台去 open-recordings：那会 ping 当前标签页、必要时 reload 它，
    //    而面板脚本就在这个页面里——reload 等于把刚点按钮的面板一起销毁，
    //    用户看到的就是"点了一下，卡死没反应"。独立页模式才需要真的去开/聚焦标签页。
    clickActions.btnOpenRecordings = async () => {
      if (inPanel()) {
        setText('recordSub', '正在连接…');
        const ok = await refresh();
        if (ok) toast('已连接录制目录');
        else {
          setText('recordSub', '连接失败');
          toast('还没连上录制目录：请按 F5 刷新本页面，再点这里重试', true);
        }
        return;
      }
      try {
        const res = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'open-recordings' });
        if (!res?.ok) throw new Error(res?.error || '打开失败');
        toast('已打开「我的录制」。登录后回到本页，第 1 步会自动变成已打开');
        // 不等常规的 5 秒同步：立刻开始每秒探测，连上就立刻变绿。
        setText('recordSub', '等待录制页…');
        probeConnection();
      } catch (e) {
        toast('打不开录制主页：' + e.message, true);
      }
    };

    clickActions.btnShared = () => chrome.runtime.sendMessage({ type: 'tmeet', op: 'open-shared' })
      .catch(() => toast('打开分享下载页失败', true));

    // 诊断信息不再占菜单位置：点顶部的状态行就能复制，出问题时一句话发给我。
    const srcLine = $('sourceLine');
    if (srcLine) {
      srcLine.style.cursor = 'pointer';
      srcLine.title = '点击复制诊断信息（贴给开发者定位问题）';
    }
    clickActions.sourceLine = async () => {
      const info = {
        at: new Date().toISOString(),
        version: (chrome.runtime.getManifest?.() || {}).version,
        connected: state.connected,
        hasRecordingTab: state.hasRecordingTab,
        licenseActive: state.licenseActive,
        starting: state.starting,
        busy: state.busy,
        collected: state.collected.length,
        selected: state.selected.size,
        exported: state.exported.size,
        pending: state.pending.size,
        filter: state.filter,
        live: state.live,
        cannotExport: whyCannotExport(),
        cannotCollect: whyCannotCollect(),
        userAgents: navigator.userAgent,
      };
      const text = JSON.stringify(info, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        toast('诊断信息已复制到剪贴板，直接粘贴发给我即可');
      } catch {
        try { window.prompt('复制下面这段发给我：', text); } catch { /* 面板里 prompt 被拦时忽略 */ }
      }
    };

    clickActions.btnCollect = async () => {
      const blocked = whyCannotCollect();
      if (blocked) return toast(blocked, true);
      _setStarting(true);
      renderStats();
      try {
        const res = await call('collect');
        if (!res.started) {
          state.live = { phase: 'error', message: '采集没有启动：' + (res.error || '未知原因'), total: 0, done: 0, failed: 0, active: 0, percent: 0 };
          return toast(res.error || '采集没有启动，请稍后重试', true);
        }
        toast('开始采集，插件会自动翻页读完整个录制目录');
        render();
      } catch (e) {
        if (e.message === 'NO_TAB') return toast('请先打开腾讯会议「我的录制」页面', true);
        toast('采集未开始：' + e.message, true);
      } finally {
        _setStarting(false);
        renderStats();
      }
    };

    clickActions.btnStop = async () => {
      // 停止过一次后按钮变"继续"：点它就是重新发起一次导出，
      // 引擎会自动认领已下好的项、只导剩下的，不用用户重新勾选。
      if (!state.busy && resumeMode) {
        resumeMode = false;
        render();
        return runExport();
      }
      if (!state.busy) return toast('当前没有运行中的任务', true);
      resumeMode = true;
      await callQuiet('stop');
      toast('已停止；可点「继续」接着导剩下的项', false);
    };

    clickActions.btnExport = async () => runExport();

    async function runExport() {
      // 之前这里是 `if (state.starting || state.busy) return;` —— 静默返回，
      // 用户看到的就是"点了没反应"。现在任何一次点击都必须有明确回应。
      const blocked = whyCannotExport();
      if (blocked) return toast(blocked, true);
      // 独立页模式：导出的每一步都跑在录制页里，而站点「更多 → 导出」菜单
      // 需要录制页在前台才渲染。所以先把录制页切到前台并展开面板，
      // 用户过去就能直接看到进度，而不是留在一个已经变成后台的独立页上看冻结的进度条。
      if (!inPanel()) {
        try {
          await chrome.runtime.sendMessage({ type: 'tmeet', op: 'open-panel' });
          toast('导出进行中：请切到「我的录制」页面看进度（站点菜单需要页面在前台）');
        } catch (e) { toast('无法切到录制页：' + e.message, true); }
      }
      // 待核对 = 上次点了导出但没确认结果，这些默认会被跳过。
      // 如果用户就是想把它们一起导，直接问一句，别让他以为"又没下载"。
      const pendingSelected = state.collected.filter((c) => state.selected.has(c.fileId) && isPending(c)).length;
      if (pendingSelected) {
        const others = state.selected.size - pendingSelected;
        const lift = window.confirm(`已选里有 ${pendingSelected} 项是「待核对」状态（上次点了导出但没确认到下载结果），这次默认会被跳过。` +
          `

点「确定」：先解除这些待核对，一并导出` +
          `
点「取消」：只导出其余 ${others} 项`);
        if (lift) {
          try {
            const cleared = await call('clearPending', { all: true });
            applySnapshot(cleared);
            render();
          } catch (e) {
            return toast('解除待核对失败：' + e.message, true);
          }
        }
      }
      _setStarting(true);
      // 先出进度条再做事：校时、建租约都要几百毫秒到几秒，不能点下去毫无反应。
      state.live = { phase: 'verifying', total: state.selected.size, done: 0, failed: 0, active: 0, percent: 0, message: '正在启动导出…' };
      render();
      render();
      try {
        const res = await call('export');
        if (!res.started) {
          state.live = { phase: 'error', message: '导出没有启动：' + (res.error || '未知原因'), total: 0, done: 0, failed: 0, active: 0, percent: 0 };
          toast(res.error || '导出没有启动，请稍后重试', true);
          return;
        }
        // 等第一条 live 回来之前先占住按钮，避免连点起两个批次。
        state.busy = true;
        state.live = { phase: 'verifying', total: res.total || state.selected.size, done: 0, failed: 0, active: 0, percent: 0, message: '正在校验已下载文件…' };
      } catch (e) {
        const message = e.message === 'NO_TAB' ? '请先打开腾讯会议「我的录制」页面' : e.message;
        state.live = { phase: 'error', message: '导出未开始：' + message, total: 0, done: 0, failed: 0, active: 0, percent: 0 };
        toast(message === e.message ? '导出未开始：' + e.message : message, true);
      } finally {
        _setStarting(false);
        render();
      }
    };

    clickActions.btnClearPending = () => void clearPending();

    clickActions.btnOpenFolder = async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'open-download-folder' });
        if (!res?.ok) throw new Error(res?.error || '后台无响应');
        toast(res.opened === 'file'
          ? '已在文件管理器里定位到最近一次下载'
          : '已打开系统默认下载目录（导出过文件后会直接定位到实际目录）');
      } catch (e) {
        toast('打开下载目录失败：' + e.message, true);
      }
    };

    // 类型筛选：同时决定勾选范围（交给录制页算，单一真相源）
    // 这几个 .seg 没有 id，用 data-type 在委托里认。
    const applyTypeFilter = async (btn) => {
      if (state.busy) return toast('任务运行中，先停止再改筛选', true);
      const type = btn.dataset.type;
      scope().querySelectorAll('#typeFilter .seg').forEach((x) => x.classList.toggle('active', x === btn));
      state.filter.type = type;
      const res = await callQuiet('filter', { filterType: type });
      if (res) applySnapshot(res);
      render();
    };

    let searchTimer;
    const applyKeyword = (value) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        state.filter.keyword = value;
        const res = await callQuiet('filter', { keyword: state.filter.keyword });
        if (res) applySnapshot(res);
        render();
      }, 180);
    };

    clickActions.btnSelectAll = () => void bulkSelect('all');
    clickActions.btnClearSel = () => void bulkSelect('none');
    clickActions.btnInvert = () => void bulkSelect('invert');

    // 列表：点复选框或整行都能切换
    $('list')?.addEventListener('click', async (event) => {
      // "允许重试"按钮在行内，先拦下来，别让它顺带切换勾选。
      const retry = event.target.closest('[data-retry]');
      if (retry) {
        event.preventDefault();
        const row = retry.closest('.item[data-id]');
        if (row) await clearPending([{ fileId: row.dataset.id, kind: row.dataset.type }]);
        return;
      }
      if (state.busy) return;
      const li = event.target.closest('.item[data-id]');
      if (!li) return;
      const id = li.dataset.id;
      const checkbox = li.querySelector('input[type="checkbox"]');
      // v1.8.14：一律以 state 为准判断目标状态。
      // 旧写法 `event.target === checkbox ? !checkbox.checked : ...` 是错的：点复选框时浏览器
      // 已经把 checked 翻成新值，再取反就是翻两次 —— 表现为"点复选框没反应，只能点名字"。
      // preventDefault 同时挡住 <label> 把这次点击再转发给 input 造成的二次 toggle。
      event.preventDefault();
      const next = !state.selected.has(id);
      if (next) state.selected.add(id); else state.selected.delete(id);
      li.classList.toggle('checked', next);
      if (checkbox) checkbox.checked = next;
      renderStats();
      const res = await callQuiet('select', { mode: 'set', id, selected: next });
      if (res) applySnapshot(res);
      renderStats();
    });

    // 录制页推送的实时进度。
    // 注意：这里只刷进度与统计，不重建列表 —— 导出时每 200ms 一条消息，
    // 重建整张表会让界面跟着卡顿，而列表内容这时并不会变。
    const onLive = (message) => {
      if (message?.type !== 'tmeet.live') return;
      state.live = message.live;
      state.busy = ['collecting', 'verifying', 'exporting'].includes(message.live?.phase);
      if (['done', 'error', 'idle'].includes(message.live?.phase)) {
        void refresh();   // 结束态需要重新拉清单（已下载标记、勾选可能变了）
        return;
      }
      if (message.live?.phase === 'collecting') {
        // 采集时让列表跟着长出来，但不必每条进度都拉一次快照。
        if (!state.collectTimer) {
          state.collectTimer = setTimeout(() => { state.collectTimer = null; void refresh(); }, 700);
        }
        renderProgress();
        renderHint();
        return;
      }
      renderStats();
      renderProgress();
      renderHint();
    };
    chrome.runtime.onMessage.addListener(onLive);
    // 面板和引擎在同一个隔离世界，chrome.runtime 消息到不了这边（它只发给扩展
    // 上下文），所以 content.js 会直接回调这里推进度。没有这条，
    // 导出期间面板的进度条会一直停在起点，看着像没动。
    globalThis.__tmeetPanelLive = onLive;
  }

  /**
   * 解除待核对。不带参数时清全部（含不在当前清单里的历史记录），
   * 带 items 时只清指定的几条。
   */
  async function clearPending(items) {
    if (state.busy) return toast('任务运行中，先停止再操作', true);
    try {
      const res = await call('clearPending', items ? { items } : { all: true });
      applySnapshot(res);
      render();
      toast(`已解除 ${res.cleared || 0} 项的待核对状态，现在可以重新导出了`);
    } catch (e) {
      toast('解除失败：' + e.message, true);
    }
  }

  async function bulkSelect(mode) {
    if (state.busy) return toast('任务运行中，先停止再改勾选', true);
    const res = await callQuiet('select', { mode });
    if (!res) return toast('没有连上录制页面', true);
    applySnapshot(res);
    render();
    if (mode === 'all' && res.skipped) toast(`已勾选 ${res.selected.length} 项，跳过 ${res.skipped} 项已下载`);
  }

  // ------------------------------------------------------------
  // 初始化
  // ------------------------------------------------------------
  /**
   * 界面必需的元素。少一个就不该继续 bind —— 但**绝不能静默失效**。
   * 真实踩过的坑：重载扩展（⟳）后没按 F5，页面里跑的还是旧 batch.js，
   * 它去找已经被删掉的 btnPickDir，`$('btnPickDir').onclick` 直接 TypeError，
   * bind() 当场中断 ⇒ 所有按钮都没绑上，界面停在初始文案、点哪里都没反应。
   * 现在缺元素会当场报出名字并显示在界面上，用户一看就知道要刷新页面。
   */
  const REQUIRED_IDS = [
    'btnOpenRecordings', 'btnCollect', 'btnExport', 'btnOpenFolder', 'btnStop',
    'recordSub', 'collectSub', 'exportSub', 'sourceLine', 'licenseBadge', 'toast',
    'list', 'listWrap', 'emptyState', 'hint', 'fSearch', 'typeFilter',
    'btnSelectAll', 'btnInvert', 'btnClearSel', 'btnClearPending',
    'selInfo', 'pendingCount', 'pendingBar',
    'progressWrap', 'progressBar', 'progressText',
    'btnShared', 'btnDownloadSettings', 'btnOpenDownloads',
  ];

  function assertDom() {
    const missing = REQUIRED_IDS.filter((id) => !$(id));
    if (!missing.length) return;
    throw new Error('页面结构不完整，缺少元素：' + missing.join('、') +
      '（多半是扩展更新后没刷新页面，按 F5 即可）');
  }

  /** 初始化失败也要让人看得见：写进顶部状态行，而不是只在控制台里躺着。 */
  function reportBootError(error) {
    console.error('[PANEL] 工作台初始化失败', error);
    try {
      const line = $('sourceLine');
      if (line) line.textContent = '界面初始化失败：' + (error?.message || String(error));
      const badge = $('licenseBadge');
      if (badge) { badge.textContent = '初始化失败'; badge.className = 'badge err'; }
      try { globalThis.__tmeetPanelStatus?.('启动失败', 'err'); } catch { /* 忽略 */ }
    } catch { /* 连元素都取不到就只能靠控制台了 */ }
  }

  /**
   * 启动阶段留痕：写进宿主的 data 属性。
   * 主世界（页面控制台）也读得到，远程排障时一眼能看出卡在哪一步。
   */
  function markStage(stage) {
    try {
      const root = globalThis.__tmeetPanelRoot;
      if (root?.host) {
        root.host.dataset.tmeetStage = stage;
        // 正在运行的脚本版本：与扩展版本对不上 = 用户没 ⟳ 重载
        root.host.dataset.tmeetJsVersion = BATCH_JS_VERSION;
      }
    } catch { /* 忽略 */ }
  }

  let initPromise = null;
  function initOnce() {
    // 幂等：外壳可能叫一次、兜底定时器再叫一次，只能真正启动一遍。
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await init();
    })();
    return initPromise;
  }

  async function init() {
    markStage('booting');
    // ── 版本戳自检 ────────────────────────────────────────────────
    // batch.html 是 fetch 出来的（Chrome 实时读磁盘 ⇒ 永远是最新的），
    // 而 panel.js / batch.js 是打包进扩展的代码（只有 ⟳ 重载才更新）。
    // 两者版本对不上 ⇒ 页面跑的是「旧 JS + 新 HTML」的混合状态，
    // 这种状态下界面看着正常、但按钮全是死的。必须当场喊出来。
    const stamp = ($('tmeet-build')?.textContent || '').trim();
    const manifestVersion = (chrome.runtime?.getManifest?.() || {}).version || '';
    if (stamp && manifestVersion && stamp !== manifestVersion) {
      console.warn('[PANEL] 版本不一致：HTML ' + stamp + ' / 扩展 ' + manifestVersion);
      try {
        const line = $('sourceLine');
        if (line) line.textContent = `扩展已更新到 v${manifestVersion}，请在扩展页点 ⟳ 重新加载，再按 F5 刷新本页`;
        const badge = $('licenseBadge');
        if (badge) { badge.textContent = '待重载'; badge.className = 'badge err'; }
        globalThis.__tmeetPanelStatus?.('待重载扩展', 'err');
      } catch { /* 忽略 */ }
    }
    // 顺序很重要：**先 bind（挂委托），再自检**。
    // 反过来的话，缺一个元素就会让 bind 整段跳过 —— 连事件委托都没挂上，
    // 结果还是"整个面板点了没反应"，白改。
    try { bind(); } catch (e) { reportBootError(e); }
    // 自检只做诊断（缺元素在委托模式下不会致命），但要在界面上留痕：
    // "缺元素"几乎总是"旧脚本配新 HTML"，用户得看得见才知道要重载。
    try { assertDom(); }
    catch (e) {
      console.warn('[PANEL] ' + e.message);
      try {
        const line = $('sourceLine');
        if (line) line.textContent = '工作台脚本与页面不匹配（可能是扩展更新后没重载）：' + e.message;
        globalThis.__tmeetPanelStatus?.('脚本版本不匹配', 'err');
      } catch { /* 忽略 */ }
    }
    // 面板就在录制页里：第 1 步不是"去打开一个页面"，而是"重新连一次目录"。
    // 文案不跟着改，用户会以为自己得再开一个标签页，反而把当前页切到后台。
    if (inPanel()) {
      const label = $('btnOpenRecordings')?.querySelector('.step-text strong');
      if (label) label.textContent = '连接录制目录';
      if ($('btnOpenRecordings')) $('btnOpenRecordings').title = '重新连接当前录制目录（面板就在本页，不需要另开标签页）';
    }
    try { render(); }
    catch (e) { reportBootError(e); }
    // 面板打开时用它立刻刷一次，避免先看到上一次的旧列表。
    globalThis.__tmeetPanelRefresh = (snapshot) => {
      try { applySnapshot(snapshot); render(); } catch (e) { reportBootError(e); }
    };
    // 首次同步：连不上/状态不明都不该让后面的定时器注册不上（否则界面永远不再更新）。
    try { await Promise.all([refresh({ silent: false }), readLicense()]); }
    catch (e) { reportBootError(e); }
    // 录制页可能在页面加载/刷新中：前 16 秒每秒重试一次，连上就停。
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      if (state.connected || tries > 16) { clearInterval(timer); return; }
      const ok = await refresh();
      if (ok) clearInterval(timer);
    }, 1000);
    // 定时轻量同步（导出时进度主要靠推送，这里只兜底状态位）。
    setInterval(() => { if (!document.hidden && !state.busy) void refresh(); }, 5000);

    // 启动完成：让外壳把标题栏状态灯点亮。
    globalThis.__tmeetBatchBooted = true;
    markStage('ready');
    try { globalThis.__tmeetPanelStatus?.('已就绪', 'ok'); } catch { /* 忽略 */ }
  }

  // 供单元测试验证的纯函数（生产逻辑不依赖这个对象）。
  globalThis.TMeetBatchUI = Object.freeze({ escapeHtml, visibleItems, computePercent, exportBlockReason, listKeyOf, KEY_PREFIX });

  // 面板模式（content script）下，panel.js 还在 fetch batch.html / batch.css，
  // 必须等节点真的注入到影子根之后再 bind，否则所有 $() 都是 null。
  // 面板模式由外壳（panel.js）叫醒：它确定 DOM 已经铺好，
  // 不用我们再去猜 document.readyState —— 猜错就是"界面在、按钮全无反应"。
  globalThis.__tmeetBatchInit = initOnce;

  void (async () => {
    if (globalThis.__tmeetPanelReady) {
      try { await globalThis.__tmeetPanelReady; }
      catch (e) { console.warn('[PANEL] 工作台注入失败，改为只提供悬浮球入口', e); return; }
      // 外壳会调 __tmeetBatchInit；这里也主动叫一次（幂等，谁先到算谁的）。
      try { globalThis.__tmeetPanelBoot?.(); } catch { /* 忽略 */ }
      // 万一外壳是旧版（没有 boot），1 秒后自己启动，别让面板永远点不动。
      setTimeout(() => { if (!globalThis.__tmeetBatchBooted) void initOnce(); }, 1000);
      return;
    }
    // 独立页模式（batch.html 直接打开）：自己判断时机。
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initOnce, { once: true });
    else void initOnce();
  })();
})();
