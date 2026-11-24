/* 面板架构契约（2026-10-30 真机故障后的架构调整）
 *
 * 背景：导出的每一步（点导出菜单、轮询下载状态）都跑在**录制页**的脚本里。
 * 工作台一旦是独立标签页，用户一看工作台，录制页就变成后台标签页，Chrome 会：
 *   1) 把 300ms 的轮询节流到 1s（重度节流 60s）；
 *   2) Memory Saver（Chrome 147 默认开启）直接冻结页面 JS。
 * 两种表现都是"导出看着像卡死"，切回录制页才继续。
 *
 * 结论：工作台必须是注入到录制页的面板（页面始终前台），不能退回独立标签页。
 * 这组用例就是防止有人（包括未来的我）把它改回去 —— 改回去不会有任何报错，
 * 只会让批量导出在真机上莫名其妙地"卡"。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('录制页的 content_scripts 必须依次加载 panel.js 和 batch.js（面板先铺壳，工作台再 bind）', () => {
  const entry = manifest.content_scripts.find((cs) => (cs.matches || []).some((m) => m.includes('meeting-record')));
  assert.ok(entry, '找不到录制页的 content_scripts');
  const js = entry.js || [];
  const iPanel = js.indexOf('panel.js');
  const iBatch = js.indexOf('batch.js');
  assert.ok(iPanel >= 0, 'panel.js 没被注入 —— 工作台会退回独立标签页，后台冻结问题会复发');
  assert.ok(iBatch > iPanel, 'batch.js 必须排在 panel.js 之后，否则 $() 拿到的全是 null');
});

test('面板要读 batch.html / batch.css / panel.css，必须有 web_accessible_resources（且只对腾讯会议开放）', () => {
  const war = manifest.web_accessible_resources || [];
  const hit = war.find((w) => (w.resources || []).includes('batch.html'));
  assert.ok(hit, '缺 web_accessible_resources：content script 里 fetch 扩展资源会直接失败');
  for (const f of ['batch.html', 'batch.css', 'panel.css']) assert.ok(hit.resources.includes(f), '缺少资源声明：' + f);
  assert.deepEqual(hit.matches, ['https://meeting.tencent.com/*'], '资源不能对所有站点开放');
});

test('panel.js：把影子根交给工作台，并把 :root 改写成 :host', () => {
  const src = read('panel.js');
  assert.match(src, /__tmeetPanelRoot\s*=\s*shadow/, 'panel.js 必须暴露影子根，工作台才能在里面查节点');
  assert.match(src, /__tmeetPanelReady\s*=\s*ready/, 'panel.js 必须暴露"注入完成"的 promise，工作台要等它');
  assert.match(src, /replace\(\/:root\\s\*\\\{\/g, ':host \{'\)/, 'panel.css 注入前必须把 :root 改写成 :host（影子根里 :root 不匹配）');
  assert.match(src, /:host/, '样式必须改写成 :host');
  assert.match(src, /TMeetPanel\s*=\s*Object\.freeze/, 'panel.js 必须提供全局开关给悬浮球用');
});

test('batch.js：面板模式直连引擎，不走跨标签页消息', () => {
  const src = read('batch.js');
  assert.match(src, /globalThis\.TMeetEngine[\s\S]{0,200}?\.send\(/, 'call() 里必须优先走 TMeetEngine');
  assert.match(src, /const scope = \(\) => globalThis\.__tmeetPanelRoot \|\| document/, '节点查询必须以影子根为作用域');
  assert.match(src, /if \(inPanel\(\)\) return \[\{ id: 'panel'/, '面板模式下不该再去查标签页');
  // 去掉本地校验后，面板不再需要任何"选目录/读文件"的能力
  assert.doesNotMatch(src, /TMeetFiles/, 'batch.js 不该再依赖目录句柄（本地校验已移除）');
  assert.doesNotMatch(src, /showDirectoryPicker/, 'batch.js 不该再要求授权下载文件夹');
});

test('面板与独立页共用同一条指令处理路径', () => {
  const content = read('content.js');
  const batch = read('batch.js');
  assert.match(content, /function handleBatch\(message, respond\)/, '指令处理要抽成函数，两条入口共用');
  assert.match(content, /globalThis\.TMeetEngine\s*=\s*Object\.freeze/, 'content.js 必须暴露 TMeetEngine');
  assert.match(content, /handleBatch\(message, respond\)/, 'chrome.runtime 入口仍要复用 handleBatch');
  // 进度推送：content script 之间收不到 runtime 消息，面板必须靠同页直推
  assert.match(content, /__tmeetPanelLive\?\.\(\{ type: 'tmeet\.live'/, 'pushLive 必须同页直推给面板，否则面板进度条不动');
  assert.match(batch, /globalThis\.__tmeetPanelLive = onLive/, 'batch.js 必须注册同页进度回调');
});

test('后台：面板需要的 op 都在，且 open-url 只放行下载列表/下载设置', () => {
  const src = read('background.js');
  assert.match(src, /'local\.match'/, '缺 local.match：面板读不到扩展源目录句柄，没法做一致性实测');
  assert.match(src, /'open-dir-picker'/, '缺 open-dir-picker：面板第 ② 步没法选目录');
  assert.match(src, /'open-panel'/, '缺 open-panel：popup 只能开独立标签页，后台冻结问题会复发');
  assert.match(src, /'open-url'/, '缺 open-url：面板里打不开 chrome://downloads');
  assert.match(src, /\^\(chrome\|edge\):\\\/\\\/\(downloads\|settings\\\/downloads\)\$/, 'open-url 必须白名单校验，不能变成任意导航通道');
  assert.match(read('file-check.js'), /tmeet\.file-contains/, '离屏文档要支持 file-contains，否则 local.match 无从判断');
});

/* ── 下面三条来自 2026-10-30 第二轮真机故障 ─────────────────────────────
 * 现象：点第 1 步"卡死没反应"，界面停在全套初始文案（连"检查授权…"都不变）。
 * 两个独立原因，各锁一条：
 *   1) 重载扩展后没刷新页面 ⇒ 旧 batch.js 去找已删除的 btnPickDir，
 *      `$('btnPickDir').onclick` 抛 TypeError，bind() 当场中断，
 *      后面所有按钮都没绑上 —— 界面从此完全没反应，且控制台之外无痕迹。
 *   2) "打开录制主页"在面板模式下会调后台 open-recordings，
 *      后台 ping 不过就 reload 当前标签页 —— 把面板所在的脚本一起销毁。
 */

test('初始化必须先自检结构，失败要显示在界面上（禁止静默失效）', () => {
  const src = read('batch.js');
  assert.match(src, /const REQUIRED_IDS = \[/, '必须有"界面必需元素"清单');
  assert.match(src, /function assertDom\(\)/, '必须能在 bind 之前自查结构');
  assert.match(src, /function reportBootError/, '初始化失败必须写到界面上，否则用户只看到"点了没反应"');
  // 顺序必须是 bind 先、自检后：反过来的话缺一个元素就让 bind 整段跳过，
  // 连事件委托都挂不上，还是"整个面板没反应"。
  const bindAt = src.indexOf('try { bind(); }');
  const checkAt = src.indexOf('try { assertDom(); }');
  assert.ok(bindAt > 0 && checkAt > bindAt, '必须先 bind（挂委托）再 assertDom，否则自检失败会连委托一起跳过');
  assert.match(src, /catch \(e\) \{ reportBootError\(e\); \}/, '捕获后必须调用 reportBootError');
  // render / 首次同步失败也不能让后续定时器注册不上
  assert.match(src, /try \{ await Promise\.all\(\[refresh\(\{ silent: false \}\), readLicense\(\)\]\); \}/,
    '首次同步失败必须被捕获，否则定时刷新永远不启动，界面就此定格');
});

test('按钮必须走事件委托，禁止逐个 onclick（一处取不到元素就全废）', () => {
  const src = read('batch.js');
  assert.match(src, /const clickActions = Object\.create\(null\)/, '必须有「id → 动作」表');
  assert.match(src, /scope\(\)\.addEventListener\('click'/, '必须在影子根上挂一次 click 委托');
  assert.match(src, /const action = node && clickActions\[node\.id\]/, '委托要按 id 分发到动作表');
  // 委托必须挂在"可能抛异常的语句"之前：它就在 bind 开头（clickActions 声明之后）
  const tableAt = src.indexOf('const clickActions = Object.create(null)');
  const clickAt = src.indexOf("scope().addEventListener('click'");
  const firstMaybeThrow = src.indexOf("$('list')?.addEventListener");
  assert.ok(clickAt > tableAt && clickAt < firstMaybeThrow, '委托要尽早挂上，别排在可能抛异常的语句后面');
  // 除了注释里的反面教材，不应该再出现逐个 onclick 赋值
  assert.doesNotMatch(src, /\$\('btn[A-Za-z]+'\)\.onclick\s*=/,
    '又出现裸 onclick 赋值了：缺元素会打断 bind，请加进 clickActions');
});

test('面板模式下第 1 步只能"重连"，绝不能调 open-recordings 刷新当前页', () => {
  const src = read('batch.js');
  const handlerAt = src.indexOf('clickActions.btnOpenRecordings =');
  assert.ok(handlerAt > 0, '找不到第 1 步的点击处理');
  const guardAt = src.indexOf('if (inPanel())', handlerAt);
  const openAt = src.indexOf("op: 'open-recordings'", handlerAt);
  assert.ok(guardAt > handlerAt, '第 1 步必须先判 inPanel()：面板就在录制页里，不该再去找标签页');
  assert.ok(openAt > guardAt,
    'open-recordings 只能留在面板分流之后的独立页分支里：后台会 ping 失败即 reload，' +
    '而面板脚本就在这个页面里，reload 等于把面板自己销毁（用户看到"卡死没反应"）');
});

test('「更多」菜单已按用户要求下线：下载他人分享课程直接放顶栏', () => {
  const html = read('batch.html');
  assert.doesNotMatch(html, /id="moreMenu"/, '"更多"下拉已删除，不要再加回来');
  assert.doesNotMatch(html, /id="btnAudit"/, '全量校验入口已下线');
  assert.match(html, /<button id="btnShared"[^>]*>下载他人分享课程<\/button>/, '分享课程入口必须直接可见，不藏在菜单里');
  // 诊断信息改由点击顶部状态行触发，不占界面位置
  assert.match(read('batch.js'), /clickActions\.sourceLine =/, '诊断信息要保留一个不占位置的入口（点状态行复制）');
});

test('标题栏的「幸会兄台 / 共饮一杯」：悬停才飘二维码，默认不许占位置也不许挡点击', () => {
  const panel = read('panel.js');
  const css = read('panel.css');

  // 结构：两个入口挂在标题栏，且二维码路径预留好（换成真图时只放文件，不改结构）
  assert.match(panel, /class="ws-social"/, '标题栏要有「幸会兄台 / 共饮一杯」容器');
  assert.match(panel, /role="button"[^>]*>幸会兄台/, '联系人入口文案是「幸会兄台」');
  assert.match(panel, /role="button"[^>]*>共饮一杯/, '打赏入口文案是「共饮一杯」');
  assert.match(panel, /data-ext-src="assets\/contact-qr\.png"/, '联系二维码路径要预留');
  assert.match(panel, /data-ext-src="assets\/reward-qr\.png"/, '打赏收款码路径要预留');
  // 影子根里的相对路径会按站点域名解析（必 404），必须换成扩展 URL
  assert.match(panel, /chrome\.runtime\.getURL\(path\)/, '影子根里必须把图片路径换成扩展地址');
  assert.match(panel, /img\.addEventListener\('error'[\s\S]{0,40}?img\.remove\(\)/, '图没放进来时要退回占位文案，不能留破图标');

  // 样式：默认收起（display:none，不能用 opacity 留个透明层挡按钮）
  assert.match(css, /\.ws-social__pop \{\s*\n\s*display: none;/, '浮层默认必须 display:none');
  assert.match(css, /\.ws-social__item:hover \.ws-social__pop/, '鼠标移上去要能飘出浮层');
  assert.match(css, /\.ws-social__item:focus \.ws-social__pop/, '键盘聚焦也要能看，不能只认鼠标');
  // 热区：必须够大，而且不能用伪元素叠一层去扩（伪元素会盖住旁边的东西）
  assert.match(css, /\.ws-social__item \{[\s\S]{0,220}?padding: 8px;/, '链接自己要有真内边距，否则只有文字能点/能悬停');
  assert.match(css, /\.ws-social__item \{[\s\S]{0,260}?margin: -8px;/, '内边距要用负外边距抵回去，视觉位置不许动');
  assert.doesNotMatch(css, /\.ws-social__item::after/, '热区不许再用伪元素叠加：会盖住状态灯和关闭按钮');
  // 浮层要贴着热区下沿，中间不能留透明缝（留缝＝鼠标往下挪的瞬间就脱手）
  assert.match(css, /\.ws-social__pop \{[\s\S]{0,160}?top: 100%;/, '浮层必须紧贴热区下沿，不能留缝');
  assert.match(css, /\.qr-img\.is-ready \+ \.qr-ph \{\s*display: none;/, '真图接上后占位文案要让位，否则叠在一起');
});

test('版本号不能被标题的省略号吃掉（两个四字链接会挤压标题栏）', () => {
  const panel = read('panel.js');
  const css = read('panel.css');
  // 真机量到过：.ws-ver 塞在 .ws-title 里时，标题一 overflow:hidden + ellipsis，
  // 版本号就被截成「v1…」。版本号必须是标题的兄弟节点，自己不被压缩。
  assert.doesNotMatch(panel, /ws-title">[^<]*<em class="ws-ver">/, '版本号不许嵌在 .ws-title 里');
  assert.match(panel, /<em class="ws-ver">/, '版本号要在标题栏可见');
  assert.match(css, /\.ws-ver \{[\s\S]{0,120}?flex: 0 0 auto;/, '版本号必须禁止被压缩');
  assert.match(css, /\.ws-title \{[\s\S]{0,200}?flex: 0 1 auto;/, '标题栏里只有标题可以牺牲宽度');
});

test('二维码是成品：图在包里、manifest 放行、有图时虚线占位框必须收掉', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const panel = read('panel.js');
  const css = read('panel.css');
  const manifest = JSON.parse(read('manifest.json'));

  // ① 图真的在包里（少一张就退回"占位图"文案，用户看到的是没做完的半成品）
  for (const f of ['assets/contact-qr.png', 'assets/reward-qr.png']) {
    const p = path.join(__dirname, '..', f);
    assert.ok(fs.existsSync(p), `缺二维码文件：${f}`);
    assert.ok(fs.statSync(p).size > 1024, `${f} 太小，可能不是有效图片`);
  }

  // ② 影子根里的图走 chrome.runtime.getURL，必须登记 web_accessible_resources，
  //    否则 Chrome 直接拒载（表现就是永远只有占位文案，且看不出原因）
  const war = manifest.web_accessible_resources || [];
  const res = war.flatMap((w) => w.resources || []);
  for (const f of ['assets/contact-qr.png', 'assets/reward-qr.png']) {
    assert.ok(res.includes(f), `${f} 必须写进 web_accessible_resources`);
  }

  // ③ 有图时收掉虚线框，且外框去掉 1px 边框（否则 150×150 的码边会被裁掉 2px）
  assert.match(panel, /classList\.add\('has-qr'\)/, '图片加载成功要给外框挂 has-qr');
  assert.match(css, /\.qr-box\.has-qr \{[^}]*border: none/, '有图时必须去掉虚线边框');
});

test('面板启动必须由外壳显式叫醒，不能猜 document.readyState', () => {
  const panel = read('panel.js');
  const batch = read('batch.js');
  // 外壳：DOM 铺好后叫醒工作台，并给出可见状态
  assert.match(panel, /globalThis\.__tmeetPanelBoot = boot/, 'panel.js 必须提供叫醒入口');
  assert.match(panel, /const init = globalThis\.__tmeetBatchInit;/, 'panel.js 必须取到工作台的启动函数');
  assert.match(panel, /typeof init !== 'function'/, '取不到启动函数时要能识别出来（说明 batch.js 是旧版）');
  assert.match(panel, /工作台未启动，请按 F5 刷新/, '3 秒没起来必须给出可照做的提示，不能静默');
  assert.match(panel, /host\.dataset\.tmeetVersion = version/, '必须把版本号写到宿主属性上，一眼可查');
  assert.match(panel, /ws-status/, '标题栏必须有启动状态灯');
  // 工作台：暴露幂等的启动函数，并在启动阶段留痕
  assert.match(batch, /globalThis\.__tmeetBatchInit = initOnce/, 'batch.js 必须暴露启动函数');
  assert.match(batch, /if \(initPromise\) return initPromise;/, '启动必须幂等（外壳和兜底定时器都会叫）');
  assert.match(batch, /markStage\('booting'\)/, '启动要留痕，便于定位卡在哪一步');
  assert.match(batch, /markStage\('ready'\)/, '启动完成要留痕');
  // 关键：面板模式下不能再依赖 readyState（猜错就是"界面在、按钮全无反应"）
  const bootAt = batch.indexOf('globalThis.__tmeetBatchInit = initOnce;');
  const readyStateAt = batch.indexOf("document.readyState === 'loading'");
  assert.ok(bootAt > 0 && readyStateAt > bootAt, 'readyState 判断只能出现在独立页分支里');
  const panelBranch = batch.slice(bootAt, readyStateAt);
  assert.doesNotMatch(panelBranch, /document\.readyState/, '面板模式下禁止用 readyState 判断启动时机');
});

test('版本号必须在标题栏可见（改了没生效时一眼可辨）', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, '版本号格式应为 x.y.z，且每轮改动都要升');
  // 不写死具体版本号：只要三处（manifest / HTML 戳 / 脚本常量）一致即可
  const batch = read('batch.js');
  const jsVersion = (batch.match(/const BATCH_JS_VERSION = '([^']+)'/) || [])[1] || '';
  assert.equal(jsVersion, manifest.version, '脚本版本常量必须与 manifest 一致');
  assert.match(read('panel.js'), /ws-ver/, '标题栏要显示版本号');
  assert.match(read('panel.js'), /chrome\.runtime\?\.getManifest\?\.\(\)/, '版本号必须从 manifest 取，不要硬编码');
});

test('必须有版本戳自检：HTML 是 fetch 的、JS 是打包的，两者不一致就是"旧 JS + 新 HTML"', () => {
  const html = read('batch.html');
  const batch = read('batch.js');
  assert.match(html, /id="tmeet-build"/, 'batch.html 必须带版本戳');
  const stamp = (html.match(/id="tmeet-build"[^>]*>([^<]+)</) || [])[1] || '';
  assert.equal(stamp.trim(), JSON.parse(read('manifest.json')).version,
    '版本戳必须与 manifest 一致（改版本号时两处都要改）');
  assert.match(batch, /tmeet-build/, 'batch.js 必须读版本戳');
  assert.match(batch, /请在扩展页点 ⟳ 重新加载/, '版本对不上必须给出可照做的提示');
});

test('工作台脚本要带自己的版本号，外壳据此判断"你跑的是旧脚本"', () => {
  const batch = read('batch.js');
  const panel = read('panel.js');
  const manifest = JSON.parse(read('manifest.json'));
  const m = batch.match(/const BATCH_JS_VERSION = '([^']+)'/);
  assert.ok(m, 'batch.js 必须声明自身版本');
  assert.equal(m[1], manifest.version, '脚本版本必须与 manifest 一致（改版本号时两处都要改）');
  assert.match(batch, /globalThis\.__tmeetBatchVersion = BATCH_JS_VERSION/, '必须把版本暴露给外壳');
  assert.match(batch, /tmeetJsVersion/, '必须把运行中的版本写到宿主属性上（页面控制台可读）');
  assert.match(panel, /__tmeetBatchVersion/, '外壳必须比对脚本版本与扩展版本');
  assert.match(panel, /脚本版本不匹配/, '对不上必须明确报出来');
});

test('兼容垫片必须最先注入：面板里没有 TMeetFiles 这个全局', () => {
  const entry = manifest.content_scripts.find((cs) => (cs.matches || []).some((m) => m.includes('meeting-record')));
  const js = entry.js || [];
  assert.equal(js[0], 'compat.js', 'compat.js 必须排在 js 数组首位');
  const compat = read('compat.js');
  assert.match(compat, /globalThis\.TMeetFiles = Object\.freeze/, '垫片要给出 TMeetFiles 的降级实现');
  assert.match(compat, /typeof globalThis\.TMeetFiles !== 'undefined'\) return;/, '已有真实实现时不能覆盖');
  // 垫片不能引入 downloads 等 content script 拿不到的 API
  assert.doesNotMatch(compat, /chrome\.downloads/, 'content script 没有 downloads 权限，垫片不能碰它');
});

test('扩展 manifest 不要写死 key：没有 key 时重新加载扩展 ID 会变，授权会丢', () => {
  // 这条是给未来的自己看的：一旦加了 key，改目录重新加载就会换 ID，
  // 用户的设备授权码与历史记录全部对不上。
  assert.equal(manifest.key, undefined, 'manifest 里不要写 key（会锁死扩展 ID，调试期反而碍事）');
});

test('v1.8.23 抽屉形态：贴边把手 + 右侧滑出，而不是铺满整页', () => {
  const src = read('panel.js');
  const css = read('panel.css');
  assert.match(src, /ws-handle/, '必须有贴边的把手');
  assert.match(src, /ws-drawer/, '必须有抽屉容器');
  assert.match(src, /classList\.add\('ws-open'\)/, '打开靠加 class 做动画，不是 display 切换');
  assert.match(src, /classList\.remove\('ws-open'\)/, '关闭要移除 class');
  assert.doesNotMatch(src, /style\.display\s*=\s*'none'/, '不能再用 display:none 整体隐藏（那样把手也看不见了）');
  assert.match(css, /\.ws-drawer[\s\S]{0,400}?translateX\(100%\)/, '抽屉默认在视口外，点开才滑进来');
  assert.match(css, /:host\(\.ws-open\) \.ws-drawer[\s\S]{0,80}?translateX\(0\)/, '打开时滑到屏幕内');
  assert.match(css, /writing-mode:\s*vertical-rl/, '把手文字竖排');
});

test('把手点得开：开门 class 在影子上，CSS 必须穿过影子墙去认它', () => {
  // 真机事故复盘：class 加在 host（影子外），CSS 却写裸 .ws-open .ws-drawer
  // （只在影子树内找祖先），两端隔着影子墙对不上，点把手抽屉纹丝不动。
  // 下面四条把两端锁死，防止以后只改一边又复发。
  const src = read('panel.js');
  const css = read('panel.css');
  assert.match(src, /host\.classList\.add\('ws-open'\)/, '开门记号加在影子宿主上');
  assert.match(src, /host\.classList\.remove\('ws-open'\)/, '关门时摘掉记号');
  assert.match(css, /:host\(\.ws-open\) \.ws-drawer[\s\S]{0,80}?translateX\(0\)/,
    '影子内样式必须用 :host(.ws-open) 才能匹配宿主');
  assert.doesNotMatch(css, /(?<!\()\.ws-open \.ws-drawer/,
    '裸 .ws-open .ws-drawer 在影子里匹配不到宿主，抽屉会永远藏在屏幕外');
});

test('v1.8.23 采集完成不再自动弹抽屉，只在把手上挂角标', () => {
  const src = read('content.js');
  const at = src.indexOf('TMeetPanel?.setBadge');
  assert.ok(at > 0, '采集完应该走 setBadge');
  // 采集完成这一段附近不允许再有自动展开（用户主动点开是另一处代码，不受影响）。
  const near = src.slice(Math.max(0, at - 500), at + 500);
  assert.doesNotMatch(near, /TMeetPanel\.open\(\)/, '采集完成不应自动展开工作台');
});

test('清单区不能被上面几块挤没：body 可滚 + 清单保底高度 + 步骤两列', () => {
  // 真机事故：四步竖排约 300px，加顶栏/说明/搜索条，窗口一矮清单区就被压到 0，
  // 197 项一起看不见，用户以为"没采集到"。三条约束缺一不可。
  const shell = read('panel.css');
  const css = read('batch.css');
  assert.match(shell, /\.ws-body[\s\S]{0,500}?overflow-y:\s*auto/,
    '抽屉内容必须能上下滚，否则矮窗口看不到清单');
  assert.match(css, /\.ws-body \.list-wrap[\s\S]{0,80}?min-height:/,
    '清单区要有保底高度，至少露出两行');
  assert.match(css, /\.ws-body \.stepbar[\s\S]{0,160}?grid-template-columns:\s*1fr 1fr/,
    '四步要压成两列，别竖着排吃掉 300px');
});

test('v1.8.23 开源版：没有试用、没有激活码、不联网校时', () => {
  const license = read('license.js');
  const bg = read('background.js');
  assert.match(license, /active:\s*true/, '授权必须恒为放行');
  assert.doesNotMatch(license, /trialStartedAt|expiresAt\s*=\s*.*\+\s*3/, '不该再有 3 天试用逻辑');
  assert.doesNotMatch(bg, /network-time\.js/, '不再加载联网校时模块');
  assert.doesNotMatch(bg, /TMeetNetworkTime/, '不再依赖联网时间');
});

test('popup：只有「打开腾讯会议官网」一个主入口，旧的"打开批量下载工作台"按钮已删除', () => {
  const html = read('popup.html');
  const js = read('popup.js');
  assert.match(html, /id="open-recordings"/, '保留打开录制页的按钮');
  assert.match(html, /打开腾讯会议官网/, '按钮文案按用户要求改名');
  assert.doesNotMatch(html, /id="open-batch"/, '不能再有"打开批量下载工作台"按钮');
  assert.doesNotMatch(html, /打开批量下载工作台/, '文案也不要残留');
  assert.doesNotMatch(js, /getElementById\('open-batch'\)/, '旧按钮的事件监听要一起删掉，避免取到 null 报错');
  // 网址不变：仍走 open-recordings（落到「我的录制」页，工作台就贴在那页右侧）
  assert.match(js, /getElementById\('open-recordings'\)[\s\S]{0,120}?send\('open-recordings'\)/,
    '按钮实际仍打开「我的录制」，不是首页');
});

test('v1.8.23 操作区：导出主按钮紧贴勾选行下方，停止在其右，进度条在下方', () => {
  const html = read('batch.html');
  // 步骤条只剩"打开 + 采集"两步，导出不再是第 3 步
  assert.doesNotMatch(html, /id="btnExport"[\s\S]{0,200}?class="step"/, '导出不该还是步骤方块');
  // 三个关键 id 都还在（JS 依赖它们），只是换了位置/形态
  for (const id of ['btnExport', 'btnStop', 'progressWrap', 'btnOpenFolder']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
  // 顺序：选择条 → 导出条（按钮 + 进度条）→ 列表
  const iSelect = html.indexOf('class="selectbar"');
  const iExport = html.indexOf('class="exportbar"');
  const iBtnExport = html.indexOf('id="btnExport"');
  const iBtnStop = html.indexOf('id="btnStop"');
  const iProgress = html.indexOf('id="progressWrap"');
  const iList = html.indexOf('id="listWrap"');
  assert.ok(iSelect < iExport && iExport < iList, '导出条必须在选择条和列表之间');
  assert.ok(iBtnExport < iBtnStop && iBtnStop < iProgress, '开始导出在左、停止在右、进度条在下方');
  // 打开下载目录从步骤按钮改成 noticebar 里的超链接，且排在"打开下载列表"后面
  const iOpenDownloads = html.indexOf('id="btnOpenDownloads"');
  const iOpenFolder = html.indexOf('id="btnOpenFolder"');
  assert.ok(iOpenDownloads < iOpenFolder, '打开下载目录链接要放在打开下载列表右边');
  assert.match(html, /id="btnOpenFolder"[^>]*class="link"/, '打开下载目录应是超链接样式');
});

test('v1.8.23 停止/继续切换：JS 有 resumeMode，停止后置位、点击变继续并可续导', () => {
  const js = read('batch.js');
  assert.match(js, /let resumeMode = false/, '要有停止/继续的形态标记');
  assert.match(js, /showResume \? '继续' : '停止'/, '停下后按钮文案变"继续"');
  assert.match(js, /classList\.toggle\('is-resume', showResume\)/, '继续态要有独立配色');
  assert.match(js, /if \(!state\.busy && resumeMode\)[\s\S]{0,160}?return runExport\(\)/,
    '点"继续"要重新发起导出（续导剩下的项），不用重新勾选');
  assert.match(js, /resumeMode = true;[\s\S]{0,80}?callQuiet\('stop'\)/, '点"停止"要置位并停任务');
});
