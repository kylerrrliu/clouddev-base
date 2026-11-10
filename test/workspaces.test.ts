import assert from "node:assert/strict";
import { existsSync, promises, realpathSync, type PathLike, type StatOptions } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { AccessDeniedError, isInside, resolveInside } from "../src/paths.ts";
import { StateFolder, WorkspaceRegistry } from "../src/workspaces.ts";
import { captureStderr, tempDir, writeTree } from "./helpers.ts";

const DATA_VOLUME = "/System/Volumes/Data";

/** macOS reaches the temporary folders under a second name, on the data volume. */
const noDataVolume = process.platform === "darwin" && existsSync(join(DATA_VOLUME, realpathSync(tmpdir()))) ? false : "needs macOS's data volume";

test("isInside handles siblings and names that start with dots", () => {
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b/c", "/a/b"), true);
  assert.equal(isInside("/a/b/..c", "/a/b"), true);
  assert.equal(isInside("/a/bc", "/a/b"), false);
  assert.equal(isInside("/a", "/a/b"), false);
});

test("resolveInside blocks traversal and symlink escapes", async () => {
  const root = await tempDir();
  const outside = await tempDir();
  const canonicalRoot = await realpath(root);
  await writeTree(root, { "src/a.txt": "a" });
  await writeTree(outside, { "secret.txt": "secret" });
  await symlink(outside, join(root, "escape"));
  await symlink(join(root, "src"), join(root, "inner"));

  assert.equal(await resolveInside(root, canonicalRoot, "src/a.txt"), join(canonicalRoot, "src/a.txt"));
  assert.equal(await resolveInside(root, canonicalRoot, "new/dir/file.txt"), join(canonicalRoot, "new/dir/file.txt"));
  assert.equal(await resolveInside(root, canonicalRoot, "inner/a.txt"), join(canonicalRoot, "src/a.txt"));

  for (const path of ["../x", "/etc/passwd", "escape/secret.txt", "escape/new.txt", "src/../../x"]) {
    await assert.rejects(resolveInside(root, canonicalRoot, path), AccessDeniedError, path);
  }
});

test("workspaces open only inside allowed roots and keep stable ids", async () => {
  const allowed = await tempDir();
  const elsewhere = await tempDir();
  const state = await tempDir();
  await mkdir(join(allowed, "project"));

  const registry = new WorkspaceRegistry([allowed], state);
  const workspace = await registry.open(join(allowed, "project"));

  assert.match(workspace.id, /^ws_[0-9a-f]{10}$/);
  assert.equal((await registry.open("project")).id, workspace.id, "relative paths resolve against the first root");
  assert.equal((await registry.get(workspace.id)).root, join(allowed, "project"));

  await assert.rejects(registry.open(elsewhere), /outside the allowed roots/);
  await assert.rejects(registry.open(join(allowed, "..")), /outside the allowed roots/);
  await assert.rejects(registry.open(join(allowed, "missing")), /does not exist/);
  await assert.rejects(registry.get("ws_unknown"), /Unknown workspace_id/);

  const created = await registry.open(join(allowed, "new-project"), true);
  assert.equal(created.root, join(allowed, "new-project"));

  // A restarted server still knows the ids it handed out.
  const restarted = new WorkspaceRegistry([allowed], state);
  assert.equal((await restarted.get(workspace.id)).root, join(allowed, "project"));

  // ...unless the folder is no longer inside the allowed roots.
  const narrowed = new WorkspaceRegistry([join(allowed, "new-project")], state);
  await assert.rejects(narrowed.get(workspace.id), /outside the allowed roots/);
});

test("no workspace holds the state folder or lies inside it, whatever the allowed roots let through", async () => {
  // As with allowBroadRoots: the allowed root holds the state folder.
  const parent = await tempDir();
  const state = join(parent, ".clouddev-base");
  await writeTree(parent, { ".clouddev-base/auth.json": '{"ownerPassword": "a-password-of-24-chars!"}', ".clouddev-base/logs/x": "", "project/a.txt": "a" });
  const registry = new WorkspaceRegistry([parent], state);

  await assert.rejects(registry.open(parent), /contains the clouddev-base state folder/);
  await assert.rejects(registry.open("."), /contains the clouddev-base state folder/);
  await assert.rejects(registry.open(state), /is the clouddev-base state folder/);
  await assert.rejects(registry.open(join(state, "logs")), /is inside the clouddev-base state folder/);
  await assert.rejects(registry.open(join(state, "sub"), true), /is inside the clouddev-base state folder/);
  assert.equal(existsSync(join(state, "sub")), false, "create=true made nothing in there");

  // Through symlinks that stay inside the allowed root, too.
  await symlink(state, join(parent, "shortcut"));
  await symlink(join(state, "logs"), join(parent, "logs"));
  await assert.rejects(registry.open(join(parent, "shortcut")), /is the clouddev-base state folder/);
  await assert.rejects(registry.open(join(parent, "logs")), /is inside the clouddev-base state folder/);

  const project = await registry.open(join(parent, "project"));
  assert.equal((await registry.get(project.id)).root, join(parent, "project"));
  await assert.rejects(registry.resolvePath(project, "../.clouddev-base/auth.json"), /outside the workspace/);

  // A workspace saved before (say, while the state folder lived elsewhere) is refused on its next use.
  await writeFile(join(state, "workspaces.json"), JSON.stringify({ ws_handmade0: parent }));
  await assert.rejects(new WorkspaceRegistry([parent], state).get("ws_handmade0"), /contains the clouddev-base state folder/);

  // resolvePath checks again, should a workspace ever reach the state folder.
  const whole = { id: "ws_whole", root: parent, canonicalRoot: await realpath(parent) };
  await assert.rejects(registry.resolvePath(whole, ".clouddev-base/auth.json"), AccessDeniedError);
  assert.equal(await registry.resolvePath(whole, "project/a.txt"), join(await realpath(parent), "project", "a.txt"));
});

// The checks below run on the state folder alone: no allowed root holds it.

test("the state folder is told by its device and inode too, under names that are not resolved", async () => {
  const parent = await tempDir();
  const state = join(parent, "state");
  await mkdir(state);
  const guard = new StateFolder(state);
  const links = await tempDir();
  await symlink(state, join(links, "to-state"));
  await symlink(parent, join(links, "to-parent"));

  const relation = (path: string) => guard.relationOf(path, path);

  assert.equal(await relation(state), "is");
  assert.equal(await relation(parent), "contains");
  assert.equal(await relation(join(state, "logs")), "is inside");
  assert.equal(await relation(join(parent, "state-sibling")), undefined);
  assert.equal(await relation(links), undefined);

  // Other names for the same folders, given here without resolving them: only the device and inode tell.
  assert.equal(await relation(join(links, "to-state")), "is");
  assert.equal(await relation(join(links, "to-parent")), "contains");
  assert.equal(await guard.contains(join(links, "to-state", "auth.json")), true);
  assert.equal(await guard.contains(join(links, "to-parent", "state-sibling", "a.txt")), false);
});

test("a state folder made after the server started is told by its identity as soon as it exists", async () => {
  const parent = await tempDir();
  const state = join(parent, "state");
  const guard = new StateFolder(state);
  const links = await tempDir();

  assert.equal(await guard.relationOf(state, state), "is", "by name before it exists");

  await mkdir(state);
  await symlink(state, join(links, "to-state"));

  assert.equal(await guard.contains(join(links, "to-state", "auth.json")), true);
});

test("a folder holds the state folder through a bind mount further down that shows a folder above it under its own name, but not through a symlink that leads out", async () => {
  // Linux bind mounts cannot be made here. Instead stat reports <base>/home's device and inode for <base>/mnt/home and
  // everything below it, as for a bind mount of <base>/home there; the folders under it are real ones, so realpath
  // leaves their names alone, as it does a bind mount's.
  const base = await realpath(await tempDir());
  await writeTree(base, { "home/you/state/auth.json": "{}", "mnt/home/you/state/auth.json": "{}", "mnt/other/a.txt": "a" });
  const guard = new StateFolder(join(base, "home", "you", "state"));
  const notYet = new StateFolder(join(base, "home", "you", "not-yet"));
  const mnt = join(base, "mnt");
  const mount = join(mnt, "home");
  const relation = (folder: StateFolder, path: string) => folder.relationOf(path, path);

  const realStat = promises.stat;
  const source = (path: PathLike) => (typeof path === "string" && isInside(path, mount) ? join(base, "home", relative(mount, path)) : path);
  promises.stat = ((path: PathLike, options?: StatOptions) => realStat(source(path), options)) as typeof promises.stat;
  syncBuiltinESMExports();

  try {
    assert.equal(await relation(guard, mnt), "contains");
    assert.equal(await relation(notYet, mnt), "contains", "also before the state folder exists");
    assert.equal(await relation(guard, mount), "contains", "the mount itself, by its device and inode");
    assert.equal(await relation(guard, join(mnt, "other")), undefined);
    assert.equal(await guard.contains(join(mount, "you", "state", "auth.json")), true);
  } finally {
    promises.stat = realStat;
    syncBuiltinESMExports();
  }

  // A symlink in its place leads out of the folder: resolveInside refuses what lies behind it.
  await rm(mount, { recursive: true });
  await symlink(join(base, "home"), mount);
  assert.equal(await relation(guard, mnt), undefined);
  assert.equal(await relation(notYet, mnt), undefined);
});

test("on macOS, the state folder's name on the data volume is the state folder, and /System holds it", { skip: noDataVolume }, async () => {
  const parent = await tempDir();
  const state = join(parent, "state");
  await mkdir(state);
  const guard = new StateFolder(state);
  const onData = join(DATA_VOLUME, await realpath(state));

  assert.equal(await guard.relationOf(onData, onData), "is");
  assert.equal(await guard.contains(join(onData, "auth.json")), true);
  assert.equal(await guard.contains(join(DATA_VOLUME, await realpath(parent), "state-sibling")), false);

  // With "/" allowed (allowBroadRoots), these folders must not become workspaces: grep and glob would walk into it.
  for (const folder of ["/System", "/System/Volumes", DATA_VOLUME]) assert.equal(await guard.relationOf(folder, folder), "contains", folder);

  assert.equal(await guard.relationOf("/System/Library", "/System/Library"), undefined);

  // Also before the state folder exists.
  const notYet = new StateFolder(join(parent, "not-yet"));
  assert.equal(await notYet.relationOf("/System", "/System"), "contains");
  assert.equal(await notYet.contains(join(DATA_VOLUME, await realpath(parent), "not-yet", "auth.json")), true);
});

test("a broken workspaces.json is moved aside and the registry starts empty", async () => {
  const allowed = await tempDir();
  await mkdir(join(allowed, "project"));

  for (const content of ["", '{"ws_0123456789": "/some/where', "null", "[]", '{"ws_0123456789": 42}', '{"ws_0123456789": "relative/path"}']) {
    const state = await tempDir();
    await writeFile(join(state, "workspaces.json"), content);

    let registry: WorkspaceRegistry | undefined;
    const logged = await captureStderr(() => (registry = new WorkspaceRegistry([allowed], state)));

    assert.match(logged.join("\n"), /workspaces\.json[\s\S]*open_workspace/, content);
    const [aside, ...others] = (await readdir(state)).filter((name) => name.startsWith("workspaces.json"));
    assert.match(aside ?? "", /^workspaces\.json\.corrupt-\d{4}-\d\d-\d\dT[\d-]+Z$/, content);
    assert.deepEqual(others, [], "the broken file is gone");
    assert.equal(await readFile(join(state, aside!), "utf8"), content, "and kept as it was");

    await assert.rejects(registry!.get("ws_0123456789"), /Unknown workspace_id/);
    const workspace = await registry!.open("project");
    assert.deepEqual(JSON.parse(await readFile(join(state, "workspaces.json"), "utf8")), { [workspace.id]: join(allowed, "project") });
  }
});
