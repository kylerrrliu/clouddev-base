import { compileWildmatch, type Matcher } from "./glob-match.ts";

/**
 * Git compares ignore patterns case-insensitively when core.ignorecase is set,
 * which `git init` does on case-insensitive file systems. The repository's own
 * config is untrusted input and is not read, so this follows the platform.
 */
export const IGNORE_CASE = process.platform === "darwin" || process.platform === "win32";

export interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  /** The pattern has no "/", so it matches a name at any depth below the file. */
  nameOnly: boolean;
  matches: Matcher;
}

export interface IgnoreFile {
  /** The folder holding the file, relative to the repository root ("" for the root). */
  base: string;
  rules: IgnoreRule[];
}

/**
 * Parse a .gitignore (or info/exclude, or global excludes) file as Git does:
 * "#" comments, "!" negation, a trailing "/" for folders only, "\" escapes and
 * unescaped trailing spaces trimmed. A pattern containing "/" is anchored to
 * `base`; one without matches names at any depth. With `caseFold`, `base` and
 * the paths later given to isIgnored must be lower-cased.
 */
export function parseIgnoreFile(text: string, base = "", caseFold = IGNORE_CASE): IgnoreFile {
  const rules: IgnoreRule[] = [];

  for (let line of text.replace(/^﻿/, "").split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "" || line.startsWith("#")) continue;

    line = trimTrailingSpaces(line);

    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);

    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);

    if (line === "") continue;

    const nameOnly = !line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);

    rules.push({ negated, dirOnly, nameOnly, matches: compileWildmatch(line, caseFold) });
  }

  return { base, rules };
}

/** Git keeps a trailing space only when it is escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let spaceFrom = -1;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === " ") {
      if (spaceFrom === -1) spaceFrom = i;
    } else {
      if (char === "\\" && ++i === line.length) return line;
      spaceFrom = -1;
    }
  }

  return spaceFrom === -1 ? line : line.slice(0, spaceFrom);
}

/**
 * Decide whether a file or folder is ignored. `files` run from lowest to highest
 * precedence (global excludes, info/exclude, then .gitignore files from the
 * repository root down); within a file the last matching line wins. `path` is
 * relative to the repository root and lies below every file's base; `name` is
 * its last segment. Lower-case both when the rules were parsed with caseFold.
 */
export function isIgnored(files: readonly IgnoreFile[], path: string, name: string, isDir: boolean): boolean {
  for (let f = files.length - 1; f >= 0; f--) {
    const file = files[f]!;
    let relative: string | undefined;

    for (let r = file.rules.length - 1; r >= 0; r--) {
      const rule = file.rules[r]!;

      if (rule.dirOnly && !isDir) continue;

      const subject = rule.nameOnly ? name : (relative ??= file.base === "" ? path : path.slice(file.base.length + 1));

      if (rule.matches(subject)) return !rule.negated;
    }
  }

  return false;
}

/**
 * Read one value from Git config text, for example ("core", "excludesfile").
 * Handles sections, comments, quotes and escapes; includes are not followed.
 * The last assignment wins.
 */
export function configValue(text: string, section: string, key: string): string | undefined {
  let current = "";
  let value: string | undefined;

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();

    if (line.startsWith("[")) {
      const end = line.indexOf("]");
      if (end === -1) continue;

      // Subsections keep their quotes, so [core "x"] never equals "core".
      current = line.slice(1, end).trim().toLowerCase();
      line = line.slice(end + 1).trim();
    }

    if (current !== section || line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue; // a bare key is a boolean, never a path

    if (line.slice(0, equals).trim().toLowerCase() === key) value = unquote(line.slice(equals + 1));
  }

  return value;
}

function unquote(raw: string): string {
  const text = raw.trimStart();
  let value = "";
  let quoted = false;
  let trailingSpace = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (char === "\"") {
      quoted = !quoted;
      trailingSpace = 0;
    } else if (char === "\\" && i + 1 < text.length) {
      const next = text[++i]!;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next;
      trailingSpace = 0;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      value += char;
      trailingSpace = !quoted && (char === " " || char === "\t") ? trailingSpace + 1 : 0;
    }
  }

  return value.slice(0, value.length - trailingSpace);
}
