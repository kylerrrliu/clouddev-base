#!/bin/sh
# clouddev-base SSH 隧道的启动脚本，由 launchd 运行（install.sh 会把它和 common.sh 复制到 ~/.clouddev-tunnel/）。
# 用法: run.sh [ssh_config 里的 Host 名，默认 clouddev-b]
#
# launchd 每次（重新）启动隧道都会运行它：先写一行带时间的日志、控制日志大小，再 exec 成 ssh，
# 这样 launchd 监管的就是 ssh 本身。ssh 断线或转发建不起来时退出，launchd 随即把它重新拉起。
#   -N  不开远程 shell，只做转发
#   -n  不读标准输入
# 其余设置（转发的端口、心跳、BatchMode 等）都在 ~/.clouddev-tunnel/ssh_config 里。

. "$(dirname "$0")/common.sh"

HOST="${1:-clouddev-b}"

# 别的 Host（比如 B 上到中转机的反向隧道）记到自己的日志里。
if [ "$HOST" != clouddev-b ]; then
  LOG="$HOME/Library/Logs/clouddev-tunnel-${HOST}.log"
fi

mkdir -p "$HOME/Library/Logs"

# 日志超过 5MB 就换一个新文件，只留一份旧的。
if [ -f "$LOG" ] && [ "$(($(wc -c <"$LOG")))" -gt 5000000 ]; then
  mv -f "$LOG" "$LOG.1"
fi

exec >>"$LOG" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') 连接 ${HOST}…"
exec /usr/bin/ssh -N -n -F "$CONF" "$HOST"
