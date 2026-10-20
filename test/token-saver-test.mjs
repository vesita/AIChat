// token-saver 插件回归。
//
// 覆盖：
//   1. before-llm-messages：只裁【已读信息】里最旧的历史（keepLast / 字符预算），
//      不碰【未读信息】【新已读信息】，不碰 system / tool 消息；
//   2. reply.local-policy：只在"本轮只发送、无待执行工具且全成功"时收尾（默认关闭）；
//   3. llm.usage：上报本轮裁掉的条数，上报后清零（不反复累加）；
//   4. 关闭（settings.enabled=false）时等价没装：不裁、不参与收尾、不上报；
//   5. 清单默认值与实现一致。
//
// 运行：node test/token-saver-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = await import(path.join(ROOT, 'plugins/token-saver/index.js').replace(/\\/g, '/'));

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

const ON = { enabled: true, keepLast: 40, charBudget: 0, localPolicy: false, countUsage: true };

/** 造一条与 buildUserPrompt 同构的 user 消息（含三个段）。 */
function makeUserContent(lineCount) {
  const lines = Array.from({ length: lineCount }, (_, i) => `[12:00] 群友${i}(QQ:${1000 + i})：第 ${i} 条已读消息，内容够长一点点`);
  return [
    '【当前时间】2026-10-20 12:00',
    '【已读信息】以下是这个会话最近的聊天记录（按时间排序；这些都已经看过）：\n' + lines.join('\n'),
    '【未读信息】以下是你还没看过的最新消息：\n[12:01] 张三(QQ:111)：新消息来了',
    '【新已读信息】以下是锚定窗口之后、这轮新沉淀的已读消息：\n[12:02] 李四(QQ:222)：追加的一条'
  ].join('\n\n');
}

// ── 1. 裁剪：只动最旧的已读历史 ──────────────────────────────────────────
check('keepLast=40：50 条已读只留最近 40 条，其它段与消息类型不动', () => {
  const userContent = makeUserContent(50);
  const messages = [
    { role: 'system', content: '系统提示词' },
    { role: 'user', content: userContent },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }
  ];
  const r = ts.trimReadHistory(messages, ON);
  assert.equal(r.trimmedLines, 10, `应裁掉 10 条，实际 ${r.trimmedLines}`);
  const content = messages[1].content;
  assert.ok(!content.includes('第 0 条已读消息'), '最旧的历史应被裁掉');
  assert.ok(content.includes('第 49 条已读消息'), '最新的历史必须保留');
  assert.ok(content.includes('【未读信息】以下是你还没看过的最新消息：\n[12:01] 张三'), '当前触发批不能被裁');
  assert.ok(content.includes('【新已读信息】'), '新已读信息段不能被裁');
  assert.ok(content.includes('【当前时间】'), '其它段不能被裁');
  assert.equal(messages[0].content, '系统提示词', 'system 消息不能被改');
  assert.equal(messages[2].content, '{"ok":true}', 'tool 消息不能被改');
  // 段与段之间的空行分隔仍在（排版不被裁剪破坏）
  assert.ok(content.includes('[12:01] 张三(QQ:111)：新消息来了\n\n【新已读信息】'), '段间空行应保留');
});

check('字符预算：keepLast 很大时按 charBudget 从最旧开始裁', () => {
  const messages = [{ role: 'user', content: makeUserContent(50) }];
  const r = ts.trimReadHistory(messages, { ...ON, keepLast: 100, charBudget: 500 });
  assert.ok(r.trimmedLines > 0, '字符预算应触发裁剪');
  const body = messages[0].content.split('【已读信息】')[1].split('【未读信息】')[0];
  // body 含段头文字（约 50 字）与段尾空行；正文本身应压在 500 字预算内
  assert.ok(body.length <= 600, `已读段应压在预算附近（含段头），实际 ${body.length} 字`);
  assert.ok(messages[0].content.includes('第 49 条已读消息'), '最新的必须保留');
});

check('没有【已读信息】段 / 段内没有正文时不改内容', () => {
  const a = [{ role: 'user', content: '【未读信息】以下是你还没看过的最新消息：\n[12:01] 张三：hi' }];
  assert.deepEqual(ts.trimReadHistory(a, ON), { trimmedLines: 0, trimmedChars: 0 });
  const b = [{ role: 'user', content: '【已读信息】（暂无历史记录，这是你第一次参与这个会话）' }];
  const before = b[0].content;
  assert.deepEqual(ts.trimReadHistory(b, ON), { trimmedLines: 0, trimmedChars: 0 });
  assert.equal(b[0].content, before, '单行段头不能改');
});

// ── 2. 本地收尾判定（默认关闭、判据保守）─────────────────────────────────
const sendBatch = (over = {}) => ({
  newSent: [{ text: '在的，你说' }],
  calls: [{ function: { name: 'send_message', arguments: '{}' } }],
  results: [{ role: 'tool', content: '{"ok":true}' }],
  ...over
});
const POLICY_ON = { ...ON, localPolicy: true };

check('默认 localPolicy=false → 不干预（undefined）', () => {
  assert.equal(ts.canEndLocally({ batch: sendBatch() }, ON), undefined);
});
check('纯发送且无待执行工具 → 收尾', () => {
  const r = ts.canEndLocally({ batch: sendBatch() }, POLICY_ON);
  assert.equal(r?.shouldEnd, true);
  assert.match(r.reason, /无待执行工具/);
});
check('还有待执行工具 / 非发送类工具 / 有失败结果 / 没发消息 → 都不干预', () => {
  assert.equal(ts.canEndLocally({ batch: sendBatch({ calls: [1, 2].map(() => ({ function: { name: 'send_message' } })), results: [{ content: '{"ok":true}' }] }) }, POLICY_ON), undefined, '结果数少于调用数（还在跑）');
  assert.equal(ts.canEndLocally({ batch: sendBatch({ calls: [{ function: { name: 'web_search' } }] }) }, POLICY_ON), undefined, '检索类工具可能还有下文');
  assert.equal(ts.canEndLocally({ batch: sendBatch({ results: [{ content: '{"ok":false,"error":"发送失败"}' }] }) }, POLICY_ON), undefined, '失败结果留给模型重试');
  assert.equal(ts.canEndLocally({ batch: sendBatch({ newSent: [] }) }, POLICY_ON), undefined, '本轮没发消息');
  assert.equal(ts.canEndLocally({ batch: sendBatch({ newSent: [{ text: '你要不要试试？' }] }) }, POLICY_ON), undefined, '以问句收尾 = 在等回复');
});
check('关闭插件（enabled=false）→ 收尾判定不干预', () => {
  assert.equal(ts.canEndLocally({ batch: sendBatch() }, { ...POLICY_ON, enabled: false }), undefined);
});

// ── 3. hook 与能力接线（真实 setup/providers/hooks）──────────────────────
check('setup 后 hook 裁剪并记账，llm.usage 上报一次后清零', () => {
  ts.resetStats();
  ts.setup({ config: () => ({ ...ON, localPolicy: true }) });
  const messages = [{ role: 'user', content: makeUserContent(50) }];
  ts.hooks['before-llm-messages']({ messages, sessionId: 'sess-1' });
  assert.ok(!messages[0].content.includes('第 0 条已读消息'), 'hook 应原地裁剪');
  const usage = ts.providers['llm.usage']({ sessionId: 'sess-1' });
  assert.equal(usage.tokenSaverTrimmedLines, 10, '应上报裁掉的条数');
  assert.equal(ts.providers['llm.usage']({ sessionId: 'sess-1' }), undefined, '上报后应清零，不反复累加');
});

check('setup 后 reply.local-policy 能力按配置生效', () => {
  ts.setup({ config: () => ({ ...ON, localPolicy: true }) });
  assert.equal(ts.providers['reply.local-policy']({ batch: sendBatch() })?.shouldEnd, true);
  ts.setup({ config: () => ({ ...ON, localPolicy: false }) });
  assert.equal(ts.providers['reply.local-policy']({ batch: sendBatch() }), undefined);
});

check('关闭插件后 hook 不裁、能力不干预（等价没装）', () => {
  ts.resetStats();
  ts.setup({ config: () => ({ ...ON, enabled: false }) });
  const messages = [{ role: 'user', content: makeUserContent(50) }];
  const before = messages[0].content;
  ts.hooks['before-llm-messages']({ messages, sessionId: 'sess-2' });
  assert.equal(messages[0].content, before, '关闭后不应裁剪');
  assert.equal(ts.providers['reply.local-policy']({ batch: sendBatch() }), undefined);
  assert.equal(ts.providers['llm.usage']({ sessionId: 'sess-2' }), undefined);
});

// ── 4. 清单与实现一致 ────────────────────────────────────────────────────
check('plugin.json 声明与默认值一致（能力名 / hooks / keepLast=40）', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/token-saver/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.capabilities.sort(), ['llm.usage', 'reply.local-policy'].sort());
  assert.equal(manifest.settings.enabled, true);
  assert.equal(manifest.settings.keepLast, 40);
  assert.equal(manifest.settings.localPolicy, false, '收尾策略默认关闭（改变对话轮次，默认保守）');
});

if (fail === 0) {
  console.log(`\n全部通过 —— 通过 ${pass} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail}`);
process.exit(1);
