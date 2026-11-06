import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request, type IncomingHttpHeaders } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir } from "./helpers.ts";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// End-to-end checks of `clouddev-base serve` as users run it: a real process on a random port, with its own config dir.
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const REDIRECT_URI = "http://localhost:9999/callback";

let env: NodeJS.ProcessEnv;
let serve: ChildProcess;
let base: string;
let output = "";

before(async () => {
  env = { ...process.env, CLOUDDEV_BASE_HOME: await tempDir() };
  delete env.CLOUDDEV_BASE_PASSWORD;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, [CLI, "serve", "--root", await tempDir(), "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  serve.stdout?.on("data", (chunk) => (output += chunk));
  serve.stderr?.on("data", (chunk) => (output += chunk));

  const deadline = Date.now() + 15_000;

  while (!(await fetch(`${base}/healthz`).then((response) => response.ok, () => false))) {
    if (serve.exitCode !== null || Date.now() > deadline) assert.fail(`serve did not start:\n${output}`);
    await delay(50);
  }
});

after(async () => {
  if (serve.exitCode !== null || serve.signalCode !== null) return;

  const exited = once(serve, "exit");
  const forceKill = setTimeout(() => serve.kill("SIGKILL"), 5000);
  serve.kill("SIGTERM");
  await exited;
  clearTimeout(forceKill);
});

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");

  return port;
}

function cli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, [CLI, ...args], { env });
}

/** Submit the approval form; 302 means the password was accepted. */
async function approve(clientId: string, password: string): Promise<number> {
  const response = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      owner_password: password,
    }).toString(),
    redirect: "manual",
  });
  await response.text();

  return response.status;
}

test("serve keeps idle connections open for 5 minutes", async () => {
  // Node advertises the idle timeout it enforces; its default of 5 s is shorter than reverse proxies keep connections.
  const headers = await new Promise<IncomingHttpHeaders>((resolve, reject) => {
    request(`${base}/healthz`, (res) => {
      res.resume();
      resolve(res.headers);
    }).on("error", reject).end();
  });

  assert.equal(headers["keep-alive"], "timeout=300");
});

test("password --reset takes effect in a running serve", async () => {
  const oldPassword = (await cli("password")).stdout.trim();
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "CLI test", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };
  assert.equal(await approve(client_id, oldPassword), 302);

  const reset = await cli("password", "--reset");
  const newPassword = reset.stdout.trim();
  assert.notEqual(newPassword, oldPassword);
  assert.match(reset.stderr, /立即生效/);

  assert.equal(await approve(client_id, oldPassword), 401);
  assert.equal(await approve(client_id, newPassword), 302);
});

test("viewing the password never replaces it, even with a blank CLOUDDEV_BASE_PASSWORD", async () => {
  const authFile = join(env.CLOUDDEV_BASE_HOME!, "auth.json");
  const before = await readFile(authFile, "utf8");

  const { stdout } = await promisify(execFile)(process.execPath, [CLI, "password"], { env: { ...env, CLOUDDEV_BASE_PASSWORD: "" } });

  assert.equal(await readFile(authFile, "utf8"), before, "auth.json must not change");
  assert.equal(stdout.trim(), (JSON.parse(before) as { ownerPassword: string }).ownerPassword);
});
