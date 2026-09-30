# Ball contact system

How the basketball moves during dribbles, moves, shots and loose balls in the 3D court
(`court3d.html`), why it used to fly off the player's leg, and how the new system keeps it on a
controlled, animation-aware path.

Written for engineers working on `engine3d/` and `court3d.html`. Paths are repo-relative.

---

## CURRENT SYSTEM

This is the system as it was before this change (builder rev `cb-2026-09-29h`).

### Who owned the ball

- **Rapier decided everything during play.** The ball was always a dynamic rigid body
  (`engine3d/basketball-physics.mjs`), never kinematic and never parented. The mesh copied the
  physics snapshot.
- **The animation only gave "intent".** `Player.ballIntent()` (`engine3d/anim3d.mjs`) said which
  hand should hold the ball and where the recorded ball was. The physics system turned that intent
  into forces: a PD spring toward the palm while "held", one impulse at the release, a weak pull
  toward the recorded path in flight, and a ramped PD from the catching palm.
- **The player's body was a set of kinematic colliders** (thighs, shins, feet, arms, 15 finger
  phalanges per hand, chest and pelvis boxes) that the ball collided with on every step.

### Where the ball data came from

| Stage | Where | What it did |
|---|---|---|
| Detection | `lib/mocap/providers.js` | SAM 3 found the ball per frame (no tracking between frames). |
| Lift to 3D | `lib/mocap/motion-builder.js` | Depth from the nearest wrist; the ball stays on its camera ray. |
| Hold rule | `lib/mocap/motion-builder.js` | "Held" = ball centre within 24 cm of a palm; hand = nearest palm, no hysteresis. |
| Flight fit | `lib/mocap/motion-builder.js` | One gravity arc with one bounce; the fitted bounce point was discarded. |
| Game clip | `lib/mocap/clip-builder.js` | Per frame `{p, held, hand, off}` in root space. No release, bounce or catch events. |
| Runtime | `engine3d/anim3d.mjs` | `prepareClip` mirrors and scales the ball; `classifyBallEvents` labels frames. |

Generated / imported clips (Kimodo, "generated") carry a synthetic ball whose free frames hover at
0.35–0.55 m and never reach the floor: only their held / free timing is meaningful.

### One frame, before

1. Input; a move request waits until the physics says the ball is in the hand.
2. `Player.update` → keypoint pose; `poseCharacter` → MHR bone matrices.
3. Contact IK (arm reach toward where the physical ball is).
4. Colliders from the IK'd pose; ball intent from the clip frame (`Math.round(t)`).
5. A move that starts in the other hand triggered `handTransfer`: one ballistic toss.
6. Rapier stepped at 120–240 Hz with the PD / impulse controller and three post-step velocity
   overrides (speed clamp, release guard, pinch guard).
7. Possession logic (lost → loose ball, pickups, passes back), render, finger conform.

---

## PROBLEMS

Reproduced on the recorded between-the-legs → crossover → shot take (`mo-mulp87wqvabn`, played as
the jump shot), the idle, the jog / run loops and the three crossovers, headless at 30, 60 and
120 fps.

**Why the ball "hits his leg and flies":**

1. **A stale release guard.** The move starts in the right hand while the idle dribbles with the
   left, so `handTransfer` tosses the ball across. The transfer never reset `lastRelease`, so the
   release guard (meant to stop a hand re-hitting a ball it just released) overwrote the ball's
   velocity with the idle dribble's old release velocity plus half a second of gravity. The result
   was a 8.5–12.3 m/s downward throw into the left foot. This happened in 4 of 4 left-hand runs.
2. **The default hand could not play the move.** The idle is left-handed and the recorded move is
   right-handed with mirroring off, so every standing jump shot went through problem 1.
3. **The recorded between-the-legs bounce runs through the left shin** on this rig (up to 6.6 cm
   into it). The single-camera track misses the real floor contact (its lowest sample is 20 cm, the
   ball's radius is 12 cm) and the depth repair only nudged it 2–6 cm clear.
4. **The release planner predicted every between-the-legs release into the legs** and
   re-planned by 1.3–4.3 m/s; 6 of 8 attempts touched a leg and 1 of 8 lost the ball.

**Structural problems:**

- The 24 cm hold rule marks fast dribbles as held for every frame, so no release or bounce exists.
- Hand labels flicker inside holds (nearest palm, no hysteresis), which also misclassifies crossovers.
- The fitted bounce point never reached the game clip; occlusion gaps longer than 3 frames read as
  releases.
- Ball state lived in four places (physics state, controller mode, game flags, animation labels).
- The dribble clock ran open-loop: the hand "caught" on schedule whether or not the ball arrived.
- Two different palm definitions (keypoint palm vs skeleton palm) disagreed by 2 cm.
- Held / free flipped at rounded frames, so timing depended on the frame rate.
- Body collider radii were fixed adult sizes, 1.7–1.8× too fat for the AC character.
- Contact IK had no joint limits and chased the ball; the ball chased the hand.

---

## NEW SYSTEM

> **Authored body motion + contact tracking + constrained ball trajectories + small IK
> corrections + physics only where appropriate.**

The recorded animation still decides what a move looks like. Contact data decides when the ball
leaves and reaches a hand and where it hits the floor. A solver builds the ball's path between those
contacts. IK fixes the last centimetres. Rapier only runs the ball when nobody controls it (a shot
in flight, a loose ball).

### Modules

| Module | Role |
|---|---|
| `engine3d/ball-contacts.mjs` | Contact metadata: auto detection with confidence, manual edits, captured-track cleaning, move entry / exit hands. |
| `engine3d/ball-trajectory.mjs` | `BallTrajectorySolver`: hand → floor and floor → hand segments (ballistic / Hermite hybrid), bounce, rotation. |
| `engine3d/ball-control.mjs` | `BallController`: the `BallControlState` machine, palm targets, controlled attachment, failsafe, IK weights, compact state. |
| `engine3d/ball-session.mjs` | Per-tick orchestration shared by the court and the tests: targets from the skeleton, schedule from the animation, controller, physics hand-off, IK, move buffer and move graph. |
| `engine3d/anim3d.mjs` | Clips carry contacts; `Player.ballSchedule()` predicts the next contacts; ball-aware move selection, interruption windows, hand switches as real crossovers. |
| `engine3d/basketball-physics.mjs` | The ball can be controlled (kinematic, no body collisions) or free (dynamic, full collisions). |
| `court3d.html` | Uses the session; Ball Debug Mode; Contact Editor in replay mode. |
| `routes/mocap.js`, `lib/mocap/game-clips.js` | Stores contact edits per clip (`meta.ballContacts`) and serves them with the library. |

### Priority when systems disagree

1. Gameplay intent, 2. ball ownership, 3. contact timing, 4. the authored / captured move,
5. bounce location, 6. ball trajectory, 7. hand contact, 8. body animation, 9. small IK
correction, 10. secondary physics. The body animation is never bent to chase a bad ball position;
the ball's path is corrected instead.

---

## STATE MACHINE

`BallControlState` (in `engine3d/ball-control.mjs`):

| State | Ball follows | Physics | Owner |
|---|---|---|---|
| `HELD_RIGHT` / `HELD_LEFT` | `BallTarget_R` / `BallTarget_L` (position + orientation constraint, tiny smoothing) | off | that hand |
| `HELD_BOTH` | midpoint of both palm targets (gather, shot pocket, shot set) | off | both hands |
| `RELEASE_RIGHT` / `RELEASE_LEFT` | the down segment, leaving the palm | off | that hand (releasing) |
| `DRIBBLE_DOWN` | the down segment to the bounce target | off | the dribbler |
| `BOUNCE` | the floor contact (one tick) | off | the dribbler |
| `DRIBBLE_UP_RIGHT` / `DRIBBLE_UP_LEFT` | the up segment to the receiving hand | off | the receiving hand |
| `CATCH_RIGHT` / `CATCH_LEFT` | a short blend from the flight into the palm | off | the receiving hand |
| `SHOT_RELEASE` | Rapier (ballistic to the rim) | on | nobody |
| `PASS_RELEASE` | a controlled pass trajectory to the receiver | off | the receiver |
| `LOOSE` | Rapier with full body collisions | on | nobody |
| `DEAD` | Rapier, out of play until a new possession | on | nobody |

Allowed transitions (anything else is rejected and logged):

```
HELD_x      → RELEASE_x, HELD_BOTH, HELD_y (hand-to-hand pass inside a hold), SHOT_RELEASE, PASS_RELEASE, LOOSE
HELD_BOTH   → HELD_x, RELEASE_x, SHOT_RELEASE, PASS_RELEASE, LOOSE
RELEASE_x   → DRIBBLE_DOWN, DRIBBLE_UP_y (a toss with no bounce), LOOSE
DRIBBLE_DOWN→ BOUNCE, LOOSE
BOUNCE      → DRIBBLE_UP_x, LOOSE
DRIBBLE_UP_x→ CATCH_x, LOOSE
CATCH_x     → HELD_x, HELD_BOTH, LOOSE
SHOT_RELEASE→ LOOSE, DEAD
PASS_RELEASE→ CATCH_x, LOOSE
LOOSE       → CATCH_x (pickup), DEAD, HELD_x (new possession)
DEAD        → HELD_x (new possession)
```

The engine always knows why the ball is where it is: every state names its reference (a palm
target, a trajectory segment, or the physics body) and every transition is caused by a contact
event, a gameplay event (shot, pass, reset) or the failsafe.

---

## CONTACT MODEL

### Palm targets

`BallTarget_R` and `BallTarget_L` are computed every tick from the skinned skeleton (the
animation pose, before IK), not from the raw hand bone:

```
palm centre = wrist + 0.55 · (middle knuckle − wrist)       (the palm, not the wrist)
palm frame  = { n: palm normal (out of the palm), y: along the fingers, x: across }
BallTarget  = palm centre + n · (R + palmThickness + normalOffset) + y · alongOffset
```

`normalOffset` and `alongOffset` default to 0 and 1.2 cm and can be set per hand and per clip in
the Contact Editor. Each target also carries its velocity and orientation. This is the single palm
definition shared by the controller, the IK and the debug view.

### Contact tracking (every tick)

For each hand: distance from the ball centre to the target, relative velocity, approach direction
(the relative velocity against the direction to the palm), palm orientation. With the ball state,
the expected receiving hand and the animation phase, this decides contacts. A catch requires all
four: the right state (a flight toward that hand), the expected hand, the distance under the
threshold, and an approach (not moving away). A ball passing near the other hand is never caught
by it.

### Contact metadata (per clip)

Stored on the clip at load time (`clip.contacts`), computed by `detectContacts` and merged with any
saved edits:

```json
{
  "version": 1,
  "moveId": "mo-mulp87wqvabn",
  "entryHand": "right",
  "exitHand": "left",
  "trackSource": "video",
  "events": [
    { "id": "r1", "type": "release", "hand": "right", "frame": 9.6, "u": 0.141, "window": [9.1, 10.1], "conf": 0.9 },
    { "id": "b1", "type": "bounce", "frame": 11.7, "u": 0.172, "window": [11.2, 12.2], "local": [0.2, 0.12, 0.35], "conf": 0.86 },
    { "id": "c1", "type": "catch", "hand": "left", "frame": 13.8, "u": 0.203, "window": [13.3, 14.3], "conf": 0.88 }
  ],
  "holds": [{ "hand": "right", "from": 0, "to": 9.6 }],
  "flights": [{ "release": "r1", "bounce": "b1", "catch": "c1", "kind": "between-legs", "profile": "low" }],
  "offsets": { "right": { "normal": 0, "along": 0.012 }, "left": { "normal": 0, "along": 0.012 } }
}
```

- `frame` is fractional clip frames, `u` normalized time (0–1), `window` the contact window in
  frames. The runtime picks the moment inside the window where the contact is best (the hand is
  closest / moving the right way), so playback-rate changes and blends don't break contacts.
- `local` is the bounce point in the clip's root frame at that moment (x left, y up, z forward),
  already scaled to the character and mirrored with the clip.
- `conf` is 0–1. Low-confidence events still drive the game but are shown in orange in the editor.
- Entry and exit hands come from the first and last holds. `game.mirror` still decides whether
  a mirrored copy exists.

### Auto detection (`detectContacts`)

1. **Palms per frame** from the clip pose; the held distance is calibrated per clip (median
   ball–palm distance over held frames).
2. **Holds**: runs of frames within the calibrated distance of a palm, hand chosen with hysteresis
   (the other hand must be 5 cm closer for 3 frames), both hands within reach → a two-hand hold.
3. **Releases and catches**: hold boundaries, refined to fractional frames where the distance
   crosses the threshold and the relative velocity says the ball is leaving / arriving.
4. **Bounces**: in each flight, the ball's height is fitted with two gravity parabolas that meet
   the floor at `R` at a searched bounce time (0.1-frame steps). The bounce point is where the
   horizontal fits meet at that time. This recovers a floor contact the camera missed between
   frames. A flight whose track never comes down (a synthetic track) gets a bounce placed by
   gravity timing between the release and catch heights, with low confidence.
5. **Confidence** combines: the track source (video vs generated), how many flight frames were
   observed, the fit residual, the implied bounce restitution (plausible 0.5–0.95), and the hand
   distance at the contact.

### Captured track cleaning (hierarchy)

```
captured ball motion → contact events → trajectory cleanup → constraint correction → IK correction
```

`cleanBallTrack` keeps captured positions where they are good and replaces the rest:

- held frames sit on the palm target of their hand;
- each flight becomes the solver's segments through the release point, the fitted bounce and the
  catch point, keeping the captured timing, horizontal path and height;
- single-frame jumps, floor penetration, acceleration spikes, hand penetration and false contacts
  are removed;
- the bounce point is moved out of the legs (capsules of the rig's own pose at that moment) by the
  smallest shift, sideways first.

The court uses the cleaned track for replays and the Contact Editor; gameplay uses the same
contacts through the solver.

---

## TRAJECTORY MODEL

`BallTrajectorySolver` (`engine3d/ball-trajectory.mjs`) solves each segment independently.

**Inputs:** start position and velocity, target position, desired duration, ball radius, floor
height, the character's root velocity, a profile.

**Hand → floor (down):** vertical motion is exact ballistic under gravity, reaching `floorY + R`
at the bounce time. A cubic correction term `Δv · τ · (1 − τ/T)²` makes the start velocity equal
the hand's velocity at release, while keeping both end points and the arrival velocity. Horizontal
motion is constant velocity plus the same correction. The correction is scaled down if it would
take the ball below the floor.

**Floor → hand (up):** vertical ballistic from the floor to the catch target in the remaining time,
with an end correction `Δv · τ² (τ − T)/T²` that blends the arrival velocity half-way toward the
catching hand's velocity (a soft catch). Horizontal the same.

**Bounce:** the ball centre is exactly `floorY + R` at the bounce. The incoming and outgoing
velocities give an implied restitution; the solver shifts the bounce time inside its window to keep
it believable (target 0.78, range 0.55–0.95) and keeps horizontal momentum from reversing unless
the move is a crossover. Nothing ever evaluates below the floor (checked on 32 samples per
segment).

**Moving character:** bounce and catch targets are stored in the character's local frame and
turned into world points with the predicted root transform at the event time (the locomotion
spring's closed form, or the clip's own root motion inside a move). They are re-predicted every
tick and the segment is re-solved from the ball's current position and velocity, with the target
change rate limited so the ball never visibly swerves.

**Locomotion profiles:** a table (`DRIBBLE_PROFILES`) keyed by gait (standing, jog, sprint,
backpedal, lateral, diagonal as a blend) shifts the local bounce point forward with speed, a
little outward when sliding, and raises the dribble at a sprint. It is deterministic.

**Rotation:** each segment has a constant angular velocity: backspin from the hand's tangential
motion at release, then at the bounce the spin moves half-way toward rolling on the floor. The
orientation is the closed-form rotation from the segment start, so it is frame-rate independent
and continuous across states. While held, the orientation follows the palm with the offset
captured at the catch.

**Character adaptation:** targets come from the rig's own palms, floor and pose; local points are
scaled by the clip-to-rig leg ratio; IK limits scale with arm length. The same crossover adapts to
the 1.75 m guard and the 2.11 m big.

---

## IK MODEL

The body animation stays primary; IK only closes the last centimetres (`engine3d/ball-control.mjs`
computes the weights, `engine3d/contact-ik.mjs` applies them).

| Limit | Value |
|---|---|
| `MAX_HAND_CORRECTION` | 4 cm (× arm length / 0.62 m) |
| `MAX_WRIST_ROTATION` | 0.30 rad |
| `MAX_ELBOW_CORRECTION` | 0.25 rad of elbow flexion change |
| Arm extension | never beyond 97 % of upper-arm + forearm length |

Weights per hand follow the state and the time to contact, through smooth curves with a rate
limit (never snapped): far from a catch 0, approaching 0.2, near 0.6, contact 1, then down to 0.3
once the hold is established and the hand already sits on the ball. A release fades out over 80 ms.
If the ball is further than the hand correction allows, the trajectory is re-targeted to the hand
instead of stretching the arm.

**Legs.** A controlled flight never touches the player's legs: 50–80 ms ahead the solver checks the
path against the rig's own thigh / shin / foot capsules (radii measured from the character's bind
mesh) and steers around them with a velocity change (no position jump); a ball already overlapping
slides out and the rest of the path is re-solved to the same bounce or catch. A ball on the palm
that the animation puts against a leg is eased out by at most 6 cm (the hand follows by IK) and
the knee yields up to 5 cm, hip and ankle fixed.

**Fingers:** `conformFingers` keeps every phalanx outside the ball and curls the controlling
hand's fingers onto it. Priority is palm accuracy > wrist accuracy > finger detail; finger contact
is a separate pass so a proper grip model can replace it later.

---

## ANIMATION INTEGRATION

**Schedule.** `Player.ballSchedule()` reports, for whatever is playing (the idle / dribble layer
at `dribbleT`, or an action at `a.t`): the move id, normalized time, the hand that should hold the
ball now, and the next contacts with their time from now, window, hand and predicted world point.
The controller consumes this; it never reads per-frame `held` flags.

**Entry / exit states.** Every clip declares `entryHand` / `exitHand` from its contacts
(`crossover_r_l`: right → left). A move can start only when the ball is under control of its entry
hand (`HELD_x`, or `CATCH_x` about to complete).

**Move graph.** Built from the library (`buildMoveGraph`): `RIGHT CONTROL` and `LEFT CONTROL` nodes,
edges to every clip (and mirror) whose entry hand matches, labelled with the exit hand. A requested
move with no clip for the current hand is preceded by a crossover dribble to the other hand, never
by a teleport.

**Input buffer.** Requests queue (up to 3, 1.2 s each) and fire at the next valid window: the ball
held by the move's entry hand, not within 60 ms of a release. Hesitation → crossover → sprint plays
in order.

**Interruption windows.** From the contacts: pre-release (held, before the release window) allows a
move from the same hand; mid-flight blocks everything except a shot request, which waits for the
catch; post-catch allows a move from the new hand. The old fixed 72 % cancel point remains only for
the stick (letting a move's recovery give way to locomotion).

**Hand switch (H).** A real crossover dribble: the next release goes to a bounce on the midline and
the other hand catches it; the idle swaps to its mirror at the bounce (both hands off the ball), so
its catch frame meets the flight. If the animation ever plays the other hand than the one holding
the ball, the animation follows the ball (ownership wins), never the reverse.

**Catch prediction.** Idle / locomotion catches are predicted from the clip's palm keypoints at the
catch frame (the dribble layer predicts its torso's future pose too), shifted onto the skinned palm
target. Inside a move, the next catch is predicted on the skinned skeleton itself (one extra
skeleton solve for that frame), because a move's captured rotations put the drawn hand up to 15 cm
from its keypoints. The last 200 ms home in on the real palm; the catch then blends in only the
remaining prediction error, at no more than 1.5 m/s of correction and ~11 g of absorption, and the
flight's arrival velocity leans toward the palm's (a soft catch).

**Skeleton crossfade.** When the animation source changes (idle ↔ locomotion loop ↔ move), the
skinned skeleton crossfades for 120 ms from the pose that was drawn, carried along with the body's
root motion — the hands never pop, so neither does the ball.

**Receiving.** A pass or a pick-up ends a shot's follow-through and holds the idle's catch pose
(ready hands) until the ball arrives; the pass is aimed at those hands.

**Foot contact.** The existing foot planner and locks keep planted feet fixed (slide metric in the
debug panel). Bounce targets are pushed off predicted planted feet.

**Shots and passes.** A shot clip's gather and set are `HELD_BOTH`; at the release frame the ball
enters `SHOT_RELEASE` and the existing ballistic shot takes over in Rapier. A pass back from the
rebounder is a controlled `PASS_RELEASE` flight that meets the player's catching hand.

---

## DEBUGGING

**Ball Debug Mode:** press **B** in the court (or the **Ball** button in the top bar, or open the
court with `?balldbg=1`). It shows:

- ball state, current move, normalized time, expected hand, hand distances, IK weights, ball
  velocity, recoveries and the transition log;
- `BallTarget_L` (blue) and `BallTarget_R` (red) spheres;
- release (yellow), bounce (cyan ring on the floor) and catch (green) points;
- the trajectory: hand ● ─── bounce ● ─── hand ●, past (dim) and planned (bright);
- a timeline of contact windows with the current time.

**Contact Editor:** open a clip in replay mode, `court3d.html?replay=<motionId>&contacts=1` (or
the **Contacts** button in the replay bar). It shows the timeline, the current frame, the ball
height and both palm distances, and markers for every release, bounce and catch (orange = low
confidence). You can add markers at the current frame, drag them, change the hand, the windows and
the trajectory profile, drag the bounce target on the floor, and set the palm offsets. **Save**
writes the clip's contact metadata; **Auto** restores the detected set.

**Console:** `__ball.log()` prints the transition log; `__ball.snapshot()` the compact state.

---

## TESTING

- `tests/ball-contact.test.js` (run with `npm test`): the solver (end points, floor, continuity,
  frame-rate independence), detection on the real clips, and full headless game scenarios through
  `ball-session.mjs` with the real `Player`, MHR skinning and clips: right / left stationary
  dribble, crossovers both ways, jog, backpedal, lateral, diagonal, sprint, a combo, an
  interruption, at 30 / 60 / 120 fps, on four characters of different height and arm length.
  Checked every tick: no floor penetration, no teleport, catches at the expected hand, bounces at
  the target, only allowed transitions, no NaN, correct ownership.
- `tests/ball-court.spec.js`: the real court in Chromium (Playwright) running the same scenarios
  on the VANTHEAH court, with screenshots of each move in Ball Debug Mode.

Results of the latest run are at the end of this document.


---

## RESULTS (2026-09-30)

**Automated (`npm test`, 86 tests, all passing):** `tests/ball-contact.test.js` — 25 tests:

| Group | Tests |
|---|---|
| Solver | end points, C1 at the release, never below the floor, closed-form velocity, believable restitution, continuous re-targeting, frame-rate independence |
| State machine / state | invalid transitions rejected and logged; compact snapshot restores the same path |
| Contact edits | validation |
| Detection | the recorded between-the-legs → cross → shot take: release R 9.1, bounce 11.5 (cleared of the legs), catch L 13.7, release L 23.1, bounce 24.3, catch R 25.8, shot 59.5; exactly two floor contacts |
| Game (60 fps, player rig) | right / left stationary dribble, crossovers R→L and L→R, forward jog, backpedal, sideways, diagonal, sprint, crossover → spin combo, interruption (a request mid-flight waits for the catch), the recorded move (two floor contacts, through the legs, shot, pass back) |
| Frame rate | the same crossover at 30 and 120 fps: same bounces, same timing relative to the move |
| Characters | guard (1.75 m, arms 0.98), big (2.11 m, arms 1.08), AC (1.93 m) |

Every game tick is checked for: NaN, rejected transitions, floor penetration, loss (LOOSE),
failsafe recoveries, catches at the expected hand, teleports (a step longer than the ball's speed
allows), pops (acceleration beyond 40 g not caused by the hand), ownership, leg clearance of
controlled flights, IK reach.

**Visual (`node tests/ball-court.spec.js --fps 30`)**, the real VANTHEAH court in Chromium with a
virtual clock, driven by the keyboard: idle dribble, jog, stop, sprint, change of direction,
crossover, crossover → spin, the recorded move — all passing (no loss, no recovery, no rejected
transition, never below the floor; the recorded move with exactly two floor contacts; catch errors
0.1–4.1 cm). Screenshots and a side-view contact sheet of the move in `tests/reports/ball-court/`.

## KNOWN REMAINING ISSUES

- **Fast dribbles hidden in holds.** The clip builder's 24 cm hold rule still merges very fast
  dribbles into a hold (the step-back's two pre-shot dribbles): the game clip never saw them leave
  the hand. Fixing it means keeping the raw tracked ball through the builder (a `BUILDER_REV` bump,
  which rebuilds every clip on the server).
- **Generated clips have no ball track.** Their bounces are placed by gravity timing under the
  move's path (confidence 0.35); the Contact Editor can place them exactly.
- **Very fast tempos.** At a jog the dribble clock runs 1.35× faster, so a hand → floor → hand
  dribble takes ~0.23 s and the ball travels ~10 m/s near the floor — honoured, but a hard dribble.
- **Held ball against a leg.** When the animation itself puts the hand at the knee (the
  between-the-legs catch behind the knee), the ball can still touch the leg by a few cm for a
  couple of frames after the 6 cm ease-out and the knee yield.
- **Contact edits on this Mac** are written into the local clip mirror (`data/mocap`); the next
  `npm run clips:pull` overwrites them. On Railway they persist in the clip store.
