/* 目录授权的最小单元：probe 必须用内存句柄真读一次，
 * 不能只看"句柄存进去了"就报成功——"选完就掉"就是这么来的。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function api() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'local-files.js'), 'utf8'), context);
  return context.TMeetFiles;
}

test('probe：能读出条目才算授权成功', async () => {
  const files = api();
  const handle = {
    name: 'Downloads',
    queryPermission: async () => 'granted',
    async *entries() { yield ['课程.docx', {}]; }
  };
  const result = await files.probe(handle);
  assert.equal(result.ok, true);
  assert.equal(result.name, '课程.docx');
  assert.equal(result.permission, 'granted');
});

test('probe：空目录也算授权可用', async () => {
  const files = api();
  const handle = { name: '空目录', queryPermission: async () => 'granted', async *entries() {} };
  const result = await files.probe(handle);
  assert.equal(result.ok, true);
  assert.equal(result.name, '');
});

test('probe：权限未授予时明确失败，并带回 permission', async () => {
  const files = api();
  const result = await files.probe({ name: 'Downloads', queryPermission: async () => 'prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.permission, 'prompt');
  assert.match(result.reason, /prompt/);
});

test('probe：没有句柄时不假装成功', async () => {
  const result = await api().probe(null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有拿到目录句柄/);
});

test('probe：读取抛错（目录被移动/删除）时返回失败而不是抛出', async () => {
  const files = api();
  const handle = { name: 'Gone', queryPermission: async () => 'granted', async *entries() { throw new Error('NotFoundError'); } };
  const result = await files.probe(handle);
  assert.equal(result.ok, false);
  assert.match(result.reason, /NotFoundError/);
});

test('status：没有 IndexedDB 时返回可判定的失败，不抛异常', async () => {
  const files = api();
  const result = await files.status();
  assert.equal(result.granted, false);
  assert.equal(result.permission, 'error');
});

// ---------------------------------------------------------------------------
// DOCX 完整性判定
// 用真实的 OOXML（TMeetDocx.create 生成合法 ZIP）造样本，
// 只把 DOMParser 换成一个够用的 XML 桩（node 没有内置 DOMParser）。
// ---------------------------------------------------------------------------
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlStub() {
  return class DOMParserStub {
    parseFromString(source) {
      // 不靠正则找标签：转义层级太容易出错，直接按字符串切，行为更好预测。
      const tags = (name) => {
        const open = '<' + name, close = '</' + name + '>';
        const out = [];
        let i = 0;
        for (;;) {
          const s = source.indexOf(open, i);
          if (s < 0) break;
          const gt = source.indexOf('>', s);
          if (gt < 0) break;
          const e = source.indexOf(close, gt);
          if (e < 0) break;
          out.push(source.slice(gt + 1, e));
          i = e + close.length;
        }
        return out;
      };
      const bodyStub = {
        getElementsByTagNameNS: (_ns, name) => {
          if (name === 'p') return tags('w:p').map(() => ({}));
          if (name === 't') return tags('w:t').map(s => ({ textContent: unescapeXml(s) }));
          return [];
        }
      };
      return {
        getElementsByTagName: (name) => (/^parsererror$/i.test(name) && /<parsererror/i.test(source) ? [{}] : []),
        getElementsByTagNameNS: (_ns, name) => (name === 'body' ? [bodyStub] : [])
      };
    }
  };
}

function docxContext() {
  const context = vm.createContext({
    console, TextEncoder, TextDecoder, URL,
    DOMParser: xmlStub(),
    Blob: class {}, // store 模式的 ZIP 不会走到解压分支
    DecompressionStream: class {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared-core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared-docx.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'local-files.js'), 'utf8'), context);
  return context;
}

function docxFile(bytes, name = '课程_逐字稿.docx') {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test('DOCX 校验：完全没正文的空模板判失败', async () => {
  const ctx = docxContext();
  const bytes = ctx.TMeetDocx.create('', '', []);
  const result = await ctx.TMeetFiles.inspect(docxFile(bytes), 'transcript');
  assert.equal(result.valid, false);
  assert.match(result.reason, /空Word模板|正文为空/);
  assert.equal(result.characters, 0);
});

test('DOCX 校验：只有标题和一两句话（腾讯没生成完）必须判失败，不能算成功', async () => {
  const ctx = docxContext();
  const bytes = ctx.TMeetDocx.create('私域变现3大抓手', '2026-10-29', [
    { start: 0, speaker: '麦爸', text: '大家好，今天我们聊私域变现。' }
  ]);
  const result = await ctx.TMeetFiles.inspect(docxFile(bytes), 'transcript');
  assert.equal(result.valid, false, '只有二十几个字不能当作完整逐字稿');
  assert.match(result.reason, /正文只有 \d+ 字/);
  assert.match(result.reason, /确认逐字稿已生成完整/);
  assert.ok(result.characters > 0 && result.characters < ctx.TMeetFiles.MIN_TRANSCRIPT_CHARS);
});

test('DOCX 校验：正常逐字稿通过，并报告字数与段落数', async () => {
  const ctx = docxContext();
  const line = '我们来看一下这个会员工作台的四个板块，认知、成交实战营、私教 MVP 和战略班。';
  const segments = Array.from({ length: 20 }, (_, i) => ({ start: i * 45, speaker: '麦爸', text: line }));
  const bytes = ctx.TMeetDocx.create('何成兵商业操作系统 V1.0 第六课', '2026-10-29', segments);
  const result = await ctx.TMeetFiles.inspect(docxFile(bytes), 'transcript');
  assert.equal(result.valid, true, result.reason);
  assert.match(result.reason, /正文 \d+ 字 \/ \d+ 段/);
  assert.ok(result.characters > 600, '实际字数应该被算出来');
  assert.ok(result.paragraphs >= 20, '段落数应该被算出来');
});

test('DOCX 校验：文件被截断（CRC 或索引对不上）直接抛错，不会当成有效', async () => {
  const ctx = docxContext();
  const bytes = ctx.TMeetDocx.create('课程', '2026-10-29', [{ start: 0, speaker: 'A', text: '内容' }]);
  const broken = bytes.slice(0, bytes.length - 40);
  await assert.rejects(
    () => ctx.TMeetFiles.inspect(docxFile(broken), 'transcript'),
    /Word ZIP|索引|截断/,
    '截断的文件必须报错，不能静默算通过'
  );
});

test('documentText 仍然返回纯文本（兼容旧调用）', async () => {
  const ctx = docxContext();
  const bytes = ctx.TMeetDocx.create('标题', '2026-10-29', [{ start: 0, speaker: 'A', text: '正文内容' }]);
  const text = await ctx.TMeetFiles.documentText(bytes);
  assert.equal(typeof text, 'string');
  assert.match(text, /正文内容/);
});

// ---------------------------------------------------------------------------
// locate：按下载记录里的路径找文件，找不到时按"去掉 (N) 重名后缀"再找一次
// ---------------------------------------------------------------------------
function apiWithHandle(handle) {
  const state = { value: handle };
  const context = vm.createContext({
    setTimeout,
    indexedDB: {
      open() {
        const request = {};
        setTimeout(() => {
          request.result = {
            transaction() {
              const tx = { oncomplete: null, onerror: null };
              setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
              tx.objectStore = () => ({
                get: () => ({ result: state.value }),
                put: (v) => { state.value = v; return {}; },
              });
              return tx;
            },
            close() {},
          };
          request.onsuccess && request.onsuccess();
        }, 0);
        return request;
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'local-files.js'), 'utf8'), context);
  return context.TMeetFiles;
}

function fakeFile(name, size = 128) {
  const file = { name, size, lastModified: 1700000000000 };
  return { kind: 'file', name, getFile: async () => file };
}

test('locate：路径完全对得上时直接命中', async () => {
  const file = fakeFile('逐字稿 (1).docx');
  const handle = {
    name: 'Downloads',
    queryPermission: async () => 'granted',
    async getFileHandle(name) {
      if (name !== file.name) throw new Error('NotFoundError');
      return { getFile: async () => ({ name, size: file.size }) };
    },
    async getDirectoryHandle() { throw new Error('NotFoundError'); },
    async *values() {},
  };
  const found = await apiWithHandle(handle).locate('C:/Users/me/Downloads/逐字稿 (1).docx');
  assert.equal(found.name, '逐字稿 (1).docx');
});

test('locate：记录里的名字对不上时，按去掉 (N) 后缀的名字兜底找到', async () => {
  const file = fakeFile('逐字稿 (1).docx');
  const handle = {
    name: 'Downloads',
    queryPermission: async () => 'granted',
    async getFileHandle() { throw new Error('NotFoundError'); },
    async getDirectoryHandle() { throw new Error('NotFoundError'); },
    async *values() { yield file; },
  };
  const found = await apiWithHandle(handle).locate('C:/Users/me/Downloads/逐字稿.docx');
  assert.equal(found.name, '逐字稿 (1).docx', 'Windows 重名后的文件也要能找到');
});

test('locate：同名文件有多个时不乱认，报可理解的错误', async () => {
  const handle = {
    name: 'Downloads',
    queryPermission: async () => 'granted',
    async getFileHandle() { throw new Error('NotFoundError'); },
    async getDirectoryHandle() { throw new Error('NotFoundError'); },
    async *values() { yield fakeFile('逐字稿 (1).docx'); yield fakeFile('逐字稿 (2).docx'); },
  };
  await assert.rejects(
    () => apiWithHandle(handle).locate('C:/Users/me/Downloads/逐字稿.docx'),
    /不存在或不在所选下载目录/
  );
});

test('locate：真的没有时，错误里说清楚接下来该做什么', async () => {
  const handle = {
    name: 'Downloads',
    queryPermission: async () => 'granted',
    async getFileHandle() { throw new Error('NotFoundError'); },
    async getDirectoryHandle() { throw new Error('NotFoundError'); },
    async *values() { yield fakeFile('别的课程.docx'); },
  };
  await assert.rejects(
    () => apiWithHandle(handle).locate('C:/Users/me/Downloads/逐字稿.docx'),
    /授权的是浏览器实际下载的文件夹|被移动|改名|删除/
  );
});
