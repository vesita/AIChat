// 〔QQ 扫码登录面板 / 令牌输入框〕——M9 拆分第 13 段
// 必须在 12-concept2-ui.js 之后、11-init.js 之前加载（11-init 会调用这里的函数）。
//
// 设计边界（§13.1，写死）：
//   · 登录态的**唯一**判据是 /api/qq-login/status 的 phase；不从 onebot.connected
//     反推（QQ 已登录但离线时它同样是 false —— 那时该显示 qq_offline，不是"未登录"）。
//   · 二维码只经 <img src> 拿服务端渲染的 SVG：qrcodeurl 是「能登录机器人」的凭据，
//     不进入浏览器 JS / localStorage / 历史记录（§9.6）。
//   · 发现未登录只做「把登录补回来」：不提供登出/重启/重置设备，关闭面板只 DELETE
//     服务端轮询会话，不碰 QQ 登录态。
'use strict';

// 阶段文案唯一实现点（§13.1 的文案直接抄这里，别再各写一份）。
const QQ_LOGIN_PHASE_TEXT = {
  unknown: { title: '正在检测 QQ 登录状态…', hint: '首次打开面板需要几秒。' },
  qr_waiting: { title: '请用 QQ 扫描二维码登录', hint: '二维码有效期约 2 分钟；过期后点「刷新二维码」。' },
  qr_scanned: { title: '已扫码，请在手机上确认', hint: '在手机上点「确认登录」后会自动继续。' },
  initializing: { title: '登录成功，正在启动 QQ…', hint: '正在拉起 QQ 与 OneBot，通常需要几秒到几十秒。' },
  restarting: { title: '正在准备新的二维码…', hint: 'NapCat 登录服务重启中，最长可能需要 3 分钟。' },
  expired: { title: '二维码已过期，请点刷新', hint: '二维码有有效期，点「刷新二维码」获取新码。' },
  unreachable: { title: '连不上 NapCat WebUI（127.0.0.1:6099）', hint: '请确认 NapCat 容器已运行：systemctl --user status napcat' },
  qq_offline: { title: 'QQ 已登录但当前离线', hint: '登录态还在，正在等待网络恢复；无需重新扫码。' },
  failed: { title: '登录失败', hint: '可点「刷新二维码」重试；若持续失败请查看 NapCat 日志。' },
  logged_in: { title: '已登录', hint: '' }
};

/** 面板/轮询的可变状态（同一时刻最多一个面板）。 */
let qqLoginState = {
  overlay: null, timer: null, cooldownTimer: null,
  onDismiss: null, status: null, qrIssuedAt: 0, busy: false
};

/** 从 /api/qq-login/status 的 error 字段里取可读文案（形状可能来自不同失败分支）。 */
function qqLoginErrorText(status) {
  const err = status?.error;
  if (!err) return '';
  if (typeof err === 'string') return err.trim();
  return String(err.error || err.message || err.code || '').trim();
}

/**
 * phase → 文案（纯函数，唯一渲染口径）。测试按它断言 6 种以上阶段文案。
 * 返回 { title, hint, showQr }。
 */
function qqLoginPhaseText(phase, status) {
  const key = String(phase || 'unknown');
  const base = QQ_LOGIN_PHASE_TEXT[key] || QQ_LOGIN_PHASE_TEXT.failed;
  let title = base.title;
  if (key === 'failed') {
    const detail = String(status?.loginError || '').trim() || qqLoginErrorText(status);
    if (detail) title += `：${detail}`;
  } else if (key === 'unreachable') {
    const detail = qqLoginErrorText(status);
    if (detail) title += `（${detail}）`;
  }
  return { title, hint: base.hint, showQr: key === 'qr_waiting' };
}

function qqLoginEl(sel) {
  return qqLoginState.overlay ? qqLoginState.overlay.querySelector(sel) : null;
}

/** 打开扫码登录面板；onDismiss 在面板关闭/登录成功后调用（首屏引导时用于进入控制台）。 */
function openQQLoginPanel({ onDismiss = null } = {}) {
  if (qqLoginState.overlay) {
    if (onDismiss) qqLoginState.onDismiss = onDismiss;
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = 'qq-login-overlay';
  overlay.className = 'qq-login-overlay';
  overlay.innerHTML = `
    <div class="qq-login-card" role="dialog" aria-modal="true" aria-labelledby="qq-login-title">
      <button class="qq-login-close" id="qq-login-close" title="关闭" aria-label="关闭">×</button>
      <h2 id="qq-login-title">QQ 扫码登录</h2>
      <p class="qq-login-hint muted" id="qq-login-hint"></p>
      <div class="qq-login-qr hidden" id="qq-login-qr">
        <img id="qq-login-qr-img" alt="QQ 登录二维码" width="240" height="240" />
      </div>
      <div class="qq-login-phase" id="qq-login-phase"></div>
      <div class="qq-login-error hidden" id="qq-login-error"></div>
      <div class="qq-login-actions">
        <button class="btn btn-primary" id="qq-login-refresh">刷新二维码</button>
        <button class="btn" id="qq-login-retry">重新检测</button>
        <button class="btn" id="qq-login-later">稍后再说</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  qqLoginState = {
    overlay, timer: null, cooldownTimer: null,
    onDismiss, status: null, qrIssuedAt: 0, busy: false
  };
  overlay.querySelector('#qq-login-close')?.addEventListener('click', () => closeQQLoginPanel());
  overlay.querySelector('#qq-login-later')?.addEventListener('click', () => closeQQLoginPanel());
  overlay.querySelector('#qq-login-retry')?.addEventListener('click', () => refreshQQLoginStatus());
  overlay.querySelector('#qq-login-refresh')?.addEventListener('click', () => refreshQQLoginQr());
  // 进入面板立刻检测；phase=unknown 说明本进程还没探测过 —— 先 POST start（§13.1）
  initialQQLoginCheck();
}

/** 关闭面板：清定时器 + DELETE 服务端轮询会话（幂等、不碰 QQ 登录态）。 */
function closeQQLoginPanel({ silent = false } = {}) {
  stopQQLoginPolling();
  if (qqLoginState.cooldownTimer) { clearInterval(qqLoginState.cooldownTimer); qqLoginState.cooldownTimer = null; }
  const overlay = qqLoginState.overlay;
  const onDismiss = qqLoginState.onDismiss;
  qqLoginState = {
    overlay: null, timer: null, cooldownTimer: null,
    onDismiss: null, status: null, qrIssuedAt: 0, busy: false
  };
  if (overlay) {
    try { overlay.remove(); } catch { /* ignore */ }
  }
  if (!silent) {
    // DELETE 只停服务端轮询与缓存；不调用 NapCat 任何接口、不登出 QQ（§9.7）
    api('/api/qq-login/session', { method: 'DELETE', body: '{}' }).catch(() => { /* 面板已关，失败无副作用 */ });
  }
  try { onDismiss?.(); } catch { /* 回调错误不影响关闭 */ }
}

/** 停掉轮询（关闭面板 / 测试用）。 */
function stopQQLoginPolling() {
  if (qqLoginState.timer) {
    clearTimeout(qqLoginState.timer);
    qqLoginState.timer = null;
  }
}

/** 轮询节拍（§13.1）：扫码/重启 1.5s，初始化 1s，故障态 5s（等用户点按钮，别白刷）。 */
function qqLoginPollDelay(phase) {
  if (phase === 'qr_waiting' || phase === 'qr_scanned' || phase === 'restarting') return 1500;
  if (phase === 'initializing') return 1000;
  return 5000;
}

function scheduleQQLoginPoll(phase) {
  stopQQLoginPolling();
  if (!qqLoginState.overlay || phase === 'logged_in') return;
  qqLoginState.timer = setTimeout(() => {
    qqLoginState.timer = null;
    pollQQLoginStatus();
  }, qqLoginPollDelay(phase));
}

/**
 * 按 status 渲染面板（纯渲染，不发起请求、不排定时器 —— 测试可直接逐 phase 调它）。
 * 已登录 ⇒ 关闭面板（首屏引导时 onDismiss 会进入控制台）。
 */
function renderQQLoginState(status) {
  if (!qqLoginState.overlay) return;
  const st = status && typeof status === 'object' ? status : {};
  qqLoginState.status = st;
  const phase = String(st.phase || 'unknown');
  if (phase === 'logged_in' || st.loggedIn === true) {
    closeQQLoginPanel({ silent: true });   // 已登录：服务端没有要停的轮询
    return;
  }
  const view = qqLoginPhaseText(phase, st);
  const overlay = qqLoginState.overlay;
  overlay.setAttribute('data-phase', phase);

  const phaseEl = qqLoginEl('#qq-login-phase');
  if (phaseEl) phaseEl.textContent = view.title;
  const hintEl = qqLoginEl('#qq-login-hint');
  if (hintEl) hintEl.textContent = view.hint;

  const errEl = qqLoginEl('#qq-login-error');
  const errorText = qqLoginErrorText(st);
  if (errEl) {
    errEl.textContent = errorText;
    errEl.classList.toggle('hidden', !errorText);
  }

  // 二维码：只在 qr_waiting 且有可用码时显示；issuedAt 变化才换 src（防整图重载闪烁）
  const qrBox = qqLoginEl('#qq-login-qr');
  const img = qqLoginEl('#qq-login-qr-img');
  const showQr = view.showQr && !!st.qr?.available;
  if (qrBox) qrBox.classList.toggle('hidden', !showQr);
  if (img && showQr) {
    const issuedAt = Number(st.qr?.issuedAt) || 0;
    if (issuedAt !== qqLoginState.qrIssuedAt || !img.getAttribute('src')) {
      qqLoginState.qrIssuedAt = issuedAt;
      const src = withConsoleToken(consoleUrl('/api/qq-login/qrcode.svg'));
      const sep = src.includes('?') ? '&' : '?';
      img.setAttribute('src', `${src}${sep}v=${encodeURIComponent(String(issuedAt || Date.now()))}`);
    }
  }

  // 按钮：初始化/已扫码阶段刷新无意义；故障态三个按钮都保留（用户可重试/稍后）
  const refreshBtn = qqLoginEl('#qq-login-refresh');
  if (refreshBtn) refreshBtn.disabled = qqLoginState.busy || phase === 'initializing' || phase === 'qr_scanned';
  return { phase, view };
}

async function initialQQLoginCheck() {
  if (!qqLoginState.overlay) return;
  try {
    let st = await api('/api/qq-login/status');
    if (!qqLoginState.overlay) return;    // 请求期间用户关了面板
    if (String(st?.phase || '') === 'unknown') {
      st = await api('/api/qq-login/start', { method: 'POST', body: '{}' });
      if (!qqLoginState.overlay) return;
    }
    renderQQLoginState(st);
    scheduleQQLoginPoll(String(st?.phase || 'unknown'));
  } catch (e) {
    handleQQLoginError(e);
  }
}

async function pollQQLoginStatus() {
  if (!qqLoginState.overlay) return;
  try {
    const st = await api('/api/qq-login/status');
    if (!qqLoginState.overlay) return;
    renderQQLoginState(st);
    scheduleQQLoginPoll(String(st?.phase || 'unknown'));
  } catch (e) {
    handleQQLoginError(e);
  }
}

/** 「重新检测」按钮：立即查一次状态（不触发取码）。 */
async function refreshQQLoginStatus() {
  if (!qqLoginState.overlay) return;
  try {
    const st = await api('/api/qq-login/status');
    if (!qqLoginState.overlay) return;
    renderQQLoginState(st);
    scheduleQQLoginPoll(String(st?.phase || 'unknown'));
  } catch (e) {
    handleQQLoginError(e);
  }
}

/** 「刷新二维码」按钮：强制重新取码；429 显示冷却倒计时（§9.5）。 */
async function refreshQQLoginQr() {
  if (!qqLoginState.overlay || qqLoginState.busy) return;
  qqLoginState.busy = true;
  const btn = qqLoginEl('#qq-login-refresh');
  if (btn) btn.disabled = true;
  try {
    const st = await api('/api/qq-login/refresh', { method: 'POST', body: '{}' });
    if (!qqLoginState.overlay) return;
    qqLoginState.busy = false;
    renderQQLoginState(st);
    scheduleQQLoginPoll(String(st?.phase || 'unknown'));
  } catch (e) {
    qqLoginState.busy = false;
    if (!qqLoginState.overlay) return;
    if (e?.code === 'RATE_LIMITED') {
      startQQLoginCooldown(e?.data?.retryAfterMs ?? 3000);
      return;
    }
    handleQQLoginError(e);
  }
}

/** 429 后的按钮倒计时（避免用户连点把 NapCat 登录服务打崩）。 */
function startQQLoginCooldown(retryAfterMs) {
  const btn = qqLoginEl('#qq-login-refresh');
  if (!btn) return;
  if (qqLoginState.cooldownTimer) clearInterval(qqLoginState.cooldownTimer);
  let left = Math.max(0, Number(retryAfterMs) || 0);
  const tick = () => {
    if (!qqLoginState.overlay) return;
    if (left <= 0) {
      clearInterval(qqLoginState.cooldownTimer);
      qqLoginState.cooldownTimer = null;
      btn.disabled = false;
      btn.textContent = '刷新二维码';
      return;
    }
    btn.disabled = true;
    btn.textContent = `请稍候 ${Math.ceil(left / 1000)} 秒`;
    left -= 1000;
  };
  tick();
  qqLoginState.cooldownTimer = setInterval(tick, 1000);
}

/** 面板请求失败 → 映射成可读状态；未授权则切令牌输入框。 */
function handleQQLoginError(err) {
  if (!qqLoginState.overlay) return;
  const code = String(err?.code || '');
  if (code === 'UNAUTHORIZED') {
    closeQQLoginPanel({ silent: true });
    openTokenPrompt();
    return;
  }
  if (code === 'QQ_ALREADY_LOGGED_IN') {
    closeQQLoginPanel({ silent: true });   // 已登录：面板关闭即可（首屏引导会进控制台）
    return;
  }
  const phase = code === 'NAPCAT_WEBUI_UNREACHABLE' || code === 'NAPCAT_AUTH_FAILED' ? 'unreachable' : 'failed';
  const detail = err?.data?.error || err?.message || String(err);
  renderQQLoginState({ phase, error: { code: code || 'INTERNAL', error: detail } });
  scheduleQQLoginPoll(phase);
}

/**
 * 首屏无令牌/错令牌的引导（§10.3）：全屏卡片 + 密码框，提交后存 sessionStorage 并重载。
 * 不许白屏，也不许把用户锁在门外 —— 提示里写明令牌从哪来。
 */
function openTokenPrompt() {
  if (document.getElementById('qq-token-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'qq-token-overlay';
  overlay.className = 'qq-login-overlay';
  overlay.innerHTML = `
    <div class="qq-login-card" role="dialog" aria-modal="true" aria-labelledby="qq-token-title">
      <h2 id="qq-token-title">需要控制台访问令牌</h2>
      <p class="qq-login-hint muted">
        控制台已开启令牌校验。令牌来自配置文件 <code>data/config.json</code> 的
        <code>server.token</code>，或由管理员用一次性的 <code>POST /api/config</code> 设置。
      </p>
      <div class="field">
        <input type="password" id="qq-token-input" placeholder="请输入控制台访问令牌" autocomplete="off" />
      </div>
      <div class="qq-login-actions">
        <button class="btn btn-primary" id="qq-token-enter">进入</button>
      </div>
      <div class="qq-login-error hidden" id="qq-token-error"></div>
    </div>`;
  document.body.appendChild(overlay);
  const errorEl = overlay.querySelector('#qq-token-error');
  const submit = () => {
    const input = overlay.querySelector('#qq-token-input');
    const value = String(input?.value || '').trim();
    if (!value) {
      if (errorEl) {
        errorEl.textContent = '令牌不能为空';
        errorEl.classList.remove('hidden');
      }
      return;
    }
    setConsoleToken(value);
    try { location.reload(); } catch { /* 受限环境（测试/旧内核）忽略：令牌已存，刷新后生效 */ }
  };
  overlay.querySelector('#qq-token-enter')?.addEventListener('click', submit);
  overlay.querySelector('#qq-token-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  setTimeout(() => { try { overlay.querySelector('#qq-token-input')?.focus(); } catch { /* ignore */ } }, 0);
}
