#!/bin/bash
# 查看 A 上 clouddev-base SSH 隧道的状态：launchd 里的运行情况、经隧道能否访问 B，以及最近的日志。
# 用法: client/tunnel/status.sh [日志行数，默认 20]
set -u

LABEL="com.clouddev-base.tunnel"
TARGET="gui/$(id -u)/$LABEL"
CONF="$HOME/.clouddev-tunnel/ssh_config"
LOG="$HOME/Library/Logs/clouddev-tunnel.log"
LINES="${1:-20}"

# 本机监听的端口取自 ssh_config 里的 LocalForward 127.0.0.1:<端口> ...
PORT="$(awk '$1 == "LocalForward" { n = split($2, part, ":"); print part[n]; exit }' "$CONF" 2>/dev/null)"
PORT="${PORT:-7676}"

echo "launchd（${TARGET}）:"
if info="$(launchctl print "$TARGET" 2>/dev/null)"; then
  # state: running 表示 ssh 正在运行；runs: 启动过几次（每次断线重连加 1）；last exit code: 上次 ssh 为什么退出（255 多半是断线或连不上）
  printf '%s\n' "$info" | grep -E '^[[:space:]]*(state|pid|runs|last exit code) = ' | sed -E 's/^[[:space:]]+/  /'
else
  echo "  没有加载。安装: client/tunnel/install.sh <B 上的用户名>@<B 的地址>"
fi

echo
printf '经隧道访问 B 上的 clouddev-base（http://127.0.0.1:%s/healthz）: ' "$PORT"
if curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q clouddev-base; then
  echo "正常"
else
  echo "不通"
fi

echo
echo "最近的日志（${LOG}）:"
if [ -f "$LOG" ]; then
  tail -n "$LINES" "$LOG"
else
  echo "  （还没有日志）"
fi

echo
echo "立即重连: launchctl kickstart -k $TARGET"
