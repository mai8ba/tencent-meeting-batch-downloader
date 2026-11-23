/**
 * 真浏览器 E2E（翻页采集）：验证"清单会不会漏项"。
 *
 * 场景：假录制页有 65 条、默认每页 10 条、共 7 页，带每页条数下拉和页码/箭头。
 * 插件要做的是：设成 30 条/页 → 回第 1 页 → 逐页读完 → 去重累计 65 条 → 回第 1 页。
 * 任何一步没对齐，结果就是"少采了几条"，用户根本看不出来 —— 所以必须自动测。
 *
 * 用法同 e2e-flow.mjs：先起调试端口，再 node tests/e2e-multipage.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker, openBrowser, loadExtension, openPage, interceptPage, waitFor, evaluate,
  mockClock, clearDraft, wakeServiceWorker, closeRecordingTabs } from './e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..', '..', '成品-v1.8.3');
const { check, finish } = createChecker();

/** 假录制页：65 条 / 每页 10 条起，带真实的每页条数下拉与翻页控件。 */
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>我的录制</title>
<style>li[data-size]{padding:4px} .met-pagination{display:flex;gap:8px;align-items:center;margin-top:12px}</style>
</head>
<body>
<table><tbody id="rows"></tbody></table>

<div class="met-pagination">
  <div class="met-pagination__select">
    <div class="met-dropdown__header" id="sizeHeader">条/页</div>
    <span class="met-dropdown__value" id="sizeValue">每页 10 条</span>
    <ul class="met-dropdown__menu" id="sizeMenu" style="display:none">
      <li data-size="10">10 条/页</li><li data-size="20">20 条/页</li><li data-size="30">30 条/页</li><li data-size="50">50 条/页</li>
    </ul>
  </div>
  <ul class="met-pagination__pagechoose" id="pageChoose"></ul>
  <button class="met-pagination__pagechoosebtn" id="prev" data-dir="arrowleft"><i aria-label="arrowleft"></i></button>
  <button class="met-pagination__pagechoosebtn" id="next" data-dir="arrowright"><i aria-label="arrowright"></i></button>
</div>

<script>
const TOTAL = 65;
const data = Array.from({ length: TOTAL }, (_, i) => {
  const n = i + 1;
  const transcript = i % 3 === 0;
  return {
    id: 'file-' + String(1000 + i),
    name: (transcript ? '转写_课程' : '课程') + n,
    time: '2026-08-' + String(10 + (i % 15)).padStart(2, '0') + ' 20:00',
    meeting: '448 436 ' + String(100 + i),
    size: transcript ? '未知大小' : (1 + i / 10).toFixed(2) + ' GB',
  };
});

let pageSize = 10;
let page = 1;

const rows = document.getElementById('rows');
const pageChoose = document.getElementById('pageChoose');
const sizeValue = document.getElementById('sizeValue');
const sizeMenu = document.getElementById('sizeMenu');

function render() {
  const pages = Math.max(1, Math.ceil(TOTAL / pageSize));
  if (page > pages) page = pages;
  const start = (page - 1) * pageSize;
  rows.innerHTML = data.slice(start, start + pageSize).map((d) => (
    '<tr>' +
      '<td><label class="met-form-check" name="' + d.id + '"></label></td>' +
      '<td><div class="titleContent">' + d.name + '</div>' +
          '<div>' + d.time + '</div><div>会议号：' + d.meeting + '</div><div>' + d.size + '</div></td>' +
      '<td><i class="met-icon more--outlined" aria-label="more--outlined"></i></td>' +
    '</tr>'
  )).join('');

  pageChoose.innerHTML = Array.from({ length: pages }, (_, i) => (
    '<li data-page="' + (i + 1) + '" class="' + (page === i + 1 ? 'met-pagination__pagechooseitem_active' : '') + '">' + (i + 1) + '</li>'
  )).join('');

  document.getElementById('prev').disabled = page === 1;
  document.getElementById('next').disabled = page === pages;
}

document.getElementById('sizeHeader').addEventListener('click', () => {
  sizeMenu.style.display = 'block';
});
sizeMenu.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-size]');
  if (!li) return;
  pageSize = Number(li.dataset.size);
  sizeValue.textContent = String(pageSize);
  sizeMenu.style.display = 'none';
  page = 1;
  render();
});
pageChoose.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-page]');
  if (!li) return;
  page = Number(li.dataset.page);
  render();
});
document.getElementById('prev').addEventListener('click', () => { if (page > 1) { page -= 1; render(); } });
document.getElementById('next').addEventListener('click', () => { if (page < Math.ceil(TOTAL / pageSize)) { page += 1; render(); } });

render();
</script>
</body></html>`;

async function main() {
  const browser = await openBrowser();
  check('连上调试端口', /(?:Chrome|Chromium|Edg)\//.test(browser.version.Browser || ''), browser.version.Browser);

  const extensionId = await loadExtension(browser, EXT_DIR);
  check('扩展已加载', !!extensionId, String(extensionId));
  if (!extensionId) return finish(browser);

  // 干净起点：关掉上轮残留页面 + 清草稿（不清会先显示上轮的 65 条，断言假通过）+ 接管校时
  const stale = await closeRecordingTabs(browser);
  check('清理上轮残留的录制页标签', true, '关掉 ' + stale + ' 个');
  await clearDraft(browser, extensionId);
  await wakeServiceWorker(browser, extensionId);
  check('接管后台校时（测试不再依赖公网）', !!(await mockClock(browser)));

  // ---------- 假录制页（带分页） ----------
  const site = await openPage(browser);
  const interceptor = await interceptPage(browser, site.sessionId, '*meeting-record*', () => PAGE);
  await browser.send('Page.navigate', { url: 'https://meeting.tencent.com/user-center/meeting-record' }, site.sessionId);

  const injected = await waitFor(browser, "!!document.getElementById('tmeet-batch-fab')", site.sessionId, 20000);
  check('假录制页注入了悬浮球', injected === true, String(injected));
  check('拦截器真的返回了假页面', interceptor.served() >= 1, '响应 ' + interceptor.served() + ' 次');

  const pager = await evaluate(browser, `(() => ({
    rows: document.querySelectorAll('table tbody tr').length,
    pages: document.querySelectorAll('.met-pagination__pagechoose li').length,
    size: document.getElementById('sizeValue').textContent.trim(),
  }))()`, site.sessionId);
  check('起始状态：每页 10 条 / 7 页 / 首页 10 行', pager.rows === 10 && pager.pages === 7 && /10/.test(pager.size), JSON.stringify(pager));

  // ---------- 工作台 ----------
  const batch = await openPage(browser, `chrome-extension://${extensionId}/batch.html`);
  await waitFor(browser, "document.readyState === 'complete' && !!document.querySelector('.step')", batch.sessionId);
  const connected = await waitFor(browser, "document.getElementById('recordSub').textContent.includes('已打开')", batch.sessionId, 20000);
  check('工作台连上假录制页', connected === true, String(connected));

  const license = JSON.parse(await evaluate(browser,
    "chrome.runtime.sendMessage({ type: 'tmeet', op: 'license.status' }).then(r => JSON.stringify(r?.license || r))", batch.sessionId));
  if (!license.active) {
    check('采集链路（授权不可用，跳过）', true, 'license: ' + (license.reason || license.kind));
    return finish(browser);
  }

  // ---------- 采集 ----------
  await evaluate(browser, "document.getElementById('btnCollect').click(), true", batch.sessionId);
  const done = await waitFor(browser, "document.querySelectorAll('.item').length === 65", batch.sessionId, 120000);
  check('翻完 7 页并累计到 65 条（不重复、不遗漏）', done === true,
    String(await evaluate(browser, "document.querySelectorAll('.item').length", batch.sessionId)) + ' 条');

  const ids = await evaluate(browser, "[...document.querySelectorAll('.item')].map(li => li.dataset.id)", batch.sessionId);
  check('65 个标识唯一（翻页没有重复抓同一页）', new Set(ids).size === 65, `唯一 ${new Set(ids).size} / 共 ${ids.length}`);
  check('标识连续覆盖到第 65 条（没有中途跳页）',
    ids.includes('file-1000') && ids.includes('file-1064'), `${ids[0]} … ${ids[ids.length - 1]}`);

  const types = await evaluate(browser,
    "[...document.querySelectorAll('.item')].map(li => li.dataset.type).reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {})", batch.sessionId);
  check('转写识别为逐字稿 22 条，其余 43 条为视频', types.transcript === 22 && types.video === 43, JSON.stringify(types));

  const hint = await evaluate(browser, "document.getElementById('collectSub').textContent.trim()", batch.sessionId);
  check('第 3 步报出 65 项已采集', /65 项已采集/.test(hint), hint);

  const backToFirst = await evaluate(browser,
    "document.querySelector('.met-pagination__pagechooseitem_active')?.textContent.trim()", site.sessionId);
  check('采集结束后回到第 1 页（下次导出从首页开始找行）', backToFirst === '1', String(backToFirst));

  const sizeApplied = await evaluate(browser, "document.getElementById('sizeValue').textContent.trim()", site.sessionId);
  // 站点文案带单位（"每页 30 条"），这里按数字读，测的正是"只比数字"这件事
  check('每页条数被设成 30（站点文案带单位也能匹配上）', /30/.test(sizeApplied), sizeApplied);

  // 采集条数到 65 只是"读完了"，收尾（回第 1 页、保存草稿、推终态）还在跑。
  // 真正的断言是"最终会恢复成空闲"：等它，而不是立刻采样。
  const settled = await waitFor(browser,
    "document.getElementById('btnCollect').getAttribute('aria-disabled') === 'false' && document.getElementById('btnStop').getAttribute('aria-disabled') === 'true'",
    batch.sessionId, 25000);
  const idle = await evaluate(browser, `(() => ({
    collecting: document.getElementById('btnCollect').getAttribute('aria-disabled') !== 'true',
    count: document.getElementById('selInfo').textContent.trim(),
    stopDisabled: document.getElementById('btnStop').getAttribute('aria-disabled') === 'true',
    exportDisabled: document.getElementById('btnExport').getAttribute('aria-disabled') === 'true',
    recordSub: document.getElementById('recordSub').textContent.trim(),
    sub: document.getElementById('collectSub').textContent.trim(),
    prog: document.getElementById('progressWrap').classList.contains('hidden') ? '(隐藏)' : document.getElementById('progressText').textContent.trim(),
  }))()`, batch.sessionId);
  check('采集收尾后按钮自己恢复可用（不会永久卡在“任务运行中”）', settled === true, JSON.stringify(idle));
  check('进度条报出采集完成，而不是停在“正在读取第 3 页”', /采集完成/.test(idle.prog), idle.prog);
  check('默认勾选全部 65 项', /已选 65/.test(idle.count), idle.count);

  // ---------- 类型筛选（在 65 条上验证，顺手确认不误伤） ----------
  await evaluate(browser, `document.querySelector('#typeFilter [data-type="transcript"]').click(), true`, batch.sessionId);
  await new Promise((r) => setTimeout(r, 900));
  const onlyTranscript = await evaluate(browser, `(() => ({
    info: document.getElementById('selInfo').textContent.trim(),
    shown: document.querySelectorAll('.item').length,
    videoChecked: !!document.querySelector('.item[data-type="video"] input:checked'),
  }))()`, batch.sessionId);
  check('仅逐字稿：列表只留 22 条、只勾 22 项', /筛选 22/.test(onlyTranscript.info) && /已选 22/.test(onlyTranscript.info), onlyTranscript.info);
  check('仅逐字稿：视频全部取消勾选', onlyTranscript.videoChecked === false);

  return finish(browser);
}

main().catch((e) => { console.error('E2E 异常终止：' + e.message); process.exit(1); });
