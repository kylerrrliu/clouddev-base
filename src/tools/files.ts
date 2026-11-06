import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import {
  MAX_BYTES,
  formatSize,
  looksBinary,
  splitLines,
  takeHead,
  textResult,
  type ToolResult,
} from "./common.ts";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;

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
  const stats = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`File not found: ${displayPath}`);
    throw error;
  });

  if (stats.isDirectory()) return textResult(await listDirectory(absolutePath, displayPath));

  const mimeType = IMAGE_TYPES[extname(absolutePath).toLowerCase()];

  if (mimeType) {
    if (stats.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image is too large to return (${formatSize(stats.size)}, limit ${formatSize(MAX_IMAGE_BYTES)}).`);
    }

    const data = (await readFile(absolutePath)).toString("base64");

    return {
      content: [
        { type: "text", text: `Image ${displayPath} (${mimeType}, ${formatSize(stats.size)})` },
        { type: "image", data, mimeType },
      ],
    };
  }

  if (stats.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(
      `${displayPath} is ${formatSize(stats.size)}, too large to read at once. Use bash (head, tail, sed -n, grep) to inspect parts of it.`,
    );
  }

  const buffer = await readFile(absolutePath);

  if (looksBinary(buffer)) {
    return textResult(`${displayPath} looks like a binary file (${formatSize(buffer.length)}); its content is not shown.`);
  }

  const strict = decodeUtf8(buffer);

  // Still show non-UTF-8 text (lossily), but say so: edit will refuse to touch it.
  const notice = strict === undefined
    ? `[Note: ${displayPath} is not valid UTF-8 (it may use another encoding such as GBK or Latin-1). Characters that are not UTF-8 are shown as replacement characters, and edit will refuse to change this file.]\n\n`
    : "";

  const text = (strict ?? buffer.toString("utf8"));
  const lines = splitLines(text.startsWith(BOM) ? text.slice(1) : text);

  if (lines.length === 0) return textResult(`(${displayPath} is empty)`);

  const start = (offset ?? 1) - 1;

  if (start >= lines.length) {
    throw new Error(`Offset ${offset} is beyond the end of ${displayPath} (${lines.length} lines).`);
  }

  const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
  const head = takeHead(lines.slice(start, end));

  if (head.lines.length === 0) {
    // A single line is bigger than the whole output budget (minified code, data blobs).
    const line = lines[start]!;

    return textResult(
      `${notice}${line.slice(0, MAX_BYTES)}\n\n[Line ${start + 1} is ${formatSize(Buffer.byteLength(line))}; only its beginning is shown. Use bash to inspect it.]`,
    );
  }

  const lastShown = start + head.lines.length;
  let body = head.lines.join("\n");

  if (head.truncated) {
    body += `\n\n[Showing lines ${start + 1}-${lastShown} of ${lines.length}. Use offset=${lastShown + 1} to continue.]`;
  } else if (end < lines.length) {
    body += `\n\n[${lines.length - end} more lines in the file. Use offset=${end + 1} to continue.]`;
  }

  return textResult(notice + body);
}

export async function listDirectory(absolutePath: string, displayPath: string): Promise<string> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const names = entries
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

  const more = entries.length > MAX_DIRECTORY_ENTRIES
    ? `\n[${entries.length - MAX_DIRECTORY_ENTRIES} more entries not shown. Use glob or bash to narrow down.]`
    : "";

  if (names.length === 0) return `Directory ${displayPath} is empty.`;

  return `Directory ${displayPath} (${entries.length} entries):\n${names.join("\n")}${more}`;
}

export async function writePath(absolutePath: string, displayPath: string, content: string): Promise<ToolResult> {
  return withFileLock(absolutePath, async () => {
    const existing = await stat(absolutePath).catch(() => undefined);

    if (existing?.isDirectory()) throw new Error(`${displayPath} is a directory.`);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");

    return textResult(`${existing ? "Overwrote" : "Created"} ${displayPath} (${formatSize(Buffer.byteLength(content))}).`);
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
  return withFileLock(absolutePath, async () => {
    const buffer = await readFile(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`File not found: ${displayPath}. Use write to create a new file.`);
      throw error;
    });

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

    await writeFile(absolutePath, bom + (crlf ? result.replace(/\n/g, "\r\n") : result), "utf8");

    let added = 0;
    let removed = 0;

    for (const replacement of replacements) {
      const stats = lineChangeStats(replacement.oldText, replacement.newText);
      added += stats.added;
      removed += stats.removed;
    }

    return textResult(`Edited ${displayPath} (+${added} -${removed} lines).`);
  });
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
