// 控制台前缀挂载守卫（零外部依赖，纯静态断言）
//
// 背景：控制台可能被反向代理挂在子路径下（AccessTrust 数据面的 /aichat/）。
// AT 会先剥掉 "/aichat" 再转发，所以服务端路由不变，但浏览器侧 URL 带前缀 ——
// 前端只要有一处资源引用或 API 路径写死成 "/xxx"，浏览器就会绕过代理前缀去
// 打站点根（404 或打到别的服务）。这类回归肉眼很难看出来，所以用本测试钉住。
//
// 覆盖：
//   1. ui/index.html 的本地资源全部相对引用（./xxx）
//   2. ui/app.js 的 /vendor/*.js import 相对引用
//   3. ui/app/00-core.js 的 api() 经基路径解析以 "/" 开头的 path
//   4. ui/app/02-sse-sessions.js 的 EventSource 不再写死 /api/events
//   5. ui/app/10-feedback.js 的 Service Worker 按基路径注册（scope 落在前缀下）
//   6. src/app.js 的 originAllowed() 有 x-forwarded-proto 网关标记分支（经 AT 放行，
//      且不再错误地拿 x-forwarded-host 当有效 authority）
//
// 运行：node test/console-prefix-test.mjs（已接入 npm test）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('ui/index.html');
const bridge = read('ui/app.js');
const core = read('ui/app/00-core.js');
const sse = read('ui/app/02-sse-sessions.js');
const feedback = read('ui/app/10-feedback.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 取出某个函数声明到配对大括号为止的源码（用于断言它的内部实现）。 */
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`找不到函数：${signature}`);
  // 先跳过参数列表（默认值里可能有 {}），再定位函数体左大括号
  const paren = src.indexOf('(', start);
  let pdepth = 0;
  let afterParams = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') {
      pdepth--;
      if (pdepth === 0) { afterParams = i + 1; break; }
    }
  }
  if (afterParams < 0) throw new Error(`参数列表未闭合：${signature}`);
  const open = src.indexOf('{', afterParams);
  if (open < 0) throw new Error(`找不到函数体：${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数体未闭合：${signature}`);
}

console.log('控制台前缀挂载守卫（ui/ 静态断言）');

// ── 1. index.html：本地资源必须相对引用 ────────────────────────────────────
check('index.html 不再用绝对路径引用 /style.css、/app.js、/app/*.js', () => {
  assert(!html.includes('href="/style.css'), '仍有 href="/style.css"（浏览器会打到站点根，绕过 /aichat 前缀）');
  assert(!html.includes('src="/app.js"'), '仍有 src="/app.js"');
  assert(!html.includes('src="/app/'), '仍有 src="/app/…"');
  // 兜底：本页任何 href/src 都不该是站点根绝对路径（站内导航另有页面承担）
  const abs = html.match(/(?:href|src)="\/(?!\/)[^"]*"/g) || [];
  assert(abs.length === 0, `仍有绝对路径引用：${abs.join('，')}`);
});

check('index.html 的入口资源全部是相对路径且文件存在', () => {
  const refs = [...html.matchAll(/<(?:script|link)[^>]*?(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert(refs.length >= 15, `相对资源引用过少（${refs.length} 条），可能被改回绝对路径或解析失败`);
  for (const ref of refs) {
    const p = path.join(ROOT, 'ui', ref.slice(2));
    assert(fs.existsSync(p), `${ref} 指向的文件不存在：${ref}`);
  }
  assert(html.includes('src="./app/00-core.js"'), '缺少 ./app/00-core.js 引用');
  assert(html.includes('src="./app.js"'), '缺少 ./app.js 引用');
});

// ── 2. app.js：vendor import 相对引用 ─────────────────────────────────────
check('app.js 的 vendor 模块 import 是相对路径', () => {
  assert(!/from\s+['"]\/vendor\//.test(bridge), `仍有绝对 vendor import：${(bridge.match(/from\s+['"]\/vendor\/[^'"]+/g) || []).join('，')}`);
  assert(bridge.includes("from './vendor/tier-slider.js'"), "缺少 from './vendor/tier-slider.js'");
  assert(bridge.includes("from './vendor/price-match.js'"), "缺少 from './vendor/price-match.js'");
});

// ── 3. 00-core.js：api() 按基路径解析 ─────────────────────────────────────
check('00-core.js 定义了控制台基路径（new URL(".", document.baseURI)）', () => {
  assert(/new URL\(\s*['"]\.['"]\s*,\s*document\.baseURI/.test(core), '找不到 new URL(".", document.baseURI) 形式的基路径计算');
  assert(core.includes('function consoleUrl('), '缺少 consoleUrl() 解析函数');
});

check('00-core.js 的 api() 把 path 经 consoleUrl() 解析后才 fetch', () => {
  const body = functionBody(core, 'async function api(path, options = {})');
  assert(/consoleUrl\(\s*path\s*\)/.test(body), 'api() 内没有 consoleUrl(path)：绝对 path 会绕过代理前缀');
  assert(/fetch\(\s*consoleUrl\(\s*path\s*\)/.test(body), 'api() 的 fetch 没有用解析后的 URL');
});

// ── 4. 02-sse-sessions.js：EventSource 不写死绝对路径（且保留令牌包装）──────
check('02-sse-sessions.js 的 EventSource 不再写死 /api/events（令牌包装 + 前缀解析都在）', () => {
  const raw = /new\s+EventSource\s*\(\s*['"]\/api\/events['"]\s*\)/.exec(sse);
  assert(!raw, `仍有写死的 EventSource('/api/events')：${raw && raw[0]}`);
  // 完整嵌套形状：URL 必须经 consoleUrl() 解析（子路径前缀），整体必须经 withConsoleToken()
  // 包装（EventSource 不能设请求头，令牌只能走 ?token=）。只断言「包含 consoleUrl」会放过
  // 「令牌包装被删」或「先拼令牌再解析前缀」这类退化 —— 两种都会让 SSE 401 或绕过前缀。
  const ok = /new\s+EventSource\s*\(\s*withConsoleToken\s*\(\s*consoleUrl\s*\(\s*['"]\/api\/events['"]\s*\)\s*\)\s*\)/.test(sse);
  assert(ok, "EventSource 参数应形如 EventSource(withConsoleToken(consoleUrl('/api/events')))，令牌包装与子路径前缀都不能丢");
});

// ── 5. 10-feedback.js：SW 按基路径注册 ────────────────────────────────────
check('10-feedback.js 的 serviceWorker.register 按基路径注册', () => {
  const raw = /serviceWorker\.register\s*\(\s*['"]\/captcha-sw\.js['"]\s*\)/.exec(feedback);
  assert(!raw, `仍有写死的 register('/captcha-sw.js')：${raw && raw[0]}`);
  const ok = /serviceWorker\.register\s*\(\s*consoleUrl\(\s*['"]\/captcha-sw\.js['"]\s*\)\s*\)/.test(feedback);
  assert(ok, "register 参数应形如 register(consoleUrl('/captcha-sw.js'))");
});

// ── 6. src/app.js：originAllowed 必须有网关标记分支 ────────────────────────
check('src/app.js 的 originAllowed() 有 x-forwarded-proto 网关分支（且早于 Host 校验）', () => {
  const server = read('src/app.js');
  const body = functionBody(server, 'function originAllowed(req)');
  const gateway = body.indexOf("req.headers['x-forwarded-proto']");
  assert(gateway >= 0, 'originAllowed() 缺少 x-forwarded-proto 网关标记分支（AT 转发来的请求会 403）');
  const hostCheck = body.indexOf('req.headers.host');
  assert(hostCheck > gateway, '网关分支必须在 Host 校验之前：经 AT 时 Host 是 AT 自己的回环地址');
  assert(/if\s*\(\s*gatewayProto\s*\)\s*return true/.test(body), '网关分支必须直接放行（return true）');
  assert(
    !body.includes("req.headers['x-forwarded-host']"),
    '不要再拿 x-forwarded-host 当有效 authority：AT 的 forward() 会用自己收到的 Host 覆盖它，实测必然 403'
  );
});

if (failed === 0) {
  console.log('\n全部通过：控制台前端没有绕过挂载前缀的绝对路径。');
  process.exit(0);
}
console.log(`\n${failed} 条断言失败：前缀挂载会失效，见上。`);
process.exit(1);
