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

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
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

/** Keep whole lines from the start until the line or byte limit is reached. */
export function takeHead(lines: string[], maxLines = MAX_LINES, maxBytes = MAX_BYTES): { lines: string[]; truncated: boolean } {
  let bytes = 0;

  for (let i = 0; i < lines.length; i++) {
    bytes += Buffer.byteLength(lines[i]!) + 1;

    if (i >= maxLines || bytes > maxBytes) return { lines: lines.slice(0, i), truncated: true };
  }

  return { lines, truncated: false };
}

/** Keep whole lines from the end until the line or byte limit is reached. */
export function takeTail(lines: string[], maxLines = MAX_LINES, maxBytes = MAX_BYTES): { lines: string[]; truncated: boolean } {
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const kept = lines.length - 1 - i;
    bytes += Buffer.byteLength(lines[i]!) + 1;

    if (kept >= maxLines || bytes > maxBytes) return { lines: lines.slice(i + 1), truncated: true };
  }

  return { lines, truncated: false };
}

/** Heuristic used by git and ripgrep: a NUL byte near the start means binary. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}
