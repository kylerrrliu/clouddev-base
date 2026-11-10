import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  broadRootProblems,
  ensureOwnerPassword,
  homeDir,
  isWithin,
  loadConfig,
  loadOwnerPassword,
  localBaseUrl,
  readStateFile,
  storedAddresses,
  storedOwnerPassword,
  tightenStatePermissions,
  webUiUrl,
  writeJsonPrivate,
  writeStoredConfig,
} from "../src/config.ts";
import { captureStderr, tempDir } from "./helpers.ts";

// The state folder (CLOUDDEV_BASE_HOME) and the allowed roots are always separate folders here: a root that holds
// the state folder is refused.

const DATA_VOLUME = "/System/Volumes/Data";

/** macOS reaches the temporary folders under a second name, on the data volume. */
const noDataVolume = process.platform === "darwin" && existsSync(join(DATA_VOLUME, realpathSync(tmpdir()))) ? false : "needs macOS's data volume";

/** Root reads any file, whatever its mode. */
const runsAsRoot = process.getuid?.() === 0 ? "root reads any file" : false;

/** Accepts any JSON. */
const anything = (value: unknown): value is unknown => value !== undefined;

test("a blank CLOUDDEV_BASE_HOME counts as unset, as in the plist, instead of meaning the current folder", () => {
  const fallback = join(homedir(), ".clouddev-base");

  assert.equal(homeDir({}), fallback);
  assert.equal(homeDir({ CLOUDDEV_BASE_HOME: "" }), fallback);
  assert.equal(homeDir({ CLOUDDEV_BASE_HOME: "  " }), fallback);
  assert.equal(homeDir({ CLOUDDEV_BASE_HOME: " /srv/clouddev-state " }), "/srv/clouddev-state");
  assert.equal(homeDir({ CLOUDDEV_BASE_HOME: "~/state" }), join(homedir(), "state"));
});

test("a blank CLOUDDEV_BASE_PASSWORD counts as unset", async () => {
  const home = await tempDir();
  const stored = ensureOwnerPassword(home);

  assert.equal(loadOwnerPassword(home, {}), stored);
  assert.equal(loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "" }), stored);
  assert.equal(loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "   " }), stored);
  assert.equal(loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "from-the-environment-123" }), "from-the-environment-123");
  assert.throws(() => loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "too-short" }), /16/);
});

test("an unusable auth.json is an error that points to --reset, and is never replaced by a new password", async () => {
  const home = await tempDir();
  const authFile = join(home, "auth.json");

  assert.equal(storedOwnerPassword(home), undefined, "no auth.json yet");

  for (const content of ['{"ownerPassword": "abcdefghij', "", "[]", "{}", '{"ownerPassword": 42}', '{"ownerPassword": "short"}']) {
    await writeFile(authFile, content);

    assert.throws(() => storedOwnerPassword(home), /auth\.json[\s\S]*password --reset/, content);
    assert.throws(() => loadOwnerPassword(home, {}), /auth\.json/, content);
    assert.throws(() => ensureOwnerPassword(home), /auth\.json/, content);
    assert.equal(await readFile(authFile, "utf8"), content, "the file is left as it was");
  }

  // Only an explicit reset replaces it.
  const reset = ensureOwnerPassword(home, true);
  assert.equal(storedOwnerPassword(home), reset);
  assert.ok(reset.length >= 16);
});

test("no extra OAuth redirect hosts are allowed by default", async () => {
  const home = await tempDir();
  const root = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };

  writeStoredConfig(home, { allowedRoots: [root] });
  assert.deepEqual(loadConfig({}, env).allowedRedirectHosts, []);

  writeStoredConfig(home, { allowedRoots: [root], allowedRedirectHosts: ["example.com"] });
  assert.deepEqual(loadConfig({}, env).allowedRedirectHosts, ["example.com"]);
});

test("the WebUI port defaults to 7677, can be turned off, and must differ from the MCP port", async () => {
  const home = await tempDir();
  const root = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };

  writeStoredConfig(home, { allowedRoots: [root] });
  assert.equal(loadConfig({}, env).uiPort, 7677);
  assert.equal(loadConfig({ uiPort: 0 }, env).uiPort, 0);
  assert.equal(loadConfig({ port: 7677, uiPort: 0 }, env).port, 7677);
  assert.throws(() => loadConfig({ port: 8000, uiPort: 8000 }, env), /WebUI 端口不能和 MCP 端口相同/);

  writeStoredConfig(home, { allowedRoots: [root], uiPort: 9000 });
  assert.equal(loadConfig({}, env).uiPort, 9000);
});

test("MCP put on the default WebUI port moves the page next door instead of refusing to start", async () => {
  const home = await tempDir();
  const root = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };

  writeStoredConfig(home, { allowedRoots: [root], port: 7677 });
  assert.equal(loadConfig({}, env).uiPort, 7678);
  assert.equal(loadConfig({ port: 65_535, uiPort: undefined }, env).uiPort, 7677, "only a clash with the default moves it");
  assert.equal(loadConfig({ port: 7677 }, env).uiPort, 7678);

  writeStoredConfig(home, { allowedRoots: [root], port: 7677, uiPort: 7677 });
  assert.throws(() => loadConfig({}, env), /WebUI 端口不能和 MCP 端口相同/, "a clash someone chose is still refused");
});

test("local addresses: a wildcard host is reached over loopback, and the WebUI URL follows its port", () => {
  assert.equal(localBaseUrl("0.0.0.0", 7676), "http://127.0.0.1:7676");
  assert.equal(localBaseUrl("::", 7676), "http://127.0.0.1:7676");
  assert.equal(localBaseUrl("::1", 7676), "http://[::1]:7676");
  assert.equal(localBaseUrl("127.0.0.1", 8000), "http://127.0.0.1:8000");
  assert.equal(webUiUrl({ uiPort: 7677 }), "http://127.0.0.1:7677");
  assert.equal(webUiUrl({ uiPort: 0 }), undefined);
});

test("roots that hand the AI ~/.ssh or the Owner password are refused: /, the home folder, a folder above it, one holding the state folder", async () => {
  const env = { CLOUDDEV_BASE_HOME: await tempDir() };

  for (const root of ["/", homedir(), dirname(homedir()), `${homedir()}/work/..`]) {
    assert.throws(() => loadConfig({ roots: [root] }, env), (error: Error) => /家目录/.test(error.message) && /--allow-broad-roots/.test(error.message) && /~\/work/.test(error.message), root);
  }

  // The state folder need not exist yet, and a root can reach it through a symlink.
  const parent = await tempDir();
  const nested = { CLOUDDEV_BASE_HOME: join(parent, "state") };
  const link = join(await tempDir(), "link");
  await symlink(parent, link);

  const fine = await tempDir();

  for (const root of [parent, link]) {
    assert.throws(() => loadConfig({ roots: [fine, root] }, nested), /包含 clouddev-base 的配置目录/, root);
  }

  // On a case-insensitive disk (the macOS default) another spelling is the same folder.
  if (existsSync(parent.toUpperCase())) {
    assert.throws(() => loadConfig({ roots: [parent.toUpperCase()] }, nested), /配置目录/);
  }

  // A sibling of the state folder is fine.
  assert.deepEqual(loadConfig({ roots: [join(parent, "work")] }, nested).allowedRoots, [join(parent, "work")]);

  // The texts match what holds: no workspace may hold the state folder, so the Owner password is never one of the
  // files the AI reads without a prompt.
  assert.throws(() => loadConfig({ roots: ["/"] }, env), (error: Error) => /~\/\.ssh/.test(error.message) && !/读到[^\n]*Owner 密码/.test(error.message));
});

test("on macOS, /System and /System/Volumes hold the home folder and the state folder too, through the data volume", { skip: noDataVolume }, async () => {
  const parent = await tempDir();
  const state = join(parent, "state");
  await mkdir(state);

  for (const folder of ["/System", "/System/Volumes", DATA_VOLUME]) {
    assert.equal(isWithin(state, folder), true, folder);
    assert.equal(isWithin(join(parent, "not-yet"), folder), true, `${folder}: also a state folder not made yet`);
    assert.equal(isWithin(homedir(), folder), true, folder);
  }

  assert.equal(isWithin(state, "/System/Library"), false, "only the firmlinked folders have a second name");
  assert.equal(isWithin(join(DATA_VOLUME, await realpath(state), "auth.json"), state), true);
  assert.equal(isWithin(state, join(DATA_VOLUME, await realpath(parent))), true);
  assert.equal(isWithin(join(DATA_VOLUME, await realpath(parent), "state-sibling"), state), false);

  // So they are refused as allowed roots, saying how they hold it.
  const env = { CLOUDDEV_BASE_HOME: state };

  for (const root of ["/System", "/System/Volumes"]) {
    assert.throws(() => loadConfig({ roots: [root] }, env), (error: Error) => /包含家目录[^\n]*另一个名字/.test(error.message) && /--allow-broad-roots/.test(error.message), root);
  }

  assert.match(broadRootProblems(["/System"], state).join("\n"), /配置目录 \S+ 照样不开放/);
  assert.deepEqual(broadRootProblems(["/System/Library"], state), []);
});

test("on macOS, a root named on the data volume says under which name it holds the home folder", { skip: noDataVolume }, async () => {
  // The home folder is a temporary one, under the name the temporary folders have outside the data volume.
  const parent = await tempDir();
  const home = join(parent, "home");
  await mkdir(home);
  const onData = join(DATA_VOLUME, await realpath(parent));
  const state = await tempDir();
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    assert.equal(homedir(), home);
    // The home folder's own name is not inside such a root, so the message gives the one that is.
    const [problem] = broadRootProblems([onData], state);
    assert.ok(problem?.startsWith(`${onData} 包含家目录 ${home}（${join(onData, "home")} 是它的另一个名字）：`), problem);

    const [plain] = broadRootProblems([parent], state);
    assert.ok(plain?.startsWith(`${parent} 包含家目录 ${home}：`), plain);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("allowBroadRoots: true in config.json lets such roots through, but never a root inside the state folder", async () => {
  const home = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };

  writeStoredConfig(home, { allowedRoots: ["/", homedir()], allowBroadRoots: true });
  assert.deepEqual(loadConfig({}, env).allowedRoots, ["/", homedir()]);
  assert.throws(() => loadConfig({ allowBroadRoots: false }, env), /家目录/, "init checks what it is about to save");

  writeStoredConfig(home, { allowedRoots: [homedir()], allowBroadRoots: "true" as unknown as boolean });
  assert.throws(() => loadConfig({}, env), /家目录/, "only true counts");

  writeStoredConfig(home, { allowedRoots: [join(home, "projects")], allowBroadRoots: true });
  assert.throws(() => loadConfig({}, env), /在 clouddev-base 的配置目录 .* 里面/);

  writeStoredConfig(home, { allowedRoots: [home], allowBroadRoots: true });
  assert.throws(() => loadConfig({}, env), /就是 clouddev-base 的配置目录/);
});

test("isWithin sees through symlinks and other names for the same folder", async () => {
  const outer = await tempDir();
  const inner = join(outer, "inner");
  await mkdir(inner);
  const link = join(await tempDir(), "link");
  await symlink(inner, link);

  assert.equal(isWithin(join(inner, "missing", "file"), outer), true);
  assert.equal(isWithin(outer, inner), false);
  assert.equal(isWithin(join(link, "file"), outer), true);
  assert.equal(isWithin(outer, link), false);
  assert.equal(isWithin(inner, link), true);
  assert.equal(isWithin(link, inner), true);
  assert.equal(isWithin(`${outer}-sibling`, outer), false);

  // macOS reaches the home folder through a firmlink as well; realpath keeps that name, the file identity does not.
  const data = "/System/Volumes/Data";

  if (process.platform === "darwin" && existsSync(join(data, homedir()))) {
    assert.equal(isWithin(join(data, homedir(), ".clouddev-base"), homedir()), true);
    assert.equal(isWithin(join(homedir(), ".clouddev-base"), join(data, homedir())), true);
    assert.equal(isWithin(homedir(), data), true);
    assert.equal(isWithin(join(data, homedir()), join(homedir(), "work")), false);
  }
});

test("a broken config.json stops loadConfig, names the file and points to service status", async () => {
  const home = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };
  const configFile = join(home, "config.json");
  const root = await tempDir();

  for (const [content, problem] of [
    ['{"allowedRoots": ["/tmp/x"],}', /无法解析/],
    ["", /无法解析/],
    ["[]", /JSON 对象/],
    ['{"allowedRoots": "~/work"}', /allowedRoots/],
  ] as const) {
    await writeFile(configFile, content);
    assert.throws(() => loadConfig({ roots: [root] }, env), (error: Error) => problem.test(error.message) && error.message.includes(configFile) && /service status/.test(error.message), content);
  }
});

test("writeJsonPrivate replaces the file whole, readable only by its owner, and leaves no temporary file", async () => {
  const dir = await tempDir();
  const file = join(dir, "state.json");

  writeJsonPrivate(file, { a: 1 });
  writeJsonPrivate(file, { a: 2 });

  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { a: 2 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["state.json"]);

  // A write that fails (here the name is taken by a folder) removes its temporary file.
  const blocked = join(dir, "blocked.json");
  await mkdir(blocked);
  assert.throws(() => writeJsonPrivate(blocked, { a: 3 }));
  assert.deepEqual((await readdir(dir)).sort(), ["blocked.json", "state.json"]);
});

test("tightenStatePermissions makes the state folder 0700 and its files 0600, and nothing else", async () => {
  const home = await tempDir();
  await chmod(home, 0o755);

  for (const name of ["config.json", "auth.json", "notes.txt"]) await writeFile(join(home, name), "{}", { mode: 0o644 });

  writeJsonPrivate(join(home, "oauth.json"), {});

  assert.deepEqual(tightenStatePermissions(home).sort(), [home, join(home, "auth.json"), join(home, "config.json")].sort());
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, "config.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, "auth.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, "notes.txt"))).mode & 0o777, 0o644, "only the server's own files");
  assert.deepEqual(tightenStatePermissions(home), [], "nothing left to change");
  assert.deepEqual(tightenStatePermissions(join(home, "missing")), []);
});

test("tightenStatePermissions leaves the home folder's mode alone, and gives the state files exactly 0600 back", async () => {
  // CLOUDDEV_BASE_HOME is the home folder itself: 0700 there would lock other accounts out of it, Public included.
  const home = await tempDir();
  await chmod(home, 0o755);
  const files = ["config.json", "auth.json", "oauth.json", "workspaces.json"].map((name) => join(home, name));

  for (const file of files) await writeFile(file, "{}", { mode: 0o644 });

  // Unreadable even to their owner, the server included.
  await chmod(files[2]!, 0o000);
  await chmod(files[3]!, 0o400);

  const originalHome = process.env.HOME;
  let changed: string[];
  process.env.HOME = home;

  try {
    assert.equal(homedir(), home);
    changed = tightenStatePermissions(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }

  assert.equal((await stat(home)).mode & 0o777, 0o755, "the home folder keeps its mode");

  for (const file of files) assert.equal((await stat(file)).mode & 0o777, 0o600, file);

  assert.deepEqual(changed.sort(), [...files].sort());
});

test("a state file of ours that may not be read (mode 000) is not broken: it gets 0600 back and is read", { skip: runsAsRoot }, async () => {
  const dir = await tempDir();
  const file = join(dir, "workspaces.json");
  await writeFile(file, '{"ws_0123456789": "/some/where"}', { mode: 0o000 });

  let value: unknown;
  const logged = await captureStderr(() => (value = readStateFile(file, anything, "lost")));

  assert.deepEqual(value, { ws_0123456789: "/some/where" });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["workspaces.json"], "nothing moved aside");
  assert.match(logged.join("\n"), /权限改回 600/);
});

test("a state file that stays unreadable is moved aside as .unreadable-<time>, saying whose it is and how to get it back", { skip: process.platform !== "darwin" ? "needs macOS ACLs" : runsAsRoot }, async () => {
  // An ACL keeps a file unreadable whatever its mode: like a file of root's, which chmod cannot fix.
  const unreadable = async (dir: string) => {
    const file = join(dir, "oauth.json");
    await writeFile(file, '{"clients": {}, "tokens": {}}');
    execFileSync("/bin/chmod", ["+a", `user:${userInfo().username} deny read`, file]);

    return file;
  };

  const check = async (dir: string, logged: string[], fix: RegExp) => {
    const [aside, ...others] = await readdir(dir);
    assert.match(aside ?? "", /^oauth\.json\.unreadable-\d{4}-\d\d-\d\dT[\d-]+Z$/);
    assert.deepEqual(others, [], "nothing left under the old name for the next save to replace");
    assert.match(logged.join("\n"), /没有读取权限[\s\S]*重新授权/);
    assert.match(logged.join("\n"), fix);
    assert.ok(logged.join("\n").includes(`mv "${join(dir, aside!)}" "${join(dir, "oauth.json")}"`), logged.join("\n"));
  };

  // Ours: chmod does not help, so the log points at the ACL.
  const own = await tempDir();
  const ownFile = await unreadable(own);
  let value: unknown = "unset";
  let logged = await captureStderr(() => (value = readStateFile(ownFile, anything, "客户端要重新授权")));
  assert.equal(value, undefined);
  await check(own, logged, /ls -le/);

  // Someone else's (as this process sees it): not touched, and the log names its owner and sudo chown.
  const theirs = await tempDir();
  const theirFile = await unreadable(theirs);
  const realGetuid = process.getuid;
  process.getuid = () => 4_000_000;

  try {
    logged = await captureStderr(() => (value = readStateFile(theirFile, anything, "客户端要重新授权")));
  } finally {
    process.getuid = realGetuid;
  }

  assert.equal(value, undefined);
  await check(theirs, logged, new RegExp(`属于 uid ${process.getuid!()}[\\s\\S]*sudo chown "\\$USER"`));
});

test("storedAddresses says where the server listens also when loadConfig refuses the config, or cannot read it", async () => {
  const home = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };

  assert.deepEqual(storedAddresses(env), { host: "127.0.0.1", port: 7676, uiPort: 7677 }, "no config.json yet");

  writeStoredConfig(home, { port: 8100, uiPort: 0 });
  assert.throws(() => loadConfig({}, env), /没有配置允许访问的目录/);
  assert.deepEqual(storedAddresses(env), { host: "127.0.0.1", port: 8100, uiPort: 0 });

  writeStoredConfig(home, { host: "::1", port: 7677 });
  assert.deepEqual(storedAddresses(env), { host: "::1", port: 7677, uiPort: 7678 }, "the WebUI moves next door, as in loadConfig");

  await writeFile(join(home, "config.json"), '{"port": 8100,');
  assert.deepEqual(storedAddresses(env), { host: "127.0.0.1", port: 7676, uiPort: 7677 }, "a broken config.json: the defaults");
});
