import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import {
  appendFile, chmod, chown, link, lstat, open, readdir, readFile, readlink, realpath, rename, stat, statfs, symlink, truncate, writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { resolveInside } from "../src/paths.ts";
import { MAX_BYTES, MAX_RESULT_CHARS } from "../src/tools/common.ts";
import { editPath, listDirectory, readPath, writePath } from "../src/tools/files.ts";
import { MAX_FREE_SPACE_RESERVE, freeSpaceReserve, replaceFile } from "../src/tools/replace-file.ts";
import { runCommand } from "../src/tools/shell.ts";
import { resultText, tempDir, writeTree } from "./helpers.ts";

const windows = process.platform === "win32";
const darwin = process.platform === "darwin";
const isRoot = process.getuid?.() === 0;

/** What a call settled with: its error, "ok", or "timeout" when it was still pending after `ms`. */
async function settleWithin(ms: number, promise: Promise<unknown>): Promise<Error | "ok" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));

  try {
    return await Promise.race([promise.then(() => "ok" as const, (error: Error) => error), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Open and close both ends of a FIFO, which releases any open() still waiting on it, so a failing test cannot hang. */
function releaseFifo(path: string): void {
  try {
    closeSync(openSync(path, constants.O_RDWR | constants.O_NONBLOCK));
  } catch {
    // Gone or not a FIFO: nothing waits on it.
  }
}

function lonelySurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

test("read, write and edit refuse a named pipe at once instead of blocking on it", { skip: windows && "no FIFOs" }, async () => {
  const dir = await tempDir();
  const fifo = join(dir, "pipe.log");
  const imageFifo = join(dir, "pipe.png");
  execFileSync("mkfifo", [fifo, imageFifo]);

  const calls: Array<[string, () => Promise<unknown>, RegExp]> = [
    ["read", () => readPath(fifo, "pipe.log"), /^pipe\.log is a named pipe \(FIFO\), not a regular file\.$/],
    ["read of an image name", () => readPath(imageFifo, "pipe.png"), /^pipe\.png is a named pipe \(FIFO\), not a regular file\.$/],
    ["write", () => writePath(fifo, "pipe.log", "x"), /^pipe\.log is a named pipe \(FIFO\), not a regular file\.$/],
    ["edit", () => editPath(fifo, "pipe.log", [{ old_text: "a", new_text: "b" }]), /^pipe\.log is a named pipe \(FIFO\), not a regular file\.$/],
  ];

  try {
    for (const [name, call, message] of calls) {
      const outcome = await settleWithin(1000, call());

      assert.notEqual(outcome, "timeout", `${name} blocked on the FIFO`);
      assert.ok(outcome instanceof Error, `${name} should fail`);
      assert.match(outcome.message, message);
    }
  } finally {
    releaseFifo(fifo);
    releaseFifo(imageFifo);
  }

  assert.ok((await lstat(fifo)).isFIFO(), "the FIFO is still there, not replaced by a file");
});

test("read, write and edit refuse a socket", { skip: windows && "no UNIX sockets in the file system" }, async () => {
  const dir = await tempDir();
  const socket = join(dir, "s.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  try {
    await assert.rejects(readPath(socket, "s.sock"), /^Error: s\.sock is a socket, not a regular file\.$/);
    await assert.rejects(writePath(socket, "s.sock", "x"), /^Error: s\.sock is a socket, not a regular file\.$/);
    await assert.rejects(editPath(socket, "s.sock", [{ old_text: "a", new_text: "b" }]), /^Error: s\.sock is a socket, not a regular file\.$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a write or edit that fails part way leaves the original file intact and no temporary file", { skip: windows && "needs ulimit" }, async () => {
  const dir = await tempDir();
  const data = Buffer.from("keep me\n".repeat(1024));
  const notes = Buffer.from(`first line\n${"keep me too\n".repeat(700)}`);
  await writeTree(dir, { "data.txt": data, "notes.txt": notes });

  // The tools run in a child under `ulimit -f`, so writing the 4MB content fails with EFBIG part way (Node ignores
  // SIGXFSZ, so the write call fails instead of the process dying). The originals are 8KB, well under the limit.
  const script = `
    import { join } from "node:path";
    const [filesUrl, dir] = process.argv.slice(1);
    const { editPath, writePath } = await import(filesUrl);
    const big = "x".repeat(4 * 1024 * 1024);
    const attempts = {
      write: () => writePath(join(dir, "data.txt"), "data.txt", big),
      edit: () => editPath(join(dir, "notes.txt"), "notes.txt", [{ old_text: "first line", new_text: big }]),
    };
    const outcome = {};
    for (const [name, attempt] of Object.entries(attempts)) {
      try {
        await attempt();
        outcome[name] = "succeeded";
      } catch (error) {
        outcome[name] = error.message;
      }
    }
    console.log(JSON.stringify(outcome));
  `;
  const filesUrl = new URL("../src/tools/files.ts", import.meta.url).href;
  const child = spawn(
    "/bin/sh",
    ["-c", 'ulimit -f 2048 && exec "$0" "$@"', process.execPath, "--input-type=module", "-e", script, filesUrl, dir],
    { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(killer);

  assert.equal(code, 0, stderr);
  const outcome = JSON.parse(stdout) as Record<string, string>;
  assert.equal(outcome.write, "Could not write data.txt (EFBIG: file too large). The original file is unchanged.");
  assert.equal(outcome.edit, "Could not write notes.txt (EFBIG: file too large). The original file is unchanged.");
  assert.deepEqual(await readFile(join(dir, "data.txt")), data);
  assert.deepEqual(await readFile(join(dir, "notes.txt")), notes);
  assert.deepEqual((await readdir(dir)).sort(), ["data.txt", "notes.txt"]);
});

test("write and edit keep the file's mode, and a new file gets the mode a plain write gives", { skip: windows && "no mode bits" }, async () => {
  const dir = await tempDir();
  const script = join(dir, "run.sh");
  await writeTree(dir, { "run.sh": "#!/bin/sh\necho one\n" });
  await chmod(script, 0o755);

  await writePath(script, "run.sh", "#!/bin/sh\necho two\n");
  assert.equal(await mode(script), 0o755);
  await editPath(script, "run.sh", [{ old_text: "two", new_text: "three" }]);
  assert.equal(await mode(script), 0o755);

  // Without the clone: the way other systems go, and macOS when cloning fails.
  await chmod(script, 0o750);
  await replaceFile(script, "#!/bin/sh\necho four\n", { displayPath: "run.sh", clone: false });
  assert.equal(await mode(script), 0o750);
  assert.equal(await readFile(script, "utf8"), "#!/bin/sh\necho four\n");

  // setuid is dropped, as an in-place write by its owner drops it too; the sticky bit stays.
  await chmod(script, 0o4755);
  await writePath(script, "run.sh", "#!/bin/sh\necho five\n");
  assert.equal(await mode(script), 0o755);
  await chmod(script, 0o1755);
  await replaceFile(script, "#!/bin/sh\necho six\n", { displayPath: "run.sh", clone: false });
  assert.equal(await mode(script), 0o1755);

  await writePath(join(dir, "new.txt"), "new.txt", "x");
  await writeFile(join(dir, "plain.txt"), "x");
  assert.equal(await mode(join(dir, "new.txt")), await mode(join(dir, "plain.txt")));
  assert.deepEqual((await readdir(dir)).sort(), ["new.txt", "plain.txt", "run.sh"], "no temporary files are left");
});

test("write and edit work on a file whose name is near the length limit", async () => {
  const dir = await tempDir();
  // 250 bytes: the temporary file next to it must not simply add to that (most file systems allow 255).
  const name = `${"é".repeat(60)}${"n".repeat(126)}.txt`;
  await writeTree(dir, { [name]: "one\n" });

  await writePath(join(dir, name), name, "two\n");
  await editPath(join(dir, name), name, [{ old_text: "two", new_text: "three" }]);
  assert.equal(await readFile(join(dir, name), "utf8"), "three\n");
  assert.deepEqual(await readdir(dir), [name]);
});

test("write and edit keep the file's group",{ skip: (windows || isRoot) && "needs a second group of this user" }, async () => {
  const dir = await tempDir();
  const file = join(dir, "shared.txt");
  await writeTree(dir, { "shared.txt": "one\n" });
  const other = process.getgroups!().find((gid) => gid !== process.getgid!());

  if (other === undefined) return;

  await chown(file, process.getuid!(), other);
  await writePath(file, "shared.txt", "two\n");
  assert.equal((await stat(file)).gid, other);
  await replaceFile(file, "three\n", { displayPath: "shared.txt", clone: false });
  assert.equal((await stat(file)).gid, other);
  assert.equal(await readFile(file, "utf8"), "three\n");
});

test("writing through a symlink in the workspace changes its target and leaves the link in place", { skip: windows && "symlinks need privileges" }, async () => {
  const dir = await realpath(await tempDir());
  await writeTree(dir, { "real.txt": "one\n" });
  await symlink("real.txt", join(dir, "link.txt"));

  // The tools get canonical paths, as resolveInside gives them.
  const target = await resolveInside(dir, dir, "link.txt");
  assert.equal(target, join(dir, "real.txt"));

  await writePath(target, "real.txt", "two\n");
  await editPath(target, "real.txt", [{ old_text: "two", new_text: "three" }]);

  assert.ok((await lstat(join(dir, "link.txt"))).isSymbolicLink());
  assert.equal(await readlink(join(dir, "link.txt")), "real.txt");
  assert.equal(await readFile(join(dir, "link.txt"), "utf8"), "three\n");
});

test("on macOS, extended attributes and ACLs survive write and edit", { skip: !darwin && "macOS only" }, async () => {
  const dir = await tempDir();
  const file = join(dir, "tagged.txt");
  await writeTree(dir, { "tagged.txt": "one\n" });
  execFileSync("/usr/bin/xattr", ["-w", "com.clouddev.test", "keep me", file]);
  execFileSync("/bin/chmod", ["+a", "everyone allow read", file]);
  const xattr = () => execFileSync("/usr/bin/xattr", ["-p", "com.clouddev.test", file], { encoding: "utf8" }).trim();
  const acl = () => execFileSync("/bin/ls", ["-led", file], { encoding: "utf8" }).split("\n").slice(1).join("\n");

  await writePath(file, "tagged.txt", "two\n");
  assert.equal(xattr(), "keep me");
  assert.match(acl(), /group:everyone allow read/);

  await editPath(file, "tagged.txt", [{ old_text: "two", new_text: "three" }]);
  assert.equal(xattr(), "keep me");
  assert.match(acl(), /group:everyone allow read/);
  assert.equal(await readFile(file, "utf8"), "three\n");
  assert.deepEqual(await readdir(dir), ["tagged.txt"]);
});

test("on macOS, a file whose ACL forbids deleting it is written in place, with no temporary file left", { skip: !darwin && "macOS only" }, async () => {
  const dir = await tempDir();
  const file = join(dir, "guarded.txt");
  await writeTree(dir, { "guarded.txt": "one\n" });
  execFileSync("/bin/chmod", ["+a", "everyone deny delete", file]);
  const inode = (await stat(file)).ino;

  try {
    // The clone carries the ACL along, so the rename and the clean-up of the clone both meet it.
    assert.equal(resultText(await writePath(file, "guarded.txt", "two\n")), "Overwrote guarded.txt (4B).");
    await editPath(file, "guarded.txt", [{ old_text: "two", new_text: "three" }]);
    assert.equal(await readFile(file, "utf8"), "three\n");
    assert.equal((await stat(file)).ino, inode);
    assert.deepEqual(await readdir(dir), ["guarded.txt"]);
  } finally {
    execFileSync("/bin/chmod", ["-R", "-N", dir]);
  }
});

test("on macOS, a write that could not clone the file says its extended attributes and ACL were not kept", { skip: (!darwin || isRoot) && "macOS, as a user who cannot read every file" }, async () => {
  const dir = await tempDir();
  const file = join(dir, "drop.txt");
  await writeTree(dir, { "drop.txt": "one\n" });
  // ditto cannot read a write-only file, so it cannot clone it.
  await chmod(file, 0o200);

  try {
    assert.equal(
      resultText(await writePath(file, "drop.txt", "two\n")),
      "Overwrote drop.txt (4B).\nNote: the extended attributes and ACL of drop.txt, if it had any, could not be carried over to the new file (copying them failed); its mode and group were kept.",
    );
    assert.equal(await mode(file), 0o200);
  } finally {
    await chmod(file, 0o600);
  }

  assert.equal(await readFile(file, "utf8"), "two\n");
  assert.deepEqual(await readdir(dir), ["drop.txt"], "no temporary file or folder is left");

  // Without cloning, as on other systems, nothing was tried, so there is nothing to say.
  assert.deepEqual(await replaceFile(file, "three\n", { displayPath: "drop.txt", clone: false }), { created: false, notes: [] });
});

test("on macOS, a clone that runs out of time leaves no partial copy behind", { skip: !darwin && "macOS only" }, async () => {
  const dir = await tempDir();
  const tools = await tempDir();
  const file = join(dir, "big.bin");
  await writeTree(dir, { "big.bin": "old\n" });
  // Stands in for ditto copying a big file to a disk that cannot clone: like ditto, it starts its partial copy next
  // to the destination, and it is still copying when its time is up (exec, so the time limit kills the sleep itself).
  // The marker beside the script shows that the partial copy was made before that.
  const slowDitto = join(tools, "slow-ditto");
  await writeTree(tools, { "slow-ditto": '#!/bin/sh\nprintf partial > "$(dirname "$3")/.BC.T_test" && : > "$0.started"\nexec sleep 30\n' });
  await chmod(slowDitto, 0o755);

  const startedAt = Date.now();
  const result = await replaceFile(file, "new\n", { displayPath: "big.bin", ditto: slowDitto, cloneTimeoutMs: 1_000 });

  assert.ok(Date.now() - startedAt < 5_000);
  assert.ok((await stat(`${slowDitto}.started`)).isFile(), "the stand-in made its partial copy");
  assert.deepEqual(result.notes, [
    "Note: the extended attributes and ACL of big.bin, if it had any, could not be carried over to the new file (copying them failed); its mode and group were kept.",
  ]);
  assert.equal(await readFile(file, "utf8"), "new\n");
  assert.deepEqual(await readdir(dir), ["big.bin"]);
});

test("on macOS, where a folder's ACL forbids deleting files, a write names what it left behind and later writes go in place", { skip: !darwin && "macOS only" }, async () => {
  // Set by hand, the entry often also passes itself on to the folders and files made inside: the clone's private
  // folder then forbids deleting the clone too, until its own ACL is cleared.
  for (const entry of ["everyone deny delete_child", "everyone deny delete_child,file_inherit,directory_inherit"]) {
    const dir = await tempDir();
    const locked = join(dir, "locked");
    const fresh = join(dir, "fresh");
    const file = join(locked, "a.txt");
    await writeTree(dir, { "locked/a.txt": "one\n", "fresh/.keep": "" });
    const inode = (await stat(file)).ino;
    execFileSync("/bin/chmod", ["+a", entry, locked, fresh]);

    try {
      // The clone's private folder could not be removed: it is left empty, without the new content.
      const first = resultText(await writePath(file, "locked/a.txt", "two\n"));
      const leftover = /^Overwrote locked\/a\.txt \(4B\)\.\nNote: locked\/(\.clouddev-\w+), a temporary folder of this write, could not be removed \(EACCES: permission denied\)\. Tell the user; later writes in that folder change files in place instead\.$/.exec(first);
      assert.ok(leftover, `${entry}: ${first}`);
      assert.deepEqual(await readdir(join(locked, leftover[1]!)), [], entry);

      assert.equal(resultText(await writePath(file, "locked/a.txt", "three\n")), "Overwrote locked/a.txt (6B).");
      assert.equal(resultText(await editPath(file, "locked/a.txt", [{ old_text: "three", new_text: "four" }])), "Edited locked/a.txt (+1 -1 lines).");
      assert.equal(resultText(await writePath(join(locked, "b.txt"), "locked/b.txt", "new\n")), "Created locked/b.txt (4B).");
      // Other programs change the folder too (a build writes its output there): the leftover is still there, so is the ACL.
      await writeFile(join(locked, "build.out"), "built\n");
      assert.equal(resultText(await writePath(file, "locked/a.txt", "five\n")), "Overwrote locked/a.txt (5B).");
      assert.equal(await readFile(file, "utf8"), "five\n");
      assert.equal((await stat(file)).ino, inode, "written in place");
      assert.deepEqual((await readdir(locked)).sort(), [leftover[1], "a.txt", "b.txt", "build.out"].sort(), "nothing more was left behind");

      // Once the user has removed the leftover, and the ACL with it, writes there go through a temporary file again.
      execFileSync("/bin/chmod", ["-R", "-N", locked]);
      execFileSync("/bin/rmdir", [join(locked, leftover[1]!)]);
      assert.equal(resultText(await writePath(file, "locked/a.txt", "six\n")), "Overwrote locked/a.txt (4B).");
      assert.notEqual((await stat(file)).ino, inode, "replaced, not written in place");
      assert.deepEqual((await readdir(locked)).sort(), ["a.txt", "b.txt", "build.out"]);

      // A new file goes through a plain temporary file, which is what stays then; the file is created all the same.
      const created = resultText(await writePath(join(fresh, "c.txt"), "fresh/c.txt", "x"));
      const temp = /^Created fresh\/c\.txt \(1B\)\.\nNote: fresh\/(\.c\.txt\.clouddev-[0-9a-f]+\.tmp), a temporary file of this write, could not be removed \(EACCES: permission denied\)\./.exec(created);
      assert.ok(temp, created);
      assert.equal(resultText(await writePath(join(fresh, "d.txt"), "fresh/d.txt", "y")), "Created fresh/d.txt (1B).");
      assert.deepEqual((await readdir(fresh)).sort(), [temp[1], ".keep", "c.txt", "d.txt"].sort());
      assert.equal(await readFile(join(fresh, "d.txt"), "utf8"), "y");
    } finally {
      execFileSync("/bin/chmod", ["-R", "-N", dir]);
    }
  }
});

test("cleaning up after a failed clone never follows a symbolic link put in place of its private folder", { skip: windows && "needs a shell script and symlinks" }, async () => {
  const tools = await tempDir();
  // Stands in for someone who can change the file's folder: while "ditto" runs, the private folder is moved away and
  // a symbolic link to another folder put in its place; then the clone fails.
  const swapDitto = join(tools, "swap-ditto");
  await writeTree(tools, {
    "swap-ditto": '#!/bin/sh\nfolder=$(dirname "$3")\nmv "$folder" "$folder.moved" && ln -s "$DECOY" "$folder" && [ -z "$LOCK" ] || /bin/chmod +a "everyone deny delete_child" "$LOCK"\nexit 1\n',
  });
  await chmod(swapDitto, 0o755);

  // Removing the link is allowed: rm removes the link, not what it leads to.
  // Not allowed (macOS: the folder's ACL), the path is no longer the folder made: nothing there is touched, not even an ACL.
  for (const lock of darwin ? [false, true] : [false]) {
    const dir = await tempDir();
    const shared = join(dir, "shared");
    const decoy = join(dir, "decoy");
    const file = join(shared, "a.txt");
    await writeTree(dir, { "shared/a.txt": "one\n", "decoy/important.txt": "keep\n", "decoy/notes/b.txt": "keep\n" });
    // chmod -N, even with -R, would clear the ACL of the folder a symbolic link given to it leads to.
    if (darwin) execFileSync("/bin/chmod", ["+a", "everyone deny delete", decoy, join(decoy, "important.txt")]);
    process.env.DECOY = decoy;
    process.env.LOCK = lock ? shared : "";

    try {
      const { notes } = await replaceFile(file, "two\n", { displayPath: "shared/a.txt", clone: true, ditto: swapDitto });

      assert.equal(await readFile(file, "utf8"), "two\n");
      assert.deepEqual((await readdir(decoy)).sort(), ["important.txt", "notes"]);
      assert.equal(await readFile(join(decoy, "notes", "b.txt"), "utf8"), "keep\n");
      if (darwin) {
        for (const kept of [decoy, join(decoy, "important.txt")]) {
          assert.match(execFileSync("/bin/ls", ["-led", kept], { encoding: "utf8" }), /everyone deny delete/, `the ACL of ${kept} is kept`);
        }
      }

      const entries = (await readdir(shared)).sort();
      const moved = entries.find((name) => name.endsWith(".moved"));
      assert.ok(moved, entries.join(", "));
      const name = moved.slice(0, -".moved".length);

      if (lock) {
        // The link stays, named as what could not be removed.
        assert.deepEqual(entries, [name, moved, "a.txt"].sort());
        assert.ok((await lstat(join(shared, name))).isSymbolicLink());
        assert.match(notes[0]!, new RegExp(`^Note: shared/${name.replace(".", "\\.")}, a temporary folder of this write, could not be removed \\(EACCES: permission denied\\)\\.`));
      } else {
        assert.deepEqual(entries, [moved, "a.txt"].sort());
      }
    } finally {
      delete process.env.DECOY;
      delete process.env.LOCK;
      if (darwin) execFileSync("/bin/chmod", ["-R", "-N", dir]);
    }
  }
});

test("write and edit say when they break a hard link", { skip: windows && "hard links behave differently" }, async () => {
  const dir = await tempDir();
  const first = join(dir, "a.txt");
  await writeTree(dir, { "a.txt": "one\n" });
  await link(first, join(dir, "b.txt"));

  assert.equal(
    resultText(await writePath(first, "a.txt", "two\n")),
    "Overwrote a.txt (4B).\nNote: a.txt had 2 hard links; it is now a separate file, and its other names keep the old content.",
  );
  assert.equal(await readFile(join(dir, "b.txt"), "utf8"), "one\n");
  assert.equal(resultText(await writePath(first, "a.txt", "three\n")), "Overwrote a.txt (6B).");

  await link(first, join(dir, "c.txt"));
  assert.equal(
    resultText(await editPath(first, "a.txt", [{ old_text: "three", new_text: "four" }])),
    "Edited a.txt (+1 -1 lines).\nNote: a.txt had 2 hard links; it is now a separate file, and its other names keep the old content.",
  );
  assert.equal(await readFile(join(dir, "c.txt"), "utf8"), "three\n");
  assert.equal(await readFile(first, "utf8"), "four\n");
});

test("write and edit refuse paths inside .git in any letter case, while reading .git still works", async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    ".git/config": "[core]\n",
    "sub/.git/hooks/x": "#!/bin/sh\n",
    ".gitignore": "a\n",
    ".github/workflows/ci.yml": "on: push\n",
    "my.git/notes": "x\n",
  });

  for (const path of [".git/config", ".GIT/config", ".Git/HEAD", "sub/.git/hooks/x", "sub/.git/hooks/pre-commit", ".git"]) {
    const refused = new RegExp(`^Error: Refusing to write ${path.replaceAll(".", "\\.")}: it is inside a \\.git folder, whose config and hooks can make git run commands\\. Use git commands through bash instead\\.$`);

    await assert.rejects(writePath(join(dir, path), path, "[core]\n\tfsmonitor = touch pwned\n"), refused);
    await assert.rejects(editPath(join(dir, path), path, [{ old_text: "[core]", new_text: "[core]\n\tfsmonitor = touch pwned" }]), refused);
  }

  assert.equal(await readFile(join(dir, ".git/config"), "utf8"), "[core]\n");
  assert.deepEqual(await readdir(join(dir, "sub/.git/hooks")), ["x"]);
  assert.equal(resultText(await readPath(join(dir, ".git/config"), ".git/config")), "[core]");

  // Names that only look like .git are fine.
  await writePath(join(dir, ".gitignore"), ".gitignore", "b\n");
  await editPath(join(dir, ".github/workflows/ci.yml"), ".github/workflows/ci.yml", [{ old_text: "push", new_text: "pull_request" }]);
  await writePath(join(dir, "my.git/notes"), "my.git/notes", "y\n");
  assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "b\n");
});

/** The files that make a folder a git folder for git: HEAD, objects/ and refs/ (plus a config to plant settings in). */
function gitFolder(path: string): Record<string, string> {
  return {
    [`${path}/HEAD`]: "ref: refs/heads/main\n",
    [`${path}/config`]: "[core]\n",
    [`${path}/objects/.keep`]: "",
    [`${path}/refs/heads/.keep`]: "",
  };
}

test("write and edit refuse paths in git folders of other names: a bare repository, or one a .git links to", { skip: windows && "symlinks need privileges" }, async () => {
  const dir = await realpath(await tempDir());
  await writeTree(dir, {
    ...gitFolder("remote.git"),
    "remote.git/hooks/post-update": "#!/bin/sh\n",
    // A repo-tool checkout: app/.git links to the git folder kept under .repo.
    ...gitFolder(".repo/projects/app.git"),
    "app/main.c": "int main;\n",
  });
  await symlink("../.repo/projects/app.git", join(dir, "app/.git"));
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refused = (shown: string, gitDir: string) => new RegExp(
    `^Error: Refusing to write ${literal(shown)}: ${literal(gitDir)} is a git folder \\(it holds HEAD, objects and refs, as a bare repository does\\), whose config and hooks can make git run commands\\. Use git commands through bash instead\\.$`,
  );

  for (const path of ["remote.git/config", "remote.git/hooks/post-update", "remote.git/HEAD", "remote.git/hooks/pre-commit"]) {
    await assert.rejects(writePath(join(dir, path), path, "[core]\n\tfsmonitor = touch pwned\n"), refused(path, "remote.git"));
    await assert.rejects(editPath(join(dir, path), path, [{ old_text: "[core]", new_text: "[core]\n\tfsmonitor = touch pwned" }]), refused(path, "remote.git"));
  }

  // The tools get canonical paths, as resolveInside gives them: .git is gone from the path, the git folder is still found.
  const config = await resolveInside(dir, dir, "app/.git/config");
  assert.equal(config, join(dir, ".repo/projects/app.git/config"));
  await assert.rejects(writePath(config, ".repo/projects/app.git/config", "[core]\n\tfsmonitor = touch pwned\n"), refused(".repo/projects/app.git/config", ".repo/projects/app.git"));
  await assert.rejects(writePath(await resolveInside(dir, dir, "app/.git/hooks/pre-commit"), ".repo/projects/app.git/hooks/pre-commit", "x"), /is a git folder/);

  assert.equal(await readFile(join(dir, "remote.git/config"), "utf8"), "[core]\n");
  assert.equal(await readFile(join(dir, ".repo/projects/app.git/config"), "utf8"), "[core]\n");
  assert.deepEqual(await readdir(join(dir, "remote.git/hooks")), ["post-update"]);
  assert.equal(resultText(await readPath(join(dir, "remote.git/config"), "remote.git/config")), "[core]");

  // The working tree of that checkout is writable.
  await editPath(join(dir, "app/main.c"), "app/main.c", [{ old_text: "int main;", new_text: "int main(void);" }]);
  assert.equal(await readFile(join(dir, "app/main.c"), "utf8"), "int main(void);\n");

  // A workspace opened inside a git folder is still in it; the message then names the git folder by its full path.
  await assert.rejects(writePath(join(dir, "remote.git/hooks/x"), "hooks/x", "x"), refused("hooks/x", join(dir, "remote.git")));
});

test("a folder that only looks a little like a git folder stays writable, and so do worktrees inside a bare repository", async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    "notes/HEAD": "the head of the list\n",
    "half/HEAD": "x\n",
    "half/objects/a.json": "{}\n",
    ...gitFolder("proj.git"),
    // git worktree add main, run in a bare clone, puts the working tree inside it.
    "proj.git/main/.git": "gitdir: ../worktrees/main\n",
    "proj.git/main/src/a.ts": "export {};\n",
  });

  await writePath(join(dir, "notes/HEAD"), "notes/HEAD", "the new head\n");
  await writePath(join(dir, "notes/more.txt"), "notes/more.txt", "x\n");
  await editPath(join(dir, "half/objects/a.json"), "half/objects/a.json", [{ old_text: "{}", new_text: "[]" }]);
  await editPath(join(dir, "proj.git/main/src/a.ts"), "proj.git/main/src/a.ts", [{ old_text: "export {};", new_text: "export const a = 1;" }]);
  await writePath(join(dir, "proj.git/main/src/b.ts"), "proj.git/main/src/b.ts", "export const b = 2;\n");

  assert.equal(await readFile(join(dir, "notes/HEAD"), "utf8"), "the new head\n");
  assert.equal(await readFile(join(dir, "half/objects/a.json"), "utf8"), "[]\n");
  assert.equal(await readFile(join(dir, "proj.git/main/src/a.ts"), "utf8"), "export const a = 1;\n");
  // The bare repository's own files stay refused.
  await assert.rejects(writePath(join(dir, "proj.git/config"), "proj.git/config", "x"), /proj\.git is a git folder/);
});

test("write refuses a nearly full disk before it changes or creates anything", async () => {
  const dir = await tempDir();
  const file = join(dir, "a.txt");
  await writeTree(dir, { "a.txt": "old\n" });
  // A 100GB disk with 3.9MB left: 64MB is kept free on a disk that size.
  const nearlyFull = async () => ({ bavail: 1000, blocks: 25_000_000, bsize: 4096 });

  await assert.rejects(
    replaceFile(file, "new\n", { displayPath: "a.txt", statfs: nearlyFull }),
    /^Error: Not enough free space to write a\.txt \(4B\): the disk is nearly full \(3\.9MB free\); the file was not changed\. Tell the user\.$/,
  );
  await assert.rejects(
    replaceFile(join(dir, "new/deep/b.txt"), "x", { displayPath: "new/deep/b.txt", statfs: nearlyFull }),
    /^Error: Not enough free space to write new\/deep\/b\.txt \(1B\): the disk is nearly full \(3\.9MB free\); the file was not created\. Tell the user\.$/,
  );
  assert.equal(await readFile(file, "utf8"), "old\n");
  assert.deepEqual(await readdir(dir), ["a.txt"], "no folders were created");

  // Exactly the reserve plus the content is enough.
  const justEnough = async () => ({ bavail: MAX_FREE_SPACE_RESERVE / 4 + 1, blocks: 25_000_000_000, bsize: 4 });
  await replaceFile(file, "new\n", { displayPath: "a.txt", statfs: justEnough });
  assert.equal(await readFile(file, "utf8"), "new\n");

  // For a file in folders still to be made, the nearest existing folder is asked.
  const asked: string[] = [];
  await replaceFile(join(dir, "new/deep/b.txt"), "x", {
    displayPath: "new/deep/b.txt",
    statfs: (path) => {
      asked.push(path);

      return statfs(path);
    },
  });
  assert.deepEqual(asked, [join(dir, "new/deep"), join(dir, "new"), dir]);
});

test("the space kept free scales with the disk, so a small disk still takes small writes", async () => {
  const MB = 1024 * 1024;
  assert.equal(freeSpaceReserve(1024 * 1024 * MB), MAX_FREE_SPACE_RESERVE);
  assert.equal(freeSpaceReserve(1024 * MB), Math.floor(1024 * MB * 0.02));
  assert.equal(freeSpaceReserve(16 * MB), MB);

  const dir = await tempDir();
  const file = join(dir, "a.txt");
  await writeTree(dir, { "a.txt": "old\n" });
  // A 32MB USB stick: 1MB is kept free.
  const stick = (free: number) => async () => ({ bavail: free / 4096, blocks: (32 * MB) / 4096, bsize: 4096 });

  await replaceFile(file, "new\n", { displayPath: "a.txt", statfs: stick(2 * MB) });
  assert.equal(await readFile(file, "utf8"), "new\n");
  await assert.rejects(replaceFile(file, "newer\n", { displayPath: "a.txt", statfs: stick(MB / 2) }), /the disk is nearly full \(512\.0KB free\)/);
  assert.equal(await readFile(file, "utf8"), "new\n");

  // A file system that reports no size at all does not block writes.
  await replaceFile(file, "newest\n", { displayPath: "a.txt", statfs: async () => ({ bavail: 0, blocks: 0, bsize: 4096 }) });
  assert.equal(await readFile(file, "utf8"), "newest\n");
});

test("emptying a file keeps it the same file, so a server appending to it goes on writing where it is seen", async () => {
  const dir = await tempDir();
  const log = join(dir, "dev.log");
  const notes = join(dir, "notes.txt");
  await writeTree(dir, { "dev.log": "old line\n", "notes.txt": "only line\n" });
  const inode = (await stat(log)).ino;
  // A server started with `>> dev.log`.
  const server = await open(log, "a");

  try {
    await server.write("one\n");
    assert.equal(resultText(await writePath(log, "dev.log", "")), "Overwrote dev.log (0B).");
    await server.write("two\n");
  } finally {
    await server.close();
  }

  assert.equal((await stat(log)).ino, inode);
  assert.equal(await readFile(log, "utf8"), "two\n");

  // edit that leaves nothing does the same; emptying needs no free space, so a full disk does not stop it.
  const notesInode = (await stat(notes)).ino;
  await editPath(notes, "notes.txt", [{ old_text: "only line\n", new_text: "" }]);
  assert.equal(await readFile(notes, "utf8"), "");
  assert.equal((await stat(notes)).ino, notesInode);
  await writeFile(notes, "again\n");
  await replaceFile(notes, "", { displayPath: "notes.txt", statfs: async () => ({ bavail: 0, blocks: 1000, bsize: 4096 }) });
  assert.equal(await readFile(notes, "utf8"), "");
  assert.deepEqual((await readdir(dir)).sort(), ["dev.log", "notes.txt"]);
});

test("a rename refused as busy writes the file in place; retried, as on Windows, it can still go through", async () => {
  const dir = await tempDir();
  const file = join(dir, "nginx.conf");
  await writeTree(dir, { "nginx.conf": "one\n" });
  const inode = (await stat(file)).ino;
  const busy = () => Object.assign(new Error("EBUSY: resource or device busy, rename"), { code: "EBUSY" });
  const alwaysBusy = async () => {
    throw busy();
  };

  // On Linux, a file that is a mount point (a bind mount of a single file) cannot be renamed over.
  assert.deepEqual(await replaceFile(file, "two\n", { displayPath: "nginx.conf", rename: alwaysBusy }), { created: false, notes: [] });
  assert.equal(await readFile(file, "utf8"), "two\n");
  assert.equal((await stat(file)).ino, inode);
  assert.deepEqual(await readdir(dir), ["nginx.conf"]);

  // On Windows a virus scanner holding the new file lets go after a moment.
  let refusals = 0;
  const brieflyBusy = async (from: string, to: string) => {
    if (refusals++ < 2) throw busy();
    await rename(from, to);
  };
  await replaceFile(file, "three\n", { displayPath: "nginx.conf", rename: brieflyBusy, renameRetryMs: 1_000 });
  assert.equal(refusals, 3);
  assert.equal(await readFile(file, "utf8"), "three\n");
  assert.notEqual((await stat(file)).ino, inode, "replaced, not written in place");

  // One that stays busy is given up after the retry time.
  const startedAt = Date.now();
  await replaceFile(file, "four\n", { displayPath: "nginx.conf", rename: alwaysBusy, renameRetryMs: 300 });
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(await readFile(file, "utf8"), "four\n");
  assert.deepEqual(await readdir(dir), ["nginx.conf"]);
});

test("edit refuses a file too big for it before reading it, even one over 2GB", { skip: windows && "files are not sparse there" }, async () => {
  const dir = await tempDir();
  const dump = join(dir, "dump.sql");
  const csv = join(dir, "big.csv");
  await writeTree(dir, { "dump.sql": "x", "big.csv": "a,b\n" });
  // Sparse files: they take no disk space. Reading 2GB at once would abort the whole server.
  await truncate(dump, 2 ** 31 + 4096);
  await truncate(csv, 64 * 1024 * 1024 + 1);

  await assert.rejects(
    editPath(dump, "dump.sql", [{ old_text: "x", new_text: "y" }]),
    /^Error: dump\.sql is 2048\.0MB, too large for edit; change it with bash \(sed -i, perl -pi\)\.$/,
  );
  await assert.rejects(editPath(csv, "big.csv", [{ old_text: "a,b", new_text: "c,d" }]), /^Error: big\.csv is 64\.0MB, too large for edit;/);
  await assert.rejects(readPath(dump, "dump.sql"), /^Error: dump\.sql is 2048\.0MB, too large to read at once\./);
  assert.equal((await stat(dump)).size, 2 ** 31 + 4096);
});

test("edit gives up when the file changes between its read and its save", async () => {
  const dir = await tempDir();
  const file = join(dir, "a.txt");
  await writeTree(dir, { "a.txt": "one\n" });
  const read = await stat(file);

  // Someone appends a line while the edit is under way: here, while the free space is checked.
  const appendMeanwhile = async (path: string) => {
    await appendFile(file, "two\n");

    return statfs(path);
  };

  await assert.rejects(
    replaceFile(file, "ONE\n", { displayPath: "a.txt", expected: read, statfs: appendMeanwhile }),
    /^Error: a\.txt changed while it was being edited; read it again and retry\.$/,
  );
  assert.equal(await readFile(file, "utf8"), "one\ntwo\n");
  assert.deepEqual(await readdir(dir), ["a.txt"]);
});

test("a file whose folder does not allow new files is written in place", { skip: (windows || isRoot) && "needs folder permissions" }, async () => {
  const dir = await tempDir();
  const locked = join(dir, "locked");
  const file = join(locked, "a.txt");
  await writeTree(dir, { "locked/a.txt": "one\n" });
  const inode = (await stat(file)).ino;
  await chmod(locked, 0o555);

  try {
    assert.equal(resultText(await writePath(file, "locked/a.txt", "two\n")), "Overwrote locked/a.txt (4B).");
    await editPath(file, "locked/a.txt", [{ old_text: "two", new_text: "three" }]);
    await assert.rejects(
      writePath(join(locked, "b.txt"), "locked/b.txt", "x"),
      /^Error: Could not create locked\/b\.txt: its folder is not writable\. Nothing was written\.$/,
    );
  } finally {
    await chmod(locked, 0o755);
  }

  assert.equal(await readFile(file, "utf8"), "three\n");
  assert.equal((await stat(file)).ino, inode);
  assert.deepEqual(await readdir(locked), ["a.txt"]);
});

test("a read-only file stays refused, although a rename could replace it", { skip: (windows || isRoot) && "needs file permissions" }, async () => {
  const dir = await tempDir();
  const file = join(dir, "frozen.txt");
  await writeTree(dir, { "frozen.txt": "one\n" });
  await chmod(file, 0o444);

  await assert.rejects(writePath(file, "frozen.txt", "two\n"), /^Error: frozen\.txt is not writable \(EACCES: permission denied\)\. It was not changed\.$/);
  await assert.rejects(editPath(file, "frozen.txt", [{ old_text: "one", new_text: "two" }]), /frozen\.txt is not writable/);
  assert.equal(await readFile(file, "utf8"), "one\n");
  assert.equal(await mode(file), 0o444);
  assert.deepEqual(await readdir(dir), ["frozen.txt"]);
});

test("a page of a big file fits one result and starts with the paging note", async () => {
  const dir = await tempDir();
  const file = join(dir, "big.txt");
  const line = (n: number) => `${String(n).padStart(5, "0")} ${"x".repeat(32)}`;
  await writeTree(dir, { "big.txt": `${Array.from({ length: 3000 }, (_, i) => line(i + 1)).join("\n")}\n` });

  const text = resultText(await readPath(file, "big.txt"));
  const note = /^\[Showing lines 1-(\d+) of 3000\. Use offset=(\d+) to continue\.\]\n\n/.exec(text);

  assert.ok(text.length <= MAX_RESULT_CHARS, `${text.length} characters`);
  assert.ok(Buffer.byteLength(text) <= MAX_BYTES);
  assert.ok(note, text.slice(0, 100));
  const shown = Number(note[1]);
  assert.equal(Number(note[2]), shown + 1);
  assert.ok(shown > 1000 && shown < 2000, `${shown} lines`);
  assert.ok(text.endsWith(`\n${line(shown)}`));

  const next = resultText(await readPath(file, "big.txt", shown + 1));
  assert.match(next, new RegExp(`^\\[Showing lines ${shown + 1}-\\d+ of 3000\\. Use offset=\\d+ to continue\\.\\]\\n\\n${line(shown + 1)}\\n`));

  const limited = resultText(await readPath(file, "big.txt", 10, 2));
  assert.equal(limited, `[Lines 10-11 of 3000; 2989 more lines after them. Use offset=12 to continue.]\n\n${line(10)}\n${line(11)}`);
});

test("pages of multi-byte text stay within the byte limit, and the encoding note stays on top", async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    "zh.txt": `${Array.from({ length: 2000 }, (_, i) => `${i} ${"中文".repeat(10)}`).join("\n")}\n`,
    "latin1.txt": Buffer.concat(Array.from({ length: 3000 }, () => Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, ...Buffer.from("x".repeat(30)), 0x0a]))),
  });

  const zh = resultText(await readPath(join(dir, "zh.txt"), "zh.txt"));
  assert.ok(Buffer.byteLength(zh) <= MAX_BYTES, `${Buffer.byteLength(zh)} bytes`);
  assert.match(zh, /^\[Showing lines 1-\d+ of 2000\. Use offset=\d+ to continue\.\]\n\n0 中文/);

  const latin1 = resultText(await readPath(join(dir, "latin1.txt"), "latin1.txt"));
  assert.ok(latin1.length <= MAX_RESULT_CHARS && Buffer.byteLength(latin1) <= MAX_BYTES);
  assert.match(latin1, /^\[Showing lines 1-\d+ of 3000\. Use offset=\d+ to continue\.\]\n\[Note: latin1\.txt is not valid UTF-8 [^\n]*\]\n\ncaf� x/);
});

test("an over-long line is shown from its start, cut between characters, with a bash command for the rest", async () => {
  const dir = await tempDir();
  const emoji = "😀".repeat(30_000);
  const minified = `${"x".repeat(60_000)}\n`;
  await writeTree(dir, {
    "emoji.txt": `${emoji}\nnext\n`,
    "odd.txt": `a${emoji}\n`,
    "zh.txt": `${"中".repeat(30_000)}\n`,
    "src/it's min.js": `first\n${minified}`,
    "-dash.js": minified,
    "wide.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(minified, "utf16le")]),
  });

  // The command counts bytes: 20,000 characters of emoji are 40,000 bytes, and so is the next window.
  const even = resultText(await readPath(join(dir, "emoji.txt"), "emoji.txt"));
  assert.match(
    even,
    /^\[Line 1 is 117\.2KB; showing its first 20,000 characters\. To see more of it: sed -n '1p' emoji\.txt \| cut -b 40001-80000 in bash\. Use offset=2 to continue after it\.\]\n\n😀/,
  );
  const odd = resultText(await readPath(join(dir, "odd.txt"), "odd.txt"));
  // 20,000 code units would end in half an emoji: one fewer is shown, and the command goes on from there.
  assert.match(odd, /^\[Line 1 is 117\.2KB; showing its first 19,999 characters\. To see more of it: sed -n '1p' odd\.txt \| cut -b 39998-79997 in bash\.\]\n\na😀/);
  const zh = resultText(await readPath(join(dir, "zh.txt"), "zh.txt"));
  // 16,964 characters of 3 bytes fill the result; the other 13,036 fit the next window.
  assert.match(zh, /^\[Line 1 is 87\.9KB; showing its first 16,964 characters\. To see more of it: sed -n '1p' zh\.txt \| cut -b 50893-90000 in bash\.\]/);

  // The file goes into the command as one shell word, never as an option; a UTF-16 file is converted first.
  assert.match(
    resultText(await readPath(join(dir, "src/it's min.js"), "src/it's min.js", 2)),
    /^\[Line 2 is 58\.6KB; showing its first 20,000 characters\. To see more of it: sed -n '2p' 'src\/it'\\''s min\.js' \| cut -b 20001-40000 in bash\.\]\n\nx/,
  );
  assert.match(resultText(await readPath(join(dir, "-dash.js"), "-dash.js")), /To see more of it: sed -n '1p' \.\/-dash\.js \| cut -b 20001-40000 in bash\.\]/);
  assert.match(
    resultText(await readPath(join(dir, "wide.txt"), "wide.txt")),
    /^\[Line 1 is 58\.6KB; showing its first 20,000 characters\. To see more of it: iconv -f UTF-16LE -t UTF-8 wide\.txt \| sed -n '1p' \| cut -b 20004-40003 in bash\.\]\n\[UTF-16 file, shown decoded\.[^\n]*\]\n\nx/,
  );

  for (const text of [even, odd, zh]) {
    const body = text.slice(text.indexOf("\n\n") + 2);

    assert.equal(lonelySurrogate(body), false);
    assert.ok(body.length <= 20_000);
    assert.ok(text.length <= MAX_RESULT_CHARS && Buffer.byteLength(text) <= MAX_BYTES, `${Buffer.byteLength(text)} bytes`);
  }

  assert.equal(resultText(await readPath(join(dir, "emoji.txt"), "emoji.txt", 2)), "next");
});

test("the bash command for the rest of an over-long line prints exactly the next part of it, which bash returns whole", { skip: windows && "needs sed, cut and iconv" }, async () => {
  const dir = await tempDir();
  // Every few characters a multi-byte one, so that a count in characters and one in bytes drift apart.
  const mixed = Array.from({ length: 9_000 }, (_, i) => `k${i}${["é", "中", "😀", ""][i % 4]}`).join(",");
  const latin1 = Buffer.from(`${"café au lait, ".repeat(5_000)}\n`, "latin1");
  const files: Record<string, string | Buffer> = {
    "ascii.txt": `${"a".repeat(70_000)}\n`,
    "cjk.txt": `head\n${"中文".repeat(40_000)}\ntail\n`,
    "emoji.txt": `${"😀".repeat(40_000)}\n`,
    "mixed.txt": `${mixed}\r\nnext\r\n`,
    // Line 1 after a byte-order mark, which sed prints along with the line.
    "bom.txt": `﻿${"ü".repeat(40_000)}\n`,
    // Not valid UTF-8: shown with replacement characters, while sed and cut see the file's own bytes.
    "latin1.txt": Buffer.concat([Buffer.from("first\n"), latin1]),
    // UTF-16 goes through iconv, whose output starts with the byte-order mark in UTF-8.
    "wide.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`one\n${mixed}\n`, "utf16le")]),
    "wide-be.txt": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${mixed}\n`, "utf16le").swap16()]),
  };
  await writeTree(dir, files);
  const lineNumbers = { "ascii.txt": 1, "cjk.txt": 2, "emoji.txt": 1, "mixed.txt": 1, "bom.txt": 1, "latin1.txt": 2, "wide.txt": 2, "wide-be.txt": 1 };

  for (const [name, lineNumber] of Object.entries(lineNumbers)) {
    const text = resultText(await readPath(join(dir, name), name, lineNumber));
    const note = /^\[Line \d+ is [\d.]+KB; showing its first ([\d,]+) characters\. To see more of it: (.+) in bash\./.exec(text);
    assert.ok(note, `${name}: ${text.slice(0, 300)}`);
    const shown = Number(note[1]!.replaceAll(",", ""));
    const line = splitDecoded(files[name]!)[lineNumber - 1]!;

    assert.equal(text.slice(text.indexOf("\n\n") + 2), line.slice(0, shown), name);

    // What bash prints is the next part of the line, at most 20,000 characters and 40,000 bytes: within what bash
    // returns whole.
    const next = resultText(await runCommand(note[2]!, dir));
    assert.ok(next.length > 0 && next.length <= 20_000 && Buffer.byteLength(next) <= 40_000, `${name}: ${next.length} characters`);
    assert.equal(next, line.slice(shown, shown + next.length), name);
    assert.ok(next.length === 20_000 || Buffer.byteLength(next) > 40_000 - 4 || shown + next.length === line.length, `${name}: the window is as big as it may be`);
  }
});

/** The lines of a test file, decoded as read decodes them. */
function splitDecoded(content: string | Buffer): string[] {
  const buffer = typeof content === "string" ? Buffer.from(content) : content;
  let text = buffer.toString("utf8");

  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) text = Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");

  return text.replace(/^﻿/, "").split(/\r?\n/);
}

test("folder listings fit one result, with long names too", async () => {
  const dir = await tempDir();
  const long = join(dir, "long");
  const many = join(dir, "many");
  await writeTree(dir, { "long/.keep": "", "many/.keep": "" });

  // 450 names of 200 characters: under the 500-entry cap, but twice what fits in one result.
  await Promise.all(Array.from({ length: 450 }, (_, i) => writeFile(join(long, `${String(i).padStart(3, "0")}-${"n".repeat(196)}`), "")));
  await Promise.all(Array.from({ length: 600 }, (_, i) => writeFile(join(many, `f${String(i).padStart(3, "0")}`), "")));

  const listing = await listDirectory(long, "long");
  const shown = /^Directory long \(451 entries\):\n\[Showing the first (\d+) entries\. Use glob or bash to see the rest\.\]\n\.keep\n000-n/.exec(listing);
  assert.ok(shown, listing.slice(0, 200));
  assert.equal(listing.split("\n").length, 2 + Number(shown[1]));
  // Room is left for what open_workspace adds around the listing.
  assert.ok(listing.length <= MAX_RESULT_CHARS - 1_000, `${listing.length} characters`);
  assert.ok(Buffer.byteLength(listing) <= MAX_BYTES - 1_000);

  const read = resultText(await readPath(long, "long"));
  assert.ok(read.length <= MAX_RESULT_CHARS && Buffer.byteLength(read) <= MAX_BYTES);

  assert.match(await listDirectory(many, "many"), /^Directory many \(601 entries\):\n\[Showing the first 500 entries\. Use glob or bash to see the rest\.\]\n\.keep\nf000\n/);
});
