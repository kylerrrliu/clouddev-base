#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync, truncateSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { homedir, hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ActivityLog } from "./activity.ts";
import {
  broadRootProblems,
  configPath,
  DEFAULT_UI_PORT,
  homeDir,
  loadConfig,
  loadOwnerPassword,
  newOwnerPassword,
  normalizePublicUrl,
  ownerPasswordPath,
  readStoredConfig,
  storedAddresses,
  storedOwnerPassword,
  tightenStatePermissions,
  WEBUI_HOST,
  writeStoredConfig,
  type ConfigOverrides,
  type ListenAddresses,
  type StoredConfig,
} from "./config.ts";
import { configureHttpServer, createHttpApp } from "./http.ts";
import { expandHome } from "./paths.ts";
import { killRunningCommandsNow } from "./tools/shell.ts";
import { installService, requireLaunchd, SERVICE_ENV_MARKER, SERVICE_LABEL, servicePaths, serviceStatus, uninstallService } from "./service.ts";
import { VERSION } from "./version.ts";
import { createWebUiApp, type WebUiInfo } from "./webui.ts";
import { WorkspaceRegistry } from "./workspaces.ts";

const HELP = `clouddev-base ${VERSION} — 让 Claude 等 AI 通过 MCP 读写、搜索本机项目并执行命令

用法:
  clouddev-base init --root <目录> [--root <目录>] [--port <端口>] [--ui-port <端口>] [--public-url <地址>] [--allow-broad-roots] [--reset]
      保存配置并生成 Owner 密码（只需运行一次）。新生成的密码只在终端里显示这一次；--reset 换一个新密码
  clouddev-base serve [--root <目录>] [--port <端口>] [--ui-port <端口>] [--host <地址>] [--public-url <地址>]
      启动 MCP 服务和本机 WebUI，供另一台电脑上的 Claude Code 经 SSH 隧道连接
  clouddev-base service install|uninstall|status [--print]
      macOS：把 serve 装成登录后自动运行、退出后自动重启的后台服务（launchd）；--print 只打印配置，不安装
  clouddev-base password [--show] [--reset]
      说明 Owner 密码保存在哪里；--show 显示它，--reset 生成新密码（运行中的服务立即生效）。
      只在这台电脑的终端里用 --show：经 Claude 的 bash 工具运行的话，密码会进入 A 上的对话记录

  --ui-port            WebUI 的端口，只监听 127.0.0.1（默认 ${DEFAULT_UI_PORT}，设为 0 关闭）
  --allow-broad-roots  只用于 init：允许把 /、家目录或它的上级目录、含有配置目录的目录作为 --root。
                       不建议：AI 不经确认就能读到 ~/.ssh 里的私钥等文件。配置目录照样不开放：工作区不能包含它

配置目录: ${homeDir()}（可用环境变量 CLOUDDEV_BASE_HOME 修改）`;

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      root: { type: "string", multiple: true },
      "public-url": { type: "string" },
      port: { type: "string" },
      "ui-port": { type: "string" },
      host: { type: "string" },
      reset: { type: "boolean" },
      show: { type: "boolean" },
      print: { type: "boolean" },
      "allow-broad-roots": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);

    return;
  }

  if (positionals.length > (command === "service" ? 1 : 0)) {
    throw new Error(`多余的参数: ${positionals.join(" ")}\n\n${HELP}`);
  }

  // Saved by init into config.json; anywhere else it would seem to work for one run and quietly do nothing.
  if (values["allow-broad-roots"] && command !== "init") {
    throw new Error("--allow-broad-roots 只能和 init 一起用（它会保存进 config.json）。");
  }

  const overrides: ConfigOverrides = {
    roots: values.root?.map((root) => resolve(expandHome(root))),
    host: values.host,
    port: values.port === undefined ? undefined : parsePort(values.port),
    uiPort: values["ui-port"] === undefined ? undefined : parsePort(values["ui-port"], true),
    publicUrl: values["public-url"],
  };

  switch (command) {
    case "init":
      return init(overrides, values.reset ?? false, values["allow-broad-roots"] ?? false);
    case "serve":
      return serve(overrides);
    case "service":
      return service(positionals[0], overrides, values.print ?? false);
    case "password":
      return password(values.show ?? false, values.reset ?? false);
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);

      return;
    default:
      throw new Error(`未知命令: ${command}\n\n${HELP}`);
  }
}

function init(overrides: ConfigOverrides, resetPassword: boolean, allowBroadRoots: boolean): void {
  const home = homeDir();
  // allowBroadRoots is kept only when passed again: an exception made once must not outlive the roots it was for.
  const { allowBroadRoots: _previous, ...stored } = readStoredConfig(home);
  const roots = overrides.roots?.length ? overrides.roots : stored.allowedRoots;

  if (!roots?.length) throw new Error("请用 --root 指定至少一个允许 AI 访问的目录，例如: clouddev-base init --root ~/work");

  const next: StoredConfig = {
    ...stored,
    allowedRoots: roots,
    ...(allowBroadRoots ? { allowBroadRoots: true } : {}),
    ...(overrides.publicUrl ? { publicUrl: normalizePublicUrl(overrides.publicUrl) } : {}),
    ...(overrides.port ? { port: overrides.port } : {}),
    ...(overrides.uiPort === undefined ? {} : { uiPort: overrides.uiPort }),
    ...(overrides.host ? { host: overrides.host } : {}),
  };

  // Checked before saving, so a bad combination (say, the same port twice, or a root holding ~/.ssh) never reaches config.json.
  const config = loadConfig({ roots: next.allowedRoots, host: next.host, port: next.port, uiPort: next.uiPort, publicUrl: next.publicUrl, allowBroadRoots });
  writeStoredConfig(home, next);

  const mcpUrl = new URL("/mcp", config.publicUrl).href;
  const broad = allowBroadRoots ? broadRootProblems(config.allowedRoots, home).map((problem) => `注意（--allow-broad-roots）: ${problem}\n`).join("") : "";

  console.log(`配置已保存: ${configPath(home)}
允许访问的目录: ${config.allowedRoots.join(", ")}
${broad}${initPasswordLines(home, resetPassword)}
${missingRootsWarning(config.allowedRoots)}
下一步:
  1. 启动服务:
       clouddev-base service install    （macOS：登录后自动运行，退出后自动重启）
     或者在终端里临时运行:
       clouddev-base serve
  2. ${isLocalUrl(config.publicUrl)
    ? `在另一台电脑（A）上运行 client/tunnel/install.sh ${sshTarget()} 建立 SSH 隧道
     （这是这台电脑在局域网里的名字，IP 变了也能用；不在同一个局域网时换成能连到这里的地址），
     再把 A 上 client/.mcp.json 的地址设为 ${mcpUrl}（见 README 的“用法”）
  3. 在 A 上用 client/start.sh 启动 Claude Code，再用 /mcp 认证`
    : `客户端连接地址: ${mcpUrl}
     填进另一台电脑上的 client/.mcp.json，用 client/start.sh 启动 Claude Code，再用 /mcp 认证`}`);
}

/**
 * What init says about the Owner password. The password itself is shown only right after it was made, and only on
 * a terminal: run through Claude's bash tool, the output lands in A's transcript, and whoever has the password can
 * approve new clients.
 */
function initPasswordLines(home: string, reset: boolean): string {
  const path = ownerPasswordPath(home);
  let existing: string | undefined;

  try {
    existing = reset ? undefined : storedOwnerPassword(home);
  } catch (error) {
    return `注意: ${(error as Error).message}`;
  }

  const ownerPassword = existing ?? newOwnerPassword(home);

  if (existing === undefined && process.stdout.isTTY) {
    return `Owner 密码: ${ownerPassword}
  （AI 客户端第一次连接时，在授权页输入它。它保存在 ${path}，以后在 B 的终端里运行 clouddev-base password --show 查看）`;
  }

  return `${existing === undefined ? "已生成 Owner 密码，" : "Owner 密码"}保存在 ${path}；在 B 的终端里运行 clouddev-base password --show 查看。
  （AI 客户端第一次连接时，在授权页输入它）`;
}

/** user@name A's install.sh can use to reach this computer: its Bonjour name, which survives a new IP address. */
function sshTarget(): string {
  const local = process.platform === "darwin" ? spawnSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).stdout?.trim() : undefined;

  return `${userInfo().username}@${local ? `${local}.local` : hostname()}`;
}

function isLocalUrl(url: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
}

async function serve(overrides: ConfigOverrides): Promise<void> {
  const asService = process.env[SERVICE_ENV_MARKER] === SERVICE_LABEL;

  // Before the config is read: a config serve refuses ends every start, launchd starts it again every 10 seconds, and
  // each start adds its refusal to the log, which has to stay bounded while that goes on.
  if (asService) keepServiceLogSmall();

  // Before the config is read too: a config.json set to 000 by hand cannot be read, so serve would stop at every
  // start. Only the folder is needed, and a state folder that is the home folder keeps its mode.
  const tightened = tightenStatePermissions(homeDir());

  if (tightened.length) console.error(`已收紧权限，现在只有你自己能访问: ${tightened.join(", ")}`);

  const config = loadConfig(overrides);

  for (const problem of broadRootProblems(config.allowedRoots, config.homeDir)) {
    console.error(`注意（config.json 设置了 allowBroadRoots）: ${problem}`);
  }

  const passwordStatus = checkOwnerPassword(config.homeDir);

  // The activity log only feeds the WebUI: with the page turned off, calls are not recorded at all.
  const activity = config.uiPort !== 0 ? new ActivityLog() : undefined;
  const registry = new WorkspaceRegistry(config.allowedRoots, config.homeDir);
  const { app, mcpUrl } = createHttpApp({ config, registry, activity });
  const httpServer = configureHttpServer(createServer(app));

  await listen(httpServer, config.port, config.host).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EADDRINUSE" ? new Error(`端口 ${config.port} 已被占用，可用 --port 换一个端口。`) : error;
  });

  const ui = activity
    ? await openWebUi(activity, { version: VERSION, mcpUrl: mcpUrl.href, allowedRoots: config.allowedRoots }, config.uiPort)
    : undefined;
  const awake = asService && preventIdleSleep();
  const tunnelPort = new URL(config.publicUrl).port || "80";

  console.log(`clouddev-base ${VERSION} 已启动
  监听:        http://${config.host}:${config.port}
  MCP 地址:    ${mcpUrl.href}
  WebUI:       ${ui?.status ?? "已关闭（--ui-port 0）"}
  允许的目录:  ${config.allowedRoots.join(", ")}
  Owner 密码:  ${passwordStatus}${awake ? "\n  防止休眠:    服务运行期间，这台电脑不会因为空闲而睡眠（caffeinate）" : ""}
${missingRootsWarning(config.allowedRoots)}
${isLocalUrl(config.publicUrl)
    ? `另一台电脑（A）经 SSH 隧道把它的 127.0.0.1:${tunnelPort} 转发到这里的 ${config.port} 端口，A 上 client/.mcp.json 填上面的 MCP 地址。`
    : "其他电脑上的客户端连接上面的 MCP 地址。"}
${process.stdout.isTTY ? "按 Ctrl+C 停止。" : ""}工具调用会显示在下面:`);

  await stopOnSignal(httpServer, () => ui?.stop(), killRunningCommandsNow);
}

/**
 * Make sure clients can be approved, and say how the owner sees the password. The server reads it again on every
 * approval. Only a missing auth.json gets a new password: an unusable one is reported and left as it is, so the
 * server still starts (under launchd a failed start repeats every 10 seconds, out of reach from A), nothing in the
 * file is lost and the password the owner knows is not replaced behind their back; approval is refused meanwhile.
 * A too-short CLOUDDEV_BASE_PASSWORD stops serve at once, in the terminal where it was set.
 */
function checkOwnerPassword(home: string): string {
  if (process.env.CLOUDDEV_BASE_PASSWORD?.trim()) {
    loadOwnerPassword(home);

    return "来自环境变量 CLOUDDEV_BASE_PASSWORD";
  }

  try {
    if (storedOwnerPassword(home) !== undefined) return "在 B 的终端里运行 clouddev-base password --show 查看";
  } catch (error) {
    console.error(`${(error as Error).message}\n修好之前，新客户端的授权都会被拒绝；已经授权的客户端照常使用。`);

    return "无法读取，新客户端的授权会被拒绝（见上面的说明）";
  }

  const ownerPassword = newOwnerPassword(home);
  // Without a terminal (the background service), stdout goes to a log file, where the password must not end up.
  console.log(process.stdout.isTTY
    ? `已生成 Owner 密码: ${ownerPassword}（保存在 ${ownerPasswordPath(home)}）`
    : `已生成 Owner 密码，保存在 ${ownerPasswordPath(home)}；在 B 的终端里运行 clouddev-base password --show 查看。`);

  return "在 B 的终端里运行 clouddev-base password --show 查看";
}

/** Start the activity page if its files are there. A failed build can leave them out; MCP, which A needs, runs on. */
async function openWebUi(activity: ActivityLog, info: WebUiInfo, port: number): Promise<{ status: string; stop(): void }> {
  let app: RequestListener;

  try {
    app = createWebUiApp(activity, info);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`WebUI 没有启动: ${reason}`);

    return { status: `没有启动: ${reason}`, stop: () => {} };
  }

  return startWebUi(app, port);
}

const UI_RETRY_MS = 30_000;

/**
 * Start the activity page. It is a convenience: when its port is taken, MCP runs without it, and the page is
 * tried again every 30 seconds, so it comes up once the port is free.
 */
async function startWebUi(app: RequestListener, port: number): Promise<{ status: string; stop(): void }> {
  const server = createServer(app);
  const url = `http://${WEBUI_HOST}:${port}`;
  let retry: NodeJS.Timeout | undefined;
  let listening = false;

  const attempt = async (first: boolean): Promise<string> => {
    try {
      await listen(server, port, WEBUI_HOST);
      listening = true;

      if (!first) console.error(`WebUI 已启动: ${url}`);

      return `${url}（只能在这台电脑上打开）`;
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;

      if (code !== "EADDRINUSE") return `没有启动: ${message}`;

      retry = setTimeout(() => void attempt(false), UI_RETRY_MS);
      retry.unref();

      return `端口 ${port} 被占用，每 30 秒重试一次（也可以用 --ui-port 换一个端口）`;
    }
  };

  const status = await attempt(true);

  return {
    status,
    stop: () => {
      clearTimeout(retry);

      if (!listening) return;

      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * Keep this computer from idle sleep while the background service runs, so the other computer can still reach
 * it when nobody uses this one. (A closed laptop lid still sleeps.) caffeinate -w lets go when this process ends.
 */
function preventIdleSleep(): boolean {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/caffeinate")) return false;

  const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  child.on("error", (error) => console.error("caffeinate 没能启动:", error.message));
  child.unref();

  return true;
}

const SERVICE_LOG_LIMIT = 10 * 1024 * 1024;

/**
 * launchd appends the service's output to one log file forever. Every 10 minutes a log over 10 MB is copied to
 * <log>.1 and emptied in place; launchd opened it for appending, so the service just continues at the new end.
 */
function keepServiceLogSmall(): void {
  const { logPath } = servicePaths(homedir());

  const check = () => {
    try {
      if (statSync(logPath).size <= SERVICE_LOG_LIMIT) return;

      copyFileSync(logPath, `${logPath}.1`);
      truncateSync(logPath, 0);
    } catch {
      // No log yet, or it cannot be touched: nothing to do.
    }
  };

  check();
  setInterval(check, 10 * 60 * 1000).unref();
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      server.on("error", (error) => console.error("服务出错:", error));
      resolvePromise();
    });
  });
}

/**
 * Resolve once SIGINT or SIGTERM has closed the server. Open connections are cut; `alsoStop` ends the rest. Commands
 * still running get their grace period, which can take a while, so a second signal ends the process at once, after
 * `endNow` (which ends those commands without waiting).
 */
function stopOnSignal(server: Server, alsoStop: () => void, endNow: () => void = () => {}): Promise<void> {
  return new Promise((resolvePromise) => {
    let stopping = false;

    const onSignal = (signal: NodeJS.Signals) => {
      if (stopping) {
        try {
          endNow();
        } finally {
          process.exit(signal === "SIGINT" ? 130 : 143);
        }
      }

      stopping = true;
      console.log(`\n正在停止…${signal === "SIGINT" ? "（再按一次 Ctrl+C 立即结束）" : ""}`);
      alsoStop();
      server.close(() => resolvePromise());
      server.closeAllConnections();
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function service(action: string | undefined, overrides: ConfigOverrides, print: boolean): Promise<void> {
  if (Object.values(overrides).some((value) => value !== undefined)) {
    throw new Error("service 使用配置文件里的设置，不接受 --root、--port 等参数。要修改，先运行 clouddev-base init …，再运行 clouddev-base service install。");
  }

  const inputs = { home: homedir(), nodePath: process.execPath, cliPath: fileURLToPath(import.meta.url), env: process.env };

  switch (action) {
    case "install":
      return installService(loadConfig(), inputs, { print });
    case "uninstall":
      return uninstallService(inputs);
    case "status":
      // First, so that elsewhere a config problem is not explained in terms of launchd.
      requireLaunchd();

      return serviceStatus(statusAddresses(), inputs);
    default:
      throw new Error("用法: clouddev-base service install|uninstall|status [--print]");
  }
}

/**
 * Where `service status` looks for the service. A config serve would refuse is reported, and the status is shown all
 * the same: launchd's state and last exit code are what explain a service that keeps restarting.
 */
function statusAddresses(): ListenAddresses {
  try {
    return loadConfig();
  } catch (error) {
    console.error(`${(error as Error).message}

按现在的配置，serve 启动不了：后台服务一重启（重新登录、重启电脑、出错退出）就起不来，launchd 每 10 秒重试一次，A 上会连不上。
按上面的提示改好后，运行 clouddev-base service install（它先检查配置，再重启后台服务）。
`);
    process.exitCode = 1;

    return storedAddresses();
  }
}

/**
 * The Owner password is printed only on request (--show), or right after --reset makes one on a terminal: whoever
 * has it can approve new clients, and output read through Claude's bash tool ends up in A's transcript.
 */
function password(show: boolean, reset: boolean): void {
  const home = homeDir();
  const path = ownerPasswordPath(home);

  if (reset) {
    const ownerPassword = newOwnerPassword(home);

    if (show || process.stdout.isTTY) printPassword(ownerPassword);
    else console.log(`已生成新的 Owner 密码，保存在 ${path}；在 B 的终端里运行 clouddev-base password --show 查看。`);

    console.error(`已生成新密码，运行中的服务立即生效，无需重启（如果服务设置了环境变量 CLOUDDEV_BASE_PASSWORD，则仍以环境变量为准）。
已连接的客户端不受影响；要注销所有客户端，删除 ${resolve(home, "oauth.json")}，运行中的服务（包括后台服务）立即生效，无需重启。`);

    return;
  }

  const fromEnv = Boolean(process.env.CLOUDDEV_BASE_PASSWORD?.trim());
  // Only --reset replaces the stored password; one is made here only when there is none at all.
  const existing = loadOwnerPassword(home);
  const ownerPassword = existing ?? newOwnerPassword(home);

  if (show) {
    printPassword(ownerPassword);

    if (fromEnv) {
      console.error(`（这是环境变量 CLOUDDEV_BASE_PASSWORD 的值，在这个终端里运行的 serve 用它。用 service install 装的后台服务不读这个变量，用的是 ${path} 里的密码。）`);
    }

    return;
  }

  if (fromEnv) {
    console.log(`这个终端设置了环境变量 CLOUDDEV_BASE_PASSWORD：在这里运行的 serve 用它，password --show 显示的也是它。
用 service install 装的后台服务不读这个变量，用的是 ${path} 里的密码：在没设这个变量的终端里运行 clouddev-base password --show 查看。`);

    return;
  }

  console.log(`${existing === undefined ? "已生成 Owner 密码，" : "Owner 密码"}保存在 ${path}。
  查看:  clouddev-base password --show（在 B 的终端里运行；经 Claude 运行的话，密码会进入 A 上的对话记录）
  换新:  clouddev-base password --reset（运行中的服务立即生效）`);
}

/** Print the password, warning when it goes somewhere other than a terminal. */
function printPassword(ownerPassword: string): void {
  console.log(ownerPassword);

  if (!process.stdout.isTTY) {
    console.error("注意: 输出不是终端，密码会留在接收输出的地方：比如经 Claude 的 bash 工具运行时，它会进入 A 上的对话记录。拿到它的人可以批准新的客户端。");
  }
}

function parsePort(value: string, allowZero = false): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65_535) throw new Error(`无效的端口: ${value}`);

  return port;
}

function missingRootsWarning(roots: string[]): string {
  const missing = roots.filter((root) => !existsSync(root));

  return missing.length ? `注意: 这些目录不存在: ${missing.join(", ")}\n` : "";
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
