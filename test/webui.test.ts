import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ActivityLog } from "../src/activity.ts";
import { textResult } from "../src/tools/common.ts";
import { createWebUiApp, WEBUI_NAME } from "../src/webui.ts";
import { firstEvent, httpGet, readEvents } from "./helpers.ts";

const INFO = { version: "9.9.9", mcpUrl: "http://127.0.0.1:7676/mcp", allowedRoots: ["/w"] };

let activity: ActivityLog;
let server: Server;
let base: string;

before(async () => {
  activity = new ActivityLog();
  server = createServer(createWebUiApp(activity, INFO, { pingIntervalMs: 50, maxViewers: 2 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const get = (path: string, headers: Record<string, string> = {}) => httpGet(`${base}${path}`, headers);

test("serves the page with a strict content security policy", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"] ?? "", /text\/html/);
  assert.match(page.body, /clouddev-base/);
  assert.match(String(page.headers["content-security-policy"]), /default-src 'none'.*script-src 'self'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["x-powered-by"], undefined);
  assert.equal(page.headers["cache-control"], "no-store");

  assert.match((await get("/app.js")).headers["content-type"] ?? "", /javascript/);
  assert.match((await get("/app.css")).headers["content-type"] ?? "", /text\/css/);
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await get("/api/snapshot")).status, 404, "the page gets its snapshot from the event stream");
});

test("refuses other host names (DNS rebinding) and cross-site reads", async () => {
  assert.equal((await get("/", { host: "evil.example" })).status, 403);
  assert.equal((await get("/api/health", { host: "evil.example:7677" })).status, 403);
  assert.equal((await get("/api/health", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await get("/api/health", { "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await get("/", { host: "localhost" })).status, 200);
});

test("/api/health names the page and its process", async () => {
  assert.deepEqual(JSON.parse((await get("/api/health")).body), { name: WEBUI_NAME, pid: process.pid });
});

test("the snapshot and call details reflect the activity log", async () => {
  const call = activity.startCall({ tool: "edit", summary: "src/a.ts", args: { path: "src/a.ts", edits: [{ old_text: "a", new_text: "b" }] } });
  call.finish(textResult("Edited src/a.ts (+1 -1 lines)."), false);

  const snapshot = (await firstEvent(`${base}/api/stream`)) as unknown as { type: string; server: typeof INFO; calls: Array<{ id: number; status: string }>; limits: unknown };
  assert.equal(snapshot.type, "snapshot");
  assert.deepEqual(snapshot.server, INFO);
  assert.equal(snapshot.calls.find((item) => item.id === call.id)?.status, "ok");
  assert.ok(snapshot.limits);

  const detail = JSON.parse((await get(`/api/calls/${call.id}`)).body) as { args: { edits: unknown[] }; output: string };
  assert.equal(detail.args.edits.length, 1);
  assert.equal(detail.output, "Edited src/a.ts (+1 -1 lines).");

  assert.equal((await get("/api/calls/999999")).status, 404);
  assert.equal((await get("/api/calls/not-a-number")).status, 404);
});

test("the event stream starts with a snapshot, then follows calls and their live output", async () => {
  // Let the server notice that the stream of the previous test was closed.
  await delay(200);

  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  let call: ReturnType<ActivityLog["startCall"]> | undefined;
  const events = await readEvents(response, (seen) => {
    // Once the snapshot is in, start a call; it streams output and finishes.
    if (seen.length === 1 && !call) {
      call = activity.startCall({ tool: "bash", summary: "npm test", args: { command: "npm test" } });
      call.output("running tests…\n");
      setTimeout(() => call!.finish(textResult("all passed"), false), 400);
    }

    return seen.some((event) => event.type === "call.end");
  });
  controller.abort();

  assert.deepEqual(events.map((event) => event.type), ["snapshot", "call.start", "call.output", "call.end"]);
  assert.equal(events[2]!.text, "running tests…\n");
  assert.equal((events[3]!.call as { status: string }).status, "ok");
});

test("too many open pages are turned away", async () => {
  // Let the server notice that the stream of the previous test was closed.
  await delay(200);

  const controllers = [new AbortController(), new AbortController()];
  const open = await Promise.all(controllers.map((controller) => fetch(`${base}/api/stream`, { signal: controller.signal })));
  assert.deepEqual(open.map((response) => response.status), [200, 200]);

  assert.equal((await get("/api/stream")).status, 503);

  for (const controller of controllers) controller.abort();
});
