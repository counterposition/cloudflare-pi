// Workerd tests for SandboxExecutionEnv.exec control-stream handling.
//
// Each test drives the REAL production exec() drain and watchControl
// algorithms inside workerd against a structural test container whose stdio
// streams are controlled faulting streams (a consumer of the streams that
// fails the transport, never an echo forwarder): stdout deliveries, control
// (stderr) faults, exit codes, and kill behavior are all orchestrated by the
// test. This exercises the code paths the launcher's shell-level tests cannot:
// what exec() reports when the control transport itself dies.
//
// Runs in the Cloudflare Workers Vitest pool (workerd); the isolated fixture
// worker in test/wrangler.jsonc bootstraps the Workers globals the adapter
// needs. Importing the adapter here pulls @cloudflare/sandbox and its
// `cloudflare:*` imports, so the Node project must never include this file.
//
// No test-side wall-clock waits: stream faults are sequenced by the streams
// spec itself (error-on-pull fires only after the queued chunk was consumed;
// control-channel close is the fake launcher's exit). The only real time that
// elapses is production's own timers — the Worker exec deadline and the
// post-exit idle grace — whose bounded behavior is the subject under test.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { expect, describe, it } from "vitest";
import { SandboxExecutionEnv } from "../src/adapters/sandbox-env";
import { WATCHDOG_EXPIRED_RECORD } from "../src/adapters/sandbox-shell";

const context = BACKGROUND_CONTEXT;
const encoder = new TextEncoder();

interface TestProcessSpec {
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  stdin?: WritableStream<Uint8Array> | null;
  exitCode?: Promise<number>;
  onKill?: () => void;
}

/** Full structural ExecProcess: unexercised members are inert, not omitted. */
function makeProcess(spec: TestProcessSpec): ExecProcess {
  return {
    stdin: spec.stdin ?? null,
    stdout: spec.stdout ?? null,
    stderr: spec.stderr ?? null,
    pid: 1,
    isPty: false,
    exitCode: spec.exitCode ?? Promise.resolve(0),
    output: () =>
      Promise.resolve({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 0 }),
    kill: () => spec.onKill?.(),
    resize: () => undefined,
  };
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A transport that is already dead: every read rejects. */
function faultedStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(message));
    },
  });
}

function testContainer(dispatch: (argv: string[]) => ExecProcess): Pick<Container, "exec"> {
  return {
    exec: (argv: string[]) => Promise.resolve(dispatch(argv)),
  };
}

function collectOutput(): {
  chunks: string[];
  onOutput: (text: string) => void;
} {
  const chunks: string[] = [];
  return { chunks, onOutput: (text: string) => void chunks.push(text) };
}

describe("SandboxExecutionEnv.exec control-stream handling (workerd)", () => {
  it("fails explicitly, preserving spill and output prefix, when the control stream faults after full stdout", async () => {
    const spillPath = "/tmp/pi-output-control-fault.log";
    const rootProcess = makeProcess({
      stdout: streamOf(encoder.encode("hello from the command\n"), encoder.encode("second line\n")),
      stderr: faultedStream("control channel reset"),
      exitCode: Promise.resolve(0),
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      if (argv[0] !== undefined && argv[0].endsWith("fs-helper.mjs") && argv[1] === "mktempfile") {
        return makeProcess({
          stdout: streamOf(encoder.encode(JSON.stringify({ ok: true, value: spillPath }))),
        });
      }
      if (argv[3] === "cat") return makeProcess({ stdin: new WritableStream<Uint8Array>() });
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "control-fault" });
    const { chunks, onOutput } = collectOutput();

    const result = await env.exec(
      "true",
      { inheritEnv: false, onOutput, spill: { afterBytes: 0, afterLines: 0 } },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ExecutionError);
    expect(result.error.code).toBe("unknown");
    expect(result.error.message).toContain("Shell control stream failed");
    // The output spilled before the fault survives on the error.
    expect(result.error.spillPath).toBe(spillPath);
    // The consumer saw the complete stdout prefix before the failure.
    expect(chunks.join("")).toBe("hello from the command\nsecond line\n");
  });

  it("never reports success when watchdog metadata is lost to a control fault and the command exits 137", async () => {
    const rootProcess = makeProcess({
      stdout: streamOf(encoder.encode("partial output\n")),
      stderr: faultedStream("control channel reset"),
      exitCode: Promise.resolve(137),
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "control-fault-137" });

    const result = await env.exec("true", { inheritEnv: false }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown");
    expect(result.error.message).toContain("Shell control stream failed");
    expect(result.error.code).not.toBe("timeout");
    expect(result.error.spillPath).toBeUndefined();
  });

  it("reports an actual timeout when a recognized watchdog record precedes the control fault", async () => {
    // error-on-pull cannot fire before the first read: with the record
    // queued, desiredSize is 0, so pull only runs after the record has been
    // consumed — the fault then rejects the next read, deterministically.
    const rootProcess = makeProcess({
      stdout: streamOf(),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`${WATCHDOG_EXPIRED_RECORD}\n`));
        },
        pull(controller) {
          controller.error(new Error("control channel reset"));
        },
      }),
      exitCode: Promise.resolve(0),
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "watchdog-record" });

    const result = await env.exec("true", { inheritEnv: false }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
  });

  it("keeps a Worker-timer expiry reported as timeout when the control channel tears down with the process", async () => {
    const { promise: exitCode, resolve: resolveExit } = Promise.withResolvers<number>();
    let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const rootProcess = makeProcess({
      // Open and silent: the drain's outstanding read must be bounded by the
      // exit notification, not by stream EOF.
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
      exitCode,
      onKill: () => {
        resolveExit(137);
        stderrController?.error(new Error("control channel torn down"));
      },
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "timer-vs-control" });

    const result = await env.exec("sleep 30", { inheritEnv: false, timeout: 0.05 }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
    expect(result.error.message).toBe("timeout:0.05");
  });

  it("bounds a pending read left by an already-exited launcher as an explicit incomplete-output failure, not a hang", async () => {
    // Real Streams-spec sequencing: highWaterMark 0 disables autopull, so
    // each pull is triggered by a consumer read. The first pull supplies the
    // prefix; the second pull — which only runs after that prefix was
    // consumed and a second read is outstanding — leaves that read pending
    // and resolves the root's exit. The exit notification therefore always
    // races an ALREADY-outstanding read, deterministically, with no test-side
    // timer. Resolving exit from a closed stream's cancel hook is not an
    // option: cancel on a closed stream is a no-op and never fires.
    let pulls = 0;
    const { promise: exitCode, resolve: resolveExit } = Promise.withResolvers<number>();
    const rootProcess = makeProcess({
      stdout: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            if (pulls === 1) controller.enqueue(encoder.encode("partial\n"));
            // Second pull: never enqueue, never close — a descendant holds
            // the pipe after the launcher root has exited. The exit notice
            // alone must bound the outstanding read.
            else resolveExit(0);
          },
        },
        { highWaterMark: 0 },
      ),
      // The control channel closes independently of the root's exit, so
      // watchControl must not be what keeps the fixture alive.
      stderr: streamOf(),
      exitCode,
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "pending-read" });
    const { chunks, onOutput } = collectOutput();
    const startedAt = Date.now();

    const result = await env.exec("true", { inheritEnv: false, onOutput }, context);
    const elapsed = Date.now() - startedAt;

    // The exit notification raced an already-outstanding read: the producer
    // observed the consumer's second read trigger before it resolved exit 0.
    expect(pulls).toBe(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown");
    expect(result.error.message).toContain("output may be incomplete");
    // The consumer still received the prefix produced before the exit.
    expect(chunks.join("")).toBe("partial\n");
    // Bounded by the post-exit idle grace, not by the descendant's lifetime.
    expect(elapsed).toBeLessThan(5000);
  });

  it("fails explicitly when stdout reaches EOF and the launcher exits 137 while the control stream never closes", async () => {
    // The exit status must never be reinterpreted as a watchdog kill: with
    // the control stream still open and no record delivered, the timeout
    // metadata is unobservable, and grace abandonment is an explicit
    // failure — never a success and never a guessed timeout.
    const rootProcess = makeProcess({
      stdout: streamOf(encoder.encode("done\n")),
      // Open and silent: after the root's exit the outstanding control read
      // is bounded by the post-exit grace, which abandons it without EOF.
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      exitCode: Promise.resolve(137),
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "control-never-eof-137" });

    const result = await env.exec("true", { inheritEnv: false }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ExecutionError);
    expect(result.error.code).toBe("unknown");
    expect(result.error.code).not.toBe("timeout");
    expect(result.error.message).toContain("timeout metadata may be missing");
    expect(result.error.spillPath).toBeUndefined();
  });

  it("fails explicitly when the launcher exits 0 while the control stream never reaches EOF", async () => {
    // A clean exit is not EOF: without the stream's own close (or a record),
    // success cannot be reported — the watchdog metadata is unobservable.
    const rootProcess = makeProcess({
      stdout: streamOf(),
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      exitCode: Promise.resolve(0),
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "control-never-eof-zero" });

    const result = await env.exec("true", { inheritEnv: false }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown");
    expect(result.error.message).toContain("timeout metadata may be missing");
  });

  it("reports timeout when a watchdog record is delivered before the post-exit grace and the control stream never closes", async () => {
    // The record is queued before any read and the stream never closes: the
    // consumer observes the record, the root then exits 137, and the grace
    // abandons the follow-up read. The observed record still wins — the
    // outcome is timeout, never a success.
    const rootProcess = makeProcess({
      stdout: streamOf(),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`${WATCHDOG_EXPIRED_RECORD}\n`));
        },
      }),
      exitCode: Promise.resolve(137),
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "record-before-grace" });

    const result = await env.exec("true", { inheritEnv: false }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
  });

  it("treats a user exit code of 124 with an intact control stream as success, not a timeout", async () => {
    const rootProcess = makeProcess({
      stdout: streamOf(encoder.encode("user output\n")),
      stderr: streamOf(encoder.encode("launcher diagnostics\n")),
      exitCode: Promise.resolve(124),
    });
    const container = testContainer((argv) => {
      if (argv[0] === "bash" && argv[3] === "pi-exec") return rootProcess;
      throw new Error(`unexpected exec argv: ${argv.join(" ")}`);
    });
    const env = new SandboxExecutionEnv(container, { id: "user-124" });

    const result = await env.exec("true", { inheritEnv: false }, context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exitCode).toBe(124);
  });
});
