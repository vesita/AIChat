# 控制台网页访问 + 扫码登录 UI：实现规格（只读勘查）

- 对象：AIChat 控制台（`ui/`、`src/app.js`、`src/routes.js`、`src/config.js`、`src/onebot.js`）与 QQ 协议端（NapCat 容器）。
- 代码基线：`topic/core-web-opt` @ `6b16ffe`。本报告所有行号按这个提交重核过，不是沿用旧报告的行号。
- 方法：只读（读源码、读容器内 NapCat 源码与打包产物、本机隔离实例实测、生产机只读命令）。未改任何代码/配置，未动生产 QQ 登录态。
- 证据强度标记：**实测**（命令输出）/ **源码**（仓内或容器内文件:行）/ **反推**（从打包产物还原的契约）/ **推测**（明确标注、待真实登出时确认）。
- 相邻报告（不重复其结论，按需引用）：`doc/audit/core-faults.md`（僵尸态/漏回/重复/超时）、`doc/audit/protocol-side-mismatch.md`（SnowLuma 假设 vs 容器 NapCat 的错配清单，本报告引用其 S1/S2）。
- 行号会随并行改动漂移。**改动点以「锚点函数名 + 插入位置」为准**（§12.3），行号只是当前工作区的参考值。

---

## 0. 结论速览

| # | 判定 | 结论 | 强度 |
|---|---|---|---|
| 1 | `authorize()` 覆盖范围 | 覆盖 `/api/*` 全部 91 条路由与 `/api/events`（SSE）；**静态资源不过鉴权** | 源码 `src/app.js:1327-1360`、`1388-1468`；实测 |
| 2 | 现网是否全放行 | `server.token` 为空 ⇒ **全放行**（现网 `hasToken:false`） | 实测 |
| 3 | 前端发的是什么令牌 | 硬编码 `qq-agent-console`，不是真实令牌 ⇒ 一旦配 token，全部 API 401 | 源码 `ui/app/00-core.js:557,620`；实测（本机配 token 实例返回 401） |
| 4 | SSE 能否带头 | 不能。`EventSource` 无法自定义头 ⇒ 必须走 `?token=`；`authorize` 已支持 | 源码 `ui/app/02-sse-sessions.js:5`、`src/app.js:1211`；实测 |
| 5 | 在线/离线状态来源 | 「机器人能不能干活」= `onebot.connected`（OneBot WS）；`/api/status.snowluma` 在 Linux 部署上是**无关字段**（探 5099，永远 false） | 源码 `src/routes.js:89-137`、`src/app.js:156-170`；实测 |
| 6 | 登出态的「QQ 登录态」权威源 | 只有 **NapCat WebUI（127.0.0.1:6099）** 能回答；OneBot 3002 要登录后才监听 | 实测（journal 时序）+ 源码 |
| 7 | 取二维码路径 | 选 **NapCat WebUI API**（`/api/auth/login` → `/api/QQLogin/CheckLoginStatus`）；容器文件 `podman cp` 只作兜底，不作主路径 | 源码（容器内 `napcat.mjs`）+ 实测可行 |
| 8 | 扫码 UI 能否在不动生产登录态下验到可信 | **能验到「除真实 QQ 扫码外的全部环节」**：鉴权闭环、登出态可打开、QR 渲染、状态机、成功/过期/失败/不可达分支、幂等与限流、payload 不泄漏。**不能**提前验：真实登出态下 NapCat 的响应体与真实扫码时序。详见 §1 | — |
| 9 | 前置依赖（已解除） | 登出态可打开控制台**已修复**：`ExecStartPre` 改为最多约 5 秒、**任何情况 `exit 0`**（工作区已落地）。本方案按「3210 始终可打开」设计，不再有前置阻塞 | 源码 `deploy/aichat.service`（HEAD 第 33 行是无界版；工作区第 36 行是有界版）；实测 |

---

## 1. ★ 不动生产 QQ 登录态：扫码 UI 能被验证到什么程度、怎么验

### 1.1 为什么绝对不能在生产上「制造一次登出」

生产现场当前的登录路径不是无感的：NapCat journal 里出现过

```
自动快速登录失败: 你的用户身份已失效，为保证账号安全，请你重新登录。
自动密码回退登录需要验证码，请在登录页面继续完成: <BOT_QQ>
```

（2026-10-20 本机实测，`journalctl --user -u napcat`，值已脱敏。）也就是说：**登出后不保证能自动恢复**，可能需要验证码/人工扫码才能回到在线。生产机器人正在服务用户，任何「登出→扫码→登回来」的演练都会造成真实中断，且恢复过程不可控。
结论：**登出态只能被动等待（真实掉线时），或用完全独立的第二套环境演练；不在生产上主动制造。**

### 1.2 三层验证，按「能不能做」排序

| 层 | 验证对象 | 手段 | 是否需要登出生产 | 强度 |
|---|---|---|---|---|
| L1 契约 + UI 全链路 | 本方案的**全部代码逻辑**：鉴权、回环门、状态机、SVG 渲染、轮询/刷新/取消、幂等、限流、错误分支、payload 不泄漏 | **stub NapCat**：本地起一个假 WebUI（实现 §8 的 5 个接口 + 可编程状态机），AIChat 用 `qqLogin.webuiUrl` 指过去；控制台起在临时 data 目录 + 随机端口 | 否 | 高（代码/契约全覆盖，但不证明 NapCat 真这么回） |
| L2 现网只读 | 「已登录短路」这一最关键分支、鉴权闭环、不破现有控制台 | curl 只读命令（§15.2） | 否 | 高（真实 NapCat，但只走 logged_in 分支） |
| L3 首次真实登出 | NapCat 真实响应体、真实扫码时序、真实过期 TTL | 自然发生的掉线（或隔离的第二套 NapCat，见 1.3） | 是/另建环境 | 最高，但不可提前做 |

### 1.3 结论：什么能验、什么不能验

**能验（L1+L2，全部可在今天完成）：**
1. 鉴权闭环：无 token → 401；错 token → 401；正确 header / `?token=` → 200；坏 Origin → 403；非回环 → 403。（本报告已用隔离实例实测了「现有代码」的这一层，见 §16 附录）
2. 登出态可打开：3002 不监听时，3210 仍监听、页面能加载、`/api/status` 200、QQ 登录面板出现（依赖 T1）。
3. 扫码 UI 全链路：取码 → 前端显示二维码 → 轮询 → 已扫待确认 → 登录成功 → 进控制台；以及过期、失败、WebUI 不可达、WebUI 鉴权失败、坏响应形状、限流、取消、幂等。
4. 安全性质：QR payload（等价于「可登录机器人账号」的凭据）不出现在任何 JSON 响应、SSE、日志；不提供 logout 能力。
5. 现网「已登录」分支：`status.phase=logged_in`、`start` 返回 409、`qrcode.svg` 返回 409，全过程不碰登录态。

**不能提前验（必须在 L3 补）：**
1. 真实 NapCat 在**登出态**下 `/api/QQLogin/CheckLoginStatus` 的响应体（我们按容器内源码实现，见 §8，但没在登出态实际调过——遵守只读约束没有发 POST）。
2. 真实扫码后的推进时序：手机确认 → `qrcode_scanned` → `initializing` → `ready`/`isLogin` → OneBot 3001/3002 监听 → AIChat `connected`。
3. 真实二维码的 TTL 与过期文案（本方案的 `expired` 判定按 NapCat 自己的 WebUI 前端同一套启发式实现，见 §8.4）。

**怎么让「不能提前验」的那部分不变成事故：**
- 契约必须**显式校验**：响应缺字段/形状不符一律 `502 NAPCAT_BAD_RESPONSE`（而不是猜一个默认值），日志里记录「哪一层不符」。「读不到」不等于「没有」——三种情况分开：
  - `unreachable`：连不上 6099 / 超时（子系统不在）
  - `failed`/`expired`：连上了，NapCat 明确说登录失败（子系统在，登录没成）
  - `unknown`：本次进程还没探测过
- L3 的验证清单（§15.3）写成「首次真实登出必须逐条打勾」，任一不符 → 改 `src/qq-login.js` 的适配层，前端不动。
- 想**主动**做 L3 也可以，但不是在生产上：在另一台主机（或独立 VM）跑第二套 NapCat 容器（不同容器名、不同端口、不带 `NAPCAT_QUICK_ACCOUNT`），在上面随意登出/扫码。**不要**在同一台生产宿主上起第二套：端口要改映射、会对现有容器与网络产生变更，超出「只读」边界。

---

## 2. 现场拓扑（本机实测 2026-10-20）

| 项 | 事实 | 证据 |
|---|---|---|
| AIChat 服务 | `aichat.service`（系统单元），`User=<deploy-user>`，`ExecStart=/usr/bin/node src/server.js` | `deploy/aichat.service`；`systemctl show aichat` 实测 |
| 控制台监听 | `127.0.0.1:3210`（只回环，经 SSH 隧道访问） | `ss -ltnp` 实测；`src/app.js:1481` |
| NapCat | 用户级 quadlet 容器 `napcat`，rootless podman；镜像 `docker.io/mlikiowa/napcat-docker`，本机 digest `sha256:f611790e…` | `podman ps`/`podman inspect` 实测 |
| 端口 | WebUI `127.0.0.1:6099`、OneBot WS `127.0.0.1:3001`、OneBot HTTP `127.0.0.1:3002`（宿主机侧全部只发布回环） | `deploy/napcat.container:36-38`；`ss` 实测 |
| 容器挂载 | `~<deploy-user>/napcat/qq → /app/.config/QQ`、`~/napcat/config → /app/napcat/config` | `podman inspect napcat` 实测 |
| WebUI 配置文件 | `~/napcat/config/webui.json`：`{host, prefix, port:6099, token:<12 字符>, loginRate:3}` | 实测（只读，未记录值） |
| WebUI token 来源 | 就是上面这个文件；与 journal 里 `[WebUi] Token:` 的值一致（哈希比对相同） | 实测（只比对 sha256，不打印值） |
| 登录态 | 当前在线：`/api/status` → `onebot.connected=true`、`everConnected=true`、`self.nickname` 有值 | 实测 |
| 服务用户与容器同用户 | 系统单元 `User=` 与 rootless podman 容器属于同一 UID ⇒ 读 `~/napcat/config/` 无需提权 | `systemctl show aichat -p User`、`id` 实测 |

---

## 3. 现状核实 A：鉴权覆盖范围

### 3.1 `authorize()` 的真实行为

```js
// src/app.js:1207-1212
function authorize(req) {
  const token = String(getConfig().server?.token ?? '');
  if (!token) return true;                                  // ← 空 token = 全放行
  const url = new URL(req.url, 'http://127.0.0.1');
  return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
}
```

- 令牌来源：`config.server.token`（默认空串，`src/config.js:390`）。
- 两种携带方式：`x-console-token` 头 **或** `?token=` 查询参数（对**所有** `/api/*` 生效，不只 SSE）。
- 空值语义：**不校验**（不是校验失败），即现网行为。

### 3.2 覆盖范围（逐入口）

| 入口 | 位置 | `authorize` | `originAllowed` | 说明 |
|---|---|---|---|---|
| `/api/events`（SSE） | `src/app.js:1327-1352` | ✅ 1328 | ✅ 1329 | 先 401 再 403 |
| `/api/*` 全部路由 | `src/app.js:1354-1385` | ✅ 1355 | ✅ 1358-1360 | 路由表 91 条，全部在门后 |
| 静态 UI（`/`、`/app/*.js`、`/style.css`、图片） | `src/app.js:1388-1468` | ❌ | ❌ | 只做路径穿越防护；**不含任何业务数据** |
| 未知路径 | `src/app.js:1470-1471` | — | — | 404 |

- 路由表共 **91** 条（`grep -c "method: '" src/routes.js`），`method:'*'` 的两条（`/api/prompt-preview`、`/api/captcha-forward`）也在 `/api/` 前缀内，同样过门。
- 没有「在 `/api/` 之外暴露数据」的入口。
- **静态资源保持放行是刻意的**：浏览器加载 HTML/JS/CSS 的子请求不带令牌；若把静态资源也拦，就必须引入 cookie 会话（新一套凭据面）。静态文件不含业务数据，真正的「只有管理员能用」落在 `/api/*` 上。若将来要把 HTML 也收进门，正确做法是「首次 `?token=` 成功后下发 `HttpOnly` cookie」，属于独立改动，不在本方案内。

### 3.3 来源校验 `originAllowed()`（CSRF / DNS rebinding）

`src/app.js:1172-1205`：

1. 若请求带 `x-forwarded-proto` → **直接放行**（识别为 AccessTrust 数据面转发）。注释明确说明：浏览器伪造不了这组头（自定义头会触发预检，本服务不接 CORS），本机进程能伪造但本机进程在可信边界内（服务只监听回环）。
2. 否则：`Host` 必须是回环（`127.0.0.1` / `localhost` / `[::1]`）→ 再校验 `Origin`（同源）或 `Referer`（同 Host）；无来源信息（curl / 地址栏）放行。

对本方案的含义：**`x-forwarded-proto` 不能当作「回环」判据**（本机进程可伪造，且网关转发时也恒为真）——见 §11。

### 3.4 本机隔离实例实测（配了 token 的真实行为）

用临时 data 目录 + 随机端口起一个 AIChat（3001/3002 指向不可达端口，不碰生产），`server.token` 设为探针值：

| 请求 | 结果 |
|---|---|
| `GET /`（静态，无 token） | **200** |
| `GET /api/status`（无 token） | **401** `{"error":"未授权"}` |
| `GET /api/status`（`x-console-token: qq-agent-console`，即**前端现在发的值**） | **401** |
| `GET /api/status`（`x-console-token: <正确值>`） | **200** |
| `GET /api/status?token=<正确值>` | **200** |
| `GET /api/events`（无 token） | **401** |
| `GET /api/events?token=<正确值>` | **200**，`text/event-stream`，首帧 `event: hello` |
| `GET /api/events`（header 带正确值） | **200**（curl 能带头，浏览器 `EventSource` 不能） |
| `GET /api/status`（正确 token + `origin: http://evil.example`） | **403** |

结论：**「配 token」与「前端现状」不兼容**，这是必须一次改全的耦合（见风险 R2）。

---

## 4. 现状核实 B：前端发送令牌的位置（穷举）

`grep` 全 `ui/` 的同源网络入口，只有 3 类：

| # | 位置 | 现状 | 改造后 | 为什么 |
|---|---|---|---|---|
| 1 | `ui/app/00-core.js:614-630` `api()` | 固定发 `x-console-token: CONSOLE_MARKER`（值 `'qq-agent-console'`，定义在 `:557`） | 发真实令牌（header），无令牌时不发该头 | 全部 JSON API 都走这一个包装器 |
| 2 | `ui/app/02-sse-sessions.js:4-5` `connectSSE()` | `new EventSource(consoleUrl('/api/events'))` | URL 追加 `?token=<真实令牌>` | `EventSource` 无法设置请求头 |
| 3 | 新增：QR `<img>`（§13） | — | URL 追加 `?token=<真实令牌>` | `<img>` 同样无法带头 |
| 4 | `ui/app/10-feedback.js:35` 注册 Service Worker（`consoleUrl('/captcha-sw.js')`） | 静态资源请求 | 不变 | 静态资源不过鉴权；SW 只改写阿里域请求（`ui/captcha-sw.js:24-27`） |
| 5 | `ui/landing.html:279`、`ui/app/10-feedback.js:270/622/814` | 外部域名请求 | 不变 | 与同源 API 无关 |

没有任何「直连 `/api/...` 的 `<img src>` / `href` / 裸 `fetch`」——除 1、2 外都安全。
`consoleUrl()`（`ui/app/00-core.js:610-612`）负责子路径挂载前缀（`/aichat/` 之类）；令牌追加必须发生在 `consoleUrl()` 之后，且保留该前缀。

---

## 5. 现状核实 C：UI 加载顺序与首屏

### 5.1 脚本顺序（`ui/index.html:161-174`）

```
app.js (type=module) → 00-core → 01-boot → 02-sse-sessions → 03-snowluma → 04-archive-usage
→ 05-memory-settings → 06-settings-render → 07-settings-events → 08-modals → 09-community
→ 10-feedback → 12-concept2-ui → 11-init（最后，启动入口）
```

module 与 `defer` 共用同一条延迟队列、按文档顺序执行，故 `app.js`（vendor → window 桥）先于 `00-core.js`（`ui/app.js:9-11` 的设计说明）。
**新增的 `13-qq-login.js` 必须排在 `12-concept2-ui.js` 之后、`11-init.js` 之前**（`11-init.js` 是启动入口，会调用它提供的函数）。

### 5.2 首屏链路（登出态的实际行为）

`ui/app/00-core.js:672-689 pollUntilReady()` → `690-700 bootLoop()`：

- 每 1 秒调 `api('/api/status')`，**成功就返回 true**（不要求 `onebot.connected`）→ `hideLoading()` → 进控制台。
- 也就是说：**只要 3210 起来，前端本来就能在登出态进控制台**。「登出态打不开控制台」的根因不在前端，而在 systemd `ExecStartPre` 阻塞（§5.3）。
- 90 秒都失败 → 显示「启动超时…」。

### 5.3 登出态可打开：已修复（本方案直接按「3210 始终可打开」设计）

- 历史阻塞：`ExecStartPre` 用 `curl` 等 3002（HEAD 版 `deploy/aichat.service:33`，最多 180 秒、超时 `exit 1`），而 3002 只在 QQ 登录成功后监听 ⇒ 登出态服务起不来、3210 不监听、扫码 UI 自己打不开。
- 当前工作区已修复：同一行改为最多约 5 秒、**任何情况 `exit 0`**（探到就继续，探不到打 WARN 也继续），迟到连接由代码侧自愈（`src/app.js:1598-1610` 每 2 秒探 OneBot WS 端口、一开就 `reconnect()`；`src/onebot.js` 的连接循环无限退避重试）。
- 因此本方案的前置条件只有一条、且已满足：**服务进程在 OneBot 未就绪时也监听 3210**。扫码面板的「登出态可见」不再需要任何 systemd 侧改动。
- 同步验收：`node test/startup-console-test.mjs`（T1 任务的测试）必须通过——它是「登出态 3210 仍监听」的强制点。

---

## 6. 现状核实 D：「在线/离线」状态的判定来源

### 6.1 数据源

| 来源 | 内容 | 位置 |
|---|---|---|
| `GET /api/status` | `onebot:{connected, everConnected, error, diagnosis, self}`；`snowluma:{dir, running, webuiUrl, embedded, pid}`；`qqPortable`；`orchestrator`；`usage/cost`；`paused`；`dataDir` | `src/routes.js:89-137` |
| `onebot.connected` 的写入点 | OneBot WS `open`/`close` → `#setStatus()` | `src/onebot.js:112-118`、`open` 在 `:208-215` |
| SSE `onebot-status` | `{connected, everConnected, error}` | `src/app.js:658`、`src/onebot.js:115` |
| SSE `status` | `{configUpdated:true}` 之类（粗粒度，不携带连接状态） | `src/routes.js:972,1024,1081` 等 |
| 前端轮询 | `refreshStatus()` 每 `ui.refreshMs`（默认 15000）一次 + 上述 SSE 触发 | `ui/app/01-boot.js:4-30`、`ui/app/02-sse-sessions.js:214-221`、`src/config.js:399` |

### 6.2 登出态的判定缺口（必须由新接口补，不能改 `/api/status` 硬塞）

- `snowluma.running` 的探针端口来自 `snowlumaDir()/config/runtime.json` 的 `webuiPort`，拿不到时**默认 5099**（`src/app.js:156-170`）。Linux 部署不配 `snowluma.dir`（实测 `""`）⇒ 永远探 5099 ⇒ **恒为 false**，与 NapCat 的 6099 无关。
- 因此登出态下 `diagnosis` 会给出「SnowLuma 未运行：请到 SnowLuma 页签启动」——**对容器部署是误导**。
- `qqPortable` 只对 Windows 便携 QQ 有意义。
- 结论：**QQ 登录态没有现成数据源**；唯一权威源是 NapCat WebUI（§8）。新接口 `/api/qq-login/status` 单独承担这一事实，**不改 `/api/status`**（理由：`/api/status` 在热路径上被 SSE/轮询高频调用，且同一事实两处实现必然漂移；`onebot.connected` 继续只表示「能不能干活」）。
- 前端顶部圆点/胶囊的「已连接」判定**保持现状**（`onebot.connected`）；扫码面板另用 `/api/qq-login/status`。两个事实各有唯一家。

### 6.3 与并发中的 `/api/status` 改造的边界（避免重复实现）

`/api/status` 正在被另一条实现线改造，新增的事实（协议端形态与健康、僵尸态探活）由那条线定义，本方案**不重复定义、不新增字段**：

| 新增字段/口径 | 权威描述在哪 | 本方案怎么用 |
|---|---|---|
| `protocol: { mode, wsReachable, httpOk, endpoint }`、`onebot.httpOk/httpError` | `doc/audit/protocol-side-mismatch.md` S1–S3 | 不读、不判 |
| `onebot.dataPathState / dataPathOk / dataPathReason / lastProbeAt / lastInboundAt / probeCount` | `doc/audit/core-faults.md` Z-1/Z-2（`src/onebot.js` 的 `dataPathStatus()` 已提供数据） | 不读、不判 |
| `snowluma.running` 在外部协议端模式下的语义修正 | `doc/audit/protocol-side-mismatch.md` S1/S2 | 不依赖（扫码面板不探 5099） |

扫码面板对「登录/离线」的唯一判据是 `/api/qq-login/status` 的 `phase`（`logged_in` / `qq_offline` / …），**不要**从 `onebot.connected` 反推 QQ 登录态：QQ 已登录但离线时 `onebot.connected=false`，两者不是一回事。

---

## 7. 取二维码：路径选型

### 7.1 路径 A（选用）：NapCat WebUI HTTP API（127.0.0.1:6099）

**可行性证据：**

| 事实 | 证据 | 强度 |
|---|---|---|
| WebUI 在**登录之前**就已监听 | journal 时序：`20:11:19 [WebUi] WebUi User Panel Url: …6099` → `20:11:20 正在快速登录` → `20:12:47 [OneBot] WebSocket Server Started :::3001` | 实测 |
| `/api/*` 存在鉴权中间件（未知 `/api/x` → 401；非 `/api/x` → 404 HTML） | `curl` 实测：`/api/definitely-not-a-route` → `200 {"code":-1,"message":"Unauthorized"}`；`/definitely-not-a-route` → 404 HTML | 实测 |
| 登录接口与 QQLogin 接口存在 | `POST /api/auth/login`（鉴权白名单）、`POST /api/QQLogin/{CheckLoginStatus,GetQQLoginQrcode,RefreshQRcode,GetQQLoginInfo}` | 源码（容器内 `/app/napcat/napcat.mjs:41708-41730`、`49448-49509`、`49710-49730`）+ 反推（`static/assets/qq_manager-*.js`） |
| 服务用户读得到 token 文件 | `~/napcat/config/webui.json` 属主/权限 = 服务用户、`644`（实测） | 实测 |
| 同一 token 值可从文件稳定获得 | 文件 token 与 journal 打印值 sha256 一致 | 实测 |

**优点**：自带完整状态机（登录中/已扫/初始化/重启/失败）、二维码 payload 直接可拿、不需要起子进程、不碰容器文件。
**代价**：需实现一个很小的 WebUI 客户端（登录 + 5 个 POST 调用），并把「响应形状不符」显式报错。

### 7.2 路径 B（不选为主路径）：容器内文件 `podman cp napcat:/app/napcat/cache/qrcode.png`

**可行性**：容器里确实有 `/app/napcat/cache/qrcode.png`（实测 `podman exec napcat ls /app/napcat/cache` → `qrcode.png`）；宿主上**没有**挂载 `/app/napcat/cache`（挂载只有 `~/napcat/qq` 与 `~/napcat/config`，实测 `podman inspect`）；从服务用户的极简环境（`env -i`，无 `XDG_RUNTIME_DIR`）执行 `podman exec` 也能成功（实测）。

**为什么不作主路径：**

| 问题 | 后果 |
|---|---|
| 没有状态机 | 「有没有二维码 / 过期没有 / 扫没扫 / 登录成没成」全要另找来源，等于两套判定 |
| 文件可能是陈旧的 | 实测：**当前已登录**状态下该文件仍然存在（595 字节）——直接读会拿到上一轮的码 |
| 需要起子进程 + rootless 运行时环境 | 每次刷新都 `spawn podman`，进程环境依赖（`XDG_RUNTIME_DIR`/`HOME`）与容器状态耦合，失败面大 |
| PNG 由容器产出，无法校验 | 拿不到「这个码对应哪次登录尝试」 |

**用途**：作为 §8.7 的降级分支（WebUI 不可用且 OneBot 未连接时，若文件 mtime 在 60 秒内才采用），默认关闭。

---

## 8. NapCat WebUI 客户端契约（实现依据）

> 证据：容器内 `/app/napcat/napcat.mjs`（镜像 digest `sha256:f611790e…`）与 `/app/napcat/static/assets/qq_manager-*.js`、`qq_login-*.js`。数值与字段名均来自源码，不是猜。行号指镜像内文件行号，换镜像版本需重新核。

### 8.1 传输约定

- Base：`http://127.0.0.1:6099`（可配 `qqLogin.webuiUrl`）。
- API 前缀：`/api`。
- 响应信封（`napcat.mjs:41708-41726`）：
  - 成功：**HTTP 200** `{"code":0,"data":<...>,"message":"success"}`
  - 失败：**HTTP 200**（注意！）`{"code":-1,"message":"<原因>"}`
  → 客户端必须**按 `code` 判成败，不许按 HTTP 状态码判**。
- 鉴权中间件（`napcat.mjs:49216-49240`）：
  - 白名单：`/auth/login`、passkey 两个端点。
  - 其余 `/api/*` 需要凭据：`Authorization: Bearer <Credential>` 或查询参数 `?webui_token=<Credential>`。
  - 凭据有效期 **1 小时**（`validateCredentialWithinOneHour`），可撤销。

### 8.2 登录 WebUI（拿凭据）

```
POST http://127.0.0.1:6099/api/auth/login
content-type: application/json
{"hash":"<sha256(webuiToken + '.napcat') 的十六进制>","totpCode":"<可选>"}
```

- hash 算法（`napcat.mjs:49203-49205`）：`sha256(token + ".napcat").digest("hex")`。
- 成功：`{"code":0,"data":{"Credential":"<base64 凭据>"},"message":"success"}`
- 开了 2FA 且未带 `totpCode`：`{"code":0,"data":{"require2FA":true,"message":"Please enter your authenticator code"}}`（**没有 Credential**，客户端必须把它当失败：`NAPCAT_AUTH_2FA_REQUIRED`）。
- 失败 `message` 取值（`napcat.mjs:61604-61626`）：`token is empty` / `login rate limit` / `Server token not initialized` / `token is invalid` / `Invalid or expired code`。
- 限流：按来源 IP，阈值取 `webui.json` 的 `loginRate`（现场 `3`）。
→ 实现要求：**凭据缓存 50 分钟**；只在 401 时重登一次，重登失败退避 ≥60 秒；重登计数打日志（不打凭据）。

### 8.3 QQ 登录状态

```
POST http://127.0.0.1:6099/api/QQLogin/CheckLoginStatus
Authorization: Bearer <Credential>
（body 不需要，但按 POST 发）
```

成功响应 `data`（`napcat.mjs:49455-49466` 的构造函数）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `isLogin` | bool | `QQLoginStatus && selfInfo.online === true` —— **只有「已登录且在线」才为 true** |
| `isOffline` | bool | 已登录但 `online === false`（掉线/网络断） |
| `loginPhase` | string | `waiting_qrcode` / `generating_qrcode` / `qrcode_scanned` / `initializing` / `reconnecting` / `ready` / `offline`（枚举来自 `setQQLoginPhase(...)` 调用点） |
| `qrLoginAccepted` | bool | 已接受扫码登录（scanned / initializing） |
| `coreReady` | bool | QQ 核心就绪 |
| `qrcodeurl` | string | **二维码内容**（不是图片 URL！WebUI 前端把它交给 QR 组件现场渲染，`qq_login-*.js` 里 `value:n` 渲染）。空串=当前没有可扫的码 |
| `loginError` | string | 登录失败原因（可能为空） |

### 8.4 取码 / 刷新码

```
POST /api/QQLogin/GetQQLoginQrcode
→ {"code":0,"data":{"qrcode":"<qrcodeurl>"}}
   失败：code -1，message "QQ Is Logined" / "QRCode Get Error"

POST /api/QQLogin/RefreshQRcode
→ {"code":0,"data":{"qrcodeurl":"<新的 qrcodeurl>"}}
   或 {"code":0,"data":{"qrcodeurl":"","restarting":true}}   // 登录服务重启中
   失败：code -1，"QQ Is Logined" / "QRCode Refresh Error: <原因>"
```

（`napcat.mjs:49448-49453`、`49493-49506`。）

**过期判定**：NapCat 没有专门的「过期」字段。它自己的 WebUI 前端用 `loginError` 文本启发式（`qq_login-*.js`）：`loginError` 含「二维码」且含「过期」或「失效」。本方案沿用同一判定，并额外接受「超时」（`napcat.mjs:41702` 的刷新超时文案是「二维码刷新超时：…」）。

### 8.5 会话内其它可用接口（本方案不用）

`GetQQLoginInfo`（账号信息）、`GetQuickLoginList(New)`、`SetQuickLogin`、`PasswordLogin`/`CaptchaLogin`/`NewDeviceLogin`、`RestartNapCat`、`ResetDeviceID`、`GetDeviceGUID` 等都在 `/api/QQLogin/*` 下（`napcat.mjs:49710-49730`）。
**本方案不调用 `RestartNapCat` / `ResetDeviceID` / 任何登出接口**——它们会改变 QQ 登录现场。

### 8.6 WebUI token 的读取

- 文件：`qqLogin.webuiTokenFile`，默认 `~/napcat/config/webui.json`（与 `deploy/napcat.container:35` 的挂载约定一致；以服务用户身份可读）。
- 解析：`JSON.parse` 后取 `token`（string，非空）。
- 读不到 / 不是 JSON / `token` 为空 ⇒ `NAPCAT_AUTH_FAILED`（**fail-closed**，不许当成「没有 token 就放行」）。
- 不在 `/api/config` 里支持内联 token：`sanitizeConfig` 的密钥模式只匹配键名 `token`（`src/app.js:1222`），内联成 `qqLogin.webuiToken` 会被**明文回传**。因此配置只存路径。
- 不把 token / 凭据 / `qrcodeurl` 写任何日志、任何 HTTP 响应体、任何 SSE。

### 8.7 降级分支（默认关闭，作为现场应急开关）

`qqLogin.fallbackContainerQrcode: false`。置 true 时：仅当 WebUI 不可达 **且** `onebot.connected === false`，用 `podman cp` 读容器内 `/app/napcat/cache/qrcode.png`，且只在该文件 mtime 距今 <60 秒时返回。出现任何异常一律回到「不可用」。

---

## 9. 新接口契约：`/api/qq-login/*`

### 9.1 通用约定

| 项 | 约定 |
|---|---|
| 鉴权 | 全部走现有 `authorize()`（token 头或 `?token=`）+ `originAllowed()` |
| 回环门 | `/api/qq-login/` 前缀额外要求 `req.socket.remoteAddress` 是回环（§11） |
| 响应体形状 | 成功 `{"ok":true,...}`；业务失败 `{"ok":false,"code":"<大写码>","error":"<中文文案>"}`；鉴权/来源/回环失败沿用现有 `{"error":"..."}`（不改 `authorize` 的输出形状） |
| 缓存 | 所有响应 `cache-control: no-store` |
| 幂等 | `start`/`refresh` 在冷却窗口内重复调用返回同一结果（见各接口） |
| 不泄漏 | 响应/日志里不出现 `qrcodeurl` 原文、WebUI token、Credential |

### 9.2 状态机（对外 `phase`，10 值）

| phase | 含义 | 来源判定 | 前端动作 |
|---|---|---|---|
| `unknown` | 本进程尚未探测 | 模块冷启动 | 面板打开时调一次 `start` |
| `unreachable` | 连不上 NapCat WebUI（或 WebUI 鉴权失败） | fetch 失败/超时；或 `code!==0` 且 message 属于 `login rate limit`/`token is invalid`/`Server token not initialized` | 显示「NapCat WebUI 不可用」+ 重试按钮；不显示二维码 |
| `logged_in` | QQ 已登录且在线 | `isLogin===true` | 关闭面板，进控制台 |
| `qq_offline` | QQ 已登录但离线 | `isOffline===true` 且 `isLogin===false` | 显示「已登录但当前离线」，保留轮询 |
| `qr_waiting` | 有可扫的码 | `loginPhase ∈ {waiting_qrcode, generating_qrcode}` 且 `qrcodeurl !== ''` | 显示二维码，1.5 秒轮询 |
| `qr_scanned` | 已扫码，等手机确认 | `loginPhase === 'qrcode_scanned'` | 「已扫码，请在手机上确认」 |
| `initializing` | 登录成功，NapCat 正在起 QQ/OneBot | `loginPhase === 'initializing'` | 「登录成功，正在启动…」，1 秒轮询 |
| `restarting` | 登录服务正在重启（刷新二维码期间） | `loginPhase === 'reconnecting'` | 「正在准备新的二维码…」 |
| `expired` | 二维码过期/失效 | `loginError` 含「二维码」且含「过期/失效/超时」 | 「二维码已过期」+ 刷新按钮（**不自动刷新**） |
| `failed` | 其他登录失败 | 其它非空 `loginError` | 显示原因 + 刷新按钮 |

判定顺序（写死，避免歧义）：`isLogin` → `isOffline` → `loginPhase` 命中 → `loginError` 启发式 → 兜底 `failed`。

### 9.3 `GET /api/qq-login/status`

- 请求：无 body。鉴权可用 header 或 `?token=`。
- 成功 200：

```json
{
  "ok": true,
  "phase": "qr_waiting",
  "loggedIn": false,
  "offline": false,
  "account": { "uin": "", "nickname": "" },
  "qr": { "available": true, "issuedAt": 1792502400123, "expiresInMs": 95000 },
  "napcat": { "reachable": true, "webuiUrl": "http://127.0.0.1:6099", "latencyMs": 12 },
  "watchers": 1,
  "retryAfterMs": 0,
  "error": null
}
```

- `qr.expiresInMs` 是**前端倒计时用的估计值**（默认 `qrTtlMs=120000` 减去已过时长，下限 0），NapCat 的真实 TTL 为准；不作为判定依据。
- `watchers`：当前打开面板的会话数（本实现用「最近 `pollIdleMs` 内被轮询过」近似，恒为 0/1）。

失败分支：

| HTTP | body | 触发 |
|---|---|---|
| 401 | `{"error":"未授权"}` | 未带/带错令牌 |
| 403 | `{"error":"请求来源不被信任（…）"}` | `originAllowed` 失败 |
| 403 | `{"error":"仅允许回环地址访问"}` | 非回环 remoteAddress |
| 502 | `{"ok":false,"code":"NAPCAT_BAD_RESPONSE","error":"NapCat WebUI 响应不符合契约：缺少 loginPhase"}` | `code===0` 但 `data` 形状不符 |

> 注：WebUI 不可达时**不是** HTTP 错误，而是 `200` + `phase:"unreachable"` + `error.code:"NAPCAT_WEBUI_UNREACHABLE"`——这是子系统真实状态，不该让控制台分不清「控制台坏了」和「协议端没起」。

### 9.4 `POST /api/qq-login/start`

- 请求：`{}`（空 body 允许）。
- 语义（顺序写死）：
  1. 若缓存 `phase ∈ {qr_waiting, qr_scanned, initializing, restarting}` 且 `now - issuedAt < 90000` → 直接返回缓存（**不发任何 NapCat 请求**，保证幂等）。
  2. `POST /api/QQLogin/CheckLoginStatus`。
  3. `isLogin` → `409 QQ_ALREADY_LOGGED_IN`（`loggedIn:true`）。
  4. `qrcodeurl` 非空 → 缓存（`issuedAt=now`）并返回 `phase`（按 §9.2 映射）。
  5. 否则 `POST /api/QQLogin/GetQQLoginQrcode`；有 `qrcode` → 缓存返回。
  6. 仍为空 → `POST /api/QQLogin/RefreshQRcode`；返回 `qrcodeurl` → 缓存；`restarting:true` → `phase:"restarting"`。
- 成功 200：同 §9.3 的结构（`ok:true` + 状态字段）。
- 失败分支：

| HTTP | code | 触发 |
|---|---|---|
| 401 | — | 未授权 |
| 403 | — | 来源不被信任 |
| 403 | — | 非回环 |
| 409 | `QQ_ALREADY_LOGGED_IN` | `isLogin===true` |
| 429 | `RATE_LIMITED` + `retryAfterMs` | 距上次 start/refresh < `actionCooldownMs`(3000) |
| 503 | `NAPCAT_WEBUI_UNREACHABLE` | 连不上 6099 / 超时（`requestTimeoutMs` 1500） |
| 503 | `NAPCAT_AUTH_FAILED` | token 文件读不到 / `token is invalid` / `login rate limit` |
| 502 | `NAPCAT_QR_UNAVAILABLE` | NapCat 回 `"QRCode Get Error"` |
| 502 | `NAPCAT_BAD_RESPONSE` | 响应形状不符 |

### 9.5 `POST /api/qq-login/refresh`

- 请求：`{}`。
- 语义：**强制重新取码**（用户点「刷新二维码」）。
  1. 冷却：距上次 start/refresh < 3000ms → `429 RATE_LIMITED`（`retryAfterMs`）。
  2. `POST /api/QQLogin/CheckLoginStatus`；`isLogin` → 409。
  3. `POST /api/QQLogin/RefreshQRcode`。
     - `restarting:true` → `phase:"restarting"`（前端继续轮询，最长等 3 分钟，与 NapCat 自己的 WebUI 文案一致）。
     - 新 `qrcodeurl` 与缓存相同 → `issuedAt` **不更新**（避免前端无谓重建图片），返回 200 原样。
     - 新 `qrcodeurl` 不同 → 更新缓存与 `issuedAt`。
- 成功：同 §9.3。
- 失败分支：401 / 403 / 403（回环）/ 409 `QQ_ALREADY_LOGGED_IN` / 429 / 503 `NAPCAT_WEBUI_UNREACHABLE` / 503 `NAPCAT_AUTH_FAILED` / 502 `NAPCAT_QR_REFRESH_FAILED`（`"QRCode Refresh Error: …"`）/ 502 `NAPCAT_BAD_RESPONSE`。

### 9.6 `GET /api/qq-login/qrcode.svg`

- 请求：无 body。可用 `?token=`；`?v=<nonce>` 只用于防缓存（忽略语义）。
- 成功 200：
  - `content-type: image/svg+xml; charset=utf-8`
  - `cache-control: no-store`
  - `x-content-type-options: nosniff`
  - body：`<svg …>`（由服务端把 `qrcodeurl` 渲染成二维码，`qrcode` npm 的 `toString(payload,{type:'svg'})`；`errorCorrectionLevel:'M'`、`margin:1`、`width:240`）
- 失败分支：

| HTTP | code | 触发 |
|---|---|---|
| 401 | — | 未授权 |
| 403 | — | 来源/回环 |
| 409 | `QQ_ALREADY_LOGGED_IN` | 已登录（前端应关闭面板） |
| 404 | `NO_QR_AVAILABLE` | 当前 `phase` 没有可用码（`unknown`/`restarting`/`unreachable`） |
| 410 | `QR_EXPIRED` | `phase === "expired"` |
| 503 | `NAPCAT_WEBUI_UNREACHABLE` / `NAPCAT_AUTH_FAILED` | 无法取码 |
| 500 | `QR_RENDER_FAILED` | 渲染库异常（**不重试**，直接暴露，属程序缺陷） |

> 为什么返回 SVG 而不是 PNG/dataURL：服务端渲染让 `qrcodeurl`（等价登录凭据）**永不进入浏览器 JS / localStorage / 历史记录**；SVG 无二进制依赖，`img-src 'self'` 直接可用，`<img>` 用 `?token=` 恰好复用现有鉴权能力。

### 9.7 `DELETE /api/qq-login/session`

- 请求：无 body。
- 语义：**停止服务端轮询与缓存，不调用 NapCat 任何接口，不登出 QQ**。幂等。
- 成功 200：`{"ok":true,"stopped":true,"watchers":0}`
- 失败分支：

| HTTP | code | 触发 |
|---|---|---|
| 401 | — | 未授权 |
| 403 | — | 来源/回环 |
| 409 | `GENERATION_IN_FLIGHT` + `retryAfterMs` | 有 start/refresh 正在飞（等它结束再取消，避免状态半成品） |
| 500 | `INTERNAL` | 取消过程中异常（记录日志，面板提示重试） |

### 9.8 明确不提供的接口

| 不提供 | 原因（安全红线） |
|---|---|
| `POST /api/qq-login/logout`、`/api/qq-login/restart-napcat`、`/api/qq-login/reset-device` | 这些动作会改变 QQ 登录现场：登出会打断正在服务用户的机器人，且现场恢复可能需要验证码/人工干预（§1.1）。控制台只允许「把登录补回来」，不提供「把登录踢掉」。 |

### 9.9 SSE

**不新增 SSE 事件。** 登录态的唯一家是 `/api/qq-login/status`（面板打开时轮询）；顶部「已连接」继续由现有 `onebot-status` 驱动。理由：两个来源描述同一件事必然漂移；面板关闭时也没有人需要登录态推送。

### 9.10 接口清单表（交付物）

| # | 方法 | 路径 | 作用 | 鉴权 | 回环门 | 主要成功体 | 失败码（除 401/403/403 外） |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/api/qq-login/status` | 查询登录态 | token | 是 | `phase/loggedIn/offline/qr/napcat/error` | 502 `NAPCAT_BAD_RESPONSE` |
| 2 | POST | `/api/qq-login/start` | 开始扫码登录（幂等） | token | 是 | 同 1 | 409 / 429 / 503×2 / 502×2 |
| 3 | POST | `/api/qq-login/refresh` | 强制重新取码 | token | 是 | 同 1 | 409 / 429 / 503×2 / 502×2 |
| 4 | GET | `/api/qq-login/qrcode.svg` | 二维码图片 | token | 是 | `image/svg+xml` | 409 / 404 / 410 / 503×2 / 500 |
| 5 | DELETE | `/api/qq-login/session` | 取消本次扫码 | token | 是 | `{ok,stopped,watchers}` | 409 / 500 |
| — | — | `/api/qq-login/logout` 等 | **不提供**（§9.8） | — | — | — | 404（路由不存在） |

---

## 10. 鉴权闭环方案（写死）

### 10.1 令牌的配置与生效

1. 生成：`openssl rand -hex 16`（32 hex 字符）。
2. 写入运行中的配置（深合并，只改 `server.token`，不动 `server.port`；已实测 `updateConfig` 为深合并，`src/config.js:436-455,644-656`）：

```bash
TOKEN='<32 位十六进制>'
curl -s -X POST http://127.0.0.1:3210/api/config \
  -H 'content-type: application/json' \
  -d "{\"server\":{\"token\":\"$TOKEN\"}}"
```

3. 生效方式：`authorize()` 每次请求都读 `getConfig()`（`src/app.js:1208`），`updateConfig` 同时更新内存与磁盘 ⇒ **无需重启**。
4. 回滚：`-d '{"server":{"token":""}}'` 即恢复放行（但这是安全降级，只在紧急时用）。
5. 说明：`POST /api/config` 返回的是脱敏配置（`sanitizeConfig` 把 `token` 换成 `hasToken`，`src/app.js:1222-1250`），不会回显明文。

### 10.2 前端：令牌从 URL 进、从请求出

新增常量与函数（`ui/app/00-core.js`，放在 `consoleUrl()` 附近）：

```js
const CONSOLE_TOKEN_KEY = 'qqa-console-token';

function getConsoleToken() {
  try { return sessionStorage.getItem(CONSOLE_TOKEN_KEY) || ''; } catch { return ''; }
}
function setConsoleToken(t) {
  try { t ? sessionStorage.setItem(CONSOLE_TOKEN_KEY, t) : sessionStorage.removeItem(CONSOLE_TOKEN_KEY); } catch { /* 隐私模式忽略 */ }
}
/** 把令牌追加到同源 URL（EventSource / <img> 不能带头，只能走 ?token=）。 */
function withConsoleToken(url) {
  const t = getConsoleToken();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}
/** 页面加载时把 ?token= 收进 sessionStorage，并把令牌从地址栏抹掉（不留在历史/书签里）。 */
function captureConsoleToken() {
  let u;
  try { u = new URL(location.href); } catch { return; }
  const t = u.searchParams.get('token') || '';
  if (t) {
    setConsoleToken(t);
    u.searchParams.delete('token');
    try { history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash); } catch { /* 忽略 */ }
  }
}
captureConsoleToken();     // 00-core.js 顶层立即执行
```

改造点：

| 位置 | 改成 |
|---|---|
| `ui/app/00-core.js:614-630` `api()` | 有令牌时发 `x-console-token: getConsoleToken()`，无令牌时**不发**该头；收到 401 时抛 `const e = new Error('未授权'); e.code='UNAUTHORIZED'; throw e` |
| `ui/app/00-core.js:557` | 删除 `CONSOLE_MARKER`（不再发假令牌） |
| `ui/app/02-sse-sessions.js:5` | `new EventSource(withConsoleToken(consoleUrl('/api/events')))` |
| `ui/app/02-sse-sessions.js:172` `es.onerror` | 连续 3 次失败且无令牌 → 顶栏 banner 提示「未授权：请用带 ?token= 的地址打开控制台」并 `es.close()`（避免无限重连） |
| QR `<img>`（§13） | `withConsoleToken(consoleUrl('/api/qq-login/qrcode.svg'))` |

令牌不进 `localStorage`：`sessionStorage` 随标签页销毁，新标签页/重启浏览器需要重新带 `?token=`（或走 §10.3 的输入框）。这是刻意的取舍——令牌是管理员凭据，不该在磁盘上长期驻留。

### 10.3 首屏无令牌/错令牌

`ui/app/00-core.js:672-689 pollUntilReady()` 现在把任何异常都当「还没就绪」，重试 90 秒后报「启动超时」（误导）。改成：

- `catch` 里若 `err.code === 'UNAUTHORIZED'` → 返回 `'need_token'`（立即停止重试）。
- `bootLoop()` 把结果透传给 `init`：`'ready' | 'logged_out' | 'need_token'`。
- `'need_token'` → `hideLoading()` + `openTokenPrompt()`：全屏卡片，一个 `type=password` 输入框 + 「进入」按钮；提交 → `setConsoleToken(v)` + `location.reload()`。
- 提示文案必须写明令牌从哪来（配置文件 `/var/lib/aichat/data/config.json` 的 `server.token`，或一次性 `POST /api/config` 设置）。

### 10.4 与「只有管理员能访问」的落点

| 层 | 机制 | 覆盖 |
|---|---|---|
| 网络 | 服务只监听 `127.0.0.1`（`src/app.js:1481`）；现场经 SSH 隧道访问 | 外网不可直连 |
| 令牌 | `server.token` + `x-console-token`/`?token=` | 所有 `/api/*`（含 SSE、QR 图） |
| 来源 | `originAllowed()` | CSRF / DNS rebinding |
| 登录态凭据 | 令牌 + 回环门 | `/api/qq-login/*` |
| 静态资源 | 不鉴权（刻意，§3.2） | 无业务数据 |

---

## 11. 回环限定（`/api/qq-login/*` 额外门）

### 11.1 判据

```js
// src/qq-login.js
export function isLoopbackAddress(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
```

在 `src/app.js` 的 `handleHttp` 里、`authorize` 与 `originAllowed` 之后（现 `1354-1360` 那段）加**唯一一处**门：

```js
if (pathname.startsWith('/api/qq-login/') && !isLoopbackAddress(req.socket?.remoteAddress)) {
  return json(res, 403, { error: '仅允许回环地址访问' });
}
```

### 11.2 明确不信什么

| 不信 | 原因 |
|---|---|
| `X-Forwarded-Proto` | **客户端可伪造**（本机进程随意加；网关转发时也恒有）——它只能证明「经过了网关」，不能证明「来源是回环」。`originAllowed()` 用它做「放行网关链路」可以（浏览器伪造不了），但不能拿它当回环判据。 |
| `X-Forwarded-For` / `X-Real-IP` | 同上，可伪造 |
| `Host` 头 | 只是字符串，不能证明 TCP 来源（DNS rebinding 场景下 Host 也可能是攻击者域名） |
| 反向代理层配置 | 不在本进程的判定范围内，不作为鉴权依据 |

### 11.3 这个门挡什么、不挡什么

- 挡：未来若有人把 `listen` 改成 `0.0.0.0`，QQ 登录凭据相关接口仍然只接受本机来源。
- 不挡：AccessTrust 数据面转发（网关与 AIChat 同机，`remoteAddress` 也是 127.0.0.1）——这是有意的：那条链路的安全性由 AccessTrust 的 SSO + 本方案的 token 负责。
- 不替代：**真正的管理员边界是 token**。回环门只是纵深防御。

---

## 12. 后端改动点（文件级）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/qq-login.js`（新增） | `createQQLogin({ getConfig, log })` + `isLoopbackAddress()` | §8 的 WebUI 客户端、§9 的状态机与错误映射、SVG 渲染、缓存/冷却/空闲停止、`dispose()`。所有对外错误用 `QQLoginError{code,httpStatus,retryAfterMs}` |
| `src/config.js` | `snowluma` 组之后（现 `165-174`）加 `qqLogin` 组 | 见 §12.1；不加任何密钥值字段 |
| `src/app.js` | ① import 并实例化 `qqLogin`；② 传进 `createRoutes` 依赖；③ 在 `/api/*` 门后加回环门（§11.1）；④ `stop()` 里 `qqLogin.dispose()` | 四处锚点见 §12.3 A |
| `src/routes.js` | 追加 5 条路由（§9），handler 从 `deps.qqLogin` 取模块、用 `json()` 回包、`qrcode.svg` 用 `res.writeHead/end` 直接写 SVG Buffer | 两处锚点见 §12.3 B；不改 `/api/status`（§6.3） |
| `package.json` | `dependencies` 加 `"qrcode": "^1.5.4"` | 服务端渲染 SVG；部署侧 `deploy/update.sh:53,66` 已支持「依赖变化才 `npm install --omit=dev`」并带健康检查回滚 |
| `test/_harness.mjs` | `bootApp({ waitOneBot = true })` 新参数 | 登出态测试需要 OneBot 不连接；默认 true 保持现有测试不变 |
| `test/qq-login-test.mjs`（新增） | stub WebUI + 断言（§15.1） | 加入 `package.json` 的 `test` 脚本尾部 |
| `deploy/OPERATIONS.md` | 新增「扫码登录」一节 | 唯一操作说明的家：怎么设 token、怎么打开、二维码不出来的排查顺序。本报告不重复这些操作细节（报告是方案，不是长期运维手册） |

### 12.1 `config.js` 新增组（写死）

```js
qqLogin: {
  webuiUrl: 'http://127.0.0.1:6099',            // NapCat WebUI（容器端口映射见 deploy/napcat.container）
  webuiTokenFile: '~/napcat/config/webui.json', // 只存路径，不存令牌值
  requestTimeoutMs: 1500,                       // 单次 WebUI 调用超时（回环，够用）
  pollIdleMs: 90000,                            // 无人在看时停止轮询的静默期
  actionCooldownMs: 3000,                       // start/refresh 冷却
  qrTtlMs: 120000,                              // 前端倒计时估计值（真实 TTL 以 NapCat 为准）
  qrSvgWidth: 240,
  fallbackContainerQrcode: false                // §8.7 应急分支
}
```

`~/` 展开用模块内小工具（`path.resolve(os.homedir(), p.replace(/^~(?=$|\/)/, ''))`），不引第三方依赖。

### 12.2 `src/qq-login.js` 结构（照此实现）

```
isLoopbackAddress(addr)                         // 纯函数，可单测
createQQLogin({ getConfig, log }) -> {
  status()                                      // §9.3，缓存 TTL 1000ms
  start()                                       // §9.4，in-flight 去重
  refresh()                                     // §9.5
  qrcodeSvg()                                   // §9.6，返回 {svg, issuedAt}
  stop()                                        // §9.7
  dispose()                                     // 清定时器
}
内部：
  readWebuiToken()                              // 读文件 + JSON.parse + 非空校验，失败抛 NAPCAT_AUTH_FAILED
  hashToken(token)                              // sha256(token + '.napcat').hex
  ensureCredential()                            // 缓存 50min；401 时重登一次；限流退避 60s
  webuiPost(path, body)                         // POST {webuiUrl}/api/{path}，Bearer，1.5s 超时，按 code 判成败
  fetchLoginState()                             // CheckLoginStatus + 契约校验
  normalize(raw)                                // NapCat 响应 → 对外 phase（§9.2 判定顺序）
  ensureQr(), refreshQr()                       // §9.4/§9.5 的顺序
  renderSvg(payload)                            // qrcode 库
  markWatching() / idle 定时器                  // 轮询静默期
```

硬性要求：

1. `webuiPost` 的响应必须先校验 `code === 0` 且 `data` 是对象，字段缺失走 `NAPCAT_BAD_RESPONSE`（**不许 `?? ''` 把「读不到」洗成「空」**）。
2. `qrcodeurl` 只在模块内存里存在；不打日志、不进响应体（只有 `qrcode.svg` 的输出通道）。
3. 任何写操作（start/refresh）必须带冷却与 in-flight 去重，避免连点打崩 NapCat 登录服务。
4. `dispose()` 幂等；`stop()` 不调用 NapCat。

### 12.3 锚点：函数名 + 插在哪两句之间（行号会漂，锚点不会）

行号是当前工作区的参考值（`src/app.js`/`src/routes.js`/`src/config.js` 另有一条实现线在改，漂移正常）。

**A. `src/app.js`（4 处）**

| # | 锚点函数/位置 | 插在哪两句之间 | 参考行号 |
|---|---|---|---|
| A1 | 文件顶部 import 区 | `import { OneBotClient, … } from './onebot.js';` 之后、`import { isAtMe } from './prompt.js';` 之前：`import { createQQLogin, isLoopbackAddress } from './qq-login.js';` | `3-30` |
| A2 | `createApp()` 内部实例化 | 注释 `// 声明式路由表（src/routes.js）：把所有依赖一次性注入。` 的上一行、`const apiRoutes = createRoutes({` 之前：`const qqLogin = createQQLogin({ getConfig, log });` | `~1306-1308` |
| A3 | `const apiRoutes = createRoutes({ … })` 依赖对象 | `readBody, authorize,` 这一行**之后**、`snowlumaDir, …` 之前：加 `qqLogin,` | `1313` |
| A4 | `async function handleHttp(req, res)` 的 `/api/` 门 | `if (pathname.startsWith('/api/')) {` 里：`if (!originAllowed(req)) { … }` 的**闭括号之后**、`const method = req.method;` **之前**：`if (pathname.startsWith('/api/qq-login/') && !isLoopbackAddress(req.socket?.remoteAddress)) return json(res, 403, { error: '仅允许回环地址访问' });` | `1354-1361` |
| A5 | `async function stop()` | `await orchestrator.abortAll();` 之后、`orchestrator.stopReminderLoop();` 之前：`try { qqLogin.dispose(); } catch { /* ignore */ }` | `~1654-1660` |

**B. `src/routes.js`（2 处）**

| # | 锚点函数/位置 | 插在哪两句之间 | 参考行号 |
|---|---|---|---|
| B1 | `export function createRoutes(deps)` 里的 `const { … } = deps;` 解构 | `readBody, authorize,` 之后、`snowlumaDir, …` 之前：加 `qqLogin,` | `48` |
| B2 | `return [ … ];` 的数组末尾 | 最后一个元素（`method: '*', pattern: /^\/api\/captcha-forward\/?$/` 的对象）的收尾 `},` **之后**、`];` **之前**：追加 5 条 `/api/qq-login/*` 路由（§9） | `1513-1577` |

**C. `src/config.js`（1 处）**

| # | 锚点 | 插在哪两句之间 | 参考行号 |
|---|---|---|---|
| C1 | `DEFAULT_CONFIG.snowluma` 组 | 该组收尾 `},` 之后、注释 `// 人设与行为` 之前：插入 `qqLogin: { … }`（§12.1） | `165-175` |

**D. 不改的文件**

| 文件 | 原因 |
|---|---|
| `src/server.js` | headless 入口只调 `createApp()`；`stop()` 已覆盖 |
| `deploy/aichat.service` | 登出态可打开已修复（§5.3） |
| `src/onebot.js` | 登录态不从这里取（§6.3） |
| `ui/app/*` 里除 §13 列出的文件 | 令牌/面板/状态分流都在已列文件内 |

### 12.4 写域边界（与并发实现线协作）

`src/app.js`、`src/routes.js`、`src/config.js` 同时被「HTTP 数据面自检 + 外部协议端模式」那条实现线占用；`ui/` 与 `test/qq-login-ui-test.mjs` 由扫码登录页实现线占用。落地时：

1. **先后顺序**：本方案的后端接线（A1–A5、B1–B2、C1）与那条线的 `/api/status` 改造互不重叠（后者在 status handler 内部、`createRoutes` 依赖里加的是 `protocol` 相关），可并行；冲突点只有两处相邻行（A3/B1 的依赖清单、B2 的数组末尾），按锚点合并是机械操作。
2. **`package.json` 冲突**：`test` 脚本末尾追加测试时，注意同时有人在改这条脚本（登出态启动测试）。
3. **不要**在 `src/routes.js` 的 `/api/status` handler 里加任何 QQ 登录态字段——那是另一条线的事实（§6.3），两处实现必然漂移。

---

## 13. 前端改动点（文件级）

| 文件 | 改动 | 关键细节 |
|---|---|---|
| `ui/app/00-core.js` | ① 令牌读取/存储/URL 剥离（§10.2）；② `withConsoleToken()`；③ `api()` 改发真实令牌 + 401 抛 `UNAUTHORIZED`；④ 删 `CONSOLE_MARKER`；⑤ `pollUntilReady`/`bootLoop` 支持 `need_token`/`logged_out` | 令牌剥离必须在 `app.js`（module）之后、首次 `api()` 之前完成——放在 `00-core.js` 顶层执行即可 |
| `ui/app/02-sse-sessions.js` | `EventSource` URL 带令牌；`onerror` 连续失败且无令牌 → banner + `close()` | 不改事件处理逻辑 |
| `ui/app/13-qq-login.js`（新增） | 面板 + 轮询 + 令牌输入框 | 见 §13.1 |
| `ui/app/01-boot.js` | `refreshStatus()` 末尾：`$('#qq-login-chip')?.classList.toggle('hidden', !!s.onebot?.connected)` | 唯一改动点，别动其它渲染 |
| `ui/app/11-init.js` | 启动分流：`ready` → `enterConsole()`；`logged_out` → `hideLoading()` + 打开扫码面板（关闭时 `enterConsole()`）；`need_token` → 令牌输入框 | 把现有 init 尾部抽成幂等的 `enterConsole()`（含 `hideLoading`、配置读取、`refreshStatus`、`startStatusPoller`、`connectSSE`、`loadSessions`、`loadMemoryView`、`initSessionScrollLoader`），并用 `consoleEntered` 防重复 |
| `ui/index.html` | ① 顶栏加壳按钮 `#qq-login-chip`（`<button class="nav-btn hidden" title="QQ 未登录：点此扫码登录">QQ 登录</button>`，放在 `#pause-btn` 旁边）；② 脚本顺序加 `<script defer src="./app/13-qq-login.js"></script>` 在 `12-concept2-ui.js` 之后、`11-init.js` 之前 | CSP 无需改：`img-src 'self'` 已允许同源 SVG |
| `ui/style.css` | `.qq-login-overlay` / `.qq-login-card` / `.qq-login-qr` / `.qq-login-phase` / `.qq-login-error` / `.qq-login-actions` | QR 图容器白底（二维码必须白底才可扫）、宽 240px；复用现有 `--bg/--raise-sm` 变量，不引新设计体系 |

### 13.1 `13-qq-login.js` 行为（写死）

- `openQQLoginPanel({ onDismiss })`：创建 `#qq-login-overlay`（`position:fixed`，`z-index` 高于顶栏）→ 立刻 `GET /api/qq-login/status` → 若 `phase==='unknown'` 先 `POST start` → 渲染。
- 轮询：面板打开期间 `setTimeout` 自续期；`phase ∈ {qr_waiting, qr_scanned, restarting}` → 1500ms；`initializing` → 1000ms；`unreachable/expired/failed` → 5000ms（等用户点按钮，别白刷）。关闭面板即清定时器。
- 渲染映射：二维码只在 `qr.available && phase ∈ {qr_waiting}` 时显示 `<img src=withConsoleToken(consoleUrl('/api/qq-login/qrcode.svg')) + '&v=' + issuedAt>`；`issuedAt` 变化才换 `src`（防闪）。
- 阶段文案（直接抄，避免实现者自己写）：`qr_waiting`「请用 QQ 扫描二维码登录」/`qr_scanned`「已扫码，请在手机上确认」/`initializing`「登录成功，正在启动 QQ…」/`restarting`「正在准备新的二维码…」/`expired`「二维码已过期，请点刷新」/`unreachable`「连不上 NapCat WebUI（127.0.0.1:6099）」+ 排查提示/`qq_offline`「QQ 已登录但当前离线」/`failed`「登录失败：<error>」。
- 按钮：`刷新二维码`（→ `POST refresh`，429 时显示倒计时）、`重新检测`（→ `GET status`）、`稍后再说`（关闭面板 → `onDismiss()`）。
- `phase==='logged_in'` → 关闭面板 → `onDismiss()`（即 `enterConsole()`）；如果面板是从顶栏打开的，`onDismiss` 为空函数即可（控制台本来就在）。
- `error.code==='UNAUTHORIZED'` → 直接切到令牌输入框。

---

## 14. 不变量与强制点

| # | 不变量 | 强制点 |
|---|---|---|
| I1 | 未配置 `server.token` 时，`/api/*` 行为与现在完全一致（不需要令牌） | 现有 `authorize()`（`src/app.js:1209`）+ 回归测试断言 200 |
| I2 | 配置 `server.token` 后，任何不带正确令牌的 `/api/*`（含 SSE）必须 401；静态资源仍 200 | 现有 `authorize()` + `test/qq-login-test.mjs` 的四条鉴权断言 |
| I3 | **非回环来源访问 `/api/qq-login/*` 必须 403，且判定只看 `req.socket.remoteAddress`** | 唯一实现点 `src/app.js` 的门 + `isLoopbackAddress` 单测（四个地址）+ 禁止 `x-forwarded-*` 的代码审查 |
| I4 | `qrcodeurl`（二维码内容）永不出现在：JSON 响应、SSE、日志、`/api/config` | 测试抓取所有响应体与注入的 log 收集器，断言不含该值 |
| I5 | 已登录（`isLogin===true`）时，`start`/`refresh` 必须 409，且**不调用** NapCat 的刷新类接口 | stub 调用计数断言（RefreshQRcode 计数 = 0）；`status` 的映射单测 |
| I6 | `start` 幂等：冷却窗口内重复调用不产生新二维码（`issuedAt` 不变，NapCat 调用计数不增） | stub 计数 + `issuedAt` 断言 |
| I7 | `start`/`refresh` 有冷却（≥3000ms）与 in-flight 去重 | 429 断言 + 并发两次调用只发一次 NapCat 请求的断言 |
| I8 | 取消（DELETE session）后 90 秒静默期内不再轮询 NapCat | stub 计数在取消后 5 秒不增长 |
| I9 | 不提供登出/重启/重置设备类接口 | 路由表测试：`DELETE /api/qq-login/logout` → 404 |
| I10 | 控制台在 OneBot 未连接（3002 不监听）时仍能监听 3210 并返回 `/api/status` | `test/startup-console-test.mjs`（T1 的任务）+ 本方案的登出态 UI 测试 |
| I11 | `unreachable` / `failed` / `unknown` 三态互不混用；「读不到」不许落成默认值 | `normalize()` 的穷举单测（每个 phase 一个用例）+ 代码审查禁止 `?? ''` |

---

## 15. 验收判据

### 15.1 A：stub 环境全链路（本机，不碰生产）

**准备**

1. `npm install qrcode`（只在开发机；生产由 `deploy/update.sh` 的依赖步骤安装）。
2. `test/qq-login-test.mjs` 内置 stub WebUI（`http.createServer`，端口随机）：
   - `POST /api/auth/login`：校验 `sha256(TEST_TOKEN + '.napcat') === body.hash`；对 → `{code:0,data:{Credential:'cred-1'}}`；错 → `{code:-1,message:'token is invalid'}`。
   - 其余 `/api/*`：无 `Authorization: Bearer cred-1` → `{code:-1,message:'Unauthorized'}`。
   - `POST /api/QQLogin/CheckLoginStatus`：按脚本变量返回 §8.3 的字段。
   - `POST /api/QQLogin/GetQQLoginQrcode` / `RefreshQRcode`：返回可编程的 `qrcodeurl`，并计数。
   - 控制口：测试代码直接改 stub 的 state 对象（不用额外 HTTP）。
3. AIChat 用 `bootApp({ waitOneBot:false, config:{ server:{port:<free>, token:'test-token-…'}, qqLogin:{webuiUrl:'http://127.0.0.1:<stubPort>', webuiTokenFile:'<tmp>/webui.json'} } })` 起在临时 data 目录。

**必须全绿（每条一个断言）**

| 组 | 断言 |
|---|---|
| 鉴权 | 无 token → 401；错 token → 401；正确 header → 200；`?token=` → 200；旧 `qq-agent-console` marker → 401 |
| 来源 | `Origin: http://evil.example` + 正确 token → 403 |
| 回环 | `isLoopbackAddress` 单测：`127.0.0.1`/`::1`/`::ffff:127.0.0.1` → true；`10.0.0.5`/`::2`/空 → false |
| 未登录 | `CheckLoginStatus` 返回 `waiting_qrcode`+`qrcodeurl` → `status.phase==='qr_waiting'`、`qr.available===true` |
| 取码 | `qrcode.svg` → 200、`content-type: image/svg+xml`、body 以 `<svg` 开头 |
| payload 不泄漏 | 所有 JSON 响应体与 log 收集器不出现 `txz.qq.com`、不出现 token、不出现 `cred-1` |
| start 幂等 | 连调两次 `start`：`GetQQLoginQrcode+RefreshQRcode` 计数 ≤1，`issuedAt` 不变 |
| 已登录 | stub `isLogin:true` → `start` 409；`qrcode.svg` 409；`RefreshQRcode` 计数 = 0 |
| 离线 | stub `isOffline:true,isLogin:false` → `phase==='qq_offline'`（不是 logged_in，也不是 failed） |
| 已扫/初始化/重启 | 对应 phase 映射正确 |
| 过期 | stub `loginError:'二维码已过期'` → `phase==='expired'`；`qrcode.svg` → 410 |
| 失败 | stub `loginError:'登录被风控'` → `phase==='failed'` |
| WebUI 不可达 | 关掉 stub → `status` 200 + `phase==='unreachable'`；`start` → 503 `NAPCAT_WEBUI_UNREACHABLE` |
| WebUI 鉴权失败 | 写错 token 文件 → `start` → 503 `NAPCAT_AUTH_FAILED` |
| 坏响应 | stub 返回 `{code:0,data:{}}` → 502 `NAPCAT_BAD_RESPONSE` |
| 限流 | 两次 `refresh` 间隔 <3000ms → 429 + `retryAfterMs` |
| 取消 | `DELETE session` → 200；随后 5 秒 stub 调用计数不增长 |
| 不提供登出 | `DELETE /api/qq-login/logout` → 404 |
| SSE 不受影响 | 带 token 连 `/api/events` → `event: hello`；不带 → 401 |

**进入 `npm test`**（`package.json` 的 `test` 链末尾追加 `&& node test/qq-login-test.mjs`）。

### 15.2 B：本地浏览器全链路（人工，10 分钟）

1. 起 stub + AIChat（同上配置，端口固定如 33211）。
2. 浏览器开 `http://127.0.0.1:33211/?token=test-token-…`：
   - 页面正常加载（不是 401 白屏）；地址栏的 `?token=` 已被抹掉；DevTools 里 `/api/status` 请求带 `x-console-token`。
3. 控制台显示「QQ 未登录 / 扫码登录」面板；二维码可见（手机相机能识别）。
4. 把 stub 状态推到 `qrcode_scanned` → 面板文案变「已扫码，请在手机上确认」。
5. 推到 `isLogin:true` → 面板关闭、进入控制台；顶栏「OneBot 未连接」保持（stub 没有真 OneBot，这是正确表现）。
6. 点顶栏「QQ 登录」→ 面板重新打开；点「刷新二维码」→ QR 变化（`issuedAt` 变）。
7. 把 stub 停掉 → 面板显示「连不上 NapCat WebUI」。
8. 换一个**不带 token** 的地址打开：出现令牌输入框（不是「启动超时」）。
9. `curl -H 'origin: http://evil.example' -H "x-console-token: test-token-…" http://127.0.0.1:33211/api/qq-login/status` → 403。

### 15.3 C：现网只读验收（部署后，不做任何登出动作）

```bash
T='<生产 token>'
# 1) 已登录短路（最关键）：不碰登录态
curl -s -H "x-console-token: $T" http://127.0.0.1:3210/api/qq-login/status
#    期望 phase="logged_in"、loggedIn=true
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "x-console-token: $T" http://127.0.0.1:3210/api/qq-login/start
#    期望 409
curl -s -o /dev/null -w '%{http_code}\n' -H "x-console-token: $T" http://127.0.0.1:3210/api/qq-login/qrcode.svg
#    期望 409
# 2) 鉴权闭环
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/api/qq-login/status        # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-console-token: qq-agent-console' \
  http://127.0.0.1:3210/api/status                                                          # 401（旧 marker 失效）
curl -s -o /dev/null -w '%{http_code}\n' -H 'origin: http://evil.example' \
  -H "x-console-token: $T" http://127.0.0.1:3210/api/qq-login/status                        # 403
# 3) 不破现有在线态（间隔 30 秒各取一次，两次数值一致）
curl -s -H "x-console-token: $T" http://127.0.0.1:3210/api/status | grep -o '"connected":[a-z]*'
# 4) 无泄漏
journalctl -u aichat --no-pager | grep -c 'txz\.qq\.com'    # 期望 0
journalctl --user -u napcat --no-pager | grep -c 'txz\.qq\.com'  # 期望 0（NapCat 自己不应打印码内容）
# 5) NapCat WebUI 仍正常
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6099/   # 301（重定向到 /webui）
# 6) 控制台页面仍可用（浏览器）：带 ?token= 打开 → 正常进控制台；不带 → 令牌输入框
```

### 15.4 D：首次真实登出时的验证清单（必须打勾，不能提前做）

| # | 观察 | 期望 |
|---|---|---|
| 1 | 打开控制台 | 立即出现「QQ 未登录」面板 + 二维码（**不是** 90 秒转圈，也不是「启动超时」） |
| 2 | 扫码 | 手机 QQ 提示登录；面板在 ≤2 秒内变「已扫码，请在手机上确认」 |
| 3 | 手机确认 | 面板「登录成功，正在启动 QQ…」→ 关闭 → 进控制台 |
| 4 | 登录完成后 | 顶栏 OneBot 变绿；`/api/status` `connected=true`；`ss -ltnp` 看到 3002 |
| 5 | 5 分钟不扫 | 面板出现「二维码已过期，请点刷新」，点刷新能出新的码（`issuedAt` 变） |
| 6 | 日志 | `journalctl -u aichat` 无 `txz.qq.com`、无 token |
| 7 | 异常路径（非生产环境做） | 停掉 napcat 容器 → 面板「连不上 NapCat WebUI」，控制台其它页面仍可打开 |

出现 2/3/5 不符 → 只改 `src/qq-login.js` 的适配层（日志会有 `NAPCAT_BAD_RESPONSE` 与缺失字段名），前端不动。

---

## 16. 实现风险

### R1（最高）NapCat 登出态契约只能从源码推定，首次真实登出才是真验证

- 已从容器内源码核对了字段与流程（§8），但**没在登出态真实调用过**（只读约束下没有发 POST）。
- 最可能踩的两处：
  1. `isLogin` 的定义是「已登录**且在线**」（`napcat.mjs:49456-49457`）。掉线但登录态还在时 `isLogin=false, isOffline=true`——**只判 `isLogin` 会把「已登录但离线」误显示成「未登录」**，然后用户去扫码，而 QQ 其实已经登录。本方案用 `qq_offline` 单独成态规避。
  2. `RefreshQRcode` 会重启 NapCat 登录服务（`reconnecting` 分支），期间 10 秒级不可用；NapCat 自己的 WebUI 有「请不要关闭此页面，最长可能需要 3 分钟」的文案（`qq_login-*.js`）。因此刷新必须是用户显式动作 + 冷却，且前端要显示「正在准备新的二维码」而不是报错。
- 缓解：契约校验 fail-closed（`NAPCAT_BAD_RESPONSE` 带缺失字段名）、`normalize()` 穷举单测、§15.4 清单。

### R2（高）鉴权一开，前端必须**同一次提交**改全，否则控制台白屏

- 已实测：配 token 后，前端现在发的 `x-console-token: qq-agent-console` → 401；`api()` 抛错 → `pollUntilReady` 重试 90 秒 → 用户看到「启动超时」，控制台不可用。
- 更隐蔽的是 SSE：`EventSource` 带不了头，必须 `?token=`；漏改则顶栏状态永不更新（看起来「卡住」，不易排查）。
- 上线顺序（写死）：① 合入全部前端 + 后端改动并跑 §15.1/15.2 → ② 再用 `POST /api/config` 设 `server.token` → ③ 立刻用带 `?token=` 的地址验证 → ④ 失败回滚：`POST /api/config {"server":{"token":""}}`（恢复放行，不需要重启）。
- 回滚窗口内控制台是「无鉴权」状态，尽快处理；这也是为什么 token 不能提前设。

### R3（中高）`/api/qq-login/*` 的凭据面：QR payload 本身就是「能登录机器人」的凭据

- `qrcodeurl` 是 QQ 登录用的扫码内容（`https://txz.qq.com/p?k=…` 形态）。谁能拿到它并抢先扫码，谁就可能登进机器人账号。
- 因此：只经 SVG 输出（不进 JS/JSON/日志）、要求 token + 回环、`no-store`；**不提供**任何「查看 payload 文本」的调试接口；不提供登出接口（防误操作）。
- 附带：WebUI token 本身是弱口令级（12 字符、journal 明文打印过），暴露面仅回环。本方案只读它、不改它；若要收口，应改 `webui.json` 并重启 NapCat 容器（属运维动作，不在本方案内）。

### 其它风险（记录，不展开）

| 风险 | 说明 | 缓解 |
|---|---|---|
| AIChat 与 NapCat 生命周期不同步 | NapCat 重启时 6099 短暂不可用 → `unreachable` | 面板 5 秒重试；不把 `unreachable` 当永久失败 |
| WebUI 登录限流（`loginRate:3`） | 反复重启 AIChat / 401 重登可能触发 | 凭据缓存 50 分钟；401 重登一次；失败退避 60 秒 |
| 端口被占用 | 6099 被别的进程占用 → 连上但响应形状不对 | 契约校验 → 502；运维文档给排查命令 |
| `qrcode` 依赖 | 新增 1 个 npm 依赖（含传递依赖），部署需 `npm install --omit=dev` | `deploy/update.sh` 已有依赖变更检测 + 健康检查回滚；无 postinstall 脚本，`--ignore-scripts` 安全 |
| 隧道 + 子路径挂载 | 经 AccessTrust 以 `/aichat/` 前缀访问 | `consoleUrl()` 已处理；`withConsoleToken()` 在其之后追加，不影响前缀 |
| 多标签页 | 两个标签都开面板 → 两个轮询 | 服务端 `watchers` 仅作展示；轮询本身幂等、NapCat 侧也支持多客户端 |

---

## 17. 附录 A：证据命令与输出摘要（只读）

本机隔离实例（临时 data 目录 + `server.token` 探针值，3001/3002 指不可达端口），验证当前鉴权行为：

```
GET /                                  → 200            （静态放行）
GET /api/status（无 token）             → 401 {"error":"未授权"}
GET /api/status（marker 头）            → 401            ← 前端现状在此断
GET /api/status（正确 header）          → 200
GET /api/status?token=…                → 200
GET /api/events（无 token）             → 401
GET /api/events?token=…                → 200 text/event-stream，event: hello
GET /api/events（header）               → 200
GET /api/status（坏 Origin + 好 token） → 403
```

生产机只读探测：

```
ss -ltnp | grep -E ':(3210|3001|3002|6099)'   → 3210/3001/3002/6099 均只发布在 127.0.0.1
curl -s http://127.0.0.1:3210/api/status      → onebot.connected=true，snowluma.running=false，snowluma.dir=""
curl -s http://127.0.0.1:3210/api/config      → server.keys=[port,autoStart,closeToTray,hasToken]，hasToken=false
curl -s http://127.0.0.1:6099/                → 301 → /webui
curl -s http://127.0.0.1:6099/api/definitely-not-a-route → 200 {"code":-1,"message":"Unauthorized"}
podman inspect napcat --format '{{range .Mounts}}…'       → 仅 ~/napcat/qq、~/napcat/config 两个挂载
podman exec napcat ls /app/napcat/cache                   → qrcode.png（容器内存在，宿主不可见）
python: webui.json token 与 journal "WebUi Token:" 的 sha256 → MATCH（值不记录）
journalctl --user -u napcat：20:11:19 WebUi 起 → 20:11:20 登录尝试 → 20:12:47 OneBot 3001/3002 起
```

## 18. 附录 B：本次未能实测、实现时必须尽快确认的项

| 项 | 现状 | 什么时候能确认 |
|---|---|---|
| WebUI 登出态 `CheckLoginStatus` 的真实返回（`loginPhase` 取值集合、`loginError` 文案） | 按容器内源码实现（§8.3/§8.4） | 首次真实登出（§15.4）或隔离的第二套 NapCat |
| `RefreshQRcode` 的真实耗时与 `restarting` 行为 | 源码可见，未实测 | 同上 |
| 真实二维码 TTL | 未知（前端只做估计倒计时） | 同上 |
| 登出态下 OneBot 3002 是否真不监听（影响 `/api/status.onebot.diagnosis` 文案） | 交接材料与运维文档均如此描述，未在登出态实测 | 同上 |
