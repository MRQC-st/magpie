#!/usr/bin/env bash
# refresh-monkeycode-auth.sh —— 服务器侧：cookie 文件变了就重跑 plugin login monkeycode 1。
#
# 背景：magpie 的社区插件 opencode-monkeycode-auth 没有 auth.refresh，凭据是登录那一刻
# 拷进 plugin-auth.json 的快照。所以「服务器上的 cookie 文件被同步成新的」并不会自动生效，
# 必须再跑一次 keyless 的 `magpie plugin login monkeycode 1`（方式 1 = 读取本机登录态）。
#
# 本脚本做成「只在文件真变了时才动作」：sha256 比对 + 落盘 stamp，避免无谓地重写凭据。
# 由 systemd user timer 每 2 小时调用一次（见 magpie-monkeycode-refresh.timer）。
set -euo pipefail

export PATH="$PATH:/home/ubuntu/.local/bin"

COOKIE_FILE="/home/ubuntu/.config/com.chaitin.baizhi.monkeycode/monkeycode-cookies.json"
STAMP_FILE="/home/ubuntu/.cache/magpie-monkeycode-cookie.sha256"

[ -f "$COOKIE_FILE" ] || { echo "no cookie file: $COOKIE_FILE"; exit 0; }

cur="$(sha256sum "$COOKIE_FILE" | cut -d' ' -f1)"
prev="$(cat "$STAMP_FILE" 2>/dev/null || true)"

if [ "$cur" = "$prev" ]; then
  echo "cookie 未变化（$cur）—— 跳过"
  exit 0
fi

if magpie plugin login monkeycode 1; then
  mkdir -p "$(dirname "$STAMP_FILE")"
  echo "$cur" > "$STAMP_FILE"
  echo "cookie 已更新（$cur）→ plugin login 成功"
else
  echo "plugin login 失败 —— 保留旧 stamp，下轮重试" >&2
  exit 1
fi
