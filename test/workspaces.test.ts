import assert from "node:assert/strict";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AccessDeniedError, isInside, resolveInside } from "../src/paths.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import { tempDir, writeTree } from "./helpers.ts";

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
