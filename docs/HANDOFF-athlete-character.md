# Handoff: Tripo athlete character → 3D court (continue on the Mac)

Read this whole file before acting. It is the state of the work as of 2026-09-29 and the exact next steps.

## 0. Get the code
```bash
cd <your sprite-factory checkout>
git fetch origin
git checkout claude/sprite-factory-motion-capture-ohky3g
git pull
npm install --cache ./.npm-cache      # adds the dev dependency three@0.160.0 (FBX loading in Node)
bash mac-dev.sh                       # local server on http://localhost:3456
```
Open http://localhost:3456/court3d and pick **Player → Athlete**. Add `?court=classic` for the light court.

The work is on the branch, **not on main yet**. Once section 4 is done and it looks right, merge to main (Railway deploys from main in about 2 minutes). Then follow the CLAUDE.md rules: results entry, project file, commit and push.

## 1. What exists now
- **`scripts/import-mixamo-character.mjs`** (new): imports any character rigged on a Mixamo skeleton (`mixamorig*` bones: Tripo, Mixamo, Meshy, AccuRig) onto the game's 127-joint MHR skeleton.
  ```bash
  node scripts/import-mixamo-character.mjs <model.fbx> <id> "Display name" [--palette '{"skin":[118,78,54],"shirt":[238,238,240],"shorts":[24,30,44],"shoe":[236,236,236],"hair":[22,18,16]}'] [--proportions model|game]
  ```
  It writes `lib/mocap/mhr-rigs/<id>.json.gz`, registers the id in `lib/mocap/mhr-rigs/custom.json`, and prints a JSON report.
  What it does:
  1. **Skeleton refit** (`--proportions model`, the default): each joint chain of the game skeleton (thigh, shin, torso, neck, shoulder width, upper arm, forearm, hand) is scaled to the model's segment lengths. Feet, head and hip width keep the game's sizes. The script re-derives `restJoints`, `boneLen`, `legLen` and `soleOffset` from it, the data the animations retarget to.
  2. **Pose fit:**
     - Limb and finger joints are pinned onto the game joints.
     - Hips and chest are placed by a two-direction frame (mid-hips → mid-shoulders, plus across), the hands by the middle knuckle plus index → pinky.
     - Spine, neck, head and clavicles ride rigidly with their parent. Then the game's spine, neck and head pivots are moved to where the model's joints landed.
     - The mesh follows through its own skin weights.
  3. **Weights:**
     - Skin: Mixamo bone → game joint group, spread over the twist joints by the game body rig's nearest point.
     - Garments (shirt, shorts, shoes): nearest-body-point transfer (4 nearest, inverse distance).
     - Garments are first cleaned of other bones' weights; the auto-rig bled the hands into the shorts.
     - Layering: sleeves follow the arms, the hidden shorts waistband follows the shirt, shoe collars follow the ankles.
     - **Fingers:** one finger per vertex (the model's dominant finger, cleaned by a neighbour vote). Weights run along that finger's own joints only: rigid phalanges, smooth blends at each knuckle. The report shows `verticesOnTwoFingers: 0`.
     - Palm: from the game body rig's palm (wrist, pinky and thumb metacarpals).
  4. **Parts:** one part per garment piece (the mesh's separate pieces: skin, shirt, shorts, shoes, hair, eyes, brows). Each has a flat `color`, because the model had no texture.
- **`court3d.html`:** a part with no `map` but a `color: [r,g,b]` (sRGB) renders in that colour. Before this, untextured parts rendered white.
- **`lib/mocap/mhr-rigs/athlete.json.gz` + `custom.json`:** the athlete imported from `tripo_convert_28375baa-….fbx`. The user's upload is not in the repo; ask the user for the file if you need to re-import.
- **Viewing and checks.** These were throwaway scripts in the cloud sandbox and are not in the repo; rebuild them as needed:
  - a bind-pose viewer (three.js page rendering the rig's parts unposed);
  - a court screenshot script (playwright, `?char=athlete`, camera via `window.__court3d.camFixed = { pos, look }`).

## 2. Why the character looks low-resolution (answer for the user)
The FBX the user sent is Tripo's **rig/convert export**:
- **9,845 triangles and 5,349 vertices.** A normal Tripo textured model is 50k–500k faces.
- **No UVs and no texture.** The file carries only positions, normals and skin weights; the zip had no image files.

So the game can only show flat colours per garment, on a low-poly mesh. The model the user sees on tripo3d.ai is the high-poly, textured version. Nothing in the import reduced the resolution: every one of the 9,845 triangles is used as-is.

## 3. What the user should export from Tripo (or make with the CLI)
- **Format:** GLB, which embeds textures and is preferred. If FBX, choose "embed media" and include the texture PNGs in the zip.
- **Texture:** textured, with PBR base colour (plus normal map if offered), 2048².
- **Face count:** 40k–80k, the game budget in `docs/character-brief/brief.html`. Tripo's rig step often decimates, so set the face limit high on generation and don't pick a "low poly" or "smart low poly" option.
- **Rig:** Tripo's auto-rig (Mixamo-style `mixamorig` skeleton **with fingers**), in its default A-pose or T-pose.
- One character per file.

### Tripo CLI setup (on the Mac)
The official package is `tripo-cli` by VAST (the maker of Tripo): repo github.com/vast-enterprise/Tripo-API-CLI, MIT, Node ≥ 20.
```bash
npm install -g tripo-cli
tripo login                 # browser approves, key stored in ~/.tripo/config.json (0600)
tripo whoami && tripo balance
tripo doctor                # self-check
tripo docs --topic commands/generate    # models, face limits, parameters: read before choosing flags
```
Make a rigged, textured game character, for example:
```bash
tripo make athlete.png --for game-pc --then texture,rig,convert:fbx -o ./tripo-out
tripo view @last            # check it in the browser first
```
- The plan card lists each API call and its credits before anything runs, and it asks before spending.
- `--param key=value` passes raw API parameters, such as a face limit; check `tripo docs` for the exact names rather than guessing.
- Never commit the API key (`tsk_…`) or `~/.tripo/`. `TRIPO_API_KEY` in the shell is the CI and agent path.

## 4. Next steps (in order)
1. **Verify the current athlete in the court after a server restart.** The server caches rigs in memory (`lib/mocap/character-rig.js` `mhrCache`), so every re-import needs a restart.
   - **Waist:** fixed. After a restart, the dribble crouch shows a clean shirt hem over the shorts.
   - **Possession (open):** in the last cloud check, the athlete **lost the ball in the idle dribble**, which the default player doesn't do.
     1. Check at 60 fps on the Mac. The cloud browser ran at 11 fps, where possession is known to be weaker.
     2. If it's still lost, re-import with `--proportions game` (the athlete's mesh on the player's proportions) and compare. If that holds the ball, the model's proportions are the cause: the shorter torso and 1.18× hands move the palm relative to the clips' ball path.
     3. Then tune, e.g. clamp `segRatio.hand` to about 1.05, or measure the torso from the mesh rather than Tripo's hip joints (auto-riggers put them high).
     4. The offline sim (`sim.mjs` from the cloud session, not in the repo) can be rebuilt from `tests/basketball-physics.test.js` patterns to test this headless at 60 fps.
2. **Texture support in `import-mixamo-character.mjs`**, needed for the user's textured export:
   - Load GLB too: `three/examples/jsm/loaders/GLTFLoader.js` in Node, parse the ArrayBuffer. FBX with embedded or adjacent images also needs support.
   - **Weld on position + UV**, not position alone. UV seams must keep separate vertices, so give seam duplicates identical weights.
   - Carry UVs into `part.uv`. The rigs store Blender-style v-up UVs, so write `1 − v`, as `scripts/import-rigged-character.js` does.
   - Write the base-colour and normal textures to `lib/mocap/mhr-rigs/<id>-tex/*.webp` with `sharp` (see `saveTex` in `import-rigged-character.js`). Set `part.map` / `part.normalMap` to `/chars/<id>/<file>.webp`.
   - With one textured mesh, the piece classification is still needed for the garment weights, but all pieces can share the one texture.
3. Re-import the user's new file as `athlete`, or under a new id. Check the report:
   - `verticesOnTwoFingers` should be 0.
   - `garmentWeightsCleaned` and `layeredVertices` should be reasonable.
   - `segRatio` values should stay within about 0.8–1.25. Values outside that usually mean the auto-rig misplaced a joint; use `--proportions game` to compare.
4. Run the checks:
   - `npm test` (53/53 at handoff);
   - `node scripts/court3d-test.js --court classic --char athlete`, which needs `--char` support; the script already has `args.char`.
   - Note: the headless test runs at about 11 fps under software GL, and possession is weaker at ≤ 10 fps (a known, older limit). Judge ball handling at 60 fps on the Mac.
5. Commit, add the results entry (MOCAP-22) and update the project file. Merge to main when the user approves how it looks.

## 5. Known state and limits (from the cloud session)
- Branch head before this handoff: `8824d7a` (boot-dribble fix, reset-after-teleport fix, freelancer brief). This handoff commit sits on top.
- The athlete has larger hands than the default player (hand ratio 1.18), so the physics palms are bigger. Check that catches still land.
- The hand close-ups showed the fingers spreading over the ball and following its surface, with no finger pulling its neighbour. The Tripo fingers are chunky because the mesh is low-poly.
- The brief for a freelancer (`docs/character-brief/`) targets `scripts/import-rigged-character.js`: a GLB already on the game's MHR skeleton. The Tripo/Mixamo path is `import-mixamo-character.mjs`.

## 6. Rules carried over
- Never commit or print secrets: studio password, Firebase admin key, Tripo API key.
- Kill the local server only by its PID; never `pkill -f`.
- No model identifiers in commits or files.
