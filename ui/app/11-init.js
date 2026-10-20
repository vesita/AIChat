// 〔页签切换 / 启动〕——M9 拆分第 12 段（末段）
// ⚠️ 本文件必须最后加载：它负责首屏分流并调用 13-qq-login.js 提供的面板。
'use strict';
// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 进入控制台（幂等）──
// 首屏分流的三条路（ready / logged_out / need_token）最后都收敛到这里或"先登录再进来"。
// 抽成幂等函数的原因：扫码面板关闭（onDismiss）与正常启动两条路都要执行同一套初始化，
// 各复制一份必然漏步骤（例如漏 startStatusPoller 会让顶栏状态永不刷新）。
let consoleEntered = false;
async function enterConsole() {
  if (consoleEntered) return;
  consoleEntered = true;
  try { hideLoading(); } catch { /* ignore */ }

  // 主题：以后端配置为准（跨设备同步），仅当后端确实存过才覆盖本地
  try {
    const cfg0 = await api('/api/config');
    const t = cfg0?.ui?.theme;
    if (THEME_VALUES.includes(t)) applyTheme(t);
  } catch { /* 接口不可用就用本地的 */ }

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      startStatusPoller();
      return;
    }
  } catch { /* 按默认流程走 */ }

  refreshStatus();
  startStatusPoller();
  connectSSE();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
}

// ── 启动 ──
(async function init() {
  try {
    // 主题：明/暗两档（跟随系统/？已移除）
    applyTheme(getThemePref());
    $('#theme-btn')?.addEventListener('click', cycleTheme);

    // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
    setLoadingStatus('正在启动 QQ Agent 服务…');
    // bootLoop 返回首屏路由：
    //   ready      → 直接进控制台
    //   logged_out → 先开扫码面板，关掉/登录成功后再进控制台（不白屏）
    //   need_token → 令牌输入框（后端配了 token 而本页没带对）
    const route = await bootLoop();
    runUpdateCheck();                                 // 启动时静默查一次（失败不打扰）
    setInterval(() => runUpdateCheck(), 3600_000);    // 之后每小时查一次

    if (route === 'need_token') {
      hideLoading();
      openTokenPrompt();
      return;
    }

    // 顶栏「QQ 登录」入口：控制台里随时可以重开扫码面板
    $('#qq-login-chip')?.addEventListener('click', () => openQQLoginPanel({}));

    if (route === 'logged_out') {
      hideLoading();
      openQQLoginPanel({ onDismiss: () => { enterConsole(); } });
      return;
    }

    await enterConsole();
  } catch (err) {
    // 启动链路任何一步抛错都必须摘掉加载遮罩 —— 否则整窗被
    // z-index:999 的 loading-overlay 盖住，用户只看到一片空白。
    console.error('[init] 启动失败:', err);
    try { setLoadingStatus(`启动异常：${err?.message || err}`); } catch { /* ignore */ }
    try { hideLoading(); } catch { /* ignore */ }
  }
})();
