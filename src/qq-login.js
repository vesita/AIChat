// QQ 登录（扫码）后端模块：NapCat WebUI 客户端 + 登录状态机 + 五个接口的 handler。
//
// 设计边界（本文件是自包含深模块）：
//   - 对外只有两个入口：createQQLogin(deps)（状态机）与 createQQLoginHandlers({ qqLogin, isLoopback })（HTTP 层）。
//   - 所有外部世界依赖都注入：fetch / 时钟 / 二维码渲染 / 读文件 / home 目录 / 配置源 / 日志。
//     ⇒ 测试可以完全离线跑，不会打到真 NapCat。
//   - 令牌鉴权（authorize）与来源校验（originAllowed）不在这里实现：那是 src/app.js 对
//     全部 /api/* 的统一门，这里只额外做「只允许回环」这一层（本方案独有）。
//
// 契约来源：doc/audit/console-access-plan.md §8（NapCat WebUI API）、§9（对外接口）、
// §11（回环限定）、§14（不变量）。字段名与错误码以那份文档为准。
//
// 三条必须守住的不变量（对应文档 §14）：
//   I4  qrcodeurl 永不出现在日志、JSON 响应、SSE —— 唯一出口是 renderQr() 渲染出的图片。
//   I5  已登录（isLogin===true）时 start/refresh 必须 409，且不调用 NapCat 的取码/刷新接口。
//   I11 「读不到」「没有」「不适用」不许混用：unknown / unreachable / failed 是三个不同的 phase，
//       响应字段缺失一律 fail-closed 报 NAPCAT_BAD_RESPONSE，不许用 ?? '' 洗成空值。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { renderQrSvg } from './qq-login-qr.js';

/** 配置默认值；现场可用 config.qqLogin 覆盖任意项（文档 §12.1）。 */
export const QQ_LOGIN_DEFAULTS = Object.freeze({
  webuiUrl: 'http://127.0.0.1:6099',
  webuiTokenFile: '~/napcat/config/webui.json',
  requestTimeoutMs: 1500,
  pollIdleMs: 90000,
  actionCooldownMs: 3000,
  qrTtlMs: 120000,
  qrSvgWidth: 240,
  statusProbeMs: 1000,          // 面板轮询时对 NapCat 的最小探测间隔（防打爆 WebUI）
  credentialTtlMs: 50 * 60 * 1000, // NapCat WebUI 凭据有效期 1 小时，提前 10 分钟换
  fallbackContainerQrcode: false
});

/** 模块内错误：code 是给前端的稳定错误码，httpStatus 决定响应码。 */
export class QQLoginError extends Error {
  constructor(code, message, httpStatus = 500, retryAfterMs = 0) {
    super(message);
    this.name = 'QQLoginError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 只有 TCP 来源是回环才算回环。不看 Host / Origin / X-Forwarded-*（都可伪造）。 */
export function isLoopbackAddress(addr) {
  const a = String(addr ?? '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const AUTH_FAILED_MESSAGES = new Set([
  'token is empty',
  'token is invalid',
  'login rate limit',
  'Server token not initialized',
  'Invalid or expired code'
]);

function expandHome(p, homedir) {
  const s = String(p ?? '');
  if (s === '~') return homedir;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homedir, s.slice(2));
  return s;
}

/**
 * 创建 QQ 登录状态机。
 *
 * @param {object} deps
 * @param {() => object} deps.getConfig 读取当前配置（每次调用都要拿最新值，改配置不用重启）
 * @param {(text: string) => void} [deps.log] 日志；**禁止**打印 token / 凭据 / qrcodeurl
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now] 时钟（测试注入）
 * @param {(payload: string, opts?: object) => string} [deps.renderQr] 二维码渲染（返回 SVG 字符串）
 * @param {(file: string, enc: string) => string} [deps.readFileSync]
 * @param {() => string} [deps.homedir]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export function createQQLogin(deps = {}) {
  const {
    getConfig,
    log = () => {},
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    renderQr = renderQrSvg,
    readFileSync = fs.readFileSync,
    homedir = os.homedir,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = deps;
  if (typeof getConfig !== 'function') throw new TypeError('createQQLogin 需要注入 getConfig()');

  const cfg = () => ({ ...QQ_LOGIN_DEFAULTS, ...(getConfig()?.qqLogin || {}) });

  // ── 模块状态（唯一事实源；每次响应的快照都从这里派生）──────────────────
  const state = {
    everProbed: false,    // 是否探测过（unknown 与 unreachable 的分界；不可达后仍要允许重试恢复）
    phase: 'unknown',
    qrcodeurl: '',        // 绝不外泄
    issuedAt: 0,
    loginError: '',
    reachable: null,      // null=未探测 / false=探测过不可达 / true=可达（三义分开，不共用 false）
    latencyMs: 0,
    lastProbeAt: 0,
    lastStatusAt: 0,      // 最近一次 status() 调用（判断还有没有人看）
    lastActionAt: 0,      // 最近一次 start/refresh（冷却）
    credential: '',
    credentialAt: 0,
    inflight: null,
    inflightKind: ''
  };

  // ── 工具 ────────────────────────────────────────────────────────────────
  function tokenFile() {
    return path.resolve(expandHome(cfg().webuiTokenFile, homedir()));
  }

  function webuiBase() {
    return String(cfg().webuiUrl || '').replace(/\/+$/, '');
  }

  function readWebuiToken() {
    const file = tokenFile();
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new QQLoginError(
        'NAPCAT_AUTH_FAILED',
        `读不到 NapCat WebUI 令牌文件：${file}（检查 qqLogin.webuiTokenFile 是否指向 napcat 容器的 webui.json）`,
        503
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new QQLoginError('NAPCAT_AUTH_FAILED', `NapCat WebUI 令牌文件不是合法 JSON：${file}`, 503);
    }
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    if (!token) {
      throw new QQLoginError('NAPCAT_AUTH_FAILED', `NapCat WebUI 令牌文件里没有 token 字段：${file}`, 503);
    }
    return token;
  }

  function hashToken(token) {
    return createHash('sha256').update(token + '.napcat').digest('hex');
  }

  function errFromMessage(message, fallbackCode = 'NAPCAT_WEBUI_ERROR') {
    const msg = String(message ?? '');
    if (msg === 'QQ Is Logined') {
      return new QQLoginError('QQ_ALREADY_LOGGED_IN', 'QQ 已登录，无需扫码', 409);
    }
    if (msg === 'QRCode Get Error') {
      return new QQLoginError('NAPCAT_QR_UNAVAILABLE', 'NapCat 未能给出二维码（登录服务未就绪）', 502);
    }
    if (msg.startsWith('QRCode Refresh Error')) {
      return new QQLoginError('NAPCAT_QR_REFRESH_FAILED', `刷新二维码失败：${msg}`, 502);
    }
    if (msg === 'Unauthorized' || AUTH_FAILED_MESSAGES.has(msg)) {
      // Unauthorized 走到这里说明「重登一次后仍然 401」：凭据拿不到，归为鉴权失败而不是泛化错误
      return new QQLoginError('NAPCAT_AUTH_FAILED', `NapCat WebUI 鉴权失败：${msg || 'Unauthorized'}`, 503);
    }
    return new QQLoginError(fallbackCode, `NapCat WebUI 返回错误：${msg || '(空消息)'}`, 502);
  }

  // ── NapCat WebUI HTTP 客户端 ────────────────────────────────────────────
  /**
   * POST {webuiUrl}/api/{pathname}，按 code 判成败（NapCat 的失败也是 HTTP 200）。
   * Unauthorized ⇒ 凭据过期：清掉重登一次再试（只重试一次）。
   */
  async function webuiPost(pathname, body, opts = {}) {
    const { allowRelogin = true } = opts;
    if (typeof fetchImpl !== 'function') {
      throw new QQLoginError('NAPCAT_WEBUI_UNREACHABLE', '当前运行环境没有可用的 fetch', 503);
    }
    const url = `${webuiBase()}/api/${pathname}`;
    const timeoutMs = Number(cfg().requestTimeoutMs) > 0 ? Number(cfg().requestTimeoutMs) : 1500;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeoutFn(() => controller.abort(), timeoutMs) : null;
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(state.credential ? { authorization: `Bearer ${state.credential}` } : {})
        },
        body: JSON.stringify(body ?? {}),
        signal: controller?.signal
      });
      text = await res.text();
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new QQLoginError('NAPCAT_WEBUI_UNREACHABLE', `连 NapCat WebUI 超时（${timeoutMs}ms）：${webuiBase()}`, 503);
      }
      throw new QQLoginError('NAPCAT_WEBUI_UNREACHABLE', `连不上 NapCat WebUI：${webuiBase()}（确认 napcat 容器在运行）`, 503);
    } finally {
      if (timer) clearTimeoutFn(timer);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new QQLoginError('NAPCAT_BAD_RESPONSE', `NapCat WebUI 返回的不是 JSON（HTTP ${res?.status}）`, 502);
    }
    if (!payload || typeof payload !== 'object') {
      throw new QQLoginError('NAPCAT_BAD_RESPONSE', 'NapCat WebUI 响应不是对象', 502);
    }
    if (payload.code !== 0) {
      const msg = String(payload.message ?? '');
      if (msg === 'Unauthorized' && allowRelogin) {
        state.credential = '';
        state.credentialAt = 0;
        await ensureCredential({ force: true });
        return webuiPost(pathname, body, { allowRelogin: false });
      }
      throw errFromMessage(msg);
    }
    return payload.data;
  }

  async function ensureCredential({ force = false } = {}) {
    const ttl = Number(cfg().credentialTtlMs) > 0 ? Number(cfg().credentialTtlMs) : QQ_LOGIN_DEFAULTS.credentialTtlMs;
    if (!force && state.credential && now() - state.credentialAt < ttl) return state.credential;
    const token = readWebuiToken();
    const data = await webuiPost('auth/login', { hash: hashToken(token) }, { allowRelogin: false });
    if (!data || typeof data !== 'object') {
      throw new QQLoginError('NAPCAT_BAD_RESPONSE', 'NapCat WebUI 登录响应缺少 data', 502);
    }
    if (data.require2FA && !data.Credential) {
      throw new QQLoginError(
        'NAPCAT_AUTH_2FA_REQUIRED',
        'NapCat WebUI 启用了两步验证：本模块无法自动登录。请在 NapCat WebUI 里关闭 2FA，或改用容器文件兜底（qqLogin.fallbackContainerQrcode）',
        503
      );
    }
    const credential = typeof data.Credential === 'string' ? data.Credential : '';
    if (!credential) {
      throw new QQLoginError('NAPCAT_AUTH_FAILED', 'NapCat WebUI 登录没有返回凭据（Credential 为空）', 503);
    }
    state.credential = credential;
    state.credentialAt = now();
    log('[qq-login] NapCat WebUI 凭据已刷新');
    return credential;
  }

  // ── 登录状态探测 ────────────────────────────────────────────────────────
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new QQLoginError('NAPCAT_BAD_RESPONSE', 'NapCat WebUI 登录状态响应不是对象', 502);
    }
    const { isLogin, isOffline, loginPhase, qrcodeurl, loginError } = raw;
    // fail-closed：判定的两个关键字段缺失就是契约不符，绝不猜一个默认值。
    if (typeof isLogin !== 'boolean') {
      throw new QQLoginError('NAPCAT_BAD_RESPONSE', 'NapCat WebUI 响应缺少 loginPhase / isLogin 字段（契约不符）', 502);
    }
    if (typeof loginPhase !== 'string') {
      throw new QQLoginError('NAPCAT_BAD_RESPONSE', 'NapCat WebUI 响应缺少 loginPhase 字段（契约不符）', 502);
    }
    const qr = typeof qrcodeurl === 'string' ? qrcodeurl : '';
    const err = typeof loginError === 'string' ? loginError : '';
    const offline = isOffline === true;

    let phase;
    if (isLogin) {
      phase = 'logged_in';
    } else if (isOffline) {
      phase = 'qq_offline';
    } else if (loginPhase === 'qrcode_scanned' || loginPhase === 'qrLoginAccepted') {
      phase = 'qr_scanned';
    } else if (loginPhase === 'initializing') {
      phase = 'initializing';
    } else if (loginPhase === 'reconnecting') {
      phase = 'restarting';
    } else if ((loginPhase === 'waiting_qrcode' || loginPhase === 'generating_qrcode') && qr) {
      phase = 'qr_waiting';
    } else if (err && (err.includes('过期') || err.includes('失效') || err.includes('超时'))) {
      phase = 'expired';
    } else if (err) {
      phase = 'failed';
    } else if (loginPhase === 'waiting_qrcode' || loginPhase === 'generating_qrcode') {
      // 有等待态但没有码：不是「等待扫码」，是取码失败（诚实地区分「没有」与「读不到」）
      phase = 'failed';
    } else {
      phase = 'failed';
    }

    return { phase, isLogin, offline, qrcodeurl: qr, loginError: err, rawPhase: loginPhase };
  }

  async function probe() {
    await ensureCredential();
    const startedAt = now();
    const data = await webuiPost('QQLogin/CheckLoginStatus', {});
    const normalized = normalize(data);
    state.latencyMs = Math.max(0, now() - startedAt);
    state.reachable = true;
    state.everProbed = true;
    state.lastProbeAt = now();
    state.loginError = normalized.loginError;
    if (normalized.rawPhase === 'reconnecting') {
      state.phase = 'restarting';
      state.qrcodeurl = '';
      state.issuedAt = 0;
      return state;
    }
    state.phase = normalized.phase;
    if (normalized.qrcodeurl) {
      // 码变了才刷新 issuedAt，避免前端无谓重建 <img>
      if (normalized.qrcodeurl !== state.qrcodeurl) {
        state.qrcodeurl = normalized.qrcodeurl;
        state.issuedAt = now();
      }
    } else if (normalized.phase !== 'qr_scanned' && normalized.phase !== 'initializing') {
      state.qrcodeurl = '';
      state.issuedAt = 0;
    }
    return state;
  }

  function markUnreachable(error) {
    state.everProbed = true;
    state.reachable = false;
    state.phase = 'unreachable';
    state.qrcodeurl = '';
    state.issuedAt = 0;
    state.loginError = error?.message ?? String(error);
    state.lastProbeAt = now();
    return state;
  }

  // 探测失败的三种去向：契约不符要暴露（502），连不上/鉴权失败是「子系统的真实状态」（200 里如实说）。
  async function probeForStatus() {
    try {
      return await probe();
    } catch (error) {
      if (error instanceof QQLoginError && error.code === 'NAPCAT_BAD_RESPONSE') throw error;
      markUnreachable(error);
      return state;
    }
  }

  async function probeForAction() {
    try {
      return await probe();
    } catch (error) {
      // 连不上/鉴权失败是子系统的真实状态，记下来再抛（面板下次 status 能读到 unreachable）；
      // 契约不符（502）不写状态，那是要被修的程序缺陷，不许被「unreachable」盖住。
      if (error instanceof QQLoginError && error.code !== 'NAPCAT_BAD_RESPONSE') markUnreachable(error);
      throw error;
    }
  }

  function retryAfterMs() {
    const cooldown = Number(cfg().actionCooldownMs);
    if (!(cooldown > 0) || !state.lastActionAt) return 0;
    return Math.max(0, cooldown - (now() - state.lastActionAt));
  }

  function snapshot() {
    const c = cfg();
    const qrAvailable = state.phase === 'qr_waiting' && state.qrcodeurl !== '';
    const ttl = Number(c.qrTtlMs) > 0 ? Number(c.qrTtlMs) : QQ_LOGIN_DEFAULTS.qrTtlMs;
    const watching = state.lastStatusAt > 0 && now() - state.lastStatusAt <= Number(c.pollIdleMs);
    let error = null;
    if (state.phase === 'unreachable') {
      error = { code: 'NAPCAT_WEBUI_UNREACHABLE', message: state.loginError };
    } else if (state.phase === 'expired') {
      error = { code: 'QR_EXPIRED', message: state.loginError || '二维码已过期' };
    } else if (state.phase === 'failed') {
      error = { code: 'NAPCAT_LOGIN_FAILED', message: state.loginError || 'NapCat 登录失败' };
    } else if (state.phase === 'qq_offline') {
      error = { code: 'QQ_OFFLINE', message: 'QQ 已登录但当前离线' };
    }
    return {
      ok: true,
      phase: state.phase,
      loggedIn: state.phase === 'logged_in',
      offline: state.phase === 'qq_offline',
      account: { uin: '', nickname: '' },
      qr: {
        available: qrAvailable,
        issuedAt: qrAvailable ? state.issuedAt : 0,
        expiresInMs: qrAvailable ? Math.max(0, ttl - (now() - state.issuedAt)) : 0
      },
      napcat: {
        reachable: state.reachable,
        webuiUrl: webuiBase(),
        latencyMs: state.latencyMs
      },
      watchers: watching ? 1 : 0,
      retryAfterMs: retryAfterMs(),
      error
    };
  }

  // ── 对外：状态 ──────────────────────────────────────────────────────────
  /** 被动查询：冷启动返回 unknown（探测由 start() 触发）；之后按 statusProbeMs 节流探测。
   *  phase 为 unreachable 时也继续按节流重试 —— 否则 NapCat 恢复后控制台永远停在「不可用」。 */
  async function status() {
    state.lastStatusAt = now();
    if (!state.everProbed) return snapshot();
    const interval = Number(cfg().statusProbeMs);
    if (!(interval > 0) || now() - state.lastProbeAt >= interval) {
      await probeForStatus();
    }
    return snapshot();
  }

  // ── 对外：开始扫码（幂等）──────────────────────────────────────────────
  async function start() {
    state.lastStatusAt = now();
    // 幂等优先于冷却：手里已经有新鲜二维码时重复点「开始」不该报「太频繁」（文档 §9.4 第 1 步）
    const ttl = Number(cfg().qrTtlMs) > 0 ? Number(cfg().qrTtlMs) : QQ_LOGIN_DEFAULTS.qrTtlMs;
    const freshWindow = Math.min(90_000, ttl);
    if (state.phase === 'qr_waiting' && state.qrcodeurl && now() - state.issuedAt < freshWindow) {
      return snapshot();
    }
    const wait = retryAfterMs();
    if (wait > 0) throw new QQLoginError('RATE_LIMITED', '操作太频繁，请稍后再试', 429, wait);
    if (state.inflight) return state.inflight;
    state.lastActionAt = now();
    state.inflightKind = 'start';
    state.inflight = (async () => {
      await probeForAction();
      if (state.phase === 'logged_in') {
        throw new QQLoginError('QQ_ALREADY_LOGGED_IN', 'QQ 已登录，无需扫码', 409);
      }
      if (state.phase === 'qr_waiting' && state.qrcodeurl) return snapshot();
      // 已有可用码就不打扰 NapCat；否则按「状态里没码 → 取码 → 仍没有 → 刷新」的顺序（文档 §9.4）
      if (state.phase !== 'qr_waiting' && state.phase !== 'qr_scanned' && state.phase !== 'initializing') {
        try {
          const data = await webuiPost('QQLogin/GetQQLoginQrcode', {});
          const qr = typeof data?.qrcode === 'string' ? data.qrcode : '';
          if (qr) {
            state.qrcodeurl = qr;
            state.issuedAt = now();
            state.phase = 'qr_waiting';
            return snapshot();
          }
        } catch (error) {
          if (!(error instanceof QQLoginError) || error.code !== 'NAPCAT_QR_UNAVAILABLE') throw error;
        }
        await refreshQr();
      }
      return snapshot();
    })().finally(() => { state.inflight = null; state.inflightKind = ''; });
    return state.inflight;
  }

  async function refreshQr() {
    const data = await webuiPost('QQLogin/RefreshQRcode', {});
    if (data?.restarting === true) {
      state.phase = 'restarting';
      state.qrcodeurl = '';
      state.issuedAt = 0;
      return snapshot();
    }
    const qr = typeof data?.qrcodeurl === 'string' ? data.qrcodeurl : '';
    if (qr) {
      if (qr !== state.qrcodeurl) {
        state.qrcodeurl = qr;
        state.issuedAt = now();
      }
      state.phase = 'qr_waiting';
      state.loginError = '';
    } else if (!state.qrcodeurl) {
      throw new QQLoginError('NAPCAT_QR_UNAVAILABLE', 'NapCat 刷新后仍没有可用二维码', 502);
    }
    return snapshot();
  }

  // ── 对外：强制刷新二维码 ───────────────────────────────────────────────
  async function refresh() {
    state.lastStatusAt = now();
    const wait = retryAfterMs();
    if (wait > 0) throw new QQLoginError('RATE_LIMITED', '操作太频繁，请稍后再试', 429, wait);
    if (state.inflight) return state.inflight;
    state.lastActionAt = now();
    state.inflightKind = 'refresh';
    state.inflight = (async () => {
      await probeForAction();
      if (state.phase === 'logged_in') {
        throw new QQLoginError('QQ_ALREADY_LOGGED_IN', 'QQ 已登录，无需扫码', 409);
      }
      return refreshQr();
    })().finally(() => { state.inflight = null; state.inflightKind = ''; });
    return state.inflight;
  }

  // ── 对外：二维码 SVG ───────────────────────────────────────────────────
  async function qrcodeSvg() {
    state.lastStatusAt = now();
    if (!state.everProbed) {
      throw new QQLoginError('NO_QR_AVAILABLE', '还没有二维码：请先调用 /api/qq-login/start', 404);
    }
    if (state.phase === 'logged_in') {
      throw new QQLoginError('QQ_ALREADY_LOGGED_IN', 'QQ 已登录，无需扫码', 409);
    }
    if (state.phase === 'expired') {
      throw new QQLoginError('QR_EXPIRED', '二维码已过期，请刷新', 410);
    }
    if (!state.qrcodeurl) {
      const interval = Number(cfg().statusProbeMs);
      if (!(interval > 0) || now() - state.lastProbeAt >= interval) await probeForStatus();
    }
    if (state.phase === 'expired') throw new QQLoginError('QR_EXPIRED', '二维码已过期，请刷新', 410);
    if (!state.qrcodeurl) {
      throw new QQLoginError('NO_QR_AVAILABLE', '当前没有可用二维码', 404);
    }
    let svg;
    try {
      svg = renderQr(state.qrcodeurl, { width: Number(cfg().qrSvgWidth) || 240, margin: 1, errorCorrectionLevel: 'M' });
    } catch (error) {
      // 渲染失败是程序缺陷，不重试、不当 404，暴露出来
      throw new QQLoginError('QR_RENDER_FAILED', `二维码渲染失败：${error?.message ?? error}`, 500);
    }
    return { svg, issuedAt: state.issuedAt };
  }

  // ── 对外：取消本次扫码（不碰 NapCat、不登出）────────────────────────────
  function stop() {
    const wasActive = state.everProbed || state.phase !== 'unknown';
    state.everProbed = false;
    state.phase = 'unknown';
    state.qrcodeurl = '';
    state.issuedAt = 0;
    state.loginError = '';
    state.reachable = null;
    state.latencyMs = 0;
    state.lastProbeAt = 0;
    state.lastStatusAt = 0;
    return { ok: true, stopped: wasActive, watchers: 0 };
  }

  /** 进程退出时调用；幂等。 */
  function dispose() {
    state.credential = '';
    state.credentialAt = 0;
    state.inflight = null;
    state.inflightKind = '';
  }

  return {
    status,
    start,
    refresh,
    qrcodeSvg,
    stop,
    dispose,
    // 供 HTTP 层判断「取消时是否有生成任务在飞」
    get inflightKind() { return state.inflightKind; },
    hasInflight() { return Boolean(state.inflight); },
    // 只读配置视图（排障/测试用；不含令牌）
    config() {
      const c = cfg();
      return {
        webuiUrl: webuiBase(),
        webuiTokenFile: tokenFile(),
        requestTimeoutMs: c.requestTimeoutMs,
        pollIdleMs: c.pollIdleMs,
        actionCooldownMs: c.actionCooldownMs,
        qrTtlMs: c.qrTtlMs,
        fallbackContainerQrcode: Boolean(c.fallbackContainerQrcode)
      };
    }
  };
}

// ── HTTP 层：把状态机的返回/异常映射成 /api/qq-login/* 的响应 ─────────────
const JSON_NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, body) {
  res.writeHead(status, JSON_NO_STORE);
  res.end(JSON.stringify(body));
}

function sendError(res, json, error) {
  if (error instanceof QQLoginError) {
    // 回环门沿用 /api 既有的 {"error": "..."} 形状（与 app.js 的 401/403 一致）；
    // 业务错误才带 ok/code，方便前端按 code 分支。
    if (error.code === 'LOOPBACK_ONLY') {
      if (typeof json === 'function') return json(res, error.httpStatus, { error: error.message });
      return sendJson(res, error.httpStatus, { error: error.message });
    }
    const body = { ok: false, code: error.code, error: error.message };
    if (error.retryAfterMs > 0) body.retryAfterMs = error.retryAfterMs;
    if (typeof json === 'function') return json(res, error.httpStatus, body);
    return sendJson(res, error.httpStatus, body);
  }
  // 未知异常：日志里由调用方记录，响应只给稳定错误码
  if (typeof json === 'function') return json(res, 500, { ok: false, code: 'INTERNAL', error: '服务器内部错误' });
  return sendJson(res, 500, { ok: false, code: 'INTERNAL', error: '服务器内部错误' });
}

/**
 * 生成五个路由 handler，签名与 src/routes.js 的 handler(ctx) 一致。
 * 这里只做两件事：回环门 + 异常→HTTP 映射；令牌鉴权由 app.js 的统一门负责。
 *
 * @param {{qqLogin: ReturnType<typeof createQQLogin>, isLoopback?: (addr: string) => boolean}} opts
 */
export function createQQLoginHandlers({ qqLogin, isLoopback = isLoopbackAddress } = {}) {
  if (!qqLogin) throw new TypeError('createQQLoginHandlers 需要 qqLogin 实例');

  function guard(req) {
    const addr = req?.socket?.remoteAddress;
    if (!isLoopback(addr)) {
      throw new QQLoginError('LOOPBACK_ONLY', '仅允许回环地址访问', 403);
    }
  }

  return {
    /** GET /api/qq-login/status */
    async status({ req, res, json } = {}) {
      try {
        guard(req);
        return json(res, 200, await qqLogin.status());
      } catch (error) {
        return sendError(res, json, error);
      }
    },

    /** POST /api/qq-login/start —— 请求体忽略（空 {} 合法） */
    async start({ req, res, json } = {}) {
      try {
        guard(req);
        return json(res, 200, await qqLogin.start());
      } catch (error) {
        return sendError(res, json, error);
      }
    },

    /** POST /api/qq-login/refresh */
    async refresh({ req, res, json } = {}) {
      try {
        guard(req);
        return json(res, 200, await qqLogin.refresh());
      } catch (error) {
        return sendError(res, json, error);
      }
    },

    /** GET /api/qq-login/qrcode.svg —— 直接写图片二进制，不走 json() */
    async qrcode({ req, res, json } = {}) {
      try {
        guard(req);
        const { svg } = await qqLogin.qrcodeSvg();
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        res.end(svg);
        return undefined;
      } catch (error) {
        return sendError(res, json, error);
      }
    },

    /** DELETE /api/qq-login/session */
    async session({ req, res, json } = {}) {
      try {
        guard(req);
        if (qqLogin.hasInflight()) {
          const retryAfterMs = 500;
          return sendError(res, json, new QQLoginError(
            'GENERATION_IN_FLIGHT', '正在生成二维码，请稍后再取消', 409, retryAfterMs
          ));
        }
        return json(res, 200, qqLogin.stop());
      } catch (error) {
        return sendError(res, json, error);
      }
    }
  };
}
