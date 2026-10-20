// 容器协议端（NapCat quadlet）原生管理：状态识别 + 手动 start / stop / restart。
//
// 设计边界（本文件是自包含深模块，与 src/qq-login.js 同一形状）：
//   - 对外只有两个入口：createProtocolSide(deps)（逻辑层）与
//     createProtocolSideHandlers({ protocolSide, isLoopback })（HTTP 层）。
//   - 外部世界依赖全部注入：runner（执行命令）/ getConfig / getProtocolMode / 时钟 / 日志 / env / uid。
//     ⇒ 测试可以完全不真跑 systemctl（见 test/protocol-side-test.mjs）。
//   - 协议端形态（external / embedded / unconfigured）不在这里判：由 config.js 的
//     resolveProtocolMode 唯一判定，经 app.js 的 protocolMode() 注入，避免第二套判定。
//
// 不变量（每条都有强制点）：
//   I1 绝不自启动：构造纯惰性、无定时器/无副作用；app 启动流程不调用任何动作。
//      只有显式 http 请求 / 显式方法调用才会触碰外部命令。强制点：构造体与启动流程代码，测试 ⑤。
//   I2 生命周期归 systemd：动作命令恒为 `systemctl --user <action> <unit>`；
//      不改 enabled、不 podman run/restart、不自动重试。强制点：runAction 唯一动作出口。
//   I3 stop / restart 必须显式 confirm（停容器会短暂中断 OneBot，且可能丢 QQ 登录态；
//      StopTimeout=80 只是缓解）。强制点：performAction 唯一确认检查。
//   I4 systemctl --user 需要 XDG_RUNTIME_DIR：本进程是系统单元，systemd 给的是 root 的
//      runtime dir，不显式指向部署用户的 /run/user/<uid> 会连错 manager。强制点：runnerEnv 唯一构造点。
//   I5 「读不到」≠「没有」≠「不适用」：systemctl 命令失败/超时 ⇒ state=unknown + lastError；
//      只有 systemctl 明确 LoadState=not-found 才回退容器识别；容器也不存在 ⇒ absent。
//   I6 动作失败/超时必须在 actionTimeoutMs 内收敛成结构化错误（503 + lastError），绝不挂死。
//      强制点：callRunner 的统一超时竞速。
//
// 接口约定（task-14，前端按这个消费）：
//   GET  /api/protocol/status → 200 { ok, mode, managed, engine, unit, container, installed,
//                                      running, state, detail, lastError, actions, stopWarning }
//   POST /api/protocol/start   body {}
//   POST /api/protocol/stop    body {"confirm":true}
//   POST /api/protocol/restart body {"confirm":true}
//      → 200 { ok:true, action, stateAfter, tookMs }
//      → 400 { ok:false, code:'CONFIRM_REQUIRED', error }
//      → 403 { error }                       （非回环；沿用 /api 既有形状）
//      → 409 { ok:false, code:'PROTOCOL_NOT_MANAGED', error }
//      → 503 { ok:false, code:'PROTOCOL_ACTION_FAILED', error, lastError }

import { execFile } from 'node:child_process';
import { DEFAULT_CONFIG } from './config.js';
import { isLoopbackAddress } from './qq-login.js';

/** 状态探测的短超时：/api/status 会被控制台高频轮询，不能等动作级的长超时。 */
const STATUS_TIMEOUT_MS = 5000;

/** 给前端的固定停止警告（停止/重启按钮的二次确认文案用）。 */
export const STOP_WARNING = '停止/重启容器会短暂中断 OneBot；容器停止还可能丢失 QQ 登录态'
  + '（StopTimeout=80 只能缓解，不能保证）。恢复后可能需要重新扫码登录。';

/** 可管理动作白名单：只允许这三个，不给任意 systemctl 命令。 */
const ACTIONS = Object.freeze(['start', 'stop', 'restart']);

/** 动作结果/状态错误：code 给前端稳定分支，httpStatus 决定响应码。 */
export class ProtocolSideError extends Error {
  constructor(code, message, httpStatus = 500, extra = {}) {
    super(message);
    this.name = 'ProtocolSideError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.lastError = String(extra.lastError ?? '');
  }
}

/**
 * 默认 runner：真的执行一条命令。
 * 契约（注入 runner 必须遵守）：resolve `{ ok, code, stdout, stderr, timedOut?, error? }`；
 * 失败也 resolve（不 reject），超时由 execFile 的 timeout 杀进程。模块外层还有统一超时竞速，
 * 所以 stub runner 永不返回也不会挂死调用方。
 */
export function createDefaultRunner() {
  return (command, args, { timeoutMs, env } = {}) => new Promise((resolve) => {
    execFile(command, args, {
      timeout: Math.max(1, Number(timeoutMs) || STATUS_TIMEOUT_MS),
      env,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const timedOut = Boolean(error?.killed)
        || error?.signal === 'SIGTERM'
        || /timed?\s*out/i.test(String(error?.message || ''));
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut,
        error: error ? String(error?.message ?? error) : ''
      });
    });
  });
}

/** 解析 `systemctl show -p A,B` 的 Key=Value 输出。 */
export function parseSystemdShow(stdout) {
  const out = { loadState: '', activeState: '' };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'LoadState') out.loadState = value;
    else if (key === 'ActiveState') out.activeState = value;
  }
  return out;
}

/** systemd ActiveState → 四态之一。未知取值不猜：state=unknown（fail-closed，不做动作）。 */
export function mapUnitState(loadState, activeState) {
  if (loadState === 'not-found') return { state: 'absent', running: false, installed: false, note: '' };
  if (activeState === 'active' || activeState === 'activating' || activeState === 'reloading') {
    return { state: 'running', running: true, installed: true, note: '' };
  }
  if (activeState === 'inactive' || activeState === 'failed' || activeState === 'deactivating' || activeState === 'maintenance') {
    return { state: 'stopped', running: false, installed: true, note: '' };
  }
  return {
    state: 'unknown', running: false, installed: true,
    note: `LoadState=${loadState || '?'} ActiveState=${activeState || '?'}`
  };
}

/**
 * 创建协议端管理模块。
 *
 * @param {object} deps
 * @param {() => object} deps.getConfig 读取当前配置（每次调用取最新值；协议端配置热更新）
 * @param {() => {mode:string}} [deps.getProtocolMode] 协议端形态（注入 config.resolveProtocolMode 的结果，
 *        通常是 app.js 的 protocolMode()，保证与 /api/status 同一判定）
 * @param {(text: string) => void} [deps.log]
 * @param {(command:string,args:string[],opts:{timeoutMs:number,env:object}) => Promise<object>} [deps.runner]
 * @param {() => number} [deps.now] 时钟（测试注入）
 * @param {object} [deps.env] 环境变量源（默认 process.env；测试注入以断言 XDG_RUNTIME_DIR）
 * @param {() => number} [deps.getuid] uid 源（默认 process.getuid）
 */
export function createProtocolSide(deps = {}) {
  const {
    getConfig,
    getProtocolMode = () => ({ mode: 'unknown' }),
    log = () => {},
    runner = createDefaultRunner(),
    now = () => Date.now(),
    env = process.env,
    getuid = typeof process.getuid === 'function' ? () => process.getuid() : () => 0
  } = deps;
  if (typeof getConfig !== 'function') throw new TypeError('createProtocolSide 需要注入 getConfig()');
  if (typeof runner !== 'function') throw new TypeError('createProtocolSide 需要 runner 是可调用函数');

  const cfg = () => ({ ...DEFAULT_CONFIG.protocolSide, ...(getConfig()?.protocolSide || {}) });

  // 模块状态：只有"最近一次失败"需要跨调用保留（status 里要能给排障文本），其余一律现算。
  // lastErrorSource 区分来源：探测失败在下次探测成功时清掉（那是瞬时/环境问题）；
  // 动作失败要一直留到下一次动作成功（它是"用户刚才的操作失败了"的证据，别被一次状态轮询抹掉）。
  let lastError = '';
  let lastErrorSource = '';   // '' | 'probe' | 'action'
  let cache = null;   // { at, snapshot } —— statusCacheMs 内的只读缓存，避免 /api/status 轮询打爆 systemctl

  function setLastError(text, source = 'probe') {
    lastError = String(text || '');
    lastErrorSource = lastError ? source : '';
  }
  /** 探测成功：清掉"探测失败"记录，但保留动作失败记录。 */
  function clearProbeError() {
    if (lastErrorSource === 'probe') { lastError = ''; lastErrorSource = ''; }
  }
  /** 动作成功：代表现场已按用户意图变化，任何旧失败记录都可以清掉。 */
  function clearLastError() { lastError = ''; lastErrorSource = ''; }

  /** I4 唯一构造点：systemctl --user 必须显式指向部署用户的 runtime dir。 */
  function xdgRuntimeDir() {
    const fromEnv = String(env?.XDG_RUNTIME_DIR || '').trim();
    if (fromEnv) return fromEnv;
    let uid = 0;
    try { uid = Number(getuid()); } catch { uid = 0; }
    return `/run/user/${Number.isFinite(uid) ? uid : 0}`;
  }

  function runnerEnv() {
    return { ...(env || {}), XDG_RUNTIME_DIR: xdgRuntimeDir() };
  }

  /** I6：统一超时竞速。即便注入的 runner 永不 settle，也在 timeoutMs 内收敛。 */
  function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      // ⚠️ 这里**不能** unref：调用方正在 await 这个竞速结果，unref 会让"只剩这个定时器"的
      // 进程/测试直接退出（表现为动作永不收敛、进程静默 exit 0）。超时到点后清理即可。
      timer = setTimeout(() => resolve({
        ok: false,
        code: null,
        timedOut: true,
        stdout: '',
        stderr: '',
        error: `${label} 超时（${timeoutMs}ms 内未返回）`
      }), Math.max(1, Number(timeoutMs) || 1));
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** 唯一命令出口：补齐 env、套超时、把异常/非法返回都收敛成结果对象（绝不抛出）。 */
  async function callRunner(command, args, timeoutMs) {
    let result;
    try {
      result = await withTimeout(
        Promise.resolve().then(() => runner(command, args, { timeoutMs, env: runnerEnv() })),
        timeoutMs,
        `${command} ${args.join(' ')}`
      );
    } catch (error) {
      return { ok: false, code: null, timedOut: false, stdout: '', stderr: '', error: String(error?.message ?? error) };
    }
    if (!result || typeof result !== 'object') {
      return { ok: false, code: null, timedOut: false, stdout: '', stderr: '', error: `runner 返回了非法结果（${command}）` };
    }
    return {
      ok: result.ok === true,
      code: result.code ?? (result.ok ? 0 : null),
      timedOut: result.timedOut === true,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      error: String(result.error ?? '')
    };
  }

  function describeResult(result) {
    if (result.error) return result.error;
    const stderr = String(result.stderr || '').trim();
    if (stderr) return stderr;
    return `exit=${result.code ?? '未知'}`;
  }

  // ── 状态识别 ────────────────────────────────────────────────────────────

  async function readUnitState(unit, timeoutMs) {
    const result = await callRunner('systemctl', ['--user', 'show', unit, '-p', 'LoadState,ActiveState'], timeoutMs);
    if (!result.ok) {
      return { ok: false, error: `systemctl --user show ${unit} 失败：${describeResult(result)}` };
    }
    const parsed = parseSystemdShow(result.stdout);
    if (!parsed.loadState && !parsed.activeState) {
      return { ok: false, error: `systemctl --user show ${unit} 输出无法解析：${String(result.stdout).slice(0, 200) || '（空）'}` };
    }
    if (parsed.loadState === 'not-found') {
      return { ok: true, installed: false, loadState: 'not-found', activeState: '' };
    }
    return { ok: true, installed: true, loadState: parsed.loadState, activeState: parsed.activeState };
  }

  /**
   * 容器兜底识别：先确认容器存在（engine auto 时依次试 podman → docker），再 inspect 运行态。
   * 返回 { engine, exists, running:true|false|null, error }；running=null 表示存在但读不到运行态。
   * auto 模式下"某个引擎说没有"不代表下一个引擎也没有，所以不提前返回。
   */
  async function detectContainer(container, engine, timeoutMs) {
    const candidates = engine === 'auto' || !engine ? ['podman', 'docker'] : [String(engine)];
    const errors = [];
    let respondedEngine = '';   // 第一个明确回答"没有该容器"的引擎
    for (const candidate of candidates) {
      const exists = await callRunner(candidate, ['container', 'exists', container], timeoutMs);
      if (exists.ok) {
        const inspect = await callRunner(candidate, ['inspect', '--format', '{{.State.Running}}', container], timeoutMs);
        if (inspect.ok) {
          return { engine: candidate, exists: true, running: /^true$/i.test(inspect.stdout.trim()), error: '' };
        }
        return {
          engine: candidate, exists: true, running: null,
          error: `${candidate} inspect ${container} 失败：${describeResult(inspect)}`
        };
      }
      // exit=1 是"容器不存在"（podman/docker 同一约定）：记下引擎，继续试下一个。
      if (exists.code === 1) {
        respondedEngine = respondedEngine || candidate;
        continue;
      }
      // 其余（ENOENT/权限/引擎不可用）= 命令本身失败，换下一个引擎。
      errors.push(`${candidate}: ${describeResult(exists)}`);
    }
    // 只要有一个引擎明确回答"没有该容器"，就是确定的 absent；另一个引擎装没装不该污染 lastError。
    if (respondedEngine) {
      return { engine: respondedEngine, exists: false, running: false, error: '' };
    }
    return {
      engine: '',
      exists: false,
      running: false,
      error: errors.join('；') || '没有可用的容器引擎（podman/docker）'
    };
  }

  function emptySnapshot(config, mode) {
    return {
      mode,
      managed: false,
      engine: '',
      unit: String(config.unit || ''),
      container: String(config.container || ''),
      installed: false,
      running: false,
      state: 'unknown',
      detail: '',
      lastError: '',
      actions: [],
      stopWarning: STOP_WARNING
    };
  }

  function cacheAndReturn(snapshot) {
    snapshot.lastError = lastError;
    cache = { at: now(), snapshot };
    return { ...snapshot, actions: [...snapshot.actions] };
  }

  /**
   * 识别一次状态（带 statusCacheMs 缓存）。
   * 全程不抛：任何读不到都落到 state=unknown + lastError（I5），供 UI 显示、不拦启动。
   */
  async function probeStatus({ force = false } = {}) {
    const config = cfg();
    const cacheMs = Math.max(0, Number(config.statusCacheMs) || 0);
    if (!force && cache && (now() - cache.at) < cacheMs) {
      return { ...cache.snapshot, actions: [...cache.snapshot.actions] };
    }
    const mode = String(getProtocolMode()?.mode || 'unknown');
    const snapshot = emptySnapshot(config, mode);

    // 不适用（I5）：内置 SnowLuma / 未配置 时容器管理不适用 —— 连命令都不发。
    if (mode !== 'external') {
      snapshot.detail = mode === 'embedded'
        ? '内置 SnowLuma 模式：容器协议端管理不适用'
        : `协议端形态=${mode}：不启用容器协议端管理`;
      return cacheAndReturn(snapshot);
    }
    if (config.enabled === false) {
      snapshot.detail = '容器协议端管理已在配置里关闭（protocolSide.enabled=false）';
      return cacheAndReturn(snapshot);
    }
    if (!snapshot.unit) {
      setLastError('protocolSide.unit 为空，无法识别协议端');
      snapshot.detail = '未配置 systemd 单元名（protocolSide.unit）';
      return cacheAndReturn(snapshot);
    }

    const unit = await readUnitState(snapshot.unit, STATUS_TIMEOUT_MS);
    if (unit.ok && unit.installed) {
      const mapped = mapUnitState(unit.loadState, unit.activeState);
      snapshot.installed = true;
      snapshot.running = mapped.running;
      snapshot.state = mapped.state;
      snapshot.managed = true;
      if (mapped.state === 'running') {
        snapshot.actions = ['stop', 'restart'];
        snapshot.detail = `systemd 用户单元 ${snapshot.unit}：${unit.activeState || 'active'}`;
      } else if (mapped.state === 'stopped') {
        snapshot.actions = ['start', 'restart'];
        snapshot.detail = `systemd 用户单元 ${snapshot.unit}：${unit.activeState || 'inactive'}（已安装、未运行）`;
      } else {
        snapshot.actions = [];
        snapshot.detail = `systemd 用户单元 ${snapshot.unit} 状态无法归类：${mapped.note}（不做动作）`;
      }
      clearProbeError();
      return cacheAndReturn(snapshot);
    }

    // 回退容器识别。
    const container = await detectContainer(snapshot.container, config.engine, STATUS_TIMEOUT_MS);
    snapshot.engine = container.engine;

    if (unit.ok && unit.installed === false) {
      // systemctl 明确说 not-found：容器可能是手工/其它方式建的。
      if (container.exists) {
        snapshot.installed = true;
        snapshot.running = container.running === true;
        snapshot.state = container.running === true ? 'running' : (container.running === false ? 'stopped' : 'unknown');
        snapshot.managed = false;   // 动作恒走 systemctl 单元，没有单元就不假装能管
        snapshot.actions = [];
        snapshot.detail = `未找到 systemd 用户单元 ${snapshot.unit}；容器 ${snapshot.container} 存在`
          + `（engine=${container.engine}，${snapshot.running ? '运行中' : '未运行'}）：`
          + '启停/重启不可用（生命周期需 systemctl 单元），仅显示状态';
        if (container.error) setLastError(container.error);
        else clearProbeError();
        return cacheAndReturn(snapshot);
      }
      snapshot.state = 'absent';
      snapshot.installed = false;
      snapshot.managed = false;
      snapshot.actions = [];
      if (container.error) {
        setLastError(container.error);
        snapshot.detail = `未找到 systemd 用户单元 ${snapshot.unit}；容器识别也失败：${container.error}`;
      } else {
        clearProbeError();
        snapshot.detail = `未找到 systemd 用户单元 ${snapshot.unit}，也未找到容器 ${snapshot.container}（协议端未部署）`;
      }
      return cacheAndReturn(snapshot);
    }

    // systemctl 读不到（不是 not-found）⇒ 读不到 ≠ 没有：unknown + lastError（I5）。
    const reason = unit.error || 'systemctl --user 不可用';
    setLastError(reason);
    snapshot.state = 'unknown';
    snapshot.installed = container.exists === true;
    if (container.exists) {
      snapshot.running = false;
      snapshot.detail = `无法识别协议端：${reason}；容器 ${snapshot.container} 存在（engine=${container.engine}）但无法归入可管理状态`;
    } else {
      snapshot.detail = `无法识别协议端：${reason}`;
    }
    return cacheAndReturn(snapshot);
  }

  // ── 动作 ────────────────────────────────────────────────────────────────

  /**
   * 唯一动作出口（I2/I3/I6）：先确认 → 再校验可管理 → 一次 systemctl 动作 → 动作后状态。
   * 只有 external + 识别到 systemd 用户单元才允许动作；其余一律 409 PROTOCOL_NOT_MANAGED。
   */
  async function performAction(action, { confirm } = {}) {
    if (!ACTIONS.includes(action)) {
      throw new ProtocolSideError('PROTOCOL_BAD_ACTION', `不支持的动作：${action}`, 400);
    }
    if ((action === 'stop' || action === 'restart') && confirm !== true) {
      throw new ProtocolSideError(
        'CONFIRM_REQUIRED',
        `${action === 'stop' ? '停止' : '重启'}协议端需要显式确认（body {"confirm":true}）。${STOP_WARNING}`,
        400
      );
    }
    const startedAt = now();
    const before = await probeStatus({ force: true });
    if (!before.managed || before.state === 'absent' || before.state === 'unknown') {
      throw new ProtocolSideError(
        'PROTOCOL_NOT_MANAGED',
        before.detail || '协议端不归本应用管理（非外部模式 / 未识别到可管理的 systemd 用户单元）',
        409
      );
    }
    const config = cfg();
    const timeoutMs = Math.max(1, Number(config.actionTimeoutMs) || 90000);
    const result = await callRunner('systemctl', ['--user', action, config.unit], timeoutMs);
    if (!result.ok) {
      const detail = describeResult(result);
      setLastError(`systemctl --user ${action} ${config.unit} 失败：${detail}`, 'action');
      throw new ProtocolSideError(
        'PROTOCOL_ACTION_FAILED',
        `协议端 ${action} 失败：${detail}`,
        503,
        { lastError }
      );
    }
    clearLastError();
    log(`[protocol-side] systemctl --user ${action} ${config.unit} 完成`);
    const after = await probeStatus({ force: true });
    return { action, stateAfter: after.state, tookMs: Math.max(0, now() - startedAt) };
  }

  return {
    /** 完整状态快照（GET /api/protocol/status 的载荷；ok 字段由 HTTP 层补）。 */
    async status() {
      const snapshot = await probeStatus();
      return { ...snapshot, stopWarning: STOP_WARNING };
    },
    /** /api/status 用的小摘要：不放大对象（managed / running / state）。 */
    async summary() {
      const snapshot = await probeStatus();
      return { managed: snapshot.managed, running: snapshot.running, state: snapshot.state };
    },
    start: () => performAction('start'),
    stop: ({ confirm } = {}) => performAction('stop', { confirm }),
    restart: ({ confirm } = {}) => performAction('restart', { confirm }),
    /** 清只读缓存（配置/现场变更后强制下次重读；当前无定时器，保留给测试与将来）。 */
    resetCache() { cache = null; },
    /** 当前生效的 XDG_RUNTIME_DIR（排障用；不含任何凭据）。 */
    xdgRuntimeDir,
    /** 只读配置视图（排障/测试用）。 */
    config() {
      const c = cfg();
      return {
        enabled: c.enabled !== false,
        unit: String(c.unit || ''),
        container: String(c.container || ''),
        engine: String(c.engine || 'auto'),
        actionTimeoutMs: Number(c.actionTimeoutMs) || 0,
        statusCacheMs: Number(c.statusCacheMs) || 0
      };
    }
  };
}

// ── HTTP 层：把状态/异常映射成 /api/protocol/* 的响应 ───────────────────────
// 与 src/qq-login.js 的 createQQLoginHandlers 同构：本层只做「回环门 + 错误→HTTP 映射」，
// 令牌鉴权由 app.js 对全部 /api/* 的统一门负责。
const JSON_NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, body) {
  res.writeHead(status, JSON_NO_STORE);
  res.end(JSON.stringify(body));
}

function sendError(res, json, error) {
  if (error instanceof ProtocolSideError) {
    // 回环门沿用 /api 既有 {"error"} 形状；业务错误带 ok/code（/lastError）供前端分支。
    if (error.code === 'LOOPBACK_ONLY') {
      if (typeof json === 'function') return json(res, error.httpStatus, { error: error.message });
      return sendJson(res, error.httpStatus, { error: error.message });
    }
    const body = { ok: false, code: error.code, error: error.message };
    if (error.lastError) body.lastError = error.lastError;
    if (typeof json === 'function') return json(res, error.httpStatus, body);
    return sendJson(res, error.httpStatus, body);
  }
  if (typeof json === 'function') return json(res, 500, { ok: false, code: 'INTERNAL', error: '服务器内部错误' });
  return sendJson(res, 500, { ok: false, code: 'INTERNAL', error: '服务器内部错误' });
}

/**
 * 生成四个路由 handler，签名与 src/routes.js 的 handler(ctx) 一致。
 *
 * @param {{protocolSide: ReturnType<typeof createProtocolSide>, isLoopback?: (addr: string) => boolean}} opts
 */
export function createProtocolSideHandlers({ protocolSide, isLoopback = isLoopbackAddress } = {}) {
  if (!protocolSide) throw new TypeError('createProtocolSideHandlers 需要 protocolSide 实例');

  function guard(req) {
    const addr = req?.socket?.remoteAddress;
    if (!isLoopback(addr)) {
      throw new ProtocolSideError('LOOPBACK_ONLY', '仅允许回环地址访问', 403);
    }
  }

  return {
    /** GET /api/protocol/status */
    async status({ req, res, json } = {}) {
      try {
        guard(req);
        return json(res, 200, { ok: true, ...(await protocolSide.status()) });
      } catch (error) {
        return sendError(res, json, error);
      }
    },
    /** POST /api/protocol/start —— body 忽略（空 {} 合法） */
    async start({ req, res, json } = {}) {
      try {
        guard(req);
        return json(res, 200, { ok: true, ...(await protocolSide.start()) });
      } catch (error) {
        return sendError(res, json, error);
      }
    },
    /** POST /api/protocol/stop —— 需要 body {"confirm":true}（确认检查在模块内单点） */
    async stop({ req, res, json, body } = {}) {
      try {
        guard(req);
        return json(res, 200, { ok: true, ...(await protocolSide.stop({ confirm: body?.confirm === true })) });
      } catch (error) {
        return sendError(res, json, error);
      }
    },
    /** POST /api/protocol/restart —— 需要 body {"confirm":true} */
    async restart({ req, res, json, body } = {}) {
      try {
        guard(req);
        return json(res, 200, { ok: true, ...(await protocolSide.restart({ confirm: body?.confirm === true })) });
      } catch (error) {
        return sendError(res, json, error);
      }
    }
  };
}
