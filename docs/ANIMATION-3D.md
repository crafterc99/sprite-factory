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

`idle` (hub loop, required) · `loco-fwd / loco-back / loco-left / loco-right / loco-sprint` (loops, used as a direction blend space) · `shot-stepback / shot-jumper` · `move-crossover (○) / move-spin (△) / move-hesi (✕) / move-btl (R1)`. Not played yet: `move-btb, start-fwd, stop, layup`. Loops use one take per role; moves and shots keep up to 4 takes per role (assigned first, then newest) and the pose matcher picks between them. Unassigned motions get a guess from the naming convention (`<family>-<action>-…`).

## 3. Character rigs — `lib/mocap/character-rig.js`

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
| `GET /api/mocap3d/rig/:char` | rig (gz JSON, ETag), `?motion&frame` for another scan |
| `POST /api/mocap3d/generate` | `{ kind: run-dribble \| crossover \| crossover-moving, hand, speed }` → new motion |
| `POST /api/mocap3d/import` | `{ name, role, type, fps, skeleton: mhr70 \| soma \| <named>, jointNames?, frames, upAxis, units, balls?, hand?, entryMax? }` → new motion |
| `POST /api/mocap3d/import-kimodo` | raw `.npz` body, `?name&role&arms=dribble\|crossover\|none&hand&prompt&type` (≤ 30 MB) → new motion |
| `GET /js/anim3d.mjs` | the runtime module (revalidated on every load, like the page) |
| `/court3d` · `/recording` | sandbox · recording guide (`/court3d?focus=<motionId>&char=big`) |
