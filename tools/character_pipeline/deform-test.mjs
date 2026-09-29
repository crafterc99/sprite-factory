#!/usr/bin/env node
/**
 * Basketball deformation test + previews for a court character, in the real court page.
 *
 *   node tools/character_pipeline/deform-test.mjs --char <rig id> --out <dir> [--base http://localhost:3456] [--source-render file]
 *
 * Poses: synthetic (A-pose, deep knee bend, 90° elbows, arms overhead, wrist bend, hand open /
 * closed) and the game's own clips (idle, walk, run, sprint, defence, jump take-off / apex /
 * landing, dribble, crossover, shot, layup / dunk — whichever the court has). For each pose the
 * skinned mesh (the runtime's own bone matrices) is measured against the bind pose:
 *   exploding vertices (> 1.6 m from the pelvis), NaNs, edges stretched > 2.5× or squashed < 0.25×,
 *   collapsed triangles (area < 2 % of rest) — with the nearest joint of the worst spots.
 * Screenshots: full body per pose, face and hand close-ups, LOD distances, and a side-by-side
 * of the Tripo source render and the in-game render. Writes <out>/deformation/report.json.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const CHAR = opt('char'), OUT = path.resolve(opt('out', './previews')), BASE = opt('base', 'http://localhost:3456'), SRC = opt('source-render');
const DEF = path.join(OUT, 'deformation'); fs.mkdirSync(DEF, { recursive: true });
const log = (...m) => console.log('[deform]', ...m);

const SYN = {
  a_pose: [],
  deep_knee_bend: ['left', 'right'].flatMap((s) => [
    { pivot: `${s}-hip`, chain: [`${s}-knee`, `${s}-ankle`, `${s}-heel`, `${s}-big-toe-tip`, `${s}-small-toe-tip`], toward: [0, 0, 1], deg: 95 },
    { pivot: `${s}-knee`, chain: [`${s}-ankle`, `${s}-heel`, `${s}-big-toe-tip`, `${s}-small-toe-tip`], toward: [0, 0, -1], deg: 120 }]),
  elbow_90: ['left', 'right'].map((s) => ({ pivot: `${s}-elbow`, chain: [`${s}-wrist`, ...hand(s)], toward: [0, 0, 1], deg: 90 })),
  arms_overhead: ['left', 'right'].map((s) => ({ pivot: `${s}-shoulder`, chain: [`${s}-elbow`, `${s}-wrist`, `${s}-olecranon`, `${s}-cubital-fossa`, ...hand(s)], toward: [0, 1, 0], deg: 150 })),
  wrist_extension: ['left', 'right'].map((s) => ({ pivot: `${s}-wrist`, chain: hand(s), toward: [0, 0, -1], deg: 55 })),
  hand_open: [],
  hand_closed: ['left', 'right'].flatMap((s) => ['index', 'middle', 'ring', 'pinky'].flatMap((f) => [
    { pivot: `${s}-${f}-third-joint`, chain: [`${s}-${f}-second-joint`, `${s}-${f}-first-joint`, `${s}-${f}-tip`], toward: 'palm', deg: 70 },
    { pivot: `${s}-${f}-second-joint`, chain: [`${s}-${f}-first-joint`, `${s}-${f}-tip`], toward: 'palm', deg: 80 },
    { pivot: `${s}-${f}-first-joint`, chain: [`${s}-${f}-tip`], toward: 'palm', deg: 45 }]).concat([
    { pivot: `${s}-thumb-third-joint`, chain: [`${s}-thumb-second-joint`, `${s}-thumb-first-joint`, `${s}-thumb-tip`], toward: 'palm', deg: 35 }])),
};
function hand(s) { return ['thumb', 'index', 'middle', 'ring', 'pinky'].flatMap((f) => ['tip', 'first-joint', 'second-joint', 'third-joint'].map((k) => `${s}-${f}-${k}`)); }
// the game's clips: role name patterns → the frames to hold
const CLIPS = [
  ['idle', /^idle$/, [0.3]], ['walk', /walk/, [0.25]], ['run', /^(run|jog|loco)/, [0.25]], ['sprint', /sprint/, [0.25]],
  ['defensive_stance', /def/, [0.3]], ['dribble', /dribble|idle/, [0.15, 0.55]], ['crossover', /cross/, [0.5]],
  ['jump', /jump|shot/, [0.35, 0.55, 0.8]], ['shooting_pose', /shot|shoot|jumper/, [0.5]], ['layup_dunk', /layup|dunk/, [0.5]],
];

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 1080 }, ...(process.env.SF_PASSWORD ? { extraHTTPHeaders: { Authorization: `Bearer ${process.env.SF_PASSWORD}` } } : {}) });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // the real court when the clip library is there; else the rig preview (same runtime, no clips)
  const lib = await (await fetch(`${BASE}/api/mocap3d/library`, { headers: process.env.SF_PASSWORD ? { Authorization: `Bearer ${process.env.SF_PASSWORD}` } : {} })).json().catch(() => ({ court: [] }));
  const hasIdle = (lib.court || []).some((c) => c.role === 'idle');
  const where = hasIdle && !opt('rig-only') ? 'court' : 'rig-preview';
  log(where === 'court' ? 'page: the court (clip library available)' : 'page: rig preview — no clip library on this server, game-clip poses are skipped');
  await page.goto(where === 'court' ? `${BASE}/court3d?char=${encodeURIComponent(CHAR)}&court=classic` : `${BASE}/rig-preview?char=${encodeURIComponent(CHAR)}`, { waitUntil: 'domcontentloaded' });
  if (where === 'court') {
    await page.waitForFunction(() => window.__c3dTest && window.__court3d?.player, null, { timeout: 180000 });
    await page.waitForFunction(() => !window.__court3d.loadingRest, null, { timeout: 180000 }).catch(() => {});
  } else {
    await page.waitForFunction(() => window.__rigReady || window.__rigError, null, { timeout: 180000 });
    const err = await page.evaluate(() => window.__rigError); if (err) throw new Error(err);
  }
  await page.waitForTimeout(1500);
  const clips = await page.evaluate(() => window.__c3dTest.clips());
  log('clips on the court:', clips.join(', '));

  const frame = async (look, dist, h = 0) => page.evaluate(([look, dist, h]) => {
    const [fx, fz] = window.__c3dTest.facing();
    window.__court3d.camFixed = { pos: [look[0] + fx * dist + fz * dist * 0.25, look[1] + h, look[2] + fz * dist - fx * dist * 0.25], look };
  }, [look, dist, h]);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const kp = (n) => page.evaluate((n) => window.__c3dTest.kp(n), n);

  const measure = () => page.evaluate(() => {
    const meshes = window.__c3dTest.skinned(), pel = window.__c3dTest.kp('pelvis');
    const J = ['left-shoulder', 'right-shoulder', 'left-elbow', 'right-elbow', 'left-wrist', 'right-wrist', 'left-hip', 'right-hip', 'left-knee', 'right-knee', 'left-ankle', 'right-ankle', 'neck', 'nose', 'left-middle-second-joint', 'right-middle-second-joint'];
    const kps = J.map((n) => [n, window.__c3dTest.kp(n)]);
    const near = (p) => kps.reduce((b, [n, q]) => { const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); return d < b[1] ? [n, d] : b; }, ['', 1e9])[0];
    let edges = 0, stretched = 0, squashed = 0, tris = 0, collapsed = 0, nan = 0, explode = 0, worst = [];
    for (const m of meshes) {
      const R = m.rest, P = m.pos, F = m.faces;
      for (let i = 0; i < P.length; i += 3) { if (!Number.isFinite(P[i] + P[i + 1] + P[i + 2])) nan++; else if (Math.hypot(P[i] - pel[0], P[i + 1] - pel[1], P[i + 2] - pel[2]) > 1.6) explode++; }
      const L = (A, a, b) => Math.hypot(A[a * 3] - A[b * 3], A[a * 3 + 1] - A[b * 3 + 1], A[a * 3 + 2] - A[b * 3 + 2]);
      const area = (A, a, b, c) => { const u = [A[b * 3] - A[a * 3], A[b * 3 + 1] - A[a * 3 + 1], A[b * 3 + 2] - A[a * 3 + 2]], v = [A[c * 3] - A[a * 3], A[c * 3 + 1] - A[a * 3 + 1], A[c * 3 + 2] - A[a * 3 + 2]]; return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; };
      for (let f = 0; f < F.length; f += 3) {
        const [a, b, c] = [F[f], F[f + 1], F[f + 2]];
        tris++; const a0 = area(R, a, b, c); if (a0 > 1e-9 && area(P, a, b, c) < 0.02 * a0) collapsed++;
        for (const [x, y] of [[a, b], [b, c], [c, a]]) {
          const l0 = L(R, x, y); if (l0 < 1e-6) continue; const r = L(P, x, y) / l0; edges++;
          if (r > 2.5) stretched++; if (r < 0.25) squashed++;
          if (r > 2.5 || r < 0.25) worst.push([Math.abs(Math.log(r)), [P[x * 3], P[x * 3 + 1], P[x * 3 + 2]]]);
        }
      }
    }
    worst.sort((p, q) => q[0] - p[0]);
    const where = {}; for (const [, p] of worst.slice(0, 200)) { const n = near(p); where[n] = (where[n] || 0) + 1; }
    return { tris, edges, nan, exploding: explode, stretchedPct: +(100 * stretched / edges).toFixed(3), squashedPct: +(100 * squashed / edges).toFixed(3), collapsedPct: +(100 * collapsed / tris).toFixed(3), worstNear: where };
  });

  const results = [];
  const shoot = async (name, closeups) => {
    const pel = await kp('pelvis');
    await frame([pel[0], pel[1] + 0.1, pel[2]], 3.2, 0.2); await settle();
    const file = path.join(DEF, `${name}.png`); await page.screenshot({ path: file });
    const m = await measure();
    const pass = m.nan === 0 && m.exploding === 0 && m.stretchedPct < 0.2 && m.squashedPct < 0.5 && m.collapsedPct < 0.5;
    results.push({ pose: name, pass, ...m, screenshot: path.relative(OUT, file) });
    log(`${pass ? 'PASS' : 'FAIL'} ${name}: stretched ${m.stretchedPct}% squashed ${m.squashedPct}% collapsed ${m.collapsedPct}% nan ${m.nan} exploding ${m.exploding}${Object.keys(m.worstNear).length ? ' · worst near ' + JSON.stringify(m.worstNear) : ''}`);
    for (const c of closeups || []) {
      const p = await kp(c.kp);
      await frame(p, c.dist, 0.02); await settle();
      await page.screenshot({ path: path.join(DEF, `${name}-${c.tag}.png`) });
    }
  };
  const handShots = [{ kp: 'left-middle-second-joint', dist: 0.45, tag: 'hand-left' }, { kp: 'right-middle-second-joint', dist: 0.45, tag: 'hand-right' }];
  for (const [name, ops] of Object.entries(SYN)) {
    await page.evaluate((ops) => window.__c3dTest.poseSynthetic(ops), ops);
    await shoot(name, name === 'a_pose' ? [{ kp: 'nose', dist: 0.7, tag: 'face' }, { kp: 'neck', dist: 0.6, tag: 'neck-seam' }, ...handShots] : /hand|wrist/.test(name) ? handShots : name === 'arms_overhead' ? [{ kp: 'left-shoulder', dist: 0.8, tag: 'shoulder' }] : name === 'elbow_90' ? [{ kp: 'left-elbow', dist: 0.6, tag: 'elbow' }] : name === 'deep_knee_bend' ? [{ kp: 'left-knee', dist: 0.9, tag: 'knee' }] : []);
  }
  const missing = [];
  for (const [name, re, fracs] of CLIPS) {
    const role = clips.find((c) => re.test(c));
    if (!role) { missing.push(name); continue; }
    for (const [i, f] of fracs.entries()) {
      await page.evaluate(([r, f]) => window.__c3dTest.poseClip(r, f), [role, f]);
      await shoot(`${name}${fracs.length > 1 ? '-' + ['a', 'b', 'c'][i] : ''}`, name === 'dribble' && i === 0 ? handShots : []);
    }
  }
  // LODs by distance
  const lods = [];
  await page.evaluate(() => window.__c3dTest.poseSynthetic([]));
  const pel = await kp('pelvis');
  for (const d of [3, 11, 20, 36]) {
    await frame(pel, d, 0.3); await settle(); await settle();
    const l = await page.evaluate(() => window.__c3dTest.lod());
    lods.push({ cameraDistance: d, ...l });
    await page.screenshot({ path: path.join(OUT, `lod-${d}m.png`) });
  }
  log('LOD by distance:', lods.map((l) => `${l.cameraDistance} m → LOD${l.level} (${l.triangles ?? '?'} tris)`).join(' · '));
  // comparison: Tripo source render | in-game (A-pose, facing the camera)
  await frame([pel[0], pel[1] + 0.05, pel[2]], 2.6, 0.1); await settle();
  const game = path.join(OUT, 'in-game-front.png'); await page.screenshot({ path: game });
  if (SRC && fs.existsSync(SRC)) {
    const a = await sharp(SRC).resize({ height: 900 }).png().toBuffer(), b = await sharp(game).resize({ height: 900 }).png().toBuffer();
    const wa = (await sharp(a).metadata()).width, wb = (await sharp(b).metadata()).width;
    await sharp({ create: { width: wa + wb + 20, height: 900, channels: 3, background: '#222' } }).composite([{ input: a, left: 0, top: 0 }, { input: b, left: wa + 20, top: 0 }]).png().toFile(path.join(OUT, 'compare-source-vs-game.png'));
    log('comparison: compare-source-vs-game.png');
  }
  await page.evaluate(() => window.__c3dTest.release());
  const report = { char: CHAR, at: new Date().toISOString(), page: where, clipLibrary: hasIdle, allPassed: results.every((r) => r.pass), results, missingClips: missing, clipPosesSkipped: where !== 'court', lods, pageErrors: errors };
  fs.writeFileSync(path.join(DEF, 'report.json'), JSON.stringify(report, null, 1));
  log(`${results.filter((r) => r.pass).length}/${results.length} poses passed${missing.length ? ` · clips not on the court: ${missing.join(', ')}` : ''}${errors.length ? ` · page errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
