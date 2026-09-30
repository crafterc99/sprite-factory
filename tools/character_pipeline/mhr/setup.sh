#!/bin/bash
# One-time setup for the MHR rig stage: a Python env (torch, numpy, scipy, pillow) and Meta's MHR
# model files (Apache-2.0, ~700 MB) in gitignored folders.
#   bash tools/character_pipeline/mhr/setup.sh
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VENV="$ROOT/tools/character_pipeline/.venv"
MODELS="$ROOT/assets/_models/mhr"
PY=""
for c in python3.12 python3.11 python3.13 python3.14 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
[ -z "$PY" ] && { echo "needs Python ≥ 3.10 (e.g. brew install python@3.11)"; exit 1; }
if [ ! -x "$VENV/bin/python" ]; then
  echo "[mhr] creating $VENV with $PY"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q torch numpy scipy pillow
if [ ! -f "$MODELS/assets/mhr_model.pt" ]; then
  echo "[mhr] downloading the MHR model files"
  mkdir -p "$MODELS"
  curl -L -o "$MODELS/assets.zip" https://github.com/facebookresearch/MHR/releases/latest/download/assets.zip
  "$VENV/bin/python" -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); [z.extract(m, sys.argv[2]) for m in ['assets/mhr_model.pt','assets/compact_v6_1.model','assets/LICENSE.txt']]" "$MODELS/assets.zip" "$MODELS"
  rm -f "$MODELS/assets.zip"
fi
"$VENV/bin/python" -c "import torch, numpy, scipy, PIL; print('[mhr] ready: torch', torch.__version__)"
