#!/usr/bin/env bash
# AIChat 热更新：拉取 chat 分支 → 装依赖 → 重启 → 健康检查 → 失败回滚。
#
# 为什么重启是安全的：QQ_AGENT_DATA_DIR 里的 messages/*.json 带 read 标记，
# 进程重启期间来的消息留在存档里、标记未读，起来后会自己补处理 —— 不丢消息。
# 所以「热更新」在这里 = 代码原子切换 + 秒级重启，而不是进程内改代码。
#
# 退出码：0 已是最新或更新成功 / 1 更新失败已回滚 / 2 前置不满足（未部署、脏工作区、锁占用）
set -uo pipefail

APP_DIR="${AICHAT_APP_DIR:-/opt/aichat/app}"
DATA_DIR="${QQ_AGENT_DATA_DIR:-/var/lib/aichat/data}"
BRANCH="${AICHAT_BRANCH:-chat}"
HEALTH="${AICHAT_HEALTH_URL:-http://127.0.0.1:3210/api/config}"
UNIT="${AICHAT_UNIT:-aichat}"
LOCK="${AICHAT_LOCK:-/var/lib/aichat/.update.lock}"

log()  { printf '[update] %s\n' "$*"; }
die()  { printf '[update] !! %s\n' "$*" >&2; exit "${2:-2}"; }

[ -d "$APP_DIR/.git" ] || die "没有 git 检出：$APP_DIR（先按 deploy/README.md 首次部署）"
command -v git >/dev/null || die "没有 git"
command -v node >/dev/null || die "没有 node"

# 串行化：两个更新同时跑会互相 reset 对方的树
mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
flock -n 9 || die "已有一个更新在跑（$LOCK）"

cd "$APP_DIR" || die "进不去 $APP_DIR"

cur_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$cur_branch" = "$BRANCH" ] || die "当前分支是 $cur_branch，不是部署分支 $BRANCH"

# 生产树必须干净：有本地改动说明有人在里面改过，reset 会悄悄丢掉
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "工作区有未提交改动，拒绝更新（先手工处理）"
fi

prev_sha="$(git rev-parse HEAD)"

git fetch --prune origin "$BRANCH" >/dev/null 2>&1 || die "git fetch 失败"
remote_sha="$(git rev-parse "origin/$BRANCH")"

if [ "$prev_sha" = "$remote_sha" ]; then
  log "已是最新：${prev_sha:0:12}"
  exit 0
fi

log "更新：${prev_sha:0:12} → ${remote_sha:0:12}"

# 依赖有变才装（npm install 在 VPS 上是最慢的一步）
deps_changed=0
if ! git diff --quiet "$prev_sha" "$remote_sha" -- package.json package-lock.json 2>/dev/null; then
  deps_changed=1
fi

git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1 || {
  git reset --hard "$prev_sha" >/dev/null 2>&1
  die "无法快进（本地与 origin/$BRANCH 分叉），已复位到 $prev_sha"
}

if [ "$deps_changed" = "1" ]; then
  log "依赖有变，安装生产依赖…"
  if ! npm install --omit=dev --ignore-scripts >/tmp/aichat-npm.log 2>&1; then
    tail -20 /tmp/aichat-npm.log >&2
    git reset --hard "$prev_sha" >/dev/null 2>&1
    die "依赖安装失败，已回滚到 $prev_sha" 1
  fi
fi

log "重启 $UNIT…"
if ! systemctl restart "$UNIT" 2>/dev/null; then
  git reset --hard "$prev_sha" >/dev/null 2>&1
  systemctl restart "$UNIT" 2>/dev/null
  die "重启失败，已回滚到 $prev_sha" 1
fi

# 健康检查：等控制台应答（最多 30 秒）
ok=0
for _ in $(seq 1 30); do
  if curl -sf -m 3 -o /dev/null "$HEALTH" 2>/dev/null; then ok=1; break; fi
  sleep 1
done

if [ "$ok" != "1" ]; then
  log "健康检查失败，回滚到 $prev_sha"
  git reset --hard "$prev_sha" >/dev/null 2>&1
  [ "$deps_changed" = "1" ] && npm install --omit=dev --ignore-scripts >/dev/null 2>&1
  systemctl restart "$UNIT" 2>/dev/null
  # 回滚后再探一次，把结果如实说出来（回滚失败比更新失败更严重）
  for _ in $(seq 1 20); do
    curl -sf -m 3 -o /dev/null "$HEALTH" 2>/dev/null && die "已回滚到 $prev_sha，服务恢复" 1
    sleep 1
  done
  die "已回滚到 $prev_sha，但服务仍不健康 —— 手工查 journalctl -u $UNIT" 1
fi

log "更新成功：现在跑 ${remote_sha:0:12}"
