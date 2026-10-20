// 启动看门狗：无论启动链路为何没跑完，遮罩都必须自己让路（2026-10-20）。
//
// 现场故障形态：浏览器里停在「QQ Agent 正在启动 / 正在启动服务并检查协议端」，
// 没有任何报错，用户进不去控制台（脚本未执行 / await 不 settle / 主线程被占都可能）。
// 本测试用真实 ui/index.html 的 DOM + 真实 00-core.js，只把看门狗延时调到毫秒级。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8')
  .replace(/<script[^>]*type="module"[^>]*><\/script>/gi, '');
const coreSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app', '00-core.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };

function boot(src, ms) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3210/', runScripts: 'outside-only' });
  const { window } = dom;
  window.__BOOT_WATCHDOG_MS = ms;
  window.fetch = async () => { throw new Error('测试里不允许发起网络请求'); };
  window.EventSource = class { constructor() {} addEventListener() {} close() {} };
  new vm.Script(src, { filename: '00-core.js' }).runInContext(vm.createContext(window));
  return window;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ① 启动没跑完 → 到期给可操作提示
{
  const w = boot(coreSrc, 60);
  const before = w.document.querySelector('#loading-status').textContent;
  await wait(120);
  const hint = w.document.querySelector('#loading-status').textContent;
  checkStatus(before, hint);
}
function checkStatus(before, hint) {
  if (before.includes('正在启动服务并检查协议端')) ok('前置：初始文案是页面自带的「正在启动服务并检查协议端」');
  else bad('前置文案不符', before);
  if (hint.includes('启动已超过')) ok('① 启动停滞时，遮罩给出「启动已超过 N 秒」+ F12 指引');
  else bad('① 未出现超时提示', hint);
}

// ② 再等一档 → 强制摘罩（opacity 归 0 / 节点被移除）
{
  const w = boot(coreSrc, 60);
  await wait(320);
  const ov = w.document.querySelector('#loading-overlay');
  const gone = !ov || ov.style.opacity === '0';
  if (gone) ok('② 强制摘罩：遮罩不再挡住控制台'); else bad('② 遮罩仍在', ov && ov.style.opacity);
}

// ③ ready 之后不该被看门狗打扰（hideLoading 后提示不再变化）
{
  const w = boot(coreSrc, 60);
  w.hideLoading();
  const settled = w.document.querySelector('#loading-status').textContent;
  await wait(140);
  const after = w.document.querySelector('#loading-status').textContent;
  if (after === settled) ok('③ 已 ready 时看门狗不覆盖状态/不重复动作'); else bad('③ ready 后被改写', after);
}

// ④ 负向对照：把 armBootWatchdog() 调用去掉 → ① 的断言必须失败（遮罩永远留着）
{
  const broken = coreSrc.replace(/\narmBootWatchdog\(\);\n/, '\n/* 负向对照：不武装看门狗 */\n');
  if (broken === coreSrc) { bad('④ 负向对照无法构造（没找到 armBootWatchdog() 调用）'); }
  else {
    const w = boot(broken, 60);
    await wait(200);
    const hint = w.document.querySelector('#loading-status').textContent;
    const stuck = !hint.includes('启动已超过');
    if (stuck) ok('④ 负向对照：去掉看门狗后遮罩永远停在「正在启动」，证明 ① 的断言不是永真');
    else bad('④ 负向对照失败：没装看门狗也出现了超时提示', hint);
  }
}

console.log(`\n启动看门狗：通过 ${pass}，失败 ${fail}`);
if (fail) { console.log('存在失败'); process.exit(1); }
console.log('全部通过 ✅');
