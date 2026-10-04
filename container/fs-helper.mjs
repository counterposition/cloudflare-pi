#!/usr/bin/env node
// fs-helper: filesystem operations for the Pi ExecutionEnv adapter.
//
// Protocol: one operation per process invocation.
//   node /opt/cloudflare-pi/fs-helper.mjs <op> <json-args>
// Arguments are passed as a JSON object in a single argv element, so paths and
// values containing quotes, newlines, or spaces never pass through a shell.
// Content-heavy operations (`append`) receive raw bytes on stdin.
//
// The response is a single JSON document on stdout:
//   {"ok":true,"value":...}
//   {"ok":false,"code":"<errno>","message":"...","path":"..."}
// Operation-level failures (filesystem errors) exit 0 with ok:false so the
// caller can distinguish expected failures from protocol faults. Protocol
// faults (unknown op, malformed args) print the same shape and exit 1.
// The `reader` op is the one exception to one-shot invocation: it opens the
// path, reports the open result, then serves line-framed read requests on
// stdin until stdin closes (see runReader below).
import { lstat, open, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function succeed(value) {
  respond({ ok: true, value });
}

// `code` is the raw errno name (ENOENT, EACCES, ...) or "UNKNOWN"; the Workers
// adapter maps it onto the Pi FileErrorCode union.
function fail(code, message, path) {
  respond({ ok: false, code, message, path });
}

function failProtocol(message) {
  fail("PROTOCOL", message, undefined);
  process.exit(1);
}

function kindFromStats(stats) {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return undefined;
}

async function opHomedir() {
  succeed(homedir());
}

async function opRealpath(args) {
  succeed(await realpath(args.path));
}

// Append stdin bytes to the file. O_APPEND semantics: every write lands at the
// end regardless of concurrent writers.
async function opAppend(args) {
  const handle = await open(args.path, "a");
  try {
    for await (const chunk of process.stdin) {
      await handle.writeFile(chunk);
    }
  } finally {
    await handle.close();
  }
  succeed(null);
}

// Truncate or extend to exactly `size` bytes (extension pads with NULs).
async function opTruncate(args) {
  const size = args.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    fail("EINVAL", "size must be a non-negative safe integer", args.path);
    return;
  }
  const handle = await open(args.path, "r+");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  succeed(null);
}

async function opFsync(args) {
  const handle = await open(args.path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  succeed(null);
}

async function opMkdtemp(args) {
  succeed(await mkdtemp(join(tmpdir(), args.prefix ?? "tmp-")));
}

async function opMktempfile(args) {
  const dir = await mkdtemp(join(tmpdir(), "tmp-"));
  const file = join(dir, `${args.prefix ?? ""}${randomUUID()}${args.suffix ?? ""}`);
  await writeFile(file, "");
  succeed(file);
}

// Validates one bounded-read request; returns the failure message or null.
function readRequestError(request) {
  if (request === null || typeof request !== "object") {
    return "request must be a JSON object";
  }
  const offset = request.offset;
  const length = request.length;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    return "offset must be a non-negative safe integer";
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0) {
    return "length must be a positive safe integer";
  }
  return null;
}

// Bounded read: exactly `length` bytes starting at `offset`. Lets the adapter
// stream line reads from files of any size without loading the whole file.
async function opReadat(args) {
  const problem = readRequestError(args);
  if (problem !== null) {
    fail("EINVAL", problem, args.path);
    return;
  }
  const handle = await open(args.path, "r");
  try {
    const buffer = Buffer.allocUnsafe(args.length);
    const { bytesRead } = await handle.read(buffer, 0, args.length, args.offset);
    succeed({
      data: buffer.subarray(0, bytesRead).toString("base64"),
      eof: bytesRead === 0,
    });
  } finally {
    await handle.close();
  }
}

// Directory listing with full metadata per entry, mirroring the Pi FileSystem
// contract: any entry that cannot be lstat'ed fails the whole call.
async function opListdir(args) {
  const entries = await readdir(args.path, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    const entryPath = join(args.path, entry.name);
    const stats = await lstat(entryPath);
    const kind = kindFromStats(stats);
    if (kind === undefined) {
      fail("UNKNOWN", `Unsupported file type: ${entryPath}`, entryPath);
      return;
    }
    rows.push({
      name: entry.name,
      kind,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
  succeed(rows);
}

// Long-lived read session: opens the path once and retains the descriptor for
// the connection's lifetime, so renaming or unlinking the path afterwards
// cannot change which file is read and a missing file fails at open. The open
// result is the first response line; afterwards stdin carries one JSON request
// ({"offset":N,"length":N}) per line, each answered with one JSON response
// line. EOF on stdin closes the descriptor and exits 0.
async function runReader(args) {
  const path = typeof args?.path === "string" ? args.path : undefined;
  let handle;
  try {
    handle = await open(args.path, "r");
  } catch (error) {
    fail(
      typeof error?.code === "string" ? error.code : "UNKNOWN",
      error instanceof Error ? error.message : String(error),
      path,
    );
    return;
  }
  succeed(null);
  try {
    let pending = "";
    for await (const chunk of process.stdin) {
      pending += chunk.toString("utf8");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let request;
        try {
          request = JSON.parse(line);
        } catch (error) {
          failProtocol(
            `Malformed reader request: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        const problem = readRequestError(request);
        if (problem !== null) {
          fail("EINVAL", problem, path);
          continue;
        }
        const buffer = Buffer.allocUnsafe(request.length);
        const { bytesRead } = await handle.read(buffer, 0, request.length, request.offset);
        succeed({
          data: buffer.subarray(0, bytesRead).toString("base64"),
          eof: bytesRead === 0,
        });
      }
    }
  } catch (error) {
    fail(
      typeof error?.code === "string" ? error.code : "UNKNOWN",
      error instanceof Error ? error.message : String(error),
      path,
    );
  } finally {
    await handle.close();
  }
}

// Snapshot of the container's startup environment. Processes started with
// exec() receive only the env passed explicitly, so inheritEnv support reads
// the init process environment. Some images/entrypoints make /proc/1/environ
// unreadable; that is reported as available:false rather than guessed around,
// and the Workers adapter treats inheritEnv as unavailable in that case
// (exec fails explicitly instead of degrading to a PATH-only environment).
async function opContainerEnv() {
  try {
    // Env values are UTF-8; decoding as Latin-1 would corrupt multibyte
    // characters before they reach exec().
    const raw = await readFile("/proc/1/environ");
    const env = {};
    for (const entry of raw.toString("utf8").split("\0")) {
      if (entry === "") continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    succeed({ available: true, env });
  } catch {
    succeed({ available: false, env: {} });
  }
}

const OPERATIONS = {
  homedir: opHomedir,
  realpath: opRealpath,
  append: opAppend,
  truncate: opTruncate,
  fsync: opFsync,
  mkdtemp: opMkdtemp,
  mktempfile: opMktempfile,
  readat: opReadat,
  reader: runReader,
  listdir: opListdir,
  "container-env": opContainerEnv,
};

async function main() {
  const op = process.argv[2];
  if (op === undefined || !(op in OPERATIONS)) {
    failProtocol(`Unknown operation: ${op ?? "<missing>"}`);
    return;
  }
  let args = {};
  const rawArgs = process.argv[3];
  if (rawArgs !== undefined) {
    try {
      args = JSON.parse(rawArgs);
    } catch (error) {
      failProtocol(
        `Malformed arguments JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    failProtocol("Arguments must be a JSON object");
    return;
  }
  try {
    await OPERATIONS[op](args);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    fail(
      code,
      error instanceof Error ? error.message : String(error),
      typeof args?.path === "string" ? args.path : undefined,
    );
  }
}

await main();
