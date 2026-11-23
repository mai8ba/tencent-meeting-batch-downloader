// 独立浏览器、受控录制页、真实扩展和真实DOCX下载；不访问用户现有标签页或账号。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

test('真实批量下载：隐藏菜单、只读类型、校时重建按钮、DOCX校验与再次导出不重复', { skip: process.env.TMEET_BROWSER_E2E !== '1', timeout: 120000 }, async () => {
  const { chromium } = require(process.env.TMEET_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const extension = path.resolve(__dirname, '../../成品-v1.8.3');
  const artifacts = path.join(__dirname, 'artifacts', 'download-' + Date.now());
  const downloads = path.join(artifacts, 'Downloads');
  const profile = path.join(artifacts, 'profile');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.TMEET_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], acceptDownloads: true, downloadsPath: downloads
  });
  const logs = [], mirrorErrors = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    // 原始密钥只从用户提供的生成器读入内存，不写文件、不输出、不进入测试产物。
    const html = fs.readFileSync(process.env.TMEET_GENERATOR_PATH || 'C:/Users/Administrator/Downloads/兑换码生成器-私钥内嵌版-请勿分发.html', 'utf8');
    const jwk = JSON.parse(html.match(/window\.KECUN_ADMIN_KEY\s*=\s*(\{[^;]+\});/)[1]);
    const device = await worker.evaluate(async () => (await TMeetLicense.createManager(chrome.storage.local, async () => 1800000000000).status()).requestCode);
    const key = await crypto.webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const body = Buffer.from(JSON.stringify({ version: 1, device, expiresAt: null, id: crypto.randomUUID() }));
    const signature = await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, body);
    await worker.evaluate(async token => {
      await licensing.activate(token);
      await chrome.storage.local.set({ config: { pageSize: 30, clickDelay: 2500, maxConcurrent: 2, autoClassify: false } });
      const original = requireLicense;
      requireLicense = async (...args) => { await new Promise(r => setTimeout(r, 220)); return original(...args); };
      const originalVerify = verifyLocal;
      verifyLocal = async (...args) => { await new Promise(r => setTimeout(r, 500)); return originalVerify(...args); };
    }, body.toString('base64url') + '.' + Buffer.from(signature).toString('base64url'));
    const doc = await worker.evaluate(() => Array.from(TMeetDocx.create('测试课程', '', [{ id: 'p1', speaker: '测试', start: 0, text: '这是用于检验真实正文的逐字稿测试内容，不能将空模板当作完整导出。'.repeat(10) }])));
    const payload = Buffer.from(doc).toString('base64');
    const batch = await context.newPage(); await batch.goto(`chrome-extension://${id}/batch.html`);
    await batch.evaluate(() => {
      const originalCreate = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = async options => {
        const tab = await originalCreate(options);
        globalThis.settingsAttempt = {url:options.url,id:tab.id};
        return tab;
      };
    });
    assert.match(await batch.locator('#btnPickDir').innerText(), /校验文件夹/);
    await batch.locator('#btnDownloadSettings').click();
    let settings;
    for(let i=0;i<40;i++) {
      settings = await batch.evaluate(()=>globalThis.settingsAttempt);
      if(settings)break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(settings, '设置入口必须真正调用浏览器打开设置页');
    assert.match(settings.url, /^(?:edge|chrome):\/\/settings\/downloads/);
    await worker.evaluate(async tabId => {await chrome.tabs.get(tabId);await chrome.tabs.remove(tabId)}, settings.id);
    const cdp = await context.newCDPSession(batch); await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await batch.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Downloads', { create: true });
      await TMeetFiles.directory(root);
      await chrome.storage.local.set({ localDir: { name: root.name, at: Date.now() } });
    });
    // 文件夹选择器需真人授权；测试用同源目录句柄映射实际下载字节，沿用完整离屏校验链路。
    const page = await context.newPage();
    page.on('console', msg => { if (msg.text().includes('导出调试')) logs.push(msg.text()); });
    page.on('download', async d => {
      try {
        let item;
        for (let i = 0; i < 100; i++) {
          item = await worker.evaluate(async () => (await chrome.downloads.search({ limit: 0 })).sort((a, b) => b.id - a.id)[0]);
          if (item?.state === 'complete' && fs.existsSync(item.filename)) break;
          await new Promise(r => setTimeout(r, 50));
        }
        const bytes = Array.from(fs.readFileSync(item.filename));
        await batch.evaluate(async ({ name, bytes }) => {
          const root = await TMeetFiles.root(), file = await root.getFileHandle(name, { create: true }), stream = await file.createWritable();
          await stream.write(new Uint8Array(bytes)); await stream.close();
        }, { name: path.basename(item.filename), bytes });
      } catch (e) { mirrorErrors.push(e.message); }
    });
    const fixture = `<!doctype html><meta charset="utf-8"><style>td{height:48px}i{display:inline-block;width:30px;height:24px}#menu{position:fixed;left:50px;top:180px;visibility:hidden} .met-modal{position:fixed;top:30px;background:white;padding:20px}</style>
      <span class="met-pagination__select"><span class="met-dropdown__value">30 条/页</span></span>
      <table><tbody>${[1, 2].map(i => `<tr><td><label class="met-form-check" name="debug-${i}"></label><span class="titleContent">调试课程${i}.docx</span><i class="more--outlined" data-id="${i}">更多</i></td></tr>`).join('')}</tbody></table>
      <ul id="menu" class="met-list--option"><li>导出</li></ul><script>
      window.confirmCount=0; window.blockMenu=true; let course=0; const menu=document.getElementById('menu');
      document.querySelectorAll('i').forEach(el=>{el.onmouseover=()=>{if(window.blockMenu)return;course=Number(el.dataset.id);menu.style.visibility='visible'};el.onmouseout=()=>menu.style.visibility='hidden'});
      menu.querySelector('li').onclick=()=>{menu.style.visibility='hidden';const d=document.createElement('div');d.className='met-modal';d.setAttribute('role','dialog');d.dataset.fileId='debug-'+course;
        d.innerHTML='<div class="record-name">调试课程'+course+'.docx</div><label><input type="checkbox" checked disabled>逐字稿（Word）</label><footer><button id="confirm">开始导出</button><button id="cancel">取消</button></footer>';
        document.body.append(d);d.querySelector('#cancel').onclick=()=>d.remove();
        const click=()=>{window.confirmCount++;const a=document.createElement('a');a.download='下载.docx';a.href=URL.createObjectURL(new Blob([Uint8Array.from(atob('${payload}'),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));a.click()};
        d.querySelector('#confirm').onclick=click;
        setTimeout(()=>{const b=document.createElement('button');b.id='confirm';b.textContent='开始导出';b.onclick=click;d.querySelector('#confirm').replaceWith(b)},80);
      };</script>`;
    await context.route('https://meeting.tencent.com/user-center/meeting-record**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto('https://meeting.tencent.com/user-center/meeting-record');
    await batch.bringToFront(); await batch.reload();
    await batch.waitForFunction(() => !document.getElementById('btnCollect').getAttribute('aria-disabled') || document.getElementById('btnCollect').getAttribute('aria-disabled') === 'false');
    await batch.locator('#btnCollect').click();
    await batch.waitForFunction(() => document.getElementById('progressText').textContent.includes('采集完成'));
    await batch.locator('#btnExport').click();
    await batch.waitForFunction(() => document.getElementById('progressText').textContent.includes('现场诊断'), null, {timeout:30000});
    const diagnosis = await batch.locator('#progressText').textContent();
    assert.match(diagnosis, /"matched":1/);
    assert.match(diagnosis, /"visible":0/);
    assert.equal(await page.evaluate(() => confirmCount), 0, '诊断失败不能触发下载');
    assert.equal((await worker.evaluate(() => chrome.downloads.search({limit:0}))).length, 0);
    await batch.waitForFunction(() => document.getElementById('btnExport').getAttribute('aria-disabled') !== 'true');
    await page.evaluate(() => {window.blockMenu=false});
    await batch.locator('#btnExport').click();
    await batch.waitForFunction(() => /任务结束|已停止|未就绪|更多菜单未找到/.test(document.getElementById('progressText').textContent), null, { timeout: 60000 });
    const progress = await batch.locator('#progressText').textContent();
    fs.writeFileSync(path.join(artifacts, 'trace.txt'), logs.join('\n') + '\n' + progress + '\n' + mirrorErrors.join('\n'));
    assert.match(progress, /成功 2，失败 0/, progress);
    assert.equal(await page.evaluate(() => confirmCount), 2);
    assert.deepEqual(mirrorErrors, []);
    const results = await worker.evaluate(async () => (await chrome.downloads.search({ limit: 0 })).map(d => ({ id: d.id, state: d.state, filename: d.filename })));
    assert.equal(results.length, 2); assert.ok(results.every(d => d.state === 'complete'));
    assert.ok(results.every(d => path.resolve(path.dirname(d.filename)) === path.resolve(downloads)), '原生下载必须实际保存到浏览器配置的下载目录');
    await batch.locator('#btnSelectAll').click();
    assert.equal(await batch.locator('#btnExport').getAttribute('aria-disabled'), 'true');
    // Playwright把aria-disabled也视作不可点击；这里只验证被阻止时的说明处理器。
    await batch.locator('#btnExport').evaluate(el => el.click());
    await batch.waitForFunction(() => /勾选/.test(document.getElementById('toast').textContent));
    assert.equal((await worker.evaluate(() => chrome.downloads.search({ limit: 0 }))).length, 2, '已校验课程不能被全选后重复下载');
    assert.ok(logs.some(s => s.includes('confirm.click')), '必须真正执行确认点击');
    // 主动终止后台后再通过正常消息唤醒，避免只在检查器保活时看起来能用。
    let versionId;
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      const version = event.versions.find(v => v.scriptURL === worker.url() && v.status === 'activated');
      if (version) versionId = version.versionId;
    });
    await cdp.send('ServiceWorker.enable');
    for (let i = 0; i < 30 && !versionId; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(versionId, '必须找到本测试扩展的后台版本');
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    await cdp.send('ServiceWorker.disable');
    const restored = await batch.evaluate(() => chrome.runtime.sendMessage({ type: 'tmeet', op: 'journal.exported' }));
    assert.equal(restored.ok, true); assert.equal(restored.exported.filter(x => x.scope === 'own').length, 2);
    console.log('[SW] 后台被终止后通过正常消息唤醒，2条已验证下载记录仍可读取。');
    console.log('[PANEL] 真下载验证通过：2个DOCX，2次确认点击，正文校验通过。');
  } finally { await context.close(); }
});
