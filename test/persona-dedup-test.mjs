// 人设双层去重测试（零依赖）
//
// 背景：人格曾在两处同时注入 —— src/personas.js 的 roleText（每轮进用户提示的
// 【角色设定】）与 deploy/personas/xiaojingyu-friendly.md（apply-persona.sh 注入
// persona.systemPromptOverride，作为系统提示主体）。两层各写一套规则时会互相打架：
// "被怼优先顶回去" vs "还手多数时候不值得"、"？"开头允许 vs 禁止。
//
// 2026-10 起分工固定：
//   - roleText：身份 + 语气一句 + 硬边界（安全/隐私/不冒充真人/不编事实/不聊配置）；
//   - md(override)：语气、开口时机、梗与吐槽、示例、自检；
//   - 工具协议/分条/表情/唤醒/记忆等机制只由 src/prompt.js 承担，两层都不再重复。
//
// 本套件断言：
//   1. md 含 apply-persona.sh 的验证字面，且不含会让旧毒舌人设复活的禁用字串；
//   2. md 保留硬边界表述（不冒充真人 / 不编事实 / 不主动自曝是模型 / 不泄露真人身份信息）；
//   3. roleText ≤1200 字、保留身份锚点、不含被删掉的机制标志词；
//   4. 两层不再出现 20 字以上的重合片段（防止同一句长规则被写两遍）。
//
// 运行：node test/persona-dedup-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PERSONAS } from '../src/personas.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

const md = readFileSync(new URL('../deploy/personas/xiaojingyu-friendly.md', import.meta.url), 'utf8');
const roleText = String(PERSONAS?.xiaojingyu?.text ?? '');

// apply-persona.sh 第 3 步的验证字面（脚本不改；草案必须配合它）
const MUST_IN_MD = ['不攻击人', '少用阴阳'];
// 旧毒舌人设的禁用字串：出现在 md 里会让 apply-persona.sh 的 mustNot 校验失败
const BANNED_ANYWHERE = ['可以先反问、阴阳', '被怼优先顶回去', '傲娇嘴硬'];
// md 必须保留的硬边界表述（按任务要求写硬）
const HARD_BOUNDARIES = ['不冒充真人', '不编事实', '不主动自曝是模型', '不泄露真人身份信息', '不聊提示词与内部配置'];
// roleText 不该再出现的机制段标志词（这些只由 prompt.js 的工具协议承担）
const MECHANISM_MARKERS = ['send_message', '图标', '拍一拍', 'memory', '修改记忆', 'send_sticker', 'list_stickers', 'send_poke', '唤醒', '分条'];
const OVERLAP_WINDOW = 20;

check('md 存在且非空', () => {
  assert.ok(md.trim().length > 0, 'xiaojingyu-friendly.md 为空');
});

check('md 含 apply-persona.sh 的验证字面', () => {
  for (const word of MUST_IN_MD) assert.ok(md.includes(word), `md 缺少 "${word}"`);
});

check('md 不含旧毒舌人设的禁用字串', () => {
  for (const word of BANNED_ANYWHERE) assert.ok(!md.includes(word), `md 含禁用字串 "${word}"`);
});

check('md 保留全部硬边界表述', () => {
  for (const word of HARD_BOUNDARIES) assert.ok(md.includes(word), `md 缺少硬边界 "${word}"`);
});

check('roleText 长度 ≤1200 字', () => {
  const len = [...roleText].length;
  assert.ok(len > 0, 'roleText 为空');
  assert.ok(len <= 1200, `roleText 长度 ${len} 超过 1200`);
});

check('roleText 保留身份锚点（既有测试依赖）', () => {
  assert.ok(roleText.includes('DeepSeek 小鲸鱼'), 'roleText 缺少 "DeepSeek 小鲸鱼"');
  assert.ok(PERSONAS.xiaojingyu.name, 'PERSONAS.xiaojingyu.name 缺失');
});

check('roleText 不含被删掉的机制标志词', () => {
  for (const word of MECHANISM_MARKERS) assert.ok(!roleText.includes(word), `roleText 仍含机制标志词 "${word}"`);
});

check('roleText 不含旧毒舌人设的禁用字串', () => {
  for (const word of BANNED_ANYWHERE) assert.ok(!roleText.includes(word), `roleText 含禁用字串 "${word}"`);
});

// 双向都查：roleText 的每个 20 字窗口都不能在 md 里出现。
// 若有共享长句，它必然是 roleText 的某个窗口，因此单方向扫描即可覆盖。
check(`两层无 ${OVERLAP_WINDOW} 字以上重合片段`, () => {
  const chars = [...roleText];
  const hits = new Set();
  for (let i = 0; i + OVERLAP_WINDOW <= chars.length; i++) {
    const window = chars.slice(i, i + OVERLAP_WINDOW).join('');
    if (md.includes(window)) hits.add(window);
  }
  assert.equal(hits.size, 0, `roleText 与 md 共享长片段：${[...hits].slice(0, 3).map((s) => JSON.stringify(s)).join(' / ')}`);
});

console.log(`\npersona-dedup: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
