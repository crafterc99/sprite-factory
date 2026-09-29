/**
 * Password gate for the whole studio (UI + API).
 *
 * Enabled when APP_PASSWORD is set (Railway → Variables). Ways in:
 *   - /login form                      → 30-day HttpOnly cookie (iPad-friendly)
 *   - private link  /?key=<password>   → sets the cookie, then strips the key from the URL
 *   - Authorization: Bearer <password> or Basic (any user) for scripts/CLI
 * Unset APP_PASSWORD → gate is off (local dev), with a startup warning.
 */
'use strict';

const crypto = require('crypto');

const COOKIE = 'sf_auth';
const MAX_AGE = 30 * 24 * 3600;
// /vendor/three.module.min.js: public library (MIT) — some WebKit versions
// fetch module scripts without cookies, so it must not sit behind the gate
const OPEN_PATHS = new Set(['/login', '/api/health', '/favicon.ico', '/vendor/three.module.min.js', '/vendor/rapier.mjs', '/js/anim3d.mjs', '/js/mhr-skin.mjs', '/js/basketball-physics.mjs', '/js/contact-ik.mjs', '/js/ball-lab.mjs', '/js/ball-setup.mjs']);
const attempts = new Map(); // ip → { n, t }

const password = () => process.env.APP_PASSWORD || '';
const enabled = () => !!password();
const token = () => crypto.createHmac('sha256', password()).update('sprite-factory-auth-v1').digest('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isAuthed(req) {
  if (!enabled()) return true;
  const c = readCookie(req, COOKIE);
  if (c && safeEqual(c, token())) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && safeEqual(h.slice(7), password())) return true;
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const pw = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pw, password())) return true;
  }
  return false;
}

function cookieHeader(req) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${COOKIE}=${token()}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}

function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 60000) { a.n = 0; a.t = now; }
  a.n++;
  attempts.set(ip, a);
  return a.n > 10;
}

function loginPage(msg = '', next = '/') {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sprite Factory — Sign in</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f14;color:#e8e9ee;font:16px/1.4 -apple-system,system-ui,sans-serif;padding:16px}
form{width:100%;max-width:360px;background:#171922;border:1px solid #2a2d3a;border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 20px;color:#9a9db0;font-size:14px}
input{width:100%;font-size:18px;padding:14px;border-radius:10px;border:1px solid #33374a;background:#0e0f14;color:#fff}
button{width:100%;margin-top:14px;font-size:17px;font-weight:600;padding:14px;border:0;border-radius:10px;background:#ff6a2b;color:#fff}
.err{color:#ff8080;font-size:14px;margin-top:12px;min-height:1em}
</style></head><body>
<form method="POST" action="/login">
<h1>Sprite Factory</h1><p>Private studio — enter the password.</p>
<input type="password" name="password" autocomplete="current-password" autofocus placeholder="Password">
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Sign in</button>
<div class="err">${esc(msg)}</div>
</form></body></html>`;
}

function readForm(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', () => resolve({}));
  });
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

/**
 * @returns {Promise<boolean>} true when the request was fully handled here
 */
async function gate(req, res, url) {
  if (!enabled()) return false;
  const pathname = url.pathname;

  if (pathname === '/login') {
    if (req.method === 'POST') {
      if (rateLimited(req)) {
        res.writeHead(429, { 'Content-Type': 'text/html' });
        res.end(loginPage('Too many attempts — wait a minute.'));
        return true;
      }
      const form = await readForm(req);
      if (safeEqual(form.password || '', password())) {
        res.writeHead(303, { 'Set-Cookie': cookieHeader(req), Location: safeNext(form.next) });
        res.end();
      } else {
        res.writeHead(401, { 'Content-Type': 'text/html' });
        res.end(loginPage('Wrong password.', safeNext(form.next)));
      }
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(loginPage('', safeNext(url.searchParams.get('next'))));
    return true;
  }
  if (pathname === '/logout') {
    res.writeHead(303, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0`, Location: '/login' });
    res.end();
    return true;
  }

  // Private link: ?key=<password> → cookie, then the same URL without the key
  const key = url.searchParams.get('key');
  if (key != null && req.method === 'GET') {
    if (!rateLimited(req) && safeEqual(key, password())) {
      url.searchParams.delete('key');
      res.writeHead(303, { 'Set-Cookie': cookieHeader(req), Location: url.pathname + (url.search || '') });
      res.end();
      return true;
    }
  }

  if (OPEN_PATHS.has(pathname) || isAuthed(req)) return false;

  if (pathname.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not signed in', login: '/login' }));
    return true;
  }
  res.writeHead(303, { Location: `/login?next=${encodeURIComponent(pathname + (url.search || ''))}` });
  res.end();
  return true;
}

module.exports = { gate, enabled, isAuthed };
