// 僵尸态自检（Z-1）：分层探活 + 三态暴露 + 不自动重启
//
// 背景（2026-10-20 线上实测）：QQ 服务端作废登录态后，WS 还连着、心跳照发，
// `get_login_info` / `get_status` 仍返回 online:true（**会撒谎**），只有走服务器
// 往返的 `get_csrf_token` 才可靠；僵尸态下 `get_friend_list` 同时返回 []。
//
// 本测试用本地 stub（真 HTTP 服务 + 真 ws 服务）覆盖：
//   · 四场景：ok / csrf failed（僵尸）/ 好友空（僵尸佐证）/ HTTP 不通（unreachable）
//   · 不变量 1：消息持续入站期间探活请求数 = 0；心跳不算入站活性
//   · 不变量 2：判据只用 get_csrf_token + get_friend_list，探活从不请求 login_info
//   · 不变量 3：ok / zombie / unreachable 三态都能从 dataPathStatus() 读到
//   · 不变量 4：判出僵尸后不重连、不断开、不触发任何恢复动作
//   · 不变量 5：探活端点（probeHttpUrl）与 fetch 实现（probeFetch）可注入
//   · 负向对照：桩里 login_info 返回 online:true 而 csrf failed ⇒ 当前实现判 zombie；
//     若改用 login_info 判据（测试内反事实实现）会判 ok —— 证明为什么不能那么写
//
// 全部打本地 stub，绝不打真 QQ 接口。
// 运行：node test/zombie-probe-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createChecker, freePort, listen, sleep, waitFor } from './_harness.mjs';
import {
  OneBotClient,
  DATA_PATH_STATE,
  PROBE_IDLE_MS,
  PROBE_INTERVAL_MS,
  isInboundMessageEvent,
  judgeDataPath,
  shouldProbeDataPath
} from '../src/onebot.js';

const c = createChecker('僵尸态自检（分层探活 + 三态 + 不自动重启）');

// ── 本地 stub：OneBot HTTP API ────────────────────────────────────────────
//
// mode = ok        ：csrf ok（token 非空）+ 好友 2 条
// mode = zombie    ：csrf failed（信息与线上一致）+ 好友 [] + login_info 仍 online:true
// mode = friend_empty：csrf ok，但好友列表为空（佐证判据单独覆盖）
//
// 所有请求路径都记录下来：断言「探活到底打了哪些端点」靠它。
async function startOneBotStub(mode = 'ok') {
  const requests = [];
  const server = http.createServer((req, res) => {
    const action = String(req.url || '').replace(/^\//, '');
    requests.push(action);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const ok = (data) => reply({ status: 'ok', retcode: 0, data });
      const failed = (message) => reply({ status: 'failed', retcode: 1404, data: null, message });
      if (action === 'get_csrf_token') {
        // 线上僵尸态原文：{"status":"failed","message":"getClientKey Error"}
        return mode === 'zombie' ? failed('getClientKey Error') : ok('csrf-token-abc123');
      }
      if (action === 'get_friend_list') {
        if (mode === 'zombie' || mode === 'friend_empty') return ok([]);
        return ok([{ user_id: 10001, nickname: '好友一' }, { user_id: 10002, nickname: '好友二' }]);
      }
      if (action === 'get_login_info') {
        // ⚠️ 关键：任何场景下它都说 online:true —— 这正是不能拿它当判据的原因。
        return ok({ user_id: 9999, nickname: '测试Bot', online: true });
      }
      return reply({ status: 'failed', retcode: 404, data: null, message: `unknown action ${action}` });
    });
  });
  const port = await listen(server);
  return { server, port, requests, url: `http://127.0.0.1:${port}` };
}

// ── 本地 stub：OneBot WebSocket（只推事件，不发消息）──────────────────────
async function startWsStub() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const clients = new Set();
  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    push(event) {
      for (const socket of clients) {
        try { socket.send(JSON.stringify(event)); } catch { /* 连接已断：忽略 */ }
      }
    },
    async close() {
      for (const socket of clients) {
        try { socket.terminate(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wss.close(resolve));
    }
  };
}

/**
 * 起一套现场：stub HTTP + stub WS + 真 OneBotClient（探活参数缩到毫秒级，
 * 只为把等待缩短；默认值仍是规范里的 10 分钟 / 5 分钟，见策略断言）。
 */
async function startCtx({ mode = 'ok', deadHttp = false, probeHttpUrl = undefined } = {}) {
  const stub = await startOneBotStub(mode);
  const ws = await startWsStub();
  const deadPort = await freePort();
  const httpUrl = deadHttp ? `http://127.0.0.1:${deadPort}` : stub.url;
  const probeHttp = probeHttpUrl === undefined ? httpUrl : probeHttpUrl;

  // fetch 注入点：记录探活请求路径，再转发给真 fetch（不打真 QQ，目标都是本地 stub）。
  const probeRequests = [];
  const probeFetch = async (url, opts) => {
    probeRequests.push(String(url).replace(/^https?:\/\/[^/]+\//, ''));
    return fetch(url, opts);
  };

  const client = new OneBotClient({
    wsUrl: ws.url,
    httpUrl,
    probeHttpUrl: probeHttp,
    probeFetch,
    probeIdleMs: 80,
    probeIntervalMs: 60,
    probeTimeoutMs: 800,
    onEvent: () => {}
  });
  const transitions = [];
  client.onDataPathChange((snapshot) => transitions.push(snapshot));
  client.connect();
  await waitFor(() => client.connected, 3000, 'WS 连接建立');
  return {
    stub, ws, client, probeRequests, transitions,
    async cleanup() {
      client.close();
      await sleep(60);
      await ws.close();
      await new Promise((resolve) => stub.server.close(resolve));
    }
  };
}

function waitState(client, state, timeoutMs = 3000) {
  return waitFor(() => {
    const snapshot = client.dataPathStatus();
    return snapshot.state === state ? snapshot : null;
  }, timeoutMs, `dataPathState=${state}`);
}

/** 只在本次断言里收集 console.warn，用来核对「固定格式告警行」。 */
function captureWarnings() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map((v) => String(v)).join(' ')); };
  return { lines, restore: () => { console.warn = original; } };
}

/**
 * 反事实判据（只存在于测试里）：如果拿 get_login_info 的 online 字段当判据，
 * 这个现场会被判成什么。用来钉住「为什么不能这么写」。
 */
function judgeByLoginInfoOnly(loginInfo) {
  if (!loginInfo) return DATA_PATH_STATE.UNREACHABLE;
  return loginInfo.online === true ? DATA_PATH_STATE.OK : DATA_PATH_STATE.ZOMBIE;
}

// ══ 一、不变量 1：探活时机（策略层，真实默认值） ═══════════════════════════

c.section('不变量 1：只在可疑时探活（默认值即规范）');

await c.check('默认值：静默 10 分钟才算可疑，探活周期 5 分钟', () => {
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1' });
  assert.equal(client.probeIdleMs, PROBE_IDLE_MS);
  assert.equal(client.probeIntervalMs, PROBE_INTERVAL_MS);
  assert.equal(PROBE_IDLE_MS, 600000);
  assert.ok(PROBE_INTERVAL_MS >= 300000, `探活周期必须 ≥5 分钟，实际 ${PROBE_INTERVAL_MS}ms`);
});

await c.check('消息每 10 秒一条、持续 1 小时 ⇒ 一次探活都不该发生', () => {
  let probes = 0;
  for (let now = 10000; now <= 3600000; now += 10000) {
    const should = shouldProbeDataPath({
      now, connectedAt: 0, lastInboundAt: now, lastProbeAt: 0,
      idleMs: PROBE_IDLE_MS, intervalMs: PROBE_INTERVAL_MS
    });
    if (should) probes++;
  }
  assert.equal(probes, 0, `消息流动期间探活了 ${probes} 次`);
});

await c.check('静默满 10 分钟才探；探后 5 分钟内不再探（周期下限）', () => {
  // 生产里 connectedAt 是真实 epoch 毫秒（永远 > 0），这里用真实量级避免踩 0 的哨兵值
  const connectedAt = 1_700_000_000_000;
  const base = { connectedAt, lastInboundAt: 0, idleMs: PROBE_IDLE_MS, intervalMs: PROBE_INTERVAL_MS };
  assert.equal(shouldProbeDataPath({ ...base, now: connectedAt + 599000 }), false, '599s 不该探');
  assert.equal(shouldProbeDataPath({ ...base, now: connectedAt + 600000 }), true, '600s 该探');
  assert.equal(shouldProbeDataPath({ ...base, now: connectedAt + 899000, lastProbeAt: connectedAt + 600000 }), false, '探后 299s 不该再探');
  assert.equal(shouldProbeDataPath({ ...base, now: connectedAt + 900000, lastProbeAt: connectedAt + 600000 }), true, '探后 300s 可再探');
  assert.equal(shouldProbeDataPath({ now: 1e12 }), false, '没有连接起点时不探');
});

await c.check('心跳（meta_event）不算入站活性；只有 message 才算', () => {
  assert.equal(isInboundMessageEvent({ post_type: 'message' }), true);
  assert.equal(isInboundMessageEvent({ post_type: 'message_sent' }), false);
  assert.equal(isInboundMessageEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), false);
  assert.equal(isInboundMessageEvent({ post_type: 'notice' }), false);
  assert.equal(isInboundMessageEvent(null), false);
});

await c.check('只有心跳在发 ⇒ 照样探活（僵尸态心跳照发，不能当活性）', async () => {
  const ctx = await startCtx({ mode: 'ok' });
  try {
    const start = Date.now();
    while (Date.now() - start < 500) {
      ctx.ws.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: Date.now(), self_id: 9999, status: { online: true, good: true } });
      await sleep(20);
    }
    assert.ok(ctx.probeRequests.length > 0, '只有心跳时也必须探活，否则僵尸态永远发现不了');
    const snapshot = await waitState(ctx.client, DATA_PATH_STATE.OK);
    return `心跳期间已探活 ${ctx.probeRequests.length} 次，判定 ${snapshot.state}`;
  } finally {
    await ctx.cleanup();
  }
});

// ══ 二、不变量 2/3：四场景判据 + 三态可读 ═══════════════════════════════════

c.section('四场景：ok / csrf failed / 好友空 / HTTP 不通');

await c.check('场景 ok：csrf ok + 好友非空 ⇒ state=ok, ok=true', async () => {
  const ctx = await startCtx({ mode: 'ok' });
  try {
    const snapshot = await waitState(ctx.client, DATA_PATH_STATE.OK);
    assert.equal(snapshot.ok, true);
    assert.match(snapshot.reason, /get_csrf_token ok/);
    assert.match(snapshot.reason, /好友 2 条/);
    assert.deepEqual(ctx.probeRequests.slice(0, 2), ['get_csrf_token', 'get_friend_list'],
      `探活应依次请求两个判据端点，实际：${JSON.stringify(ctx.probeRequests)}`);
    assert.ok(!ctx.probeRequests.includes('get_login_info'), '探活不得请求 get_login_info');
    assert.ok(ctx.transitions.some((t) => t.state === DATA_PATH_STATE.OK), '状态变化应能推给监听方');
    // 正常路径（open 时拉 selfInfo）仍然用 get_login_info —— 它只提供身份，不参与判定
    assert.ok(ctx.stub.requests.includes('get_login_info'), 'open 时仍会拉一次身份信息');
    return `state=${snapshot.state} 探活请求=[${ctx.probeRequests.slice(0, 2).join(',')}]`;
  } finally {
    await ctx.cleanup();
  }
});

await c.check('场景 csrf failed（线上僵尸态原文）⇒ state=zombie, ok=false', async () => {
  const warns = captureWarnings();
  const ctx = await startCtx({ mode: 'zombie' });
  try {
    const snapshot = await waitState(ctx.client, DATA_PATH_STATE.ZOMBIE);
    assert.equal(snapshot.ok, false);
    assert.match(snapshot.reason, /get_csrf_token failed/);
    assert.match(snapshot.reason, /getClientKey Error/);
    // 第一判据失败后不再打好友列表：不给协议端加负担
    assert.ok(!ctx.probeRequests.includes('get_friend_list'), 'csrf 已 failed 时不该再请求好友列表');
    assert.ok(ctx.probeRequests.every((a) => a === 'get_csrf_token'), `探活端点只有 csrf：${JSON.stringify(ctx.probeRequests)}`);
    assert.ok(warns.lines.some((line) => line.includes('[onebot][probe]') && line.includes('僵尸')),
      `缺少固定格式告警行，实际：${JSON.stringify(warns.lines)}`);
    assert.ok(ctx.transitions.some((t) => t.state === DATA_PATH_STATE.ZOMBIE), 'zombie 三态应能推给监听方');
    return `state=${snapshot.state} 探活请求=[${[...new Set(ctx.probeRequests)].join(',')}]`;
  } finally {
    warns.restore();
    await ctx.cleanup();
  }
});

await c.check('场景好友列表为空 ⇒ state=zombie（csrf 佐证判据）', async () => {
  const warns = captureWarnings();
  const ctx = await startCtx({ mode: 'friend_empty' });
  try {
    const snapshot = await waitState(ctx.client, DATA_PATH_STATE.ZOMBIE);
    assert.equal(snapshot.ok, false);
    assert.match(snapshot.reason, /get_friend_list 为空/);
    assert.deepEqual(ctx.probeRequests.slice(0, 2), ['get_csrf_token', 'get_friend_list']);
    assert.ok(warns.lines.some((line) => line.includes('[onebot][probe]')), '缺少固定格式告警行');
    return `state=${snapshot.state} reason=${snapshot.reason}`;
  } finally {
    warns.restore();
    await ctx.cleanup();
  }
});

await c.check('场景 OneBot HTTP 打不通 ⇒ state=unreachable, ok=false', async () => {
  const warns = captureWarnings();
  const ctx = await startCtx({ mode: 'ok', deadHttp: true });
  try {
    const snapshot = await waitState(ctx.client, DATA_PATH_STATE.UNREACHABLE);
    assert.equal(snapshot.ok, false);
    assert.match(snapshot.reason, /打不通/);
    assert.equal(ctx.probeRequests[0], 'get_csrf_token', `第一个探活请求应是第一判据，实际：${JSON.stringify(ctx.probeRequests)}`);
    assert.ok(warns.lines.some((line) => line.includes('[onebot][probe]') && line.includes('不可达')), '缺少不可达告警行');
    assert.ok(ctx.transitions.some((t) => t.state === DATA_PATH_STATE.UNREACHABLE), 'unreachable 三态应能推给监听方');
    return `state=${snapshot.state} reason=${snapshot.reason.slice(0, 40)}…`;
  } finally {
    warns.restore();
    await ctx.cleanup();
  }
});

// ══ 三、不变量 5：端点与 fetch 可注入 ═══════════════════════════════════════

c.section('不变量 5：探活端点 / fetch 可注入');

await c.check('httpUrl 打不通、probeHttpUrl 指向可用 stub ⇒ 探活走注入的端点', async () => {
  const probeStub = await startOneBotStub('ok');
  try {
    // httpUrl 故意指向死端口：如果探活偷用了 httpUrl，这里会判 unreachable
    const ctx = await startCtx({ mode: 'ok', deadHttp: true, probeHttpUrl: probeStub.url });
    try {
      const snapshot = await waitState(ctx.client, DATA_PATH_STATE.OK);
      assert.equal(snapshot.ok, true);
      assert.deepEqual([...new Set(probeStub.requests)].slice(0, 2), ['get_csrf_token', 'get_friend_list']);
      assert.ok(!probeStub.requests.includes('get_login_info'), '注入端点只该收到探活请求');
      return `注入端点收到 [${[...new Set(probeStub.requests)].join(',')}]，判定 ${snapshot.state}`;
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await new Promise((resolve) => probeStub.server.close(resolve));
  }
});

// ══ 四、不变量 1 集成断言：消息流动期间零探活 ══════════════════════════════

c.section('不变量 1（集成）：消息持续入站期间 0 探活请求');

await c.check('消息每 25ms 一条持续 800ms ⇒ 探活请求数 = 0；停流后立即补探', async () => {
  const ctx = await startCtx({ mode: 'ok' });
  try {
    const start = Date.now();
    while (Date.now() - start < 800) {
      ctx.ws.push({
        post_type: 'message', message_type: 'group', self_id: 9999,
        group_id: 100, user_id: 200, message_id: Date.now(),
        raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }]
      });
      await sleep(25);
    }
    assert.equal(ctx.probeRequests.length, 0,
      `消息流动期间探活了 ${ctx.probeRequests.length} 次（请求：${JSON.stringify(ctx.probeRequests)}）`);
    assert.equal(ctx.client.dataPathStatus().state, DATA_PATH_STATE.UNKNOWN, '还没探过时状态应是 unknown');
    // 停止入站：静默超过 idle（80ms 测试值）后必须探活，否则僵尸态永远发现不了
    const snapshot = await waitState(ctx.client, DATA_PATH_STATE.OK);
    assert.ok(ctx.probeRequests.length > 0, '静默之后必须探活');
    return `流动期探活 0 次 → 停流后探活 ${ctx.probeRequests.length} 次，判定 ${snapshot.state}`;
  } finally {
    await ctx.cleanup();
  }
});

// ══ 五、不变量 4：不自动重启 / 不自动扫码 ══════════════════════════════════

c.section('不变量 4：只观测上报，不自动重启');

await c.check('判出僵尸后不重连、不断开、不触发任何恢复动作', async () => {
  const ctx = await startCtx({ mode: 'zombie' });
  let reconnectCalls = 0;
  const realReconnect = ctx.client.reconnect.bind(ctx.client);
  ctx.client.reconnect = () => { reconnectCalls++; return realReconnect(); };
  try {
    await waitState(ctx.client, DATA_PATH_STATE.ZOMBIE);
    await sleep(250);   // 多跑几个探活节拍，给"自动恢复"留出发生的机会
    assert.equal(reconnectCalls, 0, '探活发现僵尸态不得自动重连');
    assert.equal(ctx.client.connected, true, '不得主动断开连接');
    assert.ok(ctx.client.socket, 'WS 连接必须保持');
    const actions = new Set(ctx.stub.requests);
    for (const forbidden of ['set_restart', 'restart', 'get_status', 'login', 'logout', 'set_login_info', 'clean_cache']) {
      assert.ok(!actions.has(forbidden), `不应触发恢复/扫码动作：${forbidden}`);
    }
    return `reconnect 调用 0 次，connected=${ctx.client.connected}，桩收到的动作=[${[...actions].join(',')}]`;
  } finally {
    await ctx.cleanup();
  }
});

// ══ 六、负向对照：login_info 会撒谎 ════════════════════════════════════════

c.section('负向对照：把判据换成 get_login_info 会把僵尸判成 ok');

await c.check('桩里 login_info=online:true 而 csrf failed ⇒ 当前实现判 zombie；换 login_info 判据则判 ok', async () => {
  const ctx = await startCtx({ mode: 'zombie' });
  try {
    // 直接问桩：这个"僵尸现场"里 login_info 到底怎么回答
    const loginInfoResponse = await fetch(`${ctx.stub.url}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const loginInfo = (await loginInfoResponse.json()).data;
    assert.equal(loginInfo.online, true, '桩里 login_info 必须撒谎成 online:true');

    // 当前实现（get_csrf_token 第一判据）在同一现场判 zombie
    const snapshot = await waitState(ctx.client, DATA_PATH_STATE.ZOMBIE);
    assert.equal(snapshot.ok, false);

    // 反事实：若当初拿 login_info 的 online 当判据，同一现场会被判成 ok
    const counterfactual = judgeByLoginInfoOnly(loginInfo);
    assert.equal(counterfactual, DATA_PATH_STATE.OK, '反事实判据应把僵尸判成 ok（这正是它不可用的原因）');

    // 当前实现的探活确实没碰 login_info / get_status
    assert.ok(!ctx.probeRequests.includes('get_login_info'), '探活请求里不得出现 get_login_info');
    assert.ok(!ctx.probeRequests.includes('get_status'), '探活请求里不得出现 get_status');

    console.log(`    负向对照：login_info → online=${loginInfo.online}`);
    console.log(`    负向对照：若以 login_info 为判据 = ${counterfactual}（会把故障抹平）`);
    console.log(`    负向对照：当前实现（csrf 第一判据）= ${snapshot.state}（${snapshot.reason}）`);
    console.log(`    负向对照：探活实际请求 = [${[...new Set(ctx.probeRequests)].join(',')}]`);
    return `login_info 判据=${counterfactual} vs 当前实现=${snapshot.state}`;
  } finally {
    await ctx.cleanup();
  }
});

await c.check('静态守卫：判据函数不得引用会撒谎的 login_info / get_status / online', () => {
  const source = judgeDataPath.toString();
  assert.ok(!/get_login_info|get_status|online/.test(source),
    `judgeDataPath 源码里出现了撒谎判据：${source.slice(0, 300)}`);
});

// ══ 汇总 ═════════════════════════════════════════════════════════════════

const ok = c.finish();
if (ok) console.log('\n僵尸态自检：四场景 + 五条不变量 + 负向对照全部通过 ✅');
