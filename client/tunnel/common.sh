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

# install.sh 上次生成的 ssh_config 里 Host clouddev-b 那一段的三个端口和 B 的地址，写在一行里，没有的写 -：
# B 的 SSH 端口（Port），A 上监听的端口和 B 上 clouddev-base 的端口（LocalForward 127.0.0.1:A 127.0.0.1:B），
# B 的地址（HostName，照文件里的写法：IPv6 地址里的 % 是 %%）。
# 地址放在最后：只要端口的 status.sh 用 read -r _ PORT _ 读，多出来的这一项落进最后那个变量。
# 只读这个文件自己的行：它 Include 的 ssh_config.local 不算。
conf_ports() {
  if [ -f "$CONF" ]; then
    awk '
      tolower($1) == "host" { b = ($2 == "clouddev-b") }
      b && tolower($1) == "hostname" && host == "" { host = $2 }
      b && tolower($1) == "port" && port == "" { port = $2 }
      b && tolower($1) == "localforward" && lport == "" { n = split($2, l, ":"); m = split($3, r, ":"); lport = l[n]; rport = r[m] }
      END { print (port == "" ? "-" : port), (lport == "" ? "-" : lport), (rport == "" ? "-" : rport), (host == "" ? "-" : host) }
    ' "$CONF" 2>/dev/null || echo "- - - -"
  else
    echo "- - - -"
  fi
}

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

  # --noproxy：终端里设了 http_proxy 或 all_proxy 时，curl 连 127.0.0.1 也会走代理；代理不放行本机地址的话，
  # 好好的隧道也会被当成不通。
  tunnel_up_body="$(curl --noproxy '*' -fsS -m 3 "http://127.0.0.1:$1/healthz" 2>/dev/null)" || return 1

  case "$tunnel_up_body" in
    *clouddev-base*) return 0 ;;
  esac

  return 1
}
