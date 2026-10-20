// 平台闸回归：Linux 上不许跑 Windows 协议端安装器。
//
// 背景：scripts/setup.mjs（Windows 版 SnowLuma + 便携 QQ）与 scripts/setup-napcat.mjs
// （NapCat.Shell.Windows.Node）装的都是 Windows 二进制。在生产 Linux 上跑它们会
// 「✅ 安装成功」但根本不可用，还会把控制台带进错误的「内置协议端」叙事。
// 现在两者都必须在**非 win32 平台、任何网络请求与文件写入之前**退出，并指向
// deploy/napcat.container（容器形态：OneBot WS 3001 + HTTP 3002）。
//
// 本测试真跑这两个脚本（面向 Linux/非 Windows 部署机），验证：
//   1. setup.mjs（安装路径）非零退出、输出含「Windows」与 deploy/napcat.container，
//      且没有发生任何网络请求/文件写入（--require 注入 stub 拦截 fetch / fs 写 / 子进程，
//      要求零命中；运行前后协议端目录也不变）。
//   2. setup.mjs --check 在外部协议端模式下 exit 0，明确报告协议端在外部（含 3001/3002），
//      不再用「缺失」口径把外部模式报成失败。
//   3. setup-napcat.mjs（安装路径与 --check）非零退出，同样指向容器方案。
//   4. 负向对照：--require 把 process.platform 伪造成 win32 —— 证明闸只在非 win32 触发：
//        · setup.mjs --check 走 Windows 分支（报 SnowLuma 缺失 / CLIENT_BUILD，无外部文案）；
//        · setup-napcat.mjs --check 走 Windows 分支（报未安装，无容器指引）；
//        · setup.mjs（安装路径）越过平台闸进入安装流程，被 stub 拦下第一次写（exit=97）。
//      注意：win32 真机上不会执行这个测试（见下方平台前置），这里只伪造 platform，不改别的逻辑。
//
// 运行：node test/setup-platform-gate-test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(ROOT, 'scripts', 'setup.mjs');
const SETUP_NAPCAT = path.join(ROOT, 'scripts', 'setup-napcat.mjs');
const STUB_EXIT = 97;   // stub 命中 = 发生了网络/写入尝试 ⇒ 平台闸失效

let pass = 0; let fail = 0;
const ok = (m, d) => { pass++; console.log('  ✓ ' + m + (d ? `（${d}）` : '')); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + String(d).split('\n').join('\n      ')); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const tail = (s, n = 700) => { const t = String(s || '').trim(); return t.length > n ? '…' + t.slice(-n) : (t || '(无输出)'); };

if (process.platform === 'win32') {
  // win32 上平台闸本就不该触发，这个测试没有断言对象 —— 明确说明而不是静默跳过。
  console.log('平台闸：当前平台是 win32，平台闸不会触发；本测试面向 Linux/非 Windows 部署机。');
  console.log('\n全部通过（未执行：平台不适用）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-platform-gate-'));
const FAKE_WIN32 = path.join(tmp, 'fake-win32.cjs');
const NO_SIDE_EFFECTS = path.join(tmp, 'no-side-effects.cjs');

// ── 测试替身 A：伪造 process.platform === 'win32'（只用于负向对照）──
fs.writeFileSync(FAKE_WIN32, [
  '// 测试专用：伪造平台，仅用于验证「平台闸只在非 win32 触发」',
  "try { Object.defineProperty(process, 'platform', { value: 'win32' }); }",
  "catch (e) { console.error('fake-win32 失败:', e && e.message); process.exit(98); }",
  ''
].join('\n'));

// ── 测试替身 B：拦截一切会改变现场/联网的入口；命中即打印并退出 97 ──
// 只拦「写/联网」语义。⚠️ 不能拦 fs.openSync / fs.open：Node 的 ESM loader 用公开
// fs.readFileSync 读模块（内部会走 openSync），拦它会让加载主模块本身误触。
// 命中信息用低层 fs.writeSync(2, …) 写 stderr —— 不能走 appendFileSync/writeFileSync，
// 它们内部会再调被我们 patch 的同族函数（自递归）。
fs.writeFileSync(NO_SIDE_EFFECTS, [
  '// 测试专用：平台闸要求退出发生在任何网络请求/文件写入之前 —— 这些入口一次都不该被调用。',
  "const fs = require('node:fs');",
  "const cp = require('node:child_process');",
  "const http = require('node:http');",
  "const https = require('node:https');",
  'function trip(what) {',
  "  try { fs.writeSync(2, '[side-effect] ' + what + '\\n'); } catch { /* ignore */ }",
  '  process.exit(97);',
  '}',
  "for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync',",
  "  'copyFileSync', 'createWriteStream', 'writeFile', 'mkdir', 'rm', 'rename',",
  "  'copyFile', 'appendFile']) {",
  '  if (typeof fs[name] === "function") fs[name] = () => trip("fs." + name);',
  '}',
  "if (fs.promises) for (const name of ['writeFile', 'mkdir', 'rm', 'rename', 'copyFile', 'appendFile']) {",
  '  if (typeof fs.promises[name] === "function") fs.promises[name] = () => trip("fs.promises." + name);',
  '}',
  'if (typeof globalThis.fetch === "function") globalThis.fetch = () => trip("fetch");',
  'http.request = () => trip("http.request");',
  'https.request = () => trip("https.request");',
  "for (const name of ['execFileSync', 'spawn', 'spawnSync', 'execSync', 'exec', 'execFile']) {",
  '  if (typeof cp[name] === "function") cp[name] = () => trip("child_process." + name);',
  '}',
  ''
].join('\n'));

/** stub 命中记录在子进程 stderr 的 '[side-effect] …' 行里（见测试替身 B）。 */
function stubHits(out) {
  return String(out || '').split('\n').map((s) => s.trim()).filter((s) => s.startsWith('[side-effect] '));
}
function protocolDirs() {
  return ['snowluma', 'runtime', 'napcat'].map((d) => `${d}:${fs.existsSync(path.join(ROOT, d)) ? '有' : '无'}`);
}

function run(script, args, { fakePlatform = false, guard = false } = {}) {
  const preloads = [];
  if (fakePlatform) preloads.push('--require', FAKE_WIN32);
  if (guard) preloads.push('--require', NO_SIDE_EFFECTS);
  const env = { ...process.env };
  if (preloads.length) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} ${preloads.join(' ')}`.trim();
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    code: r.status,
    signal: r.signal,
    out: String(r.stdout || '') + String(r.stderr || ''),
    spawnError: r.error ? String(r.error.message || r.error) : ''
  };
}

function main() {
  console.log('平台闸：Linux 上不许安装 Windows 协议端');
  console.log(`  仓库：${ROOT}`);
  console.log(`  平台：${process.platform}`);
  const dirsBefore = protocolDirs();

  // ── 1) setup.mjs 安装路径：平台闸 + 零网络/零写入 ──
  {
    console.log('\n[1] node scripts/setup.mjs（Linux 安装路径）');
    const r = run(SETUP, [], { guard: true });
    check(r.code !== 0 && r.code !== STUB_EXIT,
      '非零退出（平台不适用，不进入安装流程）',
      `exit=${r.code}, signal=${r.signal}${r.spawnError ? `, spawnError=${r.spawnError}` : ''}\n${tail(r.out)}`);
    check(r.out.includes('Windows') && r.out.includes('deploy/napcat.container'),
      '输出含「Windows」与容器出路 deploy/napcat.container',
      tail(r.out));
    check(r.out.includes('3001') && r.out.includes('3002'),
      '输出给出 Linux 正确端口（WS 3001 / HTTP 3002）',
      tail(r.out));
    const hit = stubHits(r.out);
    check(hit.length === 0,
      '退出发生在任何网络请求/文件写入之前（stub 零命中）',
      hit.length ? `stub 命中：${hit.join(', ')}` : 'stub 从未被调用');
    check(JSON.stringify(protocolDirs()) === JSON.stringify(dirsBefore),
      '运行前后协议端目录未变（没有落盘 snowluma/runtime/napcat）',
      `${dirsBefore.join(' ')} → ${protocolDirs().join(' ')}`);
  }

  // ── 2) setup.mjs --check：外部协议端模式，exit 0 且说清形态 ──
  {
    console.log('\n[2] node scripts/setup.mjs --check（Linux）');
    const r = run(SETUP, ['--check'], { guard: true });
    check(r.code === 0,
      'exit 0（外部协议端模式：这不是失败）',
      `exit=${r.code}, signal=${r.signal}\n${tail(r.out)}`);
    check(r.out.includes('外部') && r.out.includes('deploy/napcat.container')
      && r.out.includes('3001') && r.out.includes('3002'),
      '明确报告协议端在外部（容器 + WS 3001 / HTTP 3002）',
      tail(r.out));
    check(!r.out.includes('缺失'),
      '不再用「缺失」口径把外部模式报成失败',
      tail(r.out));
    const hit = stubHits(r.out);
    check(hit.length === 0, '--check 只读（stub 零命中）', hit.length ? `stub 命中：${hit.join(', ')}` : 'stub 从未被调用');
  }

  // ── 3) setup-napcat.mjs：两入口都必须被闸住 ──
  for (const args of [[], ['--check']]) {
    console.log(`\n[3] node scripts/setup-napcat.mjs ${args.join(' ')}`.trim() + '（Linux）');
    const r = run(SETUP_NAPCAT, args, { guard: true });
    check(r.code !== 0 && r.code !== STUB_EXIT,
      '非零退出（Windows Shell 包在 Linux 不可运行）',
      `exit=${r.code}, signal=${r.signal}\n${tail(r.out)}`);
    check(r.out.includes('Windows') && r.out.includes('deploy/napcat.container'),
      '输出含「Windows」与容器出路 deploy/napcat.container',
      tail(r.out));
    const hit = stubHits(r.out);
    check(hit.length === 0, '闸先于网络/写入（stub 零命中）', hit.length ? `stub 命中：${hit.join(', ')}` : 'stub 从未被调用');
  }

  // ── 4) 负向对照：伪造 win32，证明闸只在非 win32 触发 ──
  console.log('\n[4] 负向对照：伪造 process.platform === "win32"');
  {
    const r = run(SETUP, ['--check'], { fakePlatform: true });
    const installed = fs.existsSync(path.join(ROOT, 'snowluma', 'index.mjs'));
    const win32Expected = installed
      ? { why: '已装 SnowLuma ⇒ 报 CLIENT_BUILD（可能仍因便携 QQ 缺失而 exit 1）', ok: r.out.includes('CLIENT_BUILD') }
      : { why: '未装 SnowLuma ⇒ 明确报缺失', ok: /SnowLuma:[^\n]*缺失/.test(r.out) };
    check(win32Expected.ok && !r.out.includes('deploy/napcat.container') && !r.out.includes('外部'),
      'setup.mjs --check 走 Windows 分支（不再输出外部协议端文案）',
      `${win32Expected.why}\nexit=${r.code}\n${tail(r.out)}`);
  }
  {
    const r = run(SETUP_NAPCAT, ['--check'], { fakePlatform: true, guard: true });
    check(r.code === 1 && r.out.includes('未安装') && !r.out.includes('deploy/napcat.container'),
      'setup-napcat.mjs --check 走 Windows 分支（报未安装，不再输出容器指引）',
      `exit=${r.code}\n${tail(r.out)}`);
  }
  {
    // 安装路径：fake win32 时平台闸不该触发 ⇒ 会进入 Windows 安装流程；
    // 由 stub 拦下第一次写（mkdirSync）并 exit 97，证明它确实越过了闸且没有真的动现场。
    const r = run(SETUP, [], { fakePlatform: true, guard: true });
    const hit = stubHits(r.out);
    check(r.code === STUB_EXIT && hit.length > 0 && !r.out.includes('deploy/napcat.container'),
      '伪造 win32 后安装路径越过平台闸、进入安装流程（被 stub 拦下，现场未动）',
      `exit=${r.code}; stub 命中=${hit.join(', ') || '(无)'}\n${tail(r.out)}`);
    check(JSON.stringify(protocolDirs()) === JSON.stringify(dirsBefore),
      '负向对照也没有真的写入协议端目录',
      `${dirsBefore.join(' ')} → ${protocolDirs().join(' ')}`);
  }

  console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
}

try {
  main();
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
