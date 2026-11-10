import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityLog } from "../src/activity.ts";
import { createMcpServer, serverComputerName, shellFacts, type McpServerOptions } from "../src/mcp.ts";
import { MAX_BYTES, MAX_ERROR_RESULT_CHARS, MAX_LINES, MAX_RESULT_CHARS, MAX_TEXT_FILE_BYTES } from "../src/tools/common.ts";
import { DEFAULT_IGNORED_DIRS } from "../src/tools/file-list.ts";
import { SEARCH_TIMEOUT_MS } from "../src/tools/search.ts";
import { MAX_SEARCHED_FILE_BYTES } from "../src/tools/search-worker.ts";
import { DISCARD_WINDOW_MS, FAILURE_LINE_CHARS, MAX_DISCARD_BYTES, SUCCESS_LINE_CHARS, TERM_GRACE_MS } from "../src/tools/shell.ts";
import { MAX_EDIT_BYTES, MAX_LONG_LINE_CHARS } from "../src/tools/files.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import { captureStderr, recordEvents, resultText, tempDir } from "./helpers.ts";

const withCommas = (value: number) => value.toLocaleString("en-US");
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)}MB`;

async function connect(allowedRoot: string, options: McpServerOptions = {}): Promise<Client> {
  const server = createMcpServer(new WorkspaceRegistry([allowedRoot]), options);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

/** How the server names the computer it runs on (and the tools act on). */
const HOST = serverComputerName();

test("the computer is named by its host name, unless that name is empty or reads as the user's own computer", () => {
  assert.equal(serverComputerName("build-box.example.com"), "build-box.example.com");
  assert.equal(serverComputerName(" studio.local\n"), "studio.local");
  assert.equal(serverComputerName("localhost-builder"), "localhost-builder", "only loopback names are replaced");

  // Told that every file is on "localhost" and that a dev server there is not on the user's localhost, the model
  // would get a contradiction.
  for (const name of ["", "  ", "localhost", "LOCALHOST", "localhost.", "localhost.localdomain", "dev.localhost", "127.0.0.1", "127.0.1.1", "::1"]) {
    assert.equal(serverComputerName(name), "the server computer", JSON.stringify(name));
  }
});

test("the shell facts match the platform: bash 3.2 only on macOS, an immediate stop on Windows", () => {
  const mac = shellFacts("darwin");
  const linux = shellFacts("linux");
  const windows = shellFacts("win32");
  const graceful = `On timeout or cancel, the command's process group gets SIGTERM, then SIGKILL ${TERM_GRACE_MS / 1000} seconds later.`;

  assert.equal(mac.name, "/bin/bash 3.2");
  assert.equal(mac.limits, "~/.zshrc is not read, ** does not recurse, and there are no associative arrays");
  assert.equal(mac.stop, graceful);

  // Linux and Git Bash ship bash 4 or 5, which has associative arrays; no bash turns globstar on by itself.
  assert.equal(linux.name, "/bin/bash");
  assert.equal(linux.limits, "~/.zshrc is not read and ** does not recurse");
  assert.equal(linux.stop, graceful);

  // Windows has no process groups to signal: taskkill ends the process tree at once.
  assert.equal(windows.name, "Git Bash");
  assert.equal(windows.limits, linux.limits);
  assert.match(windows.stop, /killed at once/);
  assert.doesNotMatch(windows.stop, /SIGTERM|SIGKILL/);
});

test("exposes exactly the slim tool set with safety annotations", async () => {
  const client = await connect(await tempDir());
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name), ["open_workspace", "read", "write", "edit", "grep", "glob", "bash"]);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.read?.annotations?.readOnlyHint, true);
  assert.equal(byName.edit?.annotations?.destructiveHint, true);
  assert.equal(byName.bash?.annotations?.openWorldHint, true);
  assert.deepEqual(byName.edit?.inputSchema.required, ["workspace_id", "path", "edits"]);
  assert.match(client.getInstructions() ?? "", /open_workspace/);
});

test("every tool declares a result size above what the tools return, so Claude Code keeps results inline", async () => {
  const client = await connect(await tempDir());
  const { tools } = await client.listTools();

  assert.equal(tools.length, 7);

  for (const tool of tools) {
    assert.equal(tool._meta?.["anthropic/maxResultSizeChars"], 60000, tool.name);
  }

  // Headroom over the tools' own limits (errors are cut shorter still); Claude Code's default is 50,000, its ceiling 500,000.
  assert.ok(MAX_ERROR_RESULT_CHARS < MAX_RESULT_CHARS && MAX_RESULT_CHARS < 60000);
});

test("the instructions place files, commands and ports on the computer that runs the server", async () => {
  const client = await connect(await tempDir());
  const instructions = client.getInstructions() ?? "";

  assert.doesNotMatch(instructions, /user's computer|local permissions/i);
  assert.ok(instructions.includes(HOST), "names that computer");
  assert.match(instructions, /not the computer the user is typing on/);
  assert.match(instructions, /cannot reach ports/);

  // The shell the model gets, so it does not write zsh or rely on state from an earlier call.
  const shell = shellFacts();
  assert.ok(instructions.includes(`bash runs ${shell.name} as a non-login, non-interactive shell without the user's zsh setup: ${shell.limits}.`), instructions);
  assert.match(instructions, /~\/\.zshrc is not read/);
  assert.match(instructions, /\*\* does not recurse/);
  assert.equal(/associative arrays/.test(instructions), process.platform === "darwin", "only macOS's bash 3.2 lacks them");
  assert.match(instructions, /Each call starts a fresh shell/);
  assert.match(instructions, /nohup npm run dev > dev\.log 2>&1 &/);

  // Claude Code cuts instructions at 4,096 characters; these stay far below, allowed roots included.
  assert.ok(instructions.length < 1500, `${instructions.length} characters`);
});

test("tool descriptions state the limits and safeguards the tools keep", async () => {
  const client = await connect(await tempDir());
  const { tools } = await client.listTools();
  const describe = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
  const limits = `${MAX_LINES} lines / ${MAX_BYTES / 1024}KB / about ${MAX_RESULT_CHARS.toLocaleString("en-US")} characters`;

  for (const tool of tools) {
    assert.doesNotMatch(tool.description ?? "", /user's computer|local permissions/i, tool.name);
    // Without tool search (client/start.sh), descriptions load up front, where Claude Code cuts them at 4,096 characters.
    assert.ok((tool.description ?? "").length < 4096, tool.name);
  }

  const read = describe("read");
  assert.ok(read.includes(`at most ${limits}; notes about paging come first`), read);
  assert.ok(read.includes(`A single line too long for a result shows its first ${withCommas(MAX_LONG_LINE_CHARS)} characters.`), read);
  assert.ok(read.includes(`Text files over ${megabytes(MAX_TEXT_FILE_BYTES)} are refused; use bash for those.`), read);
  assert.match(read, /UTF-16 files with a byte-order mark are shown decoded, but edit cannot change them/);

  const bash = describe("bash");
  assert.ok(bash.includes(`in the workspace on ${HOST}`), bash);
  assert.ok(bash.includes(`a fresh non-login, non-interactive ${shellFacts().name} without the user's zsh setup`), bash);
  assert.ok(bash.includes(`the end of its output (the last ${limits})`), bash);
  assert.ok(bash.includes(`its beginning and end (about ${withCommas(MAX_ERROR_RESULT_CHARS)} characters)`), bash);
  assert.match(bash, /Terminal escape sequences \(colours, cursor movement\) are removed; pipe through cat -v to see them\./);
  assert.match(bash, /Carriage-return progress output is collapsed/);
  assert.ok(bash.includes(
    `when the output does not fit, lines over ${withCommas(SUCCESS_LINE_CHARS)} characters (${withCommas(FAILURE_LINE_CHARS)} for a failing command, or when that shows more lines) are shortened`,
  ), bash);

  if (process.platform === "win32") {
    assert.match(bash, /killed at once/);
  } else {
    assert.ok(bash.includes(`process group gets SIGTERM, then SIGKILL ${TERM_GRACE_MS / 1000} seconds later`), bash);
  }

  // A background process that keeps writing to the call's output is cut off only when it floods it.
  assert.match(bash, /after the call returns is discarded/);
  assert.ok(bash.includes(`if it writes more than ${megabytes(MAX_DISCARD_BYTES)} within ${DISCARD_WINDOW_MS / 60_000} minute`), bash);
  assert.match(bash, /that output is closed, which usually ends the process\. So start servers in the background with their output redirected/);
  assert.match(bash, /cannot be reached from the computer the user is typing on/);

  // How a save behaves, for the programs that hold the file open and when the swap is not possible.
  for (const name of ["write", "edit"]) {
    const text = describe(name);
    assert.match(text, /a temporary file that replaces the old one only once it is complete, so the path gets a new file/, name);
    assert.match(text, /\(a log writer, tail -f, a single-file container mount\) keeps the old content until it reopens it/, name);
    assert.match(text, /are written in place, and a failure part way then leaves them incomplete \(the result says so\)/, name);
    assert.match(text, /paths inside git folders \(\.git, and any folder git treats as its own\) are refused/i, name);
  }

  assert.match(describe("write"), /Empty content instead truncates the file in place/);
  assert.ok(describe("edit").includes(`Files over ${megabytes(MAX_EDIT_BYTES)} and paths inside git folders`), describe("edit"));

  const grep = describe("grep");
  assert.ok(grep.includes(`files over ${megabytes(MAX_SEARCHED_FILE_BYTES)} and folders that cannot be read are skipped too`), grep);
  assert.match(grep, /the result reports them at the top/);
  assert.match(grep, /UTF-16 files with a byte-order mark are searched/);
  assert.ok(grep.includes(`A search stops after ${SEARCH_TIMEOUT_MS / 1000} seconds`), grep);
});

test("grep and glob say which folders they skip and that path searches them anyway", async () => {
  const client = await connect(await tempDir());
  const { tools } = await client.listTools();

  for (const name of ["grep", "glob"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    const description = tool?.description ?? "";
    const path = (tool?.inputSchema.properties?.path as { description?: string } | undefined)?.description ?? "";

    // Without this, "No matches found." for something in dist/ or node_modules/ reads as "it does not exist".
    assert.ok(description.includes(`outside one, these folders are: ${[...DEFAULT_IGNORED_DIRS].join(", ")}.`), description);
    assert.match(description, /A glob that names an ignored or skipped folder finds nothing there: set path to the folder to search it/);
    assert.match(path, /Defaults to the whole workspace; setting it to an ignored folder searches that folder\./, name);
  }
});

test("a full coding session: open, write, read, edit, search, run", async () => {
  const root = await tempDir();
  await mkdir(join(root, "demo"));
  const client = await connect(root);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallResult;

  const opened = resultText(await call("open_workspace", { path: join(root, "demo") }));
  const workspace_id = /workspace_id: (ws_\w+)/.exec(opened)?.[1];
  assert.ok(workspace_id, opened);

  await call("write", { workspace_id, path: "src/math.js", content: "export const add = (a, b) => a + b;\n" });
  await call("write", { workspace_id, path: "test.js", content: "import { add } from './src/math.js';\nconsole.log(add(2, 3));\n" });

  assert.equal(resultText(await call("read", { workspace_id, path: "src/math.js" })), "export const add = (a, b) => a + b;");

  const edited = await call("edit", {
    workspace_id,
    path: "src/math.js",
    edits: [{ old_text: "a + b", new_text: "a + b + 1" }],
  });
  assert.equal(resultText(edited), "Edited src/math.js (+1 -1 lines).");

  assert.equal(resultText(await call("grep", { workspace_id, pattern: "add\\(" })), "test.js:2:console.log(add(2, 3));");
  assert.equal(resultText(await call("glob", { workspace_id, pattern: "*.js" })), "src/math.js\ntest.js");
  assert.equal(resultText(await call("bash", { workspace_id, command: "node test.js" })), "6");
  assert.equal(resultText(await call("read", { workspace_id, path: "." })), "Directory . (2 entries):\nsrc/\ntest.js");

  const failing = await call("bash", { workspace_id, command: "node -e 'process.exit(2)'" });
  assert.equal(failing.isError, true);
});

test("tool errors come back as isError results, not protocol errors", async () => {
  const root = await tempDir();
  const client = await connect(root);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallResult;

  const outside = await call("open_workspace", { path: "/" });
  assert.equal(outside.isError, true);
  assert.match(resultText(outside), /outside the allowed roots/);

  const unknown = await call("read", { workspace_id: "ws_nope", path: "x" });
  assert.match(resultText(unknown), /Call open_workspace again/);

  const opened = resultText(await call("open_workspace", { path: root }));
  const workspace_id = /workspace_id: (ws_\w+)/.exec(opened)?.[1];
  const escape = await call("read", { workspace_id, path: "../../etc/passwd" });
  assert.equal(escape.isError, true);
  assert.match(resultText(escape), /outside the workspace/);

  const badCwd = await call("bash", { workspace_id, command: "pwd", working_directory: ".." });
  assert.equal(badCwd.isError, true);
});

test("write and edit refuse a .git in the path as sent, also when .git is a symbolic link to an ordinary folder", async () => {
  const root = await tempDir();
  const project = join(root, "project");
  await mkdir(join(project, "elsewhere"), { recursive: true });
  await symlink("elsewhere", join(project, ".git"));
  await writeFile(join(project, "elsewhere", "config"), "[core]\n");

  const client = await connect(root);
  const workspace_id = await openWorkspace(client, project);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallResult;

  for (const path of [".git/config", "sub/.GIT/hooks/pre-commit", ".git\\HEAD"]) {
    const write = await call("write", { workspace_id, path, content: "[core]\n\tfsmonitor = touch /tmp/pwned\n" });
    assert.equal(write.isError, true, path);
    assert.match(resultText(write), /Refusing to write .*inside a \.git folder/, path);
  }

  const edit = await call("edit", { workspace_id, path: ".git/config", edits: [{ old_text: "[core]", new_text: "[core]\n\tfsmonitor = x" }] });
  assert.equal(edit.isError, true);
  assert.equal(await readFile(join(project, "elsewhere", "config"), "utf8"), "[core]\n", "the target behind the link is untouched");
  assert.equal(resultText(await call("write", { workspace_id, path: "elsewhere/notes.txt", content: "ok\n" })).startsWith("Created"), true);
});

async function openWorkspace(client: Client, path: string): Promise<string> {
  const opened = resultText((await client.callTool({ name: "open_workspace", arguments: { path } })) as CallResult);
  const workspaceId = /workspace_id: (ws_\w+)/.exec(opened)?.[1];
  assert.ok(workspaceId, opened);

  return workspaceId;
}

test("bash commands are logged by length only unless command logging is turned on", async () => {
  const root = await tempDir();

  const lines = await captureStderr(async () => {
    for (const logCommands of [false, true]) {
      const client = await connect(root, { logCommands });
      const workspace_id = await openWorkspace(client, root);
      await client.callTool({ name: "bash", arguments: { workspace_id, command: `echo token-${logCommands}` } });
    }
  });

  const bashLines = lines.filter((line) => line.includes(" bash "));
  assert.equal(bashLines.length, 2, lines.join("\n"));
  assert.doesNotMatch(bashLines[0]!, /token-false/);
  assert.match(bashLines[0]!, /\(16-character command\)/);
  assert.match(bashLines[1]!, /echo token-true/);
});

test("long bash commands send progress notifications when the client asks for them", async () => {
  const root = await tempDir();
  const client = await connect(root, { progressIntervalMs: 100 });
  const workspace_id = await openWorkspace(client, root);
  const updates: Array<{ progress: number; message?: string }> = [];

  const result = await client.callTool(
    { name: "bash", arguments: { workspace_id, command: "sleep 0.7; echo done" } },
    undefined,
    { onprogress: (update) => updates.push(update) },
  );

  assert.equal(resultText(result as CallResult), "done");
  assert.ok(updates.length >= 3, `expected several progress updates, got ${updates.length}`);
  assert.deepEqual(updates.map((update) => update.progress), updates.map((_, index) => index + 1));
  assert.match(updates[0]!.message ?? "", /^Command still running/);
});

test("tool calls are reported to the activity log, and bash output arrives while the command runs", async () => {
  const root = await tempDir();
  const activity = new ActivityLog();
  const events = recordEvents(activity);
  const client = await connect(root, { activity, client: "Claude Code" });
  const workspace_id = await openWorkspace(client, root);

  await client.callTool({ name: "bash", arguments: { workspace_id, command: "echo first; sleep 0.6; echo second" } });
  await client.callTool({ name: "read", arguments: { workspace_id, path: "missing.txt" } });
  await client.callTool({ name: "write", arguments: { workspace_id, path: "a.txt", content: "x".repeat(2048) } });
  await client.callTool({ name: "edit", arguments: { workspace_id, path: "a.txt", edits: [{ old_text: "x".repeat(2048), new_text: "y" }] } });

  const calls = activity.snapshot().calls;
  assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["open_workspace", "ok"], ["bash", "ok"], ["read", "error"], ["write", "ok"], ["edit", "ok"]]);
  assert.equal(calls[1]!.workspace, root);
  assert.equal(calls[1]!.client, "Claude Code");
  assert.equal(calls[1]!.summary, "echo first; sleep 0.6; echo second", "the page shows the whole command, unlike the log");

  // What the page shows next to the arguments: the timeout in effect, the size written, how many edits there were.
  assert.equal(activity.call(calls[1]!.id)?.args.timeout, 30);
  assert.equal(activity.call(calls[3]!.id)?.args.content_size, "2.0KB");
  assert.equal(activity.call(calls[4]!.id)?.args.edits_count, 1);

  const bashId = calls[1]!.id;
  const firstOutput = events.findIndex((event) => event.type === "call.output" && event.id === bashId && event.text.includes("first"));
  const end = events.findIndex((event) => event.type === "call.end" && event.call.id === bashId);
  assert.ok(firstOutput !== -1 && firstOutput < end, "output is pushed before the command ends");
  assert.equal(activity.call(bashId)?.output, "first\nsecond");
});
