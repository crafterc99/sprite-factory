# Recording guide: phone → 3D game clips

How to film basketball moves on one phone so they come out of **/mocap** (SAM 3 mask → SAM 3D Body → clip-builder) as clean 3D game clips: feet planted, smooth blends, and playable on any character in **/court3d**.
In-app version with the checklist, live shot-list status and camera cards: **/recording**.

> Numbers marked *(est.)* are estimates from the research, not measured on our data. Tune them on real takes.

---

## Why these rules exist

SAM 3D Body reads **one image at a time**. It measures joint angles and limb lengths well. It guesses the focal length and the depth again on every frame, and the fal endpoint takes no camera intrinsics.

| Axis | How it is measured | Error at 5 m |
|---|---|---|
| **Across the frame** (left/right) | directly from pixels | ~1–2 cm |
| **Toward/away** from the camera | from apparent size + a per-frame focal guess | ~5–15 cm per frame (a 1 % size error or a 3 % focal error) |

So:
1. **All travel goes ACROSS the frame.** On our step-back take, the across-camera travel matched the 2D path within ~2 cm. The depth travel was off by ~1 m, and the builder threw away 1.6 m of it.
2. **The camera never moves**, and the lens and settings stay fixed so the focal guess stays stable.
3. **The performer stays the same size in frame.** Walking 3 m toward the camera at 5 m changes body size by ~60 %.
4. **Hold still at clip edges.** The floor snap (±0.5 s window) and the foot pinning need grounded, still frames to lock onto.

---

## 1 · Camera setup

- [ ] **Tripod**, fully still. No pan, zoom or cut. One tripod position per session; if it moves, record a new calibration clip.
- [ ] **Lens height 0.9–1.2 m** (hip to chest), **level**: pitch 0°, at most 5–10° down.
- [ ] **1x main lens.** No zoom, no ultra-wide or fisheye.
- [ ] **Landscape 16:9.**
- [ ] **Stabilisation / Action Mode OFF.** They crop and warp each frame differently, which changes the focal length SAM has to guess.
- [ ] **HDR / Dolby Vision OFF** (SDR). HLG frames come out washed out after extraction *(reasoning, not from a source)*.
- [ ] **Exposure, focus and white balance locked.** Use Blackmagic Camera or a similar app.
- [ ] **60 fps capture**, 1080p minimum. Use 4K60 for the sprint lane and for shots. 60 divides evenly into every analysis rate (12/15/20/30).
- [ ] **Shutter locked:**
  - daylight: **1/500–1/1000**
  - LED or fluorescent light: **1/120** (1/100 on 50 Hz mains). Avoid 1/240 and 1/500 under mains LEDs unless you have checked they don't flicker.
- [ ] Start with a remote, or leave it recording across takes. Don't touch the phone.
- [ ] Put the light behind the camera, never a window or low sun behind the performer. Use a plain background with no mirrors or glass.

Motion blur of a ball at 5 m/s *(est.)*:

| Shutter | 1/60 | 1/120 | 1/500 | 1/1000 |
|---|---|---|---|---|
| Blur | ~8 cm | ~4 cm | ~1 cm | ~0.5 cm |

### Distance per clip class

A 1x phone lens in 16:9 covers about **1.32·d wide × 0.745·d tall** at distance *d* *(est., ~67° × 41° FOV)*.

| Class | Distance | Angle | Frame (h × w) | Performer height in frame |
|---|---|---|---|---|
| In-place dribble moves (idle, crossover, between-legs, behind-back) | **3.5 m** | **3/4**: body 30–45° off the camera axis, ball hand (right) on the camera side | 2.6 × 4.6 m | ~70 % |
| Jump shots, step-back | **4.5 m** | 3/4, imaginary hoop off to the side; the step-back travels across the frame | 3.35 × 5.9 m | ~55 % |
| Jog lanes, starts/stops, cuts, hesi, spin, layups, pull-ups | **5.0 m** | **side-on**, travel across the frame on a taped lane | 3.7 × 6.6 m | ~50 % |
| Sprint lane | **6.5 m** | side-on, **record 4K** | 4.8 × 8.6 m | ~38 % |

Tape a **start, centre and end mark** on the floor, parallel to the image plane. At the ends of travel keep ≥ 1 m between the performer and the frame edge.

---

## 2 · Framing

- [ ] Whole body **plus the ball** in frame for the **entire take**.
- [ ] **≥ 10 % margin under the feet.** The ball bounces there, and SAM needs the heels and toes.
- [ ] **Headroom ≥ 0.8–1.0 m above the standing head** for shots and layups (release ~2.8–3.0 m, layup reach ~3 m).
- [ ] The ball stays in frame for **≥ 0.3 s after release**.
- [ ] The performer is **≥ half the frame height** where possible (≥ 300 px in the analysed 1280-wide frames).

> **Real failure from our data:** in one step-back frame (f18) the head left the top of the frame. SAM guessed the missing part, and the whole body jumped. That single frame faked a **35 cm hop**, caused 54 outlier "fixes", and flipped the clip's travel direction by 162°. The pipeline now drops frames whose person box touches the border and interpolates them. A dropped frame is still an invented frame, so **record with headroom**.

---

## 3 · Performer

- [ ] Fitted clothes: shorts above the knee and a fitted top. Patterned or light colours read better than all-black.
- [ ] **Shoes that contrast with the floor** (light on dark, or the reverse). Use a matte floor; glossy courts mirror the legs.
- [ ] **Size 7 ball** only. The pipeline assumes a 0.12 m radius.
- [ ] **One person in view** for the whole take, with nobody walking behind. SAM takes the first person it finds.
- [ ] Measure the performer's height **in shoes** (cm) once per session.
- [ ] Optional: a different-coloured sock or sleeve on one side makes left/right swaps easy to spot.

---

## 4 · The hub pose: IDS (Idle Dribble Stance)

Every clip starts from and returns to one pose, so blends between clips line up.

| State | Definition |
|---|---|
| **IDS-R** (the hub) | Feet ~1.2× shoulder width, left foot ~15 cm ahead, knees bent 30–40°, hips back, chest over the knees. Ball dribbled at knee-to-hip height beside and slightly ahead of the right foot. Left forearm up as a guard. **Phase 0** = ball in the right palm at the top of the bounce. |
| IDS-L | The software mirror of IDS-R. **Never recorded.** |
| JOG-R | Moving state: right foot down, ball at the top. |
| LAND | Both feet planted after a shot, no ball. |

**Holds: at least 1 s perfectly still in IDS at the start AND end of every action clip** (≈ 2 bounces at ~2 Hz *(est.)*). The holds give the floor snap grounded frames, give the starting-hand detector a clean read, and give you a clean trim point. The `no-start-hold` flag checks for both feet planted over the first ~0.2 s of the analysed window.

---

## 5 · Loops

- Record **20–30 s takes to a metronome** (a Bluetooth speaker), then import whole cycles only.
  - Idle: ~120 bpm, 1 bounce per beat *(est.)*.
  - Jog: cadence 160–170 steps/min, a bounce every 2nd step *(est.)*.
- Lane loops: the performer is **already at speed when entering the frame** (start 3 m before the frame edge; sprint: accelerate over 8 m). Keep a constant pace and rhythm. Record **2 passes each way**.
- A loop needs a window with at least one whole cycle: idle 4 bounces ≈ 2 s, jog 2 strides ≈ 1.4 s, sprint 1–2 strides. The minimum is ~0.65 s.
- Loops use the whole analysed window (trims default to 0). The builder searches for the best cycle and reports the seam.

Speed tiers to aim for *(est.)*: walk ~1.4 · jog ~3.0 · run ~4.3 · sprint ~5.8 m/s.

---

## 6 · Hands and mirroring

- Record **everything with the ball starting in the RIGHT hand.** The game mirrors the 3D motion for the left hand ("mirror" is on by default).
- **Mirroring flips hand AND direction**: a right-hand left turn becomes a left-hand right turn. Record direction-dependent clips **in both directions**, right-handed:

| Record both ways (right hand) | Record once, R→L (the mirror gives L→R) |
|---|---|
| strafe left + strafe right · turn 90° L + R · cut 90° L + R · 180° turn planting on the left + planting on the right | crossover · between-the-legs · behind-the-back · spin |

Lane loops (jog, sprint, backpedal): record L→R **and** R→L. Joints on the far side of the body are 40–108 % less accurate, so both passes help.

---

## 7 · Turns and cuts

- Plant the pivot foot on the **centre mark**, clearly visible. Pivot radius ≤ 1 m.
- **Turn through the camera side**, so the back faces the camera for ≤ ~0.5 s (spin ~0.3 s).
- **90° cuts: V-path.** Approach at 45° going away from the camera, plant on the centre mark, exit at 45° coming back. The depth change is then symmetric, and the plant sits on the camera's best axis.
- Minimum set: 90° L and R (in place and jogging) and 180° plants. 45° and 135° are optional.

---

## 8 · Shot list

✅ = the 3D court plays this role now. Locomotion roles are clip-driven when recorded; otherwise the court falls back to procedural stepping. **Name** = the slot; add `-t<NN>` per take.

### Roles the game uses

| Role | Name | Type | Camera | What to perform | Court |
|---|---|---|---|---|---|
| `idle` | `dribble-idle-r` | loop | 3.5 m, 3/4 | 20 s IDS-R dribble to the metronome, feet planted | ✅ hub |
| `loco-fwd` | `loco-jog-fwd-r` | loop | 5 m lane | Jog dribble ~3.0 m/s *(est.)*, 2 passes each way | ✅ stick |
| `loco-back` | `loco-backpedal-r` | loop | 5 m lane | Retreat dribble ~1.5–2 m/s *(est.)*, moving backward across the frame | ✅ stick |
| `loco-left` | `loco-strafe-left-r` | loop | 5 m lane, facing camera at 3/4 | Lateral slide ~1–1.5 m/s *(est.)*, feet never cross | ✅ stick |
| `loco-right` | `loco-strafe-right-r` | loop | 5 m lane, facing camera at 3/4 | Same, the other way (right hand) | ✅ stick |
| `loco-sprint` | `loco-sprint-fwd-r` | loop | 6.5 m lane, 4K | Speed dribble ~5.5–6.5 m/s *(est.)*, ball pushed ahead, bounce every 2 steps | ✅ R2 |
| `shot-stepback` | `shot-stepback-r` | action | 4.5 m, 3/4 | IDS-R 1 s → jab or one hard dribble → step back 0.8–1.2 m **across** the frame → jumper → land → hold 1 s | ✅ stick + hold □ |
| `shot-jumper` | `shot-jumper-idle-r` | action | 4.5 m, 3/4 | IDS-R 1 s → spot-up jumper → land → hold 1 s | ✅ hold □ |
| `move-crossover` | `move-crossover-idle-rl` | action | 3.5 m, 3/4 | IDS-R 1 s → low crossover in front with a small jab step → IDS-L hold 1 s | ✅ ○ |
| `move-spin` | `move-spin-jog-rl` | action | 5 m lane | Jog → plant the left foot → reverse pivot 360° through the camera side → left hand → continue | ✅ △ |
| `move-hesi` | `move-hesi-jog-r` | action | 5 m lane | Jog → decelerate → rise with the ball hanging in the right hand → burst 2–3 steps | ✅ ✕ |
| `move-btl` | `move-btl-idle-rl` | action | 3.5 m, 3/4 | IDS-R, **left foot forward** 1 s → between the legs → ends right foot forward, hold 1 s | ✅ R1 |
| `move-btb` | `move-btb-idle-rl` | action | 3.5 m, 3/4 | IDS-R 1 s → behind the back → IDS-L hold 1 s | not yet |
| `start-fwd` | `start-jog-fwd-r` | action | 5 m lane | IDS-R side-on in the far third of the lane, hold 1 s → 3–4 accelerating steps → ≥ 2 steps at jog pace in frame | not yet |
| `stop` | `stop-jog-r` | action | 5 m lane | Enter at jog pace → 2-count stride stop or jump stop → IDS-R hold 1.5 s | not yet |
| `layup` | `layup-jog-r` | action | 5 m lane | Jog → gather on the right foot → step left → take off from the left foot → right-hand finish at full reach → land, hold 1 s | not yet |

### Extras (record them now so they are ready)

The name guesses a role from its family prefix, so some extras play on the court as soon as they are analysed: `move-crossover-jog-rl` → crossover, `shot-pullup-jog-r` → jumper, `loco-run-fwd-r` and `loco-walk-fwd-r` → forward loop, `dribble-idle-low-r` → idle hub. Set them to **— none —** in /mocap to keep them off. `calib-`, `turn-` and `cut-` takes get no role.

| Name | Camera | Notes |
|---|---|---|
| `calib-<setup>` | lane centre | One per camera position (see §10) |
| `turn-90l-idle-r` / `turn-90r-idle-r` | 3.5 m, 3/4 | IDS-R → 1–2 step pivot while dribbling → IDS-R hold |
| `cut-90l-jog-r` / `cut-90r-jog-r` | 5 m lane | V-path, plant the outside foot on the centre mark |
| `turn-180l-jog-r` / `turn-180r-jog-r` | 5 m lane | Jog across, plant (left / right foot), reverse through the camera side, keep jogging |
| `move-crossover-jog-rl` | 5 m lane | Crossover on the move with a 30–45° change of direction (can also fill `move-crossover`) |
| `shot-pullup-jog-r` | 5 m lane | Jog → 1–2 step or hop gather → jumper → land, hold |
| `loco-run-fwd-r` | 5 m lane | ~4.3 m/s *(est.)*, the next loop after the minimum set |
| `dribble-idle-low-r`, `loco-walk-fwd-r`, `start-sprint-fwd-r` | as above | Optional |

**Takes:** ≥ 3 good takes per action (3–5 for moves and shots), and 2 passes per direction for each lane loop.
**Session order:** calibration → idle hub → locomotion → transitions → shots → moves. Shots need fresh legs.

---

## 9 · Naming convention

```
<family>-<action>[-<variant>]-<hands>-t<NN>
```

- **family**: `calib` `dribble` `loco` `start` `stop` `turn` `cut` `move` `shot` `layup`
- **hands**: `r` (right the whole clip), or `rl` / `lr` for a hand change
- lowercase kebab-case, `[a-z0-9_-]`, ≤ 60 characters. The take number goes last.

Examples: `dribble-idle-r-t02` · `loco-jog-fwd-r-t03` · `loco-strafe-left-r-t01` · `move-crossover-idle-rl-t03` · `move-spin-jog-rl-t02` · `shot-stepback-r-t04` · `layup-jog-r-t02` · `calib-gym1-t01`.

Say the take name out loud on camera, or rename the file right after recording.

> The name only **guesses** a role, from its family prefix: `dribble-idle-…` → idle hub, `loco-jog/walk/run-…` → `loco-fwd`, `loco-sprint-…` → `loco-sprint`, `move-<move>-…` → that move, `shot-stepback-…` → step-back, any other `shot-…` → jumper. `calib-`, `turn-` and `cut-` get no role. **Always set the role in the "3D game clip" panel and Save.** An explicitly assigned role beats a guessed one.

---

## 10 · Calibration clip (one per camera setup)

About 12 s, recorded once each time the tripod is placed:

1. Clap or slam the ball (an audio sync mark).
2. A-pose facing the camera on the centre mark, 2 s.
3. Quarter turn to profile, 2 s.
4. IDS-R, 2 s.
5. Slow walk along the whole lane, stepping flat on the tape marks.
6. 2 small hops in place, then stand still 1 s.

Write down: **performer height in shoes (cm), tape-mark distance (m), camera height (m) and distance (m)**. Put them in the clip notes.
The pipeline does not read calibration clips automatically yet; it still estimates height per clip. Analysing the calibration clip is optional (15 fps).

---

## 11 · Analysis settings in /mocap

The **Clip type** buttons on the Capture step set these for you. Then set the trim so the window holds only the action and its holds.

| Clip type | Sample FPS | Max frames | Window | Cost at max frames |
|---|---|---|---|---|
| Idle loop | **15** | 48 | 3.2 s (≥ 4 bounces) | ~$1.00–1.45 |
| Locomotion (loops) | **30** | 96 | 3.2 s (one pass in frame) | ~$1.90–2.90 |
| Move / transition | **30** | 120 | 4 s (hold + move + hold) | ~$2.40–3.60 |
| Shot / layup | **30** | 120 | 4 s (hold + shot + land hold) | ~$2.40–3.60 |

- Max frames goes **up to 240** (= 8 s at 30 fps).
- Measuring costs about **$0.02–0.03 per frame**. The 3D body mesh adds ~$0.02 per frame.
- Why 30 fps: a jog step touches the floor for only ~0.25–0.3 s, which is about 3 samples at 12 fps. A crossover's ball transfer takes ~0.15–0.25 s *(est.)*.

---

## 11b · For hands that match the video exactly

The game replays SAM 3D Body's own hand and finger rotations, so hands are as good as what the camera sees:

- **4K at 60 fps**, shutter ≥ 1/500 (sports mode). Frames go to the analysis up to 2560 px wide, and 60 fps is selectable on /mocap. The hands are a few % of the picture; more pixels and less blur are what fixes fingers.
- **Closer**: the whole body, head to feet, filling ~70 % of the frame height. The head must never leave the picture (such frames are dropped). Feet slightly cut at the bottom are kept but lose foot data.
- **Hands visible**: film from the side the ball hand is on, never with the hands hidden behind the body for long. For two-hand moves, film two takes from both sides.
- **Start and end in a held stance** (1 s), move across the frame rather than toward the camera.
- Check the result in `/court3d?replay=<motionId>`: the clip beside each source frame.
- Why resolution matters so much: SAM 3D Body only runs its hand decoder when a hand is > 64 px in the image it gets. Hands in a 1080p full-body shot are ~40 px, so the analysis now sends a crop around the player enlarged ~2× (checked against a full-frame call on the first frame; `meta.zoomCheck`). Real pixels still beat enlargement: 4K keeps fingers sharp.

## 12 · Import, step by step

1. **/mocap → Capture:** choose the video and name it with the convention. Press the clip-type button, trim to the action plus its holds, and press **Analyze motion**.
2. **Motion step:** press **Add 3D body mesh + hand close-ups**.
3. **Motion step → "3D game clip" panel:**
   - Choose the **role**.
   - Check the **type** (loop/action), the **trims** (raw frames cut from each end; loops: leave 0) and the **entry max** (actions: the latest frame the court may start the clip from; blank = auto).
   - Press **Save & rebuild**, then read the quality flags (see §13).
   - Set rejected takes to **— none —**. Loops (idle, locomotion) use one take per role; moves and shots keep up to 4 takes and the nearest-pose matcher picks between them. An explicit role beats a guess, then the newest wins.
4. **Open in 3D court** (`/court3d?focus=<motionId>`) to play it.

### Stand-ins that were not filmed (generated / Kimodo)

Until a role is recorded, a generated clip can fill it. Filmed takes you add later join as extra variants for the pose matcher. Delete a stand-in, or set it to **— none —**, once the real take is better.

- **Procedural:** `POST /api/mocap3d/generate {"kind":"run-dribble"}` (role `loco-sprint`), `{"kind":"crossover"}` or `{"kind":"crossover-moving"}` (role `move-crossover`). Add `"hand":"left"` for the other hand.
- **NVIDIA Kimodo:** generate the body in the Kimodo demo (for example "a person jogs forward" or "a person jogs and cuts hard to the left"), export **NPZ**, then post the file: `curl -X POST --data-binary @motion.npz -H 'Authorization: Bearer …' '<site>/api/mocap3d/import-kimodo?name=Jog%20dribble&role=loco-fwd&arms=dribble'`. Kimodo does not handle the ball, so `arms=dribble` adds a dribble synced to its steps and `arms=crossover` crosses the ball at its sharpest cut (`arms=none` keeps its arms).

---

## 13 · Troubleshooting: quality flags

Red = `bad` (the clip will not work well), amber = `warn`.

| Flag | Level | What it means | Fix now | Fix when re-recording |
|---|---|---|---|---|
| `low-fps` | warn | A moving clip was analysed below 20 fps | Re-analyse at 30 fps | Capture at 60 fps |
| `depth-travel` | warn | > 0.3 m of travel toward/away from the camera was not trusted and was removed | Nothing; the travel is lost | Camera **side-on to the path**: travel ACROSS the frame; step-back across with the hoop off to the side |
| `noisy-feet` | warn | Planted feet jitter > 0.5 m/s in the capture | Analyse at 30 fps | Film closer (performer ≥ half the frame height), 1080p+, tripod, shutter ≥ 1/500 (1/120 under LEDs), more light, shoes that contrast with the floor |
| `no-contacts` | **bad** on moving clips | No foot plants found | Widen the trim window | Feet in frame for the whole take with a 10 % margin under them; heels and toes visible; nothing in front of the feet |
| `slide` | warn | Planted feet still move > 4 cm after cleanup | Analyse at 30 fps | See `noisy-feet` and `depth-travel` |
| `ik-clamped` | warn | > 15 % of frames needed a straight leg to reach the floor (height estimate off) | Check "your height (est.)" on the Motion step | Keep the head AND feet in frame all the time; record the calibration clip; no cropped frames |
| `loop-seam` | warn | The best loop's seam is > 6 cm | Analyse a longer window (≥ 2 cycles) | 20–30 s takes to a metronome, constant pace |
| `no-loop` | **bad** | No loopable cycle in the analysed window | Set type = loop, trims 0; analyse ≥ 1 whole cycle (idle ≥ 2 s) | Steady rhythm; stay in frame for full cycles |
| `no-start-hold` | warn | The action does not start with both feet planted | Lower **trim start** so the clip begins inside the hold | Hold IDS still for ≥ 1 s before the move |

### Reading the quality numbers

| Number | Good | Meaning |
|---|---|---|
| Foot slide measured → pinned | pinned ≤ 4 cm | Worst planted-foot slide in the capture, and after pinning |
| Loop seam | ≤ 6 cm | Pose difference where the loop wraps |
| Contacts L / R | ≥ 1 each on moving clips | Foot plants found per foot |
| Depth drift removed | ≤ 0.3 m | Travel along the camera axis that was discarded |
| Foot noise | ≤ 0.5 m/s | Jitter of grounded feet (sets the contact gate) |
| Pelvis drop | small | How far the pelvis was lowered so the pinned feet reach |
| Warp correction | small | How far the intended travel (e.g. the 0.95 m step-back hop) differs from the measured travel. Large values usually mean the travel went into depth. |

**Worked example: our step-back take.** It was analysed at 15 fps (`low-fps`). It moved 1.6 m in depth (`depth-travel`) and jittered 1.0 m/s (`noisy-feet`). It had no still stance at the start (`no-start-hold`). Slide went from 58 cm measured to 3 cm pinned, and the hop warp corrected 66 cm. To re-shoot: 60 fps capture analysed at 30, camera 4.5 m side-on to the step-back, 1 s IDS hold before the jab, and headroom.
