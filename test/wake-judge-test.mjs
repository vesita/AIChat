// 触发判定扩展点（reply.interest-judge）回归。
//
// 覆盖（对应 task 契约）：
//   1. 无提供者时决策与现状一致（1 档普通消息不触发、4 档必触发）；
//   2. 假提供者双向覆盖：base=false → 接话；base=true → 不接；
//   3. 返回非法 / 抛错 / 超时（>300ms）→ 回退核心判定（fail-open）；
//   4. 私聊、被艾特不咨询插件（核心直接召唤，插件不能吃掉）；
//   5. 插件给的 reason 写进会话的 contextReason；
//   6. smart-wake 插件启发式：该接的接、spam 不接、冷却/上限生效、关闭后等价无提供者。
//
// 运行：node test/wake-judge-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据目录隔离必须在 import src 之前（config.js 在模块求值时读它）
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-wake-judge-'));

const { bootApp, sleep, waitFor } = await import('./_harness.mjs');

const pass = [];
const fail = [];
async function check(name, fn) {
  try {
    await fn();
    pass.push(name);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail.push(name);
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

const env = await bootApp({
  config: { store: { contextSliderPos: 0, historyCount: 80 }, wakeDelayMs: 250 }
});
// ⚠️ src 模块必须在 bootApp 之后 import：config.js 在模块求值时捕获 DATA_DIR，
//    提前 import 会让它指向 bootApp 之前的数据目录（OneBot 连接会因此超时）。
const { skillManager } = await import('../src/skills/manager.js');
const { normalizeManifest } = await import('../src/skills/manifest.js');
const { setSkillEnabled } = await import('../src/skills/config.js');
const { app, request, llm, onebotWs } = env;
const llmCount = () => llm.state.requests.length;
const settle = async () => { await sleep(600); };
const setTier = (pos) => request('POST', '/api/config', { body: { store: { contextSliderPos: pos, historyCount: 80 } } });
const pushPrivate = (userId, text, mid) => onebotWs.push({
  post_type: 'message', message_type: 'private', user_id: userId, self_id: 888,
  message_id: mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: userId, nickname: '私聊对象' },
  message: [{ type: 'text', data: { text } }]
});
const lastSession = () => {
  const list = app.sessions.listSummaries(50);
  return list.length ? app.sessions.get(list[0].id) : null;
};

/** 注册一个假判定插件（测试用；走真实能力注册链路）。 */
function addJudge(id, fn) {
  const { manifest } = normalizeManifest({ id, name: id, capabilities: ['reply.interest-judge'], enabledByDefault: true });
  const r = skillManager.register({
    manifest,
    source: 'test',
    dir: path.join(os.tmpdir(), id),
    api: null,
    toolIds: [],
    available: null,
    availableReason: '',
    activate: null,
    deactivate: null,
    dispose: () => {},
    hooks: {},
    providers: { 'reply.interest-judge': fn },
    promptSections: null
  });
  assert.ok(r.ok, `注册假判定插件失败：${r.error || ''}`);
}
const removeJudge = (id) => { try { skillManager.unregister(id); } catch { /* ignore */ } };

// 先关掉自带 smart-wake：它的默认 enabled=false 只是"不干预"，但测试里我们要
// 控制"到底有没有提供者"，所以显式关掉，假提供者才成为唯一提供者。
setSkillEnabled('smart-wake', false);

// ── 1. 无提供者：决策与现状一致 ──────────────────────────────────────────
await check('无提供者：1 档普通消息不触发（不建会话、不调 LLM、消息立即已读）', async () => {
  const before = llmCount();
  env.pushGroupMsg(111, '张三', '闲聊一句不吃鱼', 7001);
  await sleep(120);
  assert.equal(app.store.getChatMeta('group:456').unread, 0, '普通消息应立即标已读');
  assert.equal(llmCount(), before, '不应产生 LLM 调用');
});

await check('无提供者：4 档消息必触发，contextReason 记录核心判定', async () => {
  await setTier(100);
  const before = llmCount();
  env.pushGroupMsg(111, '张三', '随便说点什么吧', 7002);
  await waitFor(() => llmCount() > before, 5000, '4 档必触发');
  await waitFor(() => { const s = lastSession(); return s && s.contextReason; }, 5000, '会话写入 contextReason');
  assert.match(String(lastSession().contextReason), /全部响应/, `contextReason 应含核心判定，实际 ${lastSession().contextReason}`);
});
await settle();

// ── 2. 假提供者双向覆盖 ──────────────────────────────────────────────────
await check('插件否决：base=true → 不接话（不建会话、消息已读）', async () => {
  addJudge('judge-veto', () => ({ respond: false, reason: '插件说这次别接' }));
  try {
    const before = llmCount();
    env.pushGroupMsg(111, '张三', '这条会被插件否掉', 7003);
    await sleep(600);   // wakeDelayMs 250 + 判定余量
    assert.equal(llmCount(), before, '插件否决后不应产生 LLM 调用');
    assert.equal(app.store.getChatMeta('group:456').unread, 0, '被否决的消息应标已读');
  } finally { removeJudge('judge-veto'); }
});

await check('插件接话：base=false → 接话，reason 写进 contextReason，已读条数补成配置值', async () => {
  await setTier(0);
  addJudge('judge-accept', () => ({ respond: true, reason: '插件要接这句话' }));
  try {
    const before = llmCount();
    env.pushGroupMsg(111, '张三', '1 档下不会被核心触发的一句', 7004);
    await waitFor(() => llmCount() > before, 5000, '插件接话后应调 LLM');
    const session = await waitFor(() => {
      const s = lastSession();
      return s && s.contextReason ? s : null;
    }, 5000, '会话 contextReason');
    assert.equal(session.contextReason, '插件要接这句话', `reason 应写进 contextReason，实际 ${session.contextReason}`);
    assert.equal(session.contextLimit, 80, `补的已读条数应为 historyCount=80，实际 ${session.contextLimit}`);
  } finally { removeJudge('judge-accept'); }
});
await settle();

// ── 3. 非法返回 / 抛错 / 超时 → 回退 base ────────────────────────────────
await check('插件返回非法（undefined / respond 非布尔）→ 回退核心判定（4 档照常响应）', async () => {
  await setTier(100);
  addJudge('judge-invalid', () => ({ respond: 'yes' }));
  try {
    const before = llmCount();
    env.pushGroupMsg(111, '张三', '非法返回也要能正常响应', 7005);
    await waitFor(() => llmCount() > before, 5000, '4 档应照常触发');
  } finally { removeJudge('judge-invalid'); }
});
await settle();

await check('插件抛错 → 回退核心判定，且错误被记录（不拖垮主流程）', async () => {
  addJudge('judge-throw', () => { throw new Error('假插件故意抛错'); });
  try {
    const before = llmCount();
    env.pushGroupMsg(111, '张三', '抛错也要能正常响应', 7006);
    await waitFor(() => llmCount() > before, 5000, '抛错时应回退 base 并照常触发');
    assert.ok(skillManager.errors.get('reply.interest-judge') || skillManager.errors.get('judge-throw'),
      '插件抛错应留下排障记录');
  } finally { removeJudge('judge-throw'); }
});
await settle();

await check('插件超时（>300ms）→ 回退核心判定，不拖住主流程', async () => {
  addJudge('judge-slow', () => new Promise(() => { /* 永不 resolve */ }));
  try {
    const before = llmCount();
    const startedAt = Date.now();
    env.pushGroupMsg(111, '张三', '超时也要能正常响应', 7007);
    await waitFor(() => llmCount() > before, 5000, '超时后应回退 base 并照常触发');
    assert.ok(Date.now() - startedAt >= 250, '确实经过了超时等待');
  } finally { removeJudge('judge-slow'); }
});
await settle();

// ── 4. 私聊 / 被艾特不咨询 ───────────────────────────────────────────────
await check('被艾特不咨询插件（核心直接召唤，插件不能吃掉）', async () => {
  await setTier(0);
  const calls = [];
  addJudge('judge-at', (info) => { calls.push(info.base?.reason); return { respond: false, reason: '不该被问到' }; });
  try {
    const before = llmCount();
    env.pushGroupMsg(111, '张三', '@覆盖Bot 在吗', 7008);
    await waitFor(() => llmCount() > before, 5000, '@ 应直接触发');
    assert.equal(calls.length, 0, `@ 消息不应咨询插件，实际咨询了 ${calls.length} 次（${calls.join('/')}）`);
  } finally { removeJudge('judge-at'); }
});
await settle();

await check('私聊不咨询插件（私聊恒响应）', async () => {
  const calls = [];
  addJudge('judge-private', (info) => { calls.push(info.chatKey); return { respond: false, reason: '不该被问到' }; });
  try {
    const before = llmCount();
    pushPrivate(777, '私聊里的一句话', 7009);
    await waitFor(() => llmCount() > before, 5000, '私聊应直接触发');
    assert.equal(calls.length, 0, `私聊不应咨询插件，实际咨询了 ${calls.length} 次`);
  } finally { removeJudge('judge-private'); }
});
await settle();

// ── 5. smart-wake 插件启发式（纯函数，直接驱动）─────────────────────────
await check('smart-wake：关闭时等价无提供者（返回 undefined = 不干预）', async () => {
  const sw = await import('../plugins/smart-wake/index.js');
  const off = { enabled: false };
  const info = {
    base: { shouldRespond: true, reason: '全部响应', tier: 4, count: 80 },
    chatKey: 'group:1', triggerEntries: [{ text: '今天天气不错', ts: 1000 }], recent: []
  };
  assert.equal(sw.evaluate(info, off, { responses: [] }, 5000), undefined, 'enabled=false 应返回 undefined');
  assert.equal(sw.handle(info, off, 5000, new Map()), undefined, 'handle 同样不干预');
});

await check('smart-wake：正常触发保持响应；纯表情 spam 被抑制', async () => {
  const sw = await import('../plugins/smart-wake/index.js');
  const on = { enabled: true, suppressSpam: true, minChars: 6, escalateThreshold: 5, cooldownSec: 90, hourlyCap: 12, dailyCap: 60, repeatWindow: 12, continuationSec: 120 };
  const normal = sw.evaluate({
    base: { shouldRespond: true, reason: '全部响应', tier: 4, count: 80 },
    chatKey: 'group:1', triggerEntries: [{ text: '今天天气不错，出去走走', ts: 1000 }], recent: []
  }, on, { responses: [] }, 5000);
  assert.equal(normal.respond, true, '非噪音应维持响应');
  const spam = sw.evaluate({
    base: { shouldRespond: true, reason: '全部响应', tier: 4, count: 80 },
    chatKey: 'group:1', triggerEntries: [{ text: '[表情][表情][图片]', ts: 1000 }], recent: []
  }, on, { responses: [] }, 5000);
  assert.equal(spam.respond, false, '纯表情应被抑制');
  assert.match(spam.reason, /纯表情/);
});

await check('smart-wake：base=false 时问句/延续对话达到阈值 → 主动接话；无信号不接', async () => {
  const sw = await import('../plugins/smart-wake/index.js');
  const on = { enabled: true, suppressSpam: true, minChars: 6, escalateThreshold: 5, cooldownSec: 90, hourlyCap: 12, dailyCap: 60, repeatWindow: 12, continuationSec: 120 };
  const now = 100_000;
  const ask = sw.evaluate({
    base: { shouldRespond: false, reason: '未触发', tier: 0, count: 0 },
    chatKey: 'group:1',
    triggerEntries: [{ text: '这个功能怎么用啊？', ts: now - 1000 }],
    recent: [{ text: '我刚才说了一个功能', ts: now - 5000, isSelf: true }]
  }, on, { responses: [] }, now);
  assert.equal(ask.respond, true, '问句 + 延续对话应达到阈值');
  const quiet = sw.evaluate({
    base: { shouldRespond: false, reason: '未触发', tier: 0, count: 0 },
    chatKey: 'group:1',
    triggerEntries: [{ text: '今天路上人不少', ts: now - 1000 }],
    recent: []
  }, on, { responses: [] }, now);
  assert.equal(quiet.respond, false, '无强信号不应主动接话');
});

await check('smart-wake：复读识别只比更早的消息（不会把自己当复读）', async () => {
  const sw = await import('../plugins/smart-wake/index.js');
  const on = { enabled: true, suppressSpam: true, minChars: 6, repeatWindow: 12 };
  const fresh = sw.detectSpam({
    triggerEntries: [{ text: '这是同一句话的内容', ts: 2000 }],
    recent: [{ text: '这是同一句话的内容', ts: 2000 }]     // 当前批自己（同 ts）不算复读
  }, on);
  assert.equal(fresh.spam, false, '当前批自己不应被判复读');
  const repeat = sw.detectSpam({
    triggerEntries: [{ text: '这是同一句话的内容', ts: 2000 }],
    recent: [{ text: '这是同一句话的内容', ts: 1000 }, { text: '这是同一句话的内容', ts: 900 }]
  }, on);
  assert.equal(repeat.spam, true, '更早的相同文本应判复读');
});

await check('smart-wake：冷却 / 小时上限生效；同批重复咨询不重复消耗预算', async () => {
  const sw = await import('../plugins/smart-wake/index.js');
  const on = { enabled: true, suppressSpam: true, minChars: 6, escalateThreshold: 5, cooldownSec: 90, hourlyCap: 12, dailyCap: 60, repeatWindow: 12, continuationSec: 120 };
  const info = {
    base: { shouldRespond: true, reason: '全部响应', tier: 4, count: 80 },
    chatKey: 'group:9', triggerEntries: [{ text: '正常的一句话内容', ts: 1000 }], recent: []
  };
  const states = new Map();
  const first = sw.handle(info, on, 10_000, states);
  assert.equal(first.respond, true, '第一次应接话');
  const again = sw.handle({ ...info, base: { ...info.base } }, on, 10_200, states);
  assert.equal(again.respond, true, '同批重复咨询应复用同一判定');
  assert.equal(states.get('group:9').responses.length, 1, '同批重复咨询不应重复消耗预算');
  const cooled = sw.handle({ ...info, triggerEntries: [{ text: '完全不同的另一句话', ts: 20_000 }] }, on, 20_000, states);
  assert.equal(cooled.respond, false, '冷却期内应否决');
  assert.match(cooled.reason, /冷却/);
  // 小时上限：构造已用满的预算（换一个新会话，避免被缓存/冷却干扰）
  const fullState = { responses: Array.from({ length: 12 }, (_, i) => 30_000 - i * 1000) };
  const capped = sw.evaluate({
    base: { shouldRespond: true, reason: '全部响应', tier: 4, count: 80 },
    chatKey: 'group:10', triggerEntries: [{ text: '正常的一句话内容', ts: 1000 }], recent: []
  }, { ...on, cooldownSec: 0 }, fullState, 30_000);
  assert.equal(capped.respond, false, '小时上限用满后应否决');
  assert.match(capped.reason, /上限/);
});

await check('smart-wake 插件声明与实现一致（能力名、默认关闭）', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'plugins/smart-wake/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.capabilities, ['reply.interest-judge'], 'capabilities 应声明 reply.interest-judge');
  assert.equal(manifest.settings.enabled, false, '默认 settings.enabled 应为 false（不改变默认行为）');
  const sw = await import('../plugins/smart-wake/index.js');
  assert.equal(typeof sw.providers['reply.interest-judge'], 'function', '应导出 reply.interest-judge 提供者');
});

// ── 收尾 ────────────────────────────────────────────────────────────────
await env.teardown();
if (fail.length === 0) {
  console.log(`\n全部通过 —— 通过 ${pass.length} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail.length}：${fail.join('；')}`);
process.exit(1);
