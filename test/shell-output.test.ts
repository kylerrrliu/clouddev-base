import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BYTES, MAX_ERROR_RESULT_CHARS, MAX_RESULT_CHARS } from "../src/tools/common.ts";
import { FAILURE_LINE_CHARS, runCommand, SUCCESS_LINE_CHARS } from "../src/tools/shell.ts";
import { resultText, tempDir, writeTree } from "./helpers.ts";

const NODE = JSON.stringify(process.execPath);
const MORE_HINT = "Redirect output to a file and read or grep it if you need more.";
const PART_OF_LINE_NOTE = `[Output truncated: part of a long line is left out. ${MORE_HINT}]`;

test("progress redrawn with \\r is folded to its last state, so the lines around it stay", async () => {
  const root = await tempDir();
  const progress = (label: string, frames: number) =>
    Array.from({ length: frames }, (_, i) => `\r${label} ${i + 1}/${frames} [=====>    ]`).join("");
  await writeTree(root, {
    "out.txt": `Step 1 ok\n${progress("downloading", 3000)}\nERROR: upload failed: quota exceeded\n${progress("retry", 500)}\nERROR: giving up\n`,
  });

  const result = await runCommand("cat out.txt; exit 1", root);

  assert.equal(
    resultText(result),
    "[Folded 3498 progress redraws (text rewritten with \\r): only the last state of each line is shown.]\n" +
      "Step 1 ok\ndownloading 3000/3000 [=====>    ]\nERROR: upload failed: quota exceeded\nretry 500/500 [=====>    ]\nERROR: giving up\n\n" +
      "Command exited with code 1.",
  );

  // Without a final newline, and without the line endings of a CRLF file counting as redraws.
  await writeTree(root, { "crlf.txt": "one\r\ntwo\r\n", "end.txt": `Step 1 ok\nERROR: disk full\n${progress("uploading", 2000)}` });
  assert.equal(resultText(await runCommand("cat crlf.txt", root)), "one\ntwo");
  assert.match(resultText(await runCommand("cat end.txt", root)), /\nStep 1 ok\nERROR: disk full\nuploading 2000\/2000 \[=====>    \]$/);

  // A frame of spaces erases a progress bar; the line keeps the last state that had something in it.
  await writeTree(root, { "erased.txt": "Saving\r          \rSaved model.pt\nUploading 100%\r                \r\nDone\n" });
  assert.equal(
    resultText(await runCommand("cat erased.txt", root)),
    "[Folded 1 progress redraw (text rewritten with \\r): only the last state of each line is shown.]\nSaved model.pt\nUploading 100%\nDone",
  );
});

test("escape sequences are stripped: colours, cursor control, titles and hyperlinks", async () => {
  const root = await tempDir();
  await writeTree(root, {
    "out.txt":
      "\x1b[31mred\x1b[0m and \x1b[1;32mbold green\x1b[0m\n" +
      "\x1b]0;window title\x07done\n" +
      "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\n" +
      "\x1b[2K\x1b[1Gcleared\x1b(B\x1b[?25h\n",
  });

  assert.equal(resultText(await runCommand("cat out.txt", root)), "red and bold green\ndone\nlink\ncleared");
});

test("a very long line keeps its two ends when the output does not fit, and the lines around it stay", async () => {
  const root = await tempDir();
  const result = await runCommand(`echo first; ${NODE} -e 'process.stdout.write("<" + "x".repeat(99998) + ">\\n")'; echo last`, root);

  assert.equal(SUCCESS_LINE_CHARS, 20_000);
  assert.equal(resultText(result), `first\n<${"x".repeat(9999)}…[80000 characters omitted]…${"x".repeat(9999)}>\nlast`);

  // A failure's budget is smaller: 1,000 characters of each end.
  const failed = await runCommand(`echo first; ${NODE} -e 'process.stdout.write("<" + "x".repeat(99998) + ">\\n")'; echo last; exit 1`, root);

  assert.equal(FAILURE_LINE_CHARS, 2_000);
  assert.equal(resultText(failed), `first\n<${"x".repeat(999)}…[98000 characters omitted]…${"x".repeat(999)}>\nlast\n\nCommand exited with code 1.`);
});

test("a long line comes back whole when the output fits, so a one-line JSON response still parses", async () => {
  const root = await tempDir();
  const items = Array.from({ length: 120 }, (_, id) => ({ id, name: `item ${id}`, done: id % 2 === 0 }));
  const unpadded = JSON.stringify({ items, padding: "" });
  const json = JSON.stringify({ items, padding: "-".repeat(5856 - unpadded.length) });
  await writeTree(root, { "response.json": json });

  assert.equal(json.length, 5856);

  const fetched = resultText(await runCommand("cat response.json", root));
  assert.equal(fetched, json);
  assert.deepEqual(JSON.parse(fetched), JSON.parse(json));

  // A failure's whole output fits its budget too.
  assert.equal(resultText(await runCommand("cat response.json; exit 7", root)), `${json}\n\nCommand exited with code 7.`);
});

test("the 20,000-character window of a long line that read's bash command takes with cut -b comes back whole", async () => {
  const root = await tempDir();
  const line = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(10, "0")).join("");
  await writeTree(root, { "bundle.min.js": `${line}\n`, "near.txt": `${"n".repeat(20_090)}\n` });

  assert.equal(resultText(await runCommand("sed -n '1p' bundle.min.js | cut -b 20001-40000", root)), line.slice(20_000, 40_000));

  // Also when the output around it does not fit, as long as cutting long lines to 2,000 characters would not show
  // more lines: here both show the last 2,000.
  const shown = resultText(await runCommand("seq 1 3000; cut -b 20001-40000 bundle.min.js", root)).split("\n");

  assert.match(shown[0]!, /^\[Output truncated: showing the last 2000 of 3001 lines\./);
  assert.equal(shown[1], "1002");
  assert.equal(shown.at(-1), line.slice(20_000, 40_000));

  // A line just over the limit is not cut for the few characters that would save.
  assert.equal(resultText(await runCommand("seq 1 3000; cat near.txt", root)).split("\n").at(-1), "n".repeat(20_090));

  // With another long line after it, both cut to 20,000 characters would leave room for fewer than 800 of the short
  // lines before them; cut to 2,000, the last 2,000 lines are shown.
  const crowded = resultText(await runCommand("seq 1 3000; cut -b 20001-40000 bundle.min.js; cat bundle.min.js", root)).split("\n");

  assert.match(crowded[0]!, /^\[Output truncated: showing the last 2000 of 3002 lines\./);
  assert.equal(crowded[1], "1003");
  assert.equal(crowded.at(-2), `${line.slice(20_000, 21_000)}…[18000 characters omitted]…${line.slice(39_000, 40_000)}`);
  assert.equal(crowded.at(-1), `${line.slice(0, 1_000)}…[98000 characters omitted]…${line.slice(-1_000)}`);
});

test("a few long lines in a successful command's output do not crowd out the many short ones around them", async () => {
  const root = await tempDir();
  const page = (script: (i: number) => string) =>
    [
      ...Array.from({ length: 100 }, (_, i) => `<div class="row-${i}">item ${i}</div>`),
      ...Array.from({ length: 4 }, (_, i) => script(i)),
      ...Array.from({ length: 100 }, (_, i) => `<li>footer ${i}</li>`),
    ].join("\n");
  const matches = Array.from({ length: 30 }, (_, i) => `dist/chunk-${i}.js:1:${"m".repeat(50_000)}`);
  await writeTree(root, {
    "page.html": `${page((i) => `<script id="s${i}">${"s".repeat(30_000)}</script>`)}\n`,
    "matches.txt": `${matches.join("\n")}\n`,
  });

  // A server-rendered page with a few inline scripts: cut to 20,000 characters, the scripts would leave room for only
  // half of the page. Cut to 2,000, every line is shown, and only the scripts are cut.
  assert.equal(
    resultText(await runCommand("cat page.html", root)),
    page((i) => `<script id="s${i}">${"s".repeat(984)}…[28025 characters omitted]…${"s".repeat(991)}</script>`),
  );

  // grep over minified bundles: the last 21 of 30 matches, instead of the last 2.
  const [note, ...shown] = resultText(await runCommand("cat matches.txt", root)).split("\n");

  assert.match(note!, /^\[Output truncated: showing the last 21 of 30 lines\./);
  assert.deepEqual(
    shown,
    matches.slice(9).map((match) => `${match.slice(0, 1_000)}…[${match.length - 2_000} characters omitted]…${match.slice(-1_000)}`),
  );
});

test("long lines of CJK text stay within the byte limit", async () => {
  const root = await tempDir();
  const line = resultText(await runCommand(`${NODE} -e 'process.stdout.write("中".repeat(60000))'`, root));

  // Each end keeps at most 10,000 bytes as well: 3,333 characters of 3 bytes.
  assert.equal(line, `${"中".repeat(3333)}…[53334 characters omitted]…${"中".repeat(3333)}`);
  assert.ok(Buffer.byteLength(line) <= MAX_BYTES);

  // Three bytes a character: the byte limit is reached long before the character limit.
  const many = resultText(await runCommand(`${NODE} -e 'for (let i = 1; i <= 40; i++) console.log(i + " " + "中".repeat(1900))'`, root));
  const [note, ...shown] = many.split("\n");

  assert.match(note!, /^\[Output truncated: showing the last (\d+) of 40 lines\./);
  assert.equal(shown.length, Number(/showing the last (\d+)/.exec(note!)![1]));
  assert.equal(shown.at(-1), `40 ${"中".repeat(1900)}`);
  assert.ok(Buffer.byteLength(shown.join("\n")) <= MAX_BYTES);
  assert.ok(many.length <= MAX_RESULT_CHARS);
});

test("a failed command's long output keeps its beginning and its end, within the error budget", async () => {
  const root = await tempDir();
  const command =
    "echo 'src/a.ts(3,1): error TS2307: Cannot find module ./config'; " +
    'for i in $(seq 2 3000); do echo "src/gen$i.ts(1,1): error TS2304: Cannot find name Config"; done; exit 2';
  const result = await runCommand(command, root);
  const text = resultText(result);
  const note = /^\[Output truncated: showing the first (\d+) and the last (\d+) of 3000 lines; the (\d+) lines in between are left out\./.exec(text);

  assert.equal(result.isError, true);
  assert.ok(text.length <= MAX_ERROR_RESULT_CHARS, `${text.length} characters`);
  assert.ok(note, text.slice(0, 300));

  const [first, last, omitted] = note.slice(1).map(Number) as [number, number, number];
  assert.equal(first + last + omitted, 3000);
  assert.ok(first >= 20 && last >= 80, `${first} first and ${last} last lines`);
  assert.ok(text.includes("\nsrc/a.ts(3,1): error TS2307: Cannot find module ./config\n"), "the root cause on line 1 is kept");
  assert.ok(
    text.includes(
      `\nsrc/gen${first}.ts(1,1): error TS2304: Cannot find name Config\n[… ${omitted} lines left out …]\nsrc/gen${first + omitted + 1}.ts(1,1)`,
    ),
  );
  assert.ok(text.endsWith("\nsrc/gen3000.ts(1,1): error TS2304: Cannot find name Config\n\nCommand exited with code 2."));
});

test("a failed command with more lines than the line limit, though few characters, says which lines it leaves out", async () => {
  const root = await tempDir();
  const text = resultText(await runCommand("for i in $(seq 1 2500); do echo $((i % 10)); done; exit 1", root));
  const note = /^\[Output truncated: showing the first (\d+) and the last (\d+) of 2500 lines; the (\d+) lines in between are left out\./.exec(text);

  assert.ok(note, text.slice(0, 300));

  const [first, last, omitted] = note.slice(1).map(Number) as [number, number, number];
  assert.equal(first + last + omitted, 2500);
  assert.ok(first + last <= 2000 && omitted > 0);
  assert.ok(text.includes(`\n${first % 10}\n[… ${omitted} lines left out …]\n${(first + omitted + 1) % 10}\n`));
});

test("a successful command's long output keeps its end, within the result budget", async () => {
  const root = await tempDir();
  const result = await runCommand("for i in $(seq 1 3000); do printf '%060d\\n' $i; done", root);
  const text = resultText(result);
  const note = /^\[Output truncated: showing the last (\d+) of 3000 lines\. [^\n]*\]\n/.exec(text);

  assert.equal(result.isError, undefined);
  assert.ok(text.length <= MAX_RESULT_CHARS, `${text.length} characters`);
  assert.ok(note, text.slice(0, 300));

  const shown = Number(note[1]);
  const expected = Array.from({ length: shown }, (_, i) => String(3001 - shown + i).padStart(60, "0")).join("\n");
  assert.equal(text.slice(note[0].length), expected);
});

test("output longer than what is kept in memory still shows its first and last lines with the right numbers", async () => {
  const root = await tempDir();
  const failed = resultText(await runCommand("seq 1 300000; exit 1", root));
  const note = /^\[Output truncated: showing the first (\d+) and the last (\d+) of 300000 lines; the (\d+) lines in between are left out\./.exec(failed);

  assert.ok(note, failed.slice(0, 300));
  assert.ok(failed.length <= MAX_ERROR_RESULT_CHARS);

  const [first, last, omitted] = note.slice(1).map(Number) as [number, number, number];
  assert.equal(first + last + omitted, 300000);
  assert.ok(failed.includes("\n1\n2\n3\n"));
  assert.ok(failed.includes(`\n${first}\n[… ${omitted} lines left out …]\n${first + omitted + 1}\n`));
  assert.ok(failed.endsWith("\n300000\n\nCommand exited with code 1."));

  const succeeded = resultText(await runCommand("seq 1 300000", root)).split("\n");
  assert.match(succeeded[0]!, /^\[Output truncated: showing the last 2000 of 300000 lines\./);
  assert.deepEqual(succeeded.slice(1), Array.from({ length: 2000 }, (_, i) => String(298001 + i)));
});

test("a line longer than what is kept in memory shows its real beginning and end, and how many bytes are left out", async () => {
  const root = await tempDir();
  // 3,000,008 bytes in one line: the head buffer holds its beginning, the rolling buffer its end.
  const write = `${NODE} -e 'process.stdout.write("BEGIN" + "x".repeat(3e6) + "END\\n")'`;

  assert.equal(resultText(await runCommand(write, root)), `${PART_OF_LINE_NOTE}\nBEGIN${"x".repeat(9995)}…[2980008 bytes omitted]…${"x".repeat(9997)}END`);
  assert.equal(
    resultText(await runCommand(`${write}; echo done; exit 1`, root)),
    `${PART_OF_LINE_NOTE}\nBEGIN${"x".repeat(995)}…[2998008 bytes omitted]…${"x".repeat(997)}END\ndone\n\nCommand exited with code 1.`,
  );

  // Both buffers cut through a character here; the count still adds up to the line's 3,000,008 bytes.
  const cjk = resultText(await runCommand(`${NODE} -e 'process.stdout.write("BEGIN" + "中".repeat(1e6) + "END\\n")'`, root));
  assert.equal(cjk, `${PART_OF_LINE_NOTE}\nBEGIN${"中".repeat(3331)}…[2980011 bytes omitted]…${"中".repeat(3332)}END`);
  assert.equal(Buffer.byteLength(`BEGIN${"中".repeat(3331)}`) + 2980011 + Buffer.byteLength(`${"中".repeat(3332)}END`), 3000008);
});

test("a line whose beginning was not kept never shows its kept part as its beginning", async () => {
  const root = await tempDir();
  const tenThousand = 'let s = ""; for (let i = 0; i < 10000; i++) s += String(i).padStart(6, "0") + "\\n";';
  const succeeded = await runCommand(`${NODE} -e '${tenThousand} process.stdout.write(s + "BEGIN" + "x".repeat(2e6) + "END\\n")'`, root);

  assert.equal(
    resultText(succeeded),
    `[Output truncated: showing the last 1 of 10001 lines. ${MORE_HINT}]\n…[1980008 bytes before this omitted]…${"x".repeat(19997)}END`,
  );

  const failed = resultText(await runCommand(`${NODE} -e '${tenThousand} process.stdout.write(s + "BEGIN" + "y".repeat(2e6) + "END\\nerror: x\\n")'; exit 1`, root));
  const note = /^\[Output truncated: showing the first (\d+) and the last 2 of 10002 lines; the (\d+) lines in between are left out\./.exec(failed);

  assert.ok(note, failed.slice(0, 300));
  assert.equal(Number(note[1]) + 2 + Number(note[2]), 10002);
  assert.ok(failed.endsWith(`\n[… ${note[2]} lines left out …]\n…[1998008 bytes before this omitted]…${"y".repeat(1997)}END\nerror: x\n\nCommand exited with code 1.`));
});

test("a failed command's first line longer than the head buffer is not shown with a made-up end", async () => {
  const root = await tempDir();
  // Line 1 is 20,008 characters; the head buffer keeps its first 16KB, and 2MB of lines come after it.
  const write = 'let s = "BEGIN" + "a".repeat(10000) + "b".repeat(10000) + "END\\n"; for (let i = 2; i <= 300000; i++) s += i + "\\n"; process.stdout.write(s)';
  const text = resultText(await runCommand(`${NODE} -e '${write}'; exit 1`, root));
  const [top, first, marker] = text.split("\n");
  const note = /^\[Output truncated: showing the first 1 and the last (\d+) of 300000 lines; the (\d+) lines in between are left out\./.exec(top!);

  assert.ok(note, text.slice(0, 300));
  assert.equal(1 + Number(note[1]) + Number(note[2]), 300000);
  assert.equal(first, `BEGIN${"a".repeat(1995)}…[the rest of this line omitted]`);
  assert.equal(marker, `[… ${note[2]} lines left out …]`);
  assert.doesNotMatch(text, /bbbbbbbbbb|END/, "nothing from the end of line 1 or from the middle that was not shown");
  assert.ok(text.length <= MAX_ERROR_RESULT_CHARS);
});

test("a failed command's line that ends where the head buffer ends is not marked as cut", async () => {
  const root = await tempDir();
  // The head buffer keeps the first 16,384 bytes, and more than 1MB follows them.
  const rest = `中文 next line\n${Array.from({ length: 300_000 }, (_, i) => `n${i}`).join("\n")}\n`;
  const files = {
    // The head buffer ends 2 bytes into the 中 that begins line 2, which the decoder holds back.
    "held.txt": `${"A".repeat(16_381)}\n${rest}`,
    // Line 1's "\n" is the first byte after the head buffer, alone or after the \r of a \r\n.
    "next.txt": `${"A".repeat(16_384)}\n${rest}`,
    "crlf.txt": `${"A".repeat(16_383)}\r\n${rest}`,
  };
  await writeTree(root, files);

  for (const [file, content] of Object.entries(files)) {
    const length = content.search(/\r?\n/);

    // Written at once, and with the first 16,384 bytes written alone, so that the byte after them comes in a later chunk.
    for (const write of [`cat ${file}`, `head -c 16384 ${file}; sleep 0.1; tail -c +16385 ${file}`]) {
      const text = resultText(await runCommand(`${write}; exit 1`, root));
      const [top, first, marker] = text.split("\n");
      const note = /^\[Output truncated: showing the first 1 and the last \d+ of 300002 lines; the (\d+) lines in between are left out\./.exec(top!);

      assert.ok(note, text.slice(0, 300));
      assert.equal(first, `${"A".repeat(1_000)}…[${length - 2_000} characters omitted]…${"A".repeat(1_000)}`, write);
      assert.equal(marker, `[… ${note[1]} lines left out …]`);
    }
  }

  // A character held back in the middle of a line does not end it.
  await writeTree(root, { "cut.txt": `${"中".repeat(10_000)}\n${rest}` });
  const cut = resultText(await runCommand("cat cut.txt; exit 1", root));

  assert.equal(cut.split("\n")[1], `${"中".repeat(2_000)}…[the rest of this line omitted]`);
});

test("a progress line longer than what is kept in memory shows its last state whole", async () => {
  const root = await tempDir();
  const write = 'let s = ""; for (let i = 1; i <= 100000; i++) s += "\\rprogress " + i + "/100000"; process.stdout.write(s + "\\ndone\\n")';
  const text = resultText(await runCommand(`${NODE} -e '${write}'`, root));

  // Only redraws were left out, so nothing is marked as cut.
  assert.match(text, /^\[Folded \d+ progress redraws \(text rewritten with \\r\): only the last state of each line is shown\.\]\nprogress 100000\/100000\ndone$/);
});
