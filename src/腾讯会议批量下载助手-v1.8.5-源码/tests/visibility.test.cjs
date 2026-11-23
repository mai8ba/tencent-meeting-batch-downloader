/* 页面可见性回归（2026-10-30 真机故障）
 *
 * 现场：导出跑到一半报「更多菜单未找到可点击的"导出"」，现场诊断里
 *   pageHidden: true，visibleMenu 里全是页面其他下拉（语言「中文」、每页「30」、顶部导航），
 *   一个菜单项都没有 ⇒ 菜单压根没弹出来。
 *
 * 根因：腾讯会议的「更多」菜单是 **hover 才渲染**的（DOM 里平时就没有「导出」这项）。
 * 页面处于隐藏状态（标签页在后台 / 窗口最小化）时 hover 根本不触发 → 菜单不弹 →
 * 找不到「导出」→ 整批卡住。后台标签页还会被 Chrome 节流、甚至 Memory Saver 冻结。
 *
 * 这组用例锁三件事：
 *   1) 导出前必须确保录制页在前台（必要时让后台把 tab 拉过去）；
 *   2) 导出中途页面被切走 → 挂起等待，而不是直接失败；
 *   3) 报错必须写明"当时不在前台"，用户才知道下一步怎么做。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('导出链路必须处理"页面不可见"：先切前台，再挂起等待', () => {
  const src = read('content.js');
  assert.match(src, /function isVisible\(\)/, '必须有可见性判断');
  assert.match(src, /function waitForVisible\(/, '必须提供"等页面回到前台"的挂起机制');
  assert.match(src, /async function focusRecordingTab\(\)/, '必须能在页面不可见时把录制页拉到前台');
  // 导出开始处：不可见就切前台 + 等
  assert.match(src, /if \(!isVisible\(\)\) \{[\s\S]{0,400}?focusRecordingTab\(\)/,
    '导出开始时必须先把录制页切到前台');
  // 循环里：每一项之前都检查
  assert.match(src, /for \(const entry of pending\) \{[\s\S]{0,500}?if \(!isVisible\(\)\)/,
    '导出循环里每一项开始前都要确保页面可见');
  // triggerExport 入口也要兜一层
  assert.match(src, /async function triggerExport\([\s\S]{0,300}?if \(!isVisible\(\)\)/,
    'triggerExport 入口必须再兜一层可见性');
});

test('挂起时必须告诉用户"切回来会自动继续"，而不是静默等待', () => {
  const src = read('content.js');
  assert.match(src, /已暂停：录制页不在前台/, '挂起时必须说明原因和恢复方式');
  assert.match(src, /切回「我的录制」就会自动继续/, '必须告诉用户切回来就会自动继续');
  assert.match(src, /录制页已回到前台，继续导出/, '恢复后要有反馈');
});

test('后台要提供 focus-recording-tab：content script 拿不到 chrome.tabs', () => {
  const src = read('background.js');
  assert.match(src, /'focus-recording-tab'/, '缺 focus-recording-tab：录制页不可见时没人能把它拉回前台');
  assert.match(src, /chrome\.tabs\.update\(sender\.tab\.id, \{ active: true \}\)/, '必须激活调用方所在的录制页标签');
  assert.match(src, /chrome\.windows\.update\(/, '窗口最小化时也要唤回来');
  assert.match(src, /state: 'normal'/, '最小化的窗口要恢复成正常状态');
  // 安全：只允许内容脚本（录制页）调用
  assert.match(src, /if \(!Number\.isInteger\(sender\.tab\?\.id\)\) throw new Error\('不允许的调用来源'\)/,
    '必须有来源校验');
});

test('菜单找不到的报错要写明当时不在前台（这是最关键的自救提示）', () => {
  const src = read('content.js');
  assert.match(src, /更多菜单未找到可点击的“导出”/, '保留原报错文案');
  assert.match(src, /document\.visibilityState === 'hidden' \? '（录制页当时不在前台/, '报错要补上"当时不在前台"');
  assert.match(src, /站点菜单不会弹出/, '要解释原因：菜单需要页面在前台');
});

test('不可见的判定要宽容：拿不到 visibilityState 时按可见处理', () => {
  const src = read('content.js');
  assert.match(src, /return !state \|\| state === 'visible';/,
    '某些测试环境没有 visibilityState，不能因此把用户的导出平白挂起');
});
