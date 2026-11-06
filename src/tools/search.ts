import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { textResult, type ToolResult } from "./common.ts";
import { MAX_LISTED_FILES } from "./file-list.ts";
import type { GlobReply, GrepReply, SearchRequest, WorkerMessage } from "./search-worker.ts";

export { compileGlob } from "./glob-match.ts";

/** Hard limit for one grep or glob call. The worker thread doing it is then terminated. */
export const SEARCH_TIMEOUT_MS = 20_000;

/** More concurrent searches wait for a free slot instead of all competing for CPU. */
const MAX_PARALLEL_SEARCHES = 4;

/** Searches allowed to wait for a slot. Beyond this a search is refused rather than queued. */
const MAX_WAITING_SEARCHES = 32;

/** Heap limit for one search worker. */
const WORKER_HEAP_MB = 512;

// tsc rewrites import specifiers but not URL strings, so the worker file takes
// this module's own extension: search.ts starts search-worker.ts, search.js
// (the build) starts search-worker.js.
const WORKER_URL = new URL(`./search-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/** How a search runs, as opposed to what it looks for. */
export interface SearchControl {
  /** Time limit in milliseconds. Defaults to SEARCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Stops the search, queued or running, when it fires: the client cancelled the tool call. */
  signal?: AbortSignal;
  /** Most files to consider. Defaults to MAX_LISTED_FILES. */
  fileLimit?: number;
}

export interface GrepOptions extends SearchControl {
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  filesOnly?: boolean;
  maxResults: number;
}

/**
 * Search file contents under `target` (a file or folder). Result paths are
 * shown relative to `displayRoot`, the workspace root, and never lie outside it.
 */
export async function grep(target: string, displayRoot: string, options: GrepOptions): Promise<ToolResult> {
  try {
    new RegExp(options.pattern, options.ignoreCase ? "i" : "");
  } catch (error) {
    throw new Error(`Invalid regular expression: ${(error as Error).message}`);
  }

  const targetStats = await statOrNotFound(target, displayRoot);
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const fileLimit = options.fileLimit ?? MAX_LISTED_FILES;

  const outcome = await runInWorker<GrepReply>({
    op: "grep",
    target,
    expectedRealTarget: realPathOrNotFound(target, displayRoot),
    isFile: !targetStats.isDirectory(),
    displayRoot,
    pattern: options.pattern,
    ignoreCase: options.ignoreCase ?? false,
    glob: options.glob,
    filesOnly: options.filesOnly ?? false,
    maxResults: options.maxResults,
    fileLimit,
  }, timeoutMs, options.signal);

  if (outcome.kind !== "done") {
    return notDone(
      outcome.kind,
      `Search stopped after ${formatSeconds(timeoutMs)}: the pattern is too complex or the search covers too much. ` +
        "Narrow it with path or glob, or simplify the pattern (nested quantifiers such as (a+)+ can take forever).",
    );
  }

  const { reply } = outcome;

  if (reply.lines.length === 0) {
    // Without this, "no matches" in a huge tree reads as "it does not exist".
    return textResult(reply.capped
      ? `No matches in the first ${fileLimit} files. The search stops after ${fileLimit} files, so the rest were not searched: narrow it with path or glob.`
      : "No matches found.");
  }

  const notes = [
    reply.limitReached ? `[Stopped after ${options.maxResults} results. Narrow the search with path, glob or a more specific pattern.]` : "",
    reply.capped ? `[Only the first ${fileLimit} files were searched.]` : "",
  ].filter(Boolean);

  return textResult([...reply.lines, ...(notes.length ? ["", ...notes] : [])].join("\n"));
}

/** Find files under `dir` whose path matches a glob. */
export async function glob(
  dir: string,
  displayRoot: string,
  pattern: string,
  maxResults: number,
  timeoutMs = SEARCH_TIMEOUT_MS,
  control: Omit<SearchControl, "timeoutMs"> = {},
): Promise<ToolResult> {
  const dirStats = await statOrNotFound(dir, displayRoot);

  if (!dirStats.isDirectory()) throw new Error("glob path must be a folder.");

  const fileLimit = control.fileLimit ?? MAX_LISTED_FILES;

  const outcome = await runInWorker<GlobReply>({
    op: "glob",
    dir,
    expectedRealDir: realPathOrNotFound(dir, displayRoot),
    displayRoot,
    pattern,
    maxResults,
    fileLimit,
  }, timeoutMs, control.signal);

  if (outcome.kind !== "done") {
    return notDone(
      outcome.kind,
      `File search stopped after ${formatSeconds(timeoutMs)}: the pattern is too complex or the folder holds too many files. ` +
        "Narrow it with path or a more specific pattern.",
    );
  }

  const { reply } = outcome;

  if (reply.paths.length === 0) {
    return textResult(reply.capped
      ? `No files found in the first ${fileLimit} files. The search stops after ${fileLimit} files, so the rest were not checked: narrow it with path or a more specific pattern.`
      : "No files found.");
  }

  const notes = [
    reply.total > reply.paths.length ? `[Showing ${reply.paths.length} of ${reply.total} files. Use a more specific pattern or path.]` : "",
    reply.capped ? `[Only the first ${fileLimit} files were considered.]` : "",
  ].filter(Boolean);

  return textResult([...reply.paths, ...(notes.length ? ["", ...notes] : [])].join("\n"));
}

function notDone(kind: "timeout" | "cancelled" | "busy", timeoutMessage: string): ToolResult {
  if (kind === "cancelled") return textResult("Search was cancelled.", true);

  if (kind === "busy") return textResult("Too many searches are already running or waiting. Try again in a moment.", true);

  return textResult(timeoutMessage, true);
}

async function statOrNotFound(path: string, displayRoot: string) {
  return stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Path not found: ${displayPathOf(displayRoot, path)}`);
    throw error;
  });
}

/** The worker compares this with its own resolution, to notice the path being replaced in between. */
function realPathOrNotFound(path: string, displayRoot: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    throw new Error(`Path not found: ${displayPathOf(displayRoot, path)}`);
  }
}

function displayPathOf(displayRoot: string, path: string): string {
  return relative(displayRoot, path).split(sep).join("/");
}

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} seconds`;
}

type WorkerOutcome<T> = { kind: "done"; reply: T } | { kind: "timeout" } | { kind: "cancelled" } | { kind: "busy" };

let runningSearches = 0;
const waitingSearches: Array<() => void> = [];
let liveWorkers = 0;

/** Search worker threads that have not exited yet. Tests use it to check that stopped searches really end. */
export function activeSearchWorkers(): number {
  return liveWorkers;
}

/** Wait for a free slot. Resolves false if the signal fires first; the search then never gets a slot. */
function waitForSlot(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const onAbort = () => {
      const index = waitingSearches.indexOf(grant);

      if (index !== -1) waitingSearches.splice(index, 1);
      resolve(false);
    };

    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    };

    waitingSearches.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a search on a fresh worker thread. The worker is terminated when the
 * search exceeds `timeoutMs` or `signal` fires, which also stops a regular
 * expression in the middle of catastrophic backtracking.
 */
async function runInWorker<T extends GrepReply | GlobReply>(
  request: SearchRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WorkerOutcome<T>> {
  if (signal?.aborted) return { kind: "cancelled" };

  if (runningSearches < MAX_PARALLEL_SEARCHES) {
    runningSearches++;
  } else if (waitingSearches.length >= MAX_WAITING_SEARCHES) {
    return { kind: "busy" };
  } else if (!(await waitForSlot(signal))) {
    return { kind: "cancelled" };
  } // else: a finishing search handed its slot over

  try {
    // An abort listener added to an already-aborted signal never fires, so check once more here.
    if (signal?.aborted) return { kind: "cancelled" };

    return await new Promise<WorkerOutcome<T>>((resolve, reject) => {
      const worker = new Worker(WORKER_URL, {
        workerData: { clouddevSearch: true, request },
        // Past this the worker alone is stopped (ERR_WORKER_OUT_OF_MEMORY), long before the server would feel it.
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
      let settled = false;

      liveWorkers++;
      worker.once("exit", () => liveWorkers--);

      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finish();
      };

      const stop = (outcome: WorkerOutcome<T>) => settle(() => {
        worker.terminate().catch(() => {});
        resolve(outcome);
      });

      const timer = setTimeout(() => stop({ kind: "timeout" }), timeoutMs);
      const onAbort = () => stop({ kind: "cancelled" });

      signal?.addEventListener("abort", onAbort, { once: true });

      worker.once("message", (message: WorkerMessage) => settle(() => {
        if (message.ok) resolve({ kind: "done", reply: message.reply as T });
        else reject(new Error(message.error));
      }));
      worker.once("error", (error: NodeJS.ErrnoException) => settle(() => reject(
        error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new Error("Search ran out of memory and was stopped. Narrow it with path or glob.")
          : error,
      )));
      worker.once("exit", (code) => settle(() => reject(new Error(`Search worker exited unexpectedly (code ${code}).`))));
    });
  } finally {
    const next = waitingSearches.shift();

    if (next) next();
    else runningSearches--;
  }
}
