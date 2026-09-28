/**
 * Character from video: a textured 3D model of the performer, for the court.
 *
 *   1. references  — crops of the performer from analysed source frames
 *   2. views       — a clean full-body A-pose front view of that exact person
 *                    (same face, hair, build, clothes), then the back view
 *                    (image model; transparent / white background)
 *   3. mesh        — fal Hyper3D Rodin v2.5 from the views (TAPose: A/T pose
 *                    for rigging, de-lit PBR textures) → GLB
 *
 * Rigging onto the performer's MHR skeleton runs offline (scripts/mhr/
 * fit_generated.py): the result joins lib/mocap/mhr-rigs/ like any rig.
 * Jobs live in data/.chargen/<jobId>/ (job.json + files).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const fal = require('./fal-client');
const IM = require('./image-models');
const store = require('./store');

const RODIN = 'fal-ai/hyper3d/rodin/v2.5';
const RODIN_COST = 0.4; // USD per generation (fal model page)
const ROOT = path.join(__dirname, '..', '..', 'data', '.chargen');
const jobs = new Map();

const jobDir = (id) => path.join(ROOT, id);
function save(job) {
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  fs.writeFileSync(path.join(jobDir(job.id), 'job.json'), JSON.stringify(job, null, 1));
}
function getJob(id) {
  if (!/^cg-[a-z0-9]+$/.test(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  const p = path.join(jobDir(id), 'job.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function filePath(id, name) {
  if (!getJob(id) || !/^[a-z0-9_.-]+$/i.test(name)) return null;
  const p = path.join(jobDir(id), name);
  return fs.existsSync(p) ? p : null;
}

const POSE = 'Standing in a neutral A-pose: arms straight and relaxed, about 30 degrees away from the body, palms facing the thighs, fingers together and relaxed, legs straight, feet shoulder-width apart pointing forward, head level.';
const LOOK = 'Photorealistic, true-to-life proportions, the whole body in frame from the top of the head to the soles with margin, camera at chest height, straight-on, plain pure white background, soft even studio lighting, no cast shadows, nothing held in the hands, no ball, no props, no text.';

function frontPrompt(outfit) {
  return `A full-body photo of this exact person from the reference photos: the same face, skin tone, hairstyle, body build and height proportions, wearing exactly the same clothes and footwear${outfit ? ` (${outfit})` : ''}, with the same colours, fit and details. ${POSE} Front view, looking straight at the camera, neutral expression. ${LOOK}`;
}
function backPrompt(outfit) {
  return `The same person as in the first image, in exactly the same A-pose and clothes${outfit ? ` (${outfit})` : ''}, seen from directly behind (back view, the camera behind them at chest height). Keep the same body proportions, hair and clothing details (hood, seams, stripes). ${LOOK}`;
}

/** Crops of the performer (person box + margin) from analysed source frames. */
async function referenceCrops(motionId, frames) {
  const raw = await store.loadMotionFile(motionId, 'raw');
  if (!raw?.frames?.length) throw new Error(`motion ${motionId} not found`);
  const out = [];
  for (const i of frames) {
    const fr = raw.frames[i];
    if (!fr || fr.error) continue;
    let p = path.join(store.motionDir(motionId), 'frames', fr.file);
    if (!fs.existsSync(p)) p = await store.loadMotionAsset(motionId, `src-${String(fr.index ?? i).padStart(3, '0')}.jpg`).catch(() => null);
    if (!p || !fs.existsSync(p)) continue;
    const meta = await sharp(p).metadata();
    const b = fr.personBBox || fr.bbox;
    let img = sharp(p);
    if (b) {
      const m = 0.12 * Math.max(b[2] - b[0], b[3] - b[1]);
      const x0 = Math.max(0, Math.floor(b[0] - m)), y0 = Math.max(0, Math.floor(b[1] - m));
      const x1 = Math.min(meta.width, Math.ceil(b[2] + m)), y1 = Math.min(meta.height, Math.ceil(b[3] + m));
      img = img.extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    }
    out.push({ frame: i, buf: await img.png().toBuffer() });
  }
  if (!out.length) throw new Error('no source frames available for this motion');
  return out;
}

/** Views on white (a transparent result is flattened; Rodin gets a clean silhouette either way). */
async function view(model, prompt, images) {
  const r = await IM.generateImage({ model, prompt, images, quality: 'high' });
  const buf = await sharp(r.buffer).flatten({ background: '#ffffff' }).png().toBuffer();
  return { buf, cost: r.cost || 0, model: r.model };
}

async function download(url, to) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

async function run(job, opts) {
  const set = (patch) => { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); save(job); };
  try {
    let front, back;
    if (opts.views) {
      // approved views (checked beforehand): the 3D model is built from exactly those
      front = { buf: await sharp(opts.views.front).flatten({ background: '#ffffff' }).png().toBuffer(), cost: 0 };
      back = { buf: await sharp(opts.views.back).flatten({ background: '#ffffff' }).png().toBuffer(), cost: 0 };
      fs.writeFileSync(path.join(jobDir(job.id), 'front.png'), front.buf);
      fs.writeFileSync(path.join(jobDir(job.id), 'back.png'), back.buf);
      set({ files: ['front.png', 'back.png'], viewsGiven: true });
    } else {
      set({ status: 'references' });
      const refs = await referenceCrops(opts.motionId, opts.frames);
      refs.forEach((r, k) => fs.writeFileSync(path.join(jobDir(job.id), `ref-${k}.png`), r.buf));
      set({ refs: refs.map((r, k) => ({ frame: r.frame, file: `ref-${k}.png` })) });

      set({ status: 'front view' });
      front = await view(opts.imageModel, frontPrompt(opts.outfit), refs.map((r) => r.buf));
      fs.writeFileSync(path.join(jobDir(job.id), 'front.png'), front.buf);
      job.cost.images += front.cost;
      set({ files: [...job.files, 'front.png'] });

      set({ status: 'back view' });
      back = await view(opts.imageModel, backPrompt(opts.outfit), [front.buf, ...refs.map((r) => r.buf)]);
      fs.writeFileSync(path.join(jobDir(job.id), 'back.png'), back.buf);
      job.cost.images += back.cost;
      set({ files: [...job.files, 'back.png'] });
    }
    if (opts.viewsOnly) return set({ status: 'done' });
    set({ status: '3D model (Rodin, ~2–4 min)' });
    const out = await fal.run(RODIN, {
      image_urls: [fal.toDataUri(front.buf, 'image/png'), fal.toDataUri(back.buf, 'image/png')],
      prompt: 'a photorealistic human, full body, A-pose',
      tier: 'Gen-2.5-High', geometry_file_format: 'glb', material: 'PBR',
      quality_mesh_option: opts.mesh || '50K Triangle', TAPose: true,
      texture_delight: true, hd_texture: true, seed: opts.seed,
    }, { timeoutMs: 900000, pollMs: 4000 });
    job.cost.mesh += RODIN_COST;
    const url = out?.model_mesh?.url;
    if (!url) throw new Error('Rodin returned no model');
    await download(url, path.join(jobDir(job.id), 'model.glb'));
    const tex = [];
    for (const [k, t] of (out.textures || []).entries()) {
      if (!t?.url) continue;
      const name = `tex-${k}${path.extname(new URL(t.url).pathname) || '.png'}`;
      await download(t.url, path.join(jobDir(job.id), name)).then(() => tex.push(name), () => {});
    }
    set({ status: 'done', files: [...job.files, 'model.glb', ...tex], rodin: { seed: out.seed } });
  } catch (err) {
    set({ status: 'failed', error: err.message });
  }
}

/**
 * Start a job. opts: { motionId, frames: [source frame indices], outfit?,
 * imageModel?, viewsOnly?, views? ({ front, back } data URIs: skip the views step), mesh?, seed? }
 */
function start(opts) {
  if (!opts?.motionId) throw new Error('motionId is required');
  let views = null;
  if (opts.views) {
    const dec = (u) => { const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(u || '')); return m ? Buffer.from(m[2], 'base64') : null; };
    views = { front: dec(opts.views.front), back: dec(opts.views.back) };
    if (!views.front || !views.back) throw new Error('views must be { front, back } image data URIs');
  }
  const frames = (Array.isArray(opts.frames) && opts.frames.length ? opts.frames : [0]).map((v) => +v).filter((v) => Number.isInteger(v) && v >= 0).slice(0, 4);
  const avail = IM.listModels().filter((m) => m.available);
  const imageModel = opts.imageModel && avail.find((m) => m.id === opts.imageModel) ? opts.imageModel : (avail.find((m) => m.provider === 'openai') || avail[0])?.id;
  if (!imageModel) throw new Error('no image model configured (OPENAI_API_KEY or GEMINI_API_KEY)');
  if (!opts.viewsOnly && !fal.isConfigured()) throw new Error('FAL_KEY is not set');
  const id = 'cg-' + crypto.randomBytes(5).toString('hex');
  const job = {
    id, status: 'queued', motionId: opts.motionId, frames, imageModel, outfit: opts.outfit || '',
    files: [], cost: { images: 0, mesh: 0 }, createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  save(job);
  run(job, { ...opts, views, frames, imageModel, outfit: String(opts.outfit || '').slice(0, 300), seed: Number.isInteger(opts.seed) ? opts.seed : undefined });
  return job;
}

module.exports = { start, getJob, filePath, frontPrompt, backPrompt };
