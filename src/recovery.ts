/**
 * Portable public-Pi recovery for stranded queued inputs.
 *
 * Pi 1.0.1 strands an accepted queued follow-up when its run fails: `endRun` settles the run's
 * inputs and runs no final boundary, `Harness.resume()` only enables task scheduling, and a
 * requestId retry dedups to the existing receipt without placing the inbox. This helper places
 * the stranded queued items of a conversation over the same public Tx/inbox mechanics the
 * built-in final boundary uses — writes first, then the user inputs the configured queue modes
 * select in ID order, each keeping its original submission ID and content; unselected user
 * inputs stay queued in the inbox for a later boundary or recovery pass — and starts the run
 * over the placed inputs. No synthetic message, no duplicate, no dropped item.
 *
 * Uses only public chord/pi-durable APIs (no Node or cloudflare: imports), so the worker and
 * its consumer regressions exercise this exact production implementation.
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
  type JsonObject,
  type QueueMode,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { UserMessage } from "@earendil-works/pi-ai";

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
