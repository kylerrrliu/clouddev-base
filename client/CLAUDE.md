# 在另一台电脑（B）上工作

（这个文件只在 client/ 目录里启动 Claude Code 时生效。）

这个目录用来让 Claude Code 通过 clouddev-base MCP 服务操作另一台电脑 B，本机（A）只是操作台。

- 所有读写、搜索和命令都用 clouddev-base 的工具完成：open_workspace、read、write、edit、grep、glob、bash。它们都作用在 B 上。本机的文件和命令工具已被禁用，不要尝试操作本机。
- 开始时先用 open_workspace 打开 B 上的项目目录（例如 ~/work/my-app），之后整个对话都复用返回的 workspace_id。不确定项目在哪时，先打开允许的根目录，看看里面有哪些项目。
- 路径都相对于工作区根目录。修改前先 read（读不完时，结果开头会给出接着读的 offset）；改已有文件用 edit，只有新建文件或整体重写才用 write。write 和 edit 不能改 .git 目录和裸仓库等 Git 目录里的文件，Git 的状态用 bash 里的 git 命令改。
- bash 每次都是一个新的、非登录的 /bin/bash（macOS 上是 3.2，没有关联数组；不读 ~/.zshrc，`**` 不会递归匹配）：要在子目录里执行，用 working_directory 参数，不要依赖上一条命令里的 cd 或 export。
- bash 默认 30 秒超时，最长 300 秒。安装依赖、跑测试、编译这类慢命令要主动把 timeout 调大。
- 不要运行需要交互输入的命令。需要一直运行的服务放到后台，并把输出追加到日志文件，例如 `nohup npm run dev >> dev.log 2>&1 &`（用 >>：以后用 write 把日志写成空内容来清空时，服务从头接着写；用 > 的话它还写在原来的位置，前面留下一段 NUL 字节，read 和 grep 会把日志当成二进制文件），之后用 read 或 grep 查看日志。超过 2MB 的日志 grep 不搜：10MB 以内用 read 分段读，更大的在 bash 里用 grep -n 或 tail 查。
- B 上的端口在本机打不开：B 上启动的服务，用 bash 在 B 上检查（比如 `curl http://127.0.0.1:3000`；bash 里访问 localhost、127.0.0.1 不走代理），不要让用户在本机打开 localhost 的地址。
- 用户要装 skill 或插件时，不要自己装，也不要装到 B 上：skill 由本机的 Claude Code 加载，装在 B 上读不到；本机的文件和命令工具又被禁用了。告诉用户在本机自己装：在会话里运行 `/plugin install <插件>@<市场>`，或者在终端里把 skill 目录拷进这个目录的 `.claude/skills/` 或 `~/.claude/skills/`。要在 B 上运行 skill 自带的脚本时，先征得用户同意，再用 bash 把脚本拉到 B 上。
- 谨慎操作：不要改动工作区以外的文件；删除文件、修改系统设置、全局安装软件之前，先征得用户同意。
