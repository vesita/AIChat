/**
 * 协议端数据面自检 + 外部协议端模式 + X1 平台闸（task-8）
 *
 * 来源：doc/audit/protocol-side-mismatch.md 的 S3/S5/S1/S2/U 组 + X1。
 *
 * 三个最关键的点（本文件逐条守）：
 *   1. onebot.httpOk/httpError 探针**只判「HTTP 数据面像不像 OneBot」**
 *      （状态码 / content-type / JSON 形状），**不判登录态/僵尸态** ——
 *      后者是 onebot.dataPathStatus() 的 get_csrf_token 判据（task-6）。
 *      → 静态守卫：judgeDataPath（登录态决策函数）不得引用本探针的任何字段。
 *   2. X1 是真崩溃：非 win32 上 spawn Windows 可执行文件且没有 error 监听
 *      ⇒ uncaughtException ⇒ 进程退出。修复 = 平台闸 400 + 所有 spawn 挂 error。
 *   3. /api/status 同时暴露僵尸字段（task-6）与 httpOk 字段（本次），并推 SSE。
 *
 * 全部用本地 stub（真 HTTP 服务 + 真 ws 服务）+ 真起 `node src/server.js`，
 * 打随机端口与临时数据目录 —— 不碰生产 NapCat（3001/3002）、不碰仓库内 data/。
 *
 * 负向对照（同一文件内，不依赖改源码）：
 *   · 把 status 里的 httpOk/httpError/diagnosis 打回修前形态（恒 true / 空串），
 *     「半通红灯」判据必须变 false —— 证明该断言能抓住本次修复被撤掉的情况。
 *   · 用子进程原样复刻修前代码（无 error 监听的 spawn）：必须 non-zero 退出；
 *     同样的 spawn 挂上 error 监听：必须正常退出 —— 证明 X1 的因果链。
 *
 * 运行：node test/protocol-diag-test.mjs
 * 注意：本文件起完整 app（会占用随机端口），不要与其它起 app 的测试同时跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createChecker, freePort, listen, sleep, waitFor } from './_harness.mjs';
import { PROTOCOL_MODE, resolveProtocolMode } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = createChecker('协议端数据面自检 + 外部协议端模式 + X1 平台闸');

// ── 本地 stub：OneBot HTTP API ────────────────────────────────────────────
//
// mode = 'ok'      ：get_login_info → 200 application/json，形状合法
// mode = 'forgejo' ：GET 到 303（跟随到 /forgejo/user/login）→ 404 text/plain。
//                    这正是现场 3000 端口 Forgejo 对 OneBot POST 的真实响应形态。
async function startHttpStub(mode = 'ok') {
  const requests = [];
  const server = http.createServer((req, res) => {
    const action = new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/^\/+/, '');
    requests.push(action);
    req.resume();
    req.on('end', () => {
      if (mode === 'ok' && action === 'get_login_info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试Bot' } }));
        return;
      }
      if (mode === 'ok' && action === 'send_group_msg') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }));
        return;
      }
      if (mode === 'forgejo') {
        if (action === 'get_login_info') {
          // Forgejo 对 OneBot 风格 POST 的实测行为：303 → 登录页 → 404 text/plain
          res.writeHead(303, { location: '/forgejo/user/login' });
          res.end();
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });
  });
  const port = await listen(server);
  return {
    server,
    port,
    requests,
    url: `http://127.0.0.1:${port}`,
    async close() { await new Promise((resolve) => server.close(resolve)); }
  };
}

// ── 本地 stub：OneBot WebSocket（只保持连接）──────────────────────────────
async function startWsStub() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  let closed = false;
  return {
    port: wss.address().port,
    async close() {
      if (closed) return;
      closed = true;
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wss.close(resolve));
    }
  };
}

// ── 真起 `node src/server.js`（临时数据目录 + 随机控制台端口）──────────────
async function startServer({ wsPort, httpUrl }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-proto-diag-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    snowluma: {
      dir: '',
      autoLaunch: false,
      mode: 'auto',
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      httpUrl
    },
    allowAllWhenEmpty: true
  }, null, 2));

  const env = {
    ...process.env,
    QQ_AGENT_PORT: String(port),
    QQ_AGENT_DATA_DIR: dataDir,
    NODE_ENV: 'production'
  };
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  const append = (chunk) => { logs = (logs + chunk).slice(-16000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1500) });
        return res.status === 200;
      } catch { return false; }
    }, 25000, '控制台监听 /api/status');
  } catch (error) {
    throw new Error(`${error?.message ?? error}\n--- 服务进程日志尾部 ---\n${logs.trim()}`);
  }

  return {
    child,
    port,
    dataDir,
    base,
    logs: () => logs,
    exited: () => exited,
    async status() {
      const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(5000) });
      assert.equal(res.status, 200, `/api/status 返回 ${res.status}`);
      return res.json();
    },
    async post(pathname) {
      const res = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(20000)
      });
      let body = null;
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body, text };
    },
    async stop() {
      if (!exited) {
        child.kill('SIGINT');
        const deadline = Date.now() + 10000;
        while (!exited && Date.now() < deadline) await sleep(50);
        if (!exited) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
}

/** 等到「WS 已连上」且 httpOk 达到期望值（探针是 WS open 后触发的，有先后）。 */
async function waitHttpOk(server, expected, label) {
  return waitFor(async () => {
    const status = await server.status();
    if (status.onebot?.connected !== true) return null;
    if (status.onebot?.httpOk !== expected) return null;
    return status;
  }, 25000, label);
}

/**
 * 「控制台能看到半通红灯」的唯一判据（测试内的观察函数）。
 * 修前形态：没有 httpOk 字段 / httpOk 恒 true / diagnosis 为空 ⇒ 恒 false。
 */
function hasHttpRedLight(status) {
  const onebot = status?.onebot || {};
  return onebot.connected === true
    && onebot.httpOk === false
    && typeof onebot.diagnosis === 'string'
    && onebot.diagnosis.includes('HTTP 数据面不可用');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-proto-diag-static-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  c.section('A. 协议端形态单一判定点（resolveProtocolMode，纯函数）');
  await c.check('外部模式：dir 为空 + autoLaunch=false + 非 3000 端口', () => {
    const r = resolveProtocolMode({
      dir: '', autoLaunch: false, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3002'
    });
    assert.equal(r.mode, PROTOCOL_MODE.EXTERNAL);
    assert.equal(r.wsPort, 3001);
    assert.equal(r.httpPort, 3002);
    assert.match(r.reason, /外部协议端/);
    return r.reason;
  });
  await c.check('有内置目录 ⇒ embedded（不会把内置模式误判成外部）', () => {
    const r = resolveProtocolMode({
      dir: '/opt/snowluma', autoLaunch: false, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3002'
    });
    assert.equal(r.mode, PROTOCOL_MODE.EMBEDDED);
    return r.reason;
  });
  await c.check('httpUrl 仍是出厂默认 3000（Forgejo）⇒ unconfigured，不判外部', () => {
    const r = resolveProtocolMode({
      dir: '', autoLaunch: false, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000'
    });
    assert.equal(r.mode, PROTOCOL_MODE.UNCONFIGURED);
    assert.match(r.reason, /3000/);
    return r.reason;
  });
  await c.check('显式 mode 覆盖自动判定（部署方钉死）', () => {
    const r = resolveProtocolMode({
      dir: '/opt/snowluma', autoLaunch: false, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000',
      explicitMode: 'external'
    });
    assert.equal(r.mode, PROTOCOL_MODE.EXTERNAL);
    return r.reason;
  });
  await c.check('配置自相矛盾（无 dir 却 autoLaunch=true）⇒ unconfigured', () => {
    const r = resolveProtocolMode({
      dir: '', autoLaunch: true, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3002'
    });
    assert.equal(r.mode, PROTOCOL_MODE.UNCONFIGURED);
    return r.reason;
  });

  // ══════════════════════════════════════════════════════════════════════
  c.section('B. 静态守卫：判据分工 / X1 结构 / SSE 接线');
  await c.check('judgeDataPath（登录态/僵尸态决策函数）不引用 HTTP 数据面探针', () => {
    const onebotSrc = fs.readFileSync(path.join(ROOT, 'src', 'onebot.js'), 'utf8');
    const start = onebotSrc.indexOf('export function judgeDataPath');
    assert.ok(start >= 0, 'src/onebot.js 里找不到 judgeDataPath');
    const end = onebotSrc.indexOf('\n}\n', start);
    assert.ok(end > start, 'judgeDataPath 函数体截取失败');
    const body = onebotSrc.slice(start, end);
    assert.doesNotMatch(body, /httpOk|httpError|httpProbe|httpDataPath|get_login_info/,
      '登录态/僵尸态决策引用了 HTTP 数据面探针结果（违反判据分工）');
    return `judgeDataPath ${body.length} 字符内无探针字段`;
  });
  await c.check('探针结论不写回 OneBotClient（不参与 connected 判定）', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.doesNotMatch(appSrc, /onebot\.(httpOk|httpError)\s*=/, '探针结论被写回 OneBotClient');
    // 注释必须写清分工（这是可读性要求，防止下一个人把探针结果接到 connected 上）
    assert.match(appSrc, /不判登录态/, 'app.js 缺少「探针不判登录态」的分工注释');
    return '无回写 + 分工注释在';
  });
  await c.check('SSE 接线：onDataPathChange → emit(onebot-datapath)', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.match(appSrc, /onebot\.onDataPathChange\(/, '没有订阅 onDataPathChange');
    assert.match(appSrc, /emit\('onebot-datapath'/, '没有推 SSE onebot-datapath');
    return '订阅 + 推送都在';
  });
  await c.check('X1 结构：routes.js 不再有裸 spawn Windows 可执行文件', () => {
    const routesSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    // 只看代码行（注释里允许写「曾经裸 spawn('explorer.exe')」这类沿革）。
    const codeLines = routesSrc.split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => {
        const t = line.trim();
        return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .map(({ line, i }) => `${i + 1}:${line}`);
    const code = codeLines.join('\n');
    assert.doesNotMatch(code, /spawn\('explorer\.exe'/, "仍有裸 spawn('explorer.exe')");
    assert.doesNotMatch(code, /spawn\('cmd\.exe'/, "仍有裸 spawn('cmd.exe')");
    assert.match(routesSrc, /platformCanOpenNativeUi/, '缺少平台闸');
    assert.match(routesSrc, /child\.on\('error'/, 'spawn 出口没有 error 监听');
    return '唯一出口 spawnDetached + 平台闸';
  });

  // ══════════════════════════════════════════════════════════════════════
  c.section('C. 场景①：正常 OneBot（200 JSON）⇒ httpOk=true');
  {
    const wsStub = await startWsStub();
    const httpStub = await startHttpStub('ok');
    const app = await startServer({ wsPort: wsStub.port, httpUrl: httpStub.url });
    try {
      const status = await waitHttpOk(app, true, '正常 OneBot：WS 已连 + httpOk=true');
      await c.check('httpOk=true 且 httpError 为空', () => {
        assert.equal(status.onebot.httpOk, true);
        assert.equal(status.onebot.httpError, '');
        return `httpProbeUrl=${status.onebot.httpProbeUrl}`;
      });
      await c.check('HTTP 探针确实打的是配置里的 httpUrl + /get_login_info', () => {
        assert.equal(status.onebot.httpProbeUrl, `${httpStub.url}/get_login_info`);
        assert.ok(httpStub.requests.includes('get_login_info'));
        return `${httpStub.url}/get_login_info`;
      });
      await c.check('/api/status 同时带僵尸字段与 httpOk 字段（task-3 接线）', () => {
        const ob = status.onebot;
        assert.ok(['unknown', 'ok', 'zombie', 'unreachable'].includes(ob.dataPathState), `dataPathState=${ob.dataPathState}`);
        assert.ok(ob.dataPathOk === null || typeof ob.dataPathOk === 'boolean', 'dataPathOk 三义（null=未探过）');
        assert.equal(typeof ob.dataPathReason, 'string');
        assert.ok(ob.lastProbeAt === null || typeof ob.lastProbeAt === 'number');
        assert.ok(ob.lastInboundAt === null || typeof ob.lastInboundAt === 'number');
        assert.equal(typeof ob.probeCount, 'number');
        assert.equal(typeof ob.httpOk, 'boolean');
        assert.equal(typeof ob.httpError, 'string');
        return `state=${ob.dataPathState} ok=${ob.dataPathOk} probeCount=${ob.probeCount} httpOk=${ob.httpOk}`;
      });
      await c.check('协议端形态投影到 /api/status.protocol（外部模式）', () => {
        assert.equal(status.protocol.mode, PROTOCOL_MODE.EXTERNAL, JSON.stringify(status.protocol));
        assert.equal(status.protocol.httpPort, httpStub.port);
        return status.protocol.reason;
      });
    } finally {
      await app.stop();
      await httpStub.close();
      await wsStub.close();
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  c.section('D. 场景②：WS 绿 / HTTP 假 Forgejo（303→404 text/plain）⇒ 红灯');
  {
    const wsStub = await startWsStub();
    const httpStub = await startHttpStub('forgejo');
    const app = await startServer({ wsPort: wsStub.port, httpUrl: httpStub.url });
    try {
      const status = await waitHttpOk(app, false, '半通：WS 已连但 httpOk=false');
      await c.check('半通形态：connected=true 且 httpOk=false（区分于全部正常）', () => {
        assert.equal(status.onebot.connected, true);
        assert.equal(status.onebot.httpOk, false);
        return `connected=true httpOk=false`;
      });
      await c.check('httpError 含实际 URL + 404 + content-type + 响应前 200 字符', () => {
        const err = status.onebot.httpError;
        assert.ok(err.includes(httpStub.url), `httpError 缺实际 URL：${err}`);
        assert.ok(err.includes('404'), `httpError 缺状态码 404：${err}`);
        assert.match(err, /text\/plain/, `httpError 缺 content-type：${err}`);
        assert.ok(err.includes('Not Found'), `httpError 缺响应体片段：${err}`);
        return err;
      });
      await c.check('诊断文案把半通升为控制台可见红灯', () => {
        assert.match(status.onebot.diagnosis, /HTTP 数据面不可用/);
        assert.match(status.onebot.diagnosis, /snowluma\.httpUrl/);
        assert.equal(hasHttpRedLight(status), true);
        return status.onebot.diagnosis;
      });
      await c.check('负向对照：把 status 打回修前形态（httpOk 恒 true / diagnosis 空）⇒ 红灯判据失败', () => {
        const legacy = JSON.parse(JSON.stringify(status));
        legacy.onebot.httpOk = true;
        legacy.onebot.httpError = '';
        legacy.onebot.diagnosis = '';
        assert.equal(hasHttpRedLight(legacy), false,
          '修前形态也判成红灯 —— 说明这个断言根本区分不出本次修复');
        return 'legacy(httpOk=true, diagnosis="") ⇒ false；实际 ⇒ true';
      });
      await c.check('外部模式：/api/snowluma/{launch,stop} 返回 409 + 说明', async () => {
        const launch = await app.post('/api/snowluma/launch');
        assert.equal(launch.status, 409, `launch 返回 ${launch.status}：${launch.text.slice(0, 200)}`);
        assert.match(String(launch.body.error), /外部协议端/);
        const stop = await app.post('/api/snowluma/stop');
        assert.equal(stop.status, 409, `stop 返回 ${stop.status}：${stop.text.slice(0, 200)}`);
        assert.match(String(stop.body.error), /外部协议端/);
        return `launch=${launch.status} stop=${stop.status}`;
      });
      await c.check('外部模式断线诊断指向容器，不再说「SnowLuma 未运行/页签」', async () => {
        // 断掉 WS 让 connected 变 false（stub 关掉所有客户端）
        await wsStub.close();
        const deadline = Date.now() + 8000;
        let disconnected = null;
        while (Date.now() < deadline) {
          const s = await app.status();
          if (s.onebot.connected === false) { disconnected = s; break; }
          await sleep(150);
        }
        assert.ok(disconnected, 'WS 关闭后 onebot.connected 没有变 false');
        const diagnosis = String(disconnected.onebot.diagnosis);
        assert.doesNotMatch(diagnosis, /SnowLuma 页签/, `外部模式诊断仍指向 SnowLuma 页签：${diagnosis}`);
        assert.match(diagnosis, /napcat|协议端（NapCat 容器）/i, `外部模式诊断没指向容器：${diagnosis}`);
        return diagnosis;
      });
      await c.check('X1：非 win32 调 /api/open-data-dir 返回 400 且进程仍存活', async () => {
        const r = await app.post('/api/open-data-dir');
        assert.equal(r.status, 400, `返回 ${r.status}：${r.text.slice(0, 200)}`);
        assert.match(String(r.body.error), /非 Windows/, `说明里没有平台信息：${r.text.slice(0, 200)}`);
        assert.ok(String(r.body.error).includes(app.dataDir), '说明里没有目标路径');
        // 真存活：同一进程还能回 /api/status（此时 WS 已被上一条关掉，不再要求 connected）
        const after = await app.status();
        assert.notEqual(after.onebot?.httpOk, undefined, '后续 /api/status 少了 httpOk 字段');
        assert.equal(app.child.exitCode, null, `进程已退出（exitCode=${app.child.exitCode}）`);
        return `open-data-dir=400，随后 /api/status=200，进程存活`;
      });
      await c.check('X1：/api/snowluma/open-folder 非 win32 返回 400（不是 500/崩溃）', async () => {
        const r = await app.post('/api/snowluma/open-folder');
        assert.equal(r.status, 400, `返回 ${r.status}：${r.text.slice(0, 200)}`);
        assert.match(String(r.body.error), /非 Windows/);
        assert.equal(app.child.exitCode, null, '进程已退出');
        return `open-folder=400，进程存活`;
      });
      await c.check('S5：手工发送失败的错误信息带实际 URL + 状态码 + 响应片段', async () => {
        const res = await fetch(`${app.base}/api/chats/group_123/test-send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '探针测试' }),
          signal: AbortSignal.timeout(20000)
        });
        const body = await res.json();
        assert.equal(res.status, 502, `返回 ${res.status}：${JSON.stringify(body).slice(0, 300)}`);
        const err = String(body.error);
        assert.ok(err.includes(httpStub.url), `发送错误缺实际 URL：${err}`);
        assert.ok(err.includes('404'), `发送错误缺状态码：${err}`);
        assert.ok(err.includes('get_login_info') || err.includes('Not Found'), `发送错误缺响应片段：${err}`);
        return err;
      });
      await c.check('负向对照：去掉本次 S5 增强（剥掉括号内诊断）⇒ 上述断言失败', () => {
        // 修前的错误形态：`OneBot send_group_msg HTTP 404`（裸状态码，无 URL/响应片段）
        const legacyError = 'OneBot send_group_msg HTTP 404';
        const hasDiagnosis = legacyError.includes(httpStub.url) && /Not Found|get_login_info/.test(legacyError);
        assert.equal(hasDiagnosis, false, '修前错误形态也满足断言 —— 断言区分不出修复');
        return `legacy="${legacyError}" ⇒ 无 URL/无响应片段`;
      });
    } finally {
      await app.stop();
      await httpStub.close();
      await wsStub.close().catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  c.section('E. 场景③：HTTP 完全打不通 ⇒ httpOk=false，且不被当成僵尸态');
  {
    const wsStub = await startWsStub();
    const deadPort = await freePort();   // 拿号后不监听：连接必被拒
    const app = await startServer({ wsPort: wsStub.port, httpUrl: `http://127.0.0.1:${deadPort}` });
    try {
      const status = await waitHttpOk(app, false, 'HTTP 不通：httpOk=false');
      await c.check('不可达 ⇒ httpOk=false，httpError 含实际 URL 与不可达原因', () => {
        assert.equal(status.onebot.httpOk, false);
        const err = String(status.onebot.httpError);
        assert.ok(err.includes(`http://127.0.0.1:${deadPort}`), `缺实际 URL：${err}`);
        assert.match(err, /不可达/);
        assert.match(err, /ECONNREFUSED|请求失败|fetch/i);
        return err;
      });
      await c.check('HTTP 不通不是僵尸判据：dataPathState 不是 zombie', () => {
        assert.notEqual(status.onebot.dataPathState, 'zombie',
          `HTTP 探针把状态判成了僵尸（违反判据分工）：${status.onebot.dataPathReason}`);
        const ob = status.onebot;
        return `dataPathState=${ob.dataPathState} dataPathOk=${ob.dataPathOk}（僵尸判据在 task-6 的 get_csrf_token）`;
      });
      await c.check('WS 仍连着 ⇒ 半通红灯可见（connected=true, httpOk=false）', () => {
        assert.equal(status.onebot.connected, true);
        assert.equal(hasHttpRedLight(status), true);
        return status.onebot.diagnosis;
      });
    } finally {
      await app.stop();
      await wsStub.close();
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  c.section('F. X1 负向对照：无 error 监听的 spawn 真的会让子进程崩溃');
  await c.check('修前代码（spawn 无 error 监听）⇒ 子进程 uncaughtException 退出', async () => {
    const result = await runNodeSnippet(
      "const {spawn}=require('node:child_process');"
      + "spawn('explorer.exe',['/tmp'],{detached:true,stdio:'ignore'}).unref();"
      + 'setTimeout(()=>{},2000);'
    );
    assert.notEqual(result.code, 0, `修前形态居然正常退出（code=${result.code}）—— 负向对照不成立`);
    assert.match(result.stderr, /ENOENT|explorer/i, `stderr 里没有 spawn 失败痕迹：${result.stderr.slice(0, 300)}`);
    return `exit=${result.code}，stderr 含 spawn 失败`;
  });
  await c.check('修复形态（error 监听已挂）⇒ 同样的 spawn 不崩', async () => {
    const result = await runNodeSnippet(
      "const {spawn}=require('node:child_process');"
      + "const c=spawn('explorer.exe',['/tmp'],{detached:true,stdio:'ignore'});"
      + "c.on('error',()=>{});c.unref();"
      + 'setTimeout(()=>process.exit(0),500);'
    );
    assert.equal(result.code, 0, `修复形态仍崩溃（code=${result.code}）：${result.stderr.slice(0, 300)}`);
    return 'exit=0';
  });

  return c.finish();
}

/** 跑一段 node -e 代码，timeout 到点整组杀掉。 */
function runNodeSnippet(code, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

main()
  .then((ok) => { process.exit(ok ? 0 : 1); })
  .catch((error) => {
    console.error('测试自身异常:', error);
    process.exit(1);
  });
