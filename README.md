# clouddev-base

一个精简的 MCP 服务器：让一台电脑（A）上的 Claude Code（或其他支持 MCP 的客户端）经 SSH 隧道打开另一台电脑（B）上的项目，**读写、搜索代码，执行终端命令**。B 上还有一个只在本机能打开的网页，实时显示 Claude Code 在 B 上做的每一步。

## 提供给 AI 的工具

| 工具 | 作用 |
| --- | --- |
| `open_workspace` | 打开允许目录内的一个项目，返回 `workspace_id`（同一项目永远是同一个 id，重启后仍有效） |
| `read` | 读文件，每次最多 2000 行，读不完时结果开头会写明接着读的 `offset`（也可以自己用 `offset`/`limit` 翻页）；一行就超过一页的上限时，只显示它的开头（最多 20,000 字符），提示里给出按字节接着看的 bash 命令（`sed -n` 取出这一行，`cut -b` 取下一段）；超过 10MB 的文本文件不读，改用 bash（`head`、`tail`、`sed -n`、`grep`）；读目录则列出内容；图片以图片形式返回；不是 UTF-8 编码的文件（如 GBK）会附带提示；带 BOM 的 UTF-16 文件解码后显示，开头注明 `edit` 改不了它，并给出转成 UTF-8 的 `iconv` 命令（写明字节序，比如 `-f UTF-16LE`：macOS 自带的 iconv 只写 `-f UTF-16` 时，可能把含 emoji 的小端文件转错又不报错）；命名管道、套接字和设备文件直接拒绝 |
| `write` | 新建或整体覆盖文件，自动创建父目录（怎样保存见下文） |
| `edit` | 按“精确原文 → 新文本”替换，原文必须唯一匹配；保留 CRLF 换行与 BOM；同一文件的并发编辑会排队执行；只改 UTF-8 文本文件，GBK 等其他编码、UTF-16（提示用 `iconv` 转换）和二进制文件会被拒绝，以免保存时损坏原有字符；超过 64MB 的文件也不改，提示改用 bash（`sed -i`、`perl -pi`） |
| `grep` | 用正则搜索文件内容，输出 `路径:行号:内容`；跳过被忽略的文件（见下文）和符号链接；二进制文件（不论大小）、大于 2MB 的文本文件和没有权限读的文件也不搜，但会在结果开头注明；带 BOM 的 UTF-16 文件会解码后搜索 |
| `glob` | 按文件名模式找文件，如 `*.ts`、`src/**/*.{js,jsx}`；只返回真实存在的普通文件，跳过被忽略的文件（规则与 `grep` 相同）；读不了的目录，以及只能列出、不能进入的目录里的文件，会在结果开头注明 |
| `bash` | 在项目目录执行命令（默认超时 30 秒，最长 300 秒）：成功时返回输出末尾，失败（非 0 退出码、超时、取消）时返回开头和结尾并标记为错误，见下文 |

每次调用返回的文字都控制在约 45,000 字符、50KB 以内，截断、翻页、跳过了哪些文件这类说明都放在结果开头：Claude Code 会把超过 50,000 字符的结果存进 A 上的文件，只给模型看开头一小段，而从 `client/` 启动时模型打不开那个文件。

所有文件路径都相对于工作区根目录，任何读写都不能越出工作区（包括通过符号链接越界）。

### 写文件（`write` 和 `edit`）

- 新内容先写进同一目录下的临时文件，落盘后再替换原文件：磁盘写满、服务被杀或断电时，原文件保持完整。服务在写的中途被杀，可能留下 `.<文件名>.clouddev-<随机串>.tmp` 文件或 `.clouddev-<随机串>` 目录（macOS 上克隆原文件用的，里面可能还有 `ditto` 没拷完的 `.BC.T_*`），都可以直接删掉。
- 这样保存后，这个路径就是一个新文件：还开着旧文件的程序继续用旧内容，直到重新打开这个路径，比如往日志里写的服务、`tail -f`；只挂载了这一个文件的容器（比如 `-v $PWD/nginx.conf:/etc/nginx/nginx.conf`）要重启容器才看得到新内容，在容器里 reload 不够。把文件写成空内容是例外：直接就地清空，还是原来那个文件，所以用 `>>` 追加写日志的服务会从头接着写；用 `>` 写日志的服务还会写在原来的位置，前面留下一段 NUL 字节，`read`、`grep` 会把整个文件当成二进制文件。
- 保留原文件的权限位（setuid、setgid 除外，普通写入也会清掉它们）和所属组。macOS 上还保留扩展属性和 ACL（克隆原文件失败时保留不了，结果里会说明）；Linux 上直接设在文件上的 ACL 和扩展属性不保留（从目录继承来的默认 ACL 照样会有）。有硬链接的文件保存后成为单独的文件，别处的链接仍是旧内容，结果里会说明。
- 文件属于别的用户，或者没法在它所在的目录里替换它（比如目录不可写）时，改为直接写原文件，没有上面这些保护，中途失败时结果里会说明。目录的 ACL 不允许删除文件时，写入会留下一个删不掉的临时文件或空的临时目录，结果里写明它的名字；服务运行期间，只要它还在，这个目录里之后的写入都直接写原文件，不会越留越多。删掉它（得先改掉目录的 ACL）之后，写入又会先写临时文件。
- 拒绝写入 Git 目录里的文件：名叫 `.git` 的目录（不分大小写，经符号链接的也算），以及 Git 会当成仓库目录的目录（同时有 `HEAD` 文件和 `objects/`、`refs/` 目录，比如裸仓库）。改 Git 的状态请用 `bash` 执行 git 命令。这只保护已有的 Git 目录，见“安全须知”。
- 也拒绝写入命名管道等非普通文件、只读文件，以及磁盘可用空间不到“新内容大小 + 预留空间”的时候（预留磁盘容量的 2%，最少 1MB，最多 64MB；把文件清空不受这个限制）。
- `edit` 读出文件之后、保存之前，文件又被别的程序改了的话，这次修改作废，不会冲掉别人的改动。
- Claude Code 的检查点（`/rewind`）撤不回 B 上的任何改动：它只跟踪 A 上自带编辑工具改的文件。要能退回，在 B 上用 Git，比如开始前先提交一次。

### 执行命令（`bash`）

- 用的是 `/bin/bash`（macOS 上是 3.2，没有关联数组；Windows 上是 Git Bash），非登录、非交互，不读 `~/.zshrc`；每次调用都是新的 shell。
- 成功时返回输出末尾，最多 2000 行；失败时最多约 9,500 字符，太长就保留开头约 2,000 字符和结尾，省略了多少行写在开头，退出状态在最后。输出超过约 1MB 时，内存里只留开头 16KB 和最后约 1MB，被截断的那一行会在行内注明缺了多少字节。
- 去掉颜色等终端转义序列；用 `\r` 刷新的进度条只保留最后的样子。输出放得下时，长行原样返回（比如一整行的 JSON）；放不下时才截长行，只留首尾两段：成功时一行最多留约 20,000 字符，按 2,000 字符截能多显示几行时就按 2,000 截；失败时一行最多留约 2,000 字符。
- 超时或客户端取消调用（如在 Claude Code 里按 Esc）时，先对命令的整个进程组发 SIGTERM，让它们收尾（比如 git 删掉 `index.lock`、执行 `trap` 里的清理），3 秒后还有进程在运行就发 SIGKILL。在终端里按 Ctrl+C 停止 `serve` 时，正在运行的命令也这样停下；再按一次 Ctrl+C 不再等，立即结束。Windows 上没有进程组，超时或取消时用 taskkill 立即结束整个进程树。
- 没重定向输出的后台进程（`cmd &`，macOS 上的 `nohup cmd &` 也一样）不会因为调用结束被杀掉，但它之后的输出都被丢弃，结果开头会提示；只有它在 60 秒内写出超过 16MB 时（比如 `yes &` 刷屏），输出才会被关掉，它再写就会出错，通常随之退出。要一直运行的服务，把输出追加到文件：`nohup npm run dev >> dev.log 2>&1 &`。
- 服务的环境里有代理变量（`http_proxy`、`https_proxy`、`all_proxy`，大小写都算）时，命令拿到的 `no_proxy`、`NO_PROXY` 会加上 `localhost,127.0.0.1,::1`：curl、git、测试工具访问 B 上自己的服务时直接连，不走代理。

### 搜索范围（`grep` 和 `glob`）

- **在 Git 仓库里**：跳过被 `.gitignore`、`.git/info/exclude` 和全局忽略文件（Git 配置里的 `core.excludesFile`，没设置时是 `~/.config/git/ignore`）忽略的文件；已被 Git 跟踪的文件即使匹配忽略规则也照常搜索。嵌套仓库和子模块用各自的规则。
- **不在 Git 仓库里**：没有忽略规则可用，默认跳过这些目录：`.git`、`.hg`、`.svn`、`node_modules`、`.venv`、`venv`、`__pycache__`、`.next`、`.nuxt`、`.turbo`、`.cache`、`dist`、`build`、`target`、`coverage`。
- **用 `path` 明确指定**一个被忽略或被默认跳过的目录时，会搜索它里面的文件，外层的忽略规则和默认跳过列表都不再生效（在 Git 仓库里时，这个目录内部的 `.gitignore` 仍然生效）。
- `grep` 没搜的文件和目录会在结果开头写明，没有匹配时也写，免得把“没搜到”当成“没有”：大于 2MB 的文本文件、没有权限读的文件和目录给出数量和前 3 个路径，二进制文件只给数量（大于 2MB 的图片、视频等也算二进制文件）。只能列出名字、不能进入的目录（有 `r` 没有 `x`）里的文件和子目录也算读不了。`glob` 同样写明读不了的目录，以及在这种目录里找到、但没法确认的文件。用 `path` 指定的单个文件没被搜索时（太大、二进制、没有权限、不是普通文件），`grep` 直接返回错误并说明原因；太大时建议在 bash 里用 `grep -n` 或 `rg` 搜（UTF-16 文件先经 `iconv` 转成 UTF-8），10MB 以内的也可以用 `read` 分段看。
- 结果超出上面说的字数时只保留前面的部分，开头会写明显示了多少条。
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

**从旧版本升级。** 在 B 上更新代码、运行 `npm install` 之后：

- 在 B 上运行 `clouddev-base service install`（经 Claude 在 B 上运行也可以），后台服务才会换用新代码：`npm install` 只重新编译 `dist/`，正在运行的服务还是旧代码。`service install` 先检查配置，配置有问题就直接报错、不动正在运行的服务，按下一条改好再运行。在 B 上运行 `curl --noproxy '*' http://127.0.0.1:7676/healthz`，返回的 `pid` 变了就说明换上了；服务还在运行旧代码时，`clouddev-base service status` 也会提示。在终端里运行 `serve` 的，停掉重新运行。
- 允许访问的目录里有 `/`、家目录或它的上级目录（macOS 上的 `/System`、`/System/Volumes` 也算），或者有包含配置目录的目录时，新版本的 `serve` 和 `service install` 会拒绝启动：后台服务下次重启（重新登录、重启电脑）时就起不来，launchd 每 10 秒重试一次。先运行 `clouddev-base init --root ~/work` 换成放项目的目录（确实需要原来的目录时加 `--allow-broad-roots`，见“在 B 上”第 2 步），再运行 `clouddev-base service install`。这时 `clouddev-base service status` 会先显示拒绝的原因，再照常显示后台服务的状态和上次退出码。
- `clouddev-base password` 不再直接显示密码，要加 `--show`。
- A 上要把新的 `client/` 重新拷一遍（自己改过 `.claude/settings.json`、`CLAUDE.md`，或者换过端口、改过 `.mcp.json` 的话，把改动合并过去），以后用 `client/start.sh` 启动（见“在 A 上”第 3 步）；这时 `/mcp` 如果显示 clouddev-base 需要认证，再认证一次。建议再运行一次 `client/tunnel/install.sh <B 上的用户名>@<B 的地址>`，让它把 B 上的限制逐项试一遍：没写的端口参数沿用上次的值（见“在 A 上”第 2 步）。

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

**2. 按上面的“安装”步骤装好 clouddev-base，然后在 B 的终端里初始化**，并记下它显示的 Owner 密码（只在刚生成时、在终端里显示这一次，以后在 B 的终端里用 `clouddev-base password --show` 查看）：

```bash
clouddev-base init --root ~/work --public-url http://127.0.0.1:7676
```

`--root` 只给放项目的目录，比如 `~/work`。`read`、`grep`、`glob` 不经你确认就能执行，所以 `init`、`serve` 和 `service install` 都会拒绝 `/`、家目录或它的上级目录（macOS 上的 `/System`、`/System/Volumes` 也算：它们经 `/System/Volumes/Data` 包含家目录），以及包含配置目录（`~/.clouddev-base`）的目录：否则 `~/.ssh` 里的私钥等文件不经确认就能被读进 A 上的对话记录，配置目录也只剩“工作区不能包含配置目录”这一道检查。确实需要这样的目录时，`init` 加 `--allow-broad-roots`（保存进 `config.json`，以后再运行 `init` 也要加上）。即使加了，配置目录里面的目录也不能作为允许访问的目录，工作区也不能包含配置目录（换成 macOS 上 `/System/Volumes/Data` 下的名字，或者经符号链接，也不行）。

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

用 `clouddev-base service status` 查看状态，`clouddev-base service uninstall` 卸载。用 `init` 改了配置、更新了 clouddev-base 的代码、升级了 node，或者想更新 PATH 等环境变量时，重新运行 `service install`。只想看生成的 plist，用 `service install --print`。

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
4. 用新配置第一次连接 B，请你核对 B 的主机指纹（在 B 上运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 查看）。这是唯一一次需要人确认，之后不会再问。接着逐项试这把钥匙在 B 上能做什么，每项通过打印一个 ✓：不能执行命令；不能随便转发（试 127.0.0.1:1）；不能在 B 上监听端口（试 `ssh -R 127.0.0.1:0`）；不能在 B 上建 Unix socket（试 `ssh -R /tmp/clouddev-probe-….sock`，靠 B 的第 5 步）；能转发到 B 的 `--remote-port`（默认 7676），而且那里回答的是 clouddev-base。哪项限制没生效或者没能确认（比如这次没连上 B），或者 B 不让转发到 `--remote-port`（端口写错，或者 `authorized_keys` 里这把钥匙前面还有旧行），脚本就停下，正在用的隧道和配置不动；那个端口上的程序不回答也会停下：约 30 秒内没有完成（连接确实这么慢的话，用环境变量 `CLOUDDEV_TUNNEL_PROBE_WAIT` 设更长的秒数），或者连上就断开、什么也没回。只有两种情况给个提示、照样安装：那个端口上还没有程序在监听，或者回答的是别的程序。`ssh_config.local` 里的 `LogLevel`、转发和连接复用设置不影响这些检查；
5. 确认能连上之后，才换上新的配置、装好 LaunchAgent `~/Library/LaunchAgents/com.clouddev-base.tunnel.plist` 并启动隧道，再确认能经隧道访问 B 上的服务。在这之前失败或按了 Ctrl+C，已经在跑的隧道不受影响。

可以重复运行（比如换了 B 的地址或端口），密钥和已确认的指纹会沿用。没写的 `--local-port`、`--remote-port` 沿用上次的值，不会回到默认值，`-p` 只在 B 的地址没变时沿用（脚本会打印沿用了哪些）；写了和上次不同的端口会提示一句，`--local-port` 和旁边 `client/.mcp.json` 里的端口对不上时也会提示。加 `--no-load` 只生成文件：不连接 B，也不装进 launchd（登录时不会自动启动）。`client/tunnel/status.sh` 查看状态和日志，`client/tunnel/uninstall.sh` 卸载。

**3. 用 `client/start.sh` 启动 Claude Code：**

```bash
/path/to/client/start.sh
```

它在 `client/` 目录里运行 `claude`，只开放几样不碰 A 上文件和命令的自带工具，MCP 也只连 `.mcp.json` 里的 clouddev-base（见下面的“禁用的工具”）。`claude` 的其他参数照常加在后面，比如 `client/start.sh --resume`、`client/start.sh "打开 B 上的 ~/work/my-app，跑一下测试"`。也可以 `cd /path/to/client && claude`，这时靠 `settings.json` 的 `deny` 兜底。

想在任何目录启动的话，把 `start.sh` 链接到 PATH 里的目录，比如 `ln -s /path/to/client/start.sh ~/.local/bin/cdev`，之后运行 `cdev` 即可：脚本会顺着链接找回 `client/`。它依次在环境变量 `CLAUDE_BIN`、PATH、`~/.claude/local/claude`、`~/.local/bin/claude` 里找 `claude`；终端里的 `claude` 是 shell 的 alias 时脚本看不到，用 `type claude` 查出它指向的程序，再运行 `CLAUDE_BIN=那个路径 client/start.sh`。

第一次启动会先问是否信任这个目录，选信任（之后 `client/` 里的设置才会完全生效）。然后输入 `/mcp`，选 clouddev-base 进行认证。浏览器打开授权页后，输入 Owner 密码（在 B 的终端里运行 `clouddev-base password --show` 查看；不要让 Claude 去运行它，否则密码会进入 A 上的对话记录）。

之后直接说“打开 B 上的 ~/work/my-app，跑一下测试并修复失败的用例”即可。

`client/.mcp.json` 里的地址已经是 `http://127.0.0.1:7676/mcp`。它必须和 B 上的 `publicUrl` 完全一致：写成 `localhost`，或者端口不同，OAuth 认证都会失败。如果 A 上 7676 端口被别的程序占用了，就换一个端口 P，三处一起改：
- `install.sh` 加 `--local-port P`；
- `client/.mcp.json` 改成 `http://127.0.0.1:P/mcp`；
- B 上运行 `clouddev-base init --public-url http://127.0.0.1:P`。

B 上的服务本身仍然监听 7676。

`client/` 目录里的文件：

| 文件 | 作用 |
| --- | --- |
| `start.sh` | 用白名单启动 Claude Code：只开放几样不碰 A 的自带工具，MCP 只连 clouddev-base（见上面第 3 步） |
| `.claude/settings.json` | 禁用 Claude Code 自带的文件、命令和跨会话等工具（见下面的“禁用的工具”），避免误操作 A；打开工作区、读取、搜索自动允许，写文件和执行命令每次先问你 |
| `.mcp.json` | MCP 服务的地址（隧道在 A 上的那一头）、单次调用的超时时间（见下），以及 `alwaysLoad`：启动时就加载 clouddev-base 的工具 |
| `CLAUDE.md` | 告诉 Claude：所有操作都通过 clouddev-base 在 B 上完成，以及这些工具的用法要点 |
| `tunnel/` | SSH 隧道的安装、启动、状态和卸载脚本 |

**禁用的工具。** 以白名单启动为主，`deny` 名单兜底：

- `start.sh` 用 `--tools` 只开放 `AskUserQuestion`、`Skill`、`ExitPlanMode`（计划模式里 Claude 用它请你确认退出计划模式；这里写不了计划文件，计划写在它的回复里）、`TaskStop`（停掉超过 2 分钟、被 Claude Code 转到后台的调用）和任务列表（`TaskCreate`、`TaskGet`、`TaskList`、`TaskUpdate`），Claude Code 以后新增的自带工具也不会出现；用 `--strict-mcp-config` 只连 `.mcp.json` 里的 clouddev-base，claude.ai 连接器、插件带的 MCP 服务器和 A 上其他配置里的服务器都不加载；用 `--no-chrome` 不连 A 上的 Chrome（即使在 `/chrome` 里设了默认启用）。白名单里没有 `ToolSearch`，clouddev-base 的工具不用等用到时再搜索；`.mcp.json` 又给它设了 `alwaysLoad`，启动时最多等它 5 秒，命令行上给的第一句话发出时工具已经在了。隧道不通或者要重新认证时等不到，会话照常开始，`/mcp` 里能看到原因。
- `settings.json` 用不用 `start.sh` 都生效。`deny` 里有能读写本机文件或执行本机命令的 `Bash`、`PowerShell`、`Monitor`、`Read`、`Edit`、`Write`、`NotebookEdit`、`Glob`、`Grep`、`LSP`（装了代码智能插件时，它经语言服务器读本机文件），给你在本机和云端的其他会话发消息的 `SendMessage`、`ListAgents`，在 claude.ai 上建云端定时任务的 `RemoteTrigger`，以及可能把会话移到没有这份设置的工作树里的 `EnterWorktree`、`ExitWorktree`。另外：拒收其他会话发来的消息（`crossSessionInbound: "refuse"`），关掉 claude.ai 连接器（`disableClaudeAiConnectors`），skill 和自定义命令里内嵌的 `` !`命令` `` 不执行（`disableSkillShellExecution`），不能用 `--dangerously-skip-permissions` 跳过权限确认（`disableBypassPermissionsMode`）。

直接运行 `claude` 时，你在 A 上全局配置的和插件带的 MCP 服务器、`WebFetch`、`WebSearch`、`Agent`，以及设了默认启用的 Claude in Chrome 仍然可用：不想让某个 MCP 服务器出现，就把 `mcp__<服务器名>` 加到 `deny` 里，或者改用 `start.sh`。Claude Code 以后新增能操作本机的工具时，也要把它加进 `deny`。

**超时设置。** `.mcp.json` 里的 `timeout` 单位是毫秒，设为 330 秒有两个作用：

- 把 Claude Code 对单次工具调用的硬上限设为 330 秒（默认约 28 小时），比 `bash` 最长约 303 秒（300 秒超时，再加 SIGTERM 之后最多 3 秒的宽限）多留一点余量；
- 把 Claude Code 的空闲超时（默认 5 分钟内没有任何响应就中止调用）放宽到 330 秒。

如果客户端在请求里要求了进度通知（带 `progressToken`），命令运行期间服务每 20 秒发一次，也会重置空闲计时；客户端没要求时不发，但上面的 330 秒已经足够覆盖最长的命令。

**安装 skill。** skill 由 A 上的 Claude Code 读取，装在 B 上的 skill 它读不到。从 `client/` 启动的 Claude Code 在 A 上写不了文件、也执行不了命令（见上面的“禁用的工具”），B 上的 `write` 又只能写工作区，所以 Claude 自己装不了 skill，要你在 A 上装：

- 插件：在会话里运行 `/plugin install <插件>@<市场>`。官方市场以外的插件，先用 `/plugin marketplace add <所有者>/<仓库>` 添加它所在的市场。这些是 Claude Code 自己执行的命令，不受 `deny` 限制。
- 单个 skill 目录：在 A 的终端里拷到 `client/.claude/skills/<名字>/`（只对从 `client/` 启动的 Claude Code 生效），或者 `~/.claude/skills/<名字>/`（A 上所有项目都生效）。

装之前先看它带了什么：

- 插件可以带 hooks 和 MCP 服务器，skill 的 `SKILL.md` 开头可以声明 `hooks`。hooks 在 A 上执行命令，`deny` 里的 `Bash` 管不到。
- skill 还可以声明 `allowed-tools`：调用这个 skill 的那一轮，列出的工具不用你批准就能用。比如列了 `mcp__clouddev-base__bash`，那一轮在 B 上执行命令就不再问你。
- skill 和自定义命令正文里内嵌的 `` !`命令` `` 在这里不会执行（`settings.json` 设了 `disableSkillShellExecution`），但这个设置管不到 hooks。

也因为这样，不要为了让 Claude 自己装 skill 去放开 `Write`、`Edit` 或 `Bash`：能写 skill，就能借它的 hooks 在 A 上执行命令。

从 `client/` 启动时（`start.sh` 也留着 `Skill` 工具），Claude 只用得上 `SKILL.md` 的正文。skill 附带的参考文件和脚本要靠 A 上的 `Read`、`Bash` 才能读、才能跑，这里都禁用了，所以纯说明、不带脚本的 skill 最适合。要用 skill 自带的脚本处理 B 上的文件时，让 Claude 用 `bash` 把脚本拉到 B 上、装好依赖，每条命令照常先问你。

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

**SSH 隧道的局限：** 隧道是一条 TCP 连接，A 换网络或者睡眠唤醒后会断，约 40 秒内发现并自动重连（前提是网络已经恢复）。断开那一刻正在执行的工具调用会失败，B 上对应的命令会在 B 发现断线后结束（见 B 的第 5 步）。如果 Claude Code 是在隧道连通之前启动的，在 `/mcp` 里重连一下即可。

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
- 端口用 `--ui-port` 或 `init --ui-port` 修改，设为 `0` 关闭（关闭后服务也不再记录调用）。端口被占用时只有 WebUI 不启动，MCP 服务照常运行，每 30 秒重试一次；`clouddev-base service status` 会显示 WebUI 是否正常。WebUI 的文件缺失时（比如编译中途出错）也只是 WebUI 不启动，启动信息里显示“WebUI: 没有启动: …”和原因，重新编译后重启服务才会恢复。

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

都在 `~/.clouddev-base/` 下（可用环境变量 `CLOUDDEV_BASE_HOME` 改位置，设为空值等于没设），目录权限为 `700`、文件为 `600`，`serve` 每次启动时都会改回这个权限（属于别的用户的文件不动，比如用 sudo 运行过、属于 root 的）：

| 文件 | 内容 |
| --- | --- |
| `config.json` | `allowedRoots`、`allowBroadRoots`（见“在 B 上”第 2 步）、`port`（默认 7676）、`host`（默认 127.0.0.1）、`publicUrl`（A 上的客户端访问服务用的地址，默认 `http://127.0.0.1:<port>`）、`uiPort`（WebUI 端口，默认 7677，0 关闭；`port` 设成 7677 而没设 `uiPort` 时用 7678）、`allowedRedirectHosts`、`serviceEnv`（见下） |
| `auth.json` | Owner 密码（见下） |
| `oauth.json` | 已注册的客户端和令牌（令牌只存 SHA-256 哈希） |
| `workspaces.json` | `workspace_id` 与项目目录的对应关系 |

**Owner 密码。** 保存在 `auth.json`，至少 16 个字符，在 B 的终端里用 `clouddev-base password --show` 查看。也可以用环境变量 `CLOUDDEV_BASE_PASSWORD` 提供，它优先于文件；设为空值等于没设。服务每次授权时都重新读取。这个环境变量不会传给 `bash` 执行的命令，但这只是防止意外泄露：`bash` 不是沙箱，命令仍能读到 `auth.json`。

**`serviceEnv`。** `service install` 除了 PATH、LANG 和常用的开发变量（见“在 B 上”第 3 步），还会把这里列出的环境变量从当前终端带进后台服务，例如 `["DATABASE_URL", "PNPM_HOME"]`（没有对应的命令行参数）。改完重新运行 `service install`。值会以明文写进 `~/Library/LaunchAgents` 里的 plist；`CLOUDDEV_BASE_PASSWORD` 列在这里也不会带过去。

**`allowedRedirectHosts`。** 决定哪些客户端能注册授权。回调地址在本机回环地址（`localhost`、`127.0.0.1`、`[::1]`）上的客户端总是允许，Claude Code 就属于这种，所以默认列表是空的。要接入回调地址是 `https://` 网址的其他 MCP 客户端，就编辑 `config.json`，把回调地址的主机名加进去，例如 `["example.com"]`（没有对应的命令行参数），改完重启服务。

**文件损坏时。** `oauth.json` 或 `workspaces.json` 读不出来或内容不对时，服务把它改名为 `<文件名>.corrupt-<时间>` 留作备份，用空的状态启动：A 上要在 `/mcp` 里重新认证，项目要重新用 `open_workspace` 打开（`workspace_id` 不变）。只是没有读取权限的不算损坏：属于你的，服务把权限改回 `600` 再读；还是读不了，或者属于别的用户（多半是用 sudo 运行过，属于 root），就改名为 `<文件名>.unreadable-<时间>`，同样用空的状态启动，日志里写着怎样找回（比如 `sudo chown "$USER" <备份>`，改回原名，然后马上重启服务）。`auth.json` 坏了服务照常启动，也不会自动换新密码，但新客户端的授权都会被拒绝，直到修好它或者运行 `clouddev-base password --reset`。`config.json` 坏了服务不启动，错误信息会指出是哪个文件；手动改好后，用 `clouddev-base service status` 确认服务恢复。服务写这几个文件时，都是先写临时文件、落盘，再改名替换。

## 安全须知

- 连上的 AI 等同于一个能操作你电脑的协作者。文件工具被限制在工作区内，但 **`bash` 不是沙箱**，命令以你的用户权限运行。
- `write`/`edit` 只保护已有的 Git 目录：它们仍然可以新建一个仓库目录（比如写出 `HEAD`、`config`、`objects/`、`refs/`，组成一个裸仓库），也能改 Git 钩子或 npm 脚本会执行的文件（`core.hooksPath` 指向的钩子目录，比如 husky 的 `.husky/_`；`node_modules` 里的代码）。所以批准 `git commit`、`npm test` 这类命令之前，留意之前的 `write`/`edit` 改了什么。可选的加固：在 B 上运行 `git config --global safe.bareRepository explicit`（Git 2.38 起支持），Git 就不会把所在目录里的裸仓库当成仓库用；之后要在裸仓库目录里直接运行 git，得加 `--git-dir=.`。
- skill 和插件都能带 hooks，在 A 上执行命令，`client/.claude/settings.json` 的 `deny` 管不到。装之前自己看一遍，也不要为了让 Claude 自己装去放开那里禁用的工具（见“在 A 上”的“安装 skill”）。
- 每个新客户端都必须在授权页输入 Owner 密码才能拿到令牌。密码不要外泄：只在 B 的终端里用 `password --show` 查看，经 Claude 运行的话它会进入 A 上的对话记录；授权页会显示授权后跳转的域名，只批准你自己发起的连接。授权成功和密码输错都会显示在 B 的 WebUI 上。
- 要让所有已连接的客户端失效：删除 `~/.clouddev-base/oauth.json`。运行中的服务（包括后台服务）立即生效、不用重启，不会再把旧的客户端和令牌写回去；之后每个客户端都要重新输入 Owner 密码授权。`clouddev-base password --reset` 生成新密码，同样立即生效，但它不会注销已连接的客户端，两件事要一起做。
- 服务只监听 127.0.0.1，别的电脑只能经 SSH 隧道访问它。A 上的隧道密钥没有口令（这样后台运行才不用等人输入），所以它在 B 上被 `authorized_keys` 的前缀限制住了：
  - `restrict` 关掉终端、agent 和 X11 转发、`~/.ssh/rc`；
  - `port-forwarding` 只重新打开端口转发；
  - `permitopen` 只允许连 B 的 127.0.0.1:7676；
  - `permitlisten` 只放行一个没用的端口，等于禁止 TCP 的反向转发；
  - `command="/usr/bin/false"` 让它即使请求 shell、scp、sftp 也只会执行 `false`。

  这些前缀只管 TCP 端口，管不到 Unix socket 的反向转发（`ssh -R /路径.sock:…`，能在 B 上任意可写的位置放一个 socket，把 B 上程序的连接转给对方），所以 B 的 sshd 还要设置 `AllowStreamLocalForwarding local`（“在 B 上”第 5 步）。`install.sh` 安装时会把这些限制和 sshd 的这项设置逐项试一遍，有一项没生效、或者没能确认，就不装隧道。两样都做了，这把钥匙即使被偷，也只能碰到 7676，而 7676 还要 OAuth 令牌和 Owner 密码。不要去掉这些限制，也不要把它加到能做别的事的账号设置里。
- 不要把 7676 端口直接开放到网络上（改 `--host`、做端口映射，或者用 cloudflared、ngrok 之类的工具），那样挡住别人的就只剩 Owner 密码和授权令牌了。B 的 SSH 端口要暴露到公网时，按“在 B 上”第 5 步只允许密钥登录。
- 服务端日志（终端里，或后台服务的 `~/Library/Logs/clouddev-base.log`）逐行记录每次工具调用（工具名、文件路径或搜索模式、耗时）。命令里可能带密钥，所以 `bash` 默认只记录命令长度；想看到完整命令，启动前设置环境变量 `CLOUDDEV_BASE_LOG_COMMANDS=1`（`service install` 会把它带进后台服务，并提示你）。后台服务的日志超过 10MB 时，旧的内容挪到 `clouddev-base.log.1`（只留一份，配置被拒绝、服务每 10 秒重启一次时也一样）；服务自动生成 Owner 密码时也不会把它写进日志。
- WebUI 只监听 127.0.0.1，在 B 本机才能打开。里面的命令全文只保存在内存里，不写磁盘。

## 排错

- **先分段确认是通的。** 在 B 上运行 `curl --noproxy '*' http://127.0.0.1:7676/healthz`，再在 A 上运行同一条命令（`--noproxy '*'`：终端里设了 `http_proxy` 或 `all_proxy` 时，curl 连 127.0.0.1 也会走代理）。两边都应该返回 `{"ok":true,"name":"clouddev-base","pid":…}`，而且 `pid` 相同：
  - B 本机就不通，问题在服务上：运行 `clouddev-base service status`，看 `~/Library/Logs/clouddev-base.log`；
  - B 通、A 不通，问题在隧道上：在 A 上运行 `client/tunnel/status.sh`。
- **隧道日志里反复出现 `Timeout, server … not responding.` 或 `connect to host … timed out`**：A 连不到 B。检查 B 是否睡着了、地址是否变了（换了地址就重新运行 `install.sh`，在局域网里最好改用 B 的 `.local` 名字），以及 B 的远程登录是否打开。
- **`status.sh` 说本机端口被别的程序占着**：A 上有别的程序（比如在 A 上也运行了 `clouddev-base serve`）占着隧道要用的端口，隧道绑不上它。停掉那个程序，或者三处一起换一个端口（见“在 A 上”第 3 步后面的说明）。
- **`Permission denied (publickey)`**：B 上的 `authorized_keys` 里没有那一行，或者账号不对；`install.sh` 打印的那一行也保存在 `~/.clouddev-tunnel/authorized_keys_line.txt`。
- **`Host key verification failed`**：B 的主机指纹变了（重装了系统，或者换了一台 B）。确认是你自己的 B 后，删掉旧指纹 `ssh-keygen -R clouddev-b -f ~/.clouddev-tunnel/known_hosts`，再运行一次 `install.sh`。
- **`administratively prohibited`，或者 `install.sh` 说转发不到 127.0.0.1:7676**：B 上 `authorized_keys` 那一行的 `permitopen` 端口和 `--remote-port`（也就是 B 上服务的端口）不一致；或者这把钥匙在 `authorized_keys` 里有不止一行（比如改端口后又追加了一行），sshd 只认第一行，删掉旧的；也可能是 B 的 sshd 关掉了端口转发（`AllowTcpForwarding`）。
- **`install.sh` 说这把钥匙在 B 上还能监听端口，或者还能建 Unix socket**：能监听端口，是 B 上这把钥匙生效的那一行缺了 `restrict` 或 `permitlisten`：换成 `install.sh` 打印的完整一行，并删掉这把钥匙更早的旧行。能建 Unix socket，是 B 的 sshd 没设置 `AllowStreamLocalForwarding local`：按“在 B 上”第 5 步设好，再在 B 上删掉检查时留下的 `/tmp/clouddev-probe-….sock`（提示里有完整路径）。然后重新运行 `install.sh`。
- **`install.sh` 说“这次没能连上 B”**：检查用的那次连接没到 B（B 睡着了、断网了，或者经中转机时中转机连不上 B），说明不了 B 上的限制。正在用的隧道没动，等 A 能连上 B 再运行一次。
- **`install.sh` 说访问 B 的端口“30 秒内没有完成”，或者“没有得到回答”**：`--remote-port` 上的程序不回答（多半是端口写错了，改对后重新运行）。“30 秒内没有完成”也可能是连接确实太慢，这时加长等待，比如 `CLOUDDEV_TUNNEL_PROBE_WAIT=60 client/tunnel/install.sh …`。
- **返回 403 `Invalid Host`**：请求里的主机名不在允许列表里，比如 `.mcp.json` 写的不是 `127.0.0.1`。
- **Claude Code 认证失败，提示 resource 不匹配**：`client/.mcp.json` 的地址和 B 上的 `publicUrl` 不一致（`localhost` 和 `127.0.0.1` 也算不一致），改成一样后重新 `/mcp`。
- **Claude 在 B 上执行命令提示 command not found，或者编译、安装依赖时缺环境变量（`JAVA_HOME`、代理等），手动在终端里却可以**：后台服务的环境是安装时从终端里带过去的。在平时开发用的终端里重新运行 `clouddev-base service install`，看它列出的变量；缺的变量加进 `config.json` 的 `serviceEnv`。
- **启动时提示端口已被占用**：用 `--port` 换一个端口，隧道的 `--remote-port` 和 `authorized_keys` 里的 `permitopen` 也一起改。只有 WebUI 端口被占用时，MCP 服务照常运行，用 `--ui-port` 换一个即可。
- **授权页一直提示密码不正确**：在终端里运行的 `serve` 如果设置了 `CLOUDDEV_BASE_PASSWORD`，以这个环境变量为准；后台服务不读这个变量，用的是 `auth.json` 里的密码。`clouddev-base password --show` 显示的是环境变量的值时会注明，在没设这个变量的终端里运行它，看到的才是 `auth.json` 里的密码。
- **新客户端连接时注册失败**：回调地址不在本机回环地址上的客户端，要先把它回调地址的主机名加进 `allowedRedirectHosts`（见“配置文件”）。

## 开发

```bash
npm test           # 单元测试 + MCP 端到端测试 + 完整 OAuth 流程测试 + 启动真实 serve 进程的 CLI 测试 + 隧道脚本测试
npm run typecheck
npm run build      # 编译到 dist/，并把 src/webui/ 复制过去
```

用两台电脑把真实的服务、隧道和 Claude Code 从头到尾走一遍（只有一台 Mac 也可以），见 [e2e/README.md](e2e/README.md)。

```text
src/
  cli.ts            命令行：init / serve / service / password
  config.ts         配置与 Owner 密码、允许目录的范围检查、状态文件的读写（损坏的改名留存）
  http.ts           HTTP 服务：OAuth 端点 + /mcp（无状态 Streamable HTTP，5 分钟 keep-alive，
                    跨请求的取消，鉴权后才解析请求体）
  oauth.ts          单用户 OAuth 授权服务器（授权页、令牌签发与轮换）
  mcp.ts            MCP 服务器与 7 个工具的定义（客户端要求时，长命令每 20 秒发送进度通知）
  activity.ts       WebUI 用的活动记录：最近的工具调用、命令的实时输出、连接和授权事件（只在内存里）
  webui.ts          WebUI 服务：只监听 127.0.0.1，页面 + SSE 事件流
  webui/            WebUI 页面（纯 HTML/CSS/JS，不需要构建）
  service.ts        macOS 后台服务（launchd）：生成 plist、加载、卸载、查看状态
  markup.ts         HTML/XML 转义（授权页和 plist 共用）
  workspaces.ts     工作区注册与允许目录校验（工作区不能包含配置目录）
  paths.ts          路径解析与越界防护（含符号链接）
  version.ts        版本号
  tools/common.ts   工具共用的输出截断（2000 行 / 50KB / 45,000 字符）、二进制文件判断与 UTF-16 解码
  tools/files.ts    read / write / edit（edit 只改 UTF-8 文本；write 和 edit 不写 Git 目录）
  tools/replace-file.ts   原子写：同目录临时文件 + fsync + rename；macOS 上用 ditto --clone 保留扩展属性和 ACL
  tools/search.ts   grep / glob：在 worker 线程里执行，20 秒硬时限
  tools/search-worker.ts  worker 入口与搜索实现
  tools/file-list.ts      文件枚举：不调用 git，不跟随符号链接；读不了的目录会记下来，由搜索结果报告
  tools/gitignore.ts      .gitignore 规则
  tools/git-index.ts      读取 .git/index（已跟踪的文件即使匹配忽略规则也会列出，与 git 一致）
  tools/glob-match.ts     不回溯的 glob 匹配
  tools/shell.ts    bash（不把服务自己的密钥传给命令；输出可实时转给 WebUI；整理输出、先 SIGTERM 再 SIGKILL）
client/             在电脑 A 上启动 Claude Code 用的目录（见“用法”）
  start.sh          白名单启动 Claude Code
  .claude/settings.json
  .mcp.json
  CLAUDE.md
  tunnel/           A 上的 SSH 隧道：install.sh / run.sh / status.sh / uninstall.sh，共用的路径和检查在 common.sh
e2e/                端到端测试：流程说明（两台电脑，也可以只用一台 Mac）、演示项目 demo-app、在 A 上运行的冒烟测试 smoke.mjs、
                    只有一台 Mac 时代答 install.sh 交互的 install-tunnel.exp
```
