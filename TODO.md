# 待办

以后要加、还没开始做的功能。

## 在 WebUI 里显示 A 上 Claude Code 的状态

在 A 的 `client/.claude/settings.json` 里加 hooks（UserPromptSubmit、Notification、Stop），经同一条隧道 POST 给 B（用单独的 token），在 WebUI 里合并显示。能看到的内容包括：

- 你输入了什么；
- Claude 在等你在 A 上批准；
- 这一轮已结束。

实现时注意：

- 隧道只转发 7676（B 上 `authorized_keys` 的 `permitopen` 只放行这一个端口），所以接收的接口要放在 MCP 端口上（`src/http.ts`），不能放在 WebUI 的 7677 上。
- 用单独的 token，是因为 hook 拿不到 Claude Code 手里的 OAuth token。token 在 B 上生成，A 上存进 `~/.clouddev-tunnel/`（权限 600）。`client/.claude/settings.json` 提交在仓库里，不能把 token 写进去。
- hook 不能拖慢或干扰 A 上的 Claude Code：
  - 超时设短（1～2 秒）。隧道断了就丢掉这条，不重试；
  - 不往 stdout 输出任何内容，因为 UserPromptSubmit 的 stdout 会被加进 Claude 的上下文；
  - 脚本最后一律 `exit 0`，因为 Stop 的 hook 以退出码 2 结束时，Claude 会接着干活而不是停下。
- Notification 不只在等批准时触发，输入框空闲久了也会触发，显示时要按 `message` 区分这两种情况。
- 这个 `settings.json` 里禁用的 Bash 只是 Claude 的 Bash 工具，不影响 hooks 运行。
- 输入的内容按调用参数的规则截断（8 KB），只存在 B 的内存里。

## 中止运行中的 bash

给运行中的 bash 加一个"中止"按钮。复用现有的取消逻辑（AbortSignal 触发后杀掉整个进程组），POST 请求时校验 Origin。

实现时注意：

- 杀进程的部分已经有了：`runCommand`（`src/tools/shell.ts`）收到 abort 后，会用 `killTree` 杀掉整个进程组。目前传进去的只有客户端取消用的 `extra.signal`（`src/mcp.ts`）。
- 给每次调用配一个 AbortController，交给 ActivityLog 保管。用 `AbortSignal.any()` 把它和 `extra.signal` 合并后再传给 `runCommand`。
- 要能看出是在 B 上手动中止的：现在 `finish()` 只根据 `extra.signal.aborted` 判断是否取消。返回给 Claude 的结果也要写明这一点，免得它原样再跑一次。
- 接口可以用 `POST /api/calls/:id/abort`（`src/webui.ts`）。现有的 `/api` 只拦截 `Sec-Fetch-Site: cross-site`，而本机其他端口上的网页算同站，拦不住。所以 POST 必须带 Origin，且要和页面自己的地址（`http://` + Host）完全一致，否则返回 403。
