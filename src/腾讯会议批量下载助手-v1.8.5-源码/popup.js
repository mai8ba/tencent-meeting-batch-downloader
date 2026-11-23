// 腾讯会议批量导出助手 - popup 设置页逻辑（v1.2）
const DEFAULTS = { pageSize: 30, clickDelay: 2500, maxConcurrent: 2, autoClassify: false };

async function init() {
  try {
    const data = await chrome.storage.local.get('config');
    const cfg = { ...DEFAULTS, ...(data.config || {}) };
    document.getElementById('clickDelay').value = Math.max(2500, cfg.clickDelay || 2500);
    document.getElementById('maxConcurrent').value = cfg.maxConcurrent;
    document.getElementById('autoClassify').checked = !!cfg.autoClassify;
  } catch (e) {
    console.error('读取配置失败', e);
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const cfg = {
    pageSize: 30,
    clickDelay: Math.max(2500, parseInt(document.getElementById('clickDelay').value, 10) || 2500),
    maxConcurrent: Math.min(8, Math.max(1, parseInt(document.getElementById('maxConcurrent').value, 10) || 3)),
    autoClassify: document.getElementById('autoClassify').checked,
  };
  try {
    await chrome.storage.local.set({ config: cfg });
    const btn = document.getElementById('save');
    btn.textContent = '已保存 ✅';
    btn.style.background = '#00b96b';
    setTimeout(() => {
      btn.textContent = '保存设置';
      btn.style.background = '#0d5cff';
    }, 1200);
  } catch (e) {
    console.error('保存配置失败', e);
  }
});
let licensed = false;
let dirCache = { at: 0, granted: false, name: '', error: '' };

// 下载文件夹授权状态：5 秒内复用，避免每次都去问离屏文档。
async function dirState(force = false) {
  if (!force && Date.now() - dirCache.at < 5000) return dirCache;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'local.status' });
    const dir = response?.ok ? response.dir : { granted: false, error: response?.error || '后台无响应' };
    dirCache = { at: Date.now(), granted: !!dir?.granted, name: dir?.name || '', error: dir?.error || '' };
  } catch (e) { dirCache = { at: Date.now(), granted: false, name: '', error: e.message }; }
  return dirCache;
}

async function refreshDir() {
  const dir = await dirState();
  const el = document.getElementById('dir-status');
  el.textContent = dir.granted
    ? `✅ 已授权：${dir.name || '下载文件夹'}`
    : `⚠️ 未授权下载文件夹${dir.error ? '（' + dir.error + '）' : '，打开工作台后可选'}`;
  el.className = 'dirline ' + (dir.granted ? 'ok' : 'warn');
}

function flash(message) {
  const el = document.getElementById('dir-status');
  el.textContent = message;
  el.className = 'dirline warn';
}

async function send(op, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'tmeet', op, ...extra });
  if (!result?.ok) throw new Error(result?.error || '后台无响应');
  return result;
}

// 工作台是主界面：采集、筛选、勾选、导出都在那边，popup 只做入口。
// 优先开在录制页里的面板：录制页保持前台，导出才不会被浏览器的
// 后台标签页节流 / Memory Saver 冻结拖到"看着像卡死"。
document.getElementById('open-batch').addEventListener('click', async () => {
  try {
    const res = await send('open-panel');
    if (res?.mode === 'tab' && res.url) await chrome.tabs.create({ url: res.url, active: true });
    window.close();
  } catch (e) { flash(e.message); }
});

document.getElementById('open-recordings').addEventListener('click', async () => {
  try { await send('open-recordings'); window.close(); }
  catch (e) { flash(e.message); }
});

document.getElementById('open-shared').addEventListener('click', async () => {
  try { await send('open-shared'); window.close(); }
  catch (e) { flash(e.message); }
});

document.getElementById('open-audit').addEventListener('click', async () => {
  try { await send('open-audit'); window.close(); }
  catch (e) { flash(e.message); }
});

TMeetLicenseUI.mount(document.getElementById('license-panel'), status => {
  licensed = status.active;
  void refreshDir();
});

void refreshDir();
setInterval(() => void refreshDir(), 2000);
init();
