/* 站点适配层契约测试：
 * 1) 类型分类只有一份实现，名称/mime 两条输入都要对；
 * 2) 适配层里的每个选择器，都必须能命中"按真实页面结构搭出来的快照"对应节点。
 *    腾讯会议改版时，第一个失败的就是这里 —— 不用等用户反馈"点了没反应"。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dom = require('./mini-dom.cjs');

function adapter() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'site-adapter.js'), 'utf8'), context);
  return context.TMeetSite;
}
const site = adapter();

test('类型分类：扩展名、中文关键词、mime 三条路径归一', () => {
  assert.equal(site.classify('私域变现3大抓手.docx'), 'transcript');
  assert.equal(site.classify('第3课 转写'), 'transcript');
  assert.equal(site.classify('第3课 会议纪要'), 'transcript');
  assert.equal(site.classify('course.transcript.txt'), 'transcript');
  assert.equal(site.classify('第3课.mp4'), 'video');
  assert.equal(site.classify('第3课 回放'), 'video');
  assert.equal(site.classify(''), 'video');
  // 文件名没有扩展名时，靠 mime 兜底（腾讯的下载接口经常只给 Content-Type）
  assert.equal(site.classify('下载', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'transcript');
  assert.equal(site.classify('下载', 'video/mp4'), 'video');
  assert.equal(site.kindLabel('课程.docx'), '逐字稿');
  assert.equal(site.kindLabel('课程.mp4'), '视频');
  assert.equal(site.isTranscriptExt('DOCX'), true);
  assert.equal(site.isTranscriptExt('mp4'), false);
  assert.equal(site.extensionOf('课程.DOCX', ''), 'docx');
  assert.equal(site.extensionOf('https://cdn.qq.com/a.mp4?sign=1', ''), 'mp4');
  assert.equal(site.extensionOf('下载', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
  assert.equal(site.extensionOf('下载', ''), 'mp4');
});

test('录制行分类 v1.8.6：按"文件大小"列判有没有视频，不看名字', () => {
  // 没大小（"1个文件"）→ 纯逐字稿，哪怕名字像会议主题、没有"转写"二字
  assert.equal(site.classifyRecording('10:30何禧和总云咖啡沟通', ''), 'transcript');
  assert.equal(site.classifyRecording('眼余鱼过AI使用', ''), 'transcript');
  assert.equal(site.classifyRecording('私域变现3大抓手', ''), 'transcript');
  // 有 MB/GB 数字 → 含视频（同时也还有逐字稿），名字带不带"转写"都一样
  assert.equal(site.classifyRecording('玫子', '24.10MB'), 'video');
  assert.equal(site.classifyRecording('何老师 MVP', '318.00MB'), 'video');
  assert.equal(site.classifyRecording('盖老师答疑', '1.20GB'), 'video');
  assert.equal(site.classifyRecording('转写_某课', '512KB'), 'video');
  // hasVideo 与分类保持同一判据
  assert.equal(site.hasVideo('24.10MB'), true);
  assert.equal(site.hasVideo(''), false);
  assert.equal(site.hasVideo('1个文件'), false);
  // 大小列缺失时退回看标题扩展名
  assert.equal(site.classifyRecording('第3课.mp4', ''), 'video');
  // 下载文件名仍走原 classify，按真实扩展名分目录，不受影响
  assert.equal(site.classify('课程_视频.mp4'), 'video');
  assert.equal(site.classify('课程_逐字稿.docx'), 'transcript');
});

test('录制列表快照：行、更多图标、标题、唯一标识都能命中', () => {
  const more = dom.node('i', { className: 'met-icon more--outlined', attrs: { 'aria-label': 'more--outlined' } });
  const title = dom.node('div', { className: 'titleContent', text: '私域变现3大抓手' });
  const check = dom.node('label', { className: 'met-form-check', attrs: { name: 'file-9' } });
  const row = dom.node('tr', { children: [
    dom.node('td', { children: [check] }),
    dom.node('td', { children: [title] }),
    dom.node('td', { text: '会议号：448 436 389' }),
    dom.node('td', { text: '2026-10-23 10:00' }),
    dom.node('td', { text: '128.5 MB' }),
    dom.node('td', { children: [more] })
  ] });
  const doc = dom.createDocument([dom.node('table', { children: [dom.node('tbody', { children: [row] })] })]);

  const rows = dom.queryAll(doc.documentElement, site.s.recordRow);
  assert.equal(rows.length, 1);
  assert.equal(rows[0], row);
  assert.equal(row.querySelector(site.s.recordMore), more);
  assert.equal(row.querySelector(site.s.recordMoreExact), more);
  assert.equal(row.querySelector(site.s.recordTitle), title);
  assert.equal(row.querySelector(site.s.recordFileCheck).getAttribute('name'), 'file-9');
});

test('分页快照：每页条数、页码、翻页方向按钮都能命中', () => {
  const value = dom.node('div', { className: 'met-dropdown__value', text: '30 条/页' });
  const header = dom.node('div', { className: 'met-dropdown__header' });
  const active = dom.node('li', { className: 'met-pagination__pagechooseitem_active', text: '2' });
  const arrow = dom.node('i', { attrs: { 'aria-label': 'arrowright' } });
  const next = dom.node('button', { className: 'met-pagination__pagechoosebtn', children: [arrow] });
  const choose = dom.node('div', { className: 'met-pagination__pagechoose', children: [active, next] });
  const doc = dom.createDocument([dom.node('div', { className: 'met-pagination__select', children: [header, value] }), choose]);

  assert.equal(doc.querySelector(site.s.pageSizeHeader), header);
  assert.equal(doc.querySelector(site.s.pageSizeValue), value);
  assert.equal(Number.parseInt(doc.querySelector(site.s.pageSizeValue).innerText, 10), 30);
  assert.equal(doc.querySelector(site.s.pageActive), active);
  assert.equal(doc.querySelector(site.s.pageItem), active);
  // 关闭翻页控件（只剩一页）时 pageChoose 仍应能识别
  assert.equal(doc.querySelector(site.s.pageChoose), choose);
});

test('导出弹窗快照：弹窗、标题、文件标识、勾选项、开始按钮都能命中', () => {
  const title = dom.node('div', { className: 'meeting-subject', text: '私域变现3大抓手' });
  const fileId = dom.node('div', { attrs: { 'data-file-id': 'file-9' } });
  const input = dom.node('input', { type: 'checkbox', attrs: { type: 'checkbox' }, checked: true });
  const label = dom.node('label', { text: '逐字稿（DOCX）', children: [input] });
  const cancel = dom.node('button', { text: '取消' });
  const start = dom.node('button', { text: '开始导出' });
  const close = dom.node('span', { className: 'met-modal__close' });
  const dialog = dom.node('div', { className: 'met-modal', children: [title, fileId, label, cancel, start, close] });
  const doc = dom.createDocument([dialog]);

  assert.equal(doc.querySelector(site.s.exportDialog), dialog);
  assert.equal(doc.querySelector(site.s.dialogTitle), title);
  assert.equal(doc.querySelector(site.s.dialogFileId).getAttribute('data-file-id'), 'file-9');
  assert.equal(doc.querySelector(site.s.exportControl), input);
  assert.equal(doc.querySelector(site.s.controlLabel), label);
  assert.equal(doc.querySelector(site.s.dialogClose), close);
  assert.ok(site.text.exportStart.test('开始导出'));
  assert.ok(site.text.exportStart.test('导出'));
  assert.equal(site.text.exportStart.test('开始导出并关闭'), false);
  assert.ok(site.text.closeDialog.test('取消'));
  assert.ok(site.text.exportDialogHint.test(dialog.innerText));
});

test('分享课程页快照：下载按钮、访问密码框、转写标签、清晰度选项都能命中', () => {
  const video = dom.node('video');
  const input = dom.node('input', { attrs: { placeholder: '请输入访问密码' } });
  const submit = dom.node('button', { text: '前往查看' });
  const form = dom.node('form', { children: [input, submit] });
  const tab = dom.node('div', { attrs: { role: 'tab' }, text: '转写' });
  const option = dom.node('li', { text: '视频（MP4）' });
  const download = dom.node('button', { text: '下载' });
  const doc = dom.createDocument([video, form, tab, option, download]);

  assert.equal(doc.querySelector(site.s.video), video);
  assert.equal(doc.querySelector(site.s.pageInput), input);
  assert.equal(doc.querySelector(site.s.submitButton), submit);
  assert.equal(doc.querySelector(site.s.passwordScope), form);
  // transcriptTab / menuItem / linkButton 是"宽选择器 + 文案过滤"，这里验证真实用法：
  // 先按选择器取候选，再用文案正则挑出目标节点。
  const tabs = dom.queryAll(doc.documentElement, site.s.transcriptTab);
  assert.equal(tabs.find(el => site.text.transcriptTab.test(el.innerText.trim())), tab);
  const items = dom.queryAll(doc.documentElement, site.s.menuItem);
  assert.equal(items.find(el => site.text.sharedDownloadOption.test(el.innerText.trim())), option);
  const links = dom.queryAll(doc.documentElement, site.s.linkButton);
  assert.equal(links.find(el => site.text.sharedDownload.test(el.innerText.trim())), download);
  assert.ok(site.text.sharedDownload.test('下载录制文件'));
  assert.ok(site.text.sharedDownloadOption.test('视频（MP4）'));
  assert.ok(site.text.transcriptTab.test('逐字稿'));
  assert.ok(site.text.passwordSubmit.test('前往查看'));
});

test('逐字稿标签去重：会议号+时间相同合并成一条，优先留纯逐字稿行走清单页快路', () => {
  // 同一场录制的两行：视频行（有大小）与转写行（无大小），会议号、时间都一样。
  const rows = [
    { fileId: 'v1', name: '玫子', type: 'video', meetingId: '448436389', time: '2026-11-20 10:00', hasVideo: true, size: '24.10MB' },
    { fileId: 't1', name: '转写_玫子', type: 'transcript', meetingId: '448436389', time: '2026-11-20 10:00', hasVideo: false },
  ];
  const merged = site.mergeTranscriptRows(rows);
  assert.equal(merged.length, 1, '两行合成一条');
  assert.equal(merged[0].fileId, 't1', '优先保留纯逐字稿行');
  assert.equal(merged[0].transcriptVia, 'list', '走清单页快路，不进详情页');
});

test('逐字稿去重：只有视频没转写的场次也保留，标 detail 进详情页', () => {
  const rows = [
    { fileId: 'v2', name: '只有视频的课', type: 'video', meetingId: '123456789', time: '2026-11-21 09:30', hasVideo: true, size: '18.00MB' },
  ];
  const merged = site.mergeTranscriptRows(rows);
  assert.equal(merged.length, 1, '视频行照样出现在逐字稿标签');
  assert.equal(merged[0].transcriptVia, 'detail', '导出时进详情页抓逐字稿');
});

test('逐字稿去重：会议号或时间不同绝不合并，避免导错场次', () => {
  const rows = [
    { fileId: 'a', name: 'A视频', type: 'video', meetingId: '111111111', time: '2026-11-20 10:00', hasVideo: true },
    { fileId: 'b', name: 'B转写', type: 'transcript', meetingId: '222222222', time: '2026-11-20 10:00', hasVideo: false },
    { fileId: 'c', name: 'C转写', type: 'transcript', meetingId: '111111111', time: '2026-11-22 10:00', hasVideo: false },
  ];
  const merged = site.mergeTranscriptRows(rows);
  assert.equal(merged.length, 3, '会议号不同、时间不同的都不合并');
});

test('逐字稿去重不改原始行（视频标签还要用），合并结果是浅拷贝', () => {
  const row = { fileId: 'v3', name: '课', type: 'video', meetingId: '999', time: 't', hasVideo: true };
  const merged = site.mergeTranscriptRows([row]);
  assert.notEqual(merged[0], row, '返回的是拷贝');
  assert.equal(row.transcriptVia, undefined, '原始行没被写上标记');
  assert.equal(row.type, 'video', '原始行类型没被改');
});

test('逐字稿分组键：会议号带空格要归一，缺会议号时退回名称+时间', () => {
  assert.equal(site.transcriptGroupKey({ meetingId: '448 436 389', time: '2026-11-20 10:00' }),
    'm:448436389|2026-11-20 10:00');
  assert.equal(site.transcriptGroupKey({ name: '无会议号', time: '2026-11-20 10:00' }),
    'n:无会议号|2026-11-20 10:00');
});
