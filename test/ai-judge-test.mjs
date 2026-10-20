// AI 自动判断接话（participationMode='ai' + [[PASS]] 核心短路）端到端回归。
//
// 用真实 app（mock OneBot + mock LLM）跑完整链路，覆盖：
//   ① 默认关：行为不变，系统提示里没有守则段；
//   ② AI 模式：系统提示自动注入守则（含 marker），群聊非定向消息进入模型判定；
//   ③ 模型只输出 [[PASS]] → 不发送、不 rescue、本批标已读、contextReason=AI 判定不接；
//   ④ PASS + 正常话 → 剥掉标记后按正常正文处理（经 rescue 发出，内容不含标记）；
//   ⑤ 空正文且未发送 → 静默不接；
//   ⑥ 定向消息（@）不受 AI 判定影响（reason=被艾特，PASS 不作为"不接"处理）；
//   ⑦ minGapSec 节流：间隔内的消息留未读，间隔过去后的下一次触发一起处理；
//   ⑧ 出站硬上限生效时不影响 AI 判定与未读逻辑（被拒的那条只影响发送本身）。
//
// 运行：node test/ai-judge-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据目录隔离必须在 import src 之前
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ai-judge-'));

const { bootApp, sleep, waitFor } = await import('./_harness.mjs');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

const env = await bootApp({
  config: { store: { contextSliderPos: 100, historyCount: 80 }, wakeDelayMs: 250 }
});
// ⚠️ src 模块必须在 bootApp 之后 import（config.js 在模块求值时捕获 DATA_DIR）
const { skillManager } = await import('../src/skills/manager.js');
const { normalizeManifest } = await import('../src/skills/manifest.js');
const { app, request, llm, pushGroupMsg } = env;
const llmCount = () => llm.state.requests.length;
const settle = () => sleep(700);
const unreadOf = (chatKey) => app.store.getChatMeta(chatKey).unread;
const setStore = (patch) => request('POST', '/api/config', { body: { store: patch } });
const lastRequest = () => llm.state.requests[llm.state.requests.length - 1];
// ⚠️ mock LLM 按"第几次请求"取 script[step]，step = 已发生的请求数。
// 所以脚本必须写到**当前请求数对应的下标**（直接 push 会落到 index 0 被前面的请求吃掉）。
function script(entries) {
  const start = llm.state.requests.length;
  entries.forEach((e, i) => { llm.state.script[start + i] = e; });
}
const scriptReply = (...contents) => script(contents.map((content) => ({ content })));
const scriptSend = (text) => script([
  { toolCalls: [{ name: 'send_message', args: { messages: [text] } }] },
  { content: '好' }   // 下一轮：无工具调用 → 正常收尾
]);

/** 注册一个测试用能力插件（rescue 用；走真实能力注册链路）。 */
function addSkill(id, capabilities, providers) {
  const { manifest } = normalizeManifest({ id, name: id, capabilities, enabledByDefault: true });
  const r = skillManager.register({
    manifest, source: 'test', dir: path.join(os.tmpdir(), id), api: null, toolIds: [],
    available: null, availableReason: '', activate: null, deactivate: null,
    dispose: () => {}, hooks: {}, providers, promptSections: null
  });
  assert.ok(r.ok, `注册假插件失败：${r.error || ''}`);
}
const removeSkill = (id) => { try { skillManager.unregister(id); } catch { /* ignore */ } };

// ── ① 默认关：行为不变 ──────────────────────────────────────────────────
await check('① 默认（probability）行为不变：群聊照常触发，系统提示无守则段', async () => {
  const before = llmCount();
  pushGroupMsg(111, '张三', '默认模式下的普通消息', 9001);
  await waitFor(() => llmCount() > before, 5000, '默认模式应照常触发');
  const system = String(lastRequest().messages[0].content);
  assert.ok(!system.includes('【群聊参与守则（自动判断）】'), '默认模式不应注入 AI 守则');
  // 输出长度不设上限：请求体里不应出现 max_tokens（允许模型在需要时写完整、长回复）
  assert.equal(lastRequest().max_tokens, undefined, '默认请求不应带 max_tokens（不设输出上限）');
  const s = await env.waitSessionDone('默认模式下的普通消息');
  assert.ok(s, '应产生会话');
  await settle();
});

// ── ② AI 模式系统提示 + ③ PASS 短路 ────────────────────────────────────
await check('② AI 模式：系统提示自动注入守则（含 marker / 定向必回要求）', async () => {
  await setStore({ participationMode: 'ai', aiJudge: { enabled: true, passMarker: '[[PASS]]', minGapSec: 0 } });
  const before = llmCount();
  scriptReply('[[PASS]]');
  pushGroupMsg(111, '张三', 'AI 模式的第一句', 9002);
  await waitFor(() => llmCount() > before, 5000, 'AI 模式应触发模型');
  const system = String(lastRequest().messages[0].content);
  assert.ok(system.includes('【群聊参与守则（自动判断）】'), '应注入守则段');
  assert.ok(system.includes('只输出 [[PASS]]'), '守则里应有 marker');
  assert.ok(system.includes('必须回应'), '守则里应有定向必回要求');
  assert.equal(lastRequest().max_tokens, undefined, 'AI 判定请求同样不设输出上限（允许长回复）');
});

await check('③ 只输出 [[PASS]]：不发送、不 rescue、本批标已读、contextReason=AI 判定不接', async () => {
  await env.waitSessionDone('AI 模式的第一句');
  const s = await waitFor(() => {
    const list = app.sessions.listSummaries(50).find((e) => (e.trigger || '').includes('AI 模式的第一句'));
    return list ? app.sessions.get(list.id) : null;
  }, 5000, 'PASS 会话');
  assert.equal(s.sent.length, 0, 'PASS 之后不应发出任何消息');
  assert.equal(s.contextReason, 'AI 判定不接', `contextReason 应记录不接，实际 ${s.contextReason}`);
  assert.ok(!(s.messages || []).some((m) => m.rescued), 'PASS 不应触发 rescue');
  assert.equal(unreadOf('group:456'), 0, '本批消息应标已读');
});

// ── ④ PASS + 正常话 → 剥标记走 rescue 正常发送 ─────────────────────────
await check('④ 正文含 PASS + 正常话：剥掉标记后经 rescue 正常发出（内容不含标记）', async () => {
  // 用真实的回复安全网链路：提供 reply.loose-send 能力（把正文整句捞出来）
  const received = [];
  addSkill('test-loose-send', ['reply.loose-send'], {
    // 只认"看起来是成品回复"的正文（避免把每轮默认占位正文也 rescue 成发送，
    // 那会让循环跑到 maxRounds、测试里看到一串重复消息）。
    'reply.loose-send': ({ text }) => {
      const body = String(text || '');
      received.push(body);
      return body.includes('今天天气不错') ? { messages: [body] } : { messages: [] };
    }
  });
  try {
    const before = llmCount();
    scriptReply('[[PASS]]\n今天天气不错，出去走走');
    pushGroupMsg(111, '张三', '带 PASS 和正文的一轮', 9003);
    await waitFor(() => llmCount() > before, 5000, '应触发模型');
    await env.waitSessionDone('带 PASS 和正文的一轮');
    const s = await waitFor(() => {
      const list = app.sessions.listSummaries(50).find((e) => (e.trigger || '').includes('带 PASS 和正文的一轮'));
      return list ? app.sessions.get(list.id) : null;
    }, 5000, '会话');
    assert.equal(s.sent.length, 1, `应正常发出 1 条（实际 ${s.sent.length}）`);
    assert.equal(s.sent[0].text, '今天天气不错，出去走走', 'marker 必须被剥掉，只发正常内容');
    assert.ok(!s.sent[0].text.includes('[[PASS]]'), '发出的内容不能含 PASS 标记');
    assert.ok(received[0] && !received[0].includes('[[PASS]]'), 'rescue 收到的正文不应含 marker');
    assert.notEqual(s.contextReason, 'AI 判定不接', '这不是"不接"，contextReason 应保持 AI 判定');
  } finally {
    removeSkill('test-loose-send');
  }
});

// ── ⑤ 空正文且未发送 → 静默 ─────────────────────────────────────────────
await check('⑤ 空正文且本轮未发送：静默不接（不报错、不发消息）', async () => {
  const before = llmCount();
  scriptReply('');
  pushGroupMsg(111, '张三', '空正文的一轮', 9004);
  await waitFor(() => llmCount() > before, 5000, '应触发模型');
  await env.waitSessionDone('空正文的一轮');
  const s = await waitFor(() => {
    const list = app.sessions.listSummaries(50).find((e) => (e.trigger || '').includes('空正文的一轮'));
    return list ? app.sessions.get(list.id) : null;
  }, 5000, '会话');
  assert.equal(s.sent.length, 0);
  assert.equal(s.contextReason, 'AI 判定不接');
  assert.equal(unreadOf('group:456'), 0);
});

// ── ⑥ 定向消息不受 AI 判定影响 ─────────────────────────────────────────
await check('⑥ @ 定向消息：reason=被艾特（不进入 AI 判定），PASS 不被当作"不接"', async () => {
  const before = llmCount();
  scriptReply('[[PASS]]');   // 模型即使输出 PASS，定向批也不按"不接"处理
  pushGroupMsg(111, '张三', '@覆盖Bot 你在吗', 9005);
  await waitFor(() => llmCount() > before, 5000, '@ 必须触发（定向必回）');
  const s = await env.waitSessionDone('@覆盖Bot 你在吗');
  assert.equal(s.contextReason, '被艾特', `定向消息 reason 应为被艾特，实际 ${s.contextReason}`);
  assert.notEqual(s.contextReason, 'AI 判定不接');
  await settle();
});

// ── ⑦ minGapSec 节流 ────────────────────────────────────────────────────
await check('⑦ minGapSec 节流：间隔内的消息留未读，间隔后的下一次触发一起处理', async () => {
  await setStore({ participationMode: 'ai', aiJudge: { enabled: true, passMarker: '[[PASS]]', minGapSec: 600 } });
  const before = llmCount();
  scriptReply('[[PASS]]');
  pushGroupMsg(111, '张三', '节流第一条', 9006);
  await waitFor(() => llmCount() > before, 5000, '第一条应触发');
  await env.waitSessionDone('节流第一条');
  await settle();
  const mid = llmCount();
  pushGroupMsg(111, '张三', '节流第二条（应留未读）', 9007);
  await sleep(700);
  assert.equal(llmCount(), mid, '节流窗口内不应再次调模型');
  assert.equal(unreadOf('group:456'), 1, '节流窗口内的消息应保持未读');
  // 关掉节流 → 下一条消息把积压一起带进判定
  await setStore({ aiJudge: { enabled: true, passMarker: '[[PASS]]', minGapSec: 0 } });
  scriptReply('[[PASS]]');
  pushGroupMsg(111, '张三', '节流第三条', 9008);
  await waitFor(() => llmCount() > mid, 5000, '关闭节流后应恢复判定');
  // 批的触发摘要取的是批内**第一条**未读（节流第二条），不是最后一条
  await env.waitSessionDone('节流第二条');
  await settle();
});

// ── ⑧ 出站硬上限生效时不影响 AI 判定 / 未读逻辑 ────────────────────────
await check('⑧ 硬上限只影响发送：AI 判定照常、未读照常，被拒原因可观测', async () => {
  // 本次测试前面已真实发出 1 条（④），所以上限设 2：第一条（总第 2 条）成功、第二条被拒
  await setStore({ participationMode: 'ai', aiJudge: { enabled: true, passMarker: '[[PASS]]', minGapSec: 0 }, limits: { maxMessagesPerHour: 2 } });
  // 第 1 条：上限内，正常发出
  const before1 = llmCount();
  scriptSend('上限内的第一条');
  pushGroupMsg(111, '张三', '限量第一条', 9009);
  await waitFor(() => llmCount() > before1, 5000, '第一次发送应触发');
  await env.waitSessionDone('限量第一条');
  // 第 2 条：超过上限，发送被拒，但会话/未读逻辑不受影响
  const before2 = llmCount();
  scriptSend('上限外的第二条');
  pushGroupMsg(111, '张三', '限量第二条', 9010);
  await waitFor(() => llmCount() > before2, 5000, '第二次仍应照常触发（判定不受上限影响）');
  const s2 = await env.waitSessionDone('限量第二条');
  assert.equal(s2.sent.length, 0, '被硬上限拒绝的消息不应出现在已发送里');
  const s1 = app.sessions.listSummaries(50).find((e) => (e.trigger || '').includes('限量第一条'));
  if (s1) assert.equal(app.sessions.get(s1.id).sent.length, 1, '上限内的第一条应正常发出');
  const toolText = JSON.stringify(s2.messages || []);
  assert.ok(toolText.includes('出站硬上限'), '会话的消息流里应能看到结构化拒绝原因');
  assert.equal(unreadOf('group:456'), 0, '被拒不影响未读标记');
  // 上限放开后恢复正常发送
  await setStore({ limits: { maxMessagesPerHour: 0 } });
  const before3 = llmCount();
  scriptSend('上限放开后的第三条');
  pushGroupMsg(111, '张三', '限量第三条', 9011);
  await waitFor(() => llmCount() > before3, 5000, '放开上限后应照常触发');
  const s3 = await env.waitSessionDone('限量第三条');
  assert.equal(s3.sent.length, 1, '放开上限后应能正常发送');
});

await env.teardown();
if (fail === 0) {
  console.log(`\n全部通过 —— 通过 ${pass} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail}`);
process.exit(1);
