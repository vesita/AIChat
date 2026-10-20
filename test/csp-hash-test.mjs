// CSP 内联脚本 hash 一致性守卫（2026-10-20）。
//
// 现场故障：ui/index.html 的内联「主题预置」脚本改了内容，但 CSP 里两处 hash
// （meta 标签 + src/app.js 的 HTTP 头）都没跟着更新 ⇒ 浏览器拒绝执行内联脚本，
// 控制台只报一行 CSP violation，主题预置失效、排查方向容易被带偏。
// 这条守卫把「内联脚本字节 == 两处声明的 hash」钉死。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

// 取第一个 <script>…</script>（主题预置块）的**精确字节**：CSP 对脚本内容做 hash
const start = html.indexOf('<script>') + '<script>'.length;
const end = html.indexOf('</script>', start);
check(start > 0 && end > start, 'index.html 里有内联脚本块', `start=${start} end=${end}`);
const inline = html.slice(start, end);
const digest = 'sha256-' + crypto.createHash('sha256').update(inline, 'utf8').digest('base64');

const metaHashes = [...html.matchAll(/sha256-([A-Za-z0-9+/=]{20,})/g)].map((m) => 'sha256-' + m[1]);
const headerHashes = [...appSrc.matchAll(/sha256-([A-Za-z0-9+/=]{20,})/g)].map((m) => 'sha256-' + m[1]);

check(metaHashes.includes(digest), 'meta 标签里的 CSP hash 与实际内联脚本一致', `实际 ${digest}\nmeta ${JSON.stringify(metaHashes)}`);
check(headerHashes.includes(digest), 'src/app.js HTTP 头里的 CSP hash 与实际内联脚本一致', `实际 ${digest}\nheader ${JSON.stringify(headerHashes)}`);
check(metaHashes.length === 1 && headerHashes.length === 1, '两处各只声明一个内联脚本 hash（多出来的必然过期）',
  `meta=${metaHashes.length} header=${headerHashes.length}`);

// 负向对照：把内联脚本改动一个字节，hash 必须不再匹配（证明断言不是永真）
{
  const tampered = inline + ' ';
  const d2 = 'sha256-' + crypto.createHash('sha256').update(tampered, 'utf8').digest('base64');
  check(d2 !== digest, '负向对照：内联脚本内容一变，hash 立即不同（守卫有效）');
}

console.log(`\nCSP 内联脚本 hash 守卫：通过 ${pass}，失败 ${fail}`);
if (fail) { console.log('存在失败'); process.exit(1); }
console.log('全部通过 ✅');
