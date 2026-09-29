# Character Factory

Turns illustrated reference images of a player into a textured, rigged, game-ready Soul Jam
character on the game's own skeleton, playing every existing basketball clip. Architecture and API:
[`docs/character-factory-plan.md`](../../docs/character-factory-plan.md). Skeleton:
[`docs/SOUL_JAM_MASTER_SKELETON.md`](../../docs/SOUL_JAM_MASTER_SKELETON.md).

## Setup (once)

```bash
cp .env.example .env            # then set TRIPO_API_KEY=tsk_…  (never commit .env)
npm install --cache ./.npm-cache
```

Blender 5.x must be installed (`/Applications/Blender.app` is found automatically; else set
`BLENDER_BIN`). Optional: `MAX_TRIPO_CREDITS_PER_CHARACTER` (default 600), `MAX_RETRIES_PER_STAGE`
(2), `TRIPO_CONCURRENCY` (3 parallel Tripo tasks), `TRIPO_USD_PER_CREDIT` (shows estimated USD).

## Commands

```bash
# a new character from a folder of reference images (any names; classified automatically)
npm run character -- build my_guy_002 --refs ./refs/my_guy_002 --quality hero --height 1.93

npm run character -- status my_guy_002          # every stage: done / stale / ready / failed
npm run character -- resume my_guy_002          # continue from the first unfinished stage
npm run character -- generate my_guy_002 --part head                  # regenerate the head only
npm run character -- generate my_guy_002 --part hand_left,hand_right  # regenerate both hands
npm run character -- rebuild my_guy_002 --stage gamemesh              # redo a stage and everything after it
npm run character -- rebuild my_guy_002 --stage rig --only            # just that stage
npm run character -- validate my_guy_002        # ingest + reference validation (no credits)
npm run character -- preview my_guy_002         # deformation poses + screenshots in the real court
npm run character -- court-test my_guy_002      # the game's court check with this character

# a model made elsewhere (e.g. downloaded from Tripo Studio as GLB) as a part's master: no credits
npm run character -- use-source my_guy_002 --part head --file ~/Downloads/head.glb
```

The UI (`/factory` on the local server) starts the same commands as jobs.

## Stages

| Stage | What | Output |
|---|---|---|
| ingest | originals kept, each image classified (part, view), cleaned (subject only), two-hand sheets split | `references/<part>/<view>.png`, manifest `references[]` |
| validate | size, cropping, background, missing views, identity proxy — warnings; blocks only when generation is impossible | manifest `validation` |
| generate | Tripo **v3.1-20260211** per part (body, head, hand_left, hand_right, extras): multiview with explicit view keys when ≥ 2 views, image-to-model otherwise; `geometry_quality: detailed`, `texture: true`, `pbr: true`, `texture_quality: extreme`, `texture_version: v3.5-20260815`, `export_uv: true`; seeds saved; parts in parallel | `source/tripo/<part>/<task>/` (SOURCE_HIGH, never overwritten) |
| assemble | Blender: body faced +Z, feet on the floor, scaled; head aligned by landmarks + trimmed ICP; wrists traced, hands aligned by wrist / axis / back-of-hand frame + ICP, scaled by hand length; neck and wrist rings fitted; cuts at the seam planes | `assembled/high.blend`, `high.glb`, `assemble-report.json`, renders in `previews/assembled/` |
| gamemesh | Blender: parts welded + capped, voxel-fused into one surface, floaters removed, seam bands smoothed, detail-weighted decimation (face, hands, joints denser) to the LOD0 budget, UVs, bake of base colour / normal / roughness / metallic / AO | `game/lod0.glb`, `textures/*.png` |
| rig | Tripo rig-check → rig (`spec: mixamo`); its weights transferred onto our game mesh; LOD chain decimated from the rigged LOD0 | `rigs/tripo_rig.glb`, `rigs/lods/rigged_lod*.glb` |
| import | `scripts/import-mixamo-character.mjs` → SOUL_JAM_MASTER_SKELETON (127 joints) via `tripo_to_souljam_bones.json`; textures as WebP; LODs appended; version snapshot | `lib/mocap/mhr-rigs/<rig-id>.json.gz`, registered in `custom.json` |
| lods | reports the LOD ladder in the rig | manifest `stages.lods` |
| preview | `deform-test.mjs` in the real court page: synthetic poses + the game's clips, stretch / collapse / explode checks, screenshots, LOD distances, source-vs-game comparison | `previews/deformation/`, `previews/*.png` |
| courttest | `scripts/court3d-test.js --char <rig-id>` | `previews/court-test/` |

Caching: every stage is keyed on its inputs (reference hashes, model, parameters, seeds, pipeline
version, upstream outputs). Changing only LOD budgets redoes the rig stage onwards, never Tripo
generation; regenerating the head makes assembly and everything after it stale while the body and
hands stay valid.

## Quality presets (`config.mjs`)

| Preset | LOD0 | LOD1 | LOD2 | LOD3 | Textures |
|---|---|---|---|---|---|
| hero | 70k | 36k | 16k | 6k | 4096 |
| standard | 50k | 28k | 12k | 5k | 2048 |
| draft | 20k | 8k | — | — | 1024 |

LOD0 follows the project's own player budget (40k–80k faces, `docs/character-brief/brief.html`).

## Adding another character

1. Put its references in a folder: at least one full-body image (front); head, left / right hand
   images and more views (left, back, right) improve the result. A two-hand sheet is split
   automatically. File names may carry hints (`head_front.png`, `hand_left_palm.png`); an
   `overrides.json` (`{"file.png": {"part": "head", "view": "left"}}`) corrects anything.
2. `npm run character -- build <id> --refs <folder>` (or Create in the UI).
3. Check `status`, the previews and the court; regenerate a part if needed.
