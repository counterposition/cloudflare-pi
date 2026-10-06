// SandboxExecutionEnv: a Pi `ExecutionEnv` backed by a Cloudflare Container.
//
// The container is caller-owned (started before use; never started, stopped, or
// monitored here). File operations reuse the `@cloudflare/sandbox` `Files`
// class where it preserves Pi semantics, and a native helper process
// (/opt/cloudflare-pi/fs-helper.mjs) for the operations Files does not cover
// (append, truncate, fsync, realpath, temp creation, retained line-reader
// sessions, directory metadata, container-env inheritance).
//
// Shell execution runs bash deliberately. The user command is passed as one
// exec() argv element (never interpolated into a shell string). The launcher
// (./sandbox-shell.ts, kept free of Workers-only imports so Node tests can run
// it on a real bash) runs the command in its own process group (`set -m` plus
// an explicit `</dev/null`) so that a single signal to the launcher root lets
// it kill the entire tree on timeout/abort, and a watchdog subshell enforces
// the timeout inside the container even if the Worker-side timer never fires.
//
// This module runs in the Workers runtime: no node: imports. The helper is
// real Node and may use node: freely.
import type { Context } from "@earendil-works/chord";
import { Files, SandboxFileError, type FileOperationOptions } from "@cloudflare/sandbox";
import {
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileInfo,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  toError,
} from "@earendil-works/pi-durable/env";
import {
  abortFileError,
  abortResult,
  buildExecLaunch,
  type HelperResponse,
  HelperTextLineReader,
  mapErrnoCode,
  posixBasename,
  posixJoin,
  posixNormalize,
  resolveTimeoutMs,
  SIGTERM,
  WATCHDOG_EXPIRED_RECORD,
} from "./sandbox-shell";

/** After the launcher root exits, stop draining output once it stays idle this long. */
const EXIT_STDIO_GRACE_MS = 100;
const FS_HELPER_PATH = "/opt/cloudflare-pi/fs-helper.mjs";

export class SandboxExecutionEnv implements ExecutionEnv {
  /** File namespace: sessions sharing an id see the same container filesystem. */
  readonly id: string;
  cwd: string;

  private readonly container: Pick<Container, "exec">;
  private readonly files: Files;
  private readonly activeRoots = new Set<ExecProcess>();
  private readonly activeReaders = new Set<HelperTextLineReader>();
  // Explicit `| undefined` so the transient-failure resets below can assign
  // undefined under exactOptionalPropertyTypes.
  private homeDirPromise: Promise<Result<string, FileError>> | undefined;
  private containerEnvPromise: Promise<Result<Record<string, string>, FileError>> | undefined;

  constructor(container: Pick<Container, "exec">, options: { id: string; cwd?: string }) {
    this.container = container;
    this.id = options.id;
    this.cwd = options.cwd ?? "/workspace";
    this.files = new Files(container);
  }

  // --- helpers ---

  private fileOptions(context: Context): FileOperationOptions | undefined {
    const signal = context.abortSignal;
    return signal ? { signal } : undefined;
  }

  private homeDir(context: Context): Promise<Result<string, FileError>> {
    if (this.homeDirPromise === undefined) {
      this.homeDirPromise = (async () => {
        const result = await this.helperOp("homedir", undefined, context);
        if (!result.ok) {
          this.homeDirPromise = undefined; // allow a retry after a transient failure
          return err(
            new FileError(
              "unknown",
              `Cannot resolve home directory: ${result.error.message}`,
              undefined,
              result.error,
            ),
          );
        }
        return ok(result.value as string);
      })();
    }
    return this.homeDirPromise;
  }

  private async resolvePath(path: string, context: Context): Promise<Result<string, FileError>> {
    let candidate = path;
    if (candidate === "~" || candidate.startsWith("~/")) {
      const home = await this.homeDir(context);
      if (!home.ok)
        return err(
          new FileError(
            "unknown",
            `Cannot resolve home directory: ${home.error.message}`,
            path,
            home.error,
          ),
        );
      candidate = candidate === "~" ? home.value : posixJoin([home.value, candidate.slice(2)]);
    } else if (candidate.startsWith("file://")) {
      // Match node.ts: a file URL becomes a path, a malformed one stays an ordinary path.
      try {
        const url = new URL(candidate);
        if (url.host === "" || url.host === "localhost")
          candidate = decodeURIComponent(url.pathname);
      } catch {
        // Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
      }
    }
    return ok(
      candidate.startsWith("/")
        ? posixNormalize(candidate)
        : posixNormalize(posixJoin([this.cwd, candidate])),
    );
  }

  /** One fs-helper invocation: a fresh Node process per operation, JSON argv, JSON response. Module-internal: the line reader class shares it. */
  async helperOp(
    op: string,
    args: Record<string, unknown> | undefined,
    context: Context,
    stdin?: Uint8Array,
  ): Promise<Result<unknown, FileError>> {
    const aborted = abortResult<unknown>(context);
    if (aborted) return aborted;

    let process_: ExecProcess;
    try {
      const signal = context.abortSignal;
      process_ = await this.container.exec([FS_HELPER_PATH, op, JSON.stringify(args ?? {})], {
        ...(stdin === undefined
          ? {}
          : {
              // Helper reads stdin to EOF; enqueue-once closes immediately after.
              stdin: new ReadableStream<Uint8Array>({
                start(controller) {
                  if (stdin.length > 0) controller.enqueue(stdin);
                  controller.close();
                },
              }),
            }),
        stdout: "pipe",
        stderr: "ignore",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const cause = toError(error);
      if (context.abortSignal?.aborted) return err(abortFileError());
      return err(
        new FileError("unknown", `fs helper could not start: ${cause.message}`, undefined, cause),
      );
    }

    let output = "";
    if (process_.stdout !== null) {
      try {
        output = await new Response(process_.stdout).text();
      } catch (error) {
        if (context.abortSignal?.aborted) return err(abortFileError());
        const cause = toError(error);
        return err(
          new FileError("unknown", `fs helper output failed: ${cause.message}`, undefined, cause),
        );
      }
    }
    const exitCode = await process_.exitCode.catch(() => -1);
    const afterAbort = abortResult<unknown>(context);
    if (afterAbort) return afterAbort;

    let parsed: HelperResponse;
    try {
      parsed = JSON.parse(output) as HelperResponse;
    } catch (error) {
      const cause = toError(error);
      return err(
        new FileError(
          "unknown",
          `fs helper protocol failure (exit ${exitCode}): ${cause.message}`,
          undefined,
          cause,
        ),
      );
    }
    if (!parsed.ok) {
      const mapped = mapErrnoCode(parsed.code);
      return err(new FileError(mapped ?? "unknown", parsed.message, parsed.path));
    }
    return ok(parsed.value);
  }

  private async filesCall<TValue>(
    call: () => Promise<TValue>,
    fallbackPath: string,
    context: Context,
  ): Promise<Result<TValue, FileError>> {
    try {
      return ok(await call());
    } catch (error) {
      const cause = toError(error);
      if (error instanceof FileError) return err(error);
      if (SandboxFileError.is(error)) {
        const path = typeof error.path === "string" ? error.path : fallbackPath;
        const mapped = mapErrnoCode(error.code);
        return err(new FileError(mapped ?? "unknown", cause.message, path, cause));
      }
      const aborted = abortResult<TValue>(context, fallbackPath);
      if (aborted) return aborted;
      return err(new FileError("unknown", cause.message, fallbackPath, cause));
    }
  }

  private containerEnv(context: Context): Promise<Result<Record<string, string>, FileError>> {
    if (this.containerEnvPromise === undefined) {
      this.containerEnvPromise = (async () => {
        const result = await this.helperOp("container-env", undefined, context);
        if (!result.ok) {
          this.containerEnvPromise = undefined; // allow a retry after a transient failure
          return err(
            new FileError("unknown", `Cannot read container environment: ${result.error.message}`),
          );
        }
        const { available, env } = result.value as {
          available: boolean;
          env: Record<string, string>;
        };
        if (!available) {
          // The helper could not read the container's startup environment
          // (/proc/1/environ unreadable). Inheriting it is requested by
          // default, so exec() fails explicitly rather than silently degrading
          // to a PATH-only environment.
          return err(
            new FileError(
              "unknown",
              "Container startup environment is unavailable (cannot read /proc/1/environ)",
            ),
          );
        }
        return ok(env);
      })();
    }
    return this.containerEnvPromise;
  }

  // --- FileSystem: path algebra ---

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.resolvePath(path, context);
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(posixJoin(parts));
  }

  // --- FileSystem: reads ---

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<string>(context, resolved.value);
    if (aborted) return aborted;
    return this.filesCall(
      async () => {
        const response = await this.files.readFile(resolved.value, this.fileOptions(context));
        return response.text();
      },
      resolved.value,
      context,
    );
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<Uint8Array>(context, resolved.value);
    if (aborted) return aborted;
    return this.filesCall(
      async () => {
        const response = await this.files.readFile(resolved.value, this.fileOptions(context));
        return new Uint8Array(await response.arrayBuffer());
      },
      resolved.value,
      context,
    );
  }

  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<TextLineReader>(context, resolved.value);
    if (aborted) return aborted;
    // The helper retains an open descriptor for the reader's lifetime, so
    // renames or unlinks of the path cannot mix another file into the byte
    // stream, and a missing file fails here, at open.
    let reader: HelperTextLineReader | undefined;
    const opened = await HelperTextLineReader.open(
      (options) =>
        this.container.exec(
          [FS_HELPER_PATH, "reader", JSON.stringify({ path: resolved.value })],
          options,
        ),
      resolved.value,
      context,
      () => {
        if (reader !== undefined) this.activeReaders.delete(reader);
      },
    );
    if (!opened.ok) return opened;
    reader = opened.value;
    this.activeReaders.add(reader);
    return ok(reader);
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally {
      await opened.value.close(context);
    }
  }

  // --- FileSystem: writes ---

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<void>(context, resolved.value);
    if (aborted) return aborted;
    // Pi's writeFile creates missing parents (node.ts mkdirs the parent first).
    const parent = await this.createDir(
      posixJoin([resolved.value, ".."]),
      { recursive: true },
      context,
    );
    if (!parent.ok) return parent;
    return this.filesCall(
      () => this.files.writeFile(resolved.value, content, this.fileOptions(context)),
      resolved.value,
      context,
    );
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<void>(context, resolved.value);
    if (aborted) return aborted;
    const parent = await this.createDir(
      posixJoin([resolved.value, ".."]),
      { recursive: true },
      context,
    );
    if (!parent.ok) return parent;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const appended = await this.helperOp("append", { path: resolved.value }, context, bytes);
    return appended.ok ? ok(undefined) : err(appended.error);
  }

  async truncateFile(
    path: string,
    size: number,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<void>(context, resolved.value);
    if (aborted) return aborted;
    if (!Number.isSafeInteger(size) || size < 0) {
      return err(
        new FileError("invalid", "File size must be a non-negative safe integer", resolved.value),
      );
    }
    const truncated = await this.helperOp("truncate", { path: resolved.value, size }, context);
    return truncated.ok ? ok(undefined) : err(truncated.error);
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<void>(context, resolved.value);
    if (aborted) return aborted;
    const flushed = await this.helperOp("fsync", { path: resolved.value }, context);
    return flushed.ok ? ok(undefined) : err(flushed.error);
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const source = await this.resolvePath(sourcePath, context);
    if (!source.ok) return source;
    const destination = await this.resolvePath(destinationPath, context);
    if (!destination.ok) return destination;
    const aborted = abortResult<void>(context, destination.value);
    if (aborted) return aborted;
    return this.filesCall(
      () => this.files.rename(source.value, destination.value, this.fileOptions(context)),
      source.value,
      context,
    );
  }

  // --- FileSystem: metadata ---

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<FileInfo>(context, resolved.value);
    if (aborted) return aborted;
    return this.filesCall(
      async () => {
        const stats = await this.files.lstat(resolved.value, this.fileOptions(context));
        // node.ts maps types other than file/directory/symlink to "invalid".
        if (stats.type !== "file" && stats.type !== "directory" && stats.type !== "symlink") {
          throw new FileError("invalid", "Unsupported file type", resolved.value);
        }
        const info: FileInfo = {
          name: posixBasename(resolved.value),
          path: resolved.value,
          kind: stats.type,
          size: Number(stats.size),
          mtimeMs: stats.modifiedAt.getTime(),
        };
        return info;
      },
      resolved.value,
      context,
    );
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<FileInfo[]>(context, resolved.value);
    if (aborted) return aborted;
    // One helper exec returns name+kind+size+mtime for every entry; Files.readDirectory
    // would need one extra lstat exec per entry to produce the same FileInfo rows.
    const listed = await this.helperOp("listdir", { path: resolved.value }, context);
    if (!listed.ok) return err(listed.error);
    const infos: FileInfo[] = [];
    for (const row of listed.value as Array<{
      name: string;
      kind: string;
      size: number;
      mtimeMs: number;
    }>) {
      infos.push({
        name: row.name,
        path: posixJoin([resolved.value, row.name]),
        kind: row.kind as FileInfo["kind"],
        size: row.size,
        mtimeMs: row.mtimeMs,
      });
    }
    return ok(infos);
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<string>(context, resolved.value);
    if (aborted) return aborted;
    const canonical = await this.helperOp("realpath", { path: resolved.value }, context);
    return canonical.ok ? ok(canonical.value as string) : err(canonical.error);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context);
    if (result.ok) return ok(true);
    if (result.error.code === "not_found") return ok(false);
    return err(result.error);
  }

  // --- FileSystem: structure ---

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<void>(context, resolved.value);
    if (aborted) return aborted;
    // node.ts mkdir defaults to recursive: true; Files.mkdir defaults to false.
    return this.filesCall(
      () =>
        this.files.mkdir(resolved.value, {
          ...this.fileOptions(context),
          recursive: options?.recursive ?? true,
        }),
      resolved.value,
      context,
    );
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = await this.resolvePath(path, context);
    if (!resolved.ok) return resolved;
    const aborted = abortResult<void>(context, resolved.value);
    if (aborted) return aborted;
    return this.filesCall(
      () =>
        this.files.remove(resolved.value, {
          ...(options?.recursive === true ? { recursive: true } : {}),
          ...(options?.force === true ? { force: true } : {}),
          ...this.fileOptions(context),
        }),
      resolved.value,
      context,
    );
  }

  async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const aborted = abortResult<string>(context);
    if (aborted) return aborted;
    const created = await this.helperOp("mkdtemp", { prefix: prefix ?? "tmp-" }, context);
    return created.ok ? ok(created.value as string) : err(created.error);
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const aborted = abortResult<string>(context);
    if (aborted) return aborted;
    const created = await this.helperOp(
      "mktempfile",
      { prefix: options?.prefix, suffix: options?.suffix },
      context,
    );
    return created.ok ? ok(created.value as string) : err(created.error);
  }

  // --- FileSystem: teardown ---

  /** Best-effort: signals every launcher and unclosed reader this environment still tracks; each trap kills its process group. */
  async cleanup(_context: Context): Promise<void> {
    this.releaseTracked();
  }

  /**
   * Container-incarnation reset: signals and forgets every launcher and reader tracked against
   * the previous container and drops the cached home directory and startup environment. The
   * adapter outlives its container (a tool may hold it across a reset), but nothing learned
   * from a destroyed VM is reused.
   */
  resetIncarnation(): void {
    this.releaseTracked();
    this.homeDirPromise = undefined;
    this.containerEnvPromise = undefined;
  }

  private releaseTracked(): void {
    for (const root of this.activeRoots) root.kill(SIGTERM);
    this.activeRoots.clear();
    for (const reader of this.activeReaders) reader.kill();
    this.activeReaders.clear();
  }

  // --- Shell ---

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const timeoutMsResult = resolveTimeoutMs(options?.timeout);
    if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
    const timeoutMs = timeoutMsResult.value;

    // node.ts reaches the same failure via spawn() rejecting null-byte arguments.
    if (command.includes("\u0000")) {
      return err(new ExecutionError("spawn_error", "Command must be a string without null bytes"));
    }

    const cwd =
      options?.cwd === undefined
        ? this.cwd
        : await this.resolvePath(options.cwd, context).then((r) => (r.ok ? r.value : undefined));
    if (cwd === undefined) {
      return err(
        new ExecutionError("spawn_error", `Cannot resolve working directory: ${options?.cwd}`),
      );
    }

    let env: Record<string, string>;
    if (options?.inheritEnv === false) {
      env = { ...options.env };
    } else {
      // Container exec() delivers only the env passed here; the container's
      // own startup environment is the inheritable parent env. Requesting it
      // (the default) is a hard requirement: when it cannot be read, exec
      // fails instead of silently degrading to a PATH-only environment.
      const inherited = await this.containerEnv(context);
      if (!inherited.ok) {
        return err(
          new ExecutionError(
            "unknown",
            `Cannot inherit container environment: ${inherited.error.message}`,
            inherited.error,
          ),
        );
      }
      env = { ...inherited.value, ...options?.env };
    }

    let root: ExecProcess;
    try {
      root = await this.container.exec(buildExecLaunch(command, options?.timeout), {
        cwd,
        env,
        stdout: "pipe",
        // The launcher's own stderr is a dedicated control stream: it merges
        // the command's stderr into stdout (2>&1) and writes the watchdog
        // expiration record here, so command output can never forge it.
        stderr: "pipe",
      });
    } catch (error) {
      const cause = toError(error);
      return err(new ExecutionError("spawn_error", cause.message, cause));
    }
    this.activeRoots.add(root);

    const { promise, resolve: resolvePromise } =
      Promise.withResolvers<Result<ShellExecResult, ExecutionError>>();
    {
      let settled = false;
      let timedOut = false;
      let callbackError: ExecutionError | undefined;
      let spillError: ExecutionError | undefined;
      let watchdogFired = false;
      // Set when the stdout drain abandoned the stream on the post-exit idle
      // grace without reaching EOF: the output seen so far may be an
      // incomplete prefix and must not be reported as a successful exec.
      let abandonedOutput = false;
      const decoder = new TextDecoder();
      const spillPrefix: Uint8Array[] = [];
      let seenBytes = 0;
      let seenNewlines = 0;
      let spilling = false;
      let spillPath: string | undefined;
      let spillWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
      let spillProc: ExecProcess | undefined;
      let spillChain: Promise<void> = Promise.resolve();
      // The watchdog timer handle's type differs between runtimes (Workers
      // `number`, Node `Timeout`), so settle() cancels through a closure.
      let cancelTimeout: (() => void) | undefined;

      const settle = (result: Result<ShellExecResult, ExecutionError>) => {
        if (settled) return;
        settled = true;
        cancelTimeout?.();
        disarmIdle();
        signal?.removeEventListener("abort", onAbort);
        this.activeRoots.delete(root);
        resolvePromise(result);
      };
      const killRoot = () => {
        // The launcher's trap turns TERM into a group-wide KILL; a direct
        // SIGKILL here would orphan the command's descendants.
        root.kill(SIGTERM);
      };
      const onAbort = () => killRoot();
      const failCallback = (error: unknown) => {
        if (callbackError !== undefined) return;
        const cause = toError(error);
        callbackError = new ExecutionError("callback_error", cause.message, cause);
        killRoot();
      };
      const failSpill = (error: unknown) => {
        if (spillError !== undefined) return;
        const cause = toError(error);
        spillError = new ExecutionError(
          "unknown",
          `Failed to preserve complete shell output: ${cause.message}`,
          cause,
        );
        killRoot();
      };
      // No output reaches the caller after exec() settled.
      const emit = (text: string): void => {
        if (
          settled ||
          text === "" ||
          options?.onOutput === undefined ||
          callbackError !== undefined
        )
          return;
        try {
          options.onOutput(text, context);
        } catch (error) {
          failCallback(error);
        }
      };
      const writeSpillChunk = (chunk: Uint8Array): Promise<void> => {
        spillChain = spillChain.then(async () => {
          if (spillWriter === undefined || spillError !== undefined) return;
          try {
            await spillWriter.write(chunk);
          } catch (error) {
            failSpill(error);
          }
        });
        return spillChain;
      };
      const startSpill = async (): Promise<void> => {
        const created = await this.createTempFile(
          { prefix: "pi-output-", suffix: ".log" },
          context,
        );
        if (!created.ok) {
          failSpill(created.error);
          return;
        }
        spillPath = created.value;
        let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
        try {
          // `cat` owns the spill file for the command's lifetime; its stdin pipe
          // backpressures the command's output through the whole chain.
          const cat = await this.container.exec(
            ["bash", "-c", 'cat -- >> "$1"', "cat", spillPath],
            {
              stdin: "pipe",
              stdout: "ignore",
              stderr: "ignore",
            },
          );
          spillProc = cat;
          writer = cat.stdin?.getWriter() ?? undefined;
        } catch (error) {
          failSpill(error);
          return;
        }
        if (writer === undefined) {
          failSpill(new Error("Spill writer stdin is unavailable"));
          return;
        }
        spillWriter = writer;
      };
      const feedChunk = async (chunk: Uint8Array): Promise<void> => {
        emit(decoder.decode(chunk, { stream: true }));
        const spill = options?.spill;
        if (spill === undefined || chunk.length === 0) return;
        if (spilling) {
          await writeSpillChunk(chunk);
          return;
        }
        seenBytes += chunk.byteLength;
        for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1))
          seenNewlines++;
        const last = chunk.length > 0 ? chunk[chunk.length - 1] : undefined;
        const lines = seenNewlines + (last === 0x0a ? 0 : 1);
        if (seenBytes <= spill.afterBytes && lines <= spill.afterLines) {
          spillPrefix.push(chunk);
          return;
        }
        const pending = [...spillPrefix, chunk];
        spillPrefix.length = 0;
        spilling = true;
        await startSpill();
        for (const pendingChunk of pending) await writeSpillChunk(pendingChunk);
      };
      const finishSpill = async (): Promise<void> => {
        await spillChain;
        const writer = spillWriter;
        if (writer === undefined) return;
        try {
          await writer.close();
        } catch (error) {
          failSpill(error);
          return;
        }
        const code = spillProc === undefined ? undefined : await spillProc.exitCode.catch(() => -1);
        if (code !== undefined && code !== 0 && spillError === undefined) {
          failSpill(new Error(`Spill writer exited with code ${code}`));
        }
      };

      // Drain the combined stdout/stderr stream. After the launcher exits, an
      // idle grace stops the drain so a descendant holding the pipe cannot
      // hang exec() forever (node.ts does the same with its post-exit idle
      // timer). The grace resets on every received chunk and is suspended
      // while a chunk is being fed onward, so output still in flight is
      // drained instead of being truncated by an already-expired timer.
      let exited = false;
      let cancelIdle: (() => void) | undefined;
      let idlePromise: Promise<{ kind: "idle" }> | undefined;
      let idleResolve: ((value: { kind: "idle" }) => void) | undefined;
      const armIdle = (): void => {
        cancelIdle?.();
        // A fresh promise per arm: a previously fired idle promise must never
        // be reused, or a timer that expired during feedChunk backpressure
        // would resolve the next race immediately and abandon live output.
        const { promise, resolve } = Promise.withResolvers<{ kind: "idle" }>();
        idlePromise = promise;
        idleResolve = resolve;
        const timerId = setTimeout(() => {
          cancelIdle = undefined;
          idleResolve?.({ kind: "idle" });
        }, EXIT_STDIO_GRACE_MS);
        cancelIdle = () => clearTimeout(timerId);
      };
      const disarmIdle = (): void => {
        cancelIdle?.();
        cancelIdle = undefined;
      };
      // Exit notification for the drain loop. A read already outstanding
      // when the launcher exits cannot join a race started later, so the
      // exit must be observable to every pending read: a descendant holding
      // the pipe would otherwise block the loop beyond the post-exit grace.
      // The identical promise also arms the idle deadline before the
      // notification resolves, so any reader woken by it races against a
      // freshly armed grace.
      const exitNotice = root.exitCode.then(
        () => {
          exited = true;
          armIdle();
          return { kind: "exit" } as const;
        },
        () => {
          exited = true;
          armIdle();
          return { kind: "exit" } as const;
        },
      );

      // Set when the stdout transport itself fails: the output seen so far is
      // a truncated prefix, which must not be reported as a successful exec.
      let drainError: ExecutionError | undefined;
      // Set when the launcher's control transport fails: watchdog expiration
      // can then no longer be observed (the timeout metadata is lost), so the
      // exec must fail explicitly rather than risk reporting an unenforced
      // timeout as a success. A watchdog record received before the fault
      // still counts.
      let controlError: ExecutionError | undefined;
      const drain = async (): Promise<void> => {
        const stream = root.stdout;
        if (stream === null) return;
        const reader = stream.getReader();
        try {
          while (true) {
            const readPromise = reader.read().then((read) => ({ kind: "read" as const, read }));
            let raced:
              | { kind: "read"; read: ReadableStreamReadResult<Uint8Array> }
              | { kind: "exit" }
              | { kind: "idle" };
            if (exited && idlePromise !== undefined) {
              raced = await Promise.race([readPromise, idlePromise]);
            } else if (!exited) {
              // The root can exit while this read is outstanding. Race the
              // SAME outstanding read against the exit notice; when exit
              // wins, the identical read is then raced against the freshly
              // armed post-exit idle deadline. The pending read is neither
              // orphaned nor re-issued, so no chunk can be consumed twice
              // and no descendant holding the pipe can block past the grace.
              raced = await Promise.race([readPromise, exitNotice]);
              if (raced.kind === "exit") {
                raced =
                  idlePromise === undefined
                    ? await readPromise
                    : await Promise.race([readPromise, idlePromise]);
              }
            } else {
              raced = await readPromise;
            }
            if (raced.kind === "idle") {
              abandonedOutput = true;
              return;
            }
            if (raced.read.done) return;
            disarmIdle();
            await feedChunk(raced.read.value);
            if (exited) armIdle();
          }
        } catch (error) {
          // The container died or the transport failed while the command may
          // still be running: stop it and surface the truncation below.
          const cause = toError(error);
          drainError = new ExecutionError(
            "unknown",
            `Shell output stream failed: ${cause.message}`,
            cause,
          );
          killRoot();
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      };

      // Drains the launcher's control stream and records watchdog expiration.
      // The command's stderr is merged into stdout by the launcher itself, so
      // only the launcher and its (reaped-before-exit) watchdog subshell can
      // write here: the record is unforgeable. Its delivery, however, is
      // bounded only by the stream's own EOF — never by the root's exit —
      // so the post-exit grace below is an honest deadline, not an
      // EOF-equivalent.
      const watchControl = async (): Promise<void> => {
        const stream = root.stderr;
        if (stream === null) return;
        const reader = stream.getReader();
        const controlDecoder = new TextDecoder();
        let controlText = "";
        // Post-exit bound for an outstanding control read. The exit notice
        // alone cannot wake a read that is already outstanding on a stream
        // that never reaches EOF (a held write-end or runtime EOF lag would
        // otherwise hang Promise.all below past a true root exit). Created
        // once when the exit is first observed. Expiry abandons the read
        // without proof of EOF: a remote transport may deliver a buffered
        // record after this deadline, so abandonment is not EOF-equivalent —
        // unless a record was already seen, exec fails explicitly below.
        // A transport error still surfaces through the catch below.
        let postExitGrace: Promise<{ kind: "grace" }> | undefined;
        const graceAfterExit = (): Promise<{ kind: "grace" }> => {
          if (postExitGrace === undefined) {
            const { promise, resolve } = Promise.withResolvers<{ kind: "grace" }>();
            postExitGrace = promise;
            setTimeout(() => resolve({ kind: "grace" }), EXIT_STDIO_GRACE_MS);
          }
          return postExitGrace;
        };
        try {
          while (true) {
            // The SAME outstanding read is raced against the exit notice and
            // then against the post-exit grace — the read is never abandoned
            // and re-issued, so no record can be consumed twice or lost.
            const readPromise = reader.read().then((read) => ({ kind: "read" as const, read }));
            let raced:
              | { kind: "read"; read: ReadableStreamReadResult<Uint8Array> }
              | { kind: "exit" }
              | { kind: "grace" };
            if (exited) {
              raced = await Promise.race([readPromise, graceAfterExit()]);
            } else {
              raced = await Promise.race([readPromise, exitNotice]);
              if (raced.kind === "exit") {
                raced = await Promise.race([readPromise, graceAfterExit()]);
              }
            }
            if (raced.kind === "grace") {
              // The grace expired without EOF and without a transport error.
              // Abandonment is not proof the stream was empty — a buffered
              // record may still be in flight past this deadline — so the
              // watchdog metadata is unobservable. Fail explicitly rather
              // than report the bare exit status as a success; a record seen
              // earlier (or a Worker-timer expiry) still takes precedence
              // over this error in the settle ordering.
              if (!watchdogFired) {
                controlError = new ExecutionError(
                  "unknown",
                  "Shell control stream ended without EOF after the launcher exited; timeout metadata may be missing",
                );
              }
              return;
            }
            const { done, value } = raced.read;
            if (value !== undefined) {
              controlText += controlDecoder.decode(value, { stream: true });
              if (controlText.includes(WATCHDOG_EXPIRED_RECORD)) watchdogFired = true;
            }
            if (done) {
              controlText += controlDecoder.decode();
              if (controlText.includes(WATCHDOG_EXPIRED_RECORD)) watchdogFired = true;
              return;
            }
          }
        } catch (error) {
          // Control transport failed: the watchdog record can no longer be
          // observed, so in-container timeout metadata is lost. Stop the root
          // only if it is still running, and surface an explicit failure
          // below (with the output prefix seen so far preserved); a watchdog
          // record or Worker-timer expiry already observed still takes
          // precedence over this error.
          const cause = toError(error);
          controlError = new ExecutionError(
            "unknown",
            `Shell control stream failed: ${cause.message}`,
            cause,
          );
          if (!exited) killRoot();
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      };

      if (timeoutMs === undefined) {
        cancelTimeout = undefined;
      } else {
        const timerId = setTimeout(() => {
          timedOut = true;
          killRoot();
        }, timeoutMs);
        cancelTimeout = () => clearTimeout(timerId);
      }
      if (signal) {
        if (signal.aborted) killRoot();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      void Promise.all([drain(), watchControl()])
        .then(async () => {
          await finishSpill();
          emit(decoder.decode());
          const exitCode = await root.exitCode.catch((error: unknown) => {
            const cause = toError(error);
            settle(err(drainError ?? new ExecutionError("spawn_error", cause.message, cause)));
            return undefined;
          });
          if (exitCode === undefined) return; // already settled
          if (callbackError !== undefined) {
            settle(err(callbackError));
            return;
          }
          // Watchdog expiration is reported through the launcher's control
          // stream, never inferred from the command's exit status: a command
          // may legitimately exit 124 (or any code) before its deadline.
          if (timedOut || watchdogFired) {
            const timeoutError = new ExecutionError("timeout", `timeout:${options?.timeout}`);
            if (spillPath !== undefined) timeoutError.spillPath = spillPath;
            settle(err(timeoutError));
            return;
          }
          if (signal?.aborted) {
            const abortError = new ExecutionError("aborted", "aborted");
            if (spillPath !== undefined) abortError.spillPath = spillPath;
            settle(err(abortError));
            return;
          }
          if (spillError !== undefined) {
            settle(err(spillError));
            return;
          }
          if (drainError !== undefined) {
            settle(err(drainError));
            return;
          }
          if (controlError !== undefined) {
            // Lost watchdog metadata is never a success, whatever the
            // command's exit status (including 137 from an unobserved kill).
            if (spillPath !== undefined) controlError.spillPath = spillPath;
            settle(err(controlError));
            return;
          }
          if (abandonedOutput) {
            // The drain abandoned the stream on the post-exit idle grace
            // without EOF: neither a completed output nor a transport error
            // authorizes reporting success over possibly truncated output.
            const incomplete = new ExecutionError(
              "unknown",
              "Shell output stream ended without EOF after the launcher exited; output may be incomplete",
            );
            if (spillPath !== undefined) incomplete.spillPath = spillPath;
            settle(err(incomplete));
            return;
          }
          settle(ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) }));
        })
        .catch((error: Error) => {
          settle(err(new ExecutionError("unknown", error.message, error)));
        });
    }
    return await promise;
  }
}
