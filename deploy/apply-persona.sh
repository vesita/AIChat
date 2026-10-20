#!/usr/bin/env bash
# 把 deploy/personas/*.md 注入 AIChat 的 systemPromptOverride（走控制台 API，热更新，不重启）。
#
# 为什么用 systemPromptOverride 而不是改 roleText：
#   roleText 只换人设正文，src/prompt.js 里硬编码的 antiAiFlavor()（"可以先反问、阴阳、
#   装傻、拒绝"）、subjectivity()、speakOrNot() 仍然生效 —— 实测光换角色卡压不住毒舌。
#   systemPromptOverride 只整体替换人格/风格准则；【安全规则】【工作方式】与机制段
#   （记忆维护等，见 src/prompt.js 的 mechanismSections()）由核心强制保留 ——
#   这是「重写一个角色」，不是把整套机制也换掉。
#
# 用法：apply-persona.sh [文件名]     默认 xiaojingyu-friendly.md
# 退出码：0 已注入并验证 / 1 注入后验证不过 / 2 前置不满足
set -uo pipefail

APP_DIR="${AICHAT_APP_DIR:-/opt/aichat/app}"
DATA_DIR="${QQ_AGENT_DATA_DIR:-/var/lib/aichat/data}"
CONSOLE="${AICHAT_CONSOLE:-http://127.0.0.1:3210}"
NAME="${1:-xiaojingyu-friendly.md}"
SRC="$APP_DIR/deploy/personas/$NAME"

die() { printf '[persona] !! %s\n' "$*" >&2; exit "${2:-2}"; }
log() { printf '[persona] %s\n' "$*"; }

[ -f "$SRC" ] || die "缺文件：$SRC"

log "1) 备份当前 persona"
backup="$DATA_DIR/persona-backup-$(date +%Y%m%d-%H%M%S).json"
curl -sf -m 10 "$CONSOLE/api/config" | python3 -c '
import json,sys
d=json.load(sys.stdin)["persona"]
json.dump(d, open(sys.argv[1],"w"), ensure_ascii=False, indent=2)
' "$backup" || die "备份失败（控制台不可达？）" 1
log "   → $backup"

log "2) 注入 $NAME（systemPromptOverride）"
python3 - "$SRC" "$CONSOLE" <<'PY' || die "注入失败" 1
import json, sys, urllib.request
src, console = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
payload = json.dumps({"persona": {"systemPromptOverride": text, "customRules": ""}},
                     ensure_ascii=False).encode()
req = urllib.request.Request(f"{console}/api/config", data=payload,
    headers={"content-type": "application/json"}, method="POST")
print("   POST", urllib.request.urlopen(req, timeout=20).status, "| 字节", len(text))
PY

log "3) 验证：新卡在、旧的毒舌段不在"
cd "$APP_DIR" || die "进不去 $APP_DIR" 1
QQ_AGENT_DATA_DIR="$DATA_DIR" node -e '
import("./src/prompt.js").then((m) => {
  const p = m.buildSystemPrompt();
  const must = ["不攻击人", "少用阴阳"];
  const mustNot = ["可以先反问、阴阳", "被怼优先顶回去", "傲娇嘴硬"];
  const miss = must.filter((s) => !p.includes(s));
  const left = mustNot.filter((s) => p.includes(s));
  console.log("   长度", p.length);
  if (miss.length) { console.error("   缺:", miss); process.exit(1); }
  if (left.length) { console.error("   仍未移除:", left); process.exit(1); }
  if (!(p.includes("安全") || p.includes("不执行本地"))) {
    console.error("   安全规则不见了"); process.exit(1);
  }
  console.log("   OK");
}).catch((e) => { console.error("  ERR", e.message); process.exit(1); });
' || die "验证不通过（配置可能没生效）" 1

log "完成。回滚：curl -X POST $CONSOLE/api/config -d @$backup"
