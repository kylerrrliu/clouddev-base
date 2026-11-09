# clouddev-base 隧道脚本共用的路径和检查：install.sh、status.sh、uninstall.sh 和 run.sh 都读它。
# install.sh 会把它和 run.sh 一起复制到 ~/.clouddev-tunnel/，launchd 运行的 run.sh 从那里读。
#
# 写法上的约定：
#   - POSIX sh，run.sh 用 /bin/sh 运行它；
#   - 变量后面紧跟非 ASCII 字符时写成 ${NAME}：macOS 自带的 bash 3.2 在 UTF-8 环境下会把那个字符算进变量名，
#     再加上 set -u 就会报 unbound variable 退出（test/tunnel.test.ts 会检查）；
#   - 函数在 set -euo pipefail 下也不能失败：管道里的每个命令都读完输入、以 0 退出。

LABEL="com.clouddev-base.tunnel"
DIR="$HOME/.clouddev-tunnel"
KEY="$DIR/id_ed25519"
CONF="$DIR/ssh_config"
LOCAL_CONF="$DIR/ssh_config.local"
KNOWN="$DIR/known_hosts"
RUN="$DIR/run.sh"
COMMON="$DIR/common.sh"
LINE_FILE="$DIR/authorized_keys_line.txt"
STAGED_PLIST="$DIR/$LABEL.plist"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/clouddev-tunnel.log"
TARGET="gui/$(id -u)/$LABEL"

# 这台电脑上在这个 TCP 端口监听的进程（pid，空格分隔）。
port_listeners() {
  { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | tr '\n' ' '
}

# launchd 里隧道任务的 pid（run.sh 用 exec 换成了 ssh，所以也是 ssh 的 pid）；没在运行时为空。
tunnel_pid() {
  { launchctl print "$TARGET" 2>/dev/null || true; } | awk '$1 == "pid" && $2 == "=" && !found { print $3; found = 1 }'
}

# 端口上监听的正是隧道的 ssh，而且经它能访问到 B 上的 clouddev-base。
# 只看 /healthz 不够：这台电脑上自己跑着的 clouddev-base 也会回答，这时 ssh 根本绑不上端口。
tunnel_up() {
  tunnel_up_pid="$(tunnel_pid)"
  [ -n "$tunnel_up_pid" ] || return 1

  case " $(port_listeners "$1") " in
    *" $tunnel_up_pid "*) ;;
    *) return 1 ;;
  esac

  tunnel_up_body="$(curl -fsS -m 3 "http://127.0.0.1:$1/healthz" 2>/dev/null)" || return 1

  case "$tunnel_up_body" in
    *clouddev-base*) return 0 ;;
  esac

  return 1
}
