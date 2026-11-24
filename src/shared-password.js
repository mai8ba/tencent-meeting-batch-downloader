/* MAIN world：让受控表单在页面自己的运行环境中接收到真实的值变更事件。 */
(() => {
  'use strict';
  if (window.__tmeetPasswordBridge) return;
  window.__tmeetPasswordBridge = true;
  const synchronized = new WeakMap();
  const filledValues = new WeakMap();
  // MAIN world 里站点适配层可能没就绪（扩展热重载后页面没刷新，注入的还是旧脚本）。
  // 用可选链取值，缺了就安静退出，不要抛 ReferenceError 把控制台刷红、
  // 掩盖真正的报错信息。
  const S = globalThis.TMeetSite?.s;
  if (!S) {
    console.warn('[CS][分享页] 站点适配层未就绪，本次不启用密码自动填充；刷新页面（F5）后恢复');
    return;
  }
  let busy = false, submitted = 0, lastSubmit = -Infinity;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function visible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }
  function context(input) {
    return input.closest(S.passwordScope) || input.parentElement;
  }
  function find() {
    const candidates = [...document.querySelectorAll(S.pageInput)].filter(el => visible(el) && !el.disabled && !el.readOnly && /^(text|password|tel|number|)$/i.test(el.type));
    return candidates.map(input => {
      const scope = context(input), text = (scope?.innerText || '').slice(0, 1000);
      const own = [input.placeholder, input.getAttribute('aria-label'), input.name, input.id, ...[...(input.labels || [])].map(label => label.innerText)].join(' ');
      const explicit = /访问密码|访问码|提取码|录制密码|分享密码/.test(own);
      const gate = /访问密码|访问码|提取码|录制密码|分享密码|前往查看|查看录制/.test(text) || /record.*password|share.*password|access.*password/i.test(scope?.className || '');
      if (!explicit && !gate) return null;
      if (/账号|帐号|手机号|邮箱|验证码|短信/.test(own) && !explicit) return null;
      const score = explicit ? 100 : /密码/.test(own) || input.type === 'password' ? 80 : 40;
      return { input, scope, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score)[0];
  }
  function syncControlled(input, value, force = false) {
    // 腾讯会议的 Met 输入框有时不响应合成 DOM change；恢复其 React 受控状态。
    // 仅限已经识别的录制访问密码输入框，不触碰登录表单。
    const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps$'));
    const props = propsKey && input[propsKey];
    if (typeof props?.onChange !== 'function' || (!force && synchronized.get(input) === value)) return;
    synchronized.set(input, value);
    const nativeEvent = new InputEvent('input', { bubbles: true, data: value, inputType: 'insertFromPaste' });
    // 页面会同步把 DOM value 遮罩为“•••7”，事件必须保留原始密码快照。
    const target = new Proxy(input, { get(node, key) {
      if (key === 'value') return value;
      const member = Reflect.get(node, key, node);
      return typeof member === 'function' ? member.bind(node) : member;
    } });
    props.onChange({ target, currentTarget: target, nativeEvent, type: 'change',
      preventDefault() { nativeEvent.preventDefault(); }, stopPropagation() { nativeEvent.stopPropagation(); },
      persist() {}, isDefaultPrevented() { return nativeEvent.defaultPrevented; }, isPropagationStopped() { return false; } });
  }
  function displayMatches(input, value) {
    if (input.value === value) return true;
    // 仅认可本脚本已填入的这个输入框，不能把任意现成遮罩当作已知密码。
    if (filledValues.get(input) !== value) return false;
    const shown = String(input.value || '');
    if (shown.length !== value.length || !/^[•●*·]+[^•●*·]*$/.test(shown)) return false;
    const suffix = shown.replace(/^[•●*·]+/, '');
    return !suffix || value.endsWith(suffix);
  }
  function fill(input, value) {
    if (displayMatches(input, value)) { syncControlled(input, value); return; }
    const before = input.value;
    filledValues.set(input, value);
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    // React 受控输入可能已记录值，确保 input 事件不会被当作“没有变化”。
    if (input._valueTracker && typeof input._valueTracker.setValue === 'function') input._valueTracker.setValue(before);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || 'Unidentified' }));
    syncControlled(input, value);
    input.blur();
  }
  const buttonText = el => (el.innerText || el.textContent || el.value || '').replace(/\s|[\u200b-\u200d\ufeff]/g, '');
  function button(scope) {
    const candidates = [...(scope || document).querySelectorAll(S.submitButton)]
      .filter(el => visible(el) && TMeetSite.text.passwordSubmit.test(buttonText(el)));
    return candidates.find(el => buttonText(el) === '前往查看') || candidates[0];
  }
  function blocked() {
    const text = (document.body?.innerText || '').slice(0, 10000);
    if (/密码.{0,8}(错误|不正确|不匹配)|访问码.{0,8}错误/.test(text)) return 'wrong-password';
    if (/请完成.{0,8}验证|拖动滑块|安全验证|人机验证/.test(text)) return 'challenge';
    return '';
  }
  function reactClick(element) {
    for (let node = element, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const key = Object.keys(node).find(k => /^__react(?:Props|EventHandlers)\$/.test(k));
      const handler = key && node[key]?.onClick;
      if (typeof handler !== 'function') continue;
      const nativeEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 });
      handler({ type: 'click', target: element, currentTarget: node, nativeEvent, button: 0, buttons: 0, detail: 1,
        preventDefault() { nativeEvent.preventDefault(); }, stopPropagation() { nativeEvent.stopPropagation(); },
        persist() {}, isDefaultPrevented() { return nativeEvent.defaultPrevented; }, isPropagationStopped() { return false; } });
      return true;
    }
    return false;
  }
  function nativeClick(element) {
    element.focus();
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Constructor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      element.dispatchEvent(new Constructor(type, { bubbles: true, cancelable: true, view: window, button: 0, buttons: type.endsWith('down') ? 1 : 0 }));
    }
    element.click();
  }
  async function apply(password) {
    const found = find();
    if (!found) return { found: false, state: 'waiting' };
    const failure = blocked();
    if (failure) return { found: true, state: failure };
    // 点击不等于进入成功：等待页面状态，再按间隔补交，最多三次。
    if (submitted && performance.now() - lastSubmit < 3500) return { found: true, filled: true, state: 'awaiting-open' };
    if (submitted >= 3) return { found: true, filled: true, state: 'submit-failed' };
    const passwordInputs = [...found.scope.querySelectorAll('input')].filter(el => visible(el) && !el.disabled && !el.readOnly && el.maxLength === 1 && /^(text|password|tel|number)$/.test(el.type));
    const split = passwordInputs.length === password.length && passwordInputs.length > 1;
    if (split) passwordInputs.forEach((input, index) => { fill(input, password[index]); syncControlled(input, password[index], true); });
    else { fill(found.input, password); syncControlled(found.input, password, true); }
    // 等待框架把密码更新到提交函数闭包中，不使用刚填值时的旧点击处理器。
    await pause(600);
    const current = find();
    if (!current) return { found: false, state: 'opened' };
    if ((!split && !displayMatches(current.input, password)) || (split && passwordInputs.some((input, index) => !input.isConnected || !displayMatches(input, password[index])))) return { found: true, state: 'rerendered' };
    const submit = button(current.scope) || button(document);
    if (!submit || submit.disabled || submit.getAttribute('aria-disabled') === 'true' || /(?:^|\s)(?:is-disabled|disabled)(?:\s|$)/.test(submit.className || '')) return { found: true, filled: true, state: 'waiting-button' };
    const beforeClick = blocked();
    if (beforeClick) return { found: true, state: beforeClick };
    const retry = submitted > 0;
    submitted++; lastSubmit = performance.now();
    // 普通点击未打开页面时，用同一个按钮的页面框架处理器恢复一次事件委托。
    if (!retry || !reactClick(submit)) nativeClick(submit);
    for (let i = 0; i < 12; i++) {
      await pause(150);
      const failure = blocked();
      if (failure) return { found: true, state: failure };
      if (!find()) return { found: false, filled: true, state: 'opened' };
    }
    return { found: true, filled: true, state: submitted >= 3 ? 'submit-failed' : 'awaiting-open' };
  }
  window.addEventListener('tmeet.shared.password', async event => {
    let payload;
    try { payload = JSON.parse(event.detail); } catch { return; }
    if (!payload || typeof payload.id !== 'string' || typeof payload.password !== 'string' || !payload.password || payload.password.length > 128 || busy) return;
    busy = true;
    let result;
    try { result = await apply(payload.password); } catch { result = { state: 'waiting' }; }
    finally { busy = false; }
    window.dispatchEvent(new CustomEvent('tmeet.shared.password-result', { detail: JSON.stringify({ id: payload.id, ...result }) }));
  });
})();
