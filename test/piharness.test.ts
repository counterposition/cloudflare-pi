/**
 * `PiHarness` hosting over real workerd: the findings the Session migration depends on.
 *
 * - Migration: the pre-`PiHarness` unprefixed schema moves under `pi_` and back, atomically,
 *   idempotently, and only when exactly one layout exists.
 * - A1: `Lifecycle` installs its own `alarm` on a host without one, and the factory-created
 *   root keeps its `cwd` (`PiSessionDefaults` cannot carry one).
 * - A2: a transcript written by the legacy layout resumes under `PiHarness` after the
 *   constructor-time migration, with requestId dedup intact.
 * - A3: `Session` defines no `alarm()`, so its Lifecycle jobs run.
 * - A4: `PiHarness` alone strands a queued follow-up whose run failed: its wake job completes
 *   with the input still queued and nothing left to place it.
 * - A5: the production recovery job answers that stranded follow-up from alarms alone and
 *   removes its own row once the object is idle.
 *
 * The provider is pi-ai's faux provider (test/piharness.fixture.ts): local and never billed.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
  type TextContent,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  type EntryRecord,
  type HarnessInspection,
} from "@earendil-works/pi-durable";
import { openPiSessionStore } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { openDurableStorage } from "./legacy-pi-store";
import { migrateLegacyPiTables, restoreLegacyPiTables } from "../src/pi-table-migration";
import { Session } from "../src/session";
import {
  FIXTURE_CWD,
  HarnessOnlyHost,
  RecoveringHost,
  type HarnessOnlyHost as FixtureHost,
} from "./piharness.fixture";

declare global {
  namespace Cloudflare {
    interface Env {
      HARNESS_ONLY: DurableObjectNamespace<HarnessOnlyHost>;
      RECOVERING: DurableObjectNamespace<RecoveringHost>;
    }
  }
}

const BG = BACKGROUND_CONTEXT;
/** Upper bound for any wait on observable state; everything below settles well inside it. */
const WAIT_BUDGET_MS = 15_000;

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Pi's tables and indexes as `sqlite_master` records them (index SQL included), by name. */
function piSchema(state: DurableObjectState): SchemaRow[] {
  return state.storage.sql
    .exec<{ type: string; name: string; tbl_name: string; sql: string | null }>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE type IN ('table', 'index')
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND name NOT LIKE 'cf_agents_%' AND name NOT LIKE 'app_%'
       ORDER BY name`,
    )
    .toArray()
    .map((row) => ({ ...row, sql: row.type === "index" ? row.sql : null }));
}

function jobRows(state: DurableObjectState): Array<{ id: string; capability: string }> {
  const exists = state.storage.sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs'")
    .toArray();
  if (exists.length === 0) return [];
  return state.storage.sql
    .exec<{ id: string; capability: string }>("SELECT id, capability FROM cf_agents_jobs")
    .toArray();
}

/** User and assistant text of the given entries, in order. */
function texts(entries: readonly EntryRecord[]): string[] {
  return entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      if (typeof message.content === "string") return [message.content];
      return message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text);
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` (each call its own invocation) until it holds, within the wait budget. */
async function until(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(20);
  }
}

const providerFailure = (): FauxResponseStep =>
  fauxAssistantMessage("provider unavailable", {
    stopReason: "error",
    errorMessage: "provider unavailable",
  });

/** True while a generation is parked in its deferred poll phase: busy for the whole hold. */
const inPollPhase = (inspection: HarnessInspection): boolean =>
  inspection.tasks.some((task) => {
    const checkpoint = task.record.state.checkpoint;
    return (
      task.record.state.status === "running" &&
      typeof checkpoint === "object" &&
      checkpoint !== null &&
      "phase" in checkpoint &&
      checkpoint.phase === "poll"
    );
  });

/**
 * Strands an accepted follow-up exactly as production can: `r1` starts a run that fails, `r2`
 * is queued behind it while the run is provably busy. Recovering hosts push the recovery job
 * before each admission, as `Session.submit` does.
 */
async function strandFollowUp(
  stub: DurableObjectStub<HarnessOnlyHost> | DurableObjectStub<RecoveringHost>,
  responses: FauxResponseStep[],
): Promise<void> {
  await runInDurableObject(stub, async (host: FixtureHost | RecoveringHost) => {
    host.faux.setResponses(responses);
    const watch = async (): Promise<void> => {
      if (host instanceof RecoveringHost) await host.watchQueued();
    };
    await watch();
    await host.harness.submit("first", { operationId: "r1" });
    const pi = await host.harness.pi();
    const deadline = Date.now() + WAIT_BUDGET_MS;
    while (!inPollPhase(await pi.inspect(BG))) {
      if (Date.now() > deadline) throw new Error("run never entered its poll phase");
      await sleep(5);
    }
    await watch();
    const queued = await host.harness.submit("second", { operationId: "r2" });
    expect(queued.accepted).toBe(true);
    const failed = await host.harness.wait("r1");
    expect(failed).toMatchObject({ status: "unanswered", reason: "model_error" });
  });
}

describe("legacy Pi table migration", () => {
  it("moves the unprefixed schema to pi_ and back, atomically and idempotently", async () => {
    // The target: exactly the schema PiHarness's own store creates on a fresh object.
    let expected: SchemaRow[] = [];
    await runInDurableObject(env.HARNESS_ONLY.getByName("schema-reference"), async (_h, state) => {
      await openPiSessionStore(state.storage);
      expected = piSchema(state);
    });
    expect(expected.length).toBeGreaterThan(9);
    expect(expected.every((row) => row.name.startsWith("pi_"))).toBe(true);

    await runInDurableObject(env.HARNESS_ONLY.getByName("round-trip"), async (_h, state) => {
      const legacy = await openDurableStorage(state.storage);
      await legacy.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BG);
      await legacy.close(BG);
      const before = piSchema(state);
      expect(before.some((row) => row.name.startsWith("pi_"))).toBe(false);

      expect(migrateLegacyPiTables(state.storage)).toEqual({ moved: 9 });
      expect(piSchema(state)).toEqual(expected);
      expect(migrateLegacyPiTables(state.storage)).toEqual({ moved: 0 });
      const migrated = await openPiSessionStore(state.storage);
      expect(await migrated.conversation(ROOT_CONVERSATION_ID, BG)).toEqual({
        id: ROOT_CONVERSATION_ID,
      });

      expect(restoreLegacyPiTables(state.storage)).toEqual({ moved: 9 });
      expect(piSchema(state)).toEqual(before);
      expect(restoreLegacyPiTables(state.storage)).toEqual({ moved: 0 });
      const restored = await openDurableStorage(state.storage);
      expect(await restored.conversation(ROOT_CONVERSATION_ID, BG)).toEqual({
        id: ROOT_CONVERSATION_ID,
      });
      await restored.close(BG);

      // Both layouts present: neither direction guesses which copy is authoritative.
      await openPiSessionStore(state.storage);
      const both = piSchema(state);
      expect(() => migrateLegacyPiTables(state.storage)).toThrowError(/both/);
      expect(() => restoreLegacyPiTables(state.storage)).toThrowError(/both/);
      expect(piSchema(state)).toEqual(both);
    });
  });
});

describe("PiHarness hosting over Lifecycle", () => {
  it("A1: Lifecycle owns the alarm and the factory's root keeps its cwd", async () => {
    await runInDurableObject(env.HARNESS_ONLY.getByName("a1"), async (host, state) => {
      expect(Object.hasOwn(host, "alarm")).toBe(true);
      await host.lifecycle.start();
      const pi = await host.harness.pi();
      const root = await pi.root(BG);
      expect((await pi.snapshot(AgentDoc, root.id, BG))?.cwd).toBe(FIXTURE_CWD);
      expect(piSchema(state).every((row) => row.name.startsWith("pi_"))).toBe(true);
    });
  });

  it("A2: resumes a legacy transcript after the startup migration, dedup intact", async () => {
    await runInDurableObject(env.HARNESS_ONLY.getByName("a2"), async (host, state) => {
      // The pre-PiHarness layout, written the way the hand-rolled Session wrote it.
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("legacy answer")]);
      const model = faux.getModel();
      const legacy = await Harness.open(
        await openDurableStorage(state.storage),
        { models, registry: createRegistry(), settings: { retry: { enabled: false } } },
        BG,
      );
      legacy.resume();
      const legacyRoot = await legacy.root(BG, {
        agent: {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: "off",
          cwd: FIXTURE_CWD,
        },
      });
      const answered = await legacyRoot.submit(
        { type: "input", content: "legacy question", requestId: "r-legacy", whenBusy: "followUp" },
        BG,
      );
      expect((await answered.wait(BG)).status).toBe("done");
      await legacy.close(BG);
      expect(piSchema(state).some((row) => row.name === "entries")).toBe(true);

      // The same (never started) host: Lifecycle startup migrates before PiHarness opens Pi.
      await host.lifecycle.start();
      expect(piSchema(state).every((row) => row.name.startsWith("pi_"))).toBe(true);
      expect(texts(await host.harness.messages())).toEqual(["legacy question", "legacy answer"]);

      const retried = await host.harness.submit("legacy question", { operationId: "r-legacy" });
      expect(retried).toEqual({ operationId: "r-legacy", session: "1", accepted: false });
      expect(texts(await host.harness.messages())).toEqual(["legacy question", "legacy answer"]);
      const pi = await host.harness.pi();
      expect((await pi.inspect(BG)).submissions).toEqual([]);
      const root = await pi.root(BG);
      expect((await pi.snapshot(AgentDoc, root.id, BG))?.cwd).toBe(FIXTURE_CWD);
    });
  });

  it("A3: Session defines no alarm handler, so Lifecycle installs its own", () => {
    expect("alarm" in Session.prototype).toBe(false);
  });

  it("A4: PiHarness alone leaves a stranded follow-up queued with no task and no wake", async () => {
    const stub = env.HARNESS_ONLY.getByName("a4");
    await strandFollowUp(stub, [providerFailure()]);

    // Let PiHarness's own wake job run to completion through its alarms.
    await until(
      () =>
        runInDurableObject(
          stub,
          async (_host, state) =>
            jobRows(state).length === 0 && (await state.storage.getAlarm()) === null,
        ),
      "PiHarness's wake job to complete",
    );
    await sleep(500);

    await runInDurableObject(stub, async (host, state) => {
      const inspection = await (await host.harness.pi()).inspect(BG);
      expect(inspection.tasks).toEqual([]);
      expect(await host.harness.pending()).toEqual([
        { operationId: "r2", session: "1", status: "queued" },
      ]);
      expect(jobRows(state)).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("A5: the recovery job answers the stranded follow-up from alarms alone", async () => {
    const stub = env.RECOVERING.getByName("a5");
    await strandFollowUp(stub, [providerFailure(), fauxAssistantMessage("recovered answer")]);

    // Nothing below drives recovery: only the Lifecycle alarm runs the host job.
    await until(
      () =>
        runInDurableObject(stub, async (host, state) => {
          const pending = await host.harness.pending();
          return (
            pending.length === 0 &&
            jobRows(state).length === 0 &&
            (await state.storage.getAlarm()) === null
          );
        }),
      "the stranded follow-up to be recovered and the object to go idle",
    );

    await runInDurableObject(stub, async (host) => {
      expect(host.recoveries).toBe(1);
      expect(await host.harness.wait("r2")).toMatchObject({
        status: "done",
        text: "recovered answer",
      });
      const userTexts = (await host.harness.messages())
        .filter((entry) => entry.model?.[0]?.role === "user")
        .flatMap((entry) => texts([entry]));
      expect(userTexts).toEqual(["first", "second"]);
      const inspection = await (await host.harness.pi()).inspect(BG);
      expect(inspection.tasks).toEqual([]);
      expect(inspection.submissions).toEqual([]);
    });
  });
});
