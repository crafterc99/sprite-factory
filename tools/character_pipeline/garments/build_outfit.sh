#!/usr/bin/env bash
# Build a character's outfit for the court (docs/garments.md):
#   collision spheres → the game pose to drape in → shorts → baggy tee (over the shorts) → pack
#
#   bash tools/character_pipeline/garments/build_outfit.sh <character dir id> <rig id>
#   e.g.  bash tools/character_pipeline/garments/build_outfit.sh ac_001 ac-001
#
# Needs the pipeline's Python env (tools/character_pipeline/.venv), Blender, and the clip library
# (data/mocap: npm run clips:pull) for the game pose. Writes lib/mocap/mhr-rigs/<rig>-outfits/ and
# the textures in lib/mocap/mhr-rigs/<rig>-tex/ (the work files stay in assets/characters/<id>/outfits/).
set -euo pipefail
CH="${1:?character id (e.g. ac_001)}"; RIG="${2:?rig id (e.g. ac-001)}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PY="$ROOT/tools/character_pipeline/.venv/bin/python"
G="$ROOT/tools/character_pipeline/garments"
R="$ROOT/lib/mocap/mhr-rigs/$RIG.json.gz"
OUT="$ROOT/assets/characters/$CH/outfits"
mkdir -p "$OUT"
echo "▸ body collision spheres"; "$PY" "$G/build_colliders.py" "$R" --out "$OUT" 2>/dev/null
echo "▸ the game pose to drape in"; (cd "$ROOT" && node "$G/export_pose.mjs" "$RIG" "$OUT/pose_idle.json" --at 1.4)
echo "▸ shorts (draped, elastic waistband)"; "$PY" "$G/build_garment.py" "$R" --garment shorts --pose "$OUT/pose_idle.json" --out "$OUT" 2>&1 | grep -E '^drape|Error' || true
echo "▸ baggy tee (draped over the shorts)"; "$PY" "$G/build_garment.py" "$R" --garment tee --over "$OUT/shorts.npz" --pose "$OUT/pose_idle.json" --out "$OUT" 2>&1 | grep -E '^drape|Error|WARNING' || true
echo "▸ pack for the game"; "$PY" "$G/pack_outfit.py" "$R" "$OUT" --rig-id "$RIG" --out "$ROOT/lib/mocap/mhr-rigs"
