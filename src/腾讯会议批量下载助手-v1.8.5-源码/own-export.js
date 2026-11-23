/* 自己的录制：每次只处理当前课程新建的导出弹窗。
 *
 * v1.7.0：弹窗可能被页面框架整体重建（React portal 重新挂载），旧引用的节点还在内存里
 * 但已脱离文档 —— 继续在它上面找按钮、点按钮都会"点了没反应"。因此每一轮都检查
 * isConnected，失效时重新定位，而不是死抱第一次拿到的引用。
 */
(() => {
  'use strict';
  function create({ rpc, checkStopped, sleep }) {
    const S = TMeetSite.s;
    const trace = (step, details = {}) => console.info('[CS][导出调试] ' + JSON.stringify({ step, ...details }));
    function visible(el) {
      if (el.isConnected === false) return false;
      const r = el.getBoundingClientRect();
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      return r.width > 0 && r.height > 0 && (!style || style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && style.opacity !== '0');
    }
    const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    function dialogs() {
      const candidates = new Set(document.querySelectorAll(S.exportDialog));
      for (const b of document.querySelectorAll(S.button)) {
        if (!visible(b) || !TMeetSite.text.dialogStart.test(text(b))) continue;
        const container = b.closest(S.dialogContainer);
        if (container) candidates.add(container);
      }
      const list = [...candidates].filter(el => visible(el) && !el.closest('#tmeet-batch-dl-panel') && TMeetSite.text.exportDialogHint.test(text(el)));
      // 保留完整弹窗，不能把 footer 当作弹窗而漏掉课程名和视频勾选项。
      return list.filter(el => !list.some(other => other !== el && other.contains(el)));
    }
    /** 重新定位当前唯一弹窗；多于一个就停下，避免课程混淆。 */
    function current() {
      const list = dialogs();
      if (list.length > 1) throw new Error('出现多个导出弹窗，已停止以避免课程混淆');
      return list[0] || null;
    }
    function buttons(root) { return [...root.querySelectorAll(S.button)].filter(visible); }
    async function closePrevious() {
      for (const dialog of dialogs()) {
        checkStopped();
        const close = buttons(dialog).find(b => TMeetSite.text.closeDialog.test(text(b))) ||
          dialog.querySelector(S.dialogClose);
        if (!close) throw new Error('上一课程的导出弹窗仍然打开，无法安全切换课程，请关闭后重试');
        close.click();
        for (let i = 0; i < 25 && visible(dialog) && dialog.isConnected; i++) { checkStopped(); await sleep(200); }
        if (dialog.isConnected && visible(dialog)) throw new Error('导出弹窗未关闭，已停止，避免继续导出上一门课程');
      }
    }
    function verify(dialog, target, known) {
      const title = dialog.querySelector(S.dialogTitle);
      if (title && text(title) && text(title) !== target.name) throw new Error('导出弹窗课程名称与当前课程不一致，已停止');
      const ids = [...dialog.querySelectorAll(S.dialogFileId)].map(el => el.getAttribute('data-file-id')).filter(Boolean);
      if (dialog.hasAttribute('data-file-id')) ids.push(dialog.getAttribute('data-file-id'));
      if (ids.length && !ids.includes(target.fileId)) throw new Error('导出弹窗文件标识与当前课程不一致，已停止');
      const body = text(dialog);
      if (!body.includes(target.name) && known.some(item => item.fileId !== target.fileId && item.name && body.includes(item.name))) throw new Error('弹窗仍指向其他课程，已停止以避免重复下载');
    }
    function choose(dialog, kind) {
      const controls = [...dialog.querySelectorAll(S.exportControl)];
      const desired = kind === 'transcript' ? /逐字稿|转写|纪要|DOCX|Word/i : /视频|MP4|录制文件/i;
      const other = kind === 'transcript' ? /视频|MP4|音频|MP3|M4A/i : /逐字稿|转写|纪要|音频|MP3|M4A/i;
      let chosen = false, relevant = false, conflict = false;
      for (const control of controls) {
        const label = control.closest(S.controlLabel) || (control.labels && control.labels[0]) || control.parentElement;
        if (!label || !visible(label)) continue;
        if (desired.test(text(label))) relevant = true;
        const name = text(label), checked = typeof control.checked === 'boolean' ? control.checked : control.getAttribute('aria-checked') === 'true';
        if (control.disabled || control.getAttribute('aria-disabled') === 'true') {
          if (desired.test(name) && !other.test(name) && checked) chosen = true;
          if (other.test(name) && checked) conflict = true;
          continue;
        }
        if (desired.test(name) && !other.test(name)) {
          if (!chosen) { if (!checked) label.click(); chosen = true; }
          else if (checked && control.type === 'checkbox') label.click();
        } else if (other.test(name) && checked && control.type !== 'radio' && control.getAttribute('role') !== 'radio') label.click();
      }
      return !controls.length || (relevant && chosen && !conflict);
    }
    async function submit(target, ticket, known = []) {
      // 有些逐字稿直接下载；有些录制会先弹出选择视频/音频的第二级确认框。
      let dialog = null;
      for (let i = 0; i < 40; i++) {
        checkStopped();
        dialog = current();
        if (dialog) break;
        if ((await rpc('detect', { ticket })).items.length) return;
        await sleep(200);
      }
      if (!dialog) { trace('dialog.not-found', { kind: target.type, next: '等待原网页直接下载' }); return; }
      trace('dialog.found', { kind: target.type });
      for (let i = 0; i < 60; i++) {
        checkStopped();
        if (!dialog.isConnected) {
          // 框架重建了弹窗：重新定位，重新校验课程，绝不操作脱离文档的旧节点。
          const next = current();
          if (!next) {
            if ((await rpc('detect', { ticket })).items.length) return;
            await sleep(200); continue;
          }
          dialog = next;
        }
        verify(dialog, target, known);
        const ready = choose(dialog, target.type);
        const start = buttons(dialog).find(b => TMeetSite.text.exportStart.test(text(b)));
        if (ready && start && !start.disabled && start.getAttribute('aria-disabled') !== 'true' && !/(?:^|\s)(?:is-disabled|disabled|loading)(?:\s|$)/.test(start.className || '')) {
          await rpc('authorize'); checkStopped(); verify(dialog, target, known);
          // 校时期间按钮本身也可能被重建，即使弹窗容器仍连着文档。
          // 不能继续持有 await 之前的 start 引用，否则 click() 会在死节点上空转。
          const latest = current();
          if (!latest || latest !== dialog) { dialog = latest || dialog; continue; }
          verify(latest, target, known);
          const currentStart = buttons(latest).find(b => TMeetSite.text.exportStart.test(text(b)));
          if (!currentStart || currentStart.isConnected === false || currentStart.disabled || currentStart.getAttribute('aria-disabled') === 'true' || /(?:^|\s)(?:is-disabled|disabled|loading)(?:\s|$)/.test(currentStart.className || '')) continue;
          trace('confirm.click', { kind: target.type, label: text(currentStart) });
          currentStart.click(); // 每门课只确认一次；下载等待交给调用者，不重复触发导出。
          return;
        }
        await sleep(200);
      }
      const labels = dialog?.isConnected ? buttons(dialog).map(text).slice(0, 8).join('、') : '弹窗已关闭';
      trace('confirm.unavailable', { kind: target.type, buttons: labels });
      throw new Error('导出弹窗的“开始导出”按钮未就绪（页面按钮：' + labels + '），请检查导出权限或所选文件类型');
    }
    return Object.freeze({ closePrevious, submit });
  }
  globalThis.TMeetOwnExport = Object.freeze({ create });
})();
