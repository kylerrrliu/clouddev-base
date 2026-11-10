import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import { tempDir } from "./helpers.ts";

// client/ is what the user copies to A, the computer Claude Code runs on. Its settings keep that Claude Code from
// touching A itself: everything goes through clouddev-base, which acts on B.
const CLIENT = fileURLToPath(new URL("../client/", import.meta.url));
const START = join(CLIENT, "start.sh");
const run = promisify(execFile);
const skip = process.platform === "win32" ? "needs bash" : false;

interface Settings {
  $schema?: string;
  permissions?: { deny?: string[]; allow?: string[]; disableBypassPermissionsMode?: string };
  enabledMcpjsonServers?: string[];
  crossSessionInbound?: string;
  disableClaudeAiConnectors?: boolean;
  disableSkillShellExecution?: boolean;
}

interface McpConfig {
  mcpServers: Record<string, { type?: string; url?: string; alwaysLoad?: boolean }>;
}

async function readSettings(): Promise<Settings> {
  return JSON.parse(await readFile(join(CLIENT, ".claude", "settings.json"), "utf8")) as Settings;
}

async function readMcpConfig(): Promise<McpConfig> {
  return JSON.parse(await readFile(join(CLIENT, ".mcp.json"), "utf8")) as McpConfig;
}

// The built-in tools start.sh keeps: none touches A's files or runs commands there. Skill stays, so skills work;
// TaskStop, so Claude can stop a clouddev-base call that Claude Code moved to the background after 2 minutes;
// ExitPlanMode, so in plan mode Claude can ask the user to confirm leaving it. Without Write, Claude cannot write a
// plan file, so the plan is only in its reply and the dialog just asks whether to exit plan mode. ToolSearch is left
// out, so clouddev-base's tools load up front instead of waiting behind a search.
const WHITELIST = "AskUserQuestion,ExitPlanMode,Skill,TaskCreate,TaskGet,TaskList,TaskStop,TaskUpdate";

test("client settings deny Claude Code's own file, command, messaging and worktree tools on A", async () => {
  const settings = await readSettings();
  const deny = settings.permissions?.deny ?? [];

  assert.equal(settings.$schema, "https://json.schemastore.org/claude-code-settings.json");

  // LSP reads A's files through a language server once a code-intelligence plugin is installed, without asking.
  // (SendUserFile and Artifact, which send or publish a file from A, check the Read deny before reading it.)
  for (const tool of ["Bash", "PowerShell", "Monitor", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "LSP"]) {
    assert.ok(deny.includes(tool), `${tool} reads or writes A's files or runs commands on A`);
  }

  // Tools that need no approval: messages to the user's other sessions, cloud routines on claude.ai, and moving the
  // session to a worktree where this file may not apply.
  for (const tool of ["SendMessage", "ListAgents", "RemoteTrigger", "EnterWorktree", "ExitWorktree"]) {
    assert.ok(deny.includes(tool), `${tool} should be denied`);
  }

  assert.equal(new Set(deny).size, deny.length, "no duplicates");
});

test("client settings refuse other sessions' messages, claude.ai connectors, inline skill shell and bypass mode", async () => {
  const settings = await readSettings();

  assert.equal(settings.crossSessionInbound, "refuse");
  assert.equal(settings.disableClaudeAiConnectors, true);
  assert.equal(settings.disableSkillShellExecution, true);
  assert.equal(settings.permissions?.disableBypassPermissionsMode, "disable");
});

test("client settings auto-allow exactly the read-only clouddev-base tools and add no ask rules", async () => {
  const settings = await readSettings();
  const mcp = await readMcpConfig();

  assert.deepEqual(settings.permissions?.allow, [
    "mcp__clouddev-base__open_workspace",
    "mcp__clouddev-base__read",
    "mcp__clouddev-base__grep",
    "mcp__clouddev-base__glob",
  ]);
  assert.equal("ask" in (settings.permissions ?? {}), false);
  assert.deepEqual(settings.enabledMcpjsonServers, ["clouddev-base"]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["clouddev-base"], "the allow rules name the server .mcp.json defines");

  // The allowed tools are the ones the server marks read-only; write, edit and bash are left to ask.
  const server = createMcpServer(new WorkspaceRegistry([await tempDir()]));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();

  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => `mcp__clouddev-base__${tool.name}`);
  assert.deepEqual([...(settings.permissions?.allow ?? [])].sort(), readOnly.sort());
});

test("client/.mcp.json makes Claude Code's startup wait for clouddev-base's tools", async () => {
  const server = (await readMcpConfig()).mcpServers["clouddev-base"];

  // Claude Code otherwise connects MCP servers in the background, so a prompt given on the command line can reach
  // the model before clouddev-base's tools do, and without ToolSearch (start.sh) the model has no way to wait for
  // them. With alwaysLoad, startup waits up to MCP_CONNECT_TIMEOUT_MS (5 seconds by default).
  assert.equal(server?.alwaysLoad, true);
  assert.equal(server?.url, "http://127.0.0.1:7676/mcp");
});

/** Where the start.sh tests let PATH look besides the folders they make: never the user's PATH, which has the real claude. */
const SYSTEM_PATH = "/usr/bin:/bin";

/**
 * The environment start.sh runs in here. It must never reach the real Claude Code: HOME is a fresh folder (start.sh
 * also looks in ~/.claude/local and ~/.local/bin), CLAUDE_BIN is set only when a test passes it, and PATH is `path`.
 */
async function scriptEnv(path: string, extra: { CLAUDE_BIN?: string } = {}): Promise<NodeJS.ProcessEnv> {
  return { HOME: await tempDir(), PATH: path, ...extra };
}

/**
 * A stand-in for Claude Code at `path`: prints the path it was started as, the folder it was started in, then each
 * argument, one per line.
 */
async function fakeClaude(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/bash\nprintf "%s\\n" "$0"\npwd\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n');
  await chmod(path, 0o755);

  return path;
}

/** A folder for PATH with nothing on it but dirname, which start.sh needs: no claude. */
async function binWithoutClaude(): Promise<string> {
  const bin = await tempDir();
  await symlink(existsSync("/usr/bin/dirname") ? "/usr/bin/dirname" : "/bin/dirname", join(bin, "dirname"));

  return bin;
}

/** What the fake Claude Code printed: the path it was started as, its working folder, its arguments. */
function started(stdout: string): { claude: string; cwd: string; args: string[] } {
  const [claude, cwd, ...args] = stdout.split("\n").slice(0, -1);

  return { claude: claude!, cwd: cwd!, args };
}

/**
 * The values Claude Code's option parser gives a variadic option such as --mcp-config <configs...>: every argument
 * after it up to the next one that starts with "-". A prompt in that position would be read as another config file.
 */
function variadicValues(args: string[], option: string): string[] {
  const start = args.indexOf(option);
  assert.notEqual(start, -1, `${option} is missing`);
  const end = args.findIndex((arg, index) => index > start && arg.length > 1 && arg.startsWith("-"));

  return args.slice(start + 1, end === -1 ? undefined : end);
}

test("start.sh is executable", { skip }, async () => {
  assert.ok(existsSync(START));
  assert.notEqual((await stat(START)).mode & 0o111, 0, "start.sh must be executable");
});

test("start.sh starts Claude Code from client/ with only the whitelisted built-in tools and clouddev-base", { skip }, async () => {
  const claude = await fakeClaude(join(await tempDir(), "claude"));
  const elsewhere = await tempDir();
  const env = await scriptEnv(`${dirname(claude)}:${SYSTEM_PATH}`);

  const run1 = started((await run(START, ["fix the failing tests", "--resume"], { cwd: elsewhere, env })).stdout);
  const config = join(run1.cwd, ".mcp.json");

  assert.equal(run1.claude, claude, "the claude on PATH");
  assert.equal(realpathSync(run1.cwd), realpathSync(CLIENT), "runs where .mcp.json and .claude/settings.json are");

  // Neither list swallows what the user passes: the prompt stays a prompt.
  assert.deepEqual(variadicValues(run1.args, "--tools"), [WHITELIST]);
  assert.deepEqual(variadicValues(run1.args, "--mcp-config"), [config], "a prompt after --mcp-config would be read as a config file");

  // --no-chrome: browser tools on A are MCP tools that neither --tools nor --strict-mcp-config removes.
  const fixed = ["--tools", WHITELIST, "--no-chrome", "--mcp-config", config, "--strict-mcp-config"];
  assert.deepEqual(run1.args, [...fixed, "fix the failing tests", "--resume"]);

  const bare = started((await run(START, [], { cwd: elsewhere, env })).stdout);
  assert.deepEqual(bare.args, fixed);
});

test("start.sh linked onto PATH through relative symlinks still starts Claude Code from client/", { skip }, async () => {
  const claude = await fakeClaude(join(await tempDir(), "claude"));
  // A relative link resolves against the real folder it sits in, so the links are made between real paths (on macOS
  // the temporary folder is under /var, itself a link).
  const links = realpathSync(await tempDir());
  await mkdir(join(links, "bin"));
  await mkdir(join(links, "share"));

  // bin/cdev -> ../share/start.sh -> client/start.sh, the way `ln -s ../share/start.sh cdev` makes them.
  await symlink(relative(join(links, "share"), realpathSync(START)), join(links, "share", "start.sh"));
  await symlink(join("..", "share", "start.sh"), join(links, "bin", "cdev"));

  const env = await scriptEnv(`${join(links, "bin")}:${dirname(claude)}:${SYSTEM_PATH}`);
  const linked = started((await run("cdev", ["hello"], { cwd: await tempDir(), env })).stdout);

  assert.equal(realpathSync(linked.cwd), realpathSync(CLIENT), "runs in client/, not in the folder of the link");
  assert.deepEqual(variadicValues(linked.args, "--mcp-config"), [join(linked.cwd, ".mcp.json")]);
  assert.equal(linked.args.at(-1), "hello");
});

test("start.sh finds Claude Code where its installers put it when PATH does not have it", { skip }, async () => {
  const env = await scriptEnv(await binWithoutClaude());
  const native = await fakeClaude(join(env.HOME!, ".local", "bin", "claude"));

  assert.equal(started((await run(START, [], { env })).stdout).claude, native);

  // The older local install, which a shell alias usually points at, comes first.
  const local = await fakeClaude(join(env.HOME!, ".claude", "local", "claude"));

  assert.equal(started((await run(START, [], { env })).stdout).claude, local);
});

test("start.sh runs the Claude Code that CLAUDE_BIN names, and stops when it names none", { skip }, async () => {
  const onPath = await fakeClaude(join(await tempDir(), "claude"));
  const chosen = await fakeClaude(join(await tempDir(), "claude-next"));
  const path = `${dirname(onPath)}:${SYSTEM_PATH}`;

  const named = started((await run(START, [], { env: await scriptEnv(path, { CLAUDE_BIN: chosen }) })).stdout);
  assert.equal(named.claude, chosen, "CLAUDE_BIN comes before PATH");

  // A relative CLAUDE_BIN counts from the folder start.sh was run in, though Claude Code then runs in client/.
  const relativeEnv = await scriptEnv(path, { CLAUDE_BIN: "./claude-next" });
  const fromHere = started((await run(START, [], { cwd: dirname(chosen), env: relativeEnv })).stdout);
  assert.equal(realpathSync(fromHere.claude), realpathSync(chosen));
  assert.equal(realpathSync(fromHere.cwd), realpathSync(CLIENT));

  const missingEnv = await scriptEnv(path, { CLAUDE_BIN: join(dirname(chosen), "missing") });

  await assert.rejects(run(START, [], { env: missingEnv }), (error: { code?: number; stdout?: string; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? "", /CLAUDE_BIN/);
    assert.equal(error.stdout, "", "falls back to nothing, not even the claude on PATH");

    return true;
  });
});

test("start.sh says so when Claude Code is not installed, and that a shell alias is invisible to it", { skip }, async () => {
  const env = await scriptEnv(await binWithoutClaude());

  await assert.rejects(run(START, [], { env }), (error: { code?: number; stdout?: string; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr ?? "", /找不到 claude/);
    assert.match(error.stderr ?? "", /alias/);
    assert.match(error.stderr ?? "", /CLAUDE_BIN=/);

    return true;
  });
});
