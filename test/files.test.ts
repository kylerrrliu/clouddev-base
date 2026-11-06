import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { editPath, readPath } from "../src/tools/files.ts";
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

test("read shows non-UTF-8 text with a warning instead of silent replacement characters", async () => {
  const root = await tempDir();
  await writeTree(root, { "latin1.txt": LATIN1 });

  const text = resultText(await readPath(join(root, "latin1.txt"), "latin1.txt"));

  assert.match(text, /^\[Note: latin1\.txt is not valid UTF-8/);
  assert.match(text, /edit will refuse to change this file\.\]\n\n/);
  assert.match(text, /\nhello$/);
});

test("valid UTF-8 (including multi-byte characters and a BOM) still reads and edits normally", async () => {
  const root = await tempDir();
  const file = join(root, "zh.txt");
  await writeTree(root, { "zh.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文\r\nhello\r\n", "utf8")]) });

  assert.equal(resultText(await readPath(file, "zh.txt")), "中文\nhello");
  await editPath(file, "zh.txt", [{ old_text: "hello", new_text: "世界" }]);
  assert.deepEqual(await readFile(file), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文\r\n世界\r\n", "utf8")]));
});
