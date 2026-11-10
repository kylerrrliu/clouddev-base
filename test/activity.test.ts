import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ActivityLog, MAX_CALLS, MAX_LIVE_OUTPUT_CHARS, MAX_NOTICES, MAX_RECORDED_RESULT_CHARS } from "../src/activity.ts";
import { textResult, type ToolResult } from "../src/tools/common.ts";
import { readPath } from "../src/tools/files.ts";
import { grep } from "../src/tools/search.ts";
import { captureStderr, recordEvents, resultText, tempDir, writeTree } from "./helpers.ts";

test("a call is reported when it starts and when it ends, with its outcome", () => {
  const log = new ActivityLog();
  const events = recordEvents(log);

  const call = log.startCall({ tool: "read", summary: "src/a.ts", args: { workspace_id: "ws_1", path: "src/a.ts" }, workspace: "/w/app", client: "Claude Code" });
  assert.equal(log.snapshot().calls[0]?.status, "running");

  call.finish(textResult("line one\nline two"), false);

  assert.deepEqual(events.map((event) => event.type), ["call.start", "call.end"]);
  const [summary] = log.snapshot().calls;
  assert.equal(summary?.status, "ok");
  assert.equal(summary?.brief, "line one");
  assert.equal(summary?.workspace, "/w/app");
  assert.equal(summary?.client, "Claude Code");
  assert.ok(summary?.endedAt);

  const detail = log.call(call.id);
  assert.deepEqual(detail?.args, { workspace_id: "ws_1", path: "src/a.ts" });
  assert.equal(detail?.output, "line one\nline two");

  // A second finish is ignored.
  call.finish(textResult("again", true), true);
  assert.equal(log.call(call.id)?.status, "ok");
});

test("errors and cancellations are told apart; bash keeps the end of its output", () => {
  const log = new ActivityLog();

  const failed = log.startCall({ tool: "bash", summary: "npm test", args: {}, cancellable: true });
  failed.finish(textResult("1 failing\n\nCommand exited with code 1.", true), false);

  const cancelled = log.startCall({ tool: "bash", summary: "sleep 100", args: {}, cancellable: true });
  cancelled.finish(textResult("Command was cancelled.", true), true);

  const [first, second] = log.snapshot().calls;
  assert.equal(first?.status, "error");
  assert.equal(first?.brief, "Command exited with code 1.", "bash shows its last line");
  assert.equal(second?.status, "cancelled");

  const long = log.startCall({ tool: "bash", summary: "yes", args: {} });
  long.finish(textResult(`${"x".repeat(MAX_RECORDED_RESULT_CHARS)}THE END`), false);
  const kept = log.call(long.id)!;
  assert.ok(kept.output.endsWith("THE END"));
  assert.equal(kept.output.length, MAX_RECORDED_RESULT_CHARS);
  assert.equal(kept.outputTruncated, true);

  const read = log.startCall({ tool: "read", summary: "big.txt", args: {} });
  read.finish(textResult(`START${"y".repeat(MAX_RECORDED_RESULT_CHARS)}`), false);
  assert.ok(log.call(read.id)!.output.startsWith("START"), "other tools keep the beginning");
});

test("a result that starts with notes is summed up by its first line of content", async () => {
  const log = new ActivityLog();
  const briefOf = (tool: string, result: ToolResult) => {
    const call = log.startCall({ tool, summary: tool, args: {} });
    call.finish(result, false);

    return log.call(call.id)?.brief;
  };

  // grep and read as they really answer: notes, a blank line, then the matches or the file's lines.
  const root = await realpath(await tempDir());
  await writeTree(root, {
    "logo.bin": Buffer.from([0, 1, 2]),
    "src/app.ts": "export const needle = 1;\n",
    "long.txt": Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"),
  });

  const searched = await grep(root, root, { pattern: "needle", maxResults: 10 });
  assert.match(resultText(searched), /^\[Not searched: 1 binary file\.\]\n\n/);
  assert.equal(briefOf("grep", searched), "src/app.ts:1:export const needle = 1;");

  const paged = await readPath(join(root, "long.txt"), "long.txt");
  assert.match(resultText(paged), /^\[Showing lines 1-2000 of 2500\./);
  assert.equal(briefOf("read", paged), "line 1");

  assert.equal(briefOf("glob", textResult("[Showing 2 of 9 files. Use a more specific pattern or path.]\n[Only the first 5 files were considered.]\n\n\n  src/a.ts\nsrc/b.ts")), "src/a.ts");
  // Without a blank line after it, a bracketed first line is content: a TOML table read from a file, say.
  assert.equal(briefOf("read", textResult("[package]\nname = \"demo\"\n\n[dependencies]")), "[package]");
  // Nothing after the notes: they are all there is to show.
  assert.equal(briefOf("glob", textResult("[Only the first 5 files were considered.]\n\n")), "[Only the first 5 files were considered.]");
  // bash is still summed up by its last line.
  assert.equal(briefOf("bash", textResult("[Output truncated: showing the last 2 of 9 lines.]\n\nok 9\nall passed\n")), "all passed");
});

test("a tool that finishes despite a cancel keeps its outcome and is marked as not delivered", () => {
  const log = new ActivityLog();

  const written = log.startCall({ tool: "write", summary: "a.txt", args: {} });
  written.finish(textResult("Overwrote a.txt (21B)."), true);
  const refused = log.startCall({ tool: "write", summary: "dir", args: {} });
  refused.finish(textResult("dir is a directory.", true), true);

  const [first, second] = log.snapshot().calls;
  assert.equal(first?.status, "ok", "the file was written");
  assert.equal(first?.undelivered, true);
  assert.equal(second?.status, "error", "an error stays an error");
  assert.equal(second?.undelivered, true);
});

test("calls the server refused before running them are listed as errors", () => {
  const log = new ActivityLog();
  const events = recordEvents(log);

  log.rejectedCall({ tool: "bash", args: { workspace_id: "ws_1", command: "make test", timeout: 600 }, client: "Claude Code", message: "Input validation error: timeout must be at most 300" });

  assert.deepEqual(events.map((event) => event.type), ["call.end"]);
  const [call] = log.snapshot().calls;
  assert.equal(call?.status, "error");
  assert.equal(call?.summary, "make test");
  assert.equal(call?.client, "Claude Code");
  assert.match(call?.brief ?? "", /timeout must be at most 300/);
});

test("live output is batched, capped and visible in snapshots while the call runs", async () => {
  const log = new ActivityLog();
  const events = recordEvents(log);
  const call = log.startCall({ tool: "bash", summary: "npm test", args: {} });

  call.output("one\n");
  call.output("two\n");
  assert.equal(events.filter((event) => event.type === "call.output").length, 0, "output is sent in batches");
  assert.equal(log.snapshot().live[call.id], "one\ntwo\n");

  await delay(400);
  assert.deepEqual(events.filter((event) => event.type === "call.output"), [{ type: "call.output", id: call.id, text: "one\ntwo\n" }]);

  // Each batch carries the whole output so far, cut to its end when long.
  call.output("z".repeat(3 * MAX_LIVE_OUTPUT_CHARS));
  call.output("THE END");
  await delay(400);
  const last = events.at(-1);
  assert.ok(last?.type === "call.output" && last.text.length === MAX_LIVE_OUTPUT_CHARS && last.text.endsWith("THE END"));
  assert.equal(log.snapshot().live[call.id], last.text);
  assert.equal(log.call(call.id)?.outputTruncated, true);

  call.finish(textResult("done"), false);
  call.output("late");
  await delay(400);
  assert.equal(events.at(-1)?.type, "call.end", "nothing is sent after the end");
  assert.equal(log.snapshot().live[call.id], undefined);
});

test("a viewer that joins between batches shows exactly what the server has", async () => {
  const log = new ActivityLog();
  const call = log.startCall({ tool: "bash", summary: "npm test", args: {} });

  call.output("line 1\n");
  await delay(400);
  call.output("line 2\n");

  // What the WebUI does on (re)connect: take a snapshot, subscribe, then apply events the way app.js does.
  let shown = log.snapshot().live[call.id] ?? "";
  log.subscribe((event) => {
    if (event.type === "call.output" && event.id === call.id) shown = event.text;
  });

  call.output("line 3\n");
  await delay(400);
  assert.equal(shown, "line 1\nline 2\nline 3\n");
  assert.equal(shown, log.call(call.id)!.output);
  call.finish(textResult("done"), false);
});

test("only the newest calls are kept, and running calls are never dropped", () => {
  const log = new ActivityLog();
  const running = log.startCall({ tool: "bash", summary: "a long build", args: {} });

  for (let i = 0; i < MAX_CALLS + 20; i++) {
    log.startCall({ tool: "read", summary: `file-${i}`, args: {} }).finish(textResult("ok"), false);
  }

  const { calls, limits } = log.snapshot();
  assert.equal(calls.length, MAX_CALLS);
  assert.equal(calls[0]?.id, running.id, "the running call is still there");
  assert.equal(calls.at(-1)?.summary, `file-${MAX_CALLS + 19}`);
  assert.equal(log.call(2), undefined, "the oldest finished calls are gone");
  assert.deepEqual(limits, { calls: MAX_CALLS, notices: MAX_NOTICES }, "the page learns the limits from the snapshot");
});

test("long arguments are cut, and multi-line commands fit on one line", () => {
  const log = new ActivityLog();
  const call = log.startCall({
    tool: "write",
    summary: "echo a\necho b",
    args: { path: "big.txt", content: "c".repeat(20_000), edits: Array.from({ length: 150 }, () => ({ old_text: "o".repeat(20_000), new_text: "n" })) },
  });

  const detail = log.call(call.id)!;
  assert.equal(detail.summary, "echo a ⏎ echo b");
  assert.ok((detail.args.content as string).length < 9000);
  assert.match(detail.args.content as string, /后面还有 11808 个字符/);
  const edits = detail.args.edits as Array<{ old_text: string }>;
  assert.equal(edits.length, 100, "long arrays keep their first items");
  assert.ok(edits[0]!.old_text.length < 9000);
});

test("a huge command with long runs of spaces is summarised quickly", () => {
  const log = new ActivityLog();
  const started = performance.now();
  const call = log.startCall({ tool: "bash", summary: `echo a${" ".repeat(300_000)}b\necho c`, args: {} });

  assert.ok(performance.now() - started < 500, "the summary must not take time that grows with the square of the input");
  const { summary } = log.call(call.id)!;
  assert.ok(summary.startsWith("echo a "));
  assert.ok(summary.length <= 500);
});

test("a failing viewer cannot break a tool call", async () => {
  const log = new ActivityLog();
  let events: ReturnType<typeof recordEvents> = [];

  const printed = await captureStderr(() => {
    log.subscribe(() => {
      throw new Error("viewer bug");
    });
    events = recordEvents(log);

    const call = log.startCall({ tool: "glob", summary: "*.ts", args: {} });
    call.finish(textResult("a.ts"), false);
  });

  assert.deepEqual(events.map((event) => event.type), ["call.start", "call.end"]);
  assert.match(printed.join("\n"), /viewer bug/);
});

test("requests, client connections and notices are recorded", () => {
  const log = new ActivityLog();
  const events = recordEvents(log);

  log.request(1_000);
  log.request(1_500);
  log.request(2_100);
  assert.deepEqual(events.filter((event) => event.type === "request").map((event) => event.type === "request" && event.at), [1_000, 2_100]);
  assert.equal(log.snapshot().lastRequestAt, 2_100);

  log.clientConnected({ name: "claude-code", version: "2.1.0" }, "Claude Code (clouddev-base)");
  log.notice("someone typed a wrong password", "warn");

  const snapshot = log.snapshot();
  assert.equal(snapshot.client?.name, "claude-code");
  assert.equal(snapshot.client?.label, "Claude Code (clouddev-base)");
  assert.deepEqual(snapshot.notices.map((notice) => notice.level), ["info", "warn"]);
  assert.match(snapshot.notices[0]!.message, /Claude Code \(clouddev-base\) 已连接（claude-code 2\.1\.0）/);
});
