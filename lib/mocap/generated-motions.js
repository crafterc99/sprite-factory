/**
 * Motions that were not filmed: generated here (lib/mocap/motion-gen.js) or
 * imported from a motion generator such as NVIDIA Kimodo (joint positions on
 * its SOMA / SMPL-X skeleton, mapped to MHR70 by lib/mocap/kimodo.js).
 *
 * They are stored like analysed motions (meta.json + motion.json + raw.json,
 * disk + cloud), so they show up in /mocap and the 3D game-clip library, get
 * a role, and build into game clips the same way. raw.json holds the world
 * joints directly: { generated: {...}, fps, statureM, worldFrames, balls }.
 */
'use strict';

const store = require('./store');
const S = require('./skeleton');

function checkFrames(frames) {
  if (!Array.isArray(frames) || frames.length < 4) throw new Error('need at least 4 frames');
  for (const P of frames) {
    if (!Array.isArray(P) || P.length !== 70) throw new Error('every frame needs 70 MHR70 joints');
    for (const p of P) if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) throw new Error('joints must be [x, y, z] numbers');
  }
}

/**
 * @param {object} g { name, role, type, fps, statureM, frames, balls, source, prompt?, params?, entryMax? }
 * @returns {Promise<string>} motion id
 */
async function saveGenerated(g, { id } = {}) {
  checkFrames(g.frames);
  const fps = Math.max(4, Math.min(120, +g.fps || 30));
  id = id || store.newId('mo');
  const now = new Date().toISOString();
  const statureM = +g.statureM || 1.8;
  const balls = Array.isArray(g.balls) && g.balls.length === g.frames.length ? g.balls : g.frames.map(() => null);
  const raw = { version: 1, fps, statureM, generated: { source: g.source || 'generated', prompt: g.prompt || null, params: g.params || null }, worldFrames: g.frames, balls };
  const motion = {
    fps, frameCount: g.frames.length, statureM, settings: { smoothing: 0, trimStart: 0, trimEnd: 0 },
    frames: g.frames.map((P, i) => ({ joints: P, ball: balls[i] || null })),
    report: { generated: true },
  };
  const game = { role: g.role || null, type: g.type || 'action' };
  if (g.entryMax != null) game.entryMax = g.entryMax;
  const meta = {
    id, name: g.name || id, createdAt: now, updatedAt: now, fps, frameCount: g.frames.length, statureM,
    startingHand: balls.find((b) => b && b.held)?.hand || null,
    source: g.source || 'generated', prompt: g.prompt || null, generated: true,
    report: { generated: true }, game,
  };
  await store.saveMotionFile(id, 'raw', raw);
  await store.saveMotionFile(id, 'motion', motion);
  await store.saveMotionFile(id, 'meta', meta);
  await store.upsertIndex('motions', id, { id, name: meta.name, createdAt: now, fps, frameCount: meta.frameCount, generated: true, source: meta.source });
  return id;
}

/** Joint-name → MHR70 import: frames as { name: [x,y,z] } objects or MHR70-ordered arrays. */
function toMHR70(frames) {
  return frames.map((f) => (Array.isArray(f) ? f : S.MHR70.map((n) => {
    const p = f[n];
    if (!p) throw new Error(`frame is missing joint "${n}"`);
    return p;
  })));
}

module.exports = { saveGenerated, toMHR70, checkFrames };
