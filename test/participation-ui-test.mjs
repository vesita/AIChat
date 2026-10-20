// 控制台「参与策略」静态守卫（零依赖：只读文件做断言）。
//
// 为什么用静态断言：这一块是"选择驱动"的 UI —— 三个模式卡片 + 各自参数区 +
// 两个全局卡片，任何一处漏接都会表现成"界面能点、保存没生效"或"选项互斥错乱"，
// 而启动整个 DOM 去点选成本高。这里钉住四件事：
//   ① 侧栏有「参与策略」，渲染函数存在且三种模式 id 齐全；
//   ② 各模式参数区 / 安全上限 / 上下文预算的输入框 id 都在；
//   ③ 保存链路（saveConfig participation 分支）把 participationMode / aiJudge / limits /
//      historyCount 一起写进 patch，且 ai 模式同步 enabled；
//   ④ 模式切换只显示选中项 + 样式存在。
//
// 运行：node test/participation-ui-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

const render06 = read('ui/app/06-settings-render.js');
const events07 = read('ui/app/07-settings-events.js');
const modals08 = read('ui/app/08-modals.js');
const css = read('ui/style.css');

// ── ① 侧栏 + 渲染函数 + 三种模式 ────────────────────────────────────────
check('侧栏有「参与策略」并指向 participation 区块', () => {
  assert.ok(/\[\s*'participation'\s*,\s*'参与策略'\s*\]/.test(render06), '侧栏菜单缺少 participation 项');
  assert.ok(/participation:\s*\(\)\s*=>\s*renderParticipationSection\(c\)/.test(render06), 'sections 映射缺少 participation');
});

check('渲染函数存在且三种模式齐全（probability / ai / directed）', () => {
  assert.ok(render06.includes('function renderParticipationSection(c)'), '缺少 renderParticipationSection');
  for (const mode of ['probability', 'ai', 'directed']) {
    assert.ok(render06.includes(`'${mode}'`), `缺少模式 ${mode}`);
  }
  assert.ok(render06.includes('AI 自动判断'), '缺少 AI 模式文案');
  assert.ok(render06.includes('仅定向'), '缺少仅定向模式文案');
  assert.ok(render06.includes('name="pmode"'), '模式卡片缺少单选 name="pmode"');
});

// ── ② 参数区输入框 ──────────────────────────────────────────────────────
check('AI 模式参数：minGapSec 输入 + 折叠的 passMarker', () => {
  assert.ok(render06.includes('id="aj-mingap"'), '缺少 minGapSec 输入（#aj-mingap）');
  assert.ok(render06.includes('id="aj-marker"'), '缺少 passMarker 输入（#aj-marker）');
  assert.ok(/<details[^>]*class="pm-adv"/.test(render06), 'passMarker 应放在折叠区（details.pm-adv）');
});

check('仅定向参数：关键词编辑（写 store.keywords）；固定概率复用滑条编辑器', () => {
  assert.ok(render06.includes('id="pm-keywords"'), '缺少关键词编辑框（#pm-keywords）');
  assert.ok(render06.includes('data-pmode="directed"'), '缺少仅定向参数区');
  assert.ok(render06.includes('id="ac-editor"'), '固定概率模式应复用 #ac-editor 滑条编辑器');
  assert.ok(render06.includes('data-pmode="probability"'), '缺少固定概率参数区');
});

check('全局卡片：安全上限（limits）与上下文预算（historyCount）字段在位', () => {
  assert.ok(render06.includes('id="lim-maxperhour"'), '缺少每小时上限输入（#lim-maxperhour）');
  assert.ok(render06.includes('id="pm-historycount"'), '缺少已读历史条数输入（#pm-historycount）');
  assert.ok(render06.includes('滚动 1 小时') || render06.includes('滚动 1 小时'), '安全上限应说明滚动窗口语义');
  assert.ok(render06.includes('80–500'), '上下文预算应说明 80–500 范围');
});

// ── ③ 保存链路 ─────────────────────────────────────────────────────────
check('saveConfig 有 participation 分支：写 participationMode / aiJudge / limits / historyCount', () => {
  assert.ok(/if\s*\(\s*sec\s*===\s*'participation'\s*\)/.test(modals08), 'saveConfig 缺少 participation 分支');
  const branch = modals08.slice(
    modals08.indexOf("if (sec === 'participation')"),
    modals08.indexOf("// ── POST 之前的最后防线")
  );
  assert.ok(branch.length > 0, '未找到 participation 分支源码');
  for (const key of ['participationMode', 'aiJudge', 'limits', 'historyCount']) {
    assert.ok(branch.includes(key), `保存 patch 缺少 ${key}`);
  }
  assert.ok(/enabled:\s*mode\s*===\s*'ai'/.test(branch), 'AI 模式必须同步 aiJudge.enabled=true，其它模式 false');
  assert.ok(branch.includes("'#lim-maxperhour'"), '安全上限应读 #lim-maxperhour');
  assert.ok(branch.includes("'#pm-historycount'"), '上下文预算应读 #pm-historycount');
  assert.ok(branch.includes("'#pm-keywords'"), '仅定向模式应收集关键词');
});

check('模式切换由 07 绑定：只显示选中模式的参数区', () => {
  assert.ok(events07.includes('input[name="pmode"]'), '07 未绑定模式单选');
  assert.ok(events07.includes('.pmode-card'), '缺少模式卡片高亮同步');
  assert.ok(events07.includes('.pmode-body'), '缺少参数区显隐同步');
  assert.ok(/el\.hidden\s*=\s*el\.dataset\.pmode\s*!==\s*mode/.test(events07), '参数区应按 data-pmode 显隐');
});

// ── ④ 样式 ─────────────────────────────────────────────────────────────
check('样式存在且不依赖内联脚本/内联样式（CSP 前提下由 style.css 承担）', () => {
  for (const sel of ['.pmode-grid', '.pmode-card', '.pmode-body', '.pmode-body[hidden]']) {
    assert.ok(css.includes(sel), `style.css 缺少 ${sel}`);
  }
  // 参与策略自己的渲染函数里不应出现内联事件处理器（onclick= 等），CSP 会拦；
  // 只截到下一个函数（其它区块的既有写法不在本测试范围内）。
  const start = render06.indexOf('function renderParticipationSection');
  const end = render06.indexOf('function renderChatSection');
  const sectionSrc = render06.slice(start, end);
  assert.ok(start >= 0 && end > start, '定位参与策略渲染函数失败');
  assert.ok(!/on(click|change|input)\s*=/.test(sectionSrc), '参与策略渲染不应使用内联事件处理器');
});

if (fail === 0) {
  console.log(`\n全部通过 —— 通过 ${pass} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail}`);
process.exit(1);
