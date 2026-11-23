/* 极简 DOM：只实现本项目测试需要的查询子集。
 * 支持：后代选择器（空格）、逗号分组、tag、.class、#id、
 *      [attr]、[attr="v"]、[attr*="v"]、以及它们的组合（如 [class*="a"][class*="b"]）。
 * 不支持：> + ~ :nth-child 等；测试里不要用。
 */
'use strict';

function parseCompound(part) {
  const tag = (/^[a-zA-Z][\w-]*/.exec(part) || [null])[0];
  const ids = [...part.matchAll(/#([\w-]+)/g)].map(m => m[1]);
  const classes = [...part.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
  const attrs = [...part.matchAll(/\[([\w-]+)(?:([*^$]?)="([^"]*)")?\]/g)].map(m => ({ name: m[1], op: m[2] === '' ? '=' : (m[2] || null), value: m[3] }));
  return { tag: tag ? tag.toLowerCase() : null, ids, classes, attrs };
}

function matchesCompound(node, compound) {
  if (compound.tag && node.tag !== compound.tag) return false;
  for (const id of compound.ids) if (node.attrs.id !== id) return false;
  for (const name of compound.classes) if (!node.classes.has(name)) return false;
  for (const attr of compound.attrs) {
    const value = attr.name === 'class' ? [...node.classes].join(' ') : node.attrs[attr.name];
    if (value === undefined || value === null) return false;
    if (attr.op === '=' && value !== attr.value) return false;
    if (attr.op === '*' && !String(value).includes(attr.value)) return false;
    if (attr.op === '^=' && !String(value).startsWith(attr.value)) return false;
    if (attr.op === '$=' && !String(value).endsWith(attr.value)) return false;
  }
  return true;
}

function matches(node, selector) {
  return String(selector).split(',').some(group => {
    const parts = group.trim().split(/\s+/).filter(Boolean).map(parseCompound);
    if (!parts.length) return false;
    if (!matchesCompound(node, parts[parts.length - 1])) return false;
    let index = parts.length - 2;
    for (let parent = node.parent; parent && index >= 0; parent = parent.parent) {
      if (matchesCompound(parent, parts[index])) index--;
    }
    return index < 0;
  });
}

function descendants(root, out = []) {
  for (const child of root.children) { out.push(child); descendants(child, out); }
  return out;
}

function queryAll(root, selector) {
  return descendants(root).filter(node => matches(node, selector));
}

function createDocument(children = []) {
  const root = node('#document', { children });
  return {
    documentElement: root,
    body: root,
    querySelectorAll: selector => queryAll(root, selector),
    querySelector: selector => queryAll(root, selector)[0] || null,
    getElementById: id => queryAll(root, '#' + id)[0] || null,
    createElement(tag) { return node(tag); }
  };
}

function node(tag, options = {}) {
  const element = {
    tag: String(tag).toLowerCase(),
    text: options.text || '',
    rawText: options.rawText,
    classes: new Set((options.className || '').split(/\s+/).filter(Boolean)),
    attrs: { ...(options.attrs || {}) },
    children: [],
    parent: null,
    connected: options.connected !== false,
    hidden: options.hidden === true,
    clicks: 0,
    disabled: options.disabled === true,
    className: options.className || '',
    checked: options.checked === true,
    type: options.type || '',
    onClick: options.onClick,
    get innerText() { return this.rawText !== undefined ? this.rawText : [this.text, ...this.children.map(c => c.innerText)].filter(Boolean).join(' '); },
    get textContent() { return this.innerText; },
    get isConnected() { return this.connected && (!this.parent || this.parent.isConnected); },
    getBoundingClientRect() { return this.hidden ? { width: 0, height: 0, x: 0, y: 0 } : { width: 120, height: 32, x: 10, y: 10 }; },
    getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
    hasAttribute(name) { return this.attrs[name] !== undefined; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    querySelectorAll(selector) { return queryAll(this, selector); },
    querySelector(selector) { return queryAll(this, selector)[0] || null; },
    closest(selector) {
      for (let current = this; current; current = current.parent) if (matches(current, selector)) return current;
      return null;
    },
    contains(other) {
      for (let current = other; current; current = current.parent) if (current === this) return true;
      return false;
    },
    append(...nodes) { for (const child of nodes) this.appendChild(child); },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    focus() {},
    blur() {},
    dispatchEvent() { return true; },
    click() { this.clicks++; this.onClick?.(); },
    scrollIntoView() {}
  };
  for (const child of options.children || []) element.appendChild(child);
  return element;
}

module.exports = { node, matches, queryAll, createDocument };
