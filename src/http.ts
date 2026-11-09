import { STATUS_CODES, type Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCNotification,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { ActivityLog } from "./activity.ts";
import { loadOwnerPassword, type Config } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { OwnerOAuthProvider, SCOPE, type AuthorizationEvent } from "./oauth.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";

/** Largest JSON body accepted on /mcp: a single `write` carries a whole file. */
const MAX_MCP_BODY = "20mb";

/**
 * How long an idle connection stays open. Whatever sits in front of us (an SSH
 * tunnel, or a reverse proxy that pools connections for about 90 s) may reuse
 * an idle connection; with Node's 5 s default it can do so just as Node closes
 * it, and that request fails.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Apply the keep-alive policy to the server running the app. headersTimeout
 * keeps its default: since Node 18 it only limits a request whose headers are
 * still arriving, never an idle connection.
 */
export function configureHttpServer<T extends Server>(server: T): T {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  return server;
}

export interface HttpAppOptions {
  config: Config;
  registry: WorkspaceRegistry;
  /** Receives tool calls, client connections and approvals for the local activity page. */
  activity?: ActivityLog;
}

/**
 * Express app serving the OAuth endpoints and a stateless Streamable HTTP
 * MCP endpoint at /mcp. Every /mcp request needs a bearer token.
 */
export function createHttpApp({ config, registry, activity }: HttpAppOptions) {
  const publicUrl = new URL(config.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);

  const app = express();
  app.disable("x-powered-by");

  // No "trust proxy": requests arrive through the SSH tunnel from sshd on loopback, and nothing in between sets
  // X-Forwarded-For. Trusting it would let any client pick its own address and slip past the OAuth rate limits.

  // Host header allowlist (DNS-rebinding protection): loopback plus the public hostname.
  app.use(hostHeaderValidation([...new Set(["localhost", "127.0.0.1", "[::1]", publicUrl.hostname])]));

  const provider = new OwnerOAuthProvider({
    // Read on every approval, so `clouddev-base password --reset` applies without a restart.
    ownerPassword: () => loadOwnerPassword(config.homeDir),
    resourceUrl: mcpUrl,
    stateDir: config.homeDir,
    allowedRedirectHosts: config.allowedRedirectHosts,
    onAuthorization: activity && ((event) => reportAuthorization(activity, event)),
  });

  // The OAuth endpoints parse their own bodies, with the SDK's default limits.
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: [SCOPE],
    resourceName: "clouddev-base",
  }));

  const requireToken = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  app.get("/healthz", (_req, res) => {
    // The pid lets `service install` and `service status` tell the launchd job from another server on the port.
    res.json({ ok: true, name: "clouddev-base", pid: process.pid });
  });

  const inFlight = new InFlightRequests();

  // The large body limit applies only once the token is verified: anonymous bodies are never parsed.
  app.post("/mcp", requireToken, express.json({ limit: MAX_MCP_BODY }), async (req: Request, res: Response) => {
    const token = req.auth!.token;
    const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];

    activity?.request();

    for (const message of messages) {
      // A cancellation arrives in a POST of its own: hand it to the request it names.
      if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") inFlight.cancel(token, message);

      // initialize means a client just started or reconnected.
      if (activity && isInitializeRequest(message)) {
        activity.clientConnected(message.params.clientInfo, provider.clientName(req.auth!.clientId));
      }
    }

    // Stateless: a fresh server and transport per request. Workspaces live in the shared registry.
    const server = createMcpServer(registry, { activity, clientName: (clientId) => provider.clientName(clientId) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const requestIds = messages.filter(isJSONRPCRequest).map((message) => message.id);

    const untrack = requestIds.map((id) => inFlight.add(token, id, (notification) => {
      if (requestIds.length === 1) {
        // Same as a client disconnect: the tool's AbortSignal fires (bash kills its process group),
        // and the response stream ends instead of waiting for a reply the SDK never sends.
        void transport.close();
      } else {
        // A batch: let the SDK abort only this request; the others still answer on the same stream.
        transport.onmessage?.(notification);
      }
    }));

    res.on("close", () => {
      for (const remove of untrack) remove();
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);

      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless: send JSON-RPC messages with POST." },
      id: null,
    });
  };

  app.get("/mcp", requireToken, methodNotAllowed);
  app.delete("/mcp", requireToken, methodNotAllowed);

  // Errors (mostly from the body parsers: malformed or oversized bodies) get a short JSON reply,
  // never Express's default HTML page with a stack trace and local file paths.
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);

      return;
    }

    const { status, rpcCode, message } = describeError(error);

    if (status >= 500) console.error("HTTP request failed:", error);

    res.status(status).json(req.path === "/mcp"
      ? { jsonrpc: "2.0", error: { code: rpcCode, message }, id: null }
      : { error: status >= 500 ? "server_error" : "invalid_request", error_description: message });
  });

  return { app, mcpUrl };
}

function reportAuthorization(activity: ActivityLog, { outcome, clientName }: AuthorizationEvent): void {
  if (outcome === "approved") activity.notice(`已批准客户端：${clientName}`);
  else if (outcome === "wrong_password") activity.notice(`授权页输入了错误的 Owner 密码（客户端：${clientName}）`, "warn");
  else activity.notice(`授权失败：服务器上没有可用的 Owner 密码（客户端：${clientName}）`, "warn");
}

type CancelRequest = (notification: JSONRPCNotification) => void;

/**
 * How long a finished request's id keeps cancellations for that id ambiguous.
 * Cancellations that race a request's completion arrive well within this.
 */
const FINISHED_REQUEST_MEMORY_MS = 10_000;

/**
 * Requests still being handled on /mcp. Every POST gets its own MCP server, so
 * the SDK alone never routes a `notifications/cancelled` (sent in a later POST)
 * to the request it names; this table does. Keys are bearer token + JSON-RPC
 * id, so a client can only cancel requests made with its own token.
 */
class InFlightRequests {
  private readonly requests = new Map<string, Set<CancelRequest>>();
  /** When a request finished, by key, oldest first. */
  private readonly finished = new Map<string, number>();

  add(token: string, id: RequestId, cancel: CancelRequest): () => void {
    const key = requestKey(token, id);
    let entries = this.requests.get(key);

    if (!entries) this.requests.set(key, (entries = new Set()));
    entries.add(cancel);

    return () => {
      entries.delete(cancel);

      if (entries.size === 0 && this.requests.get(key) === entries) this.requests.delete(key);

      this.rememberFinished(key);
    };
  }

  cancel(token: string, notification: JSONRPCNotification): void {
    const id = notification.params?.requestId;

    if (typeof id !== "string" && typeof id !== "number") return;

    const key = requestKey(token, id);
    const entries = this.requests.get(key);

    if (!entries) return;

    // Two clients sharing one token (say, two Claude Code windows) each number their requests from 0, so
    // the same id can be in flight twice, or a late cancellation for one client's finished request can
    // arrive while the other client's request with that id runs. Guessing could abort the wrong call, which
    // would then never get a reply; leaving it alone only lets a command run until its own timeout.
    const finishedAt = this.finished.get(key);
    const recentlyFinished = finishedAt !== undefined && Date.now() - finishedAt < FINISHED_REQUEST_MEMORY_MS;

    if (entries.size > 1 || recentlyFinished) {
      console.error(
        `Ignored an ambiguous cancellation for id ${JSON.stringify(id)}: ${
          entries.size > 1 ? `${entries.size} requests with this id are in flight` : "a request with this id just finished"
        } for the same token.`,
      );

      return;
    }

    for (const cancel of entries) cancel(notification);
  }

  private rememberFinished(key: string): void {
    const now = Date.now();

    // Re-inserting keeps the map ordered by finish time, so expired entries are always at the front.
    this.finished.delete(key);
    this.finished.set(key, now);

    for (const [oldKey, finishedAt] of this.finished) {
      if (now - finishedAt < FINISHED_REQUEST_MEMORY_MS) break;
      this.finished.delete(oldKey);
    }
  }
}

function requestKey(token: string, id: RequestId): string {
  // The id keeps its type: "1" and 1 are different JSON-RPC ids.
  return `${token}\n${typeof id}:${id}`;
}

/** A short, safe description of an error from the request pipeline (body-parser raises http-errors). */
function describeError(error: unknown): { status: number; rpcCode: number; message: string } {
  const { status, type } = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown; type?: unknown };

  if (typeof status !== "number" || status < 400 || status > 499) {
    return { status: 500, rpcCode: -32603, message: "Internal server error" };
  }

  if (type === "entity.parse.failed") return { status, rpcCode: -32700, message: "Parse error: Invalid JSON" };

  if (type === "entity.too.large") return { status, rpcCode: -32000, message: "Payload Too Large: the request body exceeds the size limit" };

  return { status, rpcCode: -32000, message: STATUS_CODES[status] ?? "Bad Request" };
}
