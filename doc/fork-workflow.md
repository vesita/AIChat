# Fork 开发与同步指南

这份文档写给**在本仓上打本地补丁、又要持续跟上游**的人。核心只有一句：
`main` 永远等于上游，本地改动只在 topic 分支上、最后合进部署分支 `chat`；
跟上游用 **merge**，绝不 rebase、绝不 force。

> 下游部署方直接看「部署」一节即可；上游地址、部署机、凭据都用占位符，
> 请按自己的环境替换。

## 分支模型

| 分支 | 内容 | 谁写 |
|---|---|---|
| `main` | 上游的镜像，**不提交任何本地改动** | 只由同步/镜像单向更新 |
| `topic/*` | 单个改动的开发分支 | 人 |
| `chat` | `main` + 全部本地补丁，**部署分支** | 只由 merge 前进 |

约定：

- 本地改动**永远不从 `main` 上直接提交**——否则 `main` 追上上游时要么冲突、要么只能 force，
  而 force 会毁掉别人基于它做的分支。
- `chat` 是「已发布的历史」：它的每个提交都可能在生产树上出现过，**只能 merge 前进**。
- 部署树（应用目录）里不改代码。要改就改仓、走下面流程。

## 日常开发

```sh
git fetch origin
git switch -c topic/<改动名> origin/main
# ... 改代码、自测 ...
git add -A && git commit -m "<改动说明>"

# 并入部署分支（merge，不用 rebase）
git switch chat
git merge --no-ff topic/<改动名>
git push origin chat
```

- 一个 topic 分支只做一件事，方便上游变化时单独判断去留。
- 推 `chat` 前确认它是 `origin/chat` 的快进（`git pull --ff-only origin chat`），
  推不上去说明有人在你前面推过，先 ff 再 merge。

## 跟上游同步

上游仓库（在你自己的克隆里加 remote，名字随你，下面用 `upstream`）：

```sh
git remote add upstream <upstream-url>        # 只需一次
git fetch upstream
git switch main
git merge --ff-only upstream/main            # main 只做镜像，正常情况永远能快进
# 上游若改写历史（force push），这里会失败：停下确认，按上游新的历史重建镜像，
# 不要为了绕过去 force push 任何分支
git push origin main
```

然后**先看补丁状态，再合**——上游有时会自己实现你打过补丁的功能（补丁被「吞」），
盲合会出现重复实现或空补丁：

```sh
git range-diff upstream/main...chat          # chat 相对上游多了/少了哪些提交
git log --oneline upstream/main..chat        # 本地补丁清单（应当都还认得出来）
```

- `range-diff` 里某个本地补丁显示为已被上游包含 → 该补丁可以删掉或标注 obsolete，
  在合上游那一步一起处理。
- 本地补丁一个都不认识 → 说明 `chat` 被改写过了，停下查，不要继续合。

确认后再把上游合进 `chat`：

```sh
git switch chat
git merge --no-ff upstream/main
# 解决冲突（见下），跑测试
git push origin chat
```

**为什么 merge 不 rebase**：`chat` 已经发布，部署入口是
`git merge --ff-only`（见下文）。rebase 会改写 `chat` 的提交历史，生产树就再也快进不了；
merge 只增加提交、不动旧历史，部署侧永远能快进。同理：**任何情况下都不 force push**
已发布分支。

## 冲突解决

1. `git status` 看未合并文件；先读两边意图（`git log --oneline -- <文件>`），
   别急着选一边。
2. 手工合并后 `git add <文件>`，再 `git commit`（merge 的提交信息保留「合上游哪个 sha」）。
3. 拿不准就去问上游那个改动是不是覆盖了本地补丁；能删的本地补丁优先删（少一层债）。
4. 解决完在本地跑测试，再推 `chat`。

合并提交信息建议写清来源，回滚时好定位：

```
Merge upstream/main into chat（上游 <sha 前 12 位>）
```

## 部署

部署入口是 `deploy/update.sh`（在部署机的应用目录里跑），它的行为：

1. 要求当前在部署分支（默认 `chat`）且**工作区干净**，否则退出码 `2`（前置不满足）；
2. `git fetch` 后 `git merge --ff-only` 到远端分支 —— 所以部署分支必须是**快进**，
   rebase / force 过的历史在这里直接失败并复位；
3. `package.json` / lockfile 有变才 `npm install --omit=dev`（失败即回滚）；
4. 重启服务，等控制台健康检查（最多 30 秒）；失败自动 `reset --hard` 回滚并再启一次；
5. 退出码：`0` 已是最新或更新成功 / `1` 更新失败已回滚 / `2` 前置不满足（未部署、脏工作区、锁占用）。

常用旋钮（环境变量，省略即默认值）：

| 变量 | 含义 |
|---|---|
| `AICHAT_APP_DIR` | 部署树路径 |
| `AICHAT_BRANCH` | 部署分支（默认 `chat`） |
| `AICHAT_HEALTH_URL` | 健康检查 URL（默认打本机控制台的 `/api/config`） |
| `AICHAT_UNIT` | systemd 单元名 |

部署期间有 flock 保护，同时只会有一个更新在跑。

## 发布后验证清单

- [ ] `update.sh` 退出码 `0`，日志里「更新成功」的 sha 就是你要上的 commit
- [ ] 控制台首页能开，`/api/config` 返回 200
- [ ] 机器人进程在（`systemctl status <unit>`），日志里没有启动报错
- [ ] 关键功能手动过一遍（收到消息能回、控制台配置能读）
- [ ] 若这次合了上游：`git log --oneline -3` 里能看到 merge commit，`git merge-base --is-ancestor upstream/main HEAD` 为真
- [ ] 回滚预案在手：上一版 sha 记在发布记录里；回滚 = `git reset --hard <上一版 sha>` 后
      再跑一次 `update.sh`（或直接在部署树复位 + 重启），**不要**用 force push 回滚远端

## 只读的自动检测（可选）

维护者环境里可以配一个**只读**的上游检测（不改这个仓、不推分支）：它定期 fetch 上游与本仓，
在临时 worktree 里预演一次 `merge --no-ff`，把结果发成通知 ——

- 干净 → 通知里给旧/新 sha、上游新提交数和一条 merge 命令；
- 冲突 → 列出冲突文件并保留预演现场路径。

它**只检测、不合并、不部署**。收到「有新提交」不等于已经同步：要不要合、怎么解冲突，
仍然按上面「跟上游同步」一节由人来做。
