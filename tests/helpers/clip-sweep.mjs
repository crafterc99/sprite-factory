/**
 * The clip sweep (docs/ball-contact-system.md → TESTING): every clip the court can play — each one
 * alone in its role, as filmed and mirrored — run through the real game tick (tests/helpers/ball-harness.mjs)
 * and measured on what is drawn, every tick:
 *
 *   hands    the hands' full LOD0 skin against the ball (deepest vertex, > 0 inside); while a hand owns the
 *            ball (held / catching) with its palm on it, each fingertip pad's gap off the surface (index …
 *            pinky, and the thumb); finger joints tick to tick (what the hand pass adds beyond the clip's
 *            own motion, rad/s)
 *   body     the body's own skin (torso + head, legs) against the controlled ball: the deepest vertex in a
 *            flight (hand → floor → hand, the solver's path) and on the hand (a hold / a catch)
 *   ball     lost (LOOSE), failsafe recoveries, catch error, rejected transitions, NaN, floor
 *
 * Any clip the user uploads with a runtime role is swept the same way (tests/clip-sweep.test.js).
 */
import { makeGame, courtClips } from './ball-harness.mjs';

const MS = await import('../../engine3d/mhr-skin.mjs');
const A = await import('../../engine3d/anim3d.mjs');
const TR = await import('../../engine3d/ball-trajectory.mjs');

/** The sweep's limits (m, rad/s). */
export const SWEEP_LIMITS = Object.freeze({
  handInside: -0.000999,  // the hand skin stays ≥ 1 mm outside the ball, every tick (contact-ik: margin 1.5 mm − tol 0.5 mm; float slack)
  tipGap: 0.006,          // a contact hand's fingertip pads (index … pinky) ≤ 6 mm off the ball
  thumbGap: 0.008,        // its thumb pad ≤ 8 mm
  jointRate: 26.5,        // rad/s a finger joint is turned beyond the clip's own motion (the 24 rad/s close + 10 %)
  bodyFlight: -0.002,     // a flight never enters the body skin (torso, head, legs): ≤ 2 mm (the skin is a surface sample)
  bodyHeld: 0.03,         // a ball on the hand touches the body skin by ≤ 3 cm (a capture's hand against a knee)
  catchErr: 0.06,         // m: a catch meets its palm
  // STRICT (never a per-clip ceiling): every bounce touches the floor, every flight stays above it
  bounceErr: 0.003,       // m: the ball's bottom at the floor ± 3 mm at every bounce — its path at the bounce instant, and as drawn on the bounce tick
  floorDip: -0.0005,      // m: a flight's path (every tick, and its planned segments between ticks) never below the floor by more than 0.5 mm
});
/** Metrics held to SWEEP_LIMITS on every clip and hand with no known-residual ceiling (tests/clip-sweep.test.js). */
export const STRICT = Object.freeze(['bounceErr', 'floorDip', 'bodyFlight']);

const LEGS = /^[lr]_(upleg|lowleg|foot|talocrural|subtalar|transversetarsal|ball)/;
const TORSO = /^(c_spine|c_neck|c_head|root|body_world|[lr]_clavicle)/;
/** The body skin of a rig sorted by its strongest bone: torso + head, legs (the arms and hands are not "the body" here). */
export function bodySkin(rigJson, mrig) {
  const part = rigJson.parts?.[0];
  if (!part) return null;
  const V = A.b64(part.verts, Float32Array), SI = A.b64(part.skinIdx, Uint8Array), SW = A.b64(part.skinW, Float32Array);
  const n = V.length / 3, torso = [], legs = [];
  for (let i = 0; i < n; i++) {
    let best = -1, bw = 0;
    for (let c = 0; c < 4; c++) if (SW[i * 4 + c] > bw) { bw = SW[i * 4 + c]; best = SI[i * 4 + c]; }
    const nm = mrig.names[best] || '';
    if (LEGS.test(nm)) legs.push(i); else if (TORSO.test(nm)) torso.push(i);
  }
  const pack = (ids) => {
    const v0 = new Float32Array(ids.length * 3), si = new Uint16Array(ids.length * 4), sw = new Float32Array(ids.length * 4);
    ids.forEach((i, k) => { for (let d = 0; d < 3; d++) v0[k * 3 + d] = V[i * 3 + d]; for (let c = 0; c < 4; c++) { si[k * 4 + c] = SI[i * 4 + c]; sw[k * 4 + c] = SW[i * 4 + c]; } });
    return { v0, si, sw, pos: new Float32Array(ids.length * 3), n: ids.length };
  };
  return { torso: pack(torso), legs: pack(legs) };
}
/** The deepest vertex of a skin set into the ball (m, > 0 inside). */
function depthOf(S, mats, c, R) {
  MS.skinVerts(S.v0, S.si, S.sw, mats, S.pos);
  let d = -Infinity;
  for (let v = 0; v < S.n; v++) { const x = R - Math.hypot(S.pos[v * 3] - c[0], S.pos[v * 3 + 1] - c[1], S.pos[v * 3 + 2] - c[2]); if (x > d) d = x; }
  return d;
}

/**
 * The sweep's cases: every runtime clip of the library, alone in its role, from each hand (the clip as
 * filmed and its mirror; a clip that is never mirrored plays from its own hand only).
 * @returns {{ key, clip, role, hand, script, start?, clips }[]}
 */
export async function sweepCases(all = null) {
  all = all || (await courtClips());
  if (!all) return [];
  const out = [];
  for (const c of all) {
    const only = all.filter((x) => x.role !== c.role || x === c);
    const role = c.role, base = { clip: c.name, id: c.id, role, clips: only };
    // (a clip that is never mirrored plays from its own hand only: the right — the recording guide's convention)
    const hands = c.game?.mirror === false ? ['right'] : ['right', 'left'];
    for (const h of hands) {
      const hand = { hand: h };
      if (role === 'idle') out.push({ ...base, key: `${c.name} · ${h}`, hand: h, script: [[0, 3.2, hand]] });
      else if (/^loco-/.test(role)) {
        const move = { 'loco-fwd': 'toHoop', 'loco-sprint': 'toHoop', 'loco-back': 'awayHoop', 'loco-left': 'sideHoop', 'loco-right': 'sideHoop' }[role] || 'toHoop';
        out.push({ ...base, key: `${c.name} · ${h}`, hand: h, start: move === 'toHoop' ? [0.5, 12] : undefined, script: [[0, 0.8, hand], [0.8, 3.4, { move, sprint: role === 'loco-sprint' }]] });
      } else if (/^shot-/.test(role)) {
        out.push({ ...base, key: `${c.name} · ${h}`, hand: h, script: [[0, 1, hand], [1, 1.6, { trig: role, move: role === 'shot-stepback' ? 'toHoop' : undefined }], [1.6, 8.5, {}]] });
      } else {
        const dur = (c.frameCount || 30) / (c.fps || 30);
        out.push({ ...base, key: `${c.name} · ${h}`, hand: h, script: [[0, 0.8, hand], [0.8, 0.8 + dur + 2.2, { trig: role }]] });
      }
    }
  }
  return out;
}

/**
 * Run one case and measure it (see the top). opts: { rig: 'ac-001', fps: 60 }.
 * @returns {object} one row of numbers (m; rad/s) + where the worst of each happened
 */
export async function runCase(cs, { rig = 'ac-001', fps = 60, game = null } = {}) {
  const g = game || (await makeGame({ rig, fps, clips: cs.clips, start: cs.start }));
  const body = g.__body || (g.__body = bodySkin(g.rigJson, g.mrig));
  const R = g.session.ctl.cfg.R;
  const B = { flightTorso: -Infinity, flightLegs: -Infinity, flightRaw: -Infinity, heldTorso: -Infinity, heldLegs: -Infinity, at: {} };
  const worst = (k, d, t, out, P) => { if (d > B[k]) { B[k] = d; B.at[k] = { t: +t.toFixed(3), state: out.state, clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null }; } };
  const played = new Set();
  // the floor: every bounce (its path at the bounce instant, the ball drawn on the bounce tick), every flight above it
  const bounces = [];
  // every dribble (release → catch) that goes down touches the floor exactly once; one that stays up (a hand-off) never
  const flights = [];
  let cur = null;
  let floorDip = Infinity, floorDipAt = null;
  const dip = (d, t, out, P, how) => { if (d < floorDip) { floorDip = d; floorDipAt = { t: +t.toFixed(4), state: out.state, how, clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null }; } };
  const m = g.run(cs.script, {
    onTick: ({ t, out, P, mats, session }) => {
      if (P.mode === 'action' && P.action?.clip) played.add(`${P.action.clip.name}${P.action.clip.mirror ? ' (mirrored)' : ''}`);
      const C = session.ctl;
      if (!C.controlled) return;
      const st = out.state;
      for (const e of out.events) {
        if (e.type === 'release' && !e.loose) { const fl = C.flight; cur = { t: +t.toFixed(3), clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null, from: e.hand, to: e.toHand, kind: e.kind, bounces: 0, yr: fl?.pr?.[1] ?? out.p[1], vy: fl?.vr?.[1] ?? 0, minY: Infinity }; flights.push(cur); }
        if (e.type === 'bounce' && cur) cur.bounces++;
        if (e.type === 'catch' && cur) { cur.yc = out.p[1]; cur.done = true; cur = null; }
      }
      if (cur && /^(RELEASE_|DRIBBLE_|BOUNCE|CATCH_)/.test(st)) cur.minY = Math.min(cur.minY, out.p[1]);
      for (const e of out.events) if (e.type === 'bounce') {
        const fl = C.flight || C.lastFlight, plan = fl?.down ? TR.segPos(fl.down, fl.tb)[1] - R : null;
        bounces.push({ t: +e.t.toFixed(4), tick: +t.toFixed(4), clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null, from: fl?.fromHand, to: fl?.toHand, plan: plan != null ? +plan.toFixed(5) : null, drawn: +(out.p[1] - R).toFixed(5), at: e.p.map((x) => +x.toFixed(3)) });
      }
      // the flight's path: as drawn this tick, and its planned segments from now to the catch (between the ticks)
      const inFlight = /^(RELEASE_|DRIBBLE_|BOUNCE|CATCH_|PASS_RELEASE)/.test(st);
      if (inFlight) {
        dip(out.p[1] - R, t, out, P, 'drawn');
        const fl = C.flight;
        if (fl) for (const sg of [fl.toss, fl.down, fl.up]) if (sg && sg.t1 > t) { const a = Math.max(t, sg.t0); for (let k = 0; k <= 24; k++) dip(TR.segPos(sg, a + ((sg.t1 - a) * k) / 24)[1] - R, t, out, P, sg.kind); }
      }
      if (!body) return;
      // a flight (hand → floor → hand): the ball off its hands — leaving one (RELEASE_), in the air, arriving at the other
      // (CATCH_, the blend) — more than 3 cm from both hands' palm targets; on a hand: held, or within 3 cm of it
      const fl = C.flight, T = session.lastTargets;
      const hands = /^(DRIBBLE_|BOUNCE|RELEASE_|CATCH_)/.test(st) ? [...new Set([fl?.fromHand, fl?.toHand, /^(RELEASE|CATCH)_/.test(st) ? (st.endsWith('LEFT') ? 'left' : 'right') : null].filter((h) => h === 'left' || h === 'right'))] : [];
      const near = hands.map((h) => ({ h, d: Math.hypot(...out.p.map((x, k) => x - T[h].p[k])) })).sort((a, b) => a.d - b.d)[0] || null;
      const flight = /^(DRIBBLE_|BOUNCE)/.test(st) || (/^(RELEASE_|CATCH_)/.test(st) && (!near || near.d > 0.03));
      const onHand = !flight && /^(HELD_|CATCH_|RELEASE_)/.test(st);
      if (!flight && !onHand) return;
      const dT = depthOf(body.torso, mats, out.p, R), dL = depthOf(body.legs, mats, out.p, R);
      if (!flight) { worst('heldTorso', dT, t, out, P); worst('heldLegs', dL, t, out, P); return; }
      // (near a hand the capture puts against the body — the double crossover's low catch at the shin, the between-the-legs
      // catch behind the calf — the ball on that hand is itself in the body: within 20 cm of it a flight may be as deep as
      // the ball on that hand would be, tapering to nothing at 20 cm; anywhere else it never enters the body)
      let allow = 0;
      if (near && near.d < 0.2) { const hp = Math.max(depthOf(body.torso, mats, T[near.h].p, R), depthOf(body.legs, mats, T[near.h].p, R)); if (hp > 0) allow = hp * (1 - Math.max(0, near.d - 0.03) / 0.17); }
      worst('flightRaw', Math.max(dT, dL), t, out, P);
      worst('flightTorso', dT - allow, t, out, P); worst('flightLegs', dL - allow, t, out, P);
      if (allow > 0 && Math.max(dT, dL) > -0.002) B.handForced = Math.max(B.handForced || 0, Math.max(dT, dL));
    },
  });
  // (down: a dribble flight, or a ball that went well below both hands, or a push down to a catch not much lower)
  const badFlights = flights.filter((f) => f.done).map((f) => ({ ...f, down: f.kind === 'dribble' || f.minY < Math.min(f.yr, f.yc) - 0.15 || (f.vy <= -0.4 && f.yc > f.yr - 0.25) })).filter((f) => f.bounces !== (f.down ? 1 : 0))
    .map((f) => ({ t: f.t, clip: f.clip, frame: f.frame, from: f.from, to: f.to, kind: f.kind, bounces: f.bounces, down: f.down }));
  const bErr = bounces.reduce((a, b) => Math.max(a, Math.abs(b.plan ?? 0), Math.abs(b.drawn)), 0);
  const bWorst = bounces.reduce((a, b) => (!a || Math.max(Math.abs(b.plan ?? 0), Math.abs(b.drawn)) > Math.max(Math.abs(a.plan ?? 0), Math.abs(a.drawn)) ? b : a), null);
  const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : x);
  return {
    key: cs.key, clip: cs.clip, role: cs.role, hand: cs.hand, played: [...played],
    handInside: r4(m.maxHandPen), handInsideAt: m.handPenAt,
    tipGap: r4(m.flareTipMax), tipAt: m.flareAt, tipP90: r4(m.flareTipP90), thumbGap: r4(m.thumbTipMax), thumbAt: m.thumbAt,
    jointRate: +m.maxJointRateAdd.toFixed(1), jointAt: m.jointJumpAt, clipJointRate: +(m.maxBaseJointJump * fps).toFixed(1),
    contactTicks: m.contactTicks,
    bodyFlight: r4(Math.max(B.flightTorso, B.flightLegs)), bodyFlightRaw: r4(B.flightRaw), handForced: B.handForced ? r4(B.handForced) : null, bodyHeld: r4(Math.max(B.heldTorso, B.heldLegs)), bodyAt: B.at,
    bounceErr: r4(bErr), bounceAt: bWorst, bounces, floorDip: r4(Number.isFinite(floorDip) ? floorDip : 0), floorDipAt,
    dribbles: flights.filter((f) => f.done).length, badFlights,
    legFlight: m.leg?.flight ? r4(m.leg.flight.min) : null,
    lost: m.looseTicks, recoveries: m.recoveryCount, recoveryWhy: m.recoveries, rejected: m.rejected, nan: m.nan, floor: m.floorViolations,
    catches: m.catches.length, releases: m.releases, catchErr: r4(m.maxCatchErr), maxAccel: Math.round(m.maxAccel || 0), accelAt: m.accelAt,
    actions: m.actions, shots: m.shots.length, through: m.shots[0]?.through ?? null,
  };
}

/** The limits a row breaks (empty: clean). */
export function sweepFailures(row, L = SWEEP_LIMITS) {
  const f = [];
  const mm = (x) => `${(x * 1000).toFixed(1)} mm`;
  if (!(row.handInside <= L.handInside)) f.push(`hand skin ${mm(row.handInside)} into the ball at ${JSON.stringify(row.handInsideAt)}`);
  if (row.tipGap > L.tipGap) f.push(`fingertip ${mm(row.tipGap)} off the ball at ${JSON.stringify(row.tipAt)}`);
  if (row.thumbGap > L.thumbGap) f.push(`thumb ${mm(row.thumbGap)} off the ball at ${JSON.stringify(row.thumbAt)}`);
  if (row.jointRate > L.jointRate) f.push(`finger joint turned ${row.jointRate} rad/s at ${JSON.stringify(row.jointAt)}`);
  if (row.bodyFlight > L.bodyFlight) f.push(`flight ${mm(row.bodyFlight)} into the body at ${JSON.stringify(row.bodyAt)}`);
  if (row.bodyHeld > L.bodyHeld) f.push(`ball on the hand ${mm(row.bodyHeld)} into the body at ${JSON.stringify(row.bodyAt)}`);
  if (row.bounceErr > L.bounceErr) f.push(`a bounce ${mm(row.bounceErr)} off the floor at ${JSON.stringify(row.bounceAt)}`);
  if (row.floorDip < L.floorDip) f.push(`a flight ${mm(-row.floorDip)} below the floor at ${JSON.stringify(row.floorDipAt)}`);
  for (const b of row.badFlights || []) f.push(`a ${b.down ? 'dribble' : 'hand-off'} with ${b.bounces} floor contacts (${b.down ? 'it goes down: exactly 1' : 'it stays up: none'}) at ${JSON.stringify(b)}`);
  if (row.lost) f.push(`lost ${row.lost} ticks`);
  if (row.recoveries) f.push(`${row.recoveries} recoveries ${JSON.stringify(row.recoveryWhy)}`);
  if (row.rejected) f.push(`${row.rejected} rejected transitions`);
  if (row.nan) f.push('NaN');
  if (row.floor) f.push(`${row.floor} ticks under the floor`);
  if (row.catchErr > L.catchErr) f.push(`catch ${(row.catchErr * 100).toFixed(1)} cm off its palm`);
  return f;
}
