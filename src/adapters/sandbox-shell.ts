// Pure helpers for the sandbox ExecutionEnv.
//
// This module has no runtime imports beyond the portable `pi-durable/env`
// value types: it is loaded both by the Workers adapter
// (src/adapters/sandbox-env.ts) and by Node tests (test/sandbox-env.test.ts),
// so it must never pull in Workers-only modules (`@cloudflare/sandbox` imports
// `cloudflare:*`, which the default ESM loader cannot resolve) or node:
// builtins. Everything here runs on real bash / real Node processes and is
// exercised directly by tests.

import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type Result,
  type TextLine,
  type TextLineReader,
  toError,
} from "@earendil-works/pi-durable/env";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** Bytes requested per helper reader request while streaming lines. */
const LINE_CHUNK_BYTES = 64 * 1024;

export const SIGTERM = 15;

/**
 * Control record the launcher writes on its own stderr when the in-container
 * watchdog killed the command group. The launcher's stderr is a dedicated
 * control stream: the command's own stderr is merged into the stdout pipe by
 * the launcher (`2>&1`), so ordinary command output never lands on it and a
 * command's legitimate exit status (124 included) is never interpreted as a
 * timeout. This is an ordering/convention marker, not a security boundary: a
 * command runs inside the launcher's own trust unit and can reach the parent's
 * file descriptors, so the consumer must not treat the presence (or absence)
 * of this record as adversarially trustworthy.
 */
export const WATCHDOG_EXPIRED_RECORD = "cfpi-watchdog-expired";

/**
 * Launcher: `$1` is the user command, `$2` the in-container watchdog timeout
 * ("" for none). With `set -m`, the backgrounded command becomes its own
 * process-group leader (`$!` == its pgid), so `kill -9 -<pid>` reaches every
 * descendant that did not escape the group. On TERM/INT the launcher kills the
 * group before exiting; on timeout the watchdog subshell does the same from
 * inside the container. The command's stdin is /dev/null and its combined
 * output is the launcher's stdout (the command's stderr is folded into it with
 * `2>&1`), leaving the launcher's own stderr as the watchdog control stream.
 *
 * The watchdog is forked only after the command pid exists, so it can never
 * capture a zero pid and no-op. When it fires it first writes the expiration
 * record to its inherited stderr (`>&2`, the control stream) and only then
 * kills the group: the record is one small write, already in the control
 * pipe before the launcher's `wait` can return, so the launcher reaping the
 * command and terminating the watchdog group right after cannot lose it.
 * The launcher reaps the watchdog and propagates the command's own exit
 * status unchanged.
 */
export const EXEC_LAUNCHER = `set -m
__cfpi_child=0
__cfpi_watch=0
__cfpi_kill_group() {
  if [ "$__cfpi_child" -ne 0 ]; then kill -9 -"$__cfpi_child" 2>/dev/null; fi
}
trap __cfpi_kill_group TERM INT
bash -c "$1" </dev/null 2>&1 &
__cfpi_child=$!
if [ -n "$2" ]; then
  ( sleep "$2"; printf '%s\\n' '${WATCHDOG_EXPIRED_RECORD}' >&2; __cfpi_kill_group ) & __cfpi_watch=$!
fi
wait "$__cfpi_child"
__cfpi_code=$?
if [ "$__cfpi_watch" -ne 0 ]; then
  # The watchdog subshell runs in its own job group (set -m): kill the group so
  # a still-pending sleep cannot outlive the launcher holding the output and
  # control pipes open until the deadline elapses.
  kill -TERM -"$__cfpi_watch" 2>/dev/null
  wait "$__cfpi_watch" 2>/dev/null
fi
exit "$__cfpi_code"
`;

/**
 * Builds the exec() argv for a user command. Exported because the launcher's
 * process-group, timeout, and argument-encoding behavior is exercised directly
 * by tests on a real bash.
 */
export function buildExecLaunch(command: string, timeoutSeconds: number | undefined): string[] {
  return [
    "bash",
    "-c",
    EXEC_LAUNCHER,
    "pi-exec",
    command,
    timeoutSeconds === undefined ? "" : String(timeoutSeconds),
  ];
}

export function resolveTimeoutMs(
  timeout: number | undefined,
): Result<number | undefined, ExecutionError> {
  if (timeout === undefined) return ok(undefined);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return err(
      new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"),
    );
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return err(
      new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`),
    );
  }
  return ok(timeoutMs);
}

// --- POSIX path helpers (the Workers runtime has no node:path) ---

export function posixNormalize(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const previous = out.length > 0 ? out[out.length - 1] : undefined;
      if (previous !== undefined && previous !== "..") {
        out.pop();
      } else if (!absolute) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  const joined = (absolute ? "/" : "") + out.join("/");
  return joined === "" ? (absolute ? "/" : ".") : joined;
}

/** Mirrors node:path join: empty segments are ignored, a trailing slash on the last segment is kept. */
export function posixJoin(parts: string[]): string {
  const segments = parts.filter((part) => part !== "");
  if (segments.length === 0) return ".";
  const trailing = segments[segments.length - 1]?.endsWith("/") ?? false;
  const joined = posixNormalize(segments.join("/"));
  if (trailing && joined !== "/" && joined !== ".") return `${joined}/`;
  return joined;
}

export function posixBasename(p: string): string {
  if (p === "") return "";
  let s = p;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (s === "/") return "/";
  const slash = s.lastIndexOf("/");
  return slash === -1 ? s : s.slice(slash + 1);
}

// --- Base64 helpers (bounded chunk reads) ---

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// --- Error mapping and abort helpers ---

export function mapErrnoCode(
  code: string,
): "not_found" | "permission_denied" | "not_directory" | "is_directory" | "invalid" | undefined {
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "ENOTDIR":
      return "not_directory";
    case "EISDIR":
      return "is_directory";
    case "EINVAL":
    case "EILSEQ":
      return "invalid";
    default:
      return undefined;
  }
}

export function abortFileError(path?: string): FileError {
  return new FileError("aborted", "aborted", path);
}

export function abortResult<TValue>(
  context: Context,
  path?: string,
): Result<TValue, FileError> | undefined {
  const signal = context.abortSignal;
  return signal?.aborted ? err(abortFileError(path)) : undefined;
}

// --- fs-helper protocol types ---

export interface HelperSuccess {
  ok: true;
  value: unknown;
}

export interface HelperFailure {
  ok: false;
  code: string;
  message: string;
  path?: string;
}

export type HelperResponse = HelperSuccess | HelperFailure;

// --- Line reader over a retained helper-side file descriptor ---

/** Options for spawning the retained reader process (a subset of the Workers container exec options). */
export interface ReaderExecOptions {
  stdin: "pipe";
  stdout: "pipe";
  stderr: "ignore";
  signal?: AbortSignal;
}

/** Structural subset of the Workers `ExecProcess` the reader client depends on. */
export interface ShellProcess {
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

/**
 * Strict LF line reader backed by one long-lived fs-helper `reader` process.
 *
 * The helper opens the path once and retains the descriptor for the
 * connection's lifetime, so renaming or unlinking the path afterwards cannot
 * mix another file into the byte stream, and a missing file fails at open
 * instead of returning a reader that fails later. Requests carry explicit
 * byte offsets, so offsets advance only on success and an aborted read can be
 * retried without skipping bytes.
 */
export class HelperTextLineReader implements TextLineReader {
  private readonly process: ShellProcess;
  private readonly stdout: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stdin: WritableStreamDefaultWriter<Uint8Array> | undefined;
  /** Decodes only the helper's stdout protocol frames (ASCII JSON lines). */
  private readonly protocolDecoder = new TextDecoder();
  /** Decodes only base64-decoded file bytes; retains multi-byte state across chunks. */
  private readonly dataDecoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly path: string;
  private readonly onClosed: (() => void) | undefined;
  private byteOffset = 0;
  private buffered = "";
  private received = "";
  private ended = false;
  private closed = false;

  private constructor(
    process: ShellProcess,
    stdout: ReadableStream<Uint8Array>,
    path: string,
    onClosed: (() => void) | undefined,
  ) {
    this.process = process;
    this.stdout = stdout.getReader();
    this.stdin = process.stdin === null ? undefined : process.stdin.getWriter();
    this.path = path;
    this.onClosed = onClosed;
  }

  /**
   * Spawns the retained helper reader and performs the open handshake: the
   * helper's first response line reports whether the path could be opened.
   */
  static async open(
    spawn: (options: ReaderExecOptions) => Promise<ShellProcess>,
    path: string,
    context: Context,
    onClosed?: () => void,
  ): Promise<Result<HelperTextLineReader, FileError>> {
    const aborted = abortResult<HelperTextLineReader>(context, path);
    if (aborted) return aborted;
    const signal = context.abortSignal;
    let proc: ShellProcess;
    try {
      proc = await spawn({
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const cause = toError(error);
      return err(
        new FileError("unknown", `fs helper reader could not start: ${cause.message}`, path, cause),
      );
    }
    if (proc.stdout === null) {
      return err(new FileError("unknown", "fs helper reader stdout is unavailable", path));
    }
    const instance = new HelperTextLineReader(proc, proc.stdout, path, onClosed);
    const handshake = await instance.nextResponse(context);
    if (!handshake.ok) {
      await instance.close(context);
      return err(handshake.error);
    }
    if (handshake.value === undefined) {
      return err(new FileError("unknown", "fs helper reader exited before reporting open", path));
    }
    if (!handshake.value.ok) {
      await instance.close(context);
      const mapped = mapErrnoCode(handshake.value.code);
      return err(
        new FileError(mapped ?? "unknown", handshake.value.message, handshake.value.path ?? path),
      );
    }
    return ok(instance);
  }

  /**
   * One JSON response line from the helper; `undefined` when its stdout ended.
   * Once a request has been written, the caller must read its response with
   * `ignoreAbort` (the response is already owed by the FIFO protocol);
   * aborting instead would strand the response and let a later request
   * consume it.
   */
  private async nextResponse(
    context: Context,
    ignoreAbort = false,
  ): Promise<Result<HelperResponse | undefined, FileError>> {
    while (true) {
      const newline = this.received.indexOf("\n");
      if (newline !== -1) {
        const line = this.received.slice(0, newline);
        this.received = this.received.slice(newline + 1);
        try {
          return ok(JSON.parse(line) as HelperResponse);
        } catch (error) {
          const cause = toError(error);
          return err(
            new FileError(
              "unknown",
              `fs helper reader protocol failure: ${cause.message}`,
              this.path,
              cause,
            ),
          );
        }
      }
      if (this.ended) return ok(undefined);
      if (!ignoreAbort) {
        const aborted = abortResult<HelperResponse | undefined>(context, this.path);
        if (aborted) return aborted;
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await this.stdout.read();
      } catch (error) {
        const cause = toError(error);
        return err(
          new FileError(
            "unknown",
            `fs helper reader stream failed: ${cause.message}`,
            this.path,
            cause,
          ),
        );
      }
      if (chunk.done) {
        this.received += this.protocolDecoder.decode();
        this.ended = true;
        continue;
      }
      this.received += this.protocolDecoder.decode(chunk.value, { stream: true });
    }
  }

  /** One bounded read over the retained descriptor, at an explicit offset. */
  private async requestChunk(
    context: Context,
    offset: number,
    length: number,
  ): Promise<Result<{ data: string; eof: boolean }, FileError>> {
    const aborted = abortResult<{ data: string; eof: boolean }>(context, this.path);
    if (aborted) return aborted;
    if (this.stdin === undefined) {
      return err(new FileError("unknown", "fs helper reader stdin is unavailable", this.path));
    }
    try {
      await this.stdin.write(this.encoder.encode(`${JSON.stringify({ offset, length })}\n`));
    } catch (error) {
      const cause = toError(error);
      return err(
        new FileError(
          "unknown",
          `fs helper reader request failed: ${cause.message}`,
          this.path,
          cause,
        ),
      );
    }
    // The request is owed exactly one response line: read it even if the
    // context aborted meanwhile, so the FIFO never holds an uncorrelated
    // response that a later request would consume.
    const response = await this.nextResponse(context, true);
    if (!response.ok) return err(response.error);
    if (response.value === undefined) {
      return err(new FileError("unknown", "fs helper reader exited before responding", this.path));
    }
    if (!response.value.ok) {
      const mapped = mapErrnoCode(response.value.code);
      return err(
        new FileError(
          mapped ?? "unknown",
          response.value.message,
          response.value.path ?? this.path,
        ),
      );
    }
    const value = response.value.value as { data?: unknown; eof?: unknown };
    if (typeof value?.data !== "string" || typeof value?.eof !== "boolean") {
      return err(
        new FileError("unknown", "fs helper reader returned a malformed chunk", this.path),
      );
    }
    return ok({ data: value.data, eof: value.eof });
  }

  /** The retained session answers one request at a time; this chains whole readLine/close operations. */
  private tail: Promise<unknown> = Promise.resolve();

  /** Serializes whole operations — request writing, response consumption, and buffer updates — in call order. */
  private serialized<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    const run = this.tail.then(operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    return this.serialized(() => this.readLineLocked(context));
  }

  private async readLineLocked(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const aborted = abortResult<TextLine | undefined>(context, this.path);
    if (aborted) return aborted;
    if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));

    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline !== -1) {
        const text = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        return ok({ text, terminated: true });
      }
      if (this.ended) {
        if (this.buffered.length === 0) return ok(undefined);
        const text = this.buffered;
        this.buffered = "";
        return ok({ text, terminated: false });
      }
      const chunk = await this.requestChunk(context, this.byteOffset, LINE_CHUNK_BYTES);
      if (!chunk.ok) return err(chunk.error);
      const bytes = decodeBase64(chunk.value.data);
      // Commit the chunk atomically — offset, buffer, and EOF state advance
      // together before any abort check — so an aborted call returns with a
      // consistent state and a retry neither skips nor duplicates bytes.
      this.byteOffset += bytes.byteLength;
      this.buffered += this.dataDecoder.decode(bytes, { stream: true });
      if (chunk.value.eof) {
        this.buffered += this.dataDecoder.decode();
        this.ended = true;
      }
      const afterReadAbort = abortResult<TextLine | undefined>(context, this.path);
      if (afterReadAbort) return afterReadAbort;
    }
  }

  /**
   * Ends the helper session: closing stdin tells the helper to close its
   * retained descriptor and exit, and the exit is awaited so the process is
   * reaped before close returns.
   */
  async close(context: Context): Promise<void> {
    await this.serialized(() => this.closeLocked(context));
  }

  private async closeLocked(context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffered = "";
    if (this.stdin !== undefined) {
      try {
        await this.stdin.close();
      } catch {
        // The stream was already closed or errored; the exit wait below still applies.
      }
    }
    if (context.abortSignal?.aborted) this.process.kill(SIGTERM);
    await this.process.exitCode.then(
      () => undefined,
      () => undefined,
    );
    this.onClosed?.();
  }

  /** Force-stops a reader that was never closed; used by SandboxExecutionEnv.cleanup. */
  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffered = "";
    this.process.kill(SIGTERM);
    this.onClosed?.();
  }
}
