// /api/protocol/*（容器协议端原生管理）后端测试
//
// 被测对象：src/protocol-side.js（状态识别 + start/stop/restart + 四个 handler）。
// 外部世界全部替换：runner 注入 stub（**绝不真跑 systemctl**）；时钟不参与（用真实短超时）。
//
// 覆盖（task-14 验收口径）：
//   ① 四态映射（running/stopped/absent/unknown）与 actions 可用性
//   ② start/stop/restart 各发一次正确命令且带 XDG_RUNTIME_DIR
//   ③ stop/restart 缺 confirm → 400；非 external → 409；runner 失败 → 503 带 lastError
//   ④ 四个接口非回环 → 403
//   ⑤ 不自动拉起：构造/初始化零副作用（不调用 runner）
//   ⑥ 动作超时在 actionTimeoutMs 内收敛为 503，不挂死
//   + 三条负向对照（回环门 / confirm / XDG 注入被去掉时，对应的正向断言会失败）
//
// 运行：node test/protocol-side-test.mjs

import assert from 'node:assert/strict';
import {
  createProtocolSide,
  createProtocolSideHandlers,
  ProtocolSideError,
  STOP_WARNING,
  parseSystemdShow,
  mapUnitState
} from '../src/protocol-side.js';

// ── 断言收集器（与 qq-login-backend-test / _harness 同风格）─────────────────
let pass = 0, fail = 0;
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

// ── stub runner：完全离线，记录每条命令 + 可注入故障 ────────────────────────
// 契约与 src/protocol-side.js 的 createDefaultRunner 一致：
//   resolve { ok, code, stdout, stderr, error? }，不 reject。
function createStubRunner({ engines = ['podman'] } = {}) {
  const state = {
    engines: [...engines],
    unitLoadState: 'loaded',     // loaded | not-found
    unitActiveState: 'active',   // active | inactive | failed | mystery…
    systemctlShowFails: '',      // 非空 ⇒ show 命令失败（模拟 systemctl 不可用）
    containerExists: false,      // systemctl 认不到单元时的兜底
    containerRunning: true,
    containerInspectFails: false,
    actionFails: false,
    actionThrows: '',
    actionStderr: '',
    actionNeverResolves: false,
    calls: []
  };
  const runner = async (command, args, opts = {}) => {
    state.calls.push({ command, args: [...args], env: { ...(opts.env || {}) }, timeoutMs: opts.timeoutMs });
    if (command === 'systemctl') {
      const sub = args[1];
      if (sub === 'show') {
        if (state.systemctlShowFails) {
          return { ok: false, code: 1, stdout: '', stderr: state.systemctlShowFails };
        }
        return {
          ok: true, code: 0, stderr: '',
          stdout: `LoadState=${state.unitLoadState}\nActiveState=${state.unitActiveState}\n`
        };
      }
      if (sub === 'start' || sub === 'stop' || sub === 'restart') {
        if (state.actionNeverResolves) return new Promise(() => {});   // 永不 settle，专测超时收敛
        if (state.actionThrows) throw new Error(state.actionThrows);  // runner 直接抛（模拟执行器故障）
        if (state.actionFails) {
          return { ok: false, code: 1, stdout: '', stderr: state.actionStderr || 'Job failed' };
        }
        if (sub === 'start' || sub === 'restart') state.unitActiveState = 'active';
        else state.unitActiveState = 'inactive';
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      return { ok: false, code: 1, stdout: '', stderr: `unexpected systemctl: ${args.join(' ')}` };
    }
    if (command === 'podman' || command === 'docker') {
      if (!state.engines.includes(command)) {
        return { ok: false, code: null, stdout: '', stderr: '', error: `spawn ${command} ENOENT` };
      }
      if (args[0] === 'container' && args[1] === 'exists') {
        return state.containerExists
          ? { ok: true, code: 0, stdout: '', stderr: '' }
          : { ok: false, code: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'inspect') {
        if (state.containerInspectFails) {
          return { ok: false, code: 125, stdout: '', stderr: 'inspect failed' };
        }
        return { ok: true, code: 0, stdout: state.containerRunning ? 'true\n' : 'false\n', stderr: '' };
      }
    }
    return { ok: false, code: 127, stdout: '', stderr: `unknown command ${command}` };
  };
  const actionCalls = () => state.calls.filter((c) => c.command === 'systemctl'
    && (c.args[1] === 'start' || c.args[1] === 'stop' || c.args[1] === 'restart'));
  return { runner, state, actionCalls };
}

const BASE_CONFIG = {
  enabled: true,
  unit: 'napcat.service',
  container: 'napcat',
  engine: 'auto',
  actionTimeoutMs: 500,
  statusCacheMs: 0          // 测试里默认不复用缓存（缓存专项另测）
};

function makeSide({ mode = 'external', config = {}, stub, env = {}, getuid = () => 1000 } = {}) {
  return createProtocolSide({
    getConfig: () => ({ protocolSide: { ...BASE_CONFIG, ...config } }),
    getProtocolMode: () => ({ mode }),
    log: () => {},
    runner: stub.runner,
    env,
    getuid
  });
}

// ── 假 req/res/json：与 src/routes.js 的 handler(ctx) 形状一致 ──────────────
function makeCtx({ addr = '127.0.0.1', body = {} } = {}) {
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
  const ctx = { req, res, json, url: new URL('http://127.0.0.1/'), pathname: '/', method: 'GET', match: null, body };
  return { ctx, captured };
}

function parseCaptured(captured) {
  try { return JSON.parse(captured.body); } catch { return null; }
}

async function callHandler(handlers, name, ctxOpts = {}) {
  const { ctx, captured } = makeCtx(ctxOpts);
  await handlers[name](ctx);
  return { status: captured.status, data: parseCaptured(captured), body: captured.body };
}

/** ② 的判据：动作命令的 env 里必须带 XDG_RUNTIME_DIR。 */
function hasXdgRuntimeDir(env) {
  return Boolean(env && String(env.XDG_RUNTIME_DIR || '').trim());
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section('0. 纯函数：systemctl show 解析 + 四态映射');
  check('parseSystemdShow：LoadState/ActiveState 各取一次，其它键忽略', () => {
    const p = parseSystemdShow('LoadState=loaded\nActiveState=active\nFragmentPath=/x\nLoadState=loaded\n');
    assert.deepEqual(p, { loadState: 'loaded', activeState: 'active' });
  });
  check('mapUnitState：not-found ⇒ absent（installed=false）', () => {
    const r = mapUnitState('not-found', '');
    assert.equal(r.state, 'absent');
    assert.equal(r.installed, false);
  });
  check('mapUnitState：active/activating/reloading ⇒ running；inactive/failed ⇒ stopped', () => {
    for (const a of ['active', 'activating', 'reloading']) assert.equal(mapUnitState('loaded', a).state, 'running', a);
    for (const a of ['inactive', 'failed', 'deactivating', 'maintenance']) assert.equal(mapUnitState('loaded', a).state, 'stopped', a);
  });
  check('mapUnitState：未知 ActiveState ⇒ unknown（fail-closed，不猜）', () => {
    assert.equal(mapUnitState('loaded', 'mystery-state').state, 'unknown');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('1. 四态映射 + actions 可用性（stub runner）');
  await checkAsync('running：managed=true，actions=["stop","restart"]，running=true', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const s = await side.status();
    assert.equal(s.mode, 'external');
    assert.equal(s.state, 'running');
    assert.equal(s.running, true);
    assert.equal(s.installed, true);
    assert.equal(s.managed, true);
    assert.equal(s.unit, 'napcat.service');
    assert.equal(s.container, 'napcat');
    assert.deepEqual(s.actions, ['stop', 'restart']);
    assert.match(s.detail, /systemd 用户单元 napcat\.service/);
    assert.match(s.stopWarning, /登录态/);
    assert.equal(s.lastError, '');
  });
  await checkAsync('stopped：managed=true，actions=["start","restart"]，running=false', async () => {
    const stub = createStubRunner();
    stub.state.unitActiveState = 'inactive';
    const side = makeSide({ stub });
    const s = await side.status();
    assert.equal(s.state, 'stopped');
    assert.equal(s.running, false);
    assert.equal(s.managed, true);
    assert.deepEqual(s.actions, ['start', 'restart']);
    assert.match(s.detail, /未运行/);
  });
  await checkAsync('absent：unit not-found + 容器也不存在 ⇒ absent，无动作', async () => {
    const stub = createStubRunner();
    stub.state.unitLoadState = 'not-found';
    stub.state.containerExists = false;
    const side = makeSide({ stub });
    const s = await side.status();
    assert.equal(s.state, 'absent');
    assert.equal(s.installed, false);
    assert.equal(s.managed, false);
    assert.deepEqual(s.actions, []);
    assert.match(s.detail, /未部署|未找到/);
    // 回退识别确实查了两个引擎
    assert.ok(stub.state.calls.some((c) => c.command === 'podman' && c.args[1] === 'exists'));
    assert.ok(stub.state.calls.some((c) => c.command === 'docker' && c.args[1] === 'exists'));
  });
  await checkAsync('容器存在但无 systemctl 单元 ⇒ 显示状态但 managed=false、actions=[]', async () => {
    const stub = createStubRunner();
    stub.state.unitLoadState = 'not-found';
    stub.state.containerExists = true;
    stub.state.containerRunning = true;
    const side = makeSide({ stub });
    const s = await side.status();
    assert.equal(s.state, 'running');
    assert.equal(s.running, true);
    assert.equal(s.installed, true);
    assert.equal(s.managed, false, '没有 systemd 单元就不该假装能管');
    assert.equal(s.engine, 'podman');
    assert.deepEqual(s.actions, []);
    assert.match(s.detail, /启停\/重启不可用/);
  });
  await checkAsync('unknown：systemctl 读不到 ⇒ state=unknown + lastError（读不到 ≠ 没有）', async () => {
    const stub = createStubRunner();
    stub.state.systemctlShowFails = 'Failed to connect to bus: No such file or directory';
    const side = makeSide({ stub });
    const s = await side.status();
    assert.equal(s.state, 'unknown');
    assert.equal(s.managed, false);
    assert.deepEqual(s.actions, []);
    assert.match(s.lastError, /Failed to connect to bus/);
    assert.match(s.detail, /无法识别协议端/);
  });
  await checkAsync('unknown：ActiveState 无法归类 ⇒ 不做动作（start 会 409）', async () => {
    const stub = createStubRunner();
    stub.state.unitActiveState = 'mystery-state';
    const side = makeSide({ stub });
    const s = await side.status();
    assert.equal(s.state, 'unknown');
    assert.deepEqual(s.actions, []);
    await assert.rejects(() => side.start(), (e) => e instanceof ProtocolSideError && e.code === 'PROTOCOL_NOT_MANAGED' && e.httpStatus === 409);
    assert.equal(stub.actionCalls().length, 0);
  });
  await checkAsync('不适用：embedded 模式 ⇒ managed=false、不执行任何命令（连 show 都不发）', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub, mode: 'embedded' });
    const s = await side.status();
    assert.equal(s.mode, 'embedded');
    assert.equal(s.managed, false);
    assert.equal(s.state, 'unknown');
    assert.deepEqual(s.actions, []);
    assert.match(s.detail, /不适用/);
    assert.equal(stub.state.calls.length, 0, '模式不适用时不许触碰外部命令');
  });
  await checkAsync('配置关闭（enabled=false）⇒ managed=false、不执行命令', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub, config: { enabled: false } });
    const s = await side.status();
    assert.equal(s.managed, false);
    assert.equal(stub.state.calls.length, 0);
    assert.match(s.detail, /关闭/);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('2. 动作：命令正确 + XDG_RUNTIME_DIR + 动作后状态');
  await checkAsync('running 时 stop(confirm) 发一次 `systemctl --user stop napcat.service` 并带 XDG', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub, env: {}, getuid: () => 1000 });
    const r = await side.stop({ confirm: true });
    assert.equal(r.action, 'stop');
    assert.equal(r.stateAfter, 'stopped');
    assert.equal(typeof r.tookMs, 'number');
    const actions = stub.actionCalls();
    assert.equal(actions.length, 1, '只许发一次动作命令');
    assert.deepEqual(actions[0].args, ['--user', 'stop', 'napcat.service']);
    assert.equal(actions[0].env.XDG_RUNTIME_DIR, '/run/user/1000');
  });
  await checkAsync('stopped 时 start 发一次 `systemctl --user start`，stateAfter=running', async () => {
    const stub = createStubRunner();
    stub.state.unitActiveState = 'inactive';
    const side = makeSide({ stub });
    const r = await side.start();
    assert.equal(r.action, 'start');
    assert.equal(r.stateAfter, 'running');
    const actions = stub.actionCalls();
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].args, ['--user', 'start', 'napcat.service']);
    assert.equal(actions[0].env.XDG_RUNTIME_DIR, '/run/user/1000');
  });
  await checkAsync('restart(confirm) 发一次 `systemctl --user restart`，stateAfter=running', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const r = await side.restart({ confirm: true });
    assert.equal(r.action, 'restart');
    assert.equal(r.stateAfter, 'running');
    const actions = stub.actionCalls();
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].args, ['--user', 'restart', 'napcat.service']);
  });
  await checkAsync('XDG_RUNTIME_DIR：进程 env 有值时优先用它（不被 uid 兜底覆盖）', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub, env: { XDG_RUNTIME_DIR: '/run/user/4242' }, getuid: () => 1000 });
    await side.start();
    assert.equal(stub.actionCalls()[0].env.XDG_RUNTIME_DIR, '/run/user/4242');
    assert.equal(side.xdgRuntimeDir(), '/run/user/4242');
  });
  await checkAsync('XDG_RUNTIME_DIR：进程 env 没有时按 /run/user/<uid> 补', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub, env: {}, getuid: () => 4321 });
    await side.start();
    assert.equal(stub.actionCalls()[0].env.XDG_RUNTIME_DIR, '/run/user/4321');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('3. 错误码：confirm / 非 external / 动作失败');
  await checkAsync('stop 缺 confirm → 400 CONFIRM_REQUIRED，且不发动作命令', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const r = await callHandler(handlers, 'stop', { body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'CONFIRM_REQUIRED');
    assert.match(String(r.data.error), /确认/);
    assert.equal(stub.actionCalls().length, 0);
  });
  await checkAsync('restart 缺 confirm → 400 CONFIRM_REQUIRED', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const r = await callHandler(handlers, 'restart', { body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'CONFIRM_REQUIRED');
    assert.equal(stub.actionCalls().length, 0);
  });
  await checkAsync('start 不需要 confirm（空 body 合法）→ 200', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const r = await callHandler(handlers, 'start', { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.action, 'start');
  });
  await checkAsync('非 external 模式 → start 409 PROTOCOL_NOT_MANAGED，不发动作命令', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub, mode: 'embedded' });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const r = await callHandler(handlers, 'start');
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'PROTOCOL_NOT_MANAGED');
    assert.equal(stub.actionCalls().length, 0);
  });
  await checkAsync('动作失败 → 503 PROTOCOL_ACTION_FAILED + lastError 可读', async () => {
    const stub = createStubRunner();
    stub.state.actionFails = true;
    stub.state.actionStderr = 'Job for napcat.service failed: QQ is not responding';
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const r = await callHandler(handlers, 'start');
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'PROTOCOL_ACTION_FAILED');
    assert.match(String(r.data.lastError), /QQ is not responding/);
    assert.match(String(r.data.error), /失败/);
    // 失败不静默：状态面能读到 lastError
    const s = await side.status();
    assert.match(s.lastError, /QQ is not responding/);
  });

  await checkAsync('runner 抛错 → 503 PROTOCOL_ACTION_FAILED + lastError（不许 uncaught）', async () => {
    const stub = createStubRunner();
    stub.state.actionThrows = 'spawn systemctl EACCES';
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const r = await callHandler(handlers, 'start');
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'PROTOCOL_ACTION_FAILED');
    assert.match(String(r.data.lastError), /EACCES/);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('4. 回环门：四个接口全部 403（非回环）');
  {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    for (const name of ['status', 'start', 'stop', 'restart']) {
      await checkAsync(`${name}：非回环来源 → 403（沿用 {"error"} 形状）`, async () => {
        const r = await callHandler(handlers, name, { addr: '10.1.2.3', body: { confirm: true } });
        assert.equal(r.status, 403);
        assert.match(String(r.data.error), /回环/);
        assert.equal(r.data.ok, undefined, '回环门响应不带 ok/code');
        assert.equal(r.data.code, undefined);
      });
    }
    await checkAsync('负向对照①：把回环门去掉（isLoopback 恒真）→ 同一非回环地址能通过 200', async () => {
      const permissive = createProtocolSideHandlers({ protocolSide: side, isLoopback: () => true });
      const r = await callHandler(permissive, 'status', { addr: '10.1.2.3' });
      assert.equal(r.status, 200, '去掉门后应当放行 —— 证明 403 确实是那道门挡的');
      assert.equal(r.data.ok, true);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('5. 不自动拉起（构造纯惰性 / 无定时器 / 不发动作）');
  await checkAsync('构造后 100ms 内 runner 调用数 = 0（无自启动、无初始化探测）', async () => {
    const stub = createStubRunner();
    makeSide({ stub });
    await sleep(100);
    assert.equal(stub.state.calls.length, 0, `构造期不该调用 runner，实际：${JSON.stringify(stub.state.calls)}`);
  });
  await checkAsync('只读 status() 也只发只读命令（show / container exists / inspect），从不发 start/stop/restart', async () => {
    const stub = createStubRunner();
    stub.state.unitLoadState = 'not-found';
    stub.state.containerExists = true;
    const side = makeSide({ stub });
    await side.status();
    const writes = stub.actionCalls();
    assert.equal(writes.length, 0, `只读路径出现动作命令：${JSON.stringify(writes)}`);
    for (const c of stub.state.calls) {
      const readOnly = (c.command === 'systemctl' && c.args[1] === 'show')
        || ((c.command === 'podman' || c.command === 'docker') && ['container', 'inspect'].includes(c.args[0]));
      assert.ok(readOnly, `只读路径出现非只读命令：${c.command} ${c.args.join(' ')}`);
    }
  });
  await checkAsync('负向对照：summary/status 不会触发任何动作（app 启动流程只构造实例，不调用动作）', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    await side.summary();
    await side.status();
    assert.equal(stub.actionCalls().length, 0);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('6. 动作超时：actionTimeoutMs 内收敛为 503，不挂死');
  await checkAsync('stub 动作永不返回 → 503 PROTOCOL_ACTION_FAILED（< 1.5s）', async () => {
    const stub = createStubRunner();
    stub.state.actionNeverResolves = true;
    const side = makeSide({ stub, config: { actionTimeoutMs: 80 } });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const startedAt = Date.now();
    const r = await callHandler(handlers, 'start');
    const elapsed = Date.now() - startedAt;
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'PROTOCOL_ACTION_FAILED');
    assert.match(String(r.data.lastError), /超时/);
    assert.ok(elapsed < 1500, `超时收敛太慢：${elapsed}ms（actionTimeoutMs=80）`);
    // 收敛后模块仍可用（没有挂死的全局状态）
    stub.state.actionNeverResolves = false;
    const s = await side.status();
    assert.equal(s.mode, 'external');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('7. 契约形状：status 字段 / summary / handler 名单 / 缓存');
  await checkAsync('GET /api/protocol/status 响应含契约要求的全部字段', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    const r = await callHandler(handlers, 'status');
    assert.equal(r.status, 200);
    for (const key of ['ok', 'mode', 'managed', 'engine', 'unit', 'container', 'installed',
      'running', 'state', 'detail', 'lastError', 'actions', 'stopWarning']) {
      assert.ok(key in r.data, `缺字段 ${key}`);
    }
    assert.equal(r.data.ok, true);
    assert.ok(Array.isArray(r.data.actions));
  });
  await checkAsync('summary() 只给 {managed,running,state} 三字段（不放大对象）', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const s = await side.summary();
    assert.deepEqual(Object.keys(s).sort(), ['managed', 'running', 'state']);
  });
  await checkAsync('handlers 名单固定为四个（status/start/stop/restart）', () => {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const names = Object.keys(createProtocolSideHandlers({ protocolSide: side })).sort();
    assert.deepEqual(names, ['restart', 'start', 'status', 'stop']);
  });
  await checkAsync('statusCacheMs>0 时缓存生效（连续两次 status 只发一次 show）', async () => {
    const stub = createStubRunner();
    const side = makeSide({ stub, config: { statusCacheMs: 10000 } });
    await side.status();
    const afterFirst = stub.state.calls.filter((c) => c.command === 'systemctl' && c.args[1] === 'show').length;
    await side.status();
    const afterSecond = stub.state.calls.filter((c) => c.command === 'systemctl' && c.args[1] === 'show').length;
    assert.equal(afterFirst, 1);
    assert.equal(afterSecond, 1, '缓存期内不该重复打 systemctl');
    side.resetCache();
    await side.status();
    assert.equal(stub.state.calls.filter((c) => c.command === 'systemctl' && c.args[1] === 'show').length, 2);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('8. 负向对照：去掉三道关键约束时，对应的正向断言会失败');
  {
    const stub = createStubRunner();
    const side = makeSide({ stub });
    const handlers = createProtocolSideHandlers({ protocolSide: side });
    await checkAsync('负向对照②：confirm 检查去掉（直接传 confirm:true）→ 同一请求从 400 变 200', async () => {
      const missing = await callHandler(handlers, 'stop', { body: {} });
      assert.equal(missing.status, 400, '前提：缺 confirm 必须 400');
      const bypass = await callHandler(handlers, 'stop', { body: { confirm: true } });
      assert.equal(bypass.status, 200, '补上 confirm 就过 —— 证明 400 来自那道确认检查');
    });
    await checkAsync('负向对照③：XDG_RUNTIME_DIR 注入去掉 → 动作命令的 env 断言会失败', async () => {
      const stub2 = createStubRunner();
      const side2 = makeSide({ stub: stub2, env: {}, getuid: () => 1000 });
      await side2.start();
      const env = stub2.actionCalls()[0].env;
      assert.equal(hasXdgRuntimeDir(env), true, '② 依赖：实际命令带 XDG_RUNTIME_DIR');
      const stripped = { ...env };
      delete stripped.XDG_RUNTIME_DIR;
      assert.equal(hasXdgRuntimeDir(stripped), false, '去掉注入后 ② 的判据必须变 false（否则 ② 抓不住回归）');
    });
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(64)}`);
  console.log(`容器协议端原生管理：通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n全部通过 ✅');
  }
}

main().catch((error) => {
  console.error('测试自身异常:', error);
  process.exit(1);
});
