/* ============================================================
 * 站点适配层（v1.7.0）
 *
 * 为什么单独一个文件：
 *   腾讯会议的类名、按钮文案、弹窗结构会随发版变化。过去这些字符串散落在
 *   content.js / own-export.js / shared-content.js / shared-password.js 四处，
 *   一次改版要翻 4 个文件、很容易漏。现在所有站点相关的选择器与按钮文案只
 *   在本文件出现：
 *     - 站点改版 → 只改这里，其余文件零改动
 *     - 新增功能 → 引用已有常量，不再复制正则
 *
 * 纪律：
 *   1. 只用语义类名（.met-pagination、.met-form-check 这类组件库类名），
 *      禁止使用构建期哈希类名（data-v-xxxx、css-1a2b3c），它们每次发版都变。
 *   2. 本文件只放字符串与纯函数，不碰 document —— 这样 service worker、
 *      content script、单元测试都能直接加载，不依赖 DOM。
 *   3. 选择器实测自 v1.6.0 的运行快照；站点改版后需重新核对本文件。
 * ============================================================ */
(() => {
  'use strict';

  // ---------- 选择器 ----------
  const s = Object.freeze({
    // 录制目录列表
    recordRow: 'table tbody tr',
    recordRowAny: 'tr',
    recordMore: 'i[class*="more"]',
    recordMoreExact: 'i[aria-label="more--outlined"]',
    recordMoreLoose: 'i[class*="more--outlined"]',
    recordTitle: '[class*="titleContent"], [class*="titleBox"] span',
    recordFileCheck: 'label.met-form-check, label[name]',

    // 分页
    pageSizeHeader: '.met-pagination__select .met-dropdown__header',
    pageSizeValue: '.met-pagination__select .met-dropdown__value',
    pageSizeOption: 'li',
    pageChoose: '.met-pagination__pagechoose',
    pageItem: '.met-pagination__pagechoose li',
    pageActive: '.met-pagination__pagechooseitem_active',
    pageButton: '.met-pagination__pagechoosebtn',

    // hover 菜单
    menuOption: 'ul.met-list--option li, .met-tooltip li',
    // 仅用于失败现场取证，不能用此宽泛选择器点击页面。
    menuDiagnostic: 'li, button, a, [role="menuitem"], span, div',

    // 导出弹窗
    exportDialog: '[role="dialog"], .met-modal, .met-dialog, [class*="export"][class*="modal"], [class*="Export"][class*="Modal"]',
    dialogContainer: '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]',
    dialogClose: '[aria-label="Close"], [aria-label="关闭"], .met-modal__close, [class*="close"]',
    dialogTitle: '[data-course-title], .meeting-subject, .record-name',
    dialogFileId: '[data-file-id]',
    exportControl: 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]',
    controlLabel: 'label, [role="checkbox"], [role="radio"], .met-form-check',

    // 通用控件
    button: 'button, [role="button"], .met-btn',
    submitButton: 'button, [role="button"], .met-btn, input[type="submit"]',
    linkButton: 'button, a, [role="button"], .met-btn',
    pageInput: 'input',

    // 分享课程页
    video: 'video',
    transcriptTab: '[role="tab"], button, [class*="tab"], span',
    menuItem: '[role="menuitem"], li, button',
    passwordScope: 'form, [role="dialog"], [class*="password"], [class*="Password"], [class*="access"], [class*="Access"]'
  });

  // ---------- 按钮/菜单文案 ----------
  const text = Object.freeze({
    exportMenu: '导出',
    exportStart: /^(开始导出|确认导出|开始下载|导出)$/,
    // 只用来识别"这个按钮属于导出弹窗"，不能像 exportStart 那样接受单独的"导出"，
    // 否则工具栏上的导出按钮会把整个页面容器误判成第二个弹窗。
    dialogStart: /^(开始导出|确认导出)$/,
    exportDialogHint: /导出|开始下载/,
    closeDialog: /^(取消|关闭|完成|知道了)$/,
    sharedDownload: /^(下载|下载视频|下载录制|下载录制文件)$/,
    sharedDownloadOption: /^(视频(?:\s*[（(]?MP4[）)]?)?|下载视频|MP4)$/i,
    transcriptTab: /^(转写|逐字稿|文字转写)$/,
    passwordSubmit: /^(前往查看|确认|确定|访问|查看录制|进入录制|立即查看|进入)$/,
    recordingLogin: /扫码登录|请使用微信|手机号登录/
  });

  // ---------- 文件类型分类 ----------
  // 全项目只此一份：录制行名称、下载文件名、响应 mime 都走这里，避免三处正则漂移。
  const TRANSCRIPT_NAME = /转写|逐字稿|transcript|纪要|minutes|\.(docx?|txt|srt|vtt|pdf)$/i;
  const TRANSCRIPT_EXT = /^(docx?|txt|srt|vtt|pdf)$/i;
  // 通用扩展名：保留 v1.6 的行为（任意 1-8 位字母数字），只用于决定文件后缀，
  // 是否算"逐字稿"统一由 TRANSCRIPT_EXT 判断。
  const ANY_EXT = /\.([a-z0-9]{1,8})(?:$|[?#])/i;

  /** 下载文件名 → 'transcript' | 'video'（继续按真实扩展名/mime 判断，用于文件命名与目录归类） */
  function classify(name, mime) {
    const value = String(name == null ? '' : name);
    if (TRANSCRIPT_NAME.test(value)) return 'transcript';
    if (mime && /wordprocessingml|text\/plain|application\/pdf/i.test(mime)) return 'transcript';
    return 'video';
  }

  // 媒体扩展名：只有文件名本身就是视频/音频时才算 video。
  const MEDIA_EXT = /^(mp4|mov|m4v|avi|mkv|webm|flv|wmv|mpg|mpeg|ts|m4a|mp3|wav|aac|flac|ogg)$/i;

  /**
   * 录制列表「行」的类型判定（v1.8.6 起与下载文件名分开）。
   *
   * 判据来自录制列表的「文件大小」列，不看标题名字：
   *   - 显示「1个文件」（没有 MB/GB 数字）→ 只有逐字稿
   *   - 显示「1个文件(24.10MB)」这类带大小的 → 有视频（同时也还有逐字稿）
   *
   * 为什么不用名字：同一场录制在列表里常是两行 ——「转写_玫子」没大小、
   * 「玫子」带 24.10MB，会议号相同。旧版按名字里有没有「转写」判断，
   * 名字是会议主题的上百条被误判成 video，"仅逐字稿"只挑出 14 条。
   *
   * 注意：带视频的行也依然能导逐字稿（导出弹窗两个勾选项都在）。
   * 所以这里只决定"有没有视频"，导图灵时全部行都参与。
   * 下载后的文件命名/目录归类仍走 classify()，不受影响。
   */
  function classifyRecording(name, size) {
    // 有具体大小（24.10MB / 1.2GB / 512KB）即含视频；只有"1个文件"则是纯逐字稿。
    if (hasVideo(size)) return 'video';
    // 大小列缺失时（站点改版/草稿旧数据），退回看标题是否是媒体文件名。
    const match = ANY_EXT.exec(String(name == null ? '' : name));
    if (match && MEDIA_EXT.test(match[1])) return 'video';
    return 'transcript';
  }

  /** 这一行是否含视频文件：大小列里必须出现带 MB/GB/KB 单位的数字，光有"1个文件"的 1 不算。 */
  function hasVideo(size) {
    return /\d+(?:\.\d+)?\s*(?:MB|GB|KB)/i.test(String(size == null ? '' : size));
  }

  /**
   * 逐字稿标签的分组键：同一场录制在列表里常有两行 ——
   *   「转写_玫子」（无大小=纯逐字稿）与「玫子」（有大小=视频+逐字稿），会议号、时间相同。
   * 两者会议号+时间都一样 ⇒ 同一份，只导一条逐字稿即可。
   * 会议号缺失时退化为「名称+时间」；什么都没有就不合并，避免把不同场次误并。
   */
  function transcriptGroupKey(item) {
    const meeting = String(item?.meetingId || '').replace(/\s/g, '');
    const time = String(item?.time || '').trim();
    if (meeting && time) return `m:${meeting}|${time}`;
    if (meeting) return `m:${meeting}`;
    if (time && item?.name) return `n:${item.name}|${time}`;
    return `id:${item?.fileId || ''}`;
  }

  const rowHasVideo = (item) => item && (item.hasVideo === true || (item.hasVideo === undefined && hasVideo(item.size)));

  /**
   * 逐字稿标签去重：按 会议号+时间 合并同一场的多行，每组只留一条代表行。
   * 优先保留「纯逐字稿行」（无视频）——点它的导出菜单直接拿到逐字稿文件，
   * 不必进详情页，也不会误下成视频。
   *
   * 只有视频、没有转写行的场次（用户确认这种情况可能存在）：代表行就是视频行，
   * 照样留在逐字稿标签里，但标 transcriptVia='detail' —— 导出时进它的详情页抓逐字稿。
   * 纯逐字稿行标 'list' —— 清单页直接导出。
   *
   * 返回浅拷贝，不改动采集清单里的原始行（原始行还要给"视频"标签用）。
   */
  function mergeTranscriptRows(items) {
    const groups = new Map();
    for (const item of (Array.isArray(items) ? items : [])) {
      const key = transcriptGroupKey(item);
      const prev = groups.get(key);
      if (!prev) { groups.set(key, item); continue; }
      // 已经选中了纯逐字稿行就不再替换；只有当前是视频行、来的是逐字稿行时才升级。
      if (rowHasVideo(prev) && !rowHasVideo(item)) groups.set(key, item);
    }
    return [...groups.values()].map((item) => ({
      ...item,
      transcriptVia: rowHasVideo(item) ? 'detail' : 'list',
    }));
  }

  /** 中文标签，用于下载重命名与界面徽标 */
  function kindLabel(name, mime) {
    return classify(name, mime) === 'transcript' ? '逐字稿' : '视频';
  }

  function isTranscriptExt(ext) {
    return TRANSCRIPT_EXT.test(String(ext || ''));
  }

  /**
   * 从文件名或 URL 推断扩展名；文件名没有扩展名时按 mime 回退。
   * 供 background 重命名和 shared-service 命名共用。
   */
  function extensionOf(value, mime) {
    const match = ANY_EXT.exec(String(value || ''));
    if (match) return match[1].toLowerCase();
    return /wordprocessingml/.test(String(mime || '')) ? 'docx' : 'mp4';
  }

  globalThis.TMeetSite = Object.freeze({ s, text, classify, classifyRecording, hasVideo, transcriptGroupKey, mergeTranscriptRows, kindLabel, isTranscriptExt, extensionOf });
})();
