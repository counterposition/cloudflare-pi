# Open issues after the PiHarness migration: orchestrator hand-off

Written 2026-10-04, after `Session` moved onto the Agents SDK's `Lifecycle` + `PiHarness`
(see `docs/PIHARNESS_MIGRATION.md`, marked done) and was deployed and re-accepted in production.
This file lists the problems still open, with the evidence gathered so far and what "fixed"
means for each. Read `docs/HANDOFF.md` (project rules, browser tooling) and `docs/VERIFICATION.md`
before starting.

## Current state

- **Uncommitted.** The migration and docs are in the working tree on top of `dac086e`. Don't
  commit unless the user asks. Other uncommitted work in the tree (`public/*`, `DESIGN.md`,
  `PRODUCT.md`, `.impeccable/`, `src/models.ts`, `test/models.test.ts`) belongs to separate UI
  and model efforts; leave it alone.
- **Deployed.** Worker `cloudflare-pi`, latest version `<worker-version>`, at
  `https://cloudflare-pi.<your-subdomain>.workers.dev` (behind Cloudflare Access). The production
  session is Durable Object `<session-id>`.
- **Gates.** `mise run check` (format check, typecheck, lint, tests, dry-run build) passes:
  8 files, 107 tests. `pnpm deploy` deploys. Run the gates once at the end of a change, not
  mid-flight.
- **Shared production session.** Another agent uses the same session to record a promotional
  video, and its contents can change without warning. That agent is paused right now. Before
  anything that disrupts production (a redeploy, a mid-run restart, a container teardown),
  check with the user that the session is free.
- **Review.** Substantive changes need an independent review. The user has asked for GPT 6.1
  Sol, high reasoning, through the `factory-droid` provider
  (`factory-droid/gpt-6.1-sol:high`).
- **Proof.** Passing tests don't count as runtime proof. Each fix needs a deployed observation
  (browser plus `wrangler tail`), as `docs/VERIFICATION.md` requires.

## Tooling notes from this session

- `npx wrangler tail cloudflare-pi --format json | tee /tmp/tail.json` gives a parseable log.
  Each record has `outcome`, `cpuTime`, `wallTime`, `event.rpcMethod`, or `event.scheduledTime`
  for alarms. Long-lived SSE RPC records only appear once the stream ends.
- Browsers are driven with `cua-driver` (read `skill://cua-driver`). The user has allowed
  focusing any app or tab. Brave (pid 9797, app tab in window 6987) has DevTools and "Allow
  JavaScript from Apple Events" disabled by policy. Safari (pid 1202, window 365, Responsive
  Design Mode at 390×844) has a working JavaScript console (Develop → Show JavaScript Console;
  type into the `Console prompt` AXTextArea, then press Return). Same-origin `fetch` from that
  console reaches the authenticated API. Check `location.host` before calling it. Leave
  Safari's responsive viewport in place.
- In Safari, `type_text` aimed at the app's `Message` textarea went into the console while the
  inspector had focus. That led to one prompt being submitted twice under two different
  requestIds. Close or blur the inspector before typing into the app.

---

## Issue 1 (high): SSE `events` streams can exceed the Durable Object CPU limit and reset the object

**Symptom.** In production, one `events` RPC stayed open while a run streamed and ended with
`outcome: "exceededCpu"`, `cpuTime: 32516`, `wallTime: 203103`, exception `"Durable Object
exceeded its CPU time limit and was reset."` (stream started 22:13:15 local, version
`392faa2a`). The matching Worker request `GET /api/session/events` ended with `"Network
connection lost."`. A reset interrupts admitted work the same way a redeploy does: unsafe tools
report `interrupted`, and runs resume through the alarm. So this is a durability and UX defect,
even though no data is lost.

**Likely cause (inferred, not confirmed).** In `Session.events` (`src/session.ts`, from
`async events(` around line 198), every committed conversation revision calls
`assembleSnapshot` and then `JSON.stringify` of the full snapshot, which includes the whole
transcript. That happens per open stream. Streaming generation commits revisions at
token-delta rate, so CPU grows roughly as revisions × transcript size × open streams. The
production transcript is now long (acceptance runs plus the video agent's work). The SSE code
is unchanged by the migration; diff `events()` against `git show HEAD:src/session.ts`.

**Open questions to answer first:**

1. Which request is charged for this CPU? Is it only the per-stream serialization, or also
   Pi's generation work, because the task loop runs inside whichever request started
   `Lifecycle`? If the generation itself is billed to a long-lived stream, throttling the
   stream alone won't be enough.
2. How many revisions per second does a streamed answer produce, and how large is one
   serialized snapshot? `snapshot` RPCs took 2–13 ms of CPU each in the tail.

**Fix directions (choose based on the measurements):**

- Coalesce pushes: send at most N snapshots per second per stream, always ending with the
  latest. Serialize only when a frame is actually sent. Today the code serializes even when
  backpressured, into `pendingChunk`; it should keep the latest view and serialize in `pull()`.
- Consider sending incremental frames instead of full snapshots. That changes the browser
  contract in `public/app.js` (`connectEvents`, `applySnapshot`), which is in the scope of
  separate UI work, so coordinate with the user first.
- `limits.cpu_ms` in `wrangler.jsonc` can raise the cap. That only treats the symptom and must
  not be the only fix.

**Acceptance:** in production, with a browser connected, a long streamed answer over the
current transcript completes with no `exceededCpu` in the tail, and the `events` record's
`cpuTime` stays far below 30 s. Report the before and after numbers. Keep the existing SSE
guarantees: the hydration snapshot comes first, frames are coalesced and bounded, a disconnect
detaches the observer only, and a harness close ends the stream.

## Issue 2 (medium, unconfirmed): DO-side SSE streams may outlive the browser connection

**Evidence.** A Worker `events` request that started at 22:20:26 reported `wallTime: 281326`.
That is about 2.3 minutes after the browser reloaded at 22:22:46, and it ended with `"Network
connection lost."`. No DO-side `rpc:events` record ever appeared for that stream or for later
ones, even after a redeploy. Separately, after one redeploy, a Brave page stayed stale with no
reconnect: it showed "Finished 12m ago" while a newly submitted prompt had already completed.
A reload fixed it.

**Why it matters.** If `ReadableStream.cancel()` in `Session.events` isn't called when the
client goes away across Worker→DO RPC, each reload leaves a stream that is still subscribed.
Every revision then pays the serialization cost of Issue 1 for streams nobody is reading.

**Investigate:** prove or disprove that `cancel()` runs. For example, log the number of open
streams from `this.streams.size` on each new `events` call, then reload several times. Also
check why the client's `EventSource` didn't detect the dead stream after the redeploy. The
reconnect logic is in `public/app.js` (`connectEvents`, `scheduleReconnect`); a server
keepalive comment or a client staleness timer may be needed.

**Acceptance:** stream count returns to the number of open tabs after reloads, and a redeploy
leaves no browser stuck on a stale view (it reconnects or rehydrates without a manual reload).

## Issue 3 (low): container idle teardown and the restore that follows it weren't observed

**Evidence.** `INACTIVITY_TIMEOUT_MS` is 10 minutes (`src/workspace.ts:38`), applied with
`container.setInactivityTimeout` right after `container.start` in `startContainerLocked`. After
the last tool at about 22:31:50, a read at 22:47:47 found the container still running: there
was no `backups.sandbox.internal` restore in the tail, and the workspace status never showed
`stopped`. Restore from R2 was observed only after redeploys. Possibly an open SSE stream or
DO activity counts as container activity. That is unconfirmed.

**Acceptance:** either observe a real idle stop (status goes to `stopped` through
`watchContainerExit`, then the next tool restores from R2), or document from platform docs
what keeps the container alive and update the container-inactivity text in `README.md` and
`docs/ARCHITECTURE.md` to match. Don't add code unless the behavior is actually wrong.

## Issue 4 (low): first startup warm-up after a deploy failed once

**Evidence.** Right after the first PiHarness deploy (version `92beeb98`), the non-blocking
warm-up (`Session.onStart`, then `ensureReady`) published `Workspace start failed: The
container has not been started`. The next tool started the container normally. A diagnostic
redeploy (no image change) and later restarts didn't reproduce it. That first deploy also
pushed a new container image, so it may have been image rollout. Not confirmed.

**Acceptance:** reproduce it on a deploy that changes the image (for example, a no-op change
under `container/`), capture the failing call's stack with temporary logging, and either
handle it (retry the warm-up once, or skip publishing an error the next tool will clear) or
document it as a platform rollout limitation. Remove the temporary logging afterwards.

## Issue 5 (low): generic platform errors on alarms

**Evidence.** One alarm event at 22:31:51 (version `db16c57d`) recorded the exception
`internal error; reference = 78dcifubckl64e6pq7pevtgn` with `outcome: "ok"`, during a
checkpoint's garbage collection (a `deleteObject` RPC ran next to it). No receipt failed.
`docs/VERIFICATION.md` already lists these as a known platform-diagnostic limitation.

**Action:** only follow up if they start to correlate with failed receipts or stuck runs.

---

## Upstream reports still to file (from docs/PIHARNESS_MIGRATION.md)

- **earendil-works/pi:** an accepted follow-up is stranded when its run fails (1.0.1 and 1.0.2).
  `test/session.test.ts` is a ready repro.
- **cloudflare/agents (`PiHarness`):**
  - the wake job completes while queued inputs remain (repro: test A4 in `test/piharness.test.ts`);
  - there is no public `wake(session)`;
  - `PiSessionDefaults` lacks `cwd`;
  - `abort()` can't include background tasks;
  - host tables can't join Pi's SQL queue;
  - the store prefix isn't configurable;
  - `PiHarness` opens and migrates its store before calling the host factory, so host
    migrations have to run as an earlier `Lifecycle` capability.

Filing needs the user's go-ahead.

## Key files

- `src/session.ts`: Durable Object host: `Lifecycle` and `PiHarness` setup, guard, admissions,
  SSE (`events`), snapshots.
- `src/recovery.ts`: stranded-input recovery and the `recover-queued` job (1 s heartbeat).
- `src/workspace.ts`: container lifecycle, checkpoints, restore (`ensureReady`,
  `startContainerLocked`, `watchContainerExit`).
- `src/pi-table-migration.ts`: `pi_` table move (a startup capability) and its rollback inverse.
- `public/app.js`: browser SSE client (`connectEvents`, `scheduleReconnect`, `applySnapshot`).
- Tests: `test/piharness.test.ts` and `test/piharness.fixture.ts` (workerd: hosting and
  recovery), `test/durable-sqlite.test.ts` (Session startup failures), `test/workspace.test.ts`,
  `test/session.test.ts`.
