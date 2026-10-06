/**
 * Consumer regressions over the real Pi Harness public API — no mocks, no billed calls.
 *
 * Pi Durable 1.0.1 and 1.0.2 strand an accepted queued follow-up when its run fails: `endRun`
 * settles the run's inputs and runs no final boundary, `Harness.resume()` only enables task
 * scheduling, and a requestId retry dedups to the existing receipt without placing the inbox.
 * The session backend (src/session.ts) therefore recovers such inputs in a host `Lifecycle` job
 * that runs concurrently with admissions (the run check happens inside the recovery commit),
 * using the shared portable helper (src/recovery.ts) over the same public Tx/inbox mechanics
 * the built-in final boundary uses. These tests pin the
 * exact behavior that recovery depends on — the stranding itself, requestId dedup, persistence
 * across a full storage reopen (durable-object reincarnation), and honest settlement of a stale
 * write that would otherwise resurrect cut history.
 *
 * The provider is the pi-ai faux provider scripted with a model-error response: deterministic,
 * entirely local, and never billed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { FauxProviderHandle, FauxResponseStep, TextContent } from "@earendil-works/pi-ai";
import {
  Harness,
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  UserEntry,
  createRegistry,
  type Conversation,
  type EntryRecord,
  type HarnessInspection,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { recoverQueuedInputs } from "../src/recovery";
import { describe, expect, it } from "vitest";

/** How long the scripted provider holds a deferred request before the next poll (real timers). */
const POLL_AFTER_MS = 250;
/** Upper bound for any wait on observable harness state; the conditions below settle in ms. */
const WAIT_BUDGET_MS = 10_000;

/** A valid provider failure: an assistant message with a terminal error stop reason. */
const providerFailure = (): FauxResponseStep =>
  fauxAssistantMessage("provider unavailable", {
    stopReason: "error",
    errorMessage: "provider unavailable",
  });

/** Opens a real harness over `storage` with the faux provider scripted with `responses`. */
async function openHarness(
  storage: Storage,
  responses: FauxResponseStep[],
): Promise<{ harness: Harness; root: Conversation; faux: FauxProviderHandle }> {
  const faux = fauxProvider({ deferred: { pendingFetches: 1, pollAfterMs: POLL_AFTER_MS } });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      settings: { stream: { deferred: true }, retry: { enabled: false } },
    },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  const model = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" },
  });
  return { harness, root, faux };
}

/**
 * Polls observable harness state until `pick` returns a value; the conditions used here are stable
 * once true. This deliberately uses the platform clock: the harness exposes no completion signal
 * for intermediate task phases, and the deferred hold under test lives inside pi-durable's durable
 * scheduler, whose timers fake timers cannot drive.
 */
async function waitForInspection<T>(
  harness: Harness,
  pick: (inspection: HarnessInspection) => T | undefined,
  description: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  for (;;) {
    const picked = pick(await harness.inspect(BACKGROUND_CONTEXT));
    if (picked !== undefined) return picked;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await sleepMs(5);
  }
}

/** Resolves after `ms` platform-clock milliseconds; used only by the state poll above. */
function sleepMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** True while a generation is parked in its deferred poll phase: busy for the whole hold window. */
const inPollPhase = (inspection: HarnessInspection): boolean =>
  inspection.tasks.some((task) => {
    if (task.record.state.status !== "running") return false;
    const checkpoint = task.record.state.checkpoint;
    if (typeof checkpoint !== "object" || checkpoint === null) return false;
    if (!("phase" in checkpoint)) return false;
    return checkpoint.phase === "poll";
  });

/** All user text contributed by one entry's model messages, in message order. */
function entryUserTexts(entry: EntryRecord): string[] {
  return (entry.model ?? []).flatMap((message) => {
    if (message.role !== "user") return [];
    if (typeof message.content === "string") return [message.content];
    return message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text);
  });
}

describe("queued-input recovery over the real Pi harness", () => {
  it("keeps an accepted queued follow-up after its run fails, dedups retries across reopen, and recovers it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-session-recovery-"));
    try {
      const dbPath = join(dir, "session.sqlite");
      const first = await openHarness(await openNodeSqliteStorage(dbPath), [providerFailure()]);
      const { harness, root } = first;

      const failed = await root.submit(
        { type: "input", content: "first", requestId: "r1", whenBusy: "followUp" },
        BACKGROUND_CONTEXT,
      );
      // Deterministic hold: wait until the run is parked in its deferred poll phase, then queue
      // the follow-up while the conversation is provably busy.
      await waitForInspection(
        harness,
        (inspection) => (inPollPhase(inspection) ? true : undefined),
        "the run to enter its deferred poll phase",
      );
      const followUp = await root.submit(
        { type: "input", content: "second", requestId: "r2", whenBusy: "followUp" },
        BACKGROUND_CONTEXT,
      );
      expect((await followUp.status(BACKGROUND_CONTEXT)).status).toBe("queued");

      // The run fails; Pi settles the run input and never places the queued follow-up.
      const receipt = await failed.wait(BACKGROUND_CONTEXT);
      expect(receipt.status).toBe("unanswered");
      expect(receipt.reason).toBe("model_error");
      const stranded = await harness.inspect(BACKGROUND_CONTEXT);
      expect(stranded.tasks).toHaveLength(0);
      expect(stranded.submissions.map((s) => [s.id, s.status])).toEqual([[followUp.id, "queued"]]);

      // resume() only enables scheduling; the requestId retry dedups to the existing submission
      // without placing the inbox.
      harness.resume();
      const retried = await root.submit(
        { type: "input", content: "second", requestId: "r2", whenBusy: "followUp" },
        BACKGROUND_CONTEXT,
      );
      expect(retried.id).toBe(followUp.id);
      expect((await harness.inspect(BACKGROUND_CONTEXT)).submissions.map((s) => s.status)).toEqual([
        "queued",
      ]);

      // Reincarnation: a fresh harness over the same storage sees the same stranded input with
      // no live task, and the retry still dedups instead of admitting a second copy.
      await harness.close(BACKGROUND_CONTEXT);
      const second = await openHarness(await openNodeSqliteStorage(dbPath), [providerFailure()]);
      const { harness: reopened, root: reopenedRoot, faux } = second;
      const afterReopen = await reopened.inspect(BACKGROUND_CONTEXT);
      expect(afterReopen.tasks).toHaveLength(0);
      expect(afterReopen.submissions.map((s) => [s.id, s.status])).toEqual([
        [followUp.id, "queued"],
      ]);
      const reacquired = await reopened.submission(followUp.id, BACKGROUND_CONTEXT);
      if (reacquired === undefined) throw new Error("queued submission lost across reopen");
      const retriedAgain = await reopenedRoot.submit(
        { type: "input", content: "second", requestId: "r2", whenBusy: "followUp" },
        BACKGROUND_CONTEXT,
      );
      expect(retriedAgain.id).toBe(followUp.id);

      // The backend's recovery pass places the accepted input over the public Tx/inbox mechanics
      // and restarts the run over it; the scripted provider now answers.
      faux.setResponses([fauxAssistantMessage("recovered answer")]);
      expect(await recoverQueuedInputs(reopenedRoot)).toBe(true);
      const settled = await reacquired.wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe("done");
      const drained = await reopened.inspect(BACKGROUND_CONTEXT);
      expect(drained.tasks).toHaveLength(0);
      expect(drained.submissions).toHaveLength(0);

      // No duplicate admission: each accepted input is in the active model context exactly once,
      // in chronological view order, across the reopen and the deduped retries.
      const view = await reopenedRoot.viewState(BACKGROUND_CONTEXT);
      try {
        expect(view.value.entries.flatMap(entryUserTexts)).toEqual(["first", "second"]);
      } finally {
        view.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("settles a stranded stale write honestly instead of resurrecting cut history", async () => {
    const { harness, root, faux } = await openHarness(new MemoryStorage(), [providerFailure()]);

    const failed = await root.submit(
      { type: "input", content: "first", requestId: "r1", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    const placed = await failed.status(BACKGROUND_CONTEXT);
    if (placed.status !== "placed") {
      throw new Error(`run input not placed as expected: ${JSON.stringify(placed)}`);
    }
    const beforeReset = placed.entry;

    await waitForInspection(
      harness,
      (inspection) => (inPollPhase(inspection) ? true : undefined),
      "the run to enter its deferred poll phase",
    );
    // Queue, in ID order: a reset (head "self"), a write pinned before that reset, and a user
    // input. The failing run leaves all three stranded with no live task.
    await root.reset("fresh context", BACKGROUND_CONTEXT);
    const staleWrite = await root.submit(
      {
        type: "write",
        entry: {
          kind: UserEntry.kind,
          model: [{ role: "user", content: "stale replay", timestamp: Date.now() }],
          head: beforeReset,
        },
      },
      BACKGROUND_CONTEXT,
    );
    const followUp = await root.submit(
      { type: "input", content: "second", requestId: "r2", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );

    const receipt = await failed.wait(BACKGROUND_CONTEXT);
    expect(receipt.status).toBe("unanswered");
    expect(receipt.reason).toBe("model_error");
    expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks).toHaveLength(0);

    // Recovery: the reset starts the new context, the pinned write settles `unanswered`/`stale`
    // instead of re-entering history, and the run restarts over the user input.
    faux.setResponses([fauxAssistantMessage("recovered answer")]);
    expect(await recoverQueuedInputs(root)).toBe(true);

    const staleRecord = await staleWrite.status(BACKGROUND_CONTEXT);
    expect(staleRecord.status).toBe("unanswered");
    if (staleRecord.status === "unanswered") expect(staleRecord.reason).toBe("stale");
    expect(staleRecord.entry).toBeUndefined();

    const settled = await followUp.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");

    // The active context starts at the reset handoff and carries the recovered input only; the
    // reset handoff text lives in the pi.reset entry's model messages, the recovered input in
    // its pi.user entry, and neither the pre-reset history nor the stale write appears.
    const view = await root.viewState(BACKGROUND_CONTEXT);
    try {
      const active = view.value.entries;
      expect(active.filter((entry) => entry.kind === "pi.reset")).toHaveLength(1);
      expect(active.flatMap(entryUserTexts)).toEqual(["fresh context", "second"]);
    } finally {
      view.dispose();
    }
    // The stale write was never appended anywhere in the transcript, cut history included.
    const transcript = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(transcript.items.flatMap(entryUserTexts)).not.toContain("stale replay");

    // Nothing strands: the recovery run drained every task and unsettled submission.
    const drained = await harness.inspect(BACKGROUND_CONTEXT);
    expect(drained.tasks).toHaveLength(0);
    expect(drained.submissions).toHaveLength(0);
  }, 30_000);

  it("recovers one queued follow-up per generation under the default one-at-a-time modes", async () => {
    const { harness, root, faux } = await openHarness(new MemoryStorage(), [providerFailure()]);

    const failed = await root.submit(
      { type: "input", content: "first", requestId: "r1", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    await waitForInspection(
      harness,
      (inspection) => (inPollPhase(inspection) ? true : undefined),
      "the run to enter its deferred poll phase",
    );
    // Queue two more follow-ups while the run is provably busy; the failing run strands both.
    const second = await root.submit(
      { type: "input", content: "second", requestId: "r2", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    const third = await root.submit(
      { type: "input", content: "third", requestId: "r3", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    const receipt = await failed.wait(BACKGROUND_CONTEXT);
    expect(receipt.status).toBe("unanswered");
    expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks).toHaveLength(0);

    // First recovery pass: the default modes mirror the harness's one-at-a-time boundaries, so
    // only the oldest stranded input joins the run; the younger one stays queued in place. The
    // provider is still failing, and a failed run settles its own inputs without a final
    // boundary, so the younger input strands again for a later pass.
    faux.setResponses([providerFailure()]);
    expect(await recoverQueuedInputs(root)).toBe(true);
    const firstPass = await root.commit(
      async (tx) => ({
        inputs: [...(await tx.doc(LiveDoc, root.id)).run!.inputs],
        queued: (await tx.doc(InboxDoc, root.id)).items.map((item) => item.id),
      }),
      BACKGROUND_CONTEXT,
    );
    expect(firstPass.inputs).toEqual([second.id]);
    expect(firstPass.queued).toEqual([third.id]);

    // The second generation runs and fails on its own; the queued turn stays untouched in the
    // inbox with no live task, exactly as the first strand did.
    expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
    const betweenPasses = await harness.inspect(BACKGROUND_CONTEXT);
    expect(betweenPasses.tasks).toHaveLength(0);
    expect(betweenPasses.submissions.map((s) => [s.id, s.status])).toEqual([[third.id, "queued"]]);

    // Second recovery pass: the next generation starts over the retained input alone, keeping
    // queued turns in separate generations one per pass.
    faux.setResponses([fauxAssistantMessage("third answer")]);
    expect(await recoverQueuedInputs(root)).toBe(true);
    expect((await third.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    // Each accepted input landed exactly once, in recovery order.
    const view = await root.viewState(BACKGROUND_CONTEXT);
    try {
      expect(view.value.entries.flatMap(entryUserTexts)).toEqual(["first", "second", "third"]);
    } finally {
      view.dispose();
    }
    const drained = await harness.inspect(BACKGROUND_CONTEXT);
    expect(drained.tasks).toHaveLength(0);
    expect(drained.submissions).toHaveLength(0);
  }, 30_000);

  it("recovers every queued follow-up at once when the queue modes are all", async () => {
    const { harness, root, faux } = await openHarness(new MemoryStorage(), [providerFailure()]);

    const failed = await root.submit(
      { type: "input", content: "first", requestId: "r1", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    await waitForInspection(
      harness,
      (inspection) => (inPollPhase(inspection) ? true : undefined),
      "the run to enter its deferred poll phase",
    );
    const second = await root.submit(
      { type: "input", content: "second", requestId: "r2", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    const third = await root.submit(
      { type: "input", content: "third", requestId: "r3", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    expect((await failed.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");

    // `all` modes place every queued input of the mode into one run, inbox emptied in full.
    faux.setResponses([fauxAssistantMessage("batched answer")]);
    const all = { steeringMode: "all", followUpMode: "all" } as const;
    expect(await recoverQueuedInputs(root, all)).toBe(true);
    const firstPass = await root.commit(
      async (tx) => ({
        inputs: [...(await tx.doc(LiveDoc, root.id)).run!.inputs],
        queued: (await tx.doc(InboxDoc, root.id)).items.map((item) => item.id),
      }),
      BACKGROUND_CONTEXT,
    );
    expect(firstPass.inputs).toEqual([second.id, third.id]);
    expect(firstPass.queued).toEqual([]);

    expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect((await third.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const view = await root.viewState(BACKGROUND_CONTEXT);
    try {
      expect(view.value.entries.flatMap(entryUserTexts)).toEqual(["first", "second", "third"]);
    } finally {
      view.dispose();
    }
    const drained = await harness.inspect(BACKGROUND_CONTEXT);
    expect(drained.tasks).toHaveLength(0);
    expect(drained.submissions).toHaveLength(0);
  }, 30_000);
});
