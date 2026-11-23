/* 持久化下载凭据：点击不是成功，浏览器 complete 也不是正文完整。
 *
 * 索引（v1.7.0）：
 *   记录本身按课程分散存储（export.v3.<scope>:<fileId>:<kind>），但"本批涉及哪些
 *   下载 ID"和"哪些已经通过正文校验"另存两个扁平索引。这样后台判断「上一批是否
 *   还在传输」和录制页恢复"已下载"标记时，都不必把整个 chrome.storage.local 读一遍
 *   （库里还有上千条清单和上万条校验报告）。
 */
(() => {
  'use strict';
  const prefix = 'export.v3.';
  const IDS_KEY = prefix + 'ids';           // [downloadId, ...] 全量去重，用于判断残留传输
  const VERIFIED_KEY = prefix + 'verified'; // ['export.v3.own:<fileId>:<kind>', ...] 已通过正文校验
  const PENDING_KEY = prefix + 'pending';   // ['export.v3.own:<fileId>:<kind>', ...] 点了导出但结果不明，需人工确认
  const KEY_PATTERN = /^export\.v3\.(own|shared):([^:]+):(video|transcript)$/;
  const safe = value => String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 140) || '课程';
  const base = path => String(path).split(/[\\/]/).at(-1).replace(/\s*\(\d+\)(?=\.[^.]+$)/g, '').toLowerCase();
  function parseKey(value) {
    const match = KEY_PATTERN.exec(String(value || ''));
    if (!match) return null;
    try { return { scope: match[1], fileId: decodeURIComponent(match[2]), kind: match[3] }; }
    catch { return null; }
  }
  function create(chrome, verify) {
    const store = chrome.storage.local;
    const key = (scope, id, kind) => prefix + scope + ':' + encodeURIComponent(id) + ':' + kind;
    async function get(k) { return (await store.get(k))[k]; }
    async function save(k, record) { await store.set({ [k]: record }); return record; }
    async function readList(k) {
      const value = (await store.get(k))[k];
      return Array.isArray(value) ? value : [];
    }
    // 索引都是"读-改-写"的小数组；索引丢失只会让恢复变保守（重新核对），不会假报成功。
    async function trackIds(ids) {
      const list = (ids || []).filter(id => Number.isInteger(id));
      if (!list.length) return;
      const current = await readList(IDS_KEY);
      const merged = [...new Set([...current, ...list])].slice(-20000);
      if (merged.length !== current.length) await store.set({ [IDS_KEY]: merged });
    }
    async function trackVerified(k, valid) {
      const current = await readList(VERIFIED_KEY);
      if (valid === current.includes(k)) return;
      await store.set({ [VERIFIED_KEY]: valid ? [...current, k] : current.filter(item => item !== k) });
    }
    /**
     * "点了导出但没确认下载结果"的记录索引。
     * 这种记录不能重复点击（可能已经下过），又不能一直卡着不动，
     * 所以单独维护一份列表，让工作台能一次性列出来、一键解除。
     */
    async function trackPending(k, on) {
      const current = await readList(PENDING_KEY);
      const has = current.includes(k);
      if (on === has) return;
      await store.set({ [PENDING_KEY]: on ? [...current, k] : current.filter(item => item !== k) });
    }
    /** 待核对记录（key 列表）。第一次调用会把升级前的存量记录扫进来。 */
    async function pending() {
      const raw = (await store.get(PENDING_KEY))[PENDING_KEY];
      if (Array.isArray(raw)) return raw;
      const all = await store.get(null);
      const legacy = Object.keys(all).filter(k => KEY_PATTERN.test(k) && all[k]?.pending);
      await store.set({ [PENDING_KEY]: legacy });
      return legacy;
    }
    /** 解除单条待核对：确认没有产生下载，允许重新导出。 */
    async function clearPending(k) {
      const record = await get(k);
      const wasPending = !!record?.pending;
      if (wasPending) await save(k, { ...record, pending: false, verified: false });
      await trackPending(k, false);
      return wasPending;
    }
    /** 涉及过的下载 ID，替代 storage.local.get(null) 全库扫描。 */
    async function ids() {
      const raw = (await store.get(IDS_KEY))[IDS_KEY];
      if (Array.isArray(raw)) return raw;
      // 首次升级（或索引被清掉）：扫一次旧记录补建索引，之后都只读索引。
      // 否则升级前仍在传输的文件会被误判成"陌生下载"，导致无法续导。
      const all = await store.get(null);
      const legacy = Object.entries(all)
        .filter(([k]) => k.startsWith(prefix))
        .flatMap(([, record]) => (Array.isArray(record?.ids) ? record.ids : []));
      const merged = [...new Set(legacy)].slice(-20000);
      await store.set({ [IDS_KEY]: merged });
      return merged;
    }
    /** 已通过正文校验的记录 key（供录制页恢复"已下载"标记）。 */
    async function verified() { return readList(VERIFIED_KEY); }
    async function begin(k, target) {
      const old = await get(k);
      if (old?.pending) throw new Error('上次已点击但下载结果尚未确认，请在工作台点该项的「允许重试」后再导出');
      await trackVerified(k, false);
      await save(k, { ...old, target, pending: true, verified: false, ids: [], started: new Date().toISOString(), attempts: (old?.attempts || 0) + 1 });
      await trackPending(k, true);
    }
    async function attach(k, id) {
      const r = await get(k); if (!r) throw new Error('下载凭据丢失，已停止');
      await save(k, { ...r, pending: false, ids: [...new Set([...(r.ids || []), id])] });
      await trackPending(k, false);
      await trackIds([id]);
    }
    async function attachItem(k, item) {
      await attach(k, item.id);
      const r = await get(k);
      await save(k, { ...r, filenames: { ...r.filenames, [item.id]: item.filename } });
    }
    /**
     * 判定一条课程"下好了没有"。
     *
     * v1.8.4 起不再读文件内容（不再要求用户授权下载目录）：
     * 只看 chrome.downloads 的三件事 —— 状态 complete、字节数对得上、文件还在磁盘。
     * 重名冲突交给浏览器的 uniquify（xxx (1).docx），插件不参与改名或覆盖。
     *
     * 代价：不再能识别"腾讯只生成了标题"的残缺逐字稿。用 fileSize 给一条轻提示兜底，
     * 但不因此判失败、不阻塞流程。
     */
    async function check(k, kind) {
      let record = await get(k);
      if (!record) return { state: 'new' };
      const results = [];
      for (const id of record.ids || []) {
        const [item] = await chrome.downloads.search({ id });
        if (!item) { results.push({ valid: false, id, reason: '浏览器的下载记录已被清理，无法确认' }); continue; }
        if (item.state === 'in_progress') return { state: item.paused ? 'paused' : 'running', ids: record.ids };
        if (item.state === 'interrupted') { results.push({ id, valid: false, resumable: item.canResume, interrupted: true, reason: item.error || '下载中断' }); continue; }
        const complete = item.exists !== false && (item.totalBytes === 0 || item.bytesReceived === item.totalBytes);
        const size = item.fileSize || item.bytesReceived || 0;
        // 轻提示：逐字稿小到 5KB 以下，很可能是"只生成了标题"。不判失败，只在结果里带一句。
        const tiny = complete && kind === 'transcript' && size > 0 && size < 5 * 1024;
        results.push({
          valid: complete,
          id,
          size,
          filename: item.filename || '',
          reason: complete
            ? (tiny ? `下载完成，但只有 ${Math.round(size / 1024)}KB，可能只生成了标题（未做正文校验）` : '下载完成（未做正文校验）')
            : (item.exists === false ? '下载记录指向的文件已不在磁盘上' : '传输字节数不完整'),
        });
        record.filenames = { ...record.filenames, [id]: item.filename };
      }
      const valid = results.length > 0 && results.every(r => r.valid);
      const result = { state: valid ? 'verified' : record.pending ? 'uncertain' : 'invalid', results, ids: record.ids || [] };
      await save(k, { ...record, verified: valid, validation: results, checked: new Date().toISOString() });
      await trackVerified(k, valid);
      return result;
    }
    async function adopt(k, target) {
      const previous = await get(k);
      const prior = previous ? await check(k, target.type) : null;
      if (prior && !['invalid', 'uncertain'].includes(prior.state)) return prior;
      // 旧版同名副本全部核对，不以文件大小或(1)(2)后缀决定正本。
      if (target.uniqueTitle === false) return prior || { state: 'new' };
      const suffix = target.type === 'transcript' ? '逐字稿.docx' : '视频.mp4';
      const stem = safe(target.name).replace(/\.(docx|mp4)$/i, '');
      // 只认本插件自己的命名（<课程名>_逐字稿.docx / <课程名>_视频.mp4）。
      // 不再兼容"裸文件名"：不读文件内容之后，裸同名文件无法排除是别的课程或用户手放的文件，
      // 贸然认领会把"其实没下过"的课程标成已下载。
      const expected = new Set([base(safe(target.name) + '_' + suffix), base(stem + '_' + suffix)]);
      const history = await chrome.downloads.search({ query: [safe(target.name)], limit: 0 });
      // 只认"浏览器说下完了、文件还在、名字对得上、来源是本站/本扩展"的记录。
      // 不再打开文件读正文 —— 那正是"必须授权下载目录"的根源。
      const hit = history.find(d => d.state === 'complete' && d.exists !== false &&
        (d.totalBytes === 0 || d.bytesReceived === d.totalBytes) &&
        expected.has(base(d.filename)) &&
        (d.byExtensionId === chrome.runtime.id || /meeting\.tencent\.com/.test(d.referrer || d.url || '')));
      if (hit) {
        await save(k, { ...previous, target, ids: [hit.id], pending: false, localFile: hit.filename, verified: true });
        await trackPending(k, false);
        await trackVerified(k, true);
        return { state: 'verified', results: [{ valid: true, id: hit.id, size: hit.fileSize || 0, filename: hit.filename, reason: '下载记录里已有这个文件（未做正文校验）' }] };
      }
      return prior || { state: 'new' };
    }
    async function pause(keys) {
      for (const k of keys) {
        const r = await get(k);
        for (const id of r?.ids || []) { const [d] = await chrome.downloads.search({ id }); if (d?.state === 'in_progress' && !d.paused) await chrome.downloads.pause(id).catch(() => {}); }
      }
    }
    async function resume(k) {
      const r = await get(k);
      for (const id of r?.ids || []) {
        const [item] = await chrome.downloads.search({ id });
        if (item?.paused || item?.state === 'interrupted' && item.canResume) await chrome.downloads.resume(id);
      }
      return check(k, r?.target?.type);
    }
    return Object.freeze({ key, parse: parseKey, get, save, begin, attach, attachItem, check, adopt, pause, resume, ids, verified, pending, clearPending });
  }
  globalThis.TMeetJournal = Object.freeze({ create, IDS_KEY, VERIFIED_KEY, PENDING_KEY, parse: parseKey });
})();
