#!/bin/sh
# clouddev-base SSH 隧道的启动脚本，由 launchd 运行（install.sh 会把它复制到 ~/.clouddev-tunnel/）。
# 用法: run.sh [ssh_config 里的 Host 名，默认 clouddev-b]
#
# launchd 每次（重新）启动隧道都会运行它：先写一行带时间的日志、控制日志大小，再 exec 成 ssh，
# 这样 launchd 监管的就是 ssh 本身。ssh 在断线（心跳连续没有回应）或转发建不起来时退出，
# launchd 随即把它重新拉起（两次启动至少间隔 10 秒）。
#   -N  不开远程 shell，只做转发
#   -n  不读标准输入
# 其余设置（转发的端口、心跳、BatchMode 等）都在 ~/.clouddev-tunnel/ssh_config 里。

HOST="${1:-clouddev-b}"

if [ "$HOST" = clouddev-b ]; then
  LOG="$HOME/Library/Logs/clouddev-tunnel.log"
else
  LOG="$HOME/Library/Logs/clouddev-tunnel-$HOST.log"
fi

mkdir -p "$HOME/Library/Logs"

# 日志超过 5MB 就换一个新文件，只留一份旧的。
if [ -f "$LOG" ] && [ "$(($(wc -c <"$LOG")))" -gt 5000000 ]; then
  mv -f "$LOG" "$LOG.1"
fi

exec >>"$LOG" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') 连接 ${HOST}…"
exec /usr/bin/ssh -N -n -F "$HOME/.clouddev-tunnel/ssh_config" "$HOST"
