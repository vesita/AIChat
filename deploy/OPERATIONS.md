# AIChat 部署运维手册

## 部署形态

| 项 | 值 |
|---|---|
| 代码检出 | `/opt/aichat/app`（`chat` 分支） |
| 可写数据 | `/var/lib/aichat/data`（`QQ_AGENT_DATA_DIR`） |
| AIChat 服务 | `aichat.service`（系统级，`127.0.0.1:3210`） |
| NapCat 服务 | `napcat.service`（**用户级** quadlet，`systemctl --user`） |
| 协议端端口 | OneBot **WS** `127.0.0.1:3001`（AIChat 连接）+ **HTTP API** `127.0.0.1:3002`（发送/查询）；`snowluma.wsUrl` / `snowluma.httpUrl` 两个都要配 |
| 机器人账号 | `<BOT_QQ>`（昵称由 QQ 侧决定） |
| 模型 | `deepseek-flash` @ `<MODEL_BASE_URL>` |
| 白名单 | 群 `<GROUP_ID_1>`（主群）、`<GROUP_ID_2>`（次群）；私聊 `<OWNER_QQ>` |

只填 ws 不填 http 是最常见的半通故障：WS 绿、发送 404。

## 控制台访问与鉴权

控制台只监听 `127.0.0.1:3210`。**鉴权由前置网关（AccessTrust）或 SSH 隧道承担，本应用不内建鉴权**：
`server.token` 保持空串。从远端访问控制台时，把 `/aichat/` 挂到 AT 后面，或在本机建隧道：

```bash
ssh -L 3210:127.0.0.1:3210 vps    # 然后浏览器打开 http://127.0.0.1:3210
```

`/api/qq-login/*`（扫码登录）额外只接受**回环来源**（判据是 `req.socket.remoteAddress`），
因为二维码等价于「可登录机器人账号」的凭据。经同机网关或 SSH 隧道转发时来源仍是回环，不受影响；
若把控制台挂到**另一台**机器上的网关后面，这几个接口会返回 403，需要按网关地址放行。

`server.token` 只在没有网关的裸部署里使用：非空时全部 `/api/*` 与 SSE 都要求
`x-console-token` 头或 `?token=`（前端从 `?token=` 读一次存 `sessionStorage`）。

## 改配置：热更新，不用重启

AIChat 的 `getConfig()` 有模块级缓存，**直接改 `config.json` 不会生效**。
走 HTTP API 才会即时刷新内存态并落盘：

```bash
curl -X POST http://127.0.0.1:3210/api/config \
  -H 'content-type: application/json' \
  -d '{"allow":{"groups":["<GROUP_ID_1>","<GROUP_ID_2>"],"private":["<OWNER_QQ>"]}}'
```

`POST /api/config` 是**整块替换**语义：改 `allow` 要连 `groups` 和 `private` 一起给，
只给一半会把另一半清空。

改完用 `GET /api/config` 读回内存态确认（它读的就是运行中的那份，不是磁盘）。

## 常用操作

```bash
# 服务状态
systemctl is-active aichat
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active napcat.service

# 机器人登录与在线状态（NapCat HTTP API，3002）
curl -s -X POST http://127.0.0.1:3002/get_status -d '{}' -H 'content-type: application/json'

# 看最近收到的消息（实时）
XDG_RUNTIME_DIR=/run/user/1000 journalctl --user -u napcat -f | grep -E '接收 <-|发送 ->'

# 存档（每条消息带 read 标记）
ls /var/lib/aichat/data/messages/
# 会话留档（含提示词、工具调用、token 用量）
ls -t /var/lib/aichat/data/sessions/ | head

# 更新代码（热更新：ff-only + 健康检查 + 失败自动回滚）
sudo bash /opt/aichat/app/deploy/update.sh
```

## NapCat 重启免扫码

三条缺一不可（详见 TROUBLESHOOTING.md）：持久化 `/app/.config/QQ`、
固定 MAC、`NAPCAT_QUICK_ACCOUNT` + `NAPCAT_QUICK_PASSWORD`。

密码在 `keys` 仓的 `aichat.qq-password`（密文），由 quadlet 的
`EnvironmentFile=%h/napcat/napcat.env` 注入（0600，不进任何仓）。

修复/重装容器定义：

```bash
sudo bash /opt/aichat/app/deploy/install-napcat-unit.sh
```

**不要用 `podman restart`**：QQ 不响应 SIGTERM，podman 10 秒后 SIGKILL，登录态会丢。
用 `systemctl --user restart napcat.service`（单元里有 `TimeoutStopSec=90`）。

## 成本观察

当前响应档位是默认的「全响应」—— 群里每条消息都会触发一次 LLM 调用。
要用 `deepseek-flash` 观察成本，看会话留档里的 `usage`：

```bash
python3 - <<'PY'
import json, glob, time
tot = {"promptTokens":0,"completionTokens":0,"totalTokens":0,"cachedTokens":0,"calls":0}
for f in glob.glob("/var/lib/aichat/data/sessions/*.json"):
    u = json.load(open(f)).get("usage") or {}
    for k in tot: tot[k] += int(u.get(k) or 0)
print(tot)
PY
```

觉得太吵就调档位（0-10 仅 @；10-20 +关键词；20-90 概率；90-100 全响应）：

```bash
curl -X POST http://127.0.0.1:3210/api/config \
  -H 'content-type: application/json' -d '{"store":{"contextSliderPos":15}}'
```

`wakeTierPos` 是**废弃字段**（全仓没有读点），传它不会生效；真正的开关是 `store.contextSliderPos`。

## 人设：两层各管什么

- **roleText**（`src/personas.js`）：身份 + 硬边界，约 350 字，每轮注入用户提示【角色设定】。
  ⚠️ 线上生效的是 `data/config.json` 里的 `persona.roleText`：**改代码里的默认值只影响全新安装**，
  已有部署要 `POST /api/config` 把新文本写进去（或从新代码取 `PERSONAS.xiaojingyu.text` 再 POST），
  否则看到的还是旧角色卡。
- **systemPromptOverride**（`deploy/personas/xiaojingyu-friendly.md`）：语气、开口、例子、自检。
  用 `bash deploy/apply-persona.sh` 注入；脚本会先备份到 `data/persona-backup-*.json` 再验证。
- 两层**不要重复写同一件事**（机制类内容由 `toolProtocol()` 等承担）；重复会被同时注入，既浪费 token 又互相打架。

## 自带插件（`plugins/`，确定性型）

| 插件 | 提供 | 默认 | 开关 |
|---|---|---|---|
| `smart-wake` | `reply.interest-judge` | 技能已启用，但**行为开关 `enabled=false`** | `POST /api/skills/smart-wake -d '{"settings":{"enabled":true}}'` |
| `token-saver` | `reply.local-policy`、`before-llm-messages`、`llm.usage` | 历史裁剪开（`keepLast=40`、`charBudget=12000`）；**收尾策略 `localPolicy=false`** | `POST /api/skills/token-saver -d '{"settings":{...}}'` |

`smart-wake` 打开后会在「核心判定说不接」时用本地启发式决定要不要接（问句/延续对话加分，刷屏/复读/命令抑制，
每群 90s 冷却、每小时 12 条/每天 60 条上限）；觉得变吵就调高 `escalateThreshold` 或关 `settings.enabled`。
`token-saver` 的 `before-llm-messages` 只裁【已读信息】最旧部分，不碰未读/当前触发批/工具消息。

## 参与策略：什么时候开口（三选一）

`store.participationMode` 是唯一的选择入口（控制台「设置 → 参与策略」也是写它）：

| 模式 | 判定 | 用到的参数 |
|---|---|---|
| `probability`（默认） | 按响应滑条的档位 + 随机概率（1 档仅 @ / 2 档 +关键词 / 3 档 +随机 / 4 档全响应） | `store.contextSliderPos` |
| `ai` | 群聊里**非定向**消息全部交给模型自己判断要不要接；定向消息（@ / 拍一拍 / 私聊）必回 | `store.aiJudge.*` |
| `directed` | 只回 @ / 拍一拍 / 关键词命中 / 私聊；不随机、不看滑条 | `store.keywords` |

- 旧配置没有 `participationMode` 时按 `probability` 处理（行为与旧版一致）。
- `ai` 模式下系统提示会自动追加一段【群聊参与守则（自动判断）】：模型判断"这轮不接"时
  **只输出 `store.aiJudge.passMarker`**（默认 `[[PASS]]`），核心在回复安全网（rescue）之前识别并
  丢弃 —— 不发送、不抢救、本批消息标已读，会话的 `contextReason` 记为「AI 判定不接」。
- `store.aiJudge.minGapSec > 0` 时，同群两次 AI 判定至少间隔这么久（秒）；间隔内到达的消息
  照常进未读，等下一条触发时一起判定（防止消息风暴里每句都调模型）。
- `ai` 模式下不再咨询 `reply.interest-judge`（smart-wake）：两套判定同时开会互相打架。
  想用 AI 判定就关掉 smart-wake 的行为开关，反之亦然。
- 关键词（`store.keywords`）只在 `directed` 模式与 `probability` 的 2 档生效；`ai` 模式下
  关键词不再单独触发（都交给模型判断）。

开启 AI 判定（也可以直接在控制台「参与策略」里点选，二者等价）：

```bash
curl -X POST http://127.0.0.1:3210/api/config -H 'content-type: application/json' \
  -d '{"store":{"participationMode":"ai","aiJudge":{"enabled":true,"passMarker":"[[PASS]]","minGapSec":0}}}'
```

切回固定概率 / 仅定向（记得同步关掉 `aiJudge.enabled`，控制台会自动同步）：

```bash
curl -X POST http://127.0.0.1:3210/api/config -H 'content-type: application/json' \
  -d '{"store":{"participationMode":"probability","aiJudge":{"enabled":false}}}'
```

## 出站硬上限（安全保险丝：2000 条 / 滚动 1 小时）

`store.limits.maxMessagesPerHour`（默认 **2000**，`0` = 不限）是**全局**出站闸门，
在唯一发送出口 `src/sender.js`（SendQueue）里生效：

- **滚动窗口**：不是自然小时。每次发送前剔除 1 小时前的记录，窗口内计数 `>=` 上限就拒绝。
- **只计成功发送**：文本 / 图片 / 表情 / 媒体 / 拍一拍 / 提醒，凡真正发到 QQ 的都计入；
  失败与去重跳过的**不计**。所有会话共享同一份计数（不是每群 2000）。
- **拒绝语义**：不排队、不重试，立即返回结构化错误（`error.code = 'OUTBOUND_HARD_LIMIT'`，
  带 `limit` / `count`）；工具调用方会把这句错误回给模型。
- **并发安全**：检查与"占额度"在同一段同步代码里完成（成功后转正式计数、失败释放），
  多会话并发发送也不会超出上限。

调上限：

```bash
curl -X POST http://127.0.0.1:3210/api/config -H 'content-type: application/json' \
  -d '{"store":{"limits":{"maxMessagesPerHour":500}}}'      # 收紧到 500
# -d '{"store":{"limits":{"maxMessagesPerHour":0}}}'        # 关闭上限（不建议）
```

触发时的现象与排查：

- 日志关键字：`[sender] 出站硬上限已触发：滚动 1 小时内已成功发送 N 条（上限 M），本次发送被拒绝`
  —— **同一自然小时只打一次**，不会刷屏。
- 表现：机器人突然不说话了，会话/工具结果里能看到「出站硬上限：滚动 1 小时内最多发送 M 条消息」；
  未读标记与其它会话不受影响，等窗口滚过（旧记录满 1 小时）后自动恢复。
- 先确认是不是真的异常高频（群聊被刷屏 / 模型复读）：看存档里 `self=true` 的条数；
  正常闲聊远到不了 2000/小时，触发即说明有异常放大，先把上限当保险丝而不是当节流阀。
