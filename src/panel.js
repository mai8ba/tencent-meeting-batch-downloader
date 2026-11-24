/* 录制页内的批量下载工作台（Shadow DOM 大面板）。
 *
 * ── 为什么从独立标签页搬回页面里 ───────────────────────────────
 * 导出的每一步（hover「更多」→ 点「导出」→ 轮询下载状态）都跑在**录制页**的脚本里。
 * 工作台一旦是另一个标签页，用户看着工作台时录制页就变成后台标签页，Chrome 会做两件事：
 *   1) 定时器节流：300ms 的轮询被拉长到 1 秒，重度节流时甚至 60 秒一次；
 *   2) Memory Saver 冻结（Chrome 147 默认开启）：后台标签页不活跃一段时间后 JS 完全停摆。
 * 表现都是"导出还在跑，但慢到像卡死"，切回录制页才继续动。
 * 面板与录制页同页 ⇒ 页面始终是前台活动页，这两个问题物理上不存在。
 *
 * ── 顺带的好处 ────────────────────────────────────────────────
 * 面板和引擎在同一个隔离世界，采集/勾选/导出可以直接调 content.js 暴露的
 * TMeetEngine，不再走跨标签页消息：少一层转发、少一类"消息没回来"的故障。
 *
 * ── 硬约束 ───────────────────────────────────────────────────
 * content script 里**不能**调 showDirectoryPicker（File System Access 只对扩展
 * 自身页面开放）。所以第 ② 步仍然弹一个小的扩展页窗口去选目录，选完自动关；
 * 日常的采集/勾选/导出全程在面板里，不会再开工作台标签页。
 */
(() => {
  'use strict';

  const HOST_ID = 'tmeet-workspace';
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // 贴边抽屉：host 只占"把手"那一条，主体靠 fixed 定位贴在屏幕右侧。
  // all:initial 挡住宿主页的继承样式；z-index 拉到最大，避免被腾讯会议的浮层压住。
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; width: 0; height: 100%; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  /** 工作台脚本（batch.js）要知道节点在影子根里，查询得从影子根开始。 */
  globalThis.__tmeetPanelRoot = shadow;

  let opened = false;

  const ready = (async () => {
    const url = (f) => chrome.runtime.getURL(f);
    const [html, css, shell] = await Promise.all([
      fetch(url('batch.html')).then((r) => r.text()),
      fetch(url('batch.css')).then((r) => r.text()),
      fetch(url('panel.css')).then((r) => r.text()).catch(() => ''),
    ]);

    // batch.css 里的 :root / html,body / body 在影子根里不匹配，改写到影子宿主上。
    const scoped = css
      .replace(/:root\s*\{/g, ':host {')
      .replace('html, body { margin: 0; height: 100%; }', '.ws-body { margin: 0; height: 100%; }')
      .replace(/\nbody \{/, '\n.ws-body {');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    // 脚本由 manifest 的 content_scripts 提供，这里只要结构。
    doc.body.querySelectorAll('script').forEach((el) => el.remove());

    const style = document.createElement('style');
    style.textContent = scoped + '\n' + shell;

    // 标题带上版本号：出问题时用户截一张图，就能确认他加载的是不是最新代码
    // （"改了没生效"十次里有八次是扩展没重载、或页面没 F5）。
    const version = (chrome.runtime?.getManifest?.() || {}).version || '?';
    // 形态：平时只留一个贴在屏幕右边缘的竖排把手，点它才从右边滑出抽屉。
    // 不再铺满整页 —— 录制页本身还要用，铺满等于把它挡住。
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="ws-backdrop"></div>'
      + '<button class="ws-handle" type="button" title="打开腾讯会议批量下载（点这个把手展开，再点收起）">'
      + '<span class="ws-handle-text">腾讯会议批量下载</span>'
      + '<span class="ws-handle-badge" hidden></span></button>'
      + '<div class="ws-drawer">'
      + '<div class="ws-head"><span class="ws-title">腾讯会议录制批量下载</span>'
      // 版本号必须独立于标题：塞在 .ws-title 里会被 ellipsis 一起吃掉，
      // 两个链接变长后标题一缩，版本号就只剩「v1…」（真机量出来过）。
      + '<em class="ws-ver">v' + version + '</em>'
      + '<span class="ws-status">启动中…</span>'
      // 「幸会兄台 / 共饮一杯」：鼠标移上去才飘出二维码，平时只占两个小字的位置。
      // 纯 CSS 悬停（:hover / :focus），不写 JS —— 少一处需要跟着状态机走的东西。
      // 二维码图片放扩展的 assets/ 下，用 data-ext-src 标记：影子根里的相对路径
      // 会按「站点域名」解析（变成 tencent.com/assets/xxx.png，必然 404），
      // 必须换成 chrome.runtime.getURL() 的扩展地址。
      + '<span class="ws-social">'
      + '<span class="ws-social__item" tabindex="0" role="button" aria-label="幸会兄台（微信二维码）">幸会兄台'
      + '<span class="ws-social__pop" role="tooltip">'
      + '<span class="qr-box"><img class="qr-img" data-ext-src="assets/contact-qr.png" alt="微信加好友二维码">'
      + '<span class="qr-ph">微信二维码<em>占位图</em></span></span>'
      + '<em class="qr-tip">扫码加个朋友</em></span></span>'
      + '<span class="ws-social__item" tabindex="0" role="button" aria-label="共饮一杯（收款二维码）">共饮一杯'
      + '<span class="ws-social__pop" role="tooltip">'
      + '<span class="qr-box"><img class="qr-img" data-ext-src="assets/reward-qr.png" alt="收款二维码">'
      + '<span class="qr-ph">收款二维码<em>占位图</em></span></span>'
      + '<em class="qr-tip">请我喝杯咖啡</em></span></span>'
      + '</span>'
      + '<button class="ws-close" type="button" title="收起抽屉（Esc）">✕</button></div>'
      + '<div class="ws-body"></div>'
      + '</div>';
    const body = wrap.querySelector('.ws-body');
    while (doc.body.firstChild) body.appendChild(doc.body.firstChild);

    shadow.append(style, wrap);
    wrap.querySelector('.ws-close').addEventListener('click', () => close());
    wrap.querySelector('.ws-backdrop').addEventListener('click', () => close());
    wrap.querySelector('.ws-handle').addEventListener('click', () => open());

    // 二维码图片：换成扩展自己的地址（见上面 data-ext-src 的注释）。
    // 图加载成功 → 给外框挂 has-qr，虚线占位框收掉（那圈虚线是"还没图"的标记，
    // 有图还留着就像没做完；而且 1px 边框会把 150×150 的码边裁掉 2px）。
    // 图还没放进包 → 自动退回"占位图"文案，绝不会留一个破图标在界面上。
    wrap.querySelectorAll('img[data-ext-src]').forEach((img) => {
      const path = img.getAttribute('data-ext-src');
      img.addEventListener('load', () => {
        img.classList.add('is-ready');
        img.parentElement?.classList.add('has-qr');
      });
      img.addEventListener('error', () => img.remove());
      img.src = chrome.runtime.getURL(path);
    });

    // ── 状态位：让"面板在但没反应"这种故障一眼可见 ──────────────
    // 以前只有一句话的 HTML 初始文案，用户看到"正在连接录制目录…"根本分不清
    // 是"没连上"还是"程序没启动"。现在标题栏常驻一个状态灯。
    const statusEl = wrap.querySelector('.ws-status');
    const setStatus = (text, cls = '') => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = 'ws-status ' + cls;
    };
    // DOM 属性也写一份：主世界（页面控制台）读得到，便于远程排障。
    host.dataset.tmeetVersion = version;
    host.dataset.tmeetStage = 'shell-ready';
    globalThis.__tmeetPanelStatus = setStatus;

    // ── 显式叫醒工作台 ─────────────────────────────────────────
    // 以前是 batch.js 自己判断 document.readyState 再决定何时 init()。
    // 只要它在 await 面板资源期间正好是 'loading'，就会去等 DOMContentLoaded，
    // 而那个事件在 SPA 页面上可能迟迟不来 —— 结果就是"界面在、按钮全无反应"。
    // 现在由外壳（确定 DOM 已经铺好的一方）来叫醒，不再猜时机。
    let booted = false;
    const boot = () => {
      if (booted) return true;
      const init = globalThis.__tmeetBatchInit;
      if (typeof init !== 'function') return false;
      booted = true;
      try {
        const ret = init();
        if (ret && typeof ret.catch === 'function') {
          ret.catch((e) => { setStatus('启动失败', 'err'); console.error('[PANEL] 工作台启动失败', e); });
        }
      } catch (e) {
        setStatus('启动失败', 'err');
        console.error('[PANEL] 工作台启动失败', e);
      }
      return true;
    };
    globalThis.__tmeetPanelBoot = boot;

    // 立刻叫一次；叫不到（batch.js 还没执行到）就每 300ms 重试，最多 3 秒。
    boot();
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (booted || tries > 10) { clearInterval(timer); return; }
      boot();
    }, 300);
    // 3 秒还没起来就把话说清楚，别让用户对着一个"看起来正常"的界面干等。
    setTimeout(() => {
      if (!booted) {
        setStatus('工作台未启动，请按 F5 刷新', 'err');
        host.dataset.tmeetStage = 'boot-failed';
      }
    }, 3000);

    // ── 版本一致性检查：当场说破"你跑的是旧脚本" ────────────────
    // batch.html 是 fetch 的（永远最新），batch.js 是打包的（只有 ⟳ 才更新）。
    // 只按 F5 不按 ⟳ ⇒ 旧 JS + 新 HTML，界面正常、按钮全崩。
    // 这里把"正在运行的脚本版本"和"扩展版本"摆在一起对，
    // 对不上就报红，而不是让用户莫名其妙地点不动。
    const checkVersion = () => {
      const jsVersion = globalThis.__tmeetBatchVersion || '';
      host.dataset.tmeetJsVersion = jsVersion;
      if (!jsVersion) return;
      if (jsVersion !== version) {
        setStatus('脚本版本不匹配', 'err');
        host.dataset.tmeetStage = 'version-mismatch';
        const line = wrap.querySelector('#sourceLine');
        if (line) line.textContent = `工作台脚本是旧版（v${jsVersion}），扩展是 v${version}：` +
          '请在扩展页点 ⟳ 重新加载，再按 F5 刷新本页';
        console.warn('[PANEL] 版本不一致：脚本', jsVersion, '/ 扩展', version);
      }
    };
    // batch.js 可能在 boot 之后才把版本挂上来，所以多查几次。
    checkVersion();
    const vt = setInterval(() => {
      checkVersion();
      if (host.dataset.tmeetStage === 'ready' || host.dataset.tmeetStage === 'version-mismatch') clearInterval(vt);
    }, 500);
    setTimeout(() => clearInterval(vt), 8000);
  })();

  // batch.js 在同一个隔离世界、按 manifest 顺序在本文件之后执行，它会 await 这个 promise。
  globalThis.__tmeetPanelReady = ready;

  function open() {
    // 抽屉滑出：只切一个 class，动画交给 CSS。
    host.classList.add('ws-open');
    opened = true;
    void ready.then(() => {
      // 打开时立刻拉一次快照，别让用户先看到上一次的旧列表。
      try { globalThis.TMeetEngine?.send('snapshot').then((s) => s && globalThis.__tmeetPanelRefresh?.(s)); } catch { /* 忽略 */ }
    });
  }
  function close() {
    host.classList.remove('ws-open');
    opened = false;
  }
  function toggle() { if (opened) close(); else open(); }

  /**
   * 把手上的小角标：告诉用户"这边有事"，但**不自动弹出抽屉**。
   * 以前采集完直接 open()，会当着用户的面把整个工作台拍在录制页上，
   * 反而挡住页面。现在只在把手上提示一下，由用户自己点开。
   */
  function setBadge(text) {
    void ready.then(() => {
      const badge = shadow.querySelector('.ws-handle-badge');
      if (!badge) return;
      const value = String(text == null ? '' : text).trim();
      badge.textContent = value;
      badge.hidden = !value;
      const handle = shadow.querySelector('.ws-handle');
      if (handle) handle.title = value ? `腾讯会议批量下载（${value}，点开查看）` : '打开腾讯会议批量下载';
    });
  }

  // Esc 收起：挂在影子根上，不去干扰宿主页面自己的快捷键。
  shadow.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opened) { e.stopPropagation(); close(); }
  });

  globalThis.TMeetPanel = Object.freeze({ open, close, toggle, setBadge, isOpen: () => opened });
})();
