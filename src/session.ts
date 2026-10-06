/**
 * Session durable object: one persistent Pi session per verified Access identity.
 *
 * Hosting is the Agents SDK's `Lifecycle` plus `PiHarness` (`agents/harness/pi`). `PiHarness`
 * opens Pi's durable `Harness` over its own `pi_`-prefixed store in this object's SQLite database
 * and owns the durable wake: one `Lifecycle` job per session that keeps the object alive while Pi
 * has live tasks and restarts it through the alarm after an eviction, so admitted work resumes
 * with no client attached. Lifecycle startup runs inside `blockConcurrencyWhile`, so the harness
 * factory below never touches the container or R2; the workspace restores lazily (`ensureReady`
 * at startup, and in front of every tool, checkpoint, and restore).
 *
 * Two things `PiHarness` does not cover live here:
 * - Stranded queued inputs (see src/recovery.ts): a host `Lifecycle` job, pushed before every
 *   admission, heartbeats while unsettled work exists and recovers them.
 * - Abort including background tasks, through the `pi()` escape hatch.
 *
 * Application tables (`app_owner`, `app_workspace_checkpoints`) sit outside `PiHarness`'s private
 * SQL queue. No app transaction can interleave with one of Pi's: the owner check is one
 * `transactionSync`, and checkpoint pointers are written in single statements through their
 * own `DurableSqliteDatabase` gate. Disconnected SSE streams detach their observer only;
 * admitted work always continues.
 * Interrupted unsafe tool effects surface honestly as `interrupted`, never replayed.
 */
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  type Conversation,
  type ConversationView,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import type { DirectoryBackup } from "@cloudflare/sandbox";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { DurableSqliteDatabase } from "./adapters/durable-sqlite";
import { createCodingExtension, WORKSPACE_CWD } from "./coding";
import type { AppEnv, SessionIdentity } from "./env";
import { createWorkersAiModels } from "./models";
import { legacyPiTableMigration } from "./pi-table-migration";
import {
  driveQueuedRecovery,
  hasUnsettledWork,
  recoveryJob,
  watchUnsettledWork,
  type QueueModes,
} from "./recovery";
import type { SessionSnapshot, SubmitInput, SubmitReceipt, WorkspaceCheckpoint } from "./contracts";
import { WorkspaceManager } from "./workspace";

/**
 * Application-owned tables, separate from Pi's. `app_alarm` belonged to the hand-rolled alarm
 * chain that `Lifecycle` jobs replaced; dropping it is harmless to a rollback, which recreates it.
 */
const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL,
  email TEXT NOT NULL
);
DROP TABLE IF EXISTS app_alarm;
`;

/**
 * Harness-wide run policy, passed to `Harness.open` and read by queued-input recovery. Steering
 * and follow-up queue modes stay unset, so they resolve to the upstream default `one-at-a-time`.
 */
const HARNESS_SETTINGS: HarnessSettings = { toolExecution: "sequential" };

/** The final-boundary queue modes `HARNESS_SETTINGS` implies (upstream `resolveSettings`). */
const QUEUE_MODES: QueueModes = {
  steeringMode: HARNESS_SETTINGS.steeringMode ?? "one-at-a-time",
  followUpMode: HARNESS_SETTINGS.followUpMode ?? "one-at-a-time",
};

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

/** What a verified call works with; identity binding is verified per call, never cached. */
interface Started {
  readonly pi: Harness;
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
  /** Gate for the application tables only; Pi's tables are behind `PiHarness`'s own queue. */
  private readonly appDb = new DurableSqliteDatabase(this.ctx.storage);
  private readonly streams = new Set<StreamHandle>();
  private readonly startNotices: string[] = [];
  private readonly lifecycle: Lifecycle;
  private readonly harness: PiHarness;
  /** Built by the harness factory during Lifecycle startup; set whenever startup succeeded. */
  private workspace: WorkspaceManager | undefined;
  private root: Conversation | undefined;
  /** The Harness the factory last opened, closed before a retried startup opens another. */
  private openedPi: Harness | undefined;
  private restoreNoticed = false;
  private admissionTail: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(APP_SCHEMA);
    const { models, model } = createWorkersAiModels(env.AI);
    this.harness = new PiHarness({
      // Runs inside Lifecycle startup (blockConcurrencyWhile): no container or R2 work here.
      harness: async ({ storage, context }) => {
        // `PiHarness` keeps nothing from a startup that failed after this factory returned;
        // never leave that Harness running beside the one opened now.
        await this.openedPi?.close(context).catch(() => undefined);
        this.openedPi = undefined;
        const workspace = this.buildWorkspace();
        const registry = createRegistry();
        registry.install(createCodingExtension(workspace));
        const pi = await Harness.open(
          storage,
          { models, registry, settings: HARNESS_SETTINGS, env: () => workspace.environment() },
          context,
        );
        this.openedPi = pi;
        // `PiSessionDefaults` cannot carry `cwd`, so the root is created here first; the
        // harness's own `root(defaults)` call then finds it and leaves it untouched, as does
        // every later incarnation.
        this.root = await pi.root(context, {
          agent: { model, thinkingLevel: "off", cwd: WORKSPACE_CWD },
        });
        // A closing harness honestly ends every attached SSE stream.
        pi.subscribeClose(() => {
          for (const stream of this.streams) stream.end();
        });
        this.workspace = workspace;
        return pi;
      },
      defaults: { model: { provider: model.provider, id: model.modelId }, thinkingLevel: "off" },
    });
    // No `alarm()` on this class: Lifecycle installs its own only where the host has none.
    this.lifecycle = Lifecycle.install(this);
    // Capabilities start in install order: the legacy table move precedes PiHarness's store open.
    this.lifecycle.use(legacyPiTableMigration(ctx.storage));
    this.lifecycle.use(this.harness);
  }

  // --- Lifecycle host hooks ---
  // Instance properties, not methods: Workers RPC exposes only prototype methods, so these stay
  // off the object's RPC surface (they skip `guard()`), while Lifecycle still finds them.

  /** Runs after `PiHarness.onStart` (Pi open, live sessions re-woken), inside startup. */
  onStart = async (): Promise<void> => {
    await watchUnsettledWork(this.harness, this.lifecycle);
    // Not awaited: container start and R2 restore can outlast startup's time limit. A failure
    // is published on the workspace status, and the next tool retries.
    this.ctx.waitUntil(this.workspace!.ensureReady().catch(() => undefined));
  };

  /** Host jobs: only the queued-input recovery job (see src/recovery.ts). */
  onJob = async (context: LifecycleJobContext): Promise<LifecycleJobOutcome> =>
    driveQueuedRecovery(this.harness, context, {
      modes: QUEUE_MODES,
      onRecovered: () => {
        this.startNotices.push("resumed queued inputs after an interrupted run");
      },
    });

  // --- Public API (called over RPC by the authenticated worker) ---

  /**
   * Full committed session state: conversation view, workspace cache, and notices. Returns the
   * JSON serialization of the typed snapshot (see contracts.SessionRpcApi): the string crosses
   * the RPC boundary and the worker forwards it as the public application/json body unchanged.
   */
  async snapshot(identity: SessionIdentity): Promise<string> {
    const { root, workspace } = await this.guard(identity);
    return this.renderSnapshot(root, workspace);
  }

  /** Bounded, coalesced SSE stream of committed snapshots; disconnect detaches only. */
  async events(identity: SessionIdentity): Promise<Response> {
    const { root, workspace } = await this.guard(identity);
    const view = await root.viewState(BACKGROUND_CONTEXT);
    const encoder = new TextEncoder();

    let closed = false;
    let pendingChunk: string | undefined;
    let lastView: ConversationView | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

    const assemble = (conversation: ConversationView): SessionSnapshot =>
      this.assembleSnapshot(workspace, conversation);

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

  /**
   * Durably admit one input; idempotent per requestId (the operation id). A retry of an admitted
   * requestId returns `accepted: false` and queues nothing.
   */
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
    await this.guard(identity);
    return this.admit(async () => {
      // The recovery job is durable before the input is: a run that strands this input can
      // never leave it without a wake-up. `PiHarness` schedules its own wake job the same way.
      await this.watchQueued();
      const receipt = await this.harness.submit(input.text, {
        operationId: input.requestId,
        whenBusy: input.whenBusy,
      });
      return { operationId: receipt.operationId, accepted: receipt.accepted };
    });
  }

  /** Human stop: withdraw queued inputs, abort every live task including background work. */
  async abort(identity: SessionIdentity): Promise<void> {
    const { root } = await this.guard(identity);
    // `PiSession.abort()` leaves background tasks running; keep today's semantics via `pi()`.
    await root.abort(BACKGROUND_CONTEXT, { background: true });
  }

  /** Checkpoint the workspace; rejected while any live task or unsettled submission exists. */
  async checkpoint(identity: SessionIdentity): Promise<WorkspaceCheckpoint> {
    const { pi, workspace } = await this.guard(identity);
    return this.admit(async () => {
      await rejectBusy(pi);
      return workspace.checkpoint();
    });
  }

  /**
   * Restore the latest own published checkpoint; rejected while any live work exists. Returns
   * the JSON serialization of the typed snapshot (see contracts.SessionRpcApi), same producer
   * boundary as `snapshot`.
   */
  async restore(identity: SessionIdentity): Promise<string> {
    const { pi, root, workspace } = await this.guard(identity);
    return this.admit(async () => {
      await rejectBusy(pi);
      const status = await workspace.restore();
      if (status.state === "error") {
        throw new SessionApiError(500, status.error ?? "workspace restore failed");
      }
      return this.renderSnapshot(root, workspace);
    });
  }

  // --- Startup, identity, and admission ---

  /** The workspace for this incarnation; requires the container binding. No I/O. */
  private buildWorkspace(): WorkspaceManager {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new SessionApiError(500, "container binding is not available on this session");
    }
    const exports = this.ctx.exports as { DirectoryBackupGateway: BackupGateway };
    return new WorkspaceManager(container, exports.DirectoryBackupGateway, this.appDb, {
      sessionId: this.sessionId,
      // Workspace status changes re-push the latest snapshot to connected streams.
      onChange: () => this.broadcastWorkspaceChange(),
      // Only the first restore of an incarnation is a restart; later ones follow an idle stop.
      onRestored: (checkpoint) => {
        if (this.restoreNoticed) return;
        this.restoreNoticed = true;
        this.startNotices.push(
          `workspace restored from checkpoint ${checkpoint.key} after session restart`,
        );
      },
    });
  }

  /**
   * Validate identity on every call: bind once to the stable verified identity (the issuer+sub
   * hash), then require an immutable id match. Then start the Lifecycle (native RPC bypasses the
   * fetch handler that would otherwise start it); a failed startup rejects this call honestly and
   * is retried by the next one.
   */
  private async guard(identity: SessionIdentity): Promise<Started> {
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
    this.verifyOwner(identity);
    await this.lifecycle.start();
    const pi = await this.harness.pi();
    return { pi, root: this.root!, workspace: this.workspace! };
  }

  /**
   * A re-verified email may change without changing the owner, so the stored email is refreshed
   * as current metadata instead of gating access. One synchronous transaction: it cannot
   * interleave with a Pi transaction.
   */
  private verifyOwner(identity: SessionIdentity): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ id: string; email: string }>("SELECT id, email FROM app_owner WHERE singleton = 1")
        .toArray()[0];
      if (row === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO app_owner (singleton, id, email) VALUES (1, ?, ?)",
          identity.id,
          identity.email,
        );
        return;
      }
      if (row.id !== identity.id) {
        throw new SessionApiError(403, "session belongs to a different owner");
      }
      if (row.email !== identity.email) {
        this.ctx.storage.sql.exec(
          "UPDATE app_owner SET email = ? WHERE singleton = 1",
          identity.email,
        );
      }
    });
  }

  /** Serialize admissions and checkpoint/restore effects against each other. */
  private admit<T>(job: () => Promise<T>): Promise<T> {
    const next = this.admissionTail.then(job, job);
    this.admissionTail = next.catch(() => undefined);
    return next;
  }

  /** Schedule the recovery job now (single-flight; a push replaces and pulls the row forward). */
  private async watchQueued(): Promise<void> {
    await this.lifecycle.jobs.push(recoveryJob());
  }

  // --- Snapshots ---

  private async renderSnapshot(root: Conversation, workspace: WorkspaceManager): Promise<string> {
    const view = await root.viewState(BACKGROUND_CONTEXT);
    try {
      return JSON.stringify(this.assembleSnapshot(workspace, view.value));
    } finally {
      view.dispose();
    }
  }

  private assembleSnapshot(
    workspace: WorkspaceManager,
    conversation: ConversationView,
  ): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      conversation,
      workspace: workspace.status(),
      notices: this.notices(workspace),
    };
  }

  private notices(workspace: WorkspaceManager): string[] {
    const notices = [...this.startNotices];
    const status = workspace.status();
    if (status.state === "error" && status.error !== undefined) {
      notices.push(`workspace error: ${status.error}`);
    }
    return notices;
  }

  private broadcastWorkspaceChange(): void {
    for (const handle of this.streams) handle.notify();
  }
}

/** Busy rejection: any live task (background included) or unsettled submission blocks. */
async function rejectBusy(pi: Harness): Promise<void> {
  if (hasUnsettledWork(await pi.inspect(BACKGROUND_CONTEXT))) {
    throw new SessionApiError(
      409,
      "session busy: stop live work before checkpointing or restoring",
    );
  }
}
