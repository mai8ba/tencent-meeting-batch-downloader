/* 本地目录权限只由用户点击授予；不上传文件，不删除或改写下载文件。 */
(() => {
  'use strict';
  const MAX = 64 * 1024 * 1024;
  // 逐字稿正文少于这个字数，基本可以判定是「只生成了标题」而不是真实内容。
  // 一节课哪怕只有一分钟，正常转写也在几百字量级。
  const MIN_TRANSCRIPT_CHARS = 50;
  async function database() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('tmeet-local-files', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('settings');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async function directory(value) {
    const db = await database();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', value ? 'readwrite' : 'readonly');
      const request = value ? tx.objectStore('settings').put(value, 'directory') : tx.objectStore('settings').get('directory');
      tx.oncomplete = () => resolve(value || request.result); tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  }
  async function root() {
    const handle = await directory();
    if (!handle || await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('请先选择下载文件夹并授予读取权限（插件面板第 ② 步，或“选择下载文件夹并授权”页）');
    return handle;
  }
  /** 只查授权状态，不做任何文件读取；用于面板提前提示，而不是等导出时才报错。 */
  async function status() {
    try {
      const handle = await directory();
      if (!handle) return { granted: false, name: '', permission: 'none' };
      const permission = await handle.queryPermission({ mode: 'read' });
      // 'prompt' = 句柄还在，但浏览器要一次用户点击才能恢复读取权限。
      return { granted: permission === 'granted', name: handle.name, permission, needsGesture: permission === 'prompt' };
    } catch (e) { return { granted: false, name: '', permission: 'error', error: e.message }; }
  }
  /**
   * 用内存里的句柄直接试读一次，确认"浏览器真的给了读取权限"。
   * 不经过 IndexedDB：避免"存进去了但读出来没权限"被当成授权成功。
   */
  async function probe(handle) {
    if (!handle) return { ok: false, permission: 'none', reason: '没有拿到目录句柄' };
    let permission = 'unknown';
    try {
      permission = await handle.queryPermission({ mode: 'read' });
      if (permission !== 'granted') return { ok: false, permission, reason: '浏览器未授予读取权限（' + permission + '）' };
      for await (const [name] of handle.entries()) return { ok: true, permission, name };
      return { ok: true, permission, name: '' };
    } catch (e) { return { ok: false, permission, reason: e.message }; }
  }
  /** 去掉 Windows 重名后缀后的小写文件名：逐字稿.docx 与 逐字稿 (1).docx 视为同名。 */
  const baseName = name => String(name || '').replace(/\s*\(\d+\)(?=\.[^.]+$)/g, '').toLowerCase();

  /**
   * 兜底查找：按"去掉重名后缀"的文件名在所选目录（及一层子目录）里再找一次。
   * 覆盖两种常见情况：Windows 重名生成的 "名称 (1).docx"，以及文件被挪进了子目录。
   * 扫太多文件会拖慢校验，所以有上限。
   */
  async function findByBaseName(handle, wanted) {
    const target = baseName(wanted);
    if (!target) return null;
    const hits = [];
    let scanned = 0;
    async function walk(dir, depth) {
      for await (const entry of dir.values()) {
        if (++scanned > 20000 || hits.length > 1) return;
        if (entry.kind === 'file') {
          if (baseName(entry.name) === target) hits.push(entry);
        } else if (depth > 0) {
          try { await walk(await dir.getDirectoryHandle(entry.name), depth - 1); } catch { /* 读不到就跳过 */ }
        }
      }
    }
    await walk(handle, 1);
    if (hits.length !== 1) return null;   // 0 个=没找到；多个=有歧义，不敢乱认
    try { return await hits[0].getFile(); } catch { return null; }
  }

  async function locate(path) {
    const handle = await root(), parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    // 完整路径按所选根目录截断；同名子目录不通过 basename 猜测。
    const absolute = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(path);
    const indices = absolute ? parts.flatMap((p, i) => p === handle.name ? [i + 1] : []) : [];
    const starts = indices.length ? indices : [0];
    const matches = [];
    for (const start of starts) {
      try {
        let h = handle;
        for (const part of parts.slice(start, -1)) { if (part === '..' || part === '.') throw new Error('路径无效'); h = await h.getDirectoryHandle(part); }
        matches.push(await (await h.getFileHandle(parts.at(-1))).getFile());
      } catch { /* 尝试相同根名称的下一处 */ }
    }
    if (matches.length > 1) throw new Error('本地目录名称匹配存在歧义，请选择更具体的下载目录');
    if (matches.length === 1) return matches[0];
    // 兜底：同名文件被 Windows 加了 "(1)" 后缀、或被挪进了子目录 —— 按去掉后缀的名字再找一次。
    const loose = await findByBaseName(handle, parts.at(-1)).catch(() => null);
    if (loose) return loose;
    // 报错必须带上"文件实际在哪儿"：目录句柄不暴露真实路径，
    // 插件只能从下载记录里反推，用户才能知道该重新授权哪个文件夹。
    throw new Error('本地文件不存在或不在所选下载目录：' + parts.at(-1) +
      '（实际下载路径：' + path + '）。请确认授权的是浏览器实际下载的文件夹，且文件没有被移动、改名或删除');
  }

  /**
   * 目录一致性实测：给一个绝对路径，返回授权目录里能不能找到它。
   * 用于"授权完立刻验证"，比等导出失败再看报错早得多。
   */
  async function contains(path) {
    try { await locate(path); return true; }
    catch { return false; }
  }
  const crcTable = Array.from({ length: 256 }, (_, i) => { let n = i; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  function crc(bytes) { let n = 0xffffffff; for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
  /**
   * 解析 DOCX 并给出"够不够像一份完整逐字稿"的基本指标。
   *
   * 这里只做字节级与结构级检查：ZIP 完整、CRC 正确、document.xml 可解析、正文取得到。
   * 腾讯服务端到底生成了多少内容，本地无法证明 —— 所以额外给出字数与段落数，
   * 让"只生成了标题"这种最常见的残缺能被识别出来（见 MIN_TRANSCRIPT_CHARS）。
   */
  async function documentProfile(bytes) {
    if (bytes.length > MAX) throw new Error('文档超过64MB，需人工核验');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (v.getUint32(p, true) === 0x06054b50 && p + 22 + v.getUint16(p + 20, true) === bytes.length) { end = p; break; }
    if (end < 0 || v.getUint16(end + 4, true) || v.getUint16(end + 6, true)) throw new Error('Word ZIP 文件不完整');
    const count = v.getUint16(end + 10, true), centralEnd = v.getUint32(end + 16, true) + v.getUint32(end + 12, true);
    let p = v.getUint32(end + 16, true), total = 0, xml = '';
    if (centralEnd > end || count > 4096) throw new Error('Word ZIP 索引异常');
    for (let i = 0; i < count; i++) {
      if (p + 46 > centralEnd || v.getUint32(p, true) !== 0x02014b50) throw new Error('Word ZIP 索引损坏');
      const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), expectedCRC = v.getUint32(p + 16, true), packed = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true), nameLen = v.getUint16(p + 28, true), at = v.getUint32(p + 42, true);
      total += size;
      if (total > MAX || flags & 1 || ![0, 8].includes(method) || at + 30 > bytes.length || v.getUint32(at, true) !== 0x04034b50) throw new Error('Word ZIP 格式不受支持或内容过大');
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
      if (start + packed > v.getUint32(end + 16, true)) throw new Error('Word ZIP 数据被截断');
      let data = bytes.slice(start, start + packed);
      if (method === 8) {
        const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const chunks = []; let length = 0;
        while (true) { const r = await reader.read(); if (r.done) break; length += r.value.length; if (length > size || length > MAX) { await reader.cancel(); throw new Error('Word 解压大小异常'); } chunks.push(r.value); }
        data = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      }
      if (data.length !== size || crc(data) !== expectedCRC) throw new Error('Word ZIP 校验失败，文件不完整');
      if (name === 'word/document.xml') xml = new TextDecoder('utf-8', { fatal: true }).decode(data);
      p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    if (!xml || p !== centralEnd) throw new Error('缺少 Word 正文或索引异常');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Word 正文 XML 损坏');
    const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const body = doc.getElementsByTagNameNS(NS, 'body')[0];
    if (!body) throw new Error('缺少 Word 正文');
    const paragraphs = body.getElementsByTagNameNS(NS, 'p').length;
    const text = [...body.getElementsByTagNameNS(NS, 't')].map(n => n.textContent).join('').replace(/[\s\u200b-\u200f\ufeff]/g, '');
    return {
      text,
      characters: text.length,
      paragraphs,
      // 逐字稿通常带 [00:12] 这类时间戳；只作为信息透传，不参与通过与否。
      hasTimestamp: /\d{1,2}:\d{2}(?::\d{2})?/.test(text),
    };
  }

  async function documentText(bytes) { return (await documentProfile(bytes)).text; }

  async function inspect(file, kind) {
    if (!file.size) return { valid: false, reason: '文件为0字节' };
    if (/\.docx$/i.test(file.name)) {
      const profile = await documentProfile(new Uint8Array(await file.arrayBuffer()));
      const { characters, paragraphs, hasTimestamp } = profile;
      const stamp = hasTimestamp ? '，含时间戳' : '';
      if (!characters) {
        return { valid: false, reason: '空Word模板：正文为空（页脚logo不算正文）', characters: 0, paragraphs };
      }
      // 只判"非空"会把"腾讯只生成了标题"当成成功 —— 这是逐字稿残缺最常见的形态。
      if (characters < MIN_TRANSCRIPT_CHARS) {
        return {
          valid: false,
          reason: `正文只有 ${characters} 字（${paragraphs} 段）${stamp}，像是只生成了标题或开头。请到课程页确认逐字稿已生成完整，再重新导出`,
          characters, paragraphs,
        };
      }
      return { valid: true, reason: `正文 ${characters} 字 / ${paragraphs} 段${stamp}，ZIP 与 CRC 校验通过`, characters, paragraphs };
    }
    if (kind === 'video' || /\.(mp4|m4a|mov)$/i.test(file.name)) {
      let p = 0, count = 0, media = false, index = false, type = false;
      while (p < file.size && count++ < 10000) {
        const b = new Uint8Array(await file.slice(p, p + 16).arrayBuffer());
        if (b.length < 8) throw new Error('视频容器被截断');
        const v = new DataView(b.buffer), tag = String.fromCharCode(...b.slice(4, 8)); let size = v.getUint32(0);
        if (size === 1) { if (b.length < 16) throw new Error('视频头被截断'); size = Number(v.getBigUint64(8)); }
        else if (!size) size = file.size - p;
        if (!Number.isSafeInteger(size) || size < 8 || p + size > file.size) throw new Error('视频文件大小与容器不符');
        type ||= tag === 'ftyp'; index ||= tag === 'moov'; media ||= tag === 'mdat' && size > 16; p += size;
      }
      return { valid: p === file.size && type && index && media, reason: '检查MP4容器、索引和媒体块；不代表逐帧解码验收' };
    }
    return { valid: false, reason: '暂不支持此文件格式的内容校验，请人工核验' };
  }
  async function verify(path, kind, size) {
    try {
      const file = await locate(path);
      if (size > 0 && file.size !== size) return { valid: false, reason: '磁盘文件大小与下载记录不符' };
      return { ...await inspect(file, kind), size: file.size, modified: file.lastModified, filename: path };
    } catch (e) { return { valid: false, reason: e.message, needsFolder: /下载文件夹|读取权限/.test(e.message) }; }
  }
  globalThis.TMeetFiles = Object.freeze({ directory, root, status, probe, locate, contains, inspect, verify, documentText, documentProfile, MIN_TRANSCRIPT_CHARS });
})();
