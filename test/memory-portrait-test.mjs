// 记忆画像 v1 自测（override 修复 / dim+origin 归因 / 画像渲染上限 / 内心戏口令）
//
// 覆盖任务 task-12 的验收口径：
//   ① override 分支必须含【轻量记忆】（安全规则/工具协议仍在）—— 两个分支同套断言；
//   ② 画像段上限：9 人长画像渲染 ≤420 字符、最多 3 人、每人 ≤120 字；
//   ③ 段内无时间戳（会让提示词锚点每轮 reset）；
//   ④ 无画像时不注入空段/空标题；
//   ⑤ 旧数据（无 dim/origin）照常渲染；写入后 origin 默认值正确（model/consolidate）。
//
// ⚠️ 数据目录隔离：必须在 import src/* 之前设置（config.js 模块求值时定死 DATA_DIR）。
//
// 负向对照怎么跑（不写进本文件，见任务输出里的三条前后对比）：
//   把实现临时改坏（还原 override 修复 / 去掉 420 上限 / 往渲染里塞时间戳）后
//   运行本测试，对应断言必须失败（EXIT=1）；恢复实现后 EXIT=0。
//
// 运行：node test/memory-portrait-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-portrait-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildSystemPrompt, buildUserPrompt } = await import('../src/prompt.js');

let pass = 0;
let fail = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    results.push(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

// ── 测试配置 ──
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '覆盖Bot';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.persona.participation = 'medium';
cfg.persona.systemPromptOverride = '';
cfg.persona.customRules = '';
cfg.sticker.enabled = false;
cfg.store.contextTier = 4;
cfg.store.historyCount = 20;
cfg.store.promptAnchor = { enabled: false, maxExtraRead: 0 };
cfg.participationMode = 'probability';
setRuntimeConfig(cfg);

const OVERRIDE_PERSONA = {
  ...cfg.persona,
  systemPromptOverride: '# 自定义人设（建议式）\n你是群友，说话随意。'
};

// ═══ ① override 分支必须含机制段（与默认分支同套断言）═══
function assertMechanismSections(prompt, where) {
  assert.ok(prompt.includes('【安全规则'), `${where} 缺少【安全规则】`);
  assert.ok(prompt.includes('【工作方式'), `${where} 缺少【工作方式】`);
  assert.ok(prompt.includes('【轻量记忆'), `${where} 缺少【轻量记忆】机制段`);
  const sec = prompt.indexOf('【安全规则');
  const tool = prompt.indexOf('【工作方式');
  const mem = prompt.indexOf('【轻量记忆');
  assert.ok(mem > tool && tool > sec, `${where} 机制段顺序应为 安全规则 < 工作方式 < 轻量记忆（实际 ${sec}/${tool}/${mem}）`);
  assert.equal(prompt.split('【轻量记忆').length - 1, 1, `${where} 【轻量记忆】不应重复出现`);
}

await check('① override 分支含【轻量记忆】，安全规则/工具协议仍在', () => {
  const sys = buildSystemPrompt({ persona: OVERRIDE_PERSONA });
  assert.ok(sys.includes('自定义人设'), 'override 内容应生效');
  assertMechanismSections(sys, 'override 分支');
});

await check('① 默认分支含同一套机制段（两分支同套断言）', () => {
  const sys = buildSystemPrompt({ persona: { ...cfg.persona, systemPromptOverride: '' } });
  assertMechanismSections(sys, '默认分支');
});

// ═══ ② 画像渲染上限：9 人长画像 ≤420 字符、≤3 人、每人 ≤120 字 ═══
const portraitStore = new MemoryStore();
const PORTRAIT_CHAT = 'group:9001';
const longText = '很长的画像描述'.repeat(20);          // 150 字/条，专门压上限
const dims = ['personality', 'tone', 'values', 'redline', 'relation'];
const memberIds = [];
for (let i = 1; i <= 9; i += 1) {
  const uid = String(9000 + i);
  memberIds.push(uid);
  // 名字故意拉长（20 字量级）：3 行 120 字内容 + 长名字会超过 420，专门压整段上限
  const longName = `成员${i}号${'·'.repeat(20)}`;
  for (const dim of dims) {
    portraitStore.append(PORTRAIT_CHAT, 'memberImpression', `${dim}-${longText}`, {
      userId: uid,
      target: longName,
      dim
    });
  }
}
const portrait = portraitStore.formatForPrompt(PORTRAIT_CHAT, { userIds: memberIds });
const portraitLines = portrait.split('\n').filter((line) => line.startsWith('- '));

await check('② 9 人长画像：整段 ≤420 字符', () => {
  assert.ok(portrait.length > 0, '应有画像输出');
  assert.ok(portrait.length <= 420, `画像段 ${portrait.length} 字符 > 420`);
});

await check('② 9 人长画像：最多 3 人（行数 ≤3）', () => {
  assert.ok(portraitLines.length >= 1 && portraitLines.length <= 3, `画像段包含 ${portraitLines.length} 人（应 1~3）`);
});

await check('② 每人内容 ≤120 字', () => {
  for (const line of portraitLines) {
    const idx = line.indexOf('：');
    assert.ok(idx > 0, `画像行缺少「：」分隔：${line.slice(0, 20)}`);
    const content = line.slice(idx + 1);
    assert.ok(content.length <= 120, `单人画像 ${content.length} 字 > 120`);
  }
});

await check('② 选取按 userIds 优先级：第 4 人应被上限挤出', () => {
  const prStore = new MemoryStore();
  const prChat = 'group:9101';
  const prIds = ['aaaa', 'bbbb', 'cccc', 'dddd'];
  for (let i = 0; i < prIds.length; i += 1) {
    prStore.append(prChat, 'memberImpression', `画像内容${i}`, { userId: prIds[i], target: `成员${i}`, dim: 'tone' });
  }
  // 优先级：dddd(成员3) > cccc(成员2) > bbbb(成员1) > aaaa(成员0)
  const pr = prStore.formatForPrompt(prChat, { userIds: ['dddd', 'cccc', 'bbbb', 'aaaa'] });
  assert.ok(pr.includes('成员3'), '优先级第 1 的成员应进入画像');
  assert.ok(!pr.includes('成员0'), '优先级最低（第 4）的成员应被 3 人上限挤出');
});

// ═══ ③ 段内无时间戳（会破坏锚点前缀）═══
const TS_PATTERNS = [/\d{4}-\d{2}-\d{2}/, /\d{1,2}:\d{2}(:\d{2})?/, /\d{4}年\d{1,2}月\d{1,2}日/];
await check('③ 画像段内无时间戳（日期/HH:MM）', () => {
  for (const re of TS_PATTERNS) {
    assert.ok(!re.test(portrait), `画像段含时间戳（匹配 ${re}）`);
  }
});

// ═══ ④ 无画像不注空段 ═══
const emptyMemory = new MemoryStore();
const store = new ChatStore(0);
store.appendIncoming('group:7001', {
  mid: 1, ts: Date.now() - 5000, senderId: '7001', senderName: '甲', text: '在吗'
});
const triggerEntries = store.drainUnread('group:7001');
const baseCtx = {
  chatKey: 'group:7001', kind: 'group', chatId: '7001', chatName: '测试群',
  triggerEntries, store, stickerEntries: [],
  selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false
};
const emptyPrompt = buildUserPrompt({ ...baseCtx, memory: emptyMemory });

await check('④ 无画像：formatForPrompt 返回空串', () => {
  assert.equal(emptyMemory.formatForPrompt('group:7001', { userIds: ['7001'] }), '');
});

await check('④ 无画像：用户提示不注入【记忆】空段/空标题', () => {
  assert.ok(!emptyPrompt.includes('【记忆】'), '没有画像时不应出现【记忆】段');
  assert.ok(!emptyPrompt.includes('【对群友的印象】'), '没有画像时不应出现画像标题');
});

// ═══ ⑤ 旧数据兼容 + origin 默认值 ═══
await check('⑤ 旧数据（无 dim/origin）按 fact/consolidate 兜底并可渲染', () => {
  const chatKey = 'group:1';
  const dir = path.join(__testDataDir, 'memory', 'group_1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '12345.json'), JSON.stringify({
    userId: '12345',
    name: '旧人',
    impressions: [{ content: '旧版本写下的印象', createdAt: 1700000000000 }],
    updatedAt: 1700000000000,
    lastConsolidatedAt: 0
  }), 'utf8');
  const mem = new MemoryStore();
  const member = mem.getMember(chatKey, '12345');
  assert.equal(member.impressions.length, 1);
  assert.equal(member.impressions[0].origin, 'consolidate', '旧数据 origin 缺省应为 consolidate（不冒充模型写入）');
  assert.equal(member.impressions[0].dim, 'fact', '旧数据 dim 缺省应为 fact');
  const rendered = mem.formatForPrompt(chatKey, { userIds: ['12345'] });
  assert.ok(rendered.includes('旧版本写下的印象'), '旧数据仍应能渲染进画像');
});

await check('⑤ append 写入 origin=model，且支持可选 dim', () => {
  const chatKey = 'group:2';
  const mem = new MemoryStore();
  mem.append(chatKey, 'memberImpression', '他怕被叫老师', { userId: '777', target: '甲', dim: 'redline' });
  const got = mem.getMember(chatKey, '777');
  assert.equal(got.impressions.length, 1);
  assert.equal(got.impressions[0].origin, 'model');
  assert.equal(got.impressions[0].dim, 'redline');
});

await check('⑤ replaceMember 写入 origin=consolidate', () => {
  const chatKey = 'group:3';
  const mem = new MemoryStore();
  mem.replaceMember(chatKey, '888', '乙', ['整理后的画像']);
  const got = mem.getMember(chatKey, '888');
  assert.equal(got.impressions[0].origin, 'consolidate');
  assert.equal(got.impressions[0].dim, 'fact');
});

await check('⑤ replaceConsolidated 写入 origin=consolidate 且保留结构化 dim', () => {
  const chatKey = 'group:4';
  const mem = new MemoryStore();
  mem.replaceConsolidated(chatKey, {
    memberImpression: [
      { userId: '999', target: '丙', content: '说话很急' },
      { userId: '999', target: '丙', content: '怕冷场', dim: 'tone' }
    ]
  });
  const got = mem.getMember(chatKey, '999');
  assert.equal(got.impressions.length, 2);
  assert.ok(got.impressions.every((e) => e.origin === 'consolidate'));
  const tone = got.impressions.find((e) => e.content === '怕冷场');
  assert.equal(tone.dim, 'tone');
});

// ═══ 画像进入用户提示 + 内心戏口令（不改 [[PASS]] 协议）═══
const vividStore = new ChatStore(0);
vividStore.appendIncoming('group:8001', {
  mid: 10, ts: Date.now() - 6000, senderId: '8001', senderName: '甲', text: '这游戏真好玩'
});
const vividTriggers = vividStore.drainUnread('group:8001');
const vividMemory = new MemoryStore();
vividMemory.append('group:8001', 'memberImpression', '爱玩梗', { userId: '8001', target: '甲', dim: 'tone' });
const vividPrompt = buildUserPrompt({
  chatKey: 'group:8001', kind: 'group', chatId: '8001', chatName: '测试群',
  triggerEntries: vividTriggers, store: vividStore, memory: vividMemory, stickerEntries: [],
  selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false
});

await check('画像进入用户提示【记忆】段，且带内心戏口令', () => {
  assert.ok(vividPrompt.includes('【记忆】\n'), '应有【记忆】段');
  assert.ok(vividPrompt.includes('【对群友的印象】'), '应有画像标题');
  assert.ok(vividPrompt.includes('开口前先在心里判断'), '应有内心戏口令');
  assert.ok(vividPrompt.includes('判断留在心里'), '口令必须要求不出声（不要求正文输出）');
});

await check('内心戏口令不含协议标记、不影响 [[PASS]] 与发送路径', () => {
  assert.ok(!vividPrompt.includes('[[PASS]]'), '内心戏口令不应携带或改写 PASS 标记');
  assert.ok(!/send_message/.test(vividPrompt.slice(vividPrompt.indexOf('开口前先在心里判断'))), '禁止要求正文/发送动作');
});

// ═══ 收尾 ═══
try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(results.join('\n'));
if (fail === 0) {
  console.log(`\n全部通过 —— 通过 ${pass} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail}`);
process.exit(1);
