# 3D animation set — pipeline, formats, runtime

Phone video (or a generator: procedural, NVIDIA Kimodo) → SAM 3D Body → **game clips** (planted feet, root motion, loops) → **character rigs** (any height/proportions) → the **runtime** (`engine3d/anim3d.mjs`) that blends them on the court (`/court3d`). How to film is in [RECORDING.md](RECORDING.md).

```
video ─/mocap─▶ raw.json (SAM 3D Body per frame) ─motion-builder─▶ world motion
                                                    │ (bad frames dropped, floor snap)
                                                    ▼
                             clip-builder ─▶ game clip (gameclip-v2) ─┐
scan (one mesh frame) ─character-rig─▶ rig (skinned mesh + bones) ───┤
                                                                      ▼
                                  engine3d/anim3d.mjs (Player) ─▶ court3d.html (three.js)
```

## 1. Game clips — `lib/mocap/clip-builder.js`

One camera measures body-relative pose well and absolute travel badly (depth drifts by metres). Clips therefore take travel from the feet:

| Step | What | Why |
|---|---|---|
| contacts | per foot: lowest heel/toe near the floor **and** the grounded point nearly still; hysteresis, min length, gap fill; speed gate adapts to the clip's own noise | planted-foot detection that works on noisy side-filmed clips |
| root | floor point under the hips + facing (hips + shoulders), smoothed; joints re-expressed in **root space** (origin, facing +Z, left = +X) | clips play anywhere, any direction |
| root motion | foot-anchored odometry: a planted foot does not move in the world, so the root moves by minus its motion relative to the body; flight keeps take-off velocity | travel matches the feet, camera depth not trusted |
| pinning | each contact pinned to one floor spot, two-bone IK (fixed leg lengths, soft near full extension), body lowered when out of reach | no slide baked into the clip |
| loops | best window by seam acceleration (pose + velocity continuity), contact and ball phase; dribble loops must hold a whole ball cycle; seam error spread across the cycle | seamless loops |
| warps | intended displacement over a frame window, put on airborne/swing frames only | travel the camera cannot see (a step-back filmed toward the lens) |
| QC flags | plain-language warnings: low fps, depth travel, noisy feet, no contacts, slide, loop seam, no start hold | tells you how to re-record |

**Format `gameclip-v2`** (JSON, arrays base64 Float32):

| Field | Content |
|---|---|
| `fps, frameCount, type ('loop'\|'action'), role` | |
| `joints` | F × 70 × 3 MHR70 keypoints, root space, metres |
| `rootMotion` | F × 3: dx, dz (root frame of frame i), dyaw to the next frame |
| `contacts.{left,right}` | `on` 0/1 and smooth `weight` per frame |
| `markers.{leftPlant,rightPlant}` | foot-plant frames (gait phase sync) |
| `ball[i]` | `{ p (root space), held, hand, off (held: offset from the palm) }` |
| `shot` | `releaseFrame, lastHeldFrame, stepFrame, hand, point` |
| `entry` | `{min, max}` — an action may start anywhere in this window |
| `loop` | `{from, to, poseErrCm}` |
| `stats` | `speed` (m/s), `speedHipsPerS`, `hipHeight`, `dirDeg` (0 fwd, +90 left), `turnDegPerS`, `durationS` |
| `boneLen, parent` | per-joint bone lengths along `skeleton.PARENT` (retargeting) |
| `quality` | slide before/after (cm), noise, drift removed, pelvis drop, warps, `flags` |

Served by `lib/mocap/game-clips.js`: built on demand, cached in memory, on disk and in the cloud (`gameclip-v2.json.gz`). Game settings per motion live in `meta.game` (`role, type, trimStart, trimEnd, warp, entryMax, mirror, notes`) — set in **/mocap → 3D game clip**.

## 2. Roles — `lib/mocap/game-roles.js`

`idle` (hub loop, required) · `loco-fwd / loco-back / loco-left / loco-right / loco-sprint` (loops, used as a direction blend space) · `shot-stepback / shot-jumper` · moves on the **right stick** (pro stick, `engine3d/pro-stick.mjs`; flicks relative to his facing and the ball hand): `move-crossover` (toward the free hand) / `move-double-cross` (a crossover flick, then straight back within 0.5 s — ball in the right hand: left, then right; keyboard L) / `move-spin` (¼ or ½ circle) / `move-hesi` (forward) / `move-btl` (back-diagonal, free side) / `move-btb` (straight back) / `move-inout` (toward the ball hand) / `move-stepback` (back-diagonal, ball side) / `move-sizeup` (hold). A move with no clip falls back (behind the back → between the legs → crossover → the crossover dribble) or shows "no clip yet". `?pad=classic` keeps the face buttons (○ crossover, △ spin, ✕ hesi, R1 between the legs). Not played yet: `start-fwd, stop, layup`. Loops use one take per role; moves and shots keep up to 4 takes per role (assigned first, then newest) and the pose matcher picks between them. Unassigned motions get a guess from the naming convention (`<family>-<action>-…`).

## 3. Character rigs

**MHR rigs (v4, default)** — `lib/mocap/mhr-rigs/*.json.gz`, baked by `scripts/mhr/bake_rig.py` (see its README). The body model SAM 3D Body fits (Meta's MHR, Apache-2.0): its own mesh, a 127-joint skeleton (clavicles, 4 spine joints, 4–5 twist joints along every limb, full hands) and artist skin weights (≤ 4 per vertex), shaped to the performer (median MHR shape + bone scales of the take). Every analysed frame now also stores SAM 3D Body's MHR output (`rec.mhr`: per-joint rotations, joint positions, shape) — same call, same price.

`engine3d/mhr-skin.mjs` poses it from the runtime's keypoints each frame: pelvis / chest / head frames from hips, shoulders, ears + nose; limbs from their bend plane (the hand's or foot's frame when straight); limb twist spread over the twist joints with MHR's own ratios (upper arm / thigh 0 → 100 %, forearm / shin 20–80 %); fingers aimed along their keypoints. Skinning matrices are rigid (`[Q | p − Q·b]`, no scale or shear), so volume is kept and skin does not fold. Checked against SAM 3D Body's own posed body on a spin take: mean vertex error 1.8 cm (test: `tests/anim3d.test.js`, fixture `tests/fixtures/mhr-frames.json`).

Why the older scan rigs looked mangled: one frame per bone built from noisy keypoints (thigh twist taken from the foot direction), only 2 influences per vertex, no clavicle or twist joints, and a bind pose taken from a video frame. They remain available with `/court3d?legacy=1` for comparison.

**Capture layer (recorded clips play as filmed).** The cleanup (`motion-builder`) and clip builder carry SAM 3D Body's own per-frame joint rotations through every step the keypoints take (levelled, faced forward, gaps slerped, smoothed on quaternions, root space) into the game clip (`rots`: F × 127 Int16 quaternions, plus `srcFrames` and `viewDirRoot`). The runtime reports what it plays (`result().rotSrc`: clip, time, weight); the court poses arms, forearm twist, hands, fingers and head with the capture's rotations relative to the chest (so runtime lean, turns and root motion stay), and pelvis / spine / legs with the solver (foot locks and IK). Mirrored clips use the partner joint's rotation reflected across the midplane; the layer fades in over ~0.1 s whenever the clip changes. A held ball rides the character's own captured hand (per-frame ball offset in the captured wrist frame). `/court3d?capture=0` turns it off.

**Ball path**: the ball's 2D position in every frame is an exact ray from the camera (camera centre tracked through levelling, facing and floor snap). Between two touches the path is fitted as gravity arcs through one floor bounce (or one arc hand-to-hand): for each bounce time the bounce spot is a 2-unknown least squares against all rays; the best time wins (`report.ballFit`: rms distance to the rays). A held ball sits on its ray nearest the palm. The fitted path goes where the video shows it — between the legs, behind the body.

**Replay vs video**: `/court3d?replay=<motionId>` plays a recorded clip exactly as the game has it, from the filming camera's angle, next to the source frame (play / pause, frame step, ¼ speed, capture on/off).

**Source video box**: in normal play a resizable box in the top-right corner shows the recorded frame of the move that is playing (enlarge ⤢, hide ×, `V` toggles; size and state are remembered).

**Slow-motion recordings**: set the clip's `timeMap` game setting, e.g. `{ "segments": [{ "from": 0, "to": 163, "slow": 8 }], "fps": 30 }` (source frame range filmed at 8× slow motion). The cleanup resamples poses, ball, camera rays and captured rotations onto real time at `fps`, so the move plays at real speed. The slowdown is found from the ball: the gravity-arc fit residuals are smallest at the true speed (IMG_7870: 8× → rms 1.4–2.3 cm; 4× → 2–4.4 cm).

**Textured character (`player`) — generated from the performer's video.** `lib/mocap/mhr-rigs/player.json.gz` + `player-tex/`. Pipeline:
1. `POST /api/mocap3d/character/generate { motionId, frames, outfit?, viewsOnly? }` (server, `lib/mocap/character-gen.js`): crops of the performer from analysed source frames → a full-body A-pose front view of that exact person (same face, hair, build, clothes), then the back view (GPT Image 2.5 / Nano Banana) → fal Hyper3D Rodin v2.5 (`TAPose`, de-lit PBR, 50K triangles) → GLB + textures. `viewsOnly: true` stops after the views (check them first, ~$0.12); `views: { front, back }` (data URIs) builds the model from approved views (~$0.40). `GET /api/mocap3d/character/job/:id[/file/:name]`.
2. `scripts/mhr/glb_export.py model.glb out/` (Blender Python): positions, UVs, triangles, base-colour + normal textures.
3. `scripts/mhr/bake_rig.py raw.json --out base.json.gz --height 1.83`: the performer's MHR body (shape + bone scales from the take).
4. `scripts/mhr/fit_generated.py out/ base.json.gz player.json.gz /chars/player/ --raw raw.json`: MHR's pose fitted to the mesh (two-way chamfer + pose prior; ~1.2–1.7 cm), skin weights from the fitted MHR surface (normal-aware nearest points, smoothed over the surface; no vertex driven by both an arm and a leg), the skeleton bound in the fitted pose (`bindPos` / `bindRot` / `restJoints` / bone lengths re-derived) so the mesh is used exactly as generated.
Textures are served from `/chars/<char>/<file>.webp`. (The earlier MakeHuman/MPFB route, `scripts/mpfb/`, remains for stock characters.)

### Scan rigs (v3, legacy) — `lib/mocap/character-rig.js`

One scan frame (the one with the limbs clearest of the body) is bound with the mesh guide's surface skinning: every vertex follows two of 47 bone segments. That is exactly linear-blend skinning:

`v = Σ w · M_seg(pose) · M_seg(rest)⁻¹ · v_rest`, with `M_seg = [u·L | v | w | a]` built from joint positions (`segMatrices` in the runtime = `segFrame` in `mesh-guide.js`; tested to 0.2 mm).

Presets: `ankh` 6'0", `big` 6'11" (legs ×1.07, arms ×1.08), `guard` 5'9". A preset = a scan + a height + bone-group multipliers + an outfit palette. Add one to `CHARACTERS`; any motion with a 3D body mesh can be the scan (`/api/mocap3d/rig/<id>?motion=<motionId>&frame=<file>`).

**Format `rig v3`**: `verts` (Float32 rest positions), `faces` (Uint16/32), `skin` (Uint8 × 2 segment ids), `weight` (Uint8 first-segment weight), `colors` (RGB), `restJoints` (70 × 3), `boneLen`, `parent`, `legLen`, `soleOffset` (sole below the heel/toe keypoints).

## 4. Runtime — `engine3d/anim3d.mjs`

No renderer inside; `court3d.html` draws. Runs in Node too (`tests/anim3d.test.js` measures world foot slide).

```js
import * as A from '/js/anim3d.mjs';
const rig = A.prepareRig(rigJson);
const lib = A.buildLibrary([idleClip, stepbackClip, ...], rig); // role → clip (+ mirrored copies)
const player = new A.Player(rig, lib, { x, z, yaw });
// every frame
const r = player.update(dt, { move: [x, z] /* world dir × 0..1 */, sprint, face: [hoopX, hoopZ], trigger: 'shot-stepback' | null });
A.boneMatrices(r.pose, rig.restInv, boneMats);       // 47 × mat4 for GPU skinning
// r.ball = [x,y,z] | null · r.events: plant / lift / action / release / actionEnd / missing
```

Per frame:
1. **Base pose** in capsule space: idle loop + procedural feet, or recorded loops (direction blend, phase-synced on foot plants, playback = speed / clip speed, orientation-warped legs), or an action (root motion, best-matching entry frame, shots warped to release square to the target).
2. **Retarget**: clip directions × rig bone lengths; root motion and pelvis scale with leg length.
3. **Inertialization** on every source switch (offset + velocity, spring half-life ≈ 0.09 s).
4. **Feet**: stance feet locked in the world (planner or clip contacts), toe-off heel lift, body lowered only if still out of reach, two-bone IK (soft near extension).
5. **Skinning** matrices.

The **foot planner** (used for movement until loco loops are recorded): predictive landing spots from the velocity (re-aimed every frame), reach-limited leads, running stance narrows with speed, quicker shuffle cadence sideways, slides/backpedals slower than forward, early steps before a foot leaves the leg's reach, corrective steps after turns and moves. Planted-foot world slide measured 0.00 cm in all directions at 12 and 60 fps.

**Controls** (standard game-feel techniques, no GPU):

| | How | Measured (60 fps sim) |
|---|---|---|
| instant response | "moving" starts from the stick, not the velocity; asymmetric velocity springs: push `accelHalflife 0.05`, reverse `reverseHalflife 0.08`, release `stopHalflife 0.09` | first step 0 ms, half speed 50 ms, direction reversal 83 ms |
| blended turns | facing blends hoop ↔ travel while running (`runFacingSpeed`), heavier spring while running (`runTurnHalflife 0.12`), ≤ `maxTurnRate 11` rad/s; upper body leads, banking lean; a foot turns ≤ 75° per step | faces the run (0.02 rad), back to the hoop 0.55 s after letting go |
| slide-in stop | stop state: braking crouch; from a run (> `skidSpeed 3.3`) the braking foot skids (`skidFactor 0.45`, `skidTime 0.16` s) | 0.38 m from a jog, 0.61 m + skid from a sprint; planted slide 0 cm |
| moves | momentum carried in (only what the clip's own root motion lacks) and out (exit at the move's speed); the stick cancels a move after `moveCancel 0.72` of it; a new move in that window chains | |
| pro stick (moves on the right stick) | `engine3d/pro-stick.mjs`: a flick fires on the return (out past 0.65 within 180 ms, back within 420 ms), a hold after 220 ms at the rim, a spin after ≥ 75° along the rim inside 500 ms; one gesture per push, 150 ms apart (a full flick straight back excepted); a spring-back or a jump through the centre is never a gesture, a stick swung straight across is two flicks. A crossover flick, then a flick straight back within 0.5 s while the ball is still in that hand = the double crossover (main's "flick left, then right"; keyboard ← then → quickly, or L). The stick is read on the screen (like the left stick), then in his frame: θ 0 forward, +90 toward the free hand. Arrows = the stick on the keyboard; a swipe zone on touch. R3 switch hand, D-pad camera, View camera mode | a newer stick request replaces its queued one |

**Nearest-pose matcher**: each candidate frame is a 19-number feature vector in root space (both feet position + height, pelvis height, both wrists, body velocity, foot contacts, ball hand), weighted. On a trigger every candidate — all variants of the role, their mirrors, every frame of each entry window, only those starting in the ball hand — is scored against the current pose; the lowest cost wins (`events: {type:'action', clip, mirror, entry, cost, variants}`). The same match picks the entry phase when recorded loops take over. Debug overlay (F) shows the last pick.

Tuning (`DEFAULT_OPTS`): `jogSpeed 3.1`, `sprintSpeed 5.0` m/s (at 0.86 m legs; scale with the rig), the control half-lives above, `turnHalflife 0.07`, `blendHalflife 0.09`, `moveBlendHalflife 0.06`, `unlockRadius 0.3`.

**Porting** (Godot/Unity/Unreal): the clip + rig JSON are engine-neutral; port `anim3d.mjs` (≈1.2k lines, no dependencies) or call it from a JS runtime, and feed the 47 bone matrices to the engine's skinned mesh (bind matrix identity, bone inverses = `rig.restInv`).

## 5. Generated and Kimodo clips

Motions that were not filmed are stored like analysed ones (`raw.json` holds `worldFrames` + `balls` directly) and get roles, variants and QC the same way.

- **Procedural** (`lib/mocap/motion-gen.js`): `runDribble` — a 4.25 m/s run with a flight phase, one dribble per stride, whole-cycle loop (role `loco-sprint`); `crossover` standing / on the move — the ball crosses in front of the body on the plant, entry window before the cross (role `move-crossover`). IK arms, synthesized ball.
- **NVIDIA Kimodo** (text → motion, e.g. the hosted Space `nvidia/Kimodo`; export **NPZ**): SOMA 77 (or 30) joints, 30 fps, metres, y-up, +Z forward. `lib/mocap/kimodo.js` maps SOMA → MHR70 with a fitted keypoint map (`kimodo-mhr70.json`: every keypoint = weighted joints + offsets in their bone frames, fitted to Kimodo's skinned mesh; < 2 mm with the exported `global_rot_mats`, ~0.5 cm from positions only). Kimodo animates the body well but not ball handling (its crossovers never cross the ball, its jog is ~2 m/s), so `arms=dribble` scripts one dribble per stride synced to its foot plants and `arms=crossover` crosses the ball at the sharpest cut.

## 6. API

| Route | |
|---|---|
| `GET /api/mocap3d/library` | motions + game settings + current build quality, the court's clip per role, roles, characters |
| `GET /api/mocap3d/clip/:id` | built game clip (gz JSON, ETag) |
| `PUT /api/mocap3d/clip/:id` | save game settings → rebuilt summary |
| `POST /api/mocap3d/clip/:id/build` | force a rebuild |
| `GET /api/mocap3d/rig/:char` | rig (gz JSON, ETag): the MHR rig; `?legacy=1` (or `?motion&frame`) for a scan rig |
| `GET /js/mhr-skin.mjs` | MHR skeleton solver + skinning matrices |
| `POST /api/mocap3d/generate` | `{ kind: run-dribble \| crossover \| crossover-moving, hand, speed }` → new motion |
| `POST /api/mocap3d/import` | `{ name, role, type, fps, skeleton: mhr70 \| soma \| <named>, jointNames?, frames, upAxis, units, balls?, hand?, entryMax? }` → new motion |
| `POST /api/mocap3d/import-kimodo` | raw `.npz` body, `?name&role&arms=dribble\|crossover\|none&hand&prompt&type` (≤ 30 MB) → new motion |
| `GET /js/anim3d.mjs` | the runtime module (revalidated on every load, like the page) |
| `/court3d` · `/recording` | sandbox · recording guide (`/court3d?focus=<motionId>&char=big`) |

## 7. Basketball physics — `engine3d/basketball-physics.mjs`

The ball is a **Rapier** rigid body (`@dimforge/rapier3d-compat`, served at `/vendor/rapier.mjs`) and Rapier is authoritative: the mesh follows the body, interpolated between physics states. Nothing sets the ball's position during play; the only placements are at setup (a new possession, the test scenes). **1 unit = 1 m**, the ball is 0.12 m / 0.62 kg (a thin shell, I = ⅔mR²), all values are in `BALL_DEFAULTS` and can be tuned live (`setConfig`).

**Order of authority per frame:** video intent → animated body → video ball as a soft target → physics → contact IK → render.

- **Step:** fixed 120 Hz with an accumulator, 240 Hz while the ball moves > 3 cm per step, ≤ 24 substeps. CCD and soft CCD are on the ball; collision and contact-force events are drained every step. A slow render frame runs as several ≤ 1/30 s game ticks (animation, hands and ball together).
- **Body:** articulated kinematic colliders built from the skinned bone matrices every frame: head, chest and pelvis boxes, upper arms, forearms, palms, 15 finger capsules per hand, thighs, shins and feet. They are moved with `setNextKinematic*`, so a moving limb pushes the ball with its real velocity. Anything faster than 12 m/s in one step is an animation pop and is repositioned rather than swept. Fingers are solid only on the controlling hand, and a releasing hand's fingers open. The court, rim (24 capsules), backboard and stanchion are static colliders.
- **State machine** (`BALL_STATES`): FREE, AIRBORNE, HAND_APPROACH, HAND_CONTACT, HAND_RELEASE, FLOOR_CONTACT, BOUNCE_RISING, POSSESSION_CONTROL, plus BODY_CONTACT and LOOSE.
- **Hand control:** a clamped PD force (kp/kd, ≤ `maxHandForce`) pulls the ball onto the palm surface, i.e. palm + normal × (R + palm thickness). It adds gravity compensation and palm-acceleration feed-forward. Holds and gathers get `holdGain`, and two palms on the ball share it. The target is projected out of the torso, legs and arms.
- **Release** (a dribble is impulses, not a loop), in this order:
  1. The push blends the video's release velocity with the pushing hand's velocity (`handInfluence`, `pressureGain`).
  2. The hand's tangential motion becomes a friction impulse at the contact point: top, back or side spin, with linear velocity kept exact.
  3. `bounceMatch` sets the downward speed so the real restitution brings the ball back up to the catch height on time.
  4. `catchMatch` aims the bounce horizontally at where the catching hand will be. It models floor friction (v′ = v − (v + ω×r)·k/(1+k)) and uses the body's predicted motion and lean.
  5. `planRelease` flies the ball against the moving limbs and picks the smallest change that keeps `planMargin` clearance and still reaches the catch. If nothing does, the release is logged as an `invalidPath` warning.
- **Release guards:** a hand can release only a ball it is touching. A hand that just let go cannot touch it again for `regrabTime`. A late touch (up to `lateCatchTime` after the video released) still catches, then pushes. A ball squeezed between the hand and the body is limited to `pinchMaxVel` relative to the hand.
- **Video as a soft target:** during flight a weak steering force (≤ `videoMaxForce`) pulls toward the video ball. The video never places it.
  - **Single camera:** `repairClipBall` moves recorded free paths out of the body along the camera's depth axis, the least certain one (`engine3d/ball-setup.mjs` does this per clip on the character at load).
  - **Invalid clips:** clips whose synthetic flight would pass > 3 cm into a leg are flagged `ballInvalid` and dropped when a valid variant of the role exists.
  - **Two cameras:** `lib/mocap/ball-triangulate.js` (DLT with reprojection error) is ready for synced, calibrated views.
- **Contact IK** (`engine3d/contact-ik.mjs`, runs on the MHR skinning matrices): two-bone arm reach (≤ `ikMax`; ≤ `ikCatchMax` when a catch would otherwise be missed, ramped in), palm aim, fingers conformed to the ball surface by bisection, and a bounded leg yield (≤ `legYieldMax`) when a ball passes between the legs. The IK moves the hands and legs, never the ball.
- **Classifier** (`classifyBallEvents` in the runtime): RIGHT/LEFT_HAND_DRIBBLE, CROSSOVER, BETWEEN_LEGS, BEHIND_BACK, GATHER, HOLD, PASS, SHOT, BALL_FREE.
- **Look-ahead** (`Player.ballIntent`): the intent says whether the ball is held, by which hand, when the next release and catch are, the video target and its velocity, and the catch point. Future points are predicted:
  - with the locomotion spring (speed, facing, lean) in locomotion;
  - with the clip's own pose and root motion during a move.
- **Debug and tuning** (court: the **Ball** button or `B`; `?balldbg=1`):
  - Draws the colliders, contact points and normals, velocity and spin, the video target and its error, and penetration warnings, with physics Hz.
  - Every `BALL_DEFAULTS` value can be tuned live and is saved per browser.
  - Test scenes run at `?balltest=<scene>`: dribble-right/left, pound, low, cross-rl/lr, btl, btl-narrow, btb, moving, gather, drop, drop-spin.
- **Tests:** `tests/basketball-physics.test.js` runs every scene headless and asserts:
  - no penetration, a separation on every dribble, a bounce each time, catches by the right hand and video error;
  - COR, spin, BTL through the gap and BTB behind the pelvis;
  - the fixed rate, ballistic and catch aiming, live tuning, IK, single-camera repair and triangulation.

  `scripts/court3d-test.js` also writes `ball-log.txt`, a state timeline.

**Known limits:**
- Very fast source switches (the procedural idle → a recorded jog or sprint loop in its first half second) can still make a catch miss.
- The Kimodo "Crossover cut" clip is a 0.17 s cross with a bounce and its path clips this character's leg. It usually loses the ball at the end of the move (the rebounder passes it back).
- The generated crossovers are flagged invalid for this body.
- At 20–30 fps an occasional swinging foot can still kick the ball.
- The replay view shows the recorded ball track (the video reference), not physics.

## 8. Practice court — VANTHEAH Sunset rooftop (`engine3d/court-vantheah.mjs`)

The 3D court's default environment is the VANTHEAH Sunset Practice Court pack. `?court=classic` brings back the old procedural half court.

- **Asset:** `assets/courts/vantheah.glb`, served gzipped at `/courts/vantheah.glb` (2.4 MB on the wire).
  - It's the pack's GLB with its PNG textures re-encoded as WebP (`scripts/court-webp.js`, `EXT_texture_webp`); the geometry is unchanged.
  - Size: 14.7 → 6.5 MB.
  - Contents: 98 meshes, 183k triangles, FIBA 28 × 15 m, rims 3.05 m.
- **Placement:** the game plays at a hoop on the origin with the court along +Z. The court is turned −90° about Y and moved +12.425 m:
  - glb (x, y, z) → game (−z, y, x + 12.425);
  - the West basket sits exactly on the game's hoop and the East one at z = 24.85;
  - the playable court is x ±7.5 and z from −1.575 to 26.425, and the player is kept 0.4 m inside it.
- **Look:** as the pack's loader specifies:
  - its own sun (the shadow caster) and floodlights, plus a hemisphere fill;
  - a captured PMREM environment, with the floor and character left out of the capture;
  - a live planar wet reflection on desktop and the static environment only on mobile or `?lite=1`;
  - ACES tone mapping at exposure 1.1.

  The classic lights and fog are removed. Three.js r160 addons are self-hosted at `/vendor/three-addons/`.
- **Collision** (Rapier, `addVantheahColliders`), 84 colliders:
  - both hoops: open 32-capsule rims (tube 0.0095 m) and the backboards;
  - the padded bases, fences and retaining walls from the pack's dimensions;
  - the hoop supports and mounts, bleachers, benches, ball rack and duffel from their measured bounds.

  The floor is the physics plane at y = 0. Sky, city, banners, nets, foliage and the decorative balls have no collision.
- **Checks:** `scripts/court-vantheah-check.js` tests the court in the game: player scale and foot contact, dribble height, the ball thrown at the rim and at the board, a shot, walking the full court to the East baseline, and the bounds clamp. It is state-driven, so it runs under software WebGL at ~1 fps.

### 8b. The loft behind the court's door (`engine3d/loft.mjs`)

- **The door:** a small rooftop stair-house behind the left end of the West baseline (both court kinds, x = −5.2), its lit door and glowing LOFT sign facing the court — seen from the start, past the hoop. It has no real lights (two more lights would cost every lit pixel of the court): the lamp's wash is painted (an emissive door, additive glows on the wall and floor). The 2K camera is pulled in front of the house, never through it.
- **Prompt and input:** within 1.5 m, "✕ Enter the loft" (a button on touch). ✕ (pad button 0), X or a tap on the prompt goes through the door and does nothing else (no new ball, no classic hesitation). Not offered during a shot (held, playing or in the air), a replay or the ball lab. At the loft's exit (layout `exit`) the same prompt reads "Back to the court".
- **Assets:** `assets/courts/loft.glb` (Draco meshes, JPEG / WebP textures; `vendor/three-addons/DRACOLoader.js` + `vendor/draco/`) and `assets/courts/loft-layout.json` (bounds, furniture colliders, spawn, exit, camera box, lights, background).
  - `/courts/loft-layout.json` (no-cache) adds the GLB's version; `/courts/loft.glb?v=<version>` is streamed from disk (ETag / 304, byte ranges, HEAD, never gzipped) and cached for good under that version.
  - Preloaded once the court is up and the player is within 8 m of the door, or 5 s after the page settled (court and clips loaded). ✕ before it is ready shows the progress (MB, %); a failed load shows the error and **Try again**, and the court is never touched. Kept for later entries.
- **The swap:** a 0.35 s fade; at black every visible court object is hidden (and restored exactly on the way out, with the background, fog, environment, tone mapping and camera range), the room is added with the layout's lights, the player is placed at the spawn with a new possession. Once the room is loaded its textures go onto the GPU a few per frame (~6 ms) while he is still on the court; the first entry captures the room's environment (PMREM; "Opening the loft…" at black, ~0.5–1 s) and releases the decoded textures (≈ 1.1 GB) once they are on the GPU.
- **Where:** the room stands at `LOFT_ORIGIN` (26, 0, 12) in the game world: on the physics floor and clear of every court collider. Its walls and furniture are static colliders for a loose ball.
- **Walking:** inside `bounds`, the capsule (0.3 m) pushed out of every collider (closest point: slides along sides, rounds corners, no jitter; a gap narrower than the capsule keeps the last spot). He faces where he walks (the hoop on the court).
- **Camera:** behind him, its heading following his facing only as far as he heads away from the camera (no circling); kept inside the layout's camera box and pulled in front of walls, the mezzanine and dense furniture (ray tests).
- **Look:** AgX tone mapping at the layout's exposure (1.27: the render's AgX Punchy at +0.35 EV) and its grade `contrast(1.08) saturate(1.18)` (`layout.baked.canvasFilter`), computed at the end of three's AgX function in sRGB space exactly as the CSS filter would (≤ 0.4 / 255 mean difference) — no extra compositor pass, the HUD untouched, the court (ACES) untouched. `?loftlook=base` plain AgX; `?loftlook=punchy` Blender's Punchy CDL in AgX log space (measured too saturated / dark against the render). A gradient sky dome (`water` at the horizon → `background` overhead) behind the city backdrop. Coats are kept satin (≥ 0.22 roughness: the captured environment has no parallax). A Fresnel-weighted planar reflection on the floor (desktop): on when the floor is baked (unlit: the room's second draw is cheap — an M1 182 → 93 fps uncapped — and the baked floor has no other gloss), else only with `?loftmirror=1` (lit materials: 60 → 37 fps); `?loftmirror=0` off. Baked materials become unlit `MeshBasicMaterial`: `extras.lm_scale` (the baked lighting in the emissive map, UV 1 → the light map, × lm_scale · π) and `extras.vc_scale` (the lighting in the vertex colours → vertex colours on, the colour × vc_scale); the scene lights then only light the player and the ball. Materials with neither (real emissives) stay as they are. A soft blob under the player and the ball.
- **No hoop:** □ only shows "No hoop in here — head back to the court"; no meter, no shot clip, the ball stays in play.
- **Lite devices:** textures drawn down to 1024 px (data maps 512; `?loftq=full` keeps them), a 1024 shadow map, never the floor reflection.
- **Checks:** `tests/loft.test.js` (layout, walking, camera box, lightmaps, the download), `tests/loft-server.test.js` (routes, caching, ranges, open paths), `tests/loft-door.spec.js` (the whole walk on the real court: a forced HTTP 500 first, then in, walls, sofa, □, moves, a dropped ball, out, in again from cache; screenshots in `tests/reports/loft-door/`). `?loft=0` removes the door, `?loftpreload=0` the preload.

## 9. Keeping possession, playing without the ball, video ball ↔ hand

- **Dribble layer** (`Player.dribbleLayer`): while the player has the ball, both arms and the ball follow one dribble cycle, the idle dribble on the same clock as procedural locomotion.
  - They're aligned to the blended torso and pushed ahead with speed.
  - The legs blend freely between locomotion loops.
  - Losses came from blended loops changing the dribble's timing mid-flight; a new locomotion clip now needs no matching ball timing.
  - The corner video box still shows the locomotion clip (`result.videoSrc`).
- **Possession assist** (`BasketballPhysicsSystem.assistForce`): undefended, the ball tracks the animation's own ball path (already a physical dribble) with a bounded PD force.
  - The force is capped at 5 g, never lifts more than half the ball's weight, and its target clears where the legs will be.
  - Contacts stay Rapier's.
  - Set `defended = true` (future defense) to turn it off. `possessionAssist` 0…1 is a live tunable.
- **Measured** (offline, real rig, % of frames within 30 cm of the animation's ball):
  - walking in 6 directions: 100 %;
  - W/A/S/D with stops: 97–100 % at 60 and 30 fps;
  - sprints: 75–96 %, no possession lost.
- **Without the ball:**
  - The empty-hands layer swings the arms opposite to the legs.
  - A lost ball stays on the court: walk onto it to pick it up, or press **X** / **✕** (or tap on touch) for a new ball in the dribbling hand.
  - Shots are still rebounded.
- **Spin:** every dribble push adds fingertip backspin (`dribbleSpin` ≈ 2 rev/s, ±35 %, tilted axis) on top of the hand-friction spin.
- **Video ball ↔ hand** (`motion-builder` step 8). SAM 3 segments the ball in every frame (a circle: centre and radius). A frame is held when:
  - a hand keypoint (wrist or any finger joint) lies on or over that circle in the image, where both are exact;
  - and 3D confirms it (< 0.4 m).

  A frame is held when the ball is within 24 cm of the nearest palm in 3D. A 2D SAM contact on that same hand also closes a gap inside a hold (up to 40 cm of depth error, only with held frames on both sides within 3 frames). That way a release or catch keeps its measured frame, and a shot never releases late. The held ball sits radius + 3 cm from the palm centre, toward the point of its camera ray nearest the palm (the runtime's palm contact). Holds of 9+ frames are smoothed in the hand's own frame; shorter holds are pushes, so their measured path is the release. Frames carry `ball.hand`. `BUILDER_REV cb-2026-09-29h` rebuilds the clips. (A ray–palm-plane placement at R + 1.4 cm was tried and removed: it moved release and catch points 8–9 cm toward the body, so the idle dribble's flight ran into the leg and the ball was lost at every boot.)
- **Teleport / new possession:** `snapBody(sample)` puts every body collider at the new pose at once, with no velocity and a fresh palm-velocity history. Any limb or palm jump faster than `limbMaxSpeed` counts as a pop, with velocity 0. Before this, after a sprint + reset the colliders swept 4.6 m through the new palm ball and threw it at ~550 m/s.
