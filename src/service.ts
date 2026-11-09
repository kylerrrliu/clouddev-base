import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.ts";
import { expandHome, isInside } from "./paths.ts";

/** launchd label of the background service (macOS). */
export const SERVICE_LABEL = "com.clouddev-base.serve";

/**
 * Set to SERVICE_LABEL in the service's environment. Commands Claude runs through the bash tool inherit it,
 * which is how `service install` and `service uninstall` notice that they run inside the service they replace.
 */
export const SERVICE_ENV_MARKER = "CLOUDDEV_BASE_SERVICE";

/** Set on the process that takes over from a `service` command run inside the service. */
const HANDED_OFF_MARKER = "CLOUDDEV_BASE_SERVICE_HANDOFF";

/** How long the taken-over process waits, so the bash call that started it can still return its output to Claude. */
const HANDOFF_DELAY_MS = 2000;

/**
 * Variables that `serve` in a terminal passes on to Claude's commands and that builds commonly need. launchd starts
 * jobs with an almost empty environment, so `service install` copies these into the plist when they are set.
 * More names can be listed in config.json as `serviceEnv`.
 */
export const DEFAULT_SERVICE_ENV = [
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "GOPATH",
  "GOROOT",
  "GOPROXY",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

/** Never written into the plist, even when listed in serviceEnv. */
const NEVER_CARRIED = new Set(["CLOUDDEV_BASE_PASSWORD", HANDED_OFF_MARKER]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ServiceDefinition {
  label: string;
  plistPath: string;
  logPath: string;
  programArguments: string[];
  environment: Record<string, string>;
  workingDirectory: string;
}

export interface ServiceInputs {
  home: string;
  /** The node binary running this CLI (process.execPath). */
  nodePath: string;
  /** This CLI's entry file. */
  cliPath: string;
  env: NodeJS.ProcessEnv;
}

interface FileSystem {
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
}

/** Where the plist and the log of the service live. */
export function servicePaths(home: string): { plistPath: string; logPath: string } {
  return {
    plistPath: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    logPath: join(home, "Library", "Logs", "clouddev-base.log"),
  };
}

/**
 * A node path launchd can keep using after node is upgraded. process.execPath is already the real binary
 * (symlinks resolved), such as fnm's …/node-versions/v24.16.0/installation/bin/node or Homebrew's
 * …/Cellar/node/24.1.0/bin/node, and both disappear once that version is removed. When the version manager
 * keeps a stable link to the same binary, that link is used instead: fnm's `default` alias, Homebrew's
 * opt/<formula>. Otherwise (nvm, the official installer, …) the real binary is kept.
 */
export function stableNodePath(execPath: string, env: NodeJS.ProcessEnv, fs: FileSystem = { existsSync, realpathSync }): string {
  let real = execPath;

  try {
    real = fs.realpathSync(execPath);
  } catch {
    // Keep the path as given.
  }

  for (const candidate of stableNodeCandidates(real, env)) {
    try {
      if (fs.existsSync(candidate) && fs.realpathSync(candidate) === real) return candidate;
    } catch {
      // A broken link: try the next one.
    }
  }

  return real;
}

function stableNodeCandidates(real: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  // fnm: <FNM_DIR>/node-versions/<version>/installation/bin/node
  const fnm = /^(.*)\/node-versions\/[^/]+\/installation\/bin\/node$/.exec(real);

  if (fnm) {
    for (const fnmDir of [fnm[1]!, env.FNM_DIR]) {
      if (fnmDir) candidates.push(join(fnmDir, "aliases", "default", "bin", "node"));
    }
  }

  // Homebrew: <prefix>/Cellar/<formula>/<version>/bin/node, linked from <prefix>/opt/<formula>.
  const brew = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(real);

  if (brew) candidates.push(join(brew[1]!, "opt", brew[2]!, "bin", "node"));

  return [...new Set(candidates)];
}

/**
 * PATH for the service. launchd starts jobs with only /usr/bin:/bin:/usr/sbin:/sbin, and the bash tool
 * passes the server's environment on, so without this `npm test` would fail with "command not found".
 * Node's own folder comes first, then the PATH of the shell running the install, minus fnm's temporary
 * entries, then the system folders.
 */
export function servicePath(nodePath: string, currentPath = ""): string {
  const entries = [dirname(nodePath), ...currentPath.split(":"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const seen = new Set<string>();

  return entries.filter((entry) => {
    if (!entry.startsWith("/") || /[\\/]fnm_multishells[\\/]/.test(entry) || seen.has(entry)) return false;

    seen.add(entry);

    return true;
  }).join(":");
}

function guardedFolders(home: string): string[] {
  return ["Desktop", "Documents", "Downloads", join("Library", "Mobile Documents")].map((dir) => join(home, dir));
}

/**
 * Whether a path lies in a folder macOS guards with privacy prompts (TCC). A process started by launchd
 * does not inherit the access Terminal was given, and gets a prompt of its own that nobody may be there to answer.
 */
export function inGuardedFolder(path: string, home: string): boolean {
  return isInside(path, "/Volumes") || guardedFolders(home).some((dir) => isInside(path, dir));
}

/** Allowed roots that are, or contain, folders macOS guards with privacy prompts. */
export function guardedRoots(roots: string[], home: string): string[] {
  return roots.filter((root) => inGuardedFolder(root, home) || guardedFolders(home).some((dir) => isInside(dir, root)));
}

/**
 * What the service itself has to read at every start that lies in a guarded folder: its own code (with its
 * node_modules), the config folder and node. Unlike a guarded root, any of these keeps the service from starting.
 */
export function guardedServiceFiles(service: ServiceDefinition, configHome: string, home: string): Array<{ what: string; path: string }> {
  const [node, entry] = service.programArguments;
  const found: Array<{ what: string; path: string }> = [];
  const check = (what: string, path: string) => {
    const paths = [path, realpath(path)];

    if (paths.some((candidate) => inGuardedFolder(candidate, home))) found.push({ what, path: realpath(path) });
  };

  check("clouddev-base 的代码", resolve(dirname(entry!), ".."));
  check("配置目录", configHome);
  check("node", node!);

  return found;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The service environment: PATH, LANG, the variables builds commonly need, and `extraEnv` (config.json serviceEnv). */
export function defineService({ home, nodePath, cliPath, env }: ServiceInputs, extraEnv: string[] = []): ServiceDefinition {
  const node = stableNodePath(nodePath, env);
  const environment: Record<string, string> = {
    PATH: servicePath(node, env.PATH),
    LANG: env.LANG && /utf-?8/i.test(env.LANG) ? env.LANG : "en_US.UTF-8",
    [SERVICE_ENV_MARKER]: SERVICE_LABEL,
  };

  // Where the configuration lives and the logging choice carry over. The Owner password never goes into the plist.
  if (env.CLOUDDEV_BASE_HOME) environment.CLOUDDEV_BASE_HOME = resolve(expandHome(env.CLOUDDEV_BASE_HOME));
  if (env.CLOUDDEV_BASE_LOG_COMMANDS) environment.CLOUDDEV_BASE_LOG_COMMANDS = env.CLOUDDEV_BASE_LOG_COMMANDS;

  for (const name of [...DEFAULT_SERVICE_ENV, ...extraEnv]) {
    const value = env[name];

    if (ENV_NAME.test(name) && !NEVER_CARRIED.has(name) && !(name in environment) && value) environment[name] = value;
  }

  return {
    label: SERVICE_LABEL,
    ...servicePaths(home),
    programArguments: [node, builtCli(cliPath), "serve"],
    environment,
    workingDirectory: home,
  };
}

/** Run the compiled CLI when it exists: started from src/cli.ts, the service would depend on the sources. */
function builtCli(cliPath: string): string {
  if (!cliPath.endsWith(join("src", "cli.ts"))) return cliPath;

  const built = join(dirname(cliPath), "..", "dist", "cli.js");

  return existsSync(built) ? resolve(built) : cliPath;
}

export function renderPlist(service: ServiceDefinition): string {
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;
  const args = service.programArguments.map((arg) => `\t\t${string(arg)}`).join("\n");
  const env = Object.entries(service.environment).map(([name, value]) => `\t\t<key>${escapeXml(name)}</key>\n\t\t${string(value)}`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 由 clouddev-base service install 生成。改设置请用 clouddev-base init，然后重新运行 service install。 -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${string(service.label)}
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<!-- launchd 只给最基本的环境；bash 工具继承这里的环境，所以要带上 node、npm、git 等所在的目录和常用的开发变量 -->
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>WorkingDirectory</key>
\t${string(service.workingDirectory)}
\t<!-- 登录后启动；无论因为什么退出，都由 launchd 重新拉起（两次启动至少间隔 10 秒） -->
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<!-- 不让 macOS 给后台任务限速：Claude 在这里跑的编译和测试按正常速度执行 -->
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t${string(service.logPath)}
\t<key>StandardErrorPath</key>
\t${string(service.logPath)}
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/**
 * Whether this process runs inside the background service, typically `service install` run by Claude through the
 * bash tool. Stopping the service would then kill this process half-way: the server ends the bash call and kills
 * its whole process group, before the new job is loaded.
 */
export function insideService(env: NodeJS.ProcessEnv): boolean {
  return env[SERVICE_ENV_MARKER] === SERVICE_LABEL && env[HANDED_OFF_MARKER] !== "1";
}

/** Run the same `service` command again in a session of its own, which stopping the service does not kill. */
function handOff(action: "install" | "uninstall", inputs: ServiceInputs): void {
  const { logPath } = servicePaths(inputs.home);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");

  try {
    spawn(process.execPath, [...process.execArgv, inputs.cliPath, "service", action], {
      cwd: inputs.home,
      env: { ...inputs.env, [HANDED_OFF_MARKER]: "1" },
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
  } finally {
    closeSync(log);
  }
}

async function waitIfHandedOff(env: NodeJS.ProcessEnv, action: string): Promise<void> {
  if (env[HANDED_OFF_MARKER] !== "1") return;

  await delay(HANDOFF_DELAY_MS);
  console.log(`${new Date().toISOString()} 接手在服务内部运行的 clouddev-base service ${action}`);
}

export interface InstallOptions {
  /** Only print the plist; change nothing. */
  print?: boolean;
}

export async function installService(config: Config, inputs: ServiceInputs, options: InstallOptions = {}): Promise<void> {
  const service = defineService(inputs, config.serviceEnv);
  const plist = renderPlist(service);

  if (options.print) {
    console.log(plist);

    return;
  }

  requireLaunchd();

  const guardedFiles = guardedServiceFiles(service, config.homeDir, inputs.home);
  printInstallNotes(config, inputs, service, guardedFiles);

  if (insideService(inputs.env)) {
    handOff("install", inputs);
    console.log(`这条命令是在后台服务内部运行的（比如经 Claude 的 bash 工具）。直接重装的话，服务一停，这条命令也会被一起结束，新服务就装不上了。
所以改由一个独立的进程完成：约 ${HANDOFF_DELAY_MS / 1000} 秒后它会用新的配置重启服务，期间 MCP 连接会断开几秒，之后自动恢复。
结果写在 ${service.logPath}，稍后可以运行 clouddev-base service status 查看。`);

    return;
  }

  await waitIfHandedOff(inputs.env, "install");

  mkdirSync(dirname(service.plistPath), { recursive: true });
  mkdirSync(dirname(service.logPath), { recursive: true });
  writeFileSync(service.plistPath, plist);
  // launchd refuses plists that others can write.
  chmodSync(service.plistPath, 0o644);

  await unload();

  // Checked once the old job is gone: whatever still answers on the port is not ours.
  const squatter = await probe(config);

  if (squatter) {
    console.error(`注意: ${localUrl(config)} 上已经有另一个 clouddev-base 在运行${squatter.pid ? `（pid ${squatter.pid}）` : ""}，可能是在终端里手动启动的 clouddev-base serve。
      先停掉它，后台服务才能用这个端口；在那之前后台服务每 10 秒重试一次。`);
  }

  launchctl("enable", target());
  const loaded = launchctl("bootstrap", domain(), service.plistPath);

  if (loaded.status !== 0) {
    throw new Error(`launchd 没能加载 ${service.plistPath}:
${loaded.output}
如果你在 系统设置 → 通用 → 登录项与扩展 里关掉过 clouddev-base 的后台运行，先打开它再重试。`);
  }

  // Up means: the job launchd runs is the one answering on the port, not some other server.
  const up = await waitFor(async () => {
    const pid = jobPid();

    return pid !== undefined && (await probe(config))?.pid === pid;
  }, 15_000);
  const ui = config.uiPort ? `http://127.0.0.1:${config.uiPort}` : "已关闭";
  const status = up
    ? "后台服务已启动"
    : squatter
      ? "后台服务已安装，但端口被上面提到的另一个 clouddev-base 占着，它起不来。停掉那个进程后，后台服务会自动接管"
      : guardedFiles.length
        ? "后台服务已安装，但 15 秒内没有响应。很可能是上面提到的受保护目录：看看 B 的屏幕上有没有授权弹窗，再看日志"
        : "后台服务已安装，但 15 秒内没有响应，看看日志里的错误";

  console.log(`${status}：登录后自动运行，退出后由 launchd 自动重启。
  配置:   ${service.plistPath}
  日志:   ${service.logPath}
  node:   ${service.programArguments[0]}
  MCP:    ${new URL("/mcp", config.publicUrl).href}
  WebUI:  ${ui}
查看状态: clouddev-base service status
重启:     launchctl kickstart -k ${target()}
卸载:     clouddev-base service uninstall
改了配置（clouddev-base init …）、换了 node 的安装方式，或者想更新 PATH 等环境变量时，重新运行 clouddev-base service install（经 Claude 在 B 上运行也可以）。`);
}

function printInstallNotes(config: Config, inputs: ServiceInputs, service: ServiceDefinition, guardedFiles: Array<{ what: string; path: string }>): void {
  for (const root of guardedRoots(config.allowedRoots, inputs.home)) {
    console.error(`注意: ${root} 是（或包含）macOS 的受保护目录（桌面、文稿、下载、iCloud、外接磁盘）。后台服务访问它时 macOS 会弹出授权窗口，没人点就会失败。
      建议把项目放到 ~/work 这类目录；或者在 系统设置 → 隐私与安全性 → 完全磁盘访问 里加入 ${service.programArguments[0]}。`);
  }

  for (const { what, path } of guardedFiles) {
    console.error(`注意: 后台服务每次启动都要读取${what}（${path}），它在 macOS 的受保护目录里（桌面、文稿、下载、iCloud 或外接磁盘）。
      launchd 启动的 node 没有终端那样的访问权限：B 的屏幕上会弹出授权窗口，没人点“允许”，服务就起不来（日志里是 EPERM，或者什么都没有）。
      最好把它移到 ~/work 这类目录（移动代码的话，在新位置重新运行 npm install 和 service install）；
      或者现在留意 B 屏幕上的弹窗并点“允许”，也可以在 系统设置 → 隐私与安全性 → 完全磁盘访问 里加入 ${service.programArguments[0]}。`);
  }

  if (inputs.env.CLOUDDEV_BASE_PASSWORD?.trim()) {
    console.error(`注意: 当前终端设置了 CLOUDDEV_BASE_PASSWORD，但 Owner 密码不会写进 plist。后台服务授权时用的是 ${join(config.homeDir, "auth.json")} 里的密码；
      在没设这个变量的终端里运行 clouddev-base password 可以看到它。`);
  }

  const invalid = config.serviceEnv.filter((name) => !ENV_NAME.test(name) || NEVER_CARRIED.has(name));

  if (invalid.length) console.error(`注意: config.json 的 serviceEnv 里这些名字不会带进后台服务: ${invalid.join(", ")}`);

  const carried = Object.keys(service.environment).filter((name) => name !== SERVICE_ENV_MARKER);
  console.log(`带进后台服务的环境变量: ${carried.join(", ")}
  其他变量不会带过去。要带别的变量，把变量名加进 ${join(config.homeDir, "config.json")} 的 "serviceEnv" 列表，再重新运行 service install。`);
}

export async function uninstallService(inputs: ServiceInputs): Promise<void> {
  requireLaunchd();

  const { plistPath, logPath } = servicePaths(inputs.home);

  if (insideService(inputs.env)) {
    handOff("uninstall", inputs);
    console.log(`这条命令是在后台服务内部运行的（比如经 Claude 的 bash 工具），所以改由一个独立的进程完成：约 ${HANDOFF_DELAY_MS / 1000} 秒后它会停止并移除后台服务。
之后这台电脑上的 MCP 服务就停了，另一台电脑上的 Claude Code 会连不上，直到有人在这台电脑上重新运行 clouddev-base service install 或 serve。
结果写在 ${logPath}。`);

    return;
  }

  await waitIfHandedOff(inputs.env, "uninstall");

  // The file goes first: even if this process is stopped half-way, launchd will not start the service again at login.
  const hadFile = existsSync(plistPath);
  rmSync(plistPath, { force: true });
  const wasLoaded = await unload();

  console.log(wasLoaded || hadFile ? `已停止并移除后台服务（${plistPath}）。` : "没有安装后台服务。");
}

export async function serviceStatus(config: Config, home: string): Promise<void> {
  requireLaunchd();

  const printed = launchctl("print", target());
  const answer = await probe(config);
  const { logPath } = servicePaths(home);

  if (printed.status !== 0) {
    console.log(`后台服务没有安装或没有加载（${target()}）。安装: clouddev-base service install
服务${answer ? `正在 ${localUrl(config)} 上运行（不是由 launchd 启动的${answer.pid ? `，pid ${answer.pid}` : ""}）` : "没有在运行"}。`);

    return;
  }

  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(printed.output)?.[1]?.trim();
  const pid = pidOf(printed.output);
  const health = !answer
    ? "无响应"
    : answer.pid === undefined
      ? "有响应（对方没有报告 pid，无法确认是不是这个后台服务）"
      : answer.pid === pid
        ? "正常"
        : `端口上是另一个 clouddev-base（pid ${answer.pid}），不是这个后台服务`;

  console.log(`后台服务: ${target()}
  状态:         ${field("state") ?? "未知"}${pid !== undefined ? `（pid ${pid}）` : ""}
  上次退出码:   ${field("last exit code") ?? "未知"}
  健康检查:     ${health}（${localUrl(config)}/healthz）
  WebUI:        ${config.uiPort ? `http://127.0.0.1:${config.uiPort}` : "已关闭"}
  日志:         ${logPath}`);
}

function requireLaunchd(): void {
  if (process.platform !== "darwin") {
    throw new Error("service 命令只支持 macOS（launchd）。Linux 可以用 systemd --user 单元，见 README。");
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function target(): string {
  return `${domain()}/${SERVICE_LABEL}`;
}

function launchctl(...args: string[]): { status: number; output: string } {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });

  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** The pid launchd reports for the running job, from `launchctl print`. */
function pidOf(printed: string): number | undefined {
  const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(printed)?.[1]);

  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function jobPid(): number | undefined {
  const printed = launchctl("print", target());

  return printed.status === 0 ? pidOf(printed.output) : undefined;
}

/** Stop the service if it is loaded and wait until launchd has let go of it. Returns whether it was loaded. */
async function unload(): Promise<boolean> {
  if (launchctl("print", target()).status !== 0) return false;

  launchctl("bootout", target());
  await waitFor(async () => launchctl("print", target()).status !== 0, 5000);

  return true;
}

function localUrl(config: Config): string {
  const host = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host.includes(":") ? `[${config.host}]` : config.host;

  return `http://${host}:${config.port}`;
}

/** The clouddev-base answering on the configured port, with its pid; undefined when none answers. */
async function probe(config: Config): Promise<{ pid?: number } | undefined> {
  try {
    const response = await fetch(`${localUrl(config)}/healthz`, { signal: AbortSignal.timeout(2000) });

    if (!response.ok) return undefined;

    const body = (await response.json()) as { name?: unknown; pid?: unknown };

    return body.name === "clouddev-base" ? { pid: typeof body.pid === "number" ? body.pid : undefined } : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(250);
  }

  return check();
}
