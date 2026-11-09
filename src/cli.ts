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
  configPath,
  DEFAULT_UI_PORT,
  ensureOwnerPassword,
  homeDir,
  loadConfig,
  loadOwnerPassword,
  normalizePublicUrl,
  ownerPasswordPath,
  readStoredConfig,
  WEBUI_HOST,
  writeStoredConfig,
  type ConfigOverrides,
  type StoredConfig,
} from "./config.ts";
import { configureHttpServer, createHttpApp } from "./http.ts";
import { expandHome } from "./paths.ts";
import { installService, SERVICE_ENV_MARKER, SERVICE_LABEL, servicePaths, serviceStatus, uninstallService } from "./service.ts";
import { VERSION } from "./version.ts";
import { createWebUiApp } from "./webui.ts";
import { WorkspaceRegistry } from "./workspaces.ts";

const HELP = `clouddev-base ${VERSION} — 让 Claude 等 AI 通过 MCP 读写、搜索本机项目并执行命令

用法:
  clouddev-base init --root <目录> [--root <目录>] [--port <端口>] [--ui-port <端口>] [--public-url <地址>]
      保存配置并生成 Owner 密码（只需运行一次）
  clouddev-base serve [--root <目录>] [--port <端口>] [--ui-port <端口>] [--host <地址>] [--public-url <地址>]
      启动 MCP 服务和本机 WebUI，供另一台电脑上的 Claude Code 经 SSH 隧道连接
  clouddev-base service install|uninstall|status [--print]
      macOS：把 serve 装成登录后自动运行、退出后自动重启的后台服务（launchd）；--print 只打印配置，不安装
  clouddev-base password [--reset]
      显示 Owner 密码；加 --reset 生成新密码，运行中的服务立即生效

  --ui-port   WebUI 的端口，只监听 127.0.0.1（默认 ${DEFAULT_UI_PORT}，设为 0 关闭）

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
      print: { type: "boolean" },
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

  const overrides: ConfigOverrides = {
    roots: values.root?.map((root) => resolve(expandHome(root))),
    host: values.host,
    port: values.port === undefined ? undefined : parsePort(values.port),
    uiPort: values["ui-port"] === undefined ? undefined : parsePort(values["ui-port"], true),
    publicUrl: values["public-url"],
  };

  switch (command) {
    case "init":
      return init(overrides, values.reset ?? false);
    case "serve":
      return serve(overrides);
    case "service":
      return service(positionals[0], overrides, values.print ?? false);
    case "password":
      return password(values.reset ?? false);
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);

      return;
    default:
      throw new Error(`未知命令: ${command}\n\n${HELP}`);
  }
}

function init(overrides: ConfigOverrides, resetPassword: boolean): void {
  const home = homeDir();
  const stored = readStoredConfig(home);
  const roots = overrides.roots?.length ? overrides.roots : stored.allowedRoots;

  if (!roots?.length) throw new Error("请用 --root 指定至少一个允许 AI 访问的目录，例如: clouddev-base init --root ~/work");

  const next: StoredConfig = {
    ...stored,
    allowedRoots: roots,
    ...(overrides.publicUrl ? { publicUrl: normalizePublicUrl(overrides.publicUrl) } : {}),
    ...(overrides.port ? { port: overrides.port } : {}),
    ...(overrides.uiPort === undefined ? {} : { uiPort: overrides.uiPort }),
    ...(overrides.host ? { host: overrides.host } : {}),
  };

  // Checked before saving, so a bad combination (say, the same port twice) never reaches config.json.
  const config = loadConfig({ roots: next.allowedRoots, host: next.host, port: next.port, uiPort: next.uiPort, publicUrl: next.publicUrl });
  writeStoredConfig(home, next);

  const ownerPassword = ensureOwnerPassword(home, resetPassword);
  const mcpUrl = new URL("/mcp", config.publicUrl).href;

  console.log(`配置已保存: ${configPath(home)}
允许访问的目录: ${config.allowedRoots.join(", ")}
Owner 密码: ${ownerPassword}
  （AI 客户端第一次连接时，在授权页输入它；保存在 ${ownerPasswordPath(home)}）
${missingRootsWarning(config.allowedRoots)}
下一步:
  1. 启动服务:
       clouddev-base service install    （macOS：登录后自动运行，退出后自动重启）
     或者在终端里临时运行:
       clouddev-base serve
  2. ${isLocalUrl(config.publicUrl)
    ? `在另一台电脑（A）上运行 client/tunnel/install.sh ${sshTarget()} 建立 SSH 隧道
     （这是这台电脑在局域网里的名字，IP 变了也能用；不在同一个局域网时换成能连到这里的地址），
     再把 A 上 client/.mcp.json 的地址设为 ${mcpUrl}（见 README 的“用法”）`
    : `客户端连接地址: ${mcpUrl}
     填进另一台电脑上的 client/.mcp.json，在 client/ 目录里运行 claude，再用 /mcp 认证`}`);
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
  const config = loadConfig(overrides);
  const asService = process.env[SERVICE_ENV_MARKER] === SERVICE_LABEL;

  if (asService) keepServiceLogSmall();

  // The server reads the password again on every approval; here we only make sure one exists
  // (and fail fast on a too-short CLOUDDEV_BASE_PASSWORD).
  if (!loadOwnerPassword(config.homeDir)) {
    const ownerPassword = ensureOwnerPassword(config.homeDir);
    // Without a terminal (the background service), stdout goes to a log file, where the password must not end up.
    console.log(process.stdout.isTTY
      ? `已生成 Owner 密码: ${ownerPassword}（保存在 ${ownerPasswordPath(config.homeDir)}）`
      : `已生成 Owner 密码，保存在 ${ownerPasswordPath(config.homeDir)}；运行 clouddev-base password 查看。`);
  }

  // The activity log only feeds the WebUI: with the page turned off, calls are not recorded at all.
  const activity = config.uiPort !== 0 ? new ActivityLog() : undefined;
  const registry = new WorkspaceRegistry(config.allowedRoots, config.homeDir);
  const { app, mcpUrl } = createHttpApp({ config, registry, activity });
  const httpServer = configureHttpServer(createServer(app));

  await listen(httpServer, config.port, config.host).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EADDRINUSE" ? new Error(`端口 ${config.port} 已被占用，可用 --port 换一个端口。`) : error;
  });

  const ui = activity
    ? await startWebUi(createWebUiApp(activity, { version: VERSION, mcpUrl: mcpUrl.href, allowedRoots: config.allowedRoots }), config.uiPort)
    : undefined;
  const awake = asService && preventIdleSleep();
  const tunnelPort = new URL(config.publicUrl).port || "80";

  console.log(`clouddev-base ${VERSION} 已启动
  监听:        http://${config.host}:${config.port}
  MCP 地址:    ${mcpUrl.href}
  WebUI:       ${ui?.status ?? "已关闭（--ui-port 0）"}
  允许的目录:  ${config.allowedRoots.join(", ")}
  Owner 密码:  运行 clouddev-base password 查看${awake ? "\n  防止休眠:    服务运行期间，这台电脑不会因为空闲而睡眠（caffeinate）" : ""}
${missingRootsWarning(config.allowedRoots)}
${isLocalUrl(config.publicUrl)
    ? `另一台电脑（A）经 SSH 隧道把它的 127.0.0.1:${tunnelPort} 转发到这里的 ${config.port} 端口，A 上 client/.mcp.json 填上面的 MCP 地址。`
    : "其他电脑上的客户端连接上面的 MCP 地址。"}
${process.stdout.isTTY ? "按 Ctrl+C 停止。" : ""}工具调用会显示在下面:`);

  await stopOnSignal(httpServer, () => ui?.stop());
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

/** Resolve once SIGINT or SIGTERM has closed the server. Open connections are cut; `alsoStop` ends the rest. */
function stopOnSignal(server: Server, alsoStop: () => void): Promise<void> {
  return new Promise((resolvePromise) => {
    const shutdown = () => {
      console.log("\n正在停止…");
      alsoStop();
      server.close(() => resolvePromise());
      server.closeAllConnections();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
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
      return serviceStatus(loadConfig(), inputs.home);
    default:
      throw new Error("用法: clouddev-base service install|uninstall|status [--print]");
  }
}

function password(reset: boolean): void {
  const home = homeDir();
  const fromEnv = !reset && Boolean(process.env.CLOUDDEV_BASE_PASSWORD?.trim());
  // Only --reset replaces the stored password; viewing creates one only when none exists yet.
  const ownerPassword = reset ? ensureOwnerPassword(home, true) : (loadOwnerPassword(home) ?? ensureOwnerPassword(home));

  console.log(ownerPassword);

  if (fromEnv) {
    console.error(`（这是环境变量 CLOUDDEV_BASE_PASSWORD 的值，在这个终端里运行的 serve 用它。用 service install 装的后台服务不读这个变量，用的是 ${ownerPasswordPath(home)} 里的密码。）`);
  }

  if (reset) {
    console.error(`已生成新密码，运行中的服务立即生效，无需重启（如果服务设置了环境变量 CLOUDDEV_BASE_PASSWORD，则仍以环境变量为准）。
已连接的客户端不受影响；要注销所有客户端，删除 ${resolve(home, "oauth.json")}，运行中的服务（包括后台服务）立即生效，无需重启。`);
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
