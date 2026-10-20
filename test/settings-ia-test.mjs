// S1 第二批：设置页信息架构 —— 字段搜索 / hash 深链 / 外部协议端模式收敛。
//
// 要钉住的三件事（都来自现场反馈）：
//   ① 设置页没有搜索：几十个字段只能靠记忆翻分区。搜索只过滤**当前分区**的
//      .setcard，命中面 = 可见文本 + 输入控件的 title/placeholder；
//      查询命中为空时必须给「没有匹配的设置项」，否则用户以为页面坏了。Esc 清空；
//   ② 没有深链：#settings/<section> 与 #settings/<section>/<cardId> 要能直接定位，
//      地址栏写回只走 replaceState（可复制、可刷新，但不产生历史垃圾）；
//   ③ external（NapCat 容器）模式下「程序目录 / 自动拉起 / 打开文件夹」全是无效控件
//      （线上点「打开文件夹」直接 400）：整块换成说明 + 协议端状态入口；
//      内置模式渲染必须与改造前等价。
//
// 负向对照（验收时贴前后输出）：把 ui/app/06-settings-render.js 里
// `if (isExternalProtocolMode(state.status)) {` 改成 `if (false) {` 再跑本测试 ——
// C 段 external 断言必须失败、进程退出码 1；恢复后回到 0。这证明断言不是永真的。
//
// 运行：node test/settings-ia-test.mjs（jsdom 在 node_modules）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const { JSDOM, VirtualConsole } = await import('jsdom');
const { APP_PARTS, readAppPart } = await import('./_ui-load.mjs');

const c = createChecker('设置页信息架构（S1 第二批）');

// ── 加载真实前端代码（与 test/topbar-status-test.mjs 同一套 jsdom 基建）────────
// 顺序 = index.html 的 defer 顺序；排除 11-init（启动入口会真的跑首屏流程）。
// 12-concept2-ui / 13-qq-login 在 _ui-load.APP_PARTS 之外，但 index.html 确实加载
// 它们：设置页的 setCard / autoFold 就在这里，少了它整页会走"无折叠卡"降级分支。
const MAIN_PARTS = [
  ...APP_PARTS.filter((n) => n !== '11-init.js'),
  '12-concept2-ui.js', '13-qq-login.js'
];
let MAIN_CODE = MAIN_PARTS.map(readAppPart).join('\n\n');
// 顶层 'use strict' 会让 window.eval 里的函数声明留在 eval 作用域、挂不到 window 上；
// 测试要从 window 调 switchTab / refreshStatus / applyLocationHash（浏览器里它们是全局）。
MAIN_CODE = MAIN_CODE.replace(/^'use strict';\s*$/m, '');

const { DEFAULT_CONFIG } = await import('../src/config.js');
const CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
CONFIG.api.model = 'test-model';

/** /api/status 的最小完整现场（缺字段会让 refreshStatus 后半段静默抛错）。 */
function statusOf(over = {}) {
  const base = {
    onebot: {
      connected: true, everConnected: true, error: '', diagnosis: '',
      self: { userId: '9999', nickname: '小鲸鱼' },
      httpOk: true, httpError: '', dataPathState: 'ok', dataPathReason: '',
      lastProbeAt: Date.now() - 5000
    },
    protocol: { mode: 'embedded' },
    protocolManaged: { managed: false, running: null, state: '' },
    snowluma: { running: true },
    qqPortable: { running: true },
    orchestrator: { model: 'test-model' },
    usage: { runs: 0, totalTokens: 0 },
    cost: { cost: 0 },
    cacheHitRate: 0,
    webSearchCount: 0,
    paused: false,
    dataDir: '/tmp/qq-agent-settings-ia-test'
  };
  const out = { ...base, ...over };
  out.onebot = { ...base.onebot, ...(over.onebot || {}) };
  out.orchestrator = { ...base.orchestrator, ...(over.orchestrator || {}) };
  for (const key of ['protocol', 'protocolManaged', 'snowluma', 'qqPortable']) {
    out[key] = { ...base[key], ...(over[key] || {}) };
  }
  return out;
}

async function bootUI() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!String(e?.message || '').includes('Not implemented')) console.error(e);
  });
  const dom = new JSDOM(HTML, {
    url: 'http://127.0.0.1:45991/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  const bus = { status: statusOf({}) };
  window.fetch = async (input, init = {}) => {
    const pathname = new URL(String(input), window.location.href).pathname;
    let body = {};
    if (pathname.startsWith('/api/status')) body = bus.status;
    // POST /api/config 的回包是 { ok, config }（saveConfig 会拿它覆盖 state.config），
    // GET 才是配置本体 —— 混用会让 state.config 变成 undefined、整页渲染报错。
    else if (pathname.startsWith('/api/config')) {
      body = String(init?.method || 'GET').toUpperCase() === 'POST' ? { ok: true, config: CONFIG } : CONFIG;
    } else if (pathname.startsWith('/api/persona-templates')) body = { templates: [] };
    else if (pathname.startsWith('/api/providers')) body = { providers: [] };
    else if (pathname.startsWith('/api/vision/results')) body = { results: {}, scanning: false };
    else if (pathname.startsWith('/api/model-prices')) body = { prices: [], current: null };
    else if (pathname.startsWith('/api/tools')) body = { tools: [] };
    else if (pathname.startsWith('/api/skills')) body = { skills: [], summary: {}, uninstalled: [] };
    else if (pathname.startsWith('/api/chats')) body = { chats: [] };
    else if (pathname.startsWith('/api/version')) body = { version: 'test' };
    return { ok: true, status: 200, json: async () => body };
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
  // 桥文件（app.js）在浏览器里提供 vendor 绑定；这里按同源实现注入
  const tier = await import('../src/tier-slider.js');
  const priceMod = await import('../ui/vendor/price-match.js');
  Object.assign(window, {
    TIER_SLIDER_BANDS: tier.TIER_SLIDER_BANDS,
    sliderToTier: tier.sliderToTier,
    tierToSlider: tier.tierToSlider,
    matchPriceTable: priceMod.matchPriceTable
  });
  window.eval(MAIN_CODE);
  return { window, bus };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}

const { window, bus } = await bootUI();
const doc = window.document;
const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const bySection = (id) => $(`.settings-menu-item[data-section="${id}"]`);
const visibleCards = () => $$('#settings-form .setcard').filter((el) => !el.classList.contains('search-hidden'));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const typeSearch = (text) => {
  const input = $('#settings-search');
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const keydown = (target, init) => {
  const ev = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

// ══ A. 字段搜索 ═══════════════════════════════════════════════════════════
c.section('A. 字段搜索（只过滤当前分区 / 空态 / Esc 清空）');

window.switchTab('settings');
await waitFor(() => $$('#settings-form .setcard').length >= 3, 8000, '设置页候选卡渲染');

await c.check('侧栏顶部有 #settings-search（placeholder / 默认分区 api）', () => {
  const input = $('#settings-search');
  assert.ok(input, '#settings-search 不存在');
  assert.equal(input.getAttribute('placeholder'), '搜索设置项…');
  assert.equal(bySection('api')?.classList.contains('active'), true, '默认分区应为 api');
  return `api 分区 ${$$('#settings-form .setcard').length} 张卡`;
});

await c.check('输入「备选」→ 只剩备选模型卡（其余卡被过滤）', () => {
  typeSearch('备选');
  assert.deepEqual(visibleCards().map((el) => el.id), ['card-api-fallback']);
  assert.equal($('#settings-search-empty').hidden, true, '有命中时空态必须收起');
  return '2 张卡被过滤，命中 1 张';
});

await c.check('输入框 placeholder 也参与匹配（切到搜索服务，搜只在占位里的「自建 SearXNG」）', async () => {
  click(bySection('search'));
  await waitFor(() => doc.getElementById('cfg-searchprovider'), 8000, '搜索服务分区渲染');
  typeSearch('自建 SearXNG');
  const visible = visibleCards();
  assert.ok(visible.length >= 1, 'placeholder 命中不应过滤成空');
  for (const card of visible) {
    assert.ok(card.querySelector('input[placeholder*="SearXNG"]'), `可视卡应含带该占位的输入框：${card.id || '(无 id)'}`);
  }
  // 回到 api 分区继续做 hash 用例（Esc 清空过滤）
  keydown($('#settings-search'), { key: 'Escape' });
  click(bySection('api'));
  await waitFor(() => bySection('api').classList.contains('active') && doc.getElementById('card-api-fallback'), 8000, '回到 api 分区');
  return `占位命中 ${visible.length} 张卡`;
});

await c.check('无命中 → 显示「没有匹配的设置项」', () => {
  typeSearch('zzz-不存在的字段');
  assert.deepEqual(visibleCards(), []);
  const empty = $('#settings-search-empty');
  assert.ok(empty && !empty.hidden, '空态提示必须可见');
  assert.equal(empty.textContent, '没有匹配的设置项');
  return '空态文案已显示';
});

await c.check('Esc 清空：输入框清空、卡片全部恢复、空态收起', () => {
  const input = $('#settings-search');
  keydown(input, { key: 'Escape' });
  assert.equal(input.value, '');
  assert.ok(visibleCards().length >= 3, '清空后应恢复全部卡片');
  assert.equal($('#settings-search-empty').hidden, true);
  return `${visibleCards().length} 张卡全部可见`;
});

await c.check('Ctrl+K 聚焦搜索框', () => {
  const input = $('#settings-search');
  input.blur();
  const ev = keydown(doc, { key: 'k', ctrlKey: true });
  assert.equal(doc.activeElement, input, 'Ctrl+K 后焦点应在搜索框');
  assert.equal(ev.defaultPrevented, true, '命中快捷键后应 preventDefault');
  return '焦点已进搜索框';
});

// ══ B. hash：写回策略 ═════════════════════════════════════════════════════
c.section('B. hash 写回（replaceState：不产生历史垃圾）');

await c.check('切页签写回 #<tab>（chats）', () => {
  window.switchTab('chats');
  assert.equal(window.location.hash, '#chats');
  return '#chats';
});

await c.check('点侧栏分区写回 #settings/<section>，且历史条目数不变', async () => {
  window.switchTab('settings');
  await waitFor(() => $$('#settings-form .setcard').length >= 3, 4000, '设置页重新渲染');
  const before = window.history.length;
  click(bySection('search'));
  await waitFor(() => bySection('search').classList.contains('active'), 4000, 'search 分区激活');
  assert.equal(window.location.hash, '#settings/search');
  assert.equal(window.history.length, before, 'replaceState 不应新增历史条目');
  return `hash=${window.location.hash}，history.length=${before}（不变）`;
});

// ══ C. hash 深链：定位页签 / 分区 / 卡片 ═══════════════════════════════════
c.section('C. hash 深链（#settings/<section> 与 #settings/<section>/<cardId>）');

await c.check('#settings/api：切到设置页 + api 分区，hash 原样保留', async () => {
  window.switchTab('chats');
  window.history.replaceState(null, '', '#settings/api');
  assert.equal(window.applyLocationHash(), true, '可识别的深链应返回 true');
  await waitFor(() => $('#view-settings').classList.contains('active')
    && bySection('api').classList.contains('active'), 8000, '深链切到 settings/api');
  assert.equal(window.location.hash, '#settings/api', '深链应用后 hash 不应被改写成其它形态');
  return 'settings/api 已定位';
});

await c.check('#settings/api/card-api-price：卡片被定位并短暂高亮，hash 保留 /<cardId>', async () => {
  window.history.replaceState(null, '', '#settings/api/card-api-price');
  assert.equal(window.applyLocationHash(), true);
  const card = await waitFor(() => {
    const el = doc.getElementById('card-api-price');
    return el && el.classList.contains('is-deeplink') ? el : null;
  }, 8000, '卡片高亮出现');
  assert.equal(window.location.hash, '#settings/api/card-api-price', 'hash 不能被 /<section> 冲掉');
  assert.equal(bySection('api').classList.contains('active'), true);
  return `${card.id} 已滚动定位并高亮`;
});

await c.check('高亮 1.5s 后自动移除（不是常驻标记）', async () => {
  await waitFor(() => {
    const el = doc.getElementById('card-api-price');
    return el && !el.classList.contains('is-deeplink');
  }, 4000, '高亮到期移除');
  return '1.5s 后 class 已移除';
});

await c.check('点侧栏分区 = 从 hash 里去掉卡片段（#settings/api/card-* → #settings/api）', () => {
  // 深链刚落定时 hash 还带着 /card-api-price；点「模型 API」应回到分区级
  click(bySection('api'));
  assert.equal(window.location.hash, '#settings/api');
  return '#settings/api';
});

// ══ D. 外部协议端模式：隐藏无效控件 ═══════════════════════════════════════
c.section('D. external 模式（NapCat 容器）隐藏内置 SnowLuma 控件');

await c.check('external ⇒ OneBot 分区无程序目录/自动拉起/打开文件夹，有说明与状态入口', async () => {
  bus.status = statusOf({
    protocol: { mode: 'external' },
    snowluma: { running: null },
    qqPortable: { running: null }
  });
  await window.refreshStatus();
  click(bySection('onebot'));
  await waitFor(() => doc.getElementById('settings-onebot'), 4000, 'OneBot 分区渲染');
  for (const id of ['cfg-snowlumadir', 'cfg-snowlumalaunch', 'open-snowluma-btn', 'snowluma-hint']) {
    assert.equal(doc.getElementById(id), null, `external 模式不应渲染 #${id}`);
  }
  const notice = $('#card-onebot-external');
  assert.ok(notice, '应有外部协议端说明卡');
  const text = notice.textContent;
  assert.ok(text.includes('协议端由外部容器（NapCat）提供'), `说明文案缺失：${text.slice(0, 80)}`);
  assert.ok(text.includes('systemctl --user status napcat'), '说明应给出排障命令');
  assert.ok(doc.getElementById('goto-protocol-status-btn'), '应有「查看协议端状态」入口');
  // 连接地址/令牌仍然要能填（连外部容器同样需要）
  assert.ok(doc.getElementById('cfg-wsurl') && doc.getElementById('cfg-httpurl'), '连接地址仍应渲染');
  return '无效控件已收敛，说明 + 入口就位';
});

await c.check('点「查看协议端状态」→ 切到 SnowLuma 页签', async () => {
  click(doc.getElementById('goto-protocol-status-btn'));
  assert.equal(window.location.hash, '#snowluma');
  await waitFor(() => $('#view-snowluma').classList.contains('active'), 4000, 'snowluma 视图激活');
  return '已切到协议端状态页签';
});

await c.check('内置（embedded）模式仍渲染原控件（不误伤）', async () => {
  bus.status = statusOf({ protocol: { mode: 'embedded' } });
  await window.refreshStatus();
  window.switchTab('settings');
  click(bySection('onebot'));
  // 等的是 embedded 分支的**特征控件**，不是 #settings-onebot —— 后者在上一轮
  // external 渲染里就已存在，拿它当等待条件会立刻返回、断言跑在旧 DOM 上。
  await waitFor(() => doc.getElementById('settings-onebot') && doc.getElementById('cfg-snowlumadir'),
    4000, 'embedded OneBot 分区渲染');
  assert.ok(doc.getElementById('cfg-snowlumadir'), 'embedded 模式应保留程序目录输入框');
  assert.ok(doc.getElementById('cfg-snowlumalaunch'), 'embedded 模式应保留自动拉起开关');
  assert.ok(doc.getElementById('open-snowluma-btn'), 'embedded 模式应保留打开文件夹按钮');
  assert.equal(doc.getElementById('card-onebot-external'), null, 'embedded 模式不应出现外部说明卡');
  return '内置模式渲染不变';
});

// ══ E. 加载顺序 ═══════════════════════════════════════════════════════════
c.section('E. settings.css 加载顺序');

await c.check('settings.css 在 shell.css 之后加载（token 已就绪，组件规则可覆盖）', () => {
  const iShell = HTML.indexOf('href="./shell.css"');
  const iSettings = HTML.indexOf('href="./settings.css"');
  assert.ok(iSettings > 0, 'index.html 应引用 settings.css');
  assert.ok(iSettings > iShell, 'settings.css 必须排在 shell.css 之后');
  assert.ok(fs.existsSync(path.join(ROOT, 'ui', 'settings.css')), 'ui/settings.css 应存在');
  return `shell.css@${iShell} < settings.css@${iSettings}`;
});

c.finish();
// jsdom 的定时器不会自己停，显式退出让退出码可靠
process.exit(c.results.fail.length ? 1 : 0);
