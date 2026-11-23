/* 最小 OOXML 文档（ZIP store），生成真实 .docx，不伪装 HTML 文件。 */
(() => {
  const encode = s => new TextEncoder().encode(s);
  const xml = s => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const table = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = data => { let c = 0xffffffff; for (const b of data) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const local = [], central = []; let offset = 0, centralSize = 0;
    for (const [name, body] of Object.entries(files)) {
      const n = encode(name), b = encode(body), sum = crc(b);
      const h = new Uint8Array(30 + n.length), v = new DataView(h.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
      v.setUint16(12, 0x21, true);
      v.setUint32(14, sum, true); v.setUint32(18, b.length, true); v.setUint32(22, b.length, true); v.setUint16(26, n.length, true); h.set(n, 30);
      const c = new Uint8Array(46 + n.length), d = new DataView(c.buffer);
      d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
      d.setUint16(14, 0x21, true);
      d.setUint32(16, sum, true); d.setUint32(20, b.length, true); d.setUint32(24, b.length, true); d.setUint16(28, n.length, true); d.setUint32(42, offset, true); c.set(n, 46);
      local.push(h, b); central.push(c); offset += h.length + b.length; centralSize += c.length;
    }
    const end = new Uint8Array(22), d = new DataView(end.buffer);
    d.setUint32(0, 0x06054b50, true); d.setUint16(8, central.length, true); d.setUint16(10, central.length, true); d.setUint32(12, centralSize, true); d.setUint32(16, offset, true);
    const result = new Uint8Array(offset + centralSize + 22); let at = 0;
    for (const b of [...local, ...central, end]) { result.set(b, at); at += b.length; }
    return result;
  }
  function create(title, date, segments) {
    const lines = [title, date, ...segments.flatMap(s => [`[${TMeetShared.stamp(s.start)}] ${s.speaker || '发言人'}`, s.text])].filter(Boolean);
    const body = lines.map(s => `<w:p><w:r><w:t xml:space="preserve">${xml(s)}</w:t></w:r></w:p>`).join('');
    return zip({
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`
    });
  }
  globalThis.TMeetDocx = Object.freeze({ create });
})();
