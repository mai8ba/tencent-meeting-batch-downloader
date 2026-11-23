/**
 * 真浏览器流程 E2E：不依赖腾讯线上页面，也不碰真实账号。
 *
 * 做法：用 CDP 的 Fetch 拦截，把 https://meeting.tencent.com/user-center/meeting-record
 * 的响应替换成本地构造的假录制页（结构按 site-adapter 的选择器写），
 * 于是 content script 会正常注入、工作台会正常连上，整条链路都能真跑：
 *
 *   假页面注入 → 悬浮球出现 → 工作台连上 → 第1步变绿 → 采集清单出来
 *   → 搜索/类型筛选 → 点导出被"未授权下载目录"拦住（不能静默卡死）
 *
 * 为什么值得单独跑：node --test 用的是 vm 桩，测不到
 *   content script 注入、消息通道、tab 查询、storage 真实行为。
 *
 * 用法（和 e2e-cdp.mjs 同一个调试端口）：
 *   1) chrome.exe --remote-debugging-port=9223 --user-data-dir=C:/tmeet-e2e \
 *        --enable-unsafe-extension-debugging --no-first-run about:blank
 *   2) node tests/e2e-flow.mjs
 *
 * 退出码：0 全通过 / 1 有失败 / 0 且打印 skipped（没找到调试端口）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createChecker, openBrowser, loadExtension, openPage, interceptPage,
  waitFor, evaluate, mockClock, clearDraft, wakeServiceWorker, closeRecordingTabs, clearDirectoryHandle
} from './e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..', '..', '成品-v1.8.3');
const { check, finish } = createChecker();

/** 假录制页：结构与 site-adapter 的选择器一一对应（改选择器时这里会先红）。 */
const FAKE_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>我的录制</title></head>
<body>
<div class="record-page">
  <table><tbody>
    <tr>
      <td><label class="met-form-check" name="file-aaa111"></label></td>
      <td>
        <div class="titleContent">转写_私域变现3大抓手</div>
        <div>2026-10-29 08:56</div><div>会议号：149 755 572</div><div>未知大小</div>
      </td>
      <td><i class="met-icon more--outlined" aria-label="more--outlined"></i></td>
    </tr>
    <tr>
      <td><label class="met-form-check" name="file-bbb222"></label></td>
      <td>
        <div class="titleContent">转写_何成兵商业操作系统 V1.0 第六课</div>
        <div>2026-08-23 20:02</div><div>会议号：448 436 389</div><div>212 KB</div>
      </td>
      <td><i class="met-icon more--outlined" aria-label="more--outlined"></i></td>
    </tr>
    <tr>
      <td><label class="met-form-check" name="file-ccc333"></label></td>
      <td>
        <div class="titleContent">何成兵商业操作系统 V1.0 第六课</div>
        <div>2026-08-23 20:00</div><div>会议号：448 436 389</div><div>1.82 GB</div>
      </td>
      <td><i class="met-icon more--outlined" aria-label="more--outlined"></i></td>
    </tr>
  </tbody></table>
</div>
</body></html>`;

async function main() {
  const browser = await openBrowser();
  check('连上调试端口', /(?:Chrome|Chromium|Edg)\//.test(browser.version.Browser || ''), browser.version.Browser);

  const extensionId = await loadExtension(browser, EXT_DIR);
  check('扩展已加载', !!extensionId, String(extensionId));
  if (!extensionId) return finish(browser);

  // 干净起点：关掉上轮残留页面 + 清草稿 + 唤醒后台 + 接管校时（否则会受公网抖动影响）
  const stale = await closeRecordingTabs(browser);
  check('清理上轮残留的录制页标签', true, '关掉 ' + stale + ' 个');
  await clearDraft(browser, extensionId);
  await clearDirectoryHandle(browser, extensionId);
  await wakeServiceWorker(browser, extensionId);
  check('接管后台校时（测试不再依赖公网）', !!(await mockClock(browser)));

  // ---------- 假录制页 ----------
  const site = await openPage(browser);
  const interceptor = await interceptPage(browser, site.sessionId, '*meeting-record*', () => FAKE_PAGE);
  await browser.send('Page.navigate', { url: 'https://meeting.tencent.com/user-center/meeting-record' }, site.sessionId);

  const fab = await waitFor(browser, "!!document.getElementById('tmeet-batch-fab')", site.sessionId, 20000);
  check('假录制页上注入了悬浮球', fab === true, String(fab));
  const fabShape = await evaluate(browser, `(() => {
    const host = document.getElementById('tmeet-batch-fab');
    const root = host && host.shadowRoot;
    if (!root) return { ok: false };
    const btn = root.querySelector('.tmeet-fab');
    const box = btn ? btn.getBoundingClientRect() : null;
    return { ok: !!btn, width: box && Math.round(box.width), fixed: /fixed/.test(host.style.cssText) };
  })()`, site.sessionId);
  check('悬浮球是 48px 的固定定位按钮', fabShape.ok && fabShape.width === 48 && fabShape.fixed, JSON.stringify(fabShape));

  // ---------- 面板：工作台搬进录制页（根除后台标签页节流 / Memory Saver 冻结） ----------
  // 这是本轮架构改动的核心断言：面板必须真的注入到录制页里，
  // 否则用户又会被迫开独立标签页 —— 录制页转后台后被冻结，导出看着像卡死。
  const panel = await waitFor(browser,
    "(() => { const h = document.getElementById('tmeet-workspace'); return !!(h && h.shadowRoot && h.shadowRoot.getElementById('btnExport')); })()",
    site.sessionId, 20000);
  check('面板注入到录制页（影子根里能找到工作台按钮）', panel === true, String(panel));
  const panelShape = await evaluate(browser, `(() => {
    const host = document.getElementById('tmeet-workspace');
    const root = host && host.shadowRoot;
    if (!root) return { ok: false };
    const hiddenAtStart = host.style.display === 'none';
    // 收起状态下卡片没有布局盒（宽度 0），先展开再量尺寸。
    root.querySelector('.ws-close'); // 确认外壳在
    document.getElementById('tmeet-batch-fab').shadowRoot.querySelector('.tmeet-fab').click();
    const card = root.querySelector('.ws-card');
    const box = card && card.getBoundingClientRect();
    return {
      ok: !!card,
      hiddenAtStart,
      opened: host.style.display !== 'none',
      width: box && Math.round(box.width),
      height: box && Math.round(box.height),
      hasStepbar: !!root.querySelector('.stepbar'),
      hasList: !!root.getElementById('list'),
      scopedCss: !!root.querySelector('style') && /:host/.test(root.querySelector('style').textContent),
    };
  })()`, site.sessionId);
  check('面板默认收起，点悬浮球当场展开（不再新开标签页）',
    panelShape.ok && panelShape.hiddenAtStart && panelShape.opened, JSON.stringify(panelShape));
  check('展开后是大尺寸卡片（不是小挂件）',
    panelShape.width >= 700 && panelShape.height >= 400, JSON.stringify(panelShape));
  check('面板里的工作台结构与样式都就位（Shadow DOM 内 :root 已改写成 :host）',
    panelShape.hasStepbar && panelShape.hasList && panelShape.scopedCss, JSON.stringify(panelShape));

  // 面板必须真的"启动"了：外壳负责叫醒工作台，状态灯与宿主属性都要有痕迹。
  // 这条锁的是真机故障"界面在、按钮点了没反应"——那时 stage 停在 booting。
  const panelBoot = await evaluate(browser, `(() => {
    const host = document.getElementById('tmeet-workspace');
    const root = host && host.shadowRoot;
    return {
      stage: host?.dataset?.tmeetStage || '',
      version: host?.dataset?.tmeetVersion || '',
      status: root?.querySelector('.ws-status')?.textContent || '',
      title: root?.querySelector('.ws-title')?.textContent || '',
    };
  })()`, site.sessionId);
  check('面板已真正启动（stage=ready、状态灯亮、标题带版本号）',
    panelBoot.stage === 'ready' && panelBoot.status.includes('已就绪') && panelBoot.title.includes('v1.8.'),
    JSON.stringify(panelBoot));

  // ---------- 工作台连上录制页 ----------
  const batch = await openPage(browser, `chrome-extension://${extensionId}/batch.html`);
  await waitFor(browser, "document.readyState === 'complete' && !!document.querySelector('.step')", batch.sessionId);

  const connected = await waitFor(browser, "document.getElementById('recordSub').textContent.includes('已打开')", batch.sessionId, 20000);
  check('工作台识别到录制页并把第 1 步标成已打开', connected === true, String(connected));

  const afterConnect = await evaluate(browser, `(() => {
    const g = id => document.getElementById(id);
    const steps = [...document.querySelectorAll('.stepbar .step')];
    return {
      step1Done: g('btnOpenRecordings').classList.contains('is-done'),
      step3Disabled: g('btnCollect').getAttribute('aria-disabled') === 'true',
      step3Go: g('btnCollect').classList.contains('step-go'),
      step3Hint: g('collectSub').textContent.trim(),
      highlighted: steps.filter(s => s.classList.contains('step-go')).map(s => s.id),
      source: g('sourceLine').textContent.trim(),
    };
  })()`, batch.sessionId);
  check('第 1 步变绿（已完成）', afterConnect.step1Done === true);
  check('第 3 步此时可点', afterConnect.step3Disabled === false, String(afterConnect.step3Disabled));
  check('全条只高亮第 3 步（不让人猜）', afterConnect.highlighted.join(',') === 'btnCollect', afterConnect.highlighted.join(','));
  check('第 3 步副标题是「点这里开始」', afterConnect.step3Hint === '点这里开始', afterConnect.step3Hint);

  // ---------- 采集 ----------
  await evaluate(browser, "document.getElementById('btnCollect').click(), true", batch.sessionId);
  const collected = await waitFor(browser, "document.querySelectorAll('.item').length === 3", batch.sessionId, 60000);
  if (collected !== true) {
    // 采集没出结果时把现场打出来，否则只看到一个 null 无从下手。
    const dbg = await evaluate(browser, `({
      prog: document.getElementById('progressText').textContent.trim(),
      toast: document.getElementById('toast').textContent.trim(),
      sub: document.getElementById('collectSub').textContent.trim(),
      rows: document.querySelectorAll('.item').length,
    })`, batch.sessionId);
    console.log('采集诊断:', JSON.stringify(dbg));
  }
  check('采集出 3 项（翻页/设置条数都通过）', collected === true, String(collected));

  // 面板直连引擎：展开面板后必须能看到和独立页同一份采集结果。
  // 这条锁住"面板不走跨标签页消息也能读到引擎状态"，是架构改动的核心收益。
  // 注意：content script 在隔离世界，globalThis.TMeetPanel 从 Runtime.evaluate 里看不到，
  // 这里只通过 DOM（悬浮球）驱动，别去碰隔离世界的全局对象。
  const panelList = await evaluate(browser, `(async () => {
    const host = document.getElementById('tmeet-workspace');
    const fab = document.getElementById('tmeet-batch-fab').shadowRoot.querySelector('.tmeet-fab');
    if (host.style.display === 'none') fab.click();
    for (let i = 0; i < 80; i++) {
      const n = host.shadowRoot.querySelectorAll('#list .item').length;
      if (n) return { n, sel: host.shadowRoot.getElementById('selInfo').textContent.trim() };
      await new Promise(r => setTimeout(r, 200));
    }
    return { n: 0, sel: '' };
  })()`, site.sessionId);
  check('面板与独立页共享同一份采集结果（面板直连 TMeetEngine）',
    panelList.n === 3, JSON.stringify(panelList));
  await evaluate(browser, `(() => {
    const host = document.getElementById('tmeet-workspace');
    if (host.style.display !== 'none') document.getElementById('tmeet-batch-fab').shadowRoot.querySelector('.tmeet-fab').click();
    return true;
  })()`, site.sessionId);

  if (collected === true) {
    const items = await evaluate(browser, `[...document.querySelectorAll('.item')].map(li => ({
      id: li.dataset.id,
      type: li.dataset.type,
      title: li.querySelector('.item-title').textContent.trim(),
      meta: li.querySelector('.item-meta').textContent.replace(/\\s+/g, ' ').trim(),
    }))`, batch.sessionId);
    check('文件标识来自行内 name 属性', items.map(i => i.id).join(',') === 'file-aaa111,file-bbb222,file-ccc333', items.map(i => i.id).join(','));
    check('转写自动识别为逐字稿、其余为视频',
      items.map(i => i.type).join(',') === 'transcript,transcript,video', items.map(i => i.type).join(','));
    check('会议号去掉了页面里的空格', /448436389/.test(items[1].meta), items[1].meta);
    check('时间被正确解析', /2026-08-23 20:02/.test(items[1].meta), items[1].meta);
    check('大小被正确解析', /1\.82 GB/.test(items[2].meta), items[2].meta);

    // 采集完成后第 3 步要变成“已完成”并报出条数
    const afterCollect = await evaluate(browser, `(() => ({
      done: document.getElementById('btnCollect').classList.contains('is-done'),
      hint: document.getElementById('collectSub').textContent.trim(),
      selected: document.getElementById('selInfo').textContent.trim(),
      collectDisabled: document.getElementById('btnCollect').getAttribute('aria-disabled') === 'true',
      stopDisabled: document.getElementById('btnStop').getAttribute('aria-disabled') === 'true',
    }))()`, batch.sessionId);
    check('第 3 步标成已完成并显示条数', afterCollect.done && /3 项已采集/.test(afterCollect.hint), afterCollect.hint);
    check('采集后默认勾选全部（都还没下载过）', /已选 3/.test(afterCollect.selected), afterCollect.selected);
    check('采集结束后「采集」恢复可用', afterCollect.collectDisabled === false);
    check('采集结束后「停止」变灰（没有假的运行中状态）', afterCollect.stopDisabled === true);

    // 等工作台真正空闲下来再测导出：采集收尾没结束时点导出会被 busy 挡掉，
    // 那样测到的不是导出前置校验，而是"点击被忽略"。
    const idle = await waitFor(browser,
      "document.getElementById('btnCollect').getAttribute('aria-disabled') === 'false' && document.getElementById('btnStop').getAttribute('aria-disabled') === 'true'",
      batch.sessionId, 20000);
    check('采集收尾后工作台回到空闲（导出按钮可点）', idle === true, String(idle));
    // 把采集阶段的旧提示清掉，避免把它的文案当成导出的提示
    await evaluate(browser, "document.getElementById('toast').classList.add('hidden'), true", batch.sessionId);

    // ---------- 类型筛选即勾选 ----------
    await evaluate(browser, `document.querySelector('#typeFilter [data-type="transcript"]').click(), true`, batch.sessionId);
    await new Promise((r) => setTimeout(r, 800));
    const filtered = await evaluate(browser, `(() => ({
      selected: document.getElementById('selInfo').textContent.trim(),
      rows: document.querySelectorAll('.item').length,
      videoChecked: !!document.querySelector('.item[data-type="video"] input:checked'),
      transcriptChecked: [...document.querySelectorAll('.item[data-type="transcript"] input')].every(x => x.checked),
    }))()`, batch.sessionId);
    check('切「仅逐字稿」后只勾 2 项', /已选 2/.test(filtered.selected), filtered.selected);
    check('切「仅逐字稿」后视频被取消勾选', filtered.videoChecked === false);
    check('逐字稿仍然全部勾选', filtered.transcriptChecked === true);

    await evaluate(browser, `document.querySelector('#typeFilter [data-type="all"]').click(), true`, batch.sessionId);
    await new Promise((r) => setTimeout(r, 800));
    const back = await evaluate(browser, "document.getElementById('selInfo').textContent.trim()", batch.sessionId);
    check('切回「全部」恢复全选', /已选 3/.test(back), back);

    // ---------- 搜索 ----------
    await evaluate(browser, `(() => {
      const box = document.getElementById('fSearch');
      box.value = '私域';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, batch.sessionId);
    const searched = await waitFor(browser, "document.querySelectorAll('.item').length === 1", batch.sessionId, 8000);
    check('搜索「私域」只留 1 项', searched === true, String(searched));
    await evaluate(browser, `(() => {
      const box = document.getElementById('fSearch');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, batch.sessionId);
    await waitFor(browser, "document.querySelectorAll('.item').length === 3", batch.sessionId, 8000);

    // ---------- 去掉本地校验后：没有"选文件夹"这一步，导出不该被授权拦住 ----------
    const shape = await evaluate(browser, `({
      hasPickDir: !!document.getElementById('btnPickDir'),
      steps: [...document.querySelectorAll('.stepbar .step')].map((s) => s.id),
      exportBlocked: document.getElementById('btnExport').getAttribute('aria-disabled') === 'true',
    })`, batch.sessionId);
    check('界面上已经没有第 ② 步「选文件夹」', shape.hasPickDir === false, JSON.stringify(shape));
    check('四步流程：打开录制主页 → 采集清单 → 开始导出 → 打开下载目录',
      shape.steps.join(',') === 'btnOpenRecordings,btnCollect,btnExport,btnOpenFolder', shape.steps.join(','));
    check('没有目录授权也能直接导出（不再要求选文件夹）', shape.exportBlocked === false, JSON.stringify(shape));
  }

    // ---------- 点击必须有反馈（回归锁：曾出现"点开始导出毫无反应"） ----------
    // 根因是两处：`if (state.starting || state.busy) return;` 静默返回；
    // 以及按钮用 disabled 属性——浏览器根本不派发 click，用户无从判断该先做哪步。
    const rawDisabled = await evaluate(browser, "document.getElementById('btnExport').disabled", batch.sessionId);
    check('导出按钮不使用 disabled 属性（disabled 会被浏览器吞掉点击）', rawDisabled === false, String(rawDisabled));

    // 清空选择后点导出：必须弹出原因，不能静默
    await evaluate(browser, "document.getElementById('btnClearSel').click(), true", batch.sessionId);
    await new Promise((r) => setTimeout(r, 500));
    await evaluate(browser, "document.getElementById('toast').classList.add('hidden'), true", batch.sessionId);
    await evaluate(browser, "document.getElementById('btnExport').click(), true", batch.sessionId);
    const why = await waitFor(browser, `(() => {
      const t = document.getElementById('toast');
      return !t.classList.contains('hidden') ? t.textContent.trim() : '';
    })()`, batch.sessionId, 6000);
    check('没勾选时点导出：弹出原因而不是没反应', /勾选/.test(String(why)), String(why));

    const aria = await evaluate(browser,
      "document.getElementById('btnExport').getAttribute('aria-disabled')", batch.sessionId);
    check('点不了的按钮用 aria-disabled 标记，但点击仍然有效', aria === 'true', String(aria));

    // 停止按钮空闲时点了也要有话说
    await evaluate(browser, "document.getElementById('toast').classList.add('hidden'), true", batch.sessionId);
    await evaluate(browser, "document.getElementById('btnStop').click(), true", batch.sessionId);
    const stopWhy = await waitFor(browser, `(() => {
      const t = document.getElementById('toast');
      return !t.classList.contains('hidden') ? t.textContent.trim() : '';
    })()`, batch.sessionId, 6000);
    check('空闲时点「停止」：给出提示而不是没反应', /没有运行中/.test(String(stopWhy)), String(stopWhy));

  // ---------- 无 JS 异常 ----------
  const errors = [];
  browser.on('Runtime.exceptionThrown', batch.sessionId, (m) => errors.push(m.params));
  browser.on('Runtime.exceptionThrown', site.sessionId, (m) => errors.push(m.params));
  await new Promise((r) => setTimeout(r, 500));
  check('两个页面都没有未捕获的 JS 异常', errors.length === 0,
    errors.slice(0, 2).map((e) => JSON.stringify(e).slice(0, 200)).join(' | '));

  await browser.send('Target.closeTarget', { targetId: batch.targetId }).catch(() => {});
  await browser.send('Target.closeTarget', { targetId: site.targetId }).catch(() => {});
  return finish(browser, `（假录制页响应 ${interceptor.served()} 次）`);
}

main().catch((e) => { console.error('E2E 异常终止：' + e.message); process.exit(1); });
