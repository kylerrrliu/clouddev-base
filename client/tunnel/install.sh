#!/bin/bash
# 在 A（跑 Claude Code 的电脑）上安装到 B 的 SSH 隧道:
#
#   A 的 127.0.0.1:7676 ══ ssh -L ══► B 的 127.0.0.1:7676（clouddev-base）
#
# 隧道由 launchd 常驻：登录后自动启动；断线或转发建不起来时 ssh 退出，由 launchd 重新连接；
# 全程不需要人输入。可以重复运行（比如改端口），密钥和 B 的指纹会沿用。
# 路径和几个检查在 common.sh 里，写法上的约定也见那里。
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
用法: client/tunnel/install.sh [选项] <B 上的用户名>@<B 的地址>

  -p, --port <端口>         B 的 SSH 端口（默认 22）
      --local-port <端口>   A 上监听的端口（默认 7676，必须和 B 上 publicUrl 里的端口一致）
      --remote-port <端口>  B 上 clouddev-base 监听的端口（默认 7676）
      --no-load             只生成文件：不连接 B，也不装进 launchd（登录时不会自动启动）。之后去掉这个参数再运行一次即可
  -h, --help                显示帮助

B 的地址最好用它在局域网里的名字（比如 bob-mac.local，在 B 上运行 scutil --get LocalHostName 再加上 .local），
B 的 IP 变了也能连上；不在同一个局域网时用 B 的公网地址或域名。

例子: client/tunnel/install.sh bob@bob-mac.local
      client/tunnel/install.sh -p 2222 bob@b.example.com

会创建:
  ~/.clouddev-tunnel/id_ed25519        隧道专用密钥（无口令；在 B 上被限制为只能转发这一个端口）
  ~/.clouddev-tunnel/ssh_config        隧道专用的 ssh 配置（每次运行都重新生成）
  ~/.clouddev-tunnel/ssh_config.local  你自己补充的 ssh 设置（比如经中转机的 ProxyJump），本脚本不会改它
  ~/.clouddev-tunnel/known_hosts       B 的主机指纹
  ~/.clouddev-tunnel/run.sh、common.sh launchd 运行的启动脚本
  ~/Library/LaunchAgents/com.clouddev-base.tunnel.plist（确认能连上 B 之后才装）
日志: ~/Library/Logs/clouddev-tunnel.log    状态: client/tunnel/status.sh
EOF
}

die() {
  echo "错误: $*" >&2
  exit 1
}

is_port() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

SSH_PORT=22
LOCAL_PORT=7676
REMOTE_PORT=7676
LOAD=1
SSH_TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    -p | --port | --local-port | --remote-port)
      [ $# -ge 2 ] || die "$1 需要一个端口号"
      is_port "$2" || die "无效的端口: $2"
      case "$1" in
        -p | --port) SSH_PORT="$2" ;;
        --local-port) LOCAL_PORT="$2" ;;
        --remote-port) REMOTE_PORT="$2" ;;
      esac
      shift 2
      ;;
    --no-load) LOAD=0; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "未知选项: ${1}（--help 查看用法）" ;;
    *)
      [ -z "$SSH_TARGET" ] || die "只能指定一个 B 的地址"
      SSH_TARGET="$1"
      shift
      ;;
  esac
done

[ -n "$SSH_TARGET" ] || { usage >&2; exit 1; }

case "$SSH_TARGET" in
  *@*) ;;
  *) die "请写成 <B 上的用户名>@<B 的地址>，例如 bob@bob-mac.local" ;;
esac

B_USER="${SSH_TARGET%%@*}"
B_HOST="${SSH_TARGET#*@}"
# user@[IPv6 地址] 的方括号去掉：ssh_config 里的 HostName 不要方括号。
B_HOST="${B_HOST#\[}"
B_HOST="${B_HOST%\]}"
user_re='^[A-Za-z0-9._][A-Za-z0-9._-]*$'
host_re='^[A-Za-z0-9._:%-]+$'
[[ $B_USER =~ $user_re ]] || die "用户名里有不支持的字符: $B_USER"
[[ $B_HOST =~ $host_re ]] || die "地址里有不支持的字符: $B_HOST"
# ssh_config 的 HostName 会展开 %h 这类记号，IPv6 地址里的 %（如 fe80::1%en0）要写成 %%。
CONF_HOST="${B_HOST//\%/%%}"

if [ "$LOAD" = 1 ] && [ "$(uname -s)" != "Darwin" ]; then
  die "这个脚本用 launchd 管理隧道，只支持 macOS。Linux 上的做法见 README（systemd --user）；也可以加 --no-load 只生成配置文件。"
fi

ipv4_re='^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
if [[ $B_HOST =~ $ipv4_re ]]; then
  echo "提示: B 的 IP 变了（比如路由器重新分配了地址）隧道就会一直连不上。在同一个局域网里，可以改用 B 的名字：在 B 上运行 scutil --get LocalHostName，加上 .local（例如 bob-mac.local）。"
fi

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"

# 新的 ssh 配置和启动脚本先写成 .new，确认能连上 B 之后才替换正在用的那份：
# 中途失败、按了 Ctrl+C 或者参数写错时，已经在跑的隧道不受影响。
trap 'rm -f "$CONF.new" "$RUN.new" "$COMMON.new"' EXIT

# 1. 隧道专用密钥。没有口令，后台运行时才不用等人输入；它在 B 上被限制为只能转发一个端口。
if [ -f "$KEY" ]; then
  echo "沿用已有的隧道密钥: $KEY"
else
  ssh-keygen -q -t ed25519 -N '' -C "clouddev-tunnel@$(hostname -s 2>/dev/null || hostname)" -f "$KEY"
  echo "已生成隧道专用密钥: $KEY"
fi

touch "$KNOWN"

# 2. 隧道专用的 ssh 配置。用 ssh -F 单独指定，~/.ssh/config 里的设置（ControlMaster、IdentityAgent 等）不会混进来。
#    你自己的补充设置放在 ssh_config.local：本脚本只在它不存在时建一个空的，以后不再改它。
if [ ! -f "$LOCAL_CONF" ]; then
  cat >"$LOCAL_CONF" <<'EOF'
# clouddev-base 隧道的补充 ssh 设置。install.sh 不会改这个文件，重新运行也不会覆盖。
# 它在 ssh_config 的最前面被引用，这里的设置优先生效；ssh_config 末尾 "Host *" 那一段的
# 加固设置（专用密钥、指纹检查、不等人输入、心跳）对这里加的主机同样生效。
# 比如经中转机连 B（见 README“A 连不到 B 时”）:
#
#   Host clouddev-b
#       ProxyJump clouddev-relay
#
#   Host clouddev-relay
#       HostName r.example.com
#       User tunnel
EOF
fi

cat >"$CONF.new" <<EOF
# clouddev-base 隧道专用的 ssh 配置，由 client/tunnel/install.sh 生成（重新运行会覆盖）。
# 自己要加的设置写在 ssh_config.local 里：它不会被覆盖，而且排在最前面，优先生效。
# launchd 通过 ~/.clouddev-tunnel/run.sh 以 "ssh -N -n -F 本文件 clouddev-b" 使用它。
Include "$LOCAL_CONF"

Host clouddev-b
    HostName $CONF_HOST
    Port $SSH_PORT
    User $B_USER
    # 主机指纹按别名记录：B 换了 IP 也不用重新确认
    HostKeyAlias clouddev-b
    # A 的 127.0.0.1:$LOCAL_PORT → B 的 127.0.0.1:$REMOTE_PORT
    LocalForward 127.0.0.1:$LOCAL_PORT 127.0.0.1:$REMOTE_PORT
    # 转发建不起来（比如本机端口被占用）就退出，交给 launchd 重试
    ExitOnForwardFailure yes

# 下面这些对这个文件里用到的每台主机都生效（包括 ssh_config.local 里加的中转机），前面没设置过的才用这里的值。
Host *
    IdentityFile "$KEY"
    IdentitiesOnly yes
    # 不经过 ssh-agent：1Password、Secretive 之类的 agent 不会弹出确认框
    IdentityAgent none
    UserKnownHostsFile "$KNOWN"
    # 后台运行、不等人输入：主机指纹对不上、需要密码或口令时直接失败
    StrictHostKeyChecking yes
    BatchMode yes
    PreferredAuthentications publickey
    # 保活和断线检测：10 秒没收到对方的数据就在加密通道里发一次心跳，
    # 连发 3 次都没有回应（约 40 秒）判定断线，ssh 退出，launchd 重新连接
    ServerAliveInterval 10
    ServerAliveCountMax 3
    ConnectTimeout 10
    # 日志里记录每次认证成功
    LogLevel VERBOSE
EOF

# 3. launchd 运行的启动脚本，以及登录即启动、退出即重启的 LaunchAgent。
#    plist 先放在 ~/.clouddev-tunnel 里，确认能连上 B 之后才复制进 LaunchAgents：
#    放进那个目录的 plist，下次登录时 launchd 都会自动加载。
cp "$SCRIPT_DIR/run.sh" "$RUN.new"
chmod 700 "$RUN.new"
cp "$SCRIPT_DIR/common.sh" "$COMMON.new"
chmod 600 "$COMMON.new"

cat >"$STAGED_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 由 client/tunnel/install.sh 生成。登录后启动隧道；ssh 无论因为什么退出（断线、转发失败），都由 launchd 重新拉起。 -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>$(xml_escape "$RUN")</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
</dict>
</plist>
EOF
# launchd 不接受别人可写的 plist。
chmod 644 "$STAGED_PLIST"

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$STAGED_PLIST" >/dev/null || die "生成的 $STAGED_PLIST 格式不对"
fi

# 4. B 上要加的那一行：这把钥匙只能把连接转发到 B 的 127.0.0.1:${REMOTE_PORT}。
LINE="restrict,port-forwarding,permitopen=\"127.0.0.1:$REMOTE_PORT\",permitlisten=\"127.0.0.1:1\",command=\"/usr/bin/false\" $(cat "$KEY.pub")"
printf '%s\n' "$LINE" >"$LINE_FILE"

# 在 B 上执行的追加命令：先去掉这把钥匙以前加过的行（sshd 只认同一把钥匙的第一行，旧行会让新的限制不生效），
# 再加上新的一行。grep 会给每一行补上换行，所以原文件最后一行没有换行也不会和新行粘在一起；
# grep 出错（退出码大于 1）时不替换文件，免得弄丢已有的钥匙。
KEY_BLOB="$(awk '{ print $2 }' "$KEY.pub")"
REMOTE_ADD='umask 077; mkdir -p ~/.ssh; f="$HOME/.ssh/authorized_keys"; touch "$f"; { grep -vF "'"$KEY_BLOB"'" "$f"; [ $? -le 1 ] && cat; } >"$f.tmp" && mv "$f.tmp" "$f"'

cat <<EOF

──────── 在 B 上做这一步 ────────
把下面这一整行加到 B 上 ${B_USER} 的 ~/.ssh/authorized_keys（这一行也保存在 ${LINE_FILE}）。
以前加过这把钥匙的话，要把旧的那一行换掉，而不是再追加一行：sshd 只认同一把钥匙的第一行。

$LINE

这一行让这把钥匙在 B 上只能把连接转发到 127.0.0.1:${REMOTE_PORT}：不能登录 shell、不能执行命令、
不能转发别的端口，也不能做 TCP 反向转发。Unix socket 的反向转发 authorized_keys 管不到，
所以 B 的 sshd 还要设置 AllowStreamLocalForwarding local（见 README“在 B 上”第 5 步）。
B 还要打开“远程登录”（系统设置 → 通用 → 共享）。

如果你现在能用别的方式 ssh 登录 B（比如密码），也可以在这台电脑上直接运行下面这条命令。
它会去掉这把钥匙的旧行、加上新的一行，其他钥匙不动:
  ssh -p ${SSH_PORT} ${B_USER}@${B_HOST} '${REMOTE_ADD}' < $(printf '%q' "$LINE_FILE")
────────────────────────────────
EOF

if [ "$LOAD" = 0 ]; then
  mv -f "$CONF.new" "$CONF"
  mv -f "$RUN.new" "$RUN"
  mv -f "$COMMON.new" "$COMMON"
  echo
  echo "已生成文件（--no-load）：没有连接 B，也没有把隧道装进 launchd，登录时不会自动启动。B 上配好之后，去掉 --no-load 再运行一次。"
  if [ -f "$PLIST" ]; then
    echo "注意: 之前装好的隧道还在运行，它下次重新连接时就会用刚生成的 ssh 配置。"
  fi
  exit 0
fi

[ -t 0 ] || die "接下来需要你在终端里确认 B 的主机指纹，请直接在终端里运行（或者加 --no-load 只生成文件）。正在用的隧道配置没有改动。"

echo
read -r -p "B 上配好之后按回车继续（Ctrl+C 退出）…" _

# 5. 第一次连接：固定 B 的主机指纹（唯一一次需要人确认），并检查 B 上的限制是否生效。
#    用的是还没换上的新配置；这里让 ssh 执行 true：受限的钥匙会被 B 强制改成执行 /usr/bin/false，所以退出码 1 才是对的。
cat <<'EOF'

第一次连接 B。ssh 如果问是否信任 B 的主机指纹，先在 B 上运行
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
指纹一致再输入 yes（也可以直接粘贴 B 上看到的 SHA256:… 指纹）。之后隧道在后台运行，不会再问。
EOF

set +e
# -n：不把终端里的输入发给 B；确认指纹的问题仍然直接在终端里问。
/usr/bin/ssh -n -F "$CONF.new" \
  -o BatchMode=no -o StrictHostKeyChecking=ask -o ClearAllForwardings=yes \
  clouddev-b true
code=$?
set -e

case "$code" in
  1) ;;
  0) die "能连上 B，但这把钥匙在 B 上还能执行命令：authorized_keys 里那一行缺了前面的限制。换成上面完整的那一行，再运行一次本脚本。正在用的隧道配置没有改动。" ;;
  *)
    die "连不上 B，或者 B 不接受这把钥匙（ssh 退出码 ${code}）。正在用的隧道配置没有改动。请检查:
  - B 的地址和 SSH 端口（-p）是否正确，B 是否打开了“远程登录”
  - B 上 ${B_USER} 的 ~/.ssh/authorized_keys 里有没有上面那一整行
  - 如果换了一台 B，先删掉旧指纹: ssh-keygen -R clouddev-b -f ${KNOWN}"
    ;;
esac

# 再确认这把钥匙不能转发到 B 的别的端口：permitopen 生效时，B 会拒绝打开到 127.0.0.1:1 的通道（administratively
# prohibited）；没有 permitopen 时，B 会真的去连那个端口，得到 Connection refused。
probe="$(/usr/bin/ssh -F "$CONF.new" -o ClearAllForwardings=yes -W 127.0.0.1:1 clouddev-b </dev/null 2>&1 || true)"
case "$probe" in
  *"administratively prohibited"*) echo "✓ 能连上 B，而且这把钥匙在 B 上只能把连接转发到 127.0.0.1:${REMOTE_PORT}。" ;;
  *"connect failed"* | *"Connection refused"*)
    die "这把钥匙在 B 上还能转发到别的端口：authorized_keys 那一行缺了 permitopen=\"127.0.0.1:${REMOTE_PORT}\"。换成上面完整的那一行，再运行一次本脚本。正在用的隧道配置没有改动。" ;;
  *) echo "注意: 没能确认 B 上的 permitopen 限制是否生效（ssh 输出: ${probe}）。请确认 authorized_keys 用的是上面完整的那一行。" ;;
esac

# 6. 换上新的配置和启动脚本，装好并加载 LaunchAgent。已经在运行的旧隧道先停掉，配置的改动才会生效。
mv -f "$CONF.new" "$CONF"
mv -f "$RUN.new" "$RUN"
mv -f "$COMMON.new" "$COMMON"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$STAGED_PLIST" "$PLIST"
chmod 644 "$PLIST"
echo "已写入 LaunchAgent: $PLIST"

launchctl bootout "$TARGET" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$TARGET" >/dev/null 2>&1 || break
  sleep 0.5
done

# 旧隧道停掉之后还占着本机端口的，就是别的程序了：隧道要等它让出端口才能连上。
squatters="$(port_listeners "$LOCAL_PORT")"
if [ -n "${squatters// /}" ]; then
  echo "注意: 本机 ${LOCAL_PORT} 端口已经被别的程序占用（pid ${squatters% }），隧道要等它释放端口才能工作:" >&2
  lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >&2 || true
fi

launchctl enable "$TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" ||
  die "launchd 没能加载 ${PLIST}。如果在 系统设置 → 通用 → 登录项与扩展 里关掉过它的后台运行，先打开再重试。"

# 7. 经隧道访问 B 上的 clouddev-base：端口上必须是隧道的 ssh，而且 B 有回答。
echo "隧道已交给 launchd，等待连通…"
ok=0
for _ in $(seq 1 20); do
  if tunnel_up "$LOCAL_PORT"; then
    ok=1
    break
  fi
  sleep 1
done

MCP_URL="http://127.0.0.1:$LOCAL_PORT/mcp"

if [ "$ok" = 1 ]; then
  cat <<EOF

✓ 隧道已连通：这台电脑的 http://127.0.0.1:${LOCAL_PORT} 现在就是 B 上的 clouddev-base。
  登录后会自动启动；断线后自动重连。

下一步:
  1. client/.mcp.json 里的 url 设为 $MCP_URL
     （B 上的 publicUrl 必须是 http://127.0.0.1:${LOCAL_PORT}：在 B 上运行 clouddev-base init --public-url http://127.0.0.1:${LOCAL_PORT}）
  2. 在 client/ 目录里启动 Claude Code，输入 /mcp 重新认证一次
查看状态: client/tunnel/status.sh    日志: $LOG
EOF
else
  cat <<EOF

隧道已安装，但 20 秒内经隧道访问不到 B 上的 clouddev-base（http://127.0.0.1:${LOCAL_PORT}/healthz）。可能的原因:
  - 本机 ${LOCAL_PORT} 端口被别的程序占用（上面会有提示，日志里也会有 Address already in use）
  - B 上的服务没在运行：在 B 上运行 clouddev-base service status
  - B 上的服务端口不是 ${REMOTE_PORT}：用 --remote-port 指定后重新运行本脚本
  - authorized_keys 那一行不完整（要有 port-forwarding 和 permitopen="127.0.0.1:${REMOTE_PORT}"），
    或者这把钥匙前面还有一条更早的旧行（sshd 只认第一行，要删掉旧的）
隧道会在后台继续重试。最近的日志（${LOG}）:
EOF
  tail -n 15 "$LOG" 2>/dev/null || true
  exit 1
fi
