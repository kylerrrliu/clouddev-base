/**
 * Glob matching that cannot backtrack.
 *
 * Translating a glob into a RegExp lets the engine backtrack: "*a*a*a*a*a*b"
 * against a long file name takes seconds. Here a pattern is compiled into a
 * small NFA that is run one character at a time over the set of live states,
 * so a match costs at most (text length × pattern length) steps whatever the
 * pattern. Common shapes such as "name", "*.ts" or "src/**" take plain string
 * checks instead.
 *
 * Two dialects share the engine:
 * - compileGlob: the patterns the glob and grep tools accept.
 * - compileWildmatch: .gitignore patterns, following Git's wildmatch rules.
 */

export type Matcher = (text: string) => boolean;

type CharTest = (code: number) => boolean;

type Token =
  | { kind: "char"; code: number } // one literal character
  | { kind: "one" } // "?": one character other than "/"
  | { kind: "set"; test: CharTest } // "[...]": one character from a set, never "/"
  | { kind: "star" } // "*": any run of characters without "/"
  | { kind: "any" } // "**": any run of characters, "/" included
  | { kind: "dirs" } // "**/": nothing, or any run that ends in "/"
  | { kind: "alt"; options: Token[][] } // "{a,b}"
  | { kind: "never" }; // a malformed pattern, which matches nothing

const SLASH = 47;
const ONE: Token = { kind: "one" };
const STAR: Token = { kind: "star" };
const ANY: Token = { kind: "any" };
const DIRS: Token = { kind: "dirs" };
const NEVER: Token = { kind: "never" };

/**
 * Compile a glob for the glob and grep tools. Supports `*`, `**`, `?`, `[abc]`,
 * `[!abc]` and `{a,b}`. A pattern without "/" is matched against the file name
 * only, so `*.ts` finds TypeScript files at any depth.
 */
export function compileGlob(pattern: string): Matcher {
  const normalized = pattern.trim().replace(/^\.\//, "");
  const matches = compileTokens(parseGlob(normalized));

  if (normalized.includes("/")) return matches;

  return (path) => matches(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * Compile one .gitignore pattern (already stripped of its "!" and trailing "/")
 * the way Git's wildmatch does with WM_PATHNAME: "*", "?" and "[...]" never
 * match "/", "**" spans folders only as a whole path segment, and "\" escapes
 * the next character. With `caseFold` the matcher expects lower-cased text.
 */
export function compileWildmatch(pattern: string, caseFold = false): Matcher {
  return compileTokens(parseWildmatch(caseFold ? pattern.toLowerCase() : pattern, caseFold));
}

function parseGlob(pattern: string): Token[] {
  const tokens: Token[] = [];
  // Past these, "{" and "[" have no closing partner; checking first keeps parsing linear.
  const lastBrace = pattern.lastIndexOf("}");
  const lastBracket = pattern.lastIndexOf("]");

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const segmentStart = i === 0 || pattern[i - 1] === "/";
        i++;

        if (segmentStart && pattern[i + 1] === "/") {
          tokens.push(DIRS); // "**/" matches zero or more folders
          i++;
        } else {
          tokens.push(ANY);
        }
      } else {
        tokens.push(STAR);
      }
    } else if (char === "?") {
      tokens.push(ONE);
    } else if (char === "{" && lastBrace > i) {
      const close = pattern.indexOf("}", i);
      tokens.push({ kind: "alt", options: pattern.slice(i + 1, close).split(",").map(parseGlob) });
      i = close;
    } else if (char === "[" && lastBracket >= i + 2) {
      const close = pattern.indexOf("]", i + 2);
      tokens.push({ kind: "set", test: globSet(pattern.slice(i + 1, close)) });
      i = close;
    } else {
      tokens.push({ kind: "char", code: pattern.charCodeAt(i) });
    }
  }

  return tokens;
}

/** "[...]" in a tool glob: "!" or "^" negates, "a-z" is a range, everything else is literal. */
function globSet(body: string): CharTest {
  const negated = body[0] === "!" || body[0] === "^";
  const ranges: number[] = [];

  for (let i = negated ? 1 : 0; i < body.length; i++) {
    const low = body.charCodeAt(i);

    if (body[i + 1] === "-" && i + 2 < body.length) {
      ranges.push(low, body.charCodeAt(i + 2));
      i += 2;
    } else {
      ranges.push(low, low);
    }
  }

  return charSet(ranges, [], negated);
}

function parseWildmatch(pattern: string, caseFold: boolean): Token[] {
  const tokens: Token[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;

    if (char === "\\") {
      if (++i === pattern.length) return [NEVER]; // a trailing backslash never matches
      tokens.push({ kind: "char", code: pattern.charCodeAt(i) });
    } else if (char === "?") {
      tokens.push(ONE);
    } else if (char === "*") {
      let last = i;
      while (pattern[last + 1] === "*") last++;

      const wholeSegment = last > i && (i === 0 || pattern[i - 1] === "/")
        && (last + 1 === pattern.length || pattern[last + 1] === "/");

      if (!wholeSegment) {
        tokens.push(STAR); // "**" inside a segment is just "*"
      } else if (last + 1 === pattern.length) {
        tokens.push(ANY); // trailing "/**": everything inside
      } else {
        tokens.push(DIRS); // leading "**/" or inner "/**/": zero or more folders
        last++;
      }

      i = last;
    } else if (char === "[") {
      const set = wildmatchSet(pattern, i, caseFold);
      if (!set) return [NEVER]; // unterminated, or an unknown [:class:]: Git matches nothing
      tokens.push({ kind: "set", test: set.test });
      i = set.close;
    } else {
      tokens.push({ kind: "char", code: pattern.charCodeAt(i) });
    }
  }

  return tokens;
}

const POSIX_CLASSES = new Map<string, CharTest>([
  ["alnum", (c) => isDigit(c) || isAlpha(c)],
  ["alpha", isAlpha],
  ["blank", (c) => c === 32 || c === 9],
  ["cntrl", (c) => c < 32 || c === 127],
  ["digit", isDigit],
  ["graph", (c) => c > 32 && c < 127],
  ["lower", (c) => c >= 97 && c <= 122],
  ["print", (c) => c >= 32 && c < 127],
  ["punct", (c) => (c > 32 && c < 48) || (c > 57 && c < 65) || (c > 90 && c < 97) || (c > 122 && c < 127)],
  ["space", (c) => c === 32 || (c >= 9 && c <= 13)],
  ["upper", (c) => c >= 65 && c <= 90],
  ["xdigit", (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)],
]);

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Parse "[...]" at `open` like wildmatch.c: "!" or "^" negates, "]" first is literal, "\" escapes. */
function wildmatchSet(pattern: string, open: number, caseFold: boolean): { test: CharTest; close: number } | undefined {
  let i = open + 1;
  const negated = pattern[i] === "!" || pattern[i] === "^";
  if (negated) i++;

  const ranges: number[] = [];
  const classes: CharTest[] = [];
  let previous = -1; // the last single character, which may start a range
  let first = true;
  let nextBracket = -1; // cached position of the next "]", so "[:" lookups stay linear

  for (;; i++) {
    if (i >= pattern.length) return undefined;

    const char = pattern[i]!;

    if (char === "]" && !first) break;
    first = false;

    if (char === "\\") {
      if (++i >= pattern.length) return undefined;
      previous = pattern.charCodeAt(i);
      ranges.push(previous, previous);
    } else if (char === "-" && previous !== -1 && i + 1 < pattern.length && pattern[i + 1] !== "]") {
      i++;
      if (pattern[i] === "\\" && ++i >= pattern.length) return undefined;
      ranges.push(previous, pattern.charCodeAt(i));
      previous = -1;
    } else if (char === "[" && pattern[i + 1] === ":") {
      if (nextBracket < i + 2) nextBracket = pattern.indexOf("]", i + 2);
      const end = nextBracket;
      if (end === -1) return undefined;

      if (end - 1 < i + 2 || pattern[end - 1] !== ":") {
        previous = 91; // not "[:name:]", just a literal "["
        ranges.push(91, 91);
        continue;
      }

      const name = pattern.slice(i + 2, end - 1);
      const test = POSIX_CLASSES.get(name);
      if (!test) return undefined;

      // Matching text that was lower-cased, "upper" and "lower" both mean letters.
      classes.push(caseFold && (name === "upper" || name === "lower") ? isAlpha : test);
      previous = -1;
      i = end;
    } else {
      previous = pattern.charCodeAt(i);
      ranges.push(previous, previous);
    }
  }

  return { test: charSet(ranges, classes, negated), close: i };
}

/** A character set from inclusive [low, high] pairs and class tests. It never matches "/". */
function charSet(ranges: number[], classes: CharTest[], negated: boolean): CharTest {
  const inSet = (code: number): boolean => {
    for (let k = 0; k < ranges.length; k += 2) {
      if (code >= ranges[k]! && code <= ranges[k + 1]!) return true;
    }

    return classes.some((test) => test(code));
  };

  const ascii = new Uint8Array(128);
  for (let code = 0; code < 128; code++) ascii[code] = code !== SLASH && inSet(code) !== negated ? 1 : 0;

  return (code) => (code < 128 ? ascii[code] === 1 : inSet(code) !== negated);
}

/** Peel literal text off both ends, then use a string check for simple shapes or the NFA. */
function compileTokens(tokens: Token[]): Matcher {
  if (tokens.some((token) => token.kind === "never")) return () => false;

  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start]!.kind === "char") start++;
  while (end > start && tokens[end - 1]!.kind === "char") end--;

  const prefix = literalText(tokens.slice(0, start));
  const suffix = literalText(tokens.slice(end));
  const middle = compileMiddle(tokens.slice(start, end));

  if (prefix === "" && suffix === "") return middle;

  const fixedLength = prefix.length + suffix.length;

  return (text) => text.length >= fixedLength
    && text.startsWith(prefix)
    && text.endsWith(suffix)
    && middle(text.slice(prefix.length, text.length - suffix.length));
}

function literalText(tokens: Token[]): string {
  return tokens.map((token) => String.fromCharCode((token as { code: number }).code)).join("");
}

function compileMiddle(tokens: Token[]): Matcher {
  switch (tokens.map((token) => token.kind).join(" ")) {
    case "":
      return (text) => text === "";
    case "star":
      return (text) => !text.includes("/");
    case "any":
    case "dirs star":
      return () => true;
    case "dirs":
      return (text) => text === "" || text.endsWith("/");
  }

  // "*abc*": literal text somewhere in a single path segment.
  const inner = tokens.slice(1, -1);

  if (tokens.length > 2 && tokens[0]!.kind === "star" && tokens.at(-1)!.kind === "star" && inner.every((token) => token.kind === "char")) {
    const text = literalText(inner);
    if (!text.includes("/")) return (path) => !path.includes("/") && path.includes(text);
  }

  return compileNfa(tokens);
}

// NFA state kinds.
const STEP = 0; // consumes one character that passes the state's test
const SPLIT = 1; // epsilon move to both `out` and `alt`
const ACCEPT = 2;
const DEAD = 3;

// Character tests for STEP states.
const IS_CODE = 0;
const NOT_SLASH = 1;
const ANY_CHAR = 2;
const IN_SET = 3;

function compileNfa(tokens: Token[]): Matcher {
  const kinds: number[] = [];
  const tests: number[] = [];
  const args: number[] = [];
  const outs: number[] = [];
  const alts: number[] = [];
  const sets: CharTest[] = [];

  const state = (kind: number, test: number, arg: number, out: number, alt: number): number => {
    kinds.push(kind);
    tests.push(test);
    args.push(arg);
    outs.push(out);
    alts.push(alt);

    return kinds.length - 1;
  };

  // A loop over `test`, then on to `next`.
  const repeat = (test: number, next: number): number => {
    const split = state(SPLIT, 0, 0, -1, next);
    outs[split] = state(STEP, test, 0, split, -1);

    return split;
  };

  // Build backwards from the continuation, so every state knows where it leads.
  const build = (list: Token[], next: number): number => {
    for (let i = list.length - 1; i >= 0; i--) {
      const token = list[i]!;

      switch (token.kind) {
        case "char":
          next = state(STEP, IS_CODE, token.code, next, -1);
          break;
        case "one":
          next = state(STEP, NOT_SLASH, 0, next, -1);
          break;
        case "set":
          next = state(STEP, IN_SET, sets.push(token.test) - 1, next, -1);
          break;
        case "star":
          next = repeat(NOT_SLASH, next);
          break;
        case "any":
          next = repeat(ANY_CHAR, next);
          break;
        case "dirs":
          next = state(SPLIT, 0, 0, repeat(ANY_CHAR, state(STEP, IS_CODE, SLASH, next, -1)), next);
          break;
        case "alt": {
          const starts = token.options.map((option) => build(option, next));
          let entry = starts.pop()!;
          while (starts.length > 0) entry = state(SPLIT, 0, 0, starts.pop()!, entry);
          next = entry;
          break;
        }
        case "never":
          next = state(DEAD, 0, 0, -1, -1);
          break;
      }
    }

    return next;
  };

  const accept = state(ACCEPT, 0, 0, -1, -1);
  const start = build(tokens, accept);

  const size = kinds.length;
  const kind = Uint8Array.from(kinds);
  const test = Uint8Array.from(tests);
  const arg = Int32Array.from(args);
  const out = Int32Array.from(outs);
  const alt = Int32Array.from(alts);
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let current = new Int32Array(size);
  let following = new Int32Array(size);
  let stamp = 0;

  // Add `from` and every state reachable from it through splits to `list`.
  const close = (from: number, list: Int32Array, length: number): number => {
    let top = 0;

    if (seen[from] !== stamp) {
      seen[from] = stamp;
      stack[top++] = from;
    }

    while (top > 0) {
      const s = stack[--top]!;

      if (kind[s] === SPLIT) {
        const a = out[s]!;
        const b = alt[s]!;

        if (seen[a] !== stamp) {
          seen[a] = stamp;
          stack[top++] = a;
        }

        if (seen[b] !== stamp) {
          seen[b] = stamp;
          stack[top++] = b;
        }
      } else {
        list[length++] = s;
      }
    }

    return length;
  };

  return (text) => {
    if (stamp > 0x3fff_ffff - text.length) {
      seen.fill(0);
      stamp = 0;
    }

    stamp++;
    let length = close(start, current, 0);

    for (let i = 0; i < text.length && length > 0; i++) {
      const code = text.charCodeAt(i);
      let nextLength = 0;
      stamp++;

      for (let k = 0; k < length; k++) {
        const s = current[k]!;

        if (kind[s] !== STEP) continue;

        const t = test[s];
        const passes = t === IS_CODE ? code === arg[s]
          : t === NOT_SLASH ? code !== SLASH
          : t === ANY_CHAR || sets[arg[s]!]!(code);

        if (passes) nextLength = close(out[s]!, following, nextLength);
      }

      const swap = current;
      current = following;
      following = swap;
      length = nextLength;
    }

    for (let k = 0; k < length; k++) {
      if (kind[current[k]!] === ACCEPT) return true;
    }

    return false;
  };
}
