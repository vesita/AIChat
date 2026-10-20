// 出站硬上限（SendQueue 唯一出口闸门）回归。
//
// 覆盖：
//   ① 默认 2000/滚动 1 小时；
//   ② 第 2001 条被拒，且被拒时**不调用底层发送**、不占用去重/失败记账；
//   ③ 窗口滑动（1 小时后旧记录过期）后恢复；
//   ④ 0 = 不限；
//   ⑤ 失败 / 去重跳过的发送不计入；
//   ⑥ 多 chatKey 共享同一份全局计数；
//   ⑦ 并发发送原子（不会因为"检查时都没满"而超限）；
//   ⑧ 被拒时返回结构化原因（code=OUTBOUND_HARD_LIMIT，带 limit/count）。
//
// 运行：node test/outbound-limit-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-outbound-'));

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { SendQueue } = await import('../src/sender.js');

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

/** 可注入时钟 + 假 onebot（绝不真发）。 */
let clock = 1_000_000;
let sentCalls = 0;
let failNext = 0;
const onebot = {
  async sendText() {
    if (failNext > 0) { failNext--; throw new Error('协议端故意失败'); }
    sentCalls++;
    return { message_id: sentCalls };
  }
};
const store = { appendSelf() {} };
const q = new SendQueue({ onebot, store, now: () => clock });

function applyConfig({ maxPerHour, dedupeWindowMs = 8000, sendMaxPerMinute = 1_000_000 } = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.send = {
    ...cfg.send,
    minGapMs: 0, maxGapMs: 0, byLengthMs: 0, hardSplitAt: 0, dedupeWindowMs,
    maxPerMinute: sendMaxPerMinute, maxPerHour: 1_000_000
  };
  cfg.store.limits = { maxMessagesPerHour: maxPerHour };
  setRuntimeConfig(cfg);
}
const reset = (maxPerHour) => {
  q.outboundTimes = [];
  q.outboundReserved = 0;
  q.outboundWarnHour = -1;
  sentCalls = 0;
  failNext = 0;
  applyConfig({ maxPerHour });
};

// ── ① 默认 2000 ─────────────────────────────────────────────────────────
await check('① 默认配置 = 2000 条/滚动 1 小时；前 2000 条正常发出、第 2001 条被拒', async () => {
  assert.equal(DEFAULT_CONFIG.store.limits.maxMessagesPerHour, 2000, '默认值必须是 2000');
  reset(undefined);   // 不覆盖 limits → 用 DEFAULT_CONFIG 的 2000
  for (let i = 0; i < 2000; i++) await q.sendTextBatch('group:1', [`第${i}条`]);
  assert.equal(sentCalls, 2000, `前 2000 条应全部发出（实际 ${sentCalls}）`);
  assert.equal(q.outboundTimes.length, 2000, '窗口内应记录 2000 条成功发送');
  let err = null;
  try { await q.sendTextBatch('group:1', ['第2001条']); } catch (e) { err = e; }
  assert.ok(err, '第 2001 条必须被拒绝');
  assert.match(err.message, /出站硬上限/);
  assert.equal(err.code, 'OUTBOUND_HARD_LIMIT', '应带结构化错误码');
  assert.equal(err.limit, 2000);
  assert.equal(err.count, 2000);
  assert.equal(sentCalls, 2000, '被拒时**不得**调用底层发送');
});

// ── ② 小上限下的拒绝语义 ────────────────────────────────────────────────
await check('② 上限 3：第 4 条被拒、底层发送只发生 3 次、被拒消息不进去重窗口', async () => {
  reset(3);
  for (let i = 0; i < 3; i++) await q.sendTextBatch('group:2', [`消息${i}`]);
  assert.equal(sentCalls, 3);
  await assert.rejects(() => q.sendTextBatch('group:2', ['被拒的那条']), /出站硬上限/);
  assert.equal(sentCalls, 3, '被拒的发送不能触达 onebot');
  // 若被拒消息误入去重记账，放开额度后同文本会被当成重复；这里放到 1 小时后验证能发出去
  clock += 3_700_000;
  await q.sendTextBatch('group:2', ['被拒的那条']);
  assert.equal(sentCalls, 4, '窗口过去后同文本应能正常发出（说明被拒时没有提前记账）');
});

// ── ③ 窗口滑动恢复 ──────────────────────────────────────────────────────
await check('③ 滚动窗口：旧记录满 1 小时后自动失效，无需重启', async () => {
  reset(2);
  await q.sendTextBatch('group:3', ['a']);
  await q.sendTextBatch('group:3', ['b']);
  await assert.rejects(() => q.sendTextBatch('group:3', ['c']), /出站硬上限/);
  clock += 3_600_001;   // 恰好滚过 1 小时
  await q.sendTextBatch('group:3', ['c']);
  assert.equal(q.outboundTimes.length, 1, '窗口内只应剩新发的那条');
});

// ── ④ 0 = 不限 ─────────────────────────────────────────────────────────
await check('④ 0 = 不限：连发 50 条全部成功，且不跟踪计数（不涨内存）', async () => {
  reset(0);
  for (let i = 0; i < 50; i++) await q.sendTextBatch('group:4', [`不限${i}`]);
  assert.equal(sentCalls, 50);
  assert.equal(q.outboundTimes.length, 0, '关闭上限时不记录时间戳');
});

// ── ⑤ 失败 / 去重不计 ──────────────────────────────────────────────────
await check('⑤ 失败与去重跳过的发送不计入上限（失败可重试、重复不占额度）', async () => {
  reset(10);
  failNext = 2;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => q.sendTextBatch('group:5', [`失败${i}`]), /协议端故意失败/);
  }
  assert.equal(q.outboundTimes.length, 0, '失败不计数');
  assert.equal(sentCalls, 0);
  // 去重：同一文本 8s 内第二次直接跳过，不占额度
  await q.sendTextBatch('group:5', ['重复的内容']);
  const second = await q.sendTextBatch('group:5', ['重复的内容']);
  assert.equal(second.sent[0].deduped, true, '第二次应被去重跳过');
  assert.equal(q.outboundTimes.length, 1, '去重跳过不计数');
});

// ── ⑥ 多会话共享 ────────────────────────────────────────────────────────
await check('⑥ 多 chatKey 共享同一份全局计数（不是每群 2 条）', async () => {
  reset(2);
  await q.sendTextBatch('group:6', ['群甲的']);
  await q.sendTextBatch('private:777', ['私聊的']);
  await assert.rejects(() => q.sendTextBatch('group:7', ['第三个会话']), /出站硬上限/);
  assert.equal(q.outboundTimes.length, 2);
});

// ── ⑦ 并发原子 ─────────────────────────────────────────────────────────
await check('⑦ 并发发送也不超限（检查与占额度在同一段同步代码里完成）', async () => {
  reset(2);
  // 让底层发送有真实 await 交错窗口：三个会话同时发，两个成功、一个被拒
  const results = await Promise.allSettled([
    q.sendTextBatch('group:8', ['并发甲']),
    q.sendTextBatch('group:9', ['并发乙']),
    q.sendTextBatch('group:10', ['并发丙'])
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok, 2, `并发下应恰好成功 2 条（实际 ${ok}）`);
  assert.equal(bad.length, 1);
  assert.match(String(bad[0].reason?.message), /出站硬上限/);
  assert.equal(sentCalls, 2, '底层只应被调用 2 次');
  assert.equal(q.outboundTimes.length, 2);
});

// ── ⑧ 拒绝时日志只打一次/小时 ──────────────────────────────────────────
await check('⑧ 同一自然小时内重复触发只告警一次（不刷屏）', async () => {
  reset(1);
  await q.sendTextBatch('group:11', ['唯一成功的一条']);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    for (let i = 0; i < 5; i++) {
      try { await q.sendTextBatch('group:11', [`被拒${i}`]); } catch { /* 预期 */ }
    }
  } finally {
    console.warn = origWarn;
  }
  const limitWarns = warns.filter((w) => w.includes('出站硬上限已触发'));
  assert.equal(limitWarns.length, 1, `同一小时只应告警一次，实际 ${limitWarns.length} 次`);
  assert.match(limitWarns[0], /已成功发送 1 条（上限 1）/);
});

if (fail === 0) {
  console.log(`\n全部通过 —— 通过 ${pass} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail}`);
process.exit(1);
