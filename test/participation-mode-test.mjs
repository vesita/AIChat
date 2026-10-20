// 参与策略（probability / ai / directed）与 AI 判定守则的回归。
//
// 覆盖：
//   1. 老配置（无 participationMode）默认 probability —— 判定与改动前逐字节一致；
//   2. ai 模式：群聊非定向 → 「AI 判定」；@/拍一拍/私聊仍走原语义（定向必回）；
//      关键词不再单独触发（交给模型判断）；
//   3. directed 模式：只认 @/拍一拍/关键词/私聊，不看滑条、无随机；
//   4. 配置白名单与数值收敛（非法模式回落 probability、上限 -5→0/非法→2000、
//      marker 空→[[PASS]]、minGapSec 钳制）；
//   5. AI 模式自动注入系统提示守则段（含可配置 marker），非 AI 模式不注入。
//
// 运行：node test/participation-mode-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-participation-'));

const {
  DEFAULT_CONFIG, setRuntimeConfig, updateConfig, isAiJudgeMode, aiJudgePassMarker, normalizeParticipationMode
} = await import('../src/config.js');
const { resolveContextTier, buildSystemPrompt } = await import('../src/prompt.js');

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

const baseStore = () => structuredClone(DEFAULT_CONFIG.store);
const judge = (storePatch, triggerEntries, isPrivate = false) => resolveContextTier({
  triggerEntries,
  selfNickname: '小鱼',
  botName: '覆盖Bot',
  selfId: '888',
  cfg: { ...baseStore(), ...storePatch },
  isPrivate
});
const plain = [{ text: '随便聊聊今天的事', ts: 1 }];
const at = [{ text: '@覆盖Bot 在吗', atMe: true, ts: 1 }];
const poke = [{ text: '[拍一拍] 张三 拍了拍 我', isPoke: true, ts: 1 }];
const keywordMsg = [{ text: '小鲸鱼出来一下', ts: 1 }];

// ── 1. 默认 probability：与旧行为一致 ───────────────────────────────────
check('老配置（无 participationMode）：1 档普通消息不触发、@ 触发、4 档全响应', () => {
  assert.deepEqual(normalizeParticipationMode(undefined), 'probability');
  assert.equal(judge({ contextTier: 1 }, plain).reason, '未触发');
  assert.equal(judge({ contextTier: 1 }, plain).shouldRespond, false);
  assert.equal(judge({ contextTier: 1 }, at).reason, '被艾特');
  assert.equal(judge({ contextTier: 4 }, plain).reason, '全部响应');
  assert.equal(judge({ contextTier: 1 }, poke).reason, '拍了拍我');
});

check('probability：2 档关键词 / 3 档随机（roll 固定时的两支）保持原语义', () => {
  assert.equal(judge({ contextTier: 2, keywords: ['小鲸鱼'] }, keywordMsg).reason, '关键词命中');
  assert.equal(judge({ contextTier: 3, randomPercent: 0 }, plain, false).shouldRespond, false, 'randomPercent=0 时不命中');
  const r = resolveContextTier({ triggerEntries: plain, cfg: { ...baseStore(), contextTier: 3, randomPercent: 50 }, roll: 0 });
  assert.equal(r.reason, '随机命中(0%)');
  const miss = resolveContextTier({ triggerEntries: plain, cfg: { ...baseStore(), contextTier: 3, randomPercent: 50 }, roll: 99 });
  assert.equal(miss.shouldRespond, false);
});

// ── 2. ai 模式 ───────────────────────────────────────────────────────────
check('ai 模式：群聊非定向消息 → 「AI 判定」且绕过滑条概率（1 档也触发）', () => {
  const r = judge({ participationMode: 'ai', contextTier: 1 }, plain);
  assert.equal(r.shouldRespond, true, '1 档下滑条不参与判定');
  assert.equal(r.reason, 'AI 判定');
  assert.equal(r.tier, 4);
  assert.ok(r.count > 0, '应带常规已读条数');
});

check('ai 模式：@ / 拍一拍 / 私聊仍走原语义（定向必回，不受 AI 判定影响）', () => {
  assert.equal(judge({ participationMode: 'ai', contextTier: 1 }, at).reason, '被艾特');
  assert.equal(judge({ participationMode: 'ai', contextTier: 1 }, poke).reason, '拍了拍我');
  assert.equal(judge({ participationMode: 'ai', contextTier: 1 }, plain, true).reason, '私聊消息');
});

check('ai 模式：关键词不再单独触发（非定向消息统一交给模型判断）', () => {
  const r = judge({ participationMode: 'ai', contextTier: 2, keywords: ['小鲸鱼'] }, keywordMsg);
  assert.equal(r.reason, 'AI 判定');
});

// ── 3. directed 模式 ────────────────────────────────────────────────────
check('directed 模式：4 档普通消息也不触发（无全响应/无随机）', () => {
  const r = judge({ participationMode: 'directed', contextTier: 4 }, plain);
  assert.equal(r.shouldRespond, false);
  assert.equal(r.reason, '未触发（仅定向）');
});

check('directed 模式：@ / 拍一拍 / 关键词 / 私聊照常触发', () => {
  assert.equal(judge({ participationMode: 'directed' }, at).reason, '被艾特');
  assert.equal(judge({ participationMode: 'directed' }, poke).reason, '拍了拍我');
  assert.equal(judge({ participationMode: 'directed', keywords: ['小鲸鱼'] }, keywordMsg).reason, '关键词命中');
  assert.equal(judge({ participationMode: 'directed' }, plain, true).reason, '私聊消息');
});

// ── 4. 配置白名单与数值收敛 ─────────────────────────────────────────────
check('配置白名单：非法 participationMode 回落 probability；数值字段钳制', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  updateConfig({ store: { participationMode: 'weird-mode' } });
  assert.equal(updateConfig({}).store.participationMode, 'probability');

  updateConfig({ store: { participationMode: 'ai' } });
  assert.equal(updateConfig({}).store.participationMode, 'ai');

  updateConfig({ store: { limits: { maxMessagesPerHour: -5 } } });
  assert.equal(updateConfig({}).store.limits.maxMessagesPerHour, 0, '负数钳到 0（= 不限）');
  updateConfig({ store: { limits: { maxMessagesPerHour: 'abc' } } });
  assert.equal(updateConfig({}).store.limits.maxMessagesPerHour, 2000, '非法值回落默认 2000');

  updateConfig({ store: { aiJudge: { enabled: 'yes', passMarker: '   ', minGapSec: -3 } } });
  const ai = updateConfig({}).store.aiJudge;
  assert.equal(ai.enabled, false, 'enabled 只认严格 true');
  assert.equal(ai.passMarker, '[[PASS]]', '空 marker 回落默认');
  assert.equal(ai.minGapSec, 0, '负数钳到 0');
});

check('isAiJudgeMode / aiJudgePassMarker：两处来源与自定义 marker', () => {
  assert.equal(isAiJudgeMode({ participationMode: 'probability', aiJudge: { enabled: false } }), false);
  assert.equal(isAiJudgeMode({ participationMode: 'ai', aiJudge: { enabled: false } }), true, '模式即开启');
  assert.equal(isAiJudgeMode({ participationMode: 'probability', aiJudge: { enabled: true } }), true, '单独开关也认');
  assert.equal(aiJudgePassMarker({ aiJudge: { passMarker: '[不接]' } }), '[不接]');
  assert.equal(aiJudgePassMarker({}), '[[PASS]]');
});

// ── 5. 系统提示：AI 守则段 ──────────────────────────────────────────────
const persona = { botName: '覆盖Bot', selfNickname: '小鱼', roleText: '你是群友。', participation: 'medium', customRules: '' };
function promptWith(storePatch, personaPatch = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.store = { ...cfg.store, ...storePatch };
  cfg.persona = { ...cfg.persona, ...persona };
  setRuntimeConfig(cfg);
  return buildSystemPrompt({ persona: { ...persona, ...personaPatch }, skillContext: {} });
}

check('非 AI 模式不注入守则段；ai 模式注入（含默认 marker）', () => {
  assert.ok(!promptWith({ participationMode: 'probability', aiJudge: { enabled: false } }).includes('【群聊参与守则（自动判断）】'));
  assert.ok(!promptWith({ participationMode: 'directed' }).includes('【群聊参与守则（自动判断）】'));
  const p = promptWith({ participationMode: 'ai', aiJudge: { enabled: true, passMarker: '[[PASS]]', minGapSec: 0 } });
  assert.ok(p.includes('【群聊参与守则（自动判断）】'), 'AI 模式应注入守则');
  assert.ok(p.includes('只输出 [[PASS]]'), '守则应包含约定标记');
  assert.ok(p.includes('必须回应'), '守则应包含定向必回要求');
});

check('自定义 marker 会同步进系统提示（改配置即两处生效）', () => {
  const p = promptWith({ participationMode: 'ai', aiJudge: { enabled: true, passMarker: '[不接]', minGapSec: 0 } });
  assert.ok(p.includes('只输出 [不接]'), '提示词应使用配置里的 marker');
  assert.ok(!p.includes('只输出 [[PASS]]'), '不该再出现默认 marker');
});

check('systemPromptOverride（高级覆盖）路径同样注入守则，且不覆盖安全规则', () => {
  const p = promptWith(
    { participationMode: 'ai', aiJudge: { enabled: true, passMarker: '[[PASS]]', minGapSec: 0 } },
    { systemPromptOverride: '自定义人设：{botName}' }
  );
  assert.ok(p.includes('自定义人设：覆盖Bot'), '覆盖内容应生效');
  assert.ok(p.includes('【群聊参与守则（自动判断）】'), '覆盖模式下也要注入守则');
  assert.ok(p.includes('【安全规则'), '安全规则仍保留');
});

if (fail === 0) {
  console.log(`\n全部通过 —— 通过 ${pass} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail}`);
process.exit(1);
