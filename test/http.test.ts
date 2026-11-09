import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ActivityLog, type ActivityEvent } from "../src/activity.ts";
import { ownerPasswordPath, writeJsonPrivate, type Config } from "../src/config.ts";
import { configureHttpServer, createHttpApp, KEEP_ALIVE_TIMEOUT_MS } from "../src/http.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import { resultText, tempDir } from "./helpers.ts";

const PASSWORD = "correct-horse-battery-staple";
const REDIRECT_URI = "http://localhost:9999/callback";
const ENV_PASSWORD = process.env.CLOUDDEV_BASE_PASSWORD;

let httpServer: Server;
let base: string;
let projectRoot: string;
let homeDir: string;
let activity: ActivityLog;

before(async () => {
  // The app reads the Owner password from auth.json, and an environment value would take precedence.
  delete process.env.CLOUDDEV_BASE_PASSWORD;

  projectRoot = await tempDir();
  homeDir = await tempDir();
  setOwnerPassword(PASSWORD);

  httpServer = configureHttpServer(createServer());
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const config: Config = {
    homeDir,
    allowedRoots: [projectRoot],
    host: "127.0.0.1",
    port: 0,
    publicUrl: base,
    allowedRedirectHosts: ["example.com"],
    uiPort: 0,
    serviceEnv: [],
  };

  activity = new ActivityLog();
  const { app } = createHttpApp({ config, registry: new WorkspaceRegistry([projectRoot]), activity });
  httpServer.on("request", app);
});

after(() => {
  if (ENV_PASSWORD === undefined) delete process.env.CLOUDDEV_BASE_PASSWORD;
  else process.env.CLOUDDEV_BASE_PASSWORD = ENV_PASSWORD;

  httpServer.closeAllConnections();
  httpServer.close();
});

/** What `clouddev-base init` and `password --reset` do: write auth.json. */
function setOwnerPassword(password: string): void {
  writeJsonPrivate(ownerPasswordPath(homeDir), { ownerPassword: password });
}

function form(values: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString(), redirect: "manual" };
}

async function registerClient(redirectUri = REDIRECT_URI): Promise<Response> {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Host",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

/** Run the browser part of the OAuth flow and return the tokens. */
async function authorize(clientId: string, password = PASSWORD) {
  const verifier = randomBytes(32).toString("base64url");
  const authParams = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "state-123",
    resource: `${base}/mcp`,
  };

  const page = await fetch(`${base}/authorize?${new URLSearchParams(authParams)}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Owner 密码/);
  assert.match(html, /Test Host/);
  assert.match(html, /localhost:9999/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const approved = await fetch(`${base}/authorize`, form({ ...authParams, owner_password: password }));

  if (approved.status !== 302) return { status: approved.status };

  const location = new URL(approved.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), "state-123");

  const tokenResponse = await fetch(`${base}/token`, form({
    grant_type: "authorization_code",
    code: location.searchParams.get("code")!,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    resource: `${base}/mcp`,
  }));
  assert.equal(tokenResponse.status, 200);

  return { status: 302, tokens: (await tokenResponse.json()) as { access_token: string; refresh_token: string; scope: string } };
}

/** Register and approve a new client, and return its access token. */
async function accessToken(): Promise<string> {
  const { client_id } = (await (await registerClient()).json()) as { client_id: string };
  const { tokens } = await authorize(client_id);
  assert.ok(tokens);

  return tokens.access_token;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));

  return client;
}

async function openWorkspace(client: Client): Promise<string> {
  const opened = await client.callTool({ name: "open_workspace", arguments: { path: projectRoot } });
  const workspaceId = /workspace_id: (ws_\w+)/.exec(resultText(opened as never))?.[1];
  assert.ok(workspaceId);

  return workspaceId;
}

/** POST a raw JSON-RPC message (or a raw string body) to /mcp, the way a Streamable HTTP client does. */
function postMcp(token: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

/** A plain GET with node:http, which (unlike fetch) can send any Host header. */
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Parse an error response, checking that it is brief JSON without stack traces or local paths. */
async function shortJson(response: Response): Promise<Record<string, unknown>> {
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  const text = await response.text();
  assert.ok(text.length < 300, text);
  assert.doesNotMatch(text, /node_modules|\n\s+at |\\n\s+at /);
  assert.ok(!text.includes(process.cwd()) && !text.includes(homedir()), text);

  return JSON.parse(text) as Record<string, unknown>;
}

/** A bash command that runs until it is killed. The shell and its background sleep first write their PIDs to `file`. */
function longCommand(file: string): string {
  return `sleep 120 & echo "$$ $!" > ${file}.tmp && mv ${file}.tmp ${file}; wait`;
}

/** Wait until a longCommand() has written its PIDs, i.e. until it is really running. */
async function runningPids(file: string): Promise<number[]> {
  let pids: number[] = [];

  await waitFor(`${file} to be written`, async () => {
    pids = (await readFile(join(projectRoot, file), "utf8").catch(() => "")).trim().split(" ").map(Number);

    return pids.length === 2 && pids.every((pid) => Number.isInteger(pid) && pid > 0);
  });

  return pids;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Don't leave a two-minute sleep behind when a test fails before its command is stopped. */
function killLeftovers(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, as it should be.
    }
  }
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await delay(25);
  }
}

test("publishes OAuth discovery metadata", async () => {
  type Metadata = Record<string, unknown>;
  const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Metadata;
  assert.equal(resource.resource, `${base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${base}/`]);

  const server = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Metadata;
  assert.equal(server.authorization_endpoint, `${base}/authorize`);
  assert.equal(server.registration_endpoint, `${base}/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
});

test("/mcp rejects requests without a valid token and points to the metadata", async () => {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);

  const bogus = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
  assert.equal(bogus.status, 401);
});

test("client registration only accepts known redirect hosts", async () => {
  assert.equal((await registerClient("https://evil.example/callback")).status, 400);
  assert.equal((await registerClient("https://example.com/callback")).status, 201);
  assert.equal((await registerClient()).status, 201);
});

test("the wrong Owner password is refused", async () => {
  const { client_id } = (await (await registerClient()).json()) as { client_id: string };
  const result = await authorize(client_id, "wrong-password-wrong-password");

  assert.equal(result.status, 401);
});

test("Owner password changes apply to the running server without a restart", async () => {
  const { client_id } = (await (await registerClient()).json()) as { client_id: string };
  const rotated = "a-freshly-reset-owner-password";
  const fromEnv = "an-owner-password-from-the-environment";

  try {
    setOwnerPassword(rotated);
    assert.equal((await authorize(client_id)).status, 401);
    assert.equal((await authorize(client_id, rotated)).status, 302);

    // CLOUDDEV_BASE_PASSWORD takes precedence over auth.json.
    process.env.CLOUDDEV_BASE_PASSWORD = fromEnv;
    assert.equal((await authorize(client_id, rotated)).status, 401);
    assert.equal((await authorize(client_id, fromEnv)).status, 302);
    delete process.env.CLOUDDEV_BASE_PASSWORD;

    // Without any password, approval is refused rather than opened up.
    await rm(ownerPasswordPath(homeDir));
    assert.equal((await authorize(client_id, "")).status, 503);
    assert.equal((await authorize(client_id, rotated)).status, 503);
  } finally {
    delete process.env.CLOUDDEV_BASE_PASSWORD;
    setOwnerPassword(PASSWORD);
  }
});

test("full flow: approve, call tools over Streamable HTTP, refresh the token", async () => {
  const { client_id } = (await (await registerClient()).json()) as { client_id: string };
  const { tokens } = await authorize(client_id);
  assert.ok(tokens);
  assert.equal(tokens.scope, "clouddev-base");

  const client = await connect(tokens.access_token);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);

  const workspace_id = await openWorkspace(client);
  const ran = await client.callTool({ name: "bash", arguments: { workspace_id, command: "echo over-http" } });
  assert.equal(resultText(ran as never), "over-http");

  // Bodies above express.json()'s 100KB default must still get through once authenticated.
  const wrote = await client.callTool({ name: "write", arguments: { workspace_id, path: "big.txt", content: "x".repeat(300 * 1024) } });
  assert.equal(resultText(wrote as never), "Created big.txt (300.0KB).");
  await client.close();

  // Refresh tokens rotate: the new one works, the old one is spent.
  const refreshed = await fetch(`${base}/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }));
  assert.equal(refreshed.status, 200);
  const next = (await refreshed.json()) as { access_token: string };
  assert.notEqual(next.access_token, tokens.access_token);

  const reused = await fetch(`${base}/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }));
  assert.equal(reused.status, 400);
});

test("request bodies are parsed only after authentication, and errors are short JSON", async () => {
  // No token: refused before the body is read, so even malformed JSON gets a 401.
  const anonymous = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(anonymous.status, 401);
  await shortJson(anonymous);

  // The OAuth endpoints keep the SDK's own 100KB limit.
  const oversized = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "x".repeat(300 * 1024), redirect_uris: [REDIRECT_URI] }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await shortJson(oversized)).error, "invalid_request");

  // With a token, a malformed body gets a JSON-RPC parse error.
  const malformed = await postMcp(await accessToken(), "{oops");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("x-powered-by"), null);
  assert.deepEqual(await shortJson(malformed), { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null });
});

test("cancelling a bash call over HTTP kills the command", async () => {
  const client = await connect(await accessToken());
  const workspace_id = await openWorkspace(client);
  const controller = new AbortController();
  const outcome = client.callTool(
    { name: "bash", arguments: { workspace_id, command: longCommand("sdk-cancel.pids"), timeout: 300 } },
    undefined,
    { signal: controller.signal },
  ).then(() => "finished", () => "rejected");
  let pids: number[] = [];

  try {
    pids = await runningPids("sdk-cancel.pids");
    assert.ok(pids.every(isRunning));

    // The SDK sends notifications/cancelled in a separate POST, which reaches a fresh server instance.
    controller.abort("the user pressed Esc");
    assert.equal(await outcome, "rejected");
    await waitFor("the cancelled command to exit", () => !pids.some(isRunning));
  } finally {
    killLeftovers(pids);
    await client.close();
  }
});

test("only the token that started a request can cancel it, and its response stream then ends", async () => {
  const owner = await accessToken();
  const stranger = await accessToken();
  const setup = await connect(owner);
  const workspace_id = await openWorkspace(setup);
  await setup.close();

  const call = await postMcp(owner, {
    jsonrpc: "2.0",
    id: "long-1",
    method: "tools/call",
    params: { name: "bash", arguments: { workspace_id, command: longCommand("token-cancel.pids"), timeout: 300 } },
  }, AbortSignal.timeout(15_000));
  assert.equal(call.status, 200);
  let pids: number[] = [];

  try {
    pids = await runningPids("token-cancel.pids");
    const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "long-1", reason: "test" } };

    assert.equal((await postMcp(stranger, cancel)).status, 202);
    await delay(200);
    assert.ok(pids.every(isRunning), "a cancellation sent with another token must not reach the command");

    assert.equal((await postMcp(owner, cancel)).status, 202);
    await waitFor("the cancelled command to exit", () => !pids.some(isRunning));

    // No reply is sent for a cancelled request, so its stream has to end instead of hanging.
    assert.doesNotMatch(await call.text(), /"result"/);
  } finally {
    killLeftovers(pids);
  }
});

test("a cancellation that matches two in-flight requests is ignored", async () => {
  // Two clients sharing a token (say, two Claude Code windows) can both have id 7 in flight.
  const token = await accessToken();
  const setup = await connect(token);
  const workspace_id = await openWorkspace(setup);
  await setup.close();

  const disconnect = new AbortController();
  const start = (file: string) => postMcp(token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "bash", arguments: { workspace_id, command: longCommand(file), timeout: 300 } },
  }, disconnect.signal);
  await Promise.all([start("dup-a.pids"), start("dup-b.pids")]);
  let pids: number[] = [];

  try {
    pids = [...await runningPids("dup-a.pids"), ...await runningPids("dup-b.pids")];

    assert.equal((await postMcp(token, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })).status, 202);
    await delay(200);
    assert.ok(pids.every(isRunning), "an ambiguous cancellation must not kill either command");

    // Disconnecting still stops both.
    disconnect.abort();
    await waitFor("both commands to exit after the disconnect", () => !pids.some(isRunning));
  } finally {
    disconnect.abort();
    killLeftovers(pids);
  }
});

test("idle connections stay open for 5 minutes, longer than reverse proxies keep them", async () => {
  assert.equal(httpServer.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);

  // Node advertises the idle timeout it enforces (5 s by default).
  const { headers } = await get("/healthz");
  assert.equal(headers["keep-alive"], "timeout=300");
  assert.equal(headers["x-powered-by"], undefined);
});

test("/healthz names the process, and X-Forwarded-For cannot dodge the OAuth rate limits", async () => {
  const health = (await (await fetch(`${base}/healthz`)).json()) as { name: string; pid: number };
  assert.equal(health.name, "clouddev-base");
  assert.equal(health.pid, process.pid);

  // A server of its own, so these registrations do not use up the shared server's allowance.
  const server = configureHttpServer(createServer());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: Config = { homeDir: await tempDir(), allowedRoots: [projectRoot], host: "127.0.0.1", port: 0, publicUrl: url, allowedRedirectHosts: [], uiPort: 0, serviceEnv: [] };
  server.on("request", createHttpApp({ config, registry: new WorkspaceRegistry([projectRoot]) }).app);

  try {
    const statuses: number[] = [];

    for (let i = 0; i < 21; i++) {
      // Requests arrive through the SSH tunnel from loopback; a client could put anything in this header.
      const response = await fetch(`${url}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${i}` },
        body: JSON.stringify({ client_name: "flood", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
      });
      await response.text();
      statuses.push(response.status);
    }

    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(201));
    assert.equal(statuses[20], 429, "every request counts against the one loopback address, whatever the header says");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("requests with an unexpected Host header are rejected", async () => {
  assert.equal((await get("/healthz", { host: "evil.example" })).status, 403);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("a late cancellation for a finished request does not hit a newer request with the same id", async () => {
  // Two Claude Code windows share a token and both number their requests from 0: window 1's request 9
  // has just finished when its cancellation arrives, while window 2's request 9 is running.
  const token = await accessToken();
  const setup = await connect(token);
  const workspace_id = await openWorkspace(setup);
  await setup.close();

  const call = (command: string, signal?: AbortSignal) => postMcp(token, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "bash", arguments: { workspace_id, command, timeout: 300 } },
  }, signal);

  assert.match(await (await call("echo done")).text(), /"result"/);

  const disconnect = new AbortController();
  await call(longCommand("late-cancel.pids"), disconnect.signal);
  let pids: number[] = [];

  try {
    pids = await runningPids("late-cancel.pids");

    assert.equal((await postMcp(token, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } })).status, 202);
    await delay(200);
    assert.ok(pids.every(isRunning), "a late cancellation must not kill the newer request");

    // Disconnecting still stops it.
    disconnect.abort();
    await waitFor("the command to exit after the disconnect", () => !pids.some(isRunning));
  } finally {
    disconnect.abort();
    killLeftovers(pids);
  }
});

test("the activity log sees approvals, client connections and tool calls with the client's name", async () => {
  const events: ActivityEvent[] = [];
  const unsubscribe = activity.subscribe((event) => events.push(event));

  try {
    const { client_id } = (await (await registerClient()).json()) as { client_id: string };
    assert.equal((await authorize(client_id, "a-wrong-password-123")).status, 401);
    const { tokens } = await authorize(client_id);
    const client = await connect(tokens!.access_token);
    const workspace_id = await openWorkspace(client);
    await client.callTool({ name: "read", arguments: { workspace_id, path: "." } });
    await client.close();

    const notices = events.flatMap((event) => (event.type === "notice" ? [event.notice] : []));
    assert.ok(notices.some((notice) => notice.level === "warn" && /错误的 Owner 密码（客户端：Test Host）/.test(notice.message)), JSON.stringify(notices));
    assert.ok(notices.some((notice) => notice.message === "已批准客户端：Test Host"));
    assert.ok(notices.some((notice) => notice.message === "Test Host 已连接（http-test 1.0.0）"));

    const finished = events.flatMap((event) => (event.type === "call.end" ? [event.call] : []));
    assert.deepEqual(finished.map((call) => call.tool), ["open_workspace", "read"]);
    assert.ok(finished.every((call) => call.client === "Test Host" && call.status === "ok"));
    assert.ok(Date.now() - activity.snapshot().lastRequestAt! < 5000);
  } finally {
    unsubscribe();
  }
});
