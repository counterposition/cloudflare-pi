# Architecture

How Pi on Cloudflare is put together. For what it is and how to deploy it, see `README.md`; for what has been verified in production, see `docs/VERIFICATION.md`.

## Components

- **Compute:** Workers plus a SQLite-backed Durable Object (`Session`) that hosts the Pi harness through the Agents SDK's `Lifecycle` and `PiHarness` (`agents@0.26.0`).
- **Sandbox:** isolated Linux containers run the real Pi bash/read/write/edit tools.
- **Storage:** R2 stores workspace checkpoints; the Durable Object database holds session and checkpoint metadata.
- **Inference:** Workers AI natively via an AI binding — default model `@cf/deepseek-ai/deepseek-v4-flash-0731`.
- **Auth:** Cloudflare Access in front of both the API and the static UI; one persistent session per verified Access identity (SHA-256 of issuer + subject; email is display metadata only). The Worker requires both `ACCESS_TEAM_DOMAIN` (issuer/team validation) and `ACCESS_AUD` (audience matching against the Access token); authentication fails without a correctly configured matching AUD.

## Overview

```
Browser ── Access-protected HTTP/SSE ── Worker (auth, routing, assets)
                                          │ RPC (serialized JSON snapshots)
                                          ▼
                               Session Durable Object (SQLite storage)
                               ├── Lifecycle (alarm-driven durable jobs)
                               │   ├── PiHarness → Pi Harness (pi_ tables, wake job)
                               │   └── host job: stranded-input recovery
                               ├── app_ tables (outside Pi's queue)
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
- **Durability:** `PiHarness` keeps Pi's transcript, inbox, and tasks in `pi_`-prefixed tables and schedules a durable `Lifecycle` wake job before each admission; the job holds the object while Pi has live tasks and restarts it through the alarm after an eviction, so runs resume with no client attached. Pi Durable 1.0.2 can strand an accepted follow-up when its run fails, and `PiHarness` does not recover it, so a host `Lifecycle` job (`recover-queued`, pushed before every admission) heartbeats while unsettled work exists and places stranded inputs through public Pi APIs. Lost receipts are retried with the same `requestId` (the receipt's `operationId`); a retry returns `accepted: false` and admits nothing. A DO restart recreates the container lazily from the last published checkpoint. The first start after upgrading from the hand-rolled host renames Pi's unprefixed tables to `pi_` in one transaction (`src/pi-table-migration.ts`, with `restoreLegacyPiTables` for rollback).
- **Unsafe interruption:** commands interrupted in an unsafe state are reported honestly, never silently replayed or declared replay-safe.
- **Observer semantics:** closing the browser detaches the observer — it does not cancel accepted server-side work. SSE and snapshot endpoints reflect committed state.

## Runtime boundaries

- **Network:** the workspace container has **no internet access**. Backup traffic goes through the private gateway binding only. The Worker holds no ambient provider credentials.
- **Background processes:** no daemons outliving a tool call are supported. Before archiving a mutating tool effect, the container helper quiesces Linux writers (including normal background commands and escaped process groups) and refuses to proceed on uncertain process state.
- **Model:** deployed inference is exclusively Workers AI `@cf/deepseek-ai/deepseek-v4-flash-0731` (context 1,048,576 tokens, output bounded at 8,192, harness thinking off). No other provider is configured or substituted.
- **Prompt caching:** every model call carries the conversation's persisted Pi provider session ID as Workers AI's `x-session-affinity` header (through the binding's `extraHeaders`), so the growing transcript can be served from Workers AI's prefix cache, at the model's cached-input rate. Cache hits show up as `cacheRead` in usage.

## Container lifecycle

The workspace container is bounded by a **10-minute inactivity timeout** (`INACTIVITY_TIMEOUT_MS` in `src/workspace.ts`, applied with `container.setInactivityTimeout` after the container starts): after 10 idle minutes the container is torn down and later recreated from the latest checkpoint on demand. The Durable Object session, its SQLite conversation storage, and R2 checkpoints are retained; there is no conversation TTL. The idle teardown hasn't yet been observed in production (`docs/VERIFICATION.md`; Issue 3 in `docs/OPEN_ISSUES.md`).
