/**
 * Game clips as a service: a motion + its game settings (role, type, trims,
 * warps) → a built game clip (clip-builder), cached in memory, on disk and in
 * the cloud (motion asset gameclip-v2.json.gz), so the 3D court never rebuilds
 * after a redeploy.
 *
 * meta.game (per motion, edited in /mocap → "3D game clip"):
 *   { role, type: 'loop'|'action', trimStart, trimEnd, warp: [{from,to,dx,dz}]|null,
 *     entryMax, mirror, notes }
 * Defaults: role guessed from the name/shot; loops use the whole take (the loop
 * search picks the cycle), actions the motion's own trims; step-back warps
 * from game-roles.defaultWarps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('./store');
const CB = require('./clip-builder');
const { ROLES, guessRole, defaultWarps } = require('./game-roles');
const { listMotionIds } = require('./character-rig');

const CLIP_VERSION = 2;
const ASSET = `gameclip-v${CLIP_VERSION}.json.gz`;
// bump when clip-builder output changes meaning (invalidates every cache)
const BUILDER_REV = 'cb-2026-09-28a';

/** The effective game settings of a motion (stored + defaults). */
function gameSettings(meta, motion) {
  const g = meta?.game || {};
  const role = g.role !== undefined ? g.role : guessRole(meta);
  const def = role && ROLES[role];
  const type = g.type || def?.type || (meta?.report?.shotRelease ? 'action' : 'loop');
  const trims = type === 'loop' ? { trimStart: 0, trimEnd: 0 } : { trimStart: motion?.settings?.trimStart || 0, trimEnd: motion?.settings?.trimEnd || 0 };
  return {
    role: role || null, type,
    trimStart: g.trimStart != null ? g.trimStart : trims.trimStart,
    trimEnd: g.trimEnd != null ? g.trimEnd : trims.trimEnd,
    warp: Array.isArray(g.warp) ? g.warp : null, // null = role defaults
    entryMax: g.entryMax != null ? g.entryMax : null,
    mirror: g.mirror !== false,
    notes: g.notes || '',
    assigned: !!(meta?.game && meta.game.role !== undefined),
  };
}

const mem = new Map(); // id → { key, json, gz, etag }
const inflight = new Map();

async function build(motionId, { force = false } = {}) {
  const [meta, motion] = await Promise.all([store.loadMotionFile(motionId, 'meta'), store.loadMotionFile(motionId, 'motion')]);
  if (!meta || !motion) throw new Error('motion not found');
  const gs = gameSettings(meta, motion);
  const key = JSON.stringify([CLIP_VERSION, BUILDER_REV, motionId, meta.updatedAt || meta.createdAt, motion.frameCount, motion.settings?.smoothing, gs]);
  const etag = '"' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '"';
  const hit = mem.get(motionId);
  if (!force && hit && hit.key === key) return hit;
  if (!force && inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const diskPath = path.join(store.motionDir(motionId), ASSET);
    const tryBuf = (buf) => { try { const j = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); if (j.key === key) return { key, json: j, gz: buf, etag }; } catch {} return null; };
    if (!force) {
      let got = fs.existsSync(diskPath) ? tryBuf(fs.readFileSync(diskPath)) : null;
      if (!got) { try { const fp = await store.loadMotionAsset(motionId, ASSET); if (fp) got = tryBuf(fs.readFileSync(fp)); } catch {} }
      if (got) { mem.set(motionId, got); return got; }
    }
    const raw = await store.loadMotionFile(motionId, 'raw');
    if (!raw) throw new Error('this motion has no raw measurements (re-analyse it)');
    const settings = { smoothing: motion.settings?.smoothing ?? 1.2, trimStart: gs.trimStart, trimEnd: gs.trimEnd };
    const opts = { type: gs.type, role: gs.role, name: meta.name || motionId, settings, entryMax: gs.entryMax };
    let clip = CB.buildGameClip(raw, opts);
    const warp = gs.warp || defaultWarps(gs.role, clip);
    if (warp.length) clip = CB.buildGameClip(raw, { ...opts, warp });
    const json = {
      ...clip, key, id: motionId, role: gs.role, game: gs,
      source: { ...clip.source, report: undefined, motionName: meta.name, fps: motion.fps, droppedFrames: clip.source?.report?.droppedFrames || [] },
      builtAt: new Date().toISOString(),
    };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(json)));
    const out = { key, json, gz, etag };
    mem.set(motionId, out);
    try { fs.mkdirSync(path.dirname(diskPath), { recursive: true }); fs.writeFileSync(diskPath, gz); } catch {}
    store.saveMotionAsset(motionId, ASSET, gz).catch(() => {});
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Library summary: every motion with a role or a guess, with quality when built. */
async function library() {
  const ids = await listMotionIds();
  const out = [];
  await Promise.all(ids.map(async (id) => {
    const [meta, motion] = await Promise.all([store.loadMotionFile(id, 'meta').catch(() => null), store.loadMotionFile(id, 'motion').catch(() => null)]);
    if (!meta || !motion) return;
    const gs = gameSettings(meta, motion);
    const hit = mem.get(id);
    const j = hit?.json;
    out.push({
      id, name: meta.name || id, createdAt: meta.createdAt, fps: motion.fps, frameCount: motion.frameCount,
      hasMesh: !!meta.mesh?.frames, game: gs,
      built: j ? { frameCount: j.frameCount, fps: j.fps, loop: j.loop, stats: j.stats, quality: j.quality, shot: !!j.shot, builtAt: j.builtAt } : null,
    });
  }));
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

/** Save a motion's game settings (partial update; null clears a field). */
async function saveSettings(motionId, patch) {
  const meta = await store.loadMotionFile(motionId, 'meta');
  if (!meta) throw new Error('motion not found');
  const g = { ...(meta.game || {}) };
  const allow = ['role', 'type', 'trimStart', 'trimEnd', 'warp', 'entryMax', 'mirror', 'notes'];
  for (const k of allow) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === '') { delete g[k]; continue; }
    if (k === 'role' && v !== 'none' && !ROLES[v]) throw new Error(`unknown role "${v}"`);
    if (k === 'type' && !['loop', 'action'].includes(v)) throw new Error('type must be loop or action');
    if ((k === 'trimStart' || k === 'trimEnd' || k === 'entryMax') && !(Number.isInteger(+v) && +v >= 0)) throw new Error(`${k} must be a whole number ≥ 0`);
    if (k === 'warp' && !(Array.isArray(v) && v.every((w) => Number.isFinite(+w.from) && Number.isFinite(+w.to) && Number.isFinite(+w.dx) && Number.isFinite(+w.dz)))) throw new Error('warp must be [{from,to,dx,dz}]');
    g[k] = k === 'role' ? (v === 'none' ? null : v) : k === 'trimStart' || k === 'trimEnd' || k === 'entryMax' ? +v : k === 'mirror' ? !!v : k === 'notes' ? String(v).slice(0, 500) : v;
  }
  meta.game = g;
  meta.updatedAt = new Date().toISOString();
  await store.saveMotionFile(motionId, 'meta', meta);
  mem.delete(motionId);
  return gameSettings(meta, await store.loadMotionFile(motionId, 'motion'));
}

/** Clips for the 3D court: one per role (newest assigned first), built. */
async function clipsForCourt() {
  const lib = await library();
  const byRole = new Map();
  // explicit assignments beat guesses; newer beats older
  const ranked = lib.filter((m) => m.game.role).sort((a, b) => (b.game.assigned - a.game.assigned) || String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const m of ranked) if (!byRole.has(m.game.role)) byRole.set(m.game.role, m);
  return [...byRole.values()].map((m) => ({ id: m.id, role: m.game.role, name: m.name }));
}

module.exports = { build, library, saveSettings, gameSettings, clipsForCourt, ROLES, ASSET };
