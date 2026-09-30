# Garments: loose clothes on court characters

How a character gets a baggy tee and mesh shorts that hang like real fabric, rest on the body and
sway as he plays. Written for engineers working on `tools/character_pipeline/garments/`,
`engine3d/garments.mjs` and `court3d.html`.

## In the game

- The court's top bar shows **Outfit** when the character has garments. In the panel you pick a top
  (none / Baggy tee) and a bottom (none / Mesh shorts), then a colourway for each. The choice is
  saved on the device, per character.
- `?outfit=tee:1,shorts:0` forces an outfit (garment id : colourway index); `?outfit=none` wears
  nothing.
- **fabric: moves / rigid** switches the cloth simulation off for comparison. **settle** restarts the
  fabric from its drape.

## Build (per character, offline)

```
bash tools/character_pipeline/garments/build_outfit.sh ac_001 ac-001
```

| Step | Script | What it makes |
|---|---|---|
| Collision spheres | `build_colliders.py` | About 200 spheres inscribed in the bind body (torso, pelvis, arms, thighs, knees), each skinned like the body. The fabric rests on them in the game. |
| Drape pose | `export_pose.mjs` | The court's real idle-dribble pose (headless game tick), in the character's frame. |
| Shorts | `build_garment.py --garment shorts` | Two lofted leg pieces from the body's cross-sections, eased out, hanging straight below the hips. |
| Tee | `build_garment.py --garment tee --over shorts.npz` | A volume around the torso and upper arms (`tee_shape.py`), with fabric hanging from the chest and sleeves hanging from the deltoids. Its surface is remeshed with Quadriflow (`quad_remesh_blender.py`) and cut open at the hem, cuffs and crew neck. |
| Drape | `drape_blender.py` (called by the builder) | Blender's cloth simulation drapes the cut shape as limp cotton. It runs in the drape pose, on the posed body and the posed shorts, and the result is un-posed back to the bind pose with the same skin weights. |
| Pack | `pack_outfit.py` | `lib/mocap/mhr-rigs/<rig>-outfits/{index.json, tee.json.gz, shorts.json.gz, body.json.gz}` and the print textures in `<rig>-tex/`. |

Cotton settings resist stretching, not compression, so the fabric buckles into folds. The shorts
keep an elastic waistband, which is pinned during the drape. The tee is not pinned: it rests on the
shoulders. The head, hair, hands and forearms are not drape colliders. Dreads lie over a collar, and
a hand resting at the hem would crease it for good.

Each garment file holds:

- the mesh in the bind pose, with UVs;
- skin weights on the rig's bones;
- a coarse cloth graph of about 450 nodes, with edges, tethers to the held nodes, pins and the gap to
  the skin;
- per-vertex weights from the cloth graph;
- trim distances for the collar rib and hem stitches;
- the body faces the garment hides, on every LOD.

Prints such as "SOUL JAM" and "AC 11" are placed in 3-D, as a front or back projection, and baked
through the UVs as grey plus alpha. The game tints them with the colourway's accent.

## Runtime (`engine3d/garments.mjs`)

Every game tick runs after IK and finger contact:

1. **Anchors.** Each cloth node is skinned: this is where the drape would be if it were rigid.
2. **Limp fabric.** Verlet at fixed 1/120 s substeps, the same at 30, 60 and 120 fps.
   - It keeps 85 % of the body's motion as its own momentum, has air drag and falls under full
     gravity.
   - Edges resist stretching but not compression, and tethers keep hanging fabric from stretching.
   - It collides with the body spheres. A top also collides with the shorts' cloth nodes, and has
     friction where it rests.
   - A faint memory of the drape (a 1 s time constant) keeps folds from drifting.
   - Hard limits: a node never goes into the skin, and never more than 14 cm from its anchor
     (4 mm for the waistband).
3. **Mesh.** Once per rendered frame, CPU skinning adds the cloth offsets, and normals come from the
   welded surface.

The body faces under the garments are not drawn, so no skin shows through. A teleport, or a frame
longer than 0.25 s, resets the fabric.

## Tests

- `tests/garments.test.js` (in `npm test`) covers:
  - the files;
  - exact skinning in the bind pose;
  - the fabric staying on its drape when the body holds still in the drape pose;
  - AC's headless game (idle, jog, sprint, stop, crossover, spin, jump shot), checking for:
    - no NaN;
    - every node within its limits;
    - no reset mid-play;
    - sway when moving and settling when standing;
    - under 2 % of the cloth more than 1.2 cm inside the drawn skin;
  - 30 vs 120 fps;
  - the cost per frame.
- `node tests/outfit-court.spec.js --fps 30` runs the real court in Chromium. It takes close-ups
  from four sides, a contact sheet of the fabric swinging as he sprints and stops, the shot and the
  picker. The output goes to `tests/reports/outfit-court/`.

| Measure (AC, tee + shorts) | Value |
|---|---|
| Cost per frame (Node) | about 2.7 ms |
| Fabric speed relative to the body, sprinting | about 0.9 m/s |
| Fabric speed relative to the body, standing | about 0.1 m/s |
| Worst frame, cloth more than 1.2 cm inside the drawn skin | under 2 % |

## Known limits

- The **tank jersey** builds, but its drape is not good yet: the straps stand up and the hem bunches
  on the shorts. It is not packed for the game.
- The cloth graph is coarse (about 4.5 cm between nodes). Fine folds come from the drape and ride
  along; they do not form anew as he moves.
- On a still body, the fabric settles about 3 cm below the finer Blender drape (full gravity on the
  coarse graph).
- With the arms far forward or up, the upper arm can show through a sleeve near the cuff for a
  moment.
- The garments are built per character, so only AC has them for now. `build_outfit.sh` makes them
  for any MHR rig.
