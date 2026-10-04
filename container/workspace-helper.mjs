#!/usr/bin/env node
// workspace-helper: bounded writer quiescence before workspace archive/restore.
//
// Before the Workers side archives /workspace/project into R2 or restores a
// checkpoint over it, every Linux writer left behind by tool commands must be
// gone. Neither a completed exec() nor an idle harness proves that: background
// jobs, `nohup`/disowned writers, and processes that escaped their process
// group keep running as orphans. This helper sweeps /proc directly, signals
// every remaining user process by PID (never through a shell, never via pgrep
// string matching), waits bounded intervals between SIGTERM and SIGKILL, and
// rechecks until no non-zombie writer remains. If it cannot establish
// quiescence it fails loudly instead of guessing.
//
// Refusal contract: this process may only run inside the session container's
// isolated PID namespace. It verifies that it is on Linux, that PID 1 lives in
// the same PID namespace, and that PID 1 is the controlled image entry from
// this repository's Dockerfile (CMD ["sleep","infinity"], or the platform's
// sandbox-shim supervisor binary shipped into the image). The entry is matched
// by structured argv semantics, not by argv[0] spelling: under user-space
// emulation (Linux-on-Linux via a binfmt interpreter) /proc/1/cmdline reports
// the interpreter's own argv, [<interpreter tag>, <guest executable path>,
// ...guest argv] — observed for this image as
// ["[qemu]","/usr/bin/sleep","sleep","infinity"] — and the truthful guest
// command line is recovered from that structure. A live process can only
// carry that shape through interpreter layering: any real exec() rewrites
// argv, so wrapper forms like `bash -c 'sleep infinity'` (one argv element)
// never satisfy the signature. On a developer host or CI runner PID 1 is the
// OS init, so the helper refuses there before it inspects or signals
// anything; every refusal exits 1 and kills nothing.
//
// Protocol (mirrors fs-helper.mjs): one JSON document on stdout:
//   {"ok":true,"value":...}
//   {"ok":false,"code":"...","message":"..."}
// The `check` op runs only the isolation verification (no signals, no sweep);
// `quiesce` verifies isolation and then sweeps.
import { readdir, readFile, readlink } from "node:fs/promises";

// Round plan: SIGTERM first so well-behaved writers can flush, then SIGKILL,
// then a final verification pass. Newly spawned orphans are re-collected on
// every round; if any non-zombie writer survives the plan, quiescence failed.
const SWEEP_ROUNDS = 3;
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

// Controlled PID 1 entries for this image. The Dockerfile's CMD is
// ["sleep","infinity"]; cloudflare/sandbox's supervisor binary may legally run
// as PID 1 depending on the platform runtime. Anything else is not ours.
const CONTROLLED_INIT_BASENAMES = new Set(["sandbox-shim"]);

class RefusalError extends Error {}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function succeed(value) {
  respond({ ok: true, value });
}

// `code` is REFUSED for isolation preconditions, QUIESCE_FAILED when writers
// survived the sweep, or UNKNOWN for unexpected faults. Any ok:false answer
// sets a failing exit status so the exit code can never contradict the JSON.
function fail(code, message) {
  process.exitCode = 1;
  respond({ ok: false, code, message });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function basenameOf(entry) {
  return entry.slice(entry.lastIndexOf("/") + 1);
}

// The controlled image's exact entry command line: ["sleep","infinity"].
// argv[0] is matched by basename, not literal spelling.
function isSleepInfinity(args) {
  return args.length === 2 && basenameOf(args[0]) === "sleep" && args[1] === "infinity";
}

// The kernel convention for a user-space interpreter (binfmt) layer: argv[0]
// is an opaque bracketed interpreter marker (observed "[qemu]" for this
// image), argv[1] is the real guest executable path, and the rest is the
// guest's own argv. The marker is classified structurally — never by string
// content — and the guest executable must agree with the guest argv: a live
// /proc cmdline can only carry this shape through interpreter layering, since
// any real exec() replaces argv wholesale. Wrapper forms therefore cannot be
// smuggled through: `bash -c 'sleep infinity'` reports
// ["bash","-c","sleep infinity"] (single element, wrong guest argv), and
// `sh -c 'exec sleep infinity'` reports the shell's argv until the exec
// replaces it.
function isInterpreterTagged(argv) {
  return (
    argv.length >= 3 &&
    /^\[.+\]$/.test(argv[0]) &&
    argv[1].startsWith("/") &&
    basenameOf(argv[1]) === argv[2]
  );
}

function isControlledInit(argv) {
  if (argv.length === 0) return false;
  // Native: PID 1 is the entry itself, reported as its own argv.
  if (isSleepInfinity(argv)) return true;
  if (CONTROLLED_INIT_BASENAMES.has(basenameOf(argv[0]))) return true;
  // Emulated: recover the guest command line from the structured argv and
  // require the exact controlled signature for it.
  if (isInterpreterTagged(argv)) {
    const guestArgv = argv.slice(2);
    if (isSleepInfinity(guestArgv)) return true;
    if (CONTROLLED_INIT_BASENAMES.has(basenameOf(guestArgv[0]))) return true;
  }
  return false;
}

// Isolation preconditions. Any failure is a refusal: the helper must never
// signal host processes on a hunch that it is inside the container.
async function verifyIsolation() {
  if (process.platform !== "linux") {
    throw new RefusalError(`refusing: helper requires Linux, running on ${process.platform}`);
  }
  if (process.pid === 1) {
    throw new RefusalError("refusing: helper must not run as PID 1");
  }
  let nsInit;
  let nsSelf;
  try {
    [nsInit, nsSelf] = await Promise.all([
      readlink("/proc/1/ns/pid"),
      readlink("/proc/self/ns/pid"),
    ]);
  } catch (error) {
    throw new RefusalError(`refusing: cannot read PID namespaces from /proc: ${messageOf(error)}`);
  }
  if (nsInit !== nsSelf) {
    throw new RefusalError("refusing: PID 1 is outside the helper's PID namespace");
  }
  let argv;
  try {
    const raw = await readFile("/proc/1/cmdline", "utf8");
    argv = raw.split("\0").filter((entry) => entry !== "");
  } catch (error) {
    throw new RefusalError(`refusing: cannot read /proc/1/cmdline: ${messageOf(error)}`);
  }
  if (!isControlledInit(argv)) {
    throw new RefusalError(
      `refusing: PID 1 is not the controlled image entry: ${JSON.stringify(argv)}`,
    );
  }
}

// Reads /proc/<pid>/stat; returns undefined ONLY when the process vanished
// between directory listing and read (ENOENT/ESRCH) — that is progress toward
// quiescence, never evidence of it. Every other read error propagates: an
// unreadable or malformed stat must never be silently treated as absent, or a
// permission failure would falsely establish quiescence. comm (field 2) may
// contain spaces and parens, so the state field is parsed after the LAST ')'.
async function readProcess(pid) {
  let raw;
  try {
    raw = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined;
    throw error;
  }
  const closeParen = raw.lastIndexOf(")");
  if (closeParen === -1) {
    throw new Error(`malformed /proc/${pid}/stat: no ')' after comm`);
  }
  const fields = raw.slice(closeParen + 2).split(" ");
  const state = fields[0] ?? "";
  const ppid = Number(fields[1]);
  if (state === "" || !Number.isInteger(ppid) || ppid < 0) {
    throw new Error(
      `malformed /proc/${pid}/stat: state ${JSON.stringify(state)} ppid ${fields[1] ?? "<missing>"}`,
    );
  }
  return { state, ppid };
}

// Every visible process except PID 1, the helper itself, and the helper's
// ancestor chain (its own exec transport). Zombies are skipped: they are
// already dead, cannot write, and only their parent can reap them.
async function collectWriters() {
  const entries = await readdir("/proc");
  const processes = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const info = await readProcess(pid);
    if (info !== undefined) processes.set(pid, info);
  }
  const protectedPids = new Set([1, process.pid]);
  for (let pid = process.pid; ;) {
    const info = processes.get(pid);
    if (info === undefined) break;
    protectedPids.add(pid);
    if (info.ppid === pid || info.ppid === 0) break;
    pid = info.ppid;
  }
  const writers = [];
  for (const [pid, info] of processes) {
    if (protectedPids.has(pid)) continue;
    if (info.state === "Z") continue;
    writers.push(pid);
  }
  return writers;
}

async function quiesce() {
  await verifyIsolation();
  const terminated = new Set();
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    const writers = await collectWriters();
    if (writers.length === 0) {
      succeed({ quiet: true, rounds: round, terminated: [...terminated].sort((a, b) => a - b) });
      return;
    }
    const signal = round === 0 ? "SIGTERM" : "SIGKILL";
    for (const pid of writers) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error?.code === "ESRCH") continue; // vanished since collection
        fail("UNKNOWN", `cannot signal PID ${pid}: ${messageOf(error)}`);
        return;
      }
      terminated.add(pid);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, round === 0 ? TERM_GRACE_MS : KILL_GRACE_MS),
    );
  }
  const survivors = await collectWriters();
  if (survivors.length > 0) {
    fail(
      "QUIESCE_FAILED",
      `writer processes survived SIGTERM and SIGKILL: ${survivors.sort((a, b) => a - b).join(", ")}`,
    );
    return;
  }
  succeed({
    quiet: true,
    rounds: SWEEP_ROUNDS,
    terminated: [...terminated].sort((a, b) => a - b),
  });
}

function failProtocol(message) {
  // fail() sets the failing exit status; returning (instead of process.exit)
  // lets the protocol JSON flush before the process exits naturally.
  fail("PROTOCOL", message);
}

async function main() {
  const op = process.argv[2];
  if (op !== "check" && op !== "quiesce") {
    failProtocol(`Unknown operation: ${op ?? "<missing>"}`);
    return;
  }
  try {
    if (op === "check") {
      await verifyIsolation();
      succeed(null);
      return;
    }
    await quiesce();
  } catch (error) {
    if (error instanceof RefusalError) {
      fail("REFUSED", error.message);
      return;
    }
    fail("UNKNOWN", messageOf(error));
  }
}

await main();
