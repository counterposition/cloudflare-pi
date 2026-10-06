---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/style.css", "public/app.js"]
---

# Surface brief: session UI (public/index.html)

Scope: the single-page pi session UI (header, transcript, composer, Session panel, Restore dialog). Visitor mode: Operate.

Audience and job: developers driving a hosted, durable Pi session at a desk, checking in from a phone, and demoing it. Structure is fixed by the user: keep the current layout, which is familiar to Pi users; change colours and styling only.

## Direction contract

THESIS: A dark working surface that reads as a considered tool, not the default developer dark mode; it refuses blue-black grounds, link-blue accents and rounded card soup.
OWN-WORLD: Warm graphite grounds in three steps, neutral (not blue) user bubbles, one ochre accent for the primary action, brand, focus and live work; Schibsted Grotesk for UI and prose, JetBrains Mono only for code, paths and figures; 4px corners and hairline borders.
STORY: The visitor sees at a glance whether pi is working, finished or in trouble, reads replies comfortably, and acts with the keyboard.
FIRST VIEWPORT: Unchanged composition: header with status line and Session; transcript column; composer with Steer/Send in ochre at the bottom right.
FORM: Refined dark, chosen by the user in place of the rolled worlds (seed fc774ff5); the round's category-standard exit, played straight.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
