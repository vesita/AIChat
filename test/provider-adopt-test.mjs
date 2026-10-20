// 「补登记孤儿渠道」测试：POST /api/providers/adopt-current + 设置页模型卡片渲染。
//
// 背景（2026-10-20 M1）：VPS 现场 GET /api/providers 返回 providers=[]，但
// GET /api/config 里 api.provider="si-beat"、api.model、api.baseUrl、hasApiKey
// 都有 —— 渠道目录为空 ⇒ 前端 06-settings-render.js 的 currentProvider 找不到，
// 渲染成「尚未选择模型」。本测试覆盖两层：
//   1) 后端：孤儿配置 adopt 后渠道进目录、api.provider 改写到新 id、Key 进
//      dshProviderKeys；重复调用幂等（created:false 且不重复建）；缺 provider /
//      缺 baseUrl 返回 400。
//   2) 前端：孤儿态渲染出真实配置 + 「补登记到模型目录」按钮；渠道存在时保持
//      原有文案、不出现按钮。
//
// 数据目录隔离到临时目录，不碰仓库内 data/，也不起服务：直接 import
// createRoutes 拿到路由 handler 调用（同一条 handler，只是省掉 HTTP 外壳）；
// 前端用与 test/render-test.mjs 同型的 vm sandbox 执行拼接后的 ui/app 代码。
//
// 运行：node test/provider-adopt-test.mjs（已接入 npm test）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 数据目录隔离（必须在 import src/** 之前设置）──
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-adopt-'));
if (!DATA_DIR.startsWith(os.tmpdir())) {
  throw new Error(`临时数据目录不在 ${os.tmpdir()} 下，拒绝继续：${DATA_DIR}`);
}
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;

const API_KEY = 'sk-adopt-test-key';
const BASE_URL = 'https://tokenrhythm.studio/v1';
const MODEL = 'deepseek-flash';
const ORPHAN_PROVIDER_ID = 'si-beat';

// 孤儿配置：api 里选好渠道，providers 目录为空。
fs.writeFileSync(
  path.join(DATA_DIR, 'config.json'),
  JSON.stringify({
    api: { provider: ORPHAN_PROVIDER_ID, model: MODEL, baseUrl: BASE_URL, apiKey: API_KEY },
    providers: [],
    dshProviderKeys: {}
  }, null, 2)
);

let failed = 0;
function pass(name, detail = '') {
  console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
}
function fail(name, detail) {
  failed++;
  console.log(`  ✗ ${name}`);
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
}
function check(name, cond, detail = '') {
  if (cond) pass(name);
  else fail(name, detail);
}

/** 一条断言组：任何一项抛错都记为失败，不中断后续断言。 */
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(name, e?.stack || e?.message || String(e));
  }
}

const { createRoutes } = await import('../src/routes.js');
const { getConfig, updateConfig } = await import('../src/config.js');

// 后端 sanitizeProvider 的真实实现住在 src/app.js 闭包里（不可直接 import），
// 这里按它的契约做等价桩：删掉明文 apiKey、补 hasKey。返回结构断言只依赖这层。
function sanitizeProviderStub(p) {
  if (!p || typeof p !== 'object') return p;
  const { apiKey, ...rest } = p;
  return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
}

// 路由表只依赖 handler 用到的 dep（readBody 在其它 handler 里，本路由不读 body）。
const routes = createRoutes({ sanitizeProvider: sanitizeProviderStub, readBody: async () => ({}) });
const adoptRoute = routes.find((r) => r.method === 'POST' && r.pattern === '/api/providers/adopt-current');
if (!adoptRoute) {
  fail('路由表里有 POST /api/providers/adopt-current', '没找到该路由');
  process.exit(1);
}
/** 直接调用路由 handler；json 桩把 (res, code, body) 收成 {code, body}。 */
const callAdopt = () => adoptRoute.handler({
  req: {}, res: {}, json: (res, code, body) => ({ code, body })
});

console.log('=== 后端：孤儿配置补登记 ===');

let first = null;
await step('孤儿配置 adopt 成功', async () => {
  first = await callAdopt();
  check('返回 200', first.code === 200, `实际 ${first.code}：${JSON.stringify(first.body)}`);
  check('ok=true', first.body?.ok === true);
  check('created=true（这次是真新建）', first.body?.created === true, JSON.stringify(first.body));
  check('providerId 是 upsertProvider 生成的 custom_ id',
    typeof first.body?.providerId === 'string' && first.body.providerId.startsWith('custom_'),
    String(first.body?.providerId));
  check('响应里的渠道已脱敏（不带明文 Key）',
    first.body?.provider?.apiKey === '' && !JSON.stringify(first.body).includes(API_KEY));
  check('响应里的渠道 hasKey=true', first.body?.provider?.hasKey === true);
});

await step('配置落盘后：渠道进目录、选中渠道被改写、Key 进 dshProviderKeys', async () => {
  const cfg = getConfig();
  check('providers 里有 1 个渠道', (cfg.providers || []).length === 1, `实际 ${(cfg.providers || []).length}`);
  const p = (cfg.providers || [])[0] || {};
  check('渠道 id == 返回的 providerId', p.id === first?.body?.providerId, `${p.id} vs ${first?.body?.providerId}`);
  check('api.provider 已改写成新 id（不改写前端仍找不到）', cfg.api.provider === p.id, `api.provider=${cfg.api.provider}`);
  check('dshProviderKeys[新 id] == api.apiKey', cfg.dshProviderKeys?.[p.id] === API_KEY);
  check('渠道的 models 含 api.model', (p.models || []).includes(MODEL), JSON.stringify(p.models));
  check('api 下其它字段未被 deepMerge 冲掉',
    cfg.api.model === MODEL && cfg.api.baseUrl === BASE_URL,
    `model=${cfg.api.model} baseUrl=${cfg.api.baseUrl}`);
  // 落盘验证：不是只在内存里对
  const disk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
  check('磁盘 config.json 也带上新渠道与新选中 id',
    (disk.providers || [])[0]?.id === p.id && disk.api?.provider === p.id);
});

await step('重复调用幂等：created=false 且不重复建渠道', async () => {
  const before = getConfig();
  const r2 = await callAdopt();
  check('返回 200', r2.code === 200, `实际 ${r2.code}`);
  check('created=false', r2.body?.created === false, JSON.stringify(r2.body));
  check('providerId 与第一次相同', r2.body?.providerId === first?.body?.providerId);
  check('providers 数量没变', (getConfig().providers || []).length === (before.providers || []).length,
    `${(getConfig().providers || []).length}`);
});

await step('api.provider 为空 → 400', async () => {
  updateConfig({ api: { provider: '' } });
  const r3 = await callAdopt();
  check('返回 400', r3.code === 400, `实际 ${r3.code}：${JSON.stringify(r3.body)}`);
  check('ok=false 且给出中文原因',
    r3.body?.ok === false && /api\.provider/.test(String(r3.body?.error || '')),
    JSON.stringify(r3.body));
  check('失败时没有新增渠道', (getConfig().providers || []).length === 1);
});

await step('api.baseUrl 为空 → 400', async () => {
  updateConfig({ api: { provider: 'ghost-provider', baseUrl: '' } });
  const r4 = await callAdopt();
  check('返回 400', r4.code === 400, `实际 ${r4.code}：${JSON.stringify(r4.body)}`);
  check('ok=false 且给出中文原因',
    r4.body?.ok === false && /Base URL/.test(String(r4.body?.error || '')),
    JSON.stringify(r4.body));
});

console.log('\n=== 前端：模型卡片在孤儿态与正常态的渲染 ===');
// 与 test/render-test.mjs 同型的极简 DOM 桩 + vm sandbox：真正执行 ui/app 拼接代码，
// 调真实的 renderApiSection（不是字符串匹配源码）。
const { loadUiAppCode } = await import('./_ui-load.mjs');
let uiCode = loadUiAppCode().code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');
const { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } = await import('../src/tier-slider.js');
const { matchPriceTable } = await import('../src/model-prices.js');

function makeEl(id = '') {
  const el = {
    id, dataset: {}, style: { setProperty() {}, removeProperty() {} }, textContent: '',
    innerHTML: '', value: '', checked: false, children: [],
    addEventListener() {}, removeEventListener() {},
    querySelector: () => makeEl(), querySelectorAll: () => [],
    appendChild(c) { el.children.push(c); return c; }, remove() {},
    closest: () => null, setAttribute() {}, getAttribute: () => null,
    focus() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20 }),
    insertAdjacentHTML() {}, contains: () => false,
    scrollTop: 0, scrollHeight: 100, clientHeight: 50
  };
  el.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  return el;
}
const elStore = new Map();
const uiDocument = {
  documentElement: makeEl('html'), body: makeEl('body'), head: makeEl('head'),
  querySelector: (sel) => {
    if (!elStore.has(sel)) elStore.set(sel, makeEl(String(sel).replace(/^#/, '')));
    return elStore.get(sel);
  },
  querySelectorAll: () => [],
  getElementById: (id) => uiDocument.querySelector('#' + id),
  createElement: () => makeEl(),
  addEventListener() {}, removeEventListener() {}
};
const sandbox = {
  document: uiDocument, window: null,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', host: '127.0.0.1' },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  alert() {}, confirm: () => true, prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  navigator: { userAgent: 'node' },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  URL, Blob: function () {}, FileReader: function () {},
  Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x)),
  TIER_SLIDER_BANDS, sliderToTier, tierToSlider, matchPriceTable
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

try {
  const ctx = vm.createContext(sandbox);
  new vm.Script(uiCode, { filename: path.join('ui', 'app', '06-settings-render.js') }).runInContext(ctx);
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const uiCfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  uiCfg.api = { ...uiCfg.api, provider: ORPHAN_PROVIDER_ID, model: MODEL, baseUrl: BASE_URL, hasApiKey: true };

  await step('孤儿态：真实配置 + 补登记按钮', async () => {
    vm.runInContext('state.providers = [];', ctx);
    const html = vm.runInContext('renderApiSection(globalThis.__uiCfg)', Object.assign(ctx, { __uiCfg: uiCfg }));
    check('不再显示「尚未选择模型」', !html.includes('尚未选择模型'));
    check('显示当前 model 与 baseUrl', html.includes(MODEL) && html.includes(BASE_URL), html.slice(0, 400));
    check('显示 API Key 已保存（不显示）', html.includes('已保存（不显示）'));
    check('提示该渠道未登记到模型目录', html.includes('未登记到模型目录'));
    check('渲染出补登记按钮', html.includes('id="adopt-current-provider-btn"') && html.includes('补登记到模型目录'));
  });

  await step('正常态：保留原文案、不出现补登记按钮', async () => {
    vm.runInContext(`state.providers = ${JSON.stringify([
      { id: ORPHAN_PROVIDER_ID, displayName: ORPHAN_PROVIDER_ID, baseURL: BASE_URL, hasKey: true, models: [MODEL] }
    ])};`, ctx);
    const html = vm.runInContext('renderApiSection(globalThis.__uiCfg)', Object.assign(ctx, { __uiCfg: uiCfg }));
    check('显示当前渠道文案', html.includes(`当前：${ORPHAN_PROVIDER_ID}`) && html.includes(BASE_URL));
    check('不出现「尚未选择模型」', !html.includes('尚未选择模型'));
    check('不出现补登记按钮', !html.includes('adopt-current-provider-btn'));
  });

  await step('空配置：仍显示「尚未选择模型」', async () => {
    vm.runInContext('state.providers = [];', ctx);
    const emptyCfg = JSON.parse(JSON.stringify(uiCfg));
    emptyCfg.api = { ...emptyCfg.api, provider: '', model: '', baseUrl: '' };
    const html = vm.runInContext('renderApiSection(globalThis.__uiCfg)', Object.assign(ctx, { __uiCfg: emptyCfg }));
    check('显示「尚未选择模型」', html.includes('尚未选择模型'));
    check('不出现补登记按钮', !html.includes('adopt-current-provider-btn'));
  });
} catch (e) {
  fail('前端渲染断言执行', e?.stack || e?.message || String(e));
}

// UI 代码顶层挂了定时器（SSE 重连等），断言跑完必须主动退出。
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
