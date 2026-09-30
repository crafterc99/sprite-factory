# Soul Jam Capture: two-phone recording for the animation library

Soul Jam Capture records a clean, synchronised, structured two-camera video dataset of basketball
moves, one animation at a time, for the mocap pipeline. Phone A is the director and camera A. Phone
B is camera B and needs no touching after pairing. Written for whoever runs a capture session, and
for engineers extending it.

The capture step is independent of any pose model. Processing (SAM 3D Body today, multi-view
reconstruction later) plugs in behind a processor interface.

## Run a session

**What you need**
- Two phones on a tripod each.
- The Mac running the studio (`bash mac-dev.sh`).
- The same Wi-Fi for all three, or the public Railway link (see below).

**Steps**
1. **Start the studio on the Mac.** Its log prints the phone address, for example
   `Capture (phones, same Wi-Fi): https://10.0.0.83:3443/capture`.
2. **Phone A (director):** open that address. The first time, the browser warns about the Mac's own
   certificate: on iOS tap *Show Details → visit this website*, on Android tap *Advanced → Proceed*.
   Then tap **New BASIC-01 session**, and allow the camera. Phone A is camera A.
3. **Pair phone B:** on phone A tap **Pair camera**, then scan the QR code with phone B and accept
   the certificate once. On phone B tap **TAP TO START CAMERA**. That is phone B's only touch.
   - You can also type the 6-digit code on phone B's `/capture` home page.
4. **Place the cameras** as the Setup card shows (top-down court diagram, CAM A and CAM B positions,
   framing rules). Tap **CALIBRATE SETUP A**, then walk the court lines and stand under the rim for
   about 10 s. Tap **STOP**, then **ACCEPT CALIBRATION**. Optionally tap the landmarks on each
   camera's still.
5. **Record.** Both pills show `● READY`.
   - Press **RECORD BOTH**; the athlete performs the move at game speed; press **STOP**.
   - Both recordings upload and are checked, then press **ACCEPT + NEXT**. **SAVED ✓** appears only
     after the files and metadata are stored, then the next missing animation loads.
   - **RETAKE** keeps the footage; nothing is ever deleted automatically.
6. **Change setup.** When setup A is finished, the app shows the Setup B card: move the cameras,
   calibrate, and continue.
7. **Stop any time.** Later, open `/capture` and tap **CONTINUE MISSING** on the session. It jumps
   to the next missing animation in the most efficient setup order.
8. **Export** (menu at the bottom): download the organised dataset as a `.tar`.

**Public link instead of the Mac (not deployed yet):** once this branch is on Railway,
`https://sprite-factory-production.up.railway.app/capture` works the same, with real HTTPS and no certificate warning. The director
signs in to the studio; phone B only needs the QR code. On Railway, takes are mirrored to cloud
storage before SAVED ✓.

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
  phone's IndexedDB. They are uploaded in order, idempotently, with retry and backoff, and deleted
  only after the server confirms them. The "complete" message waits for its chunks. A refresh, an
  app restart or a Wi-Fi drop resumes the queue on the next load.
- **Server.** Files are stored under `data/capture/sessions/<id>/`, with atomic JSON writes
  (temp + fsync + rename). Nothing that matters lives only in memory. The director page rebuilds
  itself from the server after a refresh, including a take mid-upload.
- **Cloud.** When cloud storage is configured (Railway), every accepted take's files are mirrored
  to `_meta/capture/…` **before** SAVED ✓. Sessions restore from there after a redeploy.
- **Retakes.** Takes are never deleted automatically. Each animation keeps all its takes and one
  `selectedTake` (MARK BEST changes it); rejected takes stay until cleaned up by hand.

## Calibration

- One calibration recording per court setup, kept apart from the takes in `calibrations/`. Its
  court landmarks are tapped per camera, as normalised image points paired with court metres.
- When a calibration is accepted, both cameras keep a reference view.
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

- `npm test` runs `tests/capture.test.js`:
  - the BASIC-01 library and state graph;
  - capture order and next missing;
  - clock sync;
  - alignment;
  - store chunk and assembly;
  - export tar;
  - validators on a generated video;
  - the chirp detector;
  - the camera-moved detector.
- `node tests/capture-e2e.spec.js` runs two simulated phones (separate Chromium instances with fake
  camera and microphone) against a dedicated server with its own data folder:
  - pairing by QR link and one tap;
  - both READY;
  - calibrate setup A with landmarks;
  - record, retake, record, ACCEPT + NEXT, SAVED ✓ and the next missing animation;
  - refresh-resume;
  - camera B offline mid-take (chunks kept on the device, uploaded after reconnect, the missed stop
    reconciled);
  - camera B page reload re-pairs;
  - home → CONTINUE MISSING;
  - export layout and metadata.

## Settings

| Environment variable | Default | What it does |
|---|---|---|
| `CAPTURE_DIR` | `data/capture` | Where sessions and takes are stored |
| `CAPTURE_HTTPS_PORT` | `3443` | Port of the LAN HTTPS listener |
| `CAPTURE_HTTPS=0` | on | Turns the LAN listener off (it is never started on Railway) |
| `CAPTURE_CLOUD=0` | on | Turns the cloud mirror off |
| `CAPTURE_DEBUG=1` | off | Logs hub liveness and event-loop stalls |

## Known limitations

- **Web capture frame rate.** It is usually 30 or 60 fps on phones (iOS Safari especially). Use the
  native file path for 120/240 fps until a native camera app exists.
- **Safari's recorder.** It records MP4; on some versions the whole take arrives at STOP instead of
  streaming. It is still saved to the device first, then uploaded.
- **Keep the camera app open.** Phones stop the camera when locked or backgrounded. The app requests
  a screen wake lock; keep phone B on its tripod with the page open.
- **Self-signed certificate.** On the Mac's LAN listener each phone accepts the warning once. The
  Railway link has none.
- **Calibration is stored, not solved.** Recordings, landmarks and camera priors are saved; solving
  the camera poses (PnP / bundle adjustment) belongs to the processing side.
- **Moved detection is an estimate.** It is a cheap image-shift and device-motion heuristic that
  prompts the operator; it doesn't prove the calibration is still valid.
