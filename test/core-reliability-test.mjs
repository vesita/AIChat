/**
 * 核心可靠性四条（M-1 / M-2 / D-1 / T-1）的回归测试 + 负向对照。
 *
 * 来源：doc/audit/core-faults.md（每条都有 文件:行 / 触发条件 / 最小修复）。
 * 四条修复各自带一个「修前会失败」的断言：同一个测试文件跑两种模式，
 * 先证明去掉修复这些断言确实会红，再证明修好后是绿的。
 *
 *   正向（期望全部通过）：
 *     node test/core-reliability-test.mjs
 *   负向对照（四个修复全关，期望带 [负向对照] 标记的断言全部失败）：
 *     COREFIX_NEGATIVE=1 node test/core-reliability-test.mjs
 *
 * 负向对照开关（src 里读取，生产不设 → 修复恒开）：
 *   COREFIX_M1=0 失败批不回滚未读 / 不自动重试
 *   COREFIX_M2=0 定向零发送不告警、不计数
 *   COREFIX_D1=0 发送前不登记 attempt 占位（回到"成功后 8 秒"去重）
 *   COREFIX_T1=0 工具直接 await，无超时、中止穿不透
 *
 * ⚠️ 并发提醒：本文件起完整 app（mock OneBot + mock LLM + 临时 data 目录），
 *    不要与别的测试同时跑（端口/data 目录会互撞导致假失败）。
 */
import assert from 'node:assert/strict';

const NEGATIVE = process.env.COREFIX_NEGATIVE === '1';
if (NEGATIVE) {
  process.env.COREFIX_M1 = '0';
  process.env.COREFIX_M2 = '0';
  process.env.COREFIX_D1 = '0';
  process.env.COREFIX_T1 = '0';
  console.log('\n############ 负向对照模式：四个修复全部关闭 ############');
  console.log('期望：[负向对照] 标记的断言全部失败（证明测试能抓住修前的缺陷）。\n');
}

// 日志采集要在 bootApp 之前装好：可靠性告警都走 console.warn / console.error。
const logs = [];
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
console.warn = (...args) => { logs.push(args.map((a) => String(a)).join(' ')); origWarn(...args); };
console.error = (...args) => { logs.push(args.map((a) => String(a)).join(' ')); origError(...args); };
const logCount = (sub) => logs.filter((l) => l.includes(sub)).length;
const logHas = (sub) => logs.some((l) => l.includes(sub));

const results = [];
/**
 * check：断言"修好后应该成立"的行为。
 * expectBroken=true 表示这条是负向对照断言 —— 修前必须失败；负向模式下它失败才算对。
 */
async function check(name, fn, { expectBroken = false } = {}) {
  try {
    await fn();
    results.push({ name, ok: true, expectBroken });
    console.log(`  [ok]   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, expectBroken, error: String(error?.message ?? error) });
    console.log(`  [FAIL] ${name}\n         -> ${String(error?.message ?? error)}`);
  }
}

// ── D-1：发送幂等（独立驱动 SendQueue，不需要整机）───────────────────────
// 放在 bootApp 之前会提前 import config.js 并锁死 DATA_DIR，所以它被放到
// bootApp 之后执行（见文件末尾的 runD1）。这里先声明，等环境就绪再跑。
async function runD1() {
  console.log('\n=== D-1 「超时但已送达」的发送幂等 ===');
  const { SendQueue } = await import('../src/sender.js');

  const makeStub = () => {
    const state = { sent: 0, mode: 'timeout' };
    return {
      state,
      async sendText() {
        state.sent += 1;
        if (state.mode === 'timeout') {
          // 复刻 onebot.call 在 AbortSignal 超时后抛的文案
          throw new Error('OneBot send_group_msg 超时（90 秒未完成）：[TimeoutError] timeout');
        }
        if (state.mode === 'ratelimit') {
          // 明确失败：消息肯定没进 QQ，应立刻释放占位、允许重试
          throw new Error('发送频率超限（每分钟最多 1 条），请等一会再发');
        }
        return { message_id: 9000 + state.sent };
      }
    };
  };
  const makeQueue = (onebot, clock) => new SendQueue({
    onebot,
    store: { appendSelf() {} },
    log: () => {},
    now: () => clock.value
  });

  // 场景 A（负向对照）：首次"超时但已收下"，30 秒后重发同一文本必须被拦。
  {
    const onebot = makeStub();
    const clock = { value: 1_000_000 };
    const q = makeQueue(onebot, clock);
    let firstError = null;
    try { await q.sendTextBatch('group:901', ['D1 超时但已送达']); }
    catch (error) { firstError = error; }

    await check('D-1 超时后日志写明「结果不确定」（可观测，不静默）', () => {
      assert.ok(firstError, '首次发送应抛错');
      assert.ok(logHas('结果不确定'), `日志应写明结果不确定，实际日志：${JSON.stringify(logs.slice(-5))}`);
    }, { expectBroken: true });

    clock.value += 30000;   // 30 秒后模型重发同一句
    let second = null;
    try { second = await q.sendTextBatch('group:901', ['D1 超时但已送达']); }
    catch (error) { second = { error }; }
    await check('D-1 首次超时后 30 秒内重发被拦（修前：协议端收到 2 条重复消息）', () => {
      assert.ok(second && !second.error, `第二次发送应被去重拦下（不抛错），实际：${second?.error?.message}`);
      assert.equal(onebot.state.sent, 1, `协议端只应收到 1 条，实际 ${onebot.state.sent} 条`);
      assert.ok(second.sent.some((s) => s.deduped), '第二次应标记为 deduped');
    }, { expectBroken: true });
  }

  // 场景 B：占位超过窗口（120s）后过期，允许正常重发（不能永久封死）。
  {
    const onebot = makeStub();
    const clock = { value: 2_000_000 };
    const q = makeQueue(onebot, clock);
    try { await q.sendTextBatch('group:902', ['D1 窗口过期重发']); } catch { /* 首次超时 */ }
    clock.value += 130000;   // 超过 120 秒占位窗口
    onebot.state.mode = 'ok';   // 协议端恢复正常
    const again = await q.sendTextBatch('group:902', ['D1 窗口过期重发']);
    await check('D-1 占位 120 秒后过期，允许正常重发（不永久封死）', () => {
      assert.equal(onebot.state.sent, 2, `窗口过期后应真的重发（协议端共 2 次），实际 ${onebot.state.sent}`);
      assert.ok(!again.sent.some((s) => s.deduped), '不应被去重');
    });
  }

  // 场景 C：明确失败（限频）立刻释放占位 —— 合法重试不能被误判成重复。
  {
    const onebot = makeStub();
    onebot.state.mode = 'ratelimit';
    const clock = { value: 3_000_000 };
    const q = makeQueue(onebot, clock);
    try { await q.sendTextBatch('group:903', ['D1 明确失败可重试']); } catch { /* 首次限频失败 */ }
    onebot.state.mode = 'ok';
    const retry = await q.sendTextBatch('group:903', ['D1 明确失败可重试']);
    await check('D-1 明确失败（限频）立刻释放占位，合法重试不被拦', () => {
      assert.equal(onebot.state.sent, 2, `第二次应真的发出去，协议端调用次数 ${onebot.state.sent}`);
      assert.ok(!retry.sent.some((s) => s.deduped), '明确失败后的重试不应被判成重复');
    });
  }
}

// ── 整机场景（M-1 / M-2 / T-1）──────────────────────────────────────────
const { bootApp, sleep, waitFor } = await import('./_harness.mjs');

const env = await bootApp({
  config: {
    wakeDelayMs: 120,
    drainDelayMs: 150,
    // 会话级重试关掉：M-1 的"批级退避重试"才是本测试要证明的路径。
    sessionRetryAttempts: 0,
    maxConcurrentRuns: 2,
    // 记忆整理会自己打 LLM 请求，抢脚本队列 —— 测试里关掉。
    memory: { consolidateEnabled: false },
    // T-1：工具超时预算缩短到 250ms（生产默认 120s，可用 tools.timeoutMs 覆盖）。
    tools: { timeoutMs: 250 },
    reliability: { batchRetries: 2, batchRetryBaseMs: 120 },
    store: { contextTier: 4, historyCount: 20 },
    send: { unconfirmedWindowMs: 120000, dedupeWindowMs: 8000 },
    // 场景之间互不污染：M-2 反例用 789，M-1/T-1 用 456，私聊用 777。
    allow: { groups: ['456', '789'], private: ['777'] }
  }
});
const { app, llm, request } = env;

// 注册一个"永不返回"的假工具（T-1 用）。必须在 refreshToolDefs 之前注册。
const { registerTool } = await import('../src/tool-registry.js');
let hangStarted = 0;
registerTool({
  id: 'test_hang_forever',
  name: '测试挂起工具',
  description: '测试专用：永远不返回，用来验证工具执行超时与中止穿透。',
  category: 'system',
  parameters: { type: 'object', properties: {} },
  execute: () => {
    hangStarted += 1;
    return new Promise(() => { /* 永不 resolve */ });
  }
});
app.orchestrator.refreshToolDefs();

const pushPrivateMsg = (userId, name, text, mid) => env.onebotWs.push({
  post_type: 'message', message_type: 'private', user_id: userId, self_id: 888,
  message_id: mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: userId, card: name, nickname: name },
  message: [{ type: 'text', data: { text } }]
});
/** 群消息：带一个真正的 @ 段（atMe 以 QQ 段为准，这是"被艾特"的权威来源）。 */
const pushGroupAtMsg = (userId, name, text, mid, groupId = 456) => env.onebotWs.push({
  post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, self_id: 888,
  message_id: mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: userId, card: name, nickname: name },
  message: [{ type: 'at', data: { qq: '888' } }, { type: 'text', data: { text: ` ${text}` } }]
});
const pushGroupPlainMsg = (userId, name, text, mid, groupId = 456) => env.onebotWs.push({
  post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, self_id: 888,
  message_id: mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: userId, card: name, nickname: name },
  message: [{ type: 'text', data: { text } }]
});
const sessionsWith = (token) => app.sessions.listSummaries(200)
  .filter((s) => String(s.trigger || '').includes(token));
const status = async () => (await request('GET', '/api/status')).data;
const settle = () => sleep(250);
/**
 * 给"下一次"LLM 请求脚本化响应。
 * ⚠️ 不能用 script.push —— mock 按 `script[请求序号]` 取条目，而 M-1 的 500 桩
 * 不消耗脚本；push 会落到错误的序号上（第一步已经踩过：T-1 拿到的不是挂起脚本）。
 */
const scriptNext = (entry) => { llm.state.script[llm.state.requests.length] = entry; };

// ── M-2：定向零发送可观测 ───────────────────────────────────────────────
console.log('\n=== M-2 定向触发「零发送」告警与计数 ===');
{
  const before = (await status()).orchestrator.missedDirected;
  scriptNext({ content: '' });   // 模型只输出空正文，不调用 send_message
  pushPrivateMsg(777, '好友777', '定向必回测试', 9201);
  const sess = await env.waitSessionDone('定向必回测试', 8000);
  await check('M-2 私聊零发送 → 会话正常收尾为 noreply（前置事实）', () => {
    assert.equal(sess.status, 'noreply', `实际 status=${sess.status}`);
    assert.equal((sess.sent || []).length, 0);
  });
  await check('M-2 定向零发送：warn 日志 + /api/status.missedDirected +1（修前：完全静默）', async () => {
    const after = (await status()).orchestrator.missedDirected;
    assert.equal(after, before + 1, `missedDirected 应从 ${before} 变成 ${before + 1}，实际 ${after}`);
    assert.ok(logHas('定向零发送'), '应有一条固定格式的定向零发送告警');
  }, { expectBroken: true });
  await check('M-2 定向零发送在会话存档里留下 missedDirected 标记', async () => {
    const detail = app.sessions.get(sess.id);
    assert.equal(detail?.missedDirected, true, '会话 JSON 应有 missedDirected=true');
  }, { expectBroken: true });
  await settle();

  // 反例：非定向（群里 4 档随机/全响应）零发送不能误报。
  const beforeNonDirected = (await status()).orchestrator.missedDirected;
  const warnBefore = logCount('定向零发送');
  scriptNext({ content: '' });
  pushGroupPlainMsg(111, '张三', '普通群聊零发送测试', 9202, 789);
  const groupSess = await env.waitSessionDone('普通群聊零发送测试', 8000);
  await check('M-2 非定向零发送不误报（计数不变）', async () => {
    assert.equal(groupSess.status, 'noreply');
    const after = (await status()).orchestrator.missedDirected;
    assert.equal(after, beforeNonDirected, `非定向零发送不应增加 missedDirected（${beforeNonDirected} → ${after}）`);
  });
  await check('M-2 非定向零发送不产生定向告警日志', () => {
    assert.equal(logCount('定向零发送'), warnBefore, '不应新增定向零发送告警');
  });
  await settle();
}

// ── M-1：失败批回补 + 自动重试 + 状态可重试 ─────────────────────────────
console.log('\n=== M-1 触发批失败后的回补与自动重试 ===');
let m1ErrorSessionId = null;
{
  const before = (await status()).orchestrator.unansweredDirected;
  // 3 次运行 × (1 主模型 + 2 次同模型重试) = 9 个 500。LLM 全败 = 线上 503 风暴。
  llm.state.forceStatus.push(...Array(9).fill(500));
  const t0 = Date.now();
  pushGroupAtMsg(111, '张三', '可靠性M1 被艾特必须回', 9301);

  await check('M-1 失败批会被下一次调度重新拾起（同一批消息至少重跑 2 次；修前：只跑 1 次）', async () => {
    await waitFor(() => sessionsWith('可靠性M1').length >= 3, 20000, '自动重试后出现第 3 个会话');
    await waitFor(() => app.orchestrator.statusSummary().running.length === 0, 10000, '重试结束后并发槽释放');
    const list = sessionsWith('可靠性M1');
    assert.ok(list.length >= 3, `应至少 3 次运行（初始 + 2 次自动重试），实际 ${list.length}`);
    console.log(`         运行次数=${list.length}，耗时=${Math.round((Date.now() - t0) / 1000)}s，状态=${list.map((s) => s.status).join(',')}`);
    assert.ok(list.every((s) => s.status === 'error'), '在 LLM 全败时每次运行都应是 error');
  }, { expectBroken: true });

  await check('M-1 定向失败未发计入 unansweredDirected', async () => {
    const after = (await status()).orchestrator.unansweredDirected;
    assert.ok(after > before, `unansweredDirected 应增加（${before} → ${after}）`);
  }, { expectBroken: true });

  await check('M-1 回滚未读留日志（不静默）', () => {
    assert.ok(logHas('已回滚'), '日志应出现「已回滚 N 条未读」；实际尾部：' + JSON.stringify(logs.filter((l) => l.includes('[reliability]')).slice(-4)));
    assert.ok(logHas('自动重试'), '日志应出现「自动重试」');
  }, { expectBroken: true });

  // 找到一条失败会话，验证"状态可重试"（手动重试是既有入口，修复后仍可用）。
  const err = sessionsWith('可靠性M1').find((s) => s.status === 'error');
  m1ErrorSessionId = err?.id || null;
  await check('M-1 失败会话满足手动重试条件：error 且 sent=0', async () => {
    assert.ok(err, '应存在 error 会话');
    const detail = app.sessions.get(err.id);
    assert.equal(detail.status, 'error');
    assert.equal((detail.sent || []).length, 0, 'sent 应为空');
  });

  // 清掉 500 桩，让手动重试能真的跑完（也避免污染后续 T-1 场景）。
  llm.state.forceStatus.length = 0;
  await check('M-1 手动重试会回滚触发批未读（restored≥1）', async () => {
    assert.ok(m1ErrorSessionId, '需要一条失败会话');
    const r = app.orchestrator.retrySession(m1ErrorSessionId);
    assert.equal(r.ok, true, `retrySession 应成功：${JSON.stringify(r)}`);
    assert.ok(r.restored >= 1, `应恢复至少 1 条未读，实际 ${r.restored}`);
    await waitFor(() => {
      const s = app.sessions.get(m1ErrorSessionId);
      return s && s.status !== 'running' && s.status !== 'waiting';
    }, 8000, '手动重试的会话收尾');
  });
  await settle();
}

await runD1();

// ── T-1：工具执行超时 + 中止穿透 ────────────────────────────────────────
console.log('\n=== T-1 工具执行超时与中止穿透 ===');
{
  const pushHangScript = () => scriptNext({
    content: null,
    toolCalls: [{ name: 'test_hang_forever', args: {} }]
  });

  await check('T-1 永不返回的工具在超时预算内收敛、并发槽释放（修前：永久停在运行中）', async () => {
    pushHangScript();
    const before = hangStarted;
    const t0 = Date.now();
    pushGroupAtMsg(111, '张三', '可靠性T1 工具挂起', 9401);
    const summary = await waitFor(
      () => sessionsWith('可靠性T1 工具挂起').find((s) => s.status === 'error'),
      4000,
      '工具超时的会话在预算内收尾'
    );
    const elapsed = Date.now() - t0;
    assert.ok(hangStarted > before, '假工具应真的被执行过');
    assert.ok(elapsed < 1500, `应在超时预算（250ms）+ 调度开销内收敛，实际 ${elapsed}ms`);
    const detail = app.sessions.get(summary.id);
    assert.equal(detail.status, 'error', `会话应以失败收敛，实际 ${detail.status}`);
    assert.ok(String(detail.error || '').includes('工具执行超时'), `会话错误应指向工具超时，实际 ${detail.error}`);
    await waitFor(() => app.orchestrator.statusSummary().running.length === 0, 8000, '并发槽释放');
    const st = await status();
    assert.ok(st.orchestrator.toolTimeouts >= 1, `status.toolTimeouts 应 ≥1，实际 ${st.orchestrator.toolTimeouts}`);
    assert.ok(logHas('工具执行超时'), '日志应有工具超时留痕');
  }, { expectBroken: true });

  await check('T-1 工具执行期间「中止」在 1 秒内生效（修前：中止无效）', async () => {
    // 先让上一个场景的 M-1 自动重试（120ms 间隔）彻底跑完，否则它会抢走
    // 本场景的脚本条目标号。用独立群 789，避免负向对照里上一个挂住的会话
    // 占用同一个 chatKey（那会挡住新消息，测不到"中止是否生效"）。
    await waitFor(() => app.orchestrator.statusSummary().running.length === 0, 8000, '上一场景重试结束').catch(() => {});
    await sleep(400);
    pushHangScript();
    const before = hangStarted;
    pushGroupAtMsg(111, '张三', '可靠性T1 中止', 9402, 789);
    await waitFor(() => hangStarted > before, 6000, '假工具开始执行（会话处于工具执行期）');
    const active = app.orchestrator.statusSummary().activeSessions.find((s) => s.chatKey === 'group:789');
    assert.ok(active, '应有运行中的会话');
    const t0 = Date.now();
    const r = await request('POST', `/api/sessions/${active.sessionId}/abort`, { body: {} });
    assert.equal(r.status, 200, `中止接口应返回 200，实际 ${r.status}`);
    const done = await waitFor(() => {
      const s = app.sessions.get(active.sessionId);
      return s && s.status !== 'running' && s.status !== 'waiting' ? s : null;
    }, 1000, '中止后会话在 1s 内结束');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed <= 1000, `中止应 ≤1s 生效，实际 ${elapsed}ms`);
    assert.equal(done.status, 'aborted', `实际 status=${done.status}`);
  }, { expectBroken: true });
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
if (NEGATIVE) {
  const brokenChecks = results.filter((r) => r.expectBroken);
  const unexpectedPass = brokenChecks.filter((r) => r.ok);
  const unexpectedFail = results.filter((r) => !r.expectBroken && !r.ok);
  console.log('负向对照结果（修复全部关闭）：');
  for (const r of brokenChecks) console.log(`  ${r.ok ? '✗ 仍然通过（对照无效）' : '✓ 已失败（对照有效）'}  ${r.name}`);
  if (unexpectedFail.length) {
    console.log('\n非对照断言意外失败（说明负向模式破坏了无关行为）：');
    for (const r of unexpectedFail) console.log(`  ✗ ${r.name} -> ${r.error}`);
  }
  if (unexpectedPass.length === 0 && unexpectedFail.length === 0) {
    console.log(`\n负向对照全部成立：${brokenChecks.length} 条对照断言在修前全部失败 ✅`);
    console.log('（这证明正向测试确实在检查修复，而不是无论代码怎样都绿。）');
    process.exit(0);
  }
  console.log(`\n负向对照不成立：仍通过 ${unexpectedPass.length} 条，意外失败 ${unexpectedFail.length} 条`);
  process.exit(1);
} else {
  const failed = results.filter((r) => !r.ok);
  console.log(`正向结果：通过 ${results.length - failed.length} / ${results.length}`);
  if (failed.length) {
    console.log('\n失败明细：');
    for (const f of failed) console.log(`  ✗ ${f.name}\n      ${f.error}`);
    process.exit(1);
  }
  console.log('\n全部通过 ✅（四条的负向对照请用 COREFIX_NEGATIVE=1 再跑一遍）');
  await env.teardown().catch(() => {});
  process.exit(0);
}
