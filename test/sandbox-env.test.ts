// Real-process tests for the sandbox execution foundation:
// - container/fs-helper.mjs is spawned as an actual Node process and exercised
//   against the real filesystem (no fake container, no echoed output).
// - The exec launcher from src/adapters/sandbox-shell.ts is run under real
//   bash to verify combined output, timeout, and descendant cleanup semantics.
// - The line reader client holds a real helper session, so file identity,
//   open failures, and large multi-chunk streams are tested end to end.
// These tests need the node runtime (child_process), not the workers pool.
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath as realpathFs,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test } from "vitest";
import type { Context } from "@earendil-works/chord";
// The pure launcher/reader module: importing the sandbox adapter itself would
// pull `@cloudflare/sandbox` (and its `cloudflare:*` imports) into Node.
import {
  WATCHDOG_EXPIRED_RECORD,
  HelperTextLineReader,
  buildExecLaunch,
  type ShellProcess,
} from "../src/adapters/sandbox-shell";

const HELPER = fileURLToPath(new URL("../container/fs-helper.mjs", import.meta.url));

interface HelperFailure {
  ok: false;
  code: string;
  message: string;
  path?: string;
}

interface TestProcess {
  code: number | null;
  stdout: string;
}

function runHelper(
  op: string,
  args: unknown,
  stdin?: Uint8Array,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [HELPER, op, args === undefined ? "{}" : JSON.stringify(args)],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  const stdoutDecoder = new TextDecoder();
  child.stdout.on("data", (chunk: Uint8Array) => {
    stdout += stdoutDecoder.decode(chunk, { stream: true });
  });
  let stderr = "";
  const stderrDecoder = new TextDecoder();
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderr += stderrDecoder.decode(chunk, { stream: true });
  });
  const { promise, resolve, reject } = Promise.withResolvers<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>();
  child.on("error", reject);
  child.on("close", (code) => {
    resolve({
      exitCode: code,
      stdout: stdout + stdoutDecoder.decode(),
      stderr: stderr + stderrDecoder.decode(),
    });
  });
  if (stdin === undefined) {
    child.stdin.end();
  } else {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  return promise;
}

async function runHelperOk(op: string, args: unknown, stdin?: Uint8Array): Promise<unknown> {
  const { exitCode, stdout, stderr } = await runHelper(op, args, stdin);
  if (exitCode !== 0) {
    throw new Error(`helper ${op} exited ${exitCode}: ${stderr}`);
  }
  const parsed = JSON.parse(stdout) as { ok: boolean; value?: unknown } & Partial<HelperFailure>;
  if (!parsed.ok) {
    throw new Error(`helper ${op} failed: ${JSON.stringify(parsed)}`);
  }
  return parsed.value;
}

// buildExecLaunch already names the executable in argv[0]: spawn it once. An
// extra outer executable argument makes bash treat argv[1] as a script file
// (observed as exit 126), so every launcher test goes through this helper.
function spawnLauncher(argv: string[], cwd?: string) {
  const [exe, ...args] = argv;
  if (exe === undefined) throw new Error("launcher argv must name an executable");
  return spawn(exe, args, {
    ...(cwd === undefined ? {} : { cwd }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runLauncher(
  command: string,
  timeoutSeconds: number | undefined,
  cwd?: string,
): Promise<TestProcess & { stderr: string }> {
  const child = spawnLauncher(buildExecLaunch(command, timeoutSeconds), cwd);
  let stdout = "";
  const stdoutDecoder = new TextDecoder();
  child.stdout.on("data", (chunk: Uint8Array) => {
    stdout += stdoutDecoder.decode(chunk, { stream: true });
  });
  let stderr = "";
  const stderrDecoder = new TextDecoder();
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderr += stderrDecoder.decode(chunk, { stream: true });
  });
  const { promise, resolve, reject } = Promise.withResolvers<TestProcess & { stderr: string }>();
  child.on("error", reject);
  child.on("close", (code) =>
    resolve({
      code,
      stdout: stdout + stdoutDecoder.decode(),
      stderr: stderr + stderrDecoder.decode(),
    }),
  );
  return promise;
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("append stores binary content containing quotes, newlines, and unicode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "report's\"quote\nline.txt");
  const content = new TextEncoder().encode("line 'single' \"double\" \\\nnext – üm👀\ttab");
  await runHelperOk("append", { path }, content);
  expect(new Uint8Array(await readFile(path))).toEqual(content);
});

test("append concatenates to existing content and round-trips via readat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "log.txt");
  await writeFile(path, "first\n");
  await runHelperOk("append", { path }, new TextEncoder().encode("second\n"));
  const data = (await runHelperOk("readat", { path, offset: 0, length: 1024 })) as {
    data: string;
    eof: boolean;
  };
  expect(new TextDecoder().decode(new Uint8Array(Buffer.from(data.data, "base64")))).toBe(
    "first\nsecond\n",
  );
});

test("readat returns bounded chunks and advances to eof by offset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "blob.bin");
  const original = new Uint8Array(100_000);
  for (let index = 0; index < original.length; index++) original[index] = index % 251;
  await writeFile(path, original);

  const pieces: number[] = [];
  let offset = 0;
  let eof = false;
  while (!eof) {
    const chunk = (await runHelperOk("readat", { path, offset, length: 4096 })) as {
      data: string;
      eof: boolean;
    };
    pieces.push(...Buffer.from(chunk.data, "base64"));
    eof = chunk.eof;
    offset += 4096;
  }
  expect(new Uint8Array(pieces)).toEqual(original);
});

test("truncate shrinks and extends with NUL padding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "file.bin");
  await writeFile(path, "abcdefghij");
  await runHelperOk("truncate", { path, size: 4 });
  expect((await readFile(path)).toString()).toBe("abcd");
  await runHelperOk("truncate", { path, size: 8 });
  const extended = await readFile(path);
  expect(extended.byteLength).toBe(8);
  expect(extended.subarray(4)).toEqual(Buffer.alloc(4));
});

test("fsync succeeds on an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "file.bin");
  await writeFile(path, "data");
  await runHelperOk("fsync", { path });
});

test("realpath resolves symlinks and canonicalizes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  await mkdir(join(dir, "real"));
  await symlink(join(dir, "real"), join(dir, "link"));
  const value = await runHelperOk("realpath", { path: join(dir, "link", "..", "link") });
  expect(value).toBe(await realpathFs(join(dir, "real")));
});

test("realpath reports ENOENT for missing paths", async () => {
  const { stdout } = await runHelper("realpath", {
    path: join(tmpdir(), "cfpi-missing-xyz", "file"),
  });
  const parsed = JSON.parse(stdout) as HelperFailure;
  expect(parsed.ok).toBe(false);
  expect(parsed.code).toBe("ENOENT");
});

test("mkdtemp and mktempfile create real temp entries", async () => {
  const dir = (await runHelperOk("mkdtemp", { prefix: "custom-" })) as string;
  expect(dir).toContain("custom-");
  await expect(stat(dir)).resolves.toBeDefined();
  const file = (await runHelperOk("mktempfile", { prefix: "out-", suffix: ".log" })) as string;
  expect(file.endsWith(".log")).toBe(true);
  expect((await readFile(file)).byteLength).toBe(0);
});

test("listdir returns names, kinds, and sizes; missing dir is ENOENT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  await writeFile(join(dir, "a.txt"), "12345");
  await mkdir(join(dir, "sub"));
  const rows = (await runHelperOk("listdir", { path: dir })) as Array<{
    name: string;
    kind: string;
    size: number;
  }>;
  expect(rows).toHaveLength(2);
  const byName = new Map(rows.map((row) => [row.name, row]));
  expect(byName.get("a.txt")).toMatchObject({ kind: "file", size: 5 });
  expect(byName.get("sub")).toMatchObject({ kind: "directory" });

  const missing = await runHelper("listdir", { path: join(dir, "nope") });
  expect(missing.exitCode).toBe(0);
  const parsed = JSON.parse(missing.stdout) as HelperFailure;
  expect(parsed.ok).toBe(false);
  expect(parsed.code).toBe("ENOENT");
});

test("append into a missing parent reports ENOENT; unwritable file reports EACCES", async () => {
  const missing = await runHelper("append", { path: join(tmpdir(), "cfpi-no-such-dir-xyz", "f") });
  const missingParsed = JSON.parse(missing.stdout) as HelperFailure;
  expect(missingParsed.ok).toBe(false);
  expect(missingParsed.code).toBe("ENOENT");

  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const locked = join(dir, "locked.txt");
  await writeFile(locked, "x");
  await chmod(locked, 0o000);
  try {
    const denied = await runHelper("append", { path: locked }, new TextEncoder().encode("nope"));
    const deniedParsed = JSON.parse(denied.stdout) as HelperFailure;
    expect(deniedParsed.ok).toBe(false);
    if (isRoot) {
      // Root ignores permission bits; the write succeeds by design.
      expect(deniedParsed.ok).toBe(true);
    } else {
      expect(["EACCES", "EPERM"]).toContain(deniedParsed.code);
    }
  } finally {
    await chmod(locked, 0o644);
  }
});

test("hostile file names survive the protocol without injection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  // One valid path component — no "/", which would denote a nested path —
  // carrying quotes, spaces, a semicolon, a tilde, a substitution, and a
  // newline. The name is data on the JSON argv; none of it may execute.
  const hostile = 'we\'rd "name" ; rm -rf ~ \n$(boom).txt';
  const path = join(dir, hostile);
  await runHelperOk("append", { path }, new TextEncoder().encode("payload"));
  const rows = (await runHelperOk("listdir", { path: dir })) as Array<{
    name: string;
    size: number;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe(hostile);
  expect(rows[0]?.size).toBe(7);
  // No injected command marker: the stored payload is exactly the appended bytes.
  const stored = (await runHelperOk("readat", { path, offset: 0, length: 64 })) as {
    data: string;
  };
  expect(new TextDecoder().decode(new Uint8Array(Buffer.from(stored.data, "base64")))).toBe(
    "payload",
  );
});

test("unknown operation and malformed arguments are protocol failures", async () => {
  const unknown = await runHelper("does-not-exist", {});
  expect(unknown.exitCode).not.toBe(0);
  expect((JSON.parse(unknown.stdout) as HelperFailure).code).toBe("PROTOCOL");

  const malformed = spawn(process.execPath, [HELPER, "append", "{not json}"]);
  let stdout = "";
  const malformedDecoder = new TextDecoder();
  malformed.stdout.on("data", (chunk: Uint8Array) => {
    stdout += malformedDecoder.decode(chunk, { stream: true });
  });
  const { promise: code, resolve: gotClose } = Promise.withResolvers<number | null>();
  malformed.on("close", gotClose);
  expect(await code).not.toBe(0);
  expect((JSON.parse(stdout) as HelperFailure).code).toBe("PROTOCOL");
});

test("launcher streams combined output and propagates the exit code", async () => {
  const { code, stdout } = await runLauncher(
    "printf 'to stdout\\n'; printf 'to stderr\\n' >&2; exit 3",
    undefined,
  );
  expect(code).toBe(3);
  expect(stdout).toBe("to stdout\nto stderr\n");
});

test("launcher runs the command in the requested cwd with the command as data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-cwd-"));
  // Proof of the working directory itself: a relative write must land in the
  // requested directory resolved to its canonical spelling (on macOS tmpdir()
  // is a /var symlink, and `pwd` spelling is incidental).
  const { code } = await runLauncher("printf data > marker.txt", undefined, dir);
  expect(code).toBe(0);
  const canonical = await realpathFs(dir);
  expect(new Uint8Array(await readFile(join(canonical, "marker.txt")))).toEqual(
    new TextEncoder().encode("data"),
  );
});

test("launcher SIGTERM stops the command and its descendants", async () => {
  const child = spawnLauncher(buildExecLaunch('sleep 30 & echo "$!"; wait "$!"', undefined));
  let stdout = "";
  const stdoutDecoder = new TextDecoder();
  child.stdout.on("data", (chunk: Uint8Array) => {
    stdout += stdoutDecoder.decode(chunk, { stream: true });
  });
  try {
    // The pid arrives with the command's first output chunk.
    const { promise: firstChunk, resolve: gotFirstChunk } = Promise.withResolvers<void>();
    const onFirstChunk = (chunk: Buffer): void => {
      if (chunk.toString().trim() !== "") {
        child.stdout.off("data", onFirstChunk);
        gotFirstChunk();
      }
    };
    child.stdout.on("data", onFirstChunk);
    await firstChunk;
    const descendantPid = Number.parseInt(stdout.trim(), 10);
    expect(Number.isInteger(descendantPid)).toBe(true);

    child.kill("SIGTERM"); // kill() reaches only the launcher root, like Container exec kill
    const { promise: closeCode, resolve: gotClose } = Promise.withResolvers<number | null>();
    child.on("close", gotClose);
    const [code, descendantAlive] = await Promise.all([
      closeCode,
      (async () => {
        // Integration test against the OS: a foreign pid's death has no event
        // source, so poll kill(pid, 0) on the platform clock until it is gone.
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            process.kill(descendantPid, 0);
          } catch {
            return false;
          }
          const { promise: tick, resolve: tickResolve } = Promise.withResolvers<void>();
          setTimeout(tickResolve, 50);
          await tick;
        }
        return true;
      })(),
    ]);
    expect(code).not.toBeNull();
    expect(descendantAlive).toBe(false);
  } finally {
    // Never leak the sleep tree when an assertion fails before the kill.
    child.kill("SIGTERM");
  }
});

test("launcher watchdog terminates the command and its descendants and reports the timeout", async () => {
  // The watchdog must be forked only after the command pid exists: it kills
  // the group (regression: a zero pid made it a no-op) and expiration is
  // reported as a control record on the launcher's own stderr, never as a
  // repinned exit status.
  const child = spawnLauncher(buildExecLaunch('sleep 30 & echo "$!"; wait "$!"', 1));
  let stdout = "";
  const stdoutDecoder = new TextDecoder();
  child.stdout.on("data", (chunk: Uint8Array) => {
    stdout += stdoutDecoder.decode(chunk, { stream: true });
  });
  let stderr = "";
  const stderrDecoder = new TextDecoder();
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderr += stderrDecoder.decode(chunk, { stream: true });
  });
  try {
    // The pid arrives with the command's first output chunk.
    const { promise: firstChunk, resolve: gotFirstChunk } = Promise.withResolvers<void>();
    const onFirstChunk = (chunk: Buffer): void => {
      if (chunk.toString().trim() !== "") {
        child.stdout.off("data", onFirstChunk);
        gotFirstChunk();
      }
    };
    child.stdout.on("data", onFirstChunk);
    await firstChunk;
    const descendantPid = Number.parseInt(stdout.trim(), 10);
    expect(Number.isInteger(descendantPid)).toBe(true);

    const started = Date.now();
    const { promise: closeCode, resolve: gotClose } = Promise.withResolvers<number | null>();
    child.on("close", gotClose);
    const code = await closeCode;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    // The in-container watchdog reported its own expiration on the control
    // stream; the killed command's signal status stays on the exit code.
    expect(code).not.toBe(0);
    expect(stderr).toContain(WATCHDOG_EXPIRED_RECORD);
    // The record is a control-stream marker only: it must never leak into the
    // combined output pipe, and the output the command produced before the
    // watchdog killed the group (the descendant pid line) is still delivered.
    expect(stdout).toContain(String(descendantPid));
    expect(stdout).not.toContain(WATCHDOG_EXPIRED_RECORD);
    // The in-container watchdog killed the whole group, not just the launcher.
    // Integration test against the OS: a foreign pid's death has no event
    // source, so poll kill(pid, 0) on the platform clock until it is gone —
    // deterministic fake timers cannot observe an external process.
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        process.kill(descendantPid, 0);
      } catch {
        return;
      }
      const { promise: tick, resolve: tickResolve } = Promise.withResolvers<void>();
      setTimeout(tickResolve, 50);
      await tick;
    }
    throw new Error("watchdog left the descendant alive after the timeout");
  } finally {
    // Never leak the sleep tree when an assertion fails before the poll.
    child.kill("SIGTERM");
  }
});

test("launcher passes a command's own exit code through unchanged", async () => {
  // 124 is a legal command status, not proof of a timeout.
  const { code } = await runLauncher("exit 124", undefined);
  expect(code).toBe(124);
});

test("a command's own 124 with a timeout armed is not a watchdog expiration", async () => {
  // The watchdog never fired (the command finished well before the deadline),
  // so no control record may be emitted and the exit code passes through: the
  // consumer classifies expiration from the control stream only.
  const { code, stdout, stderr } = await runLauncher("exit 124", 5);
  expect(code).toBe(124);
  expect(stdout).not.toContain(WATCHDOG_EXPIRED_RECORD);
  expect(stderr).not.toContain(WATCHDOG_EXPIRED_RECORD);
});

test("watchdog record reaches the control stream across repeated real expiry timings", async () => {
  // Ordering-race counterfactual: the launcher reaps the killed command the
  // moment the group dies and immediately terminates the watchdog group, so
  // the record must already sit in the control-stream pipe at that instant.
  // Real process scheduling varies run to run; exercising a bounded spread of
  // deadlines against real bash must deliver the record on stderr, never on
  // stdout, preserve the output produced before the kill, and pass the killed
  // status through on every run.
  for (const timeoutSeconds of [0.2, 0.35, 0.5, 0.75, 1]) {
    const { code, stdout, stderr } = await runLauncher("printf 'pre\\n'; sleep 30", timeoutSeconds);
    expect(stderr).toContain(WATCHDOG_EXPIRED_RECORD);
    expect(stdout).not.toContain(WATCHDOG_EXPIRED_RECORD);
    expect(stdout).toContain("pre");
    expect(code).not.toBe(0);
  }
}, 30_000);

// --- Line reader sessions over a retained helper-side descriptor ---

const testContext: Context = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "test-context",
};

// Spawns a real fs-helper `reader` session and exposes it as the structural
// process shape the pure reader client depends on: web streams bridged over
// child_process streams, and an exit promise that mirrors the Workers
// ExecProcess (resolves on a normal exit, rejects when killed by a signal).
function spawnReaderSession(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<ShellProcess> {
  const child = spawn(process.execPath, [HELPER, "reader", JSON.stringify({ path })], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      child.stdout.on("end", () => controller.close());
      child.stdout.on("error", (error: Error) => controller.error(error));
    },
  });
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      child.stdin.write(chunk, (error) => (error === null ? resolve() : reject(error)));
      return promise;
    },
    close() {
      child.stdin.end();
    },
    abort() {
      child.stdin.destroy();
    },
  });
  const { promise: exitCode, resolve: exited, reject: failed } = Promise.withResolvers<number>();
  child.on("close", (code, signal) => {
    if (code !== null) exited(code);
    else failed(new Error(`reader killed by signal ${signal}`));
  });
  child.on("error", failed);
  return Promise.resolve({
    stdin,
    stdout,
    exitCode,
    kill: (signal?: number) => child.kill(signal),
  });
}

async function openReader(path: string): Promise<HelperTextLineReader> {
  const opened = await HelperTextLineReader.open(
    (options) => spawnReaderSession(path, options),
    path,
    testContext,
  );
  if (!opened.ok) throw new Error(`reader open failed: ${opened.error.message}`);
  return opened.value;
}

// Scripted ShellProcess double standing in for one helper reader session: it
// performs the real open handshake, records each request's offset, and answers
// requests from a recorded response plan. An entry may abort a context at
// response-delivery time, which isolates the client's consume-and-commit
// ordering at the consumer boundary without timing races.
function scriptedReaderSession(
  responses: Array<{ text: string; eof: boolean; abortOnDelivery?: AbortController }>,
): ShellProcess & { requestOffsets: number[] } {
  const requestOffsets: number[] = [];
  let next = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      // The open handshake the reader client expects.
      streamController.enqueue(encoder.encode('{"ok":true,"value":null}\n'));
    },
  });
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      const request = JSON.parse(new TextDecoder().decode(chunk)) as { offset: number };
      requestOffsets.push(request.offset);
      const response = responses[next];
      if (response === undefined) throw new Error("scripted session exhausted its responses");
      next += 1;
      controller?.enqueue(
        encoder.encode(
          `{"ok":true,"value":{"data":"${Buffer.from(response.text, "utf8").toString("base64")}","eof":${response.eof}}}\n`,
        ),
      );
      response.abortOnDelivery?.abort();
    },
    close() {},
    abort() {},
  });
  return {
    stdin,
    stdout,
    exitCode: Promise.resolve(0),
    kill: () => undefined,
    requestOffsets,
  };
}

test("line reader fails at open for a missing path", async () => {
  const missing = join(tmpdir(), "cfpi-missing-xyz", "file");
  const opened = await HelperTextLineReader.open(
    (options) => spawnReaderSession(missing, options),
    missing,
    testContext,
  );
  expect(opened.ok).toBe(false);
  if (!opened.ok) expect(opened.error.code).toBe("not_found");
});

test("line reader streams a large file across bounded chunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "large.log");
  const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index} ${"x".repeat(20)}`);
  await writeFile(path, `${lines.join("\n")}\n`);

  const reader = await openReader(path);
  const collected: string[] = [];
  while (true) {
    const line = await reader.readLine(testContext);
    expect(line.ok).toBe(true);
    if (!line.ok) return;
    if (line.value === undefined) break;
    collected.push(line.value.text);
  }
  expect(collected).toEqual(lines);
  await reader.close(testContext);
});

test("line reader keeps the original file identity across rename and replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "log.txt");
  await writeFile(path, "one\ntwo\nthree\n");

  const reader = await openReader(path);
  const first = await reader.readLine(testContext);
  if (!first.ok || first.value === undefined) throw new Error("expected the first line");
  expect(first.value.text).toBe("one");

  // Swap the path's inode for different content while the reader holds the
  // original descriptor: the stream must keep coming from the opened file.
  await rename(path, join(dir, "moved.txt"));
  await writeFile(path, "XX\nYY\n");

  const second = await reader.readLine(testContext);
  const third = await reader.readLine(testContext);
  const end = await reader.readLine(testContext);
  expect(second.ok && second.value?.text).toBe("two");
  expect(third.ok && third.value?.text).toBe("three");
  expect(end.ok && end.value).toBeUndefined();
  await reader.close(testContext);
});

test("line reader keeps reading after the path is unlinked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "gone.txt");
  await writeFile(path, "a\nb\n");

  const reader = await openReader(path);
  const first = await reader.readLine(testContext);
  expect(first.ok && first.value?.text).toBe("a");

  await unlink(path);
  const second = await reader.readLine(testContext);
  const end = await reader.readLine(testContext);
  expect(second.ok && second.value?.text).toBe("b");
  expect(end.ok && end.value).toBeUndefined();
  await reader.close(testContext);
});

test("line reader close reaps the helper process and rejects further reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "closed.txt");
  await writeFile(path, "a\nb\n");

  const reader = await openReader(path);
  await reader.close(testContext); // close awaits the helper's exit
  const afterClose = await reader.readLine(testContext);
  expect(afterClose.ok).toBe(false);
  if (!afterClose.ok) expect(afterClose.error.code).toBe("invalid");
  await expect(reader.close(testContext)).resolves.toBeUndefined(); // idempotent
});

test("line reader serializes concurrent readLine calls over one session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "serial.txt");
  await writeFile(path, "a\nb\nc\n");

  const reader = await openReader(path);
  // Both calls race: the retained session answers one request at a time, and
  // the client must serialize whole operations so offsets cannot double-book.
  const [first, second] = await Promise.all([
    reader.readLine(testContext),
    reader.readLine(testContext),
  ]);
  expect(first.ok && first.value?.text).toBe("a");
  expect(second.ok && second.value?.text).toBe("b");
  const third = await reader.readLine(testContext);
  expect(third.ok && third.value?.text).toBe("c");
  const end = await reader.readLine(testContext);
  expect(end.ok && end.value).toBeUndefined();
  await reader.close(testContext);
});

test("line reader retains a chunk delivered around an abort and retries without skipping", async () => {
  const content = "one\ntwo\nthree\n";
  const controller = new AbortController();
  const session = scriptedReaderSession([
    { text: content, eof: false, abortOnDelivery: controller },
    { text: "", eof: true },
  ]);
  const opened = await HelperTextLineReader.open(
    () => Promise.resolve(session),
    "scripted://retained.log",
    testContext,
  );
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const reader = opened.value;

  // The abort fires as the response chunk is delivered: the response must be
  // consumed and its bytes committed with the offset before the error returns.
  const aborted = await reader.readLine({ ...testContext, abortSignal: controller.signal });
  expect(aborted.ok).toBe(false);
  if (aborted.ok) return;
  expect(aborted.error.code).toBe("aborted");

  // Retry with a fresh context: buffered lines come back in order, no bytes
  // are skipped, and no stale response is consumed from the FIFO.
  const fresh = { ...testContext, abortSignal: new AbortController().signal };
  const first = await reader.readLine(fresh);
  expect(first.ok && first.value?.text).toBe("one");
  const second = await reader.readLine(fresh);
  expect(second.ok && second.value?.text).toBe("two");
  const third = await reader.readLine(fresh);
  expect(third.ok && third.value?.text).toBe("three");
  const end = await reader.readLine(fresh);
  expect(end.ok && end.value).toBeUndefined();
  expect(session.requestOffsets).toEqual([0, new TextEncoder().encode(content).length]);
  await reader.close(fresh);
});

test("line reader keeps protocol framing separate from multi-byte file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfpi-test-"));
  const path = join(dir, "boundary.log");
  // One line spanning the 64-KiB read boundary whose final multi-byte
  // character is split across file chunks: the pending UTF-8 state of the
  // file stream must not flush into the helper's next JSON protocol frame.
  await writeFile(path, `${"a".repeat(65_535)}é\nafter\n`);

  const reader = await openReader(path);
  const first = await reader.readLine(testContext);
  expect(first.ok && first.value?.text).toBe(`${"a".repeat(65_535)}é`);
  const second = await reader.readLine(testContext);
  expect(second.ok && second.value?.text).toBe("after");
  const end = await reader.readLine(testContext);
  expect(end.ok && end.value).toBeUndefined();
  await reader.close(testContext);
});

// --- Container environment snapshot ---

test("container-env responds with a well-formed availability snapshot", async () => {
  const value = (await runHelperOk("container-env", {})) as {
    available: boolean;
    env: Record<string, string>;
  };
  // macOS test runners have no /proc/1/environ (available:false); Linux CI
  // reports the init environment decoded as UTF-8.
  expect(typeof value.available).toBe("boolean");
  expect(typeof value.env).toBe("object");
  for (const entry of Object.values(value.env)) expect(typeof entry).toBe("string");
});
