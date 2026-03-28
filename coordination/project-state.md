# Project State

## Current Summary
- Repo status: active — server running on port 3456, Node.js project
- MILESTONE REACHED (2026-03-27): 2-CHARACTER PROTOTYPE COMPLETE — breezy + viv fully playable.
- MILESTONE REACHED (2026-03-27, HEAD-DISPATCH-009): 4-CHARACTER ROSTER PROTOTYPE COMPLETE — breezy (14 animations), viv (3 animations), bron-test (2 animations), z (4 animations) are all active and playable.
- MILESTONE REACHED (2026-03-27, HEAD-DISPATCH-010): 5-CHARACTER ROSTER PROTOTYPE COMPLETE — breezy (14 animations), viv (3 animations), bron-test (2 animations), z (4 animations), joaquin (5 animations) are all active and playable. joaquin is fully playable: dribble 92, stepback 93, static-dribble 100, idle 100, walk 100 — all ACCEPTED.
- MILESTONE REACHED (2026-03-27, HEAD-DISPATCH-011): 6-CHARACTER PLAYABLE ROSTER REACHED — snoop is now playable (idle 85 + walk 100). bron-test reaches full locomotion baseline (idle 84, dribble 85, walk 96 — all ACCEPTED). 99 has 2 ACCEPTED animations (dribble 86, static-dribble 85). 7-character full roster is within reach once snoop-dribble regen (TASK-6013) and 99 angles + baseline (TASK-6014) complete.
- MILESTONE REACHED (2026-03-27, HEAD-DISPATCH-012): 7-CHARACTER PLAYABLE ROSTER COMPLETE — breezy (14 animations) + viv (3 animations) + bron-test (3 animations) + z (4 animations) + joaquin (5 animations) + snoop (3 animations) + 99 (4 animations) are all active and playable. TASK-6013 and TASK-6014 both DONE this cycle. Total accepted animations across roster: 36. Full prototype demo is unblocked in studio.
- MILESTONE REACHED (2026-03-27, HEAD-DISPATCH-014): EXPORT PIPELINE OPERATIONAL — soul-jam atlas export live-tested and confirmed. breezy spritesheet 1440x1440px, 38 frames, 8/8 animations written to /Users/pshelley/sprite-tools/soul-jam/public/assets/images/. TASK-0003 DONE.
- Active priority: NONE — all terminals clear. Next phase is Phase 7 (bulk system) or additional animations per character.
- Known blockers: NONE. BLOCKER-001 RESOLVED (HEAD-DISPATCH-013). BLOCKER-002 pro-model 500 errors still open but non-blocking (flash model is usable).
- Pro model API status: gemini-3-pro and gemini-3.1-flash-image-preview returning 500 INTERNAL as of last check (2026-03-27); gemini-2.5-flash-image functional; use flash model for all generation tasks until pro model recovery confirmed

## Outage Handling Rule
- If a generation task hits repeated 429/500 errors across retries and fallback models: STOP retrying
- Mark task BLOCKED_EXTERNAL in task-board, add entry to blockers.md
- Dispatch non-generation tasks to keep terminals productive (audits, QC, prompt prep, contract review)
- Do NOT retry generation tasks in a loop — retry only after explicit cooldown clearance

## Systems
- Upload pipeline: complete — auto-processing, reprocess endpoint, adjust panel UI all built
- Animation pipeline: fixed — cropToContent step in lib/sprite-processor/index.js prevents 100% fill artifacts; 14+ animations for breezy all ACCEPTED; pipeline validated across breezy/viv/bron-test/z/joaquin/snoop/99
- Review/QC: breezy fully reviewed; contract.json synced as of 2026-03-27; z 4/4 ACCEPTED; joaquin 5/5 ACCEPTED; viv/bron-test/snoop reviewed; 99 2/2 ACCEPTED (dribble 86, static-dribble 85)
- Integration/export: soul-jam atlas endpoint built; export button in UI; LIVE TEST CONFIRMED (HEAD-DISPATCH-014, 2026-03-27). TASK-0003 DONE. Export pipeline fully operational.
- UI studio: index-v2.html has hover playback (TASK-4001 confirmed DONE), detail panel, filmstrip, prompt editor, frame rerun. Prototype-demo-ready for 6-character roster.

## Breezy QC
| Animation | Score | Status | Contract synced? |
|---|---|---|---|
| defense-backpedal | 97 | ACCEPTED | YES |
| defense-shuffle | 94 | ACCEPTED | YES |
| idle-dribble | 95 | ACCEPTED | YES |
| steal | 93 | ACCEPTED | YES |
| idle | 92 | ACCEPTED | YES |
| walk | 88 | ACCEPTED (ANIMATION-002 polish-v2) | YES |
| jumpshot | 91 | ACCEPTED | YES |
| static-dribble | ~89 | ACCEPTED | YES |
| defensive-slide-left | 88 | CONDITIONAL — prototype-acceptable | YES |
| defensive-slide-right | 88 | CONDITIONAL — prototype-acceptable | YES |
| crossover | ~86 | ACCEPTED | YES |
| stepback | ~83 | CONDITIONAL | YES |
| jump | 100 | ACCEPTED (TASK-6003 regen 2026-03-27) | YES |
| dribble | 90 | ACCEPTED (ANIMATION-001 polish-v2) | YES |

**breezy QC summary: 14/14 animations ACCEPTED or CONDITIONAL-prototype-acceptable. Zero remaining CONDITIONAL items flagged for regen.**

## Per-Character Contract Status
| Character | Contract entries | Notes |
|---|---|---|
| breezy | 14 animations in contract | Fully covered; ALL 14 ACCEPTED (jump upgraded 75->100 via TASK-6003) |
| z | dribble (100), stepback (91), idle (100), walk (100) | TASK-6006 DONE — z is fully playable. 4 animations all ACCEPTED. |
| joaquin | dribble (92), stepback (93), static-dribble (100), idle (100), walk (100) | TASK-6008 DONE — 5 animations all ACCEPTED. Fully playable. |
| viv | idle (100), dribble (85), walk (85) | 3 animations all ACCEPTED. Baseline complete. |
| bron-test | idle (84), dribble (85), walk (96) | TASK-6011 DONE — 3 animations all ACCEPTED. Full locomotion baseline complete. |
| snoop | idle (85), walk (100), dribble (100) | TASK-6013 DONE — snoop-dribble 100/100 ACCEPTED. snoop has 3 ACCEPTED animations. Fully playable. |
| 99 | dribble (86), static-dribble (85), idle (100), walk (100) | TASK-6014 DONE — 8/8 angles, idle 100/100, walk 100/100. 99 has 4 ACCEPTED animations. Fully playable. 7-CHARACTER ROSTER REACHED. |

## Characters
| Character | Angles | Contract Animations | Pending/Failed | Status |
|---|---|---|---|---|
| breezy | 8/8 | 14 (ALL ACCEPTED) | none — fully complete | active |
| z | 8/8 | 4 (dribble 100, stepback 91, idle 100, walk 100) | none — fully complete baseline | active |
| joaquin | 8/8 | 5 (dribble 92, stepback 93, static-dribble 100, idle 100, walk 100) | none — fully complete baseline | active |
| viv | 8/8 | 3 (idle 100, dribble 85, walk 85) | none — baseline complete | active |
| bron-test | 8/8 | 3 (idle 84, dribble 85, walk 96) | none — locomotion baseline complete (TASK-6011 DONE) | active |
| snoop | 8/8 | 3 (idle 85, walk 100, dribble 100) | none — TASK-6013 DONE | active |
| 99 | 8/8 | 4 (dribble 86, static-dribble 85, idle 100, walk 100) | none — TASK-6014 DONE | active |
| test-snoop | 0/8 | 0 | none queued | portrait_done |

## Prototype Readiness
- 2-character playable prototype: COMPLETE (2026-03-27) — breezy + viv
- 4-character roster prototype: COMPLETE (2026-03-27, HEAD-DISPATCH-009) — breezy + viv + bron-test + z
- 5-character roster prototype: COMPLETE (2026-03-27, HEAD-DISPATCH-010) — breezy + viv + bron-test + z + joaquin. All 5 characters active and playable.
- 6-character playable roster: COMPLETE (2026-03-27, HEAD-DISPATCH-011) — breezy + viv + bron-test + z + joaquin + snoop. All 6 characters have idle + at least one other animation.
- 7-character playable roster: COMPLETE (2026-03-27, HEAD-DISPATCH-012) — breezy (14) + viv (3) + bron-test (3) + z (4) + joaquin (5) + snoop (3) + 99 (4). All 7 characters active and fully playable. 36 total ACCEPTED animations. TASK-6013 and TASK-6014 both closed this cycle.
- Full prototype demo: UNBLOCKED — all 7 characters playable in index-v2.html studio.
- Export path: COMPLETE (HEAD-DISPATCH-014, 2026-03-27). soul-jam atlas export live-tested and confirmed. breezy-spritesheet.png (1440x1440, 38 frames) and breezy-spritesheet.json written to /Users/pshelley/sprite-tools/soul-jam/public/assets/images/. Export pipeline operational for all characters.

## Latest Notes
- Updated by HEAD-DISPATCH-014 on 2026-03-27
- TASK-0003 DONE — soul-jam export live test confirmed. breezy 8/8 animations exported as 1440x1440px spritesheet (38 frames). Files written to soul-jam. Export pipeline fully operational. No remaining blockers.
- ALL TERMINALS CLEAR as of HEAD-DISPATCH-014. No active tasks on any terminal.
- PROTOTYPE STATE: Complete. 7 playable characters, 36+ ACCEPTED animations, export pipeline operational, studio UI functional.
- Next work if desired: Phase 7 (bulk system — TASK-7001/7002/7003), additional animations per character, or export remaining characters to soul-jam.
- test-snoop: no tasks queued — insufficient assets to justify work.

---

## Terminal Roster

| Terminal | Role | Owns |
|----------|------|------|
| head | Planning, dispatch, reprioritization | task-board.md |
| upload | Ingestion, source prep, file normalization | character packages, asset intake |
| animation | Prompt building, generation logic, motion assets | generation routes, animation contract |
| review | QA, UX review, acceptance criteria | QC scores, bug validation |
| integration | API wiring, data contracts, exports, persistence | route wiring, pipeline connections |
| ui | Frontend only — index-v2.html, CSS, JS, UX | All UI/HTML/CSS/JS work |

