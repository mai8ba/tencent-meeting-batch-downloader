/* 分享文本解析及转写转换；参考 txmeeting-extractor 的公开响应结构，独立实现。 */
(() => {
  'use strict';
  function shareURL(value) {
    try {
      const url = new URL(value);
      // 分享 id 允许 - 和 _（历史上出现过带连字符的 id），不能用 [A-Za-z0-9]+ 截断。
      if (url.protocol !== 'https:' || url.hostname !== 'meeting.tencent.com' || !/^\/(crm|cw|ct)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
      url.hash = '';
      return url;
    } catch { return null; }
  }
  function parse(text) {
    if (typeof text !== 'string' || text.length > 200000) throw new Error('文本过长，请分批导入');
    text = text.replace(/\r\n?/g, '\n').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\u3000/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n').replace(/\*\*|__/g, '').replace(/^[ \t]*[>#*-]+[ \t]*/gm, '')
      .replace(/^[ \t]*(?:\d+[.、)]|[（(]\d+[）)])[ \t]*(?=录制|日期|密码|访问码|提取码)/gm, '')
      .replace(/(^|[ \t])(?=(?:录制文件|录制|日期|密码|访问码|提取码)\s*[:：])/gm, '$1\n');
    const matches = [...text.matchAll(/https:\/\/meeting\.tencent\.com\/(?:crm|cw|ct)\/[A-Za-z0-9_-]+(?:\?[^\s<>"'`，。；）)\]]+)?/gi)];
    const result = [], byId = new Map();
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i], url = shareURL(match[0]);
      if (!url) continue;
      const before = text.slice(i ? matches[i - 1].index + matches[i - 1][0].length : 0, match.index);
      const after = text.slice(match.index + match[0].length, matches[i + 1]?.index ?? text.length).split(/\n\s*录制\s*[:：]/)[0];
      const titles = [...before.matchAll(/(?:^|\n)\s*录制\s*[:：]\s*([^\r\n]+)/g)];
      const dates = [...before.matchAll(/(?:^|\n)\s*日期\s*[:：]\s*([^\r\n]+)/g)];
      const password = ((after.match(/(?:密码|访问码|提取码)\s*[:：]\s*([^\s，。；]+)/) || [])[1] || url.searchParams.get('pwd') || '')
        .replace(/^[`"'（(\[]+|[`"'）)\]]+$/g, '');
      const id = url.pathname.split('/').filter(Boolean)[1];
      const item = { id, url: url.href, title: titles.at(-1)?.[1].trim() || `分享录制 ${id}`, date: dates.at(-1)?.[1].trim() || '', password: password.slice(0, 128) };
      if (byId.has(id)) {
        const old = byId.get(id);
        if (old.password && item.password && old.password !== item.password) throw new Error(`分享 ${id} 出现不同密码，请核对后再导入`);
        if (!old.password) old.password = item.password;
        if (old.title === `分享录制 ${id}`) old.title = item.title;
        if (!old.date) old.date = item.date;
      } else { result.push(item); byId.set(id, item); }
    }
    if (result.length > 200) throw new Error('每批最多 200 条，请分批处理');
    return result;
  }
  function safeName(value) {
    const clean = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90);
    return (!clean || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) ? '录制_' + clean : clean;
  }
  function mediaURL(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      if (!['tencent.com', 'qq.com', 'myqcloud.com', 'gtimg.com', 'qcloud.com'].some(d => u.hostname === d || u.hostname.endsWith('.' + d))) return null;
      if (/\.(m3u8|mpd)(?:$|\/)/i.test(u.pathname)) return null;
      return u.href;
    } catch { return null; }
  }
  function segments(paragraphs) {
    if (!Array.isArray(paragraphs)) return [];
    return paragraphs.map((p, index) => {
      const text = (Array.isArray(p.sentences) ? p.sentences : [])
        .flatMap(s => Array.isArray(s.words) ? s.words : []).map(w => typeof w.text === 'string' ? w.text : '').join('');
      return { id: String(p.pid || `${p.start_time}-${index}`), start: Math.max(0, Number(p.start_time) || 0),
        speaker: String(p.speaker?.user_name || ''), text };
    }).filter(p => p.text.trim());
  }
  function extract(path, data) {
    const out = {};
    if (!data || (data.code !== undefined && Number(data.code) !== 0)) return out;
    if (path.endsWith('/minutes/detail')) {
      const minutes = data.minutes || data.data?.minutes;
      if (Array.isArray(minutes?.paragraphs)) {
        out.segments = segments(minutes.paragraphs);
        out.complete = data.more === false || data.more === 0;
        // 未声明分页完成时不把片段当作全文。
        out.sawTranscript = true;
      }
    }
    const d = data.data || {};
    if (path.endsWith('/common-record-info')) {
      const records = Array.isArray(d.recordings) ? d.recordings : [];
      if (d.allow_download === true || d.allow_download === 1) out.allowVideo = true;
      else if (d.allow_download !== undefined && records.length > 0) out.allowVideo = false;
      // 密码验证前的公开元数据常返回空 recordings + false，不能误判成分享者禁止下载。
      out.videos = records.flatMap(r => {
        const url = mediaURL(r.download_url || r.video_url || r.recording_url || r.url);
        return url ? [{ url, name: String(r.recording_name || r.name || '') }] : [];
      });
      // 站点改字段名时，界面只会卡在"等待课程数据"；把实际键名带回控制页，便于定位而不是盲猜。
      if (!records.length && d.allow_download === undefined) {
        const keys = Object.keys(d).slice(0, 12).join(',');
        out.diagnostic = '录制信息未识别，响应字段：' + (keys || '（空）');
      }
    }
    if (path.endsWith('/get-multi-record-file')) {
      out.videos = (Array.isArray(d.file_list) ? d.file_list : []).filter(f => /video|mp4/i.test(String(f.file_type) + ' ' + f.format + ' ' + f.file_name))
        .map(f => ({ url: mediaURL(f.download_url), name: String(f.file_name || '') })).filter(f => f.url);
    }
    return out;
  }
  function stamp(ms) {
    const s = Math.floor(ms / 1000);
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
  }
  globalThis.TMeetShared = Object.freeze({ parse, shareURL, safeName, mediaURL, segments, extract, stamp });
})();
