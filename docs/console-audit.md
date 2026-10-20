# AIChat 控制台审计：配置暴露矩阵 + 信息架构（只读）

审计对象：AIChat 控制台（`ui/`、`src/config.js`、`src/routes.js`、`src/app.js`、`plugins/*`）。
审计时间：2026-10-20。审计时线上部署版本 = 仓库 `chat` 分支 `673b0e5`（curl 到的 HTML/JS/CSS 与本地 HEAD 逐字节一致）。
本报告只读：未改 `ui/`、`src/`、`plugins/`，未改线上配置、未部署、未重启服务。

## 0. 结论速览

- **配置暴露**：共 **164** 个配置键 = 默认配置 148 个叶子键 + `store.contextSliderPos`（线上存在、默认未声明）+ 插件 settings 15 个。
  **已暴露 115（70.1%）/ 半暴露 13（7.9%）/ 未暴露 36（22.0%）**。
- **导航**：顶栏 8 个页签平铺、设置页 10 个 section 平铺；**没有设置搜索、没有深链锚点、没有按使用频率分组**；
  「技能」与「插件」两个相邻入口管同一件事；6 个既有分组标题没有 `id`（人设、聊天设置、桌面端、界面、数据管理、版本更新），无法深链定位。
- **状态**：`/api/status` 本身没有错（实测 `onebot.connected=true`）。**UI 把「本机 SnowLuma 进程在不在」当成「连接状态」**，
  再叠加首屏占位文案、静默失败、轮询启动依赖 init 成功，形成「后端已连接、界面显示未连接」的观感（第 7.3 节）。
- 建议先做 P0 状态可信度（S），再做 P1 设置搜索+深链（S），然后 P2 六组重排（M）、P3 插件设置入口+高级区（M）。

## 1. 审计范围与方法

| 对象 | 方法 | 产出/证据 |
|---|---|---|
| 默认配置 | 用脚本 import `src/config.js::DEFAULT_CONFIG` 递归遍历，记录每个叶子路径、类型、默认值 | 148 个叶子键（27 个含叶子的顶层组） |
| 插件设置 | 读 `plugins/*/plugin.json` 的 `settings` 与 `configSchema` | smart-wake 10 项、token-saver 5 项 |
| UI 控件 | 在 `ui/index.html`、`ui/app/*.js` 中定位每个输入控件的 `id`，并追 `val('#id', c.<路径>)` / `patch.*` / `storePatch.*` 到保存路径 | 每个暴露项的 `文件:行` |
| 线上现状 | `curl /api/config`、`/api/status`、`/`、`/app/*.js`、`/style.css`；经 AT 数据面与运行主机回环各取一次 | 部署版本一致；状态与配置值对照 |
| 敏感值 | 只记录「已脱敏 / 空 / ***」 | 本报告不含任何 key/token 真值 |

## 2. 汇总数字

| 类别 | 数量 | 说明 |
|---|---|---|
| 核心配置叶子键（`DEFAULT_CONFIG`） | 148 | 27 个含叶子的顶层组 |
| 线上存在但默认未声明 | 1 | `store.contextSliderPos`（另有 sanitize 只读元数据，见第 6 节） |
| 插件 settings | 15 | smart-wake 10 + token-saver 5 |
| **合计** | **164** | |
| ✅ 已暴露（UI 有可编辑控件） | **115** | 核心 100 + 插件 15 |
| ◐ 半暴露（只能间接/结构化编辑，或由派生值反推） | **13** | 见 5.2 |
| ❌ 未暴露（UI 无任何入口） | **36** | 全量清单见 5.1 |

分组统计：

| 顶层组 | 键数 | ✅ | ◐ | ❌ |
|---|---|---|---|---|
| `api` | 20 | 18 | 0 | 2 |
| `providers` | 1 | 0 | 1 | 0 |
| `providersSourceYaml` | 1 | 0 | 0 | 1 |
| `webSearch` | 33 | 10 | 8 | 15 |
| `security` | 4 | 0 | 0 | 4 |
| `snowluma` | 6 | 6 | 0 | 0 |
| `persona` | 4 | 4 | 0 | 0 |
| `customPersonas` | 1 | 1 | 0 | 0 |
| `personaUnified` | 1 | 1 | 0 | 0 |
| `allow` | 2 | 2 | 0 | 0 |
| `deny` | 2 | 0 | 0 | 2 |
| `allowAllWhenEmpty` | 1 | 1 | 0 | 0 |
| `wakeDelayMs` | 1 | 1 | 0 | 0 |
| `drainDelayMs` | 1 | 1 | 0 | 0 |
| `maxConcurrentRuns` | 1 | 1 | 0 | 0 |
| `sessionRetryAttempts` | 1 | 1 | 0 | 0 |
| `send` | 7 | 4 | 0 | 3 |
| `proactive` | 5 | 4 | 0 | 1 |
| `chatActive` | 2 | 2 | 0 | 0 |
| `sticker` | 5 | 3 | 0 | 2 |
| `store` | 20 | 15 | 3 | 2 |
| `globalBlocklist` | 1 | 0 | 1 | 0 |
| `communityExemptions` | 1 | 0 | 0 | 1 |
| `commandMute` | 3 | 3 | 0 | 0 |
| `memory` | 5 | 5 | 0 | 0 |
| `tools` | 10 | 10 | 0 | 0 |
| `extensions` | 1 | 0 | 0 | 1 |
| `server` | 4 | 2 | 0 | 2 |
| `ui` | 3 | 3 | 0 | 0 |

## 3. 配置暴露矩阵（全量）

图例：✅ 已暴露 / ◐ 半暴露 / ❌ 未暴露。证据列的文件前缀均为 `ui/app/`（如 `06:189` = `ui/app/06-settings-render.js:189`），
弹窗与弹层逻辑在 `08-modals.js` / `09-community.js` / `10-feedback.js`。线上值列为空时以「（线上无）」标注（多数是脱敏或默认未写入）。

### `api`（20 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `api.baseUrl` | （空） | https://tokenrhythm.studio/v1 | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.apiKey` | （空） | （已脱敏） | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.model` | （空） | deepseek-flash | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.provider` | （空） | si-beat | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.fallbackModels` | [0] | [0] | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.visionModel` | （空） | （空） | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.videoModel` | （空） | （空） | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.videoMode` | auto | auto | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.vision` | true | true | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.video` | false | false | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.temperature` | 0.8 | 0.8 | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.maxRounds` | 12 | 12 | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.timeoutMs` | 180000 | 180000 | ❌ 未暴露 | 06:189–262；弹窗 08:279–317 | 高级折叠 |
| `api.thinkingMode` | auto | auto | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.thinkingEffort` | （空） | （空） | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.thinkingBudget` | 0 | 0 | ❌ 未暴露 | 06:189–262；弹窗 08:279–317 | 高级折叠 |
| `api.priceInputPerM` | 0 | 0 | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.priceOutputPerM` | 0 | 0 | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.priceCachedPerM` | 0 | 0 | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |
| `api.useOfficialPrice` | true | true | ✅ 已暴露 | 06:189–262；弹窗 08:279–317 | 保持 |

### `providers`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `providers` | [0] | [0] | ◐ 半暴露 | 08:263 openModelConfigModal（/api/providers） | 保持（现有入口） |

### `providersSourceYaml`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `providersSourceYaml` | （空） | （空） | ❌ 未暴露 | — | 不必暴露（迁移用） |

### `webSearch`（33 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `webSearch.enabled` | true | true | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.searchUrl` | https://cn.bing.com/search | https://cn.bing.com/search | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.maxResults` | 6 | 6 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 暴露（搜索页） |
| `webSearch.provider` | bing | bing | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.deepseek.apiKey` | （空） | （已脱敏） | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.deepseek.baseUrl` | https://api.deepseek.com/responses | https://api.deepseek.com/responses | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.deepseek.model` | deepseek-v4-flash | deepseek-v4-flash | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.deepseek.timeoutMs` | 60000 | 60000 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.zhipu.apiKey` | （空） | （已脱敏） | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.zhipu.baseUrl` | https://open.bigmodel.cn/api/paas/v4/web_… | https://open.bigmodel.cn/api/paas/v4/web_… | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.zhipu.engine` | search_std | search_std | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.zhipu.count` | 10 | 10 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.zhipu.timeoutMs` | 20000 | 20000 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.bocha.apiKey` | （空） | （已脱敏） | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.bocha.baseUrl` | https://api.bochaai.com/v1/web-search | https://api.bochaai.com/v1/web-search | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.bocha.count` | 10 | 10 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.bocha.timeoutMs` | 20000 | 20000 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.baidu.apiKey` | （空） | （已脱敏） | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.baidu.baseUrl` | https://qianfan.baidubce.com/v2/ai_search… | https://qianfan.baidubce.com/v2/ai_search… | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.baidu.count` | 6 | 6 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.baidu.timeoutMs` | 20000 | 20000 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.metaso.apiKey` | （空） | （已脱敏） | ✅ 已暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持 |
| `webSearch.metaso.baseUrl` | https://metaso.cn/api/open/v1/search | https://metaso.cn/api/open/v1/search | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.metaso.count` | 6 | 6 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.metaso.timeoutMs` | 20000 | 20000 | ❌ 未暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 高级折叠 |
| `webSearch.providers` | [0] | [0] | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |
| `webSearch.custom.name` | （空） | （空） | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |
| `webSearch.custom.type` | openai | openai | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |
| `webSearch.custom.baseUrl` | （空） | （空） | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |
| `webSearch.custom.apiKey` | （空） | （已脱敏） | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |
| `webSearch.custom.model` | （空） | （空） | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |
| `webSearch.custom.count` | 6 | 6 | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |
| `webSearch.custom.timeoutMs` | 20000 | 20000 | ◐ 半暴露 | 06:264–360；08:1324–1340；自定义 07:560–590 | 保持（现有入口） |

### `security`（4 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `security.allowPrivateImageHosts` | false | true | ❌ 未暴露 | — | 高级折叠 |
| `security.browseLock.enabled` | false | false | ❌ 未暴露 | — | 暴露（安全） |
| `security.browseLock.hosts` | [0] | [0] | ❌ 未暴露 | — | 高级折叠 |
| `security.browseLock.siteSearchUrl` | （空） | （空） | ❌ 未暴露 | — | 高级折叠 |

### `snowluma`（6 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `snowluma.dir` | （空） | （空） | ✅ 已暴露 | 06:1121–1160；08:1481–1485 | 保持 |
| `snowluma.autoLaunch` | false | false | ✅ 已暴露 | 06:1121–1160；08:1481–1485 | 保持 |
| `snowluma.wsUrl` | ws://127.0.0.1:3001 | ws://127.0.0.1:3001 | ✅ 已暴露 | 06:1121–1160；08:1481–1485 | 保持 |
| `snowluma.httpUrl` | http://127.0.0.1:3000 | http://127.0.0.1:3002 | ✅ 已暴露 | 06:1121–1160；08:1481–1485 | 保持 |
| `snowluma.accessToken` | （空） | （已脱敏） | ✅ 已暴露 | 06:1121–1160；08:1481–1485 | 保持 |
| `snowluma.httpAccessToken` | （空） | （已脱敏） | ✅ 已暴露 | 06:1121–1160；08:1481–1485 | 保持 |

### `persona`（6 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `persona.botName` | 小鲸鱼 | 小鲸鱼 | ✅ 已暴露 | 06:413–460；08:1365–1373 | 保持 |
| `persona.selfNickname` | （空） | （空） | ✅ 已暴露 | 06:413–460；08:1365–1373 | 保持 |
| `persona.roleText` | # DeepSeek 小鲸鱼（内置角色简介）

你是小鲸鱼，也是 DeepSeek… | # DeepSeek 小鲸鱼（内置角色简介）

你是小鲸鱼，也是 DeepSeek… | ✅ 已暴露 | 06:413–460；08:1365–1373 | 保持 |
| `persona.participation` | medium | low | ✅ 已暴露 | 06:413–460；08:1365–1373 | 保持 |
| `persona.customRules` | （空） | （空） | ✅ 已暴露 | 06:413–460；08:1365–1373 | 保持 |
| `persona.systemPromptOverride` | （空） | # 小鲸鱼

你是小鲸鱼，DeepSeek 娘，混在 QQ 群里的 AI 群友。嘴… | ✅ 已暴露 | 06:413–460；08:1365–1373 | 保持 |

### `customPersonas`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `customPersonas` | [0] | [0] | ✅ 已暴露 | 05:743 #cfg-persona-pick | 保持 |

### `personaUnified`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `personaUnified` | true | true | ✅ 已暴露 | 06:463 | 保持 |

### `allow`（2 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `allow.groups` | [0] | [2] | ✅ 已暴露 | 06:690–760；08:1383–1386 | 保持 |
| `allow.private` | [0] | [1] | ✅ 已暴露 | 06:690–760；08:1383–1386 | 保持 |

### `deny`（2 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `deny.groups` | [0] | [0] | ❌ 未暴露 | — | 不必暴露（由屏蔽名单替代） |
| `deny.private` | [0] | [0] | ❌ 未暴露 | — | 不必暴露（由屏蔽名单替代） |

### `allowAllWhenEmpty`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `allowAllWhenEmpty` | false | false | ✅ 已暴露 | 06:702–703 | 保持 |

### `wakeDelayMs`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `wakeDelayMs` | 2000 | 2000 | ✅ 已暴露 | 08:1417 | 保持 |

### `drainDelayMs`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `drainDelayMs` | 1200 | 1200 | ✅ 已暴露 | 08:1418 | 保持 |

### `maxConcurrentRuns`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `maxConcurrentRuns` | 2 | 2 | ✅ 已暴露 | 08:1419 | 保持 |

### `sessionRetryAttempts`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `sessionRetryAttempts` | 2 | 2 | ✅ 已暴露 | 08:1420 | 保持 |

### `send`（7 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `send.minGapMs` | 1000 | 1000 | ✅ 已暴露 | 08:1423–1426（聊天设置折叠卡） | 保持 |
| `send.maxGapMs` | 3000 | 3000 | ✅ 已暴露 | 08:1423–1426（聊天设置折叠卡） | 保持 |
| `send.byLengthMs` | 20 | 20 | ❌ 未暴露 | 08:1423–1426（聊天设置折叠卡） | 高级折叠 |
| `send.maxPerMinute` | 80 | 80 | ✅ 已暴露 | 08:1423–1426（聊天设置折叠卡） | 保持 |
| `send.maxPerHour` | 500 | 500 | ✅ 已暴露 | 08:1423–1426（聊天设置折叠卡） | 保持 |
| `send.hardSplitAt` | 4000 | 4000 | ❌ 未暴露 | 08:1423–1426（聊天设置折叠卡） | 高级折叠 |
| `send.dedupeWindowMs` | 8000 | 8000 | ❌ 未暴露 | 08:1423–1426（聊天设置折叠卡） | 高级折叠 |

### `proactive`（5 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `proactive.enabled` | false | false | ✅ 已暴露 | 08:1435–1437 | 保持 |
| `proactive.checkIntervalMinMs` | 1800000 | 1800000 | ✅ 已暴露 | 08:1435–1437 | 保持 |
| `proactive.checkIntervalMaxMs` | 5400000 | 5400000 | ✅ 已暴露 | 08:1435–1437 | 保持 |
| `proactive.idleThresholdMs` | 1800000 | 1800000 | ❌ 未暴露 | 08:1435–1437 | 高级折叠 |
| `proactive.probability` | 0.25 | 0.25 | ✅ 已暴露 | 08:1435–1437 | 保持 |

### `chatActive`（2 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `chatActive.enabled` | false | false | ✅ 已暴露 | 09:645–668 | 保持 |
| `chatActive.ttlMinutes` | 30 | 30 | ✅ 已暴露 | 09:645–668 | 保持 |

### `sticker`（5 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `sticker.enabled` | true | true | ✅ 已暴露 | 06:1050–1075；08:1442–1445 | 保持 |
| `sticker.promptMaxStickers` | 10 | 10 | ✅ 已暴露 | 06:1050–1075；08:1442–1445 | 保持 |
| `sticker.collectEnabled` | true | true | ❌ 未暴露 | 06:1050–1075；08:1442–1445 | 高级折叠 |
| `sticker.maxCollectPerHour` | 10 | 10 | ❌ 未暴露 | 06:1050–1075；08:1442–1445 | 高级折叠 |
| `sticker.encourage` | 1 | 1 | ✅ 已暴露 | 06:1050–1075；08:1442–1445 | 保持 |

### `store`（20 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `store.maxMessagesPerChat` | 0 | 0 | ❌ 未暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 高级折叠 |
| `store.contextTier` | 4 | 3 | ◐ 半暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持（现有入口） |
| `store.historyCount` | 80 | 120 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.keywords` | [0] | [1] | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.randomPercent` | 10 | 7.1 | ◐ 半暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持（现有入口） |
| `store.promptAnchor.enabled` | true | true | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.promptAnchor.maxExtraRead` | 5 | 5 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.unifiedTier` | true | true | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.keepSessionFiles` | 0 | 0 | ❌ 未暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 高级折叠（数据与备份） |
| `store.peakSchedule.enabled` | false | false | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.peakSchedule.peak.start` | 09:00 | 09:00 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.peakSchedule.peak.end` | 18:00 | 18:00 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.peakSchedule.peak.sliderPos` | 10 | 10 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.peakSchedule.valley.sliderPos` | 100 | 100 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.participationMode` | probability | ai | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.aiJudge.enabled` | false | true | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.aiJudge.passMarker` | [[PASS]] | [[PASS]] | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.aiJudge.minGapSec` | 0 | 0 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.limits.maxMessagesPerHour` | 2000 | 2000 | ✅ 已暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持 |
| `store.contextSliderPos` | 无默认（派生） | 25 | ◐ 半暴露 | 06:862–933（参与策略）；09:632–668（档位参数）；06:1002（峰谷） | 保持（滑条入口） |

### `globalBlocklist`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `globalBlocklist` | [0] | [296] | ◐ 半暴露 | 10-feedback:302,426–433 | 保持（现有入口） |

### `communityExemptions`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `communityExemptions` | [0] | [0] | ❌ 未暴露 | — | 高级折叠 |

### `commandMute`（3 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `commandMute.enabled` | true | true | ✅ 已暴露 | 08:1448–1451 | 保持 |
| `commandMute.command` | /安静 | /安静 | ✅ 已暴露 | 08:1448–1451 | 保持 |
| `commandMute.durationMin` | 30 | 30 | ✅ 已暴露 | 08:1448–1451 | 保持 |

### `memory`（5 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `memory.consolidateEnabled` | true | true | ✅ 已暴露 | 06:387–410；08:1240–1245 | 保持 |
| `memory.consolidateMinIntervalMs` | 21600000 | 21600000 | ✅ 已暴露 | 06:387–410；08:1240–1245 | 保持 |
| `memory.useChatModel` | true | true | ✅ 已暴露 | 06:387–410；08:1240–1245 | 保持 |
| `memory.provider` | （空） | （空） | ✅ 已暴露 | 06:387–410；08:1240–1245 | 保持 |
| `memory.model` | （空） | （空） | ✅ 已暴露 | 06:387–410；08:1240–1245 | 保持 |

### `tools`（10 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `tools.enabled` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.crossChatSend` | false | false | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.messaging` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.sticker` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.query` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.memory` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.web` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.knowledge` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.media` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |
| `tools.categories.system` | true | true | ✅ 已暴露 | 06:1646–1780；07:198–243 | 保持 |

### `extensions`（1 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `extensions.hotReload` | true | true | ❌ 未暴露 | — | 不必暴露（开发项，需重启） |

### `server`（4 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `server.port` | 3210 | 3210 | ❌ 未暴露 | 06:1080–1095；08:1457–1459 | 不必暴露（安装期） |
| `server.token` | （空） | （线上无） | ❌ 未暴露 | 06:1080–1095；08:1457–1459 | 不必暴露（安装期，改 JSON） |
| `server.autoStart` | false | false | ✅ 已暴露 | 06:1080–1095；08:1457–1459 | 保持 |
| `server.closeToTray` | true | true | ✅ 已暴露 | 06:1080–1095；08:1457–1459 | 保持 |

### `ui`（3 项）

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `ui.theme` | dark | dark | ✅ 已暴露 | 06:1085–1095；08:1464–1466 | 保持 |
| `ui.showVision` | true | true | ✅ 已暴露 | 06:1085–1095；08:1464–1466 | 保持 |
| `ui.refreshMs` | 15000 | 15000 | ✅ 已暴露 | 06:1085–1095；08:1464–1466 | 保持 |

## 4. 插件设置（15 项）

smart-wake 与 token-saver 的设置**有入口**：`工具与技能 → 插件` 卡片的 ⚙（`06-settings-render.js:1489`），
弹窗按 `configSchema` 自动渲染（`06-settings-render.js:1216`–`1240`），保存走 `POST /api/skills/<id>`（`06:1333`）。
入口存在，但**不在设置页**，用户从「设置」找不到——这是「很多配置不暴露」的主要观感来源（见 7.2 问题 6）。

| 配置键 | 默认值 | 线上值 | UI | 控件/证据 | 建议 |
|---|---|---|---|---|---|
| `smart-wake.enabled` | false | true | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.threshold` | 4 | 5 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.escalateThreshold` | 5 | 6 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.minChars` | 6 | 6 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.cooldownSec` | 90 | 180 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.hourlyCap` | 12 | 6 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.dailyCap` | 60 | 30 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.continuationSec` | 120 | 120 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.repeatWindow` | 12 | 12 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `smart-wake.suppressSpam` | true | true | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `token-saver.enabled` | true | true | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `token-saver.keepLast` | 40 | 200 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `token-saver.charBudget` | 12000 | 0 | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `token-saver.localPolicy` | false | false | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |
| `token-saver.countUsage` | true | true | ✅ 已暴露（技能设置弹窗） | 06:1216–1240 / 06:1489 ⚙ / 保存 06:1333 | 保持（入口过深，见 IA 问题 6） |

## 5. 未暴露与半暴露全量清单

### 5.1 ❌ 未暴露 36 项（按建议分组）

**建议新增控件（2 项）**

| 配置键 | 默认值 | 线上值 | 建议 |
|---|---|---|---|
| `webSearch.maxResults` | 6 | 6 | 暴露（搜索页） |
| `security.browseLock.enabled` | false | false | 暴露（安全） |


**建议折叠进「高级」（28 项）**

| 配置键 | 默认值 | 线上值 | 建议 |
|---|---|---|---|
| `api.timeoutMs` | 180000 | 180000 | 高级折叠 |
| `api.thinkingBudget` | 0 | 0 | 高级折叠 |
| `webSearch.deepseek.baseUrl` | https://api.deepseek.com/responses | https://api.deepseek.com/responses | 高级折叠 |
| `webSearch.deepseek.timeoutMs` | 60000 | 60000 | 高级折叠 |
| `webSearch.zhipu.baseUrl` | https://open.bigmodel.cn/api/paas/v4/web_… | https://open.bigmodel.cn/api/paas/v4/web_… | 高级折叠 |
| `webSearch.zhipu.count` | 10 | 10 | 高级折叠 |
| `webSearch.zhipu.timeoutMs` | 20000 | 20000 | 高级折叠 |
| `webSearch.bocha.baseUrl` | https://api.bochaai.com/v1/web-search | https://api.bochaai.com/v1/web-search | 高级折叠 |
| `webSearch.bocha.count` | 10 | 10 | 高级折叠 |
| `webSearch.bocha.timeoutMs` | 20000 | 20000 | 高级折叠 |
| `webSearch.baidu.baseUrl` | https://qianfan.baidubce.com/v2/ai_search… | https://qianfan.baidubce.com/v2/ai_search… | 高级折叠 |
| `webSearch.baidu.count` | 6 | 6 | 高级折叠 |
| `webSearch.baidu.timeoutMs` | 20000 | 20000 | 高级折叠 |
| `webSearch.metaso.baseUrl` | https://metaso.cn/api/open/v1/search | https://metaso.cn/api/open/v1/search | 高级折叠 |
| `webSearch.metaso.count` | 6 | 6 | 高级折叠 |
| `webSearch.metaso.timeoutMs` | 20000 | 20000 | 高级折叠 |
| `security.allowPrivateImageHosts` | false | true | 高级折叠 |
| `security.browseLock.hosts` | [0] | [0] | 高级折叠 |
| `security.browseLock.siteSearchUrl` | （空） | （空） | 高级折叠 |
| `send.byLengthMs` | 20 | 20 | 高级折叠 |
| `send.hardSplitAt` | 4000 | 4000 | 高级折叠 |
| `send.dedupeWindowMs` | 8000 | 8000 | 高级折叠 |
| `proactive.idleThresholdMs` | 1800000 | 1800000 | 高级折叠 |
| `sticker.collectEnabled` | true | true | 高级折叠 |
| `sticker.maxCollectPerHour` | 10 | 10 | 高级折叠 |
| `store.maxMessagesPerChat` | 0 | 0 | 高级折叠 |
| `store.keepSessionFiles` | 0 | 0 | 高级折叠（数据与备份） |
| `communityExemptions` | [0] | [0] | 高级折叠 |


**建议不暴露（6 项）**

| 配置键 | 默认值 | 线上值 | 建议 |
|---|---|---|---|
| `providersSourceYaml` | （空） | （空） | 不必暴露（迁移用） |
| `deny.groups` | [0] | [0] | 不必暴露（由屏蔽名单替代） |
| `deny.private` | [0] | [0] | 不必暴露（由屏蔽名单替代） |
| `extensions.hotReload` | true | true | 不必暴露（开发项，需重启） |
| `server.port` | 3210 | 3210 | 不必暴露（安装期） |
| `server.token` | （空） | （线上无） | 不必暴露（安装期，改 JSON） |


### 5.2 ◐ 半暴露 13 项

| 配置键 | 默认值 | 线上值 | 建议 |
|---|---|---|---|
| `providers` | [0] | [0] |  |
| `webSearch.providers` | [0] | [0] |  |
| `webSearch.custom.name` | （空） | （空） |  |
| `webSearch.custom.type` | openai | openai |  |
| `webSearch.custom.baseUrl` | （空） | （空） |  |
| `webSearch.custom.apiKey` | （空） | （已脱敏） |  |
| `webSearch.custom.model` | （空） | （空） |  |
| `webSearch.custom.count` | 6 | 6 |  |
| `webSearch.custom.timeoutMs` | 20000 | 20000 |  |
| `store.contextTier` | 4 | 3 |  |
| `store.randomPercent` | 10 | 7.1 |  |
| `store.contextSliderPos` | 无默认（派生） | 25 |  |
| `globalBlocklist` | [0] | [296] |  |


## 6. 默认 schema 与线上键集的偏差

| 键 | 现象 | 影响 | 建议 |
|---|---|---|---|
| `wakeTierPos` | 出现在 `/api/config` 输出，但全仓无读点（`deploy/OPERATIONS.md` 也已注明废弃） | 用户会以为改它有效 | 从默认配置与 `/api/config` 输出中移除 |
| `store.contextSliderPos` | 线上有值（25），但 `DEFAULT_CONFIG.store` 未声明默认；判定实际用 `contextTier` | 新装/默认枚举里看不见真正的滑条值 | 补默认值（或明确它由迁移脚本写入） |
| `blocklist` | 线上存在（按会话的成员屏蔽），但默认配置未声明 | 新装读 `cfg.blocklist` 为 undefined（UI 有兜底） | 补空对象默认 |
| `api.modelPrices` | 价格编辑弹窗会写入，默认配置未声明 | 价格匹配依赖它，默认不可见 | 补空对象默认 |
| `api.hasApiKey` / `api.hasKey` | sanitize 产生的只读标记（`src/app.js:1226`、`1270`–`1271`） | 前端把它当配置读，但它不可写 | 文档标注只读；高级区过滤掉 |
| `dshProviderKeyPresence` | 线上派生字段（供 UI 显示密钥是否存在） | 同上 | 高级区过滤掉 |

## 7. 信息架构与导航审计

### 7.1 现状

| 层 | 现状 | 证据 |
|---|---|---|
| 顶栏页签 | 8 个平铺：会话 / 存档 / 记忆 / 用量 / 技能 / 插件 / SnowLuma / 设置 | `ui/index.html:73`–`80` |
| 视图 | 7 个 view section（会话页签复用会话视图） | `ui/index.html:107`–`153` |
| 顶栏状态区 | 4 个就绪圆点 + OneBot/模型/今日用量/搜索次数 4 段文本 | `ui/index.html:33`–`60`；渲染 `01-boot:4`–`64` |
| 设置页布局 | 左侧 240px 固定侧栏 + 右侧内容面板（两栏） | `ui/style.css:948`–`965` |
| 设置 section | 10 个平铺：模型 API / 搜索服务 / 记忆 / 人设 / 聊天白名单 / 参与策略 / 聊天设置 / 桌面端 / OneBot（SnowLuma）/ 工具与技能 | `06-settings-render.js:41`–`52` |
| 保存语义 | section 内表单：600ms 防抖自动保存；弹窗与快捷入口：保存按钮直发 | `07:33`–`40`、`07:107`–`115`；反例 `06:563`、`09:545`、`10-feedback:426` |

### 7.2 问题清单（每条可判定）

| # | 问题 | 证据（文件:行） | 可判定描述 |
|---|---|---|---|
| 1 | 设置页过长、无分组 | `06:41`–`52`（10 个 section 平铺）；`06:935`–`1077`（聊天设置一个 section 内 8 类卡片，含峰谷 `06:1002`） | 用户要在 10 个入口中线性找 30+ 项；没有「连接/行为/人设/数据」的上层分组 |
| 2 | 设置页无搜索；技能页有 | 设置侧栏 `06:35`–`90` 只有菜单；全项目无设置搜索输入（唯一命中是章节 id `06:270`「搜索服务」，语义还撞车）；技能页有 `data-search` 过滤 `06:1494`、`06:1625` | 两个页面同类能力不一致；设置项多了只能靠滚 |
| 3 | 无锚点/深链，体检卡不能一键定位 | `00-core.js:816`（`switchTab('settings')` 只载入整页）；体检卡 `fix: 'settings-api'/'settings-allow'`（`00-core:704`、`00-core:720`）从未被用于跳转；`switchTab` 不解析 hash/query | 就绪度体检说「缺接口地址/白名单」，用户仍需自己在 10 个 section 里找 |
| 4 | 同一配置多入口，改一处不知道另几处 | 响应滑条：`06:882`（参与策略）与 `06:1008`（聊天设置）都挂 `#ac-editor`；关键词：`06:900`（`#pm-keywords`）与 `09:643`（`#tp-keywords`）；已读历史条数：`06:928`、`09:634`、`09:657` | 三个值各有 2–3 个编辑入口，保存后另一处需要重渲染才同步 |
| 5 | 保存语义不一致 | 防抖自动保存 `07:33`–`40`、`07:107`–`115`；保存按钮直发：`06:563`（单聊人设）、`06:651`（峰谷）、`09:545`/`09:652`（档位参数）、`10-feedback:426`（屏蔽名单）、`06:1605`（技能开关） | 用户无法预判「改了就生效，还是要按保存」；弹窗取消后设置页可能仍是旧值 |
| 6 | 插件设置在设置页无入口 | smart-wake/token-saver 共 15 键只能在 `工具与技能 → 插件` 卡片 ⚙（`06:1489`、弹窗 `06:1216`–`1240`、保存 `06:1333`）打开 | 「设置」页搜不到任何插件参数；用户以为这些配置不存在 |
| 7 | 窄屏挤压 | 侧栏固定宽 `.settings-sidebar{width:240px;flex:0 0 240px}`（`style.css:948`）；820px 媒体查询只隐藏顶栏副标题与参与策略卡片网格（`style.css:1782`、`style.css:1808`），无「侧栏转顶部横向/抽屉」规则；顶栏 8 页签无溢出规则（`index.html:73`–`80`） | 1366 以下宽度时右侧表单被压窄、顶栏页签横向溢出 |
| 8 | 状态显示误导 | 见 7.3 | 后端已连接时，界面仍有「未连接/未运行/未就绪」字样或红点 |
| 9 | 顶栏状态「只读且挤」 | `01-boot:66`–`72` 只有 2 个圆点可点击；4 段文本无交互；就绪圆点与文本 label 表达同一件事（连接）却来自两套判定（圆点 `01-boot:46`–`57`，label `01-boot:13`–`16`） | 信息密度高但可操作性低，且两处口径不一致时会自相矛盾 |
| 10 | 部分 section 无法定位 | 有 id 的只有 7 个（`06:189`、`270`、`394`、`690`、`862`、`1121`、`1738`）；无 id：人设 `06:462`、聊天设置 `06:939`、桌面端/界面/数据管理/版本更新 `06:1080`–`1111` | 不能深链到人设/聊天/数据管理；「数据管理」没有独立 section 只有子标题 |
| 11 | 默认配置与线上键集偏差 | 见第 6 节 | 用户手改 `/api/config` 时会被废弃字段误导 |
| 12 | 无「高级」承载 | 36 个未暴露键没有任何页面入口；也没有只读环境项说明 | 想调 `api.timeoutMs`/`send.dedupeWindowMs` 等只能改 JSON 文件 |

### 7.3 「后端 `/api/status` 已 `onebot.connected=true`、UI 却显示未连接」根因

**结论：`/api/status` 没有错；UI 把两套不同语义混成一套「连接状态」，再叠加首屏占位与静默失败。**

| 环节 | 事实 | 证据 |
|---|---|---|
| 数据源混了两套语义 | 同一个 `/api/status` 既返回 `onebot.connected`（OneBot WS 真实可用），又返回 `snowluma.running` / `qqPortable.running`（**本机进程管理器**视角）；`snowluma.running` 靠探测本机 WebUI 端口得出 | `src/routes.js:89`–`140`（尤其 `98`–`101` 的端口探测） |
| 线上实测 | `onebot.connected=true`、`everConnected=true`、`self.nickname` 有值；同时 `snowluma.running=false`、`snowluma.dir=""`、`qqPortable.running=false`、`qqPortable.ready=false` → 连接来自**外部 OneBot/NapCat**，不归本机 SnowLuma 管理器管 | 审计时对 `/api/status` 的两次实测（AT 数据面 + 回环直连，结果一致） |
| UI 表现 1：顶栏圆点 | QQ 内核 / SnowLuma 两个圆点按进程视角判红，只有 OneBot 圆点绿；用户看到「两个红点」 | `01-boot.js:43`–`57` |
| UI 表现 2：SnowLuma 页 | 「快速启动」区只在 `!onebotConnected` 时显示（`03-snowluma.js:117`）→ 已连接时既不显示启动入口，也不说明「连接来自外部地址」；页面同时把 QQ 内核/SnowLuma 渲染成「未启动/未运行」 | `03-snowluma.js:68`–`69`、`117`、`155`–`165` |
| UI 表现 3：永久「未连接」 | 顶栏 `#onebot-label` 的初始文本是「OneBot 未连接」（静态 HTML）；`refreshStatus()` 的异常被全吞（`01-boot.js:29`），轮询 `startStatusPoller()` 只在 init 成功路径启动（`11-init.js:39`–`45`）；init 若在 `bootLoop` 前抛错即被 catch（`11-init.js:50`–`56`），轮询不启动 → 占位文本永久停留 | `index.html:40`、`01-boot.js:4`–`29`、`11-init.js:39`–`56` |
| 放大因素 | 状态轮询间隔 `ui.refreshMs=15000`；状态 SSE 事件只在部分场景触发；首屏若在 OneBot 连上之前加载，label 会先显示未连接且没有「检查中」过渡 | `02-sse-sessions.js:131`、`00-core.js:678`–`688` |

**正确做法**：状态卡拆成三段——① 连接（`onebot.connected`，唯一决定「能不能干活」）；② 连接来源（本机 SnowLuma / 外部 WS 地址，来自配置与进程探测）；
③ 本机 QQ/SnowLuma 进程（只在启用本机管理模式时显示，且措辞为「未托管」而不是「未连接」）。
同时：label 初始值改「正在检查连接…」；`refreshStatus` 失败要可见（错误文案 + 重试按钮 + 最后成功时间）；轮询与 SSE 不依赖 init 成功（失败也启动）。

### 7.4 新分组方案（6 组 + 高级）

| 新分组 | 承载现有 section/页签 | 新增承载 | 工作量 | 风险 |
|---|---|---|---|---|
| 连接与模型 | `api`（模型 API/模型管理弹窗）、`onebot`（地址/令牌）、顶栏状态卡 | 连接来源说明、诊断、模型连通性测试入口 | S | 低 |
| 聊天行为与参与策略 | `participation`、`chat`（活跃/发送节奏/主动发言/表情/命令静音）、`allow`（白名单）、`chatActive` | 滑块/关键词/historyCount 各收敛为**一个**编辑入口 | M | 中（需保留旧入口重定向） |
| 人设与记忆 | `persona`（含 customPersonas、personaByChat）、`memory` | — | S | 低 |
| 搜索与工具 | `search`、`tools`、**插件设置**（smart-wake/token-saver 的 15 键提到设置页） | 搜索 provider 高级参数（count/timeout/baseUrl） | M | 中（插件设置与技能页去重：技能页保留运维视图，设置页保留参数视图） |
| 数据与备份 | `desktop` 里的数据管理/版本更新、`store.keepSessionFiles` | 备份/导出说明、数据目录、保留策略 | S | 低 |
| 高级 | —（新） | 未暴露 36 项中折叠进高级的 28 项（schema 表单）+ 只读环境项说明 | M | 中（表单需按类型校验；敏感项留空=不改） |

分组原则：按「使用频率 × 危险度」排序；每组 section 数 ≤6，超出再折叠；「高级」默认收起并在顶部写明「改错会影响运行」。

### 7.5 设置搜索 / 锚点 / 高级区

- **搜索**：设置侧栏顶部输入框，索引「组名 + section 标题 + 字段 label + 配置键（如 `api.timeoutMs`）」；命中后滚动到字段并高亮 2 秒。
  技能页已有同款本地过滤实现（`06:1494`、`06:1625`），设置页需要给每个字段加 `data-key` 才能按配置键搜到。
- **深链**：`#settings/<section>[/<field>]`；`switchTab('settings')` 解析 hash 后定位。体检卡 `fix`（`00-core.js:704`、`720`）直接变成跳转目标。
- **高级区**：schema 驱动表单（boolean / number / enum / string），敏感项密码框且「留空=不修改」（与技能设置弹窗同一约定，`06:1216`–`1240`）；
  保存仍走 `POST /api/config`（深度合并）；只读/环境项（`server.port`、`server.token`、`extensions.hotReload`、`providersSourceYaml`）只展示来源与命令行示例。

## 8. 建议的下一步（按优先级）

| 优先级 | 改什么 | 为什么 | 验收判据 | 工作量 |
|---|---|---|---|---|
| P0 | 状态显示修复：状态卡拆三段；label 初始「正在检查」；`refreshStatus` 失败可见；轮询无条件启动 | 现在的错误观感直接损伤信任，且会让人误以为机器人没连上 | ① 外部 OneBot 场景下，顶栏显示「已连接（nickname）」；② SnowLuma 页显示「连接来源：外部 WS，未托管本机 SnowLuma」，不再出现「未连接」红点；③ 断开 `/api/status` 两次后页面出现错误提示与重试 | S |
| P1 | 设置搜索 + 深链锚点 | 10 个 section + 30+ 字段靠滚动找不到；体检卡无法定位 | ① 搜「温度」能定位到 `api.temperature`；② 打开 `#settings/persona` 直达人设组；③ 体检卡点击跳到对应字段 | S |
| P2 | 六组重排 + 去重（滑块/关键词/historyCount 各留一个家） | 信息架构是本次用户主诉；重复入口会造成「改 A 显示 B」 | ① 6 组按顺序出现，旧 section 全部可达；② 三个重复值各只剩 1 个可编辑控件，另处只读或联动；③ 窄屏（1280/1024）无横向溢出 | M |
| P3 | 插件设置入口提升 + 高级区 | 15 个插件设置在设置页不可见；36 个未暴露键无入口 | ① 设置页出现「插件设置」条目可进 smart-wake/token-saver；② 高级区能改 `api.timeoutMs`/`send.dedupeWindowMs` 等并回读一致；③ 敏感项留空保存不覆盖 | M |
| P4 | 顶栏信息架构 + 窄屏（状态收进下拉/抽屉；页签分组） | 8 页签 + 状态区在窄屏挤压；状态只读 | ① 1024 宽下页签不溢出；② 状态区点击可展开诊断 | M |
| P5 | schema 对齐：移除 `wakeTierPos`，补 `contextSliderPos`/`blocklist`/`modelPrices` 默认与只读标注 | 用户手改 JSON 会被废弃字段误导；新装行为与线上不一致 | `DEFAULT_CONFIG` 键集与线上 `/api/config` 差异为空（脱敏元数据除外） | S |

## 9. 复现命令（只读）

在运行 AIChat 的主机上：

```bash
curl -s http://127.0.0.1:3210/api/config   # 敏感字段已脱敏
curl -s http://127.0.0.1:3210/api/status   # 对照 onebot.connected 与 snowluma/qqPortable
curl -s http://127.0.0.1:3210/ | sed -n '73,80p'   # 顶栏页签
curl -s http://127.0.0.1:3210/app/03-snowluma.js | sed -n '110,170p'   # 快速启动区与状态行
```
