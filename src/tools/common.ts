export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

/** Output limits shared by read and bash, so one tool call never floods the context. */
export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

/**
 * Most characters in one text result, notes included. Claude Code stores a tool result longer than 50,000
 * characters in a file on its own computer and shows the model only a short preview of it; in client/ the model
 * cannot open that file (Read and Bash are denied there). Characters are UTF-16 code units: that is how
 * JavaScript, and Claude Code, count the length of a string. MAX_BYTES still applies as well, which keeps
 * results in CJK scripts (3 bytes a character) from taking far more tokens.
 */
export const MAX_RESULT_CHARS = 45_000;

/**
 * Most characters in an error result. Claude Code keeps only the first and last 5,000 characters of an error
 * result longer than about 11,000, so a longer one is cut here instead, where the cut can keep what matters.
 */
export const MAX_ERROR_RESULT_CHARS = 9_500;

/** What takeHead and takeTail may fill by default, leaving room for the notes a tool adds around the content. */
export const MAX_CONTENT_CHARS = MAX_RESULT_CHARS - 1_000;

/** How much of its beginning an over-long error result keeps; the rest of the budget goes to its end. */
const ERROR_HEAD_CHARS = 2_000;

/**
 * A text result. As a last resort it is cut to MAX_RESULT_CHARS (MAX_ERROR_RESULT_CHARS for errors), with a note
 * saying so; tools are expected to fit their output themselves, where they can choose what to keep.
 */
export function textResult(text: string, isError = false): ToolResult {
  const fitted = fitResultText(text, isError);

  return isError ? { content: [{ type: "text", text: fitted }], isError } : { content: [{ type: "text", text: fitted }] };
}

function fitResultText(text: string, isError: boolean): string {
  const limit = isError ? MAX_ERROR_RESULT_CHARS : MAX_RESULT_CHARS;

  if (text.length <= limit) return text;

  if (!isError) {
    const note = `[Result cut to its first ${limit.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters.]\n`;

    return note + clipStart(text, limit - note.length);
  }

  const head = clipStart(text, ERROR_HEAD_CHARS);
  // The marker's length depends on the omitted count, which depends on the tail: reserve generously for it.
  const tail = clipEnd(text, limit - head.length - 80);
  const omitted = text.length - head.length - tail.length;

  return `${head}\n[… ${omitted.toLocaleString("en-US")} characters omitted …]\n${tail}`;
}

/**
 * The beginning of `text`: at most `maxChars` UTF-16 code units and `maxBytes` UTF-8 bytes, cut between code
 * points, so the result never ends in half of a surrogate pair.
 */
export function clipStart(text: string, maxChars: number, maxBytes = Number.POSITIVE_INFINITY): string {
  if (text.length <= maxChars && (maxBytes === Number.POSITIVE_INFINITY || Buffer.byteLength(text) <= maxBytes)) return text;

  let chars = 0;
  let bytes = 0;
  let end = 0;

  for (const codePoint of text) {
    const size = utf8Size(codePoint);

    if (chars + codePoint.length > maxChars || bytes + size > maxBytes) break;

    chars += codePoint.length;
    bytes += size;
    end += codePoint.length;
  }

  return text.slice(0, end);
}

/**
 * The end of `text`: at most `maxChars` UTF-16 code units and `maxBytes` UTF-8 bytes, cut between code points,
 * so the result never starts with half of a surrogate pair.
 */
export function clipEnd(text: string, maxChars: number, maxBytes = Number.POSITIVE_INFINITY): string {
  if (text.length <= maxChars && (maxBytes === Number.POSITIVE_INFINITY || Buffer.byteLength(text) <= maxBytes)) return text;

  let chars = 0;
  let bytes = 0;
  let start = text.length;

  while (start > 0) {
    const low = text.charCodeAt(start - 1);
    const pair = start >= 2 && isLowSurrogate(low) && isHighSurrogate(text.charCodeAt(start - 2));
    const length = pair ? 2 : 1;
    const size = pair ? 4 : utf8Size(text[start - 1]!);

    if (chars + length > maxChars || bytes + size > maxBytes) break;

    chars += length;
    bytes += size;
    start -= length;
  }

  return text.slice(start);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 size of one code point (a lone surrogate is written as U+FFFD, 3 bytes). */
function utf8Size(codePoint: string): number {
  const code = codePoint.codePointAt(0)!;

  if (code < 0x80) return 1;

  if (code < 0x800) return 2;

  return code > 0xffff ? 4 : 3;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Split text into lines without a phantom empty line after a trailing newline. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);

  if (lines.at(-1) === "") lines.pop();

  return lines;
}

/** Keep whole lines from the start until the line, byte or character limit is reached. */
export function takeHead(
  lines: string[],
  maxLines = MAX_LINES,
  maxBytes = MAX_BYTES,
  maxChars = MAX_CONTENT_CHARS,
): { lines: string[]; truncated: boolean } {
  let bytes = 0;
  let chars = 0;

  for (let i = 0; i < lines.length; i++) {
    bytes += Buffer.byteLength(lines[i]!) + 1;
    chars += lines[i]!.length + 1;

    if (i >= maxLines || bytes > maxBytes || chars > maxChars) return { lines: lines.slice(0, i), truncated: true };
  }

  return { lines, truncated: false };
}

/** Keep whole lines from the end until the line, byte or character limit is reached. */
export function takeTail(
  lines: string[],
  maxLines = MAX_LINES,
  maxBytes = MAX_BYTES,
  maxChars = MAX_CONTENT_CHARS,
): { lines: string[]; truncated: boolean } {
  let bytes = 0;
  let chars = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const kept = lines.length - 1 - i;
    bytes += Buffer.byteLength(lines[i]!) + 1;
    chars += lines[i]!.length + 1;

    if (kept >= maxLines || bytes > maxBytes || chars > maxChars) return { lines: lines.slice(i + 1), truncated: true };
  }

  return { lines, truncated: false };
}

/**
 * A workspace path as one word of a bash command (bash runs in the workspace root, which display paths are relative
 * to): quoted when it needs to be, and never taken for an option.
 */
export function shellWord(path: string): string {
  const word = path.startsWith("-") ? `./${path}` : path;

  return /^[\w./@%+=:,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** Heuristic used by git and ripgrep: a NUL byte near the start means binary. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** read refuses text files bigger than this (grep and the read note for big files point here too). */
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;

const UTF16LE = new TextDecoder("utf-16le");
const UTF16BE = new TextDecoder("utf-16be");

export type Utf16ByteOrder = "utf-16le" | "utf-16be";

/** The UTF-16 byte order announced by a byte-order mark at the start of `data`. FF FE 00 00 is UTF-32LE's mark and does not count. */
export function utf16ByteOrder(data: Buffer): Utf16ByteOrder | undefined {
  if (data[0] === 0xff && data[1] === 0xfe && !(data[2] === 0 && data[3] === 0)) return "utf-16le";

  if (data[0] === 0xfe && data[1] === 0xff) return "utf-16be";

  return undefined;
}

/**
 * The iconv command that turns a UTF-16 file of this byte order into UTF-8, which grep, sed and cut in bash work on.
 * It names the byte order: macOS's iconv, given only "UTF-16", can go on reading a little-endian file as big-endian,
 * without an error, after a character beyond U+FFFF (an emoji) that falls on the end of a block it reads. The output
 * then starts with the byte-order mark in UTF-8: 3 bytes (EF BB BF) before line 1, which add no line.
 */
export function iconvFromUtf16(byteOrder: Utf16ByteOrder): string {
  return `iconv -f ${byteOrder === "utf-16le" ? "UTF-16LE" : "UTF-16BE"} -t UTF-8`;
}

/**
 * A file's text: UTF-16 when it starts with a byte-order mark (Windows tools write such files, and their NUL bytes
 * would make them look binary), else UTF-8. The byte-order mark is never part of the text, so a pattern anchored
 * with ^ still matches line 1. Undefined for a binary file: one with a NUL byte near the start.
 */
export function decodeText(data: Buffer): string | undefined {
  const utf16 = utf16ByteOrder(data);

  // The UTF-16 decoders drop the mark themselves.
  if (utf16) return (utf16 === "utf-16le" ? UTF16LE : UTF16BE).decode(data);

  if (looksBinary(data)) return undefined;

  const text = data.toString("utf8");

  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
