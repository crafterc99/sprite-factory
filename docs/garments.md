# Garments: loose clothes on court characters

How a character gets a baggy tee and mesh shorts that hang like real fabric, rest on the body and
sway as he plays. Written for engineers working on `tools/character_pipeline/garments/`,
`engine3d/garments.mjs` and `court3d.html`.

## In the game

- The court's top bar shows **Outfit** when the character has garments. In the panel you pick a top
  (none / Baggy tee / Crop top) and a bottom (none / Mesh shorts), then a colourway for each. The
  choice is saved on the device, per character.
- `?outfit=tee:1,shorts:0` forces an outfit (garment id : colourway index); `?outfit=croptop:0,shorts:0`
  is the crop top in its original colourway; `?outfit=none` wears nothing.
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

## The crop top (made in Marvelous Designer)

The crop top is the user's own garment, made in Marvelous Designer (MD): a black, boxy, sleeveless
crop tank with a red splatter graphic on the chest. It is not generated. It is imported and put on
as it is.

- **Source.** `tools/character_pipeline/garments/sources/croptop/`:
  - `croptop.zprj` is the MD project, byte for byte (uploaded as `crp 4.zprj`).
  - `croptop_md_preview.png` is MD's render of it on its avatar.
- **Reader.** `clo_pac.py` reads CLO/MD files:
  - `.zprj`, `.zpac` and `.avt` are zips behind a short header.
  - The `.pac` (garment) and `.dan` (avatar) are typed, sized maps and lists. The format is in the
    file's docstring.
  - `python clo_pac.py croptop.zprj tree.txt` dumps the whole tree.

### Import (`import_md_garment.py`)

1. **Pattern pieces.** Each piece's flat mesh (`baTri`, `baRest` in mm) and its draped 3-D positions
   (`baPos3D`, in the same vertex order) are read.
2. **Doubled layers.** The neck and strap bindings are doubled in MD: an identical second piece sits
   1.3 mm away. The sewn layer is kept (pieces 0, 1, 4, 5, 6, 9, 10 and 11 of 12).
3. **Seams.** In MD's drape, sewn vertices coincide, so they are welded within 0.5 mm. This gives
   228 welded vertices, which move 0.15 mm at most. The result has:
   - 0 non-manifold edges and 0 cracks;
   - exactly four openings: the neckline, two armholes and the hem.
4. **UVs.** The flat pattern pieces are used as MD laid them out: their own shapes, at one scale
   (1 UV unit = 1.2 m of fabric), packed without overlap.
5. **Graphic.** `listMVGraphic` gives the image, the piece it is printed on (the front) and its
   rectangle on that piece's flat pattern. That rectangle becomes per-vertex graphic coordinates,
   so the graphic lands exactly where MD put it.
6. **Fabric and avatar.** The fabric colour (black) is read, and so is the avatar the top was draped
   on (MD's `charles2`, 1.73 m).

### Putting it on AC (`build_garment.py --garment croptop --md …`)

**Placement.** The garment is placed rigidly, with one uniform scale; it is never re-cut
(`import_md_garment.place_on_body`).

- The scale keeps MD's ease: AC's chest girth divided by the MD avatar's, both just below the
  armpits. For AC that is 1.091 / 0.901 = **1.21**. At scale 1 the top cannot go on him: 3,400
  vertices would sit up to 4.5 cm inside his chest.
- The height, depth and pitch come from a least-squares fit. Where the top rests on the avatar
  (shoulders, straps, neckline, upper back), it rests on AC with the same clearance. It is then
  lowered until the shoulder tops sit as they did in MD.

**Contact.** A smooth push resolves contact. The push each vertex needs is spread over the garment,
dilated and blurred, so the fabric bridges the hollow between the pecs instead of taking a print of
the skin. Before the settle there is no per-vertex push, edge smoothing or face nudging.

**Settle.** A short Blender cloth settle follows:

- 45 frames, in the bind pose, which is the A-pose the top was made in;
- over the shorts;
- with a cloth close to MD's "Default" fabric (bending 5, compression 15), not limp jersey, so the
  crew neck stays round.

The fabric ends 20 mm (mean) and 52 mm (max) from the MD garment as placed. This comes from lying
over AC's much bigger chest and settling onto his shoulders. The report's `fromMD` records it.

**Game data.** The skin weights, cloth graph, hidden body faces and tests are the same as for the
tee. The weights use torso and shoulder bones only, since it is a tank.

**Pack.** `pack_outfit.py` bakes the graphic through the UVs from the per-vertex graphic
coordinates. The graphic is one flat colour, `#920002`, which becomes the accent, so the game shows
it in its own red. The colourways are:

- Original: black with the red graphic;
- White;
- Heather;
- Navy.

**Rebuild.** `build_outfit.sh` runs all of these steps. For the crop top alone, from the repo root:

```
OUT=assets/characters/ac_001/outfits; G=tools/character_pipeline/garments; PY=tools/character_pipeline/.venv/bin/python
$PY $G/import_md_garment.py $G/sources/croptop/croptop.zprj --out $OUT --name croptop
$PY $G/build_garment.py lib/mocap/mhr-rigs/ac-001.json.gz --garment croptop --md $OUT/croptop_md.npz --over $OUT/shorts.npz --out $OUT
$PY $G/pack_outfit.py lib/mocap/mhr-rigs/ac-001.json.gz $OUT --rig-id ac-001 --garments croptop
```

The shorts must be built first. Packing one garment keeps the others listed.

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
  - the crop top's MD provenance, its original colourway, its scale and how far it moved from the MD
    shape;
  - exact skinning in the bind pose;
  - the fabric staying on its drape when the body holds still in the drape pose;
  - AC's headless game, once per top (tee + shorts, crop top + shorts): idle, jog, sprint, stop,
    crossover, spin and jump shot, checking for:
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
  - `--outfit croptop:0,shorts:0` wears the crop top.
  - `--colors 0,0` sets the colourways the picker shot switches to.

| Measure (AC, tee + shorts) | Value |
|---|---|
| Cost per frame (Node) | about 2.7 ms (crop top + shorts: about 2.5 ms) |
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
- The **crop top** is MD's garment graded by one uniform scale (1.21 for AC). Everything grows
  together, so it keeps its design: the neckline, straps, armholes and length are MD's, in
  proportion.
  - AC's chest and traps are much fuller than the MD avatar's. The fabric therefore lies over his
    pecs, and the back neckline dips slightly at the centre.
  - The second, inner layer of MD's doubled neck and strap bindings is not carried over. It is
    1.3 mm under the first and does not show.
  - The garment mesh is MD's own (8 mm triangles, about 8,400 vertices), about twice the tee's.
- The garments are built per character, so only AC has them for now. `build_outfit.sh` makes them
  for any MHR rig.
