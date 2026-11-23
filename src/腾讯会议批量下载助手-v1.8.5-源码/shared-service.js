/* 后台分享任务：标签页和数据均绑定创建它们的扩展页面，跨 worker 休眠保留。
 *
 * v1.7.0 两条读写纪律：
 *   1. 元数据和逐字稿正文分开读：状态轮询（每秒一次）只读 session 里的元数据，
 *      正文留在 IndexedDB，只有真正要生成 DOCX 时才取。
 *   2. 元数据和正文分开写：页面状态、视频地址这种小更新不再把整份正文重写一遍。
 */
(() => {
  'use strict';
  const SEGMENT_LIMIT = 20000;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  /** 分块生成 base64：避免先拼一个"每字节一个字符"的大字符串再交给 btoa（等于正文的两份副本）。 */
  function toBase64(bytes) {
    const parts = [];
    let chunk = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], hasB = i + 1 < bytes.length, hasC = i + 2 < bytes.length;
      const b = hasB ? bytes[i + 1] : 0, c = hasC ? bytes[i + 2] : 0;
      chunk += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (hasB ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (hasC ? B64[c & 63] : '=');
      if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
    }
    if (chunk) parts.push(chunk);
    return parts.join('');
  }
  // 正文不占用仅 10MB 的会话存储，也不让读取下载凭据时加载所有课程正文。
  function segmentStore(fallback) {
    if (typeof indexedDB === 'undefined') {
      // 没有 IndexedDB 时退回 local 存储，但保持与 IndexedDB 分支完全一致的读写语义。
      return {
        async get(k) { return { [k]: (await fallback.get(k))[k] }; },
        async set(value) { await fallback.set(value); },
        async remove(k) { await fallback.remove(k); },
        async keys() {
          if (typeof fallback.getKeys === 'function') return fallback.getKeys();
          return Object.keys(await fallback.get(null));
        }
      };
    }
    async function run(mode, operation) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('tmeet-segments', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('segments');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try { return await new Promise((resolve, reject) => {
        const tx = db.transaction('segments', mode), request = operation(tx.objectStore('segments'));
        tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('正文缓存事务中断'));
      }); } finally { db.close(); }
    }
    return {
      async get(k) { return { [k]: await run('readonly', s => s.get(k)) }; },
      async set(value) { for (const [k, v] of Object.entries(value)) await run('readwrite', s => s.put(v, k)); },
      async remove(k) { await run('readwrite', s => s.delete(k)); },
      async keys() { return run('readonly', s => s.getAllKeys()); }
    };
  }
  function create(chrome, licensing, journal) {
    const store = chrome.storage.session;
    const segmentsStore = segmentStore(chrome.storage.local);
    const key = id => `shared.task.${id}`;
    const segmentKey = tabId => 'shared.segments.' + tabId;
    /**
     * @param {boolean} withSegments 只有要合并分页或生成 DOCX 时才读正文；
     *   状态轮询只取元数据，避免每秒把上万段正文从 IndexedDB 搬一遍。
     */
    async function read(tabId, withSegments = false) {
      const job = (await store.get(key(tabId)))[key(tabId)];
      if (!job) return job;
      if (withSegments) job.segments = (await segmentsStore.get(segmentKey(tabId)))[segmentKey(tabId)] || job.segments || [];
      return job;
    }
    async function save(job, { segments: writeSegments = false } = {}) {
      const body = Array.isArray(job.segments) ? job.segments : null;
      const { segments, ...metadata } = job;
      if (writeSegments && body) await segmentsStore.set({ [segmentKey(job.tabId)]: body });
      const segmentCount = body ? body.length : (Number.isInteger(job.segmentCount) ? job.segmentCount : 0);
      await store.set({ [key(job.tabId)]: { ...metadata, segmentCount } });
    }
    async function urlKey(url) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url || ''));
      return 'download.url.' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    async function download(url, filename) {
      // data: 正文动辄数 MB，没必要为了取名字再哈希一遍；它本来就带着目标文件名。
      const claim = url.startsWith('data:') ? null : await urlKey(url);
      if (claim) await store.set({ [claim]: filename });
      try {
        const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
        await store.set({ ['download.id.' + id]: filename });
        return id;
      } finally { if (claim) await store.remove(claim); }
    }
    function nativeName(job, item) {
      const ext = TMeetSite.extensionOf(item.filename || item.url || '', item.mime);
      return `腾讯会议分享课程/${TMeetShared.safeName(job.item.title)}_${job.item.id}_${TMeetSite.isTranscriptExt(ext) ? '逐字稿' : '视频'}.${ext}`;
    }
    async function filename(item) {
      const idKey = 'download.id.' + item.id;
      const saved = (await store.get(idKey))[idKey];
      if (saved) return saved;
      if (!String(item.url || '').startsWith('data:')) {
        const claim = await urlKey(item.url);
        const intended = (await store.get(claim))[claim];
        if (intended) { await store.set({ [idKey]: intended }); return intended; }
      }
      let ref;
      try { ref = new URL(item.referrer || item.url); if (ref.protocol === 'blob:') ref = new URL(ref.pathname); } catch { return null; }
      if (ref.origin !== 'https://meeting.tencent.com') return null;
      const all = await store.get(null);
      const share = TMeetShared.shareURL(ref.href);
      const shareId = share?.pathname.split('/').filter(Boolean)[1];
      const pending = all.sharedNativePending;
      const job = shareId ? Object.entries(all).find(([k,j]) => k.startsWith('shared.task.') && j.item.id === shareId)?.[1] : pending ? all[key(pending.tabId)] : null;
      if (!job) return null;
      const name = nativeName(job, item);
      await store.set({ [idKey]: name });
      return name;
    }
    function view(job) {
      const count = Number.isInteger(job.segmentCount) ? job.segmentCount : (job.segments?.length || 0);
      return { tabId: job.tabId, status: job.pageStatus || '正在打开课程', allowVideo: job.allowVideo,
        hasDownloadButton: !!job.hasDownloadButton, diagnostic: job.diagnostic || '',
        videos: job.videos || [], transcriptReady: !!job.complete && count > 0,
        segmentCount: count, complete: !!job.complete, error: job.error || '', downloads: job.downloads || {} };
    }
    async function owned(tabId, owner, options = {}) {
      if (!Number.isInteger(tabId)) throw new Error('课程标识无效');
      const job = await read(tabId, options.segments === true);
      if (!job || job.owner !== owner) throw new Error('课程任务不存在，请重新打开课程');
      return job;
    }
    async function handle(message, sender, isView) {
      const op = message.op;
      if (op === 'shared.probe' || op === 'shared.capture' || op === 'shared.authorize-native') {
        if (!Number.isInteger(sender.tab?.id) || !sender.url?.startsWith('https://meeting.tencent.com/')) throw new Error('不允许的页面');
        const job = await read(sender.tab.id, op === 'shared.capture');
        if (!job) return { enabled: false };
        const current = TMeetShared.shareURL(sender.url);
        if (current && current.pathname.split('/').filter(Boolean)[1] !== job.item.id) {
          job.error = '课程页已切换到另一分享链接，请重新建立当前课程任务'; await save(job);
          return { enabled: false };
        }
        if (op === 'shared.authorize-native') {
          await licensing.require();
          if ((await store.get('stopped.' + job.owner))['stopped.' + job.owner]) throw new Error('任务已停止');
          const { sharedNativePending } = await store.get('sharedNativePending');
          if (sharedNativePending?.tabId !== job.tabId || sharedNativePending?.owner !== job.owner) throw new Error('原网页下载任务已停止');
          return { enabled: true };
        }
        if (op === 'shared.probe') return { enabled: true, password: job.item.password };
        const delta = message.delta;
        if (!delta || typeof delta !== 'object' || JSON.stringify(delta).length > 2500000) throw new Error('课程数据过大');
        if (delta.captureError) { job.error = String(delta.captureError).slice(0, 300); await save(job); return { enabled: false }; }
        let segmentsChanged = false;
        if (Array.isArray(delta.segments)) {
          const segments = new Map((job.segments || []).map(p => [p.id, p]));
          for (const part of delta.segments) {
            if (!part || typeof part.text !== 'string' || !part.text.trim()) continue;
            const id = String(part.id || '').slice(0, 160);
            if (!id) continue;
            segments.set(id, { id, text: part.text, speaker: String(part.speaker || '').slice(0, 200), start: Math.max(0, Number(part.start) || 0) });
          }
          const result = [...segments.values()].sort((a, b) => a.start - b.start);
          if (result.length > SEGMENT_LIMIT || JSON.stringify(result).length > 2200000) { job.error = '逐字稿过大，已停止自动提取，请使用原页面导出'; }
          else { job.segments = result; segmentsChanged = true; if (delta.complete === true) job.complete = true; }
        }
        if (Array.isArray(delta.videos)) {
          const videos = new Map((job.videos || []).map(v => [v.url, v]));
          for (const video of delta.videos.slice(0, 30)) {
            const url = TMeetShared.mediaURL(video.url);
            if (url) videos.set(url, { url, name: String(video.name || '').slice(0, 200) });
          }
          job.videos = [...videos.values()].slice(-30);
        }
        if (typeof delta.allowVideo === 'boolean') job.allowVideo = delta.allowVideo;
        if (typeof delta.hasDownloadButton === 'boolean') job.hasDownloadButton = delta.hasDownloadButton;
        if (typeof delta.pageStatus === 'string') job.pageStatus = delta.pageStatus.slice(0, 300);
        if (typeof delta.diagnostic === 'string') job.diagnostic = delta.diagnostic.slice(0, 300);
        await save(job, { segments: segmentsChanged });
        return { enabled: true };
      }
      if (!isView || !Number.isInteger(sender.tab?.id)) throw new Error('请从分享课程下载页面操作');
      const owner = sender.tab.id;
      if (op === 'shared.begin') {
        await licensing.require();
        const { batchLease } = await store.get('batchLease');
        if (batchLease && !(batchLease.owner === owner && batchLease.documentId && batchLease.documentId !== sender.documentId)) throw new Error('其他页面正在批量导出，请先停止该任务');
        const running = await chrome.downloads.search({ state: 'in_progress', limit: 0 });
        const all = await store.get(null);
        const known = new Set(Object.entries(all).filter(([k]) => k.startsWith('shared.task.')).flatMap(([, job]) => Object.values(job.downloads || {}).flat()));
        for (const k of await segmentsStore.keys()) if (k.startsWith('shared.segments.') && !all[key(Number(k.slice('shared.segments.'.length)))]) await segmentsStore.remove(k);
        // 索引替代 local 全库读：只看"本扩展关联过的下载 ID"。
        const tracked = new Set(journal ? await journal.ids() : []);
        if (running.some(i => !tracked.has(i.id) && (i.byExtensionId === chrome.runtime.id || known.has(i.id)))) throw new Error('上一批文件仍在传输，请等待完成或在浏览器中取消后再开始');
        await store.remove('stopped.' + owner);
        await store.set({ batchLease: { owner, documentId: sender.documentId, shared: true, keys: [] } }); return {};
      }
      if (op === 'shared.end') {
        const { batchLease } = await store.get('batchLease');
        if (batchLease?.owner === owner) await store.remove('batchLease');
        const { sharedNativePending } = await store.get('sharedNativePending');
        if (sharedNativePending?.owner === owner) await store.remove('sharedNativePending');
        return {};
      }
      if (op === 'shared.open' || op === 'shared.view') {
        await licensing.require();
        const item = message.item;
        const url = TMeetShared.shareURL(item?.url);
        if (!url) throw new Error('只支持腾讯会议 crm/cw/ct 分享链接');
        const { batchLease } = await store.get('batchLease');
        if (op === 'shared.open' && (batchLease?.owner !== owner || !batchLease.shared)) throw new Error('请先开始批量任务');
        const all = await store.get(null);
        if (Object.entries(all).filter(([k, v]) => k.startsWith('shared.task.') && v.owner === owner).length >= 200) throw new Error('保留的课程任务过多，请清空旧清单后再开始');
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        const job = { owner, tabId: tab.id, item: { url: url.href, id: url.pathname.split('/').filter(Boolean)[1], title: String(item.title || '分享课程').slice(0, 200), date: String(item.date || '').slice(0, 80), password: String(item.password || '').slice(0, 128) }, videos: [], segments: [], complete: false, downloads: {} };
        try { await save(job, { segments: true }); await chrome.tabs.update(tab.id, { url: url.href }); }
        catch (e) { await store.remove(key(tab.id)); await chrome.tabs.remove(tab.id).catch(() => {}); throw e; }
        return { job: view(job) };
      }
      if (op === 'shared.status') return { job: view(await owned(message.tabId, owner)) };
      if (op === 'shared.focus') { const job = await owned(message.tabId, owner); const tab = await chrome.tabs.update(job.tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return {}; }
      if (op === 'shared.close') {
        const job = await owned(message.tabId, owner);
        await store.remove(key(job.tabId)); await segmentsStore.remove(segmentKey(job.tabId)); await chrome.tabs.remove(job.tabId).catch(() => {}); return {};
      }
      const job = await owned(message.tabId, owner, { segments: op === 'shared.download' && message.kind === 'transcript' });
      if (op === 'shared.cancel-native') {
        const { sharedNativePending } = await store.get('sharedNativePending');
        if (sharedNativePending?.owner === owner && sharedNativePending.tabId === job.tabId) await store.remove('sharedNativePending');
        return {};
      }
      if (op === 'shared.download-status') {
        const ids = [...new Set(Object.values(job.downloads).flat())];
        return { items: (await Promise.all(ids.map(id => chrome.downloads.search({ id })))).flat().map(i => ({ id: i.id, state: i.state, error: i.error, paused: i.paused })) };
      }
      if (op === 'shared.download') {
        await licensing.require();
        const { batchLease } = await store.get('batchLease');
        if (batchLease?.owner !== owner || !batchLease.shared) throw new Error('任务已停止，请重新开始');
        if (job.error) throw new Error(job.error);
        if ((await store.get('stopped.' + owner))['stopped.' + owner]) throw new Error('任务已停止');
        const kind = message.kind;
        if (!['video', 'transcript'].includes(kind)) throw new Error('下载类型无效');
        const journalKey = journal?.key('shared', job.item.id, kind);
        if (journal) {
          const result = await journal.check(journalKey, kind);
          if (result.state === 'verified') return { ids: result.ids, verified: true };
          if (['running', 'paused'].includes(result.state)) {
            await store.set({ batchLease: { ...batchLease, keys: [...new Set([...(batchLease.keys || []), journalKey])] } });
            const resumed = await journal.resume(journalKey);
            job.downloads[kind] = resumed.ids; await save(job); return { ids: resumed.ids };
          }
          if (['uncertain', 'needs-folder'].includes(result.state)) throw new Error('上次下载待核对或未授权本地目录，请到本地校验与续导页处理');
          // 同一类型曾下到空模板或本地文件已丢失，允许本次明确重试。
          if (result.state === 'invalid') delete job.downloads[kind];
        }
        // 同一任务不盲目重复触发：成功/传输中保留，中断由用户明确重试。
        if (job.downloads[kind]?.length) {
          const existing = (await Promise.all(job.downloads[kind].map(id => chrome.downloads.search({ id })))).flat();
          if (existing.length === job.downloads[kind].length && existing.every(i => i.state === 'complete' || i.state === 'in_progress')) return { ids: job.downloads[kind] };
          if (message.retry === true && existing.length === job.downloads[kind].length && existing.every(i => i.state === 'interrupted')) {
            delete job.downloads[kind]; await save(job);
          } else throw new Error('该类型曾启动但中断或记录缺失，请核对下载列表后再次选择此课程重试');
        }
        const stem = `腾讯会议分享课程/${TMeetShared.safeName(job.item.title)}_${job.item.id}`;
        job.downloads[kind] = [];
        if (kind === 'transcript') {
          if (!job.complete || !job.segments?.length) throw new Error('尚未取得完整逐字稿，请打开课程页切换到转写并等待加载');
          const bytes = TMeetDocx.create(job.item.title, job.item.date, job.segments);
          if (journal) { await journal.begin(journalKey, { name: job.item.title, type: kind, owner }); await store.set({ batchLease: { ...batchLease, keys: [...new Set([...(batchLease.keys || []), journalKey])] } }); }
          // 生成后立刻释放正文引用，避免 base64 与正文同时驻留过久。
          job.segments = null;
          const id = await download('data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + toBase64(bytes), stem + '_逐字稿.docx');
          if (journal) { await journal.attach(journalKey, id); if ((await store.get('stopped.' + owner))['stopped.' + owner]) await journal.pause([journalKey]); }
          job.downloads[kind].push(id); await save(job, { segments: false });
        } else {
          if (job.allowVideo === false) throw new Error('分享者未开放视频下载，请联系分享者开启下载权限');
          if (job.allowVideo !== true) throw new Error('尚未确认分享者的视频下载权限，请打开原页面检查');
          if (!job.videos?.length) {
            if (!job.hasDownloadButton) throw new Error('尚未取得视频地址或原网页下载按钮，请打开课程页检查');
            const { sharedNativePending } = await store.get('sharedNativePending');
            if (sharedNativePending) return { pending: true, busy: sharedNativePending.tabId !== job.tabId };
            if (journal) { await journal.begin(journalKey, { name: job.item.title, type: kind, owner }); await store.set({ batchLease: { ...batchLease, keys: [...new Set([...(batchLease.keys || []), journalKey])] } }); }
            await save(job);
            await store.set({ sharedNativePending: { owner, tabId: job.tabId, shareId: job.item.id } });
            try {
              const response = await chrome.tabs.sendMessage(job.tabId, { type: 'tmeet.shared.action', action: 'download' });
              if (!response?.ok) throw new Error(response?.error || '课程页未响应下载操作');
            } catch (e) { await store.remove('sharedNativePending'); throw e; }
            return { pending: true };
          }
          if (job.videos.length > 1) throw new Error('检测到多个视频文件或清晰度版本，请打开课程页选择所需视频，避免重复下载');
          // 一个课程可能包含多个录制文件，逐一保存 ID，避免后续失败丢失已启动记录。
          if (journal) { await journal.begin(journalKey, { name: job.item.title, type: kind, owner }); await store.set({ batchLease: { ...batchLease, keys: [...new Set([...(batchLease.keys || []), journalKey])] } }); }
          for (let index = 0; index < job.videos.length; index++) {
            const url = TMeetShared.mediaURL(job.videos[index].url);
            if (!url) continue;
            const id = await download(url, stem + `_视频${job.videos.length > 1 ? '_' + (index + 1) : ''}.mp4`);
            if (journal) { await journal.attach(journalKey, id); if ((await store.get('stopped.' + owner))['stopped.' + owner]) await journal.pause([journalKey]); }
            job.downloads[kind].push(id); await save(job);
          }
        }
        return { ids: job.downloads[kind] };
      }
      throw new Error('未知分享任务操作');
    }
    async function removed(tabId) {
      await store.remove(key(tabId));
      await segmentsStore.remove(segmentKey(tabId));
      const { sharedNativePending } = await store.get('sharedNativePending');
      if (sharedNativePending?.owner === tabId || sharedNativePending?.tabId === tabId) await store.remove('sharedNativePending');
      // 关闭控制页仅清理任务数据，保留课程页供用户手工处理，不触碰其他标签页。
      const all = await store.get(null);
      for (const [k, job] of Object.entries(all)) if (k.startsWith('shared.task.') && job.owner === tabId) { await store.remove(k); await segmentsStore.remove(segmentKey(job.tabId)); }
    }
    async function created(item) {
      const { sharedNativePending: pending } = await store.get('sharedNativePending');
      if (!pending || item.byExtensionId === chrome.runtime.id) return;
      let referrer;
      try { referrer = new URL(item.referrer); } catch { return; }
      if (referrer.origin !== 'https://meeting.tencent.com') return;
      const share = TMeetShared.shareURL(referrer.href);
      if (share && share.pathname.split('/').filter(Boolean)[1] !== pending.shareId) return;
      const job = await read(pending.tabId);
      if (!job || job.owner !== pending.owner) { await store.remove('sharedNativePending'); return; }
      await filename(item);
      if (journal) { const k = journal.key('shared', job.item.id, 'video'); await journal.attachItem(k, item); if ((await store.get('stopped.' + job.owner))['stopped.' + job.owner]) await journal.pause([k]); }
      job.downloads.video = [item.id]; await save(job);
      await store.remove('sharedNativePending');
    }
    return Object.freeze({ handle, removed, created, filename });
  }
  globalThis.TMeetSharedService = Object.freeze({ create, toBase64 });
})();
