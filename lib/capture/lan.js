/**
 * Soul Jam Capture — the local-network HTTPS listener. Phones only give a web page the camera on a
 * secure origin, and the studio server is plain http on the Mac, so this serves the same app over
 * HTTPS on the LAN (default :3443) with a self-signed certificate made by openssl for this Mac's
 * LAN addresses. On each phone: open the URL once and accept the certificate warning ("Show
 * details → visit this website" on iOS); after that the camera and the WebSocket work.
 *
 * Not started on Railway (it has real HTTPS) or with CAPTURE_HTTPS=0.
 */
'use strict';
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const lanIps = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

function ensureCert(dir, ips) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'lan-key.pem'), cert = path.join(dir, 'lan-cert.pem'), meta = path.join(dir, 'lan-cert.json');
  const want = [...ips].sort().join(',');
  let have = null; try { have = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch {}
  if (fs.existsSync(key) && fs.existsSync(cert) && have?.ips === want) return { key, cert };
  const host = os.hostname().replace(/\.local$/, '');
  const san = ['DNS:localhost', `DNS:${host}.local`, 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '825', '-subj', `/CN=Soul Jam Capture (${host})`, '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth'], { stdio: 'ignore' });
  fs.writeFileSync(meta, JSON.stringify({ ips: want, created: new Date().toISOString() }));
  return { key, cert };
}

/** Start the HTTPS listener with the app's request handler; returns { port, ips } or null. */
function start(handler, { hub, dir, port = +(process.env.CAPTURE_HTTPS_PORT || 3443) } = {}) {
  if (process.env.CAPTURE_HTTPS === '0' || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return null;
  const ips = lanIps();
  try {
    const { key, cert } = ensureCert(dir, ips);
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
    hub?.attach(server);
    server.on('error', (e) => console.error(`  Capture HTTPS: ${e.code === 'EADDRINUSE' ? `port ${port} is busy` : e.message}`));
    server.listen(port, () => {
      console.log(`  Capture (phones, same Wi-Fi): ${ips.map((ip) => `https://${ip}:${port}/capture`).join('  ') || `https://localhost:${port}/capture`}`);
    });
    global.__captureLan = { port, ips };
    return { port, ips, server };
  } catch (e) {
    console.error('  Capture HTTPS not started:', e.message, '(install openssl, or use the Railway URL)');
    return null;
  }
}

module.exports = { start, lanIps, ensureCert };
