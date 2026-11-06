import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { editPath, readPath, writePath } from "../src/tools/files.ts";
import { runCommand } from "../src/tools/shell.ts";
import { resultText, tempDir, writeTree } from "./helpers.ts";

test("read pages through files, lists folders and recognises binaries and images", async () => {
  const root = await tempDir();
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await writeTree(root, { "big.txt": lines, "small.txt": "a\r\nb\r\nc\r\n", "dir/x.txt": "x", "bin.dat": Buffer.from([1, 0, 2]), "dot.png": png, "empty.txt": "" });

  const first = resultText(await readPath(join(root, "big.txt"), "big.txt"));
  assert.match(first, /^line 1\n/);
  assert.match(first, /\[Showing lines 1-2000 of 2500\. Use offset=2001 to continue\.\]$/);

  const page = resultText(await readPath(join(root, "big.txt"), "big.txt", 2001, 3));
  assert.equal(page, "line 2001\nline 2002\nline 2003\n\n[497 more lines in the file. Use offset=2004 to continue.]");

  assert.equal(resultText(await readPath(join(root, "small.txt"), "small.txt")), "a\nb\nc");
  assert.equal(resultText(await readPath(join(root, "dir"), "dir")), "Directory dir (1 entries):\nx.txt");
  assert.match(resultText(await readPath(join(root, "bin.dat"), "bin.dat")), /binary file/);
  assert.equal(resultText(await readPath(join(root, "empty.txt"), "empty.txt")), "(empty.txt is empty)");

  const image = await readPath(join(root, "dot.png"), "dot.png");
  assert.deepEqual(image.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });

  await assert.rejects(readPath(join(root, "big.txt"), "big.txt", 9999), /beyond the end/);
  await assert.rejects(readPath(join(root, "nope.txt"), "nope.txt"), /File not found: nope.txt/);
});

test("write creates parent folders", async () => {
  const root = await tempDir();
  const result = await writePath(join(root, "a/b/c.txt"), "a/b/c.txt", "hello");

  assert.equal(resultText(result), "Created a/b/c.txt (5B).");
  assert.equal(await readFile(join(root, "a/b/c.txt"), "utf8"), "hello");
  assert.equal(resultText(await writePath(join(root, "a/b/c.txt"), "a/b/c.txt", "bye")), "Overwrote a/b/c.txt (3B).");
  await assert.rejects(writePath(join(root, "a"), "a", "x"), /is a directory/);
});

test("edit replaces unique text and refuses ambiguous, missing or overlapping edits", async () => {
  const root = await tempDir();
  const file = join(root, "code.js");
  await writeTree(root, { "code.js": "const a = 1;\nconst b = 2;\nconst c = 3;\n" });

  const result = await editPath(file, "code.js", [
    { old_text: "const a = 1;", new_text: "const a = 10;" },
    { old_text: "const c = 3;\n", new_text: "const c = 30;\nconst d = 40;\n" },
  ]);

  assert.equal(resultText(result), "Edited code.js (+3 -2 lines).");
  assert.equal(await readFile(file, "utf8"), "const a = 10;\nconst b = 2;\nconst c = 30;\nconst d = 40;\n");

  await assert.rejects(editPath(file, "code.js", [{ old_text: "const z", new_text: "x" }]), /was not found/);
  await assert.rejects(editPath(file, "code.js", [{ old_text: "const", new_text: "let" }]), /matches 4 places/);
  await assert.rejects(editPath(file, "code.js", [{ old_text: "b = 2", new_text: "b = 2" }]), /No changes/);
  await assert.rejects(
    editPath(file, "code.js", [{ old_text: "a = 10;\nconst b", new_text: "x" }, { old_text: "b = 2", new_text: "y" }]),
    /overlap/,
  );
  await assert.rejects(editPath(join(root, "missing.js"), "missing.js", [{ old_text: "a", new_text: "b" }]), /Use write/);
});

test("edit keeps CRLF line endings and a UTF-8 BOM", async () => {
  const root = await tempDir();
  const file = join(root, "win.txt");
  await writeTree(root, { "win.txt": "﻿first\r\nsecond\r\nthird\r\n" });

  await editPath(file, "win.txt", [{ old_text: "first\nsecond", new_text: "one\ntwo" }]);

  assert.equal(await readFile(file, "utf8"), "﻿one\r\ntwo\r\nthird\r\n");
});

test("parallel edits to one file are serialized instead of overwriting each other", async () => {
  const root = await tempDir();
  const file = join(root, "list.txt");
  const items = Array.from({ length: 20 }, (_, i) => i);
  await writeTree(root, { "list.txt": items.map((i) => `item ${i}\n`).join("") });

  await Promise.all(items.map((i) => editPath(file, "list.txt", [{ old_text: `item ${i}\n`, new_text: `done ${i}\n` }])));

  assert.equal(await readFile(file, "utf8"), items.map((i) => `done ${i}\n`).join(""));
});

test("bash returns output, exit codes and working directory", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, { "sub/file.txt": "x" });

  assert.equal(resultText(await runCommand("echo hello && echo oops >&2", root)), "hello\noops");
  assert.equal(resultText(await runCommand("pwd", join(root, "sub"))), join(root, "sub"));
  assert.equal(resultText(await runCommand("true", root)), "(no output)");

  const failed = await runCommand("echo before; exit 3", root);
  assert.equal(failed.isError, true);
  assert.equal(resultText(failed), "before\n\nCommand exited with code 3.");

  await assert.rejects(runCommand("pwd", join(root, "missing")), /not an existing folder/);
  await assert.rejects(runCommand("pwd", join(root, "sub/file.txt")), /not an existing folder/);
});

test("bash keeps the tail of long output", async () => {
  const root = await tempDir();
  const result = resultText(await runCommand("seq 1 5000", root));

  assert.match(result, /^\[Output truncated: showing the last 2000 of 5000 lines\./);
  assert.match(result, /\n3001\n/);
  assert.match(result, /\n5000$/);
});

test("bash kills commands on timeout and on cancellation", async () => {
  const root = await tempDir();
  let startedAt = Date.now();
  const timedOut = await runCommand("echo started; sleep 10", root, 1);

  assert.equal(timedOut.isError, true);
  assert.equal(resultText(timedOut), "started\n\nCommand timed out after 1 seconds and was killed.");
  assert.ok(Date.now() - startedAt < 4000);

  startedAt = Date.now();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const cancelled = await runCommand("sleep 10", root, 30, controller.signal);

  assert.match(resultText(cancelled), /cancelled/);
  assert.ok(Date.now() - startedAt < 4000);
});

test("bash returns promptly when a command leaves a background process", async () => {
  const root = await tempDir();
  const startedAt = Date.now();

  const result = await runCommand("sleep 3 & echo launched", root);
  assert.equal(resultText(result), "launched");
  assert.ok(Date.now() - startedAt < 2000, "should not wait for the background process");

  const redirected = await runCommand("nohup sleep 3 > /dev/null 2>&1 & echo ok", root);
  assert.equal(resultText(redirected), "ok");
});
