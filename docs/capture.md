# Soul Jam Capture: two-phone recording for the animation library

Soul Jam Capture records a clean, synchronised, structured two-camera video dataset of basketball
moves, one animation at a time, for the mocap pipeline. Phone A is the director and camera A. Phone
B is camera B and needs no touching after pairing. Written for whoever runs a capture session, and
for engineers extending it.

The capture step is independent of any pose model. Processing (SAM 3D Body today, multi-view
reconstruction later) plugs in behind a processor interface.

## Run a session

**What you need**
- Two phones on a tripod each, both online (mobile data or any Wi-Fi).
- The studio password (for phone A only).

**Steps**
1. **Phone A (director):** open `https://sprite-factory-production.up.railway.app/capture` and sign
   in to the studio when asked. Tap **New BASIC-01 session**, and allow the camera. Phone A is
   camera A.
2. **Pair phone B:** on phone A tap **Pair camera**, then scan the QR code with phone B. On phone B
   tap **TAP TO START CAMERA**. That is phone B's only touch; phone B never needs the password.
   - You can also type the 6-digit code on phone B's `/capture` home page. A code works for 15
     minutes after **Pair camera** was opened (open it again for a fresh one); the QR code does not
     expire.
3. **Place the cameras** as the Setup card shows (top-down court diagram, CAM A and CAM B positions,
   framing rules). Tap **CALIBRATE SETUP A**, then walk the court lines and stand under the rim for
   about 10 s. Tap **STOP**, then **ACCEPT CALIBRATION**. Optionally tap the landmarks on each
   camera's still.
4. **Record.** Both pills show `● READY`.
   - Press **RECORD BOTH**; the athlete performs the move at game speed; press **STOP**.
   - Both recordings upload and are checked, then press **ACCEPT + NEXT**. **SAVED ✓** appears only
     after the files and metadata are stored, then the next missing animation loads.
   - **RETAKE** keeps the footage; nothing is ever deleted automatically.
5. **Change setup.** When setup A is finished, the app shows the Setup B card: move the cameras,
   calibrate, and continue.
6. **Stop any time.** Later, open `/capture` and tap **CONTINUE MISSING** on the session. It jumps
   to the next missing animation in the most efficient setup order.
7. **Export** (menu at the bottom): download the organised dataset as a `.tar`.

**On the Mac instead (same Wi-Fi, no internet needed):** start the studio with `bash mac-dev.sh`. Its log
prints the phone address, for example `Capture (phones, same Wi-Fi): https://10.0.0.83:3443/capture`.
Phones need HTTPS for the camera, so the Mac serves its own certificate: the first time, each phone
warns about it (iOS: *Show Details → visit this website*; Android: *Advanced → Proceed*). Takes are
then stored on the Mac (`data/capture`).

## What each screen shows

**Director**

| Area | Content |
|---|---|
| Header | `SOUL JAM CAPTURE`, and CAM A / CAM B status with the real negotiated fps |
| Progress | `SETUP A — TOP OF KEY · 34 / 67 COMPLETE`, totals, next missing |
| Animation | Name, start and end state, duration, capture fps, ball hand, direction, athlete cues, the protocol (hold → move → hold, or loop), court path diagram, camera positions and framing |
| Main button | Sticky RECORD BOTH |
| While recording | Large timer and progress against the target duration |
| Review | Both recordings side by side (Play both), the checks, RETAKE and ACCEPT + NEXT |
| Menu | Pair camera (QR + code), Takes (every take, MARK BEST, attach a native 120/240 fps file, SAM 3D Body processing), Export, Sessions, CONTINUE MISSING |

**Camera** is a full-screen preview with role, READY / RECORDING, the negotiated format and upload
status. It warns when the camera was moved and when the browser can't reach 120 fps.

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
  hub.js                       WebSocket hub (/api/capture/ws): presence, clock pings, timed start/stop, relays
  cloud.js                     streaming + retrying mirror to Firebase / R2 (Railway)
  validators.js                pre-accept checks (pluggable)
  media.js                     ffmpeg: probe, still, motion map
  sync-audio.js                chirp matched filter (FFT) → exact camera offset
  processing.js                processor interface; SAM 3D Body adapter
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
   The validators run this before accept, stored as `syncResult` on the take.

**Missed stop.** A camera that drops off the network mid-take keeps recording, with its chunks
safe on the device. On reconnect it learns the take was stopped and finalises at the director's stop
time, noted as `stopReconciled`. It also caps a take at 120 s without contact.

**The director's STOP** is resent every 2 s until the server confirms it, including across a
dropped connection or a server restart. A director page refreshed mid-take comes back with STOP.

**Which cameras a take waits for.** The ones that were READY when RECORD was pressed
(`expectedCams`). If one of them never uploads (its phone died), **REVIEW WITHOUT CAM B** appears
after 10 s. The missing camera's footage is still added to the take if it arrives later.

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

On most phones, web pages get 30 or 60 fps even when the camera app does 120/240. When that
happens, the director and camera screens say so, and there are two native paths:

- **Now: native file per take.** Record the same take with the phone's camera app at 120/240 fps,
  then attach it under **Takes → + camX 120 fps file**. Its audio contains the director's sync
  chirp, so it is aligned to the take automatically. It is stored as `camX.native.mov` next to the
  web recording, with its probe and chirp position.
- **Next: a native camera app** implementing the same protocol:
  1. join with the pairing token: `POST /api/capture/pair {token}`;
  2. open the WebSocket `/api/capture/ws?session=…&token=…`, send `hello {role: camB}`, and `ping`
     every second;
  3. report `state {ready, camera, clock}`;
  4. start at `record.at` and stop at `halt.at`;
  5. upload with `PUT …/rec/:id/camB/chunk/:n`, then `POST …/complete {chunks, mimeType, frames, meta}`.

  The director UI and server don't change. `capture/camera.mjs` defines the interface the native
  side mirrors: open, describe, start, stop, onChunk.

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
- **SAVED ✓** appears only after the take's files, its record (marked accepted) and the session's
  progress are all stored in the bucket.
- **Footage the server no longer knows** (e.g. a session removed by hand) is never deleted from the
  phone. It is kept aside, and the camera page offers **SAVE TO PHONE** or **DISCARD**.
- **Retakes.** Takes are never deleted automatically. Each animation keeps all its takes and one
  `selectedTake` (MARK BEST changes it); rejected takes stay until cleaned up by hand.

## Calibration

- One calibration recording per court setup, kept apart from the takes in `calibrations/`. Its
  court landmarks are tapped per camera, as normalised image points paired with court metres.
- When a calibration is accepted, both cameras keep a reference view. It is stored on the server
  (`calrefs/`), so a reloaded camera page keeps watching. A camera that has no reference for an
  accepted calibration (it was not connected then) flags it, so the director recalibrates.
- A camera is considered moved when a whole-picture shift explains a change in its view (edge maps,
  ±4 px of 64), or when the phone is bumped (device motion). That marks the setup's calibration
  **suspect**, and the director is prompted to recalibrate.
- A player walking through the view doesn't count as a move.
- You can skip calibration ("Cameras are placed — skip"); that is recorded as `skipped`.
- Court landmarks and known dimensions are in `court-layout.mjs` (`COURT.landmarks`). A ChArUco
  board can be recorded in the same calibration take.

## Checks before accept (`lib/capture/validators.js`)

| Check | What it tests |
|---|---|
| Cameras | Both recorded |
| Files | Each file exists and is non-trivial |
| Duration | Each recording decodes and its duration is plausible for the target; both cameras' lengths agree |
| Metadata | Metadata is complete |
| Frame rate | Measured fps, compared with negotiated |
| Clock | Clock sync uncertainty and start skew |
| Sync chirp | Heard by both cameras (exact offset) |
| Cropping | Motion running off two frame edges (a cheap motion map) |

A **fail** blocks ACCEPT unless you choose ACCEPT ANYWAY; a **warn** is only shown. Planned slots,
same signature: body visible (2D pose), ball visible, feet visible, blur, exposure.

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

## Processing: the current SAM 3D pipeline

`GET /api/capture/processors` lists the back-ends. `POST /api/capture/sessions/:sid/rec/:id/process
{processor: 'sam3dbody', cam, fps, maxFrames, confirmCostUsd, role}` sends one camera view of a take
through the existing mocap pipeline (`lib/mocap/pipeline.js`: SAM 3 + SAM 3D Body on fal.ai). The
result is a motion in the clip library. With `role` (from the animation's `gameRoles`, e.g.
`cross_RL → move-crossover`), the court picks it up as a game clip.

It is paid, about $0.03 per frame. It refuses to run without `confirmCostUsd` ≥ the estimate, and
the director UI asks first. The result is recorded on the take (`processing.sam3dbody.camA.motionId`).
A multi-view processor (both cameras + calibration → triangulated 3D) plugs into the same interface.

## Tests

- `npm test` runs:
  - `tests/capture.test.js`: the BASIC-01 library and state graph, capture order and next missing,
    clock sync, alignment, chunk storage and assembly, the export tar, validators on a generated
    video, the chirp detector and the camera-moved detector;
  - `tests/capture-server.test.js`: the real server in its production shape (password gate on, a
    local folder standing in for the bucket), driven over HTTP and WebSocket:
    - a full take;
    - a **redeploy** (process killed, local disk wiped) mid-review, mid-upload and mid-check: the
      takes, videos, stills and export come back from the bucket;
    - which cameras a take waits for, and REVIEW WITHOUT;
    - accept and MARK BEST;
    - a late STOP;
    - security: a camera token can't act as director or reach director endpoints; pairing limits,
      code expiry and body size limits;
    - crash resistance: an oversized WebSocket frame, malformed URLs, `GET //`.
- `node tests/capture-e2e.spec.js` runs two simulated phones (separate Chromium instances with fake
  camera and microphone) against a dedicated server, with a folder as the bucket (41 checks):
  - pairing by QR link and one tap, both READY, calibration with landmarks;
  - record, retake, ACCEPT + NEXT, SAVED ✓, refresh-resume;
  - camera B offline mid-take (chunks kept on the device, uploaded after reconnect);
  - camera B reloaded mid-take (its partial recording still completes the take);
  - a STOP 0.2 s after RECORD (no recorder left running);
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

- **Web capture frame rate.** It is usually 30 or 60 fps on phones (iOS Safari especially). Use the
  native file path for 120/240 fps until a native camera app exists.
- **Safari's recorder.** It records MP4; on some versions the whole take arrives at STOP instead of
  streaming. It is still saved to the device first, then uploaded.
- **Keep the camera app open.** Phones stop the camera when locked or backgrounded. The app requests
  a screen wake lock; keep phone B on its tripod with the page open.
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
