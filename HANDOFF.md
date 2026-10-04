# Cloudflare Pi — continuation handoff

## Original goal and definition of completion

Build a web-based Pi coding-agent application that runs entirely on Cloudflare, lifting sessions out of dependence on a single user machine. A user opens our URL, signs in, and receives a new Pi session or resumes their existing session from any web browser. The conversation, queued/running work, and persistent workspace belong to that hosted session—not to a browser tab, terminal process, or local computer.

The chosen implementation is Pi Durable with a native browser interface: Cloudflare Workers and Durable Objects host the application and durable harness, isolated Linux containers execute real coding tools, R2 stores workspace checkpoints, and Workers AI performs inference. Herdr and browser-rendered TUI/WASM were explored but were not selected. Full Pi CLI extension parity was not promised.

Completion means demonstrating the actual protected browser application end to end: a prompt executes real shell/file tools; closing a browser does not abort accepted work; another browser resumes the same authenticated session; harness restart preserves state and admission deduplication; sandbox recreation restores completed workspace effects; interrupted unsafe commands are reported honestly rather than blindly replayed. Setup/deployment/persistence limitations must be documented. Passing builds, unit tests, or isolated platform probes alone does not meet this goal.

## Immediate state

**The hosted-session acceptance demonstration is complete.** The constructor fix and five additional Sol-reviewed corrections are deployed. Protected Brave and Safari sessions, real coding tools, observer detach/resume, restart deduplication, checkpoint/restore, container recreation, honest unsafe interruption, native Restore confirmation, and narrow responsive rendering have all been exercised.

**No acceptance steps remain pending.** Safari resumed the same authenticated session and preserved workspace. After the user entered Responsive Design Mode, native viewport fields were set and committed to **390×844**; the actual narrow interface and a new read-only tool turn were verified. Keep the documented platform and test-coverage limits explicit.

- Repository: `<repo>`.
- Upstream reference: `<pi-checkout>`, Pi 1.0.1.
- Live URL: <https://cloudflare-pi.<your-subdomain>.workers.dev>.
- Current deployed Worker version: `<worker-version>`.
- Authenticated `/api/session` returns HTTP 200 and the protected browser renders the durable session. The former `ModelsImpl is not a constructor` error is gone.
- Stable verified session: `<session-id>`.
- Runtime factory imports remain at **`@earendil-works/pi-ai/models`**; inference remains exclusively the native Workers AI binding.
- Continuation corrections: storage-opening failure adopts a fresh closed-owner-safe SQL gate; recovery preserves configured per-mode queue selection; delayed admission receipts clear only their own pending record; compaction-only work exposes Abort; successful hydration clears only hydration-owned errors.
- Parent gates pass: frozen lockfile install with pnpm 12.9.1, format, typecheck, lint, **7 files / 97 tests**, Worker and Linux image dry-run. The real-workerd regression exercises Session's failed-open retry branch; recovery regressions exercise the real Pi Harness.
- A separate empty install target successfully installed all 189 locked packages with pnpm 12.9.1, reusing the local content-addressed store. Both final independent Sol reviews returned no actionable findings.
- No implementation/review subagents remain active. Owned Worker tails, the CuaDriver daemon, and local throwaway verification resources were cleaned up. Safari's authenticated application and user-adopted browser windows were intentionally left untouched. Production checkpoints and four inspectable proof files remain.
- The user subsequently requested the initial application commit through the git-commits workflow. Future commits still require a request.

## User decisions and orchestration rules

The user chose **Pi Durable**, not a CLI/Herdr/terminal wrapper.

Required stack:

- pnpm, pinned `12.9.1`.
- oxlint and oxfmt; other VoidZero tools only if necessary.
- Vitest.
- Latest TypeScript: installed/pinned `7.0.2`; do not downgrade.
- Private application protected by Cloudflare Access.
- Deployed inference exclusively through Workers AI.

The user authorized deployment, resource creation, Access administration, and bounded real Workers AI/container verification on their authenticated Cloudflare account. R2 was enabled with its zero-base-price usage subscription, and the backup bucket was created.

Implementation agents MUST use `factory-droid/glm-5.3-flash`. Independent review MUST use Sol through `factory-droid`. The dispatcher unexpectedly rejected both `factory-droid/gpt-6.1-sol:high` and its canonical unsuffixed selector, although `omp models find sol --json` listed them. The user explicitly approved the same Sol model with its configured reasoning setting. **`model: "@default"` succeeded**, resolving to the live parent `factory-droid/gpt-6.1-sol`. Verify that identity if the next parent is a different model; do not silently substitute.

Agent workflow:

- Parent owns planning, integration contracts, all formatting, tests, typechecking, lint, builds, deployment, and actual UI/runtime verification.
- Implementation subagents edit disjoint assigned slices, normally no more than five explicit files each.
- Subagents must not run ANY verification, including one-off `tsc`, direct shell smoke, syntax checks, or Vitest. Some early agents violated this despite prompts; their claims were not accepted as proof. Enforce this explicitly.
- Collect outputs, format the changed union once, run gates, fix all failures, and obtain independent review before advancing.
- Incorrect/incomplete agent work goes to corrective agents; do not silently repair substantive work inline.
- Do not add auth bypasses, production test-only restart routes, mocked production tools/models, compatibility shims, or placeholder features.

## Current deployment and access

Wrangler is authenticated to the owner's account (`<account-id>`). `pnpm exec wrangler whoami` confirmed Workers, Containers, AI, and Access permissions needed for the work; dashboard administration used the user's signed-in Brave session.

`wrangler.jsonc` contains:

- Worker `cloudflare-pi`, entry `src/index.ts`, compatibility date `2026-10-03`, `nodejs_compat`.
- SQLite-backed `Session` Durable Object, binding `SESSIONS`.
- Container scheduling policy `durable_object`, named image `workspace` from `Dockerfile`.
- R2 binding `WORKSPACE_BACKUPS`, bucket `workspace-backups`.
- Native AI binding `AI`.
- Authenticated static assets binding `ASSETS`, `run_worker_first: true`.
- `DirectoryBackupGateway` WorkerEntrypoint export, RPC-only, not publicly routed.
- Access team `<your-team>.cloudflareaccess.com` and application audience, already configured. These are non-secret values; no account/provider credentials were written to the repo.

Access application ID: `<access-app-id>`. It protects the live hostname with an owner-only email allow policy. Anonymous `curl` returned **302 to Cloudflare Access**, not application data.

Do not ask the user to recreate already provisioned resources. Do not bypass Access to simplify testing.

## Architecture and files

One persistent session/workspace per verified Access identity. Identity is SHA-256 of issuer plus subject; email is refreshable display metadata, not another immutable authorization key.

### Worker and transport

- `src/index.ts`: verifies Access on API AND assets; validates mutation origin; chooses DO only with verified identity; exact-path routes and honest statuses/errors.
- `src/auth.ts`: jose RS256/JWKS verification, issuer/audience/expiry/sub/email checks, Cloudflare Access hostname restriction, same-origin enforcement.
- `src/env.ts`: `AppEnv`, `SessionIdentity`.
- `src/contracts.ts`: `SessionSnapshot`, workspace status/checkpoint, submit input/receipt, branded `SessionRpcApi`.

**Internal RPC snapshots are serialized JSON strings.** `Session.snapshot()` and `Session.restore()` return `Promise<string>`; Worker forwards those bodies as `application/json` without double-stringifying. This avoids Cloudflare RPC's excessively deep type expansion of recursive Pi `ConversationView`/JSON types. Public HTTP bodies remain ordinary `SessionSnapshot` objects. SSE still returns `Response`.

Public routes:

| Route                          | Result                                           |
| ------------------------------ | ------------------------------------------------ |
| `GET /api/session`             | Snapshot, creates/returns the stable session     |
| `GET /api/session/events`      | SSE event `snapshot` containing a snapshot       |
| `POST /api/session/messages`   | `{text, requestId, whenBusy: "steer"             | "followUp"}`; 202 `{submissionId}` |
| `POST /api/session/abort`      | 204                                              |
| `POST /api/session/checkpoint` | Latest checkpoint metadata                       |
| `POST /api/session/restore`    | Restore latest own checkpoint; snapshot response |

The current compatibility date enables enhanced RPC error serialization: error name/message and own serializable `status`/`error` properties survive RPC; custom prototypes do not. Router matches `SessionApiError` by name and properties, not remote `instanceof`.

### Durable harness and recovery

- `src/session.ts`: actual Pi `Harness`, provider/registry reconstruction, owner binding, serialized admissions, background-aware inspection, alarms, abort, committed-state SSE and busy guards.
- `src/coding.ts`: actual Pi read/write/edit/bash tools, unchanged schemas/names/replay policies; sequential execution through workspace management.
- `src/recovery.ts`: single portable production implementation for Pi 1.0.1's taskless queued-input recovery. Tests import THIS helper; the earlier copied test algorithm was removed.
- `src/models.ts`: native Workers AI `Ai.run` bridge through Pi's actual OpenAI-compatible provider/decoder. Default `@cf/deepseek-ai/deepseek-v4-flash-0731`, context 1,048,576, output bounded 8,192, harness thinking off. No external provider inference or ambient credential/catalog initialization.

ONE `DurableSqliteDatabase` gate coordinates Pi storage, app metadata, and native alarm transactions. No uncoordinated `ctx.storage.put/get` metadata during Pi transactions.

Admission/inspection/idle alarm deletion share the same boundary. A durable next alarm is primed BEFORE fallible initialization, container restore, inspection, or inbox recovery; failure rearms it. Failure cleanup closes the old harness/storage, then adopts a fresh usable database gate rather than retrying a permanently closed facade. No concurrent duplicate harness owners.

Pi 1.0.1 can strand accepted follow-ups after a generation error without any live task. `Harness.resume()` and retrying the same `requestId` alone do NOT place them. The production helper uses public Pi Tx/Inbox/GenerationTask APIs to recover them, including resets and honest stale-write settlement. It does not inject synthetic wake prompts or invent new admission IDs.

### Filesystem, shell, and checkpoints

- `src/adapters/durable-sqlite.ts`: portable Pi SQL facade over DO SQL, async transactions, serial barriers, escaped-handle rejection, logical close.
- `src/adapters/sandbox-env.ts`: full portable `ExecutionEnv` using actual Container exec and SDK Files.
- `src/adapters/sandbox-shell.ts`: real shell launcher, watchdog control protocol, retained reader client.
- `container/fs-helper.mjs`: real Node filesystem operations and persistent FD reader protocol.
- `src/workspace.ts`: container lifecycle, serialized tool/effect/backup/restore operations, full DirectoryBackup records in app SQL tables, latest-plus-previous retention.
- `container/workspace-helper.mjs`: bounded container-local Linux writer quiescence; refuses uncontrolled host execution, fails on uncertain process inspection.

Persistent directory is **`/workspace/project`**, created AFTER container startup. Do not restore `/workspace` itself: image-layer directories can produce local Docker EXDEV swaps.

Mutating tools clean managed resources, quiesce Linux writers (including normal background commands and escaped process groups), archive to R2, and persist the pointer BEFORE successful tool receipts. No background daemons outliving tool calls are supported. Partial failure effects are checkpointed where possible, without replacing the original error with fake success.

On DO reincarnation, destroy an unknown pre-existing container and restore the last published checkpoint BEFORE harness resume. Unsafe interrupted tools are reported honestly, never declared replay-safe.

After checkpoint pointer insertion, immediately publish the new cached checkpoint/status. Retention GC happens separately; its failure leaves a visible warning and retryable owned rows, not a falsely failed durable tool or stale snapshot pointer. Restore failure must NOT silently create an empty workspace.

### Browser

- `public/index.html`, `public/app.js`, `public/style.css`: native responsive UI, real transcript/live tool/inbox/usage state, composer, steering/follow-up, abort, checkpoint and confirm-gated restore.
- All untrusted contents use text nodes.
- Pending admission ID/payload saved BEFORE sending, scoped to session ID, with memory fallback when storage fails. Retry reuses identical ID/payload; unresolved admissions cannot be overwritten by a new UUID.
- Initial/reconnect/bfcache recovery desired-live state, single-flight hydration/source identity, HTTP-vs-SSE epochs (including Restore), deferred selection flushing, keyed details/scroll preservation, and hidden pending banner were repaired after independent review.
- Closing the page detaches the observer, not the server job.

### Tooling and image

`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `.oxlintrc.json`, Dockerfile and `.dockerignore` are present. Docker context is restricted to Dockerfile/container files. Image: Node 24 Debian, bash/git/ripgrep/coreutils/certificates, sandbox-shim 1.0.0. Internet disabled for the workspace; backup traffic uses the private gateway.

Vitest pool 0.22.0 bundled an old workerd that rejected the production date. `pnpm-workspace.yaml` pins workerd `1.20261001.1`, which supports the current compatibility date. Native esbuild/workerd builds explicitly approved; unused transitive genai/protobufjs scripts denied. Do not downgrade TypeScript or compatibility date to evade test failures.

## Former live constructor defect (resolved)

Authenticated app hydration failed BEFORE tool/model streaming with `ModelsImpl is not a constructor`.

The implementation agent traced the full esbuild graph: importing runtime factories from pi-ai's root barrel allowed the models module to be wrapped in a lazy initializer reached only through dynamically loaded OpenAI completions. Factory functions were hoisted, but `ModelsImpl` was unassigned during DO initialization. The isolated provider smoke and Vitest had different module reachability, so their success did not prove this full-bundle path.

The local fix uses the public `@earendil-works/pi-ai/models` subpath for runtime factories, making model initialization statically reachable. It does not replace Pi's registry, disable tools, edit installed packages, or suppress the exception.

The fix was deployed and authenticated hydration succeeded. Actual full-application coding turns subsequently exercised the native model provider and real container tools.

## Verification actually observed

Parent-run continuation gates after the constructor and review corrections:

```sh
pnpm typecheck
pnpm lint
pnpm test             # 7 files / 97 tests passed
pnpm build            # complete Worker + Linux image dry-run succeeded
```

Other genuine observations:

- Real workerd Worker imported production model provider and used a native remote Workers AI binding. Returned `toolUse`, parsed `record_result` arguments and real usage; not a mock REST echo. This proved `Models.stream`, not the complete Session boot or full agent turn.
- Actual local workerd/Container execution exercised SDK Files and production environment: exact binary/Unicode read/write/append, truncate/flush/rename, retained FD lines after rename/unlink, metadata/ENOENT, combined stdout/stderr/exit 7, actual timeout, 300,000-byte spill.
- Actual cancellation observed a kernel-identified child PID/parent/group and post-cancel zombie state (non-running). An earlier missing-pgrep false positive was rejected, not accepted as proof.
- Native Linux watchdog exercised twelve expirations with record on dedicated stderr, not user stdout. Legitimate exit 124 does not imply outer timeout.
- Actual SDK DirectoryBackupGateway + remote R2 captured dirty/untracked files and restored exact dirty/baseline/binary bytes into a fresh container. Owned probe objects were deleted.
- Native Linux workspace helper accepted the controlled emulated image, killed a real file writer, and observed the file stop changing.
- Real crypto Access tests; real workerd SQL conformance; real production recovery helper with file-backed SQLite close/reopen and genuine Faux-provider failure scenarios.
- Actual production deployment succeeded; anonymous root redirects to Access; authenticated UI displayed the known HTTP 500.

Additional deployed observations during continuation:

- Browser bash/read/edit changed `live-proof.txt` from alpha to beta. The actual SHA-256 matched an independent parent calculation: `33d4de0aaf865812b4aaed873feb41ce35e8e2f0c377be91b8053411947dc611`.
- Navigation away while accepted work ran, then return, preserved the session and completed `detach-proof.txt` output.
- A simulated lost receipt retained the real accepted admission UUID `<admission-id>`. UI retry and identical retry after redeployment returned original `submissionId: 44`; `retry-proof.txt` remained exactly one line.
- The Checkpoint UI and database snapshot agreed on the published pointer. The authenticated Restore API returned HTTP 200. A later dedicated-window check visually observed the native confirmation dialog and the successful UI restore message.
- A real detached Node writer recorded PID 207. After the checkpoint boundary, `/proc/207/stat` reported zombie state `Z`; its file remained 145 bytes over the next observation interval.
- Controlled redeployment interrupted an actual unsafe bash call after `UNSAFE_RUNNING`, during `sleep 180`. Its real receipt had `isError: true` and diagnostic code `interrupted`: `Tool bash was interrupted and may have partially run`. No unsafe replay occurred. The uncheckpointed `interrupted-proof.txt` was absent after recovery.
- Genuine container recreation was observed: an arbitrary `/tmp` sentinel vanished and PID 1 start time changed from 1996484 to 13550211, while the completed project file hash, detach marker, retry line count, and writer output survived. The UI displayed the checkpoint-restored-after-session-restart notice.
- Desktop protected UI hydration, transcript, live tool output, notices, and composer were visually inspected. The browser-only correction smoke preserved newer pending admission B after delayed receipt A, exposed compaction Abort, cleared a hydration error, and retained an unrelated mutation error; that throwaway VM smoke is not claimed as a full browser test.
- Generic Cloudflare `internal error; reference = …` diagnostics appeared during otherwise completed turns (for example `hgb3eu7mq8qq5gqoc1p7l8ek`); no actionable stack was provided. A structured JSON tail also observed durable-object events with outcome `ok` and empty exceptions. Do not suppress or infer a root cause from these opaque diagnostics.
- Owned workspace verification scripts (`spawn.js`, `writer.js`, writer PID file, and boot marker) were removed through a real checkpointed bash tool. `live-proof.txt`, `detach-proof.txt`, `retry-proof.txt`, and `writer-proof.txt` remain inspectable evidence; the hash and one-line retry count were reconfirmed after cleanup.
- After the user signed into Access in Safari, its actual UI resumed session `<session-id>`, the original transcript, and checkpoint `<checkpoint-id>`. A new Safari composer prompt executed three genuine read tools: `live-proof.txt` returned `cloudflare-pi-live-20261004 beta`, `detach-proof.txt` returned `detached-completed-20261004`, and `retry-proof.txt` returned one `retry-once-20261004` line. The session returned idle. No credentials or cookies were copied between browsers.
- In Safari Responsive Design Mode at 390×844, transcript text and notices wrapped, and status chips, Checkpoint/Restore, composer, If busy, and Send controls remained visible. A new indexed Send from that viewport executed the real read tool, returned `cloudflare-pi-live-20261004 beta`, exposed busy/Abort, and returned idle. No source changes were needed.

**Verification limits:** responsive proof is Safari viewport emulation, not physical-phone testing; touch gestures, software keyboards, broader device coverage, and load/soak behavior were not exercised. A background keyboard-scroll command did not visibly move the transcript and is not claimed as scroll-interaction proof. Generic Cloudflare diagnostic references remain unexplained without an actionable stack.

## Post-verification operating notes

1. All ten tracked delivery/acceptance items have passed. The deployed version and inspectable workspace proof files are listed above.
2. README.md documents setup, required Access issuer/audience config, Workers AI, deployment, persistence/network/background-process boundaries, container inactivity versus retained session state, billing, and observed verification limits.
3. Keep parent-owned gates and independent Sol review on substantive future changes. Do not commit unless requested. Never delete production R2 checkpoints still referenced by the session.
4. Browser app windows are the user's. Do not foreground, switch their tabs, or close user-adopted windows during automation; leave Safari's selected responsive viewport intact.

## Browser tooling notes

User explicitly prefers **Brave**, signed into Cloudflare. cmux embedded browser had synchronous-evaluate restrictions; native CuaDriver worked after finding the correct window. Avoid returning to that problematic embedded session as a convenience shortcut.

Read `skill://cua-driver` and its web-app guidance. Resolve pid/windows via `launch_app`/`list_windows`; no `open`, activate, Cmd-L, tab switching or focus stealing. Snapshot before/after GUI actions. `get_window_state`/screenshot timed out on stale or wrong window targets; native `page get_text` worked for the actual app window after navigation. Window IDs may change—do not assume they persist.

Last known processes: Brave `9797`, Safari `1202`. Safari window `365` now shows the authenticated Pi application and passed cross-browser resume. Do not trust Brave `2139` as an app target: its active tab changed under user control. Native Restore was verified in a dedicated window `6987`; the user subsequently adopted that window for another site, so it was left untouched. Owned single-page window `6997` was closed and its disappearance was observed.

Example read-only primitives:

```sh
cua-driver launch_app '{"bundle_id":"com.brave.Browser","urls":["https://cloudflare-pi.<your-subdomain>.workers.dev/"]}'
cua-driver list_windows '{"pid":9797}'
cua-driver page '{"pid":9797,"window_id":2139,"action":"get_text"}'
```

Brave supports page JavaScript through Apple Events. For same-origin API diagnostics, synchronous XHR or stored async results worked; do not print tokens/cookies. Use actual UI controls for user interactions. Do not infer sign-in from dashboard authentication; user already completed the app login during this session.

Safari's Apple Events JavaScript permission is disabled. Do not silently enable it. AX snapshots, `type_text`, and indexed Send clicks were sufficient to verify genuine resumed read tools; a background native resize drag was a no-op and left window geometry unchanged at 1466×949.

After the user entered Safari Responsive Design Mode, its native Width/Height AX fields supported `set_value` followed by indexed Return commits. This successfully selected 390×844 without browser JavaScript or foregrounding, unlike the earlier native-window drag attempts.

Automation limitations observed: `launch_app` URLs opened tabs rather than promised independent windows. A new-instance launch forwarded to the existing Brave process, returned an ephemeral launcher PID, and did not reliably establish the promised focus state; `--window-size` was ignored. Background native resize drag was a no-op. These were reported through tool QA; do not repeat the launch/resize workaround or foreground user apps. Guard every page diagnostic by the expected hostname before reading content or calling same-origin endpoints.

## Useful prior artifacts if available

Internal artifacts may not survive another session; this file contains the essentials. Optional sources:

- `local://application-contract.md`: detailed produced interface/lifecycle contract.
- `local://foundation-green.md`, `local://native-model-proof.md`, `local://linux-foundation-proof.md`, `local://adapter-smoke-run.md`, `local://adapter-restore-proof.md`.
- `agent://DeployedModelConstructorFix`: precise initializer/import analysis and local change.
- `agent://DeployedInitializationSolReview`: independent constructor investigation boundary.
- `agent://IntegratedBackendSolReview/findings`, `agent://IntegratedBrowserSolReview/findings`, `agent://BrowserCorrectionClosureReview/findings`: repaired behavior defects.
- `agent://RecoveryFailureWakeupFix`, `agent://IntegratedRecoveryWorkspaceReview`: alarm/initialization failure repair and closure review.

Implementation, deployed end-to-end acceptance proof, desktop/narrow-viewport browser verification, documentation, gates, independent reviews, and owned-resource cleanup are complete. The initial application commit is now authorized.
