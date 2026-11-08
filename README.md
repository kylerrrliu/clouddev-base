# clouddev-base

一个精简的 MCP 服务器：让一台电脑上的 Claude Code（或其他支持 MCP 的客户端）通过 Tailscale 直接打开另一台电脑上的项目，**读写、搜索代码，执行终端命令**。

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

不想 `npm link` 的话，下文的 `clouddev-base` 都可以换成 `node /path/to/clouddev-base/dist/cli.js`。

## 用法：在电脑 A 上用 Claude Code 操作另一台电脑 B（Tailscale）

B 上运行 clouddev-base，A 上的 Claude Code 通过 [Tailscale](https://tailscale.com) 私有网络连接它。Tailscale 只让你自己的设备访问 B，地址固定不变，也不需要公网隧道和自己的域名。

### 在 B（被操作的电脑）上

**1. 安装 Tailscale 并登录。** 在 Tailscale 管理后台的 DNS 页面打开 MagicDNS 和 HTTPS Certificates（第一次运行下面的 `tailscale serve` 时，如果提示需要启用，按它给的链接操作即可）。macOS 上如果找不到 `tailscale` 命令，可以用 `/Applications/Tailscale.app/Contents/MacOS/Tailscale` 代替。

**2. 按上面的“安装”步骤装好 clouddev-base。**

**3. 用 Tailscale 给本机 7676 端口提供 HTTPS**（只在你的 tailnet 内可见）。它会打印出本机地址，形如 `https://b-mac.tail1234.ts.net`：

```bash
tailscale serve --bg 7676
```

注意是 `serve` 不是 `funnel`：`funnel` 会把服务公开到公网。

**4. 初始化**，把上一步的地址写进配置，并记下打印出来的 Owner 密码：

```bash
clouddev-base init --root ~/work --public-url https://b-mac.tail1234.ts.net
```

**5. 启动服务：**

```bash
clouddev-base serve
```

B 重启后，Tailscale 和 `tailscale serve --bg` 的设置会自动恢复，但 `clouddev-base serve` 需要重新运行；B 还要设置成不休眠。

### 在 A（你用来操作的电脑）上

**1. 安装 Tailscale 并登录同一个账号，装好 Claude Code。**

**2. 把本项目的 `client/` 目录拷到 A**（放在哪都行），把 `client/.mcp.json` 里的地址改成 B 的地址，末尾保留 `/mcp`：

```json
{
  "mcpServers": {
    "clouddev-base": {
      "type": "http",
      "url": "https://b-mac.tail1234.ts.net/mcp",
      "timeout": 330000
    }
  }
}
```

**3. 在 `client/` 目录里启动 Claude Code：**

```bash
cd /path/to/client && claude
```

第一次启动会先问是否信任这个目录，选信任（之后 `client/` 里的设置才会完全生效）。然后输入 `/mcp`，选 clouddev-base 进行认证。浏览器打开授权页后，输入 Owner 密码（在 B 上运行 `clouddev-base password` 可以查看）。

之后直接说“打开 B 上的 ~/work/my-app，跑一下测试并修复失败的用例”即可。

`client/` 目录里的三个文件：

| 文件 | 作用 |
| --- | --- |
| `.claude/settings.json` | 禁用 Claude Code 自带的文件和命令工具，避免误操作 A；打开工作区、读取、搜索自动允许，写文件和执行命令每次先问你 |
| `.mcp.json` | B 上 MCP 服务的地址，以及单次调用的超时时间（见下） |
| `CLAUDE.md` | 告诉 Claude：所有操作都通过 clouddev-base 在 B 上完成，以及这些工具的用法要点 |

**禁用的工具。** `settings.json` 的 `deny` 里列的是 Claude Code 自带的、能读写本机文件或执行本机命令的工具：`Bash`、`PowerShell`、`Monitor`、`Read`、`Edit`、`Write`、`NotebookEdit`、`Glob`、`Grep`。Claude Code 以后新增这类工具时，也要把它加进去。如果你在 A 上全局配置过其他能操作本机的 MCP 服务器，它们在这里仍然可用；不想让它们出现，就把 `mcp__<服务器名>` 也加到 `deny` 里。

**超时设置。** `.mcp.json` 里的 `timeout` 单位是毫秒，设为 330 秒有两个作用：

- 把 Claude Code 对单次工具调用的硬上限设为 330 秒（默认约 28 小时），比 `bash` 最长的 300 秒多留一点余量；
- 把 Claude Code 的空闲超时（默认 5 分钟内没有任何响应就中止调用）放宽到 330 秒。

如果客户端在请求里要求了进度通知（带 `progressToken`），命令运行期间服务每 20 秒发一次，也会重置空闲计时；客户端没要求时不发，但上面的 330 秒已经足够覆盖最长的命令。

> B 加入你的 tailnet 后，也能访问你 tailnet 里的其他设备，包括 A。介意的话，在 Tailscale 管理后台的 Access Controls 里只允许 A 访问 B。

## 配置文件

都在 `~/.clouddev-base/` 下（可用环境变量 `CLOUDDEV_BASE_HOME` 改位置），权限为 `600`：

| 文件 | 内容 |
| --- | --- |
| `config.json` | `allowedRoots`、`port`（默认 7676）、`host`（默认 127.0.0.1）、`publicUrl`、`allowedRedirectHosts` |
| `auth.json` | Owner 密码（见下） |
| `oauth.json` | 已注册的客户端和令牌（令牌只存 SHA-256 哈希） |
| `workspaces.json` | `workspace_id` 与项目目录的对应关系 |

**Owner 密码。** 保存在 `auth.json`，至少 16 个字符。也可以用环境变量 `CLOUDDEV_BASE_PASSWORD` 提供，它优先于文件；设为空值等于没设。服务每次授权时都重新读取。这个环境变量不会传给 `bash` 执行的命令，但这只是防止意外泄露：`bash` 不是沙箱，命令仍能读到 `auth.json`。

**`allowedRedirectHosts`。** 决定哪些客户端能注册授权。回调地址在本机回环地址（`localhost`、`127.0.0.1`、`[::1]`）上的客户端总是允许，Claude Code 就属于这种，所以默认列表是空的。要接入回调地址是 `https://` 网址的其他 MCP 客户端，就编辑 `config.json`，把回调地址的主机名加进去，例如 `["example.com"]`（没有对应的命令行参数），改完重启服务。

## 安全须知

- 连上的 AI 等同于一个能操作你电脑的协作者。文件工具被限制在工作区内，但 **`bash` 不是沙箱**，命令以你的用户权限运行。
- 每个新客户端都必须在授权页输入 Owner 密码才能拿到令牌。密码不要外泄；授权页会显示授权后跳转的域名，只批准你自己发起的连接。
- 要让所有已连接的客户端失效：停止服务，删除 `~/.clouddev-base/oauth.json`，再重新启动。`clouddev-base password --reset` 生成新密码，运行中的服务立即生效、不用重启，但它不会注销已连接的客户端。
- 用 `tailscale serve` 时，服务只在你的 tailnet 内可见。不要用 `tailscale funnel`、cloudflared、ngrok 之类的工具把它开放到公网，那样挡住别人的就只剩 Owner 密码和授权令牌了。
- 服务端终端会逐行打印每次工具调用（工具名、文件路径或搜索模式、耗时），方便你随时看 AI 在做什么。命令里可能带密钥，所以 `bash` 默认只记录命令长度；想看到完整命令，启动前设置环境变量 `CLOUDDEV_BASE_LOG_COMMANDS=1`。

## 排错

- **先确认服务和 Tailscale 是通的。** 在 B 上运行 `curl http://127.0.0.1:7676/healthz`，再从 A 运行 `curl https://你的地址/healthz`，都应该返回 `{"ok":true,"name":"clouddev-base"}`。本机通、远程不通，问题出在 Tailscale 上。
- **返回 403 `Invalid Host`**：请求里的域名和 `--public-url`（或配置里的 `publicUrl`）不一致，比如忘了设 `--public-url`，或者 B 在 Tailscale 里的名字变了。用实际的 https 地址重新启动服务。
- **启动时提示端口已被占用**：用 `--port` 换一个端口，同时让 `tailscale serve` 指向新端口。
- **授权页一直提示密码不正确**：如果服务启动时设置了 `CLOUDDEV_BASE_PASSWORD`，以这个环境变量为准；在没设这个变量的终端里运行 `clouddev-base password`，看到的是 `auth.json` 里的密码。
- **新客户端连接时注册失败**：回调地址不在本机回环地址上的客户端，要先把它回调地址的主机名加进 `allowedRedirectHosts`（见“配置文件”）。

## 开发

```bash
npm test           # 单元测试 + MCP 端到端测试 + 完整 OAuth 流程测试 + 启动真实 serve 进程的 CLI 测试
npm run typecheck
npm run build
```

```text
src/
  cli.ts            命令行：init / serve / password
  config.ts         配置与 Owner 密码
  http.ts           HTTP 服务：OAuth 端点 + /mcp（无状态 Streamable HTTP，5 分钟 keep-alive，
                    跨请求的取消，鉴权后才解析请求体）
  oauth.ts          单用户 OAuth 授权服务器（授权页、令牌签发与轮换）
  mcp.ts            MCP 服务器与 7 个工具的定义（客户端要求时，长命令每 20 秒发送进度通知）
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
  tools/shell.ts    bash（不把服务自己的密钥传给命令）
client/             在电脑 A 上启动 Claude Code 用的目录（见“用法”）
  .claude/settings.json
  .mcp.json
  CLAUDE.md
```
