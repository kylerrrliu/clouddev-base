import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ActivityLog } from "../src/activity.ts";
import { textResult } from "../src/tools/common.ts";
import { createWebUiApp } from "../src/webui.ts";

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

/** A plain GET with node:http, which (unlike fetch) can send any Host header. */
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    request(`${base}${path}`, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on("error", reject).end();
  });
}

/** Read server-sent events until `done` says stop. */
async function readEvents(response: Response, done: (events: Array<{ type: string } & Record<string, unknown>>) => boolean) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  let buffer = "";

  while (!done(events)) {
    const { value, done: ended } = await reader.read();

    if (ended) break;

    buffer += value;
    let end: number;

    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));

      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }

  await reader.cancel();

  return events;
}

test("serves the page with a strict content security policy", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"] ?? "", /text\/html/);
  assert.match(page.body, /clouddev-base/);
  assert.match(String(page.headers["content-security-policy"]), /default-src 'none'.*script-src 'self'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["x-powered-by"], undefined);

  assert.match((await get("/app.js")).headers["content-type"] ?? "", /javascript/);
  assert.match((await get("/app.css")).headers["content-type"] ?? "", /text\/css/);
  assert.equal((await get("/nope")).status, 404);
});

test("refuses other host names (DNS rebinding) and cross-site reads", async () => {
  assert.equal((await get("/", { host: "evil.example" })).status, 403);
  assert.equal((await get("/api/snapshot", { host: "evil.example:7677" })).status, 403);
  assert.equal((await get("/api/snapshot", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await get("/api/snapshot", { "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await get("/", { host: "localhost" })).status, 200);
});

test("the snapshot and call details reflect the activity log", async () => {
  const call = activity.startCall({ tool: "edit", summary: "src/a.ts", args: { path: "src/a.ts", edits: [{ old_text: "a", new_text: "b" }] } });
  call.finish(textResult("Edited src/a.ts (+1 -1 lines)."), false);

  const snapshot = JSON.parse((await get("/api/snapshot")).body) as { server: typeof INFO; calls: Array<{ id: number; status: string }> };
  assert.deepEqual(snapshot.server, INFO);
  assert.equal(snapshot.calls.find((item) => item.id === call.id)?.status, "ok");

  const detail = JSON.parse((await get(`/api/calls/${call.id}`)).body) as { args: { edits: unknown[] }; output: string };
  assert.equal(detail.args.edits.length, 1);
  assert.equal(detail.output, "Edited src/a.ts (+1 -1 lines).");

  assert.equal((await get("/api/calls/999999")).status, 404);
  assert.equal((await get("/api/calls/not-a-number")).status, 404);
});

test("the event stream starts with a snapshot, then follows calls and their live output", async () => {
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
