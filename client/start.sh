#!/bin/bash
# 在 A 上用白名单启动 Claude Code：本机只留下几个不读写文件、不执行命令的自带工具，
# MCP 只连这个目录里 .mcp.json 写的 clouddev-base。
#
# 用法: client/start.sh [claude 的其他参数]
# 例子: client/start.sh
#       client/start.sh --resume
#       client/start.sh "打开 B 上的 ~/work/my-app，跑一下测试"
# 也可以链接到 PATH 里的目录，比如 ln -s ~/clouddev/client/start.sh ~/.local/bin/cdev：脚本会顺着链接找回 client/。
#
#   --tools               只启用列出的自带工具，MCP 工具不受影响。留着 Skill，skill 照常能用（--tools "" 会把它也去掉）；
#                         留着 TaskStop：clouddev-base 的调用超过 2 分钟会被转到后台，Claude 要用它才停得掉；
#                         留着 ExitPlanMode：计划模式里 Claude 用它请你确认退出计划模式。
#                         没有 Write，Claude 写不了计划文件，计划写在它的回复里，确认框只问是否退出。
#                         没有 ToolSearch，clouddev-base 的工具一开始就全部加载，不用等到用时再搜索。
#   --no-chrome           不连 A 上的 Chrome。在 /chrome 里打开过 Enabled by default 的话，浏览器工具会随会话加载，
#                         它们也是 MCP 工具，--tools 和 --strict-mcp-config 都去不掉。B 上的端口在 A 的浏览器里本来也打不开。
#   --mcp-config          加载这个目录里的 .mcp.json。它给 clouddev-base 设了 alwaysLoad：启动时最多等它的工具 5 秒
#                         （MCP_CONNECT_TIMEOUT_MS），命令行上给的第一句话发出时工具已经在了。隧道不通或者要重新认证时
#                         等不到，会话照常开始，用 /mcp 看原因。
#   --strict-mcp-config   只用 --mcp-config 给的服务器：不加载 claude.ai 连接器、插件带的 MCP 服务器和其他配置里的服务器。
#
# --mcp-config 可以跟多个值，它后面不以 - 开头的参数都会被当成配置文件。所以它后面紧跟 --strict-mcp-config，
# 你传进来的第一句话才不会被当成配置文件。
# .claude/settings.json 照常生效；不经这个脚本、直接运行 claude 时，它的 deny 名单是兜底。
#
# claude 依次在这些地方找：环境变量 CLAUDE_BIN，PATH，~/.claude/local/claude，~/.local/bin/claude。
# 终端里的 alias 脚本看不到；装在别处的，这样指定：CLAUDE_BIN=/path/to/claude client/start.sh
set -euo pipefail
unset CDPATH

# 先找 claude，这时还在你运行脚本的目录里，CLAUDE_BIN 写相对路径也找得到。
if [ -n "${CLAUDE_BIN:-}" ]; then
  if ! claude=$(command -v -- "$CLAUDE_BIN"); then
    echo "错误: CLAUDE_BIN 设成了 $CLAUDE_BIN，但它不存在或不能运行。" >&2
    exit 1
  fi
else
  claude=$(command -v claude || true)

  if [ -z "$claude" ] && [ -n "${HOME:-}" ]; then
    for candidate in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude"; do
      if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        claude=$candidate
        break
      fi
    done
  fi
fi

if [ -z "$claude" ]; then
  echo "错误: 找不到 claude 命令：PATH 里没有，~/.claude/local/claude 和 ~/.local/bin/claude 也没有。" >&2
  echo "  终端里 claude 能用的话，它多半是 shell 的 alias，脚本看不到：用 type claude 查出它指向的程序，" >&2
  echo "  再这样启动：CLAUDE_BIN=/path/to/claude $0" >&2
  echo "  还没装的话，先在这台电脑上装好 Claude Code。" >&2
  exit 1
fi

# command -v 可能给出相对路径（CLAUDE_BIN=./claude，或者 PATH 里有相对目录），而下面要换目录。
case $claude in
  /*) ;;
  *) claude=$PWD/$claude ;;
esac

# 顺着符号链接找到脚本真正所在的 client/：.mcp.json、.claude/settings.json 和 CLAUDE.md 都在那里。
script=$0
while [ -L "$script" ]; do
  dir=$(cd -P -- "$(dirname -- "$script")" && pwd)
  script=$(readlink -- "$script")
  case $script in
    /*) ;;
    *) script=$dir/$script ;;
  esac
done
cd -P -- "$(dirname -- "$script")"

exec "$claude" \
  --tools "AskUserQuestion,ExitPlanMode,Skill,TaskCreate,TaskGet,TaskList,TaskStop,TaskUpdate" \
  --no-chrome \
  --mcp-config "$PWD/.mcp.json" \
  --strict-mcp-config \
  "$@"
