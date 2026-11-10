import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_BYTES,
  MAX_CONTENT_CHARS,
  MAX_ERROR_RESULT_CHARS,
  MAX_LINES,
  MAX_RESULT_CHARS,
  clipEnd,
  clipStart,
  splitLines,
  takeHead,
  takeTail,
  textResult,
  type ToolResult,
} from "./common.ts";

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 300;

/**
 * On a timeout or cancellation the command's process group gets SIGTERM, so programs can clean up (git removes
 * .git/index.lock, trap handlers run, test runners stop the helpers they started in groups of their own), and
 * SIGKILL if anything in it is still running this much later.
 */
export const TERM_GRACE_MS = 3_000;

/** Wait this long after the shell exits, or after its process group is stopped, for its output pipes to close. */
const EXIT_GRACE_MS = 250;

/**
 * The longest a bash call can take. It must stay below the client's timeout for a tool call (330 seconds in
 * client/.mcp.json), or the client gives up before the result arrives.
 */
export const MAX_CALL_MS = MAX_TIMEOUT_SECONDS * 1000 + TERM_GRACE_MS + EXIT_GRACE_MS;

/** How often the process group is checked during the TERM grace. */
const TERM_POLL_MS = 100;

/** Raw output kept in memory before the final truncation: roughly its last megabyte. */
const ROLLING_BUFFER_BYTES = 1024 * 1024;

/**
 * The rolling buffer drops the beginning of long output, so that is kept apart: in a failing build the first error
 * is often the cause of the rest.
 */
const HEAD_BUFFER_BYTES = 16 * 1024;

/**
 * A background process may keep writing to the output pipes after the result is returned. That output is read and
 * dropped for as long as it comes; only a flood, more than MAX_DISCARD_BYTES within DISCARD_WINDOW_MS, closes the
 * pipes. A runaway `yes &` gets there in moments instead of keeping a CPU core busy, while a dev server that logs a
 * few KB a second never does, however long it runs.
 */
export const MAX_DISCARD_BYTES = 16 * 1024 * 1024;
export const DISCARD_WINDOW_MS = 60_000;

/**
 * When the output does not fit the result as it is, a longer line (minified code, a JSON blob) keeps only its two
 * ends, half of this each. On success that is as many characters as read shows of an over-long line, so the next
 * part of one that read's bash command prints (cut -b) comes back whole even among other output, when it is ASCII;
 * but only when that shows as many lines as FAILURE_LINE_CHARS does, since a few long lines (inline scripts in an
 * HTML page, grep matches in minified bundles) would otherwise crowd out the many short ones around them. A
 * failure's budget is much smaller: its lines always get FAILURE_LINE_CHARS.
 */
export const SUCCESS_LINE_CHARS = 20_000;
export const FAILURE_LINE_CHARS = 2_000;

/** How long a line may be, in characters and in bytes, before it is cut to its two ends. */
interface LineLimit {
  chars: number;
  bytes: number;
}

/** A successful result reaches MAX_BYTES first in CJK text (3 bytes a character): a cut line keeps no more bytes than characters. */
const SUCCESS_LINE: LineLimit = { chars: SUCCESS_LINE_CHARS, bytes: SUCCESS_LINE_CHARS };
/** Short enough in characters that a cut line needs no byte limit: at 3 bytes a character it is well within MAX_BYTES. */
const FAILURE_LINE: LineLimit = { chars: FAILURE_LINE_CHARS, bytes: Number.POSITIVE_INFINITY };

/** A line is cut only when that leaves out more than this; a smaller cut would save next to nothing. */
const MIN_CUT_CHARS = 100;

/**
 * About how much of its beginning a long failed output keeps; its end gets the rest of MAX_ERROR_RESULT_CHARS. The
 * beginning gets the same share of MAX_LINES.
 */
const FAILURE_HEAD_CHARS = 2_000;
const FAILURE_HEAD_LINES = Math.floor((MAX_LINES * FAILURE_HEAD_CHARS) / MAX_ERROR_RESULT_CHARS);

/** Room kept for the notes on truncation and folded redraws, whose numbers are known only once the lines are chosen. */
const NOTE_ROOM = 400;

const MORE_HINT = "Redirect output to a file and read or grep it if you need more.";

const BACKGROUND_NOTE =
  "[A background process still holds this command's output. What it writes from now on is discarded; if it writes " +
  `more than ${MAX_DISCARD_BYTES / 1024 / 1024}MB within ${seconds(DISCARD_WINDOW_MS / 1000)}, its output is closed, ` +
  "which usually ends it. Redirect its output to a file to keep it: nohup cmd > out.log 2>&1 &]";

/**
 * Terminal escape sequences: CSI (colours, cursor movement, erasing), OSC (window titles, hyperlinks), the string
 * sequences (DCS, SOS, PM, APC) and the short ESC ones. Lines are split before this runs, so an unterminated
 * sequence ends with its line; an ESC that starts nothing known is removed alone.
 */
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])?/g;

/**
 * The process groups of the commands now running, or being stopped after a timeout or cancellation. Once bash has
 * exited by itself, what is left in its group was put in the background on purpose, and its group is not kept here.
 */
const runningGroups = new Set<number>();

/**
 * SIGKILL every command that is still running or being stopped, at once. It is for a server that ends before
 * stopGroup's grace is over (a second Ctrl+C, process.exit): whatever survived SIGTERM would otherwise run on,
 * orphaned. Synchronous, so it also works in an "exit" handler.
 */
export function killRunningCommandsNow(): void {
  for (const group of runningGroups) {
    // Never the case for a started child, but kill(-1) would signal every process the user owns.
    if (group <= 1) continue;

    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  // A group that is gone may get its number reused; it must not be signalled again.
  runningGroups.clear();
}

// For process.exit(), which does not wait for stopGroup's grace. A signal that finds no handler ends the process
// without an "exit" event, so a signal handler that ends the server has to call killRunningCommandsNow itself.
process.on("exit", killRunningCommandsNow);

/**
 * Run a command with bash in its own process group. `onOutput` receives the
 * combined output as it arrives (for the activity page); the result carries
 * only the part that fits, cleaned up the way a terminal would show it.
 */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  signal?: AbortSignal,
  onOutput?: (text: string) => void,
): Promise<ToolResult> {
  // Checked up front: a missing cwd otherwise surfaces as a confusing "spawn /bin/bash ENOENT".
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw new Error(`Working directory is not an existing folder: ${cwd}`);
  }

  const { file, args } = shellInvocation(command);
  const output = new OutputBuffer();

  const child = spawn(file, args, {
    cwd,
    env: commandEnvironment(),
    // Own process group, so a timeout can stop everything the command started.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stopCollecting = [collect(child.stdout, output, onOutput), collect(child.stderr, output, onOutput)];
  const run = await supervise(child, timeoutSeconds, signal);

  for (const stop of stopCollecting) stop();

  if (run.kind === "exited" && run.exit.error) {
    return textResult(`Failed to start the shell (${file}): ${run.exit.error.message}`, true);
  }

  const notes = keepDraining([child.stdout, child.stderr]) ? [BACKGROUND_NOTE] : [];
  const status = statusLine(run, timeoutSeconds);

  if (status === undefined) return textResult(successText(output.lines(), notes));

  return textResult(failureText(output.lines(), notes, status), true);
}

/** Server secrets that commands run for the AI must never see. */
const PRIVATE_ENV_VARS = ["CLOUDDEV_BASE_PASSWORD"];

const PROXY_ENV_VARS = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

/** This computer itself, where the servers Claude starts listen. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * The server's environment minus its own secrets. When it has a proxy, loopback goes into no_proxy and NO_PROXY:
 * curl, wget, git and test runners would otherwise send requests for this computer's own servers to the proxy, which
 * fail when the proxy is down or does not pass loopback, as if the server were not running.
 */
export function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  for (const name of PRIVATE_ENV_VARS) delete env[name];

  if (PROXY_ENV_VARS.some((name) => env[name]?.trim())) {
    // Some tools read the lowercase name first, others the uppercase one: each gets the entries of whichever is set.
    const lower = env.no_proxy?.trim() ? env.no_proxy : env.NO_PROXY;
    const upper = env.NO_PROXY?.trim() ? env.NO_PROXY : env.no_proxy;
    env.no_proxy = withLoopback(lower);
    env.NO_PROXY = withLoopback(upper);
  }

  return env;
}

/** A no_proxy list with the loopback hosts it lacks added at its end. */
function withLoopback(list = ""): string {
  const entries = list.split(",").map((entry) => entry.trim()).filter(Boolean);

  // "*" exempts every host already, and curl (like most tools) honours it only when it is the whole list.
  if (entries.length === 1 && entries[0] === "*") return list;

  const missing = LOOPBACK_HOSTS.filter((host) => !entries.some((entry) => entry.toLowerCase() === host));

  return [...entries, ...missing].join(",");
}

/** Feed a pipe into `output`, and its text to `onOutput`. Returns a function that stops collecting. */
function collect(stream: Readable | null, output: OutputBuffer, onOutput?: (text: string) => void): () => void {
  if (!stream) return () => {};

  // One decoder per stream, so a multi-byte character split across chunks stays intact.
  const decoder = new StringDecoder("utf8");

  const onData = (chunk: Buffer) => {
    output.push(chunk);

    if (!onOutput) return;

    const text = decoder.write(chunk);

    // An exception thrown inside a stream event would take the whole server down; showing output is best effort.
    try {
      if (text) onOutput(text);
    } catch {
      // Ignored.
    }
  };

  stream.on("data", onData);

  return () => stream.off("data", onData);
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const gitBash = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((dir): dir is string => Boolean(dir))
      .map((dir) => join(dir, "Git", "bin", "bash.exe"))
      .find((path) => existsSync(path));

    return { file: gitBash ?? "bash", args: ["-c", command] };
  }

  return { file: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c", command] };
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

type StopReason = "timeout" | "cancel";

/** How a run ended: the shell exited by itself, or a timeout or cancellation stopped it (`forced`: with SIGKILL). */
type Run = { kind: "exited"; exit: ExitInfo } | { kind: "stopped"; reason: StopReason; forced: boolean };

/**
 * Wait until the result can be decided. A command that ends by itself normally closes its output pipes as it
 * exits, but a background process (`cmd &`) can hold them open forever, so after the exit they get only
 * EXIT_GRACE_MS. A timeout or cancellation stops the whole process group first (see stopGroup), and output written
 * meanwhile is still collected.
 */
async function supervise(child: ChildProcess, timeoutSeconds: number, signal?: AbortSignal): Promise<Run> {
  let exit: ExitInfo | undefined;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, exitSignal) => {
      exit ??= { code, signal: exitSignal };
      resolve();
    });
    // Only a failed spawn (no pid) ends the run here. The listener stays, so a failed kill cannot crash the server.
    child.on("error", (error) => {
      if (child.pid !== undefined) return;
      exit ??= { code: null, signal: null, error };
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  let reason: StopReason | undefined;
  let stopRequested!: () => void;
  const stopping = new Promise<void>((resolve) => (stopRequested = resolve));
  const requestStop = (why: StopReason) => {
    reason ??= why;
    stopRequested();
  };

  const timer = setTimeout(() => requestStop("timeout"), timeoutSeconds * 1000);
  const onAbort = () => requestStop("cancel");

  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  // A failed spawn has no pid, and Windows no process groups (see stopGroup).
  const group = process.platform === "win32" ? undefined : child.pid;
  const untrack = () => group !== undefined && runningGroups.delete(group);

  if (group !== undefined) runningGroups.add(group);

  try {
    await Promise.race([exited, stopping]);
  } finally {
    // Once the shell has exited, a late timeout or cancellation must not kill what it left running on purpose.
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (exit?.error) return { kind: "exited", exit };

  if (reason === undefined) {
    // What is left in the group was put in the background on purpose: an abrupt exit of the server must not kill it.
    untrack();
    await settle(closed, EXIT_GRACE_MS);

    return { kind: "exited", exit: exit! };
  }

  try {
    const forced = await stopGroup(child, exited);
    await settle(closed, EXIT_GRACE_MS);

    return exit?.error ? { kind: "exited", exit } : { kind: "stopped", reason, forced };
  } finally {
    // The group is gone by now, or has been sent SIGKILL.
    untrack();
  }
}

/**
 * Stop the command's process group: SIGTERM, then SIGKILL TERM_GRACE_MS later if anything in the group is still
 * running, even when bash itself has already exited. Resolves once the group is gone (false) or SIGKILL has been
 * sent (true). Windows has no process groups: taskkill ends the process tree at once.
 */
async function stopGroup(child: ChildProcess, exited: Promise<void>): Promise<boolean> {
  const pid = child.pid;

  // Never the case for a started child, but kill(-1) would signal every process the user owns, and kill(-0) the
  // server's own process group.
  if (pid === undefined || pid <= 1) return false;

  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    await settle(exited, TERM_GRACE_MS);

    return true;
  }

  const deadline = performance.now() + TERM_GRACE_MS;

  for (let running = signalGroup(pid, "SIGTERM"); running; running = signalGroup(pid, 0)) {
    const left = deadline - performance.now();

    if (left <= 0) {
      signalGroup(pid, "SIGKILL");

      return true;
    }

    await delay(Math.min(TERM_POLL_MS, left));
  }

  return false;
}

/** Send `signal` (0 only checks) to the process group led by `pid`. Returns false when nothing is left in the group. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);

    return true;
  } catch (error) {
    // EPERM: the group still exists, but nothing in it may be signalled. On macOS that includes a group whose last
    // member is a zombie the server has not reaped yet; it is reaped within a moment.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wait for `promise`, but no longer than `ms`. */
async function settle(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * After the result is decided, a process the command left in the background (`cmd &` without redirection; macOS's
 * nohup redirects only a terminal) may still hold the output pipes. Closing them would kill it the next time it
 * writes (SIGPIPE, or EPIPE for a Node server), so they stay open: what arrives is read and dropped, and they no
 * longer keep the server running. Only a flood closes them after all: more than `maxBytes` within `windowMs`.
 * Returns whether any pipe was still open.
 */
export function keepDraining(streams: Array<Readable | null>, maxBytes = MAX_DISCARD_BYTES, windowMs = DISCARD_WINDOW_MS): boolean {
  const open = streams.filter((stream): stream is Readable => stream !== null && !stream.readableEnded && !stream.destroyed);

  if (open.length === 0) return false;

  let windowStart = performance.now();
  let discarded = 0;

  for (const stream of open) {
    stream.on("data", (chunk: Buffer) => {
      const now = performance.now();

      if (now - windowStart >= windowMs) {
        windowStart = now;
        discarded = 0;
      }

      discarded += chunk.length;

      if (discarded > maxBytes) for (const pipe of open) pipe.destroy();
    });
    // Nobody reads this output any more: a read error must not take the server down.
    stream.on("error", () => {});
    stream.resume();

    // Pipes from spawn() are sockets; unref lets the server exit while a background process holds one.
    if (stream instanceof Socket) stream.unref();
  }

  return true;
}

/** The last line of a failed command's result; undefined when the command succeeded. */
function statusLine(run: Run, timeoutSeconds: number): string | undefined {
  if (run.kind === "stopped") {
    const what = run.reason === "cancel" ? "Command was cancelled" : `Command timed out after ${seconds(timeoutSeconds)}`;

    // taskkill /F ends the tree at once.
    if (process.platform === "win32") return run.reason === "cancel" ? `${what}.` : `${what} and was killed.`;

    if (run.forced) return `${what}: sent SIGTERM, then SIGKILL ${seconds(TERM_GRACE_MS / 1000)} later.`;

    return `${what}: sent SIGTERM and it stopped.`;
  }

  const { code, signal } = run.exit;

  if (code === 0) return undefined;

  return code === null ? `Command was killed by signal ${signal}.` : `Command exited with code ${code}.`;
}

/** Every line is shown, but the middle or one end of a long line is missing; the line itself says which. */
const PART_OF_LINE_NOTE = `[Output truncated: part of a long line is left out. ${MORE_HINT}]`;

/**
 * A successful command's result: the end of its output, notes first. Long lines are cut only when the output does
 * not fit as it is: to SUCCESS_LINE when that shows as many lines as FAILURE_LINE does (one long JSON response, a
 * window taken with cut -c), else to FAILURE_LINE.
 */
function successText(printed: Printed, notes: string[]): string {
  const source = asShown(printed.tail?.lines ?? printed.head);
  const room = Math.min(MAX_CONTENT_CHARS, MAX_RESULT_CHARS - NOTE_ROOM - lengthOf(notes));
  const fit = (limit?: LineLimit) => takeTail(source.lines.map((line) => render(line, limit)), MAX_LINES, MAX_BYTES, room);
  const whole = fit();
  let shown = whole.lines;

  if (whole.truncated) {
    const long = fit(SUCCESS_LINE).lines;
    const short = fit(FAILURE_LINE).lines;
    shown = long.length < short.length ? short : long;
  }

  const top: string[] = [];

  if (shown.length < printed.total) {
    top.push(`[Output truncated: showing the last ${shown.length} of ${printed.total} lines. ${MORE_HINT}]`);
  } else if (source.lines.some(isCut)) {
    top.push(PART_OF_LINE_NOTE);
  }

  top.push(...foldNote(sum(source.folded, source.lines.length - shown.length)), ...notes);

  return assemble(top, shown.join("\n") || "(no output)");
}

/**
 * A failed command's result: notes first, the status line last, all within MAX_ERROR_RESULT_CHARS. Claude Code
 * keeps only the two ends of a longer error, and a failure's first error is often the cause of the rest, so long
 * output keeps its beginning as well as its end.
 */
function failureText(printed: Printed, notes: string[], status: string): string {
  const head = asShown(printed.head);

  if (!printed.tail) {
    const top = [...foldNote(sum(head.folded)), ...notes];
    const room = MAX_ERROR_RESULT_CHARS - lengthOf(top) - status.length - 2;

    // All of it when it fits: as it is, or else with its long lines cut.
    for (const limit of [undefined, FAILURE_LINE]) {
      const lines = head.lines.map((line) => render(line, limit));

      if (!takeHead(lines, MAX_LINES, MAX_BYTES, room).truncated) return assemble(top, lines.join("\n"), status);
    }
  }

  const room = MAX_ERROR_RESULT_CHARS - NOTE_ROOM - lengthOf(notes) - status.length - 2;
  const beginning = head.lines.map((line) => render(line, FAILURE_LINE));
  let first = takeHead(beginning, FAILURE_HEAD_LINES, MAX_BYTES, FAILURE_HEAD_CHARS).lines;

  // Long lines are cut to about FAILURE_LINE_CHARS, so the first one always fits in the whole budget.
  if (first.length === 0) first = beginning.slice(0, 1);

  // The rest: the rolling buffer's lines when the middle was dropped, else the lines after the beginning. The end
  // shares the limits with the beginning, so when the output is complete, some lines are always left out between them.
  const rest = printed.tail
    ? restAfter(printed.tail, first.length)
    : { ...sliceShown(head, first.length), start: first.length + 1 };
  const lines = rest.lines.map((line) => render(line, FAILURE_LINE));
  const last = takeTail(lines, MAX_LINES - first.length, MAX_BYTES - byteLengthOf(first), room - lengthOf(first)).lines;
  const omitted = rest.start + lines.length - last.length - 1 - first.length;
  const folds = foldNote(sum(head.folded, 0, first.length) + sum(rest.folded, lines.length - last.length));

  // Every line is shown: whatever is missing is inside a long line, and marked there.
  if (omitted === 0) {
    const cut = head.lines.slice(0, first.length).some(isCut) || rest.lines.some(isCut);

    return assemble([...(cut ? [PART_OF_LINE_NOTE] : []), ...folds, ...notes], [...first, ...last].join("\n"), status);
  }

  const shown = `showing the first ${first.length} and the last ${last.length} of ${printed.total} lines`;
  const top = [`[Output truncated: ${shown}; ${gapNote(omitted)}. ${MORE_HINT}]`, ...folds, ...notes];

  return assemble(top, [...first, `[… ${plural(omitted, "line")} left out …]`, ...last].join("\n"), status);
}

/**
 * The rolling buffer's lines after the first `shown` lines of the output. A line that both buffers kept part of is
 * shown once: in the beginning, when the beginning reaches it.
 */
function restAfter(tail: Tail, shown: number): Shown & { start: number } {
  const skip = Math.max(0, shown + 1 - tail.start);

  return { ...asShown(tail.lines.slice(skip)), start: tail.start + skip };
}

function sliceShown(shown: Shown, from: number): Shown {
  return { lines: shown.lines.slice(from), folded: shown.folded.slice(from) };
}

function gapNote(omitted: number): string {
  return omitted === 1 ? "the 1 line in between is left out" : `the ${omitted} lines in between are left out`;
}

/** Notes first, then the output, then (for a failure) the status line after a blank line. */
function assemble(notes: string[], body: string, status?: string): string {
  const text = [...notes, ...(body ? [body] : [])].join("\n");

  if (status === undefined) return text;

  return text ? `${text}\n\n${status}` : status;
}

/** Said once for the whole result, not per line. */
function foldNote(folded: number): string[] {
  if (folded === 0) return [];

  return [`[Folded ${plural(folded, "progress redraw")} (text rewritten with \\r): only the last state of each line is shown.]`];
}

/** Characters that `lines` take up, with a newline each (as takeHead and takeTail count them). */
function lengthOf(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

function byteLengthOf(lines: string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
}

function seconds(value: number): string {
  return plural(value, "second");
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function sum(values: number[], from = 0, to = values.length): number {
  let total = 0;

  for (let i = from; i < to; i++) total += values[i]!;

  return total;
}

/** Lines as a terminal shows them, with the number of \r redraws folded into each. */
interface Shown {
  lines: OutputLine[];
  folded: number[];
}

function asShown(raw: OutputLine[]): Shown {
  const lines: OutputLine[] = [];
  const folded: number[] = [];

  for (const line of raw) {
    const [text, redraws] = typeof line === "string" ? terminalLine(line) : terminalPart(line);
    lines.push(text);
    folded.push(redraws);
  }

  return { lines, folded };
}

/**
 * One line as a terminal would show it: without escape sequences, and for a line redrawn with \r (progress from
 * curl, tqdm, ffmpeg, rsync --progress) only its last state; otherwise a 70KB progress line crowds every line
 * before it out of the result. `redrawn`: that state began with a \r, so it is whole even when the beginning of the
 * line was not kept.
 */
function terminalLine(raw: string): [line: string, folded: number, redrawn: boolean] {
  const line = raw.includes("\x1b") ? raw.replace(ESCAPE_SEQUENCE, "") : raw;

  if (!line.includes("\r")) return [line, 0, false];

  // A frame of nothing but spaces is how many tools erase a progress bar: it is not a state worth showing.
  const frames = line.split("\r");
  const states = frames.filter((frame) => frame.trim() !== "");

  return [states.at(-1) ?? "", Math.max(states.length - 1, 0), frames.findLastIndex((frame) => frame.trim() !== "") !== 0];
}

/** Whether `line` is what the buffers kept of a line they cut through, rather than a whole line. */
function isCut(line: OutputLine): line is LinePart {
  return typeof line !== "string";
}

/** What was kept of a cut line, as a terminal would show it. */
function terminalPart(part: LinePart): [line: OutputLine, folded: number] {
  const [start, startFolded] = part.start === undefined ? [undefined, 0] : terminalLine(part.start);

  if (part.end === undefined) return [{ start: start ?? "" }, startFolded];

  const [end, endFolded, redrawn] = terminalLine(part.end);

  // Redrawn after the cut, the line shows only its last state, and that was kept whole.
  if (redrawn) return [end, startFolded + endFolded];

  return [{ start, end, dropped: part.dropped }, startFolded + endFolded];
}

/**
 * A line as the result shows it: whole, or with `limit`, cut to its two ends when it is longer. What the buffers did
 * not keep of a line is always marked, so the part that was kept never passes for the whole line.
 */
function render(line: OutputLine, limit?: LineLimit): string {
  if (typeof line === "string") return limit ? capLine(line, limit) : line;

  if (line.end === undefined) return `${shorten(line.start, clipStart, limit)}…[the rest of this line omitted]`;

  if (line.start === undefined) {
    const end = shorten(line.end, clipEnd, limit);

    return `…[${plural(line.dropped + bytesLeftOut(line.end, end), "byte")} before this omitted]…${end}`;
  }

  // Each end gets half the room, as in a line cut by capLine.
  const half = limit && { chars: limit.chars / 2, bytes: limit.bytes / 2 };
  const start = shorten(line.start, clipStart, half);
  const end = shorten(line.end, clipEnd, half);
  const omitted = line.dropped + bytesLeftOut(line.start, start) + bytesLeftOut(line.end, end);

  return `${start}…[${plural(omitted, "byte")} omitted]…${end}`;
}

/** A line longer than `limit` keeps the first and last half of it, unless that leaves out no more than MIN_CUT_CHARS. */
function capLine(line: string, limit: LineLimit): string {
  // A UTF-16 code unit takes at most 3 bytes in UTF-8, so such a line is within the limit.
  if (line.length <= limit.chars && line.length * 3 <= limit.bytes) return line;

  // Cut between code points, never through a surrogate pair.
  const start = clipStart(line, limit.chars / 2, limit.bytes / 2);
  const end = clipEnd(line, limit.chars / 2, limit.bytes / 2);
  const omitted = line.length - start.length - end.length;

  return omitted > MIN_CUT_CHARS ? `${start}…[${plural(omitted, "character")} omitted]…${end}` : line;
}

/** `text` cut by `clip` to `limit`, when there is one and the cut leaves out more than MIN_CUT_CHARS. */
function shorten(text: string, clip: typeof clipStart, limit: LineLimit | undefined): string {
  if (!limit) return text;

  const part = clip(text, limit.chars, limit.bytes);

  return text.length - part.length > MIN_CUT_CHARS ? part : text;
}

function bytesLeftOut(text: string, part: string): number {
  return Buffer.byteLength(text) - Buffer.byteLength(part);
}

/** A line of the output, or what the buffers kept of one they cut through. */
type OutputLine = string | LinePart;

/**
 * What the buffers kept of a line they cut through: its beginning (the rest was not kept), or its end with the
 * `dropped` bytes before it not kept, or both ends with the `dropped` bytes between them not kept.
 */
type LinePart = { start: string; end?: undefined } | { start?: string; end: string; dropped: number };

/** The output as lines: all of them in `head`, or its first lines in `head` and its last in `tail`, with a gap. */
interface Printed {
  head: OutputLine[];
  /** The last lines, when the middle was dropped. */
  tail?: Tail;
  total: number;
}

/** The last lines of the output; `start` is the line number of the first of them. */
interface Tail {
  lines: OutputLine[];
  start: number;
}

/** The combined output: its first HEAD_BUFFER_BYTES, and roughly its last ROLLING_BUFFER_BYTES. */
class OutputBuffer {
  private readonly head: Buffer[] = [];
  private headSize = 0;
  /** The first byte after the head buffer, once one has arrived: a "\n" there ends the head buffer's last line. */
  private afterHead: number | undefined;
  private readonly rolling = new RollingBuffer(ROLLING_BUFFER_BYTES);

  push(chunk: Buffer): void {
    const room = HEAD_BUFFER_BYTES - this.headSize;

    if (room > 0) {
      const part = chunk.subarray(0, room);
      this.head.push(part);
      this.headSize += part.length;
    }

    if (this.afterHead === undefined && chunk.length > room) this.afterHead = chunk[room];

    this.rolling.push(chunk);
  }

  lines(): Printed {
    const head = Buffer.concat(this.head);
    const { droppedBytes, droppedLines } = this.rolling;

    // Whatever the rolling buffer dropped is still in the head buffer: nothing is missing.
    if (droppedBytes <= head.length) {
      const lines = splitLines(Buffer.concat([head.subarray(0, droppedBytes), this.rolling.bytes()]).toString("utf8"));

      return { head: lines, total: lines.length };
    }

    // The decoder holds back a character cut in two at the end of the head buffer.
    const headText = new StringDecoder("utf8").write(head);
    const first: OutputLine[] = splitLines(headText);
    const { text, skipped } = this.rolling.text();
    const last: OutputLine[] = splitLines(text);
    const start = droppedLines + 1;

    // The lines the buffers cut through are marked, so that what was kept of them never passes for a whole line. The
    // head buffer's last line is whole when the text ends with "\n" (the decoder may hold back the first character of
    // the next line) or when the next byte is "\n" (which also completes a \r\n).
    const headLine = headText.endsWith("\n") || this.afterHead === 10 ? undefined : first.at(-1);
    const cutBytes = this.rolling.cutBytes + skipped;
    const tailLine = cutBytes > 0 ? last[0] : undefined;

    if (typeof headLine === "string" && typeof tailLine === "string" && first.length === start) {
      // One line, begun in the head buffer and ended in the rolling buffer: it keeps its two real ends.
      const line = { start: headLine, end: tailLine, dropped: Math.max(0, cutBytes - Buffer.byteLength(headLine)) };
      first[first.length - 1] = line;
      last[0] = line;
    } else {
      if (typeof headLine === "string") first[first.length - 1] = { start: headLine };

      if (typeof tailLine === "string") last[0] = { end: tailLine, dropped: cutBytes };
    }

    return { head: first, tail: { lines: last, start }, total: droppedLines + last.length };
  }
}

/** Keeps roughly the last `limit` bytes of output and counts the bytes and lines it dropped. */
class RollingBuffer {
  private readonly limit: number;
  private readonly chunks: Buffer[] = [];
  private size = 0;
  droppedBytes = 0;
  droppedLines = 0;
  /** How many bytes of the first kept line were dropped: it began before what is kept when this is above 0. */
  cutBytes = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;

    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) {
      const dropped = this.chunks.shift()!;
      const lastNewline = dropped.lastIndexOf(10);
      this.size -= dropped.length;
      this.droppedBytes += dropped.length;
      this.droppedLines += countNewlines(dropped);
      this.cutBytes = lastNewline === -1 ? this.cutBytes + dropped.length : dropped.length - lastNewline - 1;
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** The kept output as text, without the rest of a character whose first bytes were dropped (`skipped` bytes). */
  text(): { text: string; skipped: number } {
    const bytes = this.bytes();
    let skipped = 0;

    while (this.droppedBytes > 0 && skipped < 3 && skipped < bytes.length && (bytes[skipped]! & 0xc0) === 0x80) skipped++;

    return { text: bytes.subarray(skipped).toString("utf8"), skipped };
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;

  for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) count++;

  return count;
}
