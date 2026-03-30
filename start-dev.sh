#!/bin/bash
# Sprite Factory dev server + ngrok tunnel starter
# Kills any existing instances, then starts fresh

set -e

LOGDIR=/tmp/sprite-factory
mkdir -p "$LOGDIR"

echo "[start-dev] Stopping any existing sprite-factory processes..."
pkill -f "nodemon server.js" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
pkill -f "ngrok http 3456" 2>/dev/null || true
sleep 1

cd /home/user/sprite-factory

echo "[start-dev] Starting server (nodemon)..."
nohup npm run dev > "$LOGDIR/server.log" 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$LOGDIR/server.pid"

# Wait for server to be ready
for i in $(seq 1 15); do
  if curl -s http://localhost:3456/ > /dev/null 2>&1; then
    echo "[start-dev] Server ready on port 3456"
    break
  fi
  sleep 1
done

echo "[start-dev] Starting ngrok tunnel..."

# Use static domain if configured, otherwise let ngrok pick
if [ -n "$NGROK_DOMAIN" ]; then
  nohup ngrok http 3456 --domain="$NGROK_DOMAIN" --log=stdout > "$LOGDIR/ngrok.log" 2>&1 &
else
  nohup ngrok http 3456 --log=stdout > "$LOGDIR/ngrok.log" 2>&1 &
fi
NGROK_PID=$!
echo $NGROK_PID > "$LOGDIR/ngrok.pid"

sleep 3

# Fetch the public URL from ngrok's local API
TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const tunnels = JSON.parse(d).tunnels;
      const t = tunnels.find(t => t.proto === 'https') || tunnels[0];
      console.log(t ? t.public_url : '');
    } catch(e) { console.log(''); }
  });
" 2>/dev/null)

if [ -n "$TUNNEL_URL" ]; then
  echo ""
  echo "============================================"
  echo "  Sprite Factory live at:"
  echo "  $TUNNEL_URL"
  echo "  Studio: $TUNNEL_URL/index-v2.html"
  echo "============================================"
  echo ""
  echo "$TUNNEL_URL" > "$LOGDIR/current-url.txt"
else
  echo "[start-dev] Tunnel starting... check http://localhost:4040 for URL"
fi
