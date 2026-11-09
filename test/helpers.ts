import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import type { ActivityEvent, ActivityLog } from "../src/activity.ts";

const created: string[] = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary directory, removed when the test file finishes. */
export async function tempDir(prefix = "clouddev-base-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);

  return dir;
}

/** Create files from a { "relative/path": "content" } map. */
export async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

/** A plain GET with node:http, which (unlike fetch) can send any Host header. */
export function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on("error", reject).end();
  });
}

/** Run `operation` with console.error captured, and return what it printed, one entry per call. */
export async function captureStderr(operation: () => unknown): Promise<string[]> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    await operation();
  } finally {
    console.error = original;
  }

  return lines;
}

/** Every event the activity log sends from now on. */
export function recordEvents(log: ActivityLog): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  log.subscribe((event) => events.push(event));

  return events;
}

export type StreamEvent = { type: string } & Record<string, unknown>;

/** Read server-sent events from a response until `done` says stop. */
export async function readEvents(response: Response, done: (events: StreamEvent[]) => boolean): Promise<StreamEvent[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: StreamEvent[] = [];
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

      if (data) events.push(JSON.parse(data.slice(6)) as StreamEvent);
    }
  }

  await reader.cancel();

  return events;
}

/** The snapshot a WebUI stream starts with. */
export async function firstEvent(streamUrl: string): Promise<StreamEvent> {
  const controller = new AbortController();
  const response = await fetch(streamUrl, { signal: controller.signal });
  const [event] = await readEvents(response, (events) => events.length > 0);
  controller.abort();

  return event!;
}
