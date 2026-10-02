/**
 * The River practice court's files on the server (server.js), served as the loft's are: the layout names the GLB's
 * version; the GLB is streamed with ETag / 304, byte ranges (206 / 416), HEAD and a Content-Length, never gzipped
 * or held in memory, cached for good under its version; the court's module is open (WebKit fetches module scripts
 * without cookies) while the court itself stays behind the password.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const GLB = path.join(__dirname, '..', 'assets', 'courts', 'river.glb');
const HAVE = fs.existsSync(GLB) && fs.existsSync(path.join(__dirname, '..', 'assets', 'courts', 'river-layout.json'));

let srv, base;
test.before(async () => {
  process.env.APP_PASSWORD = 'river-test-pw';
  const handler = require('../server.js');
  srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); });

const AUTH = { Authorization: 'Bearer river-test-pw' };
function get(p, headers = {}, method = 'GET') {
  return new Promise((res, rej) => {
    const r = http.request(base + p, { method, headers }, (q) => { const ch = []; q.on('data', (c) => ch.push(c)); q.on('end', () => res({ status: q.statusCode, h: q.headers, body: Buffer.concat(ch) })); });
    r.on('error', rej); r.end();
  });
}

test('open without a cookie: the River court module (and what it imports)', async () => {
  for (const p of ['/js/court-river.mjs', '/js/loft.mjs', '/js/court-vantheah.mjs', '/vendor/three-addons/Reflector.js', '/vendor/three-addons/DRACOLoader.js']) {
    const r = await get(p);
    assert.strictEqual(r.status, 200, p);
    assert.match(r.h['content-type'], /javascript/, p);
  }
  assert.ok(/from '\.\/loft\.mjs'/.test((await get('/js/court-river.mjs')).body.toString()), 'imports the loft module relatively (/js/loft.mjs)');
});

test('the River court stays behind the password', { skip: !HAVE }, async () => {
  for (const p of ['/courts/river.glb', '/courts/river-layout.json']) {
    const r = await get(p);
    assert.ok(r.status === 401 || r.status === 302 || r.status === 303, `${p}: ${r.status}`);
  }
});

test('layout → version → the GLB: cached for good, ranges, 304, HEAD, no gzip', { skip: !HAVE }, async () => {
  const size = fs.statSync(GLB).size;
  const L = await get('/courts/river-layout.json', AUTH);
  assert.strictEqual(L.status, 200);
  assert.match(L.h['cache-control'], /no-cache/);
  const lay = JSON.parse(L.body.toString());
  assert.ok(lay.bounds && lay.colliders?.length && lay.lights && lay.renderCamera && lay.glb?.url && lay.glb.bytes === size);
  assert.match(lay.glb.url, /^\/courts\/river\.glb\?v=/);
  assert.strictEqual((await get('/courts/river-layout.json', { ...AUTH, 'If-None-Match': L.h.etag })).status, 304);

  const full = await get(lay.glb.url, { ...AUTH, 'Accept-Encoding': 'gzip, br' });
  assert.strictEqual(full.status, 200);
  assert.strictEqual(+full.h['content-length'], size);
  assert.strictEqual(full.body.length, size);
  assert.ok(!full.h['content-encoding'], 'never gzipped');
  assert.strictEqual(full.h['accept-ranges'], 'bytes');
  assert.match(full.h['cache-control'], /max-age=31536000.*immutable/);
  assert.strictEqual(full.body.subarray(0, 4).toString(), 'glTF');
  assert.match((await get('/courts/river.glb', AUTH, 'HEAD')).h['cache-control'], /max-age=0, must-revalidate/);
  assert.strictEqual((await get(lay.glb.url, { ...AUTH, 'If-None-Match': 'W/' + full.h.etag })).status, 304);
  const r1 = await get(lay.glb.url, { ...AUTH, Range: 'bytes=0-99' });
  assert.strictEqual(r1.status, 206); assert.strictEqual(r1.body.length, 100); assert.strictEqual(r1.h['content-range'], `bytes 0-99/${size}`);
  assert.strictEqual((await get(lay.glb.url, { ...AUTH, Range: `bytes=${size}-` })).status, 416);
  const hd = await get(lay.glb.url, AUTH, 'HEAD');
  assert.strictEqual(hd.status, 200); assert.strictEqual(+hd.h['content-length'], size); assert.strictEqual(hd.body.length, 0);
  assert.ok(!global.__glbGz || !Object.keys(global.__glbGz).some((k) => /river/.test(k)), 'never in the in-memory gzip cache');
  // the loft's routes still answer as before (the same handler serves both)
  if (fs.existsSync(path.join(__dirname, '..', 'assets', 'courts', 'loft.glb'))) {
    const LL = JSON.parse((await get('/courts/loft-layout.json', AUTH)).body.toString());
    assert.match(LL.glb.url, /^\/courts\/loft\.glb\?v=/);
    assert.strictEqual((await get(LL.glb.url, { ...AUTH, Range: 'bytes=0-3' })).body.toString(), 'glTF');
  }
});
