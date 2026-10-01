/**
 * Ball contact metadata (docs/ball-contact-system.md → CONTACT MODEL).
 *
 * For every clip: WHEN the ball leaves a hand (release), WHERE and WHEN it meets the floor
 * (bounce, in the character's local frame), WHEN and BY WHICH hand it is received (catch), plus
 * holds (one hand / both), gathers, shots and passes — each with a contact window and a
 * confidence. Detected automatically from the clip (ball track + palms), overridable by hand
 * (Contact Editor → meta.ballContacts), and used to clean the captured track:
 *
 *   captured ball motion → contact events → trajectory cleanup → constraint correction → (IK at runtime)
 *
 * Engine-agnostic: no three.js, no anim3d import (anim3d passes the sampled clip in).
 */
import { G, planDribble, planToss, segPos, gateCrossing } from './ball-trajectory.mjs';

export const CONTACTS_VERSION = 1;
export const TYPES = ['release', 'bounce', 'catch', 'gather', 'shot', 'pass'];
export const PROFILES = ['dribble', 'crossover', 'between-legs', 'behind-back', 'low', 'high', 'push', 'toss', 'pass'];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => len(sub(a, b));
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const r3 = (a) => a.map((x) => +x.toFixed(4));
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const other = (h) => (h === 'left' ? 'right' : h === 'right' ? 'left' : h);

/** Clip-space point → the character's local (root) frame at trajectory tr = [x, z, yaw]. */
export function toLocal(p, tr) {
  const c = Math.cos(tr[2]), s = Math.sin(tr[2]), x = p[0] - tr[0], z = p[2] - tr[1];
  return [c * x - s * z, p[1], s * x + c * z];
}
/** Local (root frame at tr) → clip space. */
export function fromLocal(q, tr) {
  const c = Math.cos(tr[2]), s = Math.sin(tr[2]);
  return [c * q[0] + s * q[2] + tr[0], q[1], -s * q[0] + c * q[2] + tr[1]];
}

/**
 * Detect the contacts of one clip.
 * @param {object} C  sampled clip:
 *   id, F, fps, loop, R, floorY, trackSource ('video' | 'generated' | 'unknown')
 *   frames[i] = { ball: [x,y,z] | null (clip space), held, hand, palmL, palmR (clip space) }
 *   traj(t) → [x, z, yaw] (clip root at fractional frame t), shot { releaseFrame, hand } | null
 *   hand?    the clip's own starting hand (a mirrored clip's is the other): a two-hand start enters there
 *   labels?  classifyBallEvents frames (flight kind names)
 *   legsAt?(t) → [{ a, b, r }] leg / foot capsules in clip space (bounce clearance)
 * @returns {object} contacts (see docs/ball-contact-system.md)
 */
export function detectContacts(C) {
  const { F, fps, loop } = C, R = C.R ?? 0.12, floorY = C.floorY ?? 0;
  const fr = C.frames;
  const video = C.trackSource === 'video';
  const log = [];
  if (!F || !fr?.length) return emptyContacts(C);
  // ── 1. distances + calibration (the held distance differs per source: video ≈ 17 cm, generated ≈ 26 cm)
  const dL = fr.map((f) => (f.ball ? dist(f.ball, f.palmL) : null)), dR = fr.map((f) => (f.ball ? dist(f.ball, f.palmR) : null));
  const dh = clamp(median(fr.map((f, i) => (f.held && f.ball ? Math.min(dL[i], dR[i]) : null)).filter((x) => x != null)) ?? 0.18, 0.1, 0.32);
  const thr = dh + 0.07;
  // ── 2. per-frame contact: the builder's hold flag (it saw the ball touch the hand in 2-D too),
  // bridged across short occlusions; the hand with hysteresis
  const held = fr.map((f) => !!f.held);
  const maxGap = Math.max(2, Math.round(0.35 * fps));
  for (let i = 0; i < F; i++) {
    if (fr[i].ball || held[i]) continue;
    let j = i; while (j + 1 < F && !fr[j + 1].ball && !held[j + 1]) j++;
    const a = i - 1, b = j + 1;
    const bridge = j - i + 1 <= maxGap && a >= 0 && b < F && held[a] && held[b] && fr[a].hand === fr[b].hand && !(C.shot && b >= C.shot.releaseFrame);
    if (bridge) { for (let k = i; k <= j; k++) { held[k] = true; fr[k].bridged = true; } log.push(`occlusion ${i}-${j} bridged (held ${fr[a].hand})`); }
    i = j;
  }
  // hand per held frame: nearest palm, switching only when the other is ≥ 4 cm closer for 3 frames;
  // both palms on the ball (each within the held distance + 5 cm) for most of a run = a two-hand hold
  const hand = new Array(F).fill(null);
  let cur = null, pend = 0;
  for (let i = 0; i < F; i++) {
    if (!held[i]) { cur = null; pend = 0; continue; }
    const l = dL[i], r = dR[i];
    const near = l == null || r == null ? fr[i].hand : l <= r ? 'left' : 'right';
    if (!cur) cur = fr[i].hand || near;
    else if (near !== cur && l != null && r != null && Math.abs(l - r) > 0.04) { if (++pend >= 3) { cur = near; pend = 0; for (let k = i - 2; k < i; k++) hand[k] = cur; } }
    else pend = 0;
    hand[i] = cur;
  }
  const both = fr.map((f, i) => held[i] && dL[i] != null && dR[i] != null && dL[i] < dh + 0.05 && dR[i] < dh + 0.05);
  // ── 3. runs (rotated for loops so no run is split by the wrap)
  const h0 = loop ? Math.max(0, held.findIndex(Boolean)) : 0;
  const idx = (k) => (loop ? (((k % F) + F) % F) : k);
  const runs = [];
  for (let k = 0; k < F; k++) {
    const i = idx(k + h0), isH = held[i];
    const last = runs[runs.length - 1];
    const key = isH ? 'hold' : 'free';
    if (last && last.kind === key && (key === 'free' || last.hand === hand[i] || !hand[i])) last.to = k + h0;
    else runs.push({ kind: key, from: k + h0, to: k + h0, hand: isH ? hand[i] : null });
  }
  // two-hand holds
  for (const r of runs) if (r.kind === 'hold') {
    let nb = 0; for (let k = r.from; k <= r.to; k++) if (both[idx(k)]) nb++;
    r.both = nb > (r.to - r.from + 1) * 0.5;
  }
  // ── 4. events at the run boundaries (fractional frames, windows)
  const events = [];
  const win = Math.max(0.5, 0.035 * fps);
  const ball = (k) => fr[idx(k)].ball;
  const palm = (k, h) => (h === 'left' ? fr[idx(k)].palmL : fr[idx(k)].palmR);
  const dAt = (k, h) => { const b = ball(k); return b ? dist(b, palm(k, h)) : null; };
  // crossing of the release / catch distance between a held frame and the free frame next to it
  const crossing = (kh, kf, h) => {
    const a = dAt(kh, h), b = dAt(kf, h), want = dh + 0.03;
    if (a == null || b == null || b <= a) return (kh + kf) / 2;
    return kh + (kf - kh) * clamp((want - a) / (b - a), 0.1, 0.9);
  };
  let nid = 0;
  const mk = (o) => ({ id: `${o.type[0]}${++nid}`, auto: true, ...o });
  const shotF = C.shot ? C.shot.releaseFrame : null;
  for (let q = 0; q < runs.length; q++) {
    const r = runs[q], next = runs[q + 1] || (loop ? { ...runs[0], from: runs[0].from + F, to: runs[0].to + F } : null);
    if (r.kind !== 'hold') continue;
    const hh = r.both ? 'both' : r.hand;
    if (r.both && (q === 0 || runs[q - 1]?.kind !== 'hold')) events.push(mk({ type: 'gather', hand: 'both', frame: r.from, window: [r.from - win, r.from + win], conf: 0.7 }));
    // the ball goes from one hand to the other inside a hold (a gather into the shot set, a
    // hand-off): both hands on it from there
    else if (q > 0 && runs[q - 1]?.kind === 'hold' && runs[q - 1].hand && r.hand && runs[q - 1].hand !== r.hand) events.push(mk({ type: 'gather', hand: 'both', frame: r.from - 0.5, window: [r.from - 0.5 - win, r.from - 0.5 + win], conf: 0.6 }));
    if (!next || next.kind !== 'free') continue;
    // the hold ends: a shot (the clip says so), a pass (never caught), or a dribble release
    if (shotF != null && next.from >= shotF - 1) { events.push(mk({ type: 'shot', hand: C.shot.hand === 'both' || r.both ? 'both' : C.shot.hand || hh, frame: shotF - 0.5, window: [shotF - 1, shotF], conf: 0.95 })); continue; }
    const f = crossing(r.to, r.to + 1, r.hand);
    const quality = relConf(r.hand, r.to, r.to + 1);
    if (!loop && !runs.slice(q + 2).some((x) => x.kind === 'hold')) {
      // released, never caught: fast = a pass, else the ball is just let go
      const b1 = ball(r.to + 1), b3 = ball(Math.min(r.to + 3, F - 1));
      const sp = b1 && b3 ? (dist(b1, b3) * fps) / 2 : 0;
      events.push(mk({ type: sp > 3 ? 'pass' : 'release', hand: r.hand, frame: f, window: [f - win, f + win], conf: +(quality * 0.8).toFixed(2) }));
      continue;
    }
    events.push(mk({ type: 'release', hand: r.hand, frame: f, window: [f - win, f + win], conf: +quality.toFixed(2) }));
  }
  // catches: the start of every hold that follows a free run
  for (let q = 0; q < runs.length; q++) {
    const r = runs[q], prev = runs[q - 1] || (loop ? { ...runs[runs.length - 1], from: runs[runs.length - 1].from - F, to: runs[runs.length - 1].to - F } : null);
    if (r.kind !== 'hold' || !prev || prev.kind !== 'free') continue;
    const f = crossing(r.from, r.from - 1, r.hand);
    events.push(mk({ type: 'catch', hand: r.both ? 'both' : r.hand, frame: f, window: [f - win, f + win], conf: +relConf(r.hand, r.from, r.from - 1).toFixed(2) }));
  }
  function relConf(h, kh, kf) {
    let c = video ? 0.92 : 0.62;
    const a = dAt(kh, h);
    if (a == null) c -= 0.25; else if (Math.abs(a - dh) > 0.05) c -= 0.15;
    if (!ball(kf)) c -= 0.2;
    const o = dAt(kh, other(h));
    if (a != null && o != null && Math.abs(a - o) < 0.05) c -= 0.2;   // ambiguous hand
    if (fr[idx(kh)].bridged) c -= 0.15;
    return clamp(c, 0.1, 0.99);
  }
  events.sort((a, b) => a.frame - b.frame);
  // ── 5. flights: release → (bounce) → catch; the bounce fitted on the track
  const flights = [];
  const catches = events.filter((e) => e.type === 'catch');
  const catchAfter = (f) => catches.find((x) => x.frame > f) || (loop && catches.length ? { ...catches[0], frame: catches[0].frame + F } : null);
  for (const e of events.filter((x) => x.type === 'release')) {
    const c = catchAfter(e.frame);
    if (!c || events.some((x) => ['release', 'shot', 'pass'].includes(x.type) && x.frame > e.frame && x.frame < c.frame)) continue;
    const fl = fitFlight(e, c);
    if (!fl) continue;
    if (fl.bounce) events.push(fl.bounce);
    flights.push({ release: e.id, bounce: fl.bounce?.id || null, catch: c.id, fromHand: e.hand, toHand: c.hand, kind: fl.kind, profile: fl.profile, rms: fl.rms != null ? +fl.rms.toFixed(4) : null, restitution: fl.restitution != null ? +fl.restitution.toFixed(3) : null });
  }
  // ── 5b. physics: the per-frame hold flags come from the capture's hold rule (the ball within 24 cm of a palm,
  // its depth taken from the nearest wrist) — a ball a low crossover pushed down a moment ago, or one rising past
  // the other hand, still reads "held". A release / catch the ball's own ballistic path cannot meet moves to
  // where it can; a flight still going at the clip's end is caught at the end by the hand it heads to.
  const yb0 = floorY + R;
  const evOf = (id) => events.find((x) => x.id === id);
  const flightOf = (fl) => ({ e: evOf(fl.release), c: evOf(fl.catch), b: fl.bounce ? evOf(fl.bounce) : null });
  const bouncePoint = (b) => fromLocal(b.local, C.traj(loop ? ((b.frame % F) + F) % F : b.frame));
  const holdBefore = (f) => { let a = -Infinity; for (const x of events) if ((x.type === 'catch' || x.type === 'gather') && x.frame < f && x.frame > a) a = x.frame; return Number.isFinite(a) ? a : (loop ? f - F : 0); };
  // the launch the ballistic path needs from the ball on the palm at t to reach the bounce (fb, pb), and the hand's own velocity then
  const launch = (t, fb, pb) => { const pr = interpBall(t), T = (fb - t) / fps; return T < 0.02 ? null : [(pb[0] - pr[0]) / T, (yb0 - pr[1] + 0.5 * G * T * T) / T, (pb[2] - pr[2]) / T]; };
  const handVel = (t, tEnd) => { const t1 = Math.min(t + 0.5, tEnd), a = interpBall(t1 - 1), b = interpBall(t1); return sc(sub(b, a), fps); };
  const mismatch = (L, v) => Math.hypot(L[1] - v[1], 0.7071 * (L[0] - v[0]), 0.7071 * (L[2] - v[2]));
  /** Which palm a flight from the bounce (fb, pb, horizontal velocity vh, rebound vUp) reaches at frame tc: the side it is on (along the hips), then the nearer palm. */
  const handReached = (tc, fb, pb, vh, vUp, fromHand) => {
    const t = (tc - fb) / fps, p = [pb[0] + vh[0] * 0.9 * t, yb0 + vUp * t - 0.5 * G * t * t, pb[2] + vh[2] * 0.9 * t];
    const k = Math.min(F - 1, Math.max(0, Math.round(loop ? ((tc % F) + F) % F : tc))), f = fr[k], k0 = Math.max(0, k - 2);
    const ext = Math.min(0.15, Math.max(0, (tc - (F - 1)) / fps));   // (past the clip's end: the palms move on, a little)
    const palmAt = (s) => { const a = s === 'left' ? fr[k0].palmL : fr[k0].palmR, b = s === 'left' ? f.palmL : f.palmR; const v = k > k0 ? sc(sub(b, a), fps / (k - k0)) : [0, 0, 0]; return add(b, sc(v, ext)); };
    const L = palmAt('left'), Rr = palmAt('right');
    let lat = (q) => 0;
    if (f.hipL && f.hipR) { const ax = sub(f.hipL, f.hipR), l = Math.hypot(ax[0], ax[2]) || 1, pel = lerp(f.hipL, f.hipR, 0.5); lat = (q) => ((q[0] - pel[0]) * ax[0] + (q[2] - pel[2]) * ax[2]) / l; }
    // (the side of the body it goes to: a ball well across the midline is the hand of that side's, unless the
    // palms clearly say otherwise — a crossover is caught by the other hand)
    const side = Math.abs(lat(p)) > 0.15 ? Math.sign(lat(p)) : 0;
    const sL = Math.abs(lat(p) - lat(L)) + 0.35 * dist(p, L) - (side > 0 ? 0.15 : 0), sR = Math.abs(lat(p) - lat(Rr)) + 0.35 * dist(p, Rr) - (side < 0 ? 0.15 : 0);
    return { hand: Math.abs(sL - sR) < 0.03 && fromHand ? fromHand : sL < sR ? 'left' : 'right', p, sL, sR, lat: [lat(p), lat(L), lat(Rr)] };
  };
  const rebound = (e, b, pb) => {
    // the ball's velocity into the floor (from the release on the palm) → its rebound (e ≈ 0.82) and horizontal velocity
    const L = launch(e.frame, b.frame, pb); if (!L) return null;
    const Td = (b.frame - e.frame) / fps, vin = L[1] - G * Td;
    return { vin, vUp: 0.82 * -vin, vh: [L[0], 0, L[2]] };
  };
  // (C) the clip's last release, never caught in it (a dribble move's last bounce is after its end): too close to
  // the end to leave the hand — it keeps the ball; else it bounces and the hand it heads to catches it on the last frame
  if (!loop && !C.shot) {
    const ends = events.filter((x) => x.type === 'release' || x.type === 'pass');
    const lastE = ends[ends.length - 1];
    if (lastE && !flights.some((fl) => fl.release === lastE.id) && !events.some((x) => x.type === 'catch' && x.frame > lastE.frame)) {
      if (F - 1 - lastE.frame < 0.15 * fps) { events.splice(events.indexOf(lastE), 1); log.push(`release ${lastE.id} @${lastE.frame.toFixed(1)}: too close to the end to be caught — the hand keeps the ball`); }
      else {
        lastE.type = 'release';
        const c = mk({ type: 'catch', hand: lastE.hand, frame: F - 1, window: [F - 1 - win, F - 1], conf: 0.5, atEnd: true });
        const f2 = fitFlight(lastE, c);
        if (f2?.bounce) {
          events.push(f2.bounce);
          const pb = bouncePoint(f2.bounce), rb = rebound(lastE, f2.bounce, pb);
          if (rb) c.hand = handReached(F - 1, f2.bounce.frame, pb, rb.vh, rb.vUp, lastE.hand).hand;
        }
        events.push(c);
        flights.push({ release: lastE.id, bounce: f2?.bounce?.id || null, catch: c.id, fromHand: lastE.hand, toHand: c.hand, kind: lastE.hand === c.hand ? 'dribble' : 'crossover', profile: f2?.profile || 'dribble', rms: null, restitution: null, atEnd: true });
        log.push(`release ${lastE.id}: still in the air at the end — caught on the last frame by the ${c.hand} hand`);
      }
    }
  }
  for (const fl of flights) {
    let { e, c, b } = flightOf(fl);
    if (!e || !c || !b?.local || (loop && (e.frame >= F || b.frame >= F || c.frame >= F))) continue;
    // (A) the release: where the launch the bounce needs matches the hand's own motion
    let pb = bouncePoint(b);
    // (a push throws the ball faster than the hand moves — but never 6 m/s faster: then the ball had already left it)
    const L0 = launch(e.frame, b.frame, pb), v0 = handVel(e.frame, e.frame), m0 = L0 ? mismatch(L0, v0) : Infinity, push = L0 ? v0[1] - L0[1] : 0;
    if (video && push > 6) {
      const lo = Math.max(holdBefore(e.frame) + 1, e.frame - 0.45 * fps, loop ? -Infinity : 0);
      let best = null;
      for (let t = e.frame - 0.25; t >= lo; t -= 0.25) { const L = launch(t, b.frame, pb); if (!L) continue; const m = mismatch(L, handVel(t, e.frame)); if (!best || m < best.m) best = { t, m }; }
      if (best && best.m < 2.2 && best.m < m0 - 1.5) {
        log.push(`release ${e.id} @${e.frame.toFixed(1)} → ${best.t.toFixed(1)}: the bounce needs a ${push.toFixed(1)} m/s harder throw than the hand's own motion there (the launch and the hand within ${best.m.toFixed(1)} m/s here)`);
        // (the bounce stays where the ball's own frames near the floor put it: the release only moved off the hand)
        e.frame = +best.t.toFixed(2); e.window = [e.frame - win, e.frame + win]; e.conf = +Math.max(0.3, e.conf - 0.15).toFixed(2); e.physics = true;
      }
    }
    // (B) the clip's last catch, a moment after a bounce near its end: the rebound must be able to reach the ball on
    // the palm by then — else the hold flag is a rising ball passing a hand (two hands near it), and the catch is on
    // the last frame (or when the rebound reaches the palm), by the hand the ball heads to
    const run = runs.find((r) => r.kind === 'hold' && r.from <= Math.ceil(c.frame) && r.to >= Math.floor(c.frame));
    const toEnd = !loop && run && run.to >= F - 1 && !events.some((x) => x.frame > c.frame + 1e-6 && x.type !== 'bounce');
    const rb = rebound(e, b, pb);
    if (!video || !toEnd || !rb || rb.vUp <= 0.3) continue;
    const yc = interpBall(Math.min(c.frame + 1, F - 1))[1], T = (c.frame - b.frame) / fps;
    const need = T > 0.005 ? (yc - yb0 + 0.5 * G * T * T) / T : Infinity;
    if (need <= rb.vUp / 0.82 * 1.1) continue;   // (a rebound of e ≤ 1.1 reaches it in time)
    const disc = rb.vUp * rb.vUp - 2 * G * Math.max(0, yc - yb0);
    const tUp = disc >= 0 ? (rb.vUp - Math.sqrt(disc)) / G : rb.vUp / G;   // (it never rises that high: its apex)
    const fc = b.frame + tUp * fps;
    if (fc < F - 1 - 0.5) {
      log.push(`catch ${c.id} @${c.frame.toFixed(1)} → ${fc.toFixed(1)}: the rebound reaches the palm then`);
      c.frame = +fc.toFixed(2); c.window = [c.frame - win, c.frame + win]; c.physics = true;
    } else {
      const h = handReached(Math.max(F - 1, fc), b.frame, pb, rb.vh, rb.vUp, c.hand);
      log.push(`catch ${c.id} @${c.frame.toFixed(1)} → ${F - 1} (${h.hand}): the rebound reaches the palms only after the end (${fc.toFixed(1)}), heading for the ${h.hand} hand (L ${h.sL.toFixed(2)} R ${h.sR.toFixed(2)} at ${h.p.map((x) => x.toFixed(2))}, lateral ${h.lat.map((x) => x.toFixed(2))})`);
      c.frame = F - 1; c.window = [F - 1 - win, F - 1]; c.hand = h.hand; c.physics = true; c.atEnd = true; c.conf = 0.6;
      fl.toHand = h.hand; fl.kind = fl.fromHand === h.hand ? 'dribble' : fl.kind === 'dribble' ? 'crossover' : fl.kind;
    }
  }
  events.sort((a, b) => a.frame - b.frame);
  // loops: every event back into [0, F) (frames were unwrapped from the first hold)
  if (loop) for (const e of events) { const k = Math.floor(e.frame / F) * F; if (k) { e.frame -= k; e.window = e.window.map((x) => x - k); } }
  function fitFlight(e, c) {
    const a = e.frame, b = c.frame, T = (b - a) / fps;
    if (T <= 0.02) return null;
    // observed flight frames (clip space) + the two hand anchors
    const obs = [];
    for (let k = Math.ceil(a); k <= Math.floor(b); k++) { const p = ball(k); if (p && !held[idx(k)]) obs.push({ t: (k - a) / fps, p }); }
    const pA = interpBall(a), pB = interpBall(b);
    const kindName = flightKind(e, c);
    const minObs = obs.length ? Math.min(...obs.map((o) => o.p[1])) : Infinity;
    // a bounce, or a toss from hand to hand? (a real track that never comes near the floor)
    const toss = video && obs.length >= 2 && minObs > floorY + R + 0.3 && T < 0.45;
    if (toss) return { kind: kindName, profile: 'toss', rms: null };
    let best = null;
    const yb = floorY + R;
    const pts = [{ t: 0, p: pA, w: 3 }, ...obs.map((o) => ({ ...o, w: 1 })), { t: T, p: pB, w: 3 }];
    const synthetic = !video || obs.length < 2 || minObs > floorY + R + 0.2 && !video;
    if (!synthetic) {
      for (let tb = 0.03; tb <= T - 0.03 + 1e-9; tb += 0.1 / fps) {
        let err = 0, n = 0; const v = {};
        for (const side of ['d', 'u']) {
          const P = pts.filter((q) => (side === 'd' ? q.t < tb : q.t > tb));
          if (!P.length) { err = Infinity; break; }
          let sab = 0, saa = 0;
          for (const q of P) { const ai = q.t - tb, bi = q.p[1] - yb + 0.5 * G * ai * ai; sab += q.w * ai * bi; saa += q.w * ai * ai; }
          v[side] = sab / (saa || 1e-9);
          for (const q of P) { const ai = q.t - tb, y = yb + v[side] * ai - 0.5 * G * ai * ai; err += q.w * (y - q.p[1]) ** 2; n += q.w; }
        }
        if (!(v.d < -0.2 && v.u > 0.2)) continue;
        const rms = Math.sqrt(err / Math.max(1, n));
        if (!best || rms < best.rms) best = { tb, rms, vin: v.d, vout: v.u };
      }
    }
    let tb, rms = null, restitution = null, conf, pb;
    if (best) {
      tb = best.tb; rms = best.rms; restitution = best.vout / -best.vin;
      // bounce spot: each side's horizontal line through its points, at tb
      const side = (P) => {
        if (P.length === 1) return P[0].p;
        let st = 0, sw = 0, sx = 0, sz = 0, stt = 0, stx = 0, stz = 0;
        for (const q of P) { st += q.w * q.t; sw += q.w; sx += q.w * q.p[0]; sz += q.w * q.p[2]; stt += q.w * q.t * q.t; stx += q.w * q.t * q.p[0]; stz += q.w * q.t * q.p[2]; }
        const den = sw * stt - st * st || 1e-9;
        const mx = (sw * stx - st * sx) / den, mz = (sw * stz - st * sz) / den;
        return [(sx - mx * st) / sw + mx * tb, 0, (sz - mz * st) / sw + mz * tb];
      };
      // (a side with no observation of its own — only its hand anchor, the frames next to it were on the hand — has
      // no horizontal velocity: the other side's line alone puts the spot; it used to average in the anchor itself)
      const dP = pts.filter((q) => q.t < tb), uP = pts.filter((q) => q.t > tb);
      const d0 = side(dP), u0 = side(uP);
      pb = dP.length >= 2 && uP.length >= 2 ? [(d0[0] + u0[0]) / 2, yb, (d0[2] + u0[2]) / 2]
        : uP.length >= 2 ? [u0[0], yb, u0[2]] : dP.length >= 2 ? [d0[0], yb, d0[2]] : [pA[0] + (pB[0] - pA[0]) * (tb / T), yb, pA[2] + (pB[2] - pA[2]) * (tb / T)];
      const nObs = obs.length;
      conf = clamp(1 - rms / 0.1, 0.2, 1) * clamp(nObs / 3, 0.4, 1) * (restitution >= 0.5 && restitution <= 1.0 ? 1 : 0.65);
      if (best.rms > 0.12) { conf *= 0.6; log.push(`flight ${e.id}: poor fit (rms ${(best.rms * 100).toFixed(1)} cm)`); }
    } else {
      // a synthetic / unseen flight: gravity timing between the release and catch heights, the
      // bounce under the horizontal path's middle (the move's own path, when it has one)
      const yr = pA[1] - yb, yc = pB[1] - yb;
      tb = T * clamp(Math.sqrt(Math.max(0, yr)) / (Math.sqrt(Math.max(0, yr)) + Math.sqrt(Math.max(0, yc)) || 1), 0.25, 0.75);
      const hp = obs.length ? obs.reduce((s, o) => add(s, o.p), [0, 0, 0]).map((x) => x / obs.length) : lerp(pA, pB, 0.5);
      pb = [hp[0], yb, hp[2]];
      conf = video ? 0.45 : 0.35;
    }
    // constraint: the bounce spot out of the legs / feet at that moment (smallest shift)
    const fb = a + tb * fps;
    if (C.legsAt) {
      const caps = C.legsAt(fb);
      const moved = clearOfCaps(pb, caps, R, 0.02);
      if (moved.shift > 0.001) { log.push(`bounce ${e.id}: moved ${(moved.shift * 100).toFixed(1)} cm out of the legs`); pb = moved.p; conf *= 0.9; }
    }
    const local = toLocal(pb, C.traj(fb));
    const bw = Math.max(win, 0.05 * fps);
    return {
      kind: kindName, profile: profileOf(kindName, pA, pB), rms, restitution,
      bounce: { id: `b${++nid}`, auto: true, type: 'bounce', hand: null, frame: fb, window: [fb - bw, fb + bw], local: r3(local), conf: +clamp(conf, 0.05, 0.99).toFixed(2), rms: rms != null ? +rms.toFixed(4) : null, restitution: restitution != null ? +restitution.toFixed(3) : null },
    };
  }
  function interpBall(f) {
    if (!loop) f = clamp(f, 0, F - 1);
    const k = Math.min(Math.floor(f), loop ? Math.floor(f) : F - 2), u = f - k;
    const a = ball(k) || ball(k + 1), b = ball(k + 1) || ball(k);
    if (!a) { const h = hand[idx(Math.round(f))] || 'right'; return palm(Math.round(f), h); }
    return lerp(a, b, u);
  }
  function flightKind(e, c) {
    if (e.hand === c.hand) return 'dribble';
    const lab = C.labels ? C.labels[idx(Math.round((e.frame + c.frame) / 2))] : null;
    return lab === 'BETWEEN_LEGS' ? 'between-legs' : lab === 'BEHIND_BACK' ? 'behind-back' : 'crossover';
  }
  function profileOf(kind, pA, pB) {
    if (kind !== 'dribble') return kind;
    const h = Math.min(pA[1], pB[1]);
    return h < 0.55 ? 'low' : h > 1.0 ? 'high' : 'dribble';
  }
  // ── 6. normalized time, holds, entry / exit hands — and one floor contact in every dribble
  const out = finalize({ version: CONTACTS_VERSION, moveId: C.id || null, F, fps, loop, trackSource: C.trackSource || 'unknown', heldDistance: +dh.toFixed(3), events, flights, log, defaultHand: C.hand === 'left' || C.hand === 'right' ? C.hand : null });
  return ensureBounces(out, C);
}

/** Where the hands' path (A → B) passes between the legs: under the hips (H: their centre, [x, z]) between the feet (L, Rf: [x, z]) — when it crosses between the feet at all (ball-trajectory gateCrossing), else null. */
function gateXZ(A, B, L, Rf, Hc = null) {
  const g = gateCrossing(A, B, { l: L, r: Rf, h: Hc });
  return g ? g.p : null;
}
/**
 * Every dribble touches the floor exactly once (docs/ball-contact-system.md → CONTACT MODEL → one floor contact per
 * dribble). Each release → catch flight — the hand that lets go to the hand that takes it, the same or the other — is
 * read from the motion itself:
 *   it goes DOWN: the ball's own captured frames well below both hands (a ballistic flight between two hands never
 *   comes lower than the lower of them: below that it has bounced), or the releasing palm pushing down (vertical
 *   velocity ≤ −0.4 m/s) to a catch not much lower; or it has a bounce already →
 *     none: one is put in — WHEN gravity puts it (the drop from the release height and the rise to the catch height,
 *     √h each, the captured ball's lowest frame when it is near the floor then), WHERE the motion puts it: between the
 *     feet — under the hips, on the line from the releasing hand to the catching one — when that line crosses between
 *     them (between the legs), else where the captured ball came lowest, else under the hands' path; out of the legs;
 *     more than one: the one nearest that time stays;
 *   it stays up (a hand-off above the knees): no floor contact (a toss).
 * Applied to detected and to saved (Contact Editor) sets alike. C: the sampled clip (anim3d contactInput).
 */
export function ensureBounces(K, C) {
  if (!K?.events?.length || !C?.frames?.length || !C.traj) return K;
  const F = C.F, fps = C.fps || 30, loop = !!C.loop, R = C.R ?? 0.12, floorY = C.floorY ?? 0, yb = floorY + R, fr = C.frames;
  const idx = (f) => (loop ? ((Math.round(f) % F) + F) % F : Math.max(0, Math.min(F - 1, Math.round(f))));
  const palm = (f, h) => { const q = fr[idx(f)]; return h === 'left' ? q.palmL : h === 'right' ? q.palmR : lerp(q.palmL, q.palmR, 0.5); };
  const E = [...K.events].sort((a, b) => a.frame - b.frame);
  const log = K.log || (K.log = []);
  let changed = false, nid = 0;
  for (let i = 0; i < E.length; i++) {
    const e = E[i];
    if (e.type !== 'release' || (e.hand !== 'left' && e.hand !== 'right')) continue;
    // the catch that ends this flight (nothing else letting go of the ball before it); loops wrap
    let c = null;
    const bs = [];
    for (let k = 1; k < E.length * (loop ? 2 : 1); k++) {
      if (!loop && i + k >= E.length) break;
      const x = E[(i + k) % E.length], fx = i + k >= E.length ? x.frame + F : x.frame;
      if (x.type === 'bounce') { bs.push({ ev: x, f: fx }); continue; }
      if (x.type === 'catch') { c = { ev: x, f: fx }; break; }
      if (x.type === 'release' || x.type === 'shot' || x.type === 'pass' || x.type === 'gather') break;
    }
    if (!c) continue;
    const f0 = e.frame, fc = c.f, hc = c.ev.hand === 'left' || c.ev.hand === 'right' ? c.ev.hand : e.hand;
    if (fc - f0 < 0.08 * fps) continue;   // (shorter than 80 ms: a hand-to-hand hand-off)
    const pr = palm(f0, e.hand), pc = palm(fc, hc), vy = ((palm(f0 + 1, e.hand)[1] - palm(f0 - 1, e.hand)[1]) * fps) / 2;
    let low = null;
    for (let k = Math.ceil(f0); k <= Math.floor(fc); k++) { const b = fr[idx(k)].ball; if (b && (!low || b[1] < low.p[1])) low = { f: k, p: b }; }
    const down = bs.length > 0 || (low && low.p[1] < Math.min(pr[1], pc[1]) - 0.15) || (vy <= -0.4 && pc[1] > pr[1] - 0.25);
    if (!down || bs.length === 1) continue;
    const hr = Math.max(0.01, pr[1] - yb), hh = Math.max(0.01, pc[1] - yb);
    const fg = f0 + (fc - f0) * clamp(Math.sqrt(hr) / (Math.sqrt(hr) + Math.sqrt(hh)), 0.25, 0.75);
    if (bs.length > 1) {
      bs.sort((a, b) => Math.abs(a.f - fg) - Math.abs(b.f - fg));
      for (const b of bs.slice(1)) K.events.splice(K.events.indexOf(b.ev), 1);
      log.push(`flight ${e.id} ${e.hand} @${f0.toFixed(1)}: ${bs.length} floor contacts — the one @${bs[0].f.toFixed(1)} stays`);
      changed = true;
      continue;
    }
    // (the captured ball's lowest frame, when it is near the floor about then, is the bounce; else gravity's time)
    const lowNear = low && low.p[1] < yb + 0.25 && Math.abs(low.f - fg) <= 0.15 * fps;
    const fb = clamp(lowNear ? low.f : fg, f0 + 0.04 * fps, fc - 0.04 * fps), ft = loop ? ((fb % F) + F) % F : fb;
    const caps = C.legsAt ? C.legsAt(ft) : null;
    let p = null, how;
    if (caps?.length >= 6) { const foot = (q) => [(q.a[0] + q.b[0]) / 2, (q.a[2] + q.b[2]) / 2], hip = [(caps[0].a[0] + caps[3].a[0]) / 2, (caps[0].a[2] + caps[3].a[2]) / 2], g = gateXZ(pr, pc, foot(caps[2]), foot(caps[5]), hip); if (g) { p = [g[0], yb, g[1]]; how = 'under the hips, between the feet'; } }
    if (!p && lowNear) { p = [low.p[0], yb, low.p[2]]; how = 'where the ball came lowest'; }
    if (!p) { const q = lerp(pr, pc, (fb - f0) / (fc - f0)); p = [q[0], yb, q[2]]; how = "under the hands' path"; }
    if (caps) { const m = clearOfCaps(p, caps, R, 0.02); if (m.shift > 0.001) p = m.p; }
    const bw = Math.max(0.5, 0.05 * fps);
    K.events.push({ id: `bi${++nid}`, type: 'bounce', hand: null, frame: ft, window: [ft - bw, ft + bw], local: r3(toLocal(p, C.traj(ft))), conf: 0.5, auto: true, inserted: true });
    log.push(`flight ${e.id} ${e.hand} @${f0.toFixed(1)} → ${hc} @${fc.toFixed(1)} goes down with no floor contact: one put in @${ft.toFixed(1)} (${how})`);
    changed = true;
  }
  if (!changed) return K;
  K.flights = [];   // (rebuilt from the events)
  return finalize(K);
}

function emptyContacts(C) {
  return { version: CONTACTS_VERSION, moveId: C.id || null, F: C.F || 0, fps: C.fps || 30, loop: !!C.loop, trackSource: C.trackSource || 'unknown', events: [], flights: [], holds: [], entryHand: null, exitHand: null, log: ['no ball'] };
}

/** Distance from p to segment ab. */
function segDist(p, a, b) {
  const ab = sub(b, a), t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1e-9), 0, 1);
  return dist(p, add(a, sc(ab, t)));
}
/** Move a ball centre out of capsules (smallest shift; sideways, then along, then up). */
export function clearOfCaps(p, caps, R, margin = 0.015) {
  const clear = (q) => Math.min(...caps.map((c) => segDist(q, c.a, c.b) - c.r - R));
  const c0 = caps.length ? clear(p) : Infinity;
  if (c0 >= margin) return { p, shift: 0, clearance: c0 };
  let best = null;
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.7071, 0, 0.7071], [-0.7071, 0, 0.7071], [0.7071, 0, -0.7071], [-0.7071, 0, -0.7071]];
  for (const d of dirs) for (let s = 0.005; s <= 0.35; s += 0.005) { const q = add(p, sc(d, s)); if (clear(q) >= margin) { if (!best || s < best.shift) best = { p: q, shift: s }; break; } }
  return best ? { ...best, clearance: clear(best.p) } : { p, shift: 0, clearance: c0, failed: true };
}

/**
 * Normalize a contact set: sort, normalized times (u), holds, flights re-linked, entry / exit hands.
 * Works on detected and on edited sets alike.
 */
export function finalize(c) {
  const F = c.F, loop = c.loop, span = loop ? F : Math.max(1, F - 1);
  c.events = (c.events || []).filter((e) => TYPES.includes(e.type) && Number.isFinite(e.frame)).sort((a, b) => a.frame - b.frame);
  for (const e of c.events) {
    e.frame = +(+e.frame).toFixed(3);
    if (!Array.isArray(e.window) || e.window.length !== 2) e.window = [e.frame - 0.5, e.frame + 0.5];
    e.window = e.window.map((x) => +(+x).toFixed(3));
    e.u = +(e.frame / span).toFixed(4);
    e.conf = e.conf == null ? 1 : +(+e.conf).toFixed(2);
  }
  // flights from the event order (an edited set may have none)
  if (!c.flights?.length || c.flights.some((f) => !c.events.find((e) => e.id === f.release))) {
    c.flights = [];
    const E = c.events;
    for (let i = 0; i < E.length; i++) {
      if (E[i].type !== 'release') continue;
      let b = null, k = i + 1;
      for (; k < E.length + (loop ? E.length : 0); k++) {
        const e = E[k % E.length];
        if (e.type === 'bounce' && !b) b = e;
        else if (e.type === 'catch') break;
        else if (e.type === 'release' || e.type === 'shot' || e.type === 'pass') { k = -1; break; }
      }
      const cat = k >= 0 && k < E.length * 2 ? E[k % E.length] : null;
      if (!cat || cat.type !== 'catch') continue;
      c.flights.push({ release: E[i].id, bounce: b?.id || null, catch: cat.id, fromHand: E[i].hand, toHand: cat.hand, kind: E[i].hand === cat.hand ? 'dribble' : 'crossover', profile: b ? 'dribble' : 'toss' });
    }
  }
  // holds: from each catch / gather / the start to the next release / shot / pass / the end
  const holds = [];
  const starts = c.events.filter((e) => e.type === 'catch' || e.type === 'gather');
  const ends = c.events.filter((e) => e.type === 'release' || e.type === 'shot' || e.type === 'pass');
  const firstEnd = ends[0];
  if (firstEnd && (!starts.length || starts[0].frame > firstEnd.frame)) holds.push({ hand: firstEnd.hand, from: 0, to: firstEnd.frame });
  for (const s of starts) {
    const e = ends.find((x) => x.frame > s.frame) || (loop ? ends[0] && { ...ends[0], frame: ends[0].frame + F } : null);
    holds.push({ hand: s.hand, from: s.frame, to: e ? e.frame : F - 1 });
  }
  if (!c.events.length && c.holdHand) holds.push({ hand: c.holdHand, from: 0, to: F - 1 });
  c.holds = holds.sort((a, b) => a.from - b.from);
  const firstHold = c.holds[0], lastHold = [...c.holds].sort((a, b) => a.to - b.to).pop();
  // (a two-hand start enters in the hand that lets go first, else the clip's own starting hand —
  // a mirrored clip's is the other one, never the literal right)
  c.entryHand = c.entryHand || (firstHold ? (firstHold.hand === 'both' ? (ends[0]?.hand !== 'both' ? ends[0]?.hand : null) || c.defaultHand || 'right' : firstHold.hand) : null);
  const lastHand = lastHold ? lastHold.hand : null;
  c.exitHand = c.exitHand || (lastHand === 'both' ? c.entryHand : lastHand);
  return c;
}

/**
 * Apply saved edits (Contact Editor) to a detected set. Edits replace the events wholesale
 * (manual: true, confidence 1 unless given); offsets / profiles / hands are kept from the edits.
 * A saved bounce with no floor spot (a marker placed on the timeline, never dragged on the floor) gets
 * one — the detected bounce at that moment, else where the clip's ball / hands put it (C: the sampled
 * clip) — so it still bounces on the floor instead of flying hand to hand.
 */
export function mergeContacts(auto, edits, C = null) {
  if (!edits || edits.version !== CONTACTS_VERSION || !Array.isArray(edits.events)) return auto;
  const c = { ...auto, flights: [], events: edits.events.map((e) => ({ ...e, manual: true, auto: false, conf: e.conf ?? 1 })), edited: edits.savedAt || true, offsets: edits.offsets || auto.offsets || null, entryHand: edits.entryHand || null, exitHand: edits.exitHand || null };
  if (Array.isArray(edits.flights)) c.flights = edits.flights;
  const fps = auto.fps || C?.fps || 30;
  for (const e of c.events) {
    if (e.type !== 'bounce' || (Array.isArray(e.local) && e.local.length === 3 && e.local.every(Number.isFinite))) continue;
    const near = (auto.events || []).filter((a) => a.type === 'bounce' && a.local && Math.abs(a.frame - e.frame) <= Math.max(2, 0.07 * fps)).sort((a, b) => Math.abs(a.frame - e.frame) - Math.abs(b.frame - e.frame))[0];
    if (near) { e.local = near.local.slice(); e.localFrom = 'auto'; continue; }
    const at = C ? bounceSpot(C, c.events, e) : null;
    if (at) { e.local = at; e.localFrom = 'clip'; }
  }
  // (a saved set too: every dribble in it touches the floor exactly once)
  return ensureBounces(finalize(c), C);
}
/** A floor spot (local, at e.frame) for a bounce with none: the captured ball's lowest point near it, else under the hands' path, out of the legs. */
function bounceSpot(C, events, e) {
  const R = C.R ?? 0.12, floorY = C.floorY ?? 0, F = C.F, fr = C.frames;
  if (!fr?.length || !C.traj) return null;
  const at = (k) => fr[Math.max(0, Math.min(F - 1, Math.round(k)))];
  let pb = null;
  for (let k = Math.floor(e.frame) - 2; k <= Math.ceil(e.frame) + 2; k++) { const b = k >= 0 && k < F ? fr[k].ball : null; if (b && b[1] < floorY + R + 0.15 && (!pb || b[1] < pb[1])) pb = b; }
  if (!pb) {
    const rel = [...events].reverse().find((x) => x.type === 'release' && x.frame < e.frame), cat = events.find((x) => x.type === 'catch' && x.frame > e.frame);
    const palm = (x) => (x?.hand === 'left' ? at(x.frame).palmL : x?.hand === 'right' ? at(x.frame).palmR : null);
    const a = palm(rel) || at(e.frame).palmR, b = palm(cat) || a;
    pb = lerp(a, b, rel && cat ? clamp((e.frame - rel.frame) / Math.max(1e-6, cat.frame - rel.frame), 0, 1) : 0.5);
  }
  let p = [pb[0], floorY + R, pb[2]];
  if (C.legsAt) { const m = clearOfCaps(p, C.legsAt(e.frame), R, 0.02); if (m.shift > 0.001) p = m.p; }
  return r3(toLocal(p, C.traj(e.frame)));
}

/** Validate an edit payload (server + editor): returns { ok, errors, clean }. */
export function validateEdits(o) {
  const errors = [];
  if (!o || typeof o !== 'object') return { ok: false, errors: ['not an object'] };
  const events = Array.isArray(o.events) ? o.events : [];
  if (events.length > 200) errors.push('too many events');
  const clean = { version: CONTACTS_VERSION, events: [], offsets: null, savedAt: new Date().toISOString() };
  events.forEach((e, i) => {
    if (!TYPES.includes(e.type)) { errors.push(`event ${i}: type`); return; }
    if (!Number.isFinite(+e.frame)) { errors.push(`event ${i}: frame`); return; }
    const hand = ['left', 'right', 'both', null, undefined].includes(e.hand) ? e.hand ?? null : 'right';
    const w = Array.isArray(e.window) && e.window.length === 2 && e.window.every((x) => Number.isFinite(+x)) ? e.window.map(Number) : [+e.frame - 0.5, +e.frame + 0.5];
    const ev = { id: String(e.id || `${e.type[0]}${i + 1}`).slice(0, 12), type: e.type, hand, frame: +e.frame, window: [Math.min(w[0], +e.frame), Math.max(w[1], +e.frame)], conf: e.conf != null ? clamp(+e.conf, 0, 1) : 1 };
    if (e.type === 'bounce') ev.local = Array.isArray(e.local) && e.local.length === 3 && e.local.every((x) => Number.isFinite(+x)) ? e.local.map((x) => clamp(+x, -2, 3)) : null;
    if (e.profile && PROFILES.includes(e.profile)) ev.profile = e.profile;
    clean.events.push(ev);
  });
  if (o.offsets && typeof o.offsets === 'object') {
    clean.offsets = {};
    for (const h of ['left', 'right']) { const x = o.offsets[h]; if (x) clean.offsets[h] = { normal: clamp(+x.normal || 0, -0.06, 0.06), along: clamp(+x.along || 0, -0.08, 0.08) }; }
  }
  for (const k of ['entryHand', 'exitHand']) if (['left', 'right'].includes(o[k])) clean[k] = o[k];
  return { ok: !errors.length, errors, clean };
}

/**
 * Captured track → clean track (clip space, one point per frame): holds on the palm, each flight
 * the solver's path through the release, the (fitted, leg-cleared) bounce and the catch — the
 * capture's timing, height, horizontal path and rhythm kept; jumps, noise, floor penetration and
 * spikes gone.
 * @param {object} C   the same sampled clip as detectContacts
 * @param {object} K   contacts (detected or edited)
 * @returns {{ p: number[][], state: string[] }}
 */
export function cleanBallTrack(C, K) {
  const { F, fps, loop } = C, R = C.R ?? 0.12, floorY = C.floorY ?? 0;
  const out = new Array(F).fill(null), state = new Array(F).fill('none');
  const heldPos = (k, h) => {
    const f = C.frames[((Math.round(k) % F) + F) % F];
    if (h === 'both') return lerp(f.palmL, f.palmR, 0.5).map((x, i) => (i === 1 ? x - 0.02 : x));
    const b = f.ball && f.held ? f.ball : null;
    return b || (h === 'left' ? f.palmL : f.palmR);
  };
  // holds
  for (const h of K.holds || []) for (let k = Math.ceil(h.from); k <= Math.floor(h.to); k++) { const i = ((k % F) + F) % F; if (i < F) { out[i] = heldPos(k, h.hand); state[i] = 'held'; } }
  // flights
  const byId = Object.fromEntries((K.events || []).map((e) => [e.id, e]));
  for (const fl of K.flights || []) {
    const e = byId[fl.release], c = byId[fl.catch], b = fl.bounce ? byId[fl.bounce] : null;
    if (!e || !c) continue;
    const cf = c.frame < e.frame && loop ? c.frame + F : c.frame;
    const pr = heldPos(e.frame, e.hand), pc = heldPos(cf, c.hand);
    let plan;
    if (b) {
      const bf = b.frame < e.frame && loop ? b.frame + F : b.frame;
      const pb = b.local ? fromLocal(b.local, C.traj(b.frame)) : lerp(pr, pc, 0.5);
      plan = planDribble({ tr: e.frame / fps, pr, vr: null, tb: bf / fps, pb, tc: cf / fps, pc, g: G, floorY, R });
    } else plan = { toss: planToss({ tr: e.frame / fps, pr, vr: null, tc: cf / fps, pc, floorY, R }) };
    if (!plan) continue;
    for (let k = Math.ceil(e.frame); k <= Math.floor(cf); k++) {
      const t = k / fps, i = ((k % F) + F) % F;
      out[i] = plan.toss ? segPos(plan.toss, t) : t <= plan.tb ? segPos(plan.down, t) : segPos(plan.up, t);
      state[i] = 'flight';
    }
  }
  // anything left (a shot, a loose ball): the capture, off the floor, single-frame jumps removed
  for (let i = 0; i < F; i++) {
    if (out[i]) continue;
    const b = C.frames[i].ball;
    if (b) { out[i] = [b[0], Math.max(floorY + R, b[1]), b[2]]; state[i] = 'captured'; }
  }
  for (let i = 1; i < F - 1; i++) {
    if (state[i] !== 'captured' || !out[i - 1] || !out[i + 1]) continue;
    const m = lerp(out[i - 1], out[i + 1], 0.5);
    if (dist(out[i], m) > 0.25) { out[i] = m; state[i] = 'despiked'; }
  }
  return { p: out, state };
}

/** Summary line per event (logs, tests, the editor's list). */
export function describe(K) {
  return (K.events || []).map((e) => `${e.type}${e.hand ? ' ' + e.hand : ''} @${e.frame.toFixed(1)} (u ${e.u?.toFixed?.(2)}) conf ${e.conf}${e.local ? ' local ' + e.local.map((x) => x.toFixed(2)).join(',') : ''}`);
}
