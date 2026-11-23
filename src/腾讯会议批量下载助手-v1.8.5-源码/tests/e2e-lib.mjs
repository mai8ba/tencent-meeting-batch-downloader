/**
 * 真浏览器 E2E 的公共脚手架（被 e2e-cdp / e2e-flow / e2e-multipage 复用）。
 *
 * 只做四件事：连调试端口、连 CDP、在页面里求值、收集断言结果。
 * 业务场景一律写在各自的脚本里，这里不掺任何腾讯会议的知识。
 */
import http from 'node:http';

export const PORT = Number(process.env.CDP_PORT || 9223);

/** 断言收集器：跑完统一汇总，避免第一处失败就中断后续检查。 */
export function createChecker() {
  const results = [];
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok, detail });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  → ' + detail : ''}`);
      return ok;
    },
    finish(browser, extra = '') {
      try { browser?.close(); } catch { /* 已关闭 */ }
      const failed = results.filter((r) => !r.ok);
      console.log('');
      if (extra) console.log(extra);
      console.log(`# 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
      if (failed.length) {
        for (const f of failed) console.log('  未通过：' + f.name + (f.detail ? ' → ' + f.detail : ''));
        process.exit(1);
      }
      process.exit(0);
    }
  };
}

export function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** 连调试端口。没起 Chrome 就返回 null，调用方打印 skipped 并 exit 0。 */
export async function openBrowser() {
  let version;
  try {
    version = await getJson('/json/version');
  } catch {
    console.log('skipped：127.0.0.1:' + PORT + ' 上没有调试端口，先按文件头的命令启动 Chrome。');
    process.exit(0);
  }
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  browser.version = version;
  return browser;
}

/** CDP 连接，带事件订阅（Fetch.requestPaused 必须边收边处理，不能只缓存）。 */
export function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const handlers = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const h of handlers) {
      if (h.method === msg.method && (h.sessionId === undefined || h.sessionId === msg.sessionId)) {
        try { h.fn(msg); } catch { /* 处理器自身异常不影响主流程 */ }
      }
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  return {
    ready,
    on(method, sessionId, fn) { handlers.push({ method, sessionId, fn }); },
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

/** 加载未打包扩展；已加载过就从 service worker 反查 id。 */
export async function loadExtension(browser, extDir) {
  try {
    return (await browser.send('Extensions.loadUnpacked', { path: extDir })).id;
  } catch {
    const targets = await getJson('/json/list');
    const sw = targets.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url));
    return sw ? new URL(sw.url).host : null;
  }
}

/** 在页面里跑表达式，等到真值为止（返回最后一次结果）。 */export async function waitFor(browser, expression, sessionId, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    const r = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    last = r.result?.value;
    if (last) return last;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  return last || null;
}

export async function evaluate(browser, expression, sessionId) {
  const r = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

/** 开一个页面并挂上 CDP 会话。 */
export async function openPage(browser, url = 'about:blank') {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  return { targetId, sessionId };
}

/**
 * 用 Fetch 拦截把某个路径的响应换成本地 HTML。
 * 返回 { served: () => 次数 }，便于确认拦截真的生效（不然测的是空气）。
 */
export async function interceptPage(browser, sessionId, matchPattern, getHtml) {
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: matchPattern, requestStage: 'Request' }] }, sessionId);
  let served = 0;
  browser.on('Fetch.requestPaused', sessionId, (msg) => {
    const { requestId, request } = msg.params;
    if (!new RegExp(matchPattern.replace(/^\*/, '').replace(/\*$/, '').replace(/\*/g, '[^]*')).test(request.url)) {
      void browser.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      return;
    }
    served += 1;
    void browser.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(getHtml(), 'utf8').toString('base64')
    }, sessionId).catch(() => {});
  });
  return { served: () => served };
}

/**
 * 把扩展的后台校时也接管掉。
 *
 * 为什么必须做：`authorize` 每次都要联网取时间（network-time 明确不缓存），
 * 只要公网抖一下，采集/导出就会以"无法校验联网时间"失败——
 * 测试要是依赖这个，就永远分不清是产品坏了还是网不好。
 * 这里给后台的 3 个时间源统一返回当前时间，测试从此与公网无关。
 */
export async function mockClock(browser) {
  const targets = await getJson('/json/list');
  const sw = targets.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url));
  if (!sw) return null;
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: sw.id, flatten: true });
  const sources = ['https://meeting.tencent.com/', 'https://www.qq.com/', 'https://www.baidu.com/'];
  await browser.send('Fetch.enable', {
    patterns: sources.map((u) => ({ urlPattern: u + '*', requestStage: 'Request' }))
  }, sessionId);
  browser.on('Fetch.requestPaused', sessionId, (msg) => {
    const { requestId } = msg.params;
    void browser.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Date', value: new Date().toUTCString() },
        { name: 'Age', value: '0' },
        { name: 'Content-Type', value: 'text/html; charset=utf-8' }
      ],
      body: ''
    }, sessionId).catch(() => {});
  });
  return sessionId;
}

/**
 * 把上一次跑留下的清单草稿清掉，保证每次从 0 开始。
 * 不清的话：工作台一打开就先显示上轮的 N 条，断言会假通过，随后 collect 又把它清空。
 */
export async function clearDraft(browser, extensionId) {
  const page = await openPage(browser, `chrome-extension://${extensionId}/popup.html`);
  await waitFor(browser, "document.readyState === 'complete'", page.sessionId, 8000);
  await evaluate(browser, "chrome.storage.local.remove('ownDraftV3').then(() => 'ok')", page.sessionId);
  await browser.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

/**
 * 清掉本地目录句柄（IndexedDB 里的 tmeet-local-files）。
 *
 * 为什么必须清：调试用的浏览器 profile 是复用的，里面常留着上一轮授权过的目录句柄。
 * 句柄还在但权限是 'prompt' 时，第 ② 步会正确地变成"需要你点一下恢复权限"，
 * 于是同时高亮第 ② 步和第 ③ 步 —— 那是**正确行为**，但会让"只高亮第 ③ 步"的断言误报。
 * 断言要测"没授权时该喊哪一步"，就得先把状态清干净。
 */
export async function clearDirectoryHandle(browser, extensionId) {
  const page = await openPage(browser, `chrome-extension://${extensionId}/batch.html`);
  await waitFor(browser, "document.readyState === 'complete'", page.sessionId, 8000);
  await evaluate(browser, `new Promise(resolve => {
    const request = indexedDB.deleteDatabase('tmeet-local-files');
    request.onsuccess = request.onerror = request.onblocked = () => resolve('ok');
  })`, page.sessionId);
  await browser.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

/** 把后台唤醒（没被唤醒时 /json/list 里看不到 service worker，接管时钟会落空）。 */
export async function wakeServiceWorker(browser, extensionId) {
  const page = await openPage(browser, `chrome-extension://${extensionId}/popup.html`);
  await waitFor(browser, "document.readyState === 'complete'", page.sessionId, 8000);
  await evaluate(browser,
    "chrome.runtime.sendMessage({ type: 'tmeet', op: 'license.status' }).then(() => 'ok').catch(() => 'err')", page.sessionId);
  await browser.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

/** 关掉所有残留的「我的录制」标签页：上轮跑挂留下的旧页面会干扰 tab 选择。 */
export async function closeRecordingTabs(browser) {
  const { targetInfos } = await browser.send('Target.getTargets');
  let closed = 0;
  for (const t of targetInfos) {
    if (t.type === 'page' && /meeting\.tencent\.com\/user-center\/meeting-record/.test(t.url)) {
      await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      closed += 1;
    }
  }
  return closed;
}
