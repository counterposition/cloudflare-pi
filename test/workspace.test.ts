// Refusal-contract tests for container/workspace-helper.mjs, run as a real
// Node child process. The helper must refuse to run outside the session
// container's isolated PID namespace BEFORE it inspects or signals anything,
// so these tests are safe on a developer host and on CI: the refusal path
// never kills a process. The tests prove that with a sacrificial child that
// must survive a refused `quiesce`, and with the `check` op, which runs only
// the isolation preconditions. The full sweep itself is only ever exercised
// inside the real container (parent Docker smoke), never here.
//
// The controlled-entry match is decided by structured /proc/1/cmdline argv
// semantics inside the helper, including the user-space-emulation form
// [<interpreter tag>, <guest executable path>, ...guest argv] (observed
// ["[qemu]","/usr/bin/sleep","sleep","infinity"]). Acceptance of that form can
// only be observed on the emulated Linux container (parent smoke); on the
// host the platform refusal fires first, so these tests stay refusal-only and
// the helper ships no pure re-export for direct parse testing.
//
// These tests need the node runtime (child_process), not the workers pool.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { DirectoryBackupRecord } from "@cloudflare/sandbox";
import { beforeEach, expect, test, vi } from "vitest";
import type { WorkspaceStatus } from "../src/contracts";
import { WorkspaceManager } from "../src/workspace";

const HELPER = fileURLToPath(new URL("../container/workspace-helper.mjs", import.meta.url));

interface HelperResponse {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

function runHelper(
  op: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [HELPER, op], { stdio: ["pipe", "pipe", "pipe"] });
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
  const { promise, resolve } = Promise.withResolvers<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>();
  // No wall-clock watchdog: the refusal paths never block, so vitest's test
  // timeout is the deterministic bound for a hypothetical hang.
  child.on("close", (code) => {
    resolve({ exitCode: code, stdout, stderr });
  });
  child.stdin.end();
  return promise;
}

function parseResponse(stdout: string): HelperResponse {
  return JSON.parse(stdout) as HelperResponse;
}

test("check refuses on the host: not Linux or PID 1 is not the controlled image entry", async () => {
  const { exitCode, stdout } = await runHelper("check");
  expect(exitCode).toBe(1);
  const response = parseResponse(stdout);
  expect(response.ok).toBe(false);
  expect(response.code).toBe("REFUSED");
  expect(response.message).toMatch(/[Rr]efus/);
});

test("quiesce refuses on the host before inspecting or signalling any process", async () => {
  // A process a host sweep would wrongly target; it must survive the refusal.
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const { exitCode, stdout } = await runHelper("quiesce");
    expect(exitCode).toBe(1);
    const response = parseResponse(stdout);
    expect(response.ok).toBe(false);
    expect(response.code).toBe("REFUSED");
    expect(bystander.exitCode).toBeNull();
  } finally {
    if (bystander.exitCode === null) bystander.kill("SIGKILL");
  }
});

test("unknown operations fail the protocol without touching any process", async () => {
  const { exitCode, stdout } = await runHelper("reap-everything");
  expect(exitCode).toBe(1);
  const response = parseResponse(stdout);
  expect(response.ok).toBe(false);
  expect(response.code).toBe("PROTOCOL");
});

// --- Checkpoint durability ordering (src/workspace.ts) ---
// The pointer row commit is the durability point, so the published status
// claim must land immediately after it and garbage-collection IO failures
// after it must never convert the fully durable write into a reported
// failure. These tests run the real WorkspaceManager checkpoint/restore path
// over a real node:sqlite database (real SQL rows, real record validation),
// faking only the container transport boundary — the same seam
// sandbox-control.test.ts fakes for exec.

const backupBehavior = vi.hoisted(() => ({
  failBackup: undefined as Error | undefined,
  failDeleteFor: new Set<string>(),
  onDelete: undefined as ((record: { id: string }) => void) | undefined,
  deletedKeys: new Array<string>(),
}));

// The fake backup captures this object by reference inside the vi.mock
// factory, so each case resets its properties in place: no failure flag,
// hook, or recorded delete may leak from one test into the next.
beforeEach(() => {
  backupBehavior.failBackup = undefined;
  backupBehavior.failDeleteFor.clear();
  backupBehavior.onDelete = undefined;
  backupBehavior.deletedKeys = [];
});

vi.mock("@cloudflare/sandbox", () => {
  class Files {}
  class SandboxFileError extends Error {}
  class DirectoryBackup {
    constructor(
      _container: unknown,
      _gateway: unknown,
      storage: { binding: string; prefix?: string },
    ) {
      if (typeof storage.binding !== "string" || storage.binding.length === 0) {
        throw new TypeError("storage.binding must name an R2 bucket binding");
      }
      if (storage.prefix !== undefined && !storage.prefix.endsWith("/")) {
        throw new TypeError('storage.prefix must be a string that ends in "/"');
      }
    }
    backup(): Promise<DirectoryBackupRecord> {
      if (backupBehavior.failBackup !== undefined) {
        return Promise.reject(backupBehavior.failBackup);
      }
      const record: DirectoryBackupRecord = {
        id: crypto.randomUUID(),
        dir: "/workspace/project",
        size: 1,
        sha256: "a".repeat(64),
        format: "tar+zstd/1",
      };
      return Promise.resolve(record);
    }
    async restore(): Promise<void> {}
    async delete(record: DirectoryBackupRecord): Promise<void> {
      backupBehavior.deletedKeys.push(record.id);
      backupBehavior.onDelete?.(record);
      if (backupBehavior.failDeleteFor.has(record.id)) {
        throw new Error(`R2 delete failed for ${record.id}`);
      }
    }
  }
  return { Files, SandboxFileError, DirectoryBackup };
});

const WORKSPACE_TABLE = "app_workspace_checkpoints";

async function makeManager(): Promise<{
  manager: WorkspaceManager;
  database: SqliteDatabase;
  execCalls: string[][];
  /** Every status snapshot handed to onChange, in publish order. */
  changes: WorkspaceStatus[];
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "workspace-checkpoints-"));
  const database = await openNodeSqliteDatabase(join(dir, "checkpoints.sqlite"));
  // A container that stays up: monitor() resolves only when it exits.
  const monitorHeld = Promise.withResolvers<void>();
  const execCalls: string[][] = [];
  const changes: WorkspaceStatus[] = [];
  const recordChange = (): void => {
    // WorkspaceManager requires an onChange callback (DI boundary); recording
    // the snapshots turns it into an ordering assertion channel.
    changes.push(manager.status());
  };
  const container = {
    running: false,
    images: { workspace: { image: "workspace-test" } },
    start(): void {
      this.running = true;
    },
    async destroy(): Promise<void> {
      this.running = false;
    },
    async setInactivityTimeout(): Promise<void> {},
    monitor(): Promise<void> {
      return monitorHeld.promise;
    },
    async exec(argv: string[]): Promise<{ stdout: string | null; exitCode: number }> {
      execCalls.push(argv);
      if (argv[0]?.endsWith("workspace-helper.mjs") && argv[1] === "quiesce") {
        return { stdout: JSON.stringify({ ok: true, value: null }), exitCode: 0 };
      }
      if (argv[0] === "mkdir") {
        return { stdout: null, exitCode: 0 };
      }
      throw new Error(`unexpected container exec: ${argv.join(" ")}`);
    },
  };
  const manager = new WorkspaceManager(
    container as unknown as ConstructorParameters<typeof WorkspaceManager>[0],
    (() => undefined) as unknown as ConstructorParameters<typeof WorkspaceManager>[1],
    database,
    { sessionId: "session-1", onChange: recordChange },
  );
  await manager.initialize();
  return {
    manager,
    database,
    execCalls,
    changes,
    cleanup: async () => {
      await database.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The real persisted pointer rows, newest first — the store's own selection order. */
async function pointerRows(
  database: SqliteDatabase,
): Promise<Array<{ id: string; created_at: number }>> {
  return database.all<{ id: string; created_at: number }>(
    `SELECT id, created_at FROM ${WORKSPACE_TABLE} ORDER BY created_at DESC, rowid DESC`,
  );
}

test("checkpoint publishes the durable claim before cleanup and survives garbage-collection IO failure", async () => {
  const { manager, database, changes, cleanup } = await makeManager();
  try {
    const first = await manager.checkpoint();
    const second = await manager.checkpoint();
    // Latest+previous retention: nothing obsolete yet, nothing deleted.
    expect((await pointerRows(database)).map((row) => row.id)).toEqual([second.key, first.key]);
    expect(backupBehavior.deletedKeys).toEqual([]);

    // The third checkpoint makes `first` obsolete, and its R2 delete fails.
    backupBehavior.failDeleteFor.add(first.key);
    // Test seam: the fake backup reports the status the manager had already
    // published when the cleanup delete ran.
    const publishedAtDelete: WorkspaceStatus[] = [];
    const captureStatusAtDelete = (): void => {
      publishedAtDelete.push(manager.status());
    };
    backupBehavior.onDelete = captureStatusAtDelete;
    const third = await manager.checkpoint(); // must resolve: the write is durable
    expect(backupBehavior.deletedKeys).toEqual([first.key]);

    // The claim was already published when cleanup ran, with the NEW pointer.
    expect(publishedAtDelete).toHaveLength(1);
    expect(publishedAtDelete[0]?.state).toBe("ready");
    expect(publishedAtDelete[0]?.checkpoint).toEqual(third);

    // The failed cleanup is visible as a warning, never as a failed write.
    const status = manager.status();
    expect(status.state).toBe("ready");
    expect(status.checkpoint).toEqual(third);
    expect(status.error).toMatch(/garbage collection/i);

    // Obsolete rows are retained for retry, and the published checkpoint
    // matches the restore selection (the newest SQL row) despite the failure.
    expect((await pointerRows(database)).map((row) => row.id)).toEqual([
      third.key,
      second.key,
      first.key,
    ]);
    await manager.restore();
    expect(manager.status().checkpoint).toEqual(third);

    // A retry after the transient failure collects exactly the owned stale rows.
    backupBehavior.failDeleteFor.clear();
    const fourth = await manager.checkpoint();
    expect((await pointerRows(database)).map((row) => row.id)).toEqual([fourth.key, third.key]);
    // `first` was attempted twice (failed, then retried); `second` once.
    expect(backupBehavior.deletedKeys.filter((key) => key === first.key)).toHaveLength(2);
    expect(backupBehavior.deletedKeys.filter((key) => key === second.key)).toHaveLength(1);
    expect(backupBehavior.deletedKeys.filter((key) => key === third.key)).toHaveLength(0);
    const retried = manager.status();
    expect(retried.state).toBe("ready");
    expect(retried.checkpoint).toEqual(fourth);
    expect(retried.error).toBeUndefined();
    // onChange observed the ready-with-warning transition and the clean retry.
    expect(changes.at(-1)?.checkpoint).toEqual(fourth);
  } finally {
    backupBehavior.failDeleteFor.clear();
    backupBehavior.onDelete = undefined;
    await cleanup();
  }
});

test("successful garbage collection deletes only owned rows beyond latest+previous", async () => {
  const { manager, database, cleanup } = await makeManager();
  try {
    const first = await manager.checkpoint();
    const second = await manager.checkpoint();
    const third = await manager.checkpoint();
    expect((await pointerRows(database)).map((row) => row.id)).toEqual([third.key, second.key]);
    expect(backupBehavior.deletedKeys).toEqual([first.key]);
    const status = manager.status();
    expect(status.state).toBe("ready");
    expect(status.checkpoint).toEqual(third);
    expect(status.error).toBeUndefined();
  } finally {
    await cleanup();
  }
});

test("backup failure stays fatal and keeps the last good pointer truthful", async () => {
  const { manager, database, cleanup } = await makeManager();
  try {
    const first = await manager.checkpoint();
    backupBehavior.failBackup = new Error("R2 outage");
    await expect(manager.checkpoint()).rejects.toThrow(/R2 outage/);
    expect((await pointerRows(database)).map((row) => row.id)).toEqual([first.key]);
    const status = manager.status();
    expect(status.checkpoint).toEqual(first);
    expect(status.error).toBeUndefined();
  } finally {
    backupBehavior.failBackup = undefined;
    await cleanup();
  }
});

test("pointer commit failure stays fatal and keeps the last good pointer truthful", async () => {
  const { manager, database, cleanup } = await makeManager();
  try {
    const first = await manager.checkpoint();
    await database.close(); // the SQL write itself now fails
    await expect(manager.checkpoint()).rejects.toThrow();
    const status = manager.status();
    expect(status.checkpoint).toEqual(first);
    expect(status.error).toBeUndefined();
  } finally {
    await cleanup();
  }
});
