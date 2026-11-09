import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request, type IncomingHttpHeaders } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { firstEvent, tempDir } from "./helpers.ts";

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// End-to-end checks of `clouddev-base serve` as users run it: a real process on a random port, with its own config dir.
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const REDIRECT_URI = "http://localhost:9999/callback";

let env: NodeJS.ProcessEnv;
let serve: ChildProcess;
let base: string;
let uiBase: string;
let output = "";

before(async () => {
  env = { ...process.env, CLOUDDEV_BASE_HOME: await tempDir() };
  delete env.CLOUDDEV_BASE_PASSWORD;

  const port = await freePort();
  const uiPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  uiBase = `http://127.0.0.1:${uiPort}`;
  serve = spawn(process.execPath, [CLI, "serve", "--root", await tempDir(), "--port", String(port), "--ui-port", String(uiPort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  // Node advertises the idle timeout it enforces; its default of 5 s is shorter than clients keep idle connections for reuse.
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

test("serve also starts the WebUI, on 127.0.0.1 only", async () => {
  assert.match(output, new RegExp(`WebUI: +${uiBase.replaceAll(".", "\\.")}`));

  const page = await fetch(`${uiBase}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /clouddev-base/);

  const snapshot = (await firstEvent(`${uiBase}/api/stream`)) as unknown as { server: { mcpUrl: string } };
  assert.equal(snapshot.server.mcpUrl, `${base}/mcp`);
});

test("init refuses the same port for MCP and the WebUI, and leaves config.json alone", async () => {
  const root = await tempDir();
  await cli("init", "--root", root);
  const configFile = join(env.CLOUDDEV_BASE_HOME!, "config.json");
  const before = await readFile(configFile, "utf8");

  await assert.rejects(cli("init", "--root", root, "--port", "8100", "--ui-port", "8100"), (error: { stderr?: string }) => /WebUI 端口不能和 MCP 端口相同/.test(error.stderr ?? ""));
  assert.equal(await readFile(configFile, "utf8"), before);
});

test("service install --print shows the launchd job without installing it", async () => {
  await cli("init", "--root", await tempDir());

  // A throwaway HOME and a launchctl that knows no jobs: if this ever regressed, nothing real gets installed.
  const home = await tempDir();
  const bin = await tempDir();
  await writeFile(join(bin, "launchctl"), "#!/bin/sh\nexit 113\n", { mode: 0o755 });
  const isolated = (...args: string[]) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}` } });

  const { stdout } = await isolated("service", "install", "--print");

  assert.match(stdout, /<string>com\.clouddev-base\.serve<\/string>/);
  assert.match(stdout, /<string>serve<\/string>/);
  assert.match(stdout, /<key>KeepAlive<\/key>/);
  assert.match(stdout, /<key>CLOUDDEV_BASE_SERVICE<\/key>/, "commands run through the service can tell");
  assert.ok(stdout.includes(`<string>${env.CLOUDDEV_BASE_HOME}</string>`), "the config folder in use carries over");
  assert.equal(existsSync(join(home, "Library")), false, "--print writes nothing");

  await assert.rejects(isolated("service", "install", "--port", "9000"), (error: { stderr?: string }) => /不接受 --root、--port/.test(error.stderr ?? ""));
  await assert.rejects(isolated("service", "restart"), (error: { stderr?: string }) => /用法: clouddev-base service/.test(error.stderr ?? ""));
});

test("password says when it shows CLOUDDEV_BASE_PASSWORD rather than auth.json", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, "password"], { env: { ...env, CLOUDDEV_BASE_PASSWORD: "from-the-environment-123" } });

  assert.equal(stdout.trim(), "from-the-environment-123");
  assert.match(stderr, /CLOUDDEV_BASE_PASSWORD/);
  assert.match(stderr, /auth\.json/);
});

test("init says what to pass to install.sh on the other computer", async () => {
  const { stdout } = await cli("init", "--root", await tempDir());

  assert.match(stdout, /client\/tunnel\/install\.sh \S+@\S+/);
});

test("serve runs MCP without the WebUI while its port is taken, and says it will retry", async () => {
  const busy = createServer().listen(0, "127.0.0.1");
  await once(busy, "listening");
  const uiPort = (busy.address() as AddressInfo).port;
  const port = await freePort();
  let text = "";
  const child = spawn(process.execPath, [CLI, "serve", "--root", await tempDir(), "--port", String(port), "--ui-port", String(uiPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => (text += chunk));
  child.stderr?.on("data", (chunk) => (text += chunk));

  try {
    const deadline = Date.now() + 15_000;

    while (!/工具调用会显示在下面/.test(text)) {
      if (child.exitCode !== null || Date.now() > deadline) assert.fail(`serve did not start:\n${text}`);
      await delay(50);
    }

    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200, "MCP is up");
    assert.match(text, new RegExp(`端口 ${uiPort} 被占用，每 30 秒重试`));
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    busy.close();
  }
});
