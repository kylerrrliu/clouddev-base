import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { ActivityLog } from "./activity.ts";

/**
 * The activity page only ever listens here. The SSH tunnel forwards the MCP
 * port alone, so the page cannot be reached from the other computer, and it
 * needs no login.
 */
export const WEBUI_HOST = "127.0.0.1";

/** Shown in the page header. */
export interface WebUiInfo {
  version: string;
  mcpUrl: string;
  allowedRoots: string[];
}

export interface WebUiOptions {
  /** Comment lines that keep idle event streams open. */
  pingIntervalMs?: number;
  /** Open event streams at most; more get 503. */
  maxViewers?: number;
}

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

/** A viewer that stops reading is dropped once this much is waiting for it; its page reconnects and resyncs. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The local activity page: a static page plus a server-sent event stream of
 * what MCP clients are doing. Loopback only; requests naming another host
 * (DNS rebinding) and cross-site API requests are refused.
 */
export function createWebUiApp(activity: ActivityLog, info: WebUiInfo, options: WebUiOptions = {}) {
  const pingIntervalMs = options.pingIntervalMs ?? 15_000;
  const maxViewers = options.maxViewers ?? 16;
  const assets = loadAssets();
  let viewers = 0;

  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");

  app.use(hostHeaderValidation(["localhost", "127.0.0.1", "[::1]"]));

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.set({
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    next();
  });

  // Other sites may link to the page, but never read the data behind it.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "forbidden" });

      return;
    }

    next();
  });

  for (const [path, asset] of Object.entries(assets)) {
    app.get(path, (_req, res) => {
      res.type(asset.type).send(asset.body);
    });
  }

  app.get("/api/snapshot", (_req, res) => {
    res.json({ type: "snapshot", server: info, ...activity.snapshot() });
  });

  app.get("/api/calls/:id", (req, res) => {
    const call = activity.call(Number(req.params.id));

    if (call) res.json(call);
    else res.status(404).json({ error: "not_found" });
  });

  app.get("/api/stream", (req, res) => {
    if (viewers >= maxViewers) {
      res.status(503).json({ error: "too_many_viewers" });

      return;
    }

    viewers++;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");

    // The first event is a full snapshot, so a page that (re)connects never misses anything in between.
    const send = (event: unknown) => writeEvent(res, event);
    send({ type: "snapshot", server: info, ...activity.snapshot() });
    const unsubscribe = activity.subscribe(send);

    const ping = setInterval(() => {
      if (!res.destroyed) res.write(": ping\n\n");
    }, pingIntervalMs);

    res.on("close", () => {
      viewers--;
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);

      return;
    }

    console.error("WebUI request failed:", error);
    res.status(500).json({ error: "server_error" });
  });

  return app;
}

function writeEvent(res: ServerResponse, event: unknown): void {
  if (res.destroyed || res.writableEnded) return;

  if (res.writableLength > MAX_BUFFERED_BYTES) {
    res.destroy();

    return;
  }

  // JSON never contains a raw newline, so the event is always a single data line.
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** The page files live next to this module: src/webui/ when run from source, dist/webui/ once built. */
function loadAssets(): Record<string, { type: string; body: string }> {
  const dir = new URL("./webui/", import.meta.url);

  return Object.fromEntries(Object.entries(ASSETS).map(([path, { file, type }]) => {
    try {
      return [path, { type, body: readFileSync(new URL(file, dir), "utf8") }];
    } catch (error) {
      throw new Error(`找不到 WebUI 文件 ${fileURLToPath(new URL(file, dir))}（从源码安装的话，重新运行 npm run build）: ${(error as Error).message}`);
    }
  }));
}
