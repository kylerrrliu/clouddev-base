import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ActivityLog, MAX_CALLS, MAX_LIVE_OUTPUT_CHARS, MAX_RESULT_CHARS, type ActivityEvent } from "../src/activity.ts";
import { textResult } from "../src/tools/common.ts";

function record(log: ActivityLog): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  log.subscribe((event) => events.push(event));

  return events;
}

test("a call is reported when it starts and when it ends, with its outcome", () => {
  const log = new ActivityLog();
  const events = record(log);

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

  const failed = log.startCall({ tool: "bash", summary: "npm test", args: {} });
  failed.finish(textResult("1 failing\n\nCommand exited with code 1.", true), false);

  const cancelled = log.startCall({ tool: "bash", summary: "sleep 100", args: {} });
  cancelled.finish(textResult("Command was cancelled.", true), true);

  const [first, second] = log.snapshot().calls;
  assert.equal(first?.status, "error");
  assert.equal(first?.brief, "Command exited with code 1.", "bash shows its last line");
  assert.equal(second?.status, "cancelled");

  const long = log.startCall({ tool: "bash", summary: "yes", args: {} });
  long.finish(textResult(`${"x".repeat(MAX_RESULT_CHARS)}THE END`), false);
  const kept = log.call(long.id)!;
  assert.ok(kept.output.endsWith("THE END"));
  assert.equal(kept.output.length, MAX_RESULT_CHARS);
  assert.equal(kept.outputTruncated, true);

  const read = log.startCall({ tool: "read", summary: "big.txt", args: {} });
  read.finish(textResult(`START${"y".repeat(MAX_RESULT_CHARS)}`), false);
  assert.ok(log.call(read.id)!.output.startsWith("START"), "other tools keep the beginning");
});

test("live output is batched, capped and visible in snapshots while the call runs", async () => {
  const log = new ActivityLog();
  const events = record(log);
  const call = log.startCall({ tool: "bash", summary: "npm test", args: {} });

  call.output("one\n");
  call.output("two\n");
  assert.equal(events.filter((event) => event.type === "call.output").length, 0, "output is sent in batches");
  assert.equal(log.snapshot().live[call.id], undefined, "text still waiting for its batch is not in snapshots yet");

  await delay(400);
  const batches = events.filter((event) => event.type === "call.output");
  assert.deepEqual(batches, [{ type: "call.output", id: call.id, text: "one\ntwo\n", replace: false }]);
  assert.equal(log.snapshot().live[call.id], "one\ntwo\n");

  // More than a batch can carry: the kept tail replaces what viewers have.
  call.output("z".repeat(MAX_LIVE_OUTPUT_CHARS + 10));
  await delay(400);
  const last = events.at(-1);
  assert.equal(last?.type, "call.output");
  assert.ok(last?.type === "call.output" && last.replace && last.text.length === MAX_LIVE_OUTPUT_CHARS);
  assert.equal(log.call(call.id)?.outputTruncated, true);

  call.finish(textResult("done"), false);
  call.output("late");
  await delay(400);
  assert.equal(events.at(-1)?.type, "call.end", "nothing is sent after the end");
  assert.equal(log.snapshot().live[call.id], undefined);
});

test("a viewer that joins between batches sees each piece of output exactly once", async () => {
  const log = new ActivityLog();
  const call = log.startCall({ tool: "bash", summary: "npm test", args: {} });

  call.output("line 1\n");
  await delay(400);
  call.output("line 2\n");

  // What the WebUI does on (re)connect: take a snapshot, subscribe, then apply events the way app.js does.
  let shown = log.snapshot().live[call.id] ?? "";
  log.subscribe((event) => {
    if (event.type === "call.output" && event.id === call.id) shown = event.replace ? event.text : shown + event.text;
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

  const { calls } = log.snapshot();
  assert.equal(calls.length, MAX_CALLS);
  assert.equal(calls[0]?.id, running.id, "the running call is still there");
  assert.equal(calls.at(-1)?.summary, `file-${MAX_CALLS + 19}`);
  assert.equal(log.call(2), undefined, "the oldest finished calls are gone");
});

test("long arguments are cut, and multi-line commands fit on one line", () => {
  const log = new ActivityLog();
  const call = log.startCall({
    tool: "write",
    summary: "echo a\necho b",
    args: { path: "big.txt", content: "c".repeat(20_000), edits: [{ old_text: "o".repeat(20_000), new_text: "n" }] },
  });

  const detail = log.call(call.id)!;
  assert.equal(detail.summary, "echo a ⏎ echo b");
  assert.ok((detail.args.content as string).length < 9000);
  assert.match(detail.args.content as string, /后面还有 11808 个字符/);
  assert.ok(((detail.args.edits as Array<{ old_text: string }>)[0]!.old_text).length < 9000);
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

test("a failing viewer cannot break a tool call", () => {
  const log = new ActivityLog();
  const original = console.error;
  console.error = () => {};

  try {
    log.subscribe(() => {
      throw new Error("viewer bug");
    });
    const events = record(log);

    const call = log.startCall({ tool: "glob", summary: "*.ts", args: {} });
    call.finish(textResult("a.ts"), false);

    assert.deepEqual(events.map((event) => event.type), ["call.start", "call.end"]);
  } finally {
    console.error = original;
  }
});

test("requests, client connections and notices are recorded", () => {
  const log = new ActivityLog();
  const events = record(log);

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
