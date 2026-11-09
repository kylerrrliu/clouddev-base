import { EventEmitter } from "node:events";
import { formatSize, type ToolResult } from "./tools/common.ts";

/** Tool calls the activity page keeps. Running calls are never dropped. */
export const MAX_CALLS = 500;
const MAX_NOTICES = 200;
/** Longest string kept from a tool argument: an edit's old/new text, a written file, a command. */
const MAX_ARG_CHARS = 8 * 1024;
/** Result text kept per finished call. */
export const MAX_RESULT_CHARS = 16 * 1024;
/** Live output kept per running call (only bash streams output). */
export const MAX_LIVE_OUTPUT_CHARS = 64 * 1024;
/** Live output is pushed to viewers at most this often. */
const OUTPUT_FLUSH_MS = 250;
/** `request` events are sent at most this often; the page shows "last request N seconds ago". */
const REQUEST_EVENT_INTERVAL_MS = 1000;
const MAX_BRIEF_CHARS = 200;
const MAX_SUMMARY_CHARS = 500;

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
}

export type ActivityEvent =
  | { type: "call.start"; call: CallSummary }
  /** `replace`: the text is the whole output so far, not an addition (more arrived than one event carries). */
  | { type: "call.output"; id: number; text: string; replace: boolean }
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
}

/** Handle for a call in progress. */
export interface ActiveCall {
  readonly id: number;
  /** Live output (bash). Ignored once the call has finished. */
  output(text: string): void;
  /** `aborted`: the client cancelled the call or went away. */
  finish(result: ToolResult, aborted: boolean): void;
}

interface CallRecord extends CallDetail {
  /** Output not yet pushed to viewers. */
  pending: string;
  pendingReplace: boolean;
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
      if (call.status !== "running") continue;

      // Text still waiting in `pending` reaches every subscriber with the next batch, so it is left out here:
      // a viewer that takes this snapshot and then subscribes would otherwise get it twice. (In append mode
      // `pending` is always the end of `output`; a replace batch carries everything anyway.)
      const shown = call.pendingReplace ? call.output : call.output.slice(0, call.output.length - call.pending.length);

      if (shown) live[call.id] = shown;
    }

    return {
      startedAt: this.startedAt,
      lastRequestAt: this.lastRequestAt,
      client: this.client,
      calls: this.calls.map(summaryOf),
      live,
      notices: [...this.notices],
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

  startCall({ tool, summary, args, workspace, client }: StartCall): ActiveCall {
    const record: CallRecord = {
      id: this.nextCallId++,
      tool,
      summary: oneLine(summary),
      workspace,
      client,
      startedAt: Date.now(),
      status: "running",
      args: clipArgs(args),
      output: "",
      outputTruncated: false,
      pending: "",
      pendingReplace: false,
    };

    this.calls.push(record);
    this.dropOldCalls();
    this.emit({ type: "call.start", call: summaryOf(record) });

    const flush = () => {
      record.flushTimer = undefined;

      if (!record.pending && !record.pendingReplace) return;

      const event: ActivityEvent = { type: "call.output", id: record.id, text: record.pending, replace: record.pendingReplace };
      record.pending = "";
      record.pendingReplace = false;
      this.emit(event);
    };

    return {
      id: record.id,
      output: (text) => {
        if (record.status !== "running" || !text) return;

        const combined = record.output + text;

        if (combined.length > MAX_LIVE_OUTPUT_CHARS) {
          record.output = combined.slice(-MAX_LIVE_OUTPUT_CHARS);
          record.outputTruncated = true;
        } else {
          record.output = combined;
        }

        record.pending += text;

        // More than one event should carry: send the kept tail as a replacement instead.
        if (record.pending.length > MAX_LIVE_OUTPUT_CHARS) {
          record.pending = record.output;
          record.pendingReplace = true;
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
        record.pending = "";
        record.pendingReplace = false;

        const text = resultText(result);
        // bash already keeps the end of long output, and its last lines carry the exit status.
        const keepTail = record.tool === "bash";

        record.status = aborted ? "cancelled" : result.isError ? "error" : "ok";
        record.endedAt = Date.now();
        record.output = own(keepTail ? clipTail(text, MAX_RESULT_CHARS) : clipHead(text, MAX_RESULT_CHARS));
        record.outputTruncated = record.output.length < text.length;
        const brief = briefOf(text, keepTail);
        record.brief = brief === undefined ? undefined : own(brief);
        this.emit({ type: "call.end", call: summaryOf(record) });
      },
    };
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
  const { id, tool, summary, workspace, client, startedAt, endedAt, status, brief } = call;

  return { id, tool, summary, workspace, client, startedAt, endedAt, status, brief };
}

function detailOf(call: CallRecord): CallDetail {
  const { args, output, outputTruncated } = call;

  return { ...summaryOf(call), args, output, outputTruncated };
}

/** The text of a tool result; images are described instead of included. */
function resultText(result: ToolResult): string {
  return result.content
    .map((item) => item.type === "text"
      ? item.text
      : `[图片 ${item.mimeType}，${formatSize(Math.floor((item.data.length * 3) / 4))}]`)
    .join("\n");
}

function briefOf(text: string, last: boolean): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = last ? lines.at(-1) : lines[0];

  return line === undefined ? undefined : clipHead(line, MAX_BRIEF_CHARS);
}

/** Arguments with long strings cut, so one big `write` cannot bloat the page. */
function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  return clipValue(args, 0) as Record<string, unknown>;
}

function clipValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ARG_CHARS ? own(`${value.slice(0, MAX_ARG_CHARS)}\n…（后面还有 ${value.length - MAX_ARG_CHARS} 个字符）`) : value;
  }

  if (Array.isArray(value)) return value.slice(0, 100).map((item) => clipValue(item, depth + 1));

  if (value && typeof value === "object" && depth < 4) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValue(item, depth + 1)]));
  }

  return value;
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
