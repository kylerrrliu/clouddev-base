import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  formatSize,
  iconvFromUtf16,
  MAX_BYTES,
  MAX_RESULT_CHARS,
  MAX_TEXT_FILE_BYTES,
  shellWord,
  takeHead,
  textResult,
  type ToolResult,
  type Utf16ByteOrder,
} from "./common.ts";
import { MAX_LISTED_FILES } from "./file-list.ts";
import {
  MAX_SEARCHED_FILE_BYTES,
  type GlobReply, type GrepReply, type NotSearched, type SearchRequest, type Skipped, type SkipSample, type WorkerMessage,
} from "./search-worker.ts";

export { compileGlob } from "./glob-match.ts";

/** Hard limit for one grep or glob call. The worker thread doing it is then terminated. */
export const SEARCH_TIMEOUT_MS = 20_000;

/** More concurrent searches wait for a free slot instead of all competing for CPU. */
const MAX_PARALLEL_SEARCHES = 4;

/** Searches allowed to wait for a slot. Beyond this a search is refused rather than queued. */
const MAX_WAITING_SEARCHES = 32;

/** Heap limit for one search worker. */
const WORKER_HEAP_MB = 512;

/** The size limit of one result, as the notes that cut a list name it. */
const RESULT_LIMIT = `${MAX_RESULT_CHARS.toLocaleString("en-US")} characters or ${MAX_BYTES / 1024}KB`;

const SEARCHED_FILE_LIMIT = `${MAX_SEARCHED_FILE_BYTES / (1024 * 1024)}MB`;

const READ_FILE_LIMIT = `${MAX_TEXT_FILE_BYTES / (1024 * 1024)}MB`;

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

  // FIFOs, sockets and devices are never read (a FIFO could block). The worker would not be told much more:
  // on macOS, opening a socket fails with an error Node cannot even name.
  if (!targetStats.isDirectory() && !targetStats.isFile()) {
    return notSearchedResult(displayPathOf(displayRoot, target), { reason: "not-regular" });
  }

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

  if (reply.notSearched) return notSearchedResult(displayPathOf(displayRoot, target), reply.notSearched);

  // Without these, "no matches" reads as "it does not exist" when the files holding it were never searched.
  const skipped = describeSkipped(reply.skipped);

  if (reply.lines.length === 0) {
    const none = reply.capped
      ? `No matches in the first ${fileLimit} files. The search stops after ${fileLimit} files, so the rest were not searched: narrow it with path or glob.`
      : "No matches found.";

    return textResult(skipped ? `${none} ${skipped}` : none);
  }

  const found = reply.lines.length;
  const what = options.filesOnly ? "matching files" : "matching lines";

  return textResult(fitResult(reply.lines, (shown) => [
    reply.limitReached ? `[Stopped after ${options.maxResults} results. Narrow the search with path, glob or a more specific pattern.]` : "",
    shown < found ? `[Output cut to fit the size limit (${RESULT_LIMIT}): showing ${shown} of ${found} ${what}. Narrow the search to see the rest.]` : "",
    reply.capped ? `[Only the first ${fileLimit} files were searched.]` : "",
    skipped ? `[${skipped}]` : "",
  ]));
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
  const unreadable = describeSkipped({ unreadableFiles: reply.unreadableFiles, unreadableFolders: reply.unreadableFolders });

  if (reply.paths.length === 0) {
    const none = reply.capped
      ? `No files found in the first ${fileLimit} files. The search stops after ${fileLimit} files, so the rest were not checked: narrow it with path or a more specific pattern.`
      : "No files found.";

    return textResult(unreadable ? `${none} ${unreadable}` : none);
  }

  return textResult(fitResult(reply.paths, (shown) => [
    shown < reply.total
      ? `[Showing ${shown} of ${reply.total} files${shown < reply.paths.length ? `, cut to fit the size limit (${RESULT_LIMIT})` : ""}. Use a more specific pattern or path.]`
      : "",
    reply.capped ? `[Only the first ${fileLimit} files were considered.]` : "",
    unreadable ? `[${unreadable}]` : "",
  ]));
}

/**
 * Notes, a blank line, then as many items as fit in one result: MAX_RESULT_CHARS characters and MAX_BYTES bytes,
 * notes included. Claude Code saves a longer result to a file the model cannot open here and shows it only the
 * start, so the notes come first. `notesFor` gets how many items are shown; "" stands for a note that does not apply.
 */
function fitResult(items: string[], notesFor: (shown: number) => string[]): string {
  const compose = (shown: string[]) => {
    const notes = notesFor(shown.length).filter(Boolean);

    return (notes.length > 0 ? [...notes, "", ...shown] : shown).join("\n");
  };
  const whole = compose(items);

  if (whole.length <= MAX_RESULT_CHARS && Buffer.byteLength(whole) <= MAX_BYTES) return whole;

  // The notes say how many items are shown, so their length depends on it: make room for the longest count.
  const header = `${notesFor(items.length - 1).filter(Boolean).join("\n")}\n\n`;
  const { lines } = takeHead(items, items.length, MAX_BYTES - Buffer.byteLength(header), MAX_RESULT_CHARS - header.length);

  return compose(lines);
}

/** "Not searched: 2 files over 2MB (a.log, b.log), 3 binary files, 1 unreadable folder (secret/).", or "". */
function describeSkipped(skipped: Partial<Skipped>): string {
  const parts = [
    named(skipped.tooLarge, (count) => `${plural(count, "file")} over ${SEARCHED_FILE_LIMIT}`),
    skipped.binary ? plural(skipped.binary, "binary file") : "",
    named(skipped.unreadableFiles, (count) => plural(count, "unreadable file")),
    named(skipped.unreadableFolders, (count) => plural(count, "unreadable folder")),
  ].filter(Boolean);

  return parts.length > 0 ? `Not searched: ${parts.join(", ")}.` : "";
}

/** "2 unreadable folders (a/, b/)", or "" for none. */
function named(sample: SkipSample | undefined, what: (count: number) => string): string {
  if (!sample || sample.count === 0) return "";

  const more = sample.count - sample.paths.length;

  return `${what(sample.count)} (${sample.paths.join(", ")}${more > 0 ? ` and ${more} more` : ""})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The answer for a file named on its own that was not searched: why, and what to do instead. */
function notSearchedResult(display: string, why: NotSearched): ToolResult {
  switch (why.reason) {
    case "too-large":
      // bash first: paging through a big file with read is a poor way to search it, and read refuses the biggest.
      return textResult(
        `${display} is ${sizeText(why.size)}, over grep's ${SEARCHED_FILE_LIMIT} limit, so it was not searched. ` +
          `${searchAdvice(shellWord(display), why.utf16)} ${partsAdvice(why.size, why.utf16 !== undefined)}`,
        true,
      );
    case "binary":
      return textResult(
        `${display} looks like a binary file (it has a NUL byte near the start), so it was not searched. To search it anyway, use grep -a in bash.`,
        true,
      );
    case "unreadable":
      return textResult(`${display} could not be read (${describeErrorCode(why.code)}), so it was not searched.`, true);
    case "not-regular":
      return textResult(`${display} is not a regular file, so it was not searched.`, true);
    case "missing":
      return textResult(`Path not found: ${display}`, true);
  }
}

/**
 * A file size as these messages give it. When it rounds to a limit ("2.0MB, over grep's 2MB limit" reads like a
 * mistake), the exact byte count follows.
 */
function sizeText(size: number): string {
  const shown = formatSize(size);
  const roundsToLimit = [MAX_SEARCHED_FILE_BYTES, MAX_TEXT_FILE_BYTES].some((limit) => formatSize(limit) === shown);

  return roundsToLimit ? `${shown} (${size.toLocaleString("en-US")} bytes)` : shown;
}

/**
 * How to search a file too big for grep in bash; `file` is its path as one shell word. grep there matches bytes, so it
 * finds nothing in UTF-16 text, not even ASCII: such a file goes through iconv first, which adds no line, so the line
 * numbers are the file's own.
 */
function searchAdvice(file: string, utf16: Utf16ByteOrder | undefined): string {
  return utf16
    ? `It is UTF-16: search it in bash with ${iconvFromUtf16(utf16)} ${file} | grep -n 'PATTERN' | head -50.`
    : `Search it in bash: grep -n 'PATTERN' ${file} | head -50, or rg.`;
}

/**
 * How to look at parts of a file too big for grep: read pages through it (UTF-16 shown decoded), unless it is too big
 * for read as well. tail and sed would show UTF-16 text as stored, NUL bytes and all, so it goes through iconv.
 */
function partsAdvice(size: number, utf16: boolean): string {
  return size <= MAX_TEXT_FILE_BYTES
    ? "read with offset/limit can show parts of it."
    : `It is over read's ${READ_FILE_LIMIT} limit as well: ${utf16 ? "iconv piped to tail or sed -n" : "tail or sed -n"} in bash can show parts of it.`;
}

function describeErrorCode(code: string): string {
  return code === "EACCES" || code === "EPERM" ? "permission denied" : code;
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
