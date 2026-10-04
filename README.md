# Pi on Cloudflare

A web-based [Pi](https://github.com/earendil-works/pi) coding-agent that runs entirely on Cloudflare. A user signs in from any browser and gets a persistent Pi coding session: the conversation, queued and running work, and the workspace live on Cloudflare — not in a terminal on one machine.

- **Compute:** Workers plus a SQLite-backed Durable Object (`Session`) that hosts the Pi harness.
- **Sandbox:** isolated Linux containers run the real Pi bash/read/write/edit tools.
- **Storage:** R2 stores workspace checkpoints; the Durable Object database holds session and checkpoint metadata.
- **Inference:** Workers AI natively via an AI binding — default model `@cf/deepseek-ai/deepseek-v4-flash-0731`.
- **Auth:** Cloudflare Access in front of both the API and the static UI; one persistent session per verified Access identity (SHA-256 of issuer + subject; email is display metadata only).

## Status and verified limitations

**The hosted-session acceptance demonstration is complete.** The protected application was exercised end to end, including cross-browser resume, durable admissions, workspace recreation, unsafe interruption, and a narrow responsive viewport. What has actually been observed:

- A real production deployment exists at `https://cloudflare-pi.<your-subdomain>.workers.dev`. Anonymous requests redirect to Cloudflare Access.
- Deployed authenticated hydration was verified: `/api/session` hydrates the real session UI, and a real prompt executed actual bash/read/edit/hash tools against the container.
- Observer navigation detach/resume was verified: navigating away and back reattaches to the same running session without cancelling work.
- Real workerd execution verified the native Workers AI model provider (real `toolUse` output and usage, not a mock) and real container execution of read/write/bash tools including timeouts, cancellation, retained file descriptors, and 300 KB output spill.
- Real SDK backup/restore to R2 captured dirty/untracked files and restored exact bytes into a fresh container.
- An actual lost-receipt scenario retried the identical admission UUID through the UI. Retrying again after a controlled redeployment returned the original `submissionId` (44); the append side effect remained exactly one line.
- Redeployment during a running unsafe bash command produced an `interrupted` error receipt, not success or automatic replay. The new container lost its `/tmp` marker and had a different PID 1 start time, while completed workspace content, hash, and checkpointed writer output survived.
- The protected Checkpoint control published matching UI/database metadata. Restore was exercised through both the authenticated API and the actual native confirmation dialog; the UI then reported a successful restore. A deliberately detached Linux writer was kernel-reported as a zombie after the checkpoint boundary, and its file stayed at 145 bytes across a subsequent observation interval.
- Safari independently authenticated through Access and resumed the same `<session-id>` session, existing transcript, and restored workspace as Brave. A new Safari composer prompt executed real read tools and returned the preserved `beta`, detach marker, and exactly one retry marker. No credentials were transferred between browsers.
- Safari Responsive Design Mode at **390×844** showed wrapped transcript/notices and visible status, Checkpoint/Restore, composer, and Send controls. A new mobile-viewport Send executed a genuine read tool, returned `cloudflare-pi-live-20261004 beta`, displayed busy/Abort controls, and returned to idle.
- Responsive proof uses Safari viewport emulation, not a physical phone. Touch gestures, software-keyboard behavior, broader device coverage, and load/soak behavior were not tested. The background keyboard-scroll automation did not move the transcript, so it is not claimed as scroll-interaction proof.
- Generic Cloudflare `internal error; reference = …` diagnostics appeared during otherwise completed turns; the tail supplied no actionable stack. These remain an observed platform-diagnostic limitation, not evidence of a failed tool receipt or silent replay.

Do not treat passing builds or tests as evidence of completed end-to-end behavior.

## Setup

Requirements:

- **Node.js >= 24**
- **pnpm 12.9.1** (pinned via `packageManager`; Corepack: `corepack enable pnpm`)
- **Docker** — the container image is built from the repo `Dockerfile` (Node 24 Debian with bash, git, ripgrep, coreutils, certificates). The build context is restricted to `Dockerfile` and `container/`.
- **Wrangler** (installed as a dev dependency) and a Cloudflare account with Workers, Containers, AI, Access, and R2 enabled.

Install with a frozen lockfile:

```sh
pnpm install --frozen-lockfile
```

## Cloudflare resources

The account used during development already has every resource provisioned. **If you are reusing provisioned resources, do not recreate them** — the configuration below describes what must exist, not commands you must run again.

1. **Log in and select the account:**

   ```sh
   pnpm exec wrangler login
   pnpm exec wrangler whoami
   ```

   The account needs Workers, Containers, AI, and Access permissions.

2. **Enable R2 and create the backup bucket.** R2 was enabled with its zero-base-price usage subscription, and the bucket `workspace-backups` was created. `wrangler.jsonc` binds it as `WORKSPACE_BACKUPS`.

3. **Workers AI** is used through the native `AI` binding (`ai` in `wrangler.jsonc`); no external provider account or API key is needed.

4. **Cloudflare Access (self-hosted application):** the private app is protected by an Access application on team `<your-team>.cloudflareaccess.com` protecting the workers.dev hostname, with an **owner-only email allow policy**. The Worker **requires** both values at runtime — `ACCESS_TEAM_DOMAIN` for issuer/team validation and `ACCESS_AUD` for audience matching against the Access token; authentication fails without a correctly configured matching AUD. Configure:
   - A self-hosted Access application for the deployed hostname, whose AUD matches `ACCESS_AUD` in `wrangler.jsonc` (both are non-secret values).
   - A policy that allows only the owner's email identity.
   - Do not bypass Access for testing; anonymous requests are expected to be redirected (302) to Access.

5. **Deploy:**

   ```sh
   pnpm deploy        # wrangler deploy; builds the Worker and the Linux container image
   pnpm exec wrangler tail cloudflare-pi --format pretty   # optional live tail
   ```

## Architecture

```
Browser ── Access-protected HTTP/SSE ── Worker (auth, routing, assets)
                                          │ RPC (serialized JSON snapshots)
                                          ▼
                               Session Durable Object (SQLite storage)
                               ├── Pi Harness (admissions, alarms, recovery)
                               ├── DurableSqliteDatabase (single storage gate)
                               └── workspace manager
                                     │ exec / SDK Files
                                     ▼
                             Linux container (Pi tools, /workspace/project)
                                     │ DirectoryBackupGateway (RPC only)
                                     ▼
                                    R2 checkpoints
```

- **Identity:** one persistent session/workspace per verified Access identity, keyed by SHA-256(issuer + subject). A second sign-in from another browser resumes the same session.
- **Container:** only `/workspace/project` persists. The rest of the container filesystem is ephemeral image state and is not restored (image-layer directories can produce Docker EXDEV errors on restore).
- **Checkpoints:** mutating tools quiesce container writers, archive the workspace to R2 through a private RPC-only gateway (`DirectoryBackupGateway`, not publicly routed), and persist the pointer **before** a successful tool receipt. Retention keeps the latest plus the previous checkpoint. GC failures leave a visible warning and retryable rows, never a false failure or a stale pointer.
- **Durability:** a durable alarm is primed before any fallible initialization; failures rearm it. Accepted follow-ups stranded by a Pi generation error are recovered through public Pi APIs. Lost receipts are retried with the same `requestId`; a controlled DO restart deduplicates admissions and recreates the container from the last published checkpoint.
- **Unsafe interruption:** commands interrupted in an unsafe state are reported honestly, never silently replayed or declared replay-safe.
- **Observer semantics:** closing the browser detaches the observer — it does not cancel accepted server-side work. SSE and snapshot endpoints reflect committed state.

## Runtime boundaries

- **Network:** the workspace container has **no internet access**. Backup traffic goes through the private gateway binding only. The Worker holds no ambient provider credentials.
- **Background processes:** no daemons outliving a tool call are supported. Before archiving a mutating tool effect, the container helper quiesces Linux writers (including normal background commands and escaped process groups) and refuses to proceed on uncertain process state.
- **Model:** deployed inference is exclusively Workers AI `@cf/deepseek-ai/deepseek-v4-flash-0731` (context 1,048,576 tokens, output bounded at 8,192, harness thinking off). No other provider is configured or substituted.

## Billing and lifecycle

Usage-based Cloudflare billing applies to Workers AI tokens, container runtime, Durable Objects requests/storage/duration, and R2 storage/operations. The workspace container is bounded by a **10-minute inactivity timeout** (`workspace.ts` container scheduling): after 10 idle minutes the container is torn down and later recreated from the latest checkpoint on demand. The Durable Object session, its SQLite conversation storage, and R2 checkpoints are **retained** — there is no conversation TTL and no guaranteed automatic billing cleanup of session data; delete stale sessions/checkpoints manually if you want those charges to stop. R2 was enabled at zero base price, but usage charges still apply. This is not a free-tier guarantee; consult current Cloudflare pricing. No other service limits or costs are claimed here.

## Local development and gates

```sh
pnpm dev          # wrangler dev
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test         # vitest; 7 files / 97 tests passed after continuation corrections
pnpm build        # wrangler deploy --dry-run
pnpm deploy
```

TypeScript is pinned at 7.0.2 and the compatibility date at 2026-10-03 (`pnpm-workspace.yaml` pins workerd `1.20261001.1` to support it). Do not downgrade either to evade test failures.

**Local limitations:** Local dev does not by itself prove production Access configuration or hosted durability; it depends on Docker and authenticated remote bindings for platform-backed services. The complete protected-browser acceptance proof must run deployed. Local gates (typecheck, lint, tests, dry-run build) verify code correctness only — they are not proof of a complete working application. Only the actually deployed, Access-authenticated smoke results listed under _Status_ count as runtime verification.
