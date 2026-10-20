#!/usr/bin/env bash
# AIChat 在 noco 上的首次部署（幂等，可重跑）。之后更新走 deploy/update.sh。
#
#   代码检出  /opt/aichat/app       chat 分支
#   可写数据  /var/lib/aichat/data  QQ_AGENT_DATA_DIR
#   控制台    127.0.0.1:3210        只回环
#
# 前置：node ≥ 20、git、curl；NapCat 容器已在跑。OneBot 有两个端口：WS 127.0.0.1:3001、
#       HTTP API 127.0.0.1:3002 —— AIChat 的 snowluma.wsUrl 与 snowluma.httpUrl 两个都要配；
#       只填 ws 不填 http 是最常见的半通故障（WS 绿、发送 404）。
# 退出码：0 部署完成 / 1 某步失败 / 2 前置不满足
set -uo pipefail

APP_DIR="${AICHAT_APP_DIR:-/opt/aichat/app}"
DATA_DIR="${QQ_AGENT_DATA_DIR:-/var/lib/aichat/data}"
BRANCH="${AICHAT_BRANCH:-chat}"
REPO="${AICHAT_REPO:-}"
OWNER="${AICHAT_OWNER:-$(id -un)}"
UNIT="${AICHAT_UNIT:-aichat}"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] !! %s\n' "$*" >&2; exit "${2:-2}"; }

[ "$(id -u)" = 0 ] || die "要用 root 跑（装 systemd 单元）"
command -v node >/dev/null || die "没有 node"
command -v git  >/dev/null || die "没有 git"
[ -n "$REPO" ] || die "缺 AICHAT_REPO（代码仓地址）。例：AICHAT_REPO=<你的仓地址> bash install.sh"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "node 版本太低（$node_major），需要 ≥ 20"

log "1) 代码检出 $APP_DIR（分支 $BRANCH）"
install -d -m 755 "$(dirname "$APP_DIR")"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR" || die "克隆失败：$REPO" 1
else
  log "   已存在，快进到最新"
  git -C "$APP_DIR" fetch --prune origin "$BRANCH" || die "fetch 失败" 1
  git -C "$APP_DIR" merge --ff-only "origin/$BRANCH" || die "无法快进（工作区有改动或已分叉）" 1
fi
chown -R "$OWNER:$OWNER" "$APP_DIR"

log "2) 数据目录 $DATA_DIR"
install -d -m 750 -o "$OWNER" -g "$OWNER" "$DATA_DIR"

log "3) 生产依赖"
if ! ( cd "$APP_DIR" && sudo -u "$OWNER" npm install --omit=dev --ignore-scripts >/tmp/aichat-npm.log 2>&1 ); then
  tail -20 /tmp/aichat-npm.log >&2
  die "npm install 失败" 1
fi

log "4) systemd 单元 $UNIT"
sed "s/__DEPLOY_USER__/$OWNER/g" "$APP_DIR/deploy/$UNIT.service" > "/etc/systemd/system/$UNIT.service" \
  || die "渲染单元失败" 1
chmod 644 "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1
systemctl restart "$UNIT" || die "启动失败" 1

log "5) 验证（等控制台应答，最多 30 秒）"
ok=0
for _ in $(seq 1 30); do
  if curl -sf -m 3 -o /dev/null "http://127.0.0.1:3210/api/config" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  journalctl -u "$UNIT" -n 30 --no-pager >&2
  die "控制台没有应答" 1
fi

log "完成。控制台只监听回环：ssh -L 3210:127.0.0.1:3210 <别名> 后访问 http://127.0.0.1:3210"
