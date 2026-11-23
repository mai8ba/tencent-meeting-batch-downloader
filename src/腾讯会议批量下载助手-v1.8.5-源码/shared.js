(() => {
  'use strict';
  const $ = id => document.getElementById(id), sleep = ms => new Promise(r => setTimeout(r, ms));
  let items = [], licensed = false, running = false, stopped = false, slots = 0, maxFiles = 3;
  const waiters = [];
  async function rpc(op, data = {}) {
    const result = await chrome.runtime.sendMessage({ type: 'tmeet', op, ...data });
    if (!result?.ok) throw new Error(result?.error || '后台无响应');
    return result;
  }
  function check() { if (stopped) throw new Error('任务已停止，已启动文件请在浏览器下载列表核对'); }
  function update() {
    const selected = items.filter(i => i.selected).length;
    $('count').textContent = `已选 ${selected} / 共 ${items.length} 门课程`;
    $('start').textContent = running ? '下载中…（请勿重复点击）' : '开始 / 断点续导';
    $('start').disabled = running || !licensed || !selected || (!$('want-video').checked && !$('want-transcript').checked);
    $('stop').disabled = !running;
    for (const id of ['source', 'parse', 'clear', 'select-all', 'invert', 'workers', 'want-video', 'want-transcript']) $(id).disabled = running;
    document.querySelectorAll('.course input').forEach(el => { el.disabled = running; });
  }
  function state(item, text, cls = '') {
    item.state = text; item.cls = cls;
    const el = document.getElementById('state-' + item.id);
    if (el) { el.textContent = text; el.className = 'state ' + cls; }
  }
  function render() {
    $('list').replaceChildren();
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'course';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.selected;
      checkbox.setAttribute('aria-label', '选择 ' + item.title);
      checkbox.addEventListener('change', () => { item.selected = checkbox.checked; update(); });
      const info = document.createElement('div'), title = document.createElement('div'), meta = document.createElement('div'), status = document.createElement('div');
      title.className = 'title'; title.textContent = item.title;
      meta.className = 'meta'; meta.textContent = [item.date, item.url, item.password ? '已识别访问密码' : '未提供密码'].filter(Boolean).join(' · ');
      status.id = 'state-' + item.id; status.className = 'state ' + (item.cls || ''); status.textContent = item.state || '等待下载';
      info.append(title, meta, status);
      const open = document.createElement('button'); open.textContent = '打开 / 处理课程';
      open.addEventListener('click', async () => {
        try {
          if (item.tabId) await rpc('shared.focus', { tabId: item.tabId });
          else { const { job } = await rpc('shared.view', { item }); item.tabId = job.tabId; await saveDraft(); await rpc('shared.focus', { tabId: item.tabId }); }
        } catch (e) { state(item, e.message, 'error'); }
      });
      row.append(checkbox, info, open); $('list').append(row);
    }
    update();
  }
  async function saveDraft() {
    await chrome.storage.local.set({ sharedDraft: { text: $('source').value, items } });
  }
  $('parse').addEventListener('click', async () => {
    try {
      const parsed = TMeetShared.parse($('source').value);
      if (!parsed.length) throw new Error('未识别到腾讯会议分享链接，请粘贴包含 crm/cw/ct 链接的文字');
      const previous = new Map(items.map(i => [i.id, i]));
      const incoming = new Map(parsed.map(i => [i.id, i]));
      for (const old of items) {
        const replacement = incoming.get(old.id);
        if (old.tabId && (!replacement || replacement.password !== old.password)) await rpc('shared.close', { tabId: old.tabId }).catch(() => {});
      }
      items = parsed.map(i => {
        const old = previous.get(i.id);
        return old && old.password === i.password ? { ...old, ...i } : { ...i, selected: true, state: '等待下载' };
      });
      $('parse-status').textContent = `已识别 ${items.length} 门课程，已合并重复链接`; render(); await saveDraft();
    } catch (e) { $('parse-status').textContent = e.message; }
  });
  $('clear').addEventListener('click', async () => {
    // 仅移除本控制页创建的课程任务。
    for (const item of items) if (item.tabId) await rpc('shared.close', { tabId: item.tabId }).catch(() => {});
    items = []; $('source').value = ''; $('parse-status').textContent = ''; render(); await saveDraft();
  });
  $('select-all').addEventListener('click', () => { items.forEach(i => { i.selected = true; }); render(); });
  $('invert').addEventListener('click', () => { items.forEach(i => { i.selected = !i.selected; }); render(); });
  for (const id of ['want-video', 'want-transcript']) $(id).addEventListener('change', update);
  $('stop').addEventListener('click', () => { stopped = true; void rpc('stop-batch').catch(e => { $('progress').textContent = e.message; }); $('progress').textContent = '正在停止后续任务；正在暂停已启动的文件，进度已保留。'; waiters.splice(0).forEach(w => w()); });
  async function withSlot(fn) {
    while (slots >= maxFiles) { check(); await new Promise(resolve => waiters.push(resolve)); }
    check(); slots++;
    try { return await fn(); } finally { slots--; waiters.shift()?.(); }
  }
  async function waitReady(item, kind) {
    const end = performance.now() + 90000;
    let diagnostic = '';
    while (performance.now() < end) {
      check();
      const { job } = await rpc('shared.status', { tabId: item.tabId });
      if (job.error) throw new Error(job.error);
      if (job.diagnostic) diagnostic = job.diagnostic;
      if (kind === 'video' && job.allowVideo === false) throw new Error('分享者未开放视频下载，请联系分享者开启权限');
      if ((kind === 'video' && job.allowVideo === true && (job.videos.length || job.hasDownloadButton)) || (kind === 'transcript' && job.transcriptReady)) return;
      state(item, `${kind === 'video' ? '视频' : '逐字稿'}：${job.status}${kind === 'transcript' && job.segmentCount ? `（已取得 ${job.segmentCount} 段，等待全文）` : ''}`);
      await sleep(1000);
    }
    // 站点改版时只报"超时"等于没线索，带上响应字段名让用户/客服一眼看出问题。
    throw new Error('等待课程数据超时；请打开课程页完成访问验证或切换到转写，随后重试' + (diagnostic ? `（${diagnostic}）` : ''));
  }
  async function downloadKind(item, kind) {
    let { result: prior } = await rpc('journal.check', { scope: 'shared', id: item.id, kind, target: { name: TMeetShared.safeName(item.title) + '_' + item.id, type: kind } });
    check();
    if (prior.state === 'verified') return;
    if (['uncertain', 'needs-folder'].includes(prior.state)) throw new Error('先在本地校验与续导页面核对文件或授权目录');
    const existing = ['running', 'paused'].includes(prior.state) || prior.results?.some(r => r.resumable);
    if (!existing) await waitReady(item, kind);
    return withSlot(async () => {
      check();
      const name = kind === 'video' ? '视频' : '逐字稿';
      let result = existing ? { ids: (await rpc('journal.check', { scope: 'shared', id: item.id, kind, resume: true })).result.ids } : await rpc('shared.download', { tabId: item.tabId, kind, retry: true });
      if (result.verified) return;
      const deadline = performance.now() + 45000;
      while (result.pending) {
        check();
        if (performance.now() > deadline) {
          await rpc('shared.cancel-native', { tabId: item.tabId });
          throw new Error('原网页下载尚未启动，请打开课程页处理下载确认后核对浏览器下载列表');
        }
        await sleep(400);
        const { job } = await rpc('shared.status', { tabId: item.tabId });
        if (job.downloads.video?.length) result = { ids: job.downloads.video };
        else if (result.busy) result = await rpc('shared.download', { tabId: item.tabId, kind, retry: true });
      }
      const { ids } = result;
      if (!ids?.length) throw new Error(name + '未启动下载');
      const transferStart = performance.now();
      while (true) {
        check();
        const { items: downloads } = await rpc('shared.download-status', { tabId: item.tabId });
        const relevant = downloads.filter(d => ids.includes(d.id));
        if (relevant.length !== ids.length) throw new Error(name + '下载记录缺失，请核对浏览器下载列表');
        const failed = relevant.find(d => d.state === 'interrupted');
        if (failed) { stopped = true; waiters.splice(0).forEach(w => w()); await rpc('stop-batch').catch(() => {}); throw new Error(name + '下载中断：' + (failed.error || '请查看浏览器下载列表')); }
        if (relevant.every(d => d.state === 'complete')) {
          const { result: checked } = await rpc('journal.check', { scope: 'shared', id: item.id, kind, target: { name: TMeetShared.safeName(item.title) + '_' + item.id, type: kind } });
          if (checked.state !== 'verified') {
            stopped = true; waiters.splice(0).forEach(w => w());
            await rpc('stop-batch').catch(() => {});
            throw new Error(checked.results?.map(r => r.reason).join('；') || '本地校验未通过');
          }
          return;
        }
        if (relevant.some(d => d.paused)) throw new Error('文件已暂停，点击开始继续传输');
        if (performance.now() - transferStart > 30 * 60000) throw new Error('传输等待超过30分钟，已保存续导记录，请检查网络后继续');
        state(item, name + '传输中…'); await sleep(700);
      }
    });
  }
  async function course(item, kinds) {
    try {
      check(); state(item, '正在打开课程…');
      if (item.tabId) {
        try { await rpc('shared.status', { tabId: item.tabId }); }
        catch { delete item.tabId; }
      }
      if (!item.tabId) { const { job } = await rpc('shared.open', { item }); item.tabId = job.tabId; await saveDraft(); }
      const results = await Promise.allSettled(kinds.map(kind => downloadKind(item, kind)));
      const labels = results.map((result, index) => `${kinds[index] === 'video' ? '视频' : '逐字稿'}：${result.status === 'fulfilled' ? '下载完成' : result.reason.message}`);
      const done = results.every(result => result.status === 'fulfilled');
      state(item, labels.join('；'), done ? 'done' : 'error');
      if (done) { item.selected = false; await rpc('shared.close', { tabId: item.tabId }).catch(() => {}); delete item.tabId; }
      return done;
    } catch (e) { state(item, e.message, 'error'); return false; }
    finally { await saveDraft(); }
  }
  $('start').addEventListener('click', async () => {
    if (running) return;
    running = true; stopped = false; slots = 0; update();
    $('progress').textContent = '正在校验授权并准备课程…';
    const targets = items.filter(i => i.selected), kinds = [];
    if ($('want-video').checked) kinds.push('video'); if ($('want-transcript').checked) kinds.push('transcript');
    let next = 0, complete = 0, failed = 0, acquired = false;
    try {
      if (!kinds.length) throw new Error('请选择视频或逐字稿');
      const { config } = await chrome.storage.local.get('config'); maxFiles = Math.max(1, Math.min(8, Math.floor(Number(config?.maxConcurrent)) || 2));
      await rpc('local-ready');
      await rpc('shared.begin'); acquired = true;
      const workers = Math.min(6, Math.max(1, Math.floor(Number($('workers').value)) || 2));
      await Promise.all(Array.from({ length: workers }, async () => {
        while (!stopped && next < targets.length) {
          const item = targets[next++];
          if (await course(item, kinds)) complete++; else failed++;
          $('progress').textContent = `已完成 ${complete} 门，需处理 ${failed} 门 / 共 ${targets.length} 门`;
        }
      }));
      $('progress').textContent = `${stopped ? '任务已停止' : '本批处理结束'}：完成 ${complete} 门，需处理 ${failed} 门，未开始 ${targets.length - next} 门`;
    } catch (e) { $('progress').textContent = e.message; }
    finally {
      if (acquired) { if (stopped) await rpc('stop-batch').catch(() => {}); await rpc('shared.end').catch(() => {}); }
      running = false; render(); await saveDraft().catch(e => { $('progress').textContent += '；进度保存失败：' + e.message; });
    }
  });
  TMeetLicenseUI.mount($('license-panel'), status => {
    licensed = status.active;
    if (!licensed && running) { stopped = true; void rpc('stop-batch').catch(() => {}); waiters.splice(0).forEach(w => w()); }
    update();
  });
  chrome.storage.local.get('sharedDraft').then(({ sharedDraft }) => {
    if (!sharedDraft || typeof sharedDraft.text !== 'string') return;
    $('source').value = sharedDraft.text;
    const valid = TMeetShared.parse(sharedDraft.text);
    const old = new Map((sharedDraft.items || []).map(i => [i.id, i]));
    items = valid.map(i => ({ ...i, selected: old.get(i.id)?.selected !== false, tabId: undefined, state: old.get(i.id)?.state || '等待下载', cls: old.get(i.id)?.cls || '' }));
    render();
  }).catch(() => {});
  $('open-audit').onclick = () => rpc('open-audit', { pick: true }).catch(e => { $('progress').textContent = e.message; });
  render();
})();
