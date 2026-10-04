/**
 * Session durable object: one persistent Pi session per verified Access identity.
 *
 * Every incarnation builds the same real stack over the SAME shared Durable SQLite database
 * queue: Pi's portable SQLite storage, the durable Harness over it, the Workers AI binding
 * models, and the WorkspaceManager-owned Linux container. All application metadata (owner
 * binding, alarm intent) lives in small app-prefixed SQL tables and is written through the same
 * database queue as Pi's own commits; direct `ctx.storage` KV is never used for metadata while
 * Pi transactions can be active. Alarm arms/disarms run inside `database.transaction` so they
 * join the same Durable Object transaction as any Pi commit in flight.
 *
 * Durable alarms are armed before any live admission (submit, resume), and the alarm chain
 * resumes pending work with no client attached; `ctx.waitUntil` keeps progress flowing between
 * alarms but is never assumed to be the guarantee. Every progress pass re-arms the next wake-up
 * durably BEFORE any fallible work (initialization, container reset, checkpoint restore,
 * inspection, queued-input recovery), so a fired alarm can never strand accepted work: if the
 * pass fails, a future alarm is already scheduled and the failure handler re-arms through the
 * same admission boundary. Disconnected SSE streams detach their observer only — admitted work
 * always continues. A DO reincarnation rebuilds everything, resets the dangling container,
 * restores the latest published workspace checkpoint, and then resumes; interrupted unsafe tool
 * effects surface honestly as `interrupted`, never replayed. If initialization fails, the
 * opened harness/storage is closed and a fresh usable database gate is adopted so the next
 * attempt retries as the single owner instead of finding the gate closed forever.
 */
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  type Conversation,
  type ConversationView,
  type HarnessInspection,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { DirectoryBackup } from "@cloudflare/sandbox";
import { DurableSqliteDatabase } from "./adapters/durable-sqlite";
import { createCodingExtension, WORKSPACE_CWD } from "./coding";
import type { AppEnv, SessionIdentity } from "./env";
import { createWorkersAiModels } from "./models";
import { recoverQueuedInputs as recoverQueuedInputsImpl } from "./recovery";
import type { SessionSnapshot, SubmitInput, SubmitReceipt, WorkspaceCheckpoint } from "./contracts";
import { WorkspaceManager } from "./workspace";

/** Application-owned tables, separate from Pi's own tables, in the shared SQLite database. */
const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL,
  email TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_alarm (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  reason TEXT NOT NULL,
  armed_at INTEGER NOT NULL
);
`;

/** How far ahead the durable alarm is armed for the next progress pass. */
const ALARM_LEAD_MS = 1_000;

/** Backend of the gateway loopback that moves workspace backups between container and R2. */
type BackupGateway = ConstructorParameters<typeof DirectoryBackup>[1];

/** Session-level failure with an HTTP status; safe to expose to the browser. */
export class SessionApiError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string) {
    super(error);
    this.name = "SessionApiError";
    this.status = status;
    this.error = error;
  }
}

/** Everything one incarnation builds; identity binding is verified per call, never cached. */
interface Initialized {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly workspace: WorkspaceManager;
}

/** Per-SSE-connection hooks the session pushes to. */
interface StreamHandle {
  notify(): void;
  end(): void;
}

export class Session extends DurableObject<AppEnv> {
  /** Stable across incarnations; the workspace namespace and snapshot identity. */
  private readonly sessionId = this.ctx.id.toString();
  /**
   * ONE shared database queue for Pi storage, app metadata, and alarm coordination. Replaced
   * only when a failed initialization closed the previous gate (its harness/storage close seals
   * and closes it); the replacement is adopted after that close completes, when the old gate has
   * no other owners, so exactly one live gate exists at any time.
   */
  private database: DurableSqliteDatabase = new DurableSqliteDatabase(this.ctx.storage);
  private readonly streams = new Set<StreamHandle>();
  /**
   * Harness-wide run policy, passed to every `Harness.open` and read by queued-input recovery.
   * Steering and follow-up queue modes stay unset, so they resolve to the upstream default
   * `one-at-a-time`; recovery resolves the same way (see `recoverQueuedInputs`).
   */
  private readonly harnessSettings: HarnessSettings = { toolExecution: "sequential" };
  private readonly startNotices: string[] = [];

  private schemaPromise: Promise<void> | undefined;
  /** Whether the app schema is known to exist in the underlying storage (it survives gate swaps). */
  private schemaReady = false;
  private initPromise: Promise<Initialized> | undefined;
  private admissionTail: Promise<unknown> = Promise.resolve();
  private driving = false;

  // --- Public API (called over RPC by the authenticated worker) ---

  /**
   * Full committed session state: conversation view, workspace cache, and notices. Returns the
   * JSON serialization of the typed snapshot (see contracts.SessionRpcApi): the string crosses
   * the RPC boundary and the worker forwards it as the public application/json body unchanged.
   */
  async snapshot(identity: SessionIdentity): Promise<string> {
    const init = await this.guard(identity);
    const view = await init.root.viewState(BACKGROUND_CONTEXT);
    try {
      return JSON.stringify(this.assembleSnapshot(init, view.value));
    } finally {
      view.dispose();
    }
  }

  /** Bounded, coalesced SSE stream of committed snapshots; disconnect detaches only. */
  async events(identity: SessionIdentity): Promise<Response> {
    const init = await this.guard(identity);
    const view = await init.root.viewState(BACKGROUND_CONTEXT);
    const encoder = new TextEncoder();

    let closed = false;
    let pendingChunk: string | undefined;
    let lastView: ConversationView | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

    const assemble = (conversation: ConversationView): SessionSnapshot =>
      this.assembleSnapshot(init, conversation);

    const notifyStream = (): void => {
      // Workspace status changed outside the transcript; re-send the latest view with fresh state.
      if (!closed && lastView !== undefined) push(assemble(lastView));
    };

    const endStream = (): void => {
      if (closed) return;
      try {
        // Honest end: a closed session terminates the stream instead of hanging the client.
        controller?.close();
      } catch {
        // Already cancelled or errored; nothing further to end.
      }
      cleanup();
    };

    const handle: StreamHandle = { notify: notifyStream, end: endStream };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      view.dispose();
      this.streams.delete(handle);
    };

    const push = (snapshot: SessionSnapshot): void => {
      if (closed || controller === undefined) return;
      const desired = controller.desiredSize;
      if (desired !== null && desired <= 0) {
        // Backpressure: retain only the newest snapshot; older frames are dropped, never queued.
        pendingChunk = `data: ${JSON.stringify(snapshot)}\n`;
        return;
      }
      pendingChunk = undefined;
      try {
        controller.enqueue(
          encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`),
        );
      } catch {
        cleanup();
      }
    };

    const deliver = (conversation: ConversationView): void => {
      if (closed) return;
      lastView = conversation;
      push(assemble(conversation));
    };

    // The stream is created before subscribing so the very first delivery always has a controller.
    const stream = new ReadableStream<Uint8Array>({
      start(pullController) {
        controller = pullController;
      },
      pull() {
        if (!closed && pendingChunk !== undefined && controller !== undefined) {
          const chunk = pendingChunk;
          pendingChunk = undefined;
          try {
            controller.enqueue(encoder.encode(`event: snapshot\n${chunk}\n`));
          } catch {
            cleanup();
          }
        }
      },
      cancel() {
        // Client disconnect: detach the observer only. Admitted work is never aborted here.
        cleanup();
      },
    });

    // The subscription hydrates with the current view first, then every committed revision;
    // chord keeps at most the newest pending delivery, so this consumer stays bounded too.
    let unsubscribe: () => void;
    try {
      unsubscribe = view.subscribe((conversation) => deliver(conversation));
    } catch (error) {
      // Setup failed: release the view attachment so nothing keeps the mount alive.
      view.dispose();
      throw error;
    }
    this.streams.add(handle);

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  /** Durably admit one input; idempotent per requestId. Returns the submission id immediately. */
  async submit(identity: SessionIdentity, input: SubmitInput): Promise<SubmitReceipt> {
    if (typeof input?.text !== "string" || input.text.length === 0) {
      throw new SessionApiError(400, "input text is required");
    }
    if (typeof input?.requestId !== "string" || input.requestId.length === 0) {
      throw new SessionApiError(400, "requestId is required");
    }
    if (input?.whenBusy !== "steer" && input?.whenBusy !== "followUp") {
      throw new SessionApiError(400, 'whenBusy must be "steer" or "followUp"');
    }
    const init = await this.guard(identity);
    return this.admit(async () => {
      await this.armAlarm("submit");
      // requestId retries (including across DO reincarnations) return the existing submission.
      const submission = await init.root.submit(
        {
          type: "input",
          content: input.text,
          requestId: input.requestId,
          whenBusy: input.whenBusy,
        },
        BACKGROUND_CONTEXT,
      );
      // Hold this incarnation open while the run progresses; the alarm chain is the durable fallback.
      this.ctx.waitUntil(
        submission
          .wait(BACKGROUND_CONTEXT)
          .catch(() => undefined)
          .then(() => this.drive()),
      );
      return { submissionId: submission.id };
    });
  }

  /** Human stop: withdraw queued inputs, abort every live task including background work. */
  async abort(identity: SessionIdentity): Promise<void> {
    const init = await this.guard(identity);
    await init.root.abort(BACKGROUND_CONTEXT, { background: true });
    // Aborted unsafe tool effects stay interrupted; re-derive alarm state from committed work.
    this.drive();
  }

  /** Checkpoint the workspace; rejected while any live task or unsettled submission exists. */
  async checkpoint(identity: SessionIdentity): Promise<WorkspaceCheckpoint> {
    const init = await this.guard(identity);
    return this.admit(async () => {
      await this.rejectBusy(init);
      return init.workspace.checkpoint();
    });
  }

  /**
   * Restore the latest own published checkpoint; rejected while any live work exists. Returns
   * the JSON serialization of the typed snapshot (see contracts.SessionRpcApi), same producer
   * boundary as `snapshot`.
   */
  async restore(identity: SessionIdentity): Promise<string> {
    const init = await this.guard(identity);
    return this.admit(async () => {
      await this.rejectBusy(init);
      const status = await init.workspace.restore();
      if (status.state === "error") {
        throw new SessionApiError(500, status.error ?? "workspace restore failed");
      }
      const view = await init.root.viewState(BACKGROUND_CONTEXT);
      try {
        return JSON.stringify(this.assembleSnapshot(init, view.value));
      } finally {
        view.dispose();
      }
    });
  }

  /** Alarm-driven progress with no client attached; re-arms itself while live work remains. */
  override async alarm(): Promise<void> {
    await this.driveWork();
  }

  // --- Initialization (one per incarnation; failures clear honestly and retry on next call) ---

  private ensureSchema(): Promise<void> {
    if (this.schemaPromise === undefined) {
      this.schemaPromise = this.database.exec(APP_SCHEMA).then(
        () => {
          this.schemaReady = true;
        },
        (error: unknown) => {
          this.schemaPromise = undefined;
          throw error;
        },
      );
    }
    return this.schemaPromise;
  }

  private ensureInitialized(): Promise<Initialized> {
    if (this.initPromise === undefined) {
      const promise = this.initialize().catch((error: unknown) => {
        if (this.initPromise === promise) this.initPromise = undefined;
        throw error;
      });
      this.initPromise = promise;
    }
    return this.initPromise;
  }

  private async initialize(): Promise<Initialized> {
    await this.ensureSchema();

    const container = this.ctx.container;
    if (container === undefined) {
      throw new SessionApiError(500, "container binding is not available on this session");
    }
    // Rebuilt honestly per incarnation (and per retried init attempt).
    this.startNotices.length = 0;
    const exports = this.ctx.exports as { DirectoryBackupGateway: BackupGateway };
    const workspace = new WorkspaceManager(
      container,
      exports.DirectoryBackupGateway,
      this.database,
      {
        sessionId: this.sessionId,
        // Workspace status changes re-push the latest snapshot to connected streams.
        onChange: () => this.broadcastWorkspaceChange(),
      },
    );

    // Same native binding models, provider, and registry on every incarnation.
    const { models, model } = createWorkersAiModels(this.env.AI);
    const registry = createRegistry();
    registry.install(createCodingExtension(workspace));

    // Open the harness over the shared queue. If anything below fails — including the storage
    // open itself — close what was opened (close seals admission and then closes storage) so the
    // next attempt reopens the transaction serial queue as its single owner instead of stacking
    // a second harness over it.
    let storage: SqliteStorage | undefined;
    let harness: Harness | undefined;
    try {
      // Upstream `SqliteStorage.open` closes the passed database facade when its migrations or
      // metadata read fail and rethrows, so a rejected open still leaves this gate closed.
      storage = await SqliteStorage.open(this.database);
      harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: this.harnessSettings,
          env: () => workspace.environment(),
        },
        BACKGROUND_CONTEXT,
      );

      // Root conversation gets the default model with thinking off and the workspace cwd when
      // first created; on later incarnations the stored agent is left untouched.
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model, thinkingLevel: "off", cwd: WORKSPACE_CWD },
      });

      // Reset any dangling container and restore the latest published checkpoint BEFORE resume,
      // so no orphaned Linux command survives into recovered work.
      await workspace.initialize();
      const status = workspace.status();
      if (status.checkpoint !== undefined) {
        this.startNotices.push(
          `workspace restored from checkpoint ${status.checkpoint.key} after session restart`,
        );
      }

      // Durable alarm before enabling live work; resume continues unfinished runs without a client.
      await this.armAlarm("resume");
      harness.resume();
      this.drive();

      // A closing harness honestly ends every attached SSE stream (synchronous listener; no session ops).
      harness.subscribeClose(() => {
        for (const stream of this.streams) stream.end();
      });

      return { harness, root, workspace };
    } catch (error) {
      // Second-phase cleanup: the primary init failure is what surfaces. When the storage open
      // itself failed, upstream already closed the facade (its close is synchronous bookkeeping
      // on this adapter and cannot reject), so the gate's closure is confirmed without a closer
      // here. Otherwise the close seals admission and then closes storage, which closes this
      // incarnation's database gate; the serial queue is released before the rethrow so a retry
      // can reopen as its single owner.
      if (harness === undefined && storage === undefined) {
        this.adoptFreshGate();
        throw error;
      }
      // Exactly one of the two was opened (the early return above covered both-undefined), so
      // the non-null assertion below is exhaustive: `storage` is set whenever `harness` is not.
      const closer =
        harness !== undefined
          ? harness.close(BACKGROUND_CONTEXT)
          : storage!.close(BACKGROUND_CONTEXT);
      try {
        await closer;
      } catch (closeError: unknown) {
        // Preserve both causes. Without a confirmed close the gate's ownership is unknown, so a
        // fresh gate must NOT be adopted (two live gates could stack two harnesses); the next
        // attempt retries and fails honestly until the platform recovers the storage.
        throw new AggregateError(
          [error, closeError],
          "session initialization failed and closing the harness it opened also failed",
        );
      }
      this.adoptFreshGate();
      throw error;
    }
  }

  /**
   * Adopt a fresh usable database gate over the same Durable Object storage. Called only after a
   * failed initialization confirmed the previous gate closed — upstream `SqliteStorage.open`
   * closes the facade when it fails, and harness/storage close seals admission and closes it —
   * and that close has completed, when nothing else owns the old gate: `close` never
   * touches the underlying Durable Object storage and the app schema lives there, so the fresh
   * gate reopens the same data and `schemaReady` stays valid.
   */
  private adoptFreshGate(): void {
    this.database = new DurableSqliteDatabase(this.ctx.storage);
  }

  // --- Identity, admission, and alarm coordination ---

  /**
   * Validate identity on every call: bind once to the stable verified identity (the issuer+sub
   * hash), then require an immutable id match. A re-verified email may change without changing
   * the owner, so the stored email is refreshed as current metadata instead of gating access.
   */
  private async guard(identity: SessionIdentity): Promise<Initialized> {
    if (
      identity === null ||
      typeof identity !== "object" ||
      typeof identity.id !== "string" ||
      identity.id.length === 0 ||
      typeof identity.email !== "string" ||
      identity.email.length === 0
    ) {
      throw new SessionApiError(403, "unverified session identity");
    }
    await this.ensureSchema();
    await this.verifyOwner(identity);
    return this.ensureInitialized();
  }

  private async verifyOwner(identity: SessionIdentity): Promise<void> {
    await this.database.transaction(async (tx) => {
      const row = await tx.get<{ id: string; email: string }>(
        "SELECT id, email FROM app_owner WHERE singleton = 1",
      );
      if (row === undefined) {
        await tx.run(
          "INSERT INTO app_owner (singleton, id, email) VALUES (1, ?, ?)",
          identity.id,
          identity.email,
        );
        return;
      }
      // The stable verified identity is authoritative; an email change is metadata, not a
      // different owner. Write the refresh only when it actually changed.
      if (row.id !== identity.id) {
        throw new SessionApiError(403, "session belongs to a different owner");
      }
      if (row.email !== identity.email) {
        await tx.run("UPDATE app_owner SET email = ? WHERE singleton = 1", identity.email);
      }
    });
  }

  /** Serialize admissions and checkpoint/restore effects against each other. */
  private admit<T>(job: () => Promise<T>): Promise<T> {
    const next = this.admissionTail.then(job, job);
    this.admissionTail = next.catch(() => undefined);
    return next;
  }

  /** Busy rejection: any live task (background included) or unsettled submission blocks. */
  private async rejectBusy(init: Initialized): Promise<void> {
    const inspection = await init.harness.inspect(BACKGROUND_CONTEXT);
    if (hasLiveWork(inspection)) {
      throw new SessionApiError(
        409,
        "session busy: stop live work before checkpointing or restoring",
      );
    }
  }

  /** Arm the durable alarm inside the shared SQL transaction, coordinated with Pi commits. */
  private async armAlarm(reason: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO app_alarm (singleton, reason, armed_at) VALUES (1, ?, ?) " +
          "ON CONFLICT(singleton) DO UPDATE SET reason = excluded.reason, armed_at = excluded.armed_at",
        reason,
        Date.now(),
      );
      await this.ctx.storage.setAlarm(Date.now() + ALARM_LEAD_MS);
    });
  }

  /** Clear the alarm intent and the alarm itself inside the same SQL transaction. */
  private async disarmAlarm(): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.run("DELETE FROM app_alarm WHERE singleton = 1");
      await this.ctx.storage.deleteAlarm();
    });
  }

  /**
   * Durably schedule the next progress pass inside the shared SQL coordination. The native alarm
   * is the actual wake-up and is set first, so it never depends on app tables existing yet; the
   * `app_alarm` row is metadata only and is written whenever the schema is available. If the
   * alarm cannot be persisted (storage/platform failure), this rejects and the caller must not
   * pretend a wake-up was scheduled.
   */
  private async primeAlarm(reason = "progress"): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_LEAD_MS);
      if (this.schemaReady) {
        await tx.run(
          "INSERT INTO app_alarm (singleton, reason, armed_at) VALUES (1, ?, ?) " +
            "ON CONFLICT(singleton) DO UPDATE SET reason = excluded.reason, armed_at = excluded.armed_at",
          reason,
          Date.now(),
        );
      }
    });
  }

  /**
   * One progress pass: resume pending work, recover stranded queued inputs, then keep the alarm
   * chain alive while any task or unsettled submission remains, or clear it once the session is
   * idle. Coalesced so overlapping triggers (alarm fire, submit, resume) share one pass.
   */
  private drive(): void {
    if (this.driving) return;
    this.driving = true;
    this.ctx.waitUntil(
      this.driveWork()
        .catch((error: unknown) => {
          // driveWork only rejects when no durable wake-up could be confirmed (the pass already
          // logged the primary failure and the failed re-arm); keep that state visible here
          // instead of silently dropping it. The platform's own retry of a thrown alarm handler
          // remains the last recovery path until the next client request.
          console.error("session progress trigger failed without a durable wake-up", error);
        })
        .finally(() => {
          this.driving = false;
        }),
    );
  }

  /**
   * One progress pass: resume pending work, recover stranded queued inputs, then keep the alarm
   * chain alive while any task or unsettled submission remains, or clear it once the session is
   * idle. Coalesced so overlapping triggers (alarm fire, submit, resume) share one pass.
   *
   * The whole inspect/recover/arm/disarm decision runs behind the same admission boundary as
   * submit's arm-before-admit: an idle pass can never observe "no work" and delete a wake-up
   * that a concurrent admission just armed, and a pass that follows an admission always sees
   * the freshly admitted work. Everything here joins the admission tail; nothing inside calls
   * back into `admit`, so the chain cannot deadlock.
   *
   * The next wake-up is primed BEFORE any fallible work: a fired alarm is consumed the moment
   * this pass starts, while initialization (container start, R2 checkpoint restore), inspection,
   * and queued-input recovery can all fail — priming keeps accepted work reachable even when the
   * platform's own finite alarm retries are exhausted, with no dropped queued work and no
   * synthetic wake-up input.
   */
  private async driveWork(): Promise<void> {
    await this.admit(async () => {
      await this.primeAlarm();
      try {
        const init = await this.ensureInitialized();
        init.harness.resume();
        let inspection = await init.harness.inspect(BACKGROUND_CONTEXT);
        if (
          inspection.tasks.length === 0 &&
          inspection.submissions.some(
            (submission) =>
              submission.type === "input" &&
              submission.status === "queued" &&
              submission.conversationId === init.root.id,
          )
        ) {
          await this.recoverQueuedInputs(init);
          inspection = await init.harness.inspect(BACKGROUND_CONTEXT);
        }
        if (hasLiveWork(inspection)) {
          await this.armAlarm("live-work");
        } else {
          await this.disarmAlarm();
        }
      } catch (error) {
        // The primed wake-up from the start of this pass is the durable guarantee; re-arm
        // explicitly through this same boundary (the failed initialization may have closed the
        // previous database gate, which its failure path already replaced) so the reason row and
        // the alarm time are current for the retry pass.
        try {
          await this.primeAlarm("progress-failed");
        } catch (armError: unknown) {
          // Alarm storage/platform failure: report both causes honestly rather than pretend a
          // wake-up was persisted. Rethrowing the primary failure keeps it visible (and lets the
          // platform retry a thrown alarm handler) without a durable wake-up behind it.
          console.error(
            "session progress pass failed and the next wake-up could not be re-armed; " +
              "accepted work stays reachable only via the next client request or a successful alarm retry",
            error,
            armError,
          );
          throw error;
        }
        // Durable wake-up confirmed; the failure itself stays visible and the retry pass runs.
        console.error(
          "session progress pass failed; the durable alarm stays armed for a retry",
          error,
        );
      }
    });
  }

  /**
   * Accepted inputs can be stranded queued with no live task (see src/recovery.ts). Recovery
   * runs inside the admission boundary; connected clients learn an autonomous recovery happened
   * via a persisted incarnation notice.
   */
  private async recoverQueuedInputs(init: Initialized): Promise<void> {
    // Resolve the same final-boundary queue modes the harness reads at every boundary: each
    // field over the upstream default `one-at-a-time` (see `resolveSettings`).
    const modes = {
      steeringMode: this.harnessSettings.steeringMode ?? "one-at-a-time",
      followUpMode: this.harnessSettings.followUpMode ?? "one-at-a-time",
    };
    if (await recoverQueuedInputsImpl(init.root, modes)) {
      this.startNotices.push("resumed queued inputs after an interrupted run");
    }
  }

  // --- Snapshots ---

  private assembleSnapshot(init: Initialized, conversation: ConversationView): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      conversation,
      workspace: init.workspace.status(),
      notices: this.notices(init),
    };
  }

  private notices(init: Initialized): string[] {
    const notices = [...this.startNotices];
    const status = init.workspace.status();
    if (status.state === "error" && status.error !== undefined) {
      notices.push(`workspace error: ${status.error}`);
    }
    return notices;
  }

  private broadcastWorkspaceChange(): void {
    for (const handle of this.streams) handle.notify();
  }
}

function hasLiveWork(inspection: HarnessInspection): boolean {
  return inspection.tasks.length > 0 || inspection.submissions.length > 0;
}
