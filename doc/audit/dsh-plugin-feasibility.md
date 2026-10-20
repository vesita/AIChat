# AIChat 改造成 dsh 插件的可行性与代价（含「接管核心提示词」评估）

审计日期：2026-10-20。对象：`AIChat`（`topic/core-web-opt` 工作区）与 dsh `0.2.1-rc.2`（`/usr/lib/node_modules/@deepseek-ai/dsh/` 及其 `node_modules/@deepseek-ai/*` 共 305 个目录（含 cordis 等基础设施包）；`dsh --version` = 0.2.1-rc.2）。
只读纪律：本报告是唯一写入文件；未改代码/配置、未 commit、未碰 VPS。证据里 `dsh-*` 路径均相对 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`。
证据标注：**【码】** = 读源码/README 定位；**【实测命令】** = 本机命令输出；**【推测】**= 未实测推断。行号以本版本安装产物为准。

---

## 0. 结论速览

**技术可行，但推荐 B（QQ 通道 + 记忆/画像插件，agent loop 交给 dsh，提示词只叠加不接管）；不推荐 C。**

- dsh 的插件面覆盖工具、系统提示段、运行时上下文、用户消息注入、agent 生命周期/事件、会话、技能、UI、后台服务；本工作区已有多份自研插件先例可复用打法。
- **「接管一大部分核心提示词」技术上可行且有官方支持路径**（`dsh-persona` 的 `complete:true`，配 agent preset 只作用于一个会话），但它不是"打补丁"：complete 模式会**丢弃全部第一方指导**，等于把工具协议/技能/审批/计划/团队等语义重建一遍；dsh 处于 rc 期、本地实测 68 天发 36 个版本（0.2.1 在 14 天内 7 个版本）。这笔债不是"重写一次"，是"每次升级都重验一遍"。
- **最大缺口是"外部消息源"**：305 个包里没有任何 IM/QQ/OneBot 包；dsh 的入口形态是 web/headless/sdk/acp（面向人或程序驱动），不是 IM。但 `ctx.agents.create()` + Agent API 足以让插件自己当通道；AIChat 的 OneBot/NapCat 登录/限频/白名单/记忆画像正是真正的资产。
- **Lead 的倾向（B 比 C 划算）成立**；补充修正：B 的成本中心不是提示词，而是**工具层重写 + 控制台取舍 + 双仓维护期**，所以 B 必须按最小切片推进（见 §7 PoC）。

---

## 1. dsh 插件扩展点清单

dsh 是 cordis 插件树：一个插件 = 一个 npm 包，导出 `apply(ctx, config)` 即可在装配期注册服务、工具、提示词、事件监听与资源清理；`package.json` 的 `dsh.bundle.patch` 指明它往 profile 里插哪几行【码：`dsh-collab/package.json:19-21`、`dsh README.md:37,42`】。本机 web profile 的插件清单就是这一形态【码：本机 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`；示例为逐机事实，装插件后的清单以现读为准】。

### 1.1 提示词与消息侧

| 能力 | 有现成扩展点 | 源码证据 | 限制 |
|---|---|---|---|
| 追加系统提示段 | **有** `ctx.systemPrompt.section({name, order, text, interpolate?})` | `dsh-system-prompt/lib/index.js:253`；方法契约见 340 行起注释 | 段名重复会抛错（同层内唯一）；`text` 可为函数按 agent/runtime 取值 |
| 按名替换某个核心段 | **有**：在 **agent 作用域**注册同名 section 会 shadow 全局段 | `dsh-system-prompt/lib/index.js:203`（重复名错误提示明确"per-agent override 请走 `agent.ctx`"）、`:345-356` 装配注释 "Scoped sections and variables shadow globals"；先例 `dsh-persona/lib/index.js:36-48` | 只能在该 agent 的 scope 内替换，不能在全局 root 上覆盖（root 上同名直接报错） |
| 整段接管系统提示 | **有**：section 传 `complete: true`，装配后被强制恢复为**唯一** section | `dsh-system-prompt/lib/index.js:381-407`；官方用法 `dsh-persona` 配置项 `complete`（`dsh-persona/lib/index.js:36-48`、`dsh-persona/README.md:42,49`） | 同一装配里只能有一个 complete 段，否则抛 "multiple complete prompt sections"；complete 会**吃掉** identity/工具指导/后缀；作用域仅限 agent（preset 内挂载） |
| 装配后改写（最后一道） | **有** `system-prompt/assemble` waterfall | `dsh-system-prompt/lib/index.js:398`；先例 `dsh-working-directory/lib/index.js:48-64`、`dsh-agent/lib/index.js:167` | 可增删/改 sections/contexts/tools；对 complete 段无效（它总被恢复为唯一 section） |
| 动态运行时上下文 | **有** `ctx.systemPrompt.context({name, order, text, required?, interpolate?})` | `dsh-system-prompt/lib/index.js:279`；另有 26 个文件含 `systemPrompt.section(` 调用、9 个文件含 `systemPrompt.context(`（`grep -rl` 实测） | 文本默认按 `{{变量}}` 模板解析，正文含 `{{` 必须 `interpolate:false`（先例 `arch-canvas/lib/host-logic.js:4495,5760`） |
| 上下文进入**用户消息侧** | **有（默认行为）**：preStep 把 context 作为一条 user-role 消息追加到本步 claimed messages | `dsh-agent-loop/lib/index.js:902-928`（`:909` waterfall、`:918` `[...claimed, context]`）；上下文块标题文本在 `dsh-system-prompt/lib/index.js:136-139` | required 的 context 即使 `suppressRuntimeContext()` 也保留；每个请求都会带 |
| 插件向用户消息注入任意内容 | **有**：监听 `agent/pre-step` 并返回替换后的 `decision.messages`；用官方 `createUserMessage` 构造带 `source.form` 的 user 消息 | `dsh-agent-loop/lib/index.js:909`；官方消息构造器 `dsh-llm/lib/index.js:59`；第一人称先例 `dsh-skill-gate/lib/index.js:682-693`（`form:'notice'/'instructions'`） | 注入内容进 durable 会话历史；对系统提示无影响 |
| 提示词变量 | **有** `ctx.systemPrompt.variable(name, provider)` | `dsh-system-prompt/lib/index.js:310`；内置 `provider/model` 变量 `dsh-agent-loop/lib/index.js:1591-1592` | 变量名固定正则；未注册的引用渲染时抛错 |
| 段顺序 | 按 `order` 升序，order 相同按 name 字典序 | `dsh-system-prompt/lib/index.js:101-103`；中心化 order 表 `:10-43`（32 个命名位，含 `HARNESS_IDENTITY=-1000`、`DEPLOYMENT_PERSONA_PREFIX=0`、`TOOL_* 1000+`、`DEPLOYMENT_PERSONA_SUFFIX=10200`） | 想插在"工具指导之前/之后"要挑 order；无法直接删除第一方段（除 complete/waterfall） |

**对本报告的四个必答点，直接回答：**

1. **能只追加吗？** 能，两种都行：系统提示 `section`（order 挑位）+ 运行时 `context`（默认进用户消息侧）。
2. **能替换核心段吗？** 能，但只能**按段名/按 agent 作用域**替换；全局 root 覆盖会撞重复名报错。
3. **能注入用户消息侧吗？** 能：runtime context 默认就落在用户消息侧；也可以在 `agent/pre-step` 里直接插入 `createUserMessage`。
4. **顺序与冲突规则？** section 按 order→name 排序后以空行拼接、空段丢弃；同层段名重复抛错；scoped 层同名 shadow 全局；多个 complete 段抛错；complete 生效后其余 section 全部被丢弃（contexts/tools/variables 仍解析，required context 保留）。

### 1.2 Agent 循环、会话与事件

| 能力 | 有现成扩展点 | 源码证据 | 限制 |
|---|---|---|---|
| 创建/恢复 agent（每批新会话） | **有** `ctx.agents.create()` / `resume()`，返回 `AgentHandle`；`dispose()` 停循环、注销、**移除 session**、卸 scope | `dsh-agent/lib/index.js:453`（create）；`dsh-agent/README.md:30-45` | 每 handle 唯一持有销毁权；create 是异步且要传 provider/model |
| 驱动对话 | **有** `followup()`（下一轮提示，唤醒）/`steer()`（下一步输入）/`inject()`（不唤醒，进下一步）/`cancel()`/`whenIdle()` | `dsh-agent-loop/lib/index.js:806-870`；`dsh-agent/README.md:47,143` | 三者都按 user-role 消息进 inbox；注入内容进 durable 历史 |
| 接管/替换 agent loop | **有** `ctx.agents.setFactory(factory)` | `dsh-agent/lib/index.js:429-437`（已注册则抛错）、`:314` 注释 | 全局工厂槽只有一个；换掉后 dsh 的会话/子智能体/工具管线/completeness 等行为由自研循环负责——这是"重写 loop"而非"扩展 loop" |
| 逐 agent 作用域（工具/提示/监听器） | **有** `Agent.ctx` | `dsh-agent/README.md:61-63`；预设机制 `dsh-agent-preset/README.md:28-38`、web profile 已挂 `agent-preset-registry`（`dsh-web-app/cordis.patch.yml:586-589`） | 按会话创建时组合；静态 preset + 动态 setup 两种入口 |
| 生命周期与过程干预事件 | **有**：`agent/created`、`agent/disposed`、`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping`、`agent/assistant-stream`、`agent/status`、`session/event` | `dsh-agent/lib/index.js:581`（created）、`:324`（factory 字段）；`dsh-agent-loop/lib/index.js:798,909,1001,1080,1136,1191,319`；`dsh-agent/README.md:67` | 事件签名在生成的 `.d.ts` 区，rc 期有变动风险；`agent/request` 只改路由参数不改消息 |
| 会话状态 | **有** 事件溯源 append-only log，`deriveMessages()` 投影出模型历史；可 fork/恢复/压缩 | `dsh-session/lib/index.js:1517,1672`；`dsh-session/README.md:12` | 有状态是默认语义；不落盘则纯内存（`dsh-session/README.md:12`） |
| 会话持久化 | **有** JSONL 后端，按 sessionId 每会话一个文件，zstd/纯文本可选 | `dsh-session-persistence-jsonl/README.md:12,40-48`；base 组合默认挂这一行（`dsh-base/cordis.patch.yml:138-139`） | root 必填；可按 profile patch 关掉或换内存 |
| 压缩/上下文压力 | **有** `dsh-compaction-basic`、`dsh-token-meter` | 两包 README Summary | 压缩只能压历史，压不了系统提示与工具 schema |
| 工具注册 | **有** `defineTool` + `ctx.tools.register()`；schema 自动进提示词装配 | `dsh-tools/lib/index.js:2974,3810`；`dsh-tools/README.md:32-45,141` | 需要按 dsh 的参数 DSL 重写 schema |
| 工具调用门禁/改写 | **有** `tools/pre-execute`（allow/deny/ask 瀑布）、`guard` 守卫、`tools/execute` 包装、`tools/post-execute` 改写、`tools/result` 观测；`ctx.tools.restrict/guard` 按 agent 收窄 | `dsh-tools/lib/index.js:3321,3427,3600,3513,2991,3017`；`dsh-tools/README.md:89,109,141` | pre-execute 不能改写参数（`dsh-tools/README.md:233`）；审批与沙箱策略由 permission/sandbox 包各自持有 |
| 技能 | **有** `SKILL.md`（目录包或扁平 .md），扫 repo/自定义/user 根目录；目录变化即热更新；模型用 `skill` 工具加载 | `dsh-skill-filesystem/README.md:12`；`dsh-tool-skill/README.md:12` | AIChat 的 `skill.json + index.js` 格式不兼容，需要重写为 SKILL.md 或保留为插件 |
| UI 面板 | **有** `dsh.client` 双面插件（node half + browser half；`package.json` 的 `dsh.client`，`exports('./client')`） | `dsh-collab/package.json:19-27` 的 `dsh.bundle`/`dsh.client`；web 层注释 `dsh-web-app/cordis.patch.yml:230-237` | 需要按 dsh 客户端模块体系写；原生 HTML 控制台不能直接搬 |
| 后台服务/定时器 | **有** cordis service/`ctx.effect`/`ctx.timer`；先例 `dsh-collab`（锁服务+定时刷新）、`arch-canvas` | `dsh-collab/lib/index.js`（host bundle 内 `systemPrompt.context` 与 timer）、`arch-canvas/lib/host-logic.js:5760` | 长生命周期资源要在 effect 里声明，卸载即回收 |
| 外部消息源/通道 | **无现成 IM 通道**；两条编程缝：进程内 OneBot 客户端自驱（`agents.create`），或进程外 SDK/ACP 客户端 | 无 IM 包【实测命令：305 个包名 grep `onebot|qq|napcat|telegram|discord|slack|wechat|channel|transport|webhook` 为空】；`dsh-sdk-jsonrpc-server/README.md` Summary（stdio JSON-RPC，一 session per id，prompt 队列+事件流）、`dsh-acp/README.md` Summary | 缺 OneBot WS/事件聚合/发送通道/白名单/限频——AIChat 全有 |
| 模型路由 | **有** `dsh-llm` + 适配器；`dsh-llm-pi-ai` 支持 OpenAI 兼容网关与自托管；`dsh-llm-retry` 步骤级重试 | `dsh-llm/README.md` Summary；`dsh-llm-pi-ai/README.md` Summary；`dsh-llm-retry/README.md` Summary | AIChat 的"任意 OpenAI 兼容端点"可映射；价格表/视觉探测是 AIChat 独有资产 |
| 提醒/日程 | **有** `dsh-schedule`（一次性/固定频率/每日/每周/cron，投递回原 session） | `dsh-schedule/README.md` Summary | 与 AIChat reminders 语义接近，可替换 |
| MCP 工具 | **有** `dsh-mcp-client`，外部 MCP server 的工具以 `mcp__*` 进入工具面 | `dsh-mcp-client/README.md` Summary；base 组合只挂 mcp-resources、不挂 client（`grep mcp dsh-base/cordis.patch.yml` 仅 mcp-resources） | 需自行加行；工具与会话绑定要靠插件，不如原生插件工具自然 |
| 审批/沙箱 | **有** `user-approval`、`permission-presets`、`sandbox-policy`（文件类调用统一策略） | 三包 README Summary；base 组合挂载（`dsh-base/cordis.patch.yml`） | 面向文件/命令；QQ 发送通道的审批语义要自定 |

---

## 2. 第一人称线索：系统提示里那两段插件文本从哪来

本会话系统提示里出现 `[dsh-collab] …` 与 `## 逻辑框架画布（arch-canvas）`，它们**不是 system prompt sections**，而是 **runtime context**：

- `dsh-collab` 用 `systemPrompt.context({ name:'dsh-collab/awareness', order:130 })` 和 `delegation`（order 131）注入态势与委托纪律【码：`/home/vesita/coding/my/dsh-collab/lib/delegation.js:89-91`；其 host 形态同一注册点】。
- `arch-canvas` 用 `systemPrompt.context({ name:'arch-canvas', order:137, text })` 注入画布说明【码：`/home/vesita/coding/my/arch-canvas/lib/host-logic.js:5760`】。
- agent loop 的 preStep 默认把渲染后的 runtime context 作为**一条 user-role 消息**追加到本步输入【码：`dsh-agent-loop/lib/index.js:902-928`】，其块标题即 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."【码：`dsh-system-prompt/lib/index.js:136-139`】。

因此"插件影响提示词"有两条不同通道，边界不同：
- **`section` 通道**：进系统提示，位置由 `order` 决定，可被 scoped 同名覆盖，也可 `complete` 整段接管；模型看到、对话历史里看不到。
- **`context` 通道**：进用户消息侧（默认），每步重注入、可动态变化；适合"实时态势"，不占系统提示字节前缀的稳定区。

---

## 3. AIChat 模块映射

AIChat 规模：`src/` 46 个 `.js` 模块 24,515 行，测试 51 个文件 16,358 行，`npm test` 串行 42 个测试入口【实测命令：`wc -l src/*.js`、`ls test | wc -l`、`package.json scripts.test`】。核心设计与扩展形态见 `README.md:15-19,55-70`。

### 3.1 可直接复用为插件（业务逻辑基本不动，换壳）

| AIChat 模块 | 现状（证据） | dsh 侧落点 | 依据 |
|---|---|---|---|
| `onebot.js`（OneBot v11 WS 客户端+HTTP API） | `OneBotClient`：`src/onebot.js:174` 起 | 插件内后台服务（收事件、发消息） | dsh 无 IM 通道（§1）；这是通道插件的核心 |
| `qq-login.js` / `qq-login-qr.js`（NapCat WebUI 扫码登录、状态机） | 3,048 行，含二维码与鉴权闭环 | 插件服务 + 可选 dsh.client 页面 | dsh 无协议端登录概念 |
| `sender.js`（分条/限频/去重/出站硬上限/CQ 转义/字数切分） | `SendQueue`：`src/sender.js:53` 起 | 插件服务或 `send_message` 工具内部 | dsh 工具管线不提供这些业务语义 |
| `tools.js` 的 28 个工具 | 28 个 `registerTool`（`grep -c` = 28） | 逐条改写为 `defineTool` + `ctx.tools.register` | 模型接口是标准 function calling，语义可平移 |
| `memory.js`（群友长期画像、合并/去重/整理） | `MemoryStore`：`src/memory.js:164` 起 | 插件服务 + 记忆工具（按 chatKey 绑定） | dsh 无人物画像/长期记忆包【实测命令：305 包名无 memory/profile 类】；这是 AIChat 的差异化资产 |
| `safe-fetch.js` / `web-search.js` / `image-compress.js` / `video-reader.js` / `stickers*` | 自实现 SSRF 防护、6 家搜索、媒体处理 | 工具实现体复用，注册方式改写 | dsh 的 `tool-web` 是通用抓取，不含 AIChat 的引擎矩阵与禁内网规则 |
| `model-prices.js` / `price-feed.js` / `vision-scan.js` / `model-vision-docs.js` | 价格表/峰谷/视觉探测 | 插件服务或设置页 | dsh 有 token 计量与模型目录，但没有 AIChat 的价格/峰谷口径 |
| `plugins/`（smart-wake、token-saver）与 `src/skills/` 管理器 | 钩子 5 个（`before-context`/`before-llm-messages`/`after-response`/`before-tool`/`after-tool`）+ 能力名（`getCapabilityProviders` 取用 11 个，另 4 个 rescue 能力名经 `#capFirst` 取用） | 改为 cordis 插件（直接监听 dsh 事件/瀑布） | 概念同构：确定性扩展=插件，LLM 型=skill；但 API 不同 |
| `reminders.js` | 提醒存储/调度 | 可用 `dsh-schedule`，或保留在插件内 | dsh-schedule 语义接近（§1.2） |

### 3.2 需重写成 dsh 扩展点（逻辑要保留，骨架要换）

| AIChat 模块 | 现状（证据） | dsh 落点 | 重写量 |
|---|---|---|---|
| `orchestrator.js`（唤醒/聚批/触发判定/会话重试/收尾/可靠性四条） | 2,516 行；`Orchestrator`：`src/orchestrator.js:56`；wake 在 700+ 行区域 | 插件调度器 + `ctx.agents.create`/`followup`/`whenIdle`/`dispose`；可靠性语义（M-1/M-2/D-1/T-1）**仍需自己实现** | 大：触发/聚批/重试/回补是 AIChat 的业务核心，dsh 不提供等价物 |
| `prompt.js`（人设/机制段/参与档位/AI 判定/rescue/提示词锚点） | `buildSystemPrompt`：`src/prompt.js:248`；`buildUserPrompt`：`:815`；锚点缓存注释 `:648-655` | 系统提示走 `systemPrompt.section`（人设/机制/技能段），实时状态走 `context`；档位/判定/rescue 进插件逻辑 | 中：提示词内容可迁，装配与缓存策略要重测 |
| `sessions.js`（每运行一个会话卡片、JSON 留档） | `SessionRegistry`：`src/sessions.js:32` | dsh session + `session` 投影/客户端 UI | 中：数据模型不同（AIChat 卡片字段 ≠ dsh session summary） |
| `store.js`（每群 JSON 存档、未读/已读、批边界） | `ChatStore`：`src/store.js:46`；README:15-19 的"已读信息/未读信息"来源 | 插件自有存储（dsh session log 不是"群聊存档+未读"） | 中：必须保留，否则触发/聚批语义无从谈起 |
| `llm.js`（OpenAI 兼容调用、重试、备选模型、图片降级） | 692 行；`chatCompletionWithRetry` 等 | `dsh-llm` + `dsh-llm-pi-ai`（OpenAI 兼容网关/自托管）+ `dsh-llm-retry` | 小：AIChat 这部分本来就薄，可丢 |
| `plugin-loader.js` / `src/skills/manager.js` | AIChat 自己的 manifest/能力/钩子体系 | dsh 插件 + dsh skill 两套；AIChat 的 `skill.json` 格式与 SKILL.md 不兼容 | 中：扩展要按新格式重写（或保留为插件内部体系） |
| `app.js` / `routes.js`（HTTP API、SSE、控制台后端） | `createApp`：`src/app.js:89`；`/api/status`：`src/routes.js:89` | dsh web 层 + typert/gateway；或插件自带只读路由（skill-gate 的先例） | 大：AIChat 控制台是基于自建 API 的完整产品面 |
| `config.js`（嵌套配置、按群覆盖、运行时热更） | `personaForChat`：`src/config.js:818`；`storeConfigForChat`：`src/config.js:853` | 每个插件行用 schemastery `Config`（有设置表单）；按群动态值进插件自己的存储 | 中：配置面要重新设计 |
| `server.js` 启动与进程守护 | `src/server.js` | dsh profile 启动（systemd 单元托管 dsh） | 小 |

### 3.3 与 dsh 重复、应当丢弃

| 资产 | 重复对象（证据） | 处理 |
|---|---|---|
| Electron 桌面壳（`electron/`、托盘/自启） | dsh web/CLI 已是宿主形态（`dsh README.md` 的入口模式表） | 丢 |
| 自制控制台前端（`ui/` 原生 HTML/CSS/JS） | dsh web client 插件体系（`dsh.client` 双面插件，`dsh-web-app/cordis.patch.yml:230-237`） | 丢或只保留少量业务页（会话/存档/记忆）为 client 插件 |
| 自建 LLM 路由/重试/超时/模型目录 | `dsh-llm`、`dsh-llm-pi-ai`、`dsh-llm-retry`、`dsh-agent-default-model`（`dsh-base/cordis.patch.yml`） | 丢 |
| 自建工具注册表与可用性判定（`tool-registry.js`） | `dsh-tools`（scoped 注册、restrict/guard、schemas） | 丢 |
| 自建会话/用量/成本看板 | `dsh-session`、`dsh-session-stats`、`dsh-token-meter`、`dsh-session-telemetry` | 大部分丢；价格口径另做 |
| 自建更新检查/telemetry/实例锁 | dsh 启动器/profile 管理/锁 | 丢 |
| 自建子智能体/工作流/目标（AIChat 没有） | dsh 自带 `dsh-subagent*`、`dsh-tool-workflow`、`dsh-goal*` | 反向收益：白拿 |

### 3.4 迁移后会变贵或变弱的点

1. **"成本恒定"承诺要重新标定。** dsh 默认 base 组合有 96 行（【实测命令】`grep -c "name:" dsh-base/cordis.patch.yml` = 96）、14 个工具包、26 个文件含 `systemPrompt.section(` 调用、9 个文件含 `systemPrompt.context(`（`grep -rl` 实测；包内多文件会让文件数≠包数）；且 base 默认挂 `session-title-first-prompt-llm`（每个新 session 一次额外 LLM 请求）。AIChat 每批新开会话若照搬默认组合，静态提示与额外调用都会比现在大。**必须做自定义 profile 裁剪**，这不是零成本。
2. **每群独立人设与按群配置变"代码化"。** AIChat 的 `personaForChat(chatKey)`/`storeConfigForChat(chatKey)`（`src/config.js:818,853`）是数据驱动、控制台可编辑；dsh 的 agent preset 是静态声明，按群动态人设必须在 `agents.create` 的 `setup(agentCtx)` 里注册 scoped section（可行，但配置面从表单退化为插件配置/代码）。
3. **可靠性四条不会免费获得。** AIChat 现有可靠性语义（M-1 失败批回补 / M-2 定向零发送可观测 / D-1 发送幂等 / T-1 工具超时与中止）都是它的业务语义；dsh 的工具管线只有通用超时与审批，发送幂等/漏回回补仍需在插件里重做。
4. **控制台产品面变弱。** 会话卡片（提示词/工具调用/发送记录逐条留档）、存档页未读、记忆编辑页是 AIChat 的重要产品面；dsh web UI 是通用 coding UI，不提供这些页面。要么写 client 插件（成本高），要么丢（产品变弱）。
5. **提示词前缀缓存要重测。** AIChat 有 prompt-anchor 设计（`src/prompt.js:648-655` 注释）：连续触发时复用"记忆+已读信息"字节前缀。dsh 的缓存策略基于请求头/系统提示稳定；迁移后要重新量命中率，不能假定持平。

---

## 4. 「有状态 session」与「无状态每批新开」的语义差价

dsh 的 session 是**事件溯源 append-only log**，默认有状态、可恢复、可压缩；AIChat 是"每批新开、结束即弃、成本恒定"。

**结论：差价可控，前提是把 dsh 用成"每批一个短命 agent"。**

- dsh 的 `ctx.agents.create()` 每次可给新 sessionId；`handle.dispose()` 会停循环、注销、**移除 session**、卸 scope【码：`dsh-agent/README.md:30-45`】。这正是 AIChat 的"新开即弃"。
- session 不挂持久化时纯内存（`dsh-session/README.md:12`）；base 默认挂 JSONL 后端但可按 profile patch 关掉/换临时目录（`dsh-base/cordis.patch.yml:138-139`）。AIChat 现在每次运行也写一份 `data/sessions/<id>.json`（`src/sessions.js`），所以"每批一个会话文件"不是新增成本，只是换格式。
- 需要额外关掉的默认项：会话标题 LLM（base 挂 `session-title-first-prompt-llm`）、telemetry、projcache；压缩/上下文压力对单批短会话无意义。
- 【推测】每批 create/dispose 的 CPU/IO 相对一次 LLM 调用可忽略，但需 PoC 实测（本报告未测）。
- 真正拉开成本的是**默认提示词体量**，不是 session 机制（见 §3.4 第 1 条）。

---

## 5. 「接管一大部分核心提示词」的真实代价

### 5.1 技术上可行——但含义是"整段替换"，不是"打补丁"

官方支持的路径：agent preset 里挂 `dsh-persona`，`prefix` 写你的完整系统提示、`complete: true`。装配后注册表会把该 prefix 恢复为**唯一** section【码：`dsh-system-prompt/lib/index.js:381-407`；`dsh-persona/lib/index.js:36-48`】。README 明确其语义：上下文/工具/变量/协作监听器仍会解析，但**没有 identity、suffix、工具指导或监听器能再追加提示词**【码：`dsh-persona/README.md:42,49`】。web profile 的注释也承认这条路径（"A complete agent-preset persona replaces the sections…"【码：`dsh-web-app/cordis.patch.yml:208-210`】）。

### 5.2 接管后你要自己保证的语义（不是"抄一份提示词"）

- 身份与行为准则（`HARNESS_IDENTITY` 段被顶掉）；
- 工具协议：调用格式、失败处理、结果渲染、并行/独占规则、presentation 模式（native vs ptc）；
- 技能目录与 `skill` 工具语义；
- 计划模式、目标、子智能体、团队、工作流等策略段；
- 审批/沙箱/权限提示（策略由包实现，但"怎么告诉模型"的文本在系统提示里）；
- MCP server instructions（正常情况下作为字面文本并入日志提示词；complete 下是否仍并入【推测】需实测）；
- required runtime context 仍会注入用户消息侧（如 working-directory）——`suppressRuntimeContext()` 只压可选项【码：`dsh-system-prompt/lib/index.js:289`】。

### 5.3 每次升级要付什么（这是 C 的核心成本）

- **版本节奏（可查到的硬数据）**：`dsh` 68 天发了 36 个版本（2026-08-10 → 2026-10-17）；0.2.1 系列在 14 天内发了 7 个（alpha.1 10-03 → rc.2 10-17）【实测命令：`npm view @deepseek-ai/dsh time --json`】。核心包（agent-loop/system-prompt/persona/tool-skill/base）与 CLI **同版本号同步发**（抽查 5 个包版本列表长度 36–37，末版本一致）——不是"每个包独立演进"，而是整树一起走。
- **插件兼容是硬门**：启动/安装会校验插件的 `engines.dsh` 或 DSH peer 范围，不兼容需显式精确版本豁免【码：`dsh README.md:39`】。先例：`dsh-collab` 的 peer 依赖精确钉在 `@deepseek-ai/dsh-llm 0.2.1-rc.2`【码：`/home/vesita/coding/my/dsh-collab/package.json` peerDependencies】。每次 dsh 升级，C 方案要跟着 bump peer、重装、重测。
- **没有第三方提示词回归测试**：安装包只带 `lib/`（无 tests）；上游仓库历史在本机不可达（GitHub API 被解析到非公网地址，拒绝访问）【实测命令：web_fetch 失败】。也就是说"谁保证工具协议/技能门禁没被破坏"的答案是：**只有你自己**，靠自建对照测试。
- 结论：C 的代价 = 把 dsh 的周更/rc 节奏变成自己的**提示词与行为回归节奏**；一次重写不贵，长期对齐才贵。

### 5.4 「只叠加不接管」的中间路（推荐重点）

按侵入性递增：
1. **人设段替换**：profile 的 `system-prompt` 行 `personaPrefix` 直接写 AIChat 人设与规则（web profile 现成示例：`dsh-web-app/cordis.patch.yml:18-22`）——不碰工具/技能/团队段，升级零 rebase。
2. **追加 section**：插件注册 1–3 段（order 700 附近或 9000+），如"QQ 群聊风格/参与守则/记忆使用纪律"。
3. **动态 context**：群聊态势/画像摘要每步注入用户消息侧（先例 dsh-collab/arch-canvas）。
4. **assemble waterfall 做减法**（可选）：只删不需要的第一方段（如 coding 相关工具指导），保留其余；风险中，但比 complete 可控。
5. **complete 接管**：只在"我们真的要维护整套提示词"时才选。

---

## 6. 三个方案对比

| 维度 | A 保持独立应用 | B 拆成 QQ 通道+记忆/画像插件，loop 交 dsh（只叠加） | C 全量插件化 + 接管核心提示词 |
|---|---|---|---|
| 做到什么 | 现状 46k 行独立应用；可选吸收 dsh 的提示词/工具设计（不引入 dsh） | dsh profile 内一个 cordis 插件：持有 OneBot、按批创建 fresh agent、注册 QQ 工具、叠加人设/画像/态势段；loop/工具管线/审批/沙箱/技能/子智能体/模型路由用 dsh | 单进程 dsh；系统提示完全 AIChat 风格；工具协议/技能/团队语义由我们重写并长期对齐 |
| 一次性代价 | 0 迁移 | 中高：通道插件 + 28 工具重写签名 + 存储/触发/可靠性逻辑搬移 + UI 取舍 + 自定义 profile + 测试重建 | B 的全部 + 整套核心提示词与第一方语义重写 |
| 持续代价 | 继续维护自有 loop/UI/模型路由（重复造） | 双仓维护期；跟随 dsh 事件/API 变动（rc 期）；profile 裁剪维护 | 每次 dsh 升级重验全部核心语义；peer/版本豁免管理；无上游回归测试可依 |
| 风险 | 生态脱节；loop 能力（压缩/审批/沙箱/子智能体）继续自造 | 上游 rc 期 API 变动；默认 prompt 成本；控制台产品面变弱 | 最高：升级即回归；工具协议/技能门禁破坏只有自己兜底 |
| 退出成本 | 无 | 低：插件是独立 npm 包+profile 行，停用 bundle 行即回 A；数据目录可继续共用 | 中：可回退到 A/B，但已投入提示词工作作废 |
| 生态位置 | 无 | 有：QQ 通道与记忆画像作为 dsh 生态插件 | 最强名义，但承担 harness 升级债 |

**推荐 B（只叠加，不接管）**，并**分两阶段**：
- B1（先做，1–2 天）：进程内插件 PoC，只证明"QQ 消息驱动 dsh 会话 + 插件工具回发 + 提示词只叠加"。
- B2（PoC 通过后）：补记忆画像插件、控制台方案（保留 AIChat 只读控制台 or 写 client 插件）、profile 裁剪与成本基线。

**Lead 倾向验证**：**成立**。理由来自源码而非印象：complete 接管的语义是"唯一 section + 丢弃全部第一方指导"（§5.1），叠加路径官方支持且先例充足（§5.4），而 dsh 的发布节奏与 peer 硬校验（§5.3）把 C 变成持续回归工程；AIChat 真正值钱的是 QQ 通道、记忆画像、可靠性语义与产品控制台（§3），不是那份系统提示词。

---

## 7. 最小 PoC（推荐 B 的下一步第一个具体动作）

**动作**：在**本机** dsh profile（不动生产线）新增一个最小 cordis 插件 `aichat-channel-poc`，只做"一条 QQ 消息 → 一次 fresh dsh 会话 → 一条 QQ 回发"。

最小实现范围（1–2 天）：
1. 插件入口 `apply(ctx)`：连本地 mock OneBot WS（复用 `test/_harness.mjs` 的 mock 思路，或本机 NapCat 只读旁听，不接管生产）。
2. 收到一条 @ 消息 → `ctx.agents.create({ sessionId: 'poc-'+batchId, agentOptions:{provider,model}, setup(agentCtx){ agentCtx.tools.register(send_message 工具，闭包绑定 chatKey) } })`。
3. `agent.followup({ content:[{type:'text', text: 存档摘要+新消息}], source:{kind:'qq'} })` → `agent.whenIdle()` → `handle.dispose()`。
4. 提示词只叠加：profile `personaPrefix` 填 AIChat 人设摘要；插件注册 1 个 section（记忆画像示例）+ 1 个 context（群聊态势）；**不设 complete**。

**可判定验收判据**：
- mock QQ 端收到 1 条回复，内容来自模型通过插件 `send_message` 工具发出的调用；dsh 侧有会话记录且 `whenIdle()` 后 agent 已 disposed（`ctx.agents.get(id)` 为 undef）。
- 提示词快照里同时出现：核心 identity/tool guidance 段（证明未接管）+ 我们的画像段/态势 context（证明只叠加）。
- 同一消息重复投递不会产生两条回复（发送去重生效）。
- 记录单批 token 与 AIChat 基线同场景对比（PoC 只记录数字，不设通过线）。

**负向对照（缺一不可）**：
1. **停用插件**：同一条消息进来后不产生任何 dsh 会话、不产生回复 → 证明通道能力来自插件，不是 dsh 自带。
2. **禁用插件注册的 send_message 工具**（profile `tools.overrides` 关掉）：会话仍能跑完但没有任何 QQ 发出 → 证明"能回 QQ"来自插件工具，不是宿主内建。

**停止点**：PoC 只验证链路与叠加方式；不做生产切换、不改 AIChat 主仓。

---

## 8. 三个最大风险

1. **上游 rc 期契约稳定性**：68 天 36 个版本、核心包同步发版、插件有 peer/engines 硬校验（§5.3 证据）。通道插件必须钉版本 + 留版本豁免/升级流程 + 自建契约对照测试（事件签名、工具管线行为）。缓解：B 阶段只依赖少量稳定缝（`agents.create`、`tools.register`、`systemPrompt.section/context`、`agent/pre-step`），不碰内部私有字段。
2. **默认组合的提示词体量与成本**：base 96 行、14 个工具包、26 个文件含 `systemPrompt.section(` 调用、默认标题 LLM 请求（§3.4）。不裁剪则"每批成本恒定"承诺失效；裁剪则要维护 profile patch 并重测行为。缓解：PoC 就设自定义瘦身 profile，先量成本再扩功能。
3. **控制台/产品面取舍**：AIChat 的会话卡片、存档未读、记忆编辑页是产品价值；dsh web UI 不提供。写 client 插件成本高、丢弃会变弱。缓解：B1 阶段先做只读旁路（AIChat 控制台继续读插件状态），把 UI 迁移决策推迟到有真实使用反馈之后。

---

## 9. 证据强度与未验证项

| 结论 | 强度 | 依据 |
|---|---|---|
| dsh 插件面（工具/提示词/消息/事件/loop/session/技能/UI/服务） | 强（源码+官方 README，多先例） | §1 表逐条 `文件:行` |
| 提示词只追加、按名替换、complete 接管、用户消息侧注入 | 强（源码 + 官方 README + 本机自研插件先例） | §1.1、§2、§5.1 |
| 无 IM/QQ 通道；SDK/ACP 是可编程入口 | 强（全包名 grep + README）；"缺什么"为推断 | §1.2、§5 |
| B 比 C 划算 | 中强（源码语义 + npm 发布节奏实测）；"C 的长期回归成本"部分为推断 | §5、§6 |
| 每批 create/dispose 开销可忽略 | **【推测】**，未做 PoC | §4 |
| complete 模式下 MCP instructions 是否仍并入 | **【推测】**，未实测 | §5.2 |
| dsh 提示词在两个版本间的实际 diff | **未验证**：上游 git 历史不可达（GitHub API 被本机网络拒绝），且为遵守只读未下载旧版包 | — |
| 生产 VPS 上的 dsh/AIChat 行为 | 未验证（本任务禁止触碰生产） | — |

**一句话结论**：**技术可行；推荐 B（QQ 通道 + 记忆/画像插件，loop 交 dsh，提示词只叠加不接管）**。C 的"接管核心提示词"有官方路径，但它是"整段替换 + 自己维护全部第一方语义"，与 rc 期周更节奏叠加后不划算；下一步先做 §7 的最小 PoC 并用两条负向对照钉住"通道/工具确实来自插件"。
