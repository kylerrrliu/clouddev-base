# clouddev-base

一个精简的 MCP 服务器：让一台电脑（A）上的 Claude Code（或其他支持 MCP 的客户端）经 SSH 隧道打开另一台电脑（B）上的项目，**读写、搜索代码，执行终端命令**。B 上还有一个只在本机能打开的网页，实时显示 Claude Code 在 B 上做的每一步。

## 提供给 AI 的工具

| 工具 | 作用 |
| --- | --- |
| `open_workspace` | 打开允许目录内的一个项目，返回 `workspace_id`（同一项目永远是同一个 id，重启后仍有效） |
| `read` | 读文件（超过 2000 行 / 50KB 时用 `offset`/`limit` 翻页）；读目录则列出内容；图片以图片形式返回；不是 UTF-8 编码的文件（如 GBK）会附带提示 |
| `write` | 新建或整体覆盖文件，自动创建父目录 |
| `edit` | 按“精确原文 → 新文本”替换，原文必须唯一匹配；保留 CRLF 换行与 BOM；同一文件的并发编辑会排队执行；只改 UTF-8 文本文件，GBK 等其他编码和二进制文件会被拒绝，以免保存时损坏原有字符 |
| `grep` | 用正则搜索文件内容，输出 `路径:行号:内容`；跳过被忽略的文件（见下文）、二进制文件、大于 2MB 的文件和符号链接 |
| `glob` | 按文件名模式找文件，如 `*.ts`、`src/**/*.{js,jsx}`；只返回真实存在的普通文件，跳过被忽略的文件（规则与 `grep` 相同） |
| `bash` | 在项目目录执行命令（默认超时 30 秒，最长 300 秒），返回输出末尾 2000 行 / 50KB；非 0 退出码会标记为错误；客户端取消调用（如在 Claude Code 里按 Esc）会立即终止命令及其子进程 |

所有文件路径都相对于工作区根目录，任何读写都不能越出工作区（包括通过符号链接越界）。

### 搜索范围（`grep` 和 `glob`）

- **在 Git 仓库里**：跳过被 `.gitignore`、`.git/info/exclude` 和全局忽略文件（Git 配置里的 `core.excludesFile`，没设置时是 `~/.config/git/ignore`）忽略的文件；已被 Git 跟踪的文件即使匹配忽略规则也照常搜索。嵌套仓库和子模块用各自的规则。
- **不在 Git 仓库里**：没有忽略规则可用，默认跳过这些目录：`.git`、`.hg`、`.svn`、`node_modules`、`.venv`、`venv`、`__pycache__`、`.next`、`.nuxt`、`.turbo`、`.cache`、`dist`、`build`、`target`、`coverage`。
- **用 `path` 明确指定**一个被忽略或被默认跳过的目录时，会搜索它里面的文件，外层的忽略规则和默认跳过列表都不再生效（在 Git 仓库里时，这个目录内部的 `.gitignore` 仍然生效）。
- 单次搜索最长 20 秒，不会因为复杂的正则卡住服务；一次最多检查 10 万个文件，超出时结果里会说明。

## 安装

需要 Node.js 22.18 或更高版本（推荐 24），以及 Bash（Windows 请装 Git Bash）。服务本身不需要 Git。

```bash
cd /path/to/clouddev-base
npm install        # 会自动编译到 dist/
npm link           # 可选：把 clouddev-base 命令装到全局
```

不想 `npm link` 的话，下文的 `clouddev-base` 都可以换成 `node /path/to/clouddev-base/dist/cli.js`。只在 A 上用的话（A 只需要 `client/` 目录）不用安装。

在 B 上，clouddev-base 本身**不要放在 `~/Documents`、`~/Desktop`、`~/Downloads` 或 iCloud 里**，放到 `~/work` 这类目录：装成后台服务后，launchd 启动的 node 读不到这些目录里的代码（见下文 B 的第 2 步）。

## 用法：A 上的 Claude Code 经 SSH 隧道操作 B

```text
A：跑 Claude Code                                        B：跑 clouddev-base
claude ─► 127.0.0.1:7676 ══ ssh -L（launchd 常驻）══► sshd ─► 127.0.0.1:7676  MCP + OAuth
                                                               127.0.0.1:7677  WebUI（只在 B 本机能打开）
```

- A 用一把**只能转发 7676 端口**的专用密钥主动连 B。B 上的服务只监听 127.0.0.1，网络上只暴露 B 的 SSH 端口。
- 隧道（A）和服务（B）都交给 macOS 的 launchd：登录后自动启动，退出后自动重启。ssh 自带的心跳负责发现断线，见下文“隧道怎样保活和自动重连”。
- 前提是 A 能连到 B 的 SSH 端口：在同一个局域网，或者 B 有公网地址（路由器端口映射也行）。都不行的话见“A 连不到 B 时”。
- 下面按两台都是 Mac 来写；Linux 见“不用 macOS 时”。

### 在 B（被操作的电脑）上

**1. 打开远程登录。** 系统设置 → 通用 → 共享 → 远程登录，“允许访问”选“仅这些用户”，只留运行 clouddev-base 的账号。

**2. 按上面的“安装”步骤装好 clouddev-base，然后初始化**，并记下打印出来的 Owner 密码：

```bash
clouddev-base init --root ~/work --public-url http://127.0.0.1:7676
```

`--public-url` 是 A 上的 Claude Code 访问服务用的地址，也就是隧道在 A 上的那一头。允许访问的目录（`--root`）、clouddev-base 本身和配置目录（`~/.clouddev-base`）都**不要放在 `~/Documents`、`~/Desktop`、`~/Downloads` 或 iCloud 里**：下一步装成后台服务后，launchd 启动的 node 访问这些目录会弹出 macOS 的隐私授权窗口，后台没人点就会失败；代码或配置在这些目录里时，服务干脆起不来。`service install` 发现这种情况会提示。在终端里手动运行时用的是终端的授权，所以不会遇到。

**3. 装成后台服务**（登录后自动运行，退出后由 launchd 自动重启）：

```bash
clouddev-base service install
```

它会生成 `~/Library/LaunchAgents/com.clouddev-base.serve.plist` 并启动服务，日志写到 `~/Library/Logs/clouddev-base.log`。几个容易踩的坑它都处理了：

- **node 路径**：plist 里不写死带版本号的 node（比如 fnm 的 `node-versions/v24.16.0/…`、Homebrew 的 `Cellar/node/24.1.0/…`）：升级或卸载那个版本后它就没了，服务也就起不来。用 fnm 时换成 fnm 的 `default` 别名，用 Homebrew 时换成 `/opt/homebrew/opt/node/bin/node`（都要求指向的就是当前这个 node）。其他安装方式（如 nvm）没有这样的固定路径，升级 node 后要重新运行 `service install`。
- **环境变量**：launchd 启动的服务环境几乎是空的，而 `bash` 工具执行的命令继承服务的环境。所以 `service install` 会把你当前终端里的 PATH（否则 Claude 在 B 上跑 `npm test` 会报 command not found），以及编译、安装依赖常用的变量写进 plist：`JAVA_HOME`、`ANDROID_HOME`、`GOPATH`、`CARGO_HOME`、代理（`HTTPS_PROXY`、`NO_PROXY` 等）、证书（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 等）。安装时会列出带过去了哪些；别的变量要带过去，把名字加进 `config.json` 的 `serviceEnv`（见“配置文件”）。**在你平时开发用的终端里运行 `service install`。** Owner 密码不会写进 plist：终端里设置的 `CLOUDDEV_BASE_PASSWORD` 不会带过去，后台服务用的是 `auth.json` 里的密码。
- 后台任务默认会被 macOS 限速，这里设为不限速，Claude 跑的编译和测试按正常速度执行。
- **经 Claude 运行也可以**：在 A 上让 Claude 在 B 上运行 `service install` 或 `service uninstall` 时，命令会发现自己是在后台服务内部运行的。服务一停，原来的命令会被一起结束，所以它改由一个独立的进程完成：几秒后服务用新配置重启，期间 MCP 连接断开几秒。

用 `clouddev-base service status` 查看状态，`clouddev-base service uninstall` 卸载。用 `init` 改了配置、升级了 node，或者想更新 PATH 等环境变量时，重新运行 `service install`。只想看生成的 plist，用 `service install --print`。

安装后 macOS 会提示“已添加后台项目”。如果在系统设置 → 通用 → 登录项与扩展里关掉了它，launchd 就不会启动服务。不想装后台服务的话，也可以在终端里运行 `clouddev-base serve`。

**4. 让 B 不睡眠。** B 一睡着隧道就会断，直到 B 醒来。后台服务运行期间会用 macOS 自带的 `caffeinate -i` 阻止 B 因为空闲而睡眠，不用改系统设置；但笔记本合上盖子（没接外接显示器时）仍然会睡，这种 B 要开着盖子用。在终端里手动运行 `serve` 时不会阻止睡眠，要么到系统设置 → 能源（笔记本是电池 → 选项）打开“显示器关闭时防止自动进入睡眠”。

**5. 设置 sshd：** 禁止 Unix socket 的反向转发（必须），及时清理死连接、只允许密钥登录（建议）：

```bash
sudo tee /etc/ssh/sshd_config.d/010-clouddev.conf <<'EOF'
# 隧道钥匙在 authorized_keys 里的限制管不到 Unix socket 的反向转发（ssh -R /路径.sock:…），在这里关掉；
# 反过来的 ssh -L 本地端口:/路径.sock 不受影响
AllowStreamLocalForwarding local
# A 突然断网时，B 约 2 分钟内发现并关掉这条连接，连接上还在运行的命令也随之结束
ClientAliveInterval 30
ClientAliveCountMax 3
# 只允许密钥登录。B 的 SSH 端口暴露到公网时必须加；加之前确认你自己登录 B 用的也是密钥
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
```

macOS 的 sshd 每个连接单独启动，改完对新连接生效。

**6.** 接下来在 A 上运行安装脚本时，它会打印一行公钥，**把那一整行加到 B 上这个账号的 `~/.ssh/authorized_keys`**。以前加过这把钥匙（比如改了端口、重新运行了安装脚本）的话，要把旧的那一行换掉，而不是再追加一行：sshd 只认同一把钥匙的第一行。安装脚本还会打印一条命令，能 ssh 登录 B 的话直接运行它，它会替换旧行，并且不会和文件最后一行粘在一起。

**从 Tailscale 迁移过来：** 在 B 上运行 `tailscale serve --https=443 off` 撤掉原来那条转发（也就是旧文档里的 `tailscale serve --bg 7676`；不要用 `tailscale serve reset`，它会清掉 B 上所有 serve 和 funnel 设置。可以先用 `tailscale serve status` 看看有哪些），再用上面第 2 步的 `init --public-url http://127.0.0.1:7676` 把访问地址改成回环地址。旧令牌绑定的是 ts.net 地址，会自动失效，在 A 的 Claude Code 里用 `/mcp` 重新认证一次即可。

### 在 A（你用来操作的电脑）上

**1. 装好 Claude Code，把本项目的 `client/` 目录拷到 A**（放在哪都行）。

**2. 建隧道：**

```bash
client/tunnel/install.sh bob@bob-mac.local
```

`bob@bob-mac.local` 换成 B 上的账号和 B 的地址（B 上运行 `clouddev-base init` 时会打印它）。在同一个局域网里，最好用 B 的局域网名字（在 B 上运行 `scutil --get LocalHostName`，加上 `.local`），B 的 IP 变了也能连上；写 IP 的话，IP 一变隧道就会一直连不上。不在同一个局域网时用 B 的公网地址或域名；SSH 不是 22 端口时加 `-p 端口`。脚本会：

1. 生成隧道专用密钥 `~/.clouddev-tunnel/id_ed25519`（没有口令，后台运行时才不用等人输入）；
2. 生成隧道专用的 ssh 配置 `~/.clouddev-tunnel/ssh_config`。你自己要加的设置（比如经中转机的 `ProxyJump`）写在旁边的 `ssh_config.local` 里：脚本不会改它，重新运行也不会覆盖，而且它优先生效；
3. 打印要加到 B 上 `authorized_keys` 的那一行，等你加好后按回车；
4. 用新配置第一次连接 B，请你核对 B 的主机指纹（在 B 上运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 查看）。这是唯一一次需要人确认，之后不会再问。同时检查 B 上的限制是否生效：钥匙不能执行命令，也不能转发到 B 的别的端口；
5. 确认能连上之后，才换上新的配置、装好 LaunchAgent `~/Library/LaunchAgents/com.clouddev-base.tunnel.plist` 并启动隧道，再确认能经隧道访问 B 上的服务。在这之前失败或按了 Ctrl+C，已经在跑的隧道不受影响。

可以重复运行（比如换了 B 的地址或端口），密钥和已确认的指纹会沿用。加 `--no-load` 只生成文件：不连接 B，也不装进 launchd（登录时不会自动启动）。`client/tunnel/status.sh` 查看状态和日志，`client/tunnel/uninstall.sh` 卸载。

**3. 在 `client/` 目录里启动 Claude Code：**

```bash
cd /path/to/client && claude
```

第一次启动会先问是否信任这个目录，选信任（之后 `client/` 里的设置才会完全生效）。然后输入 `/mcp`，选 clouddev-base 进行认证。浏览器打开授权页后，输入 Owner 密码（在 B 上运行 `clouddev-base password` 可以查看）。

之后直接说“打开 B 上的 ~/work/my-app，跑一下测试并修复失败的用例”即可。

`client/.mcp.json` 里的地址已经是 `http://127.0.0.1:7676/mcp`。它必须和 B 上的 `publicUrl` 完全一致：写成 `localhost`，或者端口不同，OAuth 认证都会失败。如果 A 上 7676 端口被别的程序占用了，就换一个端口 P，三处一起改：
- `install.sh` 加 `--local-port P`；
- `client/.mcp.json` 改成 `http://127.0.0.1:P/mcp`；
- B 上运行 `clouddev-base init --public-url http://127.0.0.1:P`。

B 上的服务本身仍然监听 7676。

`client/` 目录里的文件：

| 文件 | 作用 |
| --- | --- |
| `.claude/settings.json` | 禁用 Claude Code 自带的文件和命令工具，避免误操作 A；打开工作区、读取、搜索自动允许，写文件和执行命令每次先问你 |
| `.mcp.json` | MCP 服务的地址（隧道在 A 上的那一头），以及单次调用的超时时间（见下） |
| `CLAUDE.md` | 告诉 Claude：所有操作都通过 clouddev-base 在 B 上完成，以及这些工具的用法要点 |
| `tunnel/` | SSH 隧道的安装、启动、状态和卸载脚本 |

**禁用的工具。** `settings.json` 的 `deny` 里列的是 Claude Code 自带的、能读写本机文件或执行本机命令的工具：`Bash`、`PowerShell`、`Monitor`、`Read`、`Edit`、`Write`、`NotebookEdit`、`Glob`、`Grep`。Claude Code 以后新增这类工具时，也要把它加进去。如果你在 A 上全局配置过其他能操作本机的 MCP 服务器，它们在这里仍然可用；不想让它们出现，就把 `mcp__<服务器名>` 也加到 `deny` 里。

**超时设置。** `.mcp.json` 里的 `timeout` 单位是毫秒，设为 330 秒有两个作用：

- 把 Claude Code 对单次工具调用的硬上限设为 330 秒（默认约 28 小时），比 `bash` 最长的 300 秒多留一点余量；
- 把 Claude Code 的空闲超时（默认 5 分钟内没有任何响应就中止调用）放宽到 330 秒。

如果客户端在请求里要求了进度通知（带 `progressToken`），命令运行期间服务每 20 秒发一次，也会重置空闲计时；客户端没要求时不发，但上面的 330 秒已经足够覆盖最长的命令。

### 隧道怎样保活和自动重连

隧道就是 launchd 运行的 `ssh -N -n -F ~/.clouddev-tunnel/ssh_config clouddev-b`，不需要 autossh：

| 需求 | 做法 |
| --- | --- |
| 保活 | `ServerAliveInterval 10`：10 秒没收到 B 的数据，就在加密通道里发一次心跳。心跳无法伪造，也能让路由器或 NAT 不因连接空闲把它断掉 |
| 断线检测 | `ServerAliveCountMax 3`：连发 3 次心跳都没有回应就判定断线，ssh 退出（实测 B 没有响应后约 40 秒）。`ConnectTimeout 10` 让连不上的情况也在 10 秒内失败，不会卡住 |
| 断线自动重连 | LaunchAgent 的 `KeepAlive`：ssh 一退出就重新启动。`ThrottleInterval 10`：两次启动至少间隔 10 秒，B 关机时不会疯狂重试 |
| 登录自动启动 | LaunchAgent 的 `RunAtLoad` |
| 转发失败就退出 | `ExitOnForwardFailure yes`：比如 A 的 7676 端口被占用、转发建不起来时，ssh 直接退出交给 launchd 重试，不会出现“连着但没转发”的假在线状态。它只管 A 这一端；B 上服务没起来时 ssh 不会退出，请求会被拒绝，服务恢复后自动就好了 |
| 不等人输入 | `-N -n` 不开 shell、不读标准输入；`BatchMode yes`，需要密码、口令或确认的地方一律直接失败；用无口令的专用密钥；`IdentityAgent none`，不经过 ssh-agent，1Password、Secretive 不会弹确认框；`StrictHostKeyChecking yes`，加上安装时已固定的 B 的指纹 |

**排查：**
- `client/tunnel/status.sh` 显示 launchd 状态（`runs` 是启动过几次，每次断线重连加 1）、能否经隧道访问 B，以及最近的日志。
- 日志在 `~/Library/Logs/clouddev-tunnel.log`。每次（重新）连接记一行带时间的“连接 B…”，后面跟着 ssh 自己的输出：
  - `Authenticated to …`：连上了；
  - `Timeout, server … not responding.`：心跳超时，判定断线；
  - `Address already in use`：本机端口被占用；
  - `open failed: connect failed`：B 上的服务没在运行。
- 立即重连：`launchctl kickstart -k gui/$(id -u)/com.clouddev-base.tunnel`。

**和 Tailscale 相比的代价：** SSH 隧道是一条 TCP 连接，A 换网络或者睡眠唤醒后会断，约 40 秒内发现并自动重连（前提是网络已经恢复）。断开那一刻正在执行的工具调用会失败，B 上对应的命令会在 B 发现断线后结束（见 B 的第 5 步）。如果 Claude Code 是在隧道连通之前启动的，在 `/mcp` 里重连一下即可。

### B 上的 WebUI

服务启动后，在 **B 上**的浏览器打开 <http://127.0.0.1:7677>。页面上显示：

- **进行中：** 正在执行的工具调用和实时计时，`bash` 的输出实时滚动。
- **记录：** 每次调用的工具、工作区、路径/搜索模式/命令、耗时，以及结果（完成、出错、已中止）。展开后：
  - `edit` 显示改了什么；
  - `write` 显示写入的内容和大小；
  - 都能看到结果。

  可以按工具筛选、只看出错、搜索。
- **概况：** 当前客户端（如 Claude Code 及其版本）、最近一次请求是什么时候、服务运行了多久。
- **事件：** 客户端连上或重连、新客户端授权成功、授权页密码输错（如果不是你在输，说明有人在试你的 Owner 密码）。

几点说明：

- WebUI 只监听 127.0.0.1，A 访问不到：隧道只转发 MCP 端口，A 的钥匙在 B 上也只能连 7676。所以它不需要登录。它还会拒绝别的域名指向它的请求（防 DNS rebinding），也拒绝别的网站跨站读取它的数据。
- 记录只保存在内存里（最近 500 次调用），不写磁盘，服务重启后清空。`bash` 命令在 WebUI 里显示全文；写进日志文件的仍然只记长度（见“安全须知”）。参数不对或者工具不存在、服务没有执行的调用也会列出来，标为出错。
- 已中止只用于真的停下来的调用（`bash`、`grep`、`glob`）。读写文件不会因为取消而停下：客户端取消或断开时它们照样做完，记录里标着“未送达”，表示结果没送到客户端，但文件已经改了。
- Claude Code 空闲时隧道里没有任何流量，所以 WebUI 看不出隧道是否连着，隧道状态在 A 上用 `status.sh` 看。
- 页面切到后台时会断开和服务的连接，切回来时重新同步。浏览器对同一个地址最多同时开 6 个连接，这样开多个标签也不会把它们占满。
- 端口用 `--ui-port` 或 `init --ui-port` 修改，设为 `0` 关闭（关闭后服务也不再记录调用）。端口被占用时只有 WebUI 不启动，MCP 服务照常运行，每 30 秒重试一次；`clouddev-base service status` 会显示 WebUI 是否正常。

### A 连不到 B 时（经中转机）

A、B 不在同一个局域网，B 也没有公网地址时，找一台有公网 IP 的机器 R（比如一台 VPS）中转：B 把自己的 SSH 端口反向挂到 R 的 127.0.0.1:2222，A 经 R 跳到 B。A 和 B 之间仍然是端到端的 SSH，R 只能看到密文；B 上 `authorized_keys` 的限制照样生效。B 和 R 上按下面手动配置；A 上仍然用安装脚本，中转的设置写进 `ssh_config.local`。

**R 上：** sshd 加上 `ClientAliveInterval 10` 和 `ClientAliveCountMax 3`，让断掉的旧连接尽快释放端口；再加上 `AllowStreamLocalForwarding local`，原因和 B 的第 5 步一样。

**B 上**，再建一条到 R 的常驻反向隧道：

1. 生成 B 自己的隧道密钥（这个目录在 B 上还不存在，要先建）：

   ```bash
   mkdir -p -m 700 ~/.clouddev-tunnel
   ssh-keygen -t ed25519 -N '' -f ~/.clouddev-tunnel/id_ed25519
   ```

2. 在 R 上那个账号的 `authorized_keys` 里加上 B 的公钥，前面加限制（只能在 R 上监听 127.0.0.1:2222）：

   ```text
   restrict,port-forwarding,permitlisten="127.0.0.1:2222",permitopen="127.0.0.1:1",command="/usr/bin/false" ssh-ed25519 AAAA…（B 的公钥）
   ```

3. 写 `~/.clouddev-tunnel/ssh_config`：

   ```text
   Host clouddev-relay
       HostName r.example.com
       User tunnel
       IdentityFile ~/.clouddev-tunnel/id_ed25519
       IdentitiesOnly yes
       IdentityAgent none
       UserKnownHostsFile ~/.clouddev-tunnel/known_hosts
       StrictHostKeyChecking yes
       BatchMode yes
       # 把 B 的 SSH 端口挂到 R 的 127.0.0.1:2222
       RemoteForward 127.0.0.1:2222 127.0.0.1:22
       # 这里尤其关键：R 上旧连接还占着 2222 时，新连接必须退出重试，而不是连着却没挂上端口
       ExitOnForwardFailure yes
       ServerAliveInterval 10
       ServerAliveCountMax 3
       ConnectTimeout 10
   ```

4. 手动连一次，确认 R 的指纹（应该以退出码 1 结束：受限的钥匙只会执行 `false`）：

   ```bash
   ssh -F ~/.clouddev-tunnel/ssh_config -o BatchMode=no -o StrictHostKeyChecking=ask -o ClearAllForwardings=yes clouddev-relay true
   ```

5. 交给 launchd 常驻（复用 A 上的启动脚本，日志在 `~/Library/Logs/clouddev-tunnel-clouddev-relay.log`）：

   ```bash
   cp client/tunnel/run.sh client/tunnel/common.sh ~/.clouddev-tunnel/
   cat > ~/Library/LaunchAgents/com.clouddev-base.relay-tunnel.plist <<EOF
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.clouddev-base.relay-tunnel</string>
     <key>ProgramArguments</key>
     <array><string>/bin/sh</string><string>$HOME/.clouddev-tunnel/run.sh</string><string>clouddev-relay</string></array>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>ThrottleInterval</key><integer>10</integer>
   </dict>
   </plist>
   EOF
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.clouddev-base.relay-tunnel.plist
   ```

**A 上：**

1. 只生成文件，让隧道连 R 上的 127.0.0.1:2222（也就是 B 的 SSH）：`client/tunnel/install.sh --no-load -p 2222 bob@127.0.0.1`。它打印的那一行照常加到 B 的 `authorized_keys`。
2. 在 R 的 `authorized_keys` 里也加上 A 的公钥（`~/.clouddev-tunnel/id_ed25519.pub`），前面加 `restrict,port-forwarding,permitopen="127.0.0.1:2222",permitlisten="127.0.0.1:1",command="/usr/bin/false"`。
3. 把中转设置写进 `~/.clouddev-tunnel/ssh_config.local`。安装脚本不会改这个文件，生成的 `ssh_config` 会在最前面引用它；专用密钥、指纹检查、不等人输入、心跳这些加固设置写在 `ssh_config` 末尾的 `Host *` 里，对 R 同样生效，这里不用再写：

   ```text
   Host clouddev-b
       ProxyJump clouddev-relay

   Host clouddev-relay
       HostName r.example.com
       User tunnel
   ```

4. 确认 R 的指纹，应该以退出码 1 结束（受限的钥匙只会执行 `false`）：

   ```bash
   ssh -F ~/.clouddev-tunnel/ssh_config -o BatchMode=no -o StrictHostKeyChecking=ask clouddev-relay true
   ```

5. 去掉 `--no-load` 再运行一次：`client/tunnel/install.sh -p 2222 bob@127.0.0.1`。它经 R 连到 B，请你确认 B 的指纹，然后启动隧道。以后重新运行安装脚本（带不带 `--no-load` 都一样）都不会动 `ssh_config.local`，中转设置一直有效。

### 不用 macOS 时

`clouddev-base service` 和 `client/tunnel/install.sh` 的后台部分依赖 launchd。Linux 上用 systemd 的用户服务代替，设置不变。

**B：**

```ini
# ~/.config/systemd/user/clouddev-base.service
[Service]
ExecStart=/usr/bin/node /path/to/clouddev-base/dist/cli.js serve
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

**A：** 先运行 `client/tunnel/install.sh --no-load …` 生成密钥和配置。再手动连一次，确认 B 的指纹：

```bash
ssh -F ~/.clouddev-tunnel/ssh_config -o BatchMode=no -o StrictHostKeyChecking=ask -o ClearAllForwardings=yes clouddev-b true
```

然后写隧道的服务文件：

```ini
# ~/.config/systemd/user/clouddev-tunnel.service
[Service]
ExecStart=/usr/bin/ssh -N -n -F %h/.clouddev-tunnel/ssh_config clouddev-b
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

用 `systemctl --user enable --now <服务名>` 启动。想在没有登录时也运行，再执行 `loginctl enable-linger`。

## 配置文件

都在 `~/.clouddev-base/` 下（可用环境变量 `CLOUDDEV_BASE_HOME` 改位置），权限为 `600`：

| 文件 | 内容 |
| --- | --- |
| `config.json` | `allowedRoots`、`port`（默认 7676）、`host`（默认 127.0.0.1）、`publicUrl`（A 上的客户端访问服务用的地址，默认 `http://127.0.0.1:<port>`）、`uiPort`（WebUI 端口，默认 7677，0 关闭；`port` 设成 7677 而没设 `uiPort` 时用 7678）、`allowedRedirectHosts`、`serviceEnv`（见下） |
| `auth.json` | Owner 密码（见下） |
| `oauth.json` | 已注册的客户端和令牌（令牌只存 SHA-256 哈希） |
| `workspaces.json` | `workspace_id` 与项目目录的对应关系 |

**Owner 密码。** 保存在 `auth.json`，至少 16 个字符。也可以用环境变量 `CLOUDDEV_BASE_PASSWORD` 提供，它优先于文件；设为空值等于没设。服务每次授权时都重新读取。这个环境变量不会传给 `bash` 执行的命令，但这只是防止意外泄露：`bash` 不是沙箱，命令仍能读到 `auth.json`。

**`serviceEnv`。** `service install` 除了 PATH、LANG 和常用的开发变量（见“在 B 上”第 3 步），还会把这里列出的环境变量从当前终端带进后台服务，例如 `["DATABASE_URL", "PNPM_HOME"]`（没有对应的命令行参数）。改完重新运行 `service install`。值会以明文写进 `~/Library/LaunchAgents` 里的 plist；`CLOUDDEV_BASE_PASSWORD` 列在这里也不会带过去。

**`allowedRedirectHosts`。** 决定哪些客户端能注册授权。回调地址在本机回环地址（`localhost`、`127.0.0.1`、`[::1]`）上的客户端总是允许，Claude Code 就属于这种，所以默认列表是空的。要接入回调地址是 `https://` 网址的其他 MCP 客户端，就编辑 `config.json`，把回调地址的主机名加进去，例如 `["example.com"]`（没有对应的命令行参数），改完重启服务。

## 安全须知

- 连上的 AI 等同于一个能操作你电脑的协作者。文件工具被限制在工作区内，但 **`bash` 不是沙箱**，命令以你的用户权限运行。
- 每个新客户端都必须在授权页输入 Owner 密码才能拿到令牌。密码不要外泄；授权页会显示授权后跳转的域名，只批准你自己发起的连接。授权成功和密码输错都会显示在 B 的 WebUI 上。
- 要让所有已连接的客户端失效：删除 `~/.clouddev-base/oauth.json`。运行中的服务（包括后台服务）立即生效、不用重启，不会再把旧的客户端和令牌写回去；之后每个客户端都要重新输入 Owner 密码授权。`clouddev-base password --reset` 生成新密码，同样立即生效，但它不会注销已连接的客户端，两件事要一起做。
- 服务只监听 127.0.0.1，别的电脑只能经 SSH 隧道访问它。A 上的隧道密钥没有口令（这样后台运行才不用等人输入），所以它在 B 上被 `authorized_keys` 的前缀限制住了：
  - `restrict` 关掉终端、agent 和 X11 转发、`~/.ssh/rc`；
  - `port-forwarding` 只重新打开端口转发；
  - `permitopen` 只允许连 B 的 127.0.0.1:7676；
  - `permitlisten` 只放行一个没用的端口，等于禁止 TCP 的反向转发；
  - `command="/usr/bin/false"` 让它即使请求 shell、scp、sftp 也只会执行 `false`。

  这些前缀只管 TCP 端口，管不到 Unix socket 的反向转发（`ssh -R /路径.sock:…`，能在 B 上任意可写的位置放一个 socket，把 B 上程序的连接转给对方），所以 B 的 sshd 还要设置 `AllowStreamLocalForwarding local`（“在 B 上”第 5 步）。两样都做了，这把钥匙即使被偷，也只能碰到 7676，而 7676 还要 OAuth 令牌和 Owner 密码。不要去掉这些限制，也不要把它加到能做别的事的账号设置里。
- 不要把 7676 端口直接开放到网络上（改 `--host`、做端口映射，或者用 cloudflared、ngrok、`tailscale funnel` 之类的工具），那样挡住别人的就只剩 Owner 密码和授权令牌了。B 的 SSH 端口要暴露到公网时，按“在 B 上”第 5 步只允许密钥登录。
- 服务端日志（终端里，或后台服务的 `~/Library/Logs/clouddev-base.log`）逐行记录每次工具调用（工具名、文件路径或搜索模式、耗时）。命令里可能带密钥，所以 `bash` 默认只记录命令长度；想看到完整命令，启动前设置环境变量 `CLOUDDEV_BASE_LOG_COMMANDS=1`（`service install` 会把它带进后台服务，并提示你）。后台服务的日志超过 10MB 时，旧的内容挪到 `clouddev-base.log.1`（只留一份）；服务自动生成 Owner 密码时也不会把它写进日志。
- WebUI 只监听 127.0.0.1，在 B 本机才能打开。里面的命令全文只保存在内存里，不写磁盘。

## 排错

- **先分段确认是通的。** 在 B 上运行 `curl http://127.0.0.1:7676/healthz`，再在 A 上运行同一条命令。两边都应该返回 `{"ok":true,"name":"clouddev-base","pid":…}`，而且 `pid` 相同：
  - B 本机就不通，问题在服务上：运行 `clouddev-base service status`，看 `~/Library/Logs/clouddev-base.log`；
  - B 通、A 不通，问题在隧道上：在 A 上运行 `client/tunnel/status.sh`。
- **隧道日志里反复出现 `Timeout, server … not responding.` 或 `connect to host … timed out`**：A 连不到 B。检查 B 是否睡着了、地址是否变了（换了地址就重新运行 `install.sh`，在局域网里最好改用 B 的 `.local` 名字），以及 B 的远程登录是否打开。
- **`status.sh` 说本机端口被别的程序占着**：A 上有别的程序（比如在 A 上也运行了 `clouddev-base serve`）占着隧道要用的端口，隧道绑不上它。停掉那个程序，或者三处一起换一个端口（见“在 A 上”第 3 步后面的说明）。
- **`Permission denied (publickey)`**：B 上的 `authorized_keys` 里没有那一行，或者账号不对；`install.sh` 打印的那一行也保存在 `~/.clouddev-tunnel/authorized_keys_line.txt`。
- **`Host key verification failed`**：B 的主机指纹变了（重装了系统，或者换了一台 B）。确认是你自己的 B 后，删掉旧指纹 `ssh-keygen -R clouddev-b -f ~/.clouddev-tunnel/known_hosts`，再运行一次 `install.sh`。
- **`administratively prohibited`**：B 上 `authorized_keys` 那一行的 `permitopen` 端口和 B 上服务的端口不一致；或者这把钥匙在 `authorized_keys` 里有不止一行（比如改端口后又追加了一行），sshd 只认第一行，删掉旧的。
- **返回 403 `Invalid Host`**：请求里的主机名不在允许列表里，比如 `.mcp.json` 写的不是 `127.0.0.1`。
- **Claude Code 认证失败，提示 resource 不匹配**：`client/.mcp.json` 的地址和 B 上的 `publicUrl` 不一致（`localhost` 和 `127.0.0.1` 也算不一致），改成一样后重新 `/mcp`。
- **Claude 在 B 上执行命令提示 command not found，或者编译、安装依赖时缺环境变量（`JAVA_HOME`、代理等），手动在终端里却可以**：后台服务的环境是安装时从终端里带过去的。在平时开发用的终端里重新运行 `clouddev-base service install`，看它列出的变量；缺的变量加进 `config.json` 的 `serviceEnv`。
- **启动时提示端口已被占用**：用 `--port` 换一个端口，隧道的 `--remote-port` 和 `authorized_keys` 里的 `permitopen` 也一起改。只有 WebUI 端口被占用时，MCP 服务照常运行，用 `--ui-port` 换一个即可。
- **授权页一直提示密码不正确**：在终端里运行的 `serve` 如果设置了 `CLOUDDEV_BASE_PASSWORD`，以这个环境变量为准；后台服务不读这个变量，用的是 `auth.json` 里的密码。`clouddev-base password` 显示的是环境变量的值时会注明，在没设这个变量的终端里运行它，看到的才是 `auth.json` 里的密码。
- **新客户端连接时注册失败**：回调地址不在本机回环地址上的客户端，要先把它回调地址的主机名加进 `allowedRedirectHosts`（见“配置文件”）。

## 开发

```bash
npm test           # 单元测试 + MCP 端到端测试 + 完整 OAuth 流程测试 + 启动真实 serve 进程的 CLI 测试 + 隧道脚本测试
npm run typecheck
npm run build      # 编译到 dist/，并把 src/webui/ 复制过去
```

```text
src/
  cli.ts            命令行：init / serve / service / password
  config.ts         配置与 Owner 密码
  http.ts           HTTP 服务：OAuth 端点 + /mcp（无状态 Streamable HTTP，5 分钟 keep-alive，
                    跨请求的取消，鉴权后才解析请求体）
  oauth.ts          单用户 OAuth 授权服务器（授权页、令牌签发与轮换）
  mcp.ts            MCP 服务器与 7 个工具的定义（客户端要求时，长命令每 20 秒发送进度通知）
  activity.ts       WebUI 用的活动记录：最近的工具调用、命令的实时输出、连接和授权事件（只在内存里）
  webui.ts          WebUI 服务：只监听 127.0.0.1，页面 + SSE 事件流
  webui/            WebUI 页面（纯 HTML/CSS/JS，不需要构建）
  service.ts        macOS 后台服务（launchd）：生成 plist、加载、卸载、查看状态
  markup.ts         HTML/XML 转义（授权页和 plist 共用）
  workspaces.ts     工作区注册与允许目录校验
  paths.ts          路径解析与越界防护（含符号链接）
  version.ts        版本号
  tools/common.ts   工具共用的输出截断（2000 行 / 50KB）与二进制文件判断
  tools/files.ts    read / write / edit（edit 只改 UTF-8 文本）
  tools/search.ts   grep / glob：在 worker 线程里执行，20 秒硬时限
  tools/search-worker.ts  worker 入口与搜索实现
  tools/file-list.ts      文件枚举：不调用 git，不跟随符号链接
  tools/gitignore.ts      .gitignore 规则
  tools/git-index.ts      读取 .git/index（已跟踪的文件即使匹配忽略规则也会列出，与 git 一致）
  tools/glob-match.ts     不回溯的 glob 匹配
  tools/shell.ts    bash（不把服务自己的密钥传给命令；输出可实时转给 WebUI）
client/             在电脑 A 上启动 Claude Code 用的目录（见“用法”）
  .claude/settings.json
  .mcp.json
  CLAUDE.md
  tunnel/           A 上的 SSH 隧道：install.sh / run.sh / status.sh / uninstall.sh，共用的路径和检查在 common.sh
```
