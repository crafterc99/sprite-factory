# Soul Jam Capture: two-phone recording for the animation library

Soul Jam Capture records a clean, synchronised, structured two-camera video dataset of basketball
moves, one animation at a time, for the mocap pipeline. Phone A is the director and camera A. Phone
B is camera B and needs no touching after pairing. Written for whoever runs a capture session, and
for engineers extending it.

The capture step is independent of any pose model. Processing (SAM 3D Body today, multi-view
reconstruction later) plugs in behind a processor interface.

## Run a session

**What you need:** two phones or tablets on tripods (the iPad directs and is camera A; a phone is
camera B), both online, and the studio password (for the director only).

1. **Connect.** On the iPad open `https://sprite-factory-production.up.railway.app/capture`, sign in,
   tap **New BASIC-01 session** and allow the camera. On the phone, scan the QR code on CAM B's tile
   (or open `/capture` and type the 6-digit code), then tap **TAP TO START CAMERA**. That is the
   phone's only touch.
   - Each camera then records a 2-second **camera check** by itself. ✓ means it produced real
     video (bytes, frames, a file that decodes); ✗ says why. Both tiles show what the camera sees.
   - **NEXT** unlocks when both pass, or tap **Continue with one camera**.
2. **Calibrate.** Calibration lets the two camera views be combined into 3-D later, so both cameras
   must see the whole capture area and must not move afterwards.
   - Place the cameras as the diagram shows and check that the dashed area fits in both pictures.
   - Press **CALIBRATE**. After 3-2-1, walk to the corners **1 → 2 → 3 → 4** of the area (numbered on
     the diagram), then stand in the middle with your arms up. It stops after 10 s and saves by
     itself: **Calibration saved ✓** with a still from each camera.
   - **Skip — cameras are placed; I'll calibrate later** also works.
3. **Record**, one animation at a time. The screen shows `#12 of 82 · Setup A`, the name, a court
   diagram with the **START** and **FINISH** marks and the path, the start pose, the move and the
   finish pose, and the protocol: hold the start pose 1 s → the move at game speed → hold the
   finish pose 1 s (loops: keep repeating).
   - Press **RECORD**: 3-2-1, then it records with a big timer and stops by itself (or press
     **STOP**). There is no review: the next animation to record comes up at once.
   - The take uploads and is checked in the background. It counts as **Recorded ✓** only once the
     server and the bucket have it; until then the list says **Uploading**. A **Redo** button for the
     take just recorded stays for a few seconds.
   - When a setup is finished, the app asks you to move the cameras and calibrate the next setup.
4. **Animations** lists all 82 slots by setup, in capture order: name, start → finish pose and
   status (**Not recorded · Uploading · Recorded ✓ · Check failed — redo** with the reason ·
   **Analysed ✓**), with the totals. Filter **To record / All**. Tap a slot to see its takes (play,
   **MARK BEST**, attach a slo-mo file, **Record it again**).
5. **Analysis** (any time later): nothing is analysed by itself. Pick the recorded animations
   (all by default), the camera (A or B), check the cost (about $0.03 per frame) and press
   **Send to analysis**, then confirm the amount. The server runs them one at a time, and you can close
   the page. Progress and errors (for example an empty fal.ai balance) show at the top.

Stop at any point: home → **CONTINUE MISSING** on the session goes to the next animation to record.
**Export** is at the bottom of **Animations** (the organised dataset as a `.tar`).

**On the Mac instead (same Wi-Fi, no internet needed):** start the studio with `bash mac-dev.sh`. Its log
prints the phone address, for example `Capture (phones, same Wi-Fi): https://10.0.0.83:3443/capture`.
Phones need HTTPS for the camera, so the Mac serves its own certificate: the first time, each phone
warns about it (iOS: *Show Details → visit this website*; Android: *Advanced → Proceed*). Takes are
then stored on the Mac (`data/capture`).

**If a camera is not recording,** the director says so within about 2 s of the start (in the
recording screen: "CAM B is not recording — keep its screen on and the page in front"). The take is
flagged and, if no usable video arrives, the slot becomes **Check failed — redo**. Phone B's own
screen says the same. The usual cause is a locked screen or the page in the background. The app
keeps the screen awake and the preview playing, but a phone call or another app using the camera
still stops it.

## What each screen shows

**Director:** a header with the stepper (**1 Connect · 2 Calibrate · 3 Record · Animations ·
Analysis**) and the CAM A / CAM B status, then the step:

| Step | Content |
|---|---|
| 1 Connect | Two camera tiles: a live picture (camera B sends a small JPEG every ~1.5 s), READY, resolution, fps, orientation, format and the camera check; pairing QR and code; the frame-rate note |
| 2 Calibrate | Why it matters; the setup diagram (camera positions, the area, corners 1–4); both live pictures with a framing guide; CALIBRATE (3-2-1 → 10 s with prompts → saved by itself) or Skip |
| 3 Record | `#n of 82 · Setup X`, name, START/FINISH diagram, start pose, the move, finish pose, protocol; RECORD → 3-2-1 → timer → stops by itself; "Saved ✓" / Redo |
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
  court-layout.mjs             court geometry + landmarks, setups A/B/C (player path, camera poses, framing), SVG diagram
  protocol.mjs                 session order, progress / next missing, take lifecycle, real-time message types
  camera-sync.mjs              shared session clock (ClockSync), sync chirp definition, alignTakes / frameStats
  camera.mjs                   web camera: capability ladder, MediaRecorder chunks, frame timestamps, moved detection
  uploader.mjs                 IndexedDB-backed resumable uploader
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
(`expectedCams`). If one of them never uploads (its phone died), the slot stays **Uploading**, and
its takes offer **Go on with CAM A** (`POST …/finish`; a calibration offers **Save with CAM A only**
after 20 s). The missing camera's footage is still added to the take if it arrives later.

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

- **Now: a slo-mo file per take.** Record the same take with the phone's Camera app in Slo-mo
  (120/240 fps), then attach it under **Animations → the slot → Slo-mo file: + CAM X**. Its audio
  contains the director's sync chirp, so it is aligned to the take automatically. It is stored as
  `camX.native.mov` next to the web recording, with its probe and chirp position.
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

- **Format** (`pickMime`). On WebKit (Safari: iPhone, iPad, Mac) the recorder uses MP4 / H.264
  first, then WebM. On Chromium it uses WebM first, because it streams real 1 s chunks. If a format
  records (almost) nothing while the camera delivers frames, the device skips that format from then
  on (kept in its `localStorage`) and says so.
- **Health check.** About 1.6 s and 3.2 s after the scheduled start, each camera checks that its
  recording is real. A problem is any of: a recorder error, the camera stopped or muted, the page in
  the background, (nearly) empty chunks, or no frames and no data. It reports the problem at once
  (`state.recError`). The director shows it in the recording screen ("CAM B is not recording — keep
  its screen on and the page in front"), and phone B shows it too. The take carries it (a `recorder-camX`
  warning), and it is checked again at the stop.
- **Keeping the camera running.** The camera page keeps a screen wake lock, asks for it again
  whenever the page comes back to the front, and restarts the preview video when iOS pauses it
  (frame timestamps need it playing).

## Persistence

- **On the device first.** Chunks (1 s of video each; WebM streams them while recording) go to the
  phone's IndexedDB and are uploaded in order, idempotently, with retry and backoff. The phone
  keeps its copy of a recording until the server confirms the whole recording is saved (below).
  Chunks the server lost are sent again. A refresh, an app restart or a Wi-Fi drop resumes the
  queue on the next load.
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
  recorded take of its animation (`POST …/accept` stays as an API, and **Use it anyway** uses it for a
  failed check).
- **Footage the server no longer knows** (e.g. a session removed by hand) is never deleted from the
  phone. It is kept aside, and the camera page offers **SAVE TO PHONE** or **DISCARD**.
- **Retakes.** Takes are never deleted automatically. Each animation keeps all its takes and one
  `selectedTake` (MARK BEST changes it); rejected takes stay until cleaned up by hand.

## Calibration

**Why.** The two cameras film the same move from two sides. To combine them into one 3-D motion
later, the processing side has to know where each camera stands relative to the court. The
calibration recording gives it that: both cameras film the same known walk (the capture area's
four corners and its middle, arms up), so the views can be matched. That is why both cameras must
see the whole area, and must not move once it is recorded.

- One calibration recording per court setup (10 s, prompted: corners 1 → 2 → 3 → 4 as numbered on
  the diagram, then the middle), kept apart from the takes in `calibrations/`. It saves itself
  once both recordings are uploaded and decode (no review). The corner positions are in
  `court-layout.mjs` (`calibrationWalk`).
- Court landmarks can still be added per camera through the API (`POST …/rec/:id/landmarks`), as
  normalised image points paired with court metres; the main flow doesn't ask for them.
- When a calibration is saved, both cameras keep a reference view. It is stored on the server
  (`calrefs/`), so a reloaded camera page keeps watching. A camera that has no reference for an
  accepted calibration (it was not connected then) flags it, so the director recalibrates.
- A camera is considered moved when a whole-picture shift explains a change in its view (edge maps,
  ±4 px of 64), or when the phone is bumped (device motion). That marks the setup's calibration
  **suspect**, and the director is prompted to recalibrate.
- A player walking through the view doesn't count as a move.
- You can skip calibration ("Skip — cameras are placed; I'll calibrate later"); that is recorded as `skipped`.
- Court landmarks and known dimensions are in `court-layout.mjs` (`COURT.landmarks`). A ChArUco
  board can be recorded in the same calibration take.

## Checks (`lib/capture/validators.js`)

They run in the background once a take's cameras have uploaded. Nobody waits for them.

| Check | What it tests |
|---|---|
| Cameras | Both recorded |
| Files | Each file exists and is non-trivial |
| Duration | Each recording decodes and its duration is plausible for the target; both cameras' lengths agree |
| Recorder | What a camera said while recording (its health check) |
| Metadata | Metadata is complete |
| Frame rate | Measured fps, compared with negotiated |
| Clock | Clock sync uncertainty and start skew |
| Sync chirp | Heard by both cameras (exact offset) |
| Cropping | Motion running off two frame edges (a cheap motion map) |

A **hard failure** means a camera produced no usable video: missing, a tiny file, no decode, or
under 1 s. It makes the slot **Check failed — redo**, with the reason; the take is kept, and
**Use it anyway** in its takes saves it regardless. Any other fail or warning is only shown with the
take. Planned slots, same signature: body visible (2D pose), ball visible, feet visible, blur,
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
  cam, fps, maxFrames, estimateUsd, attempts, error, motionId}`), with the order in
  `session.analysisQueue` and a summary per slot. After a restart, the queue resumes on boot or on
  the next read of the session. A take interrupted twice by a restart becomes an error instead of
  being paid for a third time.
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
    - saved by itself (the newest selected), MARK BEST, a failed check → needs redo / use it anyway;
    - a late STOP;
    - the camera check (never a take), the live-snapshot relay (director only, rate limited);
    - the analysis queue: the quote, the confirmed queue run one at a time (`MOCAP_MOCK=1`), and its
      resumption after a restart;
    - security: a camera token can't act as director or reach director endpoints; pairing limits,
      code expiry and body size limits;
    - crash resistance: an oversized WebSocket frame, malformed URLs, `GET //`.
- `node tests/capture-e2e.spec.js` runs two simulated phones (separate Chromium instances with fake
  camera and microphone) against a dedicated server, with a folder as the bucket (about 60 checks).
  The director is an iPad (1180×820) and camera B a phone (390×844), with screenshots of every step at
  iPad and phone sizes, portrait and landscape, in `tests/reports/capture-e2e/`:
  - connect: pairing by QR link and one tap, the camera check ✓ — and ✗ with the reason for a camera B
    whose recorder produces nothing (the iPhone case), told to the director while it records;
  - calibrate: the walk diagram, the prompts, saved by itself with both stills;
  - record three animations back to back with no review; the slot list (Uploading → Recorded ✓,
    filters, totals); redo from the toast and from the list; MARK BEST; a failed check → redo;
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

Limits: one camera's recording up to 900 MB (2000 chunks); a native file up to 2 GB; pairing by code
is rate limited per client and to 60 wrong codes a minute overall.

## Known limitations

- **Web capture frame rate.** At most 60 fps on iPhone / iPad (Safari's limit), usually 30 or 60 on
  other phones. Use the slo-mo file path for 120/240 fps until a native camera app exists.
- **Safari's recorder.** It records MP4; on some versions the whole take arrives at STOP instead of
  streaming. It is still saved to the device first, then uploaded.
- **Keep the camera page in front.** Phones stop the camera when locked, backgrounded, or when
  another app takes the camera (a call, the Camera app). The app keeps a wake lock, and the director
  is told within about 2 s when a camera stops recording; keep phone B on its tripod with the page open.
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
