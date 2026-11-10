import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  commandEnvironment,
  DISCARD_WINDOW_MS,
  keepDraining,
  killRunningCommandsNow,
  MAX_CALL_MS,
  MAX_DISCARD_BYTES,
  runCommand,
} from "../src/tools/shell.ts";
import { resultText, tempDir, writeTree } from "./helpers.ts";

const NODE = JSON.stringify(process.execPath);
const BACKGROUND_NOTE = /^\[A background process still holds this command's output\./m;

test("commands do not inherit the server's Owner password variable", async () => {
  const root = await tempDir();
  const previous = process.env.CLOUDDEV_BASE_PASSWORD;
  process.env.CLOUDDEV_BASE_PASSWORD = "not-for-commands-0123456789";
  process.env.CLOUDDEV_BASE_TEST_VISIBLE = "visible";

  try {
    const result = await runCommand("printenv CLOUDDEV_BASE_PASSWORD || echo absent; printenv CLOUDDEV_BASE_TEST_VISIBLE", root);

    assert.equal(resultText(result), "absent\nvisible");
    assert.equal(process.env.CLOUDDEV_BASE_PASSWORD, "not-for-commands-0123456789", "the server's own environment is unchanged");
  } finally {
    if (previous === undefined) delete process.env.CLOUDDEV_BASE_PASSWORD;
    else process.env.CLOUDDEV_BASE_PASSWORD = previous;
    delete process.env.CLOUDDEV_BASE_TEST_VISIBLE;
  }
});

test("with a proxy set, commands reach this computer's own servers directly", async () => {
  const names = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const server = createHttpServer((_request, response) => response.end("served here"));

  try {
    for (const name of names) delete process.env[name];

    // Without a proxy, nothing is added.
    assert.equal(commandEnvironment().no_proxy, undefined);
    assert.equal(commandEnvironment().NO_PROXY, undefined);

    // A list in one spelling goes into both: some tools read only the lowercase name, others prefer the uppercase one.
    process.env.HTTPS_PROXY = "http://proxy.example:3128";
    process.env.NO_PROXY = " corp.example.com, LOCALHOST ";
    let env = commandEnvironment();
    assert.equal(env.NO_PROXY, "corp.example.com,LOCALHOST,127.0.0.1,::1");
    assert.equal(env.no_proxy, "corp.example.com,LOCALHOST,127.0.0.1,::1");
    assert.equal(process.env.no_proxy, undefined, "the server's own environment is unchanged");

    // With both spellings set, each keeps its own entries, without duplicates.
    process.env.no_proxy = "a.example,127.0.0.1";
    env = commandEnvironment();
    assert.equal(env.no_proxy, "a.example,127.0.0.1,localhost,::1");
    assert.equal(env.NO_PROXY, "corp.example.com,LOCALHOST,127.0.0.1,::1");

    // "*" lets every host bypass the proxy already, but only on its own.
    process.env.no_proxy = "*";
    assert.equal(commandEnvironment().no_proxy, "*");

    if (!runs("curl", "--version")) return;

    // curl, with its proxy unreachable, still gets to a server on 127.0.0.1.
    for (const name of names) delete process.env[name];
    process.env.http_proxy = `http://127.0.0.1:${await closedPort()}`;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const root = await tempDir();

    assert.equal(resultText(await runCommand(`curl -sS --max-time 10 ${url}`, root)), "served here");
    // Told to use the proxy anyway, it fails: the proxy really is in the way.
    assert.equal((await runCommand(`curl -sS --max-time 10 --noproxy '' ${url}`, root)).isError, true);
  } finally {
    server.close();

    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("background processes that keep writing to the output survive the call, and the result says so", async () => {
  const root = await tempDir();
  // Once nobody reads the pipe, a shell loop dies of SIGPIPE at its next write, and a Node process of an unhandled
  // EPIPE error. Both end by themselves after about 20 seconds, should the cleanup below not run.
  const command =
    `${NODE} -e 'setInterval(() => console.log("node tick"), 50); setTimeout(() => process.exit(), 20000)' & echo $$ $! > node.pids; ` +
    "(for i in $(seq 400); do echo shell tick; sleep 0.05; done) & echo $$ $! > shell.pids; sleep 0.3; echo started";
  const result = await runCommand(command, root);

  try {
    const [, nodeWriter] = await readPids(root, "node.pids");
    const [, shellWriter] = await readPids(root, "shell.pids");
    const text = resultText(result);

    assert.equal(result.isError, undefined);
    assert.match(text, BACKGROUND_NOTE);
    assert.ok(text.split("\n").includes("started"), text.slice(0, 500));

    await delay(1000);
    assert.ok(isRunning(shellWriter!), "the shell loop is still running a second later");
    assert.ok(isRunning(nodeWriter!), "the Node process is still running a second later");
  } finally {
    await stopLeftovers(root, "shell.pids");
    await stopLeftovers(root, "node.pids");
  }
});

test("a background process flooding the output is cut off once it writes more than 16MB within a minute", async () => {
  const root = await tempDir();
  const result = await runCommand("yes & echo $$ $! > yes.pids; echo started", root);

  try {
    const [, flood] = await readPids(root, "yes.pids");

    assert.equal(MAX_DISCARD_BYTES, 16 * 1024 * 1024);
    assert.equal(DISCARD_WINDOW_MS, 60_000);
    assert.match(resultText(result), /^\[A background process [^\n]* if it writes more than 16MB within 60 seconds, its output is closed,/m);
    // Its output pipes are closed, so its next write ends it with SIGPIPE instead of keeping a CPU core busy.
    await waitFor("yes to be stopped", () => !isRunning(flood!), 10_000);
  } finally {
    await stopLeftovers(root, "yes.pids");
  }
});

test("background output is closed only when it comes faster than the limit, however much of it there is in all", async () => {
  // A flood: more than the limit within one window.
  const flood = new PassThrough();
  assert.equal(keepDraining([flood], 1000, 60_000), true);
  flood.write(Buffer.alloc(600));
  flood.write(Buffer.alloc(500));
  await delay(50);
  assert.equal(flood.destroyed, true);

  // A steady writer: twice the limit in all, but never more than 800 bytes in one 500 ms window, since its writes are
  // at least 150 ms apart.
  const steady = new PassThrough();
  keepDraining([steady], 1000, 500);

  for (let i = 0; i < 10; i++) {
    steady.write(Buffer.alloc(200));
    await delay(150);
  }

  assert.equal(steady.destroyed, false);
  steady.destroy();

  // Pipes that are already closed are not drained.
  const closed = new PassThrough();
  closed.destroy();
  assert.equal(keepDraining([closed, null]), false);
});

test("a background process holding the output does not keep the server from exiting", async () => {
  const root = await tempDir();
  const shellModule = new URL("../src/tools/shell.ts", import.meta.url).href;
  const command = "(for i in $(seq 400); do echo tick; sleep 0.05; done) & echo $$ $! > loop.pids; echo started";
  await writeTree(root, {
    "server.mjs":
      `import { runCommand } from ${JSON.stringify(shellModule)};\n` +
      `const result = await runCommand(${JSON.stringify(command)}, ${JSON.stringify(root)});\n` +
      "console.log(result.content[0].text.split('\\n').includes('started') ? 'started' : result.content[0].text);\n",
  });

  const server = spawn(process.execPath, [join(root, "server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  let printed = "";
  server.stdout.on("data", (chunk: Buffer) => (printed += chunk));
  const exited = new Promise<number | null>((resolve) => server.once("exit", resolve));

  try {
    const code = await Promise.race([exited, delay(10_000, "still running", { ref: false })]);

    assert.equal(code, 0, "the server process ends by itself once the call has returned");
    assert.equal(printed.trim(), "started");
  } finally {
    // Sends nothing once the server has exited.
    server.kill("SIGKILL");
    await stopLeftovers(root, "loop.pids");
  }
});

test("a timeout still stops the background processes the command started", async () => {
  const root = await tempDir();
  const command =
    "nohup sleep 30 > /dev/null 2>&1 & echo $$ $! > quiet.pids; " +
    "(for i in $(seq 400); do echo tick; sleep 0.05; done) & echo $$ $! > loud.pids; sleep 10";
  const result = await runCommand(command, root, 1);

  try {
    const [group, quiet] = await readPids(root, "quiet.pids");
    const [, loud] = await readPids(root, "loud.pids");
    const text = resultText(result);

    assert.equal(result.isError, true);
    assert.match(text, /\n\nCommand timed out after 1 second: sent SIGTERM and it stopped\.$/);
    assert.doesNotMatch(text, BACKGROUND_NOTE);
    assert.ok(!isRunning(quiet!), "the redirected nohup process was stopped");
    assert.ok(!isRunning(loud!), "the writing background loop was stopped");
    assert.ok(!groupExists(group!));
  } finally {
    await stopLeftovers(root, "quiet.pids");
    await stopLeftovers(root, "loud.pids");
  }
});

test("a timeout or cancellation sends SIGTERM first, so trap handlers run", async () => {
  const root = await tempDir();
  const timedOut = await runCommand("trap 'echo cleaned up > timeout.txt' TERM; echo started; sleep 10", root, 1);

  // bash outlives the signal thanks to its trap, so it reports the killed sleep ("Terminated: 15") before it exits.
  assert.equal(timedOut.isError, true);
  assert.match(resultText(timedOut), /^started\n[\s\S]*\n\nCommand timed out after 1 second: sent SIGTERM and it stopped\.$/);
  assert.equal(await readFile(join(root, "timeout.txt"), "utf8"), "cleaned up\n");

  const controller = new AbortController();
  const cancelled = runCommand("trap 'echo cleaned up > cancel.txt' TERM; echo started; touch ready; sleep 10", root, 30, controller.signal);

  try {
    await waitFor("the trap to be set", () => existsSync(join(root, "ready")));
  } finally {
    controller.abort();
  }

  assert.match(resultText(await cancelled), /^started\n[\s\S]*\n\nCommand was cancelled: sent SIGTERM and it stopped\.$/);
  assert.equal(await readFile(join(root, "cancel.txt"), "utf8"), "cleaned up\n");
});

test("a test runner that stops its detached helper on SIGTERM gets to do so on a timeout", async () => {
  const root = await tempDir();
  // Like Playwright with its browsers: the helper runs in a process group of its own, which a signal to the command's
  // group does not reach, and the runner ends it when it gets SIGTERM. SIGKILL would leave the helper behind.
  await writeTree(root, {
    "runner.cjs": [
      "let helper;",
      'process.on("SIGTERM", () => { if (helper) process.kill(-helper.pid, "SIGKILL"); process.exit(1); });',
      'helper = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });',
      'require("node:fs").writeFileSync("helper.pids", `${helper.pid} ${helper.pid}`);',
      'console.log("started");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  });

  const result = await runCommand(`${NODE} runner.cjs`, root, 2);

  try {
    const [helper] = await readPids(root, "helper.pids");

    assert.equal(resultText(result), "started\n\nCommand timed out after 2 seconds: sent SIGTERM and it stopped.");
    await waitFor("the helper to be stopped", () => !isRunning(helper!));
  } finally {
    await stopLeftovers(root, "helper.pids");
  }
});

test("a git commit stopped by a timeout leaves no index.lock behind", { skip: !hasGit() && "git is not installed" }, async () => {
  const root = await tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, ".git", "hooks"));
  await writeTree(root, { "a.txt": "1\n", ".git/hooks/pre-commit": "#!/bin/sh\necho 'running lint...'\nsleep 20\n" });
  await chmod(join(root, ".git", "hooks", "pre-commit"), 0o755);
  git("add", "a.txt");
  git("commit", "-q", "--no-verify", "-m", "init");
  await writeTree(root, { "a.txt": "2\n" });

  // SIGKILL in the middle of the hook used to leave .git/index.lock, and every later git add failed.
  const result = await runCommand("git commit -am wip", root, 2);

  assert.match(resultText(result), /running lint\.\.\.[\s\S]*Command timed out after 2 seconds: sent SIGTERM and it stopped\.$/);
  assert.equal(existsSync(join(root, ".git", "index.lock")), false);
  assert.equal(resultText(await runCommand("git add a.txt && echo added", root)), "added");
});

test("a command that ignores SIGTERM gets SIGKILL 3 seconds later", async () => {
  const root = await tempDir();
  const startedAt = performance.now();
  // The background sleep inherits the ignored SIGTERM; bash ignores it while it waits.
  const result = await runCommand("trap '' TERM; sleep 30 & echo $$ $! > stubborn.pids; echo started; wait", root, 1);
  const elapsed = performance.now() - startedAt;

  try {
    const [group] = await readPids(root, "stubborn.pids");

    assert.equal(result.isError, true);
    assert.equal(resultText(result), "started\n\nCommand timed out after 1 second: sent SIGTERM, then SIGKILL 3 seconds later.");
    assert.ok(elapsed >= 3900 && elapsed < 8000, `returned after ${Math.round(elapsed)} ms`);
    await waitFor("the process group to be gone", () => !groupExists(group!));
  } finally {
    await stopLeftovers(root, "stubborn.pids");
  }
});

test("killRunningCommandsNow ends a command being stopped at once, even one that outlives SIGTERM", async () => {
  const root = await tempDir();
  // Times out after 1 second, ignores the SIGTERM, and would get SIGKILL only 3 seconds later.
  const call = runCommand("trap '' TERM; sleep 30 & echo $$ $! > stubborn.pids; echo started; wait", root, 1);

  try {
    const [group, sleeper] = await waitForPids(root, "stubborn.pids");
    await delay(1500);
    assert.ok(isRunning(sleeper!), "the sleep outlived SIGTERM");

    const killedAt = performance.now();
    killRunningCommandsNow();
    await waitFor("the sleep to be gone", () => !isRunning(sleeper!), 1000);

    assert.equal(resultText(await call), "started\n\nCommand timed out after 1 second: sent SIGTERM and it stopped.");
    assert.ok(performance.now() - killedAt < 2000, "the call does not wait out the grace");
    assert.ok(!groupExists(group!));
  } finally {
    await call.catch(() => undefined);
    await stopLeftovers(root, "stubborn.pids");
  }
});

test("a server that exits during the grace takes the commands it is stopping along, but not what was left running on purpose", async () => {
  const root = await tempDir();
  const shellModule = new URL("../src/tools/shell.ts", import.meta.url).href;
  const kept = "nohup sleep 30 > /dev/null 2>&1 & echo $$ $! > kept.pids";
  // Times out after 1 second and outlives the SIGTERM; the server exits half a second into the grace.
  const stubborn = "trap '' TERM; sleep 30 & echo $$ $! > stubborn.pids; echo started; wait";
  await writeTree(root, {
    "server.mjs":
      `import { runCommand } from ${JSON.stringify(shellModule)};\n` +
      `await runCommand(${JSON.stringify(kept)}, ${JSON.stringify(root)});\n` +
      `void runCommand(${JSON.stringify(stubborn)}, ${JSON.stringify(root)}, 1);\n` +
      "setTimeout(() => process.exit(0), 1500);\n",
  });

  const server = spawn(process.execPath, [join(root, "server.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
  const exited = new Promise<number | null>((resolve) => server.once("exit", resolve));

  try {
    const [, sleeper] = await waitForPids(root, "stubborn.pids");
    const [, background] = await waitForPids(root, "kept.pids");

    assert.equal(await Promise.race([exited, delay(10_000, "still running", { ref: false })]), 0);
    await waitFor("the stubborn sleep to be gone", () => !isRunning(sleeper!), 1000);
    assert.ok(isRunning(background!), "the process started in the background on purpose is still running");
  } finally {
    // Sends nothing once the server has exited.
    server.kill("SIGKILL");
    await stopLeftovers(root, "stubborn.pids");
    await stopLeftovers(root, "kept.pids");
  }
});

test("output written after bash has exited is still collected while the group is being stopped", async () => {
  const root = await tempDir();
  // SIGTERM ends bash and `sleep 10`. The subshell ignores it, writes a line a second after bash has gone (a result
  // decided when bash exits, plus a short grace for the pipes, would miss it), then waits for SIGKILL.
  const command = "(trap '' TERM; sleep 2; echo late line; sleep 30) & echo $$ $! > late.pids; echo started; sleep 10";
  const result = await runCommand(command, root, 1);

  try {
    assert.equal(resultText(result), "started\nlate line\n\nCommand timed out after 1 second: sent SIGTERM, then SIGKILL 3 seconds later.");
  } finally {
    await stopLeftovers(root, "late.pids");
  }
});

test("the longest bash call ends before the client's own timeout", async () => {
  const config = JSON.parse(await readFile(new URL("../client/.mcp.json", import.meta.url), "utf8")) as {
    mcpServers: Record<string, { timeout: number }>;
  };

  assert.ok(MAX_CALL_MS < config.mcpServers["clouddev-base"]!.timeout, `${MAX_CALL_MS} ms`);
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch (error) {
    // On macOS a group whose members are all unreaped zombies answers EPERM; they are reaped within a moment.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PIDs a command wrote to `file`: its process group (bash's $$) first, then its background processes ($!). */
async function readPids(root: string, file: string): Promise<number[]> {
  return (await readFile(join(root, file), "utf8")).trim().split(/\s+/).map(Number);
}

/** readPids, once a command that is still running has written them. */
async function waitForPids(root: string, file: string): Promise<number[]> {
  const deadline = Date.now() + 5000;

  for (;;) {
    const pids = await readPids(root, file).catch((): number[] => []);

    if (pids.length >= 2 && pids.every((pid) => Number.isInteger(pid) && pid > 1)) return pids;

    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${file}`);
    await delay(25);
  }
}

/** The process group of a process, from ps; undefined when there is no such process. */
function processGroupOf(pid: number): number | undefined {
  try {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    return Number(output.trim()) || undefined;
  } catch {
    // ps exits with status 1 when there is no such process.
    return undefined;
  }
}

/**
 * End whatever is left of the process group a test's command started, even after a failed assertion. It is signalled
 * only while a process the command recorded moments ago is still in it: once those are gone, their numbers may
 * already belong to unrelated processes. Processes are never picked by name or pattern.
 */
async function stopLeftovers(root: string, file: string): Promise<void> {
  const [group, ...members] = await readPids(root, file).catch((): number[] => []);

  if (group === undefined || !Number.isInteger(group) || group <= 1) return;

  if (!members.some((pid) => processGroupOf(pid) === group)) return;

  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await delay(25);
  }
}

function hasGit(): boolean {
  return runs("git", "--version");
}

function runs(file: string, ...args: string[]): boolean {
  try {
    execFileSync(file, args, { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

/** A port on 127.0.0.1 that nothing listens on: it was free a moment ago. */
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));

  return port;
}
