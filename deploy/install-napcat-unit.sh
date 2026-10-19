#!/usr/bin/env bash
# 把 NapCat 装成 systemd 用户级单元（quadlet），并开启 linger。
#
# 为什么必须这么做：
#   - 容器归 vesita 用户（rootless podman），root 级单元声明不了对它的依赖。
#     之前 aichat.service 里写的 After=podman-napcat.service 是不存在的单元，
#     等于没有依赖 —— 重启后 AIChat 可能先起、连不上 OneBot。
#   - 默认 Linger=no：用户没有登录会话时，user manager 会被回收，容器跟着停。
#     开机会话还没建立，所以必须开 linger 才能开机自启。
#
# 退出码：0 装好且单元 active / 1 某步失败 / 2 前置不满足
set -uo pipefail

OWNER="${NAPCAT_OWNER:-vesita}"
QQ_DIR="${NAPCAT_QQ_DIR:-/home/vesita/napcat}"
KEYS_DIR="${KEYS_DIR:-/home/vesita/coding/my/keys}"
SRC="${AICHAT_APP_DIR:-/opt/aichat/app}/deploy/napcat.container"

die() { printf '[napcat-unit] !! %s\n' "$*" >&2; exit "${2:-2}"; }
log() { printf '[napcat-unit] %s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "要用 root 跑（要 enable-linger 与装单元）"
[ -f "$SRC" ] || die "缺 $SRC"

log "1) 写环境文件（含 QQ 密码，0600，不进任何仓）"
install -d -m 755 -o "$OWNER" -g "$OWNER" "$QQ_DIR"
pw=""
if [ -x "$KEYS_DIR/sync.sh" ]; then
  pw="$( cd "$KEYS_DIR" && ./sync.sh decrypt aichat.qq-password 2>/dev/null )"
fi
[ -n "$pw" ] || die "取不到 QQ 密码（keys/aichat.qq-password）；没有它就只能扫码登录" 1
printf 'NAPCAT_QUICK_PASSWORD=%s\n' "$pw" > "$QQ_DIR/napcat.env"
chown "$OWNER:$OWNER" "$QQ_DIR/napcat.env"
chmod 600 "$QQ_DIR/napcat.env"

log "2) 装 quadlet 定义"
unit_dir="$( getent passwd "$OWNER" | cut -d: -f6 )/.config/containers/systemd"
install -d -m 755 -o "$OWNER" -g "$OWNER" "$unit_dir"
install -m 644 -o "$OWNER" -g "$OWNER" "$SRC" "$unit_dir/napcat.container"

log "3) 开启 linger（开机即可用该用户的 user manager）"
loginctl enable-linger "$OWNER" || die "enable-linger 失败" 1
[ -e "/var/lib/systemd/linger/$OWNER" ] || die "linger 没落盘" 1

log "4) 让 quadlet 生成单元并启动"
sudo -u "$OWNER" XDG_RUNTIME_DIR="/run/user/$(id -u "$OWNER")" \
  systemctl --user daemon-reload || die "daemon-reload 失败" 1
# 先删掉手工创建的容器，交给 systemd 管（否则同名冲突）
if sudo -u "$OWNER" podman container exists napcat 2>/dev/null; then
  log "   移除手工创建的容器（登录态在挂载卷里，不受影响）"
  sudo -u "$OWNER" podman rm -f napcat >/dev/null 2>&1 || true
fi
sudo -u "$OWNER" XDG_RUNTIME_DIR="/run/user/$(id -u "$OWNER")" \
  systemctl --user enable --now napcat.service || die "启动 napcat.service 失败" 1

log "5) 等待 OneBot 就绪（最多 120 秒）"
ok=0
for _ in $(seq 1 120); do
  if curl -sf -m 3 -o /dev/null "http://127.0.0.1:3002/get_login_info" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || die "OneBot 120 秒内没就绪，看 journalctl --user -u napcat" 1

log "完成。napcat 现在是 systemd 用户级单元（开机自启、退出自动重启）"
