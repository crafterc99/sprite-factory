#!/bin/bash
# Sprite Factory - Mac dev launcher
# Starts the local server + auto-pulls from GitHub when Claude Code pushes changes.
# Run once: bash mac-dev.sh
# Stop with: Ctrl-C

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

LOGDIR="$DIR/.mac-dev-logs"
mkdir -p "$LOGDIR"

cleanup() {
  echo ""
  echo "[mac-dev] Stopping..."
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$SYNC_PID" ]   && kill "$SYNC_PID"   2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ── Kill any existing instances ──────────────────────────────────────────────
echo "[mac-dev] Stopping any existing instances..."
pkill -f "nodemon server.js" 2>/dev/null || true
pkill -f "node server.js"    2>/dev/null || true
sleep 1

# ── Start nodemon ────────────────────────────────────────────────────────────
echo "[mac-dev] Starting server (nodemon)..."
npm run dev > "$LOGDIR/server.log" 2>&1 &
SERVER_PID=$!

# Wait up to 15s for server to be ready
for i in $(seq 1 15); do
  if curl -s http://localhost:3456/ > /dev/null 2>&1; then
    echo "[mac-dev] Server ready at http://localhost:3456"
    echo "[mac-dev] Studio:         http://localhost:3456/index-v2.html"
    break
  fi
  sleep 1
done

# ── Git auto-sync loop ───────────────────────────────────────────────────────
git_sync() {
  while true; do
    sleep 30
    git fetch origin main --quiet 2>/dev/null || continue
    LOCAL=$(git rev-parse HEAD 2>/dev/null)
    REMOTE=$(git rev-parse origin/main 2>/dev/null)
    if [ "$LOCAL" != "$REMOTE" ]; then
      echo "[mac-dev] New commits detected — pulling..."
      git pull origin main --quiet 2>/dev/null && \
        echo "[mac-dev] Updated to $(git rev-parse --short HEAD) — nodemon restarting server"
    fi
  done
}

echo "[mac-dev] Auto-sync started (polls GitHub every 30s)"
git_sync &
SYNC_PID=$!

echo ""
echo "══════════════════════════════════════════════"
echo "  Local:   http://localhost:3456/index-v2.html"
echo "  Railway: https://sprite-factory-production.up.railway.app/index-v2.html"
echo ""
echo "  Changes Claude Code pushes will auto-pull"
echo "  and restart the server within ~30 seconds."
echo "══════════════════════════════════════════════"
echo ""

# Keep script alive (server + sync run in background)
wait $SERVER_PID
