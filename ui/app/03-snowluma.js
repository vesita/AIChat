// 〔SnowLuma 页签〕——M9 拆分第 4 段
'use strict';
// ── SnowLuma 独立页签 ──
/**
 * 只刷新日志区（不重建整个页面）。
 * SSE 每来一条新日志就调一次 —— 整页 innerHTML 重建会重绘、丢滚动、还拖帧。
 * 三个日志框各刷各的：QQ / SnowLuma / 应用。
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  const slPre = box.querySelector('#sl-logs-view');
  const qqPre = box.querySelector('#qq-logs-view');
  const appPre = box.querySelector('#app-logs-view');
  if (!slPre && !qqPre && !appPre) return;   // 页面还没渲染过，等下次整页刷新
  try {
    const [logs, qqLogs, appLogsData] = await Promise.all([
      api('/api/snowluma/logs'),
      api('/api/qq-portable/logs').catch(() => ({ logs: [] })),
      api('/api/logs?limit=120').catch(() => ({ logs: [] }))
    ]);
    const fmt = (arr) => (arr || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    const setLog = (pre, text) => {
      if (!pre) return;
      // 先记贴底状态再换内容：往上翻历史时绝不把用户拽回底部
      const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent = text;
      if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
    };
    setLog(slPre, fmt(logs.logs));
    setLog(qqPre, fmt(qqLogs.logs));
    if (appPre) {
      const appText = (appLogsData.logs || []).map((e) => {
        const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
        const lv = String(e.level || 'info').toUpperCase().padEnd(5);
        return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
      }).join('\n') || '暂无日志';
      setLog(appPre, appText);
    }
  } catch { /* 刷新失败静默，不影响主流程 */ }
}

// 整页重建节流：状态事件可能连着来（启动 QQ + SnowLuma + OneBot），
// 不节流会连续三四次 Promise.all + innerHTML 重绘。
let slFullReloadTimer = null;
function scheduleSnowlumaReload(opts = {}) {
  if (slFullReloadTimer) return;
  slFullReloadTimer = setTimeout(() => {
    slFullReloadTimer = null;
    loadSnowlumaPage({ quiet: true });
  }, 400);
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs, qqLogs, appLogsData] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs'),
      api('/api/qq-portable/logs'),
      api('/api/logs?limit=120').catch(() => ({ logs: [], level: 'info' }))
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    // U2 误报收口：外部容器模式下本页不展示内置 SnowLuma 的叙事（谁都没有启动它，
    // 也不该出现 npm run setup / 未找到目录 / 未运行 这些把人引向错误方向的假警报）。
    if (isExternalProtocolMode(s)) {
      // 进入页签（非 quiet）时拉一次协议端状态；SSE/动作触发的 quiet 重渲染直接用缓存，
      // 不挂全局轮询（控制台已有 refreshMs 周期，别叠加）。
      await renderExternalProtocolPage(box, s, appLogsData, { refreshProtocol: !quiet });
      return;
    }
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    // 便携 QQ 状态
    const qq = s.qqPortable || {};
    const qqReady = !!qq.ready;
    const qqRunning = !!qq.running;
    const qqPid = qq.pid ?? null;
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    const qqLogText = (qqLogs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    // 应用日志（logger 的内存环形缓冲）
    const appLogs = appLogsData.logs || [];
    const appLogLevel = appLogsData.level || 'info';
    const appLogText = appLogs.map((e) => {
      const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const lv = String(e.level || 'info').toUpperCase().padEnd(5);
      return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
    }).join('\n') || '暂无日志';

    // 整页重建前记住日志滚动位置：SSE/轮询触发的 quiet 重建会重置 DOM，
    // 不补偿的话用户往下翻日志会被弹回顶部（Kondius 实测：划两下就蹦上去）
    const oldPre = box.querySelector('#sl-logs-view');
    const prevScroll = oldPre
      ? { top: oldPre.scrollTop, atBottom: oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 40 }
      : null;
    const oldAppPre = box.querySelector('#app-logs-view');
    const prevAppScroll = oldAppPre
      ? { top: oldAppPre.scrollTop, atBottom: oldAppPre.scrollTop + oldAppPre.clientHeight >= oldAppPre.scrollHeight - 40 }
      : null;

    box.innerHTML = `
      <div class="snowluma-page-card">
        <h2>SnowLuma（OneBot 网关）</h2>

        <!-- 一键启动区域（核心入口） -->
        ${!onebotConnected ? `
        <div class="quick-start-section" style="background:var(--bg);border:none;border-radius:14px;padding:16px;margin-bottom:16px;box-shadow:var(--raise-sm)">
          <div style="font-size:15px;font-weight:600;margin-bottom:8px">🚀 快速启动</div>
          <div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.6">
            ${!qqReady ? '便携 QQ 未安装，请先运行 <code>npm run setup</code>' :
              !qqRunning ? '点击下面按钮，自动完成：启动 QQ → 启动 SnowLuma → 连接 OneBot' :
              !running ? 'QQ 已运行，点击启动 SnowLuma 并连接' :
              'SnowLuma 已运行，等待 OneBot 连接…'}
          </div>
          <button class="btn btn-primary" id="quick-start-btn" style="font-size:14px;padding:10px 20px" ${!qqReady ? 'disabled' : ''}>
            ${!qqReady ? '请先运行 npm run setup' :
              !qqRunning ? '一键启动（QQ + SnowLuma）' :
              !running ? '启动 SnowLuma' :
              '等待连接…'}
          </button>
          <span id="quick-start-hint" class="muted" style="font-size:12px;margin-left:12px"></span>
        </div>` : ''}

        <!-- 便携 QQ 内核状态 -->
        <div class="snowluma-qq-section">
          <div class="snowluma-state-row">
            <span class="dot ${qqRunning ? 'dot-on' : 'dot-off'}"></span>
            <span>QQ 内核：<strong>${qqRunning ? `运行中${qqPid ? `（pid ${qqPid}）` : ''}` : (qqReady ? '未启动' : '未安装')}</strong></span>
            ${!qqReady ? '<span class="muted" style="color:var(--orange)">请先运行 npm run setup</span>' : ''}
          </div>
          ${qqReady ? `
          <div class="snowluma-state-row muted" style="font-size:12px">
            <span>目录：${esc(qq.dir || '')}</span>
          </div>` : ''}
          <div class="snowluma-actions">
            <button class="btn btn-small" id="qq-start-btn" ${!qqReady || qqRunning ? 'disabled' : ''}>${qqRunning ? '已运行' : '单独启动 QQ'}</button>
            <button class="btn btn-small btn-danger" id="qq-stop-btn" ${!qqRunning ? 'disabled' : ''}>关闭 QQ</button>
            <span id="qq-hint" class="muted" style="font-size:12px"></span>
          </div>
          ${qqLogText !== '暂无日志' ? `
          <div class="sl-log-block">
            <div class="hint sl-log-head">QQ 日志</div>
            <pre class="snowluma-logs-view" id="qq-logs-view" style="max-height:120px">${esc(qqLogText)}</pre>
          </div>` : ''}
        </div>

        <hr class="sl-sep">

        <!-- SnowLuma 状态 -->
        <div class="snowluma-qq-section">
          <div class="snowluma-state-row">
            <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
            <span>SnowLuma：<strong>${running ? '运行中' : '未运行'}</strong></span>
            ${pid ? `<span class="muted">pid ${pid}</span>` : ''}
            <span class="muted">${embedded ? '内置模式（随 QQ Agent 退出）' : (running ? '独立模式' : '')}</span>
          </div>
          <div class="snowluma-state-row">
            <span class="dot ${onebotConnected ? 'dot-on' : 'dot-off'}"></span>
            <span>OneBot：<strong>${onebotConnected ? `已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}` : '未连接'}</strong></span>
            <span class="muted">WS ${s.onebot?.error ? `：${s.onebot.error}` : ''}</span>
          </div>
          <div class="snowluma-state-row muted">
            <span>目录：${esc(dir || '（未找到项目内 snowluma/ 文件夹）')}</span>
          </div>
          <div class="snowluma-state-row">
            <span>WebUI：</span>
            ${webuiUrl
              ? `<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">${esc(webuiUrl)}</button>`
              : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>'}
          </div>
          <div class="snowluma-actions">
            <button class="btn btn-primary" id="sl-start-btn" ${running ? 'disabled' : ''}>${running ? '已运行' : '启动 SnowLuma'}</button>
            <button class="btn btn-danger" id="sl-stop-btn" ${running ? '' : 'disabled'}>关闭 SnowLuma</button>
            <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
            <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
            <span id="sl-hint" class="muted" style="font-size:12px"></span>
          </div>
        </div>
        <div class="sl-log-block">
          <div class="hint sl-log-head">运行日志（仅保留最近 500 行）</div>
          <pre class="snowluma-logs-view" id="sl-logs-view">${esc(logText)}</pre>
        </div>

        <!-- 应用日志：logger.js 的内存环形缓冲 + data/logs/ 落盘文件。 -->
        <div class="sl-log-block sl-app-logs">
          <div class="hint sl-log-head">
            <span>应用日志（最近 ${appLogs.length} 条，同时落盘到 data/logs/）</span>
            <label class="sl-log-level">
              <span class="muted">落盘级别</span>
              <select id="app-log-level" title="低于该级别的日志不写入磁盘">
                ${['debug', 'info', 'warn', 'error'].map((v) =>
                  `<option value="${v}" ${appLogLevel === v ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </label>
            <button class="btn btn-small" id="app-logs-refresh-btn" title="重新拉取最近日志">刷新</button>
          </div>
          <pre class="snowluma-logs-view" id="app-logs-view">${esc(appLogText)}</pre>
        </div>
      </div>`;

    // 恢复日志滚动：贴底跟随新日志；否则回到原阅读位置；首次渲染贴底
    const newPre = box.querySelector('#sl-logs-view');
    if (newPre) newPre.scrollTop = prevScroll ? (prevScroll.atBottom ? newPre.scrollHeight : prevScroll.top) : newPre.scrollHeight;
    const newAppPre = box.querySelector('#app-logs-view');
    if (newAppPre) newAppPre.scrollTop = prevAppScroll ? (prevAppScroll.atBottom ? newAppPre.scrollHeight : prevAppScroll.top) : newAppPre.scrollHeight;

    // ── 应用日志：级别切换 + 手动刷新 ──
    if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
    const appLevelSel = $('#app-log-level');
    if (appLevelSel) {
      appLevelSel.addEventListener('change', async () => {
        try {
          const r = await api('/api/logs/level', { method: 'POST', body: JSON.stringify({ level: appLevelSel.value }) });
          if (r && r.level) appLevelSel.value = r.level;
          loadSnowlumaPage({ quiet: true });
        } catch (e) {
          alert(`设置日志级别失败：${e.message}`);
        }
      });
    }
    const appLogsRefreshBtn = $('#app-logs-refresh-btn');
    if (appLogsRefreshBtn) appLogsRefreshBtn.addEventListener('click', () => loadSnowlumaPage());

    // ── 一键启动按钮事件 ──
    const quickStartBtn = $('#quick-start-btn');
    if (quickStartBtn) quickStartBtn.addEventListener('click', async () => {
      const btn = $('#quick-start-btn');
      const hint = $('#quick-start-hint');
      btn.disabled = true;
      hint.textContent = '';

      try {
        // 步骤 1：启动便携 QQ（如果未运行）
        if (!qqRunning) {
          btn.textContent = '启动 QQ 中…';
          hint.textContent = '请在弹出的 QQ 窗口扫码登录';
          const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `QQ 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
          // 等 3 秒让 QQ 完全启动
          await new Promise((r) => setTimeout(r, 3000));
        }

        // 步骤 2：启动 SnowLuma（如果未运行）
        if (!running) {
          btn.textContent = '启动 SnowLuma 中…';
          hint.textContent = '正在启动协议端…';
          const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `SnowLuma 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
        }

        // 步骤 3：等待 OneBot 连接
        btn.textContent = '等待 OneBot 连接…';
        hint.textContent = '首次登录可能需要几秒到几十秒';

        // 轮询检查连接状态（最多 30 秒）
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const s = await api('/api/status');
          if (s.onebot?.connected) {
            hint.textContent = '✅ 已连接！机器人开始工作';
            btn.textContent = '已连接 ✓';
            setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
            return;
          }
        }
        hint.textContent = '连接超时，请检查日志或手动刷新';
        btn.disabled = false;
        btn.textContent = '重试';
      } catch (e) {
        hint.textContent = `启动失败：${e.message}`;
        btn.disabled = false;
        btn.textContent = '一键启动（QQ + SnowLuma）';
      }
    });

    // ── 便携 QQ 按钮事件 ──
    const qqStartBtn = $('#qq-start-btn');
    if (qqStartBtn) qqStartBtn.addEventListener('click', async () => {
      const btn = $('#qq-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.alreadyRunning ? '便携 QQ 已在运行 ✓' : (r.ok ? '已启动，请在弹出的 QQ 窗口扫码登录' : `启动失败：${r.error}`);
      } catch (e) {
        $('#qq-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    const qqStopBtn = $('#qq-stop-btn');
    if (qqStopBtn) qqStopBtn.addEventListener('click', async () => {
      const btn = $('#qq-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/stop', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.ok ? '已请求关闭便携 QQ' : `关闭失败：${r.error}`;
      } catch (e) {
        $('#qq-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });

    $('#sl-start-btn').addEventListener('click', async () => {
      const btn = $('#sl-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
      } catch (e) {
        $('#sl-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    $('#sl-stop-btn').addEventListener('click', async () => {
      const btn = $('#sl-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#sl-hint').textContent = '';
      try {
        await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = '已请求关闭 SnowLuma。';
      } catch (e) {
        $('#sl-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });
    $('#sl-refresh-btn').addEventListener('click', () => loadSnowlumaPage());
    $('#sl-open-folder-btn').addEventListener('click', async () => {
      try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
      catch (e) { $('#sl-hint').textContent = `失败：${e.message}`; }
    });
    const webuiBtn = $('#sl-open-webui-btn');
    if (webuiBtn) webuiBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
        if (!r.ok) $('#sl-hint').textContent = r.error;
      } catch (e) {
        $('#sl-hint').textContent = `打开失败：${e.message}`;
      }
    });
  } catch (e) {
    if (!quiet) console.error(e);
  }
}

/**
 * 外部容器协议端页签（U2 误报收口 + task-15 可操作卡片）。
 *
 * 现场是「宿主系统单元 AIChat + 用户级容器 NapCat」：整页不再出现
 * 「SnowLuma 未运行 / 未找到目录 / npm run setup」这些把人引向内置安装的假警报，
 * 改成「可操作卡片 + OneBot 端点可达性 + HTTP/数据面探测结果 + 排障命令」。
 *
 * 事实来源只有一个：GET /api/protocol/status（后端 src/protocol-side.js）。
 * 前端不自己推断容器状态、不伪造动作；按钮完全按后端给的 actions 数组渲染 ——
 * embedded / 未安装 / 不可管理等形态不需要前端各写一套分支。
 * 状态只在进入页签时拉一次、动作后刷新一次；quiet 重渲染读缓存，不挂全局轮询。
 */
function renderExternalProtocolPage(box, s, appLogsData, { refreshProtocol = true } = {}) {
  return (async () => {
    if (refreshProtocol || !protocolCardState) await fetchProtocolStatus();
    const p = protocolCardState || {};
    const ob = s.onebot || {};
    const protocol = s.protocol || {};
    const httpOk = ob.httpOk;
    const dataPathState = String(ob.dataPathState || '');
    const endpoint = String(protocol.endpoint || '');
    const self = ob.self ? `${ob.self.nickname || ''}${ob.self.userId ? `（${ob.self.userId}）` : ''}` : '';
    const reach = ob.connected
      ? `已连接${self ? `：${self}` : ''}`
      : `未连接${ob.diagnosis ? `：${String(ob.diagnosis).slice(0, 160)}` : ''}`;
    const httpText = httpOk === true
      ? '正常'
      : (httpOk === false
        ? `不可用${ob.httpError ? `：${String(ob.httpError).slice(0, 120)}` : ''}`
        : '尚未探测');
    const appLogs = appLogsData?.logs || [];
    const appLogLevel = appLogsData?.level || 'info';
    const appLogText = appLogs.map((e) => {
      const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const lv = String(e.level || 'info').toUpperCase().padEnd(5);
      return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
    }).join('\n') || '暂无日志';

    box.innerHTML = `
      <div class="snowluma-page-card">
        <h2>协议端（外部容器 · NapCat）</h2>
        ${protocolCardHtml(p)}
        <div class="snowluma-state-row">
          <span class="dot ${ob.connected ? 'dot-on' : 'dot-off'}"></span>
          <span>OneBot 端点：<strong>${esc(reach)}</strong></span>
          ${endpoint ? `<span class="muted">${esc(endpoint)}</span>` : ''}
        </div>
        <div class="snowluma-state-row">
          <span>HTTP 数据面：<strong>${esc(httpText)}</strong></span>
          ${dataPathState ? `<span class="muted">数据面自检：${esc(dataPathState)}</span>` : ''}
        </div>
        <div class="snowluma-state-row muted" style="font-size:12px">
          容器生命周期归 systemd 用户单元（本应用不会自动拉起）；需要扫码时点顶栏「QQ 登录」。
          排障：<code>systemctl --user status napcat</code> · <code>podman ps | grep napcat</code>
        </div>
        <div class="snowluma-actions">
          <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
          <span id="sl-hint" class="muted" style="font-size:12px"></span>
        </div>
        <div class="sl-log-block sl-app-logs">
          <div class="hint sl-log-head">
            <span>应用日志（最近 ${appLogs.length} 条，同时落盘到 data/logs/）</span>
            <label class="sl-log-level">
              <span class="muted">落盘级别</span>
              <select id="app-log-level" title="低于该级别的日志不写入磁盘">
                ${['debug', 'info', 'warn', 'error'].map((v) =>
                  `<option value="${v}" ${appLogLevel === v ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </label>
            <button class="btn btn-small" id="app-logs-refresh-btn" title="重新拉取最近日志">刷新</button>
          </div>
          <pre class="snowluma-logs-view" id="app-logs-view">${esc(appLogText)}</pre>
        </div>
      </div>`;

    // 动作按钮：只按后端给的 actions 渲染（data-protocol-action 是测试与事件绑定的唯一钩子）。
    box.querySelectorAll('[data-protocol-action]').forEach((btn) => {
      btn.addEventListener('click', () => { runProtocolAction(btn.dataset.protocolAction); });
    });
    $('#sl-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage());
    $('#app-logs-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage({ quiet: true }));
    const levelSel = $('#app-log-level');
    if (levelSel) {
      levelSel.addEventListener('change', async () => {
        try {
          const r = await api('/api/logs/level', { method: 'POST', body: JSON.stringify({ level: levelSel.value }) });
          if (r && r.level) levelSel.value = r.level;
          loadSnowlumaPage({ quiet: true });
        } catch (e) {
          const hint = $('#sl-hint');
          if (hint) hint.textContent = `设置日志级别失败：${e.message}`;
        }
      });
    }
  })();
}

// ── 协议端卡片（task-15）：状态徽标 + 动作按钮 + 二次确认 ─────────────────
// 显示文案与动作白名单都收在这里，渲染分支只有一份 —— 后端换 actions 时前端不用改。

const PROTOCOL_STATE_BADGE = {
  running: { text: '运行中', cls: 'protocol-badge protocol-badge--ok' },
  stopped: { text: '已停止', cls: 'protocol-badge protocol-badge--off' },
  absent: { text: '未安装', cls: 'protocol-badge protocol-badge--warn' },
  unknown: { text: '未知', cls: 'protocol-badge protocol-badge--na' }
};

const PROTOCOL_ACTION_LABEL = { start: '启动', stop: '停止', restart: '重启' };
const PROTOCOL_ACTION_CLASS = { start: 'btn-primary', stop: 'btn-danger', restart: '' };

// 进入页签拉一次 / 动作后刷新；不做全局轮询（quiet 重渲染直接读缓存）。
let protocolCardState = null;   // 最近一次 GET /api/protocol/status 的响应
let protocolCardBusy = false;   // 动作执行中：按钮 disabled + 「执行中…」
let protocolActionError = '';   // 最近一次动作失败的可读提示

/** state → 徽标（纯函数；未知值统一显示「未知」，不猜）。 */
function protocolBadge(state) {
  return PROTOCOL_STATE_BADGE[String(state || '')] || PROTOCOL_STATE_BADGE.unknown;
}

/** actions 渲染的唯一入口：只认后端数组，按已知动作过滤（不硬编码哪种模式有哪个按钮）。 */
function protocolCardActions(protocol) {
  const list = Array.isArray(protocol?.actions) ? protocol.actions : [];
  return list.filter((a) => Object.prototype.hasOwnProperty.call(PROTOCOL_ACTION_LABEL, a));
}

/** stop / restart 会动 QQ 登录态：必须先二次确认。 */
function protocolNeedsConfirm(action) {
  return action === 'stop' || action === 'restart';
}

/** 确认文案：带后端 stopWarning（掉登录态风险），后端没给时给同义兜底。 */
function protocolConfirmText(action, protocol) {
  const label = PROTOCOL_ACTION_LABEL[action] || action;
  const warning = String(protocol?.stopWarning || '').trim()
    || '停止协议端可能导致 QQ 登录态失效，之后需要重新扫码登录。';
  return `确定要${label}协议端吗？\n\n${warning}`;
}

/** 409/400/503/403 等 → 人话（错误分支的唯一渲染口径）。 */
function protocolErrorMessage(error) {
  const code = String(error?.code || '');
  const data = error?.data || {};
  const detail = String(data.error || error?.message || '').trim();
  const lastError = String(data.lastError || '').trim();
  if (code === 'PROTOCOL_NOT_MANAGED') return '当前不是可管理的容器协议端（AIChat 未接管协议端生命周期）';
  if (code === 'CONFIRM_REQUIRED') return '该操作需要二次确认，请重新点击并确认';
  if (lastError) return `协议端操作失败：${lastError}`;
  if (code === 'PROTOCOL_ACTION_FAILED' || code === 'PROTOCOL_LAST_ERROR' || error?.status === 503) {
    return detail ? `协议端操作失败：${detail}` : '协议端操作失败（后端未给出原因）';
  }
  if (error?.status === 403) return '只允许本机访问：协议端管理接口要求回环来源';
  if (error?.status === 401) return '未授权：请用带 ?token= 的地址打开控制台';
  if (error?.status === 404) return '后端尚未提供协议端管理接口（/api/protocol/*）';
  return detail || '请求失败';
}

async function fetchProtocolStatus() {
  try {
    protocolCardState = await api('/api/protocol/status');
  } catch (error) {
    // 接口不存在 / 非回环 / 未授权：保留上一次状态（动作按钮别消失），把可读原因显示出来
    protocolCardState = {
      ...(protocolCardState || {}),
      ok: false,
      state: protocolCardState?.state || 'unknown',
      actions: protocolCardState?.actions || [],
      error: protocolErrorMessage(error)
    };
  }
  return protocolCardState;
}

/** 协议端卡片 HTML（唯一渲染点）。 */
function protocolCardHtml(p) {
  const badge = protocolBadge(p?.state);
  const actions = protocolCardActions(p);
  const facts = [
    ['引擎', p?.engine || '未知'],
    ['单元', p?.unit || '—'],
    ['容器', p?.container || '—']
  ].map(([k, v]) => `<span class="protocol-card__fact">${esc(k)}：<code>${esc(String(v))}</code></span>`).join('');
  const buttons = actions.map((action) => {
    const cls = PROTOCOL_ACTION_CLASS[action] || '';
    const text = protocolCardBusy ? '执行中…' : PROTOCOL_ACTION_LABEL[action];
    return `<button class="btn ${cls}" data-protocol-action="${esc(action)}"${protocolCardBusy ? ' disabled' : ''}>${esc(text)}</button>`;
  }).join('');
  const errorText = protocolActionError || (p?.ok === false ? String(p.error || '') : '');
  return `
    <div class="protocol-card" id="protocol-card" data-state="${esc(String(p?.state || 'unknown'))}">
      <div class="protocol-card__head">
        <span class="${badge.cls}" id="protocol-state-badge">${esc(badge.text)}</span>
        <span class="protocol-card__title">协议端（容器）</span>
        ${p?.managed === false ? '<span class="muted protocol-card__managed">本机不接管生命周期</span>' : ''}
      </div>
      <div class="protocol-card__facts">${facts}</div>
      ${p?.detail ? `<div class="muted protocol-card__detail">${esc(String(p.detail))}</div>` : ''}
      ${p?.lastError ? `<div class="warn-text protocol-card__lasterror" id="protocol-card-lasterror">⚠ ${esc(String(p.lastError))}</div>` : ''}
      <div class="warn-text protocol-card__error${errorText ? '' : ' hidden'}" id="protocol-card-error">${esc(errorText)}</div>
      ${actions.length
        ? `<div class="protocol-card__actions">${buttons}</div>`
        : '<div class="muted protocol-card__noactions">当前模式没有可执行的协议端操作</div>'}
    </div>`;
}

/**
 * 执行一个协议端动作：stop/restart 先二次确认（取消则一个请求都不发）；
 * 执行中按钮 disabled + 「执行中…」；结束后刷新状态并 toast 结果。
 */
async function runProtocolAction(action) {
  if (protocolCardBusy) return;
  if (!Object.prototype.hasOwnProperty.call(PROTOCOL_ACTION_LABEL, action)) return;
  if (protocolNeedsConfirm(action)) {
    const ok = await uiConfirm(protocolConfirmText(action, protocolCardState), {
      title: `⚠️ 确认${PROTOCOL_ACTION_LABEL[action]}协议端`,
      okText: `确认${PROTOCOL_ACTION_LABEL[action]}`,
      cancelText: '取消'
    });
    if (!ok) return;      // 取消：不发任何请求（不变量：危险动作必须显式确认）
  }
  protocolCardBusy = true;
  protocolActionError = '';
  const box = $('#snowluma-page');
  if (box) {
    box.querySelectorAll('[data-protocol-action]').forEach((b) => { b.disabled = true; });
    const button = box.querySelector(`[data-protocol-action="${action}"]`);
    if (button) button.textContent = '执行中…';
  }
  try {
    const body = protocolNeedsConfirm(action) ? JSON.stringify({ confirm: true }) : '{}';
    const result = await api(`/api/protocol/${action}`, { method: 'POST', body });
    protocolCardBusy = false;
    await fetchProtocolStatus();
    await loadSnowlumaPage({ quiet: true });
    const label = PROTOCOL_ACTION_LABEL[action] || action;
    const after = result?.stateAfter ? `（${protocolBadge(result.stateAfter).text}）` : '';
    showProtocolToast(`${label}完成${after}`);
  } catch (error) {
    protocolCardBusy = false;
    protocolActionError = protocolErrorMessage(error);
    // 503 的 lastError 优先展示；同时刷新状态，让 detail/lastError 与后端一致
    await fetchProtocolStatus();
    await loadSnowlumaPage({ quiet: true });
    showProtocolToast(protocolActionError, { error: true });
  }
}

let protocolToastTimer = null;
/** 极简 toast：固定右下、4 秒自动消失（不引依赖、不改页面布局）。 */
function showProtocolToast(text, { error = false } = {}) {
  const content = String(text || '').trim();
  if (!content) return;
  let el = $('#protocol-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'protocol-toast';
    document.body.appendChild(el);
  }
  el.className = 'protocol-toast' + (error ? ' protocol-toast--error' : '');
  el.textContent = content;
  uiShow(el, () => el.classList.remove('hidden'), false);
  if (protocolToastTimer) clearTimeout(protocolToastTimer);
  protocolToastTimer = setTimeout(() => {
    protocolToastTimer = null;
    uiHide(el, () => el.classList.add('hidden'), false);
  }, 4000);
}
