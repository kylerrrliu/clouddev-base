import { realpathSync, type Stats } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { isInside } from "../paths.ts";
import { clipStart, decodeText, splitLines, utf16ByteOrder, type Utf16ByteOrder } from "./common.ts";
import { confirmInside, listFiles, tryReadRegularFile, type FileList, type ReadFailure } from "./file-list.ts";
import { compileGlob } from "./glob-match.ts";

// The grep and glob work proper. search.ts runs it on a worker thread with a
// time limit, so a pathological pattern or a huge tree cannot stall the server.

/** Larger files are not searched; the reply says which were left out. */
export const MAX_SEARCHED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCH_LINE_CHARS = 500;

/** How many skipped files or folders of one kind a reply names. The rest are only counted. */
const MAX_NAMED_SKIPS = 3;

/** How much of a file over the size limit is read to tell whether it is binary: what looksBinary looks at. */
const BINARY_CHECK_BYTES = 8000;

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

/** Files or folders of one kind that a search passed over: how many, and the display paths of the first few. */
export interface SkipSample {
  count: number;
  paths: string[];
}

/**
 * What a folder search could not look into. Without it, "no matches" reads as
 * "not there" when the text sits in a file that was never searched.
 */
export interface Skipped {
  /** Files over MAX_SEARCHED_FILE_BYTES. */
  tooLarge: SkipSample;
  /** Files that look binary. Only counted: projects hold many (images, fonts, archives). */
  binary: number;
  /** Files that could not be opened or read: permission denied, an I/O error. */
  unreadableFiles: SkipSample;
  /** Folders that could not be listed, named with a trailing "/". */
  unreadableFolders: SkipSample;
}

/** Why a file was not searched. A reply carries it to the main thread, so it holds no file content. */
export type NotSearched =
  | Exclude<ReadFailure, { reason: "too-large" }>
  /** `utf16` is the byte order a UTF-16 file announces with a byte-order mark: grep in bash finds nothing in it as stored. */
  | { reason: "too-large"; size: number; utf16?: Utf16ByteOrder }
  | { reason: "binary" };

export interface GrepReply {
  /** Output lines: `path:line:text`, or paths with filesOnly. */
  lines: string[];
  limitReached: boolean;
  capped: boolean;
  skipped: Skipped;
  /** Set when the target is a single file and it was not searched: why. */
  notSearched?: NotSearched;
}

export interface GlobReply {
  /** Up to maxResults display paths, sorted. */
  paths: string[];
  /** All matching files, including those not shown, but not unreadableFiles. */
  total: number;
  capped: boolean;
  /**
   * Matching files that could not be checked, so they are not listed: their folder can be listed but not entered
   * (no x permission, as `chmod -R 644` leaves it).
   */
  unreadableFiles: SkipSample;
  /** Folders that could not be listed: files in them were not seen. */
  unreadableFolders: SkipSample;
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
  const inside = folderCheck(boundary);
  const skipped: Skipped = { tooLarge: noSkips(), binary: 0, unreadableFiles: noSkips(), unreadableFolders: noSkips() };
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
    skipped.unreadableFolders = unreadableFolders(listing, request.target, request.displayRoot, inside);
  }

  const lines: string[] = [];

  for (const path of candidates) {
    const file = readSearchedFile(path);

    if ("reason" in file) {
      // A file named on its own gets an answer of its own: why it was not searched.
      if (request.isFile) return { lines, limitReached: false, capped, skipped, notSearched: file };

      noteSkipped(skipped, file, path, request.displayRoot, inside);
      continue;
    }

    if (literal && !regex.test(file.text)) continue;

    const matches = matchingLines(file.text, regex, request.filesOnly ? 1 : request.maxResults - lines.length);

    if (matches.length === 0 || !confirmInside(path, boundary, file.stats)) continue;

    const display = displayPath(request.displayRoot, path);

    if (request.filesOnly) {
      lines.push(display);
    } else {
      for (const match of matches) lines.push(`${display}:${match.line}:${match.text}`);
    }

    if (lines.length >= request.maxResults) return { lines, limitReached: true, capped, skipped };
  }

  return { lines, limitReached: false, capped, skipped };
}

/** A file's text, or why it is not searched. */
function readSearchedFile(path: string): { text: string; stats: Stats } | NotSearched {
  const file = tryReadRegularFile(path, MAX_SEARCHED_FILE_BYTES, false, BINARY_CHECK_BYTES);

  if ("reason" in file) return file.reason === "too-large" ? tooLargeOrBinary(file.size, file.head) : file;

  const text = decodeText(file.data);

  return text === undefined ? { reason: "binary" } : { text, stats: file.stats };
}

/**
 * Why a file over the size limit was not searched. A big image, video or font is binary before it is big: it is
 * counted with the binary files, so it does not take one of the few names a reply gives big files, which belong to
 * the logs and bundles that may hold the text looked for. The head is dropped here: it is file content. Only its
 * encoding goes on, for a big UTF-16 file: grep in bash matches bytes, so the advice for it has to decode it first.
 */
function tooLargeOrBinary(size: number, head: Buffer | undefined): NotSearched {
  if (head && decodeText(head) === undefined) return { reason: "binary" };

  const utf16 = head && utf16ByteOrder(head);

  return utf16 ? { reason: "too-large", size, utf16 } : { reason: "too-large", size };
}

function noSkips(): SkipSample {
  return { count: 0, paths: [] };
}

function addSkip(sample: SkipSample, display: string): void {
  sample.count++;

  if (sample.paths.length < MAX_NAMED_SKIPS) sample.paths.push(display);
}

/** Count a file of a folder search that was not searched. */
function noteSkipped(skipped: Skipped, why: NotSearched, path: string, displayRoot: string, inside: FolderCheck): void {
  // Never named, so not worth checking where each one really lies: a project can hold thousands.
  if (why.reason === "binary") {
    skipped.binary++;
    return;
  }

  // Gone or replaced since the folder was listed: nothing was lost.
  if (why.reason !== "too-large" && why.reason !== "unreadable") return;

  // The file was opened without following a symlink, but a folder on the way may have been swapped for one
  // since it was listed: name only files whose folder really lies in the workspace. (The folder, because an
  // unreadable file's own real path may be unknowable.)
  if (!inside(dirname(path))) return;

  addSkip(why.reason === "too-large" ? skipped.tooLarge : skipped.unreadableFiles, displayPath(displayRoot, path));
}

/** The folders a listing could not read, as display paths ending in "/". */
function unreadableFolders(listing: FileList, root: string, displayRoot: string, inside: FolderCheck): SkipSample {
  const sample = noSkips();

  for (const rel of listing.unreadable) {
    const path = join(root, rel);

    // A folder swapped for a symlink since it was listed is read through it: report only folders whose name came
    // from listing a folder that really lies in the workspace. The parent is checked, as for files: the folder's
    // own real path is unknowable when its parent can be listed but not entered (r without x, as chmod -R 644
    // leaves it). The search root itself was named by the caller, not listed: it is checked directly.
    if (inside(rel === "" ? path : dirname(path))) addSkip(sample, `${displayPath(displayRoot, path) || "."}/`);
  }

  return sample;
}

/** Whether a folder, symlinks resolved, lies inside the workspace. */
type FolderCheck = (folder: string) => boolean;

/**
 * A FolderCheck for one search, which resolves each folder once: a folder full of big or unreadable files costs one
 * realpath, not one per file. A folder swapped for a symlink after its first check is not noticed, which is
 * acceptable because only the names and counts of what was skipped depend on it.
 */
function folderCheck(realRoot: string): FolderCheck {
  const known = new Map<string, boolean>();

  return (folder) => {
    let inside = known.get(folder);

    if (inside === undefined) {
      inside = liesInside(folder, realRoot);
      known.set(folder, inside);
    }

    return inside;
  };
}

/** Whether `path`, symlinks resolved, lies inside `realRoot`. */
function liesInside(path: string, realRoot: string): boolean {
  try {
    return isInside(realpathSync.native(path), realRoot);
  } catch {
    return false;
  }
}

/** Whether `path` cannot be resolved for lack of permission: its folder can be listed but not entered. */
function unresolvable(path: string): boolean {
  try {
    realpathSync.native(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    return code === "EACCES" || code === "EPERM";
  }
}

function matchingLines(text: string, regex: RegExp, limit: number): Array<{ line: number; text: string }> {
  const matches: Array<{ line: number; text: string }> = [];
  // No empty line after a final newline, so "^$" matches no line past the end of the file.
  const lines = splitLines(text);

  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const line = lines[i]!;

    if (regex.test(line)) {
      matches.push({
        line: i + 1,
        text: line.length > MAX_MATCH_LINE_CHARS ? `${clipStart(line, MAX_MATCH_LINE_CHARS)}…` : line,
      });
    }
  }

  return matches;
}

export function runGlob(request: GlobRequest): GlobReply {
  const boundary = searchBoundary(request.dir, request.expectedRealDir, request.displayRoot);
  const inside = folderCheck(boundary);
  const listing = listFiles(request.dir, request.displayRoot, request.fileLimit);
  const found = listing.files.filter(compileGlob(request.pattern)).sort();
  const paths: string[] = [];
  const unreadableFiles = noSkips();

  for (const file of found) {
    if (paths.length >= request.maxResults) break;

    const path = join(request.dir, file);

    if (confirmInside(path, boundary)) {
      paths.push(displayPath(request.displayRoot, path));
    } else if (unresolvable(path) && inside(dirname(path))) {
      // There, but where it really lies cannot be checked, so it is not listed: say so instead of leaving it out
      // unmentioned. (Named only when its folder lies in the workspace, as grep does.)
      addSkip(unreadableFiles, displayPath(request.displayRoot, path));
    }
  }

  return {
    paths,
    // Not counting the files that could not be checked: "Showing 3 of 5 files" would promise two more.
    total: found.length - unreadableFiles.count,
    capped: listing.capped,
    unreadableFiles,
    unreadableFolders: unreadableFolders(listing, request.dir, request.displayRoot, inside),
  };
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
