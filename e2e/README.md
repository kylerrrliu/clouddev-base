# 端到端测试

用两台电脑把 README 的“用法”从头到尾走一遍：B 上的后台服务和 WebUI、A 到 B 的 SSH 隧道（受限的钥匙 + launchd）、经隧道的 OAuth 授权、7 个工具，最后在 A 上用 Claude Code 修好 B 上的一个演示项目。测完按“复原”一节，把两台电脑恢复到测试前的样子。只有一台 Mac 时见最后一节。

| 文件 | 作用 |
| --- | --- |
| `demo-app/` | 测试用的小项目。两个函数各有一个 bug，`npm test` 有 2 个用例失败，留给 Claude 在 B 上找出来修好 |
| `smoke.mjs` | 在 A 上运行的冒烟测试：经隧道走完 OAuth，再调用全部 7 个工具 |
| `install-tunnel.exp` | 只有一台 Mac 时用：替你应答 `install.sh` 的两处交互（回车、核对主机指纹） |

## 准备

- 两台 Mac：B 是被操作的电脑，A 是你用来操作的电脑。Linux 的做法见 README 的“不用 macOS 时”，这里不展开。
- A 能连到 B 的 SSH 端口：在同一个局域网里，或者 B 有公网地址。
- 两台都装好 Node.js 22.18 或更高版本，都有这个仓库（运行过 `npm install`）。B 用它运行服务；A 用它运行 `e2e/smoke.mjs`。A 上还要装好 Claude Code。
- 下面的命令都在各自电脑上的仓库根目录里运行，每段开头注明在哪台上运行。

## 布局

测试用的东西都放在两台电脑各自的 `~/clouddev-e2e` 里，仓库本身不动。B 上的这个目录不能放在 `~/Documents` 这类受保护目录里：launchd 启动的 node 读不到那里的代码（见 README 的“安装”）。

| 电脑 | 路径 | 内容 |
| --- | --- | --- |
| B | `~/clouddev-e2e/server` | 仓库的副本（已编译），后台服务从这里运行 |
| B | `~/clouddev-e2e/work` | 允许访问的目录，里面是 `demo-app` 的副本 |
| B | `~/clouddev-e2e/bin/clouddev-base` | 代替 `npm link` 的包装脚本，测完随目录一起删掉，不碰全局的 npm |
| A | `~/clouddev-e2e/client` | `client/` 的副本：在这里装隧道、启动 Claude Code。Claude Code 的信任记录和设置都落在副本上，仓库里的 `client/` 不会多出文件 |

| 电脑 | 端口 | 用途 |
| --- | --- | --- |
| B | 127.0.0.1:7676 | clouddev-base（MCP + OAuth） |
| B | 127.0.0.1:7677 | WebUI，只能在 B 上打开 |
| B | 22 | sshd（远程登录），A 只连这一个端口 |
| A | 127.0.0.1:7676 | 隧道在 A 上的一头，转发到 B 的 7676 |

## 0. 记下测试前的状态

两台各自运行，复原时对照。在没装过 clouddev-base 的电脑上，下面这些命令都没有输出（`ls` 只会报文件不存在）。

在 B 上：

```bash
ls -d ~/.clouddev-base ~/clouddev-e2e ~/.ssh/authorized_keys
ls ~/Library/LaunchAgents ~/Library/Logs | grep clouddev
launchctl print-disabled gui/$(id -u) | grep clouddev
ls /etc/ssh /etc/ssh/sshd_config.d | grep -E 'host|clouddev'
for p in 7676 7677; do lsof -nP -iTCP:$p -sTCP:LISTEN; done
nc -z -G 3 127.0.0.1 22 && echo "远程登录已打开" || echo "远程登录没打开"
```

在 A 上：

```bash
ls -d ~/.clouddev-tunnel ~/clouddev-e2e
ls ~/Library/LaunchAgents ~/Library/Logs | grep clouddev
launchctl print-disabled gui/$(id -u) | grep clouddev
lsof -nP -iTCP:7676 -sTCP:LISTEN
```

已经存在的（比如 B 上本来就有 `authorized_keys`、本来就开着远程登录），复原时要还原成原来的样子，而不是删掉或关掉。

## 1. B：装服务

在 B 上：

```bash
mkdir -p ~/clouddev-e2e/bin ~/clouddev-e2e/work
# 只排除根目录下的 dist：写成 --exclude dist 会把 node_modules 里各个包的 dist 也排除掉，编译就会失败
rsync -a --exclude /.git --exclude /dist --exclude /.claude --exclude .DS_Store ./ ~/clouddev-e2e/server/
(cd ~/clouddev-e2e/server && npm run build)
printf '#!/bin/sh\nexec node "$HOME/clouddev-e2e/server/dist/cli.js" "$@"\n' > ~/clouddev-e2e/bin/clouddev-base
chmod 755 ~/clouddev-e2e/bin/clouddev-base
```

把演示项目放进允许访问的目录。建成 Git 仓库，`grep` 和 `glob` 才会走 `.gitignore` 的逻辑：

```bash
cp -R e2e/demo-app ~/clouddev-e2e/work/
(cd ~/clouddev-e2e/work/demo-app && git init -q && git add -A && git commit -q -m "Initial demo app")
```

初始化，然后装成后台服务。`service install` 要在平时开发用的终端里运行，它会把这个终端的 PATH 带进服务：

```bash
~/clouddev-e2e/bin/clouddev-base init --root ~/clouddev-e2e/work --public-url http://127.0.0.1:7676
~/clouddev-e2e/bin/clouddev-base service install
~/clouddev-e2e/bin/clouddev-base service status
```

- `init` 会打印 Owner 密码，A 上认证时要用。以后在 B 上用 `~/clouddev-e2e/bin/clouddev-base password` 查看。
- `init` 还会打印一条给 A 用的 `install.sh` 命令，里面的 `<用户名>@<名字>.local` 就是下面要用的“B 的地址”。
- `service status` 的健康检查和 WebUI 都应该是“正常”。

## 2. B：打开远程登录

在 B 上：系统设置 → 通用 → 共享 → 打开“远程登录”。“允许访问”选“仅这些用户”，只留你的账号。

## 3. A：生成隧道钥匙

在 A 上：

```bash
mkdir -p ~/clouddev-e2e
cp -R client ~/clouddev-e2e/client
~/clouddev-e2e/client/tunnel/install.sh --no-load <B 上的用户名>@<B 的地址>
```

B 的地址用第 1 步 `init` 打印的那个（比如 `bob@bob-mac.local`）。不在同一个局域网时，用 B 的公网地址或域名；B 的 SSH 不在 22 端口时加 `-p 端口`。

`--no-load` 只生成钥匙和配置，不连接 B，也不装进 launchd。它会打印要加到 B 上的那一行，这一行也存在 `~/.clouddev-tunnel/authorized_keys_line.txt` 里。

## 4. B：加上钥匙、设置 sshd

这一步改的是 B 的访问设置，要你自己来做。让 Claude Code 代做时，写 `authorized_keys` 会被自动模式的安全检查当作持久化访问拦下。

先把那一整行加到 B 上你的账号的 `~/.ssh/authorized_keys`，两种办法任选一种：

- **能用密码或你自己的钥匙从 A ssh 登录 B：** 在 A 上运行 `install.sh` 打印的那条 `ssh … < …/authorized_keys_line.txt` 命令。
- **否则：** 在 B 的终端里运行下面这条，粘贴那一行，回车，再按 Ctrl+D：

  ```bash
  (umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys)
  ```

然后按 README“在 B 上”第 5 步，写好 `/etc/ssh/sshd_config.d/010-clouddev.conf`（要 sudo）：

- `AllowStreamLocalForwarding local` 是必须的。
- `PasswordAuthentication no` 会关掉密码登录。加之前确认你登录 B 不靠密码；上面用密码 ssh 加钥匙的话，那一步已经做完了，不受影响。

## 5. A：装隧道

在 A 上：

```bash
~/clouddev-e2e/client/tunnel/install.sh <B 上的用户名>@<B 的地址>
```

按回车后，ssh 会问是否信任 B 的主机指纹。在 B 上运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`，指纹一致再输入 `yes`，也可以直接粘贴 B 上看到的 `SHA256:…` 指纹。

成功时 `install.sh` 会打印两个 ✓：钥匙在 B 上只能转发到 127.0.0.1:7676，以及“隧道已连通”。`~/clouddev-e2e/client/tunnel/status.sh` 应该显示 `state = running`，经隧道访问“正常”。

## 6. A：冒烟测试

在 A 上：

```bash
node e2e/smoke.mjs
```

它先确认隧道是通的，再提示输入 B 的 Owner 密码：在 B 上运行 `~/clouddev-e2e/bin/clouddev-base password` 查看，粘贴进去（不显示）。检查这些：

- A 的 7676 端口是隧道的 ssh 在监听，不是 A 上别的程序；
- 经隧道能访问 B 上的 `/healthz`。它会打印 B 上服务的 pid：在 B 上运行 `curl http://127.0.0.1:7676/healthz`，pid 应该相同；
- 不带令牌访问 `/mcp` 返回 401；
- OAuth：授权服务器元数据、动态注册、授权页；输错 Owner 密码被拒绝，输对拿到授权码；换到访问令牌和刷新令牌；
- MCP：`initialize`，`tools/list` 正好是 7 个工具；
- 在 B 上：
  - `open_workspace`、`read`、`glob`、`grep` 都正常；
  - 读工作区以外的文件（B 上的 `~/.clouddev-base/auth.json`）被拒绝；
  - `bash` 在后台服务的环境里运行，PATH 里有 node、npm、git；
  - `bash` 跑 `npm test`：有失败用例时标为出错，全部通过时不标。demo-app 修好之后再跑，这一项也能通过。

每次运行都会在 B 上注册一个叫 `e2e-smoke` 的客户端。复原时它随 B 的 `~/.clouddev-base` 一起删掉。

## 7. B：看 WebUI

在 B 的浏览器里打开 <http://127.0.0.1:7677>：

- **记录：** 有冒烟测试的 7 次调用，`npm test` 和读工作区以外的文件这两次标为出错；
- **概况：** 客户端是 `e2e-smoke`；
- **事件：** 依次是输错 Owner 密码、批准客户端、客户端已连接。

## 8. A：在 Claude Code 里测

在 A 上：

```bash
cd ~/clouddev-e2e/client && claude
```

1. 第一次启动时选信任这个目录。
2. 输入 `/mcp`，选 clouddev-base 认证。浏览器打开授权页后，输入 B 的 Owner 密码。
3. 让 Claude 修演示项目：“打开 ~/clouddev-e2e/work/demo-app，跑一下测试并修复失败的用例”。应该看到：
   - Claude 只用 clouddev-base 的工具，A 上的文件和命令工具被 `client/.claude/settings.json` 禁用了；
   - 打开工作区、读取、搜索自动允许，改文件和执行命令每次都先问你；
   - 它找到两个 bug：`average()` 的循环从下标 1 开始，漏掉了第一个数；`median()` 的 `sort()` 没传比较函数，按字符串排序；
   - 修完后 `npm test` 全部通过。B 的 WebUI 实时显示每一步，展开 `edit` 能看到改了什么。
4. 也可以试：
   - 让 Claude 跑一个慢命令（比如 `sleep 60`），在 Claude Code 里按 Esc，B 的 WebUI 里那次调用会标为“已中止”；
   - 在 A 上运行 `launchctl kickstart -k gui/$(id -u)/com.clouddev-base.tunnel` 让隧道重连，`status.sh` 里的 `runs` 会加 1；
   - 关掉 A 的网络再打开，隧道约 40 秒内发现断线并自动重连（README“隧道怎样保活和自动重连”）。
5. **退出前**在 `/mcp` 里选 clouddev-base → Clear authentication。令牌存在 A 的钥匙串里。删掉 `client` 副本后，`/mcp` 里就看不到这个服务，也就没法在界面里清除了。

## 9. 复原

先做完第 8 节最后一步（清除认证），并退出所有在 `~/clouddev-e2e/client` 里运行的 `claude`。

**1. B：去掉隧道钥匙那一行。** 要用 A 上的公钥找到这一行，所以要在 A 删掉 `~/.clouddev-tunnel` 之前做。先在 A 上运行 `awk '{ print $2 }' ~/.clouddev-tunnel/id_ed25519.pub`，打印出来的是一串 `AAAA` 开头的公钥。然后在 B 上运行下面的命令，把公钥填进 `blob`：

```bash
blob='<A 上打印的那一串公钥>'
(umask 077; grep -vF "$blob" ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp); mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys
# 测试前没有这个文件的话，现在它是空的，删掉
[ -s ~/.ssh/authorized_keys ] || rm ~/.ssh/authorized_keys
```

**2. A：隧道，以及 Claude Code 留下的记录。** 在 A 上：

```bash
~/clouddev-e2e/client/tunnel/uninstall.sh --purge
rm -f ~/Library/Logs/clouddev-tunnel.log ~/Library/Logs/clouddev-tunnel.log.1
# ~/.claude.json 里这个目录的那一项，以及测试会话的记录
node -e 'const fs = require("fs"), os = require("os"); const f = os.homedir() + "/.claude.json"; const j = JSON.parse(fs.readFileSync(f, "utf8")); delete j.projects[os.homedir() + "/clouddev-e2e/client"]; fs.writeFileSync(f, JSON.stringify(j, null, 2));'
rm -rf ~/.claude/projects/"$(printf '%s' "$HOME/clouddev-e2e/client" | sed 's/[^A-Za-z0-9]/-/g')"
rm -rf ~/clouddev-e2e
```

**3. B：后台服务、配置、测试目录和 sshd 设置。** 在 B 上：

```bash
~/clouddev-e2e/bin/clouddev-base service uninstall
rm -rf ~/.clouddev-base
rm -f ~/Library/Logs/clouddev-base.log ~/Library/Logs/clouddev-base.log.1
rm -rf ~/clouddev-e2e
sudo rm /etc/ssh/sshd_config.d/010-clouddev.conf
```

**4. B：关掉远程登录。** 测试前没开的话，在 系统设置 → 通用 → 共享 里关掉。

最后在两台上各跑一遍第 0 节的命令核对。会留下、但不影响什么的：

- `launchctl print-disabled` 里的 `enabled` 记录：B 上是 `"com.clouddev-base.serve" => enabled`，A 上是 `"com.clouddev-base.tunnel" => enabled`。它们是安装脚本里的 `launchctl enable` 写进去的，不用 root 删不掉；对应的 plist 删掉后不起任何作用。
- B 的 `/etc/ssh/ssh_host_*`：B 测试前从没开过远程登录的话，这是第一次打开时 macOS 生成的主机密钥。建议保留，以后再开远程登录还会用它们。

## 只有一台 Mac 时

同一台 Mac 同时当 A 和 B。上面的步骤照做，命令都在这一台上运行，只改下面这几处。

**端口和地址。** A 的隧道一头不能也用 7676（B 的服务占着），按 README“在 A 上”第 3 步后面的说明，三处一起换成 17676。B 的地址用 `"$(id -un)@127.0.0.1"`，`install.sh` 打印的“IP 变了”的提示可以忽略。

- 第 1 步：`init --root ~/clouddev-e2e/work --public-url http://127.0.0.1:17676`
- 第 3 步：复制 `client` 之后改端口，然后生成钥匙：

  ```bash
  sed -i '' 's#127.0.0.1:7676/mcp#127.0.0.1:17676/mcp#' ~/clouddev-e2e/client/.mcp.json
  ~/clouddev-e2e/client/tunnel/install.sh --no-load --local-port 17676 "$(id -un)@127.0.0.1"
  ```

- 第 5 步：`install.sh` 同样要加 `--local-port 17676`，地址同样写 `"$(id -un)@127.0.0.1"`（也可以用下面的 expect）。

**第 4 步。** 加钥匙直接追加：

```bash
(umask 077; cat ~/.clouddev-tunnel/authorized_keys_line.txt >> ~/.ssh/authorized_keys)
```

sshd 设置可以不加：钥匙不出这台电脑。但远程登录开着期间，局域网里也能连到这台电脑的 22 端口；加上它，密码登录就关掉了。远程登录从没打开过的 Mac 上，`/etc/ssh` 里还没有主机密钥，第一次有连接进来时 macOS 才生成。

**第 5 步。** 可以让 expect 代答 `install.sh` 的两处交互。它把 ssh 显示的指纹和本机 `/etc/ssh` 里的主机公钥比对，一致才回答 `yes`，否则回答 `no`，`install.sh` 随即失败退出：

```bash
expect e2e/install-tunnel.exp ~/clouddev-e2e/client/tunnel/install.sh --local-port 17676 "$(id -un)@127.0.0.1"
```

**第 6 步。** 加上端口，密码直接用管道传：

```bash
~/clouddev-e2e/bin/clouddev-base password | node e2e/smoke.mjs --tunnel-port 17676
```

**第 9 步。** 去掉钥匙那一行时，`blob` 直接取：`blob="$(awk '{ print $2 }' ~/.clouddev-tunnel/id_ed25519.pub)"`。没加过 sshd 设置的话，跳过 `sudo rm` 那一行。

## 注意

- B 上服务运行期间不会因为空闲而睡眠（caffeinate），卸载服务后恢复。B 是笔记本的话，测试期间不要合上盖子（README“在 B 上”第 4 步）。
- 测试期间两台都不要在仓库里运行 `npm start`（预览配置里的 start）。在 B 上它和后台服务抢 7676、7677；在 A 上它占住隧道要用的 7676，隧道就连不上了。
- OpenSSH 10 的指纹提示是 `ED25519 key fingerprint is: SHA256:…`，`is` 后面有冒号，比旧版本多一个字符。改 `install-tunnel.exp` 的匹配规则时注意。
