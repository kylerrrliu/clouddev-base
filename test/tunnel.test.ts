import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir } from "./helpers.ts";

// The A side of the SSH tunnel: client/tunnel/install.sh with --no-load writes every file but never
// connects anywhere or touches launchd, so it can run here with a throwaway HOME.
const TUNNEL = fileURLToPath(new URL("../client/tunnel/", import.meta.url));
const INSTALL = join(TUNNEL, "install.sh");
const run = promisify(execFile);
const hasSsh = spawnSync("ssh-keygen", ["-?"]).error === undefined;
const skip = process.platform === "win32" || !hasSsh ? "needs bash and OpenSSH" : false;

// Terminal, iTerm and VS Code all run shells in a UTF-8 locale, where macOS's bash 3.2 reads "$NAME）" as a
// longer variable name. The scripts run in one here too, whatever the test runner's own locale is.
const UTF8 = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

async function install(home: string, ...args: string[]) {
  return run(INSTALL, ["--no-load", ...args], { env: { ...process.env, ...UTF8, HOME: home } });
}

test("install.sh writes a key, a locked-down ssh config and a launchd job it does not load yet", { skip }, async () => {
  const home = await tempDir();
  const { stdout } = await install(home, "-p", "2222", "--local-port", "17676", "--remote-port", "7700", "bob@192.168.1.20");
  const dir = join(home, ".clouddev-tunnel");

  const config = await readFile(join(dir, "ssh_config"), "utf8");
  for (const line of [
    `Include "${join(dir, "ssh_config.local")}"`,
    "HostName 192.168.1.20",
    "Port 2222",
    "User bob",
    "HostKeyAlias clouddev-b",
    "IdentityAgent none",
    "StrictHostKeyChecking yes",
    "BatchMode yes",
    "LocalForward 127.0.0.1:17676 127.0.0.1:7700",
    "ExitOnForwardFailure yes",
    "ServerAliveInterval 10",
    "ServerAliveCountMax 3",
  ]) {
    assert.ok(config.split("\n").some((text) => text.trim() === line), `ssh_config should contain "${line}"`);
  }

  // B gets a key line that can only forward to its clouddev-base port.
  const keyLine = (await readFile(join(dir, "authorized_keys_line.txt"), "utf8")).trim();
  assert.match(keyLine, /^restrict,port-forwarding,permitopen="127\.0\.0\.1:7700",permitlisten="127\.0\.0\.1:1",command="\/usr\/bin\/false" ssh-ed25519 \S+ clouddev-tunnel@/);
  assert.ok(stdout.includes(keyLine));

  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, "id_ed25519"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "run.sh"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, "common.sh"))).mode & 0o777, 0o600, "run.sh reads the shared paths from next to it");
  assert.equal((await stat(join(dir, "ssh_config.local"))).mode & 0o777, 0o600);

  // The job is prepared, but only copied into LaunchAgents (which launchd loads at every login) once B answered.
  const staged = join(dir, "com.clouddev-base.tunnel.plist");
  const plist = await readFile(staged, "utf8");
  assert.ok(plist.includes(`<string>${join(dir, "run.sh")}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.equal((await stat(staged)).mode & 0o777, 0o644);
  assert.equal(existsSync(join(home, "Library", "LaunchAgents", "com.clouddev-base.tunnel.plist")), false, "--no-load must not install anything launchd starts at login");
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".new")), [], "no half-written files are left behind");

  // ssh must read the config the same way (-G prints the result without connecting).
  const { stdout: effective } = await run("ssh", ["-G", "-F", join(dir, "ssh_config"), "clouddev-b"]);
  assert.match(effective, /^localforward \[127\.0\.0\.1\]:17676 \[127\.0\.0\.1\]:7700$/m);
  assert.match(effective, /^exitonforwardfailure yes$/m);
  assert.match(effective, /^serveraliveinterval 10$/m);
  assert.match(effective, /^serveralivecountmax 3$/m);
  assert.match(effective, /^batchmode yes$/m);
  assert.match(effective, /^identityagent none$/m);
  assert.match(effective, /^hostname 192\.168\.1\.20$/m);

  // Running it again keeps the key (and with it B's authorized_keys line).
  const key = await readFile(join(dir, "id_ed25519"), "utf8");
  await install(home, "bob@192.168.1.21");
  assert.equal(await readFile(join(dir, "id_ed25519"), "utf8"), key);
});

test("settings in ssh_config.local survive re-runs and come first", { skip }, async () => {
  const home = await tempDir();
  const dir = join(home, ".clouddev-tunnel");
  await install(home, "-p", "2222", "bob@127.0.0.1");
  await appendFile(join(dir, "ssh_config.local"), "Host clouddev-b\n    ProxyJump clouddev-relay\n\nHost clouddev-relay\n    HostName r.example.com\n    User tunnel\n");

  await install(home, "--local-port", "7777", "-p", "2222", "bob@127.0.0.1");

  assert.match(await readFile(join(dir, "ssh_config.local"), "utf8"), /ProxyJump clouddev-relay/);
  const { stdout } = await run("ssh", ["-G", "-F", join(dir, "ssh_config"), "clouddev-b"]);
  assert.match(stdout, /^proxyjump clouddev-relay$/m);
  assert.match(stdout, /^localforward \[127\.0\.0\.1\]:7777 \[127\.0\.0\.1\]:7676$/m);
  const relay = await run("ssh", ["-G", "-F", join(dir, "ssh_config"), "clouddev-relay"]);
  assert.match(relay.stdout, /^hostname r\.example\.com$/m);
  // The relay gets the same hardening from the "Host *" defaults without repeating them.
  assert.match(relay.stdout, /^identityagent none$/m);
  assert.match(relay.stdout, /^batchmode yes$/m);
  assert.match(relay.stdout, /^serveraliveinterval 10$/m);
  assert.match(relay.stdout, new RegExp(`^identityfile ${join(dir, "id_ed25519").replaceAll(".", "\\.")}$`, "m"));
});

test("the command printed for B replaces this key's old line and keeps every other key", { skip }, async () => {
  const home = await tempDir();
  const dir = join(home, ".clouddev-tunnel");
  const { stdout } = await install(home, "bob@192.168.1.20");
  const remote = /^ {2}ssh -p \d+ \S+ '(.*)' < .+$/m.exec(stdout)?.[1];
  assert.ok(remote, "install.sh prints a command that updates B's authorized_keys");

  const keyLine = (await readFile(join(dir, "authorized_keys_line.txt"), "utf8")).trim();
  const blob = keyLine.split(" ")[2]!;

  // B's file: an older line for this key (another port), and the owner's own key without a final newline.
  const bHome = await tempDir();
  await mkdir(join(bHome, ".ssh"), { mode: 0o700 });
  const authorized = join(bHome, ".ssh", "authorized_keys");
  await writeFile(authorized, `restrict,port-forwarding,permitopen="127.0.0.1:7000" ssh-ed25519 ${blob} old\nssh-ed25519 AAAAmine me@laptop`);

  const command: string = remote;
  const input = await readFile(join(dir, "authorized_keys_line.txt"));

  for (let i = 0; i < 2; i++) {
    // What ssh does on B: run the quoted command in the user's shell, with the key line on stdin.
    const result = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: bHome }, input });
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(await readFile(authorized, "utf8"), `ssh-ed25519 AAAAmine me@laptop\n${keyLine}\n`, "running it again changes nothing");
  }

  assert.equal((await stat(authorized)).mode & 0o777, 0o600);
});

test("status.sh and uninstall.sh --purge run to the end in a UTF-8 locale", { skip }, async () => {
  // Something else (say, a clouddev-base run on A itself) listens on the tunnel's port.
  const squatter = createServer((_req, res) => res.end('{"ok":true,"name":"clouddev-base"}')).listen(0, "127.0.0.1");
  await once(squatter, "listening");
  const port = String((squatter.address() as AddressInfo).port);
  const home = await tempDir();
  await install(home, "--local-port", port, "bob@192.168.1.20");

  // A launchctl that knows no jobs, so nothing here reaches the real launchd.
  const bin = await tempDir();
  await writeFile(join(bin, "launchctl"), "#!/bin/sh\nexit 113\n", { mode: 0o755 });
  const env = { ...process.env, ...UTF8, HOME: home, PATH: `${bin}:${process.env.PATH}` };

  const status = await run(join(TUNNEL, "status.sh"), [], { env }).finally(() => squatter.close());
  assert.match(status.stdout, /没有加载/);
  assert.match(status.stdout, /被别的程序占着/, "an answer on the port is not taken for the tunnel");
  assert.match(status.stdout, /立即重连/);

  const uninstall = await run(join(TUNNEL, "uninstall.sh"), ["--purge"], { env });
  assert.match(uninstall.stdout, /已删除/);
  assert.equal(existsSync(join(home, ".clouddev-tunnel")), false, "--purge removes the key");
});

test("the tunnel scripts never put a non-ASCII character right after $NAME", async () => {
  for (const file of ["install.sh", "run.sh", "status.sh", "uninstall.sh", "common.sh"]) {
    const lines = (await readFile(join(TUNNEL, file), "utf8")).split("\n");
    const bad = lines.flatMap((line, index) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));

    assert.deepEqual(bad, [], "write ${NAME} there: bash 3.2 in a UTF-8 locale reads the character as part of the name");
  }
});

test("install.sh escapes % in IPv6 zone ids for ssh_config", { skip }, async () => {
  const home = await tempDir();
  await install(home, "bob@[fe80::1%en0]");

  const { stdout: effective } = await run("ssh", ["-G", "-F", join(home, ".clouddev-tunnel", "ssh_config"), "clouddev-b"]);
  assert.match(effective, /^hostname fe80::1%en0$/m);
});

test("install.sh refuses targets and options that are not plain values", { skip }, async () => {
  const home = await tempDir();

  for (const [args, message] of [
    [["bob@host -oProxyCommand=evil"], /不支持的字符/],
    [["bob;rm@host"], /不支持的字符/],
    [["host-without-user"], /用户名/],
    [["-p", "99999", "bob@host"], /无效的端口/],
    [["--remote-port"], /需要一个端口号/],
    [["--bogus", "bob@host"], /未知选项/],
  ] as const) {
    await assert.rejects(install(home, ...args), (error: { stderr?: string }) => message.test(error.stderr ?? ""), `${args.join(" ")} should be refused`);
  }
});
