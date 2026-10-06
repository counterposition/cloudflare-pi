---
target: deployed Pi web UI
total_score: 22
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
target_identity: "file:public/index.html"
target_fingerprint: "sha256:bd1424018921202554b200de2549e190d0bfbc26b7eae9d7df29c529269550b8"
target_path: public/index.html
timestamp: 2026-10-04T22-53-18Z
slug: public-index-html
---

Method: dual-agent (A: design review · B: detector + browser evidence). Browser overlay unavailable (Chrome Local Network Access prompt not granted); CLI detector ran.

## Design Health Score — 22/40 (Acceptable)

| #   | Heuristic                       | Score | Key Issue                                                                               |
| --- | ------------------------------- | ----- | --------------------------------------------------------------------------------------- |
| 1   | Visibility of System Status     | 3     | Busy is a small grey pill; no elapsed time, last-run outcome, or dynamic tab title      |
| 2   | Match System / Real World       | 2     | Raw machine text: [followUp], <harness> XML, ckpt UUID, full model path                 |
| 3   | User Control and Freedom        | 2     | No Abort shortcut; Discard has no undo; steer/follow-up not per-message                 |
| 4   | Consistency and Standards       | 2     | follow up vs followUp; Restore styled like Checkpoint; tool-block margin collision      |
| 5   | Error Prevention                | 3     | Strong duplicate-send guards; Restore confirm lacks checkpoint age / busy warning       |
| 6   | Recognition Rather Than Recall  | 2     | If-busy mode invisible while idle; checkpoint time hover-only                           |
| 7   | Flexibility and Efficiency      | 1     | Only Enter/Shift+Enter; no autofocus; transcript summaries in tab order before composer |
| 8   | Aesthetic and Minimalist Design | 2     | Model string x3; raw markdown fences; session chip noise                                |
| 9   | Error Recovery                  | 3     | Text preserved + Retry; raw HTTP copy with no next step                                 |
| 10  | Help and Documentation          | 2     | Steer/follow-up only in tooltip; empty state teaches nothing                            |

## Design Specificity

Category-interchangeable chat template; product character (durable session, truthful state) lives only in plumbing. Detector: 1 finding, side-tab at public/style.css:294 (.tool-block, 19 runtime instances) — semantic but symptomatic of log-dump tool cards. Static index.html scan clean (app.js renders runtime DOM).

## Priority Issues

- [P1] Status not glanceable on phone/background tab (390px: chips wrap 4 rows, truncated; transcript 414/844px; no finished/failed state; static title). Fix: single status headline in renderHeader (app.js:398), demote session/model chips, dynamic document.title. → layout, adapt
- [P1] Keyboard-first unmet (app.js:1138 only Enter/Shift+Enter; no Esc abort, no send-time steer/follow-up modifier, no autofocus, summaries in tab order). → harden
- [P1] Transcript reads unfinished: raw pre-wrap markdown, unlinked tool call/result cards, interrupted-unsafe shown as generic ERROR with <harness> XML. Fix: safe markdown DOM subset, merged tool steps, "Interrupted — not replayed" state. → typeset, clarify
- [P2] Restore under-signalled: same style as Checkpoint, tooltip-only explanation, confirm (app.js:988) lacks checkpoint time, no busy warning. → clarify
- [P2] Recovery copy untruthful/machine-y: "Unsent message" (app.js:867) may be false; raw HTTP errors; amber permanent UUID notice; unexplained token total; no stale marker while reconnecting. → clarify

## Persona Red Flags

- Alex: no autofocus, select-based mode switching that silently persists, model path on every header.
- Sam: transcript replaceChildren every snapshot (app.js:557) resets SR buffer; no role=log; ~10.5px chips/meta; tooltip-only explanations.
- Casey: workspace state truncated away; targets <44px; Abort adjacent to Send; no "since you left" marker.
- Dana (demoing to client): raw fences, debug model path, amber UUID notice, <harness> XML; durability claim invisible.

## Minor Observations

Send not primary-styled; notices undismissable and in rebuild key; live card has no elapsed time/motion; recreating/restoring unstyled; empty "system prompt updated" note; usage line wraps 3 lines on mobile; .visually-hidden incomplete; select uses UA focus ring; no favicon.

## Questions

- What would "Running on Cloudflare · committed 8s ago" do for trust and demos?
- Should steer vs follow up be decided at send time instead of a persistent dropdown?
- Is a chat-bubble layout right for a tool-running agent, versus a step timeline?
- Would a "since you left" divider serve returning visitors better?
