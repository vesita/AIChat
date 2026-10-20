# 内置 SnowLuma 假设 vs 容器 NapCat 现场 —— 协议端形态错配勘查（只读）

审计对象：AIChat 里「本应用自己管理协议端」的全部路径（启动 / 自动拉起 / 停止 / 便携 QQ / 版本对齐 / 安装与 `--check` / 控制台展示），对象现场是**宿主上的系统单元 AIChat + 用户级容器 NapCat**。
代码版本：`topic/core-web-opt @ 6b16ffe`（本机检出，与线上 `/opt/aichat/app` 同源）。
审计时间：2026-10-20。

只读纪律：未改 `src/`、`ui/`、`scripts/`、`deploy/`、`test/`、`package.json`，未 commit、未切分支；线上只做只读观测（`/api/status`、`/api/config`、`ss`、静态文件、`journalctl`），未 restart/stop 任何单元、未 `podman rm`、未扫码、未登出。`/api/config` 只提取字段名、长度、布尔、端口（未记录任何令牌值或完整地址）。

证据标注：
- **【实测】** 本次在本机或线上只读观测到的输出。
- **【读码推断】** 由代码路径 + 行号推导，未在线上真实触发（触发它需要做禁止动作，例如停容器 / 点会弹窗的按钮）。

---

## 0. 结论速览

### 直接回答两个担忧

1. **会不会「扫描不到」？会，但影响被高估了。**
   AIChat 根本没有「扫描协议端」这一步：主链路只按 `snowluma.wsUrl` / `snowluma.httpUrl` 直连（`src/app.js:633-639`、`src/onebot.js:85-99`），所以外部 NapCat **连接面完全正常**（实测 `onebot.connected=true`、`self.nickname` 有值，说明 WS 与 HTTP 都通）。所谓「扫描」实际只有两处，且都只认内置 SnowLuma 形态：`snowlumaDir()` 探项目内 `snowluma/` 目录（`src/app.js:135-145`）、`snowlumaWebuiPort()` 探 SnowLuma WebUI 端口（默认 5099，`src/app.js:158-170`）。这两处在容器现场恒为空/false，**只让管理面与展示面「看不见」协议端**，不影响连接与收发。

2. **会不会有隐性 bug？有，且比「扫描不到」危险得多。**
   最危险的不是「看不见」，而是**看不见却照样工作、并且能在没有告警的情况下半通**：`snowluma.httpUrl` 的出厂默认是 `http://127.0.0.1:3000`（`src/config.js:171`、`src/onebot.js:87`），而宿主 3000 是 Forgejo（实测）。HTTP 走 3000 时，WS 仍绿、`/api/status.onebot.connected=true`，但所有查询/发送都失败，`diagnosis` 是空串 —— 机器人收得到消息、回不出去，界面上没有任何红灯。其次是安装脚本没有平台闸：`npm run setup` / `npm run setup:napcat` 在 Linux 上会把 **Windows 协议端**装进生产树并报「✅ 完成」。第三是几个「打开目录」类端点直接 spawn Windows 可执行文件且不接 `error` 事件，在 Linux 上点一下就 **让 AIChat 进程退出**。

### 错配总数

**18 条**（另附 1 条同源但非协议端本身：X1）。分布：

| 组 | 条数 | 内容 |
|---|---|---|
| P 安装/进程管理 | 6 | 自动拉起、启动/停止按钮、便携 QQ、`setup`、`setup:napcat` |
| S 状态/诊断/配置 | 6 | `snowluma.running` 语义、断线诊断、只探 WS、401 恢复、默认端口、版本对齐 |
| U 控制台展示 | 3 | 就绪圆点、SnowLuma 页签、设置页分节 |
| D 文档/验收口径 | 3 | 部署文档端口、单元里硬编码端口、测试套件现场假设 |

### 「会真做错事」清单（重点，5 条）

| # | 条目 | 会做什么错事 | 触发方式 | 证据 |
|---|---|---|---|---|
| 1 | **S5 + S3**：`httpUrl` 漂回默认 3000 / 新部署没配 | 所有出站请求打到 Forgejo，`HTTP 404`；WS 仍绿 ⇒ 机器人**静默不回**，无诊断、无红灯 | 全新部署 / 配置段丢失 / 手工改错端口（界面提示「改完需要重启」但无校验） | 实测（3000 是 gitea；fetch 等价探测 final=404 text/plain）+ 读码 |
| 2 | **P5**：`npm run setup`（UI 明确引导） | 在 Linux 上下载并「成功安装」Windows SnowLuma + 约 650 MB Windows QQ 免安装包；之后控制台进入错误的「内置模式」叙事，启停按钮报假成功 | 照 UI 橙色提示或 README 执行一条命令 | 读码（无平台闸；解压后 `index.mjs`+`node.exe`/`QQ.exe` 齐备即判就绪） |
| 3 | **P6**：`npm run setup:napcat` | 装 `NapCat.Shell.Windows.Node` 到仓库内并报 ✅，在 Linux 上不可运行；与容器方案形成第二套协议端故事 | 手工执行（无文档引用，属孤儿路径） | 读码（`scripts/setup-napcat.mjs:26-36, 113-118, 161-165`） |
| 4 | **X1**：`/api/open-data-dir`、`/api/snowluma/open-folder`（`open-webui` 同理） | 在 Linux 上 `spawn('explorer.exe'/'cmd.exe')` 无 `error` 监听 ⇒ `uncaughtException` ⇒ `process.exit(1)` ⇒ AIChat 重启（会话被 `abortedOnBoot`） | 控制台点「打开数据目录」（**无前置条件**）；`open-folder` 在 `snowluma.dir` 非空后同样会炸 | 读码 + 实测陷阱存在（Linux 无 explorer.exe；`src/server.js:7-10` 记录后退出） |
| 5 | **P1 + P2**（条件）：存在 `snowluma/` 目录时 | 「启动 SnowLuma」报成功但什么都没起；`autoLaunch=true` 时每次启动白等 20 秒（等一个永远不会开的 5099） | P5/P6 跑过之后，或从 Windows 开发机拷来目录 | 读码（`spawn` 错误是异步事件，函数在事件到达前就 `return ok:true`） |

### 3 条最该先修

1. **HTTP 端点的「半通」自检 + 部署口径（S3 + S5）** —— 唯一能让机器人「看着在线、实际不回」的路径，现在完全不可见。最小改：启动/连接后做一次 HTTP 探测（`get_login_info` 或现成的 `get_group_list`），把 `httpOk` 暴露到 `/api/status`；发送失败错误里带上实际 `httpUrl` 的 host:port；`deploy/install.sh`/`deploy/README.md` 写明 `ws=http://127.0.0.1:3001`（WS）与 `http=http://127.0.0.1:3002`（HTTP）。成本 S，收益最大。
2. **安装脚本平台闸（P5 + P6）** —— 一条命令就能把 Windows 协议端装进生产树并报成功，之后的判断全部被它带偏。最小改：`process.platform !== 'win32'` 时 `die('外部协议端模式不需要 setup；协议端见 deploy/napcat.container')`。
3. **外部协议端模式识别 + 展示面收口（S1 + S2 + U1 + U2 同根）** —— 一次判定消掉 4 条误报，并让断线诊断指向正确的排障动作（容器）。不修的话，每次协议端故障都把运维引向一个本地不存在的「SnowLuma 页签」。

### 证据强度

- 现场形态、端口归属、`connected=true`、`snowluma.running=false/dir=''`、3000→Forgejo 的 404、3001 的 426：**多组只读实测，单次采样但相互独立**（`/api/status` + `/api/config` 字段 + `ss` + 直接 POST 探测）。
- 误动作类（P5/P6/X1/P1/P2）与全部展示面：**读码推断**，未在线上触发（触发即改动现场，违反只读约束）。
- 未做：停容器观察诊断、改配置复现 3000 陷阱、点「打开数据目录」。这些的结论都是从代码与等价探测推出来的，标了「读码推断」。

---

## 1. 审计范围与方法

| 对象 | 方法 | 说明 |
|---|---|---|
| 进程管理 | 通读 `src/app.js:130-580`、`1310-1320`、`1488-1700` | `snowlumaDir/wsPort/webuiPort/webuiUrl/stopSnowluma/launchSnowluma`、`qqPortable*`、启动顺序、退出清理 |
| 连接与令牌 | 通读 `src/app.js:628-790`、`src/onebot.js:85-310` | OneBot 客户端构造（ws/http/token）、WS 重连、HTTP `call` 的错误语义、401 候选轮换 |
| 路由/状态面 | 通读 `src/routes.js:86-136`、`240-345`、`442-460` | `/api/status`、`/api/snowluma/*`、`/api/qq-portable/*`、`/api/onebot-token` |
| 安装与版本对齐 | 通读 `scripts/setup.mjs`、`scripts/setup-napcat.mjs`、`scripts/setup-second-instance.mjs` | SnowLuma 下载、`isSnowlumaReady`、`alignClientBuild`、`checkClientBuildMatch`、`--check`、便携 QQ |
| 部署单元/文档 | `deploy/install.sh`、`deploy/aichat.service`、`deploy/napcat.container`、`deploy/napcat.sh`、`deploy/README.md`、`deploy/OPERATIONS.md`、`deploy/TROUBLESHOOTING.md` | 端口口径、启动依赖、协议端形态 |
| 控制台 | `ui/app/03-snowluma.js`、`01-boot.js`、`00-core.js`、`06-settings-render.js`、`08-modals.js`、`07-settings-events.js`、`ui/index.html` | 页签、就绪圆点、断线横幅、设置分节、启动/停止事件 |
| 测试/验收 | `test/startup-console-test.mjs`、`test/coverage-http.mjs`、`test/setup-qq-version.mjs`、`package.json` scripts | 测试对现场的假设 |

线上只读口径（2026-10-20）：`/api/status` 返回 `onebot.connected=true`、`onebot.diagnosis=""`、`self.nickname` 有值；`snowluma.running=false`、`snowluma.dir=""`、`snowluma.webuiUrl=""`、`snowluma.embedded=false`、`qqPortable.ready=false`；`/api/config` 的 `snowluma.dir` 长度 0、`autoLaunch=false`、`wsUrl` 19 字符、`httpUrl` 21 字符、`hasAccessToken=false`、`hasHttpAccessToken=false`（端口分别为 3001 / 3002，只取端口、不记录完整地址）。宿主监听实测：`127.0.0.1:3000=gitea`、`3001/3002/6099=rootlessport`（NapCat 容器）、`3210=node`（AIChat）、5099 未监听。

---

## 2. 错配清单

### P 组：安装与进程管理（会主动做事）

#### P1 自动拉起：外部模式是无意义路径，且失败会「假成功 + 白等 20 秒」【P1｜误动作(条件) + 误报】

- **位置**：`src/app.js:1552-1569`（`autoLaunch` 分支）、`src/app.js:523-561`（`spawn(node.exe, index.mjs)`）、`src/app.js:553-557`（`child.on('error')` 只打日志）。
- **现场后果**：`autoLaunch=false` 时整段是死路径（无害）；一旦有人在设置页勾上（界面不会拒绝），每次启动都会走 `launchSnowluma()` → `snowlumaDir()` 为空 → 直接返回「找不到 SnowLuma 目录」，启动日志多一条误导性报错（无害）。**危险的是条件分支**：若 `snowluma/` 目录存在（例如 P5 跑过），`spawn` 一个 Windows `node.exe` 会异步失败，但函数在 `'error'` 事件到达前已经 `return { ok: true, launched: true, embedded: true, pid }`，于是 `start()` 进入 `for (i<20) 等 5099` 的空转，**启动被拖慢最多 20 秒**，之后才连 OneBot。
- **证据**：【读码推断】`spawn` 的 `error` 是异步事件（Node 语义），函数体里没有等它。
- **最小修复**：`isExternalMode()` 为真时在 `snowlumaReady` 里直接 `return` 并只打一条 debug 日志；`launchSnowluma` 改为等 `'spawn'`/`'error'` 之一再返回结果（或至少用 `child.pid !== undefined` 判定）。
- **验收判据**：外部模式 + `autoLaunch=true` 启动，日志不含「自动启动失败」，`/api/status` 的 `snowluma.embedded` 恒为 false。条件分支：造一个 `snowluma/index.mjs`+假 `node.exe`（内容为空）→ `POST /api/snowluma/launch` 返回 `ok:false`，且 `start()` 不再等 20 秒（用启动耗时对比）。

#### P2 「启动 SnowLuma」按钮在外部模式是死路径【P1｜误报（无害）】

- **位置**：`ui/app/03-snowluma.js:178`（按钮渲染）、`src/routes.js:242-250`、`src/app.js:492-494`。
- **现场后果**：页签里按钮可用（只按「5099 端口开没开」判断 `disabled`），点下去 → `POST /api/snowluma/launch` → 400「找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在…」。不产生副作用，但把运维引向「去找/装 snowluma 目录」。
- **证据**：【实测】`/api/status.snowluma.running=false`、`dir=""` ⇒ 按钮可点；【读码推断】返回 400。
- **最小修复**：外部模式直接不渲染启动/关闭/「打开文件夹」按钮，换成一行「协议端由外部容器提供（NapCat）：`systemctl --user status napcat`」+ 链接到 `deploy/OPERATIONS.md`。
- **验收判据**：外部模式页面 DOM 里不存在 `#sl-start-btn`/`#sl-stop-btn`/`#sl-open-folder-btn`；直接 `curl -X POST /api/snowluma/launch` 返回 409 且 `error` 含「外部」。

#### P3 「关闭 SnowLuma」：Linux 上必然失败，且接口层把失败报成成功【P1｜误报】

- **位置**：`src/app.js:232-278`（无 `snowlumaProc` 时走 `wmic process where name='node.exe'`，Windows-only，见 `248-253`；`process.kill(pid)` 在 `267-269`）、`src/routes.js:257-266`（`const stopped = stopSnowluma();` **未 await**）、`ui/app/03-snowluma.js:332-339`（不看响应，直接写「已请求关闭 SnowLuma。」）。
- **现场后果**：Linux 上 `wmic` 不存在 → `exec` 失败 → 返回 false，**不会杀任何进程**（安全，不会碰容器）。但 `routes.js:260` 把 async 函数返回值（Promise）直接塞进 JSON，序列化成 `stopped:{}`（真值），HTTP 永远 200，UI 永远提示「已请求关闭」。于是「停止协议端」这个动作在实际没做的情况下报了成功。
- **证据**：【读码推断】（`JSON.stringify(Promise) === "{}"`；Linux 无 wmic）。`test/coverage-http.mjs:733` 只断言 `status===200`，覆盖不到这个语义错误。
- **最小修复**：`const stopped = await stopSnowluma();` 并返回 `{ ok:true, stopped:false, reason:'external' }`；外部模式直接 409「本应用不管理外部协议端」。
- **验收判据**：`curl -s -X POST /api/snowluma/stop | jq -e '.stopped==false and .reason=="external"'` 退出码 0；响应体里 `stopped` 是布尔不是对象；点一次按钮后 `podman ps` 与 `systemctl --user is-active napcat` 均无变化。

#### P4 便携 QQ 启停在 Linux 全是死路径，但 UI 用错误话术引导【P1｜死路径 + 误报】

- **位置**：`src/app.js:334-335`（`listQqProcesses` 非 win32 直接 `return []`）、`src/app.js:388-391`（未装 → 「请先运行 npm run setup」）、`src/app.js:448-453`（未在运行）；`ui/app/03-snowluma.js:134-135`（「QQ 内核：未安装」+ 橙色「请先运行 npm run setup」）、`141-147`（启动/关闭按钮）。
- **现场后果**：Linux 上永远不会误杀外部 QQ（平台闸守住了，**这点是安全的**）；但控制台把「容器里的 QQ 在跑」显示成「QQ 内核：未安装」，并给出**会做错事的引导** `npm run setup`（见 P5）。
- **证据**：【实测】`/api/status.qqPortable.ready=false`；【读码推断】平台闸。
- **最小修复**：外部模式下这块整块替换为「QQ 内核：外部容器（NapCat）」，删掉 setup 引导。
- **验收判据**：外部模式 `/api/status.qqPortable.ready` 仍为 false，但页面文本不含 `npm run setup`；`POST /api/qq-portable/launch` 返回 409。

#### P5 `npm run setup` 在 Linux 上会装 Windows 协议端并报成功【P0｜误动作（人触发）】

- **位置**：`scripts/setup.mjs:182-186`（就绪 = `index.mjs` + `node.exe` 存在）、`188-278`（下载并解压 SnowLuma win-x64 zip）、`303-347`（就地改写 `snowluma/index.mjs`）、`455-520`（下载约 650 MB 的 QQ 免安装包并解压约 1.5 GB）、`package.json:52`；引导入口：`ui/app/03-snowluma.js:122,135`、`README.md:99-103`。
- **现场后果**：全流程**没有 `process.platform` 闸**（唯一的平台判断在 `172` 行，只是 unzip 退路）。在 Linux 上 `unzip` 能解 Windows zip，`node.exe`/`QQ.exe` 也在包里，于是 `isSnowlumaReady()`/`isQqPortableReady()` 都返回 true → 脚本以「✅ Setup 完成」结束。后果：约 2 GB Windows 二进制落进生产检出（`snowluma/`、`runtime/` 均被 `.gitignore` 忽略，所以 `update.sh` 的干净检查不会拦住）；随后控制台进入错误的「内置模式」叙事（P1/P2/X1 全部随之变成活路径）。`setup:mjs --check` 也因此开始报「就绪」（S6）。
- **证据**：【读码推断】（未执行，执行即改动生产树）。
- **最小修复**：脚本开头加平台闸：非 `win32` → `die('AIChat 在 Linux 上以外部协议端模式运行，不需要 setup；协议端见 deploy/napcat.container')`；UI 与 README 同步按平台给文案（或用 `/api/status.protocol.mode` 决定）。
- **验收判据**：Linux 上 `timeout 60 npm run setup; echo $?` ≠ 0，输出含「外部」且 60 秒内结束；`git status --porcelain` 与执行前一致；`ls /opt/aichat/app/snowluma` 仍不存在。

#### P6 `npm run setup:napcat` 是第二套协议端故事（Windows Shell 包）【P1｜误动作（人触发）+ 重复实现】

- **位置**：`scripts/setup-napcat.mjs:26-36`（资产固定为 `NapCat.Shell.Windows.Node.zip`）、`46-48`（就绪判定只看 `wrapper.node` + `napcat.mjs`）、`113-118`（Linux 走 `unzip`）、`161-165`（「✅ NapCat 安装完成」）；入口 `package.json:54`。
- **现场后果**：该脚本在 Linux 上能「装成功」，产出的 `napcat/shell/index.js` 需要 Windows QQ 内核，Linux 上不可用；同时它与 `deploy/napcat.container`（生产实际使用的 quadlet 容器）是**两套互不引用、口径不同**的 NapCat 方案。仓库里没有任何 README/文档指向 `setup:napcat`（实测 grep：仅脚本自身与 `package.json` 提到），属于孤儿路径，但 `npm run setup:napcat` 这个名字足够让人以为「这是标准装法」。
- **证据**：【读码推断】。
- **最小修复**：二选一 —— 删除该脚本与 script 条目，或加平台闸并在 Linux 下打印 `deploy/napcat.container` 的安装命令。仓库内只保留**一套**协议端安装口径（推荐容器，因为生产就是它）。
- **验收判据**：`grep -rn "setup:napcat" --include=*.md --include=*.json .` 只剩一处或零处；Linux 上执行该命令退出码 ≠ 0 且指向 `deploy/`。

### S 组：状态、诊断与配置语义

#### S1 `snowluma.running` 绑死在 SnowLuma WebUI 端口（默认 5099），外部模式恒 false【P1｜误报根因】

- **位置**：`src/app.js:156-170`（`snowlumaWebuiPort` 读 `snowluma/config/runtime.json`，读不到就 5099）、`src/routes.js:95-103`（`/api/status` 用它判 `slRunning`）、`src/routes.js:120-125`（写进 `snowluma.running`）。
- **现场后果**：容器现场 5099 未监听（实测）⇒ `snowluma.running=false` 恒定。它同时驱动：断线诊断话术（S2）、UI 红灯（U1）、启停按钮可用性（P2/P3）、`/api/status` 的 `snowluma` 块语义。任何外部消费者（监控、运维脚本、未来的自愈逻辑）拿这个字段都会得出「协议端没运行」的错误结论 —— 而实际上 OneBot 连着、机器人正在工作。
- **证据**：【实测】5099 未监听 + `snowluma.running=false` + `onebot.connected=true` 同时成立。
- **最小修复**：新增 `protocol: { mode, wsReachable, httpOk, endpoint }` 作为协议端健康口径；外部模式下 `snowluma` 块保留但明确标 `managedBy:'external'`，`running` 置 null（而不是 false），避免被当成「挂掉」。
- **验收判据**：容器运行时 `curl -s /api/status | jq -e '.protocol.mode=="external" and .protocol.wsReachable==true and .protocol.httpOk==true'` 退出码 0；`snowluma.running` 不再是布尔 false（或带 `managedBy` 字段，见 U1 验收）。

#### S2 断线诊断把原因归给「SnowLuma 未运行 / 到 SnowLuma 页签启动」【P0｜误报（排障方向错误）】

- **位置**：`src/routes.js:104-111`（`if (!slRunning) diagnosis='SnowLuma 未运行：请到 SnowLuma 页签启动'`）、`ui/app/00-core.js:675`（loading 文案）、`723`（就绪体检项）、`738`（横幅「OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动…」）、`ui/index.html:66`（「正在启动 SnowLuma 与 OneBot 服务」）。
- **现场后果**：容器现场 OneBot 一断（容器没起 / QQ 掉线 / 未登录），AIChat 给出的第一指引是「到 SnowLuma 页签启动」—— 而本地没有 SnowLuma、点按钮只会得到 400（P2）。真正的动作是 `systemctl --user start napcat.service` / 重新扫码。等于**故障时把运维引到一条必定失败的路上**，且把「容器没起」与「SnowLuma 没装」混为一谈。
- **证据**：【实测】`slRunning=false` 与 `connected=true` 同时成立说明该分支只看 5099、不看真实协议端；【读码推断】断线时命中第一条分支。
- **最小修复**：外部模式的诊断话术改为协议端形态相关（「NapCat 容器未运行或未登录：`systemctl --user status napcat.service`」），并把 `/api/status.protocol.mode` 一起返回给 UI 决定文案。
- **验收判据**（需一次授权停容器）：停容器后 `curl -s /api/status | jq -r '.onebot.diagnosis'` 含 `napcat` 且不含「SnowLuma 页签」；起容器后诊断回空串。不授权停容器时用假 HTTP/WS 桩做单测。

#### S3 只探 WS、不验证 HTTP：连接「半通」完全不可观测【P0｜隐性 bug（真故障路径）】

- **位置**：`src/routes.js:100-111`（`Promise.all([探 5099, 探 WS 端口])`；`diagnosis` 只在 `!onebot.connected` 时生成）、`src/onebot.js:286-302`（HTTP 失败才抛，且 404 无提示；只有 426 有「可能指向了 WS 端口」提示）。
- **现场后果**：`onebot.connected` 只看 WS（`src/onebot.js:201-205`）。WS 走 `wsUrl`、HTTP 走 `httpUrl`，两者**在配置里是独立字段、代码里没有任何一致性校验**。于是「WS 通 + HTTP 错」这种半通形态：状态页绿、`diagnosis` 空、`get_login_info` 失败只是 `console.error`（昵称显示不出来），所有发送/查询抛 `OneBot <action> HTTP 404`。运维看到的是「已连接」但机器人不回话。
- **证据**：【实测】3000（Forgejo）对 OneBot 风格 POST 的响应：`303 → GET /forgejo/user/login → 404 text/plain`；用本仓 `OneBotClient.call` 指向 3000 得到 `OneBot get_login_info HTTP 404`（本机经 SSH 隧道对同一 Forgejo 实例实测）；`httpUrl=http://127.0.0.1:3000` 正是出厂默认（`src/config.js:171`、`src/onebot.js:87`）。
- **最小修复**：连接后（或每分钟）用一次 HTTP `get_login_info`/`get_version_info` 作为数据面探针，`/api/status` 暴露 `onebot.httpOk` + `onebot.httpError`；`diagnosis` 增加「WS 已连但 HTTP 不可用：检查 `snowluma.httpUrl`」；发送失败的错误消息里带上实际 URL 的 host:port（现在是 `HTTP 404` 裸状态码）。
- **验收判据**：把 `httpUrl` 指向一个返回 404 的本地桩（不碰生产），`curl -s /api/status | jq -e '.onebot.connected==true and .onebot.httpOk==false'` 退出码 0，且日志/会话错误里出现该桩的 `host:port`；恢复 3002 后 `httpOk==true`。

#### S4 401 自动恢复在外部模式没有候选令牌，但诊断仍说「正在自动轮换重试」【P1｜误报 + 恢复缺口】

- **位置**：`src/app.js:684-718`（`readSnowlumaTokenCandidates`：`snowlumaDir()` 为空立即 `return out`，**不会**补空令牌候选；空令牌兜底在 `712-713` 之后才 push）、`733-751`（`syncSnowlumaTokens`）、`753-774`（`maybeRecoverOnebot`：`if (!candidates.length) return`）、`775-787`（只在 `status.error` 含 401 时触发）、`src/routes.js:109`（诊断文案「正在自动轮换重试」）。
- **现场后果**：外部模式下候选集为空 ⇒ 401 时 `maybeRecoverOnebot` 直接 return，**一轮都不轮换**；但诊断文案固定说「正在自动轮换重试」，用户会一直等一个不会发生的动作。触发条件现实存在：NapCat 侧改了令牌 / 配置里残留了旧令牌 / 手滑填错。
- **证据**：【读码推断】（`dir===""` 时 `return out` 在 push 空候选之前）。
- **最小修复**：候选集与「内置目录」解耦 —— 外部模式候选 = `[配置里的令牌, 空令牌]`；无法轮换时诊断改成「访问令牌不匹配：请核对设置里的 OneBot 令牌」。
- **验收判据**：外部模式 + 故意错令牌（人工授权），日志出现一次「无可轮换候选」类明确行、诊断不含「自动轮换」；改对后 30 秒内重连成功。

#### S5 默认端口与现场形态错配，且部署文档不给 HTTP 地址【P0｜真故障路径（配置陷阱）】

- **位置**：`src/config.js:164-174`（`wsUrl: ws://127.0.0.1:3001`、`httpUrl: http://127.0.0.1:3000`，第二实例 +portOffset）、`src/onebot.js:86-90`（同样的默认值兜底）；`deploy/README.md:23`（只写「NapCat 已在 127.0.0.1:3001 提供 OneBot」）、`deploy/README.md:31-32`（「部署后控制台是空的配置，需要填模型/白名单/响应档位」——**没提 WebSocket/HTTP 地址**）、`deploy/install.sh:8`（注释同样只提 3001）。
- **现场后果**：现场是 `ws=3001`（NapCat 的 WS 监听）、`http=3002`（NapCat 的 HTTP API）；出厂默认恰好是 `ws=3001`（蒙对）+ `http=3000`（**Forgejo**）。所以**全新部署 / 配置段丢失 / 照默认走**会得到「WS 能连、HTTP 554 到 Forgejo」的半通形态（S3），而且部署文档完全没让人填过这个字段。这是本次审计里最可能在生产真实发生的一条。
- **证据**：【实测】`/api/config` 的 `httpUrl` 端口 3002（生产被显式改成 3002）、默认值 3000（代码）、3000 监听者是 gitea（`ss`）、Forgejo 对 OneBot POST 返回 404（等价探测）。生产当前**没有**踩中（端口 3002 是显式配置的）。
- **最小修复**：`deploy/install.sh` 在首次部署时显式 `POST /api/config` 写入 `snowluma.wsUrl=http://127.0.0.1:3001`(ws) 与 `httpUrl=http://127.0.0.1:3002`，或在 `deploy/README.md`「首次部署」里写清两个字段与 3001/3002 的分工；同时加一条启动自检：`httpUrl` 端口等于 3000 时打 warn「httpUrl 仍是出厂默认，可能是 Forgejo 而不是 OneBot HTTP」。
- **验收判据**：删掉 `snowluma` 段（或用一个空 data dir）启动，日志出现上述 warn；按文档配好 3001/3002 后 `/api/status` 的 `onebot.httpOk`（S3 新增）为 true、昵称有值；`deploy/README.md` 里 grep 得到 3002。

#### S6 CLIENT_BUILD 版本对齐 / `setup:check` 在外部模式是误报【P2｜误报】

- **位置**：`scripts/setup.mjs:893-901`（`--check`：`SnowLuma: ❌ 缺失`，`if (cb)` 才打印 CLIENT_BUILD，最后 `process.exit(1)`）、`303-347`（`alignClientBuild` 只改 SnowLuma 的 `index.mjs`）、`381-419`（版本比对只对内置 SnowLuma）。测试侧：`test/setup-qq-version.mjs:109-135`。
- **现场后果**：外部模式下 `npm run setup:check` 永远退出 1 并报「SnowLuma ❌ 缺失 / 便携 QQ ❌ 缺失」，让任何「部署完成了吗」类检查误判为失败。**注意：任务背景里「`npm test` 84 过 1 挂」的那 1 挂在本审计期间已被并发改动修复**（该测试现在按「装了才断言 CLIENT_BUILD，没装则断言明确报缺失」二分），本次实测 `node test/setup-qq-version.mjs` = 85 通过 0 失败；但**脚本层**的误报仍在（只是不再让测试链断掉）。
- **证据**：【实测】本机 `node scripts/setup.mjs --check` → `[setup] SnowLuma: ❌ 缺失`、`[setup] 便携 QQ: ❌ 缺失`、exit=1；`node test/setup-qq-version.mjs` → 85/0。
- **最小修复**：`--check` 在外部模式输出 `协议端：外部（跳过 SnowLuma/便携QQ 检查）` 并 exit 0；CLIENT_BUILD 对齐在没有内置协议端时静默跳过（现状已是「找不到文件就跳过」，只是退出码说谎）。
- **验收判据**：外部模式 `npm run setup:check; echo $?` → 0，输出不含「❌ 缺失」；嵌入模式（有 `snowluma/`）行为不变。

### U 组：控制台展示面（线上用户会看到什么）

#### U1 顶栏 4 个就绪圆点里 2 个在容器现场永远红【P1｜误报】

- **位置**：`ui/index.html:49-54`（圆点定义：QQ 内核 / SnowLuma / OneBot / 配置）、`ui/app/01-boot.js:35-62`（`qqRunning=s.qqPortable.running`、`slRunning=s.snowluma.running`；`dots[0]`/`dots[1]` 恒 off，tooltip「未运行（点击前往启动）」，点击跳 `snowluma` 页签）。
- **现场后果**：实测状态为「QQ 内核 false / SnowLuma false / OneBot true / 配置 true」⇒ 界面顶部永久 2/4 红、2/4 绿。用户第一眼看到的是「有两项没跑」，点进去得到的又是 P2 的失败提示。这是「扫描不到」在用户侧最直观的表现。
- **证据**：【实测】`/api/status` 各字段如上；【读码推断】映射关系。
- **最小修复**：外部模式把圆点改成 3 个（协议端连通 / OneBot / 配置），或给前两个换语义（「协议端（外部容器）」「WS 可达」）。判定来源用 S1 新增的 `protocol.mode`。
- **验收判据**：外部模式下 `document.querySelectorAll('#readiness-dots .rdot').length === 3`（或前两个 class 含 `on`/`na`）；页面无「未运行（点击前往启动）」tooltip。

#### U2 「SnowLuma」页签整页叙事与现场相反【P1｜误报】

- **位置**：`ui/app/03-snowluma.js:109`（标题「SnowLuma（OneBot 网关）」）、`159`（「SnowLuma：未运行」）、`169`（「目录：（未找到项目内 snowluma/ 文件夹）」）、`175`（「等待 SnowLuma 启动后自动识别…」）、`178-179`（启动/关闭按钮）、`109-127`（`!onebotConnected` 时的快速启动卡）。
- **现场后果**：用户会看到：OneBot 已连接（正确的绿点）、但「SnowLuma 未运行」「未找到 snowluma 文件夹」「QQ 内核未安装，请先运行 npm run setup」。四句里三句是误报，最后一句是把人往 P5 引。页签是排障入口，却提供相反的结论。
- **证据**：【实测】`/api/status` 字段 + 【读码推断】渲染分支。
- **最小修复**：页签按 `protocol.mode` 分流：`external` 下只显示「协议端：外部容器（NapCat）」「OneBot：已连接（昵称）」「最近一次 HTTP 探测结果」，并给出容器排障命令；`embedded` 下保持现状。
- **验收判据**：外部模式打开页签，DOM 不含「npm run setup」「未找到项目内 snowluma/ 文件夹」「SnowLuma：未运行」；含「外部」「napcat」。

#### U3 设置页的「OneBot（SnowLuma）」分节在外部模式是噪声（但不会误写）【P2｜无害/噪声，需注意一处例外】

- **位置**：`ui/app/06-settings-render.js:1121-1145`（分节标题、SnowLuma 目录、自动拉起复选框、WS/HTTP 地址、令牌）、`ui/app/08-modals.js:1479-1487`（保存时组装 `patch.snowluma`）、`ui/app/07-settings-events.js:963-967`（「打开文件夹」按钮先 `saveConfig` 再调 `/api/snowluma/open-folder`）。
- **现场后果**：WS/HTTP 地址是**唯一真正需要**的配置项（改完需重启，代码侧明确）；目录 / 自动拉起 / 「打开文件夹」是 SnowLuma 专属，在外部模式属噪声。**不会**把地址冲回默认值：`saveConfig` 的取值有 fallback（`val('#cfg-wsurl', c.snowluma?.wsUrl || '')`），字段缺失时写回现值。唯一的动作风险是「打开文件夹」（X1）。
- **证据**：【读码推断】`saveConfig` fallback 链。
- **最小修复**：外部模式只渲染 WS/HTTP 地址 + 令牌，其余字段折叠到「高级（内置模式）」。
- **验收判据**：外部模式设置页可见输入框仅 `#cfg-wsurl`/`#cfg-httpurl`/两个令牌；改动其他区块保存后 `/api/config` 的 `snowluma.wsUrl`/`httpUrl` 端口不变（3001/3002）。

### D 组：文档与验收口径

#### D1 部署文档说 OneBot 在 3001，实际 HTTP API 在 3002【P1｜误报口径】

- **位置**：`deploy/install.sh:8`（「NapCat 已在跑（OneBot 在 127.0.0.1:3001）」）、`deploy/README.md:23`（同）。
- **现场后果**：3001 是 **WS** 端口：实测 `POST http://127.0.0.1:3001/get_login_info` → `426 Upgrade Required`（text/plain）；HTTP API 在 3002（`POST` → `200 application/json`）。照文档去 3001 验收的人会得到 426，可能误判「协议端坏了」或（更糟）把 `httpUrl` 配成 3001，然后每条发送都收到「HTTP 426（可能指向了 WS 端口）」。
- **证据**：【实测】两端口探测结果。
- **最小修复**：改成「NapCat 在 127.0.0.1:3001 提供 WS、3002 提供 HTTP API（AIChat 两个都要配）」。
- **验收判据**：`grep -n "3001" deploy/install.sh deploy/README.md` 每处都同时出现 3002 与「WS/HTTP」区分。

#### D2 `aichat.service` 硬编码 3002，与配置里的 `snowluma.httpUrl` 是两处口径【P2｜无害/漂移风险】

- **位置**：`deploy/aichat.service:36`（`ExecStartPre` 里 `curl http://127.0.0.1:3002/get_login_info`，失败也 `exit 0`）。
- **现场后果**：该探测只打印 WARN、不阻塞启动，所以端口漂移时不会做错事；但「协议端端口」这个概念在配置（`snowluma.httpUrl`）与单元文件里各写一遍，改一处忘一处时排障信息会说谎。
- **证据**：【读码推断】。
- **最小修复**：注释里标注「端口必须与 `snowluma.httpUrl` 一致」，或改为读 `/var/lib/aichat/data/config.json`（避免解析复杂度也可保留硬编码，但写清依赖关系）。
- **验收判据**：改 `httpUrl` 到 3003 后，`systemctl status aichat` 的 `ExecStartPre` WARN 文案与配置不一致能被一眼看出（现有 WARN 已含「OneBot 未就绪」，补一句实际探测端口即可）。

#### D3 测试套件假设「3002 必须不监听」，在容器现场必然失败【P2｜误报/覆盖缺口】

- **位置**：`test/startup-console-test.mjs:240-245`（前置：`3002` 不监听，否则直接 fail「请停掉 NapCat/QQ 后重跑」）；`test/coverage-http.mjs:1084-1090`（`SKIP` 掉 `open-data-dir`、`snowluma/open-folder`、`open-webui`，注释「会在用户桌面弹窗口 / 可能影响用户真实进程」——即这三个 Windows 专属端点**从未在 Linux 上被验证**，也正是 X1 那类崩溃的藏身处）。
- **现场后果**：在部署机上跑 `npm test`，`startup-console-test` 必挂（容器一直在跑）；而三个最危险的 Windows 专属端点被测试显式跳过。前者是「误报」，后者是「覆盖缺口」——两者叠加会让人得出「测试都过了，协议端肯定没问题」。
- **证据**：【读码推断】+ 现场 3002 常开（实测）。
- **最小修复**：外部模式下让 `startup-console-test` 跳过「登出态」子用例（或改用临时端口/桩），把「3002 关闭」从前提改为分支；三个 SKIP 端点在非 win32 下改为断言「不崩溃且返回 501/409」。
- **验收判据**：容器运行中执行 `node test/startup-console-test.mjs` 退出码 0（或明确 skip 计数）；`node test/coverage-http.mjs` 覆盖到三个端点，Linux 上返回非 500 且进程存活。

---

## 附 X1（同源类，非协议端本身）：spawn Windows 可执行文件无 `error` 监听 → 点一下 AIChat 就退出

- **位置**：`src/routes.js:139-147`（`/api/open-data-dir` → `spawn('explorer.exe', [DATA_DIR], …).unref()`）、`src/routes.js:267-275`（`/api/snowluma/open-folder`）、`277-283`（`/api/snowluma/open-webui` → `spawn('cmd.exe', […])`）；`src/server.js:7-10`（`uncaughtException` → `console.error` + `process.exit(1)`，注释明确「记录后退出，交给外层重启」）。
- **现场后果**：Linux 上这些可执行文件不存在，`spawn` 异步发 `'error'`，调用方没有监听（`try/catch` 抓不到异步事件）⇒ `uncaughtException` ⇒ 进程退出 ⇒ `Restart=always`（`deploy/aichat.service:52`）5 秒后重启，期间在途会话按 `abortedOnBoot` 收尾。「打开数据目录」按钮在设置页（`ui/app/07-settings-events.js:971-977`），无需任何前置条件即可触发。`open-folder` 现在被 `snowlumaWebuiUrl()/snowlumaDir()` 返回空挡住（400），但在 `snowluma.dir` 非空（P5/P6 之后）时会走到同一个 `spawn`；`open-webui` 同理，等哪天 `snowluma/config/runtime.json` 被写出来（P5 之后）就会被解锁。
- **证据**：【读码推断】（未点击，点击即重启生产进程）。
- **最小修复**：按 `process.platform` 分支（Linux 用 `xdg-open`，或直接返回 501「此平台的打开动作需要桌面会话」）；即便保留也要挂 `child.on('error')`。
- **验收判据**：Linux 上 `curl -s -o /dev/null -w '%{http_code}' -X POST /api/open-data-dir` 返回 200/501（非 500），且随后 `systemctl is-active aichat` 仍为 active、`journalctl -u aichat` 无新增 `[未捕获异常]`。

---

## 3. 「外部协议端模式」的最小判定方案

### 判定条件（不需要新配置，全部用现有字段）

令：
- `dir = snowlumaDir()`（`src/app.js:135-145`，空串 = 没有内置 SnowLuma 目录）
- `wsPort = snowlumaWsPort()`、`httpPort = new URL(httpUrl).port`（校验可解析）
- `wsOpen = isPortOpen('127.0.0.1', wsPort)`（已有函数 `src/app.js:194-204`）
- `httpOk = 一次 HTTP 探测（get_login_info 200 且 status=ok）`

**外部模式 ⇔ `dir === ''` ∧ `snowluma.autoLaunch === false` ∧ `wsPort`、`httpPort` 可解析 ∧ `httpPort !== 5099` ∧ (wsOpen ∨ onebot.connected) ∧ httpOk。**

补充两条纠偏，避免把「没装 SnowLuma 的 Windows 用户」误判成外部模式：
- `httpPort === 3000`（出厂默认 / Forgejo）时不判外部，而是判「协议端未配置」（正好可以给 S5 的 warn）。
- 保留显式覆盖 `snowluma.mode: 'auto' | 'embedded' | 'external'`（默认 `auto`），部署方可以钉死，启发了也不至于误判。

### 判定后各面的预期变化

| 面 | 现在（外部现场） | 判定后 |
|---|---|---|
| `/api/status` | `snowluma.running=false/dir=''`，无协议端健康字段 | 新增 `protocol:{mode:'external',wsReachable,httpOk,endpoint}`；`snowluma.running` 置 null + `managedBy:'external'` |
| 断线诊断 | 「SnowLuma 未运行：请到 SnowLuma 页签启动」 | 「NapCat 容器未运行/未登录：`systemctl --user status napcat.service`」；HTTP 坏时「检查 `snowluma.httpUrl`」 |
| 顶栏圆点 | 2/4 恒红 | 3 个点（协议端连通/OneBot/配置），无「点击前往启动」 |
| SnowLuma 页签 | 「未运行 / 未找到目录 / npm run setup」 | 外部协议端卡片 + 只读容器状态与排障命令；无启动/停止/打开文件夹按钮 |
| `/api/snowluma/{launch,stop,open-*}` | 400 / 假成功 / 可能炸进程 | 一律 409 `{ok:false,error:'external protocol side'}` |
| `npm run setup` / `setup:check` | 会装 Windows 协议端 / 恒 exit 1 | 平台闸 die / 输出「外部模式，跳过」exit 0 |
| 设置页 | SnowLuma 目录/自动拉起/打开文件夹 | 只留 WS/HTTP 地址与令牌 |

### 最小改动顺序（建议）

1. `src/app.js` 里加 `protocolMode()`（纯函数，输入 dir/autoLaunch/urls/探测结果）+ `httpProbe()`；`/api/status` 加 `protocol` 块（`src/routes.js:112-135`）。
2. `src/routes.js:104-111` 诊断按 mode 分流；`/api/snowluma/*` 外部模式 409。
3. `ui/app/01-boot.js:35-62` 圆点与 `ui/app/03-snowluma.js` 页签按 `protocol.mode` 分流。
4. `scripts/setup.mjs`、`scripts/setup-napcat.mjs` 平台闸；`deploy/install.sh` 首次部署写死 3001/3002。
5. （可选）`src/routes.js:139-283` 三个 open-* 端点加平台分支与 `error` 监听（X1）。

---

## 4. 端口坑专项：`snowluma.httpUrl` 漂回默认 3000 会发生什么

**结论：会「半通」——WS 正常连、HTTP 全部打到 Forgejo，机器人静默不回，且界面上看不出来。**（生产当前未踩中：`httpUrl` 已显式配成 3002。）

链路推演（`httpUrl=http://127.0.0.1:3000`）：

1. `OneBotClient` 用 `wsUrl`（3001）连 WS → `open` → `connected=true`、状态广播绿。
2. `open` 里立刻 `this.call('get_login_info')` → 走 `httpUrl` 3000（`src/onebot.js:286-302`）→ Forgejo 对 `POST /get_login_info` 先 `303`，fetch 默认跟随到 `/forgejo/user/login`，最终 **404 text/plain**（实测）→ `res.ok=false` → 抛 `OneBot get_login_info HTTP 404`（**没有** 426 那种「地址可能配错」的提示，只有裸状态码）。
3. 后果：`selfInfo=null` ⇒ `/api/status.self=null`、UI 显示「已连接（无昵称）」；15 秒补拉与 45 秒终检同样失败。
4. 任何发送/查询都走 3000 ⇒ `OneBot send_group_msg HTTP 404`；WS 仍绿、`diagnosis` 仍空串 ⇒ 没有红灯、没有告警。
5. 能看出来吗？**只有翻日志**能看到 `[onebot] 获取登录信息失败: OneBot get_login_info HTTP 404`，控制台上没有任何提示；`/api/status.onebot.connected=true` 会持续骗过监控。

最坏形态是 3000 那侧不是 404 而是 200 HTML（例如某天 Forgejo 改成不重定向、或换成别的服务）：`res.json()` 失败后走 `catch(() => ({}))`，`body.retcode === undefined`，错误变成更难懂的 `OneBot get_login_info 失败: retcode=undefined`。现在 **没有任何代码**校验 `wsUrl` 与 `httpUrl` 是否是同一协议端、也没校验 `httpUrl` 端口是否还在出厂默认。

**修法见 S3 + S5**：HTTP 数据面探针 + 发送错误带 URL + 端口默认值告警 + 部署文档写死 3001/3002。

---

## 5. 修复优先级与批次

| 批次 | 条目 | 理由 |
|---|---|---|
| 第 1 批（半天内） | S3、S5、X1、P5、P6 | 会真做错事 / 会让机器人静默失效；全是小改动（探针、平台闸、URL 拼接、error 监听） |
| 第 2 批（半天） | S1、S2、U1、U2、P2、P3 | 外部模式识别 + 展示面收口 + 启停 409/await；一次判定消 4 条误报 |
| 第 3 批（可选） | P1、P4、S4、S6、U3、D1、D2、D3 | 条件路径、恢复缺口、文档与测试口径 |

修复时注意：本仓库其它会话正在改 `src/onebot.js`、`src/orchestrator.js`、`src/sender.js`、`deploy/aichat.service`、`package.json`、`test/*`（见协作占用），动这些文件前先确认写域。本报告所有条目本身**不需要**改这些文件也能落地（S3 的探针放 `src/app.js`/`src/routes.js`，平台闸在 `scripts/`，展示面在 `ui/`）。

---

## 6. 未覆盖 / 无法实测（诚实边界）

- 未停容器验证诊断文案（禁止动作）；S2 的验收判据因此给了「授权后停容器」与「假桩单测」两条路。
- 未修改配置复现 3000 陷阱；用同源 Forgejo 实例 + 本仓 `OneBotClient` 做了等价探测（404 文本与代码路径一致），但没有在生产配置上真实触发。
- 未点击 `open-data-dir` / `open-folder`（点击即重启生产进程）；X1 为读码推断。
- 未执行 `npm run setup` / `npm run setup:napcat`（会改动生产检出）；P5/P6 为读码推断。
- 未运行全量 `npm test`（并发会话占用端口/写域；且 `startup-console-test` 在当前现场必挂）；只单跑了 `test/setup-qq-version.mjs`（85/0）与本地 `setup.mjs --check`（exit 1）。
