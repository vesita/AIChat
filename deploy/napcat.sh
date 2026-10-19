#!/usr/bin/env bash
# NapCat 容器管理：固定设备指纹 + 快速登录，实现重启免扫码。
#
# 三条实测结论（缺一条就退化成每次重启都要扫码）：
#   1. 必须持久化 /app/.config/QQ（登录凭证与设备指纹都在这，约 90 MB）
#   2. 必须固定 MAC。容器重建换了 MAC，QQ 判成新设备，凭证当场作废
#   3. 必须给 NAPCAT_QUICK_ACCOUNT + NAPCAT_QUICK_PASSWORD 才会自动登录；
#      只挂卷不给账号，NapCat 仍然只出二维码
#
# 停容器用 `podman stop -t 60`，不要 `podman restart`：QQ 不响应 SIGTERM 时
# podman 10 秒后就 SIGKILL（退出码 137），登录态跟着丢。
set -uo pipefail

NAME="${NAPCAT_NAME:-napcat}"
OWNER="${NAPCAT_OWNER:-$(id -un)}"
QQ_DIR="${NAPCAT_QQ_DIR:-$HOME/napcat}"
WEBUI_TOKEN="${NAPCAT_WEBUI_TOKEN:-}"
IMAGE="${NAPCAT_IMAGE:-docker.io/mlikiowa/napcat-docker:latest}"
KEYS_DIR="${KEYS_DIR:-$HOME/coding/my/keys}"
# 现场取值不进本仓（本仓公开）。来源优先级：环境变量 > 环境文件。
# 环境文件格式：每行 KEY=VALUE，见 deploy/napcat.env.example
ENV_FILE="${NAPCAT_ENV_FILE:-$QQ_DIR/napcat.env}"
[ -r "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
MAC="${NAPCAT_MAC:-}"
ACCOUNT="${NAPCAT_ACCOUNT:-}"

die() { printf '[napcat] !! %s\n' "$*" >&2; exit "${2:-2}"; }

as_owner() {
  if [ "$(id -u)" = 0 ]; then sudo -u "$OWNER" "$@"; else "$@"; fi
}

qq_password() {
  # 密码从 keys 仓取（密文，sync.sh 解密到 stdout）。取不到就返回空 ——
  # 那样只能扫码登录，不静默降级成别的东西。
  if [ -x "$KEYS_DIR/sync.sh" ]; then
    ( cd "$KEYS_DIR" && ./sync.sh decrypt aichat.qq-password 2>/dev/null )
  fi
}

case "${1:-status}" in
  start)
    if as_owner podman ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "已在运行：$NAME"; exit 0
    fi
    if as_owner podman ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "启动已有容器（设备指纹与登录态都在，会快速登录）…"
      as_owner podman start "$NAME" || exit 1
    else
      [ -n "$MAC" ] || die "缺 NAPCAT_MAC（固定 MAC 是重启免扫码的必要条件）。写进 $ENV_FILE 或设环境变量"
      [ -n "$ACCOUNT" ] || die "缺 NAPCAT_ACCOUNT（机器人 QQ 号）。写进 $ENV_FILE 或设环境变量"
      pw="$(qq_password)"
      [ -n "$pw" ] || { echo "取不到 QQ 密码（keys/aichat.qq-password），只能扫码登录" >&2; }
      echo "创建容器（固定 MAC $MAC，账号 $ACCOUNT）…"
      as_owner podman run -d --name "$NAME" --restart=unless-stopped \
        --network=bridge --mac-address="$MAC" \
        -e MODE=ws -e WEBUI_TOKEN="$WEBUI_TOKEN" -e TZ=Asia/Shanghai \
        -e NAPCAT_QUICK_ACCOUNT="$ACCOUNT" -e NAPCAT_QUICK_PASSWORD="$pw" \
        -p 127.0.0.1:6099:6099 -p 127.0.0.1:3001:3001 -p 127.0.0.1:3002:3002 \
        -v "$QQ_DIR/qq:/app/.config/QQ" \
        -v "$QQ_DIR/config:/app/napcat/config" \
        "$IMAGE" || exit 1
    fi
    ;;
  stop)
    as_owner podman stop -t 60 "$NAME" || exit 1
    ;;
  restart)
    "$0" stop && "$0" start
    ;;
  status)
    as_owner podman ps -a --format '{{.Names}}\t{{.Status}}' | grep -P "^$NAME\t" || echo "容器不存在"
    ;;
  login)
    curl -s -m 5 -X POST "http://127.0.0.1:3002/get_login_info" \
      -H 'content-type: application/json' -d '{}' | head -c 200; echo
    ;;
  logs)
    as_owner podman logs --tail "${2:-30}" "$NAME" 2>&1 | grep -avE '^[0-9a-f]{64}$'
    ;;
  *)
    echo "用法: $0 start|stop|restart|status|login|logs" >&2; exit 2
    ;;
esac
