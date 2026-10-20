// 顶栏链路状态带（T1）：单一判定 + 五段诊断面板 + 首屏中性文案。
//
// 要钉住的三件事（都来自现场故障「顶栏总显示 OneBot 无法连接」）：
//   ① 首屏不能冒充断连：请求没跑到/失败时文案必须停在中性的「链路状态检测中…」，
//      改造前那句话写死成「OneBot 未连接」，所以永远像连不上；
//   ② 判定只有一个点 computeLinkState()（圆点/胶囊/就绪点三套判定已合并）：
//      输入 → 状态 → 文案的对照表就是本测试的 B 段；
//   ③ 面板五段各自给出证据与下一手动作，且只在打开时用最近一次 /api/status 渲染。
//
// 负向对照（手工，验收时会贴前后输出）：
//   把 ui/app/01-boot.js 里 computeLinkState 的 `if (ob.httpOk === false) reasons.push(...)`
//   一行注释掉再跑本测试 —— B 段「WS 通但 HTTP 坏」必须失败、进程退出码 1；恢复后回到 0。
//   这证明断言不是永真的。
//
// 运行：node test/topbar-status-test.mjs（jsdom 在 node_modules）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const { JSDOM, VirtualConsole } = await import('jsdom');
const { APP_PARTS, readAppPart } = await import('./_ui-load.mjs');

const c = createChecker('顶栏链路状态带（T1）');

// ── 加载真实前端代码（与 test/qq-login-ui-test.mjs 同一套 jsdom 基建）────────
// 顺序 = index.html 的 defer 顺序；排除 11-init（启动入口会真的跑首屏流程），
// 补上 13-qq-login（01-boot 里「QQ 登录」入口的相关函数在它那边）。
const MAIN_PARTS = [...APP_PARTS.filter((n) => n !== '11-init.js'), '13-qq-login.js'];
let MAIN_CODE = MAIN_PARTS.map(readAppPart).join('\n\n');
// 顶层 'use strict' 会让 window.eval 里的函数声明留在 eval 作用域、挂不到 window 上；
// 测试要从 window 调 refreshStatus / computeLinkState（浏览器里它们是全局，语义等价）。
MAIN_CODE = MAIN_CODE.replace(/^'use strict';\s*$/m, '');

const CONFIG = {
  api: { baseUrl: 'http://example.invalid/v1', model: 'test-model' },
  allow: { groups: ['123456'], private: [] },
  allowAllWhenEmpty: false
};

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
    dataDir: '/tmp/qq-agent-topbar-test'
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
  window.fetch = async (input) => {
    const pathname = new URL(String(input), window.location.href).pathname;
    let body = {};
    if (pathname.startsWith('/api/status')) body = bus.status;
    else if (pathname.startsWith('/api/config')) body = CONFIG;
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
  window.eval(MAIN_CODE);
  return { window, bus };
}

const { window, bus } = await bootUI();
const doc = window.document;
const btn = () => doc.getElementById('link-status-btn');
const btnText = () => doc.getElementById('link-status-text').textContent;
const panel = () => doc.getElementById('link-status-panel');
const panelBody = () => doc.getElementById('link-panel-body');
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// ══ A. 首屏：中性文案，而不是「未连接」 ═══════════════════════════════════
c.section('A. 首屏默认文案（JS 还没跑到 / 请求失败时的样子）');

await c.check('首屏文案是「链路状态检测中…」而不是「OneBot 未连接」', () => {
  assert.equal(btnText(), '链路状态检测中…');
  assert.equal(btn().dataset.state, undefined, '还没判定时不应写 data-state');
  for (const cls of ['is-ok', 'is-warn', 'is-err']) {
    assert.ok(!btn().classList.contains(cls), `首屏不应带 ${cls}`);
  }
  return btnText();
});

await c.check('诊断面板默认隐藏', () => {
  assert.equal(panel().hidden, true);
  return 'hidden=true';
});

await c.check('旧控件已从可见顶栏移除：没有 #onebot-dot / #onebot-label', () => {
  assert.equal(doc.getElementById('onebot-dot'), null);
  assert.equal(doc.getElementById('onebot-label'), null);
  return '#onebot-dot / #onebot-label 均不存在';
});

await c.check('就绪圆点保留为隐藏兼容锚点（qq-login-ui-test 的外部模式回归仍要用）', () => {
  const dots = doc.getElementById('readiness-dots');
  assert.ok(dots, '#readiness-dots 应保留');
  assert.equal(dots.hidden, true, '锚点必须隐藏，不能再出现在视觉里');
  assert.equal(dots.querySelectorAll('.rdot').length, 4);
  return '4 个 .rdot 隐藏保留';
});

// ══ B. computeLinkState：6 种输入 → 状态 → 文案 ═══════════════════════════
c.section('B. computeLinkState 判定表（唯一判定点）');

const compute = window.computeLinkState;
assert.equal(typeof compute, 'function', 'window.computeLinkState 必须是函数（纯函数便于单测）');

const CASES = [
  {
    name: '① 连接正常',
    status: statusOf({}),
    state: 'ok', prefix: '链路正常', inc: ''
  },
  {
    name: '② 未连接（有后端诊断）',
    status: statusOf({ onebot: { connected: false, everConnected: true, diagnosis: 'WS 连接被拒绝：check snowluma.wsUrl' } }),
    state: 'err', prefix: '链路中断：', inc: 'WS 连接被拒绝'
  },
  {
    name: '③ WS 通、HTTP 数据面坏',
    status: statusOf({ onebot: { httpOk: false, httpError: 'ECONNREFUSED 127.0.0.1:3002', dataPathState: 'unknown' } }),
    state: 'warn', prefix: '链路异常：HTTP', inc: 'HTTP 数据面不可用'
  },
  {
    name: '④ 数据面自检僵尸态',
    status: statusOf({ onebot: { httpOk: true, dataPathState: 'zombie', dataPathReason: 'get_csrf_token failed' } }),
    state: 'warn', prefix: '链路异常：数据面', inc: '僵尸态'
  },
  {
    name: '⑤ 协议端容器停',
    status: statusOf({ protocolManaged: { managed: true, running: false, state: 'exited' } }),
    state: 'warn', prefix: '链路异常：协议端容器', inc: '协议端容器未运行'
  },
  {
    name: '⑥ 全空（后端什么都没给）',
    status: {},
    state: 'err', prefix: '链路中断：', inc: 'OneBot 未连接'
  }
];

const rowsOut = [];
for (const tc of CASES) {
  await c.check(`${tc.name} ⇒ ${tc.state} / ${tc.prefix}…`, () => {
    const r = compute(tc.status);
    assert.equal(r.state, tc.state, `状态应为 ${tc.state}，实际 ${r.state}（文案：${r.text}）`);
    assert.ok(r.text.startsWith(tc.prefix), `文案应以「${tc.prefix}」开头，实际「${r.text}」`);
    if (tc.inc) assert.ok(r.text.includes(tc.inc), `文案应含「${tc.inc}」，实际「${r.text}」`);
    rowsOut.push(`${tc.name} → ${r.state} → ${r.text}`);
    return r.text;
  });
}
console.log('\n  判定表：');
for (const line of rowsOut) console.log(`    ${line}`);

// ══ C. 顶栏与面板联动（warn 现场：连得上但回不出去）════════════════════════
c.section('C. 顶栏按钮 + 诊断面板（warn 现场）');

await c.check('refreshStatus 后按钮显示「链路异常：HTTP…」，面板默认仍收起', async () => {
  bus.status = statusOf({
    onebot: {
      httpOk: false, httpError: 'ECONNREFUSED 127.0.0.1:3002',
      dataPathState: 'zombie', dataPathReason: 'get_csrf_token failed', lastProbeAt: Date.now() - 125000
    },
    protocolManaged: { managed: true, running: false, state: 'exited' },
    orchestrator: { model: '' }
  });
  await window.refreshStatus();
  assert.ok(btn().classList.contains('is-warn'), `按钮应是 is-warn，实际 class=${btn().className}`);
  assert.ok(btnText().startsWith('链路异常：HTTP'), `按钮文案应以「链路异常：HTTP」开头，实际「${btnText()}」`);
  assert.equal(panel().hidden, true, '刷新不应自动打开面板');
  return btnText();
});

await c.check('点按钮展开面板：六段各一行，证据/动作齐全', () => {
  click(btn());
  assert.equal(panel().hidden, false, '点击后应展开');
  assert.equal(btn().getAttribute('aria-expanded'), 'true');
  const text = panelBody().textContent;
  for (const seg of ['QQ 内核', '协议端容器', 'OneBot WS', 'HTTP 数据面', '数据面自检', '模型']) {
    assert.ok(text.includes(seg), `面板缺少「${seg}」段：${text}`);
  }
  assert.equal(panelBody().querySelectorAll('.link-row').length, 6, '应有 6 行（五段链路 + 数据面自检）');
  assert.ok(text.includes('ECONNREFUSED'), 'HTTP 段应带 httpError 证据');
  assert.ok(text.includes('容器未运行'), '容器段应写明停着');
  assert.ok(text.includes('未配置'), '模型段应写明未配置');
  const acts = [...panelBody().querySelectorAll('[data-link-act]')].map((el) => el.dataset.linkAct);
  assert.ok(acts.length >= 2, `应有可执行动作，实际 ${acts.length} 个`);
  assert.ok(acts.every((t) => t === 'settings' || t === 'snowluma'), `动作目标只能是已有页签：${acts}`);
  return `${panelBody().querySelectorAll('.link-row').length} 行，动作=${acts.join('/')}`;
});

await c.check('再点按钮收起面板', () => {
  click(btn());
  assert.equal(panel().hidden, true);
  assert.equal(btn().getAttribute('aria-expanded'), 'false');
  return 'hidden=true';
});

// ══ D. err 现场：真断连才显示「链路中断」 ═══════════════════════════════════
c.section('D. 断连现场');

await c.check('connected=false ⇒ 按钮 is-err + 文案「链路中断：<diagnosis>」', async () => {
  bus.status = statusOf({
    onebot: { connected: false, everConnected: true, diagnosis: '协议端未就绪：WS 端口 3001 拒绝连接' },
    qqPortable: { running: false }, snowluma: { running: false }
  });
  await window.refreshStatus();
  assert.ok(btn().classList.contains('is-err'), `按钮应是 is-err，实际 class=${btn().className}`);
  assert.ok(btnText().startsWith('链路中断：'), `实际「${btnText()}」`);
  assert.ok(btnText().includes('WS 端口 3001'), '应把后端 diagnosis 原样带出来');
  // 既有行为不能被这次重构打破：未连接时「QQ 登录」入口露出
  assert.ok(!doc.getElementById('qq-login-chip').classList.contains('hidden'), '未连接时 QQ 登录入口应可见');
  return btnText();
});

await c.check('断连现场展开面板：OneBot WS 段为 err、HTTP 段仍按证据单独判', () => {
  click(btn());
  const body = panelBody();
  const wsRow = [...body.querySelectorAll('.link-row')].find((r) => r.textContent.includes('OneBot WS'));
  assert.ok(wsRow, '应有 OneBot WS 行');
  assert.ok(wsRow.className.includes('is-err'), `OneBot WS 行应为 is-err，实际 ${wsRow.className}`);
  assert.ok(wsRow.textContent.includes('WS 端口 3001'), wsRow.textContent);
  click(btn());
  return wsRow.textContent.trim().slice(0, 60);
});

// ══ E. 外部协议端：面板不制造「本应用没启动」的假警报 ══════════════════════
c.section('E. 外部协议端模式（protocol.mode=external）');

await c.check('external ⇒ QQ 内核/协议端容器显示「不管理 / 不可管理」，不出「未运行」红字', async () => {
  bus.status = statusOf({
    protocol: { mode: 'external' },
    snowluma: { running: null },
    qqPortable: { running: null },
    protocolManaged: { managed: false, running: null, state: '' }
  });
  await window.refreshStatus();
  click(btn());
  const text = panelBody().textContent;
  assert.ok(text.includes('由 NapCat 容器提供，本应用不管理'), `QQ 内核段应说明由外部容器提供：${text}`);
  assert.ok(text.includes('不可管理'), `协议端容器段应显示不可管理：${text}`);
  assert.ok(!text.includes('未运行（点击前往启动）'), '不得再出现本应用「未运行（点击前往启动）」的假警报');
  click(btn());
  return '外部容器证据已就位';
});

// ══ F. 引用与加载顺序：不留失效引用 ════════════════════════════════════════
c.section('F. 引用清干净 / 样式加载顺序');

await c.check('ui/app/*.js 不再引用 #onebot-dot / #onebot-label', () => {
  const dir = path.join(ROOT, 'ui', 'app');
  const hits = [];
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    if (src.includes("'#onebot-dot'") || src.includes("'#onebot-label'") || src.includes('"#onebot-label"') || src.includes('"#onebot-dot"')) {
      hits.push(file);
    }
  }
  assert.deepEqual(hits, [], `仍有文件引用旧 id：${hits.join(', ')}`);
  return '无残留引用';
});

await c.check('shell.css 在 style.css 之后加载（token 已就绪，组件规则可覆盖）', () => {
  const iStyle = HTML.indexOf('href="./style.css"');
  const iShell = HTML.indexOf('href="./shell.css"');
  assert.ok(iStyle > 0, 'index.html 应引用 style.css');
  assert.ok(iShell > iStyle, 'shell.css 必须排在 style.css 之后');
  return `style.css@${iStyle} < shell.css@${iShell}`;
});

await c.check('窄屏规则：<1100px 隐藏 search，保留 model + usage', () => {
  const css = fs.readFileSync(path.join(ROOT, 'ui', 'shell.css'), 'utf8');
  assert.ok(/@media\s*\(max-width:\s*1100px\)/.test(css), 'shell.css 应有 1100px 断点');
  assert.ok(/#search-count-label\s*\{\s*display:\s*none/.test(css), '该断点内应隐藏 #search-count-label');
  assert.ok(HTML.includes('id="model-label"') && HTML.includes('id="usage-label"'), 'model/usage 芯片仍在');
  return '1100px 断点收敛为 model + usage';
});

c.finish();
// jsdom 的定时器不会自己停，显式退出让退出码可靠
process.exit(c.results.fail.length ? 1 : 0);
