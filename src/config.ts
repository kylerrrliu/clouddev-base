import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "./paths.ts";

export const DEFAULT_PORT = 7676;
export const DEFAULT_HOST = "127.0.0.1";
/** The activity page. It always listens on 127.0.0.1 only; 0 turns it off. */
export const DEFAULT_UI_PORT = 7677;
/** The only address the activity page listens on: the SSH tunnel forwards the MCP port alone. */
export const WEBUI_HOST = "127.0.0.1";

/** What lives in ~/.clouddev-base/config.json. Every field is optional. */
export interface StoredConfig {
  allowedRoots?: string[];
  host?: string;
  port?: number;
  publicUrl?: string;
  allowedRedirectHosts?: string[];
  uiPort?: number;
  /** Names of extra environment variables `service install` copies into the launchd job. */
  serviceEnv?: string[];
}

export interface Config {
  homeDir: string;
  allowedRoots: string[];
  host: string;
  port: number;
  /** Origin the MCP host uses to reach this server: the SSH tunnel's end on the other computer, e.g. http://127.0.0.1:7676 */
  publicUrl: string;
  /** Extra https hosts accepted as OAuth redirect targets. Loopback, which is all Claude Code uses, is always accepted. */
  allowedRedirectHosts: string[];
  /** Port of the activity page on 127.0.0.1; 0 when it is turned off. */
  uiPort: number;
  /** Names of extra environment variables `service install` copies into the launchd job (config.json only). */
  serviceEnv: string[];
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(env.CLOUDDEV_BASE_HOME ?? join(homedir(), ".clouddev-base")));
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function readStoredConfig(home: string): StoredConfig {
  return readJson<StoredConfig>(configPath(home)) ?? {};
}

export function writeStoredConfig(home: string, config: StoredConfig): void {
  writeJsonPrivate(configPath(home), config);
}

export interface ConfigOverrides {
  roots?: string[];
  host?: string;
  port?: number;
  publicUrl?: string;
  uiPort?: number;
}

/** Merge config.json with command-line overrides into the runtime config. */
export function loadConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const home = homeDir(env);
  const stored = readStoredConfig(home);
  const host = overrides.host ?? stored.host ?? DEFAULT_HOST;
  const port = overrides.port ?? stored.port ?? DEFAULT_PORT;
  const roots = overrides.roots?.length ? overrides.roots : stored.allowedRoots ?? [];

  if (roots.length === 0) {
    throw new Error("没有配置允许访问的目录。请先运行 `clouddev-base init --root <目录>`，或在启动时传入 --root。");
  }

  const publicUrl = normalizePublicUrl(overrides.publicUrl ?? stored.publicUrl ?? localBaseUrl(host, port));
  const chosenUiPort = overrides.uiPort ?? stored.uiPort;
  let uiPort = chosenUiPort ?? DEFAULT_UI_PORT;

  if (uiPort !== 0 && uiPort === port) {
    if (chosenUiPort !== undefined) {
      throw new Error(`WebUI 端口不能和 MCP 端口相同（都是 ${port}）。用 --ui-port 换一个，或设为 0 关闭 WebUI。`);
    }

    // Only the default collides (MCP itself was put on 7677): move the page next door instead of refusing to start.
    uiPort = port === 65_535 ? port - 1 : port + 1;
  }

  return {
    homeDir: home,
    allowedRoots: roots.map((root) => resolve(expandHome(root))),
    host,
    port,
    publicUrl,
    allowedRedirectHosts: stored.allowedRedirectHosts ?? [],
    uiPort,
    // Checked by `service install`, the only user, so a typo here never stops `serve`.
    serviceEnv: Array.isArray(stored.serviceEnv) ? stored.serviceEnv.filter((name): name is string => typeof name === "string") : [],
  };
}

/** How this computer reaches a server listening on `host`: a wildcard address means loopback. */
export function localBaseUrl(host: string, port: number): string {
  const name = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;

  return `http://${name}:${port}`;
}

/** Where the activity page is, or undefined when it is turned off. */
export function webUiUrl(config: Pick<Config, "uiPort">): string | undefined {
  return config.uiPort ? `http://${WEBUI_HOST}:${config.uiPort}` : undefined;
}

/** Keep only the origin. A pasted ".../mcp" URL is accepted too. */
export function normalizePublicUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`无效的访问地址: ${value}`);
  }

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`访问地址必须是 https://（本机调试可用 http://127.0.0.1）: ${value}`);
  }

  return url.origin;
}

export function ownerPasswordPath(home: string): string {
  return join(home, "auth.json");
}

/** The password typed on the approval page when an MCP host connects. */
export function loadOwnerPassword(home: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // A blank variable counts as unset: it must not hide (or lead to replacing) the stored password.
  const fromEnv = env.CLOUDDEV_BASE_PASSWORD?.trim();
  const password = fromEnv || readJson<{ ownerPassword?: string }>(ownerPasswordPath(home))?.ownerPassword?.trim();

  if (password && password.length < 16) {
    throw new Error("Owner 密码至少需要 16 个字符。");
  }

  return password || undefined;
}

export function ensureOwnerPassword(home: string, reset = false): string {
  const existing = reset ? undefined : readJson<{ ownerPassword?: string }>(ownerPasswordPath(home))?.ownerPassword;

  if (existing) return existing;

  const ownerPassword = randomBytes(18).toString("base64url");
  writeJsonPrivate(ownerPasswordPath(home), { ownerPassword });

  return ownerPassword;
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;

  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`无法解析 ${path}: ${(error as Error).message}`);
  }
}

/** Atomically write a JSON file readable only by the current user. */
export function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
