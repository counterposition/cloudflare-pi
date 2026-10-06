/**
 * Test-only hosts for `PiHarness` over `Lifecycle`, shaped like `Session` (src/session.ts) minus
 * the workspace, auth, and Workers AI: the same startup-time table migration, the same
 * factory-created root with a `cwd`, and — on `RecoveringHost` — the same host recovery hooks,
 * running the production `watchUnsettledWork` and `driveQueuedRecovery`. The model is pi-ai's
 * faux provider with a deferred poll window, so a follow-up can be queued while a run is
 * provably busy.
 */
import { DurableObject } from "cloudflare:workers";
import { createModels, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { legacyPiTableMigration } from "../src/pi-table-migration";
import { driveQueuedRecovery, recoveryJob, watchUnsettledWork } from "../src/recovery";

export const FIXTURE_CWD = "/workspace/project";
/** How long the faux provider holds a deferred request before its next poll. */
export const POLL_AFTER_MS = 250;
/** Recovery heartbeat for tests, so the suite does not sit on the production 1 s. */
export const TEST_RECOVERY_HEARTBEAT_MS = 25;

class FixtureHost extends DurableObject {
  readonly faux: FauxProviderHandle;
  readonly harness: PiHarness;
  readonly lifecycle: Lifecycle;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const faux = fauxProvider({ deferred: { pendingFetches: 1, pollAfterMs: POLL_AFTER_MS } });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    this.faux = faux;
    this.harness = new PiHarness({
      harness: async ({ storage, context }) => {
        const pi = await Harness.open(
          storage,
          {
            models,
            registry: createRegistry(),
            settings: { stream: { deferred: true }, retry: { enabled: false } },
          },
          context,
        );
        await pi.root(context, {
          agent: {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: "off",
            cwd: FIXTURE_CWD,
          },
        });
        return pi;
      },
      defaults: { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" },
    });
    this.lifecycle = Lifecycle.install(this);
    this.lifecycle.use(legacyPiTableMigration(ctx.storage));
    this.lifecycle.use(this.harness);
  }
}

/** `PiHarness` alone: its own wake job and nothing else. */
export class HarnessOnlyHost extends FixtureHost {}

/**
 * `PiHarness` plus the production queued-input recovery job, as `Session` hosts it — hooks
 * included as instance properties, so Lifecycle must find them off the RPC surface too.
 */
export class RecoveringHost extends FixtureHost {
  recoveries = 0;

  onStart = async (): Promise<void> => {
    await watchUnsettledWork(this.harness, this.lifecycle);
  };

  onJob = async (context: LifecycleJobContext): Promise<LifecycleJobOutcome> =>
    driveQueuedRecovery(this.harness, context, {
      heartbeatMs: TEST_RECOVERY_HEARTBEAT_MS,
      onRecovered: () => {
        this.recoveries++;
      },
    });

  /** What `Session.submit` does before every admission. */
  async watchQueued(): Promise<void> {
    await this.lifecycle.jobs.push(recoveryJob());
  }
}
