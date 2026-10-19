# AIChat 在 noco 上的运维手册

## 现状（部署形态）

| 项 | 值 |
|---|---|
| 代码检出 | `/opt/aichat/app`（`chat` 分支） |
| 可写数据 | `/var/lib/aichat/data`（`QQ_AGENT_DATA_DIR`） |
| AIChat 服务 | `aichat.service`（系统级，`127.0.0.1:3210`） |
| NapCat 服务 | `napcat.service`（**用户级** quadlet，`systemctl --user`） |
| 机器人账号 | QQ `3874072623` / `dschat` |
| 模型 | `deepseek-flash` @ `https://tokenrhythm.studio/v1` |
| 白名单 | 群 `1075176171`（究竟谁是串子）、`376365247`（幻想乡）；私聊 `2308007975` |

## 改配置：热更新，不用重启

AIChat 的 `getConfig()` 有模块级缓存，**直接改 `config.json` 不会生效**。
走 HTTP API 才会即时刷新内存态并落盘：

```bash
curl -X POST http://127.0.0.1:3210/api/config \
  -H 'content-type: application/json' \
  -d '{"allow":{"groups":["1075176171","376365247"],"private":["2308007975"]}}'
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
  -H 'content-type: application/json' -d '{"wakeTierPos":15}'
```
