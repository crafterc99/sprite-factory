# Project: Sprite Factory Core

| Field | Value |
|---|---|
| **Status** | IN_PROGRESS |
| **Last Updated** | 2026-06-11 |
| **Owner** | Claude Code |

## Goal
A full pipeline for generating NBA player sprite sheets using Gemini image generation. Takes reference footage or images, generates animation frames (idle, dribble, crossover, jumpshot, etc.) at multiple angles, and exports production-ready sprite sheets.

## Milestones
- [x] Server with REST API (server.js)
- [x] Studio UI (index-v2.html)
- [x] Character + animation definitions (lib/sprite-generator/prompts.js)
- [x] Nano Banana Pro (Gemini) client (lib/sprite-generator/nano-banana.js)
- [x] Frame-by-frame generation endpoint
- [x] Strip generation (multi-angle reference)
- [x] Pipeline with gap-filling and bulk generation
- [x] Cost tracking
- [x] Evaluation and audit endpoints
- [x] Soul Jam export format
- [x] Smart frame selector (lib/sprite-generator/smart-selector.js)
- [x] Reference strip builder (lib/sprite-generator/strip-builder.js)
- [x] Default model updated to gemini-3-pro-image-preview (Nano Banana Pro)
- [ ] Stable end-to-end generation on Railway (public URL)
- [ ] Full character roster complete (all planned characters with all animations)
- [ ] Production export pipeline validated

## Current State
Core pipeline is functional locally. Generation uses `gemini-3-pro-image-preview` as the default model. Server exports a handler for both local (nodemon) and serverless (Vercel) modes.

Key routes:
- POST /api/generate/strip — generate full animation strip
- POST /api/generate/fbf — frame-by-frame generation
- POST /api/generate/angles — multi-angle generation
- POST /api/pipeline/run — run full pipeline for a character
- POST /api/evaluate/animation — evaluate generated frames
- POST /api/export/soul-jam — export to Soul Jam format

## Next Steps
1. Confirm Railway deployment is stable (see railway-deployment.md)
2. Run a full generation test from the Railway URL
3. Begin filling gaps in the character roster via pipeline

## Blockers
None currently — pending Railway stability.

## Log

| Date | What happened |
|---|---|
| 2026-06-11 | Testing scale/speed sliders sync globally via testing-config (R2) — same values on every device |
| 2026-06-11 | Starting-hand toggle on video save + studio settings editor (fps/loop/hand via meta PATCH); ?w= asset thumbnails fix slow dashboard/studio character loading; video boxes restore their save settings for editing |
| 2026-06-11 | Perf: 304 conditional GETs + swr caching (HTML/engine/images), roster + R2-health micro-caches; video thumbs 480px lanczos (blur fix) + max-quality frames; Studio anim reference delete button |
| 2026-06-10 | Video tab: multi-video session boxes (Studio-style) with background extract/cutout, parallel non-blocking processing (async ffmpeg/yt-dlp/curl), localStorage+server state restore with auto-resume |
| 2026-06-10 | Video tab: JPEG+thumbnail extraction (single ffmpeg pass), format-agnostic frame routes, soft-edge de-spilled cutouts at 768x1024 native res (no upscale), 1024px ref strips, sliding cutout pool |
| 2026-06-10 | Prompts tab removed (UI, prompt-lab/prompt-manager/pipeline2 routes, prompt-system engine); generation-facing prompt stores kept (char prompts, frame prompts, angle/ball overrides, training) |
| 2026-06-10 | Testing tab: procedural hoop removed (hoop image upload auto-removes background); animation switches/moves now wait for the current anim's last frame (smooth transitions); movement editor replaced by a simple permanent crossover/stepback Soul Jam applicator; speed slider now drives Game Mode playback |
| 2026-06-09 | Game Mode movement fixed: actions now resolve movement data (saved editor values > presets); added Soul Jam burst physics (linear-decay separation bursts) with stepback/crossover direction applicators; procedural vector hoop replaces image overlay in Testing tab |
| 2026-03-31 | Default model changed to gemini-3-pro-image-preview across all 5 generation endpoints |
| 2026-03-31 | Fixed chalk ESM crash in strip-builder.js and smart-selector.js |
| 2026-03-31 | Vercel deployment added (assets excluded from bundle due to 250MB size limit) |
