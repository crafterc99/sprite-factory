# Handoffs

## Handoff Template

### FROM-TASK -> TO-TASK
- From owner:
- To owner:
- Artifact:
- Files:
- What is ready:
- What still needs verification:

---

## ANIM-REGEN-SNOOP-IDLE — Regeneration Brief
- Prepared by: animation terminal (2026-03-27)
- Status: READY TO QUEUE — blocked on generation API recovery (BLOCKER-002)

### Failure reason
Prior output (snoop-idle.png, 720x180, 4 frames, 52/100 FAILED): not an idle loop.
Frames were a grab-bag of unrelated poses (standing hold, deep dribble-crouch, arms-overhead jump-shot release, defensive crouch). Character fill below threshold in 3 of 4 frames (65–75%). Not loopable.

### Character
- ID: snoop
- Portrait file: data/assets/snoopfull.png (use as Image 2 character reference)
- Style: 16-bit pixel art, GBA style
- Build: athletic, 6ft 0in / 185 lbs
- Team colors: primary #263e0f (dark green), secondary #aa7942 (tan/gold), accent #000000
- Identifying features: Celtics #7 jersey, blue uniform, goggles/sunglasses — match Image 2 exactly

### Output spec
- Frames: 5 (increased from 4 to allow a cleaner loop arc)
- FPS: 6
- Loop: true
- Frame size: 180x180 px each
- Strip dimensions: 900x180 px total
- Background: solid bright green #00FF00, no green on character
- Character fill: 85–90% of frame height, feet on baseline
- Output path: data/assets/snoop-idle.png

### Motion definition
Animation: looping idle stance, subtle weight-shift and breathing — no ball

Frame breakdown:
(1) neutral upright stance — weight centered, arms relaxed at sides, knees soft, looking forward
(2) slight weight shift right — right shoulder dips minimally, right knee softens slightly, left arm drifts slightly out
(3) back to neutral center — minimal motion, both feet grounded, arms settle
(4) slight weight shift left — left shoulder dips minimally, left knee softens, right arm drifts slightly out
(5) return to center — closing the loop, nearly identical to frame 1 to allow seamless repeat

### Prompt construction
Use TEXT-ONLY mode (no pose reference image — the existing snoop-idle.png is not suitable as a pose ref).

Prompt template:
```
Generate a 5-frame horizontal sprite strip showing a looping idle animation for a basketball player.

CHARACTER: the character shown in Image 1 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions (Celtics-style #7 jersey, blue uniform, goggles/sunglasses, athletic build)

ANIMATION: standing idle, subtle weight shift and breathing — no basketball. The character stands in place with minimal movement. This is a looping animation.

FRAME BREAKDOWN:
(1) neutral upright stance — weight centered, arms relaxed at sides, knees soft
(2) slight weight shift right — right shoulder dips minimally, left arm drifts slightly outward
(3) back to neutral center — arms settle, both feet grounded
(4) slight weight shift left — left shoulder dips minimally, right arm drifts slightly outward
(5) return to center — nearly identical to frame 1, closing the loop

OUTPUT:
- Single horizontal strip, EXACTLY 5 frames, equally-sized, no gaps, no borders
- Characters must be LARGE and fill 85-90% of each frame — not tiny
- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines around the character
- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds
- NO green (#00FF00) on the character itself
- Same character size in every frame, feet on same baseline
- Consistent character identity across ALL 5 frames — same face, outfit, skin tone
```

### QC targets
- Pass threshold: 80/100
- Accept threshold: 88/100
- Key checks: loop coherence (frames 1 and 5 near-identical), character fill 85–90%, no pose discontinuities, consistent identity, no unrelated action poses

---

## ANIM-REGEN-Z-STEPBACK — Regeneration Brief
- Prepared by: animation terminal (2026-03-27)
- Status: READY TO QUEUE — blocked on generation API recovery (BLOCKER-002)

### Failure reason
Prior output (z-stepback.png, 720x180, 4 frames, 18/100 FAILED): character contamination in 3 of 4 frames.
Frame 1: completely wrong character (female player in white uniform). Frame 3: second character partially visible in same cell. Frame 4: rendering artifacts with thin vertical lines, character at ~40% fill. Only frame 2 contained valid Z content.

### Character
- ID: z
- Portrait file: data/assets/zfull.png (use as character reference — Image 1 if using pose transfer, or describe explicitly in text-only mode)
- Style: 16-bit pixel art, GBA style
- Build: athletic, 6ft 0in / 185 lbs
- Team colors: primary #FF4400 (orange-red), secondary #FFFFFF, accent #000000
- Identifying features: black hoodie, grey/white sweatpants, chain necklace, dark sneakers — match portrait exactly
- No angles available — use portrait (zfull.png) as sole character reference

### Output spec
- Frames: 4
- FPS: 8
- Loop: false
- Frame size: 180x180 px each
- Strip dimensions: 720x180 px total
- Background: solid bright green #00FF00, no green on character
- Character fill: 85–90% of frame height, feet on baseline
- Output path: data/assets/z-stepback.png

### Motion definition
Animation: stepback jumper — creating space off the dribble

Frame breakdown:
(1) dribbling approach — character moving forward with ball at knee-to-hip height, weight forward, momentum into defender
(2) hard plant — front foot plants sharply, body still carrying forward momentum, ball gathering to body, braking motion
(3) stepback — rear foot explodes backward creating space, body leaning back and away, ball rising to shooting pocket
(4) shot ready — weight shifted to back foot, ball at chest/shooting position, body upright or slightly fading back, space created

### Prompt construction
Use TEXT-ONLY mode with explicit character description. Do NOT use the existing z-stepback.png as a pose reference — it is contaminated.

If breezy-stepback.png is used as a pose reference (Image 1), append the following character swap override:
- Replace the character with Image 2 (Z) — black hoodie, grey sweatpants, chain, dark sneakers
- Do NOT retain any white uniform, female figure, or any other character from the pose ref
- ONE character only — no secondary figures, no partial figures in any frame

Preferred prompt template (text-only):
```
Generate a 4-frame horizontal sprite strip showing a stepback jumper animation for a basketball player.

CHARACTER: the character shown in Image 1 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions (black hoodie, grey/white sweatpants, chain necklace, dark sneakers, athletic build)

ANIMATION: stepback jumper — creating space off the dribble. Non-looping sequence.

FRAME BREAKDOWN:
(1) dribbling approach — character moving forward with ball at hip height, weight forward
(2) hard plant — front foot plants sharply, ball gathering to body, momentum braking
(3) stepback — rear foot pushes backward creating space, body leaning back, ball rising to shooting pocket
(4) shot ready — weight on back foot, ball at chest/shooting position, space clearly created

CRITICAL — CHARACTER PURITY:
- ONE character per frame — no secondary figures, no partial figures at any frame edge
- Same character identity in ALL 4 frames — same clothing, build, face, chain
- Do NOT mix in any other character from training data

OUTPUT:
- Single horizontal strip, EXACTLY 4 frames, equally-sized, no gaps, no borders
- Characters must be LARGE and fill 85-90% of each frame
- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines around the character
- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds
- NO green (#00FF00) on the character itself
- Same character size in every frame, feet on same baseline
```

### QC targets
- Pass threshold: 75/100
- Accept threshold: 85/100
- Key checks: ONE character only per frame (critical — any contamination = immediate FAIL regardless of score), correct Z identity all 4 frames, no artifacts, stepback motion arc readable, character fill 85–90%
- Zero tolerance: any frame containing a second figure or wrong character = FAILED, do not accept at any score
