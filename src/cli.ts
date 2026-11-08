#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  configPath,
  ensureOwnerPassword,
  homeDir,
  loadConfig,
  loadOwnerPassword,
  normalizePublicUrl,
  ownerPasswordPath,
  readStoredConfig,
  writeStoredConfig,
  type ConfigOverrides,
} from "./config.ts";
import { configureHttpServer, createHttpApp } from "./http.ts";
import { expandHome } from "./paths.ts";
import { VERSION } from "./version.ts";
import { WorkspaceRegistry } from "./workspaces.ts";

const HELP = `clouddev-base ${VERSION} — 让 Claude 等 AI 通过 MCP 读写、搜索本机项目并执行命令

用法:
  clouddev-base init --root <目录> [--root <目录>] [--public-url <https 地址>] [--port <端口>]
      保存配置并生成 Owner 密码（只需运行一次）
  clouddev-base serve [--root <目录>] [--public-url <https 地址>] [--port <端口>] [--host <地址>]
      启动 HTTP MCP 服务，供其他电脑上的 Claude Code 经 Tailscale 连接
  clouddev-base password [--reset]
      显示 Owner 密码；加 --reset 生成新密码，运行中的服务立即生效

配置目录: ${homeDir()}（可用环境变量 CLOUDDEV_BASE_HOME 修改）`;

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      root: { type: "string", multiple: true },
      "public-url": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      reset: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);

    return;
  }

  const overrides: ConfigOverrides = {
    roots: values.root?.map((root) => resolve(expandHome(root))),
    host: values.host,
    port: values.port === undefined ? undefined : parsePort(values.port),
    publicUrl: values["public-url"],
  };

  switch (command) {
    case "init":
      return init(overrides, values.reset ?? false);
    case "serve":
      return serve(overrides);
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

  writeStoredConfig(home, {
    ...stored,
    allowedRoots: roots,
    ...(overrides.publicUrl ? { publicUrl: normalizePublicUrl(overrides.publicUrl) } : {}),
    ...(overrides.port ? { port: overrides.port } : {}),
    ...(overrides.host ? { host: overrides.host } : {}),
  });

  const ownerPassword = ensureOwnerPassword(home, resetPassword);
  const config = loadConfig();

  console.log(`配置已保存: ${configPath(home)}
允许访问的目录: ${config.allowedRoots.join(", ")}
Owner 密码: ${ownerPassword}
  （AI 客户端第一次连接时，在授权页输入它；保存在 ${ownerPasswordPath(home)}）
${missingRootsWarning(config.allowedRoots)}
${isLocalUrl(config.publicUrl) ? accessSetupSteps(config.port) : `下一步:
  1. 启动服务:
       clouddev-base serve
  2. 客户端连接地址: ${new URL("/mcp", config.publicUrl).href}
       填进另一台电脑上的 client/.mcp.json，在 client/ 目录里运行 claude，再用 /mcp 认证`}`);
}

function accessSetupSteps(port: number): string {
  return `下一步，用 Tailscale 让另一台电脑上的 Claude Code 连接这台电脑（只在你的私有网络内可见）:
  1. 提供 HTTPS 并启动服务:
       tailscale serve --bg ${port}
       clouddev-base serve --public-url https://<本机名>.<tailnet>.ts.net
  2. 在另一台电脑上用项目里的 client/ 目录启动 Claude Code（见 README 的“用法”）`;
}

function isLocalUrl(url: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
}

function serve(overrides: ConfigOverrides): Promise<void> {
  const config = loadConfig(overrides);

  // The server reads the password again on every approval; here we only make sure one exists
  // (and fail fast on a too-short CLOUDDEV_BASE_PASSWORD).
  if (!loadOwnerPassword(config.homeDir)) {
    const ownerPassword = ensureOwnerPassword(config.homeDir);
    console.log(`已生成 Owner 密码: ${ownerPassword}（保存在 ${ownerPasswordPath(config.homeDir)}）`);
  }

  const registry = new WorkspaceRegistry(config.allowedRoots, config.homeDir);
  const { app, mcpUrl } = createHttpApp({ config, registry });
  const httpServer = configureHttpServer(createServer(app));

  return new Promise((resolvePromise, reject) => {
    httpServer.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new Error(`端口 ${config.port} 已被占用，可用 --port 换一个端口。`) : error);
    });

    httpServer.listen(config.port, config.host, () => {
      const local = isLocalUrl(config.publicUrl);

      console.log(`clouddev-base ${VERSION} 已启动
  监听:        http://${config.host}:${config.port}
  MCP 地址:    ${mcpUrl.href}
  允许的目录:  ${config.allowedRoots.join(", ")}
  Owner 密码:  运行 clouddev-base password 查看
${missingRootsWarning(config.allowedRoots)}${local ? `
提示: 当前没有配置访问地址，其他电脑连不上这台电脑。
      先运行 tailscale serve --bg ${config.port}，再加 --public-url https://<本机名>.<tailnet>.ts.net 重新启动
` : ""}
按 Ctrl+C 停止。工具调用会显示在下面:`);
    });

    const shutdown = () => {
      console.log("\n正在停止…");
      httpServer.close(() => resolvePromise());
      httpServer.closeAllConnections();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function password(reset: boolean): void {
  const home = homeDir();
  // Only --reset replaces the stored password; viewing creates one only when none exists yet.
  const ownerPassword = reset ? ensureOwnerPassword(home, true) : (loadOwnerPassword(home) ?? ensureOwnerPassword(home));

  console.log(ownerPassword);

  if (reset) {
    console.error(`已生成新密码，运行中的服务立即生效，无需重启（如果服务设置了环境变量 CLOUDDEV_BASE_PASSWORD，则仍以环境变量为准）。
已连接的客户端不受影响；要注销所有客户端，请停止服务，删除 ${resolve(home, "oauth.json")}，再重新启动。`);
  }
}

function parsePort(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`无效的端口: ${value}`);

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
