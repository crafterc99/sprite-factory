# Project: Sprite Factory Core

| Field | Value |
|---|---|
| **Status** | IN_PROGRESS |
| **Last Updated** | 2026-10-02 |
| **Owner** | Claude Code |

## Goal
A full pipeline for generating NBA player sprite sheets using Gemini image generation. Takes reference footage or images, generates animation frames (idle, dribble, crossover, jumpshot, etc.) at multiple angles, and exports production-ready sprite sheets.

## Milestones
- [x] Server with REST API (server.js)
- [x] Studio UI (index-v2.html)
- [x] Character + animation definitions (lib/sprite-generator/prompts.js)
- [x] Nano Banana Pro (Gemini) client (lib/sprite-generator/nano-banana.js)
- [x] Frame-by-frame generation endpoint
- [x] Strip generation (multi-angle reference)
- [x] Pipeline with gap-filling and bulk generation
- [x] Cost tracking
- [x] Evaluation and audit endpoints
- [x] Soul Jam export format
- [x] Smart frame selector (lib/sprite-generator/smart-selector.js)
- [x] Reference strip builder (lib/sprite-generator/strip-builder.js)
- [x] Default model updated to gemini-3-pro-image-preview (Nano Banana Pro)
- [x] Mocap Stage 1: video → SAM 3 + SAM 3D Body (fal) → motion.json → mannequin → any character/angle/hand (/mocap)
- [x] Password-protected studio (APP_PASSWORD)
- [x] 3D animation-set pipeline: game clips (planted feet, root motion, loops, QC), skinned character rigs (any height/proportions), skeletal runtime with blends + foot IK (/court3d), recording guide (/recording)
- [x] 3D court feel: responsive controls (instant stick, blended turns, slide-in stops), nearest-pose matcher for moves/loop entry, run-dribble + crossover clips (procedural + Kimodo import)
- [x] Second practice court: the River waterfront court (the user's painting, `?court=river` / the Court picker; branch river-court)
- [ ] Stable end-to-end generation on Railway (public URL)
- [ ] Full character roster complete (all planned characters with all animations)
- [ ] Production export pipeline validated

## Current State
Core pipeline is functional locally. Generation uses `gemini-3-pro-image-preview` as the default model. Server exports a handler for both local (nodemon) and serverless (Vercel) modes.

Key routes:
- POST /api/generate/strip — generate full animation strip
- POST /api/generate/fbf — frame-by-frame generation
- POST /api/generate/angles — multi-angle generation
- POST /api/pipeline/run — run full pipeline for a character
- POST /api/evaluate/animation — evaluate generated frames
- POST /api/export/soul-jam — export to Soul Jam format

## Next Steps
1. Confirm Railway deployment is stable (see railway-deployment.md)
2. Run a full generation test from the Railway URL
3. Begin filling gaps in the character roster via pipeline

## Blockers
None currently — pending Railway stability.

## Log

| Date | What happened |
|---|---|
| 2026-09-28 | Stage 1 mocap pipeline + /mocap iPad UI (SAM 3 masks, SAM 3D Body skeletons, cleaned reusable motion.json, colour-coded mannequin per game zone, GPT Image 2.5 / Nano Banana generation aligned to the mannequin, canonical composited ball, QC + auto-retry, save to slot); APP_PASSWORD gate; audit fixes: shared strip scale, SAM 3 cutouts |
| 2026-06-12 | Moves panel click-to-edit: inline per-animation settings (game-wide speed, per-variant starting hand re-key); roster cache busts on writes; net-line idle hand verified vs production net |
| 2026-06-12 | Per-animation speed persists game-wide (FPS slider PATCHes all slot variants server-side); net-line hand swap verified in all 5 zones with velocity fallback |
| 2026-06-12 | Parallel L/R saves (hand always in slot key + studio hand picker) and net-relative ball-hand rule (lateral movement vs character→net line switches hands) |
| 2026-06-12 | Ball-hand state machine: L/R variants per move (hand-suffixed keys through video save + studio assign), hand-aware strip selection, auto hand flip on cross/behind/tween, crossover burst removed pending redesign |
| 2026-06-11 | Testing game mode: dribble moves on the right stick (flick) instead of held-R2; jog/dribble/sprint face the left stick's 8-way direction, decoupled from court zone |
| 2026-06-11 | Fixed intermittent pixel/arcade-styled studio frames: "pixelated" wording in default studio prompt, stale pixel-era prompt overrides now ignored, Bulk Generate prompt de-pixeled |
| 2026-06-11 | Studio first-gen keeps native-res frames (was crushing to 180px strip cells); strip fallback crops to content — no more tiny/blurry first-gen sprites |
| 2026-06-11 | Testing scale/speed sliders sync globally via testing-config (R2) — same values on every device |
| 2026-06-11 | Starting-hand toggle on video save + studio settings editor (fps/loop/hand via meta PATCH); ?w= asset thumbnails fix slow dashboard/studio character loading; video boxes restore their save settings for editing |
| 2026-06-11 | Perf: 304 conditional GETs + swr caching (HTML/engine/images), roster + R2-health micro-caches; video thumbs 480px lanczos (blur fix) + max-quality frames; Studio anim reference delete button |
| 2026-06-10 | Video tab: multi-video session boxes (Studio-style) with background extract/cutout, parallel non-blocking processing (async ffmpeg/yt-dlp/curl), localStorage+server state restore with auto-resume |
| 2026-06-10 | Video tab: JPEG+thumbnail extraction (single ffmpeg pass), format-agnostic frame routes, soft-edge de-spilled cutouts at 768x1024 native res (no upscale), 1024px ref strips, sliding cutout pool |
| 2026-06-10 | Prompts tab removed (UI, prompt-lab/prompt-manager/pipeline2 routes, prompt-system engine); generation-facing prompt stores kept (char prompts, frame prompts, angle/ball overrides, training) |
| 2026-06-10 | Testing tab: procedural hoop removed (hoop image upload auto-removes background); animation switches/moves now wait for the current anim's last frame (smooth transitions); movement editor replaced by a simple permanent crossover/stepback Soul Jam applicator; speed slider now drives Game Mode playback |
| 2026-06-09 | Game Mode movement fixed: actions now resolve movement data (saved editor values > presets); added Soul Jam burst physics (linear-decay separation bursts) with stepback/crossover direction applicators; procedural vector hoop replaces image overlay in Testing tab |
| 2026-03-31 | Default model changed to gemini-3-pro-image-preview across all 5 generation endpoints |
| 2026-03-31 | Fixed chalk ESM crash in strip-builder.js and smart-selector.js |
| 2026-03-31 | Vercel deployment added (assets excluded from bundle due to 250MB size limit) |

- 2026-09-28: Mocap fix round 3 — zone apex at hoop stand base, magenta ball-proxy grip (fingers over the ball), per-frame floor snap + smoothed root for travelling moves. Tests 9/9. Railway deploy pending persistent storage.

- 2026-09-28: Step-back jumper from video → zones 1–5 (SAM 3D Body mesh guide, hand close-ups, ball placed from the performer photo, shot release) → playable on the test court: move + hold Square, faces the hoop in every zone, ball flies to the rim. Firebase persistence live.
- 2026-09-28: 3D animation-set pipeline: clip-builder (contacts, foot-anchored root motion, IK pinning, loops, warps, QC flags), character-rig (skinned scan, ankh/big/guard), engine3d/anim3d.mjs runtime (retarget, inertialization, foot planner, world foot locks, blend space, actions), court3d rewritten on it, /mocap game-clip panel, /recording guide. Planted-foot slide 0 cm in sims + headless court.
- 2026-09-28: 3D court feel — instant stick / blended turns / slide-in stop, nearest-pose matcher (variant + mirror + entry frame), generated run-dribble + crossovers, Kimodo NPZ import (fitted SOMA→MHR70 map), POST /api/mocap3d/generate|import|import-kimodo; adversarial review fixes (foot locks, ball state, id canonicalisation, settings rollback, XSS, WebGL1, caching, touch/keyboard). Tests 25/25, headless court PASS.
- 2026-09-28: 3D characters on Meta's MHR body model (the one SAM 3D Body fits): real mesh, 127-joint skeleton with twist joints and skin weights, shaped to the performer; runtime solver for rigid joint rotations (1.8 cm mean mesh error vs SAM 3D Body). Spin → layup take analysed (layup tail pending fal top-up).
- 2026-09-28: Slow-mo cross → jump shot take (timeMap → real time, 8× found from the ball arcs; $5.69), corner source-video box in the 3D court (resizable, V toggles), zoom sized from the measured hands, textured MPFB (CC0) character "Player" on the MHR skeleton as the default. Tests 28/28, headless court PASS.
- 2026-09-28: Player character now wears the performer's outfit (cream hoodie, striped track pants, slides + socks; MakeHuman CC0/CC-BY assets); refit fixes for clothes (no more torn hood / stretched chest). Tests 28/28, headless court PASS.
- 2026-09-28: Realistic player character generated from the performer's own video (A-pose views → Hyper3D Rodin → rigged on their MHR body), replacing the MakeHuman figure; server job POST /api/mocap3d/character/generate. $0.52. Tests 28/28, court PASS 3/3.
- 2026-09-29: Physical basketball — Rapier rigid body (1 m units, 0.62 kg, CCD, 120/240 Hz fixed step) driven by impulses and a clamped PD hand; articulated kinematic body + finger colliders; release/catch planning (bounce + catch match, limb-aware clearance), contact IK, event classifier, debug view + live tuning, 13 lab scenes, two-camera triangulation. Tests 51/51; headless court: dribble, moves, standing crossover, run, stop, shot SWISH (moving crossover still misses the buffer).
- 2026-09-29: Audit of the 3D court requests. Fixed the boot-dribble loss from the new ball coupling (calibrated hold rule restored; SAM 2D contact closes gaps inside holds) and the ball being thrown after a teleport / reset (snapBody). Added the freelancer brief + reference rig (docs/character-brief/) and the import-rigged-character importer. npm test 53/53; court test: shot SWISH.
- 2026-09-30: Soul Jam Capture live at /capture: two-phone synchronised capture for the SAM 3D pipeline, with production durability on Railway (bucket mirror, redeploy-safe) and hardening. The user's Spalding basketball model replaces the procedural ball in the 3D court. docs/capture.md.
- 2026-09-30: Court shots and hands. The user's jump shot now releases at the top of the jump and swishes (arm-extension release, launch clear of the body, make/miss flight hook). Fingers grip the ball and never go through it or flare off it (each hand solved against its own skin).
- 2026-09-30: Soul Jam Capture redesigned after the user's iPad + iPhone test (branch deploy-capture, not deployed): the steps Connect (live pictures, camera check) · Calibrate (a numbered corner walk, saves itself) · Record (START/FINISH, no review, it stops by itself) · Animations (all 82 slots) · Analysis (sent by hand with a cost confirmation, a queue that survives restarts). The iPhone fix: MP4 on WebKit, a ~2 s "not recording" warning, the wake lock and preview kept running. npm test 100/100; e2e 59/59.
- 2026-10-01: Soul Jam Capture redesign finished on deploy-capture (not deployed): review fixes (START/FINISH per hand and distance, honest holds for moving moves, an easy ~21 s calibration walk saved only with both cameras, no paid analysis twice, nothing waits for a camera that never started) and the live iPhone hotfixes carried over (MP4 on every iOS browser, a stuck stop finishes, souljam-capture-v2 storage with a memory fallback, device status). npm test 114/114; e2e 66/66 twice.
- 2026-09-30: Soul Jam Capture (/capture): two-phone capture for the SAM 3D pipeline. Director (phone A = CAM A) + camera B paired by QR/6-digit code; shared session clock; timed start/stop; an audible sync chirp found in both recordings (FFT matched filter); per-frame timestamps. BASIC-01 library of 82 animations with start/end states, ordered by court setup A/B/C. Calibration per setup, and a moved camera marks it suspect. Retakes kept, MARK BEST, CONTINUE MISSING. IndexedDB-first resumable uploads; SAVED ✓ only after the files are stored (and mirrored on Railway). Validators before accept; organised tar export; a native 120/240 fps file path; SAM 3D Body processing behind a processor interface (cost confirmation). LAN HTTPS on :3443. npm test 104/104; two-phone e2e 26/26, three runs in a row. Not deployed to Railway yet. docs/capture.md.
- 2026-09-30: The user's Marvelous Designer crop top (black boxy crop tank, red graphic) is in AC's outfit picker. It is imported from the .zprj by our own CLO .pac reader (clo_pac.py): pattern pieces welded at MD's sewn seams, MD's flat patterns as UVs, and the graphic where MD placed it. It is put on AC as it is: a rigid placement with one uniform scale (1.21), a smooth contact push and a short bind-pose settle, 20 mm mean from the MD shape. It sways as limp fabric like the tee. npm test 107/107; court test ✔ (tests/reports/outfit-court/ac-001-croptop_0_shorts_0-30fps). Branch only, not deployed.
- 2026-09-30: The hands never go inside the ball. The ball was placed for a 1 cm palm, but AC's palm skin is 3–5 cm thick, so it sat 3–4 cm inside his hand. Now the palm targets clear the character's own palm skin, and every tick his LOD0 hand skin is solved against the ball: the palm rests on it, the fingers turn about their anatomical hinges out of it, and the holding hand's fingers curl onto it. Headless AC/player at 30/60 fps: the skin is ≥ 1 mm outside the ball on every tick (at HEAD it was 21–31 mm inside), 3–4 fingertip pads are on the ball in a hold, ≈ 0.5 ms a tick. Court test ✔ (ac-001, 30 fps). Branch only.
- 2026-09-30: A 2K-style shot meter on the 3D court. Hold □ (I / Space / SHOOT): the shot starts, a bar beside the shooter fills with the shot clip and reaches its mark on the clip's own release frame; let go there (±45 ms) for EXCELLENT — a swish. Slightly / plain / very early or late make 62 / 30 / 6 %, misses on their side (front rim, short, airball / back rim, long); a late release bends the ball in the air to its grade. What the court shows (SWISH / MAKE / MISS / AIR BALL) is what the ball did. Outcomes calibrated on Rapier (120 spots, both boards). npm test 157/158 (the known garments timing flake); court test ✔ (ac-001, 30 fps: both shots EXCELLENT → SWISH). Branch only.
- 2026-09-30: Every ball-handling move is on the right stick (2K "pro stick", engine3d/pro-stick.mjs), relative to the player's facing and the ball hand: flick toward the free hand = crossover, forward = hesitation, toward the ball hand = in-and-out, back-diagonals = between the legs / step-back, straight back = behind the back, a ¼ or ½ circle = spin, hold = size-up. Moves without a clip fall back (btb → btl → crossover) or say "no clip yet". R3 switches hand, the D-pad moves the camera, the arrows are the stick on the keyboard, a swipe zone on touch; ?pad=classic keeps the old buttons. New runtime roles move-inout / move-stepback / move-sizeup (+ move-btb). npm test 174/175 (the known garments timing flake); court test ✔ 20/20 (tests/pro-stick-court.spec.js, ac-001 30 fps). Branch only.
- 2026-10-01: The user's double crossover (live on main) is on the pro stick — a crossover flick, then straight back (ball in the right hand: left, then right), key L. Ball contacts are automatic for every clip: the double crossover's own (saved contacts removed) match the hand-made timeline ± 1 frame; the generated crossovers no longer drop the ball at their end. Grip: a hand that meets the ball early takes it, every fingertip flexed / spread onto the ball, two-hand holds on the palms. tests/clip-sweep.test.js runs every clip of the library from both hands every tick (skin, fingertips, joints, body, lost); remaining residuals recorded with ceilings. npm test 179/180 (garments timing under load); pro-stick court 22/22. Branch only.
- 2026-10-01: A door on the test court into a loft you can walk around (branch loft-door). A lit rooftop stair-house with a glowing LOFT sign stands behind the left end of the baseline (both court kinds); ✕ / X / a tap at it fades into the loft (assets/courts/loft.glb: the Cycles lighting baked, 67 MB), the court world hidden and later restored exactly. He keeps the ball — dribbling, every move, a dropped ball comes back; no hoop (□ says so); walls and furniture keep him out; the camera stays in the room; ✕ at the loft's door goes back. Loading: the bytes prefetched when the page is idle, the room decoded and warmed near the door, real progress and Try again on a failure; first entry ~1.3 s, later ~1 s. Served with ranges and an immutable versioned URL. Tests: loft unit + server tests, tests/loft-door.spec.js 33/33 on both court kinds; ball-court spec 10/10. Not deployed.
- 2026-10-01: Move controls engine (branch move-controls, not merged/deployed): every right-stick move has a trigger the user sets — one gesture or a sequence (flick at 45°, hold anywhere / in a direction ≥ X ms, ¼ / ½ circle cw / ccw, let go), relative to the ball hand and mirrored in the left hand. The stick is read every tick and always reads a move (nothing near enough: the nearest one); combos win over single moves (the single plays at once and upgrades, or the combo waits — per combo). Defaults = the old mapping. Saved via /api/mocap3d/controls (disk + bucket, restored after a redeploy); a clip given a new `move-<name>` role appears as a new move; record-a-trigger + live test events for the coming designed UI (window.__controls); a temporary panel on the court (M). Tests: 20 unit + 6 API + 6 court scenarios, the old pro-stick specs unchanged.
- 2026-10-02: A second practice court, the user's overgrown waterfront court at sunset (branch river-court, not merged/deployed): `?court=river` or the new Court picker in the top bar (remembered on the device; VANTHEAH stays the default). The GLB (14.6 MB, Draco/WebP, instanced props) is placed by VANTHEAH's own frame, so its rims sit on the game's hoops and VANTHEAH's hoop physics plays there (boards at this court's faces); its layout's walls, bleachers, rubble, curb and the hoop posts (measured from the model) stop the ball and the player. Look matched against the Cycles replica: the layout's sun with shadows, glow, hemisphere, fog, AgX, an environment captured from the court, the sky repainted from the city picture, wet asphalt + mirror puddles from a planar reflection on desktop (lite: none). The loft door stands in the waterfront corner. 60 fps on an M1 (desktop and the lite path), 157 draw calls. Tests: river unit + server tests, tests/river-court.spec.js 43/43 (EXCELLENT swish through the visible rim, rim / board contacts within 2 mm of the visible hoop, walls, loft round trip, replay, ball lab, touch, picker); ball-court 10/10 and loft-door 33/33 on VANTHEAH unchanged.
