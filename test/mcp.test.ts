import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityLog } from "../src/activity.ts";
import { createMcpServer, type McpServerOptions } from "../src/mcp.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import { captureStderr, recordEvents, resultText, tempDir } from "./helpers.ts";

async function connect(allowedRoot: string, options: McpServerOptions = {}): Promise<Client> {
  const server = createMcpServer(new WorkspaceRegistry([allowedRoot]), options);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

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
