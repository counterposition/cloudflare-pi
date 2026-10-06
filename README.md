# Pi on Cloudflare

Run the [Pi](https://github.com/earendil-works/pi) coding agent as a private web app on your own Cloudflare account.

You open a URL, sign in, and chat with an agent that reads, writes, and runs code in its own Linux workspace. The session lives on Cloudflare, not in a terminal or a browser tab: close the tab and the agent keeps working; open the app from another browser or your phone and you're back in the same conversation, with the same files.

## What you get

- **A private chat with Pi in your browser**, behind Cloudflare Access, so only the people you allow can sign in.
- **A Linux workspace** at `/workspace/project`, where Pi runs shell commands and reads, writes, and edits files.
- **Work that outlives the browser.** Closing the tab only stops you watching. Accepted work keeps running, and any browser you sign in from resumes the same session.
- **Automatic saves.** Every file change is checkpointed to Cloudflare R2 before Pi reports it done. You can roll the project back to the latest checkpoint at any time.
- **Honest interruptions.** If a deploy or restart cuts a command off partway, it's reported as interrupted. It's never quietly re-run or reported as a success.

## Using it

Open the app's URL and sign in through Cloudflare Access. Type a message and press **Enter**.

While Pi is working:

- **Enter** steers the current run with a new message.
- **Alt+Enter** queues a follow-up for when the run finishes.
- **Esc** aborts the run (press it twice if you're typing).

The **Session** button shows the connection, model, workspace state, latest checkpoint, and token usage. Its **Restore…** action replaces every file in the project with the latest checkpoint, after you confirm.

Each person who signs in gets exactly one session and one workspace. There's no "new chat"; the conversation simply continues.

## Limitations

- **No internet from the workspace.** Pi can't clone repositories, install packages from a registry, or call outside APIs. It works with the files already in the project.
- **Only `/workspace/project` is kept.** Anything elsewhere in the container is lost when the container restarts.
- **No long-running background processes.** Dev servers, watchers, and other daemons are stopped before each save; a process can't outlive the command that started it.
- **One model.** Inference runs on Workers AI's `@cf/deepseek-ai/deepseek-v4-flash-0731`; no other providers are set up.
- **Known issue:** long runs with a lot of streamed output can exceed a Cloudflare CPU limit and reset the session's Durable Object. It isn't fixed yet; see [`docs/OPEN_ISSUES.md`](docs/OPEN_ISSUES.md).
- Tested in Brave and Safari on a Mac, including a phone-sized viewport, but not on a physical phone.

## Deploy your own

### Before you start

- A Cloudflare account on the Workers Paid plan (Containers require it), with R2 enabled and a Zero Trust organization for Cloudflare Access.
- Node.js 24 or newer, pnpm 12.9.1, and Docker running locally (the deploy builds the workspace's container image). With [mise](https://mise.jdx.dev), `mise install` sets up Node and pnpm for you.

### Steps

1. **Install dependencies:**

   ```sh
   pnpm install --frozen-lockfile
   ```

2. **Log in to Cloudflare:**

   ```sh
   pnpm exec wrangler login
   ```

3. **Create the R2 bucket** for workspace checkpoints:

   ```sh
   pnpm exec wrangler r2 bucket create workspace-backups
   ```

4. **Deploy:**

   ```sh
   pnpm deploy
   ```

   This creates the Worker at `https://cloudflare-pi.<your-subdomain>.workers.dev`. Until Access is set up in the next two steps, it rejects every request.

5. **Protect it with Cloudflare Access.** In the Cloudflare dashboard, turn on Access for the Worker's `workers.dev` URL, or add a self-hosted Access application for that hostname. Give it a policy that allows only the people who should use the app (for example, just your own email address). Note your team domain (`<your-team>.cloudflareaccess.com`) and the application's Audience (AUD) tag.

   Don't add a bypass rule: the app rejects any request without a valid Access token.

6. **Point the app at your Access application.** Put your values in `.dev.vars` (it's gitignored), then upload them as Worker secrets. Secrets survive later deploys, so this is a one-time step.

   ```sh
   cat > .dev.vars <<'VARS'
   ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com
   ACCESS_AUD=<your-aud-tag>
   VARS
   pnpm exec wrangler secret bulk .dev.vars
   ```

7. Open `https://cloudflare-pi.<your-subdomain>.workers.dev` and sign in.

Workers AI is used through a binding, so there's no model API key to set up. If you rename the Worker (`name` in `wrangler.jsonc`), its hostname changes, and the Access application has to match.

## Costs

Billing is usage-based: Workers AI tokens, container run time, Durable Object requests, storage, and duration, and R2 storage and operations. There's no free-tier guarantee; check Cloudflare's current pricing.

The workspace container shuts down after 10 idle minutes and is recreated from the latest checkpoint when it's next needed. Conversations and checkpoints are kept indefinitely, though. Nothing cleans them up automatically, and the app has no delete button, so remove old sessions and checkpoints yourself if you want those storage charges to stop.

## How it works

```
Browser ── Cloudflare Access ── Worker
                                  │
                                  ▼
                        Session Durable Object ── Workers AI
                        (conversation, queue, Pi)
                                  │
                                  ▼
                        Linux container (workspace) ── R2 (checkpoints)
```

A Worker checks each request's Access identity and routes it to that person's Durable Object, which runs Pi and stores the conversation in SQLite. Pi's tools run in a Linux container attached to the session, and each change to the workspace is archived to R2. Because the Durable Object, not the browser, owns the run, work continues and resumes after restarts with no browser attached.

The details are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Project status

A working personal project. It has been deployed and exercised end to end in production, including resuming from a second browser, surviving redeploys mid-run, and restoring the workspace from checkpoints. [`docs/VERIFICATION.md`](docs/VERIFICATION.md) records exactly what was observed and what wasn't; [`docs/OPEN_ISSUES.md`](docs/OPEN_ISSUES.md) lists the known problems.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, durability, checkpoints, and runtime boundaries.
- [`docs/VERIFICATION.md`](docs/VERIFICATION.md): what has been observed running in production, and its limits.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): toolchain, local development, and the test and lint gates.
- [`docs/OPEN_ISSUES.md`](docs/OPEN_ISSUES.md): known problems, with evidence.
- [`PRODUCT.md`](PRODUCT.md) and [`DESIGN.md`](DESIGN.md): product and interface design notes.
- [`docs/HANDOFF.md`](docs/HANDOFF.md) and [`docs/PIHARNESS_MIGRATION.md`](docs/PIHARNESS_MIGRATION.md): working notes from earlier development.
