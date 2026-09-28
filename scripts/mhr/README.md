# MHR character rigs (rig v4)

The 3D court's characters are Meta's **MHR** (Momentum Human Rig, Apache-2.0,
github.com/facebookresearch/MHR) — the body model SAM 3D Body fits — shaped to
the performer. `bake_rig.py` writes `lib/mocap/mhr-rigs/<id>.json.gz`: MHR's own
LOD1 mesh (18 439 verts), 127-joint skeleton (clavicles, 4 spine joints,
twist joints along every limb) and skin weights, plus the 70 rest keypoints the
runtime retargets to. `engine3d/mhr-skin.mjs` poses it at runtime.

Rebake (after analysing a new take of the performer, or to add a preset):

```bash
# once: model assets (~200 MB zip; only mhr_model.pt + compact_v6_1.model are read)
curl -L -o assets.zip https://github.com/facebookresearch/MHR/releases/latest/download/assets.zip
python3 -c "import zipfile; z=zipfile.ZipFile('assets.zip'); [z.extract(m,'.') for m in ['assets/mhr_model.pt','assets/compact_v6_1.model','assets/LICENSE.txt']]"
pip install torch numpy          # CPU is fine

# raw.json = GET /api/mocap/motion/<id>/raw of any motion analysed with MHR params (from 2026-09-28 on)
python bake_rig.py raw.json --out ../../lib/mocap/mhr-rigs/ankh.json.gz --id ankh --name "Ankh · 6'0\"" --height 1.83
python bake_rig.py raw.json --out ../../lib/mocap/mhr-rigs/big.json.gz --id big --name "Big · 6'11\"" --height 2.11 --leg 1.07 --arm 1.08 --torso 1.02 --palette '{"shirt":[240,240,244],"shorts":[20,70,200]}'
python bake_rig.py raw.json --out ../../lib/mocap/mhr-rigs/guard.json.gz --id guard --name "Guard · 5'9\"" --height 1.75 --leg 0.97 --arm 0.98 --palette '{"shirt":[250,196,30],"shorts":[30,30,36]}'
```

Identity = the median of the take's MHR shape (45) and bone-scale parameters;
presets change bone lengths through MHR's own scale parameters (10 cm per unit),
then one uniform scale to the height.
