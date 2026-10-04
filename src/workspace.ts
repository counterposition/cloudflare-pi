// WorkspaceManager: owns the session's Linux container, the /workspace/project
// directory inside it, and the checkpoint lifecycle over R2.
//
// The manager is the single serialization boundary for everything that touches
// the container or the checkpoint pointers: container start/reset, tool work
// and its post-effect quiesce+archive, external checkpoints, and restores all
// run through one operation queue. Public entry points never queue from inside
// the queue; the internal *Locked helpers are the only reentry-free path.
//
// Durability rule: a tool's effects are only claimed durable after a verified
// R2 backup has landed and its pointer row is committed. A mutating tool whose
// backup or quiesce fails therefore rejects (honestly, with both causes) even
// when the tool itself succeeded — the effects live only in the current
// container and are lost with it.
//
// Writer quiescence is established by container/workspace-helper.mjs (native,
// bounded, refusing to run outside the container's PID namespace) before every
// archive and restore. An idle harness or a completed exec() is not evidence
// that escaped background writers stopped.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DirectoryBackup, type DirectoryBackupRecord } from "@cloudflare/sandbox";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { SandboxExecutionEnv } from "./adapters/sandbox-env";
import type { WorkspaceCheckpoint, WorkspaceStatus } from "./contracts";

const WORKSPACE_DIR = "/workspace/project";
const WORKSPACE_HELPER_PATH = "/opt/cloudflare-pi/workspace-helper.mjs";
const CHECKPOINT_TABLE = "app_workspace_checkpoints";
/**
 * The SDK's only archive format (`DIRECTORY_BACKUP_FORMAT` in
 * @cloudflare/sandbox directory-backup/contracts; the constant itself is not
 * exported, so it is pinned here against the same literal).
 */
const BACKUP_FORMAT = "tar+zstd/1";
/** Retained checkpoints: latest + previous, per the shared contract. */
const KEEP_CHECKPOINTS = 2;
/** Container lifetime bound, reapplied after every start. */
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/** Bound for native container operations issued by the manager itself. */
const CONTAINER_OP_DEADLINE_MS = 30_000;

interface HelperResponse {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

interface CheckpointRow {
  id: string;
  created_at: number;
  record: string;
}

/** A validated persisted checkpoint: the full SDK record plus its commit time. */
interface StoredCheckpoint {
  record: DirectoryBackupRecord;
  createdAt: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validates a JSON-decoded value against the actual SDK `DirectoryBackupRecord`
 * contract — the same rules `DirectoryBackup.restore()` enforces on the wire
 * (record schema in @cloudflare/sandbox: UUID id, absolute dir, positive safe
 * integer size, hex sha256, exact format literal). No guessed properties, no
 * silent coercion. Throws with a diagnostic message on mismatch.
 */
function parseBackupRecord(value: unknown): DirectoryBackupRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("checkpoint record must be a JSON object");
  }
  const value_ = value as Record<string, unknown>;
  const invalid = (problem: string): Error => new Error(`checkpoint record is invalid: ${problem}`);
  if (
    typeof value_.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value_.id)
  ) {
    throw invalid("id must be a UUID string");
  }
  if (typeof value_.dir !== "string" || !value_.dir.startsWith("/")) {
    throw invalid("dir must be an absolute path");
  }
  if (typeof value_.size !== "number" || !Number.isSafeInteger(value_.size) || value_.size <= 0) {
    throw invalid("size must be a positive safe integer");
  }
  if (typeof value_.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value_.sha256)) {
    throw invalid("sha256 must be a 64-character lowercase hex digest");
  }
  const format = value_.format;
  if (format !== BACKUP_FORMAT) {
    throw invalid(`format must be ${BACKUP_FORMAT}`);
  }
  const name = value_.name;
  if (name !== undefined && typeof name !== "string") {
    throw invalid("name must be a string when present");
  }
  // The SDK record's fields are readonly; the name is present only when the
  // persisted row carried one, so the validated record is constructed complete
  // rather than mutated or cast.
  return name === undefined
    ? {
        id: value_.id,
        dir: value_.dir,
        size: value_.size,
        sha256: value_.sha256,
        format,
      }
    : {
        id: value_.id,
        dir: value_.dir,
        size: value_.size,
        sha256: value_.sha256,
        format,
        name,
      };
}

function parseStoredRow(row: CheckpointRow): StoredCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record);
  } catch (error) {
    throw new Error(`checkpoint record ${row.id} is not valid JSON: ${messageOf(error)}`);
  }
  return { record: parseBackupRecord(parsed), createdAt: row.created_at };
}

/**
 * App-prefixed SQL persistence for checkpoint pointers over the session's
 * shared `SqliteDatabase` (the same serialized queue the Pi storage uses).
 * Rows hold the full `DirectoryBackupRecord` plus `createdAt`, scoped to the
 * owning session id; only own-session rows are ever read, kept, or deleted.
 */
class CheckpointStore {
  private readonly sessionId: string;

  constructor(
    private readonly database: SqliteDatabase,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
  }

  async ensureSchema(): Promise<void> {
    await this.database.exec(
      `CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL PRIMARY KEY,
        created_at INTEGER NOT NULL,
        record TEXT NOT NULL
      )`,
    );
  }

  /**
   * The newest own checkpoint. Throws when the newest row is unreadable or
   * fails record validation — corruption must surface, never fall back to an
   * empty workspace.
   */
  async latest(): Promise<StoredCheckpoint | undefined> {
    const row = await this.database.get<CheckpointRow>(
      `SELECT id, created_at, record FROM ${CHECKPOINT_TABLE}
       WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      this.sessionId,
    );
    if (row === undefined) return undefined;
    return parseStoredRow(row);
  }

  /** Rows beyond the newest `keep`, oldest first; selection only, no deletion. */
  async beyondNewest(keep: number): Promise<StoredCheckpoint[]> {
    const rows = await this.database.all<CheckpointRow>(
      `SELECT id, created_at, record FROM ${CHECKPOINT_TABLE}
       WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
      this.sessionId,
      keep,
    );
    const stored: StoredCheckpoint[] = [];
    for (const row of rows) {
      try {
        stored.push(parseStoredRow(row));
      } catch {
        // An obsolete corrupt row has no recoverable R2 object reference;
        // it is still removed by removeRecords, and latest() would have
        // already failed if the corrupt row were the newest one.
      }
    }
    return stored;
  }

  /** Persists a new pointer; the caller has a verified backup record only. */
  async insert(record: DirectoryBackupRecord, createdAt: number): Promise<void> {
    await this.database.run(
      `INSERT INTO ${CHECKPOINT_TABLE} (session_id, id, created_at, record) VALUES (?, ?, ?, ?)`,
      this.sessionId,
      record.id,
      createdAt,
      JSON.stringify(record),
    );
  }

  /** Removes the given own-session pointer rows atomically. */
  async removeRecords(stored: readonly StoredCheckpoint[]): Promise<void> {
    if (stored.length === 0) return;
    await this.database.transaction(async (transaction: SqliteExecutor) => {
      for (const entry of stored) {
        await transaction.run(
          `DELETE FROM ${CHECKPOINT_TABLE} WHERE session_id = ? AND id = ?`,
          this.sessionId,
          entry.record.id,
        );
      }
    });
  }
}

/** Serial operation boundary for start/tool/quiesce/archive/restore. */
class WorkspaceQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Owns one session's container and workspace. Constructor contract is fixed by
 * the shared application contract; `gateway` is the DirectoryBackupGateway
 * binding (`ctx.exports.DirectoryBackupGateway`) that keeps all backup
 * credentials in the Workers runtime and grants the container only per-operation
 * upload/download access to this session's R2 prefix.
 */
export class WorkspaceManager {
  private readonly backup: DirectoryBackup;
  private readonly store: CheckpointStore;
  private readonly queue = new WorkspaceQueue();
  private currentEnv: SandboxExecutionEnv | undefined;
  private cachedStatus: WorkspaceStatus = { state: "stopped" };
  private lastCheckpoint: WorkspaceCheckpoint | undefined;
  private containerReady = false;
  private initializePromise: Promise<void> | undefined;

  constructor(
    private readonly container: Container,
    gateway: ConstructorParameters<typeof DirectoryBackup>[1],
    database: SqliteDatabase,
    private readonly options: { sessionId: string; onChange: () => void },
  ) {
    this.backup = new DirectoryBackup(container, gateway, {
      binding: "WORKSPACE_BACKUPS",
      prefix: `sessions/${options.sessionId}/`,
    });
    this.store = new CheckpointStore(database, options.sessionId);
  }

  /** Synchronous cached status; `onChange` fires after every transition. */
  status(): WorkspaceStatus {
    return this.cachedStatus;
  }

  /**
   * Per-incarnation startup: stop any container left over from a previous Durable
   * Object incarnation (its orphaned Linux commands must never keep writing
   * against a recovered transcript), start a fresh container, and restore the
   * last published checkpoint into ordinary files. A missing or corrupt latest
   * backup fails initialization — the workspace is never silently emptied.
   */
  initialize(): Promise<void> {
    this.initializePromise ??= this.queue
      .run(async () => {
        await this.store.ensureSchema();
        await this.startContainerLocked();
      })
      .catch((error: unknown) => {
        this.initializePromise = undefined; // allow an honest retry
        throw error;
      });
    return this.initializePromise;
  }

  /**
   * The execution environment for tool callbacks: a fresh adapter per container
   * incarnation (cached tmpdir/home lookups from a destroyed VM are never
   * reused) with a stable file namespace (the session id) and cwd
   * /workspace/project.
   */
  environment(): SandboxExecutionEnv {
    this.currentEnv ??= new SandboxExecutionEnv(this.container, {
      id: this.options.sessionId,
      cwd: WORKSPACE_DIR,
    });
    return this.currentEnv;
  }

  /**
   * Runs one tool callback inside the serial queue. Mutating work is followed
   * by quiesce + checkpoint even when the callback failed or was aborted, so
   * partial effects are preserved and no escaped writer survives into the
   * published state; the original error is preserved alongside any durability
   * failure. Success is only returned when the new checkpoint is durable.
   */
  runTool<T>(mutating: boolean, work: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      await this.ensureContainerLocked();
      if (!mutating) return await work();

      let result: T | undefined;
      let toolError: { error: unknown } | undefined;
      try {
        result = await work();
      } catch (error) {
        toolError = { error };
      }

      let checkpointError: { error: unknown } | undefined;
      try {
        await this.checkpointLocked();
      } catch (error) {
        checkpointError = { error };
      }

      if (toolError !== undefined) {
        if (checkpointError === undefined) throw toolError.error;
        throw new AggregateError(
          [toolError.error, checkpointError.error],
          `Tool failed (${messageOf(toolError.error)}) and its effects could not be ` +
            `checkpointed (${messageOf(checkpointError.error)})`,
        );
      }
      if (checkpointError !== undefined) {
        // The tool's in-container effects exist but are not durable; claiming
        // success would silently lose them on the next container loss.
        throw new Error(
          `Tool effect could not be made durable; checkpoint failed: ` +
            `${messageOf(checkpointError.error)}`,
        );
      }
      return result as T;
    });
  }

  /** External checkpoint request. Serialized with all other operations. */
  checkpoint(): Promise<WorkspaceCheckpoint> {
    return this.queue.run(async () => {
      await this.ensureContainerLocked();
      return await this.checkpointLocked();
    });
  }

  /**
   * Restores the latest own checkpoint over the live workspace. Refuses when
   * no checkpoint exists; a failed restore keeps the pointer and the previous
   * state visible — no empty fallback.
   */
  restore(): Promise<WorkspaceStatus> {
    return this.queue.run(async () => {
      await this.ensureContainerLocked();
      return await this.restoreLatestLocked();
    });
  }

  // --- serialized internals (never re-enter the queue) ---

  private async ensureContainerLocked(): Promise<void> {
    if (this.containerReady && this.container.running) return;
    await this.startContainerLocked();
  }

  private async startContainerLocked(): Promise<void> {
    // Incarnation reset: a container can outlive its Durable Object incarnation
    // with unknown commands still running against the old workspace. Stop it
    // before any resume; the rebuilt workspace comes from the last published
    // checkpoint only.
    if (this.container.running) {
      await this.container.destroy(
        new Error(`workspace reset for session ${this.options.sessionId}`),
      );
    }
    this.containerReady = false;
    this.currentEnv = undefined;
    this.publish("starting");
    try {
      const image = this.container.images.workspace;
      if (image === undefined) {
        throw new Error("Container image 'workspace' is not configured");
      }
      this.container.start({ image, enableInternet: false });
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      this.watchContainerExit();

      const latest = await this.store.latest();
      if (latest === undefined) {
        // Brand-new workspace: the Dockerfile creates /workspace only, so the
        // project directory is created at runtime (never an image-layer dir).
        await this.runInContainer(["mkdir", "-p", WORKSPACE_DIR], "workspace directory creation");
      } else {
        this.publish("restoring");
        await this.backup.restore(latest.record);
        this.lastCheckpoint = { key: latest.record.id, createdAt: latest.createdAt };
      }
      this.containerReady = true;
      this.publish("ready");
    } catch (error) {
      this.containerReady = false;
      this.publish("error", `Workspace start failed: ${messageOf(error)}`);
      throw error;
    }
  }

  private async checkpointLocked(): Promise<WorkspaceCheckpoint> {
    await this.quiesceLocked();
    const record = await this.backup.backup({ dir: WORKSPACE_DIR });
    const createdAt = Date.now();
    await this.store.insert(record, createdAt); // new pointer durable
    const checkpoint: WorkspaceCheckpoint = { key: record.id, createdAt };
    // The pointer is durable: the checkpoint is claimed in the published
    // status immediately, before best-effort garbage collection. Cleanup
    // trouble must never convert a fully durable write into a reported
    // failure or a stale published pointer.
    this.lastCheckpoint = checkpoint;
    this.publish("ready");
    try {
      const obsolete = await this.store.beyondNewest(KEEP_CHECKPOINTS);
      for (const stale of obsolete) {
        // Only owned, already-unreferenced archives beyond the newest
        // KEEP_CHECKPOINTS are deleted, and only after the new pointer is
        // durable. A failed deletion keeps its row so the next checkpoint
        // retries; the pointer and the published claim are unaffected.
        await this.backup.delete(stale.record);
      }
      await this.store.removeRecords(obsolete);
    } catch (error) {
      // Garbage collection is best-effort, never silent: the failure is
      // surfaced as a warning on the (still ready) workspace status, and the
      // retained rows make the next checkpoint retry the deletions.
      this.publish(
        "ready",
        `Workspace checkpoint garbage collection failed; older checkpoints retained for retry: ${messageOf(error)}`,
      );
    }
    return checkpoint;
  }

  private async restoreLatestLocked(): Promise<WorkspaceStatus> {
    const latest = await this.store.latest();
    if (latest === undefined) {
      throw new Error("No workspace checkpoint exists to restore");
    }
    this.publish("restoring");
    try {
      await this.quiesceLocked();
      await this.backup.restore(latest.record);
      this.lastCheckpoint = { key: latest.record.id, createdAt: latest.createdAt };
      this.publish("ready");
    } catch (error) {
      this.publish("error", `Workspace restore failed: ${messageOf(error)}`);
      throw error;
    }
    return this.cachedStatus;
  }

  /**
   * Closes the current environment's retained fd helpers and exec roots, then
   * runs the bounded native sweep: every non-zombie user process in the
   * container's PID namespace except PID 1 and the sweep helper's own transport
   * is terminated, and the helper verifies quiescence before returning.
   * Failure is fatal to the enclosing checkpoint/restore.
   */
  private async quiesceLocked(): Promise<void> {
    if (this.currentEnv !== undefined) {
      await this.currentEnv.cleanup(BACKGROUND_CONTEXT);
    }
    const output = await this.runInContainer(
      [WORKSPACE_HELPER_PATH, "quiesce"],
      "workspace quiesce",
    );
    let parsed: HelperResponse;
    try {
      parsed = JSON.parse(output) as HelperResponse;
    } catch (error) {
      throw new Error(`workspace quiesce helper protocol failure: ${messageOf(error)}`);
    }
    if (!parsed.ok) {
      throw new Error(`workspace quiesce failed: ${parsed.message ?? "unknown helper error"}`);
    }
  }

  /** One bounded container command; combined output is returned for diagnostics. */
  private async runInContainer(cmd: string[], label: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTAINER_OP_DEADLINE_MS);
    try {
      const proc = await this.container.exec(cmd, {
        signal: controller.signal,
        stdout: "pipe",
        stderr: "combined",
      });
      const [output, code] = await Promise.all([
        proc.stdout === null ? Promise.resolve("") : new Response(proc.stdout).text(),
        proc.exitCode,
      ]);
      if (controller.signal.aborted) {
        throw new Error(`${label} exceeded ${CONTAINER_OP_DEADLINE_MS}ms deadline`);
      }
      if (code !== 0) {
        throw new Error(`${label} failed with exit code ${code}: ${output.trim()}`);
      }
      return output;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${label} exceeded ${CONTAINER_OP_DEADLINE_MS}ms deadline`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private watchContainerExit(): void {
    void this.container.monitor().then(
      () => {
        this.containerReady = false;
        // Normal exit (e.g. inactivity timeout): the workspace reverts to the
        // last published checkpoint until the next operation restarts it. Only
        // demote a ready workspace — an in-flight start/restore reports its own
        // error when the container disappears under it.
        if (this.cachedStatus.state === "ready") this.publish("stopped");
      },
      (error: unknown) => {
        this.containerReady = false;
        this.publish("error", `Container exited unexpectedly: ${messageOf(error)}`);
      },
    );
  }

  private publish(state: WorkspaceStatus["state"], error?: string): void {
    const status: WorkspaceStatus = { state };
    if (this.lastCheckpoint !== undefined) status.checkpoint = this.lastCheckpoint;
    if (error !== undefined) status.error = error;
    this.cachedStatus = status;
    try {
      this.options.onChange();
    } catch {
      // The status cache is already updated; a failing SSE notification must
      // not corrupt the workspace operation in flight (clients refetch).
    }
  }
}
