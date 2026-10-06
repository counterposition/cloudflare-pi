/**
 * Portable public-Pi recovery for stranded queued inputs.
 *
 * Pi Durable 1.0.1 and 1.0.2 strand an accepted queued follow-up when its run fails: `endRun`
 * settles the run's inputs and runs no final boundary, `Harness.resume()` only enables task
 * scheduling, and a requestId retry dedups to the existing receipt without placing the inbox.
 * This helper places the stranded queued items of a conversation over the same public Tx/inbox
 * mechanics the built-in final boundary uses — writes first, then the user inputs the configured
 * queue modes select in ID order, each keeping its original submission ID and content;
 * unselected user inputs stay queued in the inbox for a later boundary or recovery pass — and
 * starts the run over the placed inputs. No synthetic message, no duplicate, no dropped item.
 *
 * `PiHarness` (agents 0.26.0) does not recover them either: its per-session wake job completes
 * once a session has no tasks, so a stranded follow-up has nothing left to place it.
 * `driveQueuedRecovery` is the host `Lifecycle` job that does: it heartbeats while unsettled work
 * exists, places stranded inputs with `recoverQueuedInputs`, and re-wakes the harness for the
 * recovered run.
 *
 * Uses only public chord/pi-durable APIs and type-only `agents` imports (no Node or cloudflare:
 * imports), so the worker, the workerd hosting tests, and the consumer regressions all exercise
 * this exact production implementation.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  GenerationTask,
  InboxDoc,
  LiveDoc,
  UserEntry,
  type Conversation,
  type EntryDraft,
  type HarnessInspection,
  type JsonObject,
  type QueueMode,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { PiHarness } from "agents/harness/pi";
import type {
  Lifecycle,
  LifecycleJobContext,
  LifecycleJobOutcome,
  LifecycleJobPushOptions,
} from "agents/lifecycle";

/** The queue-mode settings a final boundary reads (upstream `harness/inbox.ts` `QueueModes`). */
export type QueueModes = { steeringMode: QueueMode; followUpMode: QueueMode };

/**
 * Narrows a stored inbox entry to the documented `EntryDraft` shape. Stored inbox entries are
 * plain JSON by design (the built-in boundary re-appends them the same way), so this truthfully
 * checks the fields the recovery pass relies on — the required string `kind` and, when present,
 * the `head` marker (an entry ID number or `"self"`) and `model` message array — and passes
 * every other JSON field through untouched as draft metadata.
 */
function narrowEntryDraft(raw: JsonObject): EntryDraft | undefined {
  if (typeof raw.kind !== "string") return undefined;
  const { head, model } = raw;
  if (head !== undefined && head !== "self" && typeof head !== "number") return undefined;
  if (model !== undefined && !Array.isArray(model)) return undefined;
  // The library's own serialization of an `EntryDraft`: every field the recovery relies on was
  // shape-checked above, and this decoding boundary re-applies the erased entry-ID brand and
  // message tuple types, dropping nothing.
  return raw as unknown as EntryDraft;
}

/**
 * Place the root conversation's stranded queued items and start the run over them, with the
 * final-boundary selection rules the configured queue modes imply: every write, then the first
 * user item of each mode in ID order (`one-at-a-time`, the upstream default) or every item of a
 * mode configured `all`. Unselected user items stay queued in the inbox with their original
 * submission IDs for a later boundary or recovery pass. Returns whether a recovery actually
 * happened: `false` when a run already owns the inbox, when the inbox is empty, or when only
 * honestly-settled writes were present (no run to start).
 */
export async function recoverQueuedInputs(
  root: Conversation,
  modes: QueueModes = { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
  context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
  const conversationId = root.id;
  return root.commit<boolean>(async (tx) => {
    // Table reads precede the first table write, as the built-in boundary prepares them.
    const live = await tx.doc(LiveDoc, conversationId);
    // A run started meanwhile owns the inbox; its boundaries place queued items.
    if (live.run !== undefined) return false;
    const inbox = await tx.doc(InboxDoc, conversationId);
    if (inbox.items.length === 0) return false;
    let head = (await tx.latestHeadMarker(conversationId))?.head;
    const now = Date.now();
    // Writes first, in ID order, matching the built-in boundary: stale head writes settle
    // honestly, placed writes advance the head, and malformed drafts settle `invalid`.
    for (const item of inbox.items) {
      if (item.mode !== "write") continue;
      const draft = narrowEntryDraft(item.entry);
      if (draft === undefined) {
        // A stored entry outside the documented shape cannot be re-appended; settle it honestly
        // rather than resurrecting malformed data.
        tx.settleSubmission(item.id, { status: "unanswered", reason: "invalid" });
        continue;
      }
      if (typeof draft.head === "number" && head !== undefined && draft.head < head) {
        // A head write before the active range would bring back cut history; settle honestly.
        tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
      } else {
        const entry = await tx.appendEntry(conversationId, draft);
        if (draft.head !== undefined) head = draft.head === "self" ? entry.id : draft.head;
        tx.placeSubmission(item.id, entry.id);
      }
    }
    // Final-boundary user selection (spec §6, `applyBoundary` at `final`): user items in
    // original inbox (ID) order, after the writes. `one-at-a-time` takes the first item of that
    // mode, `all` every item of that mode. Unselected items compact in place (writes drop;
    // they were placed or honestly settled above), so no per-item allocation or rescan.
    let steerTaken = false;
    let followUpTaken = false;
    const placedIds: SubmissionId[] = [];
    let kept = 0;
    // Compaction only writes at positions the iteration has already passed, so iterating the
    // array directly stays safe; the truncate below happens after the loop.
    for (const item of inbox.items) {
      if (item.mode === "write") continue;
      const taken = item.mode === "steer" ? steerTaken : followUpTaken;
      const queueMode = item.mode === "steer" ? modes.steeringMode : modes.followUpMode;
      if (taken && queueMode !== "all") {
        inbox.items[kept++] = item;
        continue;
      }
      const message: UserMessage = { role: "user", content: item.content, timestamp: now };
      const entry = await tx.appendEntry(UserEntry, conversationId, { model: [message] });
      tx.placeSubmission(item.id, entry.id);
      placedIds.push(item.id);
      if (item.mode === "steer") steerTaken = true;
      else followUpTaken = true;
    }
    inbox.items.length = kept;
    if (placedIds.length === 0) return false;
    // A run over the placed inputs, as `startRun` builds it for the built-in boundary.
    const taskId = await tx.createTask(
      GenerationTask,
      {},
      {
        ownership: { kind: "conversation" },
        conversationId,
      },
    );
    live.run = { taskId, inputs: placedIds };
    return true;
  }, context);
}

/** The host `Lifecycle` job that recovers stranded queued inputs (one per object). */
export const RECOVERY_JOB = { id: "recover-queued", fn: "recover-queued" } as const;

/**
 * How often the recovery job re-checks while unsettled work exists. Nothing reacts to a failed
 * run settling, so this bounds how long a stranded follow-up sits queued; it matches the 1 s
 * alarm cadence of the hand-rolled host it replaced.
 */
export const RECOVERY_HEARTBEAT_MS = 1_000;

/** The recovery job, due at `time`. Pushing it again replaces (and pulls forward) the row. */
export function recoveryJob(time = Date.now()): LifecycleJobPushOptions {
  return { ...RECOVERY_JOB, time, singleflight: true };
}

/** Any live task or unsettled submission: the work the recovery job watches. */
export function hasUnsettledWork(inspection: HarnessInspection): boolean {
  return inspection.tasks.length > 0 || inspection.submissions.length > 0;
}

/**
 * Host `onStart` half of the recovery contract: unsettled work left by an earlier incarnation
 * (or by the pre-`Lifecycle` host, which had no job row) gets the recovery job. Every admission
 * pushes the job itself; from then on its row is durable.
 */
export async function watchUnsettledWork(harness: PiHarness, lifecycle: Lifecycle): Promise<void> {
  const pi = await harness.pi();
  if (hasUnsettledWork(await pi.inspect(BACKGROUND_CONTEXT))) {
    await lifecycle.jobs.push(recoveryJob());
  }
}

export interface QueuedRecoveryOptions {
  /** The queue modes the harness was opened with (default: upstream `one-at-a-time`). */
  readonly modes?: QueueModes;
  /** Called after a recovery placed stranded inputs and started their run. */
  readonly onRecovered?: () => void;
  /** Heartbeat while unsettled work exists (default {@link RECOVERY_HEARTBEAT_MS}). */
  readonly heartbeatMs?: number;
}

/**
 * One run of the recovery job. With no live task and queued root inputs, it places them with
 * {@link recoverQueuedInputs} and then calls `PiHarness`'s public `onStart()`, which pushes the
 * durable wake job for every session that now has tasks, so the recovered run survives eviction.
 * It reschedules itself while any task or unsettled submission remains and completes (its row is
 * deleted) once the object is idle. Jobs with another `fn` are completed untouched.
 */
export async function driveQueuedRecovery(
  harness: PiHarness,
  context: LifecycleJobContext,
  options: QueuedRecoveryOptions = {},
): Promise<LifecycleJobOutcome> {
  if (context.job.fn !== RECOVERY_JOB.fn) return undefined;
  const heartbeat = { rescheduleAt: Date.now() + (options.heartbeatMs ?? RECOVERY_HEARTBEAT_MS) };
  try {
    return await recoverOnce(harness, options, heartbeat);
  } catch (error) {
    // Never let Lifecycle's retry policy delete this row: a thrown pass would leave a stranded
    // input with no wake-up. Report and keep heartbeating instead.
    console.error("queued-input recovery pass failed; retrying on the next heartbeat", error);
    return heartbeat;
  }
}

async function recoverOnce(
  harness: PiHarness,
  options: QueuedRecoveryOptions,
  heartbeat: { rescheduleAt: number },
): Promise<LifecycleJobOutcome> {
  const pi = await harness.pi();
  const root = await pi.root(BACKGROUND_CONTEXT);
  let inspection = await pi.inspect(BACKGROUND_CONTEXT);
  const stranded =
    inspection.tasks.length === 0 &&
    inspection.submissions.some(
      (submission) =>
        submission.type === "input" &&
        submission.status === "queued" &&
        submission.conversationId === root.id,
    );
  if (stranded && (await recoverQueuedInputs(root, options.modes))) {
    options.onRecovered?.();
    // The recovered run is a new task; this re-wake is what keeps it alive across eviction.
    await harness.onStart({ props: undefined });
    inspection = await pi.inspect(BACKGROUND_CONTEXT);
  }
  return hasUnsettledWork(inspection) ? heartbeat : undefined;
}
