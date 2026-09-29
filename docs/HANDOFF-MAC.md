# Handoff: continue the 3D court work on the Mac (new Claude Code chat)

You are picking up work from a cloud Claude Code session. Read this file fully, then the files it names, then start at **§4 Next steps**. Don't redo finished work.

## 0. Set up (run these first)
```bash
cd <path to sprite-factory>
git fetch origin
git checkout claude/sprite-factory-motion-capture-ohky3g
git pull
npm install --cache ./.npm-cache      # adds the dev dependency three@0.160.0 (FBX/GLB loading in Node)
bash mac-dev.sh                       # server on http://localhost:3456
npm test                              # expect 53/53
```
- The newest work lives on the branch `claude/sprite-factory-motion-capture-ohky3g` (head `965f7a9` + this doc). **main** has everything up to `8824d7a` and is live on Railway: https://sprite-factory-production.up.railway.app
- Per CLAUDE.md, the Mac works on main. Merge the branch into main once §4.1–4.3 look right to the user: `git checkout main && git merge claude/sprite-factory-motion-capture-ohky3g && git push origin main`.
- Open the court at http://localhost:3456/court3d (`?court=classic` = the light court, `?char=athlete` = the new character, or pick it in the Player menu).
- **The server caches character rigs in memory** (`lib/mocap/character-rig.js`, `mhrCache`). Restart it after every character re-import, or you'll be looking at the old one. Kill it only by its PID, never `pkill -f`.

## 1. Read these (in this order)
1. `CLAUDE.md` (project rules), then `coordination/results.md`, last entries MOCAP-18 … MOCAP-22.
2. `docs/ANIMATION-3D.md` §7–9: physics, court, possession, video ball ↔ hand.
3. `docs/HANDOFF-athlete-character.md`: the detailed notes on the athlete importer. This file summarises and supersedes it.
4. `projects/sprite-factory-core.md` (project log).

## 2. What's built and working (don't redo)
- **3D court (`court3d.html`)**:
  - skinned MHR characters (127 joints) driven by mocap clips;
  - Rapier physics basketball (`engine3d/basketball-physics.mjs`): the ball is a rigid body, and the hands, fingers and body are colliders; contact IK.
  - VANTHEAH rooftop practice court (`engine3d/court-vantheah.mjs`), with the flicker fixed and the city and trees removed.
  - Possession assist: the ball isn't lost on simple moves unless defended.
  - Play without the ball: jog; X / ✕ gives a new ball in hand; walk onto a loose ball to pick it up.
  - Fingertip spin on every dribble.
- **Clip builder (`lib/mocap/motion-builder.js`)**: SAM's ball circle is coupled to the hand per frame. The hold rule is calibrated (24 cm, R + 3 cm); the 2D contact only closes gaps inside a hold. `BUILDER_REV cb-2026-09-29h`.
- **Recent physics fix**: `snapBody()` stops a teleport or reset from throwing the ball (it was being thrown at about 550 m/s). There is a regression test for it.
- **Characters**:
  - `scripts/import-rigged-character.js`: GLB already on the game's MHR skeleton (the freelancer path).
  - `scripts/import-mixamo-character.mjs`: any `mixamorig`-rigged FBX (Tripo, Mixamo, Meshy, AccuRig). It does the skeleton refit to the model's proportions, pose fit, weights, garment cleanup and layering, and **a per-finger rig** (no vertex on two fingers). Untextured parts get flat colours.
  - `lib/mocap/mhr-rigs/athlete.json.gz`: the user's first Tripo model imported. It is low-poly (9,845 triangles) and untextured.
- **Freelancer package**: `docs/character-brief/` (brief.html, player-rig-reference.glb, skeleton.json). The brief is also a private artifact page: https://claude.ai/artifact/LerRJJNzxJyhHxQqE8iiMz

## 3. The user's goal right now
Their **real character** in the game: textured, detailed, and properly rigged with fingers that touch the ball correctly. They make models in **Tripo** (studio.tripo3d.ai) and want to use the **Tripo CLI** too.

The model they have in Tripo Studio:
- textured (white tee, red shorts with a black-and-white Ankh logo, white socks, white/grey high-top sneakers, braids, goatee);
- **1,946,107 triangles**, far over the game budget of 40k–80k;
- not yet rigged.

Why the first import looked "low-res": that FBX was a 9.8k-triangle rig export with **no UVs and no texture**. The game used every triangle; it simply had no colour data, so it got flat colours.

What the user was told to do in Tripo Studio:
1. **Retopo** (left sidebar) to about 50k triangles (or about 25k quads). If the texture is lost, run **Texture** again.
2. **Rig**: Humanoid; skeleton preset **Mixamo** if listed (the importer knows Mixamo names), otherwise UE5 Mannequin (then add a UE5 name map, §4.3); keep the A-pose.
3. **Export**: format **GLB** (not OBJ, which has no rig or skin), texture **2K**, vertex colours off. Check it shows about 50k faces before exporting.

### Tripo CLI (help the user install it; the key never goes in git)
Official package: `tripo-cli` by VAST (Tripo's maker), github.com/vast-enterprise/Tripo-API-CLI, MIT, Node ≥ 20.
```bash
npm install -g tripo-cli
tripo login                 # browser approves; key saved to ~/.tripo/config.json
tripo whoami && tripo balance && tripo doctor
tripo docs --topic commands/generate     # read this for face-limit / parameter names; don't guess flags
tripo make athlete.png --for game-pc --then texture,rig,convert:fbx -o ./tripo-out
tripo view @last
```
`tripo make` shows a plan card with the credit cost and asks before spending. Keys start with `tsk_`; never commit them or `~/.tripo/`.

## 4. Next steps (in order)
1. **Get the user's new export** (a GLB of about 50k triangles, textured, rigged). Ask for it if you don't have it. Save it outside the repo, or under a gitignored folder.
2. **Add texture and GLB support to `scripts/import-mixamo-character.mjs`:**
   - Load `.glb` / `.gltf` with `three/examples/jsm/loaders/GLTFLoader.js` in Node (parse an ArrayBuffer; the same `globalThis.self/window/document` shims as the FBX path). Keep FBX support, including embedded or adjacent textures.
   - **Weld on position + UV**, not position alone. UV-seam duplicates stay separate vertices and share identical weights (compute weights per position, then copy them to the duplicates).
   - Write `part.uv` with **1 − v** (the rigs store Blender v-up UVs; see `scripts/import-rigged-character.js`).
   - Textures → `lib/mocap/mhr-rigs/<id>-tex/*.webp` via `sharp`, max 2048 (see `saveTex` there). Set `part.map` / `part.normalMap` = `/chars/<id>/<file>.webp`. The server already serves `/chars/<id>/…` from `<id>-tex/`.
   - Piece classification is still needed for the garment weights. A textured single-mesh model may have fewer separate pieces; if skin and clothes are one piece, classify **per vertex** (the dominant bone plus texture colour, or keep Tripo's weights with the own-bone cleanup and `bodyWeights` for torso and leg regions). Check the result visually.
3. **Skeleton names**:
   - Mixamo (`mixamorig*`) works now.
   - If the export is **UE5 Mannequin**, add a name map: `pelvis→Hips`, `spine_01..05`, `neck_01/02`, `head`, `clavicle_l/r→Left/RightShoulder`, `upperarm`, `lowerarm`, `hand`, `thigh`, `calf`, `foot`, `ball`, `index/middle/ring/pinky/thumb_01..03`.
   - UE5 also has `*_metacarpal` bones: fold them into the palm (wrist / pinky0 / thumb0) and ignore `*_twist*` and IK bones.
   - Map to the Mixamo names the script expects, then run the same pipeline.
4. **Import and check:**
   ```bash
   node scripts/import-mixamo-character.mjs <file.glb> athlete "Athlete"
   ```
   - Report: `verticesOnTwoFingers` 0; `segRatio` values between about 0.8 and 1.25. Outside that, the auto-rig misplaced a joint; compare with `--proportions game`.
   - Restart the server and open `/court3d?char=athlete&court=classic`.
   - Look at: the waist in the dribble crouch (shirt hem over shorts), sleeves at the elbows, hands on the ball (close-up), shoes on the floor, the face. Use `window.__court3d.camFixed = { pos:[x,y,z], look:[x,y,z] }` from a playwright script for fixed-camera screenshots.
5. **Possession with the athlete (open bug):**
   - The first import lost the ball in the idle dribble in the cloud's headless check. That ran at 11 fps, where possession is known to be weaker; the default player is fine at 60 fps.
   - Check at 60 fps on the Mac first. If it's still lost, compare with `--proportions game`.
   - Likely causes: the hand ratio of 1.18 and the shorter torso move the palm relative to the clips' ball path. Try clamping `segRatio.hand` to about 1.05, or measure the torso from the mesh instead of Tripo's hip joints (auto-riggers place them high).
6. **Full checks**:
   - `npm test`;
   - `node scripts/court3d-test.js --court classic` (and with `--char athlete`). Known: at ≤ 10 fps the moving-crossover sub-check can fail; this is pre-existing and not a regression.
   - Update `coordination/results.md` (MOCAP-23) and `projects/sprite-factory-core.md`, commit, and push to main when the user approves how it looks.

## 5. Known limits (not bugs to chase first)
- Possession drops more often at ≤ 10 fps (the physics runs on big frame steps); fine at 60 fps.
- Sprint dribbles drift from the animation 4–25% of the time; nothing is lost.
- The VANTHEAH court renders at about 1 fps under software GL; use `?court=classic` for headless tests.
- Generated crossovers are flagged invalid for the player body and are dropped (pre-existing).

## 6. Rules
- Never commit or print secrets: studio password, Firebase admin key (a JSON under the user's uploads), Tripo key (`tsk_…`).
- No model identifiers in commits or files.
- Kill the local server only by its PID.
- Commit messages say what changed and why. After each working change: commit and push (main, per CLAUDE.md, once merged).

## 7. First message to paste into the new Mac chat
> Read docs/HANDOFF-MAC.md in sprite-factory and continue from §4. Check out the branch it names first. My new Tripo export is at <path to file>.
