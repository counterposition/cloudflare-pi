---
target: deployed Pi web UI
total_score: 27
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
target_identity: "file:public/index.html"
target_fingerprint: "sha256:df4c9a0211190ef12c4a27ef702c32cc99953914d7f88e7224be6ff6055ac731"
target_path: public/index.html
timestamp: 2026-10-05T00-25-25Z
slug: public-index-html
---

Method: dual-agent (A: design review · B: detector + browser evidence). Overlay unavailable: auto-mode classifier refused live-server. CLI detector clean (0 findings). Deployed files identical to local.

## Design Health Score — 27/40 (Acceptable; was 22)

| #   | Heuristic                       | Score | Key Issue                                                                          |
| --- | ------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| 1   | Visibility of System Status     | 3     | No "new activity below"; workspace stopped not shown in header                     |
| 2   | Match System / Real World       | 3     | UUID notice, raw ready/stopped, model path, HTTP banners                           |
| 3   | User Control and Freedom        | 2     | Esc in composer aborts instantly; undismissable notices/errors; inbox not editable |
| 4   | Consistency and Standards       | 3     | Restore styled like Checkpoint while Abort is danger                               |
| 5   | Error Prevention                | 2     | Esc trap; Restore confirm() lacks checkpoint age                                   |
| 6   | Recognition Rather Than Recall  | 3     | / and Cmd+S only documented in panel                                               |
| 7   | Flexibility and Efficiency      | 3     | No panel shortcut, jump-to-latest, retry/discard keys                              |
| 8   | Aesthetic and Minimalist Design | 3     | Narration card + step card per tool turn; permanent amber notice                   |
| 9   | Error Recovery                  | 3     | Generic failures are raw mono banners without action                               |
| 10  | Help and Documentation          | 2     | Steer vs follow up unexplained; keyboard list hidden on touch                      |

## Priority Issues

- [P1] Esc inside #input aborts immediately (app.js:1731; regression from round 1). Fix: double-Esc in editable targets; warn-colored flash. → harden
- [P1] #status live region (index.html:19) re-announces 1s ticking detail (app.js:753); replies not announced; transcript rebuild drops focus. Fix: detail out of live region, state-change-only announcements, keyed focus restore. → audit, harden
- [P1] Restore equal to Checkpoint; native confirm() (app.js:1543) lacks checkpoint age. Fix: Restore into panel with danger style; in-page dialog with age, Cancel focused. → harden, clarify
- [P2] Pending bar "Unsent message" may be false; never says Retry is safe (app.js:1417). → clarify
- [P2] Flat transcript: narration cards per tool turn, outcomes not findable, no new-activity pill. Fix: group by run with footer. → layout, distill

## Persona Red Flags

- Alex: 26 summaries in tab order; no panel shortcut; keys documented only in panel.
- Sam: per-second announcements; focus loss per snapshot; no message headings; panel lacks heading/close.
- Casey: notice takes 2 lines; steer/follow-up unexplained on touch; no since-you-left.
- Dana: UUID notice, 64-char ID, model path, unexplained token total, native confirm; durability story invisible.

## Minor Observations

"No output." above error line; interrupted step duplicates command (pre + Arguments); shortId cuts mid-segment; stopped workspace silent; pending time has seconds; Session button styled as action.

## Questions

Header stating "on Cloudflare, safe to close"? Runs instead of messages? Should Follow up be primary while busy? What would a since-you-left digest hold?
