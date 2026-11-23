/**
 * 一键跑全部真浏览器 E2E（三个脚本串行）。
 *
 * 前提：先起一个带调试端口的 Chrome（命令见 tests/README.md）。
 * 用法：node tests/run-e2e.mjs
 *
 * 为什么串行：三个脚本都要加载同一个扩展、都要清草稿、都要抢「我的录制」标签页，
 * 并行跑会互相踩。串行总共约 1 分钟，够快了。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  ['DOCX 完整性 / 五步结构', 'e2e-cdp.mjs'],
  ['单页流程（注入→连接→采集→筛选→导出前置）', 'e2e-flow.mjs'],
  ['翻页采集（65 条 / 7 页，验漏项）', 'e2e-multipage.mjs']
];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    child.on('close', (code) => {
      const m = out.match(/# 共 (\d+) 项，通过 (\d+)，失败 (\d+)/);
      resolve({ code, total: m ? Number(m[1]) : 0, pass: m ? Number(m[2]) : 0, fail: m ? Number(m[3]) : 0 });
    });
  });
}

const rows = [];
for (const [name, file] of SUITES) {
  console.log(`\n=== ${name}（${file}）===`);
  const r = await run(file);
  rows.push({ name, file, ...r });
}

console.log('\n===== 汇总 =====');
for (const r of rows) {
  console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.file.padEnd(20)} ${r.pass}/${r.total}`);
}
const failed = rows.filter((r) => r.code !== 0);
const total = rows.reduce((a, r) => a + r.total, 0);
const pass = rows.reduce((a, r) => a + r.pass, 0);
console.log(`合计：${pass}/${total} 项通过`);
process.exit(failed.length ? 1 : 0);
