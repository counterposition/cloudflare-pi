---
name: pi
description: A dark, glanceable working surface for a hosted, durable Pi coding-agent session.
colors:
  ground: "#161514"
  panel: "#1d1c1a"
  panel-raised: "#262421"
  hairline: "#33302c"
  hairline-strong: "#4b4741"
  ink: "#eeece8"
  ink-dim: "#a8a39b"
  ink-faint: "#8f8a82"
  ochre: "#e0a84c"
  ochre-hover: "#eab866"
  on-ochre: "#141416"
  signal-red: "#ff7a6b"
  signal-green: "#6fcf97"
  signal-orange: "#f0864a"
  commit-red: "#c7383d"
  commit-red-hover: "#b32f34"
  on-commit-red: "#ffffff"
  user-bubble: "#2a2825"
  button-hover: "#2c2a26"
typography:
  brand:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 800
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 650
    lineHeight: 1.35
  heading:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.12rem"
    fontWeight: 650
    lineHeight: 1.35
  body:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  prose:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  control:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.3
  status:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 600
  label:
    fontFamily: "Schibsted Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  marker: "1px"
  sm: "4px"
  dot: "50%"
spacing:
  xs: "0.3rem"
  sm: "0.5rem"
  md: "0.9rem"
  entry: "1.1rem"
  gutter: "1rem"
  gutter-phone: "0.75rem"
  column: "48rem"
components:
  button:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0.4rem 0.9rem"
  button-hover:
    backgroundColor: "{colors.button-hover}"
  button-primary:
    backgroundColor: "{colors.ochre}"
    textColor: "{colors.on-ochre}"
    rounded: "{rounded.sm}"
    padding: "0.4rem 0.9rem"
  button-primary-hover:
    backgroundColor: "{colors.ochre-hover}"
  button-danger:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.signal-red}"
    rounded: "{rounded.sm}"
    padding: "0.4rem 0.9rem"
  button-danger-solid:
    backgroundColor: "{colors.commit-red}"
    textColor: "{colors.on-commit-red}"
    rounded: "{rounded.sm}"
    padding: "0.4rem 0.9rem"
  button-danger-solid-hover:
    backgroundColor: "{colors.commit-red-hover}"
  composer-input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0.55rem 0.75rem"
  reply:
    textColor: "{colors.ink}"
    typography: "{typography.prose}"
    padding: "0.1rem 0 0.2rem"
  bubble-user:
    backgroundColor: "{colors.user-bubble}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.6rem 0.9rem 0.7rem"
  tool-steps:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  tool-step:
    textColor: "{colors.ink}"
    padding: "0.3rem 0.7rem"
    height: "2.1rem"
  code-well:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 0.65rem"
  topbar:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    padding: "0.5rem 1rem"
  session-panel:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "1rem 1.1rem 1.1rem"
    width: "23rem"
---

# Design System: pi

## Overview

**Creative North Star: "The Lit Workbench"**

A dark working surface that reads as a considered tool rather than the default developer dark mode. Three steps of warm graphite carry all structure; one ochre accent marks the few things that matter right now: the brand, the primary action, keyboard focus, and work in progress. Everything else is ink in three tiers and hairlines.

The surface is dense but calm. A single reading column (48rem) holds the conversation, with a sticky status bar above and the composer below. Replies sit directly on the ground like a document; only the visitor's own messages are filled. State is carried by small markers and coloured words, never by large fills, and trouble changes shape as well as colour, so a glance from a phone answers "working, finished, or in trouble" without the screen shouting. Depth comes from tonal steps and 1px borders, not shadows.

It rejects blue-black grounds, link-blue accents and rounded card soup. Corners are a tight 4px everywhere; borders are hairlines.

**Key Characteristics:**

- Three warm graphite tonal steps (ground, panel, raised; red > green > blue) with hairline borders for structure.
- One ochre accent, reserved for brand, primary action, focus and live work.
- Status as small markers plus coloured text in a fixed four-tone vocabulary; trouble is hollow and square-cornered.
- Replies on the ground, user messages filled, tool steps as one connected list.
- Schibsted Grotesk for UI and prose; JetBrains Mono only for code, paths, ids and machine figures.
- 4px corners, 1px rules, flat surfaces, no decorative shadows.

## Colors

Warm graphite (OKLCH hue 68-85, chroma under 0.014) lit by a single ochre and three signal hues.

### Primary

- **Workbench Ochre** (ochre): the only accent. Brand wordmark, primary button fill (Send/Steer), focus outline, caret, link underlines, the running-step dot, the "working" status dot, the live reply's "writing…" label and the working line's dot. Hover lifts to **Ochre Glow** (ochre-hover). Text on ochre is **On-Ochre** (on-ochre), holding 8.6:1.

### Secondary

- **Signal Green** (signal-green): finished and saved states: ok status dot, completed tool steps, flash confirmations.
- **Signal Orange** (signal-orange): attention without failure: warning status, interrupted or aborted steps, notices, the armed-abort hint, warning notes, the restore dialog's caveat, and the pending-send strip (10% tint, 40% top rule). Deliberately orange so it never reads as the ochre accent.
- **Signal Red** (signal-red): failure and destructive intent: error banner, failed steps, error notes, danger buttons' text and border.

Signal tints are always written through the RGB channel tokens (`--warn-rgb`, `--danger-rgb`) so a tint can never drift from its solid.

### Tertiary

- **Commit Red** (commit-red, hover commit-red-hover): the solid fill for the one button that commits a destructive confirmation (Restore checkpoint). Text on it is **On-Commit** (on-commit-red, white), holding 5.1:1. Never used outside a confirmation dialog.

### Neutral

- **Ground** (ground): page background, replies, composer field, code wells, kbd keys. The deepest step.
- **Panel** (panel): top bar, composer bar, inbox, the tool-step list; also the theme-color and favicon tile.
- **Raised** (panel-raised): buttons at rest, the Session popover, the confirmation dialog, table headers. Button hover steps to **Button Hover** (button-hover).
- **User Graphite** (user-bubble): the user message bubble, the only filled transcript entry; neutral, never tinted blue.
- **Hairline** (hairline) and **Strong Hairline** (hairline-strong): every border; strong for popovers, dialogs, kbd keys, blockquote rules, scrollbars and hover borders.
- **Ink** (ink): primary text and link text.
- **Dim Ink** (ink-dim): secondary text: status detail, labels, step targets and status words, queue labels, notes, thinking, the save line.
- **Faint Ink** (ink-faint): the third tier: timestamps, model ids, the composer hint and placeholder. It holds 4.5:1 on ground, panel and raised; inside the filled user bubble it drops below that, so timestamps there step up to Dim Ink.

### Named Rules

**The One Ochre Rule.** Ochre marks only brand, primary action, focus and live work. If an element is none of these, it is not ochre.

**The Four Tones Rule.** Status speaks in exactly four tones: working (ochre), ok (green), warn (orange), danger (red), plus idle (dim ink). The page markers, step markers and favicon badge use the same colour mapping.

**The Tint, Not Fill Rule.** Signal colours appear as text, markers, borders and 6-12% tints. Only Commit Red is ever a solid fill.

**The Faint Floor Rule.** Faint Ink is only used on ground, panel or raised. On any lighter fill, step up to Dim Ink.

## Typography

**Display Font:** none; the brand wordmark is the only display moment.
**Body Font:** Schibsted Grotesk (with system-ui, -apple-system, Segoe UI, Roboto, sans-serif), self-hosted variable 400-900.
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo, Consolas, monospace), self-hosted variable.

**Character:** A sturdy, slightly editorial grotesk carries the interface and the assistant's prose; mono appears only where characters must line up or be copied exactly.

### Hierarchy

- **Brand** (800, 1.2rem, -0.03em): the lowercase "pi" wordmark in ochre. Used once.
- **Title** (650, 1.05rem, 1.35): dialog titles.
- **Heading** (650, 1.12rem, 1.35): markdown h1 in replies; h2 and below step down to 1.04rem at the same weight.
- **Status** (600, 0.95rem): the status word in the top bar; its detail runs at 400 in dim ink with tabular figures.
- **Body** (400, 1rem, 1.5): base text, composer input (1.45). Assistant markdown runs at 1.6 inside the 48rem column.
- **Control** (400, 0.875rem, 1.3): buttons, Session panel; primary and commit buttons go to 600.
- **Label** (600, 0.75rem): sender names (0.8rem), panel section titles, queue labels. Sentence case, no tracking.
- **Meta** (400, 0.75-0.85rem): timestamps and hints in faint ink; notes, step status and banners in dim or signal colour.
- **Code** (JetBrains Mono 400, 0.8rem, 1.5): tool output, commands, thinking, session/model ids, checkpoint fact, usage; markdown code blocks at 0.82rem; inline code at 0.87em on an 8% ink tint; step names at 600.

### Named Rules

**The Mono Means Literal Rule.** JetBrains Mono is for code, paths, ids, model names and machine figures only. Never for UI labels, headings, banners or status prose.

**The Tabular Figures Rule.** Elapsed times, timestamps, usage and tables use `font-variant-numeric: tabular-nums` so ticking numbers do not jitter.

## Layout

A full-height flex column: sticky top bar, optional banners, a scrolling transcript, optional inbox and pending strips, then the composer. Transcript children, inbox contents and composer contents are each capped to one centred reading column (48rem) inside a 1rem gutter, so all three align on wide screens.

The top bar is a three-area grid (brand, status, Session) with 0.5rem/0.9rem gaps. Rhythm is small and steady: 0.5rem between controls and above a reply's step list, 1.1rem between transcript entries. User bubbles right-align at up to min(40rem, 88%); replies take the full column.

Responsive: at 640px and below the gutter tightens to 0.75rem, the status line stacks over the save line, the Session popover spans the viewport, and user bubbles widen to 92%. On coarse pointers, buttons and step summaries grow to a 2.75rem minimum height and keyboard hints and the shortcut list are hidden. Safe-area insets pad the top bar and composer.

## Elevation & Depth

Flat. Depth is tonal: ground for the page, replies and inset wells; panel for bars and the step list; raised for things that float (popover, dialog, buttons). Every layer edge is a 1px hairline; floating layers use the strong hairline. The only shadows are functional: a 1px ochre ring on the focused composer, inset rings that draw hollow markers, and the expanding ochre pulse on a running step. Dialogs dim the page with a 72% warm near-black backdrop.

### Shadow Vocabulary

- **Focus ring** (`box-shadow: 0 0 0 1px var(--accent)`): composer field focus, paired with an ochre border.
- **Hollow marker** (`box-shadow: inset 0 0 0 1.5px var(--text-dim)`): pending or missing tool step.
- **Trouble marker** (`box-shadow: inset 0 0 0 2px var(--warn)`): warning status (round) and interrupted/aborted steps (1px-radius square).
- **Live pulse** (`0 0 0 0 rgba(224,168,76,.55)` to `0 0 0 .5rem rgba(224,168,76,0)`, 1.6s): running tool step dot only; disabled under reduced motion.

### Named Rules

**The Tone Is Depth Rule.** Lift a surface by stepping it to the next graphite tone and giving it a strong hairline, never by adding a drop shadow.

## Shapes

One radius: 4px on buttons, the user bubble, the step list, code wells, inputs, popover, dialog, kbd keys and inline code. Healthy state markers are filled circles (0.5-0.55rem); trouble markers are hollow, a 2px orange ring in the status line and a 1px-radius hollow square on steps. Every border and rule is 1px: hairlines, blockquote rules (strong hairline), kbd keys (strong hairline all round), step dividers. The disclosure chevron is drawn from two 1.5px borders, rotating 180 degrees on open.

### Named Rules

**The Trouble Changes Shape Rule.** Working and finished are filled; trouble is hollow (and square on steps). Never signal a warning by colour alone.

## Components

### Buttons

Refined and restrained; one loud button per context.

- **Shape:** gently squared (4px), 1px hairline border.
- **Default:** raised graphite fill, ink text, 0.875rem, 0.4rem 0.9rem padding.
- **Primary:** ochre fill and border, on-ochre text at 600. One per row (Send/Steer).
- **Danger:** raised fill, signal-red text, 60% red border; hover adds a 12% red tint. Used for Abort and Restore entry points.
- **Danger solid:** commit-red fill, white 600 text; only the confirming button inside a destructive dialog.
- **Hover / Focus:** background and border ease over 150ms on the expo-out curve; hover strengthens the border. Focus is a 2px ochre outline offset 2px. Disabled drops to 45% opacity.

### Links

- Ink text with an ochre underline offset 0.18em; focus takes the standard ochre outline.

### Inputs / Fields

- **Style:** the composer textarea sits on the ground tone inside the panel-toned composer bar, hairline border, 4px, auto-growing to 40vh. Placeholder in faint ink.
- **Focus:** border turns ochre plus a 1px ochre ring; no outline.

### Navigation (top bar)

- Panel-toned sticky bar with a hairline bottom. Brand left, status centre, Session button right. The status line pairs a tone marker, a 600-weight state word (orange or red when warn/danger), and a dim tabular detail; a dim save line follows after a hairline divider (stacked under it on phones).

### Transcript Entries

- **Reply:** no fill, no border, sitting on the ground at prose measure; header shows sender (0.8rem/600), faint timestamp and right-aligned faint mono model id.
- **User bubble:** right-aligned, user-graphite fill, hairline edge, 4px, 0.6rem 0.9rem padding; its timestamp is dim, not faint.
- **Live reply:** the reply being written, styled exactly like the reply it becomes, with an ochre "writing…" label in the timestamp slot. A quiet "Working…" line with an ochre dot holds the reading position when nothing is streaming yet.

### Tool Steps (signature)

- A reply's tool calls form one connected list: a single panel-toned block with a hairline edge and 4px corners, rows separated by hairline dividers. Each row is collapsible: tone marker, mono step name at 600, dim mono target truncated with ellipsis, dim status word, and a border-drawn chevron. Running steps put the status word in ochre; interrupted and error rows take a 6% orange or red tint and coloured status. Bodies hold code wells (ground tone, mono 0.8rem) capped at 24rem.

### Session Popover and Confirmation Dialog

- Raised tone, strong hairline, 4px. The popover is a definition list of facts (dim 0.75rem terms, mono values for session id, model, checkpoint and usage) plus a kbd shortcut table; kbd keys sit on ground with a 1px strong hairline. The dialog right-aligns Cancel and the commit-red action.

### Status Strips

- Full-bleed rows inside the gutter, all in the sans face: error banner (red on a 10% red tint with a 35% red bottom rule), notices (orange text), flash (green text, orange for warnings), inbox (panel tone, dim "Queued" title and dim mode labels), pending send (10% orange tint, ink text, Retry/Discard buttons).

## Do's and Don'ts

### Do:

- **Do** keep every surface on the three warm graphite steps (ground, panel, raised) and separate them with 1px hairlines.
- **Do** reserve ochre for brand, the primary action, focus and live work.
- **Do** express state through the four-tone vocabulary (ochre, green, orange, red), and make trouble hollow as well as orange or red.
- **Do** write signal tints through the RGB channel tokens (`--warn-rgb`, `--danger-rgb`).
- **Do** use Faint Ink only on ground, panel and raised; step up to Dim Ink inside the user bubble.
- **Do** use 4px corners on every rectangle, circles for healthy markers, and 1px for every rule.
- **Do** set code, paths, ids and figures in JetBrains Mono, and use tabular figures for anything that ticks.
- **Do** give every control a 2px ochre focus outline and a 2.75rem minimum height on coarse pointers.

### Don't:

- **Don't** use blue-black grounds, link-blue accents or blue-tinted user bubbles.
- **Don't** fill or border assistant replies; only the user's message is a bubble.
- **Don't** add drop shadows for elevation; step the tone instead.
- **Don't** use larger radii or pill shapes for containers or buttons.
- **Don't** fill large areas with signal colours; tints stay at 6-12% and only Commit Red is solid.
- **Don't** use the warning colour for neutral labels such as queue modes.
- **Don't** set UI labels, headings, banners or status prose in mono.
