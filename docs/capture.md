# Soul Jam Capture: two-phone recording for the animation library

Soul Jam Capture records a clean, synchronised, structured two-camera video dataset of basketball
moves, one animation at a time, for the mocap pipeline. Phone A is the director and camera A. Phone
B is camera B and needs no touching after pairing. Written for whoever runs a capture session, and
for engineers extending it.

The capture step is independent of any pose model. Processing (SAM 3D Body today, multi-view
reconstruction later) plugs in behind a processor interface.

## Run a session

**What you need:** two phones or tablets on tripods (the iPad directs and is camera A; a phone is
camera B), both online, the studio password (for the director only), and five cones or pieces of
tape for the floor. The iPad's header shows the steps — **1 Connect · 2 Calibrate · 3 Record ·
Animations · Analysis** — and a green / red dot for each camera. "Right" and "left" always mean
the athlete's, as he faces the hoop.

1. **Connect the phones.** On the iPad open `https://sprite-factory-production.up.railway.app/capture`,
   sign in, tap **New BASIC-01 session** and allow the camera. On the phone, scan the QR code on
   CAM B's tile (or open `/capture` and type the 6-digit code), then tap **TAP TO START CAMERA**.
   That is the phone's only touch: leave it on its tripod with the screen on and the page in front.
   - Both tiles show what each camera sees. Each camera then records a 2-second **camera check**
     by itself: ✓ means real video (bytes, frames, a file that decodes); ✗ says why ("CAM B
     recorded no usable video (…)"). Fix it (screen on, page in front) and tap **Run the camera
     check again**.
   - **NEXT** unlocks when both pass (it says where it goes: Calibrate, or Record when this
     placement is already calibrated). **Continue with one camera** records one view (no 3-D).
   - iPhone/iPad browsers record at most 60 fps; for 120/240 fps see *Frame rate* below.
2. **Calibrate (once per camera placement).** What it is for: it lets the two camera views be
   combined into 3-D later, so both cameras must see the whole area the athlete uses, head to feet,
   and must not move afterwards. There are two placements: one for setups A + B (top of the key and
   the drive lane), one for setup C (the rim).
   - Put the cameras where the screen says, in court words (e.g. "1.1 m inside the right
     sideline, 2.0 m up from the baseline"), lens at chest height, phone sideways.
   - Put a cone or tape on the middle (✕) and on corners 1–4; each is listed in court words.
   - Stand on each mark: you must be visible **head to feet** in both live pictures. If not, move
     that camera back (or tap **Wider** when the phone offers a wider lens).
   - Press **CALIBRATE** (both cameras must be READY). After the countdown, walk ✕ → 1 → 2 → 3 →
     4 → ✕ at an easy pace as the iPad calls out the corners (each lit on the map), then stand on ✕
     with your arms up. It takes about 21 s, stops by itself and saves:
     **Calibration saved ✓** with a still from each camera, then **NEXT: Record →**. With two
     cameras it is saved only when both recorded; otherwise it says why ("✗ Calibration not
     saved — …") and you press CALIBRATE again.
   - **Skip — cameras are placed; I'll calibrate later** also works.
3. **Record, one animation after another.** The screen shows `#12 of 82 · Setup A` with the slot's
   status, the name, and:
   - a court diagram with a green **START** mark, an orange **FINISH** mark and the path (one spot
     = START + FINISH on the same mark), seen from the cameras' side;
   - **START** (the pose, how it looks, and where: "0.3 m right of the middle, 1.8 m behind the
     free-throw line"), **THE MOVE** (direction, distance, cues), **FINISH** (the pose and where);
   - the protocol in one line: from a still pose, hold it 1 s → the move at game speed → hold the
     finish pose 1 s; a move that starts moving (moving dribble, sprint, slide) starts 2–3 steps
     before START and crosses it already moving; one that ends moving keeps going through FINISH;
     loops keep repeating. On a phone a one-line START → FINISH summary sits above the diagram.

   Press **RECORD**: a countdown (3, 5 or 10 s, kept on the iPad), then it records with a big timer,
   says **Go** / **Hold** out loud (the athlete can't see the iPad), and stops by itself (or press
   **STOP**; **CANCEL** in the countdown discards it). There is no review: the next animation to
   record comes up at once, and a toast says "recorded — uploading", then "saved", with **Redo**
   for a few seconds (it stays, with the reason, when the take failed or was cut short).
   - The take uploads and is checked in the background. It counts as **Recorded ✓** only once the
     server and the bucket have it; until then the list says **Uploading**.
   - **◀ ▶** browse the animations; **All animations** opens the list.
   - When a placement is finished, the app first says what is left there (redos, uploads), then
     asks you to move the cameras and calibrate the next placement.
4. **Animations** lists all 82 slots by setup, in capture order: name, start → finish pose and
   status (**Not recorded · Uploading · Recorded ✓ · Check failed — redo** with the reason ·
   **Analysed ✓**), a warning line when a take was cut short or has only one camera's view, and the
   totals. Filter **To record / All**. Tap a slot to see its takes (play, **MARK BEST**, attach a
   slo-mo file, **Use it anyway**, **Record it now / again**). **Export** is at the bottom.
5. **Analysis — later, when you choose.** Nothing is analysed by itself. Pick the recorded
   animations (all by default), the camera (A or B) and the frame rate, check the cost (about
   $0.03 per frame) and press **Send to analysis**, then confirm the amount. The server runs them
   one at a time, and you can close the page. Progress and errors (for example an empty fal.ai
   balance) show at the top; a failed one goes back to the list to send again.

Stop at any point: home → **CONTINUE MISSING** on the session goes to the next animation to record.

**On the Mac instead (same Wi-Fi, no internet needed):** start the studio with `bash mac-dev.sh`. Its log
prints the phone address, for example `Capture (phones, same Wi-Fi): https://10.0.0.83:3443/capture`.
Phones need HTTPS for the camera, so the Mac serves its own certificate: the first time, each phone
warns about it (iOS: *Show Details → visit this website*; Android: *Advanced → Proceed*). Takes are
then stored on the Mac (`data/capture`).

**If a camera is not recording,** the director says so within about 3 s of the start, in the
recording screen ("CAM B is not recording — keep its screen on and the page in front", or "CAM B
did not start recording" when its page was asleep). Phone B's own screen says the same. The take
does not wait for that camera: with two cameras it becomes **Check failed — redo**. The usual cause
is a locked screen or the page in the background. The app keeps the screen awake and the preview
playing, but a phone call or another app using the camera still stops it. **If a camera's uploads
don't arrive,** the director shows "CAM B upload: …" (and after 30 s "Waiting for CAM B's upload"
with **Go on without CAM B**); its recording stays on the phone until the server has it.

## What each screen shows

**Director:** a header with the stepper (**1 Connect · 2 Calibrate · 3 Record · Animations ·
Analysis**) and the CAM A / CAM B status, then the step:

| Step | Content |
|---|---|
| 1 Connect | Two camera tiles: a live picture (camera B sends a small JPEG every ~1.5 s), READY, resolution, fps, orientation, format and the camera check; pairing QR and code; the frame-rate note |
| 2 Calibrate | Why it matters; where each camera stands and where the floor marks go (court words); the diagram (camera positions, the area, corners 1–4, ✕); both live pictures (zoom when the phone has a wider lens); CALIBRATE (countdown → ~21 s walk with spoken corners → saved by itself) or Skip |
| 3 Record | `#n of 82 · Setup X`, name, START/FINISH diagram and court words, start pose, the move, finish pose, protocol; countdown 3/5/10 s, voice on/off; RECORD → countdown → timer → stops by itself; "Saved ✓" / Redo. On a phone a one-line start → finish summary sits above the diagram |
| Animations | All slots with status and totals; a slot's takes (play, MARK BEST, slo-mo file, "Use it anyway" for a failed check, record again); export |
| Analysis | Sent to analysis (running with progress, queued, done, errors); the recorded takes to send with checkboxes, camera, frames per second and the cost; Send to analysis with a cost confirmation |

**Camera** (phone B) is a full-screen preview with its role, format (resolution · fps · orientation ·
MP4/WebM) and one big status: `Connected ✓ — waiting for the director`, `● RECORDING`,
`Uploading 3…`, `✓ Saved`, or what went wrong. It also shows footage kept on the phone (SAVE TO PHONE /
DISCARD) and **USE THIS PHONE** when another page took its role.

## Architecture

```
capture/                       shared by the server and the browser (served at /capture/js/*.mjs)
  schema.mjs                   canonical states, the animation-definition schema + validation, state graph
  basic01.mjs                  BASIC-01 — the ONE source of truth for the 82 animations
  court-layout.mjs             court geometry + landmarks, camera placements (STATIONS), setups A/B/C (player paths,
                               mirrored by ball hand), the calibration walk and its timing, framing checks, SVG diagram
  instructions.mjs             what the athlete is told per animation: START / FINISH in court words, holds (or not, for
                               moves that start / end moving), the protocol, the cues and spoken words second by second
  protocol.mjs                 session order, progress / next missing, take lifecycle, real-time message types
  camera-sync.mjs              shared session clock (ClockSync), sync chirp definition, alignTakes / frameStats
  camera.mjs                   web camera: capability ladder, MediaRecorder chunks, frame timestamps, moved detection
  uploader.mjs                 IndexedDB-backed resumable uploader (souljam-capture-v2; in-memory fallback)
  app.mjs + capture.html       the app (director / camera modes)
lib/capture/
  store.js                     sessions, takes, calibrations, chunked uploads, atomic JSON, tar export
  hub.js                       WebSocket hub (/api/capture/ws): presence, clock pings, timed start/stop, relays, live snapshots
  cloud.js                     streaming + retrying mirror to Firebase / R2 (Railway)
  validators.js                the checks every recording gets in the background (pluggable), the camera-check verdict
  media.js                     ffmpeg: probe, still, motion map
  sync-audio.js                chirp matched filter (FFT) → exact camera offset
  processing.js                processor interface; SAM 3D Body adapter
  analysis.js                  the analysis queue: one take at a time, persisted, resumed after a restart
  lan.js                       LAN HTTPS listener (self-signed certificate via openssl)
routes/capture.js              REST API (see the file header for every endpoint)
```

Every clip starts and ends in a canonical state: N, TR, TL, DR, DL, MR, ML, G, DEF, DEF_M, LAND
(which resolves to N) or N_SPRINT. So the library is a state graph (`stateGraph()`), and gameplay
can chain any clip ending in X with any clip starting in X.

**Session order** (`captureOrder`):
1. court setup A, then B, then C (the cameras never move back);
2. body state;
3. the state's loops before the moves out of it;
4. ball hand;
5. direction.

## Synchronisation

Browsers can't hardware-trigger two phones on one frame, and the app doesn't pretend to. Each take
instead stores everything an offline step needs to align the cameras exactly.

1. **Shared session clock.** Every device pings the server over the WebSocket every second.
   `ClockSync` takes the median offset of the lowest-latency round trips and stores it with its
   uncertainty (± half that round trip). Every stored time is on the server clock.
2. **Coordinated start and stop.** RECORD makes the server send `record {at: now + 0.8 s}`. Each
   camera starts MediaRecorder when its own clock reaches that server time. STOP works the same way.
3. **Per-frame timestamps.** While recording, every frame the device shows is logged
   (`requestVideoFrameCallback` capture time → server clock) to `camX.frames.json`. `alignTakes()`
   pairs frames across the cameras.
4. **Audible sync event.** The director plays a 90 ms up-chirp (1.8 → 5.2 kHz) 0.35 s after the
   start, and records when on the server clock. Both cameras' microphones hear it.
   `sync-audio.syncTake()` finds it in each file with an FFT matched filter, which gives the camera
   offset to one audio sample (1/16000 s). The result is cross-checked against the clock estimate.
   The background checks run this and store it as `syncResult` on the take.

**Missed stop.** A camera that drops off the network mid-take keeps recording, with its chunks
safe on the device. On reconnect it learns the take was stopped and finalises at the director's stop
time, noted as `stopReconciled`. It also caps a take at 120 s without contact.

**The director's STOP** is resent every 2 s until the server confirms it, including across a
dropped connection or a server restart. A director page refreshed mid-take comes back with STOP.

**Which cameras a take waits for.** The ones that were READY when RECORD was pressed
(`expectedCams`). Each camera's state report names the take it got the start of; one that has not
3 s after the scheduled start never started (its page asleep or in the background). A camera page
of the earlier code (still open on a phone after a deploy) names no take: there "recording" counts. The hub then
tells the director (`notrecording`), records it on the take (`missingCams`) and the take does not
wait for it: with two cameras it is "needs redo" (`camB never started recording`); in one-camera
mode it is saved with a warning. A camera that did start but never uploads (its phone died
mid-take) keeps the slot **Uploading**; after 30 s the director shows a banner, and **Go on without
CAM B** / the take's **Go on with CAM A** (`POST …/finish`) save it with the other camera. That
camera's footage is still added to the take if it arrives later.

**CANCEL** during the 3-2-1 (or in the 0.8 s before the cameras start) discards the take: the cameras
halt and the take is marked `rejected`, so it never counts as a recording of the move.

**A camera page reloaded mid-take** (or the app killed) finishes that recording with what it had
recorded (`meta.interrupted`, no frame times), so the take still completes.

**One page per role.** If a second page opens the same role (camera B's link twice, or the session
in two tabs), the newest one takes the role and the older one stops, showing **USE THIS PHONE** /
**DIRECT FROM HERE** to take it back. Only a signed-in director can be the director; a camera's
pairing link never grants it.

## Frame rate: honest capabilities, and the native path

The camera asks for 120 fps. It walks 120 → 60 → 30 at 1080p and 720p, and keeps the best rate the
device actually grants (`getSettings`). It also **measures** the frame rate while recording. The
negotiated and measured values are shown and stored. Nothing is faked.

**iPhone and iPad browsers record at most 60 fps.** Safari caps web camera capture there (both of
the user's devices report `getCapabilities().frameRate.max = 60`), even though the Camera app does
120/240. Other phones' browsers are usually limited to 30 or 60 fps too. The Connect step says so,
and there are two native paths:

- **Now: a slo-mo file per take, from a third phone.** During the take, film the same move in
  Slo-mo (120/240 fps) with the Camera app of a **third** phone standing next to CAM A or CAM B.
  Not with CAM A or CAM B themselves: opening the Camera app on them sends the capture page to the
  background and stops its recording. Then attach the file under **Animations → the slot →
  Slo-mo file: + next to CAM X**. Its audio contains the director's sync chirp, so it is aligned to
  the take automatically. It is stored as `camX.native.mov` next to the web recording, with its
  probe and chirp position.
- **Next: a native camera app** implementing the same protocol:
  1. join with the pairing token: `POST /api/capture/pair {token}`;
  2. open the WebSocket `/api/capture/ws?session=…&token=…`, send `hello {role: camB}`, and `ping`
     every second;
  3. report `state {ready, camera, clock}`;
  4. start at `record.at` and stop at `halt.at`;
  5. upload with `PUT …/rec/:id/camB/chunk/:n`, then `POST …/complete {chunks, mimeType, frames, meta}`.

  The director UI and server don't change. `capture/camera.mjs` defines the interface the native
  side mirrors: open, describe, start, stop, onChunk.

## Recording format and the "is it really recording?" check

- **Format** (`pickMime`). On WebKit (Safari on iPhone, iPad and Mac, and every other iOS browser:
  Chrome, Firefox, Edge, in-app views) the recorder uses MP4 / H.264 first (High profile, then
  baseline), then WebM: in the field, an iPhone's WebM/VP9 recorder claimed support and recorded a
  5-byte file. On Chromium it uses WebM first, because it streams real 1 s chunks. A format the
  recorder refuses outright (it can't be created or won't start) is skipped at once: the next one
  it offers is used for the same take.
  A format whose FINISHED recording is (almost) empty while the camera delivered frames is skipped
  for a week (kept in the phone's `localStorage`); it is never judged from a mid-recording byte
  count, since Safari may deliver the whole take at the stop.
- **Health check.** About 1.6 s and 3.2 s after the scheduled start, each camera checks that its
  recording is real. A problem is any of: a recorder error (or one that won't start), the camera
  stopped or muted, the page in the background, (nearly) empty chunks while no frame arrives, no
  frames and no data, or — 3 s in — no frame while the preview isn't playing either ("this camera
  is not delivering a picture", even if audio still flows). It reports the problem at once
  (`state.recError`). The director shows it in the recording screen ("CAM B is not recording — keep
  its screen on and the page in front"), and phone B shows it too. The take carries it (a `recorder-camX`
  warning), and it is checked again at the stop.
- **Keeping the camera running.** The camera page keeps a screen wake lock, asks for it again
  whenever the page comes back to the front, and restarts the preview video when iOS pauses it
  (frame timestamps need it playing).
- **A recorder that never says "stopped"** still finishes the take 4 s after the stop, with what
  it handed over (the take is not left "finishing").

## Persistence

- **On the device first.** Chunks (1 s of video each; WebM streams them while recording) go to the
  phone's IndexedDB and are uploaded in order, idempotently, with retry and backoff. The phone
  keeps its copy of a recording until the server confirms the whole recording is saved (below).
  Chunks the server lost are sent again. A refresh, an app restart or a Wi-Fi drop resumes the
  queue on the next load.
  - The database is `souljam-capture-v2`, a fresh name, so a capture tab of older code left open on
    the phone can't block it (in the field one held the old database and every save waited
    forever: uploads stuck at "finishing"). If storage is unavailable or doesn't open within 3 s,
    the queue runs in memory: uploads still go, the camera page says to keep it open (no reload),
    and the director sees "CAM B can't use its phone storage".
  - Each camera reports its storage mode and its upload error in its state; the director shows
    "CAM B upload: …" while uploads wait. `GET /api/capture/sessions/:sid/devices` (director only)
    returns the hub's live view of every device: online, READY, format, uploads, storage, errors.
- **Server and cloud.** Files are written under `data/capture/sessions/<id>/` (atomic JSON: temp +
  fsync + rename). When cloud storage is configured (Railway: Firebase Storage), **every** record
  change is mirrored to `_meta/capture/…` as it happens: session progress, takes and retakes,
  calibrations, landmarks, the selected take, processing results.
  - A camera's upload is confirmed only after its assembled video and frame times are in the bucket.
    Only then does the phone drop its copy.
  - Railway's disk is wiped on every deploy. After one, sessions, takes and videos are read back
    from the bucket as they are needed: review, the takes list, export, stills and processing.
    Nothing needs to be re-recorded.
- **Recorded ✓ / Saved ✓** appear only after the take's files, its record (marked accepted) and the
  session's progress are all stored in the bucket. Nobody accepts a take by hand: once a take's
  uploads are in and its checks pass, the server saves it and selects it if it is the newest
  recorded take of its animation — unless it is short (stopped early: a duration warning) and the
  selected one is not; then it is saved, the old one stays selected and the list says so.
  `POST …/accept` stays as an API, and **Use it anyway** uses a failed take.
- **Sessions of the old, reviewed flow.** A take that was checked but never accepted is not saved
  behind the operator's back: its slot asks for a decision (**Use it anyway** or record it again).
  An earlier MARK BEST is kept when such a session is settled.
- **Footage the server no longer knows** (e.g. a session removed by hand) is never deleted from the
  phone. It is kept aside, and the camera page offers **SAVE TO PHONE** or **DISCARD**.
- **Retakes.** Takes are never deleted automatically. Each animation keeps all its takes and one
  `selectedTake` (MARK BEST changes it); rejected takes stay until cleaned up by hand.

## Calibration

**Why.** The two cameras film the same move from two sides. To combine them into one 3-D motion
later, the processing side has to know where each camera stands relative to the court. The
calibration recording gives it that: both cameras film the same known walk (the capture area's
four corners and its middle, arms up), so the views can be matched. That is why both cameras must
see the whole area, head to feet, and must not move once it is recorded.

- **One calibration per camera placement** (`court-layout.mjs` `STATIONS`): placement A serves
  setups A and B (top of the key and the drive lane, the cameras do not move between them),
  placement C serves the rim. Calibrations are kept as `session.calibrations.A` / `.C`, and
  `session.currentSetup` is the placement in use.
- **Where the cameras go.** Each placement puts both cameras so that a phone's normal (1×) lens
  takes in the whole area head to feet: the nearest corner at least 4.5 m away and the area within
  about 50° across (`tests/capture.test.js` checks it). Their positions are given in court words.
  The area's corners and middle are listed in court words too: a cone or tape on each.
- **The recording** (about 21 s, `calibrationWalk`): 2 s on ✕ arms up, then ✕ → 1 → 2 → 3 → 4 → ✕
  at an easy 1.3 m/s, then 2 s arms up. The iPad says each corner out loud and lights it on the
  map. It saves itself once both recordings are uploaded and decode (no review). With two cameras,
  a calibration with only one camera's view is not saved ("the calibration needs both cameras");
  in one-camera mode one view is saved. The CALIBRATE button waits for both cameras to be READY.
- **Moving the cameras** to another placement makes the old placement's calibration **stale**.
  Coming back needs a new calibration (or an explicit skip). A take records the calibration it was
  made with only while that calibration is valid (`calibrationId`, `calibrationStatus`).
- Kept apart from the takes in `calibrations/`. Court landmarks can still be added per camera
  through the API (`POST …/rec/:id/landmarks`), as normalised image points paired with court
  metres; the main flow doesn't ask for them.
- When a calibration is saved, both cameras keep a reference view. It is stored on the server
  (`calrefs/`), so a reloaded camera page keeps watching. A camera that has no reference for an
  accepted calibration (it was not connected then) flags it, so the director recalibrates.
- A camera is considered moved when a whole-picture shift explains a change in its view (edge maps,
  ±4 px of 64), or when the phone is bumped (device motion). That marks the placement's calibration
  **suspect**, and the director is prompted to recalibrate. A player walking through the view doesn't
  count as a move.
- You can skip calibration ("Skip — cameras are placed; I'll calibrate later"); that is recorded as `skipped`.
- Court landmarks and known dimensions are in `court-layout.mjs` (`COURT.landmarks`). A ChArUco
  board can be recorded in the same calibration take.

## Checks (`lib/capture/validators.js`)

They run in the background once a take's cameras have uploaded. Nobody waits for them.

| Check | What it tests |
|---|---|
| Cameras | Both recorded (two-camera mode: a take only one camera recorded is saved with a "one view: no 3-D" warning) |
| Files | Each file exists and is non-trivial |
| Duration | Each recording decodes and its duration is plausible for the target; both cameras' lengths agree |
| Recorder | What a camera said while recording (its health check) |
| Metadata | Metadata is complete |
| Frame rate | Measured fps, compared with negotiated |
| Clock | Clock sync uncertainty and start skew |
| Sync chirp | Heard by both cameras (exact offset) |
| Cropping | Motion running off two frame edges (a cheap motion map) |

A **hard failure** means a camera produced no usable video: missing, a tiny file, no decode, or
under 1 s, or (two cameras) an expected camera never started. It makes the slot **Check failed —
redo**, with the reason; the take is kept, and **Use it anyway** in its takes saves it regardless.
Any other fail or warning is shown with the take; one that matters for the clip (cut short, the
camera said it was not recording, the athlete cropped) also shows in the list and the toast. Planned slots, same signature: body visible (2D pose), ball visible, feet visible, blur,
exposure.

**The camera check** (Connect step) is a 2 s recording of kind `check` (`POST …/checks`), kept in
`checks/` and never part of the progress. Each camera's verdict (`validators.checkCamera`: bytes, a
file that decodes, at least 0.8 s, frames the page saw) goes to `session.cameraChecks[camX]`, tied to
the device that holds the role.

## Export

`GET /api/capture/sessions/:id/export.tar` returns accepted takes only; add `?all=1` for every take.

```
SoulJam_BASIC01/
  session.json                      the library, states, court, setups, capture order, progress, the takes index, conventions
  calibration/setup_A/cal01/        camA.webm  camB.webm  camX.frames.json  metadata.json (+ landmarks)
  setup_A/cross_RL/take01/          camA.webm  camB.webm  camA.frames.json  camB.frames.json  metadata.json  (camX.native.mov)
  setup_B/pullup_R/take01/ …
  setup_C/layup_R/take01/ …
```

A take's `metadata.json` contains:

- **Animation.** Id, key, title, category, `startState`, `endState`, `endResolves`, `direction`,
  `ballHand`, `targetDurationSec`, `loop`.
- **Take.** Session id, take number, `courtSetup`, `calibrationId`, state, accepted, selected, and
  the validation results.
- **`sync`.** `startAtServerMs`, `stopAtServerMs`, the chirp's server time and parameters, and
  `syncResult` (the chirp positions per camera and `offsetSec`).
- **Per camera.** Device, negotiated track (resolution, fps, facing, zoom), capabilities, recorder
  (mime, bitrate), clock (offset, round trip, uncertainty), `startedAtServerMs`, measured frame
  stats, file info (codec, size, duration, decoded fps), the motion map and any native file.

This is everything a later pipeline needs:

- two-view synchronisation and camera calibration;
- 2D pose, SAM 3D Body or multi-view 3D;
- ball, hand and foot-contact tracking;
- segmentation (the holds are capture handles, not game frames);
- loop and root-motion extraction;
- the state graph.

## Processing: the analysis queue (SAM 3D Body today)

Nothing is analysed when it is recorded. The **Analysis** screen sends the chosen takes:

- `POST /api/capture/sessions/:sid/process-batch {takes, cam, fps, confirmCostUsd}`. Without a
  `confirmCostUsd` ≥ the estimate it answers **402** with the quote (frames, dollars, per take) and
  queues nothing. With one, it queues the recorded takes (each the slot's selected take). It leaves
  out, with the reason, any take that isn't recorded, has no recording from that camera, or is
  already queued.
- The server runs the queue **one take at a time**. Each take goes through the existing mocap
  pipeline (`lib/mocap/pipeline.js`: SAM 3 + SAM 3D Body on fal.ai) and becomes a motion in the clip
  library. Its game role comes from the animation's `gameRoles` (e.g. `cross_RL → move-crossover`).
- The state is persisted on the take (`take.analysis = {state: queued | running | done | error,
  cam, fps, maxFrames, estimateUsd, attempts, beatAt, error, motionId}`), with the order in
  `session.analysisQueue` and a summary per slot. After a restart, queued takes resume on boot or on
  the next read of the session (after a 2-minute grace, since a redeploy's old container may still
  be running the queue; takes queued on the new server start at once).
- **Paid work never runs twice without asking.** A running take writes a heartbeat (`beatAt`).
  Another server leaves it alone while the heartbeat is fresh. Once it is stale (90 s), the server
  that ran it is gone, and the take becomes an **error**: "interrupted by a server restart … send it
  again". It is never re-run by itself. SIGTERM stops the queue from starting anything new. A
  result the bucket refused to store is kept and only its writes are retried; the pipeline is not
  run again.
- `GET /api/capture/sessions/:sid/analysis` returns the queue with live progress. Errors are shown as
  the pipeline reports them, for example fal.ai's own message when its balance is empty. A take that
  failed goes back to the list to send again.
- It is paid, about $0.03 per frame (at most 240 frames per take). `MOCAP_MOCK=1` runs the
  pipeline on synthetic data at no cost (tests).

`POST …/rec/:id/process {processor, cam, fps, maxFrames, confirmCostUsd, role}` still runs one take
directly. A multi-view processor (both cameras + calibration → triangulated 3D) plugs into the same
interface.

## Tests

- `npm test` runs:
  - `tests/capture.test.js`: the BASIC-01 library and state graph, capture order and next missing,
    clock sync, alignment, chunk storage and assembly, the export tar, validators on a generated
    video, the chirp detector, the camera-moved detector, the recorder format and health check, the
    camera-check verdict, slot statuses, the court and calibration-walk diagrams;
  - `tests/capture-server.test.js`: the real server in its production shape (password gate on, a
    local folder standing in for the bucket), driven over HTTP and WebSocket:
    - a full take;
    - a **redeploy** (process killed, local disk wiped) mid-review, mid-upload and mid-check: the
      takes, videos, stills and export come back from the bucket;
    - which cameras a take waits for, and going on without one;
    - saved by itself (the newest selected, unless it is short), MARK BEST, a failed check → needs
      redo / use it anyway; a session of the old reviewed flow is never saved behind the operator's
      back;
    - a late STOP; an expected camera that never starts (told within seconds, nothing waits for it);
    - calibrations: one per camera placement, both views needed with two cameras, stale after a move;
    - the camera check (never a take), the live-snapshot relay (director only, rate limited), the
      zoom relay;
    - the analysis queue: the quote, the confirmed queue run one at a time (`MOCAP_MOCK=1`), a
      redeploy (queued resumes; an interrupted run becomes an error, a fresh heartbeat is left
      alone), and a refused result write that is retried without running the pipeline again;
    - live device status (director only: storage mode, upload errors); a camera page of the earlier
      code still counts as started; a two-camera take one camera recorded says "one view";
    - security: a camera token can't act as director or reach director endpoints; pairing limits,
      code expiry and body size limits;
    - crash resistance: an oversized WebSocket frame, malformed URLs, `GET //`.
- `node tests/capture-e2e.spec.js` runs two simulated phones (separate Chromium instances with fake
  camera and microphone) against a dedicated server, with a folder as the bucket (about 70 checks).
  The director is an iPad (1180×820) and camera B a phone (390×844), with screenshots of every step at
  iPad and phone sizes, portrait and landscape, in `tests/reports/capture-e2e/`:
  - connect: pairing by QR link and one tap, the camera check ✓ — and ✗ with the reason for a camera B
    whose recorder produces nothing (the iPhone case), told to the director while it records;
  - calibrate: camera positions and floor marks in court words, the walk diagram, the written and
    spoken prompts at an easy walk, saved by itself with both stills;
  - record: START/FINISH in court words, a move that starts moving (no "hold the start pose"), the
    phone layout above the fold, the countdown setting; three animations back to back with no
    review; the slot list (Uploading → Recorded ✓, filters, totals); redo from the toast and from
    the list; MARK BEST; a failed check → redo; camera B asleep at RECORD;
  - analysis: the selection, the server's quote to confirm, the queue run (mock) → Analysed ✓;
  - CANCEL in the 3-2-1 and in the 0.8 s lead (the take is discarded, no recorder left running);
  - camera B offline mid-take (chunks kept on the device, uploaded after reconnect);
  - camera B reloaded mid-take (its partial recording still completes the take);
  - the director refreshed mid-recording (STOP comes back);
  - a second page on camera B's link (no reconnect fight, USE THIS PHONE);
  - a server restart with the disk wiped, mid-session and mid-upload;
  - home → CONTINUE MISSING, and the export layout and metadata.

## Settings

| Environment variable | Default | What it does |
|---|---|---|
| `CAPTURE_DIR` | `data/capture` | Where sessions and takes are stored |
| `CAPTURE_HTTPS_PORT` | `3443` | Port of the LAN HTTPS listener |
| `CAPTURE_HTTPS=0` | on | Turns the LAN listener off (it is never started on Railway) |
| `CAPTURE_CLOUD=0` | on | Turns the cloud mirror off |
| `CAPTURE_CLOUD_DIR` | unset | Tests only: a local folder stands in for the bucket |
| `CAPTURE_DEBUG=1` | off | Logs hub liveness and event-loop stalls |
| `CAPTURE_ACK_GRACE_MS` | `3000` | How long after a take's start a camera has to say it started |
| `CAPTURE_ANALYSIS_LEASE_MS` | `90000` | A running analysis whose heartbeat is older: its server is gone (→ error) |
| `CAPTURE_ANALYSIS_GRACE_MS` | `120000` | After a boot, queued analyses from before wait this long |
| `CAPTURE_ANALYSIS_RETRY_MS` | `60000` | A refused analysis write is retried after this long |

Limits: one camera's recording up to 900 MB (2000 chunks); a native file up to 2 GB; pairing by code
is rate limited per client and to 60 wrong codes a minute overall.

## Known limitations

- **Web capture frame rate.** At most 60 fps on iPhone / iPad (Safari's limit), usually 30 or 60 on
  other phones. Use the slo-mo file path for 120/240 fps until a native camera app exists.
- **Safari's recorder.** It records MP4; on some versions the whole take arrives at STOP instead of
  streaming. It is still saved to the device first, then uploaded.
- **Keep the camera page in front.** Phones stop the camera when locked, backgrounded, or when
  another app takes the camera (a call, the Camera app). The app keeps a wake lock, and the director
  is told within about 3 s when a camera stops or never starts recording; keep phone B on its
  tripod with the page open.
- **The iPad's voice.** iOS speaks only after a tap on the page (RECORD / CALIBRATE is one) and
  only with the sound on. With the voice off, someone reads the screen to the athlete.
- **Self-signed certificate.** On the Mac's LAN listener each phone accepts the warning once. The
  Railway link has none.
- **A deploy during a session** drops both phones' connections for a moment; they reconnect by
  themselves. A take being recorded at that moment is stopped at the reconnect: record it again.
- **Phone storage.** The phone holds each recording until it is saved on the server, up to about
  600 MB for a 120 s take at the highest bitrate.
- **Calibration is stored, not solved.** Recordings, landmarks and camera priors are saved; solving
  the camera poses (PnP / bundle adjustment) belongs to the processing side.
- **Moved detection is an estimate.** It is a cheap image-shift and device-motion heuristic that
  prompts the operator; it doesn't prove the calibration is still valid.
