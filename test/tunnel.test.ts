import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { httpGet, tempDir } from "./helpers.ts";

// The A side of the SSH tunnel: client/tunnel/install.sh with --no-load writes every file but never
// connects anywhere or touches launchd, so it can run here with a throwaway HOME. The tests at the end of the file
// run it for real, against an sshd of their own and a fake launchctl.
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
  assert.deepEqual(await leftovers(dir), [], "no half-written files are left behind");

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

test("a re-run keeps the ports it is not given from the last run, and points out the ones that change", { skip }, async () => {
  const home = await tempDir();
  const dir = join(home, ".clouddev-tunnel");
  const effective = async () => (await run("ssh", ["-G", "-F", join(dir, "ssh_config"), "clouddev-b"])).stdout;
  await install(home, "-p", "2222", "--local-port", "17676", "--remote-port", "7700", "bob@192.168.1.20");

  // As README's upgrade advice has it: the same command again, without remembering the ports.
  const again = await install(home, "bob@192.168.1.20");
  assert.match(again.stdout, /沿用上次的端口设置：-p 2222 --local-port 17676 --remote-port 7700/);
  let config = await effective();
  assert.match(config, /^port 2222$/m);
  assert.match(config, /^localforward \[127\.0\.0\.1\]:17676 \[127\.0\.0\.1\]:7700$/m);
  assert.match(await readFile(join(dir, "authorized_keys_line.txt"), "utf8"), /permitopen="127\.0\.0\.1:7700"/, "B's line keeps the port too");

  // A port on the command line wins, and the change is pointed out.
  const changed = await install(home, "--local-port", "7777", "bob@192.168.1.20");
  assert.match(changed.stdout, /提示: --local-port 改成了 7777（上次是 17676）/);
  assert.match(changed.stdout, /沿用上次的端口设置：-p 2222 --remote-port 7700（/);
  config = await effective();
  assert.match(config, /^port 2222$/m);
  assert.match(config, /^localforward \[127\.0\.0\.1\]:7777 \[127\.0\.0\.1\]:7700$/m);

  // Ports that were the defaults anyway are not worth a line.
  const plain = await tempDir();
  await install(plain, "bob@192.168.1.20");
  assert.doesNotMatch((await install(plain, "bob@192.168.1.20")).stdout, /沿用上次|改成了/);
});

test("a re-run for another B address does not keep -p, and still keeps the clouddev-base ports", { skip }, async () => {
  const home = await tempDir();
  const dir = join(home, ".clouddev-tunnel");
  const effective = async () => (await run("ssh", ["-G", "-F", join(dir, "ssh_config"), "clouddev-b"])).stdout;
  // README "A 连不到 B 时": B's SSH is R's 127.0.0.1:2222. Later A reaches B in its own LAN, on B's own SSH port.
  await install(home, "-p", "2222", "--local-port", "17676", "--remote-port", "7700", "bob@127.0.0.1");

  const moved = await install(home, "bob@bob-mac.local");
  assert.match(moved.stdout, /提示: B 的地址和上次（127\.0\.0\.1）不一样，-p 没有沿用上次的 2222，用默认的 22/);
  assert.match(moved.stdout, /沿用上次的端口设置：--local-port 17676 --remote-port 7700（/);
  assert.match(moved.stdout, /^ {2}ssh -p 22 bob@bob-mac\.local /m, "the command printed for B uses B's own SSH port");
  let config = await effective();
  assert.match(config, /^hostname bob-mac\.local$/m);
  assert.match(config, /^port 22$/m, "--no-load does not write R's port into the config a running tunnel picks up");
  assert.match(config, /^localforward \[127\.0\.0\.1\]:17676 \[127\.0\.0\.1\]:7700$/m);

  // The same name in other letters is the same B: a new -p is a change, and it is kept from then on.
  assert.match((await install(home, "-p", "2200", "bob@Bob-Mac.local")).stdout, /提示: -p 改成了 2200（上次是 22）/);
  const same = await install(home, "bob@bob-mac.local");
  assert.match(same.stdout, /沿用上次的端口设置：-p 2200 --local-port 17676 --remote-port 7700（/);
  assert.doesNotMatch(same.stdout, /地址和上次/);

  // -p for another address is not a change from the port of the old one.
  const back = await install(home, "-p", "2222", "bob@127.0.0.1");
  assert.doesNotMatch(back.stdout, /改成了|地址和上次/);
  config = await effective();
  assert.match(config, /^port 2222$/m);
});

test("install.sh warns when client/.mcp.json next to it points at another port than --local-port", { skip: skip || (!existsSync("/usr/bin/plutil") ? "reads .mcp.json with plutil" : false) }, async () => {
  // A copy of client/ whose .mcp.json was moved to 17676, as on a single Mac (e2e/README).
  const client = join(await tempDir(), "client");
  await cp(TUNNEL, join(client, "tunnel"), { recursive: true });
  await writeFile(join(client, ".mcp.json"), JSON.stringify({ mcpServers: { "clouddev-base": { type: "http", url: "http://127.0.0.1:17676/mcp", timeout: 330000 } } }));
  const home = await tempDir();
  const copy = (...args: string[]) => run("/bin/bash", [join(client, "tunnel", "install.sh"), "--no-load", ...args], { env: { ...process.env, ...UTF8, HOME: home } });

  const forgot = await copy("bob@192.168.1.20");
  assert.match(forgot.stdout, /\.mcp\.json 里的地址是 http:\/\/127\.0\.0\.1:17676\/mcp，端口和 --local-port 7676 不一样/);
  assert.match(forgot.stdout, /或者用 --local-port 17676 重新运行本脚本/);

  for (const args of [["--local-port", "17676"], []]) {
    const { stdout } = await copy(...args, "bob@192.168.1.20");
    assert.doesNotMatch(stdout, /\.mcp\.json 里的地址/, `${args.join(" ") || "no port"}: A's port and .mcp.json agree`);
  }
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

test("status.sh reaches the tunnel directly when a proxy is set", { skip }, async () => {
  // The "tunnel": this process listens on the port, and a fake launchctl says the job's pid is this process.
  const tunnel = await answer(JSON.stringify({ ok: true, name: "clouddev-base" }));
  const home = await tempDir();
  await install(home, "--local-port", String(tunnel.port), "bob@192.168.1.20");
  const bin = await tempDir();
  await writeFile(join(bin, "launchctl"), `#!/bin/sh\n[ "$1" = print ] || exit 0\nprintf '%s = {\\n\\tstate = running\\n\\tpid = ${process.pid}\\n}\\n' "$2"\n`, { mode: 0o755 });

  // curl uses these for 127.0.0.1 too: a proxy that does not pass loopback through made a working tunnel look down.
  const dead = `127.0.0.1:${await freePort()}`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...UTF8, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.no_proxy;
  delete env.NO_PROXY;
  Object.assign(env, { http_proxy: `http://${dead}`, HTTP_PROXY: `http://${dead}`, all_proxy: `socks5://${dead}`, ALL_PROXY: `socks5://${dead}` });

  const status = await run(join(TUNNEL, "status.sh"), [], { env }).finally(() => tunnel.close());
  assert.match(status.stdout, /healthz）: 正常/);
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
  await install(home, "-p", "2222", "bob@[fe80::1%en0]");

  const { stdout: effective } = await run("ssh", ["-G", "-F", join(home, ".clouddev-tunnel", "ssh_config"), "clouddev-b"]);
  assert.match(effective, /^hostname fe80::1%en0$/m);

  // A re-run compares the address as written there, %% and all, and shows it as given.
  assert.match((await install(home, "bob@[fe80::1%en0]")).stdout, /沿用上次的端口设置：-p 2222（/);
  assert.match((await install(home, "bob@bob-mac.local")).stdout, /B 的地址和上次（fe80::1%en0）不一样/);
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

/** Files a run of install.sh must never leave behind in ~/.clouddev-tunnel. */
async function leftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".new") || name.includes(".probe"));
}

/** A port nothing listens on (right now). */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");

  return port;
}

/** A TCP server on 127.0.0.1 that takes connections and what they send, and then neither answers nor closes. */
async function silentServer(): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy();

      server.close();
    },
  };
}

/**
 * Command lines of the processes whose command line contains `text`, once they have had `grace` ms to exit. Only
 * looks at the process list: nothing is signalled.
 */
async function processesWith(text: string, grace = 0): Promise<string[]> {
  const deadline = Date.now() + grace;

  for (;;) {
    const found = (await run("ps", ["-axww", "-o", "command="])).stdout.split("\n").filter((command) => command.includes(text));

    if (found.length === 0 || Date.now() >= deadline) return found;

    await delay(100);
  }
}

/** An HTTP server on 127.0.0.1 that answers every request with `body`. */
async function answer(body: string): Promise<{ port: number; close: () => void }> {
  const server = createServer((_req, res) => res.end(body)).listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// install.sh for real. What it checks on B only means something against a real sshd, so these tests start one:
// unprivileged, on a random 127.0.0.1 port, with its own host key and authorized_keys. "B" is this machine and this
// user, and B's clouddev-base is a stand-in in this process. launchd is a fake launchctl that runs the one job in the
// background, and expect presses Enter at install.sh's prompt.
const SSHD = "/usr/sbin/sshd";
const hasExpect = spawnSync("expect", ["-v"]).error === undefined;
const skipReal = skip || (process.platform !== "darwin" ? "installs into launchd: macOS only" : !existsSync(SSHD) ? "needs /usr/sbin/sshd" : !hasExpect ? "needs expect" : false);
const USER = userInfo().username;
const SERVICE_BODY = JSON.stringify({ ok: true, name: "clouddev-base", pid: process.pid });

// One job, no restarts, its state in $FAKE_LAUNCHD: nothing reaches the real launchd. nohup, because the job starts
// from install.sh's terminal and has to outlive it, as a launchd job would. It signals the job only while the pid it
// recorded still runs this HOME's tunnel (run.sh, then ssh -F ssh_config), never a process that got that pid later.
const FAKE_LAUNCHCTL = `#!/bin/sh
state="\${FAKE_LAUNCHD:?}"
job() {
  pid="$(cat "$state/pid" 2>/dev/null)" || return 1
  case "$(ps -ww -o command= -p "$pid" 2>/dev/null)" in
    *"$HOME/.clouddev-tunnel/"*) echo "$pid" ;;
    *) return 1 ;;
  esac
}
case "$1" in
  print)
    [ -f "$state/loaded" ] || exit 113
    echo "$2 = {"
    if pid="$(job)"; then printf '\\tstate = running\\n\\tpid = %s\\n' "$pid"; else printf '\\tstate = not running\\n'; fi
    echo "}"
    ;;
  bootout)
    [ -f "$state/loaded" ] || exit 3
    # Like launchd, return once the job is gone: the next tunnel binds the same port.
    if pid="$(job)"; then
      kill "$pid"
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        job >/dev/null || break
        sleep 0.1
      done
    fi
    rm -f "$state/loaded" "$state/pid"
    ;;
  bootstrap)
    run="$(/usr/bin/plutil -extract ProgramArguments.1 raw "$3")" || exit 5
    touch "$state/loaded"
    nohup /bin/sh "$run" </dev/null >/dev/null 2>&1 &
    echo $! >"$state/pid"
    ;;
esac
exit 0
`;

// Enter at the prompt. B's host key is in known_hosts beforehand, so a host key question means something broke.
// With $INTERRUPT_ON set, Ctrl+C a second after install.sh prints that text. wait reports a process killed by a
// signal with status 0 and then CHILDKILLED <signal>: that becomes exit code 128 and a line naming the signal.
const EXPECT_SCRIPT = `set timeout 60
set interrupt_on "\\x01none\\x01"
if {[info exists env(INTERRUPT_ON)]} { set interrupt_on $env(INTERRUPT_ON) }
spawn {*}$argv
expect {
  -ex "Ctrl+C" { send "\\r"; exp_continue }
  -ex "(yes/no/\\[fingerprint\\])?" { send "no\\r"; exp_continue }
  -ex $interrupt_on { sleep 1; send "\\003"; exp_continue }
  timeout { exit 124 }
  eof
}
catch wait result
if {[lindex $result 4] eq "CHILDKILLED"} {
  puts "\\nkilled by [lindex $result 5]"
  exit 128
}
exit [lindex $result 3]
`;

// What these tests start (sshd, the tunnel), stopped at the end of the file even when a test gives up half-way.
const cleanups = new Set<() => Promise<void>>();
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** Run `stop` at the end of the file unless it ran before; the returned function runs it now (once). */
function atEnd(stop: () => Promise<void>): () => Promise<void> {
  const runOnce = async () => {
    if (cleanups.delete(runOnce)) await stop().catch(() => {});
  };
  cleanups.add(runOnce);

  return runOnce;
}

/** B's sshd, or undefined when it cannot start here. Without `allowStreamLocal` it keeps sshd's default (yes). */
async function startSshd(allowStreamLocal?: "local"): Promise<{ port: number; dir: string; stop: () => Promise<void> } | undefined> {
  const dir = await tempDir();
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "hostkey")]);

  // The port is free when picked, but something else may take it before sshd binds it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const config = [`Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${join(dir, "hostkey")}`, `PidFile ${join(dir, "sshd.pid")}`, `AuthorizedKeysFile ${join(dir, "authorized_keys")}`, "StrictModes no", "UsePAM no", "PasswordAuthentication no", "KbdInteractiveAuthentication no"];

    if (allowStreamLocal) config.push(`AllowStreamLocalForwarding ${allowStreamLocal}`);

    await writeFile(join(dir, "sshd_config"), `${config.join("\n")}\n`);
    const sshd = spawn(SSHD, ["-D", "-e", "-f", join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    let exited = false;
    // "exit", not "close": sshd's per-connection processes share its stderr and may hold it a moment longer.
    const exit = new Promise<void>((resolve) => {
      sshd.on("exit", () => resolve());
      sshd.on("error", () => resolve());
    }).then(() => {
      exited = true;
    });
    sshd.stderr.setEncoding("utf8").on("data", (text: string) => (log += text));
    const stop = atEnd(async () => {
      // A no-op once this sshd has exited: kill() only ever signals the process this ChildProcess started.
      sshd.kill();
      await exit;
      sshd.stderr.destroy();
    });

    const deadline = Date.now() + 5000;

    while (!log.includes("Server listening on") && !exited && Date.now() < deadline) await delay(20);

    if (log.includes("Server listening on") && !exited) return { port, dir, stop };

    await stop();
  }

  return undefined;
}

type Side = { home: string; dir: string; launchd: string; env: Record<string, string>; tunnel?: number };

let expectFile: string | undefined;

type InstallOptions = {
  env?: Record<string, string>;
  /** Sees everything install.sh has printed so far, each time it prints more. */
  onOutput?: (output: string) => void;
  /**
   * Run install.sh, and so everything it starts, with SIGHUP ignored. install.sh leads the pseudo-terminal's session
   * here, so when it exits, the terminal hangs up and SIGHUP stops what it left running. In Terminal the login shell
   * leads the session and stays: only install.sh itself can stop what it started.
   */
  ignoreHangup?: boolean;
};

/** install.sh without --no-load, in a pseudo-terminal, with Enter pressed at its prompt. */
async function installForReal(a: Side, args: string[], options: InstallOptions = {}): Promise<{ code: number | null; output: string }> {
  if (!expectFile) {
    expectFile = join(await tempDir(), "install.exp");
    await writeFile(expectFile, EXPECT_SCRIPT);
  }

  const command = options.ignoreHangup ? ["/bin/sh", "-c", 'trap "" HUP; exec /bin/bash "$@"', "sh", INSTALL, ...args] : ["/bin/bash", INSTALL, ...args];
  const child = spawn("expect", [expectFile, ...command], { env: { ...a.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const add = (text: string) => {
    output += text;
    options.onOutput?.(output);
  };
  child.stdout.setEncoding("utf8").on("data", add);
  child.stderr.setEncoding("utf8").on("data", add);
  // A stuck install.sh fails the test rather than hanging it: expect's end closes the terminal install.sh runs in.
  const timer = setTimeout(() => child.kill(), 90_000);
  const [code] = (await once(child, "close")) as [number | null];
  clearTimeout(timer);

  // The job the fake launchd runs now (a re-run replaces it), for stopTunnel.
  a.tunnel = Number(await readFile(join(a.launchd, "pid"), "utf8").catch(() => "")) || a.tunnel;

  return { code, output: output.replaceAll("\r", "") };
}

/** Stop the tunnel the fake launchd started, if that pid still runs this HOME's tunnel and not something else by now. */
async function stopTunnel(a: Side): Promise<void> {
  if (!a.tunnel) return;

  const command = await run("ps", ["-ww", "-o", "command=", "-p", String(a.tunnel)]).then(({ stdout }) => stdout, () => "");

  if (command.includes(`${a.home}/.clouddev-tunnel/`)) process.kill(a.tunnel);

  a.tunnel = undefined;
}

/**
 * B (an sshd, and a stand-in clouddev-base on `service`) and A (a temp HOME whose key B's authorized_keys has, after
 * `line` edits it), as when the user has done B's part and presses Enter at install.sh's prompt. `args(port)` are
 * install.sh's arguments for --remote-port `port`; B's line names `remotePort` (the stand-in's port unless given).
 * `localConf` goes into A's ssh_config.local, where users put their own ssh settings.
 */
async function scenario(t: TestContext, options: { allowStreamLocal?: "local"; remotePort?: number; line?: (line: string) => string; localConf?: string } = {}) {
  const b = await startSshd(options.allowStreamLocal);

  if (!b) {
    t.skip("sshd does not start here");

    return undefined;
  }

  const service = await answer(SERVICE_BODY);
  const home = await tempDir();
  const launchd = await tempDir();
  const bin = await tempDir();
  await writeFile(join(bin, "launchctl"), FAKE_LAUNCHCTL, { mode: 0o755 });
  // Only what install.sh needs: nothing from this shell (proxies, ssh-agent) leaks in.
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, ...UTF8, TERM: "dumb", FAKE_LAUNCHD: launchd };
  const a: Side = { home, dir: join(home, ".clouddev-tunnel"), launchd, env };
  const localPort = await freePort();
  const args = (port: number) => ["-p", String(b.port), "--local-port", String(localPort), "--remote-port", String(port), `${USER}@127.0.0.1`];

  // --no-load makes the key and B's line; B's host key goes into known_hosts as if the user had confirmed it before.
  await install(home, ...args(options.remotePort ?? service.port));
  const line = await readFile(join(a.dir, "authorized_keys_line.txt"), "utf8");
  await writeFile(join(b.dir, "authorized_keys"), options.line ? options.line(line) : line);
  const hostKey = (await readFile(join(b.dir, "hostkey.pub"), "utf8")).split(" ").slice(0, 2).join(" ");
  await writeFile(join(a.dir, "known_hosts"), `clouddev-b ${hostKey}\n`);

  if (options.localConf) await appendFile(join(a.dir, "ssh_config.local"), options.localConf);

  const cleanup = atEnd(async () => {
    await stopTunnel(a);
    await b.stop();
    service.close();
  });

  return { a, b, service, localPort, args, cleanup, plist: join(home, "Library", "LaunchAgents", "com.clouddev-base.tunnel.plist") };
}

const IN_USE = "# the config in use before this run\n";

/** Mark the ssh config in use, to tell later whether a run of install.sh replaced it. */
async function markConfig(a: Side): Promise<void> {
  await appendFile(join(a.dir, "ssh_config"), IN_USE);
}

async function configKept(a: Side): Promise<boolean> {
  return (await readFile(join(a.dir, "ssh_config"), "utf8")).endsWith(IN_USE);
}

/** The Unix socket path the check on B tried. */
function probeSocket(output: string): string | undefined {
  return /\/tmp\/clouddev-probe-\d+-\d+\.sock/.exec(output)?.[0];
}

const CHECKED = [
  /✓ 能连上 B，这把钥匙在 B 上执行不了命令/,
  /✓ B 不让这把钥匙随便转发：试了转发到 127\.0\.0\.1:1/,
  /✓ 这把钥匙不能在 B 上随意监听端口/,
  /✓ 这把钥匙不能在 B 上建 Unix socket/,
];

test("install.sh checks what the key can do on B, then installs a tunnel that works through a proxy", { skip: skipReal, timeout: 120_000 }, async (t) => {
  const s = await scenario(t, { allowStreamLocal: "local" });

  if (!s) return;

  // A proxy that does not pass loopback through must not make the working tunnel look down.
  const dead = `127.0.0.1:${await freePort()}`;
  const proxies = { http_proxy: `http://${dead}`, all_proxy: `socks5://${dead}` };

  try {
    await markConfig(s.a);
    const result = await installForReal(s.a, s.args(s.service.port), { env: proxies });
    assert.equal(result.code, 0, result.output);

    for (const check of [...CHECKED, new RegExp(`✓ 这把钥匙能转发到 B 的 127\\.0\\.0\\.1:${s.service.port}，那里回答的是 clouddev-base`), /✓ 隧道已连通/]) {
      assert.match(result.output, check);
    }

    const socket = probeSocket(result.output);
    assert.ok(socket, "the check names the socket it tried");
    assert.equal(existsSync(socket), false, "B refused it, so nothing is left there");
    assert.equal(await configKept(s.a), false, "the new config is in use");
    assert.ok(existsSync(s.plist), "the job is in LaunchAgents");
    assert.deepEqual(await leftovers(s.a.dir), []);
    assert.match((await httpGet(`http://127.0.0.1:${s.localPort}/healthz`)).body, /clouddev-base/, "A's port reaches B's service");
    assert.match((await run(join(TUNNEL, "status.sh"), [], { env: { ...s.a.env, ...proxies } })).stdout, /healthz）: 正常/);

    // Again, while that tunnel holds A's port: the checks use a config without LocalForward, so they still run.
    const again = await installForReal(s.a, s.args(s.service.port), { env: proxies });
    assert.equal(again.code, 0, again.output);

    for (const check of CHECKED) assert.match(again.output, check);
  } finally {
    await s.cleanup();
  }
});

test("install.sh stops, before replacing anything, when the key may listen on B", { skip: skipReal, timeout: 120_000 }, async (t) => {
  const withoutPermitlisten = (line: string) => {
    const edited = line.replace('permitlisten="127.0.0.1:1",', "");
    assert.notEqual(edited, line, "the line install.sh prints has permitlisten to take out");

    return edited;
  };
  const s = await scenario(t, { allowStreamLocal: "local", line: withoutPermitlisten });

  if (!s) return;

  try {
    await markConfig(s.a);
    const result = await installForReal(s.a, s.args(s.service.port));

    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /还能监听端口.*permitlisten/);
    assert.doesNotMatch(result.output, /✓ 这把钥匙不能在 B 上随意监听端口/);
    assert.ok(await configKept(s.a), "the config in use stays");
    assert.equal(existsSync(s.plist), false);
    assert.deepEqual(await leftovers(s.a.dir), []);
  } finally {
    await s.cleanup();
  }
});

test("install.sh stops when B's sshd allows Unix socket forwarding, and names the socket the check left there", { skip: skipReal, timeout: 120_000 }, async (t) => {
  // sshd's default, AllowStreamLocalForwarding yes: README "在 B 上" step 5 skipped.
  const s = await scenario(t);

  if (!s) return;

  let socket: string | undefined;

  try {
    await markConfig(s.a);
    const result = await installForReal(s.a, s.args(s.service.port));
    socket = probeSocket(result.output);

    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /✓ 这把钥匙不能在 B 上随意监听端口/);
    assert.match(result.output, /还能建 Unix socket.*AllowStreamLocalForwarding local/);
    assert.ok(socket, "the message names the socket");
    assert.ok((await lstat(socket)).isSocket(), "it really is on B, and the key cannot remove it");
    assert.ok(result.output.includes(`rm ${socket}`));
    assert.ok(await configKept(s.a), "the config in use stays");
    assert.equal(existsSync(s.plist), false);
    assert.deepEqual(await leftovers(s.a.dir), []);
  } finally {
    // B is this machine: remove the socket the check left, by its exact path.
    if (socket) await rm(socket, { force: true });

    await s.cleanup();
  }
});

test("install.sh leaves a working tunnel alone when B does not let the key reach --remote-port", { skip: skipReal, timeout: 120_000 }, async (t) => {
  const s = await scenario(t, { allowStreamLocal: "local" });

  if (!s) return;

  try {
    const first = await installForReal(s.a, s.args(s.service.port));
    assert.equal(first.code, 0, first.output);
    const pid = s.a.tunnel;
    assert.ok(pid);
    await markConfig(s.a);

    // B's line still names the service's port, as when --remote-port is wrong or an older line for the key comes first.
    const wrong = await freePort();
    const result = await installForReal(s.a, s.args(wrong));

    assert.equal(result.code, 1, result.output);
    assert.match(result.output, new RegExp(`转发不到 127\\.0\\.0\\.1:${wrong}（B 拒绝了）`));
    assert.ok(await configKept(s.a), "the config in use stays");
    assert.equal(s.a.tunnel, pid, "the running tunnel is not restarted");
    assert.match((await httpGet(`http://127.0.0.1:${s.localPort}/healthz`)).body, /clouddev-base/, "and it still works");
    assert.deepEqual(await leftovers(s.a.dir), []);
  } finally {
    await s.cleanup();
  }
});

test("install.sh warns, and still installs, when B's port has no clouddev-base on it", { skip: skipReal, timeout: 120_000 }, async (t) => {
  const other = await answer("OTHER-SERVICE");
  const closed = await freePort();

  try {
    for (const [port, warning] of [
      [closed, new RegExp(`127\\.0\\.0\\.1:${closed} 上现在没有程序在监听`)],
      [other.port, /回答的是别的程序，不是 clouddev-base/],
    ] as const) {
      const s = await scenario(t, { allowStreamLocal: "local", remotePort: port });

      if (!s) return;

      try {
        // The tunnel cannot reach clouddev-base, so the wait at the end runs out: one second is enough here.
        const result = await installForReal(s.a, s.args(port), { env: { CLOUDDEV_TUNNEL_WAIT: "1" } });

        assert.equal(result.code, 1, result.output);
        assert.match(result.output, warning);

        for (const check of CHECKED) assert.match(result.output, check);

        assert.ok(existsSync(s.plist), "installed anyway: the tunnel connects once the service runs");
        assert.match(result.output, /1 秒内经隧道访问不到/);
      } finally {
        await s.cleanup();
      }
    }
  } finally {
    other.close();
  }
});

test("install.sh stops, before replacing anything, when the key may forward anywhere or run commands on B", { skip: skipReal, timeout: 120_000 }, async (t) => {
  for (const [option, cut, message] of [
    ["permitopen", (line: string) => line.replace(/permitopen="[^"]*",/, ""), /还能转发到别的端口.*permitopen/],
    // With its comma: a dangling one would make sshd reject the whole line.
    ["command=", (line: string) => line.replace(',command="/usr/bin/false"', ""), /还能执行命令/],
  ] as const) {
    const line = (text: string) => {
      const edited = cut(text);
      assert.notEqual(edited, text, `the line install.sh prints has ${option} to take out`);

      return edited;
    };
    const s = await scenario(t, { allowStreamLocal: "local", line });

    if (!s) return;

    try {
      await markConfig(s.a);
      const result = await installForReal(s.a, s.args(s.service.port));

      assert.equal(result.code, 1, result.output);
      assert.match(result.output, message);
      assert.ok(await configKept(s.a), "the config in use stays");
      assert.equal(existsSync(s.plist), false);
      assert.deepEqual(await leftovers(s.a.dir), []);
    } finally {
      await s.cleanup();
    }
  }
});

test("install.sh still reads B's answers when ssh_config.local turns ssh's messages down", { skip: skipReal, timeout: 120_000 }, async (t) => {
  // B's refusals come in INFO lines, which LogLevel ERROR hides: without its own LogLevel, every check would come out
  // unknown, and a wrong --remote-port would replace a working tunnel.
  const s = await scenario(t, { allowStreamLocal: "local", localConf: "Host *\n    LogLevel ERROR\n" });

  if (!s) return;

  try {
    const first = await installForReal(s.a, s.args(s.service.port));
    assert.equal(first.code, 0, first.output);

    for (const check of CHECKED) assert.match(first.output, check);

    const pid = s.a.tunnel;
    assert.ok(pid);
    await markConfig(s.a);

    const wrong = await freePort();
    const result = await installForReal(s.a, s.args(wrong));

    assert.equal(result.code, 1, result.output);
    assert.match(result.output, new RegExp(`转发不到 127\\.0\\.0\\.1:${wrong}（B 拒绝了）`));
    assert.ok(await configKept(s.a), "the config in use stays");
    assert.equal(s.a.tunnel, pid, "the running tunnel is not restarted");
    assert.match((await httpGet(`http://127.0.0.1:${s.localPort}/healthz`)).body, /clouddev-base/, "and it still works");
    assert.deepEqual(await leftovers(s.a.dir), []);
  } finally {
    await s.cleanup();
  }
});

test("install.sh still tries the Unix socket on B when forwards of ssh_config.local get in the way", { skip: skipReal, timeout: 120_000 }, async (t) => {
  // The user's own forwards: a LocalForward on a port something here holds (on a re-run, the tunnel itself), which
  // ssh cannot set up, and a RemoteForward that B refuses. Neither may decide the check: B keeps sshd's default
  // AllowStreamLocalForwarding yes, so the key can make sockets there and install.sh must stop.
  const held = await answer("held");
  let socket: string | undefined;
  const s = await scenario(t, { localConf: `Host clouddev-b\n    LocalForward 127.0.0.1:${held.port} 127.0.0.1:9\n    RemoteForward 127.0.0.1:${held.port} 127.0.0.1:9\n` });

  try {
    if (!s) return;

    await markConfig(s.a);
    const result = await installForReal(s.a, s.args(s.service.port));
    socket = probeSocket(result.output);

    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /✓ 这把钥匙不能在 B 上随意监听端口/);
    assert.match(result.output, /还能建 Unix socket.*AllowStreamLocalForwarding local/);
    assert.ok(socket, "the message names the socket");
    assert.ok((await lstat(socket)).isSocket(), "B really let the key make it");
    assert.ok(await configKept(s.a), "the config in use stays");
    assert.equal(existsSync(s.plist), false);
    assert.deepEqual(await leftovers(s.a.dir), []);
  } finally {
    // B is this machine: remove the socket the check left, by its exact path.
    if (socket) await rm(socket, { force: true });

    held.close();
    await s?.cleanup();
  }
});

test("install.sh gives up on a --remote-port that never answers, and keeps the config in use", { skip: skipReal, timeout: 120_000 }, async (t) => {
  // ssh -W would wait for ever there.
  const silent = await silentServer();
  const s = await scenario(t, { allowStreamLocal: "local", remotePort: silent.port });

  try {
    if (!s) return;

    await markConfig(s.a);
    const started = Date.now();
    const result = await installForReal(s.a, s.args(silent.port), { env: { CLOUDDEV_TUNNEL_PROBE_WAIT: "1" } });

    assert.equal(result.code, 1, result.output);

    for (const check of CHECKED) assert.match(result.output, check);

    assert.match(result.output, new RegExp(`127\\.0\\.0\\.1:${silent.port}，1 秒内没有完成（连接太慢，或者那个端口上的程序不回答）`));
    assert.ok(Date.now() - started < 20_000, "the wait comes from CLOUDDEV_TUNNEL_PROBE_WAIT, not the 30 s default");
    assert.ok(await configKept(s.a), "the config in use stays");
    assert.equal(existsSync(s.plist), false);
    assert.deepEqual(await leftovers(s.a.dir), []);
    assert.deepEqual(await processesWith(`${s.a.dir}/ssh_config.probe`), [], "the ssh it gave up on was stopped before install.sh exited");
  } finally {
    silent.close();
    await s?.cleanup();
  }
});

test("Ctrl+C while install.sh waits for --remote-port stops that check's ssh and keeps the config in use", { skip: skipReal, timeout: 120_000 }, async (t) => {
  const silent = await silentServer();
  const s = await scenario(t, { allowStreamLocal: "local", remotePort: silent.port });

  try {
    if (!s) return;

    await markConfig(s.a);
    const started = Date.now();
    // A second into the wait (30 s by default). The check's ssh runs in the background, where Ctrl+C does not reach it:
    // install.sh's exit has to stop it.
    const result = await installForReal(s.a, s.args(silent.port), { env: { INTERRUPT_ON: "✓ 这把钥匙不能在 B 上建 Unix socket" }, ignoreHangup: true });

    assert.equal(result.code, 128, result.output);
    assert.match(result.output, /killed by SIGINT/);
    assert.ok(Date.now() - started < 20_000, "it did not wait for the check to give up");
    assert.ok(await configKept(s.a), "the config in use stays");
    assert.equal(existsSync(s.plist), false);
    assert.deepEqual(await leftovers(s.a.dir), []);
    // It was sent SIGTERM on the way out, without waiting for it: give it a moment.
    assert.deepEqual(await processesWith(`${s.a.dir}/ssh_config.probe`, 2000), [], "no check is left running");
  } finally {
    silent.close();
    await s?.cleanup();
  }
});

test("through a relay, install.sh checks B, and a relay that cannot reach B is not taken for B's answer", { skip: skipReal, timeout: 120_000 }, async (t) => {
  // README "A 连不到 B 时": A reaches B's sshd through R's, with ProxyJump in ssh_config.local.
  const r = await startSshd();

  if (!r) {
    t.skip("sshd does not start here");

    return;
  }

  try {
    const relay = `Host clouddev-b\n    ProxyJump clouddev-relay\n\nHost clouddev-relay\n    HostName 127.0.0.1\n    Port ${r.port}\n    User ${USER}\n`;
    const rHostKey = (await readFile(join(r.dir, "hostkey.pub"), "utf8")).split(" ").slice(0, 2).join(" ");

    // B stays up; then B's sshd stops right after the first check, as when B's own link to R drops. R then answers
    // the next check with "open failed: connect failed", which once read as B forwarding anywhere.
    for (const drop of [false, true]) {
      const s = await scenario(t, { allowStreamLocal: "local", localConf: relay });

      if (!s) return;

      try {
        // R's line for A's key, as README gives it: it may only reach B's SSH port.
        const key = (await readFile(join(s.a.dir, "id_ed25519.pub"), "utf8")).trim();
        await writeFile(join(r.dir, "authorized_keys"), `restrict,port-forwarding,permitopen="127.0.0.1:${s.b.port}",permitlisten="127.0.0.1:1",command="/usr/bin/false" ${key}\n`);
        await appendFile(join(s.a.dir, "known_hosts"), `[127.0.0.1]:${r.port} ${rHostKey}\n`);
        await markConfig(s.a);
        let stopped = false;
        const stopB = (output: string) => {
          if (drop && !stopped && output.includes("✓ 能连上 B")) {
            stopped = true;
            void s.b.stop();
          }
        };
        const result = await installForReal(s.a, s.args(s.service.port), { onOutput: stopB });

        if (drop) {
          assert.equal(result.code, 1, result.output);
          assert.match(result.output, /这次没能连上 B/);
          assert.doesNotMatch(result.output, /还能转发到别的端口|没在运行|错误: 没能确认/);
          assert.ok(await configKept(s.a), "the config in use stays");
          assert.equal(existsSync(s.plist), false);
        } else {
          assert.equal(result.code, 0, result.output);

          for (const check of [...CHECKED, /✓ 这把钥匙能转发到 B 的 127\.0\.0\.1:\d+，那里回答的是 clouddev-base/, /✓ 隧道已连通/]) assert.match(result.output, check);
        }

        assert.deepEqual(await leftovers(s.a.dir), []);
      } finally {
        await s.cleanup();
      }

      // Every ssh it started, the jumps through R included, is gone with the tunnel.
      assert.deepEqual(await processesWith(`${s.a.home}/`, 2000), []);
    }
  } finally {
    await r.stop();
  }
});

// A ProxyCommand for ssh_config.local that loses B part-way, with no timing involved. It counts the connections in $2
// and passes each through to B's sshd on port $1, until connection $3: from that one on it fails the way a relay that
// can no longer reach B does, with R's "open failed: connect failed" on stderr and no SSH at all.
const LOSING_PROXY = `#!/bin/sh
n=$(( $(cat "$2" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$2"
if [ "$n" -ge "$3" ]; then
  echo "channel 0: open failed: connect failed: Connection refused" >&2
  echo "stdio forwarding failed" >&2
  exit 255
fi
exec /usr/bin/nc 127.0.0.1 "$1"
`;

test("install.sh stops as unreached at whichever check B drops out of, and keeps the config in use", { skip: skipReal || (!existsSync("/usr/bin/nc") ? "needs /usr/bin/nc" : false), timeout: 120_000 }, async (t) => {
  // install.sh connects to B five times, one connection per check: ssh true, -W 127.0.0.1:1, -R 127.0.0.1:0,
  // -R <socket>, then -W to --remote-port. Read as B's answer, R's connect failed would be "the key forwards anywhere"
  // on the second, and on the last "nothing listens on --remote-port", a notice before installing anyway.
  const passed = [...CHECKED, /✓ 这把钥匙能转发到 B 的/];
  const dir = await tempDir();
  const proxy = join(dir, "proxy.sh");
  await writeFile(proxy, LOSING_PROXY);

  for (const from of [2, 3, 4, 5]) {
    const count = join(dir, `connections-${from}`);
    const s = await scenario(t, { allowStreamLocal: "local", localConf: `Host clouddev-b\n    ProxyCommand /bin/sh ${proxy} %p ${count} ${from}\n` });

    if (!s) return;

    try {
      await markConfig(s.a);
      const result = await installForReal(s.a, s.args(s.service.port));

      assert.equal(result.code, 1, result.output);
      assert.equal((await readFile(count, "utf8")).trim(), String(from), `it stopped at the connection that failed\n${result.output}`);

      // The checks before that connection passed; its own is not reported as passed.
      for (const [index, check] of passed.entries()) {
        if (index < from - 1) assert.match(result.output, check);
        else assert.doesNotMatch(result.output, check);
      }

      // R's line is in what ssh printed, and still not taken for B's answer.
      assert.match(result.output, /错误: 这次没能连上 B（ssh 输出: [^）]*open failed: connect failed/);
      assert.doesNotMatch(result.output, /还能转发到别的端口|还能监听端口|还能建 Unix socket|错误: 没能确认|没有程序在监听/);

      if (from === 4) assert.match(result.output, /B 上如果留下了 \/tmp\/clouddev-probe-\d+-\d+\.sock，把它删掉/);

      assert.ok(await configKept(s.a), "the config in use stays");
      assert.equal(existsSync(s.plist), false);
      assert.deepEqual(await leftovers(s.a.dir), []);
    } finally {
      await s.cleanup();
    }

    // Every ssh it started is gone, and with them the proxy's connections to B.
    assert.deepEqual(await processesWith(`${s.a.home}/`, 2000), []);
    assert.deepEqual(await processesWith(`/usr/bin/nc 127.0.0.1 ${s.b.port}`, 2000), []);
  }
});
