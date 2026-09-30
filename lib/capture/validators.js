/**
 * Soul Jam Capture — take validators: the inexpensive checks that run before ACCEPT + NEXT.
 * A validator returns { id, level: 'ok' | 'warn' | 'fail', msg }. 'fail' blocks acceptance
 * (the operator can still accept with an explicit override); 'warn' is shown.
 *
 * Registered validators run in order. Later ones (body / ball / feet visibility, blur, exposure)
 * plug in here with the same signature — see PLANNED.
 */
'use strict';
const fs = require('fs');
const media = require('./media');

const ok = (id, msg) => ({ id, level: 'ok', msg });
const warn = (id, msg) => ({ id, level: 'warn', msg });
const fail = (id, msg) => ({ id, level: 'fail', msg });

/** @type {{id:string, run:(ctx)=>Promise<object|object[]>}[]} ctx = { take, files: {camA, camB} (absolute paths), cams: ['camA','camB'], probe: {cam: probeResult} } */
const VALIDATORS = [
  { id: 'cameras', run: async ({ take, cams, files }) => {
    const missing = cams.filter((c) => !files[c]);
    return missing.length ? fail('cameras', `no recording from ${missing.join(' + ')}`) : ok('cameras', `${cams.length} camera${cams.length > 1 ? 's' : ''} recorded`);
  } },
  { id: 'files', run: async ({ cams, files }) => cams.filter((c) => files[c]).map((c) => {
    const st = fs.statSync(files[c]);
    return st.size < 50_000 ? fail(`file-${c}`, `${c}: file is only ${st.size} bytes`) : ok(`file-${c}`, `${c}: ${(st.size / 1e6).toFixed(1)} MB saved`);
  }) },
  { id: 'duration', run: async ({ take, cams, probe }) => {
    const out = [];
    const target = take.targetDurationSec || 4;
    for (const c of cams) {
      const p = probe[c]; if (!p) continue;
      if (!p.ok) { out.push(fail(`decode-${c}`, `${c}: the recording does not decode`)); continue; }
      if (p.durationSec < 1) out.push(fail(`duration-${c}`, `${c}: only ${p.durationSec.toFixed(1)} s`));
      else if (p.durationSec < target * 0.5) out.push(warn(`duration-${c}`, `${c}: ${p.durationSec.toFixed(1)} s — shorter than half the target (${target} s)`));
      else if (p.durationSec > target * 3 + 5) out.push(warn(`duration-${c}`, `${c}: ${p.durationSec.toFixed(1)} s — much longer than the target (${target} s)`));
      else out.push(ok(`duration-${c}`, `${c}: ${p.durationSec.toFixed(1)} s`));
    }
    const d = cams.map((c) => probe[c]?.durationSec).filter((x) => x > 0);
    if (d.length === 2 && Math.abs(d[0] - d[1]) > 1.5) out.push(warn('duration-match', `the cameras' lengths differ by ${Math.abs(d[0] - d[1]).toFixed(1)} s`));
    return out;
  } },
  { id: 'metadata', run: async ({ take, cams }) => {
    const need = ['sessionId', 'takeNo', 'courtSetup', 'createdAt'];
    if (take.kind === 'take') need.push('animId', 'startState', 'endState');
    const miss = need.filter((k) => take[k] == null);
    for (const c of cams) if (!take.cameras?.[c]?.track) miss.push(`${c}.track`);
    return miss.length ? fail('metadata', `missing: ${miss.join(', ')}`) : ok('metadata', 'take metadata complete');
  } },
  { id: 'fps', run: async ({ take, cams, probe }) => cams.map((c) => {
    const fr = take.cameras?.[c]?.frames, p = probe[c], fps = fr?.fps || p?.fps || 0, neg = take.cameras?.[c]?.track?.frameRate;
    if (!fps) return warn(`fps-${c}`, `${c}: frame rate unknown`);
    if (fps < 20) return fail(`fps-${c}`, `${c}: ${fps.toFixed(0)} fps measured`);
    if (fps < 50) return warn(`fps-${c}`, `${c}: ${fps.toFixed(0)} fps measured${neg ? ` (negotiated ${neg})` : ''} — below 60`);
    return ok(`fps-${c}`, `${c}: ${fps.toFixed(0)} fps measured${neg ? ` (negotiated ${neg})` : ''}`);
  }) },
  { id: 'sync', run: async ({ take, cams }) => {
    if (cams.length < 2) return ok('sync', 'single camera');
    const s = cams.map((c) => take.cameras?.[c]);
    if (s.some((x) => x?.clock?.uncertaintyMs == null)) return warn('sync', 'no clock sync on a camera — align by the chirp only');
    const unc = Math.max(...s.map((x) => x.clock.uncertaintyMs));
    const st = s.map((x) => x.startedAtServerMs).filter(Number.isFinite);
    const skew = st.length === 2 ? Math.abs(st[0] - st[1]) : null;
    if (skew != null && skew > 250) return warn('sync', `the cameras started ${skew.toFixed(0)} ms apart (clock ±${unc.toFixed(0)} ms)`);
    return ok('sync', `clock ±${unc.toFixed(0)} ms${skew != null ? `, starts ${skew.toFixed(0)} ms apart` : ''}`);
  } },
  { id: 'chirp', run: async ({ take, cams, files }) => {
    if (!take.sync?.chirp) return warn('chirp', 'no sync chirp was played (director audio off?) — align by the clock only');
    const r = await require('./sync-audio').syncTake(take, Object.fromEntries(cams.map((c) => [c, files[c]])));
    take.syncResult = { ...r, at: new Date().toISOString() };
    const miss = cams.filter((c) => !r.cams[c]?.found);
    if (miss.length) return warn('chirp', `sync chirp not heard by ${miss.join(' + ')} — align by the clock only (±${Math.round(Math.max(...cams.map((c) => take.cameras?.[c]?.clock?.uncertaintyMs || 0)))} ms)`);
    return ok('chirp', cams.length > 1 ? `sync chirp heard by both cameras: offset ${(r.offsetSec * 1000).toFixed(1)} ms${r.clockErrorMs != null ? ` (clock said ${(r.clockOffsetSec * 1000).toFixed(0)} ms)` : ''}` : 'sync chirp heard');
  } },
  { id: 'cropping', run: async ({ take, cams, files, probe }) => {
    const out = [];
    for (const c of cams) {
      if (!files[c]) continue;
      const m = await media.motionMap(files[c], { durationSec: probe[c]?.durationSec }).catch(() => null);
      if (!m || !m.bbox) { out.push(warn(`crop-${c}`, `${c}: no movement seen — was the athlete in frame?`)); continue; }
      const e = m.edges, sides = Object.entries(e).filter(([, v]) => v > 0.06).map(([k]) => k);
      take.cameras[c].motion = m;
      out.push(sides.length >= 2 ? warn(`crop-${c}`, `${c}: movement runs off the ${sides.join(' + ')} edge — athlete may be cropped`) : ok(`crop-${c}`, `${c}: movement stays in frame`));
    }
    return out;
  } },
];

/** Not implemented yet — the slots future checks go in (same signature). */
const PLANNED = ['body-visible (2D pose on sampled frames)', 'ball-visible', 'feet-visible (floor contact)', 'blur (Laplacian variance)', 'exposure (histogram clipping)'];

async function validate(take, files, { cams = ['camA', 'camB'] } = {}) {
  const probe = {};
  for (const c of cams) if (files[c]) probe[c] = await media.probe(files[c]).catch((e) => ({ ok: false, error: e.message }));
  for (const c of cams) if (probe[c]?.ok && take.cameras?.[c]) take.cameras[c].fileInfo = probe[c];
  const checks = [];
  for (const v of VALIDATORS) {
    try { const r = await v.run({ take, cams, files, probe }); checks.push(...(Array.isArray(r) ? r : [r])); }
    catch (e) { checks.push(warn(v.id, `${v.id} check failed to run: ${e.message}`)); }
  }
  return { ok: !checks.some((c) => c.level === 'fail'), checks, planned: PLANNED, at: new Date().toISOString() };
}

module.exports = { validate, VALIDATORS, PLANNED };
