# AIChat 部署运维手册

## 部署形态

| 项 | 值 |
|---|---|
| 代码检出 | `/opt/aichat/app`（`chat` 分支） |
| 可写数据 | `/var/lib/aichat/data`（`QQ_AGENT_DATA_DIR`） |
| AIChat 服务 | `aichat.service`（系统级，`127.0.0.1:3210`） |
| NapCat 服务 | `napcat.service`（**用户级** quadlet，`systemctl --user`） |
| 机器人账号 | `<BOT_QQ>`（昵称由 QQ 侧决定） |
| 模型 | `deepseek-flash` @ `<MODEL_BASE_URL>` |
| 白名单 | 群 `<GROUP_ID_1>`（主群）、`<GROUP_ID_2>`（次群）；私聊 `<OWNER_QQ>` |

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

# 机器人登录与在线状态
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
