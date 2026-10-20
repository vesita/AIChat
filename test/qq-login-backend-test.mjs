// /api/qq-login/* 后端模块测试（离线，不碰真 NapCat / 不碰生产数据）。
//
// 被测对象：src/qq-login.js（NapCat WebUI 客户端 + 10 态状态机 + 五个 handler）。
// 外部世界全部替换：本地 stub WebUI 顶替 127.0.0.1:6099；时钟注入；令牌文件写临时目录。
//
// 覆盖（对应 doc/audit/console-access-plan.md §15.1 与 task-10 验收口径）：
//   - 10 个 phase 各一次断言
//   - fail-closed：契约不符 → 502 NAPCAT_BAD_RESPONSE（不是拿默认值糊过去）
//   - 回环门：非回环 403；负向对照（去掉门 → 放行）
//   - 负向对照：stub 状态变化 → status 跟着变（证明不是写死）
//   - 二维码接口返回真图：content-type + <svg + 长度 > 0，且用 resvg/zbarimg 真解码回原文
//   - 幂等 / 冷却 / 取消 / 已登录 409
//   - 令牌与二维码内容不泄漏：所有响应体 + 日志全局扫描
//   - 端到端：真 createApp + 真路由上验证「未配 token 放行 / 无 token 401 / 旧 marker 401 / 正确 token 200」
//
// 运行：node test/qq-login-backend-test.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// ── 断言收集器（与 test/_harness.mjs 同风格，本文件不依赖它的 bootApp）──────
let pass = 0, fail = 0, skipped = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}
function section(name) { console.log(`\n=== ${name} ===`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stub NapCat WebUI ────────────────────────────────────────────────────
// 契约照 doc/audit/console-access-plan.md §8：
//   POST /api/auth/login            {hash} → {code:0,data:{Credential}}
//   POST /api/QQLogin/CheckLoginStatus   → {code:0,data:{isLogin,isOffline,loginPhase,qrcodeurl,loginError,...}}
//   POST /api/QQLogin/GetQQLoginQrcode   → {code:0,data:{qrcode}} / {code:-1,message:"QQ Is Logined"|"QRCode Get Error"}
//   POST /api/QQLogin/RefreshQRcode      → {code:0,data:{qrcodeurl}} 或 {code:0,data:{qrcodeurl:"",restarting:true}}
// 失败一律 HTTP 200 + {code:-1,message}（NapCat 的真实行为）
const STUB_TOKEN = 'webui-token-SECRET-9f2a';
const STUB_CREDENTIAL = 'cred-SECRET-5b71';
const STUB_QR_1 = 'https://txz.qq.com/p?k=STUB-QR-SECRET-1';
const STUB_QR_2 = 'https://txz.qq.com/p?k=STUB-QR-SECRET-2';

function createStubWebui() {
  const stub = {
    token: STUB_TOKEN,
    credential: STUB_CREDENTIAL,
    // NapCat 侧的登录现场
    isLogin: false,
    isOffline: false,
    loginPhase: 'waiting_qrcode',
    qrcodeurl: STUB_QR_1,
    loginError: '',
    restarting: false,
    // 故障注入
    badShape: false,
    delayMs: 0,
    calls: { login: 0, status: 0, get: 0, refresh: 0 },
    server: null,
    url: '',
    port: 0
  };

  const expectedHash = createHash('sha256').update(stub.token + '.napcat').digest('hex');

  const respond = (res, body) => {
    const text = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 空 body 合法 */ }
    if (stub.delayMs) await sleep(stub.delayMs);

    const auth = String(req.headers.authorization || '');
    const hasCred = auth === `Bearer ${stub.credential}`;

    if (req.url === '/api/auth/login') {
      stub.calls.login++;
      if (body.hash !== expectedHash) return respond(res, { code: -1, message: 'token is invalid' });
      return respond(res, { code: 0, data: { Credential: stub.credential }, message: 'success' });
    }

    // 其余 /api/* 都要凭据（与 NapCat 的中间件一致）
    if (!hasCred) return respond(res, { code: -1, message: 'Unauthorized' });

    if (req.url === '/api/QQLogin/CheckLoginStatus') {
      stub.calls.status++;
      if (stub.badShape) return respond(res, { code: 0, data: {} });
      return respond(res, {
        code: 0,
        data: {
          isLogin: stub.isLogin,
          isOffline: stub.isOffline,
          loginPhase: stub.loginPhase,
          qrLoginAccepted: stub.loginPhase === 'qrcode_scanned' || stub.loginPhase === 'initializing',
          coreReady: stub.isLogin,
          qrcodeurl: stub.qrcodeurl,
          loginError: stub.loginError
        },
        message: 'success'
      });
    }

    if (req.url === '/api/QQLogin/GetQQLoginQrcode') {
      stub.calls.get++;
      if (stub.isLogin) return respond(res, { code: -1, message: 'QQ Is Logined' });
      // 登录服务重启中（reconnecting）时 NapCat 取不到码
      if (stub.loginPhase === 'reconnecting' || !stub.qrcodeurl) return respond(res, { code: -1, message: 'QRCode Get Error' });
      return respond(res, { code: 0, data: { qrcode: stub.qrcodeurl }, message: 'success' });
    }

    if (req.url === '/api/QQLogin/RefreshQRcode') {
      stub.calls.refresh++;
      if (stub.isLogin) return respond(res, { code: -1, message: 'QQ Is Logined' });
      if (stub.restarting) return respond(res, { code: 0, data: { qrcodeurl: '', restarting: true }, message: 'success' });
      if (!stub.qrcodeurl) return respond(res, { code: -1, message: 'QRCode Refresh Error: 登录服务未就绪' });
      return respond(res, { code: 0, data: { qrcodeurl: stub.qrcodeurl }, message: 'success' });
    }

    return respond(res, { code: -1, message: `Unknown path ${req.url}` });
  });

  return {
    stub,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      stub.port = server.address().port;
      stub.url = `http://127.0.0.1:${stub.port}`;
      stub.server = server;
      return stub;
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// ── 时钟 / 日志 / 令牌文件 ───────────────────────────────────────────────
function createClock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; }
  };
}

function createLogSink() {
  const lines = [];
  const log = (text) => { lines.push(String(text)); };
  log.lines = lines;
  return log;
}

const tempDirs = [];
function trackTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
function makeTokenFile(token) {
  const dir = trackTempDir('qq-login-test-');
  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(file, JSON.stringify({ host: '127.0.0.1', port: 6099, token, loginRate: 3 }), 'utf8');
  return { dir, file };
}

// ── 被测模块装载 ─────────────────────────────────────────────────────────
const { createQQLogin, createQQLoginHandlers, isLoopbackAddress, QQLoginError } = await import('../src/qq-login.js');

function makeLogin({ webuiUrl, tokenFile, clock, log, overrides = {} }) {
  const config = {
    qqLogin: {
      webuiUrl,
      webuiTokenFile: tokenFile,
      requestTimeoutMs: 800,
      statusProbeMs: 0,          // 测试里每次 status 都探测（时钟不自动走）
      actionCooldownMs: 0,       // 默认关冷却；冷却用专项测试打开
      pollIdleMs: 90_000,
      qrTtlMs: 120_000,
      ...overrides
    }
  };
  return createQQLogin({
    getConfig: () => config,
    log,
    now: clock.now
  });
}

// 假 req/res/json：与 src/routes.js 的 handler(ctx) 形状一致
function makeCtx({ addr = '127.0.0.1', query = {} } = {}) {
  const captured = { status: 0, headers: null, body: null };
  const res = {
    writeHead(code, headers) { captured.status = code; captured.headers = headers || {}; },
    end(text) { captured.body = Buffer.isBuffer(text) ? text : String(text ?? ''); }
  };
  const json = (r, code, data) => {
    captured.status = code;
    captured.headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    captured.body = JSON.stringify(data);
    r.end(captured.body);
    return undefined;
  };
  const req = { socket: { remoteAddress: addr }, url: '/', method: 'GET', headers: {} };
  return { ctx: { req, res, json, url: new URL('http://127.0.0.1/'), pathname: '/', method: 'GET', match: null }, captured };
}

const parseBody = (captured) => {
  try { return JSON.parse(captured.body); } catch { return null; }
};

// ── 主流程 ───────────────────────────────────────────────────────────────
const webui = createStubWebui();
await webui.start();
const stub = webui.stub;

const tokenFile = makeTokenFile(STUB_TOKEN);
const clock = createClock();
const log = createLogSink();
const qqLogin = makeLogin({ webuiUrl: stub.url, tokenFile: tokenFile.file, clock, log });
const handlers = createQQLoginHandlers({ qqLogin });

const allResponseBodies = [];   // 用于「不泄漏」扫描
async function call(name, ctxOpts = {}) {
  const { ctx, captured } = makeCtx(ctxOpts);
  const result = await handlers[name](ctx);
  allResponseBodies.push(String(captured.body ?? ''));
  return { status: captured.status, headers: captured.headers, body: captured.body, data: parseBody(captured), result };
}

// ── 1. 回环门 ────────────────────────────────────────────────────────────
section('1. 回环门（isLoopbackAddress + 非回环 403）');
check('isLoopbackAddress：127.0.0.1 / ::1 / ::ffff:127.0.0.1 为真', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
});
check('isLoopbackAddress：私网/公网/空值 为假', () => {
  for (const a of ['10.0.0.5', '192.168.1.20', '::2', '8.8.8.8', '', null, undefined]) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
});
await checkAsync('非回环请求访问 status → 403 + {"error":"仅允许回环地址访问"}', async () => {
  const r = await call('status', { addr: '10.1.2.3' });
  assert.equal(r.status, 403);
  assert.match(String(r.data.error), /回环/);
  assert.equal(r.data.ok, undefined, '回环门沿用 {"error"} 形状，不带 ok/code');
});
await checkAsync('非回环请求访问 qrcode → 403（五个 handler 同一道门）', async () => {
  const r = await call('qrcode', { addr: '203.0.113.9' });
  assert.equal(r.status, 403);
});
await checkAsync('负向对照②：去掉回环门（isLoopback 恒真）→ 同一非回环地址能通过', async () => {
  const permissive = createQQLoginHandlers({ qqLogin, isLoopback: () => true });
  const { ctx, captured } = makeCtx({ addr: '10.1.2.3' });
  await permissive.status(ctx);
  assert.equal(captured.status, 200, '去掉门后应当放行，证明确实是那道门在挡');
});

// ── 2. 10 个 phase ───────────────────────────────────────────────────────
section('2. 状态机 10 个 phase（stub 驱动）');
await checkAsync('phase unknown：冷启动被动查询，不探测 NapCat', async () => {
  const cold = makeLogin({ webuiUrl: stub.url, tokenFile: tokenFile.file, clock, log });
  const r = await cold.status();
  assert.equal(r.phase, 'unknown');
  assert.equal(r.qr.available, false);
  assert.equal(r.napcat.reachable, null, '未探测时 reachable 必须是 null，不能假装 false');
  assert.equal(stub.calls.status, 0, 'unknown 阶段不许打 NapCat');
});

await checkAsync('phase qr_waiting：等待扫码 + 二维码可用 + expiresInMs', async () => {
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1, loginError: '' });
  await qqLogin.start();
  const r = await qqLogin.status();
  assert.equal(r.phase, 'qr_waiting');
  assert.equal(r.qr.available, true);
  assert.ok(r.qr.issuedAt > 0);
  assert.ok(r.qr.expiresInMs > 0 && r.qr.expiresInMs <= 120000);
  assert.equal(r.error, null);
});

await checkAsync('负向对照①：stub 从「等待扫码」改成「已登录」→ status 立刻跟着变（不是写死）', async () => {
  stub.isLogin = true;
  stub.loginPhase = 'ready';
  stub.qrcodeurl = '';
  const r = await qqLogin.status();
  assert.equal(r.phase, 'logged_in');
  assert.equal(r.loggedIn, true);
  assert.equal(r.qr.available, false);
  // 还原
  stub.isLogin = false;
});

await checkAsync('phase qr_scanned：已扫码待确认', async () => {
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'qrcode_scanned', qrcodeurl: STUB_QR_1, loginError: '' });
  const r = await qqLogin.status();
  assert.equal(r.phase, 'qr_scanned');
});

await checkAsync('phase initializing：登录成功、正在启动 QQ', async () => {
  Object.assign(stub, { loginPhase: 'initializing', qrcodeurl: '' });
  const r = await qqLogin.status();
  assert.equal(r.phase, 'initializing');
});

await checkAsync('phase restarting：NapCat 登录服务重启中', async () => {
  Object.assign(stub, { loginPhase: 'reconnecting', qrcodeurl: '' });
  const r = await qqLogin.status();
  assert.equal(r.phase, 'restarting');
});

await checkAsync('phase expired：loginError 含「过期」→ expired（二维码接口 410）', async () => {
  Object.assign(stub, { loginPhase: 'waiting_qrcode', qrcodeurl: '', loginError: '二维码已过期，请刷新' });
  const r = await qqLogin.status();
  assert.equal(r.phase, 'expired');
  assert.equal(r.error.code, 'QR_EXPIRED');
  const q = await call('qrcode');
  assert.equal(q.status, 410);
  assert.equal(q.data.code, 'QR_EXPIRED');
});

await checkAsync('phase failed：其他登录失败', async () => {
  Object.assign(stub, { loginPhase: 'waiting_qrcode', qrcodeurl: '', loginError: '登录被风控拦截' });
  const r = await qqLogin.status();
  assert.equal(r.phase, 'failed');
  assert.equal(r.error.code, 'NAPCAT_LOGIN_FAILED');
});

await checkAsync('phase qq_offline：已登录但离线（不是未登录、也不是失败）', async () => {
  Object.assign(stub, { isLogin: false, isOffline: true, loginPhase: 'offline', qrcodeurl: '', loginError: '' });
  const r = await qqLogin.status();
  assert.equal(r.phase, 'qq_offline');
  assert.equal(r.offline, true);
  assert.equal(r.loggedIn, false);
  assert.equal(r.error.code, 'QQ_OFFLINE');
});

await checkAsync('phase logged_in：已登录→ start 409 且不调用刷新类接口', async () => {
  Object.assign(stub, { isLogin: true, isOffline: false, loginPhase: 'ready', qrcodeurl: '' });
  const before = { get: stub.calls.get, refresh: stub.calls.refresh };
  const r = await call('start');
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'QQ_ALREADY_LOGGED_IN');
  assert.equal(stub.calls.get, before.get, '已登录不许调 GetQQLoginQrcode');
  assert.equal(stub.calls.refresh, before.refresh, '已登录不许调 RefreshQRcode');
});

await checkAsync('phase unreachable：WebUI 连不上 → status 200 + unreachable（不是 5xx）', async () => {
  // 找一个确定没人监听的端口
  const deadPort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const deadClock = createClock();
  const dead = makeLogin({ webuiUrl: `http://127.0.0.1:${deadPort}`, tokenFile: tokenFile.file, clock: deadClock, log });
  const cold = await dead.status();
  assert.equal(cold.phase, 'unknown', '冷启动还没探测过：必须如实说 unknown');
  // 主动动作才给 5xx
  const act = await dead.start().then(() => null, (e) => e);
  assert.ok(act instanceof QQLoginError);
  assert.equal(act.code, 'NAPCAT_WEBUI_UNREACHABLE');
  assert.equal(act.httpStatus, 503);
  // 失败后状态落成 unreachable：面板下一次 status 能读到（并会按节流重试恢复）
  const r = await dead.status();
  assert.equal(r.phase, 'unreachable');
  assert.equal(r.napcat.reachable, false);
  assert.equal(r.error.code, 'NAPCAT_WEBUI_UNREACHABLE');
});

// ── 3. fail-closed / 鉴权失败 ────────────────────────────────────────────
section('3. fail-closed：契约不符 502、WebUI 鉴权失败 503');
await checkAsync('契约不符（响应缺 loginPhase/isLogin）→ status 502 NAPCAT_BAD_RESPONSE', async () => {
  stub.badShape = true;
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1 });
  const r = await call('status');
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'NAPCAT_BAD_RESPONSE');
  stub.badShape = false;
});

await checkAsync('WebUI 令牌不对（hash 不匹配）→ start 503 NAPCAT_AUTH_FAILED（不是 500，也不是静默）', async () => {
  const badToken = makeTokenFile('wrong-token-not-matching');
  const c2 = createClock();
  const l2 = makeLogin({ webuiUrl: stub.url, tokenFile: badToken.file, clock: c2, log: createLogSink() });
  const err = await l2.start().then(() => null, (e) => e);
  assert.ok(err instanceof QQLoginError);
  assert.equal(err.code, 'NAPCAT_AUTH_FAILED');
  assert.equal(err.httpStatus, 503);
});

await checkAsync('令牌文件不存在 → 503 NAPCAT_AUTH_FAILED 且文案给出文件路径', async () => {
  const c3 = createClock();
  const l3 = makeLogin({ webuiUrl: stub.url, tokenFile: path.join(os.tmpdir(), '__no_such_webui__.json'), clock: c3, log: createLogSink() });
  const err = await l3.start().then(() => null, (e) => e);
  assert.equal(err.code, 'NAPCAT_AUTH_FAILED');
  assert.match(err.message, /__no_such_webui__\.json/);
});

await checkAsync('凭据过期（stub 换 credential）→ 自动重登并重试一次后成功', async () => {
  const old = stub.credential;
  stub.credential = 'cred-SECRET-rotated';
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1 });
  const r = await qqLogin.status();
  assert.equal(r.phase, 'qr_waiting');
  stub.credential = old;
});

// ── 4. 取码 / 刷新 / 幂等 / 冷却 / 取消 ──────────────────────────────────
section('4. 二维码、刷新、幂等、冷却、取消');
await checkAsync('start 取到码；二维码接口返回真 SVG（content-type + <svg + 长度）', async () => {
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1, loginError: '' });
  await call('start');
  const q = await call('qrcode');
  assert.equal(q.status, 200);
  assert.match(String(q.headers['content-type']), /^image\/svg\+xml/);
  assert.equal(q.headers['cache-control'], 'no-store');
  const svg = String(q.body);
  assert.ok(svg.length > 1000, `SVG 太短：${svg.length}`);
  assert.ok(svg.startsWith('<svg') || svg.startsWith('<?xml'), '应以 <svg/<?xml 开头');
  // 内容不得出现在 SVG 文本里（二维码是图形，不该把原文写进 markup）
  assert.ok(!svg.includes('STUB-QR-SECRET'), 'SVG 里不许出现二维码原文');
});

const svgForDecode = await (async () => {
  const q = await call('qrcode');
  return String(q.body);
})();
{
  const resvg = spawnSync('which', ['resvg']).status === 0 ? 'resvg' : (spawnSync('which', ['rsvg-convert']).status === 0 ? 'rsvg-convert' : null);
  const zbar = spawnSync('which', ['zbarimg']).status === 0;
  if (!resvg || !zbar) {
    skipped++;
    console.log('  ○ 跳过「真解码」：本机没有 resvg/rsvg-convert + zbarimg（生产不依赖它们，仅用于本测试取证）');
  } else {
    await checkAsync('二维码真解码：SVG → PNG → zbarimg 解出的内容 === stub 的 qrcodeurl', async () => {
      const dir = trackTempDir('qq-login-qr-');
      const svgFile = path.join(dir, 'qr.svg');
      const pngFile = path.join(dir, 'qr.png');
      fs.writeFileSync(svgFile, svgForDecode, 'utf8');
      const conv = resvg === 'resvg'
        ? spawnSync('resvg', [svgFile, pngFile])
        : spawnSync('rsvg-convert', ['-o', pngFile, svgFile]);
      assert.equal(conv.status, 0, `SVG→PNG 失败：${conv.stderr}`);
      const dec = spawnSync('zbarimg', ['--quiet', '--raw', pngFile], { encoding: 'utf8' });
      assert.equal(dec.status, 0, `zbarimg 解码失败：${dec.stderr}`);
      assert.equal(String(dec.stdout).trim(), stub.qrcodeurl);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
}

await checkAsync('start 幂等：冷却窗口内第二次 start 不再打 NapCat、issuedAt 不变', async () => {
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1, loginError: '' });
  const clock2 = createClock();
  const l2 = makeLogin({ webuiUrl: stub.url, tokenFile: tokenFile.file, clock: clock2, log: createLogSink(), overrides: { actionCooldownMs: 3000 } });
  const before = { get: stub.calls.get, refresh: stub.calls.refresh, status: stub.calls.status };
  const a = await l2.start();
  const b = await l2.start();   // 同一时钟、冷却内
  assert.equal(b.qr.issuedAt, a.qr.issuedAt);
  assert.equal(stub.calls.get - before.get, 0, '已有可用码时 start 不该调 GetQQLoginQrcode');
  assert.equal(stub.calls.refresh - before.refresh, 0);
});

await checkAsync('冷却：3 秒内 refresh → 429 RATE_LIMITED + retryAfterMs', async () => {
  const clock3 = createClock();
  const l3 = makeLogin({ webuiUrl: stub.url, tokenFile: tokenFile.file, clock: clock3, log: createLogSink(), overrides: { actionCooldownMs: 3000 } });
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1 });
  await l3.start();
  const err = await l3.refresh().then(() => null, (e) => e);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.httpStatus, 429);
  assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 3000, `retryAfterMs=${err.retryAfterMs}`);
  clock3.advance(3001);
  const ok = await l3.refresh();
  assert.equal(ok.phase, 'qr_waiting');
});

await checkAsync('refresh 走 RefreshQRcode 并更新 issuedAt（码变了）', async () => {
  const clock4 = createClock();
  const l4 = makeLogin({ webuiUrl: stub.url, tokenFile: tokenFile.file, clock: clock4, log: createLogSink(), overrides: { actionCooldownMs: 0 } });
  stub.qrcodeurl = STUB_QR_1;
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', loginError: '' });
  const before = stub.calls.refresh;
  const a = await l4.start();
  clock4.advance(500);
  stub.qrcodeurl = STUB_QR_2;   // stub 刷新后给新码
  const b = await l4.refresh();
  assert.equal(stub.calls.refresh, before + 1);
  assert.notEqual(b.qr.issuedAt, a.qr.issuedAt, '换了新码 issuedAt 必须变');
});

await checkAsync('restarting：刷新时 NapCat 登录服务重启中 → phase restarting + 无码', async () => {
  const clock5 = createClock();
  const l5 = makeLogin({ webuiUrl: stub.url, tokenFile: tokenFile.file, clock: clock5, log: createLogSink(), overrides: { actionCooldownMs: 0 } });
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1, loginError: '', restarting: true });
  await l5.start();
  // NapCat 进入 reconnecting（登录服务重启）：状态里没有码，刷新接口返回 restarting:true
  stub.loginPhase = 'reconnecting';
  stub.qrcodeurl = '';
  const r = await l5.refresh();
  assert.equal(r.phase, 'restarting');
  assert.equal(r.qr.available, false);
  const q = await l5.qrcodeSvg().then(() => null, (e) => e);
  assert.ok(q instanceof QQLoginError, '重启中应取不到码');
  assert.equal(q.code, 'NO_QR_AVAILABLE');
  stub.restarting = false;
  stub.loginPhase = 'waiting_qrcode';
  stub.qrcodeurl = STUB_QR_1;
});

await checkAsync('取消（DELETE session）：不调用 NapCat 任何接口，状态回到 unknown', async () => {
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1, loginError: '', restarting: false });
  await qqLogin.start();
  const before = { ...stub.calls };
  const r = await call('session');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  await sleep(150);
  assert.deepEqual(stub.calls, before, '取消不许碰 NapCat');
  const s = await qqLogin.status();
  assert.equal(s.phase, 'unknown');
});

await checkAsync('session 在生成中 → 409 GENERATION_IN_FLIGHT（且带 retryAfterMs）', async () => {
  Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1, loginError: '' });
  const c6 = createClock();
  const l6 = makeLogin({ webuiUrl: stub.url, tokenFile: tokenFile.file, clock: c6, log: createLogSink(), overrides: { actionCooldownMs: 0 } });
  const h6 = createQQLoginHandlers({ qqLogin: l6 });
  stub.delayMs = 120;
  const pending = l6.start();
  await sleep(20);
  const { ctx, captured } = makeCtx();
  await h6.session(ctx);
  stub.delayMs = 0;
  await pending.catch(() => {});
  assert.equal(captured.status, 409);
  const body = parseBody(captured);
  assert.equal(body.code, 'GENERATION_IN_FLIGHT');
  assert.ok(body.retryAfterMs > 0);
});

// ── 5. 不泄漏 ────────────────────────────────────────────────────────────
section('5. 令牌 / 凭据 / 二维码原文不泄漏');
check('所有 JSON 响应体不含 WebUI 令牌 / 凭据 / 二维码原文', () => {
  const all = allResponseBodies.join('\n');
  assert.ok(!all.includes(STUB_TOKEN), '响应体里出现了 WebUI 令牌');
  assert.ok(!all.includes(STUB_CREDENTIAL), '响应体里出现了 WebUI 凭据');
  assert.ok(!all.includes('STUB-QR-SECRET'), '响应体里出现了二维码原文');
});
check('日志里不含 WebUI 令牌 / 凭据 / 二维码原文', () => {
  const all = log.lines.join('\n');
  assert.ok(!all.includes(STUB_TOKEN), '日志里出现了 WebUI 令牌');
  assert.ok(!all.includes(STUB_CREDENTIAL), '日志里出现了 WebUI 凭据');
  assert.ok(!all.includes('STUB-QR-SECRET'), '日志里出现了二维码原文');
});
check('status 快照没有 qrcodeurl 字段（只暴露 issuedAt/available）', async () => {
  const r = await qqLogin.status();
  assert.ok(!('qrcodeurl' in r), 'status 不许携带二维码原文');
  assert.ok(!('qrcodeurl' in r.qr), 'qr 块不许携带二维码原文');
});

// ── 6. 不提供登出能力 ─────────────────────────────────────────────────────
section('6. 能力边界');
check('handlers 只暴露 5 个动作，没有 logout/restart/reset', () => {
  const keys = Object.keys(createQQLoginHandlers({ qqLogin })).sort();
  assert.deepEqual(keys, ['qrcode', 'refresh', 'session', 'start', 'status']);
});
check('状态机对外方法同样没有登出入口', () => {
  const keys = Object.keys(qqLogin).sort();
  for (const forbidden of ['logout', 'restartNapCat', 'logoutQQ', 'resetDevice']) {
    assert.ok(!keys.includes(forbidden), `不该暴露 ${forbidden}`);
  }
});

// ── 7. 端到端：真 createApp + 真路由 + 真 HTTP（鉴权闭环与接口接线）────────
// 令牌鉴权属于 app.js 对全部 /api/* 的统一门；这里起真 server，用 /api/qq-login/*
// 本身作探针，验证「未配 token 放行 / 无 token 401 / 旧 marker 401 / 正确 token 200」
// 这四条，顺带证明 5 条路由真的接上了（不是只有模块层能跑）。
section('7. 端到端：真 server + /api/qq-login/* 鉴权闭环');
{
  const PORT_TOKEN = 'console-token-SECRET-77ab';

  async function freePort() {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    });
  }

  /** 起一个真 AIChat（隔离 data 目录 + 临时端口 + qqLogin 指向 stub）。 */
  async function bootProbeApp({ token }) {
    const dataDir = trackTempDir('qq-login-e2e-');
    const port = await freePort();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      server: { port, token },
      snowluma: { wsUrl: 'ws://127.0.0.1:9', httpUrl: 'http://127.0.0.1:9', accessToken: '', mode: 'external' },
      api: { baseUrl: '', apiKey: '', model: 'test-model' },
      extensions: { hotReload: false },
      proactive: { enabled: false },
      qqLogin: { webuiUrl: stub.url, webuiTokenFile: tokenFile.file }
    }), 'utf8');
    const prevDataDir = process.env.QQ_AGENT_DATA_DIR;
    const prevPort = process.env.QQ_AGENT_PORT;
    process.env.QQ_AGENT_DATA_DIR = dataDir;
    process.env.QQ_AGENT_PORT = String(port);
    const { createApp } = await import('../src/app.js');
    const app = createApp({ log: () => {} });
    let actualPort;
    try {
      actualPort = await app.start();
    } catch (error) {
      if (prevDataDir === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = prevDataDir;
      if (prevPort === undefined) delete process.env.QQ_AGENT_PORT; else process.env.QQ_AGENT_PORT = prevPort;
      throw error;
    }
    const base = `http://127.0.0.1:${actualPort}`;
    return {
      base,
      async stop() {
        try { await app.stop(); } catch { /* ignore */ }
        if (prevDataDir === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = prevDataDir;
        if (prevPort === undefined) delete process.env.QQ_AGENT_PORT; else process.env.QQ_AGENT_PORT = prevPort;
        await sleep(100);
      }
    };
  }

  const httpCall = async (base, method, pathname, { headers = {}, body } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* SVG 等非 JSON */ }
    return { status: res.status, headers: res.headers, text, data };
  };

  // ── 7a. 未配 server.token：放行（现状兼容），且五条路由真的接上了 ──
  {
    Object.assign(stub, { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: STUB_QR_1, loginError: '', restarting: false });
    let app = null;
    try {
      app = await bootProbeApp({ token: '' });
      await checkAsync('未配 token：POST /api/qq-login/start → 200 且 phase=qr_waiting（真路由）', async () => {
        const r = await httpCall(app.base, 'POST', '/api/qq-login/start', { body: {} });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.data.ok, true);
        assert.equal(r.data.phase, 'qr_waiting');
      });
      await checkAsync('未配 token：GET /api/qq-login/status → 200 且 phase 与 stub 一致', async () => {
        const r = await httpCall(app.base, 'GET', '/api/qq-login/status');
        assert.equal(r.status, 200, r.text);
        assert.equal(r.data.phase, 'qr_waiting');
        assert.equal(r.data.qr.available, true);
      });
      await checkAsync('未配 token：GET /api/qq-login/qrcode.svg → 200 image/svg+xml 且是真图', async () => {
        const r = await httpCall(app.base, 'GET', '/api/qq-login/qrcode.svg');
        assert.equal(r.status, 200, r.text);
        assert.match(String(r.headers.get('content-type')), /^image\/svg\+xml/);
        assert.ok(r.text.length > 1000);
        assert.ok(r.text.includes('<svg'));
      });
      await checkAsync('未配 token：DELETE /api/qq-login/session → 200（取消后状态回 unknown）', async () => {
        const d = await httpCall(app.base, 'DELETE', '/api/qq-login/session');
        assert.equal(d.status, 200, d.text);
        assert.equal(d.data.ok, true);
        const s = await httpCall(app.base, 'GET', '/api/qq-login/status');
        assert.equal(s.data.phase, 'unknown');
      });
    } finally {
      await app?.stop?.();
    }
  }

  // ── 7b. 再给同一个实例配 server.token：鉴权闭环（无 token / 旧 marker / 正确 token）──
  // 说明：config 是模块级缓存 + DATA_DIR 在 import 时固定，同一进程里再起第二个实例
  // 读不到新 data 目录的 config.json。这里用 updateConfig() 在运行中设令牌 ——
  // 与生产「POST /api/config 设 token」是同一条路径，authorize() 每次都读内存活配置。
  {
    let app = null;
    try {
      app = await bootProbeApp({ token: '' });
      const { updateConfig } = await import('../src/config.js');
      // 先确认未配 token 时放行（与 7a 同实例，避免依赖第二次 import 的 config 缓存）
      await checkAsync('未配 token：GET /api/qq-login/status → 200（放行）', async () => {
        const r = await httpCall(app.base, 'GET', '/api/qq-login/status');
        assert.equal(r.status, 200, r.text);
      });
      updateConfig({ server: { token: PORT_TOKEN } });
      await checkAsync('配 token 后（无 token）：GET /api/qq-login/status → 401（不是 200、不是 404）', async () => {
        const r = await httpCall(app.base, 'GET', '/api/qq-login/status');
        assert.equal(r.status, 401, r.text);
        assert.ok(r.data?.error, '应返回 {error} 形状');
      });
      await checkAsync('旧硬编码 marker（qq-agent-console）：GET /api/qq-login/status → 401', async () => {
        const r = await httpCall(app.base, 'GET', '/api/qq-login/status', { headers: { 'x-console-token': 'qq-agent-console' } });
        assert.equal(r.status, 401);
      });
      await checkAsync('正确 token（header）：GET /api/qq-login/status → 200 且 handler 真的执行了', async () => {
        const r = await httpCall(app.base, 'GET', '/api/qq-login/status', { headers: { 'x-console-token': PORT_TOKEN } });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.data.ok, true);
        assert.equal(r.data.phase, 'unknown', '冷启动未探测：如实说 unknown');
      });
      await checkAsync('正确 token（?token=）：GET /api/status → 200（既有门未被改坏）', async () => {
        const r = await httpCall(app.base, 'GET', `/api/status?token=${encodeURIComponent(PORT_TOKEN)}`);
        assert.equal(r.status, 200);
      });
      await checkAsync('静态资源不过鉴权（无 token 也能取页面）→ 200', async () => {
        const r = await httpCall(app.base, 'GET', '/');
        assert.equal(r.status, 200);
      });
    } finally {
      await app?.stop?.();
    }
  }
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
qqLogin.dispose();
qqLogin.dispose();   // 幂等
await webui.stop();
await sleep(100);
cleanupTempDirs();

console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`);
if (fail > 0) {
  console.error('\n失败项：');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
process.exit(0);
