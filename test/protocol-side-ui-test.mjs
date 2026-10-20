// 控制台「协议端卡片」（task-15）：状态徽标 + actions 驱动按钮 + 二次确认 + 错误提示
//
// 加载**真实** ui/index.html 与 ui/app/*.js（jsdom + window.eval，沿用 test/qq-login-ui-test.mjs
// 的基建），把后端 /api/protocol/* 换成内存桩，按用户真实操作路径断言：
//   ① 四种 state 各渲染出正确徽标（运行中/已停止/未安装/未知）+ engine/unit/container 事实；
//   ② 按钮只按 actions 数组渲染（只给 start 时不得出现 stop）；
//   ③ stop 取消确认 → 一个 POST 都不发；确认 → POST 且 body 含 confirm:true（start 不需确认）；
//   ④ 503 → 页面出现 lastError 文案；⑤ 409 → 页面出现「不可管理」类提示。
//
// 负向对照（贴前后，证明断言不是永真）：
//   · 删掉确认分支 ⇒ ③ 的「取消不发 POST」必须失败
//   · 把 actions 渲染改成硬编码三按钮 ⇒ ②「只给 start 时不出现 stop」必须失败
//
// 运行：node test/protocol-side-ui-test.mjs（jsdom + 内存桩，无外部服务）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createChecker, sleep, waitFor } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const { JSDOM, VirtualConsole } = await import('jsdom');
const { APP_PARTS, readAppPart } = await import('./_ui-load.mjs');

const c = createChecker('控制台协议端卡片（状态徽标 / 动作按钮 / 二次确认 / 错误提示）');

// ── 拼接真实脚本（13 在 11 之前；与 index.html 的 defer 顺序一致）────────────
const PARTS = [...APP_PARTS.filter((n) => n !== '11-init.js'), '13-qq-login.js'];
const SNOWLUMA_SRC = readAppPart('03-snowluma.js');

function buildMainCode({ snowlumaReplace = [] } = {}) {
  return PARTS.map((name) => {
    let src = readAppPart(name);
    if (name === '03-snowluma.js') {
      for (const [from, to] of snowlumaReplace) {
        const before = src;
        src = src.replace(from, to);
        assert.notEqual(src, before, `负向对照的代码替换没生效：${from.slice(0, 60)}`);
      }
    }
    return src;
  }).join('\n\n')
    .replace(/^'use strict';\s*$/m, '')
    .replace(/^export\s+(function|const|let|async function|class)/gm, '$1');
}

// ── 假数据 ───────────────────────────────────────────────────────────────
const CONFIG = {
  api: { baseUrl: 'http://example.invalid/v1', model: 'test-model' },
  allow: { groups: ['123456'], private: [] },
  ui: { theme: 'dark', refreshMs: 15000 },
  snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3002' }
};

const EXTERNAL_STATUS = {
  onebot: {
    connected: true, everConnected: true, error: '', diagnosis: '',
    self: { userId: '9999', nickname: '测试Bot' },
    httpOk: true, httpError: '', dataPathState: 'ok'
  },
  protocol: { mode: 'external', reason: 'container', wsPort: 3001, httpPort: 3002 },
  snowluma: { dir: '', running: null, managedBy: 'external' },
  qqPortable: { running: false, ready: false },
  orchestrator: { model: 'test-model', paused: false },
  usage: { runs: 0, totalTokens: 0 }, cost: { cost: 0 }, cacheHitRate: 0,
  webSearchCount: 0, paused: false, dataDir: '/tmp/qq-agent-test'
};

function protocolStatus(overrides = {}) {
  return {
    ok: true,
    mode: 'external',
    managed: true,
    engine: 'podman',
    unit: 'napcat.service',
    container: 'napcat',
    installed: true,
    running: true,
    state: 'running',
    detail: '容器运行中（pid 4242）',
    lastError: '',
    actions: ['start', 'stop', 'restart'],
    stopWarning: '停止容器可能导致 QQ 登录态失效，需要重新扫码登录。',
    ...overrides
  };
}

// ── 启动 jsdom 控制台（脚本 + 起搏，桩掉全部网络）──────────────────────────
async function bootUI({ respond, mainCode } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!String(e?.message || '').includes('Not implemented')) console.error(e);
  });
  virtualConsole.on('error', (msg) => console.error(msg));
  const dom = new JSDOM(HTML, {
    url: 'http://127.0.0.1:43220/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  const calls = [];
  const responder = respond || (() => ({ status: 200, body: {} }));
  window.fetch = async (input, init = {}) => {
    const u = new URL(String(input), window.location.href);
    const pathname = u.pathname + u.search;
    const method = String(init.method || 'GET');
    const headers = init.headers || {};
    const body = init.body;
    calls.push({ path: pathname, method, headers, body });
    const r = (await responder(pathname, { method, headers, body, seq: calls.length })) || {};
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => (r.body ?? {}) };
  };
  window.EventSource = class { constructor(u) { this.url = String(u); } addEventListener() {} close() {} };
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => null;
  if (typeof window.structuredClone !== 'function') window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
  const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
  Object.assign(window, {
    TIER_SLIDER_BANDS: tier.TIER_SLIDER_BANDS,
    sliderToTier: tier.sliderToTier,
    tierToSlider: tier.tierToSlider,
    matchPriceTable: priceMod.matchPriceTable
  });
  window.eval((mainCode || buildMainCode()) + '\n\n' + readAppPart('11-init.js'));
  return { dom, window, calls };
}

/** 一套控制后端响应与请求记录的内存桩。 */
function makeBackend() {
  const state = {
    protocol: protocolStatus(),
    posts: [],             // { action, body, at }
    protocolStatusCalls: 0,
    nextActionResponse: null,   // { status, body } | ((action) => ({status, body}))
    delayNextPostMs: 0
  };
  const respond = async (pathname, req) => {
    if (pathname.startsWith('/api/status')) return { status: 200, body: EXTERNAL_STATUS };
    if (pathname.startsWith('/api/config')) return { status: 200, body: CONFIG };
    if (pathname.startsWith('/api/protocol/status')) {
      state.protocolStatusCalls++;
      return { status: 200, body: state.protocol };
    }
    const m = /^\/api\/protocol\/(start|stop|restart)$/.exec(pathname);
    if (m && req.method === 'POST') {
      const action = m[1];
      state.posts.push({ action, body: req.body, at: Date.now() });
      if (state.delayNextPostMs) await sleep(state.delayNextPostMs);
      const scripted = state.nextActionResponse;
      const r = typeof scripted === 'function' ? scripted(action) : scripted;
      if (r) return r;
      // 默认成功：动作后状态跟着变（stop→stopped，start/restart→running）
      state.protocol = {
        ...state.protocol,
        state: action === 'stop' ? 'stopped' : 'running',
        running: action !== 'stop'
      };
      return { status: 200, body: { ok: true, action, stateAfter: state.protocol.state, tookMs: 7 } };
    }
    if (pathname.startsWith('/api/qq-login/status')) return { status: 404, body: { error: 'Not Found' } };
    return { status: 200, body: {} };
  };
  return { state, respond };
}

const postCalls = (calls) => calls.filter((x) => /^\/api\/protocol\/(start|stop|restart)$/.test(x.path));
const bodyJson = (call) => {
  try { return JSON.parse(String(call.body || '{}')); } catch { return {}; }
};

/** 等待协议端卡片渲染出来。 */
async function waitCard(window) {
  await waitFor(() => window.document.querySelector('#protocol-card'), 5000, '协议端卡片渲染');
  return window.document.querySelector('#protocol-card');
}

// ══ ① 状态徽标 ═══════════════════════════════════════════════════════════

c.section('① 四种 state 的状态徽标 + engine/unit/container 事实');

await c.check('running / stopped / absent / unknown 各渲染正确徽标与三项事实', async () => {
  const backend = makeBackend();
  const { window } = await bootUI({ respond: backend.respond });
  const seen = [];
  for (const [state, badgeText] of [['running', '运行中'], ['stopped', '已停止'], ['absent', '未安装'], ['unknown', '未知']]) {
    backend.state.protocol = protocolStatus({ state, running: state === 'running', detail: `detail-${state}` });
    await window.fetchProtocolStatus();
    await window.loadSnowlumaPage({ quiet: true });
    await waitCard(window);
    const badge = window.document.querySelector('#protocol-state-badge');
    assert.ok(badge, `${state}：应有状态徽标`);
    assert.equal(badge.textContent, badgeText, `${state} 徽标文案应为「${badgeText}」，实际「${badge.textContent}」`);
    assert.equal(window.document.querySelector('#protocol-card').getAttribute('data-state'), state, 'data-state 应与 state 一致');
    const text = window.document.querySelector('#protocol-card').textContent;
    assert.ok(text.includes('引擎') && text.includes('podman'), `应显示 engine：${text.slice(0, 120)}`);
    assert.ok(text.includes('napcat.service'), '应显示 unit');
    assert.ok(text.includes('容器') && text.includes('napcat'), '应显示 container');
    assert.ok(text.includes(`detail-${state}`), '应显示 detail');
    assert.equal(window.protocolBadge(state).text, badgeText, `protocolBadge(${state}) 文案应一致`);
    seen.push(`${state}=${badgeText}`);
  }
  return seen.join(' / ');
});

// ══ ② 按钮按 actions 渲染 ═══════════════════════════════════════════════

c.section('② 按钮只按 actions 数组渲染');

await c.check('actions 只含 start ⇒ 不出现 stop/restart；含全部 ⇒ 三个按钮都在且文案正确', async () => {
  const backend = makeBackend();
  const { window } = await bootUI({ respond: backend.respond });
  backend.state.protocol = protocolStatus({ actions: ['start'] });
  await window.fetchProtocolStatus();
  await window.loadSnowlumaPage({ quiet: true });
  await waitCard(window);
  assert.ok(window.document.querySelector('[data-protocol-action="start"]'), '应出现「启动」按钮');
  assert.equal(window.document.querySelector('[data-protocol-action="stop"]'), null, 'actions 不含 stop 时绝不能渲染 stop 按钮');
  assert.equal(window.document.querySelector('[data-protocol-action="restart"]'), null, 'actions 不含 restart 时绝不能渲染 restart 按钮');

  backend.state.protocol = protocolStatus({ actions: ['start', 'stop', 'restart'] });
  await window.fetchProtocolStatus();
  await window.loadSnowlumaPage({ quiet: true });
  await waitCard(window);
  const labels = [...window.document.querySelectorAll('[data-protocol-action]')].map((b) => `${b.dataset.protocolAction}:${b.textContent}`);
  assert.deepEqual(labels, ['start:启动', 'stop:停止', 'restart:重启'], `按钮应按 actions 顺序渲染，实际：${labels.join(' | ')}`);
  return `actions=['start'] ⇒ 仅启动；actions=全部 ⇒ ${labels.join(' / ')}`;
});

// ══ ③ 二次确认 ═══════════════════════════════════════════════════════════

c.section('③ stop/restart 二次确认；取消不发请求，确认带 confirm:true');

await c.check('stop 取消确认 ⇒ 0 个 POST；确认 ⇒ POST /api/protocol/stop + confirm:true；start 不需要确认', async () => {
  const backend = makeBackend();
  const { window, calls } = await bootUI({ respond: backend.respond });
  backend.state.protocol = protocolStatus({ actions: ['start', 'stop', 'restart'] });
  await window.fetchProtocolStatus();
  await window.loadSnowlumaPage({ quiet: true });
  await waitCard(window);

  // 取消确认
  const confirmMessages = [];
  window.uiConfirm = async (msg) => { confirmMessages.push(String(msg)); return false; };
  window.document.querySelector('[data-protocol-action="stop"]').click();
  await sleep(80);
  assert.equal(postCalls(calls).length, 0, '取消确认后不得发出任何动作请求');
  assert.equal(confirmMessages.length, 1, '点击 stop 应先弹确认');
  assert.ok(confirmMessages[0].includes('停止容器可能导致 QQ 登录态失效'),
    `确认文案必须带后端 stopWarning，实际：${confirmMessages[0]}`);

  // 确认执行（带 80ms 延迟，检查"执行中…"态）
  window.uiConfirm = async () => true;
  backend.state.delayNextPostMs = 80;
  window.document.querySelector('[data-protocol-action="stop"]').click();
  await sleep(20);
  const runningBtn = window.document.querySelector('[data-protocol-action="stop"]');
  assert.ok(runningBtn && runningBtn.disabled, '动作执行期间按钮应 disabled');
  assert.equal(runningBtn.textContent, '执行中…', '动作执行期间按钮文案应为「执行中…」');
  await waitFor(() => postCalls(calls).length === 1, 3000, '确认后应发出 POST');
  const stopCall = postCalls(calls)[0];
  assert.equal(stopCall.path, '/api/protocol/stop');
  assert.equal(stopCall.method, 'POST');
  assert.equal(bodyJson(stopCall).confirm, true, 'stop 请求体必须带 confirm:true');
  backend.state.delayNextPostMs = 0;
  await waitFor(() => window.document.querySelector('#protocol-state-badge')?.textContent === '已停止', 4000, '动作后刷新状态');
  await waitFor(() => window.document.querySelector('#protocol-toast'), 3000, '动作结果 toast');
  assert.ok(window.document.querySelector('#protocol-toast').textContent.includes('停止完成'), 'toast 应提示动作完成');

  // start 不需要确认
  const before = postCalls(calls).length;
  window.uiConfirm = async () => { throw new Error('start 不应弹确认'); };
  window.document.querySelector('[data-protocol-action="start"]').click();
  await waitFor(() => postCalls(calls).length === before + 1, 3000, 'start 应直接发 POST');
  const startCall = postCalls(calls).at(-1);
  assert.equal(startCall.path, '/api/protocol/start');
  assert.notEqual(bodyJson(startCall).confirm, true, 'start 不需要 confirm');
  return `取消=0 POST；确认 stop → POST confirm:true；start 直接执行`;
});

// ══ ④⑤ 错误分支 ════════════════════════════════════════════════════════

c.section('④⑤ 503 / 409 的可读提示');

await c.check('503 ⇒ 页面展示后端 lastError；409 ⇒ 页面展示「不可管理」类提示', async () => {
  const backend = makeBackend();
  const { window, calls } = await bootUI({ respond: backend.respond });
  backend.state.protocol = protocolStatus({ actions: ['start', 'stop', 'restart'] });
  await window.fetchProtocolStatus();
  await window.loadSnowlumaPage({ quiet: true });
  await waitCard(window);

  // 503：动作失败，后端带 lastError
  backend.state.nextActionResponse = {
    status: 503,
    body: { error: '启动失败', code: 'PROTOCOL_ACTION_FAILED', lastError: 'systemctl --user start napcat.service 超时（90000ms）' }
  };
  window.uiConfirm = async () => true;
  window.document.querySelector('[data-protocol-action="start"]').click();
  await waitFor(() => (window.document.querySelector('#protocol-card-error')?.textContent || '').includes('超时（90000ms）'),
    4000, '503 的 lastError 应展示在页面上');
  const errText = window.document.querySelector('#protocol-card-error').textContent;
  assert.ok(errText.includes('协议端操作失败'), `503 应有「协议端操作失败」提示：${errText}`);
  assert.ok(errText.includes('systemctl --user start'), `503 应展示 lastError 原文：${errText}`);

  // 409：当前不是可管理的容器协议端
  backend.state.nextActionResponse = {
    status: 409,
    body: { error: '当前不是可管理的容器协议端', code: 'PROTOCOL_NOT_MANAGED' }
  };
  window.document.querySelector('[data-protocol-action="start"]').click();
  await waitFor(() => (window.document.querySelector('#protocol-card-error')?.textContent || '').includes('不是可管理的容器协议端'),
    4000, '409 应展示「不可管理」提示');
  const text409 = window.document.querySelector('#protocol-card-error').textContent;
  assert.ok(text409.includes('不是可管理的容器协议端'), `409 文案应说明不可管理：${text409}`);
  assert.equal(postCalls(calls).length, 2, '两次错误动作各发一次 POST（错误分支不重试、不静默）');
  return '503 展示 lastError；409 展示不可管理';
});

// ══ 拉取时机（不挂全局轮询）═══════════════════════════════════════════════

c.section('拉取时机：进入页签一次 + 动作后刷新，quiet 重渲染读缓存');

await c.check('quiet 重渲染不重复拉 /api/protocol/status；非 quiet（进入页签）才拉一次', async () => {
  const backend = makeBackend();
  const { window } = await bootUI({ respond: backend.respond });
  await window.loadSnowlumaPage();               // 进入页签
  await waitCard(window);
  const afterEnter = backend.state.protocolStatusCalls;
  assert.equal(afterEnter, 1, `进入页签应只拉一次状态，实际 ${afterEnter}`);
  await window.loadSnowlumaPage({ quiet: true });  // SSE 触发的重渲染
  await window.loadSnowlumaPage({ quiet: true });
  assert.equal(backend.state.protocolStatusCalls, afterEnter, 'quiet 重渲染不得重复请求协议端状态');
  await window.loadSnowlumaPage();                 // 再次进入页签
  assert.equal(backend.state.protocolStatusCalls, afterEnter + 1, '再次进入页签应重新拉一次');
  // 静态守卫：禁止把协议端状态挂到全局轮询上
  assert.ok(!/setInterval\([^)]*fetchProtocolStatus/.test(SNOWLUMA_SRC), '不得把 fetchProtocolStatus 挂进 setInterval');
  assert.ok(!/setInterval\([^)]*protocolCardState/.test(SNOWLUMA_SRC), '不得把协议端状态轮询挂进 setInterval');
  return `进入页签 1 次、quiet 重渲染 0 次新增、再进入 +1`;
});

// ══ 负向对照 1：删掉确认逻辑 ⇒ ③ 前半必须失败 ═════════════════════════════

c.section('负向对照 1：删掉 stop 的确认分支 ⇒「取消不发 POST」必须失败');

await c.check('确认分支被去掉后，取消确认仍会发 POST —— 说明 ③ 的断言不是永真', async () => {
  const brokenCode = buildMainCode({
    snowlumaReplace: [['if (protocolNeedsConfirm(action)) {', 'if (false) {']]
  });
  const backend = makeBackend();
  const { window, calls } = await bootUI({ respond: backend.respond, mainCode: brokenCode });
  backend.state.protocol = protocolStatus({ actions: ['start', 'stop', 'restart'] });
  await window.fetchProtocolStatus();
  await window.loadSnowlumaPage({ quiet: true });
  await waitCard(window);
  let confirmCalled = false;
  window.uiConfirm = async () => { confirmCalled = true; return false; };
  window.document.querySelector('[data-protocol-action="stop"]').click();
  await waitFor(() => postCalls(calls).length > 0, 3000, '破坏版应直接发 POST');
  const sent = postCalls(calls)[0];
  // 用 ③ 的前半断言检查它 —— 必须失败
  let positiveFailed = false;
  try {
    assert.equal(confirmCalled, true, '点击 stop 应先弹确认');
    assert.equal(postCalls(calls).length, 0, '取消确认后不得发出任何动作请求');
  } catch { positiveFailed = true; }
  assert.ok(positiveFailed, '负向对照应失败：去掉确认逻辑后「取消不发 POST」必须不成立');
  assert.equal(confirmCalled, false, '破坏版不应弹确认');
  console.log(`    负向对照（确认）：破坏版直接发了 POST ${sent.path}（confirm=${JSON.stringify(bodyJson(sent).confirm)}）⇒ ③ 断言失败 ✅`);
  return `破坏版：未弹确认、直接 POST ${sent.path}`;
});

// ══ 负向对照 2：actions 渲染改成硬编码三按钮 ⇒ ② 必须失败 ═══════════════

c.section('负向对照 2：actions 渲染改为硬编码三按钮 ⇒「只给 start 不出现 stop」必须失败');

await c.check('硬编码三按钮后，actions=[start] 仍渲染 stop —— 说明 ② 的断言不是永真', async () => {
  const brokenCode = buildMainCode({
    snowlumaReplace: [[
      'const actions = protocolCardActions(p);',
      "const actions = ['start', 'stop', 'restart'];"
    ]]
  });
  const backend = makeBackend();
  const { window } = await bootUI({ respond: backend.respond, mainCode: brokenCode });
  backend.state.protocol = protocolStatus({ actions: ['start'] });
  await window.fetchProtocolStatus();
  await window.loadSnowlumaPage({ quiet: true });
  await waitCard(window);
  let positiveFailed = false;
  try {
    assert.equal(window.document.querySelector('[data-protocol-action="stop"]'), null,
      'actions 不含 stop 时绝不能渲染 stop 按钮');
  } catch { positiveFailed = true; }
  assert.ok(positiveFailed, '负向对照应失败：硬编码三按钮后 ② 必须不成立');
  const buttons = [...window.document.querySelectorAll('[data-protocol-action]')].map((b) => b.dataset.protocolAction);
  console.log(`    负向对照（actions）：actions=[start] 时硬编码版渲染了 [${buttons.join(',')}] ⇒ ② 断言失败 ✅`);
  return `破坏版：actions=[start] 却渲染 [${buttons.join(',')}]`;
});

// ══ 汇总 ════════════════════════════════════════════════════════════════

const ok = c.finish();
if (ok) console.log('\n协议端卡片（徽标 / 按钮 / 确认 / 错误分支）：全部通过 ✅');
process.exit(ok ? 0 : 1);
