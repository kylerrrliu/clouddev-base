import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RequestId, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ActivityLog } from "./activity.ts";
import {
  MAX_BYTES, MAX_ERROR_RESULT_CHARS, MAX_LINES, MAX_RESULT_CHARS, MAX_TEXT_FILE_BYTES, formatSize, textResult, type ToolResult,
} from "./tools/common.ts";
import { DEFAULT_IGNORED_DIRS } from "./tools/file-list.ts";
import { MAX_EDIT_BYTES, MAX_LONG_LINE_CHARS, editPath, listDirectory, readPath, refuseGitRequest, writePath } from "./tools/files.ts";
import { SEARCH_TIMEOUT_MS, glob, grep } from "./tools/search.ts";
import { MAX_SEARCHED_FILE_BYTES } from "./tools/search-worker.ts";
import {
  DEFAULT_TIMEOUT_SECONDS, DISCARD_WINDOW_MS, FAILURE_LINE_CHARS, MAX_DISCARD_BYTES, MAX_TIMEOUT_SECONDS, SUCCESS_LINE_CHARS, TERM_GRACE_MS,
  runCommand,
} from "./tools/shell.ts";
import { toDisplayPath } from "./paths.ts";
import { VERSION } from "./version.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";

const workspaceId = z.string().describe("workspace_id returned by open_workspace.");
const relativePath = (what: string) => z.string().describe(`${what}, relative to the workspace root.`);

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITES_FILES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const RUNS_COMMANDS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/**
 * Declared on every tool in tools/list. Claude Code stores a successful result longer than 50,000 characters in a
 * file on its own computer and shows the model a short preview; in client/ the model cannot open that file (Read and
 * Bash are denied there). The tools keep their results under MAX_RESULT_CHARS themselves, so this is headroom, not a
 * budget. Claude Code accepts up to 500,000. For a tool that declares a value it no longer applies its token limit to
 * text, so the byte limit the tools keep (MAX_BYTES) is what stops CJK output from taking far more tokens.
 */
const RESULT_SIZE_META = { "anthropic/maxResultSizeChars": 60_000 };

/** The descriptions quote the limits from the constants the tools enforce, so the two cannot drift apart. */
const withCommas = (value: number) => value.toLocaleString("en-US");
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)}MB`;
const RESULT_LIMITS = `${MAX_LINES} lines / ${MAX_BYTES / 1024}KB / about ${withCommas(MAX_RESULT_CHARS)} characters`;

/** A duration in whole minutes or seconds, the way the descriptions say it: "3 seconds", "1 minute". */
function duration(ms: number): string {
  const [count, unit] = ms % 60_000 === 0 ? [ms / 60_000, "minute"] : [ms / 1000, "second"];

  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Host names that do not tell computers apart. A computer without a name of its own calls itself localhost or
 * localhost.localdomain, and so may the user's; written into the text below, such a name reads as the user's own
 * computer, the opposite of what the text says.
 */
const LOOPBACK_NAME = /^(?:localhost(?:\.localdomain)?|.+\.localhost|127\..*|::1)\.?$/i;

/**
 * How the instructions and descriptions name the computer the tools act on. The user types on another computer
 * (client/ in this repository), so "local" or "the user's computer" would point the model at the wrong one, and so
 * would a host name like localhost.
 */
export function serverComputerName(name = hostname()): string {
  const trimmed = name.trim();

  return trimmed === "" || LOOPBACK_NAME.test(trimmed) ? "the server computer" : trimmed;
}

/** What the model needs to know about the shell bash runs in, which differs by platform. */
export interface ShellFacts {
  /** The shell each bash call runs in (see shellInvocation in tools/shell.ts). */
  name: string;
  /** What it does not do that the user's own shell may. */
  limits: string;
  /** What a timeout or cancellation does to the command (see stopGroup in tools/shell.ts). */
  stop: string;
}

/**
 * The shell facts for `platform`. Only macOS ships bash 3.2, which has no associative arrays; Linux has a current
 * bash, and Windows runs Git Bash, where a stop is an immediate taskkill: there are no process groups to signal. No
 * bash turns globstar on by itself, so ** does not recurse anywhere.
 */
export function shellFacts(platform: NodeJS.Platform = process.platform): ShellFacts {
  const limits = "~/.zshrc is not read and ** does not recurse";

  if (platform === "win32") {
    return { name: "Git Bash", limits, stop: "On timeout or cancel, the command and the processes it started are killed at once." };
  }

  const stop = `On timeout or cancel, the command's process group gets SIGTERM, then SIGKILL ${duration(TERM_GRACE_MS)} later.`;

  return platform === "darwin"
    ? { name: "/bin/bash 3.2", limits: "~/.zshrc is not read, ** does not recurse, and there are no associative arrays", stop }
    : { name: "/bin/bash", limits, stop };
}

/**
 * How write and edit save a file (tools/replace-file.ts). It decides what a program holding the file open sees, and
 * what a failure part way leaves behind, so the model is told before it relies on either.
 */
const SAVED_AS_NEW_FILE = [
  "Normally the new content goes to a temporary file that replaces the old one only once it is complete, so the path",
  "gets a new file: a program holding the old one open (a log writer, tail -f, a single-file container mount) keeps",
  "the old content until it reopens it.",
].join(" ");
const SAVED_IN_PLACE = [
  "Files owned by another user, or in folders that refuse the swap, are written in place, and a failure part way then",
  "leaves them incomplete (the result says so).",
].join(" ");
const GIT_FOLDERS = "git folders (.git, and any folder git treats as its own)";

/** What grep and glob leave out (tools/file-list.ts). Unsaid, "No matches found." would read as "it does not exist". */
const SEARCH_SCOPE = [
  "Inside a Git repository, files ignored by .gitignore are skipped (nested repositories and submodules use their own rules);",
  `outside one, these folders are: ${[...DEFAULT_IGNORED_DIRS].join(", ")}.`,
  "A glob that names an ignored or skipped folder finds nothing there: set path to the folder to search it.",
  "Symbolic links are always skipped.",
].join(" ");
const PATH_LIFTS_IGNORES = "setting it to an ignored folder searches that folder";

/** How often a running bash command reports progress (when the client asked for progress). */
const PROGRESS_INTERVAL_MS = 20_000;

export interface McpServerOptions {
  /** Log the full text of bash commands. Defaults to `CLOUDDEV_BASE_LOG_COMMANDS=1`; off otherwise. */
  logCommands?: boolean;
  /** Interval for progress notifications while a bash command runs. */
  progressIntervalMs?: number;
  /** Where tool calls are reported for the local activity page. */
  activity?: ActivityLog;
  /** Who is calling, as the activity page names it (the name the OAuth client registered with). */
  client?: string;
  /** Told the JSON-RPC id of every tool call that reaches a tool, so the caller can tell which ones were refused before. */
  onToolCall?: (requestId: RequestId) => void;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Build an MCP server exposing the workspace tools. Cheap enough to create per HTTP request. */
export function createMcpServer(registry: WorkspaceRegistry, options: McpServerOptions = {}): McpServer {
  const roots = registry.allowedRoots.join(", ");
  const host = serverComputerName();
  const shell = shellFacts();
  const logCommands = options.logCommands ?? process.env.CLOUDDEV_BASE_LOG_COMMANDS === "1";
  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const { activity } = options;

  /**
   * Run a tool: turn exceptions into error results, report the call to the activity page,
   * and log one line per call to stderr. `logDetail` is what the log shows; the activity page,
   * which keeps everything in memory on this computer, always gets the full `summary`.
   * `cancellable`: the tool stops when the client cancels (it passes extra.signal on).
   */
  const run = async (
    call: { tool: string; summary: string; logDetail?: string; args: Record<string, unknown>; extra: ToolExtra; cancellable?: boolean },
    operation: (onOutput?: (text: string) => void) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const startedAt = performance.now();
    const workspaceId = typeof call.args.workspace_id === "string" ? call.args.workspace_id : undefined;
    options.onToolCall?.(call.extra.requestId);
    const active = activity?.startCall({
      tool: call.tool,
      summary: call.summary,
      args: call.args,
      workspace: workspaceId === undefined ? undefined : registry.rootOf(workspaceId),
      client: options.client,
      cancellable: call.cancellable,
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
      // Read by the model at the start of every session; Claude Code cuts instructions at 4,096 characters.
      instructions: [
        `Coding tools for project folders on ${host}, the computer that runs clouddev-base (allowed roots: ${roots}).`,
        `It is not the computer the user is typing on: every file and command is on ${host},`,
        "and the user cannot reach ports opened there, so a dev server started there is not on the user's localhost.",
        "Call open_workspace once per project to get a workspace_id, then reuse it with read, write, edit, grep, glob and bash.",
        "Paths are relative to the workspace root. Read a file before editing it, and prefer edit over write for changes to existing files.",
        `bash runs ${shell.name} as a non-login, non-interactive shell without the user's zsh setup: ${shell.limits}.`,
        "Each call starts a fresh shell, so cd and export do not carry over; use working_directory instead.",
        "Start servers in the background with their output redirected, e.g. nohup npm run dev > dev.log 2>&1 &, then read the log.",
      ].join(" "),
    },
  );

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description: `Open a project folder on ${host} and get the workspace_id the other tools need. Call it once per project and keep reusing the returned workspace_id. Opening an allowed root lists the projects inside it. Allowed roots: ${roots}.`,
      inputSchema: {
        path: z.string().describe("Absolute path or ~/path of a folder inside an allowed root. A relative path is resolved against the first allowed root."),
        create: z.boolean().optional().describe("Create the folder if it does not exist. Defaults to false."),
      },
      annotations: { ...READ_ONLY, title: "Open workspace" },
      _meta: RESULT_SIZE_META,
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
      description: [
        `Read a text file, or list a folder. A result holds at most ${RESULT_LIMITS}; notes about paging come first,`,
        "and offset and limit page through bigger files.",
        `A single line too long for a result shows its first ${withCommas(MAX_LONG_LINE_CHARS)} characters.`,
        `Text files over ${megabytes(MAX_TEXT_FILE_BYTES)} are refused; use bash for those.`,
        "UTF-16 files with a byte-order mark are shown decoded, but edit cannot change them.",
        "PNG, JPEG, GIF and WebP files are returned as images.",
      ].join(" "),
      inputSchema: {
        workspace_id: workspaceId,
        path: relativePath("File or folder path"),
        offset: z.number().int().positive().optional().describe("1-based line number to start from."),
        limit: z.number().int().positive().optional().describe("Maximum number of lines to return."),
      },
      annotations: { ...READ_ONLY, title: "Read file" },
      _meta: RESULT_SIZE_META,
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
      description: [
        "Create a file or replace its entire content. Missing parent folders are created.",
        SAVED_AS_NEW_FILE,
        "Empty content instead truncates the file in place.",
        SAVED_IN_PLACE,
        `Paths inside ${GIT_FOLDERS} are refused. To change part of an existing file, use edit instead.`,
      ].join(" "),
      inputSchema: {
        workspace_id: workspaceId,
        path: relativePath("File path"),
        content: z.string().describe("The complete new file content."),
      },
      annotations: { ...WRITES_FILES, title: "Write file" },
      _meta: RESULT_SIZE_META,
    },
    (args, extra) => run({
      tool: "write",
      summary: args.path,
      args: { ...args, content_size: formatSize(Buffer.byteLength(args.content)) },
      extra,
    }, async () => {
      const { workspace_id, path, content } = args;
      refuseGitRequest(path);
      const workspace = await registry.get(workspace_id);
      const absolute = await registry.resolvePath(workspace, path);

      return writePath(absolute, toDisplayPath(workspace.canonicalRoot, absolute), content);
    }),
  );

  server.registerTool(
    "edit",
    {
      title: "Edit file",
      description: [
        "Edit an existing file by replacing exact text. Each old_text must match exactly one place in the current file,",
        "including whitespace and indentation, and edits must not overlap. Several edits to one file can be sent in one call.",
        SAVED_AS_NEW_FILE,
        SAVED_IN_PLACE,
        `Files over ${megabytes(MAX_EDIT_BYTES)} and paths inside ${GIT_FOLDERS} are refused.`,
      ].join(" "),
      inputSchema: {
        workspace_id: workspaceId,
        path: relativePath("File path"),
        edits: z.array(z.object({
          old_text: z.string().describe("Exact text to replace. Must match exactly one place in the file."),
          new_text: z.string().describe("Replacement text."),
        })).min(1),
      },
      annotations: { ...WRITES_FILES, title: "Edit file" },
      _meta: RESULT_SIZE_META,
    },
    // The page lists at most 100 edits; the count tells how many there were.
    (args, extra) => run({ tool: "edit", summary: args.path, args: { ...args, edits_count: args.edits.length }, extra }, async () => {
      const { workspace_id, path, edits } = args;
      refuseGitRequest(path);
      const workspace = await registry.get(workspace_id);
      const absolute = await registry.resolvePath(workspace, path);

      return editPath(absolute, toDisplayPath(workspace.canonicalRoot, absolute), edits);
    }),
  );

  server.registerTool(
    "grep",
    {
      title: "Search file contents",
      description: [
        "Search file contents with a regular expression (JavaScript syntax). Returns matching lines as path:line:text.",
        SEARCH_SCOPE,
        `Binary files, files over ${megabytes(MAX_SEARCHED_FILE_BYTES)} and folders that cannot be read are skipped too,`,
        "and the result reports them at the top. UTF-16 files with a byte-order mark are searched.",
        `A search stops after ${duration(SEARCH_TIMEOUT_MS)}; avoid nested quantifiers such as (a+)+.`,
      ].join(" "),
      inputSchema: {
        workspace_id: workspaceId,
        pattern: z.string().min(1).describe("Regular expression, e.g. \"function\\s+main\" or \"TODO\"."),
        path: z.string().optional()
          .describe(`File or folder to search, relative to the workspace root. Defaults to the whole workspace; ${PATH_LIFTS_IGNORES}.`),
        glob: z.string().optional().describe("Only search files matching this glob, e.g. \"*.ts\" or \"src/**/*.{js,jsx}\". A glob without \"/\" matches file names at any depth."),
        ignore_case: z.boolean().optional().describe("Case-insensitive search. Defaults to false."),
        files_only: z.boolean().optional().describe("Return only the paths of matching files. Defaults to false."),
        max_results: z.number().int().min(1).max(1000).optional().describe("Maximum matching lines (or files with files_only). Defaults to 100."),
      },
      annotations: { ...READ_ONLY, title: "Search file contents" },
      _meta: RESULT_SIZE_META,
    },
    (args, extra) => run({ tool: "grep", summary: args.pattern, args, extra, cancellable: true }, async () => {
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
      description: [
        "Find files by name pattern, e.g. \"*.py\", \"**/*.test.ts\" or \"src/*.json\". A pattern without \"/\" matches file names at any depth.",
        "Returns existing regular files only.",
        SEARCH_SCOPE,
        "Folders that cannot be read are reported at the top of the result.",
      ].join(" "),
      inputSchema: {
        workspace_id: workspaceId,
        pattern: z.string().min(1).describe("Glob pattern. Supports *, **, ?, [abc] and {a,b}."),
        path: z.string().optional()
          .describe(`Folder to search in, relative to the workspace root. Defaults to the whole workspace; ${PATH_LIFTS_IGNORES}.`),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum number of paths. Defaults to 200."),
      },
      annotations: { ...READ_ONLY, title: "Find files" },
      _meta: RESULT_SIZE_META,
    },
    (args, extra) => run({ tool: "glob", summary: args.pattern, args, extra, cancellable: true }, async () => {
      const workspace = await registry.get(args.workspace_id);
      const dir = await registry.resolvePath(workspace, args.path ?? ".");

      return glob(dir, workspace.canonicalRoot, args.pattern, args.max_results ?? 200, undefined, { signal: extra.signal });
    }),
  );

  server.registerTool(
    "bash",
    {
      title: "Run command",
      description: [
        `Run a bash command in the workspace on ${host}: tests, builds, git, package managers and so on.`,
        `Each call runs in a fresh non-login, non-interactive ${shell.name} without the user's zsh setup.`,
        "There is no stdin, so avoid interactive commands.",
        "Returns combined stdout and stderr, and reports a non-zero exit code as an error.",
        `A successful command returns the end of its output (the last ${RESULT_LIMITS}),`,
        `a failing one its beginning and end (about ${withCommas(MAX_ERROR_RESULT_CHARS)} characters).`,
        "Terminal escape sequences (colours, cursor movement) are removed; pipe through cat -v to see them.",
        "Carriage-return progress output is collapsed, and when the output does not fit, lines over",
        `${withCommas(SUCCESS_LINE_CHARS)} characters (${withCommas(FAILURE_LINE_CHARS)} for a failing command, or when that shows more lines) are shortened.`,
        shell.stop,
        "Output that a background process writes to the call's own output after the call returns is discarded;",
        `if it writes more than ${megabytes(MAX_DISCARD_BYTES)} within ${duration(DISCARD_WINDOW_MS)}, that output is closed, which usually ends the process.`,
        `So start servers in the background with their output redirected, e.g. "nohup npm run dev > dev.log 2>&1 &".`,
        `Ports on ${host} cannot be reached from the computer the user is typing on.`,
      ].join(" "),
      inputSchema: {
        workspace_id: workspaceId,
        command: z.string().min(1).describe("Shell command to run."),
        working_directory: z.string().optional().describe("Folder to run in, relative to the workspace root. Defaults to the workspace root."),
        timeout: z.number().positive().max(MAX_TIMEOUT_SECONDS).optional()
          .describe(`Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`),
      },
      annotations: { ...RUNS_COMMANDS, title: "Run command" },
      _meta: RESULT_SIZE_META,
    },
    // Commands can contain secrets (tokens, passwords), so only their length is logged by default.
    (args, extra) => run({
      tool: "bash",
      summary: args.command,
      logDetail: logCommands ? args.command : `(${args.command.length}-character command)`,
      args: { ...args, timeout: args.timeout ?? DEFAULT_TIMEOUT_SECONDS },
      extra,
      cancellable: true,
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
