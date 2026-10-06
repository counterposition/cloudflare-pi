# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Today the only user is the owner. A Cloudflare Access policy allows only the owner's email. The intended direction is a product for **individual developers** who want their coding agent to run somewhere other than their own machine, so a session doesn't depend on one laptop, terminal or browser tab.

They use it in four situations, all confirmed:

- **Focused desktop sessions:** sitting down to drive real coding work turn by turn.
- **Kick off and walk away:** starting long work, closing the tab, and trusting it keeps running.
- **Phone check-ins:** checking progress, steering or aborting from a phone.
- **Showing it to others:** demoing to colleagues or clients what a hosted agent can do.

## Product Purpose

Pi on Cloudflare is a web interface to a persistent, hosted Pi coding-agent session. A signed-in user gets one durable session. The conversation, queued and running work, and the project workspace live on Cloudflare (Durable Object, Linux container, R2 checkpoints), not in a browser tab or on a local machine. Success means the user can start work from any browser, leave, come back from another device, and find the same session exactly as the server left it.

## Positioning

From the README; not yet confirmed as marketing positioning. The session is hosted and durable, not tied to a browser or a terminal. Closing the browser only detaches an observer and never cancels accepted work. Another browser resumes the same session. Workspace effects are checkpointed before a tool reports success, and interrupted unsafe commands are reported as interrupted, never silently replayed.

## Operating Context

- One persistent session per verified Access identity. Signing in from a second browser resumes it; there is no session list or switcher.
- Live updates arrive over SSE as committed snapshots.
- A message sent while Pi is busy is either a **steer** (redirects the current work) or a **follow up** (queued for afterwards). Queued messages appear in an inbox.
- Sends carry a client request ID. A lost receipt can be retried or discarded without duplicating the admission.
- The workspace (`/workspace/project`) is **checkpointed** to R2 automatically after every write, edit or bash call, before the tool reports success. The UI presents this as "All changes saved"; there is no manual checkpoint control (removed 2026-10-04 because it duplicated the automatic save and, with only the latest two kept, pushed out the older one). **Restore** replaces all project files with the latest checkpoint. Making it undo a whole run is planned.
- The container is torn down after 10 idle minutes and recreated from the latest checkpoint when needed, so workspace state can be "recreating" or "restoring".
- Work can be **aborted**.
- The interface shows connection state, busy/idle, the model behind the latest response, workspace and checkpoint state, token usage, and session notices or warnings.

## Capabilities and Constraints

- **Frontend stack:** plain HTML, CSS and JavaScript served as static assets (`public/`), with no framework and no build step. This is the default, not fixed: propose a framework or build step only when it clearly pays for itself.
- **Pi's vocabulary is fixed:** steer, follow up, checkpoint, restore, abort and related terms stay as Pi names them.
- **Keyboard-first is fixed:** every important action must be fast without a mouse.
- **Auth:** Cloudflare Access protects both the API and the static UI. Don't add auth bypasses for testing. Local dev needs Docker and does not prove Access or hosted durability.
- **Inference:** exclusively Workers AI. The model is shown, not chosen, in the UI.
- **Workspace:** no internet access, and no background processes that outlive a tool call.
- **Undecided:** multi-user and sign-up flows, more than one session per user, a public landing surface, pricing and branding beyond the "pi" name.

## Brand Commitments

- The product is called **pi** (lowercase in the current UI) after the Pi coding agent it hosts.
- No other brand assets or voice commitments have been confirmed.

## Evidence on Hand

- A real deployment at `https://cloudflare-pi.<your-subdomain>.workers.dev`, behind Access.
- The verified end-to-end behaviours listed in `docs/VERIFICATION.md`: cross-browser resume, observer detach, lost-receipt retry deduplication, checkpoint/restore, honest unsafe interruption, and a 390×844 responsive viewport.
- There are no users other than the owner, and no testimonials, metrics, pricing or customers. Don't fabricate any.

## Product Principles

1. **The session outlives the screen.** Every surface should make it obvious that work belongs to the hosted session, not to this tab. Leaving, coming back and switching devices are normal paths, not edge cases.
2. **Prefer truthful state.** Show what the server has actually committed, and never imply success, replay or safety it hasn't confirmed. Technical detail may be simplified when it hurts usability, as long as the simplification stays true.
3. **Glanceable from anywhere.** On a phone or after time away, the user should see within seconds whether Pi is working, waiting, finished or in trouble, and be able to steer or abort.
4. **Fast hands at the desk.** In focused sessions, composing, steering, queueing and aborting are keyboard-first and never wait on the pointer.
5. **Worth showing.** The interface may be demoed to others as proof that hosted agents work, so its clarity and craft are part of the evidence.
