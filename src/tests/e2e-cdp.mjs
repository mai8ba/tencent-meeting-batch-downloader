/**
 * 真浏览器 E2E：通过 Chrome DevTools Protocol 驱动一个带调试端口的 Chrome，
 * 加载未打包扩展，然后在真实页面里验证。
 *
 * 为什么要有这一层：
 *   node --test 里的 DOCX 校验用的是手写 DOMParser 桩，只覆盖了 ZIP store 模式；
 *   而腾讯导出的 docx 是 deflate 压缩的，真 DOMParser 的命名空间行为也和桩不同。
 *   这里用真实 Chrome 跑一遍，才能确认"逐字稿是否完整"的判定在线上环境成立。
 *
 * 用法：
 *   1) 先启动 Chrome（注意 MV3 从 Chrome 137 起禁用 --load-extension，必须用下面这行）：
 *      chrome.exe --remote-debugging-port=9223 --user-data-dir=C:/tmeet-e2e \
 *        --enable-unsafe-extension-debugging --no-first-run about:blank
 *   2) node tests/e2e-cdp.mjs
 *
 * 退出码：0 全通过 / 1 有失败 / 0 且打印 skipped（没找到调试端口）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearDraft, closeRecordingTabs, clearDirectoryHandle } from './e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..', '..', '成品-v1.8.3');
const PORT = Number(process.env.CDP_PORT || 9223);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? '  → ' + detail : ''}`);
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** 一条 CDP 连接，支持 flatten 模式的 sessionId。 */
function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  return {
    ready,
    events,
    send(method, params = {}, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { try { ws.close(); } catch { /* 已关闭 */ } }
  };
}

/** 等某个页面里的表达式出结果（页面加载有延迟）。 */
async function waitFor(client, expression, sessionId, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result?.value) return result.value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function main() {
  // ---------- 0. 端口 ----------
  let version;
  try {
    version = await getJson('/json/version');
  } catch {
    console.log('skipped：127.0.0.1:' + PORT + ' 上没有调试端口，先按文件头的命令启动 Chrome。');
    process.exit(0);
  }
  check('连上调试端口', /(?:Chrome|Chromium|Edg)\//.test(version.Browser || ''), version.Browser);

  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  // ---------- 1. 加载扩展 ----------
  let extensionId = null;
  try {
    const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
    extensionId = loaded.id;
  } catch (e) {
    // 已经加载过就会报错，从 service worker 里反查 id
    const targets = await getJson('/json/list');
    const sw = targets.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url));
    extensionId = sw ? new URL(sw.url).host : null;
    check('加载扩展（或复用已加载的）', !!extensionId, e.message);
  }
  check('扩展已加载', !!extensionId, String(extensionId));
  if (!extensionId) return finish(browser);

  // 先清场：别让上一个 E2E 留下的清单草稿/录制页标签混进来，
  // 否则"未连接时第 3 步应该提示先做第 1 步"这类断言会被上一轮的 3 条数据顶掉。
  await closeRecordingTabs(browser);
  await clearDraft(browser, extensionId);
  await clearDirectoryHandle(browser, extensionId);

  // ---------- 2. 打开工作台 ----------
  const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/batch.html` });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);

  const ready = await waitFor(browser, "document.readyState === 'complete' && !!document.querySelector('.step')", sessionId);
  check('工作台页面渲染出步骤条', !!ready);

  // ---------- 3. 五步结构 ----------
  const structure = await browser.send('Runtime.evaluate', {
    expression: `(() => {
      const steps = [...document.querySelectorAll('.stepbar .step')];
      return {
        count: steps.length,
        numbers: steps.map(s => s.querySelector('.step-no').textContent.trim()),
        texts: steps.map(s => s.querySelector('.step-text strong').textContent.trim()),
        ids: steps.map(s => s.id),
      };
    })()`,
    returnByValue: true
  }, sessionId);
  const s = structure.result.value;
  // 去掉本地正文校验后不再需要"选文件夹"，流程从五步收敛为四步。
  check('顶部操作带正好 4 个步骤块', s.count === 4, '实际 ' + s.count);
  check('编号是 1 2 3 4', s.numbers.join(',') === '1,2,3,4', s.numbers.join(','));
  check('顺序：打开录制主页 → 采集清单 → 开始导出 → 打开下载目录',
    s.texts.join('|') === '打开录制主页|采集清单|开始导出|打开下载目录', s.texts.join('|'));
  check('第 1 步是专门的开录制页按钮', s.ids[0] === 'btnOpenRecordings', s.ids[0]);

  // ---------- 4. 未连接时的状态机 ----------
  const state = await browser.send('Runtime.evaluate', {
    expression: `(() => {
      const get = id => document.getElementById(id);
      return {
        openGo: get('btnOpenRecordings').classList.contains('step-go'),
        openDisabled: get('btnOpenRecordings').getAttribute('aria-disabled') === 'true',
        collectDisabled: get('btnCollect').getAttribute('aria-disabled') === 'true',
        collectHint: get('collectSub').textContent,
        exportDisabled: get('btnExport').getAttribute('aria-disabled') === 'true',
        exportHint: get('exportSub').textContent,
        folderDisabled: get('btnOpenFolder').getAttribute('aria-disabled') === 'true',
      };
    })()`,
    returnByValue: true
  }, sessionId);
  const st = state.result.value;
  check('未连接时第 1 步是蓝色高亮（告诉用户先点它）', st.openGo === true);
  check('第 1 步可点（不是灰的）', st.openDisabled === false);
  check('未连接时第 3 步禁用', st.collectDisabled === true);
  check('第 3 步副标题写明要先做第 1 步', /第 1 步/.test(st.collectHint), st.collectHint);
  check('未连接时第 4 步禁用', st.exportDisabled === true);
  check('第 5 步打开下载目录始终可用', st.folderDisabled === false);

  // ---------- 5. 逐字稿完整性判定（真实 Chrome + 真实 DOMParser + deflate） ----------
  // 在页面里现场造 DOCX：deflate 压缩的 ZIP，和腾讯导出的结构一致。
  const probe = await browser.send('Runtime.evaluate', {
    expression: `(async () => {
      const enc = new TextEncoder();
      const table = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
      const crc = d => { let c = 0xffffffff; for (const b of d) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

      async function deflate(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }

      async function zip(files) {
        const locals = [], centrals = [];
        let offset = 0, centralSize = 0;
        for (const [name, body] of Object.entries(files)) {
          const n = enc.encode(name), raw = enc.encode(body);
          const packed = await deflate(raw), sum = crc(raw);
          const h = new Uint8Array(30 + n.length), v = new DataView(h.buffer);
          v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
          v.setUint16(8, 8, true);                      // deflate，和腾讯导出一致
          v.setUint16(12, 0x21, true);
          v.setUint32(14, sum, true); v.setUint32(18, packed.length, true); v.setUint32(22, raw.length, true);
          v.setUint16(26, n.length, true); h.set(n, 30);
          const c = new Uint8Array(46 + n.length), d = new DataView(c.buffer);
          d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
          d.setUint16(10, 8, true); d.setUint16(14, 0x21, true);
          d.setUint32(16, sum, true); d.setUint32(20, packed.length, true); d.setUint32(24, raw.length, true);
          d.setUint16(28, n.length, true); d.setUint32(42, offset, true); c.set(n, 46);
          locals.push(h, packed); centrals.push(c);
          offset += h.length + packed.length; centralSize += c.length;
        }
        const end = new Uint8Array(22), d = new DataView(end.buffer);
        d.setUint32(0, 0x06054b50, true); d.setUint16(8, centrals.length, true); d.setUint16(10, centrals.length, true);
        d.setUint32(12, centralSize, true); d.setUint32(16, offset, true);
        const out = new Uint8Array(offset + centralSize + 22);
        let at = 0; for (const b of [...locals, ...centrals, end]) { out.set(b, at); at += b.length; }
        return out;
      }

      async function makeDocx(lines) {
        const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
        const body = lines.map(t => '<w:p><w:r><w:t xml:space="preserve">' + esc(t) + '</w:t></w:r></w:p>').join('');
        return zip({
          '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr/></w:body></w:document>'
        });
      }

      const file = (bytes, name) => new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const out = {};

      // 空模板：腾讯只给了页脚，没有正文
      out.empty = await TMeetFiles.inspect(file(await makeDocx([]), 'empty.docx'), 'transcript');

      // 只生成了标题和一句开场：真实数据里最常见的残缺形态
      out.short = await TMeetFiles.inspect(file(await makeDocx(['私域变现3大抓手', '2026-10-29', '大家好，今天聊私域。']), 'short.docx'), 'transcript');

      // 正常逐字稿：20 段，每段带时间戳
      const lines = ['何成兵商业操作系统 V1.0 第六课'];
      for (let i = 0; i < 20; i++) lines.push('[' + String(i).padStart(2, '0') + ':12] 麦爸', '我们来看一下这个会员工作台的四个板块，认知、成交实战营、私教 MVP 和战略班，每一个都要单独跑通。');
      out.full = await TMeetFiles.inspect(file(await makeDocx(lines), 'full.docx'), 'transcript');

      // 截断文件
      const good = await makeDocx(lines);
      out.broken = null;
      try { await TMeetFiles.inspect(file(good.slice(0, good.length - 40), 'broken.docx'), 'transcript'); }
      catch (e) { out.broken = e.message; }

      return out;
    })()`,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);

  if (probe.exceptionDetails) {
    check('DOCX 探针可执行', false, JSON.stringify(probe.exceptionDetails.exception?.description || probe.exceptionDetails.text));
  } else {
    const r = probe.result.value;
    check('空模板被判失败（不是"正文非空就算过"）', r.empty.valid === false && /空Word模板/.test(r.empty.reason), JSON.stringify(r.empty));
    check('只生成标题的残片被判失败', r.short.valid === false && /正文只有 \d+ 字/.test(r.short.reason), JSON.stringify(r.short));
    check('残片的提示里带"确认已生成完整"', /确认逐字稿已生成完整/.test(r.short.reason || ''), r.short.reason);
    check('正常逐字稿通过，且报出字数/段落数', r.full.valid === true && /正文 \d+ 字 \/ \d+ 段/.test(r.full.reason), JSON.stringify(r.full));
    check('正常样本字数 > 600（deflate 解压后能读全）', r.full.characters > 600, String(r.full.characters));
    check('截断的 docx 直接报错，不当成有效', typeof r.broken === 'string' && /Word ZIP|索引|截断/.test(r.broken), String(r.broken));
  }

  // ---------- 6. 页面没有 JS 异常 ----------
  const errors = browser.events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown' && e.sessionId === sessionId) ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' && e.sessionId === sessionId)
  );
  check('工作台没有未捕获的 JS 异常', errors.length === 0,
    errors.slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 200)).join(' | '));

  // ---------- 7. 弹窗入口 ----------
  const { targetId: popupTarget } = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
  const popupAttach = await browser.send('Target.attachToTarget', { targetId: popupTarget, flatten: true });
  await browser.send('Runtime.enable', {}, popupAttach.sessionId);
  const popupOk = await waitFor(browser, "!!document.getElementById('open-batch')", popupAttach.sessionId, 5000);
  check('弹窗里有「打开批量下载工作台」入口', !!popupOk);

  await browser.send('Target.closeTarget', { targetId: popupTarget });
  await browser.send('Target.closeTarget', { targetId });
  return finish(browser);
}

function finish(browser) {
  browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`# 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log('  未通过：' + f.name + (f.detail ? ' → ' + f.detail : ''));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('E2E 异常终止：' + e.message); process.exit(1); });
