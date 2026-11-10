# 待办

以后要加、还没开始做的功能。

标着“参考 cc-desk-tunnel”的条目来自 2026-11 和 [cc-desk-tunnel](https://github.com/sun168567/cc-desk-tunnel/tree/0a34200142da8b060de542868dc98e1cce8cea18) 的对比，提到它的文件时，路径都相对于这个提交。它和我们方向相反：Claude Code 跑在云端，命令回到用户自己的电脑上执行。这里只记值得借鉴的做法。

## 在 WebUI 里显示 A 上 Claude Code 的状态

在 A 的 `client/.claude/settings.json` 里加 hooks，把 Claude Code 的状态经同一条隧道报给 B，在 WebUI 里合并显示。能看到的内容包括：

- 你输入了什么；
- Claude 在运行、在等你在 A 上批准（等的是哪一次调用），还是这一轮已结束；
- 会话换了（`/clear`、`/resume`）或者关了。

要挂的事件。前五行参考 cc-desk-tunnel 的 `apps/server/src/terminal-transcript.ts`，它在 Claude Code 2.1.293 上实测过；后两行它没有用，来自 Claude Code 的 hooks 文档。

| 事件 | 显示成 |
| --- | --- |
| `UserPromptSubmit` | 运行中，带上输入的内容（`prompt`） |
| `PermissionRequest` | 等你批准，带上是哪个工具（`tool_name`） |
| `PostToolUse`、`PostToolUseFailure` | 回到运行中：工具跑完了，说明已经批准 |
| `Notification` | 看 `notification_type`：`permission_prompt`、`elicitation_dialog` 是等你，`idle_prompt` 是空闲 |
| `Stop`、`SessionStart` | 空闲。`/clear`、`/resume` 之后的 `SessionStart` 带着新的 `session_id` |
| `StopFailure` | 这一轮因为 API 出错结束，这时不触发 `Stop` |
| `SessionEnd` | 会话关了，去掉这一行 |

事件怎样送到 B，先试第一种：

1. **`mcp_tool` 类型的 hook。** hook 直接调用 clouddev-base 上的一个工具（比如叫 `report_status`），走的是 Claude Code 自己那条已经认证过的 MCP 连接：不需要另外的 token，A 上不需要脚本，接收的一头自然就在 MCP 端口上。hook 的 `input` 里用 `${session_id}`、`${tool_name}` 这样的写法从事件里挑字段，只发用得上的。
2. **`command` 类型的 hook 运行脚本，用 curl POST 给 B。** 第一种行不通时用。脚本拿不到 Claude Code 手里的 OAuth token，要用单独的 token：在 B 上生成，A 上存进 `~/.clouddev-tunnel/`（权限 600）；`client/.claude/settings.json` 提交在仓库里，不能把 token 写进去。字段要在 A 上挑出来再发，而 A 上不一定有 jq。

`http` 类型的 hook 不合适：它把事件整个 POST 出去，挑不了字段，不支持 `SessionStart`，token 还得放进环境变量。

实现时注意：

- 事件表是别人在一个版本上测的结论，加上文档的说法。动手前在 A 实际用的 Claude Code 上把每个事件都触发一遍，尤其是下面写着“待测”的。
- 等批准要靠 `PermissionRequest`：按对方的实测，弹出确认框时 Claude Code 只触发它，不发 `Notification`（`permission_prompt` 仍然按“等你”处理，以防别的版本会发）。`Notification` 按 `notification_type` 区分，不用解析 `message`；hook 的 `matcher` 可以直接按类型过滤。
- 按 Esc 中断一轮时不触发任何 hook，`Stop` 也不触发，状态会停在“运行中”或“等你批准”。B 自己只看得到一种情况：正在执行的调用被取消了（记录里是“已中止”或“未送达”）。所以状态旁边要显示最后一次事件的时间；太久没有新事件、也没有新请求，就显示成“未知”，不要一直显示“运行中”。`PostToolUseFailure` 的输入里有 `is_interrupt`，工具执行到一半被中断时能不能靠它知道，待测。
- 手动拒绝一次调用没有专门的事件（`PermissionDenied` 只在自动模式下触发），拒绝之后状态怎么变，待测。
- 状态按 `session_id` 分行显示。两个 Claude Code 窗口共用同一个 token，MCP 请求分不出是哪个窗口发的，只有 hook 的事件里有 `session_id`。
- 事件不能整个发过隧道。`PermissionRequest`、`PostToolUse` 的输入里带着工具的参数，`PostToolUse` 还带着结果：`write` 的整个文件、`read` 读到的内容都在里面。cc-desk-tunnel 的 hook 把输入原样追加到本机文件，再由服务端解析；我们隔着隧道，这一点不能照搬。
- `PostToolUse` 每次工具调用都触发，hook 默认又是同步的，等于每次调用多一个来回，要量一下。用 `client/start.sh` 启动时，要批准的基本都是 clouddev-base 的 `write`、`edit`、`bash`，批准之后调用马上到 B。所以也可以不挂它，由 B 在收到调用时把状态改回“运行中”；代价是开着多个窗口时，可能算到别的窗口头上。
- hook 不能拖慢或干扰 A 上的 Claude Code：
  - 超时设短（1～2 秒）。隧道断了就丢掉这条，不重试；
  - 不产生任何输出。`UserPromptSubmit` 的 hook 输出会被加进 Claude 的上下文；`Stop` 的 hook 以退出码 2 结束，或者输出 `{"decision": "block"}` 时，Claude 会接着干活而不是停下。`mcp_tool` 的 hook 把工具返回的文字当作输出，所以这个工具不返回任何文字；脚本不往 stdout 写东西，最后一律 `exit 0`。
- 用 `mcp_tool` 时：
  - 这个工具不经过 `run`（`src/mcp.ts`）：它不算一次工具调用，不进“记录”，也不逐条打日志；
  - Claude Code 启动时的那次 `SessionStart` 不会调用 `mcp_tool` 的 hook（那时 MCP 还没连上），`/clear` 之后的会。一个新会话第一次出现，是在它的第一个 `UserPromptSubmit`；
  - 待测：这个工具是不是必须出现在 `tools/list` 里（出现的话 Claude 也看得见它，描述里要写明只给 hook 用，`test/mcp.test.ts`、`test/http.test.ts`、`e2e/smoke.mjs` 里数着 7 个工具的地方也要改）；把它放进 `deny` 会不会连 hook 一起拦住；`${…}` 取不到字段时填的是什么；隧道不通时界面上会不会每次都报错。
- 用脚本时：
  - 隧道只转发 7676（B 上 `authorized_keys` 的 `permitopen` 只放行这一个端口），所以接收的接口要放在 MCP 端口上（`src/http.ts`），不能放在 WebUI 的 7677 上；
  - `settings.json` 里禁用的 Bash 只是 Claude 的 Bash 工具，不影响 hooks 运行。
- 输入的内容按调用参数的规则截断（8 KB），只存在 B 的内存里。
- hooks 加进 `client/.claude/settings.json` 之后，`test/client-config.test.ts` 要补上对应的检查；A 上的 `client/` 要重新拷一遍才生效。

## 中止运行中的 bash

给运行中的 bash 加一个"中止"按钮。复用现有的取消逻辑（AbortSignal 触发后停掉整个进程组），POST 请求时校验 Origin。

实现时注意：

- 停进程的部分已经有了：`runCommand`（`src/tools/shell.ts`）收到 abort 后，用 `stopGroup` 先对整个进程组发 SIGTERM，3 秒后还有进程就发 SIGKILL。目前传进去的只有客户端取消用的 `extra.signal`（`src/mcp.ts`）。
- 给每次调用配一个 AbortController，交给 ActivityLog 保管。用 `AbortSignal.any()` 把它和 `extra.signal` 合并后再传给 `runCommand`。
- 要能看出是在 B 上手动中止的：现在 `finish()` 只根据 `extra.signal.aborted` 判断是否取消。返回给 Claude 的结果也要写明这一点，免得它原样再跑一次。
- 接口可以用 `POST /api/calls/:id/abort`（`src/webui.ts`）。现有的 `/api` 只拦截 `Sec-Fetch-Site: cross-site`，而本机其他端口上的网页算同站，拦不住。所以 POST 必须带 Origin，且要和页面自己的地址（`http://` + Host）完全一致，否则返回 403。
- 这个 AbortController 也是下一节后台任务的基础：后台任务没有 `extra.signal`，只能靠它结束。

## 后台任务：长命令不跟着连接走

参考 cc-desk-tunnel 复查后定下的规则（`docs/research/review-2026-10.md` 第 1 条）：需要持续工作的东西归设备，只有随连接存在的交互才归连接。它的运行在断线后有 5 分钟宽限期。

我们的 `bash` 跟着那一次 HTTP 请求走：

- 请求一断，命令就被停掉（`src/http.ts` 里的 `res.on("close")`）。隧道重连时立刻如此；A 睡眠或突然断网时，B 的 sshd 约 2 分钟后关掉连接（README“在 B 上”第 5 步的 `ClientAliveInterval`），命令也随之结束。
- 最长 300 秒。超过 2 分钟的调用 Claude Code 会转到后台，但那只是 A 上不再等它，上限和“跟着连接走”都没变。
- 更久的只能让 Claude 用 `nohup … &`。这样的进程在 WebUI 里看不到，也停不掉；Claude 要自己去读日志，才知道它跑完没有。

要做的是让命令归服务进程：调用立即返回一个任务号，命令接着跑，之后凭任务号取输出、看状态、结束它。

实现时注意：

- 先查清楚走哪条路：
  - MCP 协议的 tasks（2025-11 版规范里的实验特性：调用立即返回任务，之后轮询、取结果、取消）。Claude Code 和我们用的 SDK 支持到什么程度，待查；支持的话优先用它，不用加工具。
  - 否则自己加：`bash` 加参数 `run_in_background`（和 Claude Code 自带的 Bash 同名），再加两个工具，一个凭任务号取新输出和状态，一个结束任务。
- 每个 POST 都新建一个 McpServer（`src/http.ts`），任务表要像 `WorkspaceRegistry`、`ActivityLog` 那样放在服务进程里，传给 `createMcpServer`。
- 输出沿用 `OutputBuffer`（`src/tools/shell.ts`：开头 16 KB 加最后约 1 MB），每个任务记住读到了哪里。
- 自己加工具的话，Claude 只能轮询。取输出的工具可以带一个等待时间：有新输出或任务结束就返回，否则最多等这么久。
- 任务在 WebUI 里要看得到、停得掉。可以直接用 ActivityLog 里那条调用记录：调用返回后记录仍是“进行中”（进行中的记录本来就不会被清掉），任务结束时再收尾；“中止”按钮就是上一节的那个。
- 服务停止或重启时任务怎么办，要先定。任务表只在内存里，重启后还活着的进程就成了看不见的孤儿。建议服务退出时把后台任务一起停掉（`runningGroups` 和 `killRunningCommandsNow` 已经是这个思路），并在工具描述里写明；要活过服务重启的常驻进程，仍然用 `nohup`。
- 还要定上限：同时运行的任务数，结束的任务保留多久。
- 新工具要进 A 上 `client/.claude/settings.json` 的权限设置：取输出的只读，可以放进 `allow`。`test/client-config.test.ts` 里“只自动放行只读工具”的用例要跟着改。
- 要一起改的说明：`bash` 的工具描述、服务的 `instructions`、`client/CLAUDE.md` 里推荐 `nohup` 的几处；README 的工具表；`test/mcp.test.ts`、`test/http.test.ts`、`e2e/smoke.mjs` 和 README、`e2e/README.md` 里数着 7 个工具的地方。

## 服务启动时读取登录 shell 的环境

参考 cc-desk-tunnel 的 `apps/desktop/electron/shell-environment.mjs`：在 macOS 和 Linux 上，它启动时用登录 shell 跑一次（`-lic`），拿到的环境和用户在终端里的一样。

我们是在 `service install` 时把当时终端里的 PATH 和一份白名单变量写死进 plist（`src/service.ts` 的 `defineService`）。所以 README 里才有这些说明：要在平时开发用的终端里运行 `service install`；升级 node、改了 PATH 之后要重新运行；白名单以外的变量要加进 `serviceEnv`，值会以明文写进 plist。

改成后台服务启动时读一次登录 shell 的环境，作为 `bash` 工具执行命令的环境（`src/tools/shell.ts` 的 `commandEnvironment`）；读不到就用 plist 里的那一份。

实现时注意：

- 只在后台服务里做，在终端里手动运行 `serve` 时环境本来就是对的。Linux 上用 systemd 启动的同样需要（README 里那个单元文件只写了一个固定的 PATH），所以触发条件不能只认 launchd 的标记。
- 用哪个 shell：对方先看 `$SHELL`，再看 `os.userInfo().shell`，只认 zsh 和 bash，别的（比如 fish）退回系统自带的。
- 环境不能从 stdout 直接读：shell 的启动脚本可能往里打印东西。对方走一个私有的 Unix socket，带一次性的随机数；VS Code 的做法更简单，在 stdout 里用随机标记把 JSON 包起来。
- 启动脚本可能卡住（等输入、弹更新提示）。对方限制 10 秒、1 MB；超时或失败时照常启动，用 plist 里的环境，并在日志里写一行原因。
- 合并时：
  - 服务自己的变量（`CLOUDDEV_BASE_SERVICE`、`CLOUDDEV_BASE_HOME`、`CLOUDDEV_BASE_LOG_COMMANDS`）以服务进程里的为准；
  - 删掉 `BASH_ENV` 和 `ENV`，否则每条命令启动时都会再跑一遍它们指向的脚本；
  - PATH 仍然过一遍 `servicePath`：去掉 fnm 的临时目录，把 node 所在的目录放在最前面；
  - `commandEnvironment` 现有的两步照旧在最后做：删掉 `CLOUDDEV_BASE_PASSWORD`（有人会把它写在 `.zshrc` 里），给 `no_proxy` 补上本机地址。
- 实现前先定一件事：现在后台服务里的命令只看得到白名单里的变量，改完之后看得到登录 shell 里 export 的全部变量，包括写在 `.zshrc` 里的各种 token，和在终端里手动运行 `serve` 时一样。要不要留一个排除名单。
- 读到的只是环境变量。命令仍然在非登录、非交互的 bash 里运行，`.zshrc` 里的 alias 和函数照样没有，工具描述里这一句不用改。
- 环境只在服务启动时读一次：改了 `.zshrc` 之后重启服务就生效，不用重新安装。README“在 B 上”第 3 步的“环境变量”、`serviceEnv` 的说明和“排错”里 command not found 那一条要跟着改。

## 连接参数一次给全

参考 cc-desk-tunnel 的安装脚本（`deploy/README.md`）：结束时一次列出客户端要填的地址、证书指纹和凭据；客户端固定这个指纹，没有“第一次连接时问你信不信”这一步。

我们现在：

- B 的主机指纹要人在 A 的终端里核对（`client/tunnel/install.sh` 第 5 步）。脚本因此离不开终端，`e2e/install-tunnel.exp` 就是为了代答它；
- 换一个端口要三处一起改（README“在 A 上”第 3 步后面的说明）。`install.sh` 已经会记住上次的端口，也会在 `client/.mcp.json` 的端口对不上时提醒，但不会替你改。

改成在 B 上打印一条完整的命令，到 A 上照着运行：

- `init`（`src/cli.ts`）已经会打印 `client/tunnel/install.sh <用户名>@<名字>.local`。再带上 `--local-port`（`publicUrl` 里的端口）、`--remote-port`（`port`）和 `--host-key`（B 的主机公钥，读 `/etc/ssh/ssh_host_ed25519_key.pub`，这个文件谁都能读）；
- `install.sh` 收到 `--host-key`，就把它写进 `~/.clouddev-tunnel/known_hosts`，第一次连接直接用 `StrictHostKeyChecking yes`，不再提问。没带这个参数时照现在的做法；
- 隧道连通之后，`install.sh` 直接把 `client/.mcp.json` 里的 `url` 改好。

实现时注意：

- 公钥跟着命令从 B 带到 A，这条路要可信：以自己在 B 的屏幕上看到的为准，和现在核对指纹是一个道理。
- `known_hosts` 里的主机名写别名 `clouddev-b`：ssh 配置里设了 `HostKeyAlias clouddev-b`。
- `--host-key` 的值要先校验成“类型加 base64”的样子再写文件，和用户名、地址的校验一样（`test/tunnel.test.ts` 有对应的用例）。
- 从没打开过“远程登录”的 Mac 上还没有主机密钥（`e2e/README.md` 提到过）。`init` 读不到时就不带 `--host-key`，并提示先打开远程登录。
- 脚本里还有一处“B 上配好之后按回车继续”，也要能跳过，否则仍然离不开终端。
- 把钥匙那一行加进 B 的 `authorized_keys` 仍然由人来做，不要自动化；第 5 步里对 B 上各项限制的检查原样保留。
- 经中转机连接时，中转机的指纹仍然要另外确认（README“A 连不到 B 时”）。

## CI

参考 cc-desk-tunnel 的 `.github/workflows/check.yml`。仓库在 GitHub 上，但没有 workflow：每次改动跑不跑测试、在哪个系统上跑，全靠手动。Windows 上的那部分代码（比如 `src/tools/shell.ts` 里找 bash、结束进程的分支）没有自动测试在跑。

- 加一个 workflow：`npm ci`（会顺带运行 `prepare` 里的构建）、`npm run typecheck`、`npm test`，在 Linux、macOS、Windows 上各跑一遍。
- Node 用 22 和 24：`engines` 要求 22.18 以上，测试靠 Node 直接运行 `.ts`。
- Windows 先设成不拦截（`continue-on-error`），看清哪些用例在那里跑不了，再改成必须通过，对方也是这样起步的。`test/shell.test.ts` 里测 SIGTERM 和进程组的用例没有按平台跳过，预计要先补上。
- 端到端流程（`e2e/README.md`）要两台 Mac 和人工操作，不进 CI。
- 顺带在 README 里列一个“已实现、还没实测”的清单，对方的 `docs/roadmap.md` 有这样一节。现在端到端流程只覆盖 macOS；Linux 上的 systemd 写法、Windows 上手动 `serve` 实测到什么程度，文档里看不出来。

## 小改动

- **A 上的 `client/` 过期时提示。** `client/` 是手工拷到 A 的，B 更新之后它可能还是旧的（少了新加的 `deny`、新工具的放行，或者没有 `start.sh`）。B 这一头，`service status` 已经会提示服务还在运行旧代码；A 这一头没有任何检查。可以给 `client/` 一个自己的版本标记，`/healthz`（`src/http.ts`）报告 B 上那一份的标记，`client/tunnel/status.sh` 比对后提示重新拷贝。不能直接用 `VERSION`，它不是每次改动都升；用一条测试卡住：记下 `client/` 里各文件的哈希，文件改了而标记没改就失败。
- **告诉 Claude 中断之后结果未知。** 参考 cc-desk-tunnel 给 Claude 的提示词（`apps/server/src/claude.ts` 的 `remotePrompt`）。在 `client/CLAUDE.md` 里加一句：调用被取消、超时或者连接断开之后，B 上实际做到哪一步是未知的，先查清楚（`read`、`git status`、看日志），不要直接重跑有副作用的命令。WebUI 把这种调用标成“已中止”或“未送达”，但 Claude 不知道。
- **Windows 上 Git Bash 的两处不同。** 参考 cc-desk-tunnel 的 `apps/server/src/device-terms.ts`。`shellFacts`（`src/mcp.ts`）在 Windows 上只告诉 Claude shell 是 Git Bash。补上两条：传给 Windows 程序的参数里，像 Unix 路径的会被改写，所以 `/c` 这样的开关要写成 `//c`；`ps`、`kill` 只看得到 Git Bash 自己启动的进程，别的 Windows 进程用 `tasklist`、`taskkill`。
- **中文 Windows 上的乱码。** 参考 cc-desk-tunnel 的 `apps/server/src/tunnel.ts`，它在启动 Git Bash 之前先执行 `chcp.com 65001`。中文区域的 Windows 上，Git Bash 里调用的系统程序（`ping`、`ipconfig`、`cmd`）按 GBK 输出，而我们按 UTF-8 解码。手头的 Windows 是英文区域（代码页 437），没有复现，要先在中文区域的机器上确认再改。
