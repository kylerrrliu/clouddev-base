import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { looksBinary } from "./common.ts";
import { confirmInside, listFiles, readRegularFile } from "./file-list.ts";
import { compileGlob } from "./glob-match.ts";

// The grep and glob work proper. search.ts runs it on a worker thread with a
// time limit, so a pathological pattern or a huge tree cannot stall the server.

const MAX_SEARCHED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCH_LINE_CHARS = 500;

export interface GrepRequest {
  op: "grep";
  /** A file or folder; `isFile` says which. */
  target: string;
  /** `target` with symlinks resolved, as the main thread saw it just before starting the worker. */
  expectedRealTarget: string;
  isFile: boolean;
  /** The workspace root: result paths are shown relative to it, and every result must lie inside it. */
  displayRoot: string;
  pattern: string;
  ignoreCase: boolean;
  glob?: string;
  filesOnly: boolean;
  maxResults: number;
  /** Most files to consider. */
  fileLimit: number;
}

export interface GlobRequest {
  op: "glob";
  dir: string;
  /** `dir` with symlinks resolved, as the main thread saw it just before starting the worker. */
  expectedRealDir: string;
  displayRoot: string;
  pattern: string;
  maxResults: number;
  fileLimit: number;
}

export type SearchRequest = GrepRequest | GlobRequest;

export interface GrepReply {
  /** Output lines: `path:line:text`, or paths with filesOnly. */
  lines: string[];
  limitReached: boolean;
  capped: boolean;
}

export interface GlobReply {
  /** Up to maxResults display paths, sorted. */
  paths: string[];
  /** All matching files, including those not shown. */
  total: number;
  capped: boolean;
}

export type WorkerMessage = { ok: true; reply: GrepReply | GlobReply } | { ok: false; error: string };

export function runSearch(request: SearchRequest): GrepReply | GlobReply {
  return request.op === "grep" ? runGrep(request) : runGlob(request);
}

export function runGrep(request: GrepRequest): GrepReply {
  const regex = new RegExp(request.pattern, request.ignoreCase ? "i" : "");
  // A pattern without metacharacters is plain text: a file that does not contain
  // it anywhere has no matching line, so it can be skipped without splitting it.
  const literal = !/[\\^$.*+?()[\]{}|]/.test(request.pattern);
  const boundary = searchBoundary(request.target, request.expectedRealTarget, request.displayRoot);
  let candidates: string[];
  let capped = false;

  if (request.isFile) {
    candidates = [request.target];
  } else {
    const listing = listFiles(request.target, request.displayRoot, request.fileLimit);
    const matchesGlob = request.glob ? compileGlob(request.glob) : undefined;

    candidates = (matchesGlob ? listing.files.filter(matchesGlob) : listing.files)
      .sort()
      .map((file) => join(request.target, file));
    capped = listing.capped;
  }

  const lines: string[] = [];

  for (const path of candidates) {
    const file = readRegularFile(path, MAX_SEARCHED_FILE_BYTES);

    if (!file || looksBinary(file.data)) continue;

    const text = file.data.toString("utf8");

    if (literal && !regex.test(text)) continue;

    const matches = matchingLines(text, regex, request.filesOnly ? 1 : request.maxResults - lines.length);

    if (matches.length === 0 || !confirmInside(path, boundary, file.stats)) continue;

    const display = displayPath(request.displayRoot, path);

    if (request.filesOnly) {
      lines.push(display);
    } else {
      for (const match of matches) lines.push(`${display}:${match.line}:${match.text}`);
    }

    if (lines.length >= request.maxResults) return { lines, limitReached: true, capped };
  }

  return { lines, limitReached: false, capped };
}

function matchingLines(text: string, regex: RegExp, limit: number): Array<{ line: number; text: string }> {
  const matches: Array<{ line: number; text: string }> = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const line = lines[i]!;

    if (regex.test(line)) {
      matches.push({
        line: i + 1,
        text: line.length > MAX_MATCH_LINE_CHARS ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}…` : line,
      });
    }
  }

  return matches;
}

export function runGlob(request: GlobRequest): GlobReply {
  const boundary = searchBoundary(request.dir, request.expectedRealDir, request.displayRoot);
  const listing = listFiles(request.dir, request.displayRoot, request.fileLimit);
  const found = listing.files.filter(compileGlob(request.pattern)).sort();
  const paths: string[] = [];

  for (const file of found) {
    if (paths.length >= request.maxResults) break;

    const path = join(request.dir, file);

    if (confirmInside(path, boundary)) paths.push(displayPath(request.displayRoot, path));
  }

  return { paths, total: found.length, capped: listing.capped };
}

/**
 * The folder every result must lie in: the workspace root. The search path
 * itself is not trusted as a boundary. The main thread resolved it (symlinks
 * included) just before starting this worker; if it now resolves elsewhere,
 * it was replaced in between, and the search is refused.
 */
function searchBoundary(path: string, expectedRealPath: string, workspaceRoot: string): string {
  let real: string;

  try {
    real = realpathSync.native(path);
  } catch {
    throw new Error("The search path no longer exists. Search again.");
  }

  if (real !== expectedRealPath) throw new Error("The search path changed while the search was starting. Search again.");

  return realpathOrSelf(workspaceRoot);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function displayPath(displayRoot: string, path: string): string {
  return relative(displayRoot, path).split(sep).join("/");
}

// Worker entry point. Importing this module on the main thread (as tests do) runs nothing.
if (!isMainThread && parentPort && (workerData as { clouddevSearch?: unknown } | null)?.clouddevSearch) {
  let message: WorkerMessage;

  try {
    message = { ok: true, reply: runSearch((workerData as { request: SearchRequest }).request) };
  } catch (error) {
    message = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  parentPort.postMessage(message);
}
