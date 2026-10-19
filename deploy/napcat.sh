#!/usr/bin/env bash
# NapCat 容器的启动/停止/状态管理。
#
# ★ 为什么不用 `podman restart`：QQ 客户端不响应 SIGTERM，podman 等 10 秒后升级为
#   SIGKILL（退出码 137），登录态跟着丢 —— 实测每次都掉。这里用 stop -t 60
#   给它足够时间优雅退出，登录态才能留在 ~/napcat/qq 里。
#
# 用法：napcat.sh start|stop|restart|status|logs
set -uo pipefail

NAME="${NAPCAT_NAME:-napcat}"
QQ_DIR="${NAPCAT_QQ_DIR:-/home/vesita/napcat}"
OWNER="${NAPCAT_OWNER:-vesita}"
WEBUI_TOKEN="${NAPCAT_WEBUI_TOKEN:-testtoken123}"
IMAGE="${NAPCAT_IMAGE:-docker.io/mlikiowa/napcat-docker:latest}"

as_owner() {
  if [ "$(id -u)" = 0 ]; then sudo -u "$OWNER" "$@"; else "$@"; fi
}

case "${1:-status}" in
  start)
    if as_owner podman ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "已在运行：$NAME"; exit 0
    fi
    if as_owner podman ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "启动已存在的容器（保留登录态）…"
      as_owner podman start "$NAME" || exit 1
    else
      echo "首次创建容器…"
      as_owner podman run -d --name "$NAME" --restart=unless-stopped \
        -e MODE=ws -e WEBUI_TOKEN="$WEBUI_TOKEN" -e TZ=Asia/Shanghai \
        -p 127.0.0.1:6099:6099 -p 127.0.0.1:3001:3001 -p 127.0.0.1:3002:3002 \
        -v "$QQ_DIR/qq:/app/.config/QQ" \
        -v "$QQ_DIR/config:/app/napcat/config" \
        "$IMAGE" || exit 1
    fi
    ;;
  stop)
    # 关键：60 秒宽限，别让 podman 升级成 SIGKILL
    as_owner podman stop -t 60 "$NAME" || exit 1
    ;;
  restart)
    "$0" stop && "$0" start
    ;;
  status)
    as_owner podman ps -a --format '{{.Names}}\t{{.Status}}' | grep -P "^$NAME\t" || echo "容器不存在"
    ;;
  login)
    # 登录态检查：OneBot 就绪 = 已登录
    if curl -s -m 5 -o /dev/null "http://127.0.0.1:3002/get_login_info"; then
      curl -s -m 5 -X POST "http://127.0.0.1:3002/get_login_info" \
        -H 'content-type: application/json' -d '{}' | head -c 200; echo
    else
      echo "未登录（OneBot HTTP 未就绪）"
    fi
    ;;
  logs)
    as_owner podman logs --tail "${2:-30}" "$NAME" 2>&1 | grep -avE '^[0-9a-f]{64}$'
    ;;
  *)
    echo "用法: $0 start|stop|restart|status|login|logs" >&2; exit 2
    ;;
esac
