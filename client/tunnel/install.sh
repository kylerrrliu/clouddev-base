#!/bin/bash
# 在 A（跑 Claude Code 的电脑）上安装到 B 的 SSH 隧道:
#
#   A 的 127.0.0.1:7676 ══ ssh -L ══► B 的 127.0.0.1:7676（clouddev-base）
#
# 隧道由 launchd 常驻：登录后自动启动；断线或转发建不起来时 ssh 退出，由 launchd 重新连接；
# 全程不需要人输入。可以重复运行（比如改端口），密钥和 B 的指纹会沿用，没有指定的端口沿用上次的设置
# （B 的 SSH 端口只在 B 的地址没变时沿用）。
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

重新运行时，没有指定的端口沿用上次生成的 ~/.clouddev-tunnel/ssh_config 里的值，不会回到默认值。
只有 -p 例外：B 的地址和上次不一样时不沿用（那是上次那个地址的 SSH 端口），没有指定就用默认的 22。

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

# 转成小写，比较 B 的地址时用（bash 3.2 没有 ${NAME,,}）。
lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# 三个端口没有在命令行上指定时为空，下面再决定用上次的值还是默认值。
SSH_PORT=""
LOCAL_PORT=""
REMOTE_PORT=""
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

# 没有指定的端口沿用上次生成的 ssh_config 里的值：升级后重新运行时不用记得当初的参数（只有一台 Mac 时的
# --local-port 17676 就容易忘：回到默认的 7676，要到换上新配置之后才发现不通）；第一次运行时用默认值。
# 指定了、但和上次不一样的，说一声。
# $1: 变量名；$2: 选项；$3: 上次的值（没有时为空）；$4: 默认值。bash 3.2 没有 nameref，所以用 ${!1} 和 printf -v。
reused=""
settle_port() {
  if [ -z "${!1}" ]; then
    printf -v "$1" '%s' "${3:-$4}"
    if [ -n "$3" ] && [ "$3" != "$4" ]; then
      reused="$reused $2 ${3}"
    fi
  elif [ -n "$3" ] && [ "${!1}" != "$3" ]; then
    echo "提示: $2 改成了 ${!1}（上次是 ${3}）。"
  fi
}

read -r prev_ssh_port prev_local_port prev_remote_port prev_host <<EOF
$(conf_ports)
EOF
is_port "$prev_ssh_port" || prev_ssh_port=""
is_port "$prev_local_port" || prev_local_port=""
is_port "$prev_remote_port" || prev_remote_port=""
# 上次的 SSH 端口是上次那个地址的：B 的地址换了就不沿用，没有指定 -p 时用默认的 22。比如从经中转机的
# -p 2222 bob@127.0.0.1 换成局域网里的 bob@bob-mac.local，沿用 2222 就连不上；加了 --no-load 时还会把它写进新配置，
# 正在跑的隧道下次重连就用上了。另外两个端口是 A 和 B 上 clouddev-base 的，和 B 的地址无关，照样沿用。
# 地址不分大小写：Bob-Mac.local 和 bob-mac.local 是同一台。
if [ -n "$prev_ssh_port" ] && [ "$(lower "$prev_host")" != "$(lower "$CONF_HOST")" ]; then
  if [ -z "$SSH_PORT" ] && [ "$prev_ssh_port" != 22 ]; then
    echo "提示: B 的地址和上次（${prev_host//\%\%/%}）不一样，-p 没有沿用上次的 ${prev_ssh_port}，用默认的 22。B 的 SSH 端口不是 22 的话，用 -p 指定。"
  fi
  prev_ssh_port=""
fi
settle_port SSH_PORT -p "$prev_ssh_port" 22
settle_port LOCAL_PORT --local-port "$prev_local_port" 7676
settle_port REMOTE_PORT --remote-port "$prev_remote_port" 7676
if [ -n "$reused" ]; then
  echo "沿用上次的端口设置：${reused# }（取自 ${CONF}；要换的话在命令行上指定）。"
fi

# Claude Code 经 client/.mcp.json（本脚本上一级目录里的那份）里的地址连隧道，那里的端口要和 --local-port 一样。
MCP_JSON="$(dirname "$SCRIPT_DIR")/.mcp.json"
if [ -f "$MCP_JSON" ] && command -v plutil >/dev/null 2>&1; then
  mcp_url="$(plutil -extract mcpServers.clouddev-base.url raw -o - "$MCP_JSON" 2>/dev/null || true)"
  # http://127.0.0.1:7676/mcp → 7676
  mcp_port="${mcp_url#*://}"
  mcp_port="${mcp_port%%/*}"
  mcp_port="${mcp_port##*:}"
  if is_port "$mcp_port" && [ "$mcp_port" != "$LOCAL_PORT" ]; then
    echo "注意: ${MCP_JSON} 里的地址是 ${mcp_url}，端口和 --local-port ${LOCAL_PORT} 不一样，Claude Code 会连不到隧道。把它改成 http://127.0.0.1:${LOCAL_PORT}/mcp（B 上的 publicUrl 也要跟着改），或者用 --local-port ${mcp_port} 重新运行本脚本。"
  fi
fi

ipv4_re='^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
if [[ $B_HOST =~ $ipv4_re ]]; then
  echo "提示: B 的 IP 变了（比如路由器重新分配了地址）隧道就会一直连不上。在同一个局域网里，可以改用 B 的名字：在 B 上运行 scutil --get LocalHostName，加上 .local（例如 bob-mac.local）。"
fi

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"

# 第 5 步检查 B 时用的临时文件：一份去掉 LocalForward 的 ssh 配置，以及经它访问 B 上服务端口时的回答和 ssh 的输出。
PROBE="$CONF.probe"
# 第 5 步放到后台去访问 B 上服务端口的那个 ssh 的 pid，只在等它的那几秒里有值。
# 脚本放到后台的命令不理会 Ctrl+C，所以中途退出时要由下面的 cleanup 结束它。
asker=""

# 新的 ssh 配置和启动脚本先写成 .new，确认能连上 B 之后才替换正在用的那份：
# 中途失败、按了 Ctrl+C 或者参数写错时，已经在跑的隧道不受影响。
cleanup() {
  if [ -n "$asker" ]; then
    kill "$asker" 2>/dev/null || true
  fi
  rm -f "$CONF.new" "$RUN.new" "$COMMON.new" "$PROBE" "$PROBE.out" "$PROBE.err"
}
trap cleanup EXIT

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
连接 B 时本脚本会把这些限制逐项试一遍，有一项没生效、或者没能确认，就停下，不会装上隧道。
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

# 5. 第一次连接：固定 B 的主机指纹（唯一一次需要人确认），再逐项试这把钥匙在 B 上能做什么。
#    用的都是还没换上的新配置；试出哪一项不对就停下，正在用的配置和隧道都不动。每个 ✓ 只说真正试过的那一项。
#    先让 ssh 执行 true：受限的钥匙会被 B 强制改成执行 /usr/bin/false，所以退出码 1 才是对的。
cat <<'EOF'

第一次连接 B。ssh 如果问是否信任 B 的主机指纹，先在 B 上运行
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
指纹一致再输入 yes（也可以直接粘贴 B 上看到的 SHA256:… 指纹）。之后隧道在后台运行，不会再问。
EOF

set +e
# -n：不把终端里的输入发给 B；确认指纹的问题仍然直接在终端里问。
# ControlPath=none：ssh_config.local 里设了连接复用（ControlMaster）时，这几次检查既不借用已有的连接，
# 也不在后台留下一个（每一项都要是一次新的连接，才说明得了这一项）。
/usr/bin/ssh -n -F "$CONF.new" \
  -o BatchMode=no -o StrictHostKeyChecking=ask -o ClearAllForwardings=yes -o ControlPath=none \
  clouddev-b true
code=$?
set -e

case "$code" in
  1) echo "✓ 能连上 B，这把钥匙在 B 上执行不了命令：让它执行 true，B 换成了强制命令（退出码 1）。" ;;
  0) die "能连上 B，但这把钥匙在 B 上还能执行命令：authorized_keys 里那一行缺了前面的限制。换成上面完整的那一行，再运行一次本脚本。正在用的隧道配置没有改动。" ;;
  *)
    die "连不上 B，或者 B 不接受这把钥匙（ssh 退出码 ${code}）。正在用的隧道配置没有改动。请检查:
  - B 的地址和 SSH 端口（-p）是否正确，B 是否打开了“远程登录”
  - B 上 ${B_USER} 的 ~/.ssh/authorized_keys 里有没有上面那一整行
  - 如果换了一台 B，先删掉旧指纹: ssh-keygen -R clouddev-b -f ${KNOWN}"
    ;;
esac

# 后面几项用一份去掉 LocalForward 的配置：旧隧道还占着本机端口时，带 LocalForward 的 ssh 会因为
# Address already in use 以 255 退出，盖住真正要看的结果。也不能改用 ClearAllForwardings：它连命令行上的 -R
# 也一起清掉，反向转发根本没试，正确配置的 B 也会被判成不合格。
# ssh_config.local 里自己加的转发 sed 删不到（它是被 Include 进来的）：-W 本来就不建配置里的转发，
# 两项反向转发的检查用 ExitOnForwardFailure=no，那些转发建不起来也照样试。
sed '/^ *LocalForward /d' "$CONF.new" >"$PROBE"

# 下面几项都要读 ssh 说了什么，所以在命令行上定死两项设置（命令行上的优先，ssh_config.local 改不了它们）:
#   LogLevel=INFO     B 拒绝时 ssh 用 INFO 级别报告；ssh_config.local 里的 LogLevel ERROR 或 QUIET 会把它藏起来，
#                     哪一项都看不出结果；
#   ControlPath=none  见上面第一次连接。
PROBE_SSH=(/usr/bin/ssh -F "$PROBE" -o LogLevel=INFO -o ControlPath=none)

# ssh 的输出说明这次没连到 B（或者连接半路断了）：这时输出里别的话都不是 B 的回答。经中转机连 B 时，
# 中转机连不上 B 也会打印 open failed: connect failed，那是中转机的回答，不能当成 B 上的限制来看。
not_reached() {
  case "$1" in
    *"kex_exchange_identification"* | *"banner exchange"* | *"Connection closed by"* | *"ssh: connect to host"*) return 0 ;;
  esac
  return 1
}

# $1: ssh 的输出；$2: 补在最后的话（可以没有）。
die_unreached() {
  die "这次没能连上 B（ssh 输出: ${1}）。正在用的隧道配置没有改动。确认能连上 B（经中转机的话，还有中转机）之后，再运行一次本脚本。${2:-}"
}

# 这把钥匙不能随便转发：permitopen 生效时，B 会拒绝打开到 127.0.0.1:1 的通道（administratively prohibited）；
# 没有 permitopen 时，B 会真的去连那个端口，得到 connect failed。别的输出都说明不了 B 上的限制，就停下。
probe="$("${PROBE_SSH[@]}" -W 127.0.0.1:1 clouddev-b </dev/null 2>&1 || true)"
if not_reached "$probe"; then
  die_unreached "$probe"
fi
case "$probe" in
  *"open failed: administratively prohibited"*) echo "✓ B 不让这把钥匙随便转发：试了转发到 127.0.0.1:1，B 拒绝了。" ;;
  *"open failed: connect failed"*)
    die "这把钥匙在 B 上还能转发到别的端口：authorized_keys 那一行缺了 permitopen=\"127.0.0.1:${REMOTE_PORT}\"。换成上面完整的那一行，再运行一次本脚本。正在用的隧道配置没有改动。" ;;
  *) die "没能确认 B 上的 permitopen 限制是否生效（ssh 输出: ${probe}）。正在用的隧道配置没有改动。" ;;
esac

# 让这把钥匙在 B 上开一个反向转发，结果放进 reverse。$1: ssh -R 后面那一段；$2: B 拒绝时 ssh 怎么称呼这个转发
# 监听的地方（listen port 0 或 listen path <socket>）。
#   refused    B 拒绝了：ssh 报这一项的 remote port forwarding failed，接着照常执行命令。只认这一项的：
#              ssh_config.local 里的 RemoteForward 被 B 拒绝时，ssh 也会这样报；
#   allowed    B 答应了：ssh 接着执行命令 true，B 把它换成强制命令 /usr/bin/false，以 1 退出；
#   unreached  这次没连到 B；
#   unknown    别的情况，ssh 的退出码和输出在 reverse_code、reverse_out 里。
try_reverse() {
  reverse_code=0
  reverse_out="$("${PROBE_SSH[@]}" -o ExitOnForwardFailure=no -R "$1" clouddev-b true </dev/null 2>&1)" || reverse_code=$?
  if not_reached "$reverse_out"; then
    reverse=unreached
    return 0
  fi
  case "$reverse_code:$reverse_out" in
    *"remote port forwarding failed for $2"*) reverse=refused ;;
    0:* | 1:*) reverse=allowed ;;
    *) reverse=unknown ;;
  esac
}

# 不能在 B 上随意监听 TCP 端口：靠钥匙那一行的 restrict 和 permitlisten（只放行没用的 1 号端口）。
# 能监听的话，同一把钥匙就能抢先占住 B 上 clouddev-base 的端口。127.0.0.1:0 让 B 随便挑一个空闲端口。
try_reverse 127.0.0.1:0:127.0.0.1:9 "listen port 0"
case "$reverse" in
  refused) echo "✓ 这把钥匙不能在 B 上随意监听端口：试了 ssh -R 127.0.0.1:0（TCP 反向转发），B 拒绝了。" ;;
  allowed)
    die "这把钥匙在 B 上还能监听端口（ssh -R 127.0.0.1:0 成功了），可以用来抢先占住 B 上 clouddev-base 的端口：B 上这把钥匙生效的那一行缺了 restrict 或 permitlisten=\"127.0.0.1:1\"。换成上面完整的那一行（这把钥匙以前加过的旧行要删掉：sshd 只认第一行），再运行一次本脚本。正在用的隧道配置没有改动。" ;;
  unreached) die_unreached "$reverse_out" ;;
  *) die "没能确认这把钥匙在 B 上能不能监听端口（ssh 退出码 ${reverse_code}，输出: ${reverse_out}）。正在用的隧道配置没有改动。" ;;
esac

# 不能在 B 上建 Unix socket：authorized_keys 管不到，要靠 B 的 sshd 设置 AllowStreamLocalForwarding local。
# 没设置时 socket 会真的建在 B 上，而且一直留着。路径每次都换一个：那里已经有文件时 B 也会拒绝，就看不出 sshd 的设置了。
sock="/tmp/clouddev-probe-$$-$RANDOM.sock"
try_reverse "$sock:127.0.0.1:9" "listen path $sock"
case "$reverse" in
  refused) echo "✓ 这把钥匙不能在 B 上建 Unix socket：试了 ssh -R ${sock}（Unix socket 反向转发），B 拒绝了。" ;;
  allowed)
    die "这把钥匙在 B 上还能建 Unix socket（ssh -R ${sock} 成功了）：B 的 sshd 没有设置 AllowStreamLocalForwarding local，这种反向转发 authorized_keys 那一行管不到。按 README“在 B 上”第 5 步设置好，再运行一次本脚本。正在用的隧道配置没有改动。
这次检查在 B 上留下了 ${sock}，这把钥匙删不掉它，请在 B 上删掉: rm ${sock}" ;;
  unreached) die_unreached "$reverse_out" "B 上如果留下了 ${sock}，把它删掉。" ;;
  *) die "没能确认 B 的 sshd 是否禁止了 Unix socket 的反向转发（ssh 退出码 ${reverse_code}，输出: ${reverse_out}）。正在用的隧道配置没有改动。B 上如果留下了 ${sock}，把它删掉。" ;;
esac

# 最后试 B 上 clouddev-base 的端口：这把钥匙要能转发过去，那里回答的应该是 clouddev-base。
# 那个端口上的程序可能既不回答也不断开，ssh 就会一直等下去，所以放到后台，最多等 PROBE_WAIT 秒（macOS 没有
# timeout 命令）。默认 30 秒，经很慢的中转机也够用：往返 600 毫秒时这一次连接实测约 9 秒。
# 环境变量 CLOUDDEV_TUNNEL_PROBE_WAIT 可以换成别的秒数（测试用它缩短注定等不到的等待；连接确实更慢时加长）。
PROBE_WAIT="${CLOUDDEV_TUNNEL_PROBE_WAIT:-30}"
case "$PROBE_WAIT" in
  # 0 开头的不要：$(( )) 会把它当成八进制。
  '' | *[!0-9]* | 0*) PROBE_WAIT=30 ;;
esac
printf 'GET /healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' |
  "${PROBE_SSH[@]}" -W "127.0.0.1:$REMOTE_PORT" clouddev-b >"$PROBE.out" 2>"$PROBE.err" &
# 后台管道的 $! 是最后一个命令，也就是 ssh。
asker=$!
for _ in $(seq 1 "$((PROBE_WAIT * 10))"); do
  kill -0 "$asker" 2>/dev/null || break
  sleep 0.1
done
gave_up=""
if kill -0 "$asker" 2>/dev/null; then
  kill "$asker" 2>/dev/null || true
  gave_up=1
fi
wait "$asker" 2>/dev/null || true
asker=""

probe="$(cat "$PROBE.err")"
if not_reached "$probe"; then
  die_unreached "$probe"
fi
case "$probe" in
  *"open failed: administratively prohibited"*)
    die "这把钥匙在 B 上转发不到 127.0.0.1:${REMOTE_PORT}（B 拒绝了）。正在用的隧道配置没有改动。可能的原因:
  - --remote-port 写错了：要和 B 上 clouddev-base 的端口一致
  - B 的 authorized_keys 里这把钥匙前面还有一条更早的旧行：sshd 只认第一行，要把旧的删掉
  - B 的 sshd 关掉了端口转发（sshd_config 里的 AllowTcpForwarding 或 DisableForwarding）" ;;
  *"open failed: connect failed"*)
    echo "注意: B 的 127.0.0.1:${REMOTE_PORT} 上现在没有程序在监听：B 上的 clouddev-base 没在运行，或者它的端口不是 ${REMOTE_PORT}（在 B 上运行 clouddev-base service status 查看）。隧道照样装上，服务在这个端口运行起来就能连通。" ;;
  *)
    if grep -q clouddev-base "$PROBE.out"; then
      echo "✓ 这把钥匙能转发到 B 的 127.0.0.1:${REMOTE_PORT}，那里回答的是 clouddev-base。"
    elif [ -s "$PROBE.out" ]; then
      echo "注意: B 的 127.0.0.1:${REMOTE_PORT} 上回答的是别的程序，不是 clouddev-base。B 上 clouddev-base 的端口不是 ${REMOTE_PORT} 的话，用 --remote-port 指定后重新运行本脚本。"
    elif [ -n "$gave_up" ]; then
      die "经这把钥匙访问 B 的 127.0.0.1:${REMOTE_PORT}，${PROBE_WAIT} 秒内没有完成（连接太慢，或者那个端口上的程序不回答）。正在用的隧道配置没有改动。B 上 clouddev-base 的端口不是 ${REMOTE_PORT} 的话，用 --remote-port 指定后重新运行本脚本；连接本来就这么慢的话，把环境变量 CLOUDDEV_TUNNEL_PROBE_WAIT 设成更多的秒数再运行。"
    else
      die "没能确认 B 的 127.0.0.1:${REMOTE_PORT} 上是不是 clouddev-base：经这把钥匙访问那里，没有得到回答（ssh 输出: ${probe:-没有}）。正在用的隧道配置没有改动。B 上 clouddev-base 的端口不是 ${REMOTE_PORT} 的话，用 --remote-port 指定后重新运行本脚本。"
    fi
    ;;
esac
rm -f "$PROBE" "$PROBE.out" "$PROBE.err"

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
#    最多等 20 秒；环境变量 CLOUDDEV_TUNNEL_WAIT 可以换成别的秒数（测试用它缩短注定等不到的等待）。
WAIT="${CLOUDDEV_TUNNEL_WAIT:-20}"
case "$WAIT" in
  '' | *[!0-9]* | 0) WAIT=20 ;;
esac
echo "隧道已交给 launchd，等待连通…"
ok=0
for _ in $(seq 1 "$WAIT"); do
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
  2. 用 client/start.sh 启动 Claude Code，再用 /mcp 认证
查看状态: client/tunnel/status.sh    日志: $LOG
EOF
else
  cat <<EOF

隧道已安装，但 ${WAIT} 秒内经隧道访问不到 B 上的 clouddev-base（http://127.0.0.1:${LOCAL_PORT}/healthz）。可能的原因:
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
