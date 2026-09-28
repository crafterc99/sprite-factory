# Motion Capture (Stage 1) — video → any character, any angle

Open **/mocap** (or the "Mocap 3D" button in the studio nav).

## Railway variables

| Variable | Needed for | Notes |
|---|---|---|
| `APP_PASSWORD` | Private studio | Turns on the login page. Private link: `https://<app>/mocap?key=<password>` signs a device in for 30 days. |
| `FAL_KEY` | Analysis (required) | fal.ai key. SAM 3 image ($0.005/prompt, 2 per frame) + SAM 3D Body ($0.02/frame) ≈ **$0.03 per frame**. |
| `OPENAI_API_KEY` | GPT Image 2.5 Sunburst / Flare | Optional. Native transparent output (no green-screen fringe). |
| `GEMINI_API_KEY` | Nano Banana Pro / 2 | Already set for the studio. |
| `FIREBASE_SERVICE_ACCOUNT` | Persistent storage (recommended) | Firebase console → Project settings → Service accounts → **Generate new private key** → paste the whole JSON. Enable **Build → Storage** first. Optional `FIREBASE_STORAGE_BUCKET` if the bucket isn't `<project>.firebasestorage.app` / `<project>.appspot.com`. Takes priority over R2 (`STORAGE_BACKEND=r2` forces R2). |
| `R2_*` | Persistent storage (alternative) | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (+ `R2_PUBLIC_URL` for the game). |
| `MOCAP_MOCK=1` | Local dev/tests only | Synthetic providers, no keys. **Never set on Railway.** |

## Pipeline

```
video ─► ffmpeg frames (sample fps, trim)
      ─► SAM 3 "person" mask + "basketball" circle     (real pixels, nothing redrawn)
      ─► SAM 3D Body per frame (MHR70 2D/3D keypoints + camera), mask-guided
      ─► motion-builder: convention auto-detect · camera→y-up world · ball depth from its
         known size · gap fill · L/R swap repair · outlier filter · smoothing · level ground ·
         face forward · ground + per-frame floor snap (depth drift when travelling; jumps kept)
         · foot lock (±12 cm) · stature · smoothed in-place root · dribble physics (in-hand
         vs. flight + floor bounce)                                    → motion.json (reusable)
         + per frame: the SAM 3D Body MESH (.ply) aligned to that frame's keypoints, and a
           close-up of the ball hand (real pixels) — stored with the motion
      ─► pose guide (per game zone yaw, character's real height, one px/m per animation):
         the performer's body scan re-posed on the CLEANED motion (every vertex bound to
         its bone along the surface), software z-buffer render — shaded clay, blue = left
         limbs, red = right, dark outlines at depth edges, eyes when facing camera.
         Motions without a mesh fall back to the stick mannequin (MOCAP_GUIDE=mannequin
         forces it). "Add 3D body mesh" on the Motion step backfills older motions.
      ─► image model: [angle ref, guide, anchor frame, performer cut-out, HAND close-up,
         portrait] → character in that pose (compact 2-sheet mode on low rate limits)
         Ball IN HAND → drawn in the guide as a flat magenta disc; the model draws the grip
         around it (fingers over the disc)
      ─► compose: bg → alpha · align silhouette to mannequin (feet/height/centre, scale
         clamped ±12% of the animation median; magenta excluded from sizing) · magenta disc →
         canonical ball (fingers stay in front) · ball in flight / no disc → canonical ball
         composited from physics in front/behind   (MOCAP_BALL_PROXY=0 disables the disc)
      ─► QC: pose coverage · spill · colour vs anchor · ball leak · size → auto-retry
      ─► 180×180 strip (feet y=170, stature = pixelHeight, same window every frame)
         + 540×540 frames + genmeta.json {mode:'mocap-aligned'}
      ─► Save to slot → {slot}_z{zone}_{hand} (same as the studio's slot assignment)
```

Left-hand variants mirror the 3D motion (not the finished sprite), so jersey numbers
and other one-sided details stay correct.

## Filming tips
- Full body in frame, head to feet, steady camera; 60 fps + good light for dribbles.
- Stand still for ~0.5 s before the move (sets the floor and your height).
- Any camera angle works — the motion is rotated to each game zone. Angles more than
  ~90° from where you filmed (e.g. Back when filmed from the front) are inferred.

## Storage
`data/mocap/<motionId>/{meta,raw,motion}.json` → R2 `_meta/mocap/...` (restored on demand).
Re-cleaning (smoothing, trim, foot lock) re-runs from `raw.json` for free.

## Tests
`npm test` — motion recovery, auth gate and the full HTTP pipeline in mock mode.
