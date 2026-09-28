/**
 * Mocap pipeline orchestration (Stage 1: hosted SAM 3 + SAM 3D Body on fal).
 *
 *   analyzeVideo  — video → sampled frames → SAM 3 masks + ball → SAM 3D Body
 *                   per frame → raw.json → motion.json (clean, reusable move)
 *   generateMove  — motion × character × views × hands → mannequin pose refs →
 *                   image model → aligned to the mannequin → canonical ball →
 *                   QC + auto-retry → game strip + hi-res frames + result record
 *   regenFrame    — redo one frame of a finished variant (optional instruction)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const S = require('./skeleton');
const providers = require('./providers');
const { buildMotion } = require('./motion-builder');
const M = require('./mannequin');
const C = require('./compose');
const models = require('./image-models');
const store = require('./store');

const CHARACTERS_FILE = process.env.CHARACTERS_FILE || path.resolve(__dirname, '../../data/.characters.json');

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function findVideo(sessionDir) {
  if (!fs.existsSync(sessionDir)) return null;
  const f = fs.readdirSync(sessionDir).find((x) => /\.(mov|mp4|m4v|avi|mkv|webm)$/i.test(x));
  return f ? path.join(sessionDir, f) : null;
}

// ── Analyze ────────────────────────────────────────────────────────────────
/**
 * @param {object} o { sessionId, name, fps=12, start, end, maxFrames=48, TMP_DIR }
 * @param {function} progress ({ step, done, total, msg })
 */
async function analyzeVideo(o, progress = () => {}) {
  const { extractFrames } = require('../sprite-generator/video-extractor');
  const sessionDir = path.join(o.TMP_DIR, store.safeId(o.sessionId));
  const video = findVideo(sessionDir);
  if (!video) throw new Error('No uploaded video for this session — upload or record one first');

  const id = store.newId('mo');
  const dir = store.motionDir(id);
  const framesDir = path.join(dir, 'frames');
  const masksDir = path.join(dir, 'masks');
  fs.mkdirSync(masksDir, { recursive: true });

  const fps = Math.max(4, Math.min(30, +o.fps || 12));
  const extractOpts = { fps, scale: 'min(1280\\,iw)' };
  if (o.start > 0) extractOpts.start = String(o.start);
  if (o.end > (o.start || 0)) extractOpts.duration = String(Math.max(0.2, o.end - (o.start || 0)));
  progress({ step: 'extract', done: 0, total: 1, msg: 'Extracting frames…' });
  await extractFrames(video, framesDir, extractOpts);
  let files = fs.readdirSync(framesDir).filter((f) => /^frame-\d+\.(png|jpe?g)$/i.test(f)).sort();
  const maxFrames = Math.max(2, Math.min(96, +o.maxFrames || 48));
  if (files.length > maxFrames) {
    for (const f of files.slice(maxFrames)) fs.rmSync(path.join(framesDir, f), { force: true });
    files = files.slice(0, maxFrames);
  }
  if (files.length < 2) throw new Error('Clip too short — need at least 2 frames');

  let cost = 0;
  let done = 0;
  const total = files.length;
  progress({ step: 'measure', done, total, msg: `Measuring ${total} frames (SAM 3 + SAM 3D Body)…` });
  const rawFrames = await pool(files, 4, async (file, i) => {
    const fp = path.join(framesDir, file);
    const rec = { file, index: i };
    try {
      const seg = await providers.segmentFrame(fp);
      cost += seg.cost || 0;
      const maskPath = path.join(masksDir, `mask-${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(maskPath, seg.personMaskPng);
      rec.ball = seg.ball;
      rec.personBBox = seg.person?.bbox || null;
      const body = await providers.bodyFrame(fp, maskPath);
      cost += body.cost || 0;
      Object.assign(rec, { kp2d: body.kp2d, kp3d: body.kp3d, camT: body.camT, focal: body.focal, imgW: body.imgW, imgH: body.imgH, bbox: body.bbox });
    } catch (err) {
      rec.error = String(err.message || err).slice(0, 300);
    }
    done++;
    progress({ step: 'measure', done, total, msg: `Measured ${done}/${total} frames` });
    return rec;
  });

  const failed = rawFrames.filter((r) => r.error);
  if (failed.length === rawFrames.length) {
    throw new Error(`Every frame failed: ${failed[0].error}`);
  }

  const raw = { version: 1, fps, sessionId: o.sessionId, frames: rawFrames };
  const motion = buildMotion(raw, o.settings || {});
  const meta = {
    id, name: (o.name || 'move').trim().slice(0, 60), createdAt: new Date().toISOString(),
    fps, frameCount: motion.frameCount, sourceFrames: files.length, failedFrames: failed.length,
    statureM: motion.statureM, startingHand: motion.startingHand, report: motion.report,
    measureCost: +cost.toFixed(3), settings: motion.settings,
  };
  await store.saveMotionFile(id, 'raw', raw);
  await store.saveMotionFile(id, 'motion', motion);
  await store.saveMotionFile(id, 'meta', meta);
  await store.upsertIndex('motions', id, { name: meta.name, createdAt: meta.createdAt, frameCount: meta.frameCount, fps, startingHand: meta.startingHand });
  progress({ step: 'done', done: total, total, msg: 'Motion ready' });
  return { motionId: id, meta };
}

/** Re-clean a motion from raw.json with new settings (smoothing, trim, …). */
async function reprocessMotion(id, settings) {
  const raw = await store.loadMotionFile(id, 'raw');
  if (!raw) throw new Error('Motion not found');
  const meta = (await store.loadMotionFile(id, 'meta')) || { id };
  const motion = buildMotion(raw, settings || {});
  Object.assign(meta, { frameCount: motion.frameCount, statureM: motion.statureM, startingHand: motion.startingHand, report: motion.report, settings: motion.settings, updatedAt: new Date().toISOString() });
  await store.saveMotionFile(id, 'motion', motion);
  await store.saveMotionFile(id, 'meta', meta);
  await store.upsertIndex('motions', id, { frameCount: meta.frameCount, startingHand: meta.startingHand });
  return { motion, meta };
}

// ── Character helpers ──────────────────────────────────────────────────────
function loadCharacter(charName) {
  let reg = {};
  try { if (fs.existsSync(CHARACTERS_FILE)) reg = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8')); } catch {}
  const c = reg[charName] || {};
  const heightInches = +c.heightInches || 72;
  return {
    name: charName,
    heightInches,
    statureM: heightInches * 0.0254,
    pixelHeight: +c.pixelHeight || Math.round((111.6 * heightInches) / 72),
    description: c.clothingDescription || c.description || '',
  };
}

function characterRefs(ASSETS_DIR, charName, angleIdx) {
  const pick = (...names) => names.map((n) => path.join(ASSETS_DIR, n)).find((p) => fs.existsSync(p)) || null;
  const angle = pick(`${charName}-angle-${angleIdx}.png`, `${charName}-angle-0.png`, `${charName}full.png`);
  const portrait = pick(`${charName}full.png`, `${charName}-angle-0.png`);
  return { angle, portrait: portrait && portrait !== angle ? portrait : null };
}

// ── Prompt ────────────────────────────────────────────────────────────────
function buildPrompt({ viewLabel, hasAnchor, hasPortrait, transparent, charDescription, custom }) {
  let n = 2;
  const anchorIdx = hasAnchor ? ++n : null;
  const portraitIdx = hasPortrait ? ++n : null;
  const lines = [
    'Image 1 is the CHARACTER. Keep this exact person: face, hair, skin tone, body build, outfit, shoes, colours and clean art style. Do not redesign anything.',
    `Image 2 is a POSE MANNEQUIN from motion capture, seen from the ${viewLabel} camera angle. Redraw the character from Image 1 in exactly this pose:`,
    '- BLUE mannequin limbs are the character\'s LEFT arm and leg. RED limbs are the character\'s RIGHT arm and leg. Grey is the torso and head. Dots on the head mark the face (they only appear when the face is toward the viewer).',
    '- Match every joint angle, elbow and knee bend, torso lean, head direction and foot placement. Same camera angle and framing: the character fills the same area of the image as the mannequin, feet at the same height, full body visible, nothing cropped.',
  ];
  if (anchorIdx) lines.push(`Image ${anchorIdx} is an approved frame of this same animation. Match its rendering exactly — same colours, line weight, shading, proportions and scale.`);
  if (portraitIdx) lines.push(`Image ${portraitIdx} is the character's front reference — use it to keep the face and outfit identical.`);
  if (charDescription) lines.push(`Character notes: ${charDescription}`);
  lines.push(
    '- Do NOT draw a basketball or any ball, even if the hands look like they are dribbling. Keep the hand shapes from the pose; the ball is added separately.',
    '- No floor, shadow, text, logo or props. One character only.',
    '- Clean illustrated game-character style exactly like Image 1. No pixel art, no photo realism changes.',
    transparent
      ? 'Background: fully transparent.'
      : 'Background: solid pure green #00FF00 everywhere around the character. No green anywhere on the character.',
  );
  if (custom) lines.push(`SPECIFIC INSTRUCTION: ${custom}`);
  return lines.join('\n');
}

// ── Generate ──────────────────────────────────────────────────────────────
/**
 * Orange share of the character reference itself (skin, clothing), measured
 * on the character only — the green reference background must not dilute it,
 * or skin tones read as "the model drew a ball".
 */
async function refOrangeShare(refPath) {
  const buf = fs.readFileSync(refPath);
  const prep = await C.prepareGenerated(buf, false).catch(() => null);
  return (await C.colorProfile(prep ? prep.buf : buf)).orangeShare;
}
function variantName(motionMeta, view, hand) {
  const base = String(motionMeta.name || 'move').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'move';
  return `mocap-${base}-${motionMeta.id.slice(-4)}-z${view}-${hand}`;
}

async function generateOneFrame(ctx, fi, { anchorPath, custom } = {}) {
  const { motion, view, mirror, statureM, ppm, refs, model, quality, charInfo, workDir } = ctx;
  const r = await M.renderFrame(motion, fi, { view, mirror, statureM, ppm });
  const posePath = path.join(workDir, `pose-${fi}.png`);
  const poseAlphaPath = path.join(workDir, `pose-alpha-${fi}.png`);
  fs.writeFileSync(posePath, r.png);
  fs.writeFileSync(poseAlphaPath, r.alphaPng);
  const info = models.modelInfo(model);
  const images = [refs.angle, r.png];
  if (anchorPath) images.push(anchorPath);
  if (refs.portrait) images.push(refs.portrait);
  const prompt = buildPrompt({
    viewLabel: M.VIEWS[view].label, hasAnchor: !!anchorPath, hasPortrait: !!refs.portrait,
    transparent: info.transparent, charDescription: charInfo.description, custom,
  });
  const gen = await models.generateImage({ model, prompt, images, quality, poseIndex: 1 });
  fs.writeFileSync(path.join(workDir, `raw-${fi}.png`), gen.buffer);
  // Keep every raw generation (disk + R2) so a variant can be re-aligned /
  // re-composited later (motion clean-up, ball fixes) without new model calls
  const rawFile = `raw-${fi}-${Date.now().toString(36)}.png`;
  const genDir = path.join(ctx.ASSETS_DIR, `${ctx.charName}-${ctx.animName}-gen`);
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, rawFile), gen.buffer);
  const r2 = require('../r2-storage');
  if (r2.isAvailable()) r2.uploadFile(`${ctx.charName}-${ctx.animName}-gen/${rawFile}`, gen.buffer).catch(() => {});
  const prep = await C.prepareGenerated(gen.buffer, gen.transparent);
  return { fi, render: r, prep, k: C.fitScaleFor(prep.stats, r.bbox), cost: gen.cost || 0, rawFile, transparent: gen.transparent };
}

async function finishFrame(ctx, g, kMedian, anchorProfile) {
  const lo = kMedian * (1 - C.QC_LIMITS.scaleDev), hi = kMedian * (1 + C.QC_LIMITS.scaleDev);
  const k = Math.max(lo, Math.min(hi, g.k));
  const scaleDev = Math.abs(g.k - kMedian) / kMedian;
  const placed = await C.placeOnCanvas(g.prep, g.render.bbox, k);
  const sil = await C.silhouetteQC(placed, g.render.alphaPng);
  const prof = await C.colorProfile(placed);
  const palette = anchorProfile ? C.histIntersection(prof.hist, anchorProfile.hist) : null;
  const drewBall = await C.detectDrawnBall(placed, g.render.ballPx?.r || 0.12 * ctx.ppm);
  const withBall = await C.compositeBall(placed, g.render.ballPx);
  const qc = C.judge({ sil, palette, drewBall, scaleDev });
  qc.metrics = { coverage: +sil.coverage.toFixed(3), spill: +sil.spill.toFixed(3), palette: palette == null ? null : +palette.toFixed(3), scaleDev: +scaleDev.toFixed(3), drewBall };
  return { canvas: withBall, charOnly: placed, profile: prof, qc, k };
}

async function writeVariantOutputs(ctx, finals) {
  const { ASSETS_DIR, charName, animName, statureM, ppm, charInfo } = ctx;
  const r2 = require('../r2-storage');
  const framesDir = path.join(ASSETS_DIR, `${charName}-${animName}-frames`);
  fs.mkdirSync(framesDir, { recursive: true });
  const gameBufs = [];
  let clipped = false;
  for (let i = 0; i < finals.length; i++) {
    const game = await C.toGameFrame(finals[i].canvas, { statureM, ppm, pixelHeight: charInfo.pixelHeight });
    const hires = await C.toGameFrame(finals[i].canvas, { statureM, ppm, pixelHeight: charInfo.pixelHeight, outSize: C.GAME.size * C.HIRES });
    clipped = clipped || game.clipped;
    gameBufs.push(game.buf);
    const fp = path.join(framesDir, `frame-${i}.png`);
    fs.writeFileSync(fp, hires.buf);
    if (r2.isAvailable()) r2.uploadFile(`${charName}-${animName}-frames/frame-${i}.png`, fp).catch(() => {});
  }
  const stripPath = path.join(ASSETS_DIR, `${charName}-${animName}.png`);
  await C.buildStripFromFrames(gameBufs, stripPath);
  if (r2.isAvailable()) r2.uploadFile(`${charName}-${animName}.png`, stripPath).catch(() => {});
  // Marks the frames as pre-aligned so studio rebuilds never re-scale them per frame
  const genmeta = { mode: 'mocap-aligned', frameSize: C.GAME.size, hiresSize: C.GAME.size * C.HIRES, baseline: C.GAME.baseline, pixelHeight: charInfo.pixelHeight, motionId: ctx.motionId, view: ctx.view, hand: ctx.hand };
  const metaPath = path.join(ASSETS_DIR, `${charName}-${animName}-genmeta.json`);
  fs.writeFileSync(metaPath, JSON.stringify(genmeta));
  if (r2.isAvailable()) r2.uploadFile(`${charName}-${animName}-genmeta.json`, metaPath, 'application/json').catch(() => {});
  return { stripUrl: `/assets/${charName}-${animName}.png?v=${Date.now().toString(36)}`, frameUrls: finals.map((_, i) => `/assets/${charName}-${animName}-frames/frame-${i}.png`), clipped };
}

/**
 * @param {object} o { motionId, charName, views:[1..5], hands:['right','left'], model, quality,
 *                     frameStep=1, retries=1, concurrency=3, ASSETS_DIR, TMP_DIR }
 */
async function generateMove(o, progress = () => {}) {
  const motion = await store.loadMotionFile(o.motionId, 'motion');
  const meta = await store.loadMotionFile(o.motionId, 'meta');
  if (!motion || !meta) throw new Error('Motion not found');
  const charInfo = loadCharacter(o.charName);
  const views = (o.views && o.views.length ? o.views : [1]).map(Number).filter((v) => M.VIEWS[v]);
  const hands = (o.hands && o.hands.length ? o.hands : [motion.startingHand || 'right']).filter((h) => h === 'left' || h === 'right');
  const step = Math.max(1, +o.frameStep || 1);
  const frameIdx = Array.from({ length: motion.frameCount }, (_, i) => i).filter((i) => i % step === 0);
  const model = o.model || 'gemini-3-pro-image-preview';
  const retries = Math.max(0, Math.min(3, o.retries ?? 1));
  const baseHand = motion.startingHand || 'right';

  const resultId = store.newId('mr');
  const result = {
    id: resultId, motionId: o.motionId, motionName: meta.name, charName: o.charName, model,
    quality: o.quality || 'high', createdAt: new Date().toISOString(), fps: Math.max(1, Math.round((motion.fps || 12) / step)),
    frameIdx, variants: [], cost: meas(0), status: 'running',
  };
  function meas(x) { return +x.toFixed(4); }

  const totalFrames = views.length * hands.length * frameIdx.length;
  let doneFrames = 0;
  const tick = (msg) => progress({ done: doneFrames, total: totalFrames, msg, resultId, variants: result.variants });

  for (const hand of hands) {
    const mirror = hand !== baseHand;
    const ppm = M.fitScale(motion, { statureM: charInfo.statureM, mirror });
    for (const view of views) {
      const refs = characterRefs(o.ASSETS_DIR, o.charName, M.VIEWS[view].angleIdx);
      if (!refs.angle) throw new Error(`No reference image for "${o.charName}" — generate body angles or a portrait first`);
      const animName = variantName(meta, view, hand);
      const workDir = path.join(o.TMP_DIR, 'mocap-gen', resultId, animName);
      fs.mkdirSync(workDir, { recursive: true });
      const refOrange = await refOrangeShare(refs.angle);
      const ctx = { ...o, motion, view, hand, mirror, statureM: charInfo.statureM, ppm, refs, model, quality: o.quality || 'high', charInfo, workDir, animName, refOrange };
      const variant = { view, viewLabel: M.VIEWS[view].label, hand, mirror, animName, status: 'generating', frames: [], ppm, statureM: charInfo.statureM, pixelHeight: charInfo.pixelHeight };
      result.variants.push(variant);
      tick(`${M.VIEWS[view].label} · ${hand} hand: anchor frame…`);

      // Anchor frame first; the rest reference it (parallel, consistent)
      const gens = new Array(frameIdx.length);
      gens[0] = await generateOneFrame(ctx, frameIdx[0]);
      result.cost += gens[0].cost;
      doneFrames++;
      const anchorPath = path.join(workDir, 'anchor.png');
      // Anchor reference = the anchor character placed at its own scale on the pose canvas
      fs.writeFileSync(anchorPath, await C.placeOnCanvas(gens[0].prep, gens[0].render.bbox, gens[0].k));
      tick(`${M.VIEWS[view].label} · ${hand} hand: frames…`);
      await pool(frameIdx.slice(1), Math.max(1, Math.min(4, +o.concurrency || 3)), async (fi, j) => {
        gens[j + 1] = await generateOneFrame(ctx, fi, { anchorPath });
        result.cost += gens[j + 1].cost;
        doneFrames++;
        tick(`${M.VIEWS[view].label} · ${hand}: ${doneFrames}/${totalFrames} frames`);
      });

      // Align with a clamped per-frame scale around the median, then QC + retry
      const kMedian = S.median(gens.map((g) => g.k));
      let anchorFinal = await finishFrame(ctx, gens[0], kMedian, null);
      const finals = [anchorFinal];
      for (let j = 1; j < gens.length; j++) finals.push(await finishFrame(ctx, gens[j], kMedian, anchorFinal.profile));
      for (let j = 0; j < finals.length; j++) {
        let attempts = 1;
        while (!finals[j].qc.pass && attempts <= retries) {
          tick(`${M.VIEWS[view].label} · ${hand}: retrying frame ${j + 1} (${finals[j].qc.issues[0]})`);
          const g = await generateOneFrame(ctx, frameIdx[j], { anchorPath: j === 0 ? null : anchorPath });
          result.cost += g.cost;
          const f = await finishFrame(ctx, g, kMedian, j === 0 ? null : anchorFinal.profile);
          attempts++;
          if (f.qc.score > finals[j].qc.score) { finals[j] = f; gens[j] = g; }
          finals[j].rawFile = gens[j].rawFile;
        }
        finals[j].qc.attempts = attempts;
        if (j === 0) anchorFinal = finals[0];
      }

      const out = await writeVariantOutputs(ctx, finals);
      Object.assign(variant, {
        status: 'done', kMedian, spriteUrl: out.stripUrl, frameUrls: out.frameUrls, clipped: out.clipped,
        frameCount: finals.length, fps: result.fps,
        frames: finals.map((f, j) => ({ index: j, sourceFrame: frameIdx[j], pass: f.qc.pass, score: f.qc.score, issues: f.qc.issues, attempts: f.qc.attempts, metrics: f.qc.metrics, raw: gens[j].rawFile, transparent: gens[j].transparent })),
        qcPassRate: +(finals.filter((f) => f.qc.pass).length / finals.length).toFixed(2),
      });
      await store.saveResult(result);
      tick(`${M.VIEWS[view].label} · ${hand} hand done`);
    }
  }
  result.status = 'done';
  result.cost = +result.cost.toFixed(4);
  await store.saveResult(result);
  await store.upsertIndex('results', resultId, { motionId: o.motionId, charName: o.charName, model, createdAt: result.createdAt, variants: result.variants.length });
  return result;
}

/** Regenerate one frame of a finished variant. */
async function regenFrame(o) {
  const result = await store.loadResult(o.resultId);
  if (!result) throw new Error('Result not found');
  const variant = result.variants.find((v) => v.animName === o.animName);
  if (!variant) throw new Error('Variant not found');
  const motion = await store.loadMotionFile(result.motionId, 'motion');
  const charInfo = loadCharacter(result.charName);
  const j = +o.frameIndex;
  const fi = result.frameIdx[j];
  if (fi == null) throw new Error('frameIndex out of range');
  const refs = characterRefs(o.ASSETS_DIR, result.charName, M.VIEWS[variant.view].angleIdx);
  const workDir = path.join(o.TMP_DIR, 'mocap-gen', result.id, variant.animName);
  fs.mkdirSync(workDir, { recursive: true });
  const model = o.model || result.model;
  const ctx = {
    ...o, motion, view: variant.view, hand: variant.hand, mirror: variant.mirror, statureM: variant.statureM,
    ppm: variant.ppm, refs, model, quality: result.quality, charInfo, workDir, animName: variant.animName, motionId: result.motionId, charName: result.charName,
    refOrange: await refOrangeShare(refs.angle),
  };
  // Anchor = hi-res frame 0 mapped back onto the pose canvas is not needed: the
  // model only needs to see the approved look, so hand it frame 0 as-is.
  const framesDir = path.join(o.ASSETS_DIR, `${result.charName}-${variant.animName}-frames`);
  const anchorPath = j === 0 ? null : path.join(framesDir, 'frame-0.png');
  const g = await generateOneFrame(ctx, fi, { anchorPath: anchorPath && fs.existsSync(anchorPath) ? anchorPath : null, custom: o.customPrompt });
  const anchorProfile = anchorPath && fs.existsSync(anchorPath) ? await C.colorProfile(fs.readFileSync(anchorPath)) : null;
  const f = await finishFrame(ctx, g, variant.kMedian || g.k, anchorProfile);

  // Rebuild the strip from the stored hi-res frames with this one replaced
  const game = await C.toGameFrame(f.canvas, { statureM: variant.statureM, ppm: variant.ppm, pixelHeight: charInfo.pixelHeight, outSize: C.GAME.size * C.HIRES });
  const target = path.join(framesDir, `frame-${j}.png`);
  fs.writeFileSync(target, game.buf);
  const r2 = require('../r2-storage');
  if (r2.isAvailable()) r2.uploadFile(`${result.charName}-${variant.animName}-frames/frame-${j}.png`, target).catch(() => {});
  const bufs = [];
  for (let i = 0; i < variant.frameCount; i++) {
    const p = path.join(framesDir, `frame-${i}.png`);
    bufs.push(await sharp(p).resize(C.GAME.size, C.GAME.size, { kernel: 'lanczos3' }).png().toBuffer());
  }
  const stripPath = path.join(o.ASSETS_DIR, `${result.charName}-${variant.animName}.png`);
  await C.buildStripFromFrames(bufs, stripPath);
  if (r2.isAvailable()) r2.uploadFile(`${result.charName}-${variant.animName}.png`, stripPath).catch(() => {});

  variant.frames[j] = { index: j, sourceFrame: fi, pass: f.qc.pass, score: f.qc.score, issues: f.qc.issues, attempts: (variant.frames[j]?.attempts || 1) + 1, metrics: f.qc.metrics, raw: g.rawFile, transparent: g.transparent };
  variant.spriteUrl = `/assets/${result.charName}-${variant.animName}.png?v=${Date.now().toString(36)}`;
  variant.qcPassRate = +(variant.frames.filter((x) => x.pass).length / variant.frames.length).toFixed(2);
  result.cost = +((result.cost || 0) + g.cost).toFixed(4);
  await store.saveResult(result);
  return { variant, frameUrl: `/assets/${result.charName}-${variant.animName}-frames/frame-${j}.png?v=${Date.now().toString(36)}` };
}

/**
 * Re-align + re-composite a finished result from its stored raw generations
 * against the CURRENT motion (after a re-clean or a ball fix). No model calls.
 */
async function recomposeResult(o) {
  const result = await store.loadResult(o.resultId);
  if (!result) throw new Error('Result not found');
  const motion = await store.loadMotionFile(result.motionId, 'motion');
  const charInfo = loadCharacter(result.charName);
  const r2 = require('../r2-storage');
  let done = 0;
  for (const variant of result.variants) {
    if (o.animName && variant.animName !== o.animName) continue;
    const refs = characterRefs(o.ASSETS_DIR, result.charName, M.VIEWS[variant.view].angleIdx);
    const ctx = {
      ...o, motion, view: variant.view, hand: variant.hand, mirror: variant.mirror, statureM: charInfo.statureM,
      charName: result.charName, animName: variant.animName, motionId: result.motionId, charInfo,
      refOrange: await refOrangeShare(refs.angle),
    };
    ctx.ppm = M.fitScale(motion, { statureM: charInfo.statureM, mirror: variant.mirror });
    const genDir = path.join(o.ASSETS_DIR, `${result.charName}-${variant.animName}-gen`);
    const gens = [];
    for (let j = 0; j < variant.frames.length; j++) {
      const fr = variant.frames[j];
      if (!fr.raw) throw new Error(`${variant.animName} frame ${j} has no stored raw generation (made before recompose existed)`);
      let raw = null;
      const p = path.join(genDir, fr.raw);
      if (fs.existsSync(p)) raw = fs.readFileSync(p);
      else if (r2.isAvailable()) raw = await r2.downloadFile(`${result.charName}-${variant.animName}-gen/${fr.raw}`);
      if (!raw) throw new Error(`raw generation missing: ${fr.raw}`);
      const fi = Math.min(motion.frameCount - 1, result.frameIdx[j]);
      const render = await M.renderFrame(motion, fi, { view: variant.view, mirror: variant.mirror, statureM: charInfo.statureM, ppm: ctx.ppm });
      const prep = await C.prepareGenerated(raw, fr.transparent !== false && models.modelInfo(result.model).transparent);
      gens.push({ fi, render, prep, k: C.fitScaleFor(prep.stats, render.bbox), rawFile: fr.raw, transparent: fr.transparent });
    }
    const kMedian = S.median(gens.map((g) => g.k));
    const anchor = await finishFrame(ctx, gens[0], kMedian, null);
    const finals = [anchor];
    for (let j = 1; j < gens.length; j++) finals.push(await finishFrame(ctx, gens[j], kMedian, anchor.profile));
    const out = await writeVariantOutputs(ctx, finals);
    Object.assign(variant, {
      kMedian, ppm: ctx.ppm, statureM: charInfo.statureM, pixelHeight: charInfo.pixelHeight, spriteUrl: out.stripUrl, frameUrls: out.frameUrls, clipped: out.clipped,
      frames: finals.map((f, j) => ({ ...variant.frames[j], pass: f.qc.pass, score: f.qc.score, issues: f.qc.issues, metrics: f.qc.metrics })),
      qcPassRate: +(finals.filter((f) => f.qc.pass).length / finals.length).toFixed(2), recomposedAt: new Date().toISOString(),
    });
    done++;
  }
  await store.saveResult(result);
  return { result, variantsRecomposed: done };
}

module.exports = { recomposeResult, analyzeVideo, reprocessMotion, generateMove, regenFrame, loadCharacter, buildPrompt, variantName };
