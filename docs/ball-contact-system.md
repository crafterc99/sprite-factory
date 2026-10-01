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

**The character's own palm.** `palmThickness` (1.4 cm) is a mannequin's palm: a real character's
palm skin sits 3–5 cm in front of the palm centre (AC: the heel 53 mm, the thenar up to 67 mm), so
the ball on that target was 3–4 cm INSIDE the hand. With the rig's hand skin
(`contact-ik.mjs buildHandContact`, the session's `handContact`), each target is moved out along
`n` by `palmClearance` — just far enough that no palm vertex (heel, thenar / hypothenar, the pads
under the knuckles) is inside the ball — every tick, from the pose, and the skinned catch
prediction the same way. The IK uses the same per-hand thickness.

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
6. **Physics** (every clip, automatically — a clip needs no hand-made contacts). The per-frame hold
   flags come from the capture's hold rule (the ball within 24 cm of a palm, its depth taken from the
   nearest wrist), so a ball a low crossover pushed down a moment ago, or one rising past the other
   hand, still reads "held". Video tracks:
   - **a release the bounce makes impossible** — the launch it needs is > 6 m/s harder than the hand's
     own motion (a push throws the ball faster than the hand moves, never that much faster) — moves
     back to where the ballistic launch and the hand's motion agree (≤ 0.45 s earlier); the bounce
     stays where the ball's own frames near the floor put it;
   - **the clip's last catch, a moment after a bounce near its end**, that the rebound (e ≈ 0.82 of the
     speed it came in with) cannot reach by then is a rising ball passing a hand (two hands near it):
     the catch is on the last frame (or when the rebound reaches the palm), by **the hand the flight
     heads to** — the side of the body it goes to (along the hips; a ball well across the midline is
     that side's hand), then the nearer palm, the flight extrapolated with its horizontal velocity
     and its rebound to when it reaches the palms → the clip's `exitHand`.
   Every clip: **a last release never caught in the clip** (a dribble move whose last bounce is after
   its end) is caught on the last frame by the hand it heads to (bounce fitted), or — under 0.15 s
   before the end — the hand keeps the ball. (It was let go to the physics: the ball was lost.)
   A bounce spot fitted from one side only (the other side's frames were on the hand) takes that side's
   line, not the hand anchor. The user's double crossover (IMG_5866) with its saved contacts removed:
   release R 5.1 · bounce 6.6 · catch L 9.6 · release L 22.4 · bounce 29.3 · catch R 32 (its last
   frame), entry and exit right — the hand-made set ± 0.6 frame (it was: release L 28.1, catch **L**
   30.9, exit left: the cross back never changed hands). Every other clip's detection is unchanged,
   except the generated crossovers' last flights (caught at the end, or kept).

### One floor contact per dribble (`ensureBounces`)

Every release → catch flight — the hand that lets go to the hand that takes it, the same or the other — is read from
the motion itself, for detected and saved (Contact Editor) sets alike:

- it **goes down** when the ball's own captured frames are well below both hands (a ballistic flight between two hands
  never comes lower than the lower of them: below that it has bounced), or the releasing palm pushes down (≤ −0.4 m/s)
  to a catch not much lower, or it already has a bounce → **exactly one** floor contact: none — one is put in, WHEN
  gravity puts it (the drop from the release height and the rise to the catch height, √h each; the captured ball's
  lowest frame when it is near the floor then), WHERE the motion puts it (between the legs: under the hips, between the
  feet, on the line from the releasing hand to the catching one; else where the captured ball came lowest; else under
  the hands' path; out of the legs); two or more — the one nearest that time stays;
- it **stays up** (a hand-off above the knees): no floor contact (a toss).

The sweep checks it on every clip's contacts (both hands, saved and automatic) and on every flight the game plays.

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

**The floor contact, from the motion** (`ball-trajectory.mjs planBounce`, the session's `planFlight`). At every
release the bounce of the flight is planned — WHERE and WHEN the ball meets the floor:

- the contact's own flight (its spot, its time chosen in its window, as above) is kept when it is physical (restitution
  0.55–0.95, ≤ 9.8 m/s into the floor), lands in the gate when the hands' path goes between the legs, and is clear of
  the body;
- **between the legs**: when the hands' path (release → catch, on the floor) crosses between the feet, the spot is the
  point of that path under the hips, between the feet (`gateCrossing`);
- **clear of the body**: the body is the rig's own skin (`buildBodyContact`: legs + torso of the LOD0 mesh thinned to one
  vertex per 2.5 cm, skinned only where a flight can reach) as it will be during the flight — a move's own future pose
  every 1/60 s (the skeleton solved at that clip time with the move's root motion, offset by how the drawn body differs
  from the clip's own now: planted feet held, the legs solved to them), the dribble layer's pose now. The flight (every
  1/120 s) must stay 1 cm clear, its floor contact 2 cm (and clear of the leg capsules the reactive clearance steers by),
  tapering to 4 mm within 8 cm of a hand; near a hand the capture itself puts in the body (the double crossover's catch at
  the shin, the btl's behind the calf) the ball may be as deep as on that hand, tapering over 20 cm;
- otherwise it is re-planned **from** the contact's own flight: only its clearance failed — its time stays and its spot
  moves away from where the flight touched the body (by how much the bounce moves the ball there), kept unless that
  clears it by ≥ 3 mm more; its physics or the gate failed — every time of the window is tried, each candidate scored
  by restitution (0.78), impact (≤ 8.5 m/s), the hand's own velocity at the release (a push down is fine), the
  horizontal speed kept through the bounce (a little lost, never turned back), distance from the motion's spot, and how
  far short of clear it is; a physics re-plan has to score 0.1 better than the contact's own. The dribble layer keeps its
  tempo (its loop's catch frames are built for its own bounces).

The planned spot rides on the schedule's re-predicted one (the body moves on, the choice stays). Cost: 1–5 ms a release
(a best-effort btl ~10–15 ms). Every plan is logged on the release (`contact` / `spot` / `moved` / `gate` /
`best-effort`, why the contact's own was not kept, its clearance); `session.lastPlan` has the last one.

**The floor contact is drawn.** The tick nearest each bounce shows the ball ON the floor at the bounce point (state
`BOUNCE`, one tick: the bounce instant, ≤ half a tick from the tick's time), the next one rising from it. Drawn at the
tick's own time a bounce is up to v·dt/2 above the floor on both sides — at 9 m/s and 30 fps 15 cm: the ball was never
seen touching the floor (the user: "it doesn't bounce off the ground"). The path is unchanged; `out.drawT` names the
instant drawn (the harness measures steps and accelerations over the drawn instants).

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
the knee yields up to 5 cm, hip and ankle fixed — by how deep the ball is in that leg's own skin (never less than its
capsule says), out at once, eased back (40 ms).

**Fingers:** the hand's own skin against the ball (`contact-ik.mjs resolveHandBall`, the
session's last step every tick, in every state; see *Hands never inside the ball* below). A rig
with no mesh falls back to the joint passes (`conformFingers`, `clearHandsOfBall`).

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

**Input buffer.** Requests queue (up to 3, 1.2 s each — a 4th pushes the oldest out, dropped like any other: a queued
shot's armed meter goes with it) and fire at the next valid window: the ball
held by the move's entry hand, not within 60 ms of a release. Hesitation → crossover → sprint plays
in order. A request carries its source: a newer right-stick gesture replaces the stick's queued one
(`requestMove(role, t, { src: 'stick', replace: true })`), so the stick never builds a backlog.

**Pro stick (the right stick).** `engine3d/pro-stick.mjs`, shared by the court and the harness: the
recognizer (flick on the return · hold 220 ms at the rim · spin ≥ 75° along the rim in 500 ms; one
gesture per push), the stick read on the screen and turned into the player's frame (θ 0 forward,
+90 toward the free hand — the ball hand is the holding hand, else the hand a flight goes to), the
sectors (|θ| < 35 hesi · 35–105 crossover · 105–150 between the legs · ≥ 150 behind the back ·
−150…−105 step-back · −105…−35 in-and-out) and the role chain (a missing clip falls back to the next
move, or shows "no clip yet"). **The double crossover** (`move-double-cross`, the user's IMG_5866 — live on
main as "right stick: flick left, then right"): a crossover flick, then within 0.5 s a flick turned
≥ 120° back from it while the ball is still in (or on its way back to) that hand — with the ball in the
right hand and the chase camera exactly left, then right (the left hand: right, then left, and its mirror
plays). It replaces the queued crossover, or takes over the crossover in its pre-release hold (the
interruption window); once the crossover has let go of the ball, the flick back is a crossover back — and a double
crossover recognised with the ball in one hand that waits (the crossover past its interruption window) and fires from the
other hand is a crossover back too (the request carries the hand it was read in: never the mirrored double crossover).
The recognizer lets a full flick straight back through its 150 ms cooldown, and a stick swung straight
across between two samples (a low frame rate never reads the centre) is two flicks, not one. Keyboard:
← then → quickly, or **L**; touch: two swipes. The controller camera stays on the D-pad (← → orbit,
↑ ↓ zoom), as on main. Gestures are ignored without the ball, while □ is held and while a
shot plays (logged, never buffered). `window.__stick.log()` lists every gesture; Ball Debug Mode
has a `stick` line. `?pad=classic` restores the face-button moves.

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

**Shots and passes.** A shot clip's gather and set are held (`HELD_BOTH` or the shooting hand); at
the release frame the ball enters `SHOT_RELEASE` and Rapier flies it. A pass back from the
rebounder is a controlled `PASS_RELEASE` flight that meets the player's catching hand.

**The release frame** (`lib/mocap/motion-builder.js` `inferShotRelease`, runtime copy
`engine3d/shot-release.mjs`). A shot filmed close leaves the top of the picture while still in the
hands; the frame the ball vanished is not the release. When the ball was never seen clear of the
picture's edge after the last hold (report `shotRelease.source` `left-picture` / `lost`), the
release is where the shooting arm straightens (shoulder→wrist ≥ 0.88 of the arm's length; an arm
that never does releases at its wrist's highest point, ≤ 0.6 s after the last seen hold) and the
hold runs on to there. A release that was seen (`source: 'seen'`) is never moved. At load, a shot
clip with no usable release (none, or on its last frame) gets one the same way (`anim3d`
`shotReleaseGuard`), so a shot always lets go of the ball.

**The held ball clear of the hands** (`engine3d/ball-fit.mjs`). A capture's hands can be closer
together than the ball is wide (hands guessed off-screen), and a palm target can face into the
other hand. In a two-hand hold, and in any hold of a shot's last 0.5 s, the ball is fitted out of
the rigid hand (palms, knuckles, thumb bases), forearms, upper arms, head and chest — the smallest
move; in the last 0.3 s before a release, the nearest clear place on the launch side. The fit
eases in and out (critically damped, ≤ 2 m/s) and its motion is the ball's (no teleport, no pop).

**The shot** (`engine3d/shot-flight.mjs` `planShot`). From where the ball is on the release tick
(this tick's hands; a release point still touching the hand is moved just clear), the arc to the
rim: a 47° entry angle, apex ≥ 45 cm over the rim, the launch velocity exact under gravity and the
ball's air drag, backspin. The ball ↔ player-body contacts are off until the ball is 3 cm clear of
the thrower (≤ 0.5 s) — the kinematic hands it leaves would otherwise swallow the throw. Its flight
starts on the next tick. The outcome is a make unless a shot meter graded the release:
`session.setShotInput({ quality: 0…1, timing: 'early' | 'late' | 'perfect' })` (or `{ outcome }`)
before it — swish / make / rim-make / rim-out (a seeded roll) / short / long / airball, each aimed
where it says. `Player.shotTiming()` gives the playing shot's time to its release (the meter's
target); `session.lastShot` the result (`through`, `minRimDist`, `maxY`). In the court:
`window.__shot = { timing(), input(x), last() }`, and Ball Debug Mode draws the planned arc.

**The shot meter** (`engine3d/shot-meter.mjs`, NBA 2K style). Hold □ (I / Space, the touch
SHOOT button): the press starts the shot (buffered to a valid window like any move) and the bar is up
at once, empty until the shot clip starts. **The animation is the timer**: the bar fills with the shot
clip from its first frame (the frame it was entered at) and reaches its white mark exactly on the clip's
release frame — the same frame the ball leaves the hands; letting go there is the perfect release. It is
timed in the clip's own time (`action.t` / `fps`), so every clip has its own window at its real speed and
the Speed slider scales it: the jump shot fills over 0.9 s (30 fps, released on 27), the step-back over
1.27–1.53 s (15 fps, released on 23, entered at 0–4), the between-the-legs → crossover → shot combo over
its whole 2 s (resampled from its 20 fps / 8× slow-motion capture to real time at 30 fps by the clip's
timeMap: released on 60) — mirrored clips the same. Above the mark the top fifth of the bar is the late
zone, one scale for every clip (0.3 s: the green band looks the same); the late zone itself runs to the
clip's end (at least 0.3 s), and held to its end the shot grades itself VERY LATE. The key / touch release
is taken at the moment it came up between two frames (a controller's button: halfway through the frame
it is seen up in; a release after the shot clip ended is graded at that moment on the meter's own clock —
`buttonMoment`). The bar is big (22–40 px × 170–360 px: 3.2 vmin × 34 vh) with the label in a dark pill
above it, and it sits above every other HUD panel (z 12; only the loading screen covers it). One press is
one shot: a button still held after a dropped request or a new ball must come up first (no
auto-repeat), the press that asks for a new ball (a tap on the touch SHOOT button, ✕ / X with □ down) is
not a shot, and neither is a press with no ball (held through the shot's flight, it never shoots the pass
back the moment it arrives); a tap, then held again before the shot started, is the same shot timed by
the hold. The touch SHOOT button gives a new ball on its press only, and not while a shot is in the air.

**No roll: the timing sets the flight** (`aimOf`). The animation is always the same clean clip; only the
ball's flight changes, deterministically and continuously within a band:

| Release (from the release frame) | Label | The ball (on Rapier, both boards, 1.2–11 m, every angle) |
|---|---|---|
| ≤ 80 ms either side | EXCELLENT (the green window) | the clean swish — today's perfect flight, touching nothing |
| 80–160 ms early | SLIGHTLY EARLY | short onto the front of the rim, out (dz −0.20 … −0.30 m) |
| 160–260 ms early | EARLY | clearly short of the net: an air ball (dz −0.50 … −0.75) |
| beyond, or a tap | VERY EARLY | an air ball, shorter the earlier (dz −0.80 … −1.30) |
| 80–160 ms late | SLIGHTLY LATE | a bit long onto the back of the rim, out (dz +0.18 … +0.22) |
| 160–260 ms late | LATE | too hard: off the glass, out (dz +1.05 … +1.15, 6° flatter) |
| beyond, held to the clip's end | VERY LATE | harder off the glass — held to the end, the hardest (… +1.25) |

dz is where the ball's centre comes down through the rim's height, along the shot from the rim's centre.
**The physics stays honest** (`shot-flight.mjs planShot({ dz, pitch })` → `launchAlong`): the ball leaves
on the clip's release frame along the clean swish's heading — only its launch speed differs (slower:
short; faster: long), and a too-hard one is also 6° flatter; Rapier then flies it into whatever it meets
— the rim, the glass, nothing. From near the baseline (≥ ~60° off the board's axis) the glass is not in a
too-hard shot's path: it flies long, past the rim (out). A release known before the launch (early, or
within the green window) flies its flight from the launch. **Still held on the release frame** (any late
release — it can only be known after the ball left): the ball leaves on the clean swish; held past the
green window it is bent toward the late flight of the timing so far (`meter.lateNow()` — later only gets
harder: the back rim, then the glass), and to the final one once the button comes up. It is steered to
that flight's own point 15 cm past the rim's centre (short of the glass, `lateFlight`), arriving when that
flight would, ≤ 14 m/s², off 60 ms before it or once the rim / glass is touched — so it meets the rim /
the glass as that flight does. The bend this takes: ≈ 0.2 m/s for the back rim, 1.4–1.6 m/s off the glass
from 5.5 m (≤ 2.3 m/s anywhere — visible as the ball speeding up just after it leaves; the price of a
grade that only exists after the release frame). What the court shows — SWISH / MAKE / MISS / AIR BALL —
is what the ball did (the session's `make` / `shotEnd` events), never the grade. `window.__shotMeter =
{ view(), last(), history(), shot(), clipT(), cfg() }`; `?shotmeter=0` turns the meter off (the press
shoots, every shot a make); `session.setShotInput(x)` (the older quality / timing hook) still overrides
the meter.

**Hands never inside the ball — and never flared off it** (`contact-ik.mjs resolveHandBall`,
`BallSession.resolveHands`: every tick after the IK, before skinning, both hands). It works on what
is drawn: the hand's LOD0 skin (true 4-weight LBS of the matrices; `buildHandContact` sorts it once
per rig into the rigid palm — heel, the pads under the knuckles, the thenar — and the 16 phalanges,
thumb root + 5 × 3, with each joint's anatomical hinge and flexion limits; 24 samples per phalanx,
72 for the palm, every vertex for the final check):

1. **The palm rests on the ball.** A palm whose skin is inside is moved straight out along its
   normal by the arm (≤ 12 cm: a capture's two hands can be 15 cm apart around a 24 cm ball — the
   guide hand of the user's jump shot needs ~17 cm). A holding palm that is off the ball reaches back
   onto it (≤ 4 cm × arm scale) — not while the controller fits the ball off the hands' targets (a
   two-hand squeeze, a shot's launch pocket), where that would drive the fingers into the ball.
2. **Fingers wrap the ball, knuckle → tip.** Each phalanx turns about its hinge (within its limits)
   by the least extension that takes its skin out of the ball. The hand that holds the ball — or
   that it is flying to (the grip is on from the dribble's rebound: it only turns a phalanx near the
   surface, so the fingers close as the ball arrives, not after the palm has it) — flexes each one
   until its distal chain, as drawn last tick, touches the surface. A finger closes from the knuckle
   out at ≤ 24 rad/s (a hand closes on a ball in ≈ 50 ms; a joint never curls ahead of the one before
   it, so it never has to open again). Smoothing is one-sided: a correction the ball needs (more
   extension) applies at once; anything else eases toward its new target with a 40 ms half-life —
   a finger that was pushed out goes back onto the ball, a curl lets go at a release. A new
   possession grips at once. A free hand's finger turns out of an arriving ball at ≤ 10 rad/s and
   the arm moves the hand out for the rest (a hand pushed aside, not a finger flicked).
3. **A phalanx still inside with its joint at its limit** (a straight fingertip lying in the ball):
   the joints nearer the palm straighten the finger by the least that clears it. Anything left: the
   arm moves the hand out along the deepest skin's own outward direction (≤ 3 steps; first, for every
   hand — a hand moved out by a few mm reads better than its fingers flicked), then the fingers swing
   straight out (≤ 0.35 rad).
4. **A receiving hand that meets the ball early** (every clip — a generated crossover's hand snapping
   to its catch pose, a fast catch's hand sweeping onto the ball: its palm target within 3.5 cm before
   the planned catch, `ball-control` earlyCatchDist) **takes it then**: the catch blend / the hold
   settles the ball onto the palm instead of the ball pushing the hand back 15 cm (the catch event is
   marked `early`; the harness counts those apart from the catch error, which measures where a flight
   ended vs the palm).
5. **Every fingertip on the ball**: a holding finger flexes to its first touch, else as close as its
   flexion comes (it used to stay open when that was > 12 mm: a flare), never into the ball; a finger
   whose flexion arc misses the ball (off to the side of the hand) spreads at its knuckle toward it
   (≤ 0.3 rad, ≤ 8 rad/s). In a **two-hand hold** the holding hands are no obstacle of the ball fit when
   the rig has hand skin (`handSkin`): their palms are moved onto / out of the ball by their own skin
   contact — the fit used to push the ball onto the heels of the hands, the fingers far off it.
   Tried and left off (contact-ik HAND): shaping a receiving hand's grip around its palm target in the
   last 0.12 s (`preShape`: the jog / run catches 40 → 3 mm on AC, but on the stock rig the fingertips
   over-curl and redistribute in one tick when the ball lands) and a hard per-joint rate limit with the
   arm taking the rest (`jointRate`: the stock rig's pinky then closes late, 25 mm off).

Result (headless court, AC / player, 30 / 60 fps and 240 Hz ticks = the court at 0.25× speed,
every dribble, move and shot): the skin stays ≥ 1 mm outside the ball on every tick (it was 2–3 cm
inside with the joint passes); in a hold the palm is 3–4 mm off the surface and 3–4 fingertip pads
are on it. Flare, AC's idle dribble at 0.25×, 1× and 30 fps: every fingertip ≤ 4 mm and the thumb
≤ 3 mm off the ball on every tick the hand has it (the joint passes: middle / ring / pinky a median
44–66 mm off, joints flicked 1.1 rad in a tick); no finger joint is turned faster than the 24 rad/s
close; the clip's own fingers move ≤ 5 rad/s (no spikes in the capture). Moves and shots: the
fingertips are on the ball 90 % of the time (p90 ≤ 3 mm); a 10 m/s spin catch or the shot's launch
pocket lifts one for a tick or two. ≈ 0.5–1 ms a tick for both hands. `session.lastHands` reports
each hand's depth / push; Ball Debug Mode shows it (`hands` line).
The clip sweep (`tests/clip-sweep.test.js`, below) measures every clip of the library this way.
Closed: the generated crossover's receiving hand that snapped into the ball and was pushed back
15 cm (the early catch); the spin's thumb 11 cm off at its catch (now ≤ 7 mm); two-hand holds whose
fingers pointed away from a ball fitted onto the heels of the hands (the step-back 11 → 5 cm, still
open). Still open — see KNOWN REMAINING ISSUES and the clip sweep's numbers below.

---

## DEBUGGING

**Ball Debug Mode:** press **B** in the court (or the **Ball** button in the top bar, or open the
court with `?balldbg=1`). It shows:

- ball state, current move, normalized time, expected hand, hand distances, IK weights, ball
  velocity, recoveries and the transition log;
- `BallTarget_L` (blue) and `BallTarget_R` (red) spheres;
- release (yellow), bounce (cyan ring on the floor) and catch (green) points;
- the trajectory: hand ● ─── bounce ● ─── hand ●, past (dim) and planned (bright); a shot in the
  air: its planned arc (the bent rest of it once a late grade steered it);
- the shot meter's phase and the last shot: its grade (ms off the release frame) → outcome, bent in
  the air or not, in / out (`__shotMeter.history()` in the console);
- a timeline of contact windows with the current time.

**Contact Editor:** open a clip in replay mode, `court3d.html?replay=<motionId>&contacts=1` (or
the **Contacts** button in the replay bar). It shows the timeline, the current frame, the ball
height and both palm distances, and markers for every release, bounce and catch (orange = low
confidence). You can add markers at the current frame, drag them, change the hand, the windows and
the trajectory profile, drag the bounce target on the floor, and set the palm offsets. **Save**
writes the clip's contact metadata; **Auto** restores the detected set. A saved bounce that was never
placed on the floor (no `local`) gets a spot at load (`mergeContacts`): the detected bounce at that
moment, else the captured ball's lowest point near it, else under the hands' path, out of the legs —
it still bounces on the floor (it used to fly hand to hand: the double crossover's saved set).

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
  on the VANTHEAH court, with screenshots of each move in Ball Debug Mode; both shots are taken with
  the shot meter (I held, let go one frame before the release frame: EXCELLENT, a swish).
- `tests/pro-stick.test.js`: the recognizer at 30 / 60 / 120 fps (flicks, holds, spins, rebounds,
  NaN), the arrow keys, the stick → θ → move mapping (chase and side cameras, the sector edges), the
  role fallbacks and the gates. `tests/ball-contact.test.js` "pro stick": the gestures through the
  headless game (crossovers both ways, the spin, between the legs → crossover, a hold = one move,
  gestures during a move, the stick during a shot). `tests/pro-stick-court.spec.js`: the real court
  with a synthetic gamepad (every gesture, R3, the D-pad, a side camera, the keyboard, the touch zone,
  `?pad=classic`).
- `tests/shot-meter.test.js`: the meter's grades in clip time for every shot clip (the jump shot,
  the step-back entered at 0–4, the combo, mirrored; 30–120 Hz ticks; 1× / 0.5× / 0.25× speed), the
  bar on its mark on the frame the ball leaves, the timing → flight map (short / front rim / swish /
  back rim / off the glass — more short the earlier, harder the later), taps, held shots — and every
  band on Rapier from 120 spots on both boards, the late ones steered in the air as the session does;
  per shot clip, a release in each band → its flight. `tests/ball-contact.test.js` "the shot meter":
  the real shot clips through the headless game (with the court's backboard) — EXCELLENT swishes in
  each clip's own window, and a release in every band does what its band says (the first thing the
  ball meets, in or out, the result shown). `tests/shot-meter-court.spec.js`: the real court at iPad
  size, the jump shot released once per band, filmed (the meter on the press, the label, what the
  ball met, the result) — `tests/reports/shot-meter/`.

- `tests/clip-sweep.test.js` (`tests/helpers/clip-sweep.mjs`): **every clip of the library with a
  runtime role**, each alone in its role, from both hands (as filmed and mirrored), the user's double
  crossover with its saved contacts and with its automatic ones, through the game tick on AC at 60 fps.
  Every tick: the hand skin ≥ 1 mm outside the ball; a contact hand's fingertip pads ≤ 6 mm off it
  (the thumb ≤ 8 mm); no finger joint turned > 26.5 rad/s beyond the clip's own motion; the body's own
  skin (torso + head, legs) never entered by a flight (≤ −2 mm) and a ball on the hand ≤ 3 cm into it;
  never lost, no recovery, no rejected transition, no NaN, never under the floor, catches ≤ 6 cm off
  the palm; the clip played as itself. A clip uploaded later is held to these limits; the clips with a
  known residual (`tests/fixtures/clip-sweep-known.json`, per case "clip · hand") to its measured value + 0.2 mm /
  0.2 rad/s (better passes and asks to tighten it; `SWEEP_WRITE_KNOWN=1` rewrites it from a run). STRICT on every clip,
  never a ceiling: each bounce's ball bottom on the floor ± 3 mm (its path at the bounce instant and as drawn on the
  bounce tick), no flight under the floor (> 0.5 mm, every tick and the planned segments between ticks), every dribble
  that goes down exactly one floor contact (a hand-off none — and every clip's contacts the same), the flying ball (off
  both hands by > 3 cm, the catch blend included) never in the body skin (near a hand the capture puts in the body, no
  deeper than the ball on that hand). Report: `tests/reports/clip-sweep.json`.
- `tests/btl-bounce-court.spec.js`: the real court, the between-the-legs move on AC — each of its two bounce frames frozen
  and filmed from the front, the side and the back, every 2nd frame from its first dribble to the crossover's catch
  (every frame while the ball is in the air), the floor contact checked (± 3 mm) and the btl one between the feet.
  `tests/reports/btl-bounces/`.

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
With the shot meter (AC, 30 fps): the jump shot and the between-the-legs shot, I held and let go one
frame before the release frame — EXCELLENT (−33 ms) → SWISH, the bar on screen through the rise
(`6a-jump-shot-meter-*.png`, `7-btl-shot-meter-*.png`).

## RESULTS (2026-10-01): the clip sweep, before → after

`tests/clip-sweep.test.js`, AC at 60 fps, every runtime clip of the library alone in its role, from both hands
(worst tick of each run; "into body" < 0: clear of the skin). The hand skin is ≥ 1.0 mm outside the ball on every
tick of every run, before and after. `npm test`: 180 tests, 179 pass — the garments cost check under load (7.8 ms
with Blender jobs running; alone 8/8).

| Clip · hand | fingertip off (mm) | thumb off (mm) | joint added (rad/s) | flight into body (mm) | ball on hand into body (mm) | lost / recoveries |
|---|---|---|---|---|---|---|
| move-double-cross-r-t01 · right | 7 → **6** | 19 → **17** | 31 → **32** | -63 → -63 | 95 → 97 | 0/0 → **0/0** |
| move-double-cross-r-t01 · left | 7 → **6** | 18 → **16** | 28 → **32** | -95 → -74 | 96 → 98 | 0/0 → **0/0** |
| shot-jumper IMG_5816 · right | 69 → **46** | 18 → **16** | 40 → **40** | -63 → -63 | 59 → 59 | 0/0 → **0/0** |
| shot-jumper IMG_5816 · left | 69 → **46** | 20 → **18** | 49 → **49** | -102 → -102 | 77 → 77 | 0/0 → **0/0** |
| move-btl-cross-shot-r-t01 · right | 49 → **40** | 13 → **12** | 53 → **53** | -19 → -19 | 40 → 40 | 0/0 → **0/0** |
| Step back jumpshot · right | 108 → **47** | 9 → **7** | 53 → **74** | -63 → -63 | 110 → 110 | 0/0 → **0/0** |
| Step back jumpshot · left | 111 → **55** | 10 → **6** | 76 → **41** | -102 → -102 | 109 → 109 | 0/0 → **0/0** |
| move-spin-layup-r-t01 · right | 72 → **58** | 111 → **7** | 68 → **57** | -12 → -12 | 46 → 46 | 0/0 → **0/0** |
| move-spin-layup-r-t01 · left | 70 → **62** | 110 → **7** | 70 → **57** | -10 → -10 | 47 → 47 | 0/0 → **0/0** |
| Crossover cut · Kimodo · right | 47 → **44** | 12 → **13** | 34 → **27** | -14 → -14 | 5 → 5 | 202/0 → **0/0** |
| Crossover cut · Kimodo · left | 46 → **43** | 13 → **14** | 33 → **39** | -15 → -15 | 6 → 6 | 204/0 → **0/0** |
| Crossover on the move (generated) · right | 3 → **4** | 3 → **3** | 48 → **50** | -39 → -39 | -17 → -17 | 152/0 → **0/0** |
| Crossover on the move (generated) · left | 3 → **5** | 3 → **3** | 53 → **54** | -41 → -41 | -18 → -18 | 152/0 → **0/0** |
| Crossover (generated) · right | 5 → **9** | 3 → **5** | 43 → **24** | -20 → -20 | -14 → -14 | 0/0 → **0/0** |
| Crossover (generated) · left | 3 → **4** | 3 → **3** | 50 → **51** | -19 → -19 | -14 → -14 | 0/0 → **0/0** |
| Jog dribble · Kimodo · right | 40 → **39** | 3 → **3** | 24 → **24** | -63 → -63 | -56 → -56 | 0/0 → **0/0** |
| Jog dribble · Kimodo · left | 40 → **39** | 3 → **3** | 24 → **24** | -86 → -86 | -52 → -52 | 0/0 → **0/0** |
| Run dribble (generated) · right | 37 → **36** | 3 → **3** | 24 → **24** | -63 → -63 | -74 → -74 | 0/0 → **0/0** |
| Run dribble (generated) · left | 37 → **36** | 3 → **3** | 24 → **24** | -71 → -71 | -69 → -69 | 0/0 → **0/0** |
| Idle dribble · right | 3 → **3** | 3 → **3** | 24 → **24** | -63 → -63 | -74 → -74 | 0/0 → **0/0** |
| Idle dribble · left | 3 → **3** | 3 → **3** | 24 → **24** | -102 → -102 | -69 → -69 | 0/0 → **0/0** |
| move-double-cross-r-t01 [auto] · right | 103 → **6** | 12 → **16** | 61 → **32** | -50 → -63 | 92 → 92 | 0/0 → **0/0** |
| move-double-cross-r-t01 [auto] · left | 102 → **6** | 12 → **15** | 61 → **32** | -76 → -76 | 94 → 94 | 0/0 → **0/0** |

What changed it: the automatic contacts (the double crossover's own: fingertips 103 → 6 mm, catch error 17 → 1.5 cm;
the generated crossovers no longer lose the ball), the early catch (the generated crossover's hand that snapped into
the ball), every fingertip flexed to the ball (or spread toward it) instead of left open past 12 mm, the two-hand fit
that no longer pushes the ball onto the heels of the hands. What did not: see KNOWN REMAINING ISSUES.

## RESULTS (2026-10-01, later): the floor contact

The user: "on the new between-the-legs move the ball goes between the legs but doesn't bounce off the ground — the twice
it's supposed to within the animation". Measured on `mo-mulp87wqvabn` (AC, the harness and the court):

- **Before.** Both floor contacts were in the plan (the path reached `floorY + R` at the bounce instant), but no frame
  ever showed them: every bounce was drawn on the tick after it — the btl 2–7 cm and the crossover back 8 cm above the
  floor at 60 fps; in the court at 30 fps 66 mm and 25 mm (`tests/reports/btl-bounces/ac-001-30fps-before/`). Across the
  library the drawn bounce was 76–242 mm off the floor (the spin's 13 m/s slam). The between-the-legs bounce was 12 cm
  IN FRONT of the feet's line next to the left foot (the capture's spot), and the flight up to the left hand behind the
  calf went 4 cm into the left leg; the crossover back hit the floor at 11.5 m/s.
- **After.** Floor contacts at clip frames **11.5–11.7** and **24.8–25.1** (30 / 60 / 120 fps; the contacts: 11.5, 24.3),
  the ball's bottom **0.00 mm** off the floor at each — its path at the bounce instant and as drawn on the bounce frame.
  The btl bounce between the feet (0.41–0.44 along the line from the left foot to the right) and 15–17 cm behind the
  feet's line toward the hips (31 cm behind it): under the body. The crossover back 10.2–12.3 m/s into the floor
  (e 0.80–0.86). Screenshots: `tests/reports/btl-bounces/ac-001-30fps/`.

The clip sweep (AC @60, every clip from both hands; "floor contact drawn" = the worst bounce of the run; "flight into
body" > 0: into the skin, "(hand)": within 20 cm of a hand the capture puts in the body):

| Clip · hand | floor contact drawn (mm) | flight into body (mm) | fingertip (mm) | thumb (mm) | joint (rad/s) | held into body (mm) |
|---|---|---|---|---|---|---|
| move-double-cross-r-t01 · right | 85 → **0.0** | 33 → **34** (hand) | 6.1 → **6.1** | 17.1 → **17.4** | 32.2 → **29.4** | 97 → **97** |
| move-double-cross-r-t01 · left | 85 → **0.0** | 34 → **36** (hand) | 6.3 → **6.3** | 16.1 → **16.3** | 31.9 → **32.2** | 98 → **98** |
| shot-jumper IMG_5816 · right | 76 → **0.0** | -62 → **-62** | 46.2 → **46.2** | 16.2 → **16.2** | 40.3 → **28** | 59 → **59** |
| shot-jumper IMG_5816 · left | 80 → **0.0** | -69 → **-69** | 45.6 → **45.6** | 18.3 → **18.3** | 48.7 → **26.5** | 77 → **77** |
| move-btl-cross-shot-r-t01 · right | 81 → **0.0** | 40 → **28** (hand) | 40.4 → **40.4** | 12.0 → **6.4** | 53.3 → **45.6** | 34 → **24** |
| Step back jumpshot · right | 76 → **0.0** | -62 → **-62** | 47.4 → **47.4** | 7.2 → **7.2** | 73.7 → **48.2** | 110 → **110** |
| Step back jumpshot · left | 80 → **0.0** | -69 → **-69** | 54.6 → **54.6** | 6.3 → **6.3** | 41.1 → **41.1** | 109 → **109** |
| move-spin-layup-r-t01 · right | 242 → **0.0** | 28 → **-8.4** | 57.5 → **22.3** | 7.3 → **8.1** | 57.2 → **48.2** | 46 → **46** |
| move-spin-layup-r-t01 · left | 241 → **0.0** | 37 → **-11** | 62.4 → **20.0** | 6.7 → **8.3** | 57.2 → **36.8** | 47 → **48** |
| Crossover cut · Kimodo · right | 76 → **0.0** | -14 → **-17** | 44.4 → **44.4** | 12.5 → **11.8** | 27.2 → **27.2** | 5.4 → **0.6** |
| Crossover cut · Kimodo · left | 80 → **0.0** | -15 → **-17** | 43.2 → **43.8** | 13.8 → **12.1** | 39.2 → **39.2** | 5.6 → **2.7** |
| Crossover on the move (generated) · right | 76 → **0.0** | -39 → **-39** | 4.2 → **4.2** | 3.2 → **3.2** | 49.5 → **49.5** | -17 → **-21** |
| Crossover on the move (generated) · left | 80 → **0.0** | -41 → **-41** | 4.5 → **4.5** | 3.2 → **3.2** | 53.8 → **53.8** | -18 → **-22** |
| Crossover (generated) · right | 76 → **0.0** | -20 → **-35** | 8.6 → **8.6** | 4.5 → **4.5** | 24.2 → **24.2** | -14 → **-14** |
| Crossover (generated) · left | 80 → **0.0** | -19 → **-35** | 4.2 → **4.2** | 3.2 → **3.2** | 50.9 → **50.9** | -14 → **-14** |
| Jog dribble · Kimodo · right | 103 → **0.0** | -62 → **-62** | 38.9 → **39.1** | 2.8 → **2.8** | 24.2 → **24.2** | -56 → **-56** |
| Jog dribble · Kimodo · left | 108 → **0.0** | -62 → **-62** | 39.1 → **39.2** | 2.5 → **2.5** | 24.1 → **24.1** | -52 → **-52** |
| Run dribble (generated) · right | 110 → **0.0** | -62 → **-62** | 35.9 → **35.9** | 2.8 → **2.6** | 24.2 → **24.2** | -80 → **-80** |
| Run dribble (generated) · left | 115 → **0.0** | -69 → **-69** | 35.9 → **35.9** | 2.5 → **2.5** | 24.1 → **24.1** | -74 → **-74** |
| Idle dribble · right | 76 → **0.0** | -62 → **-62** | 3.1 → **3.1** | 2.8 → **2.8** | 24.2 → **24.2** | -80 → **-80** |
| Idle dribble · left | 80 → **0.0** | -69 → **-69** | 3.1 → **3.1** | 2.5 → **2.5** | 24.1 → **24.1** | -74 → **-74** |
| move-double-cross-r-t01 [auto] · right | 76 → **0.0** | 35 → **38** (hand) | 6.2 → **6.2** | 15.7 → **15.7** | 32.1 → **32.1** | 92 → **94** |
| move-double-cross-r-t01 [auto] · left | 80 → **0.0** | 36 → **37** (hand) | 6.1 → **6.3** | 15.4 → **15.9** | 32.2 → **32.2** | 94 → **94** |

Every dribble that goes down has exactly one floor contact (the game's flights and every clip's contacts), no flight
dips under the floor (≤ 0.1 mm: the solver's own tolerance). The step-back's 74 rad/s finger flick (the tick before its
release) is gone: a joint curls on at ≤ 6 rad/s while the next joint of its finger is curled onto the ball (`HAND.shiftRate`).

## KNOWN REMAINING ISSUES

- **A ball arriving at a hand the capture puts in a leg.** The between-the-legs catch behind the left calf and the
  double crossover's low catch at the left shin: the ball on that palm is itself 4–10 cm into the leg's skin, so the last
  ~20 cm of the flight into it are up to 2.8 cm (btl) / 3.6 cm (double crossover) in the leg — the sweep allows a flight
  near such a hand to be as deep as the ball on it (and no deeper). Pushing the arriving / held ball out of the skin
  (tried: a skin-accurate push, capped at 6 cm) jittered and pulled the hands off the ball. The between-the-legs bounce
  itself is the "best-effort" plan for that reason (≤ 5 mm short of its 1 cm margin near that catch).
- **Hand residuals still above the limits** (`tests/fixtures/clip-sweep-known.json`, per case): the generated
  crossover's fingertip 8.6 mm at its early catch (without the early catch 5.2 mm, but its finger joints 24 → 44 rad/s);
  the Kimodo cut's pinky pushed open by the ball arriving into the pre-curled catching hand (39.2 rad/s; it was 33.1
  before the grip rework); the spin's thumb 8.1 / 8.3 mm after its re-planned second dribble (was 7.3 / 6.7; its
  fingertips 58 / 62 → 22 / 20 mm).
- **Very fast tempos and slams.** A move's own timing may allow no believable bounce: the btl's crossover back is a
  0.12 s flight from the hip (10–12 m/s into the floor), the jog / run dribble clock forces a restitution ≈ 1 (kept: the
  dribble layer keeps its tempo).

- **Fast dribbles hidden in holds.** The clip builder's 24 cm hold rule still merges very fast
  dribbles into a hold (the step-back's two pre-shot dribbles): the game clip never saw them leave
  the hand. Fixing it means keeping the raw tracked ball through the builder (a `BUILDER_REV` bump,
  which rebuilds every clip on the server).
- **Generated clips have no ball track.** Their bounces are placed by gravity timing under the
  move's path (confidence 0.35); the Contact Editor can place them exactly.
- **Very fast tempos.** At a jog the dribble clock runs 1.35× faster, so a hand → floor → hand
  dribble takes ~0.23 s and the ball travels ~10 m/s near the floor — honoured, but a hard dribble.
- **Held ball against a leg or the chest** (the clip sweep's "body held"). When the capture itself
  puts the hand at the shin (the double crossover's low left-hand catch: frames 9–13), between the
  knees (the step-back's gather) or the ball at the face (the jump shot's set), the ball on the hand
  is up to 10–13 cm into the leg's skin / 5–9 cm into the head for a few ticks: the leg push is 6 cm
  with capsules of the limb's median radius, the head / chest are physics boxes smaller than the skin.
  Pushing the held ball 12 cm with the hand following (tried) cleared it to 7 cm but pulled the hand
  off the ball (fingertips 37 mm off on the double crossover) — not shipped. Flights never enter the
  body (≥ 1 cm clear on every clip).
- **Fingertips off the ball, still** (the clip sweep's known residuals, AC @60): the jog / run
  dribbles' catch tick (~4 cm, one tick); the spin's ~10 m/s catch (the hand sweeps onto the ball
  between two ticks: 2 ticks with fingertips 3–6 cm off, then on); a pass back caught at 6–12 m/s
  (one tick, ~5 cm); two-hand sets whose capture puts the ball on the heels of the hands (the
  step-back: ~10 ticks of 1–5 cm; the jump shot's set: 2 ticks); the Kimodo crossover cut's catch
  (2 ticks, 4 cm: the arm moves the hand out of a finger pose inside the ball); the thumb 1–2 cm off
  after some catches; a finger joint turned up to 40–75 rad/s in such a tick (24 in the dribbles).
  The sweep holds each to its measured value per case + 0.2 mm / 0.2 rad/s (`tests/fixtures/clip-sweep-known.json`).
- **Contact edits on this Mac** are written into the local clip mirror (`data/mocap`); the next
  `npm run clips:pull` overwrites them. On Railway they persist in the clip store.
- **The jump shot (IMG_5816) ends in the air.** Its landing was in the frames the capture service
  failed on (trimmed off); the clip now releases at frame 27 of 32 and returns to the idle from the
  air. A runtime landing (both feet off at the last frame) is a separate task.
- **Shot meter on a controller at a low frame rate.** A gamepad button has no event time: it is
  graded halfway through the frame it is seen up in (the keyboard and the touch SHOOT button: the
  moment between frames). At 20 fps that is ±25 ms of uncertainty against the ±80 ms green window.
- **A late release bends the ball in the air.** The grade of a release after the release frame only
  exists after the ball left; the flight is steered to it (≤ 14 m/s²) — up to ≈ 1.6 m/s off the glass
  from mid-range, 2.3 m/s from point-blank. A release that keeps the ball in the hands longer would need
  the animation to change (it is always the same clip).
- **A pass back is caught hard.** A made shot's rebound comes back from under the hoop (6–12 m/s);
  the catch stops it within two ticks (the harness counts a pass catch as an impulse, like a throw).
