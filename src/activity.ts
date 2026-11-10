import { EventEmitter } from "node:events";
import { formatSize, type ToolResult } from "./tools/common.ts";

/** Tool calls the activity page keeps. Running calls are never dropped. */
export const MAX_CALLS = 500;
export const MAX_NOTICES = 200;
/** Longest string kept from a tool argument: an edit's old/new text, a written file, a command. */
const MAX_ARG_CHARS = 8 * 1024;
/** Items kept from an array argument (the edits of an `edit`). */
const MAX_ARG_ITEMS = 100;
/**
 * Result text the activity page keeps per finished call. Not the limit on tool results themselves: that is
 * MAX_RESULT_CHARS in tools/common.ts.
 */
export const MAX_RECORDED_RESULT_CHARS = 16 * 1024;
/** Live output shown per running call (only bash streams output): the end of it. */
export const MAX_LIVE_OUTPUT_CHARS = 64 * 1024;
/** Live output is pushed to viewers at most this often. */
const OUTPUT_FLUSH_MS = 250;
/** `request` events are sent at most this often; the page shows "last request N seconds ago". */
const REQUEST_EVENT_INTERVAL_MS = 1000;
const MAX_BRIEF_CHARS = 200;
const MAX_SUMMARY_CHARS = 500;

/** What the page keeps, so it can match the server. */
export interface ActivityLimits {
  calls: number;
  notices: number;
}

export type CallStatus = "running" | "ok" | "error" | "cancelled";

/** One tool call as listed on the activity page. */
export interface CallSummary {
  id: number;
  tool: string;
  /** One line: the path, search pattern or command. */
  summary: string;
  /** Root of the workspace the call ran in, when known. */
  workspace?: string;
  /** Name the client registered with (e.g. "Claude Code (clouddev-base)"). */
  client?: string;
  startedAt: number;
  endedAt?: number;
  status: CallStatus;
  /** For finished calls, the most telling line of the result (the last one for bash). */
  brief?: string;
  /**
   * The client cancelled the call or went away while it ran, but this tool does not stop for that
   * (read, write, edit, open_workspace): the work was done, the result just never reached the client.
   */
  undelivered?: boolean;
}

/** A call with its (truncated) arguments and output, fetched when a row is expanded. */
export interface CallDetail extends CallSummary {
  args: Record<string, unknown>;
  /** Live output while running, the result text once finished. */
  output: string;
  outputTruncated: boolean;
}

export interface Notice {
  id: number;
  at: number;
  level: "info" | "warn";
  message: string;
}

export interface ClientInfo {
  /** clientInfo.name from the MCP initialize request, e.g. "claude-code". */
  name: string;
  version: string;
  /** Name the client registered with during OAuth. */
  label?: string;
  at: number;
}

export interface ActivitySnapshot {
  startedAt: number;
  lastRequestAt?: number;
  client?: ClientInfo;
  calls: CallSummary[];
  /** Output so far of the calls still running, by call id. */
  live: Record<number, string>;
  notices: Notice[];
  limits: ActivityLimits;
}

export type ActivityEvent =
  | { type: "call.start"; call: CallSummary }
  /** The output so far of a running call (its end, when long). It replaces what was shown before. */
  | { type: "call.output"; id: number; text: string }
  | { type: "call.end"; call: CallSummary }
  | { type: "notice"; notice: Notice }
  | { type: "client"; client: ClientInfo }
  | { type: "request"; at: number };

export interface StartCall {
  tool: string;
  summary: string;
  args: Record<string, unknown>;
  workspace?: string;
  client?: string;
  /** The tool stops when the client cancels (bash, grep, glob). Others run to completion regardless. */
  cancellable?: boolean;
}

/** Handle for a call in progress. */
export interface ActiveCall {
  readonly id: number;
  /** Live output (bash). Ignored once the call has finished. */
  output(text: string): void;
  /** `aborted`: the client cancelled the call or went away. */
  finish(result: ToolResult, aborted: boolean): void;
}

interface CallRecord extends CallSummary {
  args: Record<string, unknown>;
  cancellable: boolean;
  /**
   * While running, the live output: it may grow to twice the shown length before it is cut back, so a chunk
   * costs no more than appending it. Once finished, the kept result text.
   */
  text: string;
  /** Some output was cut off. */
  cut: boolean;
  /** A batch of live output is waiting to be pushed. */
  flushTimer?: NodeJS.Timeout;
}

/**
 * What the MCP clients are doing, for the local activity page: recent tool
 * calls (kept in memory only, never written to disk), live output of running
 * commands, and notable events such as new authorizations.
 */
export class ActivityLog {
  readonly startedAt = Date.now();
  private readonly emitter = new EventEmitter();
  private readonly calls: CallRecord[] = [];
  private readonly notices: Notice[] = [];
  private nextCallId = 1;
  private nextNoticeId = 1;
  private lastRequestAt: number | undefined;
  private lastRequestEventAt = 0;
  private client: ClientInfo | undefined;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  /** Receive every event from now on. Returns the unsubscribe function. */
  subscribe(listener: (event: ActivityEvent) => void): () => void {
    // A viewer must never be able to break a tool call, so listener errors stop here.
    const safe = (event: ActivityEvent) => {
      try {
        listener(event);
      } catch (error) {
        console.error("Activity listener failed:", error);
      }
    };

    this.emitter.on("event", safe);

    return () => this.emitter.off("event", safe);
  }

  snapshot(): ActivitySnapshot {
    const live: Record<number, string> = {};

    for (const call of this.calls) {
      if (call.status === "running" && call.text) live[call.id] = liveOutput(call);
    }

    return {
      startedAt: this.startedAt,
      lastRequestAt: this.lastRequestAt,
      client: this.client,
      calls: this.calls.map(summaryOf),
      live,
      notices: [...this.notices],
      limits: { calls: MAX_CALLS, notices: MAX_NOTICES },
    };
  }

  /** Arguments and output of one call, while it is still kept. */
  call(id: number): CallDetail | undefined {
    const call = this.calls.find((candidate) => candidate.id === id);

    return call && detailOf(call);
  }

  /** An authenticated MCP request arrived. */
  request(now = Date.now()): void {
    this.lastRequestAt = now;

    if (now - this.lastRequestEventAt < REQUEST_EVENT_INTERVAL_MS) return;

    this.lastRequestEventAt = now;
    this.emit({ type: "request", at: now });
  }

  /** A client sent `initialize`: it just started or reconnected. */
  clientConnected(info: { name: string; version: string }, label?: string): void {
    this.client = { name: info.name, version: info.version, label, at: Date.now() };
    this.emit({ type: "client", client: this.client });
    this.notice(`${label ?? info.name} 已连接（${info.name} ${info.version}）`);
  }

  notice(message: string, level: Notice["level"] = "info"): void {
    const notice: Notice = { id: this.nextNoticeId++, at: Date.now(), level, message };
    this.notices.push(notice);

    if (this.notices.length > MAX_NOTICES) this.notices.splice(0, this.notices.length - MAX_NOTICES);

    this.emit({ type: "notice", notice });
  }

  startCall(call: StartCall): ActiveCall {
    const record = this.add(call);
    this.emit({ type: "call.start", call: summaryOf(record) });

    const flush = () => {
      record.flushTimer = undefined;

      if (record.status === "running") this.emit({ type: "call.output", id: record.id, text: liveOutput(record) });
    };

    return {
      id: record.id,
      output: (text) => {
        if (record.status !== "running" || !text) return;

        record.text += text;

        if (record.text.length > 2 * MAX_LIVE_OUTPUT_CHARS) {
          record.text = own(record.text.slice(-MAX_LIVE_OUTPUT_CHARS));
          record.cut = true;
        }

        if (!record.flushTimer) {
          record.flushTimer = setTimeout(flush, OUTPUT_FLUSH_MS);
          record.flushTimer.unref();
        }
      },
      finish: (result, aborted) => {
        if (record.status !== "running") return;

        clearTimeout(record.flushTimer);
        record.flushTimer = undefined;

        // A tool that stops when cancelled was cancelled; one that ran to completion keeps its own outcome.
        record.status = aborted && record.cancellable ? "cancelled" : result.isError ? "error" : "ok";
        if (aborted && !record.cancellable) record.undelivered = true;
        // bash already keeps the end of long output, and its last lines carry the exit status.
        this.end(record, resultText(result), record.tool === "bash");
      },
    };
  }

  /** A call the server refused before running it: arguments that do not fit the tool, or an unknown tool. */
  rejectedCall({ tool, args, client, message }: { tool: string; args: Record<string, unknown>; client?: string; message: string }): void {
    const record = this.add({ tool, summary: summaryFromArgs(args), args, client });
    record.status = "error";
    this.end(record, message, false);
  }

  private add({ tool, summary, args, workspace, client, cancellable = false }: StartCall): CallRecord {
    const record: CallRecord = {
      id: this.nextCallId++,
      tool,
      summary: oneLine(summary),
      workspace,
      client,
      startedAt: Date.now(),
      status: "running",
      args: clipArgs(args),
      cancellable,
      text: "",
      cut: false,
    };

    this.calls.push(record);
    this.dropOldCalls();

    return record;
  }

  private end(record: CallRecord, text: string, keepTail: boolean): void {
    record.endedAt = Date.now();
    record.text = own(keepTail ? clipTail(text, MAX_RECORDED_RESULT_CHARS) : clipHead(text, MAX_RECORDED_RESULT_CHARS));
    record.cut = record.text.length < text.length;
    const brief = briefOf(text, keepTail);
    record.brief = brief === undefined ? undefined : own(brief);
    this.emit({ type: "call.end", call: summaryOf(record) });
  }

  private dropOldCalls(): void {
    while (this.calls.length > MAX_CALLS) {
      const index = this.calls.findIndex((call) => call.status !== "running");

      if (index === -1) return;

      this.calls.splice(index, 1);
    }
  }

  private emit(event: ActivityEvent): void {
    this.emitter.emit("event", event);
  }
}

function summaryOf(call: CallRecord): CallSummary {
  const { id, tool, summary, workspace, client, startedAt, endedAt, status, brief, undelivered } = call;

  return { id, tool, summary, workspace, client, startedAt, endedAt, status, brief, undelivered };
}

function detailOf(call: CallRecord): CallDetail {
  const running = call.status === "running";
  const output = running ? liveOutput(call) : call.text;

  return { ...summaryOf(call), args: call.args, output, outputTruncated: call.cut || output.length < call.text.length };
}

/** What viewers see of a running call's output: its last MAX_LIVE_OUTPUT_CHARS characters. */
function liveOutput(call: CallRecord): string {
  return clipTail(call.text, MAX_LIVE_OUTPUT_CHARS);
}

/** The text of a tool result; images are described instead of included. */
function resultText(result: ToolResult): string {
  return result.content
    .map((item) => item.type === "text"
      ? item.text
      : `[图片 ${item.mimeType}，${formatSize(Math.floor((item.data.length * 3) / 4))}]`)
    .join("\n");
}

/** What a refused call was about, from whichever of its usual arguments it has. */
function summaryFromArgs(args: Record<string, unknown>): string {
  for (const name of ["command", "pattern", "path"]) {
    if (typeof args[name] === "string") return args[name];
  }

  return "";
}

/**
 * The line a finished call is summed up by: the last one for bash, else the first one of the content. grep, glob
 * and read put their notes first ("[Stopped after 100 results. …]"), then a blank line, then the content, which
 * tells more about the call, and is what a search of the activity page looks for.
 */
function briefOf(text: string, last: boolean): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const line = last ? lines.findLast(Boolean) : (lines.slice(contentStart(lines)).find(Boolean) ?? lines.find(Boolean));

  return line === undefined ? undefined : clipHead(line, MAX_BRIEF_CHARS);
}

/**
 * Where a result's content starts: after a leading block of "[…]" note lines and the blank line that ends it, else
 * at the top. Without that blank line a bracketed first line is content, such as a TOML "[package]" header.
 */
function contentStart(lines: string[]): number {
  let notes = 0;

  while (notes < lines.length && /^\[.*\]$/.test(lines[notes]!)) notes++;

  return notes > 0 && lines[notes] === "" ? notes + 1 : 0;
}

/** Arguments with long strings and arrays cut, so one big `write` cannot bloat the page. */
function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  return clipValue(args, 0) as Record<string, unknown>;
}

function clipValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ARG_CHARS ? own(`${value.slice(0, MAX_ARG_CHARS)}\n…（后面还有 ${value.length - MAX_ARG_CHARS} 个字符）`) : value;
  }

  if (value === null || typeof value !== "object") return value;

  // The tools' arguments are shallow; anything deeper is not shown rather than kept whole.
  if (depth >= 4) return "…";

  if (Array.isArray(value)) return value.slice(0, MAX_ARG_ITEMS).map((item) => clipValue(item, depth + 1));

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValue(item, depth + 1)]));
}

/**
 * A copy of `text` that holds no reference to a longer string. V8's slice() returns a view that keeps the whole
 * original alive, so a clipped 8 KB argument would otherwise keep a 20 MB `write` in memory for as long as the
 * call is listed.
 */
function own(text: string): string {
  return structuredClone(text);
}

/**
 * The call's summary on one line: whitespace runs that contain a line break become " ⏎ ". Only the beginning
 * of a long command is looked at, and the replacement is linear: a pattern of the form "spaces, line break,
 * spaces" backtracks quadratically on a long run of spaces with no line break in it.
 */
function oneLine(summary: string): string {
  const line = summary.slice(0, MAX_SUMMARY_CHARS * 4).replace(/\s+/g, (space) => (space.includes("\n") ? " ⏎ " : space));

  return own(clipHead(line, MAX_SUMMARY_CHARS));
}

function clipHead(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function clipTail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}
