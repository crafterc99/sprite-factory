# Motion Capture (Stage 1) — video → any character, any angle

Open **/mocap** (or the "Mocap 3D" button in the studio nav).

## Railway variables

| Variable | Needed for | Notes |
|---|---|---|
| `APP_PASSWORD` | Private studio | Turns on the login page. Private link: `https://<app>/mocap?key=<password>` signs a device in for 30 days. |
| `FAL_KEY` | Analysis (required) | fal.ai key. SAM 3 image ($0.005/prompt, 2 per frame) + SAM 3D Body ($0.02/frame) ≈ **$0.03 per frame**. |
| `OPENAI_API_KEY` | GPT Image 2.5 Sunburst / Flare | Optional. Native transparent output (no green-screen fringe). |
| `GEMINI_API_KEY` | Nano Banana Pro / 2 | Already set for the studio. |
| `MOCAP_MOCK=1` | Local dev/tests only | Synthetic providers, no keys. **Never set on Railway.** |

## Pipeline

```
video ─► ffmpeg frames (sample fps, trim)
      ─► SAM 3 "person" mask + "basketball" circle     (real pixels, nothing redrawn)
      ─► SAM 3D Body per frame (MHR70 2D/3D keypoints + camera), mask-guided
      ─► motion-builder: convention auto-detect · camera→y-up world · ball depth from its
         known size · gap fill · L/R swap repair · outlier filter · smoothing · level ground ·
         face forward · ground + foot lock · stature · in-place root   → motion.json (reusable)
      ─► mannequin (per game zone yaw, character's real height, one px/m per animation;
         blue = left limbs, red = right limbs, face dots only when facing camera)
      ─► image model: [angle ref, mannequin, anchor frame, portrait] → character in that pose
      ─► compose: bg → alpha · align silhouette to mannequin (feet/height/centre, scale
         clamped ±12% of the animation median) · canonical ball composited in front/behind
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
