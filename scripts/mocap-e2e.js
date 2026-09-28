#!/usr/bin/env node
/**
 * End-to-end mocap run against a live studio, with per-step timings.
 *
 *   SF_PASSWORD=... node scripts/mocap-e2e.js \
 *     --base https://sprite-factory-production.up.railway.app \
 *     --video clip.mov --sheet character.webp --name ankh --height 74 \
 *     --model gpt-image-2.5-sunburst --views 1,3 --hands right,left --slot cross
 *
 * Steps: character from sheet → upload → analyze (SAM 3 + SAM 3D Body) →
 * generate → save to slot. Writes <out>/report.json and downloads the strips.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const BASE = (args.base || 'http://localhost:3456').replace(/\/$/, '');
const PW = process.env.SF_PASSWORD || '';
const OUT = args.out || path.join(process.cwd(), 'mocap-e2e-out');
fs.mkdirSync(OUT, { recursive: true });
const auth = PW ? { Authorization: `Bearer ${PW}` } : {};

async function call(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { ...auth, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`${method} ${url} → ${res.status} ${j.error || ''}`);
  return j;
}

async function job(jobId, label) {
  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await call('GET', `/api/mocap/job/${jobId}`);
    const msg = j.progress?.msg || '';
    if (msg && msg !== last) { console.log(`   ${label}: ${msg}`); last = msg; }
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(`${label} failed: ${j.error}`);
  }
}

(async () => {
  const T = {};
  const tStart = Date.now();
  const step = async (name, fn) => {
    const t = Date.now();
    console.log(`▶ ${name}`);
    const r = await fn();
    T[name] = +((Date.now() - t) / 1000).toFixed(1);
    console.log(`  ✓ ${name} — ${T[name]}s`);
    return r;
  };

  const status = await step('status', () => call('GET', '/api/mocap/status'));
  console.log('  providers:', JSON.stringify({ fal: status.fal, images: status.images }));
  if (!status.ready) throw new Error('fal is not configured on the server');

  let character = null;
  if (args.sheet) {
    const b64 = fs.readFileSync(args.sheet).toString('base64');
    character = await step('create character', async () => job((await call('POST', '/api/mocap/character-from-sheet', {
      name: args.name, heightInches: +args.height || 74, imageBase64: b64, model: args.model, order: args.order,
    })).jobId, 'character'));
  }

  const up = await step('upload video', () => call('POST', '/api/video/upload', fs.readFileSync(args.video), { 'Content-Type': 'application/octet-stream' }));
  const analysis = await step('analyze motion', async () => job((await call('POST', '/api/mocap/analyze', {
    sessionId: up.sessionId, name: args.move || args.slot || 'move', fps: +args.fps || 12, maxFrames: +args.maxFrames || 36,
  })).jobId, 'analyze'));
  console.log('  motion:', JSON.stringify(analysis.meta.report), `stature ${analysis.meta.statureM}m, hand ${analysis.meta.startingHand}, $${analysis.meta.measureCost}`);

  const result = await step('generate sprites', async () => job((await call('POST', '/api/mocap/generate', {
    motionId: analysis.motionId, charName: args.name,
    views: String(args.views || '1').split(',').map(Number), hands: String(args.hands || 'right').split(','),
    model: args.model, quality: args.quality || 'high', frameStep: +args.frameStep || 2, retries: +(args.retries ?? 1),
  })).jobId, 'generate'));

  const ZL = { 1: ['Front', 0], 2: ['Front Left', 7], 3: ['Left', 6], 4: ['Back Left', 5], 5: ['Back', 4] };
  const saved = await step('save to slot', async () => {
    const keys = [];
    for (const v of result.variants) {
      if (!ZL[v.view]) continue;
      const animId = `${args.slot || 'cross'}_z${v.view}_${v.hand}`;
      await call('POST', `/api/character/${encodeURIComponent(args.name)}/save-animation`, {
        animId, animName: `${args.slot || 'cross'} — ${ZL[v.view][0]} (${v.hand})`, spriteUrl: v.spriteUrl.split('?')[0],
        fps: result.fps, frameCount: v.frameCount, angle: ZL[v.view][0], angleIndex: ZL[v.view][1],
        slotId: args.slot || 'cross', zoneId: v.view, startingHand: v.hand,
      });
      keys.push(animId);
    }
    return keys;
  });

  for (const v of result.variants) {
    const res = await fetch(BASE + v.spriteUrl, { headers: auth });
    if (res.ok) fs.writeFileSync(path.join(OUT, `${v.animName}.png`), Buffer.from(await res.arrayBuffer()));
  }
  T.total = +((Date.now() - tStart) / 1000).toFixed(1);
  const report = {
    base: BASE, timings: T, character, motionId: analysis.motionId, motion: analysis.meta, resultId: result.id,
    cost: { measure: analysis.meta.measureCost, generate: result.cost },
    variants: result.variants.map((v) => ({ animName: v.animName, view: v.view, hand: v.hand, frames: v.frameCount, qcPass: v.frames.filter((f) => f.pass).length, scores: v.frames.map((f) => f.score), issues: [...new Set(v.frames.flatMap((f) => f.issues))], spriteUrl: v.spriteUrl })),
    saved,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify({ timings: T, cost: report.cost, variants: report.variants.map((v) => `${v.animName}: QC ${v.qcPass}/${v.frames}`) }, null, 2));
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
