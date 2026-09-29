# Character Factory — plan and architecture

Source of truth for the character factory inside Soul Jam (this repo, `sprite-factory`). Written
after inspecting the repository on 2026-09-29; the "current architecture" section describes what
exists, the rest is what the factory adds and how it plugs in.

## 1. Current project architecture (as found)

| Area | What exists |
|---|---|
| Server | Plain Node `http` server (`server.js`), a small `Router` (`:param` patterns), route modules in `routes/*.js` (CommonJS) registered with a `ctx` of helpers (`json`, `parseBody`, `serveStatic`, …). |
| Auth | `middleware/auth.js` gate: `APP_PASSWORD` → sign-in cookie / `Authorization: Bearer`. Unset locally = open. Every `/api/*` sits behind it. |
| Storage | Local disk (`data/`, `lib/mocap/mhr-rigs/`), with Firebase Storage or R2 backup when `FIREBASE_SERVICE_ACCOUNT` / `R2_*` are set (not set on the Mac). |
| Frontend | Static HTML pages per tool (`index-v2.html` studio, `mocap.html`, `court3d.html`, `skeleton-viewer.html`, …). No bundler; ES modules; the court uses self-hosted three.js r160 (`/vendor/three.module.min.js`). The studio pages use plain DOM JS. |
| 3D court | `court3d.html` + `engine3d/*.mjs`: skinned characters, Rapier physics basketball, contact IK, the VANTHEAH rooftop court and a light "classic" court. Test hooks on `window.__court3d` / `window.__c3dTest`. |
| Skeleton | **MHR, 127 joints** (`lib/mocap/mhr-rigs/player.json.gz`: names, parents, bind positions / rotations, keypoint joints). Twist joints on arms / legs / neck, full finger chains (thumb0–3, index/middle/ring 1–3 + tips, pinky0–3), no facial joints. This is **SOUL_JAM_MASTER_SKELETON** (see `docs/SOUL_JAM_MASTER_SKELETON.md`). |
| Animation | Clips are **keypoint clips** (`gameclip-v2`: 70 MHR70 keypoints per frame in root space, root motion, contacts, ball). The runtime (`engine3d/anim3d.mjs` Player) blends them and `engine3d/mhr-skin.mjs` solves the 127-joint pose for **any** rig from its rest keypoints / bone lengths. A character on the master skeleton therefore plays every current and future clip with no per-character retarget. |
| Characters | Rig JSON (`kind: mhr`) with `parts` (skinned meshes: verts, UVs, 4 weights on the 127 joints, textures served from `/chars/<id>/…`). Importers: `scripts/import-rigged-character.js` (GLB already on MHR), `scripts/import-mixamo-character.mjs` (Mixamo / Tripo / UE5-named skeletons → MHR). |
| Clip data | Stored in Firebase / R2; **not on the Mac** (no storage credentials), so the local court has no clips (it stops at "No idle loop yet"). Production (Railway) has them behind `APP_PASSWORD`. |
| Blender | Blender 5.1.2 at `/Applications/Blender.app`; earlier Blender Python scripts under `scripts/mhr/`, `scripts/mpfb/`. |
| Design system | Claude Design export "Sprite Factory v2" (`souljam/tokens.css`, `sf*.css`): paper / ink panels, 3 px ink borders, hard offset shadows, Anton / Oswald / Space Mono, soul gradient purple → orange. |

## 2. Target architecture

```
REFERENCE INPUT (upload / provider)          ReferenceImageProvider: uploaded (now), gpt-image / higgsfield / custom (interface)
      │
REFERENCE LAB  — classify (part, view), clean crop, split hand sheets, validate (green / yellow / red)
      │
      ├── BODY ─┐   Tripo H3.1 per part, multiview when ≥ 2 views (explicit view keys),
      ├── HEAD ─┤   image-to-model otherwise; detailed geometry, extreme PBR texture, seeds saved
      ├── HAND L┤   parallel job pool (TRIPO_CONCURRENCY), resumable, cached by input hash
      ├── HAND R┤
      └── extras┘  (hair / shoes / clothing: same stage, optional)
      │
SOURCE_HIGH (never overwritten: source/tripo/<part>/<task_id>/)
      │
ASSEMBLY (Blender) — head: landmarks + trimmed ICP; hands: wrist trace + frame + ICP; seam ring fit
      │
GAME_MESH (Blender) — weld, voxel fuse, seam-band smooth, detail-weighted decimate, UVs,
      │                bake base colour / normal / roughness / metallic / AO
RIG — Tripo rig-check → rig (Mixamo spec) → weights transferred onto our game mesh → LOD chain
      │
SOUL_JAM_MASTER_SKELETON — import-mixamo-character.mjs via tools/character_pipeline/tripo_to_souljam_bones.json
      │
ANIMATION + DEFORMATION VALIDATION — deform-test.mjs in the real court page (synthetic + game clips)
      │
LODs (rig JSON `lods`, runtime distance switch)
      │
GAME READY → COURT TEST (court3d.html?char=<id>) → PUBLISH (registered in custom.json)
```

## 3. Stage graph (dependencies and invalidation)

Stages and their inputs (`tools/character_pipeline/state.mjs`):

| Stage | Depends on | Cache key inputs |
|---|---|---|
| `ingest` | reference files | image hashes, overrides.json, pipeline version |
| `validate` | ingest | classification |
| `generate:<part>` | ingest (that part's cleaned views) | view hashes, model, params, seeds |
| `assemble` | every `generate:<part>` | source files (size + mtime), height |
| `gamemesh` | assemble | assemble key, LOD0 budget, bake size |
| `rig` | gamemesh | game mesh file, LOD budgets |
| `import` | rig | rigged LOD files, texture size, importer hash |
| `lods` | import | rig JSON |
| `preview` (animation / deformation validation) | import | rig JSON |
| `courttest` | import | rig JSON |

A stage is **done** when its recorded key equals the key of its current inputs; **stale** when it
ran but an input changed (e.g. the head was regenerated → assemble, gamemesh, rig, import, lods,
preview, courttest become stale; body / hands generation stay valid); **ready** when its
dependencies are done; **blocked** when a dependency is not; **running** when a job holds it;
**failed** with the last error. The pipeline status shown in the UI is derived from these, never
from UI state:

`DRAFT → REFERENCES_INCOMPLETE → REFERENCES_READY → GENERATING_SOURCE → SOURCE_READY → ASSEMBLING →
ASSEMBLED → OPTIMIZING → GAME_MESH_READY → RIGGING → RIGGED → ANIMATION_VALIDATION → COURT_VALIDATION →
GAME_READY` (+ `FAILED` when the earliest unfinished stage failed).

## 4. Storage format

```
assets/characters/<id>/
  manifests/character.json      the manifest (committed)
  references/_original/         uploads as received
  references/<part>/<view>.png  cleaned crops sent to generation
  source/tripo/<part>/<task>/   SOURCE_HIGH per task (history kept)
  assembled/high.blend|glb      assembled SOURCE_HIGH + assemble-report.json
  game/lod0.glb, game.blend     GAME_MESH + gamemesh-report.json
  textures/*.png                baked maps (4K hero)
  rigs/tripo_rig.glb, lods/     Tripo rig output, rigged LODs, rigmerge-report.json
  previews/                     assembled renders, deformation screenshots, LOD shots, comparison
  versions/v<n>/                snapshots of the game rig + manifest at each game-ready build
  logs/                         stage and job logs
assets/characters/_jobs/<job>.json   persistent job records (all characters)
lib/mocap/mhr-rigs/<rig-id>.json.gz  the game rig (+ <rig-id>-tex/*.webp), registered in custom.json
```

Heavy / private working files are gitignored (references, sources, blends); the manifest and the
game rig are committed. The repo is public: references of real people stay out of git.

Manifest (`character.json`) main fields: `id, name, style, notes, heightMeters, quality,
pipelineVersion, references[] (name, sha256, part, view, source, confidence, cleaned, warnings),
validation, generation.<part> (mode, model, params, seeds, views, task {id, status, createdAt,
finishedAt, credits, output}, files, sourceHigh, history[]), credits {spent, log[]}, stages.<stage>
(key, status, at, seconds, outputs, report, error), lods, skeletonVersion, textureVersion,
versions[], errors[]`.

## 5. Jobs, concurrency, resume

* The CLI (`npm run character -- …`) is the single implementation. The server's API starts CLI
  processes (`child_process.spawn`, argument arrays only — no shell), one per job, and never
  reimplements a stage.
* Job records (`assets/characters/_jobs/<job>.json`): character, operation, part, stage, status
  (`queued · running · done · failed · cancelled`), pid, start / end, duration, credits, log path,
  current step text. The CLI updates its own record; the server reads them. Records survive
  restarts; a record whose pid is gone while "running" is shown as `interrupted` with a Resume
  action.
* One pipeline job per character at a time (lock); Tripo generation runs its parts in parallel
  up to `TRIPO_CONCURRENCY` (default 3).
* Resume = run from the first stage that is not done. Tripo tasks already created are polled, not
  re-created; finished downloads are reused.
* Cancel stops the local process. A Tripo task already submitted keeps running on Tripo's side and
  is billed; the UI says so.

## 6. Cost and time

Credits come from Tripo's own task field (`credits_consumed`) and are exact. USD is shown only as
an estimate when `TRIPO_USD_PER_CREDIT` is set (labelled "estimated"). Per stage: start, end,
seconds; per Tripo task: created / finished. The dashboard averages only over finished builds.

## 7. API (server: `routes/character-factory.js`, prefix `/api/cf`)

| Method | Path | Does |
|---|---|---|
| GET | `/api/cf/status` | Tripo key configured?, balance (live), Blender found?, concurrency, limits, clip library available? |
| GET | `/api/cf/characters` | list: id, name, status, stage, thumbnail, triangles, rig / LOD state, credits, updatedAt |
| POST | `/api/cf/characters` | create `{name, id?, heightMeters?, style?, notes?, quality?}` |
| GET | `/api/cf/characters/:id` | manifest + derived stage graph + pipeline status + files |
| PATCH | `/api/cf/characters/:id` | name / notes / height / quality |
| DELETE | `/api/cf/characters/:id` | removes the character folder (and its game rig + registry entry); requires `?confirm=<id>` |
| POST | `/api/cf/characters/:id/duplicate` | new id with the same references (no generated assets) |
| POST | `/api/cf/characters/:id/references?name=<file>` | raw image body → saved to `references/_original`, re-ingest, returns classification |
| PATCH | `/api/cf/characters/:id/references/:name` | correct `{part, view, side?}` → overrides.json, re-ingest |
| DELETE | `/api/cf/characters/:id/references/:name` | remove an upload, re-ingest |
| POST | `/api/cf/characters/:id/jobs` | start `{op: build · resume · generate · assemble · gamemesh · rig · import · validate · preview · courttest, part?}` |
| GET | `/api/cf/jobs` | all jobs (newest first), `?character=` filter |
| GET | `/api/cf/jobs/:job` | one job + log tail |
| POST | `/api/cf/jobs/:job/cancel` | stops the process |
| GET | `/api/cf/characters/:id/file?path=` | a file inside the character folder (images, GLB, reports) — path-checked |
| GET | `/api/cf/characters/:id/versions` | version snapshots |
| GET | `/api/cf/summary` | factory dashboard aggregates (real counts, credits, average build time) |

## 8. UI (`/factory` — Sprite Factory v2 shell)

Global: **Characters · Create · Moves · Playground · Jobs · Settings** (header tabs, design's
`apptabs`). Inside a character (`/factory/characters/<id>/<section>` deep links, History API):
**Overview · References · Parts · Assembly · Rig · Animation · Appearance · LODs · Court Test**.
Every control maps to an API call above; a missing credential shows its blocked state with the fix.
The 3D viewer (three.js r160 + GLTFLoader) loads one model at a time (lazy), modes textured / clay /
wireframe / normals / skeleton, real counts from the loaded geometry.

## 9. Security

The Tripo key lives only in the server's environment (`.env`, gitignored); the browser never sees
it. Uploads: images only (PNG / JPEG / WebP, ≤ 20 MB, magic-byte check), names sanitised, stored
inside the character folder. Character ids `^[a-z0-9_-]{2,40}$`. File serving resolves the path and
refuses anything outside the character folder. Jobs pass whitelisted operations and validated ids
as argv to the CLI.

## 10. Testing

`tests/character-factory.test.js`: manifest create / save, stage keys and invalidation (head
regenerated → downstream stale, body not), pipeline status derivation, reference classification on
fixtures, Tripo request construction (view keys, params, seeds), credit accounting and the credit
limit, job persistence and interrupted detection, skeleton mapping file, path sanitising, API
routes (create → upload → classify → job listing). Visual checks: `deform-test.mjs` (poses,
screenshots, LODs, comparison), `scripts/court3d-test.js --char`.

## 11. Scaling

* **10 characters**: as built — one Mac, sequential pipelines, Tripo parts in parallel.
* **100**: job queue across characters (global concurrency for Blender = cores / 2, Tripo pool per
  account limit); cache hits make LOD / rig changes cheap; textures 2K for standard quality.
* **1,000**: the same CLI on worker machines pulling jobs from shared storage (the job records and
  manifests are already per-file JSON); rigs published to R2 / Firebase instead of the repo; the
  character select loads a thumbnail + LOD2 first.

## 12. Facial standard (future)

Heads keep no per-character facial controls. A future `SOUL_JAM_FACE` standard (blink L/R, jaw
open, smile, frown, brow up / down, eye look, visemes) will be blend shapes defined once on a
reference head topology and transferred per character; the rig JSON reserves `face: null`.
