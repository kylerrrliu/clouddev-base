import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { MAX_BYTES, formatSize, splitLines, takeTail, textResult, type ToolResult } from "./common.ts";

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 300;

/** Raw output kept in memory before the final tail truncation. */
const ROLLING_BUFFER_BYTES = 1024 * 1024;

/** Wait this long after the shell exits for its output pipes to close. */
const EXIT_GRACE_MS = 250;

/**
 * Run a command with bash in its own process group. `onOutput` receives the
 * combined output as it arrives (for the activity page); the result still
 * carries only the tail.
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
  const output = new RollingBuffer(ROLLING_BUFFER_BYTES);

  const child = spawn(file, args, {
    cwd,
    env: commandEnvironment(),
    // Own process group, so a timeout can kill everything the command started.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const forward = (stream: Readable | null) => {
    // One decoder per stream, so a multi-byte character split across chunks stays intact.
    const decoder = new StringDecoder("utf8");

    stream?.on("data", (chunk: Buffer) => {
      output.push(chunk);

      if (!onOutput) return;

      const text = decoder.write(chunk);

      // An exception thrown inside a stream event would take the whole server down; showing output is best effort.
      try {
        if (text) onOutput(text);
      } catch {
        // Ignored.
      }
    });
  };

  forward(child.stdout);
  forward(child.stderr);

  let timedOut = false;
  let cancelled = false;

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutSeconds * 1000);

  const onAbort = () => {
    cancelled = true;
    killTree(child);
  };

  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let exit: ExitInfo;

  try {
    exit = await waitForExit(child);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (exit.error) return textResult(`Failed to start the shell (${file}): ${exit.error.message}`, true);

  const text = formatOutput(output);

  if (cancelled) return textResult(appendStatus(text, "Command was cancelled."), true);

  if (timedOut) {
    return textResult(appendStatus(text, `Command timed out after ${timeoutSeconds} seconds and was killed.`), true);
  }

  if (exit.code !== 0) {
    const status = exit.code === null ? `Command was killed by signal ${exit.signal}.` : `Command exited with code ${exit.code}.`;

    return textResult(appendStatus(text, status), true);
  }

  return textResult(text || "(no output)");
}

/** Server secrets that commands run for the AI must never see. */
const PRIVATE_ENV_VARS = ["CLOUDDEV_BASE_PASSWORD"];

/** The server's environment minus its own secrets. */
export function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  for (const name of PRIVATE_ENV_VARS) delete env[name];

  return env;
}

function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}

function formatOutput(output: RollingBuffer): string {
  const lines = splitLines(output.text());
  const tail = takeTail(lines);

  if (tail.lines.length === 0 && lines.length > 0) {
    const last = lines.at(-1)!;

    return `${last.slice(-MAX_BYTES)}\n\n[Output truncated: showing the end of a ${formatSize(Buffer.byteLength(last))} line.]`;
  }

  const text = tail.lines.join("\n");

  if (!tail.truncated && output.droppedLines === 0) return text;

  const total = output.droppedLines + lines.length;

  return `[Output truncated: showing the last ${tail.lines.length} of ${total} lines. Redirect output to a file and read or grep it if you need more.]\n${text}`;
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

function killTree(child: ChildProcess): void {
  if (!child.pid) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });

    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/**
 * Resolve when the shell exits. Normally that is the "close" event, but a
 * background process (`cmd &`) can keep the output pipes open forever, so
 * after "exit" only a short grace period is granted.
 */
function waitForExit(child: ChildProcess): Promise<ExitInfo> {
  return new Promise((resolve) => {
    let settled = false;
    let exited: ExitInfo | undefined;
    let grace: NodeJS.Timeout | undefined;

    const finish = (info: ExitInfo) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(info);
    };

    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      grace = setTimeout(() => finish(exited!), EXIT_GRACE_MS);
    });
    child.once("close", (code, signal) => finish(exited ?? { code, signal }));
  });
}

/** Keeps roughly the last `limit` bytes of output and counts the lines it dropped. */
class RollingBuffer {
  private readonly limit: number;
  private readonly chunks: Buffer[] = [];
  private size = 0;
  droppedLines = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;

    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.length;
      this.droppedLines += countNewlines(dropped);
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;

  for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) count++;

  return count;
}
