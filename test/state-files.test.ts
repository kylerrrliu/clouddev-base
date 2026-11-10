import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

// `clouddev-base serve` started on what a power cut, a failed build or a slip while editing by hand leaves behind.
// Under launchd a serve that exits is started again every 10 seconds, and nobody on the other computer can fix it.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "src", "cli.ts");
const PASSWORD = "a-good-owner-password-123";
const READY = /工具调用会显示在下面/;
const REDIRECT_URI = "http://localhost:9999/callback";

interface Running {
  base: string;
  output(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");

  return port;
}

/** A config folder holding a valid config.json and auth.json, unless `files` replaces them. The root is a folder of its own. */
async function stateFolder(files: Record<string, string> = {}): Promise<string> {
  const home = await tempDir();
  const defaults = { "config.json": JSON.stringify({ allowedRoots: [await tempDir()] }), "auth.json": JSON.stringify({ ownerPassword: PASSWORD }) };

  for (const [name, content] of Object.entries({ ...defaults, ...files })) await writeFile(join(home, name), content);

  return home;
}

function spawnServe(home: string, cli: string, port: number, uiPort: number, extraEnv: NodeJS.ProcessEnv = {}) {
  // Neither the password variable nor the service marker (set when tests run through the service's bash tool) may leak in.
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, CLOUDDEV_BASE_HOME: home };
  delete env.CLOUDDEV_BASE_PASSWORD;
  delete env.CLOUDDEV_BASE_SERVICE;

  const child = spawn(process.execPath, [cli, "serve", "--port", String(port), "--ui-port", String(uiPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  child.stderr.on("data", (chunk) => (text += chunk));

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = once(child, "exit");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(forceKill);
  };

  return { child, output: () => text, stop };
}

/** Start serve and wait until it says it is up; fail with its output if it exits first. */
async function startServe(home: string, { cli = CLI, uiPort = 0, env = {} as NodeJS.ProcessEnv } = {}): Promise<Running> {
  const port = await freePort();
  const serve = spawnServe(home, cli, port, uiPort, env);
  const deadline = Date.now() + 15_000;

  while (!READY.test(serve.output())) {
    if (serve.child.exitCode !== null || Date.now() > deadline) {
      await serve.stop();
      assert.fail(`serve did not start:\n${serve.output()}`);
    }

    await delay(50);
  }

  return { base: `http://127.0.0.1:${port}`, output: serve.output, stop: serve.stop };
}

async function registerClient(base: string): Promise<string> {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "state test", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  assert.equal(response.status, 201);

  return ((await response.json()) as { client_id: string }).client_id;
}

/** Submit the approval form with the right password: 302 approves, 503 means the server has no usable password. */
async function approve(base: string, clientId: string): Promise<number> {
  const response = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      owner_password: PASSWORD,
    }).toString(),
    redirect: "manual",
  });
  await response.text();

  return response.status;
}

test("serve moves a broken oauth.json and workspaces.json aside and starts with empty state", async () => {
  const cases = [
    { oauth: "", workspaces: '{"ws_0123456789": "/some/where' },
    { oauth: '{"clients":{"a":{"client_id":"a"', workspaces: "" },
    { oauth: "null", workspaces: '{"ws_0123456789": 42}' },
  ];

  for (const { oauth, workspaces } of cases) {
    const home = await stateFolder({ "oauth.json": oauth, "workspaces.json": workspaces });
    const serve = await startServe(home);

    try {
      const names = await readdir(home);
      assert.ok(names.some((name) => /^oauth\.json\.corrupt-/.test(name)), names.join(", "));
      assert.ok(names.some((name) => /^workspaces\.json\.corrupt-/.test(name)), names.join(", "));
      assert.ok(!names.includes("oauth.json") && !names.includes("workspaces.json"), names.join(", "));
      assert.match(serve.output(), /oauth\.json[^\n]*重新授权/);
      assert.match(serve.output(), /workspaces\.json[^\n]*open_workspace/);

      // The empty state works: a client registers and is approved, and a fresh oauth.json is written.
      assert.equal(await approve(serve.base, await registerClient(serve.base)), 302);
      assert.equal(Object.keys((JSON.parse(await readFile(join(home, "oauth.json"), "utf8")) as { clients: object }).clients).length, 1);
    } finally {
      await serve.stop();
    }
  }
});

test("serve starts with a broken auth.json, makes no new password, and refuses approvals until it is fixed", async () => {
  const broken = '{"ownerPassword": "a-good-owner-pass';
  const home = await stateFolder({ "auth.json": broken });
  const serve = await startServe(home);

  try {
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), broken, "left as it was");
    assert.doesNotMatch(serve.output(), /已生成 Owner 密码/);
    assert.match(serve.output(), /auth\.json[\s\S]*password --reset/);
    assert.match(serve.output(), /Owner 密码: +无法读取/);
    assert.equal(await approve(serve.base, await registerClient(serve.base)), 503);
  } finally {
    await serve.stop();
  }
});

test("serve makes the state folder and its files private", async () => {
  const home = await stateFolder();
  await chmod(home, 0o755);
  await chmod(join(home, "config.json"), 0o644);
  await chmod(join(home, "auth.json"), 0o644);
  const serve = await startServe(home);

  try {
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, "config.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, "auth.json"))).mode & 0o777, 0o600);
    assert.match(serve.output(), /已收紧权限/);
  } finally {
    await serve.stop();
  }
});

test("serve gives a config.json set to 000 its 0600 back before reading it, and leaves a state folder that is the home folder at its mode", async () => {
  // Unreadable even to the server: read before the modes were fixed, it stopped every start (under launchd, every 10 seconds).
  const home = await stateFolder();
  const configFile = join(home, "config.json");
  await chmod(configFile, 0o000);
  let serve = await startServe(home);

  try {
    assert.equal((await stat(configFile)).mode & 0o777, 0o600);
    const tightened = serve.output().split("\n").find((line) => line.startsWith("已收紧权限"));
    assert.ok(tightened?.includes(configFile), serve.output());
  } finally {
    await serve.stop();
  }

  // CLOUDDEV_BASE_HOME is the home folder itself: 0700 there would lock other accounts out of it.
  const homeFolder = await stateFolder();
  await chmod(homeFolder, 0o755);
  await chmod(join(homeFolder, "config.json"), 0o000);
  serve = await startServe(homeFolder, { env: { HOME: homeFolder } });

  try {
    assert.equal((await stat(join(homeFolder, "config.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(homeFolder)).mode & 0o777, 0o755, "the home folder keeps its mode");
  } finally {
    await serve.stop();
  }
});

test("serve refuses a broken config.json, naming the file and how to check it after a fix", async () => {
  for (const content of ['{"allowedRoots": ["/tmp/x"],}', "[]"]) {
    const home = await stateFolder({ "config.json": content });
    const serve = spawnServe(home, CLI, await freePort(), 0);
    const timer = setTimeout(() => void serve.stop(), 15_000);
    const [code] = await once(serve.child, "close");
    clearTimeout(timer);

    assert.equal(code, 1, serve.output());
    assert.ok(serve.output().includes(join(home, "config.json")), serve.output());
    assert.match(serve.output(), /clouddev-base service status/);
  }
});

test("under launchd, serve keeps its log bounded also when it refuses the config and exits at once", async () => {
  // launchd starts it again every 10 seconds, and each start adds its refusal to the log.
  const home = await tempDir();
  const log = join(home, "Library", "Logs", "clouddev-base.log");
  await mkdir(dirname(log), { recursive: true });
  await writeFile(log, Buffer.alloc(11 * 1024 * 1024, "."));

  // The state folder has no config.json, so serve refuses to start; HOME is where the service's log lives.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLOUDDEV_BASE_HOME: await tempDir(), CLOUDDEV_BASE_SERVICE: "com.clouddev-base.serve" };
  delete env.CLOUDDEV_BASE_PASSWORD;
  delete env.CLOUDDEV_BASE_SERVICE_HANDOFF;

  const child = spawn(process.execPath, [CLI, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  child.stderr.on("data", (chunk) => (text += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const [code] = await once(child, "close");
  clearTimeout(timer);

  assert.equal(code, 1, text);
  assert.match(text, /没有配置允许访问的目录/);
  assert.equal((await stat(log)).size, 0, "emptied in place");
  assert.equal((await stat(`${log}.1`)).size, 11 * 1024 * 1024, "the old content is kept once");
});

test("serve runs MCP without the WebUI when the page's files are missing, and says why", async () => {
  // A copy of the code without src/webui/, as a failed build leaves dist/ without dist/webui/.
  const copy = await tempDir();
  const pageFiles = join(REPO, "src", "webui");
  await cp(join(REPO, "src"), join(copy, "src"), { recursive: true, filter: (source) => source !== pageFiles });
  await cp(join(REPO, "package.json"), join(copy, "package.json"));
  await symlink(join(REPO, "node_modules"), join(copy, "node_modules"));

  const uiPort = await freePort();
  const serve = await startServe(await stateFolder(), { cli: join(copy, "src", "cli.ts"), uiPort });

  try {
    assert.match(serve.output(), /WebUI: +没有启动: 找不到 WebUI 文件 \S+index\.html/);
    assert.equal((await fetch(`${serve.base}/healthz`)).status, 200, "MCP is up");
    await assert.rejects(fetch(`http://127.0.0.1:${uiPort}/`), "nothing listens on the WebUI port");
  } finally {
    await serve.stop();
  }
});
