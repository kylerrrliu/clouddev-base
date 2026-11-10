import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { request, type IncomingHttpHeaders } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { firstEvent, resultText, tempDir } from "./helpers.ts";

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
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
  // Neither the password variable nor the service marker (set when tests run through the service's bash tool) may leak in.
  delete env.CLOUDDEV_BASE_PASSWORD;
  delete env.CLOUDDEV_BASE_SERVICE;
  delete env.CLOUDDEV_BASE_SERVICE_HANDOFF;

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

/** The CLI with a config folder of its own, for tests that change config.json or auth.json. */
function cliIn(home: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...env, CLOUDDEV_BASE_HOME: home } });
}

async function storedPassword(home: string): Promise<string> {
  return (JSON.parse(await readFile(join(home, "auth.json"), "utf8")) as { ownerPassword: string }).ownerPassword;
}

/** macOS's script(1) gives the CLI a terminal, as when the owner types the command on B. */
const noTerminal = process.platform === "darwin" && existsSync("/usr/bin/script") ? false : "needs macOS's script(1) for a terminal";

/** Run the CLI on a terminal; returns what it printed there (stdout and stderr together). */
async function inTerminal(home: string, ...args: string[]): Promise<string> {
  // stdin must not be a pipe: script would fail to read its terminal settings.
  const child = spawn("/usr/bin/script", ["-q", "/dev/null", process.execPath, CLI, ...args], {
    env: { ...env, CLOUDDEV_BASE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout?.on("data", (chunk) => (text += chunk));
  child.stderr?.on("data", (chunk) => (text += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 0, text);

  return text;
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
  const oldPassword = (await cli("password", "--show")).stdout.trim();
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "CLI test", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };
  assert.equal(await approve(client_id, oldPassword), 302);

  const reset = await cli("password", "--reset");
  const newPassword = await storedPassword(env.CLOUDDEV_BASE_HOME!);
  assert.notEqual(newPassword, oldPassword);
  assert.ok(!`${reset.stdout}${reset.stderr}`.includes(newPassword), "without a terminal, --reset does not print the new password");
  assert.match(reset.stdout, /password --show/);
  assert.match(reset.stderr, /立即生效/);
  assert.equal((await cli("password", "--show")).stdout.trim(), newPassword);

  assert.equal(await approve(client_id, oldPassword), 401);
  assert.equal(await approve(client_id, newPassword), 302);
});

test("viewing the password never replaces it, even with a blank CLOUDDEV_BASE_PASSWORD", async () => {
  const authFile = join(env.CLOUDDEV_BASE_HOME!, "auth.json");
  const before = await readFile(authFile, "utf8");

  const { stdout } = await promisify(execFile)(process.execPath, [CLI, "password", "--show"], { env: { ...env, CLOUDDEV_BASE_PASSWORD: "" } });

  assert.equal(await readFile(authFile, "utf8"), before, "auth.json must not change");
  assert.equal(stdout.trim(), (JSON.parse(before) as { ownerPassword: string }).ownerPassword);
});

test("password prints the password only with --show, and warns when that output is not a terminal", async () => {
  const stored = await storedPassword(env.CLOUDDEV_BASE_HOME!);

  const plain = await cli("password");
  assert.ok(!`${plain.stdout}${plain.stderr}`.includes(stored), "no flags: not printed");
  assert.match(plain.stdout, /auth\.json/);
  assert.match(plain.stdout, /password --show/);

  const shown = await cli("password", "--show");
  assert.equal(shown.stdout.trim(), stored);
  assert.match(shown.stderr, /不是终端[\s\S]*对话记录/);
});

test("password refuses an unusable auth.json, and only --reset replaces it", async () => {
  const home = await tempDir();
  await writeFile(join(home, "auth.json"), '{"ownerPassword": "cut-short');

  for (const args of [["password"], ["password", "--show"]]) {
    await assert.rejects(cliIn(home, ...args), (error: { stderr?: string }) => /auth\.json[\s\S]*password --reset/.test(error.stderr ?? ""), args.join(" "));
  }

  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"ownerPassword": "cut-short');
  await cliIn(home, "password", "--reset");
  assert.ok((await storedPassword(home)).length >= 16);
});

test("init without a terminal never prints the password, also when it makes one", async () => {
  const home = await tempDir();
  const root = await tempDir();

  const first = await cliIn(home, "init", "--root", root);
  const created = await storedPassword(home);
  assert.ok(!`${first.stdout}${first.stderr}`.includes(created));
  assert.match(first.stdout, /已生成 Owner 密码，保存在 \S+auth\.json；在 B 的终端里运行 clouddev-base password --show 查看/);

  const reset = await cliIn(home, "init", "--root", root, "--reset");
  const replaced = await storedPassword(home);
  assert.notEqual(replaced, created);
  assert.ok(!`${reset.stdout}${reset.stderr}`.includes(replaced));
});

test("on a terminal, init shows a password it has just made, and only then", { skip: noTerminal }, async () => {
  const home = await tempDir();
  const root = await tempDir();

  assert.ok((await inTerminal(home, "init", "--root", root)).includes(await storedPassword(home)), "made now: shown");

  const again = await inTerminal(home, "init", "--root", root);
  assert.ok(!again.includes(await storedPassword(home)), "made before: not shown again");
  assert.match(again, /password --show/);

  assert.ok((await inTerminal(home, "init", "--root", root, "--reset")).includes(await storedPassword(home)), "--reset: the new one is shown");

  const shown = await inTerminal(home, "password", "--show");
  assert.ok(shown.includes(await storedPassword(home)));
  assert.doesNotMatch(shown, /不是终端/);
});

test("init refuses a root that holds the config folder unless --allow-broad-roots, which only init takes", async () => {
  const parent = await tempDir();
  const home = join(parent, "state");
  const configFile = join(home, "config.json");

  await assert.rejects(cliIn(home, "init", "--root", parent), (error: { stderr?: string }) => /包含 clouddev-base 的配置目录/.test(error.stderr ?? "") && /--allow-broad-roots/.test(error.stderr ?? ""));
  assert.equal(existsSync(configFile), false, "nothing was saved");

  const allowed = await cliIn(home, "init", "--root", parent, "--allow-broad-roots");
  assert.match(allowed.stdout, /注意（--allow-broad-roots）/);
  assert.equal((JSON.parse(await readFile(configFile, "utf8")) as { allowBroadRoots?: boolean }).allowBroadRoots, true);

  // The exception lasts only while it is passed again.
  await cliIn(home, "init", "--root", await tempDir());
  assert.equal((JSON.parse(await readFile(configFile, "utf8")) as { allowBroadRoots?: boolean }).allowBroadRoots, undefined);

  await assert.rejects(cliIn(home, "serve", "--allow-broad-roots"), (error: { stderr?: string }) => /只能和 init 一起用/.test(error.stderr ?? ""));
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
  const withVariable = { env: { ...env, CLOUDDEV_BASE_PASSWORD: "from-the-environment-123" } };
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, "password", "--show"], withVariable);

  assert.equal(stdout.trim(), "from-the-environment-123");
  assert.match(stderr, /CLOUDDEV_BASE_PASSWORD/);
  assert.match(stderr, /auth\.json/);

  const plain = await promisify(execFile)(process.execPath, [CLI, "password"], withVariable);
  assert.ok(!plain.stdout.includes("from-the-environment-123"));
  assert.match(plain.stdout, /CLOUDDEV_BASE_PASSWORD[\s\S]*auth\.json/);
});

test("init says what to pass to install.sh on the other computer, and to start Claude Code with start.sh", async () => {
  const { stdout } = await cli("init", "--root", await tempDir());

  assert.match(stdout, /client\/tunnel\/install\.sh \S+@\S+/);
  assert.match(stdout, /client\/start\.sh 启动 Claude Code，再用 \/mcp 认证/);

  const remote = await cliIn(await tempDir(), "init", "--root", await tempDir(), "--public-url", "https://b.example.com");
  assert.match(remote.stdout, /https:\/\/b\.example\.com\/mcp[\s\S]*client\/start\.sh 启动 Claude Code，再用 \/mcp 认证/);
});

test("help says --allow-broad-roots exposes ~/.ssh, but never the config folder", async () => {
  const { stdout } = await cli("help");

  assert.match(stdout, /--allow-broad-roots[\s\S]*~\/\.ssh[^\n]*工作区不能包含它/);
  assert.doesNotMatch(stdout, /读到[^\n]*Owner 密码/);
});

test("a blank CLOUDDEV_BASE_HOME means ~/.clouddev-base, never the current folder", async () => {
  // HOME is a folder of its own, so ~/.clouddev-base is one too; the current folder stands for a project.
  const home = await tempDir();
  const project = await tempDir();
  await writeFile(join(project, "config.json"), '{"name": "a project of its own"}');
  const blank = { env: { ...env, HOME: home, CLOUDDEV_BASE_HOME: "  " }, cwd: project };

  await promisify(execFile)(process.execPath, [CLI, "init", "--root", await tempDir()], blank);

  assert.ok(existsSync(join(home, ".clouddev-base", "config.json")));
  assert.deepEqual(await readdir(project), ["config.json"], "no auth.json in the project");
  assert.equal(await readFile(join(project, "config.json"), "utf8"), '{"name": "a project of its own"}');

  // And the background service would use the same folder.
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, "service", "install", "--print"], blank);
  assert.doesNotMatch(stdout, /CLOUDDEV_BASE_HOME/);
});

test("service status shows launchd's view also when serve would refuse the config, and says when the code is newer than the job", { skip: process.platform === "darwin" ? false : "needs launchd" }, async () => {
  // The running serve stands in for the background service: a fake launchctl reports its pid, and the job's code
  // is a dist/ folder of its own. Nothing real is looked at or changed: HOME and the config folder are throwaway.
  const home = await tempDir();
  const state = await tempDir();
  const bin = await tempDir();
  const code = await tempDir();
  const cliFile = join(code, "dist", "cli.js");
  await mkdir(join(code, "dist"));
  await writeFile(cliFile, "");
  await writeFile(join(bin, "launchctl"), `#!/bin/sh
[ "$1" = print ] || exit 113
cat <<'EOF'
gui/${process.getuid!()}/com.clouddev-base.serve = {
	state = running
	program = ${process.execPath}
	arguments = {
		${process.execPath}
		${cliFile}
		serve
	}
	pid = ${serve.pid}
	last exit code = 1
}
EOF
`, { mode: 0o755 });

  const port = Number(new URL(base).port);
  const status = () => promisify(execFile)(process.execPath, [CLI, "service", "status"], { env: { ...env, HOME: home, CLOUDDEV_BASE_HOME: state, PATH: `${bin}:${env.PATH}` } })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (error: { code: number; stdout: string; stderr: string }) => error);

  // An old config whose root is the home folder: serve refuses it, as after an upgrade.
  await writeFile(join(state, "config.json"), JSON.stringify({ allowedRoots: [home], port, uiPort: 0 }));
  const later = new Date(Date.now() + 60_000);
  await utimes(cliFile, later, later);

  const refused = await status();
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /是家目录[\s\S]*init --root ~\/work[\s\S]*service install/);
  assert.match(refused.stdout, new RegExp(`状态: +running（pid ${serve.pid}）`));
  assert.match(refused.stdout, /上次退出码: +1/);
  assert.match(refused.stdout, new RegExp(`健康检查: +正常（http://127\\.0\\.0\\.1:${port}/healthz）`), "probed on the port config.json names");
  assert.match(refused.stdout, /代码更新过[\s\S]*service install/, "dist/ changed after the job started");

  // A config serve accepts, and code older than the job: nothing to report.
  await writeFile(join(state, "config.json"), JSON.stringify({ allowedRoots: [await tempDir()], port, uiPort: 0 }));
  await utimes(cliFile, new Date(2000, 0, 1), new Date(2000, 0, 1));

  const fine = await status();
  assert.equal(fine.code, 0, fine.stderr);
  assert.equal(fine.stderr, "");
  assert.match(fine.stdout, /健康检查: +正常/);
  assert.doesNotMatch(fine.stdout, /代码更新过/);
});

/** Register a client, approve it with the Owner password and exchange the code, as Claude Code does. */
async function accessToken(serveBase: string, password: string): Promise<string> {
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const registered = await fetch(`${serveBase}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "CLI test", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${serveBase}/mcp`,
  };
  const approved = await fetch(`${serveBase}/authorize`, { method: "POST", headers: form, body: new URLSearchParams({ ...params, owner_password: password }).toString(), redirect: "manual" });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const tokens = await fetch(`${serveBase}/token`, {
    method: "POST",
    headers: form,
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT_URI, resource: `${serveBase}/mcp` }).toString(),
  });

  return ((await tokens.json()) as { access_token: string }).access_token;
}

async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(25);
  }
}

test("a second Ctrl+C ends serve at once, while the first one still waits for running commands", async () => {
  const home = await tempDir();
  const root = await tempDir();
  const port = await freePort();
  const serveBase = `http://127.0.0.1:${port}`;
  let text = "";
  const child = spawn(process.execPath, [CLI, "serve", "--root", root, "--port", String(port), "--ui-port", "0"], {
    env: { ...env, CLOUDDEV_BASE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (text += chunk));
  child.stderr?.on("data", (chunk) => (text += chunk));
  const client = new Client({ name: "cli-test", version: "1.0.0" });

  try {
    await waitUntil("serve to start", () => child.exitCode === null && /工具调用会显示在下面/.test(text));
    const token = await accessToken(serveBase, await storedPassword(home));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${serveBase}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: root } });
    const workspace_id = /workspace_id: (ws_\w+)/.exec(resultText(opened as never))?.[1];
    assert.ok(workspace_id, resultText(opened as never));

    // A command that ignores SIGTERM: stopping it takes its full grace period, and it ends by itself soon after.
    const running = client.callTool({ name: "bash", arguments: { workspace_id, command: "trap '' TERM; touch started; sleep 8" } }).catch(() => undefined);
    await waitUntil("the command to start", () => existsSync(join(root, "started")));

    child.kill("SIGINT");
    await waitUntil("the first Ctrl+C to be taken", () => /正在停止…（再按一次 Ctrl\+C 立即结束）/.test(text));
    assert.equal(child.exitCode, null, "still waiting for the command");

    const exited = once(child, "exit");
    child.kill("SIGINT");
    const [code, signal] = await exited;
    assert.equal(code, 130, text);
    assert.equal(signal, null);

    // Closing the client ends the call it still waits for, instead of its 60-second timeout.
    await client.close();
    await running;
  } finally {
    await client.close().catch(() => {});

    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
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
