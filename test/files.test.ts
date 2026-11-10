import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_BYTES, MAX_RESULT_CHARS } from "../src/tools/common.ts";
import { editPath, readPath, writePath } from "../src/tools/files.ts";
import { resultText, tempDir, writeTree } from "./helpers.ts";

// "café\nhello\n" in Latin-1 and "中文\nhello\n" in GBK: valid text, but not UTF-8.
const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]);
const GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]);

test("edit refuses files that are not valid UTF-8 and leaves them untouched", async () => {
  const root = await tempDir();
  await writeTree(root, { "latin1.txt": LATIN1, "gbk.txt": GBK });

  for (const name of ["latin1.txt", "gbk.txt"]) {
    const file = join(root, name);
    const before = await readFile(file);

    await assert.rejects(
      editPath(file, name, [{ old_text: "hello", new_text: "world" }]),
      /is not valid UTF-8.*refuses to change it/,
    );
    assert.deepEqual(await readFile(file), before, `${name} must not be modified`);
  }
});

test("edit refuses binary files", async () => {
  const root = await tempDir();
  const bytes = Buffer.from([0x68, 0x69, 0x00, 0xff, 0xfe, 0x0a]);
  await writeTree(root, { "blob.bin": bytes });

  await assert.rejects(editPath(join(root, "blob.bin"), "blob.bin", [{ old_text: "hi", new_text: "yo" }]), /binary file/);
  assert.deepEqual(await readFile(join(root, "blob.bin")), bytes);
});

test("edit and write of a folder say that it is one", async () => {
  const root = await tempDir();
  await writeTree(root, { "dir/x.txt": "x" });

  await assert.rejects(editPath(join(root, "dir"), "dir", [{ old_text: "x", new_text: "y" }]), /^Error: dir is a directory\.$/);
  await assert.rejects(writePath(join(root, "dir"), "dir", "y"), /^Error: dir is a directory\.$/);
});

test("read shows non-UTF-8 text with a warning instead of silent replacement characters", async () => {
  const root = await tempDir();
  await writeTree(root, { "latin1.txt": LATIN1 });

  const text = resultText(await readPath(join(root, "latin1.txt"), "latin1.txt"));

  assert.match(text, /^\[Note: latin1\.txt is not valid UTF-8/);
  assert.match(text, /edit will refuse to change this file\.\]\n\n/);
  assert.match(text, /\nhello$/);
});

/** `text` as UTF-16 with a byte order mark, little- or big-endian. */
function utf16(text: string, order: "le" | "be"): Buffer {
  const le = Buffer.from(text, "utf16le");

  return order === "le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), le]) : Buffer.concat([Buffer.from([0xfe, 0xff]), le.swap16()]);
}

/** The note read puts on top of a UTF-16 file: the iconv command it gives names the file's byte order. */
function utf16Note(order: "le" | "be"): string {
  return `[UTF-16 file, shown decoded. edit does not change UTF-16 files; convert it with iconv -f UTF-16${order.toUpperCase()} -t UTF-8 in bash first.]`;
}

const UTF16_NOTE = utf16Note("le");

test("read shows UTF-16 files with a byte order mark decoded, as grep searches them, and edit refuses them", async () => {
  const root = await tempDir();
  const text = "\"title\" = \"名前\";\r\npassword = hunter2\r\n";
  await writeTree(root, { "le.strings": utf16(text, "le"), "be.strings": utf16(text, "be"), "bom-only.txt": Buffer.from([0xff, 0xfe]) });

  for (const order of ["le", "be"] as const) {
    const name = `${order}.strings`;
    const file = join(root, name);
    const before = await readFile(file);

    assert.equal(resultText(await readPath(file, name)), `${utf16Note(order)}\n\n"title" = "名前";\npassword = hunter2`);
    assert.equal(resultText(await readPath(file, name, 2)), `${utf16Note(order)}\n\npassword = hunter2`);
    await assert.rejects(
      editPath(file, name, [{ old_text: "hunter2", new_text: "swordfish" }]),
      new RegExp(`^Error: ${name.replace(".", "\\.")} is a UTF-16 file; edit only changes UTF-8 text\\. Convert it with iconv -f UTF-16${order.toUpperCase()} -t UTF-8 in bash first, or change it with bash\\.$`),
    );
    assert.deepEqual(await readFile(file), before, `${name} must not be modified`);
  }

  assert.equal(resultText(await readPath(join(root, "bom-only.txt"), "bom-only.txt")), "(bom-only.txt is empty)");
});

test("the iconv command read and edit give converts a UTF-16 file with emoji whole", { skip: (process.platform === "win32" || !hasIconv()) && "needs iconv" }, async () => {
  // macOS's iconv, given only -f UTF-16, reads this little-endian file as big-endian from about its 510th character
  // on, without an error: there an emoji falls on the end of a block it reads.
  const root = await tempDir();
  const text = "😀,".repeat(3_000);
  await writeTree(root, { "le.txt": utf16(text, "le"), "be.txt": utf16(text, "be") });

  for (const order of ["le", "be"] as const) {
    const name = `${order}.txt`;
    const command = /convert it with (iconv [^]+?) in bash first/.exec(resultText(await readPath(join(root, name), name)))![1]!;
    const converted = execFileSync("/bin/sh", ["-c", `${command} ${name}`], { cwd: root });

    // The byte-order mark comes along, as UTF-8's.
    assert.equal(converted.toString("utf8"), `﻿${text}`, name);
  }
});

function hasIconv(): boolean {
  try {
    execFileSync("iconv", ["-l"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

test("pages of a UTF-16 file are counted in decoded lines and fit one result", async () => {
  const root = await tempDir();
  const line = (n: number) => `${String(n).padStart(4, "0")} ${"字".repeat(20)}`;
  await writeTree(root, { "wide.txt": utf16(`${Array.from({ length: 3000 }, (_, i) => line(i + 1)).join("\r\n")}\r\n`, "le") });

  const first = resultText(await readPath(join(root, "wide.txt"), "wide.txt"));
  const note = /^\[Showing lines 1-(\d+) of 3000\. Use offset=(\d+) to continue\.\]\n(\[UTF-16 file[^\n]*\])\n\n0001 字/.exec(first);
  assert.ok(note, first.slice(0, 300));
  assert.equal(note[3], UTF16_NOTE);
  assert.ok(first.length <= MAX_RESULT_CHARS && Buffer.byteLength(first) <= MAX_BYTES, `${Buffer.byteLength(first)} bytes`);
  assert.ok(first.endsWith(`\n${line(Number(note[1]))}`));

  assert.equal(
    resultText(await readPath(join(root, "wide.txt"), "wide.txt", 10, 2)),
    `[Lines 10-11 of 3000; 2989 more lines after them. Use offset=12 to continue.]\n${UTF16_NOTE}\n\n${line(10)}\n${line(11)}`,
  );
});

test("valid UTF-8 (including multi-byte characters and a BOM) still reads and edits normally", async () => {
  const root = await tempDir();
  const file = join(root, "zh.txt");
  await writeTree(root, { "zh.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文\r\nhello\r\n", "utf8")]) });

  assert.equal(resultText(await readPath(file, "zh.txt")), "中文\nhello");
  await editPath(file, "zh.txt", [{ old_text: "hello", new_text: "世界" }]);
  assert.deepEqual(await readFile(file), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文\r\n世界\r\n", "utf8")]));
});
