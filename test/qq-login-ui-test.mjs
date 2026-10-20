// 控制台前端：扫码登录页 + 令牌闭环 + 外部协议端展示收口（task-11）
//
// 加载**真实** ui/index.html 与 ui/app/*.js（jsdom + window.eval，沿用
// test/coverage-wiring.mjs 的既有基建），按用户真实路径断言四件事：
//   ① 未配令牌时，前端不再发硬编码假令牌（且首屏行为与改造前一致：直接进控制台）
//   ② 带 ?token=abc 打开后，后续 /api 请求头里是 abc（不是 marker），地址栏令牌被抹掉
//   ③ /api/qq-login/status 的 8 种 phase 各自渲染出规定文案（覆盖验收要求的 6 种）
//   ④ 外部协议端模式（protocol.mode=external）下，控制台不再把
//      「SnowLuma 未安装 / 未运行」当故障红项，协议端状态改显示 OneBot 端点可达性
//
// 负向对照（证明上面断言不是永真）：
//   · 把令牌读入逻辑桩回硬编码 marker ⇒ ② 的断言必须失败
//   · 关掉外部模式判定（status 无 protocol 字段）⇒ ④ 的红项断言必须失败
//
// 运行：node test/qq-login-ui-test.mjs（jsdom 已装在 node_modules）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createChecker, sleep, waitFor } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const { JSDOM, VirtualConsole } = await import('jsdom');

const c = createChecker('控制台扫码登录 / 令牌闭环 / 外部协议端展示（前端）');

// ── 加载真实脚本 ─────────────────────────────────────────────────────────
// 顺序 = index.html 的 defer 顺序，其中 13-qq-login.js 在 11-init.js 之前。
// 不改 test/_ui-load.mjs（别人的文件），这里按它的 readAppPart 自行拼接。
const { APP_PARTS, readAppPart } = await import('./_ui-load.mjs');
const MAIN_PARTS = [...APP_PARTS.filter((n) => n !== '11-init.js'), '13-qq-login.js'];
let MAIN_CODE = MAIN_PARTS.map(readAppPart).join('\n\n');
// 顶层 'use strict' 会让 window.eval 里的函数声明留在 eval 作用域、挂不到 window 上；
// 测试需要从 window 调这些函数（真实浏览器是全局脚本，语义等价）——沿用 coverage-wiring 的处理。
MAIN_CODE = MAIN_CODE.replace(/^'use strict';\s*$/m, '');
MAIN_CODE = MAIN_CODE.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');
const INIT_CODE = readAppPart('11-init.js');

// ── 假数据 ───────────────────────────────────────────────────────────────
const CONFIG = {
  api: { baseUrl: 'http://example.invalid/v1', model: 'test-model' },
  allow: { groups: ['123456'], private: [] },
  allowAllWhenEmpty: false,
  ui: { theme: 'dark', refreshMs: 15000 },
  snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3002' }
};

function baseStatus(overrides = {}) {
  return {
    onebot: {
      connected: true, everConnected: true, error: '', diagnosis: '',
      self: { userId: '9999', nickname: '测试Bot' },
      ...(overrides.onebot || {})
    },
    snowluma: { dir: '', running: false, webuiUrl: '', ...(overrides.snowluma || {}) },
    qqPortable: { running: false, ready: false, ...(overrides.qqPortable || {}) },
    orchestrator: { model: 'test-model', paused: false },
    usage: { runs: 0, totalTokens: 0 },
    cost: { cost: 0 },
    cacheHitRate: 0,
    webSearchCount: 0,
    paused: false,
    dataDir: '/tmp/qq-agent-test',
    ...overrides
  };
}

const QR_WAITING = {
  ok: true, phase: 'qr_waiting', loggedIn: false, offline: false,
  account: { uin: '', nickname: '' },
  qr: { available: true, issuedAt: 1792502400123, expiresInMs: 95000 },
  napcat: { reachable: true, webuiUrl: 'http://127.0.0.1:6099', latencyMs: 12 },
  error: null
};

/** 外部协议端现场（容器 NapCat）：protocol.mode=external + OneBot 数据面字段。 */
const EXTERNAL_STATUS = baseStatus({
  protocol: { mode: 'external', wsReachable: true, httpOk: true, endpoint: 'ws://127.0.0.1:3001' },
  snowluma: { dir: '', running: null, managedBy: 'external' },
  onebot: { connected: true, httpOk: true, httpError: '', dataPathState: 'ok' }
});

// ── 启动一个 jsdom 控制台 ────────────────────────────────────────────────
/**
 * @param {object} opts
 *   url      页面地址（带/不带 ?token=）
 *   respond  (path, req) => { status, body }；默认 200 + 对应假数据
 *   autoInit 是否立刻执行 11-init.js（默认 true；面板测试可关掉自己控制）
 */
async function bootUI({ url = 'http://127.0.0.1:43210/', respond, autoInit = true } = {}) {
  // 屏蔽 jsdom 的「Not implemented: navigation」噪音（令牌输入框提交会调 location.reload，
  // jsdom 不支持导航；那是测试环境限制，不是页面缺陷）。
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!String(e?.message || '').includes('Not implemented')) console.error(e);
  });
  virtualConsole.on('error', (msg) => console.error(msg));
  virtualConsole.on('warn', (msg) => console.warn(msg));
  const dom = new JSDOM(HTML, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const calls = [];
  const responder = respond || (() => ({ status: 200, body: {} }));
  window.fetch = async (input, init = {}) => {
    const u = new URL(String(input), window.location.href);
    const pathname = u.pathname + u.search;
    const headers = init.headers || {};
    const method = String(init.method || 'GET');
    calls.push({ path: pathname, method, headers, body: init.body });
    const r = responder(pathname, { method, headers, body: init.body, seq: calls.length }) || {};
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (r.body ?? {})
    };
  };
  window.EventSource = class {
    constructor(u) { this.url = String(u); this.readyState = 0; }
    addEventListener() {}
    close() {}
  };
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => null;
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  }
  const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
  const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
  Object.assign(window, {
    TIER_SLIDER_BANDS: tier.TIER_SLIDER_BANDS,
    sliderToTier: tier.sliderToTier,
    tierToSlider: tier.tierToSlider,
    matchPriceTable: priceMod.matchPriceTable
  });
  // ⚠️ 必须**一次** eval 全部段：各段的 const/let（$、$$、state…）是全局词法绑定，
  // 只在本段 eval 的作用域内共享；拆成两次 eval 会让 11-init 看不到 $/$$。
  try {
    window.eval(MAIN_CODE + '\n\n' + (autoInit ? INIT_CODE : ''));
  } catch (error) {
    try { dom.window.close(); } catch { /* ignore */ }
    throw error;
  }
  return { dom, window, calls };
}

/** 默认 responder：覆盖首屏会打到的全部 /api，令牌模式可要求正确头。 */
function defaultResponder({ status, qqLogin, config = CONFIG, requireToken = '' } = {}) {
  return (pathname, req) => {
    if (requireToken) {
      const got = req.headers['x-console-token'];
      if (got !== requireToken && !pathname.includes(`token=${encodeURIComponent(requireToken)}`)) {
        return { status: 401, body: { error: '未授权' } };
      }
    }
    if (pathname.startsWith('/api/status')) return { status: 200, body: typeof status === 'function' ? status() : status };
    if (pathname.startsWith('/api/config')) return { status: 200, body: config };
    if (pathname.startsWith('/api/qq-login/status')) {
      return qqLogin ? { status: 200, body: typeof qqLogin === 'function' ? qqLogin() : qqLogin } : { status: 404, body: { error: 'Not Found' } };
    }
    if (pathname.startsWith('/api/qq-login/start') || pathname.startsWith('/api/qq-login/refresh')) {
      return qqLogin ? { status: 200, body: typeof qqLogin === 'function' ? qqLogin() : qqLogin } : { status: 404, body: { error: 'Not Found' } };
    }
    if (pathname.startsWith('/api/qq-login/session')) return { status: 200, body: { ok: true, stopped: true, watchers: 0 } };
    return { status: 200, body: {} };
  };
}

const callsTo = (calls, pathPrefix) => calls.filter((x) => x.path.startsWith(pathPrefix));
const headerOf = (call) => call.headers['x-console-token'];

// ══ 断言工具（正向与负向对照共用同一份，避免各写一套）══════════════════════

/** ①/② 的核心断言：令牌头必须等于期望值，且绝不能是旧硬编码 marker。 */
function assertConsoleTokenHeader(calls, expected) {
  const apiCalls = calls.filter((x) => x.path.startsWith('/api/'));
  assert.ok(apiCalls.length > 0, '应有 /api/ 请求');
  for (const call of apiCalls) {
    assert.equal(headerOf(call), expected,
      `${call.path} 的 x-console-token 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(headerOf(call))}`);
    assert.notEqual(headerOf(call), 'qq-agent-console', '不得再发硬编码 marker 冒充令牌');
  }
}
function assertNoTokenHeader(calls) {
  const apiCalls = calls.filter((x) => x.path.startsWith('/api/'));
  assert.ok(apiCalls.length > 0, '应有 /api/ 请求');
  for (const call of apiCalls) {
    assert.equal(headerOf(call), undefined, `${call.path} 不应带 x-console-token（后端未配令牌时行为必须与今天一致）`);
  }
}

/** ④ 的核心断言：外部协议端模式不得出现「SnowLuma 未安装/未运行」类红项。 */
function assertNoExternalFalseAlarms(window) {
  const dots = [...window.document.querySelectorAll('#readiness-dots .rdot')];
  assert.ok(dots.length === 3 || (dots.length === 4 && dots[0].className.includes('na') && dots[1].className.includes('na')),
    `外部模式首两点应标 na / 或只有 3 个点，实际 ${dots.length} 点：${dots.map((d) => d.className).join('|')}`);
  const dotText = dots.map((d) => `${d.title} ${d.textContent}`).join(' ');
  assert.ok(!dotText.includes('未运行（点击前往启动）'), `就绪圆点仍有「未运行（点击前往启动）」误报：${dotText}`);
  // 协议端状态改成 OneBot 端点可达性
  assert.ok(dotText.includes('OneBot') && (dotText.includes('HTTP') || dotText.includes('数据面')),
    `就绪圆点没显示 OneBot 端点可达性：${dotText}`);
  const page = window.document.querySelector('#snowluma-page');
  assert.ok(page, 'snowluma 页签容器存在');
  const pageText = page.textContent || '';
  for (const fake of ['npm run setup', '未找到项目内 snowluma/ 文件夹', 'SnowLuma：未运行', 'SnowLuma 未运行']) {
    assert.ok(!pageText.includes(fake), `外部模式页签仍出现假警报文案「${fake}」`);
  }
  assert.ok(pageText.includes('外部容器') && pageText.includes('NapCat'), `外部模式页签应说明协议端是外部容器 NapCat：${pageText.slice(0, 200)}`);
  assert.ok(pageText.includes('HTTP 数据面') || pageText.includes('数据面'), '外部模式页签应显示 OneBot 数据面探测结果');
}

// ══ A. 令牌闭环 ═════════════════════════════════════════════════════════

c.section('A. 令牌闭环（§10.2/§10.3）');

await c.check('① 未配令牌：前端不发假令牌，首屏直接进控制台（与今天行为一致）', async () => {
  const { dom, window, calls } = await bootUI({ respond: defaultResponder({ status: baseStatus() }) });
  try {
    await waitFor(() => calls.some((x) => x.path.startsWith('/api/status')), 4000, '首屏 /api/status');
    await waitFor(() => !window.document.querySelector('#loading-overlay'), 3000, 'loading 遮罩收起');
    assertNoTokenHeader(calls);
    assert.equal(window.getConsoleToken(), '');
    assert.equal(window.document.querySelector('#qq-token-overlay'), null, '未配令牌不应弹令牌输入框');
    assert.equal(window.localStorage.getItem('qqa-console-token'), null, '令牌不得落 localStorage');
    // 静态守卫：源码里不再有硬编码标记冒充令牌
    assert.ok(!MAIN_CODE.includes('CONSOLE_MARKER'), '源码里不应再有 CONSOLE_MARKER');
    assert.ok(!MAIN_CODE.includes("'qq-agent-console'"), "源码里不应再有硬编码 'qq-agent-console'");
    return `${callsTo(calls, '/api/').length} 个 /api 请求全部无令牌头，控制台正常进入`;
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

await c.check('② 带 ?token=abc：请求头是 abc、地址栏令牌被抹掉、不落 localStorage', async () => {
  const { dom, window, calls } = await bootUI({
    url: 'http://127.0.0.1:43211/?token=abc',
    respond: defaultResponder({ status: baseStatus() })
  });
  try {
    await waitFor(() => calls.some((x) => x.path.startsWith('/api/status')), 4000, '首屏 /api/status');
    assertConsoleTokenHeader(calls, 'abc');
    assert.equal(window.sessionStorage.getItem('qqa-console-token'), 'abc', '令牌应进 sessionStorage');
    assert.ok(!window.location.search.includes('token=abc'), `地址栏令牌应被抹掉，实际：${window.location.search}`);
    assert.equal(window.localStorage.getItem('qqa-console-token'), null, '令牌不得落 localStorage');
    // EventSource / QR <img> 带不了头 ⇒ 必须走 ?token=
    assert.ok(window.withConsoleToken('/api/events').includes('token=abc'), 'withConsoleToken 应给 URL 追加令牌');
    return `请求头 x-console-token=abc，地址栏已清理（search=${JSON.stringify(window.location.search)}）`;
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

await c.check('②b 令牌注入失败后的降级/负向对照：桩回硬编码 marker ⇒ ② 的断言必须失败', async () => {
  const { dom, window, calls } = await bootUI({
    url: 'http://127.0.0.1:43212/?token=abc',
    respond: defaultResponder({ status: baseStatus() })
  });
  try {
    await waitFor(() => calls.some((x) => x.path.startsWith('/api/status')), 4000, '首屏 /api/status');
    assertConsoleTokenHeader(calls, 'abc');       // 正向先成立
    // 负向对照：模拟「把令牌读入逻辑去掉，桩回硬编码 marker」的旧实现
    window.getConsoleToken = () => 'qq-agent-console';
    const before = calls.length;
    await window.api('/api/status');
    const after = calls.slice(before).filter((x) => x.path.startsWith('/api/status'));
    assert.equal(after.length, 1, '负向对照请求应已发出');
    let failed = false;
    try { assertConsoleTokenHeader(after, 'abc'); } catch { failed = true; }
    assert.ok(failed, '负向对照应失败：去掉令牌逻辑后 ② 必须不成立');
    console.log(`    负向对照（令牌）：硬编码 marker 时请求头 = ${JSON.stringify(headerOf(after[0]))} ⇒ ② 断言失败 ✅`);
    return `正向=abc；桩回 marker 后=${headerOf(after[0])}（断言按预期失败）`;
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

await c.check('②c 需要令牌但没带：首屏出现令牌输入框（不是「启动超时」白屏）', async () => {
  const { dom, window, calls } = await bootUI({
    url: 'http://127.0.0.1:43213/',
    respond: defaultResponder({ status: baseStatus(), requireToken: 'secret-token' })
  });
  try {
    await waitFor(() => window.document.querySelector('#qq-token-overlay'), 5000, '令牌输入框');
    const input = window.document.querySelector('#qq-token-input');
    assert.ok(input, '应有密码输入框');
    assert.equal(input.getAttribute('type'), 'password');
    const text = window.document.querySelector('#qq-token-overlay').textContent;
    assert.ok(text.includes('server.token'), `提示里应写明令牌从哪来（server.token）：${text.slice(0, 160)}`);
    assert.ok(!text.includes('启动超时'), '不应再显示误导性的「启动超时」');
    // 提交令牌：写入 sessionStorage（reload 在 jsdom 里是 no-op）
    input.value = 'entered-token';
    window.document.querySelector('#qq-token-enter').click();
    assert.equal(window.sessionStorage.getItem('qqa-console-token'), 'entered-token', '提交后令牌应进 sessionStorage');
    return `令牌输入框出现且可提交（首屏请求 ${callsTo(calls, '/api/status').length} 次后立即停止重试）`;
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

await c.check('②d 后端未实现 /api/qq-login/* 时退回改造前行为：直接进控制台', async () => {
  const { dom, window, calls } = await bootUI({
    respond: defaultResponder({ status: baseStatus({ onebot: { connected: false, everConnected: false, diagnosis: '连接中…' } }), qqLogin: null })
  });
  try {
    await waitFor(() => calls.some((x) => x.path.includes('/api/qq-login/status')), 4000, '探测 /api/qq-login/status');
    await waitFor(() => !window.document.querySelector('#loading-overlay'), 3000, 'loading 收起');
    assert.equal(window.document.querySelector('#qq-login-overlay'), null, '后端没有扫码接口时不应弹面板');
    return '404 时前端未白屏、未弹面板，按旧路径进控制台';
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

await c.check('②e 静态守卫：SSE 地址 = withConsoleToken(consoleUrl(...))，保留子路径前缀且带令牌', () => {
  const sseSrc = readAppPart('02-sse-sessions.js');
  assert.ok(/withConsoleToken\(\s*consoleUrl\(\s*'\/api\/events'\s*\)\s*\)/.test(sseSrc),
    'EventSource 地址必须经 consoleUrl（子路径挂载）再用 withConsoleToken 追加令牌');
  assert.ok(!/new\s+EventSource\s*\(\s*['"]\/api\/events['"]/.test(sseSrc), '不得写死 /api/events');
  // 旧版 test/console-prefix-test.mjs 的守卫只认 EventSource(consoleUrl(...)) 这一种形状，
  // 令牌追加后形状变了 —— 本断言接管「前缀 + 令牌」两条不变量（见交付说明）。
  return 'SSE 走 withConsoleToken(consoleUrl(/api/events))';
});

// ══ B. 6 种 phase 渲染 ══════════════════════════════════════════════════

c.section('B. 扫码面板：phase → 文案（§13.1）');

const PHASE_CASES = [
  ['qr_waiting', { ...QR_WAITING }, '请用 QQ 扫描二维码登录'],
  ['qr_scanned', { ok: true, phase: 'qr_scanned', qr: { available: false }, error: null }, '已扫码，请在手机上确认'],
  ['initializing', { ok: true, phase: 'initializing', qr: { available: false }, error: null }, '登录成功，正在启动 QQ'],
  ['restarting', { ok: true, phase: 'restarting', qr: { available: false }, error: null }, '正在准备新的二维码'],
  ['expired', { ok: true, phase: 'expired', qr: { available: false }, error: { code: 'QR_EXPIRED', error: '二维码已过期' } }, '二维码已过期，请点刷新'],
  ['failed', { ok: true, phase: 'failed', qr: { available: false }, error: { code: 'NAPCAT_QR_UNAVAILABLE', error: '登录被风控' } }, '登录失败：登录被风控'],
  ['unreachable', { ok: true, phase: 'unreachable', qr: { available: false }, error: { code: 'NAPCAT_WEBUI_UNREACHABLE', error: 'connect ECONNREFUSED 127.0.0.1:6099' } }, '连不上 NapCat WebUI'],
  ['qq_offline', { ok: true, phase: 'qq_offline', offline: true, loggedIn: false, qr: { available: false }, error: null }, 'QQ 已登录但当前离线']
];

await c.check('③ 8 种 phase（含验收要求的 6 种）各自渲染规定文案，二维码只在 qr_waiting 显示', async () => {
  const { dom, window, calls } = await bootUI({
    url: 'http://127.0.0.1:43214/?token=abc',
    respond: defaultResponder({ status: baseStatus(), qqLogin: QR_WAITING })
  });
  try {
    await waitFor(() => calls.some((x) => x.path.startsWith('/api/status')), 4000, '首屏');
    window.openQQLoginPanel({ onDismiss: () => {} });
    await waitFor(() => window.document.querySelector('#qq-login-overlay'), 4000, '扫码面板出现');
    await waitFor(() => window.document.querySelector('#qq-login-overlay')?.getAttribute('data-phase') === 'qr_waiting', 4000, '首次渲染 qr_waiting');
    window.stopQQLoginPolling();   // 关掉自动轮询，下面手动逐 phase 渲染（同步，不竞态）

    const seen = [];
    for (const [phase, status, expected] of PHASE_CASES) {
      window.renderQQLoginState(status);
      const overlay = window.document.querySelector('#qq-login-overlay');
      assert.ok(overlay, `${phase}：面板应仍在`);
      assert.equal(overlay.getAttribute('data-phase'), phase, `${phase}：data-phase 应同步`);
      const text = overlay.querySelector('#qq-login-phase').textContent;
      assert.ok(text.includes(expected), `${phase}：应出现「${expected}」，实际「${text}」`);
      const qrBox = overlay.querySelector('#qq-login-qr');
      const qrImg = overlay.querySelector('#qq-login-qr-img');
      if (phase === 'qr_waiting') {
        assert.ok(!qrBox.classList.contains('hidden'), 'qr_waiting 应显示二维码');
        assert.ok(String(qrImg.getAttribute('src')).includes('/api/qq-login/qrcode.svg'), '二维码应走服务端 SVG 端点');
        assert.ok(String(qrImg.getAttribute('src')).includes('token=abc'), '二维码 <img> 带不了头，必须走 ?token=');
      } else {
        assert.ok(qrBox.classList.contains('hidden'), `${phase}：不应显示二维码`);
      }
      // 故障态要能看到可操作的按钮
      if (['expired', 'failed', 'unreachable'].includes(phase)) {
        assert.ok(overlay.querySelector('#qq-login-refresh'), `${phase}：应有「刷新二维码」`);
        assert.ok(overlay.querySelector('#qq-login-retry'), `${phase}：应有「重新检测」`);
      }
      seen.push(phase);
    }
    // 二维码 issuedAt 变化才换 src（防闪）：同 issuedAt 重渲染不换 URL
    window.renderQQLoginState({ ...QR_WAITING });
    const src1 = window.document.querySelector('#qq-login-qr-img').getAttribute('src');
    window.renderQQLoginState({ ...QR_WAITING });
    const src2 = window.document.querySelector('#qq-login-qr-img').getAttribute('src');
    assert.equal(src1, src2, '同一 issuedAt 不应重建二维码 URL');

    // logged_in ⇒ 关闭面板（首屏引导时 onDismiss 会进入控制台）
    let dismissed = 0;
    window.openQQLoginPanel({ onDismiss: () => { dismissed++; } });
    await waitFor(() => window.document.querySelector('#qq-login-overlay'), 3000, '再次打开面板');
    window.renderQQLoginState({ ok: true, phase: 'logged_in', loggedIn: true });
    assert.equal(window.document.querySelector('#qq-login-overlay'), null, 'logged_in 后面板应关闭');
    assert.equal(dismissed, 1, 'logged_in 后应触发 onDismiss（进入控制台）');
    return `已覆盖 ${seen.join(' / ')} + logged_in`;
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

// ══ C. 启动分流（logged_out 打开面板）═══════════════════════════════════

c.section('C. 启动分流：QQ 未登录先出扫码面板');

await c.check('QQ 未登录 + 扫码接口可用 ⇒ 首屏弹面板（不是 90 秒转圈），面板关闭后可进控制台', async () => {
  let consoleEntered = false;
  const { dom, window, calls } = await bootUI({
    respond: defaultResponder({
      status: baseStatus({ onebot: { connected: false, everConnected: false, diagnosis: '连接中…' } }),
      qqLogin: QR_WAITING
    })
  });
  try {
    await waitFor(() => window.document.querySelector('#qq-login-overlay'), 6000, '首屏扫码面板');
    await waitFor(() => !window.document.querySelector('#loading-overlay'), 3000, 'loading 遮罩收起（不许白屏）');
    await waitFor(() => window.document.querySelector('#qq-login-overlay')?.getAttribute('data-phase') === 'qr_waiting', 4000, '面板 phase');
    // 关闭面板：「稍后再说」→ onDismiss → enterConsole
    window.document.querySelector('#qq-login-later').click();
    await waitFor(() => !window.document.querySelector('#qq-login-overlay'), 3000, '面板关闭');
    await waitFor(() => calls.some((x) => x.path.startsWith('/api/sessions')), 6000, '进入控制台后拉会话列表');
    consoleEntered = true;
    return `面板出现→关闭→控制台初始化完成（/api/sessions ${callsTo(calls, '/api/sessions').length} 次）`;
  } catch (error) {
    console.log(`    C 失败细节：面板=${!!window.document.querySelector('#qq-login-overlay')} consoleEntered=${consoleEntered} 请求=${calls.map((x) => x.method + ' ' + x.path).slice(0, 14).join(' | ')}`);
    throw error;
  }
});

// ══ D. 外部协议端展示收口（U1/U2）═══════════════════════════════════════

c.section('D. 外部协议端模式：不再把「SnowLuma 未安装」当故障红项');

await c.check('④ protocol.mode=external ⇒ 无「未运行（点击前往启动）」红项，显示 OneBot 端点可达性', async () => {
  const { dom, window } = await bootUI({
    respond: defaultResponder({ status: EXTERNAL_STATUS })
  });
  try {
    await window.refreshStatus();
    await window.loadSnowlumaPage();
    await sleep(50);
    assertNoExternalFalseAlarms(window);
    const dots = [...window.document.querySelectorAll('#readiness-dots .rdot')];
    return `前两点=na（${dots[0].title}），OneBot 点标题含可达性；页签显示外部容器`;
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

await c.check('④b 负向对照：关掉外部模式判定（status 无 protocol 字段）⇒ 红项必须回来（④ 的断言失败）', async () => {
  // 嵌入式现场（没有 protocol 字段）：QQ 内核未装 / SnowLuma 未运行 —— 今天会亮两个红点
  const embedded = baseStatus({ onebot: { connected: false, everConnected: false, diagnosis: '' }, snowluma: { dir: '', running: false } });
  const { dom, window } = await bootUI({
    respond: defaultResponder({ status: embedded })
  });
  try {
    await window.refreshStatus();
    await window.loadSnowlumaPage();
    await sleep(50);
    const dotText = [...window.document.querySelectorAll('#readiness-dots .rdot')].map((d) => d.title).join(' ');
    const pageText = window.document.querySelector('#snowluma-page').textContent || '';
    assert.ok(dotText.includes('未运行（点击前往启动）'), `嵌入式现场应保持原红项提示，实际：${dotText}`);
    assert.ok(pageText.includes('npm run setup') || pageText.includes('SnowLuma'), '嵌入式现场页签应保持原 SnowLuma 叙事');
    // 用同一份"无红项"断言去检查它 —— 必须失败
    let failed = false;
    try { assertNoExternalFalseAlarms(window); } catch { failed = true; }
    assert.ok(failed, '负向对照应失败：关掉外部模式判定后红项必须重新出现');
    console.log('    负向对照（外部模式）：无 protocol 字段时红项出现 ⇒ ④ 断言失败 ✅');
    return `嵌入式现场红项=${dotText.includes('未运行（点击前往启动）')}，负向对照按预期失败`;
  } finally {
    // 不在这里 close window：页内 async init 可能仍在飞，关闭后它的后续 await 会抛错；
    // 进程末尾统一 process.exit 收尾（jsdom 定时器不会阻止显式退出）。
  }
});

// ══ 汇总 ════════════════════════════════════════════════════════════════

const ok = c.finish();
if (ok) console.log('\n扫码登录页 + 令牌闭环 + 外部协议端展示收口：全部通过 ✅');
// jsdom 的定时器/事件循环可能仍有句柄（页内 setInterval 轮询），显式退出让 CI 不被挂住。
process.exit(ok ? 0 : 1);
