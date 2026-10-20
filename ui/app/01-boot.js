// 〔启动 loading 壳 / 就绪体检 / 状态栏〕——M9 拆分第 2 段
'use strict';
// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    // 顶栏链路状态：唯一判定点 + 五段诊断面板（见下方 computeLinkState / linkSegments）。
    // 判定/渲染失败不应连带跳过后面那些纯展示的刷新，所以这里不 else 兜底文案 ——
    // 首屏的「链路状态检测中…」由 HTML 提供，只有真拿到 status 才改写它。
    updateLinkStatus(s);
    // 顶栏「QQ 登录」入口：QQ/OneBot 在线时收起（没到登录现场就别打扰），
    // 未连接时露出，用户可自助扫码把登录补回来。
    $('#qq-login-chip')?.classList.toggle('hidden', !!s.onebot.connected);
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    // 成本：官方价匹配得上就显示；匹配不上（中转站常见）只显示 token，不显示误导性的 ¥0
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` · ¥${c.cost.toFixed(3)}` : '';
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${rateTxt}${costTxt}`;
    $('#search-count-label').textContent = `搜索：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`;
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    state.dataDir = s.dataDir || '';
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
    updateReadinessDots(s);
  } catch (e) { /* 忽略瞬时错误 */ }
}

/* ══ 顶栏链路状态（唯一判定点）════════════════════════════════════════════
   改造前顶栏把连接状态拆成三套各自判定的控件：OneBot 圆点、4 个就绪圆点、
   一串状态胶囊。同一件事三种说法，而且首屏文案写死了「OneBot 未连接」——
   请求没跑到/失败时那句话就永远留在页面上，用户看到的就是"总显示连不上"。

   现在只有一个 computeLinkState()：顶栏按钮、诊断面板的每段证据都从同一份
   /api/status 推导。判定顺序即优先级：

     err   onebot.connected !== true（连都没连上，别的都是后话）
     warn  connected 但 HTTP 数据面坏 / 数据面自检 zombie|unreachable / 协议端容器停了
     ok    其余

   "没拿到 status" 不在这三档里 —— 首屏由 HTML 给中性文案「链路状态检测中…」，
   请求失败就停在它上面，绝不冒充断连。 */

/**
 * 把 /api/status 压成**一个**链路状态。
 * @param {object|null} s /api/status 响应
 * @returns {{state:'ok'|'warn'|'err', text:string, reasons:string[]}}
 */
function computeLinkState(s) {
  const ob = s?.onebot || {};
  if (ob.connected !== true) {
    const why = ob.diagnosis || (isExternalProtocolMode(s) ? 'OneBot 端点不可达' : 'OneBot 未连接');
    return { state: 'err', text: `链路中断：${why}`, reasons: [why] };
  }

  const reasons = [];
  if (ob.httpOk === false) reasons.push('HTTP 数据面不可用');
  const dp = String(ob.dataPathState || '');
  if (dp === 'zombie') reasons.push('数据面自检：僵尸态');
  else if (dp === 'unreachable') reasons.push('数据面自检：不可达');
  const pm = s?.protocolManaged || {};
  if (pm.managed === true && pm.running === false) reasons.push('协议端容器未运行');

  if (reasons.length) return { state: 'warn', text: `链路异常：${reasons[0]}`, reasons };
  return { state: 'ok', text: '链路正常', reasons: [] };
}

/** 相对时间（诊断证据用）。ts 为空返回空串，由调用方决定说什么。 */
function fmtAgo(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 10) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/**
 * 五段链路的证据行：每行 = 段名 / 状态 / 一句证据 / 一个动作。
 * 只读 /api/status 既有字段，不额外发请求。
 *
 * QQ 内核的字段说明：/api/status 的 qqPortable.running 才是「便携 QQ 内核」，
 * snowluma.running 是内置协议端（老后端可能没有 qqPortable，退回用它）。
 * 外部协议端模式下两者的进程都不归本应用管，统一显示"不管理"，避免红点误报。
 */
function linkSegments(s) {
  const external = isExternalProtocolMode(s);
  const ob = s?.onebot || {};
  const pm = s?.protocolManaged || {};
  const sl = s?.snowluma || {};
  const qq = s?.qqPortable || {};
  const rows = [];

  // ① QQ 内核
  if (external) {
    rows.push({ name: 'QQ 内核', state: 'na', ev: '由 NapCat 容器提供，本应用不管理' });
  } else {
    const qqKnown = typeof qq.running === 'boolean';
    const slKnown = typeof sl.running === 'boolean';
    const bits = [];
    if (qqKnown) bits.push(`QQ 内核${qq.running ? '运行中' : '未运行'}`);
    if (slKnown) bits.push(`SnowLuma${sl.running ? '运行中' : '未运行'}`);
    const running = qqKnown ? qq.running === true : sl.running === true;
    rows.push({
      name: 'QQ 内核',
      state: bits.length === 0 ? 'na' : (running ? 'ok' : 'warn'),
      ev: bits.length ? bits.join(' · ') : '状态未知',
      act: running ? null : { label: '去启动', tab: 'snowluma' }
    });
  }

  // ② 协议端容器（只有容器托管形态才可管理）
  if (pm.managed !== true) {
    rows.push({ name: '协议端容器', state: 'na', ev: '不可管理（协议端不由本应用托管）' });
  } else {
    const st = pm.state ? `（${pm.state}）` : '';
    rows.push(pm.running === true
      ? { name: '协议端容器', state: 'ok', ev: `容器运行中${st}` }
      : { name: '协议端容器', state: 'warn', ev: `容器未运行${st}`, act: { label: '去处理', tab: 'snowluma' } });
  }

  // ③ OneBot WS
  if (ob.connected === true) {
    const who = ob.self?.nickname
      ? `：${ob.self.nickname}${ob.self.userId ? `（${ob.self.userId}）` : ''}`
      : '';
    rows.push({ name: 'OneBot WS', state: 'ok', ev: `已连接${who}` });
  } else {
    const why = ob.diagnosis || ob.error || (external ? '端点不可达' : '未连接');
    rows.push({ name: 'OneBot WS', state: 'err', ev: `未连接：${why}`, act: { label: '去检查', tab: 'snowluma' } });
  }

  // ④ HTTP 数据面（WS 通、HTTP 坏 = 收得到回不出去，最危险且最容易漏报）
  if (ob.httpOk === true) {
    rows.push({ name: 'HTTP 数据面', state: 'ok', ev: '正常' });
  } else if (ob.httpOk === false) {
    rows.push({ name: 'HTTP 数据面', state: 'warn', ev: `不可用：${ob.httpError || '请求失败'}`, act: { label: '去设置', tab: 'settings' } });
  } else {
    rows.push({ name: 'HTTP 数据面', state: 'na', ev: '尚未探测' });
  }

  // ⑤ 数据面自检（僵尸态：WS 连着但实际调不动）
  const dp = String(ob.dataPathState || '');
  const probe = ob.lastProbeAt ? ` · ${fmtAgo(ob.lastProbeAt)}` : '';
  const dpDetail = ob.dataPathReason ? `：${ob.dataPathReason}` : '';
  if (dp === 'ok') rows.push({ name: '数据面自检', state: 'ok', ev: `通过${probe}` });
  else if (dp === 'zombie') rows.push({ name: '数据面自检', state: 'warn', ev: `僵尸态${dpDetail}${probe}` });
  else if (dp === 'unreachable') rows.push({ name: '数据面自检', state: 'warn', ev: `不可达${dpDetail}${probe}` });
  else rows.push({ name: '数据面自检', state: 'na', ev: `尚未探测${probe}` });

  // ⑥ 模型（没配模型时机器人能连上也回不了话）
  const model = s?.orchestrator?.model || '';
  rows.push(model
    ? { name: '模型', state: 'ok', ev: model }
    : { name: '模型', state: 'warn', ev: '未配置（机器人无法回复）', act: { label: '去设置', tab: 'settings' } });

  return rows;
}

/** 渲染诊断面板正文（s = 最近一次 /api/status；为空表示还没拿到）。 */
function renderLinkPanel(s) {
  const body = $('#link-panel-body');
  if (!body) return;
  if (!s) {
    body.innerHTML = '<div class="link-panel-empty">还没拿到 /api/status：后端可能还在启动，或这次请求失败了。页面每 15 秒重试一次；一直停在这里就去设置页检查服务与控制台令牌。</div>';
    return;
  }
  body.innerHTML = linkSegments(s).map((row) => {
    const act = row.act
      ? `<button class="link-row-act" type="button" data-link-act="${esc(row.act.tab)}">${esc(row.act.label)}</button>`
      : '<span></span>';
    return `<div class="link-row is-${esc(row.state)}">`
      + `<span class="link-row-name">${esc(row.name)}</span>`
      + '<span class="link-row-dot" aria-hidden="true"></span>'
      + `<span class="link-row-ev" title="${esc(row.ev)}">${esc(row.ev)}</span>`
      + act
      + '</div>';
  }).join('');
}

/** 顶栏按钮：状态点 + 文案 + 悬停详情；面板开着时用同一份 status 一起刷新。 */
function updateLinkStatus(s) {
  const r = computeLinkState(s);
  const btn = $('#link-status-btn');
  if (btn) {
    btn.classList.remove('is-ok', 'is-warn', 'is-err');
    btn.classList.add(`is-${r.state}`);
    btn.dataset.state = r.state;
    btn.title = r.reasons.length ? `点击查看链路诊断：${r.reasons.join('；')}` : '点击查看链路诊断';
  }
  const dot = $('#link-status-dot');
  if (dot) dot.className = `link-dot is-${r.state}`;
  const text = $('#link-status-text');
  if (text) text.textContent = r.text;
  const panel = $('#link-status-panel');
  if (panel && !panel.hidden) renderLinkPanel(s);
}

/** 开/收诊断面板：open 省略时取反；打开时用最近一次 status 渲染，不额外发请求。 */
function toggleLinkPanel(open) {
  const btn = $('#link-status-btn');
  const panel = $('#link-status-panel');
  if (!btn || !panel) return;
  const next = typeof open === 'boolean' ? open : panel.hidden;
  panel.hidden = !next;
  btn.setAttribute('aria-expanded', String(next));
  if (next) renderLinkPanel(state.status);
}

$('#link-status-btn')?.addEventListener('click', (e) => {
  // 不冒泡到 document 的"点外面收起"判定（否则刚打开就被同一次点击关掉）
  e.preventDefault();
  e.stopPropagation();
  toggleLinkPanel();
});

document.addEventListener('click', (e) => {
  const panel = $('#link-status-panel');
  if (!panel || panel.hidden) return;
  if (panel.contains(e.target) || $('#link-status-btn')?.contains(e.target)) return;
  toggleLinkPanel(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleLinkPanel(false);
});

// 面板里的动作按钮：事件委托（面板每次渲染都换 innerHTML，逐行绑会漏）
$('#link-panel-body')?.addEventListener('click', (e) => {
  const act = e.target.closest?.('[data-link-act]');
  if (!act) return;
  const tab = act.dataset.linkAct;
  if (tab === 'settings' || tab === 'snowluma') switchTab(tab);
  toggleLinkPanel(false);
});

// 纯函数，测试直接取 window.computeLinkState（普通脚本本来也是全局绑定，这里写明意图）
window.computeLinkState = computeLinkState;

/**
 * 更新顶栏就绪进度指示器。
 *
 * ⚠️ 视觉上已由上面的链路状态按钮取代，这里只为**隐藏兼容锚点** #readiness-dots 保留：
 *    test/qq-login-ui-test.mjs 的外部协议端回归直接断言这 4 个 .rdot 的 className / title。
 *    删除本函数与锚点前，先改那条回归的判据。
 *
 * 两种协议端形态语义不同（U1 误报收口）：
 *   · embedded（内置 SnowLuma）：4 圆点 = QQ内核 / SnowLuma / OneBot / 配置
 *   · external（外部容器 NapCat）：前两点本应用根本不管理，恒红是误报 ——
 *     标成 na（不适用）并在 title 写明"由外部容器提供"；第 3 点改为
 *     **OneBot 端点可达性**（connected + httpOk + dataPathState，都是 /api/status 既有字段）。
 * 判定只认 protocol.mode；没有该字段（旧后端）时按 embedded 渲染，行为与改造前一致。
 */
function updateReadinessDots(s) {
  const dots = $$('#readiness-dots .rdot');
  if (dots.length !== 4) return;

  const cfg = state.config || {};
  const cfgReady = !!(cfg.api?.baseUrl && cfg.api?.model && (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty));
  const obConnected = !!s?.onebot?.connected;

  if (isExternalProtocolMode(s)) {
    const httpOk = s?.onebot?.httpOk;
    const dataPathState = String(s?.onebot?.dataPathState || '');
    // 外部协议端：本应用不管理 QQ 内核 / SnowLuma —— 不再渲染成两个"没运行"的红点
    dots[0].className = 'rdot na';
    dots[0].title = '协议端由外部容器（NapCat）提供，本应用不管理它的进程';
    dots[1].className = 'rdot na';
    dots[1].title = '外部协议端模式：无需内置 QQ 内核 / SnowLuma';
    dots[2].className = 'rdot' + (obConnected ? ' on' : '');
    const httpNote = httpOk === false ? '；HTTP 数据面不可用（发送会失败，检查 snowluma.httpUrl）' : '';
    const dpNote = dataPathState ? `；数据面 ${dataPathState}` : '';
    dots[2].title = (obConnected ? `OneBot 已连接${httpNote}` : `OneBot 未连接${s?.onebot?.diagnosis ? `：${s.onebot.diagnosis}` : ''}${httpNote}`) + dpNote;
    dots[3].className = 'rdot' + (cfgReady ? ' on' : '');
    dots[3].title = cfgReady ? '配置已完成' : '配置未完成（点击前往设置）';
    return;
  }

  const qq = s?.qqPortable || {};
  const qqRunning = !!qq.running;
  const slRunning = !!s?.snowluma?.running;

  // 圆点 0：QQ 内核
  dots[0].className = 'rdot' + (qqRunning ? ' on' : '');
  dots[0].title = qqRunning ? 'QQ 内核运行中' : 'QQ 内核未运行（点击前往启动）';

  // 圆点 1：SnowLuma
  dots[1].className = 'rdot' + (slRunning ? ' on' : '');
  dots[1].title = slRunning ? 'SnowLuma 运行中' : 'SnowLuma 未运行（点击前往启动）';

  // 圆点 2：OneBot
  dots[2].className = 'rdot' + (obConnected ? ' on' : (slRunning ? ' wait' : ''));
  dots[2].title = obConnected ? 'OneBot 已连接' : (s?.onebot?.diagnosis || (slRunning ? 'OneBot 连接中…' : 'OneBot 未连接'));

  // 圆点 3：配置完成
  dots[3].className = 'rdot' + (cfgReady ? ' on' : '');
  dots[3].title = cfgReady ? '配置已完成' : '配置未完成（点击前往设置）';
}

// 就绪圆点点击跳转
$$('#readiness-dots .rdot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const target = dot.dataset.target;
    if (target === 'snowluma') switchTab('snowluma');
    else if (target === 'settings') switchTab('settings');
  });
});

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}
