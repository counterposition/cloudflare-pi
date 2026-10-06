# Plan: move `Session` onto `PiHarness` — DONE (deployed 2026-10-04)

**Outcome:** implemented, reviewed (GPT 6.1 Sol, high: no findings), and deployed. Production acceptance results and limits are in `docs/VERIFICATION.md`. Changes from the plan as written:

- The table migration runs as a `Lifecycle` capability installed before `PiHarness`, not in the constructor. `PiHarness` opens and migrates its store before it calls the host factory, and a constructor that throws when both layouts exist would leave the object unreachable for repair.
- The recovery heartbeat is 1 s (the old alarm cadence), not 10 s. A thrown pass reschedules instead of letting `Lifecycle` delete the job row.
- App SQL holds no async transaction: the owner check is one `transactionSync`, and checkpoint pointer removal is a single batched `DELETE`.
- `onStart` and `onJob` are instance properties, so Workers RPC refuses them.
- There is one execution-env adapter per workspace, reset in place on each container start. The restore notice comes from the actual restore.
- Phase 4 step 5 (idle teardown) wasn't observed; see `docs/VERIFICATION.md`.

Drafted and validated 2026-10-04 against `agents@0.26.0` (published 2026-10-02), `@earendil-works/pi-durable` 1.0.1 and 1.0.2 (published 2026-10-04). The repo has since moved to 1.0.2 (see D3); the spike ran on 1.0.1, and the only 1.0.2 change on this path is the per-conversation provider session ID.

**Validation status (at drafting):** every design decision below was checked against the published `agents` source and, where it carries risk, against real workerd. A throwaway spike passed typecheck, lint, the existing 97 tests, 4 new workerd tests and a Worker bundle build.

## Goal

Replace the hand-rolled Durable Object hosting in `src/session.ts` (own SQL gate, alarm chain, init/gate adoption) with the Agents SDK's `Lifecycle` + `PiHarness`, while keeping every behavior the acceptance demonstration proved: durable admission with requestId dedup, observer detach, resume without a client, honest `interrupted` receipts, checkpoint-before-success, container recreation from R2, cross-browser resume.

**Not in scope:** multiple sessions or forking in the UI; switching the model provider to `agents/models/pi-ai`; WebSockets instead of SSE; UI changes.

## What stays and what goes

| Area                                                                                          | Today                                                                                  | After                                                            |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Auth, routing (`auth.ts`, `index.ts`)                                                         | unchanged                                                                              | unchanged                                                        |
| Workspace, R2 checkpoints, container env (`workspace.ts`, `adapters/sandbox-*`, `container/`) | unchanged                                                                              | one change: eager start becomes lazy `ensureReady()` (finding 2) |
| Coding tools (`coding.ts`), models (`models.ts`)                                              | unchanged                                                                              | unchanged                                                        |
| Stranded-input recovery (`recovery.ts`)                                                       | run by the alarm chain                                                                 | kept; run by a host `Lifecycle` job (finding 5)                  |
| Pi storage                                                                                    | `DurableSqliteDatabase` + `SqliteStorage.open`, unprefixed tables                      | `PiHarness`'s store, `pi_`-prefixed tables (finding 1)           |
| Wake-ups                                                                                      | `app_alarm` table, `armAlarm`/`primeAlarm`/`disarmAlarm`/`drive`/`driveWork`/`alarm()` | `PiHarness` wake job + one host recovery job                     |
| Open failure handling                                                                         | `initialize`/`adoptFreshGate`/close-on-failure                                         | `Lifecycle` startup (fails honestly, retries on next call)       |
| Submit                                                                                        | `root.submit(...)` → `{ submissionId }`                                                | `harness.submit(...)` → `{ operationId, accepted }` (finding 7)  |
| SSE snapshots                                                                                 | `root.viewState()`                                                                     | unchanged, via `harness.pi()`                                    |
| App SQL (`app_owner`, `app_workspace_checkpoints`)                                            | shares Pi's queue                                                                      | own `DurableSqliteDatabase` gate (finding 8)                     |

Expected size: `session.ts` goes from 709 lines to roughly 350–400.

## Findings that shape the design

Source references are to `agents@0.26.0/dist/`. Spike tests are named A1–A5.

1. **Pi's tables get a `pi_` prefix, and the live session's data isn't prefixed.** `PiHarness` always opens storage with `openPiSessionStore(this.lifecycle.storage)` and the default prefix `pi_` (`harness/pi/index.js:29-33, 530`). This isn't configurable through `PiHarness`. The production session's transcript sits in unprefixed tables, so without a migration the user would get an empty session. _Validated (A2):_ in one `transactionSync`, drop Pi's indexes, `ALTER TABLE … RENAME TO pi_…` the 9 Pi tables, and recreate the indexes under prefixed names. `PiHarness` then resumes the same transcript, requestId dedup (`accepted: false` for an old requestId) and root `cwd`. The function is idempotent. Index names have to be recreated: SQLite keeps an index's name across a table rename, but the store's prefixer rewrites index names in every future Pi migration.

2. **Startup runs inside `blockConcurrencyWhile`, and that includes our factory.** `Lifecycle` runs capability `onStart` hooks inside `ctx.blockConcurrencyWhile` (`lifecycle-CFu6OV03.js:1285`). `PiHarness.onStart` opens Pi, which calls our factory. The factory must not start the container or restore from R2, because that can run past the 30-second limit. A lazy reset is safe. Pi only touches the environment from inside tools (`tools/bash.js` `env.exec`). Generation builds the env object, but our prompt sections never use it. Every tool goes through `WorkspaceManager.runTool` → `ensureContainerLocked`, which destroys an orphaned container and restores the latest checkpoint on a new incarnation. The host `onStart` starts a non-blocking `ensureReady()` so the restore notice and status show up promptly.

3. **`Session` must stop defining `alarm()`.** `Lifecycle.installHandlers` skips any handler the class already has (`if (name in host) continue`, `lifecycle-CFu6OV03.js:921-937`). With today's `alarm()` override, `Lifecycle` jobs would never run. _Validated (A1):_ on a plain `DurableObject`, `Lifecycle` installs its own `alarm`.

4. **The root `cwd` has to be set in the factory.** `PiSessionDefaults` only accepts `model` and `thinkingLevel`. After the factory returns, `PiHarness` calls `pi.root(BG, { agent: defaults })` (`index.js:535`). The factory creates the root first with `cwd: /workspace/project`, so `PiHarness`'s call finds it and leaves it alone. _Validated (A1, A2)._

5. **Stranded follow-ups still happen, and `PiHarness` doesn't recover them.** pi-durable 1.0.2 only adds a provider session UUID (CHANGELOG), so the 1.0.1 bug `recovery.ts` works around remains. `PiHarness`'s wake step finishes once a session has no tasks (`index.js:488`), and its wake function is private (`index.js:466-475`). _Validated (A4):_ after `PiHarness`'s own alarm runs, the follow-up is queued, no task exists, no wake job exists, and nothing will place it. _Fix, validated (A5):_ a host `Lifecycle` job, `recover-queued`, is pushed (single-flight) before every admission and heartbeats while unsettled work exists. When it sees queued inputs with no task, it runs `recoverQueuedInputs` and then calls `PiHarness`'s **public** `onStart()`, which pushes the durable wake for the recovered run. In A5 the stranded follow-up was answered from alarms alone, and the job row was removed once the session was idle. The job is durable, so this also covers eviction.

6. **Abort keeps its current semantics only through the escape hatch.** `PiSession.abort()` calls `conversation.abort(BG)` without `{ background: true }`. Keep today's call through `harness.pi()`, which is public and meant for anything the interface doesn't cover.

7. **The receipt shape changes.** `harness.submit` returns `{ operationId, session, accepted }` with no numeric submission id. The browser ignores the receipt body (`public/app.js:1482-1494` only clears the pending request on HTTP success). The new contract is `202 { operationId, accepted }`. Only docs mention `submissionId` (README status, HANDOFF API table).

8. **App tables no longer share Pi's SQL queue.** `PiHarness`'s queue is private, and `Lifecycle`'s own `cf_agents_jobs` writes bypass it too. Pi's transactions await only their own synchronous statements, so they finish within one microtask drain. App writes made at RPC entry or as the first step after an I/O await (as `verifyOwner` and the checkpoint insert do today) can't land inside a Pi transaction. **Rule:** app transactions run SQL only and never await I/O inside. Keep `DurableSqliteDatabase` as the app tables' gate, which leaves `WorkspaceManager` and its tests unchanged. Ask upstream for a hook (see below).

9. **Packaging and bundling are fine.** All of `agents`' peer dependencies are optional. Installing it adds 156 packages. `core-js-pure` (via `mimetext`) has a postinstall that has to be denied in `allowBuilds`. The bundle grows from 2,227 to 2,335 KiB raw (393 to 417 KiB gzip). pi-ai's model registry still initializes when the Worker loads (`init_models()` runs at top level in both bundles), so the earlier "ModelsImpl is not a constructor" crash doesn't come back. TypeScript 7.0.2 typecheck and oxlint pass.

10. **`Lifecycle` needs `ctx.id.name`.** Production addresses sessions with `getByName(identity.id)`, so that's fine. The existing workerd test uses `newUniqueId()` and must switch to `getByName`.

## Target shape

```ts
export class Session extends DurableObject<AppEnv> {
  private readonly lifecycle: Lifecycle<AppEnv>;
  private readonly harness: PiHarness;
  private readonly appDb = new DurableSqliteDatabase(this.ctx.storage); // app tables only
  private workspace: WorkspaceManager | undefined; // built in the factory; throws SessionApiError(500) without a container

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    migrateLegacyPiTables(ctx.storage); // synchronous, atomic, before Lifecycle startup
    ctx.storage.sql.exec(APP_SCHEMA); // app_owner only; app_alarm is dropped by the migration
    const { models, model } = createWorkersAiModels(env.AI);
    this.harness = new PiHarness({
      harness: async ({ storage, context }) => {
        const workspace = this.buildWorkspace(); // no container start here (finding 2)
        const registry = createRegistry();
        registry.install(createCodingExtension(workspace));
        const pi = await Harness.open(
          storage,
          { models, registry, settings: HARNESS_SETTINGS, env: () => workspace.environment() },
          context,
        );
        await pi.root(context, { agent: { model, thinkingLevel: "off", cwd: WORKSPACE_CWD } }); // finding 4
        pi.subscribeClose(() => {
          for (const stream of this.streams) stream.end();
        });
        return pi;
      },
      defaults: { model: { provider: model.provider, id: model.modelId }, thinkingLevel: "off" },
    });
    this.lifecycle = Lifecycle.install(this);
    this.lifecycle.use(this.harness);
  }

  async onStart(): Promise<void> {
    // host hook, after PiHarness.onStart
    if (await hasUnsettledWork(this.harness)) await this.watchQueued(); // covers state left by the old code
    this.ctx.waitUntil(this.workspace!.ensureReady().catch(() => undefined)); // status shows the error
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return driveQueuedRecovery(this.harness, context); // finding 5; shared with tests
  }

  // RPC: guard() = validate identity → verifyOwner (appDb) → await this.lifecycle.start()
  //   snapshot/events: (await harness.pi()).root(BG) → viewState (unchanged SSE contract)
  //   submit:  admit(() => watchQueued() then harness.submit(text, { operationId: requestId, whenBusy }))
  //   abort:   (await harness.pi()).root(BG) → abort(BG, { background: true })
  //   checkpoint/restore: admit(() => rejectBusy(pi.inspect) then workspace op)  — unchanged
}
```

## Phases

### Phase 0: decisions (yours)

- **D1. Keep the existing transcript?** Recommended: yes, using the in-place table migration (validated). The alternative is a fresh session that leaves the old data orphaned in unprefixed tables.
- **D2. Receipt contract** `{ submissionId }` → `{ operationId, accepted }`. Recommended: accept it; the UI is unaffected.
- **D3. pi-durable version.** Done: the repo is on pi-durable, pi-ai and chord 1.0.2, with the provider session ID wired to Workers AI's `x-session-affinity` header for prefix caching (`src/models.ts`). `PiHarness`'s peer range (`^1.0.0`) accepts 1.0.2. The new `pi.provider` conversation document migrates with the other Pi tables.
- **D4. Model provider.** Recommended: keep `src/models.ts`. It deliberately pins the compat profile and the 8,192-token output cap, and `agents/models/pi-ai` is a separate evaluation.

### Phase 1: dependency and migration, no behavior change

1. Add `agents` pinned exactly at `0.26.0` (the harness is `@beta`, and `Lifecycle` is `@experimental`). Add `"core-js-pure": false` to `allowBuilds`.
2. Add `src/pi-table-migration.ts` with `migrateLegacyPiTables` (from the spike) and a `restoreLegacyPiTables` inverse for rollback.
3. Add `test/piharness.test.ts`, `test/piharness.fixture.ts` and `test/piharness.wrangler.jsonc` (from the spike, as their own Vitest workers project). Cover A2 plus a forward/reverse round trip.
4. Gates: `mise run check` (format, typecheck, lint, tests, dry-run build).

### Phase 2: rewrite `Session`

1. `src/session.ts`: implement the target shape. Delete `app_alarm`, `armAlarm`, `disarmAlarm`, `primeAlarm`, `drive`, `driveWork`, `alarm()`, `initialize`, `adoptFreshGate` and `ensureSchema`'s alarm part. Keep `guard`/`verifyOwner`, `admit`, `rejectBusy`, the SSE code, snapshot assembly and notices.
2. `src/recovery.ts`: add `driveQueuedRecovery(harness, context)` (stranded check → `recoverQueuedInputs` → `harness.onStart()` → heartbeat or complete) and `RECOVERY_JOB`. The fixture and `Session` both use it, so the tests run production code.
3. `src/workspace.ts`: replace `initialize()` with `ensureReady()`, which runs `ensureContainerLocked` in the queue. It must not destroy a container that a resumed tool already started. Create the checkpoint table eagerly.
4. `src/contracts.ts`: `SubmitReceipt` becomes `{ operationId: string; accepted: boolean }`.
5. Tests:
   - Replace the `durable-sqlite.test.ts` "Session initialization gate recovery" case. Use `getByName`, set `pi_durable_schema` version 99, check that `snapshot` rejects with `/newer than supported/`, fix the version, and check that `snapshot` succeeds. It no longer needs the container.
   - Move A1, A3, A4 and A5 onto the shared recovery code.
   - Keep `session.test.ts`, which tests the recovery helper over the real Pi harness, unchanged.
6. Gates: `mise run check`, then an independent review of the diff.

### Phase 3: docs

Update the README architecture, durability and status text (receipt shape, `Lifecycle` wake jobs, `pi_` tables), the HANDOFF API table, and remove this plan or mark it done.

### Phase 4: deploy and re-run acceptance (required; tests don't count as proof)

Deploy, then on the stable production session:

1. The first authenticated `/api/session` migrates the tables. The existing transcript renders unchanged.
2. Retrying an old requestId returns `accepted: false` and creates no duplicate turn.
3. A new prompt runs real bash/read/edit tools. The checkpoint pointer advances before the tool reports success.
4. Close the browser mid-run and come back: the run continued. Redeploy mid-run: the run resumes through the `Lifecycle` alarm with no client, and an unsafe in-flight bash command reports `interrupted`.
5. The idle timeout tears down the container, and the next tool restores the workspace from R2.
6. Safari resumes the same session. 390×844 still renders.
7. `wrangler tail` shows no `pi:wake_error` events and no startup failures.

The stranded-follow-up path can't be triggered in production without a test-only route, which HANDOFF rules out. It stays covered by the workerd tests (A4/A5).

## Rollback

The old code can't read `pi_` tables. It would open an empty session, and the data would survive untouched. To roll back, deploy the previous commit with `restoreLegacyPiTables` called before its storage opens (prepared and tested in Phase 1). R2 checkpoints aren't touched by the migration. As a last resort, SQLite-backed Durable Objects support point-in-time recovery for 30 days.

## Risks

| Risk                                                                       | Mitigation                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PiHarness` (`@beta`) and `Lifecycle` (`@experimental`) APIs change        | Exact pin. Behavior is covered by the workerd tests above. Re-run the spike checks on every upgrade.   |
| Recovery uses `onStart()` as a re-wake (public, but not designed for this) | Covered by A5. Ask upstream for a supported `wake(session)` or built-in recovery.                      |
| App SQL outside Pi's queue (finding 8)                                     | No I/O awaits inside app transactions. The upstream `Lifecycle` makes the same choice.                 |
| Startup timeouts                                                           | No container or R2 work in the factory or in startup hooks (finding 2).                                |
| Table migration on the live object                                         | Atomic `transactionSync`, idempotent, refuses if both layouts exist, tested round trip, rollback path. |

## Upstream issues to file

- **earendil-works/pi:** an accepted follow-up is stranded when its run fails (1.0.1 and 1.0.2). `test/session.test.ts` is a ready repro.
- **cloudflare/agents (`PiHarness`):**
  - the wake job completes while queued inputs remain (A4);
  - no public `wake(session)`;
  - `PiSessionDefaults` lacks `cwd`;
  - `abort()` can't include background tasks;
  - host tables can't join Pi's SQL queue;
  - the store prefix isn't configurable through `PiHarness`.
