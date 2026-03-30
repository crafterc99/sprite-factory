# SPRITE FACTORY — MASTER TASK BOARD

---


## REGEN QUEUE

### SYNC-CONTRACT-003 -- Add snoop-idle to animation-contract.json

**Owner:** Integration
**Status:** DONE — 2026-03-27. characters.snoop.animations.idle added. qcStatus ACCEPTED, qcScore 85/100, 5 frames, 900x180 confirmed.

---

### SYNC-CONTRACT-002 -- Add z-stepback to animation-contract.json

**Owner:** Integration
**Status:** DONE — 2026-03-27. characters.z.animations.stepback added. qcStatus ACCEPTED, qcScore 91/100 confirmed.

---

### SYNC-CONTRACT-001 -- Sync animation-contract.json with latest QC results

**Owner:** Integration
**Status:** DONE

---

### ANIM-REGEN-SNOOP-IDLE -- Regenerate snoop idle animation

**Owner:** Animation
**Status:** DONE — 2026-03-27 (reprocess with fixed pipeline). Score 85/100 ACCEPTED. 900x180, 5 frames. See results.md.

---

### ANIM-REGEN-Z-STEPBACK -- Regenerate z stepback animation

**Owner:** Animation
**Status:** DONE — 2026-03-27. Restored from prior accepted frames, re-evaluated 91/100. z-stepback.png is 720x180.

---


## PHASE 0 — BLOCKERS (MUST COMPLETE FIRST)

### TASK-0001 — Fix batch customPrompt bug

**Owner:** Integration
**Status:** DONE

---

### TASK-0002 — Regenerate breezy-dribble

**Owner:** Animation
**Status:** DONE

---

### TASK-0003 — Fix soul-jam export dependency

**Owner:** Integration
**Action:** clone ../soul-jam/ repo and verify endpoint
**Success:** POST /api/export/soul-jam returns valid atlas
**Status:** DONE — (2026-03-27, HEAD-DISPATCH-014). Live test confirmed: POST /api/export/soul-jam with breezy returned success. 8/8 animations included, 0 missing. Spritesheet: 1440x1440px, 38 frames. Files written to /Users/pshelley/sprite-tools/soul-jam/public/assets/images/breezy-spritesheet.png and breezy-spritesheet.json. Export pipeline fully operational.

---

## PHASE 1 — CHARACTER SYSTEM

### TASK-1001 — Create character endpoint

**Owner:** Upload
**Status:** DONE — implemented in routes/characters.js:359.

---

### TASK-1002 — Clothing registry

**Owner:** Upload
**Status:** DONE

---

### TASK-1003 — Apply clothing endpoint

**Owner:** Upload
**Status:** DONE

---

### TASK-1004 — Register character "99" in .characters.json and contract

**Owner:** Upload
**Priority:** HIGH
**Files:** data/.characters.json, data/animation-contract.json
**Problem:** Character "99" has assets on disk (data/assets/99full.png, 99-dribble.png, 99-static-dribble.png, spritesheet, frames/) but is absent from .characters.json and animation-contract.json characters block.
**Actions:**
  1. Inspect 99-dribble.png and 99-static-dribble.png — confirm strip dimensions and frame count (use sharp or file dimensions)
  2. Add "99" entry to data/.characters.json: name "99", id "99", portraitPath "99full.png", style "16-bit pixel art, GBA style", build "athletic", status "portrait_done" (check for 99-angle-*.png files — if they exist, list them in anchor.angles)
  3. Add characters["99"].animations to animation-contract.json for each confirmed animation — set qcStatus "NEEDS_REVIEW" and qcScore null until evaluated
  4. Run node -e "require('./data/animation-contract.json')" to confirm JSON parses
**Success:** "99" in .characters.json; characters["99"] block in contract; JSON parses clean; log to results.md
**Status:** DONE — 2026-03-27. anchor block added to .characters.json "99" entry; characters["99"].animations added to animation-contract.json (dribble 8f 1440x180, static-dribble 6f 1080x180). Both files parse clean. See results.md.

---

## PHASE 2 — MULTI-ANGLE GENERATION

### TASK-2001 — Angle generation logic

**Owner:** Animation
**Status:** DONE

---

### TASK-2002 — Store angles in package

**Owner:** Upload
**Status:** DONE — POST /api/character/:name/package/sync-angles (characters.js:1167).

---

### TASK-2003 — Angle rerun endpoint

**Owner:** Integration
**Status:** DONE

---

### TASK-2004 — Generate z angles

**Owner:** Animation
**Priority:** HIGH
**Character:** z (portrait: data/assets/zfull.png)
**Problem:** z has zero angles on disk; .characters.json z.anchor.angles is empty. z has 2 ACCEPTED animations and 6 ball refs but the pipeline cannot use angle-based generation without directional refs.
**Action:** Generate 8 directional angles for z using the angle generation endpoint or pipeline. Output: data/assets/z-angle-0.png through z-angle-7.png. Then call POST /api/character/z/package/sync-angles to register them in .characters.json.
**Success:** z-angle-0.png through z-angle-7.png exist on disk; z.anchor.angles has 8 entries in .characters.json; log to results.md
**Status:** DONE — 2026-03-27. All 8 angles generated (gemini-2.5-flash-image, 180x180 each, padding fix applied). z.anchor.angles populated, z.anchor.status = "complete". See results.md TASK-2004.

---

## PHASE 3 — VIDEO TO ANIMATION

### TASK-3001 — Video frame extraction

**Owner:** Animation
**Status:** DONE — routes/video.js:53.

---

### TASK-3002 — Frame selection UI

**Owner:** Integration
**Status:** DONE

---

### TASK-3003 — Pose-based animation generation

**Owner:** Animation
**Status:** DONE — routes/video.js:188.

---

## PHASE 4 — REVIEW SYSTEM

### TASK-4001 — Hover playback

**Owner:** Integration
**Status:** DONE — 2026-03-27 (HEAD-DISPATCH-004 audit). setupAnimHovers() at index-v2.html:1459-1483 implements mouseenter/mouseleave setInterval playback via background-position-x scrubbing on .anim-cell.done elements.

---

### TASK-4002 — Animation detail panel

**Owner:** Integration
**Status:** DONE

---

### TASK-4003 — Frame regenerate endpoint

**Owner:** Integration
**Status:** DONE — 2026-03-27 (HEAD-DISPATCH-004 audit). Backend POST /api/frame-prompts/:character/:animName/:frameIndex/rerun in routes/generation.js. UI "Rerun frame" button at index-v2.html:758 wired to this endpoint at index-v2.html:2058.

---

### TASK-4004 — QC auto-trigger loop

**Owner:** Review
**Status:** DONE — POST /api/auto-test in routes/evaluation.js:42.

---

## PHASE 5 — FRAME-LEVEL PROMPT EDITING

### TASK-5001 — Store prompts per frame

**Owner:** Animation
**Status:** DONE — 2026-03-27. See results.md TASK-5001.

---

### TASK-5002 — Prompt editor UI

**Owner:** Integration
**Status:** DONE — 2026-03-27. See results.md TASK-5002.

---

### TASK-5003 — Frame override logic

**Owner:** Animation
**Status:** DONE — 2026-03-27. POST /api/frame-prompts/.../rerun in routes/generation.js.

---

## PHASE 6 — BASELINE ANIMATIONS FOR NON-BREEZY CHARACTERS

### TASK-6001 — Generate viv baseline animations (idle + dribble + walk)

**Owner:** Animation
**Priority:** HIGH
**Character:** viv (portrait: data/assets/vivfull.png, 8 angles: viv-angle-0 through viv-angle-7, ball refs: viv-ball-*.png)
**Rationale:** viv has complete setup (portrait, 8 angles, 6 ball refs) but zero animations. Highest ROI generation task. Completing this gives a 2-character prototype.
**Actions:**
  1. Generate viv-idle.png: 4 frames, 720x180, #00FF00 background, looping idle stance, no ball, fps 6, loop true. Use viv-angle-2.png as character ref. QC threshold 80/100.
  2. Generate viv-dribble.png: 8 frames, 1440x180, #00FF00 background, running dribble cycle with ball, fps 10, loop true. Use viv-angle-2.png + viv-ball-dribble-high.png as refs. QC threshold 80/100.
  3. Generate viv-walk.png: 8 frames, 1440x180, #00FF00 background, walk cycle no ball, fps 10, loop true. Use viv-angle-2.png as ref. QC threshold 80/100.
**Output:** data/assets/viv-idle.png, data/assets/viv-dribble.png, data/assets/viv-walk.png
**Success:** All 3 at correct dimensions, each >= 80/100 QC; add to animation-contract.json characters.viv block; log to results.md
**Status:** DONE — 2026-03-27. viv-dribble ACCEPTED 85/100 (8f 1440x180), viv-walk ACCEPTED 85/100 (8f 1440x180), viv-idle ACCEPTED 100/100 (4f 720x180, padding fix via TASK-6005). All three animations in animation-contract.json characters.viv block. 2-character prototype (breezy + viv) playable.

---

### TASK-6002 — Generate bron-test baseline animations (idle + dribble)

**Owner:** Animation
**Priority:** MEDIUM
**Character:** bron-test (portrait: data/assets/bron-testfull.png, 8 angles: bron-test-angle-0 through bron-test-angle-7)
**Actions:**
  1. Generate bron-test-idle.png: 4 frames, 720x180, #00FF00 background, looping idle stance, no ball, fps 6. Use bron-test-angle-2.png as ref. QC threshold 80/100.
  2. Generate bron-test-dribble.png: 8 frames, 1440x180, #00FF00 background, running dribble cycle, fps 10, loop true. QC threshold 80/100.
**Output:** data/assets/bron-test-idle.png, data/assets/bron-test-dribble.png
**Success:** Both at correct dimensions, each >= 80/100; add to animation-contract.json characters.bron-test block; log to results.md
**Status:** DONE — 2026-03-27. bron-test-idle ACCEPTED 100/100 (4f 720x180), bron-test-dribble ACCEPTED 100/100 (8f 1440x180). Padding fix applied. characters.bron-test.animations block added to animation-contract.json. See results.md TASK-6002.

---

### TASK-6003 — Regen breezy jump (CONDITIONAL 75 to target >=85)

**Owner:** Animation
**Priority:** MEDIUM
**Character:** breezy (use breezy-angle-2.png as char ref; prior output data/assets/breezy-jump.png is 5f 900x180)
**Problem:** breezy-jump is the only breezy animation still CONDITIONAL at 75/100. Prior issues: black artifacts, identity drift, flat arc.
**Action:** Regenerate breezy-jump.png: 5 frames, 900x180, #00FF00 background, vertical jump no ball, fps 8, loop false. Enforce clear jump arc (crouch, takeoff, peak, descent, land) and character purity.
**QC threshold:** 85/100 to upgrade from CONDITIONAL to ACCEPTED
**Success:** breezy-jump.png is 900x180 with clear jump arc, >= 85/100; update contract entry qcStatus to ACCEPTED; log to results.md
**Status:** DONE — 2026-03-27. ACCEPTED 100/100. breezy-jump.png overwritten (900x180, 5 frames). animations.jump.qcStatus -> ACCEPTED in contract. See results.md TASK-6003.

---

### TASK-6004 — Audit and decision on joaquin static-dribble

**Owner:** Review
**Priority:** LOW
**Character:** joaquin (data/assets/joaquin-static-dribble.png — prior QC 38/100 FAILED)
**Action:** Visually inspect joaquin-static-dribble.png. Is identity correct? Are any frames usable as pose refs? Write decision to results.md: DISCARD (do not add to contract) or REGEN-QUEUED (open a new regen task with spec). If REGEN-QUEUED, add the new task to this board.
**Success:** Written decision in results.md; task closed
**Status:** DONE — 2026-03-27. Decision: REGEN-QUEUED. Frames 000-003 clean and identity-confirmed; frames 4-5 are pipeline extraction artifacts (strip-within-strip, style break). Static-dribble is worth fixing (high-value motion type, identical fix to z-dribble/viv-idle precedent). TASK-6007 opened. See results.md.

---

### TASK-6005 — Reprocess viv-idle with padding fix (160x160 content area within 180x180 frame)

**Owner:** Animation
**Priority:** HIGH
**Character:** viv
**Problem:** viv-idle-raw.png scored 79/100 FAILED. Root cause: 96.7% fill height — content bounding box 39x174px is critically tall, triggering too_large on all frames. Only 1 point below threshold. This is the same issue z-dribble had before the padding fix.
**Precedent:** z-dribble was fixed by padding each frame so content occupies at most 160x160 within the 180x180 output frame (10px margin on all sides). That fix brought z-dribble from FAILED to 100/100.
**Action:**
  1. Load data/raw-sprites/viv-idle-raw.png (4-frame horizontal strip — 16:9 source, cut into 4 equal frames)
  2. For each frame: detect content bounding box, scale content to fit within 160x160 (preserving aspect ratio), center in a 180x180 transparent canvas
  3. Reassemble the 4 padded frames into a new 720x180 strip
  4. Save output to data/assets/viv-idle.png (overwrite the failed output)
  5. Run QC evaluation — target >= 80/100
**Raw input:** data/raw-sprites/viv-idle-raw.png
**Output:** data/assets/viv-idle.png (720x180, 4 frames, padded)
**Success:** viv-idle.png is 720x180, QC >= 80/100 ACCEPTED; update animation-contract.json characters.viv with idle entry; log to results.md
**Status:** DONE — 2026-03-27. 100/100 ACCEPTED. 720x180, 4 frames. animation-contract.json updated. See results.md TASK-6005.

---

### TASK-6006 — Generate z baseline animations (idle + dribble + walk)

**Owner:** Animation
**Priority:** MEDIUM
**Character:** z (portrait: data/assets/zfull.png, angles: z-angle-0.png through z-angle-7.png, ball refs: z-ball-*.png)
**Unblocked by:** TASK-2004 DONE (z now has 8 directional angles)
**Rationale:** z has complete setup (portrait, 8 angles, 6 ball refs, 2 ACCEPTED animations). Adding idle+dribble+walk brings z to a 3-animation baseline matching viv and unlocks a 4-character roster prototype (breezy + viv + bron-test + z).
**Actions:**
  1. Generate z-idle.png: 4 frames, 720x180, #00FF00 background, looping idle stance, no ball, fps 6, loop true. Use z-angle-2.png as character ref. QC threshold 80/100.
  2. Generate z-dribble-walk.png (walk with dribble): 8 frames, 1440x180, #00FF00 background, running dribble cycle with ball, fps 10, loop true. Use z-angle-2.png + z-ball-dribble-high.png as refs. QC threshold 80/100.
  3. Generate z-walk.png: 8 frames, 1440x180, #00FF00 background, walk cycle no ball, fps 10, loop true. Use z-angle-2.png as ref. QC threshold 80/100.
  4. Apply 160x160-within-180x180 padding fix to all outputs (same as viv-idle, bron-test precedent).
  5. Add characters.z.animations entries for idle, dribble, and walk to animation-contract.json.
**Output:** data/assets/z-idle.png (720x180), data/assets/z-dribble.png (1440x180), data/assets/z-walk.png (1440x180)
**Success:** All 3 at correct dimensions, each >= 80/100 QC; contract entries added; log to results.md
**Status:** DONE — 2026-03-27. z-idle ACCEPTED 100/100 (4f 720x180), z-walk ACCEPTED 100/100 (8f 1440x180). z-dribble skipped (already ACCEPTED 100/100). Padding fix applied to all. characters.z.animations.idle + walk added to animation-contract.json. See results.md TASK-6006.

---

### TASK-6007 — Regen joaquin static-dribble frames 4-5 and reassemble strip

**Owner:** Animation
**Priority:** LOW
**Character:** joaquin
**Problem:** joaquin-static-dribble scored 38/100 FAILED. Visual audit (TASK-6004) confirmed: frames 000-003 are clean and identity-locked; frames 4-5 are pipeline extraction artifacts (frame-004 shows 3 tiled miniature figures; frame-005 has wrong art style and identity break). Strip was also assembled as 2-row instead of single-row — needs clean single-row output.
**Actions:**
  1. Use frames 000-003 from data/assets/joaquin-static-dribble-frames/ as accepted base frames (do not regenerate these)
  2. Regenerate frames 4 and 5: stationary dribble cycle continuing from frame-003 pose (upright stance, ball held low at right side). Use joaquin-angle-2.png as character ref. Match style to frames 000-003 (16-bit pixel art, GBA style, black outlines, "Lucky Trucker" shirt, blue jeans).
  3. Apply 160x160-within-180x180 padding fix to all 6 frames (same as UPLOAD-BGX-001 z-dribble and TASK-6005 viv-idle precedent)
  4. Assemble all 6 padded frames into a single horizontal row: 1080x180 strip
  5. Save to data/assets/joaquin-static-dribble.png (overwrite)
  6. Run QC evaluation — target >= 80/100
  7. Add characters.joaquin.animations.static-dribble to animation-contract.json if QC passes
**Output:** data/assets/joaquin-static-dribble.png (1080x180, 6 frames, single-row)
**Success:** Strip is 1080x180, QC >= 80/100, contract entry added, log to results.md
**Status:** DONE — 2026-03-27. Frames 4-5 regenerated (gemini-2.5-flash-image), all 6 reprocessed with padding fix, assembled as single-row 1080x180. QC 100/100 ACCEPTED. characters.joaquin.animations.static-dribble added to contract. See results.md TASK-6007.

---

## PHASE 6 — CONTINUED CHARACTER BASELINE

### TASK-6008 — Generate joaquin baseline animations (idle + walk)

**Owner:** Animation
**Priority:** HIGH
**Character:** joaquin (portrait: data/assets/joaquinfull.png, angles: joaquin-angle-0.png through joaquin-angle-7.png)
**Rationale:** joaquin has 8 angles, 3 ACCEPTED animations (dribble 92, stepback 93, static-dribble 100), and is fully unblocked. Adding idle + walk brings joaquin to a complete locomotion baseline and enables a 5-character roster prototype (breezy + viv + bron-test + z + joaquin).
**Actions:**
  1. Generate joaquin-idle.png: 4 frames, 720x180, #00FF00 background, looping idle stance, no ball, fps 6, loop true. Use joaquin-angle-2.png as character ref. QC threshold 80/100.
  2. Generate joaquin-walk.png: 8 frames, 1440x180, #00FF00 background, walk cycle no ball, fps 10, loop true. Use joaquin-angle-2.png as ref. QC threshold 80/100.
  3. Apply 160x160-within-180x180 padding fix to all outputs (same as viv-idle, bron-test, z precedent).
  4. Add characters.joaquin.animations.idle and .walk to animation-contract.json.
**Output:** data/assets/joaquin-idle.png (720x180), data/assets/joaquin-walk.png (1440x180)
**Success:** Both at correct dimensions, each >= 80/100 QC; contract entries added; log to results.md
**Status:** DONE — 2026-03-27. joaquin-idle ACCEPTED 100/100 (4f 720x180), joaquin-walk ACCEPTED 100/100 (8f 1440x180). Padding fix applied. characters.joaquin.animations.idle + walk added to animation-contract.json. joaquin is fully playable (5 ACCEPTED animations: dribble+stepback+static-dribble+idle+walk). 5-character roster prototype REACHED. See results.md TASK-6008.

---

### TASK-6009 — QC evaluate character 99 animations

**Owner:** Review
**Priority:** LOW
**Character:** 99
**Problem:** 99-dribble.png (1440x180, 8f) and 99-static-dribble.png (1080x180, 6f) are in animation-contract.json as NEEDS_REVIEW with null qcScore. Assets are on disk but have never been QC evaluated.
**Actions:**
  1. Run QC evaluation on data/assets/99-dribble.png — measure score, check fill, frame count, identity consistency.
  2. Run QC evaluation on data/assets/99-static-dribble.png — same checks.
  3. Update animation-contract.json characters["99"].animations.dribble and .static-dribble with qcScore and qcStatus (ACCEPTED if >= 80/100, CONDITIONAL if 70-79, FAILED if < 70).
  4. Log findings to results.md.
**Output:** animation-contract.json updated with real scores; results.md entry written
**Success:** Both animations have actual qcScore and qcStatus in contract; decision made on each (ACCEPTED, CONDITIONAL, or FAILED + regen note)
**Status:** DONE — 2026-03-27. 99-dribble ACCEPTED 86/100 (8f 1440x180, avgFrame 97, consistency 69 — size variance). 99-static-dribble FAILED 74/100 (6f 1080x180, all frames too_large critical, no padding fix applied). Contract updated. TASK-6010 opened. See results.md TASK-6009.

---

### TASK-6010 — Apply padding fix to 99-static-dribble.png

**Owner:** Animation
**Priority:** LOW
**Character:** 99
**Problem:** 99-static-dribble.png scored 74/100 FAILED (TASK-6009). Root cause: all 6 frames have 98.9-100% fill height — character fills the entire frame with no padding. This is the same issue fixed for z-dribble (UPLOAD-BGX-001), viv-idle (TASK-6005), and joaquin-static-dribble (TASK-6007) with the 160x160-within-180x180 padding fix.
**Actions:**
  1. Load data/assets/99-static-dribble.png (6-frame 1080x180 strip)
  2. Cut into 6 individual 180x180 frames
  3. For each frame: detect content bounding box, scale content to fit within 160x160 (preserving aspect ratio), center in a 180x180 transparent canvas
  4. Reassemble all 6 padded frames into a single 1080x180 horizontal strip
  5. Save output to data/assets/99-static-dribble.png (overwrite)
  6. Run QC evaluation — target >= 80/100
  7. Update animation-contract.json characters["99"].animations.static-dribble with new qcScore and qcStatus
**Output:** data/assets/99-static-dribble.png (1080x180, 6 frames, padded)
**Success:** Strip is 1080x180, QC >= 80/100 ACCEPTED, contract entry updated, log to results.md
**Status:** DONE — 2026-03-27. Padding fix applied. All 6 frames reprocessed (160x160-within-180x180). QC 85/100 ACCEPTED. characters["99"].animations.static-dribble updated in animation-contract.json. See results.md TASK-6010.

---

### TASK-6011 — Generate bron-test-walk.png

**Owner:** Animation
**Priority:** MEDIUM
**Character:** bron-test (portrait: data/assets/bron-testfull.png, angles: bron-test-angle-0 through bron-test-angle-7)
**Rationale:** bron-test is active and playable (idle 84, dribble 85) but missing the walk locomotion piece. All 5 other active characters have walk. This is the remaining gap to full locomotion parity.
**Actions:**
  1. Generate bron-test-walk.png: 8 frames, 1440x180, #00FF00 background, walk cycle no ball, fps 10, loop true. Use bron-test-angle-2.png as character ref. QC threshold 80/100.
  2. Apply 160x160-within-180x180 padding fix (same as all prior precedents).
  3. Add characters.bron-test.animations.walk entry to animation-contract.json.
**Output:** data/assets/bron-test-walk.png (1440x180, 8 frames, padded)
**Success:** Strip is 1440x180, QC >= 80/100 ACCEPTED, contract entry added, log to results.md
**Status:** DONE — 2026-03-27. bron-test-walk.png generated (gemini-2.5-flash-image, 1344x768 raw). QC 96/100 ACCEPTED (8f 1440x180, fill 88.9%). Padding fix applied. characters.bron-test.animations.walk added to animation-contract.json. See results.md TASK-6011.

---

### TASK-6012 — Generate snoop angles then idle+dribble+walk baseline

**Owner:** Animation
**Priority:** MEDIUM
**Character:** snoop (portrait: data/assets/snoopfull.png, 0 angles — must generate all 8 first)
**Rationale:** snoop has 1 ACCEPTED animation (idle 85) but no directional angles. Without angles, multi-animation generation cannot use angle-based refs. Generating angles is the prerequisite for bringing snoop to a full playable character.
**Actions:**
  1. Generate 8 directional angles for snoop using the angle generation endpoint or pipeline. Output: data/assets/snoop-angle-0.png through snoop-angle-7.png (180x180 each, transparent background, 160x160-within-180x180 padding). Use snoopfull.png as portrait ref.
  2. Call POST /api/character/snoop/package/sync-angles to register in .characters.json (or update directly). Confirm snoop.anchor.angles has 8 entries.
  3. Generate snoop-dribble.png: 8 frames, 1440x180, #00FF00 background, running dribble cycle with ball, fps 10, loop true. Use snoop-angle-2.png + any available ball ref as refs. QC threshold 80/100. Apply padding fix.
  4. Generate snoop-walk.png: 8 frames, 1440x180, #00FF00 background, walk cycle no ball, fps 10, loop true. Use snoop-angle-2.png as ref. QC threshold 80/100. Apply padding fix.
  5. Add characters.snoop.animations.dribble and .walk entries to animation-contract.json.
**Output:** data/assets/snoop-angle-0.png through snoop-angle-7.png; data/assets/snoop-dribble.png (1440x180); data/assets/snoop-walk.png (1440x180)
**Success:** All 8 angles on disk; .characters.json snoop.anchor.angles populated; both new animations QC >= 80/100 ACCEPTED; contract entries added; log to results.md
**Dependencies:** None — snoop-idle is already ACCEPTED (85/100) and in contract. Only angles are missing.
**Status:** DONE — 2026-03-27. Part A: 8/8 angles generated (snoop-angle-0 through snoop-angle-7, 180x180 each, padding fix applied). snoop.anchor.angles populated in .characters.json. Part B: snoop-walk ACCEPTED 100/100 (8f 1440x180) added to contract. snoop-dribble CONDITIONAL 74/100 (empty frame issue — NOT added to contract). See results.md TASK-6012.

---

### TASK-6013 — Regenerate snoop-dribble from scratch

**Owner:** Animation
**Priority:** MEDIUM
**Character:** snoop (portrait: data/assets/snoopfull.png, angles: snoop-angle-0.png through snoop-angle-7.png — all 8 available as of TASK-6012)
**Problem:** snoop-dribble.png scored 74/100 CONDITIONAL (TASK-6012). Root cause: empty frame issue — at least 1 frame at 2.8% coverage (avgFrame 56). Likely a Gemini generation artifact where one frame rendered the character very small or near-invisible. The existing snoop-dribble.png is NOT suitable for reuse — regenerate from scratch.
**Actions:**
  1. Regenerate snoop-dribble.png: 8 frames, 1440x180, #00FF00 background, running dribble cycle with ball, fps 10, loop true. Use snoop-angle-2.png as character ref. QC threshold 80/100.
  2. Apply 160x160-within-180x180 padding fix (same as all prior precedents).
  3. Visually inspect output before QC — confirm no empty or near-empty frames before running QC eval.
  4. If QC passes (>= 80/100): add characters.snoop.animations.dribble to animation-contract.json and overwrite data/assets/snoop-dribble.png.
  5. If QC fails again due to empty frame: attempt one more regen with an explicit "every frame must contain a large character" instruction; if still failing after 2 attempts, mark BLOCKED_GENERATION and log to blockers.md.
**Output:** data/assets/snoop-dribble.png (1440x180, 8 frames, padded)
**Success:** Strip is 1440x180, all 8 frames have character fill >= 70%, QC >= 80/100 ACCEPTED, contract entry added, log to results.md
**Status:** DONE — 2026-03-27. ACCEPTED 100/100. snoop-dribble.png 1440x180, 8 frames. Padding fix applied. characters.snoop.animations.dribble added to animation-contract.json. Empty-frame issue from TASK-6012 resolved with explicit full-character-per-frame prompt. See results.md TASK-6013.

---

### TASK-6014 — Generate 99 angles then idle + walk baseline

**Owner:** Animation
**Priority:** MEDIUM
**Character:** 99 (portrait: data/assets/99full.png, 0 angles — must generate all 8 first)
**Rationale:** 99 now has 2 ACCEPTED animations (dribble 86, static-dribble 85). Angle generation unblocks idle + walk. Adding idle + walk makes 99 a fully playable character and brings the roster to 7 playable characters.
**Actions:**
  1. Generate 8 directional angles for 99 using 99full.png as portrait ref. Output: data/assets/99-angle-0.png through 99-angle-7.png (180x180 each, transparent background, 160x160-within-180x180 padding). Use the same angle generation pipeline as snoop (TASK-6012) and z (TASK-2004).
  2. Call POST /api/character/99/package/sync-angles to register in .characters.json (or update directly). Confirm 99.anchor.angles has 8 entries.
  3. Generate 99-idle.png: 4 frames, 720x180, #00FF00 background, looping idle stance, no ball, fps 6, loop true. Use 99-angle-2.png as character ref. QC threshold 80/100. Apply padding fix.
  4. Generate 99-walk.png: 8 frames, 1440x180, #00FF00 background, walk cycle no ball, fps 10, loop true. Use 99-angle-2.png as ref. QC threshold 80/100. Apply padding fix.
  5. Add characters["99"].animations.idle and .walk to animation-contract.json.
**Output:** data/assets/99-angle-0.png through 99-angle-7.png; data/assets/99-idle.png (720x180); data/assets/99-walk.png (1440x180)
**Success:** All 8 angles on disk; .characters.json 99.anchor.angles populated; both animations QC >= 80/100 ACCEPTED; contract entries added; log to results.md
**Dependencies:** None — 99-dribble (86) and 99-static-dribble (85) are already ACCEPTED. Only angles are missing.
**Status:** DONE — 2026-03-27. Part A: 8/8 angles generated (99-angle-0 through 99-angle-7, 180x180 each, padding fix applied). characters["99"].anchor.angles populated, status = "complete". Part B: 99-idle ACCEPTED 100/100 (4f 720x180), 99-walk ACCEPTED 100/100 (8f 1440x180). Both added to animation-contract.json characters["99"].animations. 99 is now fully playable (4 ACCEPTED animations: dribble+static-dribble+idle+walk). 7-character roster REACHED. See results.md TASK-6014.

---

## PHASE 7 — BULK SYSTEM (deferred, not blocking prototype)

### TASK-7001 — Multi-character selection

**Owner:** Integration
**Action:** UI selection system
**Status:** DONE — #bulkPanel in index-v2.html, checkbox list, select-all, animation dropdown, runBulkGenerate()

---

### TASK-7002 — Bulk apply endpoint

**Owner:** Integration
**Route:** POST /api/animation/apply-bulk
**Status:** DONE — POST /api/animation/apply-bulk + GET /:bulkJobId in routes/generation.js

---

### TASK-7003 — Parallel job execution

**Owner:** Integration
**Status:** DONE — runWithConcurrency helper, concurrency param (default 3, max 5) in apply-bulk

---

## ACTIVE DISPATCH SUMMARY (HEAD-DISPATCH-012, closed 2026-03-27)

MILESTONE CLOSED: 7-CHARACTER PLAYABLE ROSTER COMPLETE.
breezy (14) + viv (3) + bron-test (3) + z (4) + joaquin (5) + snoop (3) + 99 (4) = 36 total ACCEPTED animations.
All Phase 6 tasks DONE. Studio demo fully unblocked.

| Task | Owner | Priority | Final Status |
|---|---|---|---|
| TASK-6001 | Animation | HIGH | DONE — viv 3/3 ACCEPTED |
| TASK-6002 | Animation | MEDIUM | DONE — bron-test idle+dribble 100/100 |
| TASK-6003 | Animation | MEDIUM | DONE — breezy-jump 100/100 |
| TASK-6004 | Review | LOW | DONE — joaquin static-dribble REGEN-QUEUED |
| TASK-6005 | Animation | HIGH | DONE — viv-idle 100/100 |
| TASK-6006 | Animation | MEDIUM | DONE — z idle+walk 100/100 |
| TASK-6007 | Animation | LOW | DONE — joaquin static-dribble 100/100 |
| TASK-6008 | Animation | HIGH | DONE — joaquin idle+walk 100/100 |
| TASK-6009 | Review | LOW | DONE — 99 dribble 86 ACCEPTED, static-dribble 74 FAILED |
| TASK-6010 | Animation | LOW | DONE — 99 static-dribble 85/100 ACCEPTED |
| TASK-6011 | Animation | MEDIUM | DONE — bron-test walk 96/100 ACCEPTED |
| TASK-6012 | Animation | MEDIUM | DONE — snoop 8 angles + walk 100/100; dribble CONDITIONAL (regen to TASK-6013) |
| TASK-6013 | Animation | MEDIUM | DONE — snoop-dribble 100/100 ACCEPTED |
| TASK-6014 | Animation | MEDIUM | DONE — 99 angles 8/8 + idle 100/100 + walk 100/100 |
| TASK-0003 | Integration | LOW | DONE — export live test confirmed; 8/8 animations, 1440x1440 spritesheet written to soul-jam |
| TASK-2004 | Animation | HIGH | DONE — z 8/8 angles |
| TASK-7001 | Integration | LOW | TODO — not started (Phase 7, not blocking demo) |
| TASK-7002 | Integration | LOW | TODO — not started (Phase 7) |
| TASK-7003 | Integration | LOW | TODO — not started (Phase 7) |

Animation terminal: CLEAR — no active tasks.
Review terminal: CLEAR — no active tasks.
Integration terminal: CLEAR — TASK-0003 DONE. TASK-7001/7002/7003 TODO when Phase 7 begins.

Next decision point: Phase 7 (bulk system) or additional animations per character. Export pipeline is operational — no blockers remain.

---

## COMPLETION RULE

A task is COMPLETE only if:

* Code is implemented or asset generated
* Output verified at correct dimensions and QC score
* Result logged in coordination/results.md

---

## PHASE 8 — UI / VIDEO PIPELINE

### UI-VIDEO-TAB-001 -- Add Video tab to index-v2.html

**Owner:** UI
**Status:** DONE — 2026-03-28
**What was built:**
- Nav button "Video" added to header
- 3-step page: Upload → Select Frames → Configure & Generate
- Drag/drop video upload → POST /api/video/upload (raw binary)
- Frame extraction at configurable FPS → POST /api/video/extract → thumbnail gallery
- Click-to-select frames + Smart Select (POST /api/video/smart-select) with count input
- Confirm selection → POST /api/video/select-manual → shows selected strip preview
- Config: character dropdown (from roster), anim name, action description, target frames, FPS, loop
- Strip mode: POST /api/video/strip → POST /api/video/generate → result card
- FBF mode: POST /api/video/generate-fbf (SSE) → progress ring + log → result card
- Result shows sprite sheet image + save path
**Files changed:** index-v2.html
**Validation:** UI renders, all API endpoints exist in routes/video.js

---

### UI-DASHBOARD-FIX-001 -- Fix dashboard layout (phantom sidebar column)

**Owner:** UI
**Status:** DONE — 2026-03-28
**What changed:** .app changed from grid (260px 1fr) to flex column — sidebar HTML was removed in a prior commit but grid column remained, forcing main content into 260px slot. Fix: display:flex; flex-direction:column with flex:1 on .main.
**Files changed:** index-v2.html

---

## GLOBAL RULES

* Do NOT skip phases
* Do NOT start blocked tasks
* Always update results.md after completion
* Head assigns — workers execute automatically

---

## SYSTEM GOAL

Fully autonomous pipeline:
Photo → Character → Angles → Animation → Review → Fix → Export
