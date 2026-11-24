(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const fromPanel = params.get('pick') === '1';
  const autoClose = params.get('close') === '1';
  let report = [];
  // 从小窗口进来时只显示授权：窗口小，扫描结果也放不下。
  if (fromPanel) $('scan-section').hidden = true;
  if (autoClose) document.title = '选择下载文件夹（选完自动关闭）';

  async function refreshDir() {
    const dir = await TMeetFiles.status();
    $('dir-state').textContent = dir.granted ? `✅ 已授权：${dir.name}` : '⚠️ 尚未授权下载文件夹';
    $('dir-state').className = dir.granted ? 'ok' : 'warn';
    $('scan').disabled = !dir.granted;
    // 浏览器偶尔会把持久权限降级为 prompt：这时不需要重新挑目录，点一下恢复即可。
    $('restore').hidden = dir.permission !== 'prompt';
    return dir;
  }

  // 扩展自己创建的标签页可以直接关；关不掉就退回 window.close()。
  async function closeSelf() {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) { await chrome.tabs.remove(tab.id); return; }
    } catch { /* 退回 window.close */ }
    window.close();
  }

  async function records() {
    $('records').replaceChildren();
    const all = await chrome.storage.local.get(null);
    for (const [key, r] of Object.entries(all)) {
      if (!key.startsWith('export.v3.') || !r.pending) continue;
      const row = document.createElement('p'), button = document.createElement('button');
      row.textContent = (r.target?.name || key) + '：上次已发出操作，下载结果不明。先检查浏览器下载列表及本地目录。';
      button.textContent = '我已核对未产生下载，允许下次重试';
      button.onclick = async () => {
        const response = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'journal.clear-pending', key });
        if (!response?.ok) { $('status').textContent = response?.error || '清除失败'; return; }
        row.remove();
      };
      row.append(button); $('records').append(row);
    }
  }

  // 第 ① 步：只选目录 + 存句柄，不做全量扫描（扫描动辄几分钟，不该挡在授权前面）。
  $('choose').onclick = async () => {
    try {
      const handle = await showDirectoryPicker({ mode: 'read', id: 'tmeet-downloads' });
      await TMeetFiles.directory(handle);
      // 存完立刻用内存句柄真读一次：确认浏览器确实把读取权限给了扩展。
      const check = await TMeetFiles.probe(handle);
      if (!check.ok) {
        $('status').textContent = '授权没有生效：' + check.reason + '。请再点一次“选择下载文件夹”重试。';
        $('dir-state').textContent = '⚠️ 授权未生效';
        $('dir-state').className = 'warn';
        return;
      }
      const dir = await refreshDir();
      if (!dir.granted) {
        $('status').textContent = '目录已选中，但本页读不到授权状态。请再点一次“选择下载文件夹”；若仍失败，换一个目录（例如直接选“下载”文件夹）。';
        return;
      }
      // 本页能读 ≠ 校验用的离屏文档能读：关页面前端到端确认一次，避免"选完就掉"。
      // 注意 localDir 必须最后才写：录制页一收到这个信号就会自动继续导出。
      const response = await chrome.runtime.sendMessage({ type: 'tmeet', op: 'local.status' });
      if (!response?.ok) {
        $('status').textContent = '授权已记录，但校验组件无响应（' + (response?.error || '未知错误') + '）。请稍后重试，或重新打开本页面。';
        return;
      }
      if (response.dir && !response.dir.granted) {
        $('status').textContent = '目录已选中，但校验组件读不到授权（' + (response.dir.permission || 'unknown') + '）。请点“恢复上次授权”再试，或换一个目录。';
        $('dir-state').textContent = '⚠️ 授权未生效';
        $('dir-state').className = 'warn';
        return;
      }
      await chrome.storage.local.set({ localDir: { name: handle.name, at: Date.now() } });
      if (autoClose) {
        $('status').textContent = `已授权：${handle.name}，正在返回…`;
        await closeSelf();
        return;
      }
      $('status').textContent = `已授权：${handle.name}。回到录制页，依次点“③ 采集全部清单”→“④ 开始导出”。`;
    } catch (e) {
      $('status').textContent = e?.name === 'AbortError' ? '已取消选择。' : (e.message || String(e));
    }
  };

  // 浏览器把持久权限降级为 prompt 时，恢复读取权限不需要重新挑目录。
  $('restore').onclick = async () => {
    try {
      const handle = await TMeetFiles.directory();
      if (!handle) { $('status').textContent = '没有找到上次的目录记录，请重新选择。'; return; }
      const permission = await handle.requestPermission({ mode: 'read' });
      if (permission !== 'granted') { $('status').textContent = '仍未被授权，请重新选择下载文件夹。'; return; }
      await chrome.storage.local.set({ localDir: { name: handle.name, at: Date.now() } });
      await refreshDir();
      $('status').textContent = `已恢复读取权限：${handle.name}。可以回录制页继续。`;
    } catch (e) { $('status').textContent = e.message; }
  };

  // 第 ② 步（可选）：全量扫描并生成校验报告。
  $('scan').onclick = async () => {
    const dir = await TMeetFiles.status();
    if (!dir.granted) { $('status').textContent = '请先选择下载文件夹并授权。'; return; }
    let handle;
    try { handle = await TMeetFiles.root(); } catch (e) { $('status').textContent = e.message; return; }
    $('scan').disabled = true; report = [];
    try {
      async function scan(current, path = '') {
        for await (const [name, entry] of current.entries()) {
          const filename = path + name;
          if (report.length >= 20000) throw new Error('文件过多，请选择更小的目录');
          if (entry.kind === 'directory') { await scan(entry, filename + '/'); continue; }
          if (!/\.(docx|mp4|m4a|mov)$/i.test(name)) continue;
          const file = await entry.getFile();
          $('status').textContent = '正在检查：' + filename;
          let result; try { result = await TMeetFiles.inspect(file); } catch (e) { result = { valid: false, reason: e.message }; }
          report.push({ filename, size: file.size, ...result });
        }
      }
      await scan(handle);
      const family = path => path.replace(/\\/g, '/').split('/').at(-1).replace(/\s*[（(]\d+[）)](?=\.[^.]+$)/g, '').toLowerCase();
      for (const r of report) if (!r.valid) { const copies = report.filter(f => f.valid && family(f.filename) === family(r.filename)); r.alternatives = copies.map(f => f.filename); r.reason += copies.length ? '；同族有效副本：' + copies.map(f => f.filename).join('、') : '；同族无已验证正本，保留并补救'; }
      // 只把"文件名 + 结论"落库（供续导认领旧文件）；完整报告留在内存里显示和导出，
      // 否则两万条明细会反复整份写入 storage.local。
      await chrome.storage.local.set({ localAuditV3: report.map(r => ({ filename: r.filename, size: r.size, valid: r.valid, modified: r.modified, reason: String(r.reason || '').slice(0, 200) })) });
      $('results').textContent = report.map(r => `${r.valid ? '通过' : '需处理'} | ${r.filename} | ${r.size}字节 | ${r.reason}`).join('\n');
      $('status').textContent = `检查结束：${report.length}个文件，通过${report.filter(r => r.valid).length}个。空壳和孤本全部保留，请根据报告处理。`;
      await records();
    } catch (e) { $('status').textContent = e.message; }
    finally { $('scan').disabled = false; }
  };

  $('refresh').onclick = records;
  $('report').onclick = () => {
    if (!report.length) { $('status').textContent = '还没有可保存的校验结果，请先运行全量校验。'; return; }
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    a.href = url; a.download = '腾讯会议本地校验报告.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  refreshDir().then(dir => {
    if (fromPanel && !dir.granted) $('status').textContent = '请点击上面的“选择下载文件夹（只读）”按钮，只需授权一次。';
  }).catch(e => { $('dir-state').textContent = '无法读取授权状态：' + e.message; });
  records();
})();
