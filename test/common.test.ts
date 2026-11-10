import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONTENT_CHARS,
  MAX_ERROR_RESULT_CHARS,
  MAX_RESULT_CHARS,
  clipEnd,
  clipStart,
  decodeText,
  takeHead,
  takeTail,
  textResult,
  utf16ByteOrder,
} from "../src/tools/common.ts";

const EMOJI = "\u{1F600}"; // two UTF-16 code units, four UTF-8 bytes

test("clipStart and clipEnd never cut a surrogate pair in half", () => {
  const text = EMOJI.repeat(10);

  assert.equal(clipStart(text, 5), EMOJI.repeat(2));
  assert.equal(clipEnd(text, 5), EMOJI.repeat(2));
  assert.equal(clipStart(text, 1), "");
  assert.equal(clipEnd(text, 1), "");
  assert.equal(clipStart("abc", 10), "abc");
  assert.equal(clipEnd("abc", 2), "bc");
});

test("clipStart and clipEnd also respect a byte limit", () => {
  const han = "中".repeat(100); // 3 bytes each

  assert.equal(clipStart(han, 1_000, 10), "中".repeat(3));
  assert.equal(clipEnd(han, 1_000, 10), "中".repeat(3));
  assert.equal(clipStart(`a${EMOJI}b`, 10, 4), "a");
  assert.equal(clipEnd(`a${EMOJI}b`, 10, 5), `${EMOJI}b`);
});

test("takeHead and takeTail stop at the character budget", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `${String(i).padStart(4, "0")} ${"x".repeat(33)}`); // 38 characters
  const head = takeHead(lines);
  const tail = takeTail(lines);

  assert.equal(head.truncated, true);
  assert.equal(tail.truncated, true);
  assert.ok(head.lines.join("\n").length <= MAX_CONTENT_CHARS);
  assert.ok(tail.lines.join("\n").length <= MAX_CONTENT_CHARS);
  assert.equal(head.lines.length, Math.floor(MAX_CONTENT_CHARS / 39));
  assert.equal(tail.lines.at(-1), lines.at(-1));
  assert.deepEqual(takeHead(["a", "b"], 10, 100, 4), { lines: ["a", "b"], truncated: false });
  assert.deepEqual(takeHead(["a", "b"], 10, 100, 3), { lines: ["a"], truncated: true });
});

test("textResult cuts an over-long result as a last resort and says so", () => {
  const ok = textResult("y".repeat(MAX_RESULT_CHARS + 500));
  const okText = ok.content[0]!.type === "text" ? ok.content[0]!.text : "";

  assert.ok(okText.length <= MAX_RESULT_CHARS);
  assert.match(okText, /^\[Result cut to its first 45,000 of 45,500 characters\.\]\n/);
  assert.equal(ok.isError, undefined);

  const failure = `first line\n${"z".repeat(50_000)}\nlast line`;
  const error = textResult(failure, true);
  const errorText = error.content[0]!.type === "text" ? error.content[0]!.text : "";

  assert.equal(error.isError, true);
  assert.ok(errorText.length <= MAX_ERROR_RESULT_CHARS, `${errorText.length} characters`);
  assert.ok(errorText.startsWith("first line\n"));
  assert.ok(errorText.endsWith("\nlast line"));
  assert.match(errorText, /\[… [\d,]+ characters omitted …\]/);

  assert.deepEqual(textResult("short"), { content: [{ type: "text", text: "short" }] });
});

test("decodeText reads UTF-16 with a byte-order mark and drops a UTF-8 mark", () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("first\nzweite", "utf16le")]);
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a, 0x00, 0x62]);
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\nsecond")]);

  assert.equal(decodeText(le), "first\nzweite");
  assert.equal(utf16ByteOrder(le), "utf-16le");
  assert.equal(decodeText(be), "a\nb");
  assert.equal(utf16ByteOrder(be), "utf-16be");
  assert.equal(decodeText(utf8Bom), "first\nsecond");
  assert.match(decodeText(utf8Bom)!, /^first/);
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00])), undefined, "UTF-32LE stays binary");
  assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), undefined, "a NUL byte without a mark means binary");
  assert.equal(utf16ByteOrder(Buffer.from("plain")), undefined);
});
