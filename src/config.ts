import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { expandHome, isInside, isMissing } from "./paths.ts";

export const DEFAULT_PORT = 7676;
export const DEFAULT_HOST = "127.0.0.1";
/** The activity page. It always listens on 127.0.0.1 only; 0 turns it off. */
export const DEFAULT_UI_PORT = 7677;
/** The only address the activity page listens on: the SSH tunnel forwards the MCP port alone. */
export const WEBUI_HOST = "127.0.0.1";

/** What lives in ~/.clouddev-base/config.json. Every field is optional. */
export interface StoredConfig {
  allowedRoots?: string[];
  /**
   * Accept allowed roots through which the AI reads secrets without a prompt: "/", the home folder or a folder
   * above it, or a folder holding the state folder. Saved by `init --allow-broad-roots`; only `true` counts.
   */
  allowBroadRoots?: boolean;
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

/** The files the server keeps in its state folder. */
const STATE_FILES = ["config.json", "auth.json", "oauth.json", "workspaces.json"];

/**
 * macOS keeps the folders users write to (/Users, /Applications, /private, …) on a separate data volume and
 * firmlinks them into the root, so /System/Volumes/Data/Users/you is another name for /Users/you. realpath keeps
 * whichever name it is given.
 */
const DATA_VOLUME = "/System/Volumes/Data";

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  // A blank variable counts as unset, as the plist treats it: "" would otherwise mean the current folder, which serve
  // would then make private and fill with auth.json.
  return resolve(expandHome(env.CLOUDDEV_BASE_HOME?.trim() || join(homedir(), ".clouddev-base")));
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

/**
 * config.json, checked only as far as needed to use it safely. A broken one stops whoever reads it: falling back to
 * the defaults could quietly widen what the server allows.
 */
export function readStoredConfig(home: string): StoredConfig {
  const path = configPath(home);
  const fix = "手动编辑过这个文件的话，改正后运行 clouddev-base service status 检查服务是否恢复。";
  let stored: unknown;

  try {
    stored = readJson(path);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${fix}`);
  }

  if (stored === undefined) return {};

  if (!isPlainObject(stored)) throw new Error(`${path} 应该是一个 JSON 对象（{ … }）。\n${fix}`);

  const { allowedRoots } = stored;

  if (allowedRoots !== undefined && !(Array.isArray(allowedRoots) && allowedRoots.every((root) => typeof root === "string"))) {
    throw new Error(`${path} 里的 allowedRoots 应该是目录的列表，例如 ["~/work"]。\n${fix}`);
  }

  return stored as StoredConfig;
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
  /** Used instead of config.json's allowBroadRoots (by init, which checks what it is about to save). */
  allowBroadRoots?: boolean;
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

  const allowedRoots = roots.map((root) => resolve(expandHome(root)));
  checkAllowedRoots(allowedRoots, home, overrides.allowBroadRoots ?? (stored.allowBroadRoots === true));

  const publicUrl = normalizePublicUrl(overrides.publicUrl ?? stored.publicUrl ?? localBaseUrl(host, port));
  const chosenUiPort = overrides.uiPort ?? stored.uiPort;

  if (chosenUiPort !== undefined && chosenUiPort !== 0 && chosenUiPort === port) {
    throw new Error(`WebUI 端口不能和 MCP 端口相同（都是 ${port}）。用 --ui-port 换一个，或设为 0 关闭 WebUI。`);
  }

  return {
    homeDir: home,
    allowedRoots,
    host,
    port,
    publicUrl,
    allowedRedirectHosts: stored.allowedRedirectHosts ?? [],
    uiPort: chosenUiPort ?? defaultUiPort(port),
    // Checked by `service install`, the only user, so a typo here never stops `serve`.
    serviceEnv: Array.isArray(stored.serviceEnv) ? stored.serviceEnv.filter((name): name is string => typeof name === "string") : [],
  };
}

/** The WebUI port when none was chosen. Only the default can collide (MCP itself was put on 7677): it moves next door. */
function defaultUiPort(port: number): number {
  return port === DEFAULT_UI_PORT ? DEFAULT_UI_PORT + 1 : DEFAULT_UI_PORT;
}

/** Where the server listens. */
export type ListenAddresses = Pick<Config, "host" | "port" | "uiPort">;

/**
 * Where the server listens according to config.json, without loadConfig's checks: `service status` must reach a
 * service that started before the config became one serve refuses. The defaults stand in for what cannot be read.
 */
export function storedAddresses(env: NodeJS.ProcessEnv = process.env): ListenAddresses {
  let stored: StoredConfig = {};

  try {
    stored = readStoredConfig(homeDir(env));
  } catch {
    // A broken config.json: the defaults are the best guess.
  }

  const port = stored.port ?? DEFAULT_PORT;

  return { host: stored.host ?? DEFAULT_HOST, port, uiPort: stored.uiPort ?? defaultUiPort(port) };
}

/**
 * read, grep and glob run without asking (client/.claude/settings.json allows them), so an allowed root that holds
 * the home folder hands the AI the SSH keys and puts them in A's transcript, and one that holds the state folder
 * leaves only WorkspaceRegistry's check between the AI and the Owner password. Such roots need allowBroadRoots. A
 * root inside the state folder is never accepted: no workspace could be opened there anyway.
 */
function checkAllowedRoots(roots: string[], stateDir: string, allowBroad: boolean): void {
  const insideState = roots.find((root) => isWithin(root, stateDir));

  if (insideState) {
    const same = isWithin(stateDir, insideState);
    throw new Error(`允许访问的目录 ${insideState} ${same ? "就是" : "在"} clouddev-base 的配置目录 ${stateDir}${same ? "" : " 里面"}。那里放的是 Owner 密码和授权令牌，不能让 AI 访问。请换一个目录，例如 ~/work。`);
  }

  const problems = broadRootProblems(roots, stateDir);

  if (problems.length === 0 || allowBroad) return;

  throw new Error(`这些允许访问的目录太宽:
${problems.map((problem) => `  ${problem}`).join("\n")}
请改用专门放项目的目录，例如: clouddev-base init --root ~/work
确实需要这样的话，在 init 时加上 --allow-broad-roots（会保存进 config.json）。`);
}

/**
 * Allowed roots that are too broad, each with what it exposes. The state folder itself stays closed whatever the
 * roots (WorkspaceRegistry refuses any workspace that holds it), so a root that holds it only leaves that one check
 * between the AI and the Owner password.
 */
export function broadRootProblems(roots: string[], stateDir: string): string[] {
  const home = homedir();
  const problems: string[] = [];

  for (const root of roots) {
    const holdsState = isWithin(stateDir, root);

    if (isWithin(home, root)) {
      const alias = otherNameIn(root, home);
      const what = isWithin(root, home) ? "是家目录" : `包含家目录 ${home}${alias ? `（${alias} 是它的另一个名字）` : ""}`;
      const state = holdsState ? `；配置目录 ${stateDir} 照样不开放（工作区不能包含它）` : "";
      problems.push(`${root} ${what}：AI 用 read、grep、glob 不经你确认就能读到 ~/.ssh 里的私钥等文件，读到的内容会进入 A 上的对话记录${state}`);
    } else if (holdsState) {
      problems.push(`${root} 包含 clouddev-base 的配置目录 ${stateDir}：里面放着 Owner 密码和授权令牌，挡着 AI 的只剩“工作区不能包含配置目录”这一条规则（也可以用环境变量 CLOUDDEV_BASE_HOME 把配置目录放到别处）`);
    }
  }

  return problems;
}

/**
 * The name under which `root` holds `path` when it does not hold it under `path`'s own: on macOS, the one on the data
 * volume. /System holds /Users/you as /System/Volumes/Data/Users/you, and so does /System/Volumes/Data/Users. Without
 * it, a message saying that such a root holds /Users/you would not add up.
 */
function otherNameIn(root: string, path: string): string | undefined {
  const realRoot = realPathOf(root);
  const realPath = realPathOf(path);

  return isInside(realPath, realRoot) ? undefined : otherNames(realPath).find((name) => isInside(name, realRoot));
}

/**
 * Whether `path` is `folder` or lies inside it, also when the two are written differently: compared as given, with
 * symlinks resolved (on macOS this also settles upper and lower case), under `path`'s name on macOS's data volume
 * (so /System holds /Users/you), and by file identity, which catches other names for the same folder, such as a
 * bind mount. `path` need not exist.
 */
export function isWithin(path: string, folder: string): boolean {
  if (isInside(resolve(path), resolve(folder))) return true;

  const realPath = realPathOf(path);
  const realFolder = realPathOf(folder);

  return [realPath, ...otherNames(realPath)].some((name) => isInside(name, realFolder))
    || holdsUnderSameNames(realFolder, existingPart(realPath));
}

/**
 * The other name of a real path on macOS: its name on the data volume, or the one without it. Only the firmlinked
 * folders have one, so it counts only when it leads to the same file (checked on the longest part that exists:
 * "/" and the data volume's own root are different folders).
 */
export function otherNames(realPath: string): string[] {
  if (process.platform !== "darwin") return [];

  const existing = existingPart(realPath);
  const other = isInside(existing, DATA_VOLUME) ? resolve("/", relative(DATA_VOLUME, existing)) : join(DATA_VOLUME, existing);
  const id = fileId(existing);

  return id !== undefined && fileId(other) === id ? [join(other, relative(existing, realPath))] : [];
}

/** `path` with symlinks resolved in the longest part of it that exists; the rest is appended unchanged. */
export function realPathOf(path: string): string {
  const absolute = resolve(path);

  for (let candidate = absolute; ; candidate = dirname(candidate)) {
    try {
      return resolve(realpathSync.native(candidate), relative(candidate, absolute));
    } catch {
      if (dirname(candidate) === candidate) return absolute;
    }
  }
}

/** The longest part of a real path that exists. */
export function existingPart(path: string): string {
  let candidate = path;

  while (fileId(candidate) === undefined && dirname(candidate) !== candidate) candidate = dirname(candidate);

  return candidate;
}

/**
 * Whether `folder` holds the existing real path `path` under the names `path` ends with: if one of the folders
 * above `path` is `folder` under another name, the rest of the names lead from `folder` to the same file.
 * Symlinks inside `folder` that lead out of it do not count.
 */
function holdsUnderSameNames(folder: string, path: string): boolean {
  const target = fileId(path);

  if (target === undefined || fileId(folder) === undefined) return false;

  for (let above = path; ; above = dirname(above)) {
    const candidate = join(folder, relative(above, path));
    let real: string | undefined;

    try {
      real = realpathSync.native(candidate);
    } catch {
      // Not there under these names.
    }

    if (real !== undefined && isInside(real, folder) && fileId(real) === target) return true;

    if (dirname(above) === above) return false;
  }
}

/** Device and inode of a file, or undefined when it cannot be found. Inode numbers can exceed 2^53, hence bigint. */
export function fileId(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });

    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
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

  if (!fromEnv) return storedOwnerPassword(home);

  if (fromEnv.length < 16) throw new Error("环境变量 CLOUDDEV_BASE_PASSWORD 太短：Owner 密码至少需要 16 个字符。");

  return fromEnv;
}

/**
 * The password in auth.json, or undefined when there is no auth.json. An auth.json that is there but unusable is an
 * error, never a reason to make a new password: that would replace the one the owner knows without telling them.
 */
export function storedOwnerPassword(home: string): string | undefined {
  const path = ownerPasswordPath(home);
  const fix = "修好这个文件，或者在 B 的终端里运行 clouddev-base password --reset 生成新密码。";
  let stored: unknown;

  try {
    stored = readJson(path);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${fix}`);
  }

  if (stored === undefined) return undefined;

  const password = isPlainObject(stored) && typeof stored.ownerPassword === "string" ? stored.ownerPassword.trim() : "";

  if (!password) throw new Error(`${path} 里没有 Owner 密码（应该是 {"ownerPassword": "…"}）。\n${fix}`);

  if (password.length < 16) throw new Error(`${path} 里的 Owner 密码太短：至少需要 16 个字符。\n${fix}`);

  return password;
}

/** Make a new Owner password and save it in auth.json. */
export function newOwnerPassword(home: string): string {
  const ownerPassword = randomBytes(18).toString("base64url");
  writeJsonPrivate(ownerPasswordPath(home), { ownerPassword });

  return ownerPassword;
}

export function ensureOwnerPassword(home: string, reset = false): string {
  return (reset ? undefined : storedOwnerPassword(home)) ?? newOwnerPassword(home);
}

/**
 * Make the state folder 0700 and its files exactly 0600, best effort: files made by hand can be readable by everyone,
 * and one set to 000 cannot be read even by the server. Files that belong to another user (root, after a run under
 * sudo) are left alone: only that user can change them. Returns what was changed. The folder is left alone when it
 * is the home folder or above it.
 */
export function tightenStatePermissions(home: string): string[] {
  const changed: string[] = [];
  const change = (path: string, mode: number, needed: (stats: Stats) => boolean) => {
    try {
      if (!needed(statSync(path))) return;

      chmodSync(path, mode);
      changed.push(path);
    } catch {
      // Missing, or not ours to change.
    }
  };

  if (!isWithin(homedir(), home)) change(home, 0o700, (stats) => (stats.mode & 0o077) !== 0);

  for (const name of STATE_FILES) {
    change(join(home, name), 0o600, (stats) => stats.uid === process.getuid?.() && (stats.mode & 0o777) !== 0o600);
  }

  return changed;
}

export function readJson<T>(path: string): T | undefined {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;

    throw new Error(`无法读取 ${path}: ${(error as Error).message}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`无法解析 ${path}: ${(error as Error).message}`);
  }
}

/**
 * Read a state file the server can do without (oauth.json, workspaces.json). One that is broken, or does not hold
 * what `valid` expects, is moved aside to <name>.corrupt-<time> and the server starts without it: a power cut or a
 * slip while editing must not keep it from starting, which under launchd means a restart every 10 seconds that
 * nobody on the other computer can fix. One the server may not read is not broken, and is handled apart (see
 * setAsideUnreadable). `lost` tells the log what starting without it costs.
 */
export function readStateFile<T>(path: string, valid: (value: unknown) => value is T, lost: string): T | undefined {
  let text: string;

  try {
    text = readPermitted(path);
  } catch (error) {
    if (isMissing(error)) return undefined;

    const reason = (error as Error).message;

    return isDenied(error) ? setAsideUnreadable(path, reason, lost) : setAside(path, reason, lost);
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    return setAside(path, (error as Error).message, lost);
  }

  return valid(value) ? value : setAside(path, "内容的结构不对", lost);
}

/** Read a file. One of ours that may not be read (say, set to 000 by hand) gets its 0600 back and is read again. */
function readPermitted(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (!isDenied(error) || ownerOf(path) !== process.getuid?.()) throw error;

    try {
      chmodSync(path, 0o600);
    } catch {
      throw error;
    }

    const text = readFileSync(path, "utf8");
    console.error(`${path} 之前读不出来（${(error as Error).message}），已把它的权限改回 600。`);

    return text;
  }
}

function isDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  return code === "EACCES" || code === "EPERM";
}

/** The uid a file belongs to, or undefined when it cannot be told. */
function ownerOf(path: string): number | undefined {
  try {
    return statSync(path).uid;
  } catch {
    return undefined;
  }
}

/**
 * A state file the server may not read is not broken: most likely it belongs to root after a run under sudo, and
 * chown gives it back whole. It is moved aside all the same, or the next save would replace it, under a name that
 * says why, and the log says how to get it back.
 */
function setAsideUnreadable(path: string, reason: string, lost: string): undefined {
  const owner = ownerOf(path);
  const mine = owner !== undefined && owner === process.getuid?.();
  const why = owner === undefined
    ? ""
    : mine
      ? "权限改回 600 之后也一样，可能有 ACL 之类的限制（用 ls -le 查看）。"
      : owner === 0
        ? "它属于 root，不属于运行服务的用户：多半是用 sudo 运行过 clouddev-base。"
        : `它属于 uid ${owner}，不属于运行服务的用户。`;
  const aside = `${path}.unreadable-${timestamp()}`;

  try {
    renameSync(path, aside);
  } catch (error) {
    console.error(`${path} 没有读取权限（${reason}）。${why}也没能改名（${(error as Error).message}），服务用空的状态启动：${lost}。`);

    return undefined;
  }

  const getBack = owner === undefined || mine
    ? `修好权限后运行 mv "${aside}" "${path}"`
    : `运行 sudo chown "$USER" "${aside}" && mv "${aside}" "${path}"`;

  console.error(`${path} 没有读取权限（${reason}）。${why}已改名为 ${basename(aside)}，服务用空的状态启动：${lost}。
要找回它：${getBack}，然后马上重启服务（后台服务运行 clouddev-base service install，终端里的 serve 停掉后重新运行）。`);

  return undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function setAside(path: string, reason: string, lost: string): undefined {
  const aside = `${path}.corrupt-${timestamp()}`;

  try {
    renameSync(path, aside);
    console.error(`${path} 无法使用（${reason}），已改名为 ${basename(aside)} 留作备份，服务用空的状态启动：${lost}。`);
  } catch (error) {
    console.error(`${path} 无法使用（${reason}），也没能改名（${(error as Error).message}），服务用空的状态启动：${lost}。`);
  }

  return undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Atomically write a JSON file readable only by the current user, flushed to disk before it replaces the old one. */
export function writeJsonPrivate(path: string, value: unknown): void {
  const dir = dirname(resolve(path));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;

  try {
    const fd = openSync(temp, "w", 0o600);

    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      // Without this, a power cut soon after the rename can leave the file empty or cut short.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }

  chmodSync(path, 0o600);
  syncFolder(dir);
}

/** Flush a folder's entries to disk, so the rename above survives a power cut. Best effort. */
function syncFolder(dir: string): void {
  let fd: number | undefined;

  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not every system lets a folder be opened or flushed.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
