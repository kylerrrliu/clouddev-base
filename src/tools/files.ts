import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, stat, type FileHandle } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import { isMissing } from "../paths.ts";
import {
  MAX_BYTES,
  MAX_LINES,
  MAX_RESULT_CHARS,
  MAX_TEXT_FILE_BYTES,
  clipStart,
  decodeText,
  formatSize,
  iconvFromUtf16,
  looksBinary,
  shellWord,
  splitLines,
  takeHead,
  textResult,
  utf16ByteOrder,
  type ToolResult,
  type Utf16ByteOrder,
} from "./common.ts";
import { assertRegularFile, replaceFile } from "./replace-file.ts";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;

/** How much of a single over-long line read shows (minified code, data blobs); bash can show the rest. */
export const MAX_LONG_LINE_CHARS = 20_000;

/**
 * Most bytes of the next part of an over-long line that read's bash command prints. bash returns its output whole
 * while it fits MAX_BYTES (50KB): 20,000 characters of CJK text would be 60KB, so such a window holds fewer.
 */
const LONG_LINE_WINDOW_BYTES = 40_000;

/**
 * Largest file edit changes. edit holds the whole file in memory, and a single read of 2GB or more would abort the
 * server (a failed assertion inside Node, which no try/catch can catch); bigger files are changed with bash.
 */
export const MAX_EDIT_BYTES = 64 * 1024 * 1024;

/** The most one read call asks for, whatever a caller wants: Node aborts the process on a read of 2GB or more. */
const MAX_READ_CHUNK = 1024 * 1024 * 1024;

/** What read puts on top of a UTF-16 file, which grep searches too. */
function utf16Note(byteOrder: Utf16ByteOrder): string {
  return `[UTF-16 file, shown decoded. edit does not change UTF-16 files; convert it with ${iconvFromUtf16(byteOrder)} in bash first.]`;
}

/** Room kept for the paging note at the top of a page; the longest one is under 200 characters. */
const PAGE_NOTE_ROOM = 300;

/** Room a folder listing leaves for the note on top and for what open_workspace writes around it (the root path). */
const LISTING_ROOM = 2_000;

// O_NONBLOCK keeps a FIFO from stalling the open (and with it a thread of libuv's pool, which four stuck calls use
// up); O_NOFOLLOW refuses a symlink swapped in for the file after its path was checked.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** U+FEFF, the UTF-8 byte order mark. */
const BOM = String.fromCharCode(0xfeff);

/** Strict decoder: invalid UTF-8 throws instead of turning into replacement characters. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode UTF-8 text, or return undefined when the bytes are not valid UTF-8 (GBK, Latin-1, ...). */
function decodeUtf8(buffer: Buffer): string | undefined {
  try {
    return strictUtf8.decode(buffer);
  } catch {
    return undefined;
  }
}

export async function readPath(
  absolutePath: string,
  displayPath: string,
  offset?: number,
  limit?: number,
): Promise<ToolResult> {
  const stats = await stat(absolutePath).catch((error: unknown) => {
    if (isMissing(error)) throw new Error(`File not found: ${displayPath}`);
    throw error;
  });

  if (stats.isDirectory()) return textResult(await listDirectory(absolutePath, displayPath));

  // stat never blocks, so a FIFO or socket is refused here before anything opens it.
  assertRegularFile(stats, displayPath);

  const file = await openRegularFile(absolutePath, displayPath, `File not found: ${displayPath}`);

  try {
    const mimeType = IMAGE_TYPES[extname(absolutePath).toLowerCase()];

    if (mimeType) {
      if (file.stats.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image is too large to return (${formatSize(file.stats.size)}, limit ${formatSize(MAX_IMAGE_BYTES)}).`);
      }

      const data = (await readFrom(file.handle, file.stats.size)).toString("base64");

      return {
        content: [
          { type: "text", text: `Image ${displayPath} (${mimeType}, ${formatSize(file.stats.size)})` },
          { type: "image", data, mimeType },
        ],
      };
    }

    if (file.stats.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `${displayPath} is ${formatSize(file.stats.size)}, too large to read at once. Use bash (head, tail, sed -n, grep) to inspect parts of it.`,
      );
    }

    return textResult(showText(await readFrom(file.handle, file.stats.size), displayPath, offset, limit));
  } finally {
    await file.handle.close();
  }
}

/**
 * The part of a text file one read returns: notes first (paging, encoding), so they are seen before the text,
 * then as many whole lines as fit MAX_RESULT_CHARS and MAX_BYTES together with the notes.
 */
function showText(buffer: Buffer, displayPath: string, offset?: number, limit?: number): string {
  // A UTF-16 file has NUL bytes near its start, but it is text: grep searches it, so read shows it.
  const utf16 = utf16ByteOrder(buffer);

  if (!utf16 && looksBinary(buffer)) {
    return `${displayPath} looks like a binary file (${formatSize(buffer.length)}); its content is not shown.`;
  }

  // The UTF-16 decoders drop the byte order mark themselves.
  const decoded = utf16 ? decodeText(buffer) : decodeUtf8(buffer);
  const notes: string[] = [];

  if (utf16) {
    notes.push(utf16Note(utf16));
  } else if (decoded === undefined) {
    // Still show non-UTF-8 text (lossily), but say so: edit will refuse to touch it.
    notes.push(
      `[Note: ${displayPath} is not valid UTF-8 (it may use another encoding such as GBK or Latin-1). Characters that are not UTF-8 are shown as replacement characters, and edit will refuse to change this file.]`,
    );
  }

  const text = decoded ?? buffer.toString("utf8");
  const lines = splitLines(text.startsWith(BOM) ? text.slice(1) : text);

  if (lines.length === 0) return `(${displayPath} is empty)`;

  const start = (offset ?? 1) - 1;

  if (start >= lines.length) {
    throw new Error(`Offset ${offset} is beyond the end of ${displayPath} (${lines.length} lines).`);
  }

  const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
  const reservedChars = notes.join("\n").length + PAGE_NOTE_ROOM;
  const reservedBytes = Buffer.byteLength(notes.join("\n")) + PAGE_NOTE_ROOM;
  const page = takeHead(lines.slice(start, end), MAX_LINES, MAX_BYTES - reservedBytes, MAX_RESULT_CHARS - reservedChars);

  if (page.lines.length === 0) {
    // A single line is bigger than the whole budget: show its beginning, cut between characters. The note names the
    // file in a command, so the room kept for it grows with the path.
    const line = lines[start]!;
    const file = shellWord(displayPath);
    const shown = clipStart(line, MAX_LONG_LINE_CHARS, MAX_BYTES - reservedBytes - Buffer.byteLength(file));
    const after = start + 1 < lines.length ? ` Use offset=${start + 2} to continue after it.` : "";
    const next = clipStart(line.slice(shown.length), MAX_LONG_LINE_CHARS, LONG_LINE_WINDOW_BYTES);
    const more = restOfLineCommand(file, start, utf16 ?? buffer, line, shown.length, shown.length + next.length);
    const note = `[Line ${start + 1} is ${formatSize(Buffer.byteLength(line))}; showing its first ${shown.length.toLocaleString("en-US")} characters. To see more of it: ${more} in bash.${after}]`;

    return withNotes([note, ...notes], shown);
  }

  const lastShown = start + page.lines.length;

  if (page.truncated) {
    notes.unshift(`[Showing lines ${start + 1}-${lastShown} of ${lines.length}. Use offset=${lastShown + 1} to continue.]`);
  } else if (end < lines.length) {
    notes.unshift(`[Lines ${start + 1}-${end} of ${lines.length}; ${lines.length - end} more lines after them. Use offset=${end + 1} to continue.]`);
  }

  return withNotes(notes, page.lines.join("\n"));
}

function withNotes(notes: string[], body: string): string {
  return notes.length === 0 ? body : `${notes.join("\n")}\n\n${body}`;
}

/**
 * A bash command printing the characters `from` up to `to` of line `index` (counted from 0), as `line` holds them
 * decoded. cut counts bytes there, not characters: cut -c counts bytes in GNU cut (Linux), characters in macOS's,
 * which stops at bytes that are not UTF-8. So both ends are byte offsets, and both fall between characters.
 *
 * A UTF-16 file (`source` is its byte order) goes through iconv first: the line is then the UTF-8 encoding of `line`,
 * after the 3 bytes of the byte-order mark on line 1. Otherwise sed prints the line as `source`, the whole file,
 * holds it: the line's bytes there give the offsets, which also holds for a file that is not valid UTF-8, shown with
 * replacement characters, and for line 1 after a UTF-8 byte-order mark.
 */
function restOfLineCommand(file: string, index: number, source: Buffer | Utf16ByteOrder, line: string, from: number, to: number): string {
  const print = `sed -n '${index + 1}p'`;

  if (typeof source === "string") {
    const start = (index === 0 ? 3 : 0) + Buffer.byteLength(line.slice(0, from));

    return `${iconvFromUtf16(source)} ${file} | ${print} | cut -b ${start + 1}-${start + Buffer.byteLength(line.slice(from, to))}`;
  }

  const { bytes, skipped } = rawLine(source, index);

  return `${print} ${file} | cut -b ${skipped + byteOffset(bytes, from) + 1}-${skipped + byteOffset(bytes, to)}`;
}

/** The bytes of line `index` (counted from 0) of a UTF-8 file, after its byte-order mark, and how many bytes that mark took. */
function rawLine(raw: Buffer, index: number): { bytes: Buffer; skipped: number } {
  let start = 0;

  // A "\n" byte is a line end in any text decoded from UTF-8, valid or not: it is never part of another character.
  for (let line = 0; line < index; line++) start = raw.indexOf(10, start) + 1;

  const end = raw.indexOf(10, start);
  const skipped = index === 0 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;

  return { bytes: raw.subarray(start + skipped, end === -1 ? raw.length : end), skipped };
}

/**
 * Where, in `bytes`, the first `chars` UTF-16 code units of their decoded text end (`chars` falls between characters).
 * Decoding a longer start of `bytes` never gives a shorter text, and one byte more past that point always adds to it
 * (a character, or a replacement character for a part of one): the point is the longest start that decodes to no
 * more than `chars`. Every character of valid UTF-8 has its own bytes; so has every replacement character, for the
 * bytes it replaces.
 */
function byteOffset(bytes: Buffer, chars: number): number {
  let low = 0;
  let high = Math.min(bytes.length, chars * 3);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (bytes.toString("utf8", 0, middle).length <= chars) low = middle;
    else high = middle - 1;
  }

  return low;
}

/**
 * Open a file for reading without blocking on a FIFO or following a symlink, and check that it is a regular file.
 * The caller reads from the returned handle, so the file checked is the file read.
 */
async function openRegularFile(path: string, displayPath: string, missing: string): Promise<{ handle: FileHandle; stats: Stats }> {
  let handle: FileHandle;

  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    if (isMissing(error)) throw new Error(missing);

    // A socket cannot be opened at all (EOPNOTSUPP, ENXIO), nor a symlink with O_NOFOLLOW (ELOOP): say what it is.
    const stats = await lstat(path).catch(() => undefined);

    if (stats) assertRegularFile(stats, displayPath);

    throw error;
  }

  try {
    const stats = await handle.stat();
    assertRegularFile(stats, displayPath);

    return { handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read up to `size` bytes from the start of an open file, in calls of at most MAX_READ_CHUNK. */
async function readFrom(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let length = 0;

  while (length < size) {
    const { bytesRead } = await handle.read(buffer, length, Math.min(size - length, MAX_READ_CHUNK), length);

    if (bytesRead === 0) break;

    length += bytesRead;
  }

  return buffer.subarray(0, length);
}

export async function listDirectory(absolutePath: string, displayPath: string): Promise<string> {
  const entries = await readdir(absolutePath, { withFileTypes: true });

  if (entries.length === 0) return `Directory ${displayPath} is empty.`;

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const header = `Directory ${displayPath} (${entries.length} entries):`;
  const names = entries
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

  // 500 long names can exceed what one result may hold, so the listing is cut by characters and bytes as well.
  const shown = takeHead(
    names,
    MAX_DIRECTORY_ENTRIES,
    MAX_BYTES - Buffer.byteLength(header) - LISTING_ROOM,
    MAX_RESULT_CHARS - header.length - LISTING_ROOM,
  ).lines;

  const more = shown.length < entries.length
    ? [`[Showing the first ${shown.length} entries. Use glob or bash to see the rest.]`]
    : [];

  return [header, ...more, ...shown].join("\n");
}

export async function writePath(absolutePath: string, displayPath: string, content: string): Promise<ToolResult> {
  await refuseGitPath(absolutePath, displayPath);

  return withFileLock(absolutePath, async () => {
    const { created, notes } = await replaceFile(absolutePath, content, { displayPath });

    return textResult([`${created ? "Created" : "Overwrote"} ${displayPath} (${formatSize(Buffer.byteLength(content))}).`, ...notes].join("\n"));
  });
}

export interface TextEdit {
  old_text: string;
  new_text: string;
}

/**
 * Apply exact-text replacements. Every old_text must match exactly one place
 * in the original file and edits must not overlap, so the result never
 * depends on the order of the edits. CRLF line endings and a UTF-8 BOM are
 * preserved. Files that are not valid UTF-8 text are refused: decoding and
 * re-encoding them would silently corrupt every non-UTF-8 character.
 */
export async function editPath(absolutePath: string, displayPath: string, edits: TextEdit[]): Promise<ToolResult> {
  await refuseGitPath(absolutePath, displayPath);

  return withFileLock(absolutePath, async () => {
    const file = await openRegularFile(absolutePath, displayPath, `File not found: ${displayPath}. Use write to create a new file.`);
    let buffer: Buffer;

    try {
      if (file.stats.size > MAX_EDIT_BYTES) {
        throw new Error(`${displayPath} is ${formatSize(file.stats.size)}, too large for edit; change it with bash (sed -i, perl -pi).`);
      }

      buffer = await readFrom(file.handle, file.stats.size);
    } finally {
      await file.handle.close();
    }

    const utf16 = utf16ByteOrder(buffer);

    if (utf16) {
      throw new Error(
        `${displayPath} is a UTF-16 file; edit only changes UTF-8 text. Convert it with ${iconvFromUtf16(utf16)} in bash first, or change it with bash.`,
      );
    }

    if (looksBinary(buffer)) {
      throw new Error(`${displayPath} looks like a binary file; edit only changes UTF-8 text files.`);
    }

    const raw = decodeUtf8(buffer);

    if (raw === undefined) {
      throw new Error(
        `${displayPath} is not valid UTF-8 (it may use another encoding such as GBK or Latin-1). edit refuses to change it because saving would corrupt its other characters. Convert it to UTF-8 first (for example with iconv in bash), or change it with bash.`,
      );
    }

    const bom = raw.startsWith(BOM) ? BOM : "";
    const body = bom ? raw.slice(1) : raw;
    const firstNewline = body.indexOf("\n");
    const crlf = firstNewline > 0 && body[firstNewline - 1] === "\r";
    const content = body.replace(/\r\n/g, "\n");
    const replacements: Array<{ start: number; end: number; oldText: string; newText: string }> = [];

    edits.forEach((edit, index) => {
      const label = edits.length > 1 ? `edits[${index}].old_text` : "old_text";
      const oldText = edit.old_text.replace(/\r\n/g, "\n");
      const newText = edit.new_text.replace(/\r\n/g, "\n");

      if (oldText === "") throw new Error(`${label} must not be empty.`);

      const start = content.indexOf(oldText);

      if (start === -1) {
        throw new Error(
          `${label} was not found in ${displayPath}. It must match the file exactly, including whitespace and indentation. Read the file again and retry.`,
        );
      }

      const matches = countOccurrences(content, oldText);

      if (matches > 1) {
        throw new Error(`${label} matches ${matches} places in ${displayPath}. Include more surrounding lines so it matches exactly one.`);
      }

      replacements.push({ start, end: start + oldText.length, oldText, newText });
    });

    replacements.sort((a, b) => a.start - b.start);

    for (let i = 1; i < replacements.length; i++) {
      if (replacements[i]!.start < replacements[i - 1]!.end) {
        throw new Error("Edits overlap. Merge overlapping edits into a single edit.");
      }
    }

    let result = "";
    let cursor = 0;

    for (const replacement of replacements) {
      result += content.slice(cursor, replacement.start) + replacement.newText;
      cursor = replacement.end;
    }

    result += content.slice(cursor);

    if (result === content) throw new Error("No changes: new_text is identical to old_text.");

    // `expected`: a change made by someone else since the read above aborts the edit instead of being undone.
    const { notes } = await replaceFile(absolutePath, bom + (crlf ? result.replace(/\n/g, "\r\n") : result), {
      displayPath,
      expected: file.stats,
    });

    let added = 0;
    let removed = 0;

    for (const replacement of replacements) {
      const stats = lineChangeStats(replacement.oldText, replacement.newText);
      added += stats.added;
      removed += stats.removed;
    }

    return textResult([`Edited ${displayPath} (+${added} -${removed} lines).`, ...notes].join("\n"));
  });
}

/**
 * write and edit refuse paths inside a git folder: a hook, or a setting such as core.fsmonitor in its config, makes
 * every later git command run a program, and such a change never shows in git diff. A git folder is one named .git
 * (compared case-insensitively, as APFS and NTFS compare names by default: ".GIT/config" is .git/config there), or
 * any folder git itself takes for one: HEAD next to objects/ and refs/. That covers bare repositories, and a .git
 * that is a symbolic link to a git folder with another name (repo-tool checkouts), whose name is gone from the
 * canonical path checked here. This protects existing git folders only: write could create a new one, and it can
 * still change files that hooks and npm scripts run (.husky/_, node_modules). Reading stays allowed.
 */
async function refuseGitPath(absolutePath: string, displayPath: string): Promise<void> {
  const segments = absolutePath.split(process.platform === "win32" ? /[\\/]/ : "/");

  if (segments.some(isGitName)) {
    throw new Error(
      `Refusing to write ${displayPath}: it is inside a .git folder, whose config and hooks can make git run commands. Use git commands through bash instead.`,
    );
  }

  const gitDir = await enclosingGitDir(absolutePath);

  if (gitDir !== undefined) {
    throw new Error(
      `Refusing to write ${displayPath}: ${displayFolder(gitDir, absolutePath, displayPath)} is a git folder (it holds HEAD, objects and refs, as a bare repository does), whose config and hooks can make git run commands. Use git commands through bash instead.`,
    );
  }
}

/**
 * The git folder that `path` is in (or is), looking up from `path` all the way to the root: a workspace may be
 * opened inside a bare repository. The search stops at a folder holding a .git, which makes it a working tree: git
 * run anywhere below uses that .git, so even a working tree inside a bare repository (worktrees added there) is not
 * part of that repository's git folder.
 */
async function enclosingGitDir(path: string): Promise<string | undefined> {
  for (let folder = path; ; folder = dirname(folder)) {
    if (await isGitDir(folder)) return folder;

    if (await lstat(join(folder, ".git")).then(() => true, () => false)) return undefined;

    if (dirname(folder) === folder) return undefined;
  }
}

/** Whether git would take `folder` for a git folder: a HEAD file (or old-style symbolic link) next to objects/ and refs/. */
async function isGitDir(folder: string): Promise<boolean> {
  const head = await lstat(join(folder, "HEAD")).catch(() => undefined);

  if (!head || !(head.isFile() || head.isSymbolicLink())) return false;

  // objects/ and refs/ may be symbolic links to folders, as in repo-tool checkouts.
  const [objects, refs] = await Promise.all(["objects", "refs"].map((name) => stat(join(folder, name)).catch(() => undefined)));

  return Boolean(objects?.isDirectory() && refs?.isDirectory());
}

/** How messages name `folder`, which holds the file at `absolutePath`: as a workspace path like `displayPath` if it is one. */
function displayFolder(folder: string, absolutePath: string, displayPath: string): string {
  if (folder === absolutePath) return displayPath;

  const below = relative(folder, absolutePath).split(sep).join("/");

  return displayPath.endsWith(`/${below}`) ? displayPath.slice(0, -below.length - 1) : folder;
}

/**
 * Refuse a path the model asked for when one of its parts is .git, before symlinks are resolved: a .git that is a
 * symbolic link resolves to a name refuseGitPath no longer sees, and when it points to a folder that is not (yet) a
 * git folder, writing its config, HEAD, objects and refs would make it one.
 */
export function refuseGitRequest(requested: string): void {
  if (requested.split(/[\\/]/).some(isGitName)) {
    throw new Error(
      `Refusing to write ${requested}: it is inside a .git folder, whose config and hooks can make git run commands. Use git commands through bash instead.`,
    );
  }
}

function isGitName(segment: string): boolean {
  // Windows ignores trailing dots and spaces in names, so ".git." names .git there.
  const name = process.platform === "win32" ? segment.replace(/[. ]+$/, "") : segment;

  return name.toLowerCase() === ".git";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;

  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) count++;

  return count;
}

/** Changed-line counts for one replacement, ignoring unchanged leading/trailing lines. */
function lineChangeStats(oldText: string, newText: string): { added: number; removed: number } {
  const before = oldText.split("\n");
  const after = newText.split("\n");
  let head = 0;

  while (head < before.length && head < after.length && before[head] === after[head]) head++;

  let tail = 0;

  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;

  return { added: after.length - head - tail, removed: before.length - head - tail };
}

const fileLocks = new Map<string, Promise<unknown>>();

/** Serialize writes to the same file: hosts may send several edits in parallel. */
export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  const run = previous.then(operation);
  const settled = run.catch(() => undefined);
  fileLocks.set(path, settled);

  try {
    return await run;
  } finally {
    if (fileLocks.get(path) === settled) fileLocks.delete(path);
  }
}
