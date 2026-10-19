# 在 noco 上部署 AIChat

无头部署（不装 Electron、不跑 Windows 协议端）。QQ 协议端由 NapCat 容器提供，
AIChat 只做一个 OneBot v11 客户端。

## 落点

| 项 | 路径 |
|---|---|
| 代码检出 | `/opt/aichat/app`（`chat` 分支） |
| 可写数据 | `/var/lib/aichat/data`（`QQ_AGENT_DATA_DIR`：config / sessions / messages / memory） |
| systemd 单元 | `/etc/systemd/system/aichat.service`（本源 `aichat.service`） |
| 控制台 | `127.0.0.1:3210`（只回环，经 SSH 隧道） |

**代码与数据分离**是热更新的前提：更新只动检出，数据一个字节都不碰。

## 首次部署

```bash
sudo bash deploy/install.sh
```

前提：node ≥ 20、git、curl；NapCat 已在 `127.0.0.1:3001` 提供 OneBot。
部署后控制台是空的配置，需要在里面填模型 API、白名单群、响应档位。

## 更新（热更新）

```bash
sudo bash /opt/aichat/app/deploy/update.sh
```

一次更新做这些事，任一步失败自动回滚到原提交：

1. 校验：分支必须是 `chat`、工作区必须干净（有本地改动就拒绝，不悄悄丢掉）
2. `git fetch` + **`--ff-only`**（分叉时不硬来）
3. `package.json` / `package-lock.json` 变了才 `npm install`
4. `systemctl restart aichat`
5. 健康检查（控制台 30 秒内没应答就回滚并重启旧版，回滚后再探一次并如实报告）

**为什么重启是安全的**：消息经 OneBot 到达后先写进 `messages/*.json` 并带 `read` 标记；
进程重启期间来的消息留在存档里标记未读，起来后轨道器会自己补处理 —— 不丢消息。
所以这里的「热更新」= 代码原子切换 + 秒级重启，不是进程内改代码。

要让更新真正「不影响运行」，两条前提成立即可：
- 更新窗口（约 2–5 秒）内到达的消息不丢（上面的存档机制保证）
- 回滚是自动的：新版本启动后健康检查不过就退回旧提交

### 自动更新

定时器可选，按需开启：

```bash
# /etc/systemd/system/aichat-update.service + .timer
systemctl enable --now aichat-update.timer   # 见 update.timer
```

## 控制台访问

控制台硬编码只监听 `127.0.0.1`，只能经隧道访问：

```bash
ssh -f -N -L 3210:127.0.0.1:3210 vps
# 浏览器打开 http://127.0.0.1:3210
```

## 回滚

```bash
sudo -u vesita git -C /opt/aichat/app log --oneline -5
sudo -u vesita git -C /opt/aichat/app reset --hard <sha>
sudo systemctl restart aichat
```
