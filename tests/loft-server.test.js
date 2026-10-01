/**
 * The loft's files on the server (server.js): the layout names the GLB's version; the GLB is streamed with
 * ETag / 304, byte ranges (206 / 416), HEAD and a Content-Length, never gzipped, cached for good under its
 * version; the Draco decoder and the new modules are open (WebKit fetches module scripts without cookies)
 * while the loft itself stays behind the password.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const GLB = path.join(__dirname, '..', 'assets', 'courts', 'loft.glb');
const HAVE = fs.existsSync(GLB) && fs.existsSync(path.join(__dirname, '..', 'assets', 'courts', 'loft-layout.json'));

let srv, base;
test.before(async () => {
  process.env.APP_PASSWORD = 'loft-test-pw';
  const handler = require('../server.js');
  srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); });

const AUTH = { Authorization: 'Bearer loft-test-pw' };
function get(p, headers = {}, method = 'GET') {
  return new Promise((res, rej) => {
    const r = http.request(base + p, { method, headers }, (q) => { const ch = []; q.on('data', (c) => ch.push(c)); q.on('end', () => res({ status: q.statusCode, h: q.headers, body: Buffer.concat(ch) })); });
    r.on('error', rej); r.end();
  });
}

test('open without a cookie: the Draco decoder, DRACOLoader, the loft module', async () => {
  for (const p of ['/vendor/three-addons/DRACOLoader.js', '/vendor/draco/draco_wasm_wrapper.js', '/vendor/draco/draco_decoder.wasm', '/js/loft.mjs']) {
    const r = await get(p);
    assert.strictEqual(r.status, 200, p);
    assert.ok(r.body.length > 1000, p);
  }
  assert.strictEqual((await get('/vendor/draco/draco_decoder.wasm')).h['content-type'], 'application/wasm');
  assert.ok(/^import[\s\S]*from '\/vendor\/three\.module\.min\.js'/.test((await get('/vendor/three-addons/DRACOLoader.js')).body.toString()), 'DRACOLoader imports the vendored three');
});

test('the loft stays behind the password', { skip: !HAVE }, async () => {
  for (const p of ['/courts/loft.glb', '/courts/loft-layout.json']) {
    const r = await get(p);
    assert.ok(r.status === 401 || r.status === 302 || r.status === 303, `${p}: ${r.status}`);
  }
});

test('layout → version → the GLB: cached for good, ranges, 304, HEAD, no gzip', { skip: !HAVE }, async () => {
  const size = fs.statSync(GLB).size;
  const L = await get('/courts/loft-layout.json', AUTH);
  assert.strictEqual(L.status, 200);
  assert.match(L.h['cache-control'], /no-cache/);
  const lay = JSON.parse(L.body.toString());
  assert.ok(lay.bounds && lay.spawn && lay.glb?.url && lay.glb.bytes === size);
  assert.strictEqual((await get('/courts/loft-layout.json', { ...AUTH, 'If-None-Match': L.h.etag })).status, 304);

  const full = await get(lay.glb.url, { ...AUTH, 'Accept-Encoding': 'gzip, br' });
  assert.strictEqual(full.status, 200);
  assert.strictEqual(+full.h['content-length'], size);
  assert.strictEqual(full.body.length, size);
  assert.ok(!full.h['content-encoding'], 'never gzipped');
  assert.strictEqual(full.h['accept-ranges'], 'bytes');
  assert.match(full.h['cache-control'], /max-age=31536000.*immutable/);
  assert.strictEqual(full.body.subarray(0, 4).toString(), 'glTF');
  // without (or with an old) version: revalidated every time
  assert.match((await get('/courts/loft.glb', AUTH, 'HEAD')).h['cache-control'], /max-age=0, must-revalidate/);
  assert.match((await get('/courts/loft.glb?v=old', AUTH, 'HEAD')).h['cache-control'], /must-revalidate/);
  // 304 on its ETag (Railway's edge may weaken it to W/)
  assert.strictEqual((await get(lay.glb.url, { ...AUTH, 'If-None-Match': 'W/' + full.h.etag })).status, 304);
  // ranges
  const r1 = await get(lay.glb.url, { ...AUTH, Range: 'bytes=0-99' });
  assert.strictEqual(r1.status, 206); assert.strictEqual(r1.body.length, 100); assert.strictEqual(r1.h['content-range'], `bytes 0-99/${size}`);
  assert.ok(r1.body.equals(full.body.subarray(0, 100)));
  const r2 = await get(lay.glb.url, { ...AUTH, Range: 'bytes=-10' });
  assert.strictEqual(r2.status, 206); assert.ok(r2.body.equals(full.body.subarray(size - 10)));
  const r3 = await get(lay.glb.url, { ...AUTH, Range: `bytes=${size - 5}-` });
  assert.strictEqual(r3.status, 206); assert.strictEqual(r3.body.length, 5);
  assert.strictEqual((await get(lay.glb.url, { ...AUTH, Range: `bytes=${size}-` })).status, 416);
  // an If-Range that no longer matches: the whole (new) file
  assert.strictEqual((await get(lay.glb.url, { ...AUTH, Range: 'bytes=0-9', 'If-Range': '"stale"' })).status, 200);
  const hd = await get(lay.glb.url, AUTH, 'HEAD');
  assert.strictEqual(hd.status, 200); assert.strictEqual(+hd.h['content-length'], size); assert.strictEqual(hd.body.length, 0);
  // (and it was never put in the in-memory gzip cache)
  assert.ok(!global.__glbGz || !Object.keys(global.__glbGz).some((k) => /loft/.test(k)));
});
