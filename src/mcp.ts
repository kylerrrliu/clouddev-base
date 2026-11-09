import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ActivityLog } from "./activity.ts";
import { textResult, type ToolResult } from "./tools/common.ts";
import { editPath, listDirectory, readPath, writePath } from "./tools/files.ts";
import { glob, grep } from "./tools/search.ts";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, runCommand } from "./tools/shell.ts";
import { toDisplayPath } from "./paths.ts";
import { VERSION } from "./version.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";

const workspaceId = z.string().describe("workspace_id returned by open_workspace.");
const relativePath = (what: string) => z.string().describe(`${what}, relative to the workspace root.`);

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITES_FILES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const RUNS_COMMANDS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** How often a running bash command reports progress (when the client asked for progress). */
const PROGRESS_INTERVAL_MS = 20_000;

export interface McpServerOptions {
  /** Log the full text of bash commands. Defaults to `CLOUDDEV_BASE_LOG_COMMANDS=1`; off otherwise. */
  logCommands?: boolean;
  /** Interval for progress notifications while a bash command runs. */
  progressIntervalMs?: number;
  /** Where tool calls are reported for the local activity page. */
  activity?: ActivityLog;
  /** Display name of an OAuth client, for the activity page. */
  clientName?: (clientId: string) => string | undefined;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Build an MCP server exposing the workspace tools. Cheap enough to create per HTTP request. */
export function createMcpServer(registry: WorkspaceRegistry, options: McpServerOptions = {}): McpServer {
  const roots = registry.allowedRoots.join(", ");
  const logCommands = options.logCommands ?? process.env.CLOUDDEV_BASE_LOG_COMMANDS === "1";
  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const { activity } = options;

  /**
   * Run a tool: turn exceptions into error results, report the call to the activity page,
   * and log one line per call to stderr. `logDetail` is what the log shows; the activity page,
   * which keeps everything in memory on this computer, always gets the full `summary`.
   */
  const run = async (
    call: { tool: string; summary: string; logDetail?: string; args: Record<string, unknown>; extra: ToolExtra },
    operation: (onOutput?: (text: string) => void) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const startedAt = performance.now();
    const workspaceId = typeof call.args.workspace_id === "string" ? call.args.workspace_id : undefined;
    const clientId = call.extra.authInfo?.clientId;
    const active = activity?.startCall({
      tool: call.tool,
      summary: call.summary,
      args: call.args,
      workspace: workspaceId === undefined ? undefined : registry.rootOf(workspaceId),
      client: clientId === undefined ? undefined : options.clientName?.(clientId) ?? clientId,
    });
    let result: ToolResult;

    try {
      result = await operation(active?.output);
    } catch (error) {
      result = textResult(error instanceof Error ? error.message : String(error), true);
    }

    active?.finish(result, call.extra.signal.aborted);

    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const summary = (call.logDetail ?? call.summary).replace(/\s+/g, " ").slice(0, 120);
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    console.error(`${time} ${call.tool.padEnd(14)} ${result.isError ? "ERR" : "ok "} ${seconds.padStart(5)}s  ${summary}`);

    return result;
  };

  const server = new McpServer(
    { name: "clouddev-base", title: "clouddev-base", version: VERSION },
    {
      instructions: [
        `Coding tools for local project folders on the user's computer (allowed roots: ${roots}).`,
        "Call open_workspace once per project to get a workspace_id, then reuse it with read, write, edit, grep, glob and bash.",
        "Paths are relative to the workspace root. Read a file before editing it, and prefer edit over write for changes to existing files.",
      ].join(" "),
    },
  );

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description: `Open a project folder and get the workspace_id the other tools need. Call it once per project and keep reusing the returned workspace_id. Opening an allowed root lists the projects inside it. Allowed roots: ${roots}.`,
      inputSchema: {
        path: z.string().describe("Absolute path or ~/path of a folder inside an allowed root. A relative path is resolved against the first allowed root."),
        create: z.boolean().optional().describe("Create the folder if it does not exist. Defaults to false."),
      },
      annotations: { ...READ_ONLY, title: "Open workspace" },
    },
    (args, extra) => run({ tool: "open_workspace", summary: args.path, args, extra }, async () => {
      const { path, create } = args;
      const workspace = await registry.open(path, create);
      const listing = await listDirectory(workspace.root, ".");

      return textResult([
        `workspace_id: ${workspace.id}`,
        `root: ${workspace.root}`,
        "",
        listing,
        "",
        `Use workspace_id "${workspace.id}" for read, write, edit, grep, glob and bash in this project.`,
      ].join("\n"));
    }),
  );

  server.registerTool(
    "read",
    {
      title: "Read file",
      description: "Read a text file, or list a folder. Output is limited to 2000 lines or 50KB; use offset and limit to page through bigger files. PNG, JPEG, GIF and WebP files are returned as images.",
      inputSchema: {
        workspace_id: workspaceId,
        path: relativePath("File or folder path"),
        offset: z.number().int().positive().optional().describe("1-based line number to start from."),
        limit: z.number().int().positive().optional().describe("Maximum number of lines to return."),
      },
      annotations: { ...READ_ONLY, title: "Read file" },
    },
    (args, extra) => run({ tool: "read", summary: args.path, args, extra }, async () => {
      const { workspace_id, path, offset, limit } = args;
      const workspace = await registry.get(workspace_id);
      const absolute = await registry.resolvePath(workspace, path);

      return readPath(absolute, toDisplayPath(workspace.canonicalRoot, absolute), offset, limit);
    }),
  );

  server.registerTool(
    "write",
    {
      title: "Write file",
      description: "Create a file or replace its entire content. Missing parent folders are created. To change part of an existing file, use edit instead.",
      inputSchema: {
        workspace_id: workspaceId,
        path: relativePath("File path"),
        content: z.string().describe("The complete new file content."),
      },
      annotations: { ...WRITES_FILES, title: "Write file" },
    },
    (args, extra) => run({
      tool: "write",
      summary: args.path,
      args: { ...args, content_bytes: Buffer.byteLength(args.content) },
      extra,
    }, async () => {
      const { workspace_id, path, content } = args;
      const workspace = await registry.get(workspace_id);
      const absolute = await registry.resolvePath(workspace, path);

      return writePath(absolute, toDisplayPath(workspace.canonicalRoot, absolute), content);
    }),
  );

  server.registerTool(
    "edit",
    {
      title: "Edit file",
      description: "Edit an existing file by replacing exact text. Each old_text must match exactly one place in the current file, including whitespace and indentation, and edits must not overlap. Several edits to one file can be sent in one call.",
      inputSchema: {
        workspace_id: workspaceId,
        path: relativePath("File path"),
        edits: z.array(z.object({
          old_text: z.string().describe("Exact text to replace. Must match exactly one place in the file."),
          new_text: z.string().describe("Replacement text."),
        })).min(1),
      },
      annotations: { ...WRITES_FILES, title: "Edit file" },
    },
    (args, extra) => run({ tool: "edit", summary: args.path, args, extra }, async () => {
      const { workspace_id, path, edits } = args;
      const workspace = await registry.get(workspace_id);
      const absolute = await registry.resolvePath(workspace, path);

      return editPath(absolute, toDisplayPath(workspace.canonicalRoot, absolute), edits);
    }),
  );

  server.registerTool(
    "grep",
    {
      title: "Search file contents",
      description: "Search file contents with a regular expression (JavaScript syntax). Returns matching lines as path:line:text. Files ignored by .gitignore are skipped (nested repositories and submodules use their own rules), as are binary files, files over 2MB and symbolic links. A search stops after 20 seconds; avoid nested quantifiers such as (a+)+.",
      inputSchema: {
        workspace_id: workspaceId,
        pattern: z.string().min(1).describe("Regular expression, e.g. \"function\\s+main\" or \"TODO\"."),
        path: z.string().optional().describe("File or folder to search, relative to the workspace root. Defaults to the whole workspace."),
        glob: z.string().optional().describe("Only search files matching this glob, e.g. \"*.ts\" or \"src/**/*.{js,jsx}\". A glob without \"/\" matches file names at any depth."),
        ignore_case: z.boolean().optional().describe("Case-insensitive search. Defaults to false."),
        files_only: z.boolean().optional().describe("Return only the paths of matching files. Defaults to false."),
        max_results: z.number().int().min(1).max(1000).optional().describe("Maximum matching lines (or files with files_only). Defaults to 100."),
      },
      annotations: { ...READ_ONLY, title: "Search file contents" },
    },
    (args, extra) => run({ tool: "grep", summary: args.pattern, args, extra }, async () => {
      const workspace = await registry.get(args.workspace_id);
      const target = await registry.resolvePath(workspace, args.path ?? ".");

      return grep(target, workspace.canonicalRoot, {
        pattern: args.pattern,
        glob: args.glob,
        ignoreCase: args.ignore_case,
        filesOnly: args.files_only,
        maxResults: args.max_results ?? 100,
        signal: extra.signal,
      });
    }),
  );

  server.registerTool(
    "glob",
    {
      title: "Find files",
      description: "Find files by name pattern, e.g. \"*.py\", \"**/*.test.ts\" or \"src/*.json\". A pattern without \"/\" matches file names at any depth. Returns existing regular files only; files ignored by .gitignore and symbolic links are skipped.",
      inputSchema: {
        workspace_id: workspaceId,
        pattern: z.string().min(1).describe("Glob pattern. Supports *, **, ?, [abc] and {a,b}."),
        path: z.string().optional().describe("Folder to search in, relative to the workspace root. Defaults to the whole workspace."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum number of paths. Defaults to 200."),
      },
      annotations: { ...READ_ONLY, title: "Find files" },
    },
    (args, extra) => run({ tool: "glob", summary: args.pattern, args, extra }, async () => {
      const workspace = await registry.get(args.workspace_id);
      const dir = await registry.resolvePath(workspace, args.path ?? ".");

      return glob(dir, workspace.canonicalRoot, args.pattern, args.max_results ?? 200, undefined, { signal: extra.signal });
    }),
  );

  server.registerTool(
    "bash",
    {
      title: "Run command",
      description: `Run a bash command in the workspace with the user's local permissions: tests, builds, git, package managers and so on. Returns combined stdout and stderr (the last 2000 lines / 50KB) and reports a non-zero exit code as an error. There is no stdin, so avoid interactive commands. Start long-running servers in the background with their output redirected, e.g. "nohup npm run dev > dev.log 2>&1 &".`,
      inputSchema: {
        workspace_id: workspaceId,
        command: z.string().min(1).describe("Shell command to run."),
        working_directory: z.string().optional().describe("Folder to run in, relative to the workspace root. Defaults to the workspace root."),
        timeout: z.number().positive().max(MAX_TIMEOUT_SECONDS).optional()
          .describe(`Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`),
      },
      annotations: { ...RUNS_COMMANDS, title: "Run command" },
    },
    // Commands can contain secrets (tokens, passwords), so only their length is logged by default.
    (args, extra) => run({
      tool: "bash",
      summary: args.command,
      logDetail: logCommands ? args.command : `(${args.command.length}-character command)`,
      args,
      extra,
    }, async (onOutput) => {
      const workspace = await registry.get(args.workspace_id);
      const cwd = args.working_directory ? await registry.resolvePath(workspace, args.working_directory) : workspace.root;
      const stopProgress = reportProgress(extra, progressIntervalMs);

      try {
        return await runCommand(args.command, cwd, args.timeout ?? DEFAULT_TIMEOUT_SECONDS, extra.signal, onOutput);
      } finally {
        stopProgress();
      }
    }),
  );

  return server;
}

/**
 * While a command runs, send progress notifications if the client asked for
 * them (it sent a progressToken). Clients such as Claude Code abort calls that
 * stay silent for too long; progress counts as activity.
 */
function reportProgress(extra: ToolExtra, intervalMs: number): () => void {
  const progressToken = extra._meta?.progressToken;

  if (progressToken === undefined || intervalMs <= 0) return () => {};

  const startedAt = Date.now();
  let ticks = 0;

  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);

    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: ++ticks, message: `Command still running (${seconds}s)` },
    }).catch(() => {
      // The client may have gone away; the command's own abort handling covers that.
    });
  }, intervalMs);

  timer.unref();

  return () => clearInterval(timer);
}
