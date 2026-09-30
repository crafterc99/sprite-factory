/**
 * Pipeline stages. Each stage reads the manifest, checks its cache key (its inputs' hashes +
 * parameters + pipeline version) and returns at once when the key matches a finished run, so a
 * rebuild only redoes what changed. Expensive Tripo work is keyed per part, and a task that was
 * created but not finished is resumed (polled), never re-created.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { ROOT, TRIPO, LIMITS, QUALITY, PARTS, VIEWS, BLENDER, PIPELINE_VERSION, RIGS_DIR, RIG } from './config.mjs';
import { dirs, saveManifest, hashOf, fileHash, rel, abs } from './manifest.mjs';
import { classify, handSides, cleanCrop, validate as validateRefs, skinTone, listImages, sha256 } from './refs.mjs';
import { TripoClient, TripoError } from './tripo-client.mjs';

const say = (...m) => console.log('[character]', ...m);
const ensure = (d) => (fs.mkdirSync(d, { recursive: true }), d);

// ═══ 1. ingest: originals kept, each image classified, cleaned per part / view ═══
export async function ingest(m, { refsDir } = {}) {
  const D = dirs(m.id);
  const src = refsDir ? path.resolve(refsDir) : path.join(D.references, '_original');
  const hasLocal = Object.values(m.generation || {}).some((g) => g.local);
  if ((!fs.existsSync(src) || !listImages(src).length) && hasLocal) { m.stages.ingest = { key: 'local', at: new Date().toISOString(), images: 0, references: ['no reference images: local models are the masters'] }; saveManifest(m); say('ingest: no references — local models are the masters'); return; }
  if (!fs.existsSync(src)) throw new Error(`references not found: ${src}`);
  const overridesFile = [path.join(src, 'overrides.json'), path.join(D.references, 'overrides.json')].find((f) => fs.existsSync(f));
  const overrides = overridesFile ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};
  const imgs = listImages(src);
  if (!imgs.length) throw new Error(`no images in ${src}`);
  const key = hashOf('ingest', PIPELINE_VERSION, imgs.map((f) => sha256(fs.readFileSync(f))), overrides);
  if (m.stages.ingest?.key === key && m.references.length) { say('ingest: unchanged'); return; }
  ensure(path.join(D.references, '_original'));
  const refs = [];
  for (const f of imgs) {
    const buf = fs.readFileSync(f), hash = sha256(buf);
    const orig = path.join(D.references, '_original', path.basename(f));
    if (path.resolve(f) !== path.resolve(orig)) fs.copyFileSync(f, orig);
    const ov = overrides[path.basename(f)] || {};
    const cl = await classify(orig, ov);
    const base = { name: path.basename(f), original: rel(m.id, orig), sha256: hash, width: cl.width, height: cl.height, source: cl.source, confidence: cl.confidence, notes: cl.notes, bgSpread: cl.bgSpread, skinShare: cl.skinShare, ...(cl.armsTouching != null ? { armsTouching: cl.armsTouching } : {}) };
    const emit = async (part, view, box) => {
      const out = path.join(D.references, part, `${view.replace('/', '-')}${refs.filter((r) => r.part === part && r.view === view).length ? '-' + refs.length : ''}.png`);
      const c = await cleanCrop(orig, cl, box, out);
      refs.push({ ...base, part, view, box, cleaned: rel(m.id, out), cleanedSha256: fileHash(out), cropWidth: c.sourceWidth, cropHeight: c.sourceHeight, upscaled: c.upscaled, skinTone: await skinTone(out) });
    };
    if (cl.part === 'hands') { const s = handSides(cl); await emit('hand_left', cl.view, s.hand_left); await emit('hand_right', cl.view, s.hand_right); refs.at(-1).notes = [...cl.notes, 'split from a two-hand sheet (image left = right hand for a back view, fingers down)']; refs.at(-2).notes = refs.at(-1).notes; }
    else if (cl.part === 'hand') await emit(ov.side || 'hand_right', cl.view, cl.boxes[0]);
    else await emit(cl.part, cl.view, cl.boxes[0] || { x0: 0, y0: 0, x1: 1, y1: 1 });
  }
  m.references = refs;
  m.sourceFiles = refs.map((r) => r.original).filter((v, i, a) => a.indexOf(v) === i);
  m.stages.ingest = { key, at: new Date().toISOString(), images: imgs.length, references: refs.map((r) => `${r.part}/${r.view} ← ${r.name} (${r.source}, ${r.confidence})`) };
  saveManifest(m);
  say('ingest:', m.stages.ingest.references.join('; '));
}

// ═══ 2. validate (before any credits) ═══
export function validate(m) {
  const local = Object.entries(m.generation || {}).filter(([, g]) => g.local).map(([p]) => p);
  const v = validateRefs(m.references, { localParts: local });
  m.validation = { ...v, at: new Date().toISOString() };
  saveManifest(m);
  for (const w of v.warnings) say('warning:', w);
  for (const b of v.blocking) say('BLOCKING:', b);
  if (!v.ok) throw new Error('references cannot be generated: ' + v.blocking.join('; '));
}

// ═══ 3. generate: one Tripo master per part (body, head, hand_left, hand_right, extras) ═══
function creditsGuard(m, what) {
  if (m.credits.spent >= LIMITS.maxCreditsPerCharacter) throw new Error(`credit limit reached for ${m.id}: ${m.credits.spent} ≥ MAX_TRIPO_CREDITS_PER_CHARACTER (${LIMITS.maxCreditsPerCharacter}); not starting ${what}`);
}
function recordCredits(m, what, taskId, n) {
  if (!n) return;
  m.credits.spent = +(m.credits.spent + n).toFixed(2);
  m.credits.log.push({ what, taskId, credits: n, at: new Date().toISOString() });
}
const seed = () => crypto.randomInt(1, 2 ** 31 - 1);

/** Runs (or resumes) one Tripo task recorded at rec; returns the finished task detail. */
async function runTask(m, rec, what, create) {
  const client = new TripoClient({ log: say });
  if (rec.task?.id && rec.task.status !== 'failed') {
    say(`${what}: resuming task ${rec.task.id} (${rec.task.status})`);
  } else {
    creditsGuard(m, what);
    const attempts = (rec.attempts || 0) + 1;
    if (attempts > LIMITS.maxRetriesPerStage + 1) throw new Error(`${what}: ${rec.attempts} attempts failed; not retrying (MAX_RETRIES_PER_STAGE=${LIMITS.maxRetriesPerStage}). Last error: ${rec.task?.error}`);
    rec.attempts = attempts;
    const id = await create(client);
    rec.task = { id, status: 'queued', createdAt: new Date().toISOString() };
    saveManifest(m);
    say(`${what}: task ${id} created`);
  }
  let last = '';
  try {
    const t = await client.waitForTask(rec.task.id, { onProgress: (x) => { const s = `${x.status} ${x.progress ?? ''}%`; if (s !== last) { last = s; process.stdout.write(`\r[character] ${what}: ${s}   `); } } });
    process.stdout.write('\n');
    const credits = t.credits_consumed ?? t.consumed_credit ?? t.credits ?? null;
    rec.task = { ...rec.task, status: 'success', type: t.type, finishedAt: new Date().toISOString(), credits, output: t.output };
    if (!rec.creditsRecorded) { recordCredits(m, what, t.task_id || rec.task.id, credits); rec.creditsRecorded = true; }
    saveManifest(m);
    return t;
  } catch (e) {
    process.stdout.write('\n');
    if (e.code !== 'timeout') { rec.task = { ...rec.task, status: 'failed', error: e.message, finishedAt: new Date().toISOString() }; saveManifest(m); }
    throw e;
  }
}

async function downloadOutputs(m, t, dir) {
  ensure(dir);
  const client = new TripoClient();
  const files = {};
  for (const { field, url } of TripoClient.outputUrls(t)) {
    const ext = path.extname(new URL(url).pathname) || (/image|preview|render/.test(field) ? '.webp' : '.glb');
    const name = field.replace(/_url$/, '').replace(/[^a-z0-9_.-]/gi, '_') + ext;
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest)) await client.download(url, dest);
    files[field] = rel(m.id, dest);
  }
  return files;
}

/** The model file of a finished generation: the PBR model when there is one. */
const modelOf = (files) => files['pbr_model'] || files['model'] || files['base_model'] || Object.values(files).find((f) => /\.(glb|fbx)$/i.test(f));

/**
 * What a part's generation would send: its views (explicit Tripo view keys), mode, parameters and
 * the cache key. Shared with state.mjs, so "is this part's source still valid?" uses the same rule.
 * Hand views: the back of the hand is Tripo's "front" (it carries the most detail), the palm its
 * "back"; thumb side / pinky side become left / right as seen with the back toward the camera.
 */
export function genPlan(m, part) {
  const refs = m.references.filter((r) => r.part === part);
  const views = {};
  for (const r of refs) {
    let v = r.view;
    if (part.startsWith('hand')) {
      const right = part === 'hand_right';
      v = { back: 'front', 'hand-back': 'front', front: 'front', palm: 'back', thumb: right ? 'left' : 'right', pinky: right ? 'right' : 'left' }[r.view] || null;
      if (!v && !views.front) v = 'front';
    }
    if (v && VIEWS.includes(v) && !views[v]) views[v] = r;
  }
  if (!views.front) { const first = Object.keys(views)[0]; if (first) { views.front = views[first]; delete views[first]; } }
  const g = m.generation[part] || {};
  // the body's front in a T-pose (made when the arms touch the body), when there is one
  if (part === 'body' && g.pose?.cleaned && views.front && g.pose.sourceSha === views.front.cleanedSha256) views.front = { ...views.front, cleaned: g.pose.cleaned, cleanedSha256: g.pose.sha, posed: true };
  const mode = Object.keys(views).length >= 2 ? 'multiview' : 'image';
  const params = { ...TRIPO.source, ...(g.seeds || {}) };
  for (const k of g.dropParams || []) delete params[k];     // parameters the API rejected earlier
  const key = hashOf('gen', TRIPO.sourceModel, mode, Object.fromEntries(Object.entries(views).map(([k, r]) => [k, r.cleanedSha256])), params);
  return { views, mode, params, key };
}
export const partsOf = (m) => [...new Set([...m.references.map((r) => r.part), ...Object.keys(m.generation || {}).filter((p) => m.generation[p]?.local)])].filter((p) => p !== 'unknown');

/** Arms touching the body → a T-pose version of the body's front reference (Tripo image-to-image). */
async function posePrep(m) {
  const D = dirs(m.id);
  const front = m.references.find((r) => r.part === 'body' && r.view === 'front');
  if (!front?.armsTouching || process.env.CF_POSE_PREP === 'off') return;
  const g = (m.generation.body ||= {});
  if (g.pose?.sourceSha === front.cleanedSha256 && g.pose.cleaned && fs.existsSync(abs(m.id, g.pose.cleaned))) return;
  const rec = (g.poseTask ||= {});
  if (rec.sourceSha !== front.cleanedSha256) { g.poseTask = { sourceSha: front.cleanedSha256 }; }
  say('pose: the body reference has the arms against the body — making a T-pose version first');
  const t = await runTask(m, g.poseTask, 'T-pose reference', async (c) => c.createImageToImage(await c.uploadFile(abs(m.id, front.cleaned)), { template: 't_pose' }));
  const u = TripoClient.outputUrls(t).find((x) => /\.(png|jpe?g|webp)(\?|$)/i.test(x.url)) || TripoClient.outputUrls(t)[0];
  const dest = path.join(D.references, 'body', 'pose', `front-tpose-${(t.task_id || g.poseTask.task.id).slice(0, 8)}.png`);
  await new TripoClient().download(u.url, dest);
  g.pose = { cleaned: rel(m.id, dest), sha: fileHash(dest), sourceSha: front.cleanedSha256, task: g.poseTask.task.id, template: 't_pose' };
  saveManifest(m);
}

async function generatePart(m, part) {
  const D = dirs(m.id);
  const g = (m.generation[part] ||= {});
  if (g.local && g.task?.status === 'success') { say(`generate ${part}: local model ${g.local.file} (not regenerated)`); return; }
  g.seeds ||= { model_seed: seed(), texture_seed: seed() };
  if (part === 'body') await posePrep(m);
  for (let round = 0; round < 3; round++) {
    const { views, mode, params, key } = genPlan(m, part);
    if (!views.front) { say(`generate ${part}: no usable view`); return; }
    if (g.key === key && g.task?.status === 'success' && g.files && fs.existsSync(abs(m.id, modelOf(g.files)))) { say(`generate ${part}: cached (${g.task.id})`); return; }
    if (g.key && g.key !== key) {
      if (g.task?.status === 'success') (g.history ||= []).push({ task: g.task.id, files: g.files, sourceHigh: g.sourceHigh, seeds: g.params && { model_seed: g.params.model_seed, texture_seed: g.params.texture_seed }, credits: g.task.credits, at: g.task.finishedAt });
      say(`generate ${part}: inputs changed — new task`); g.task = null; g.attempts = 0; g.creditsRecorded = false; g.files = null; g.sourceHigh = null;
    }
    g.key = key; g.mode = mode; g.model = TRIPO.sourceModel; g.params = params; g.views = Object.fromEntries(Object.entries(views).map(([k, r]) => [k, r.cleaned]));
    say(`generate ${part}: ${mode === 'multiview' ? 'multiview-to-model (' + Object.keys(views).join(', ') + ')' : 'image-to-model'} · ${TRIPO.sourceModel} · geometry ${params.geometry_quality} · texture ${params.texture_quality} · seeds ${params.model_seed}/${params.texture_seed} · spent so far ${m.credits.spent} of ${LIMITS.maxCreditsPerCharacter} credits`);
    saveManifest(m);
    let t;
    try {
      t = await runTask(m, g, `generate ${part}`, async (c) => {
        g.phase = 'uploading'; saveManifest(m);
        const tok = {}; for (const [v, r] of Object.entries(views)) tok[v] = await c.uploadFile(abs(m.id, r.cleaned));
        g.fileTokens = tok; g.phase = 'generating';
        return mode === 'multiview' ? c.createMultiviewModel(tok, params) : c.createImageModel(tok.front, params);
      });
    } catch (e) {
      // an unrecognised optional parameter: dropped once (recorded), then the part is retried
      const bad = /param|invalid|1004/i.test(e.message) && ['texture_version', 'export_uv'].find((q) => e.message.includes(q) && params[q] != null);
      if (bad && !(g.dropParams || []).includes(bad)) { say(`generate ${part}: the API rejected ${bad} (${e.message}); retrying without it`); (g.dropParams ||= []).push(bad); g.task = null; g.key = null; g.attempts = 0; saveManifest(m); continue; }
      g.phase = 'failed'; saveManifest(m);
      throw new Error(`${part}: ${e.message}`);
    }
    g.phase = 'downloading'; saveManifest(m);
    g.files = await downloadOutputs(m, t, path.join(D.tripo, part, g.task.id));
    g.sourceHigh = modelOf(g.files);
    g.phase = 'completed';
    saveManifest(m);
    say(`generate ${part}: done → ${g.sourceHigh} (${g.task.credits ?? '?'} credits)`);
    return;
  }
}

/** All parts (or `only`), TRIPO_CONCURRENCY at a time; one part failing doesn't stop the others. */
export async function generate(m, { only } = {}) {
  const parts = partsOf(m).filter((p) => !only || only.includes(p));
  const conc = Math.max(1, +(process.env.TRIPO_CONCURRENCY || 3));
  const queue = parts.slice(), errors = [];
  for (const p of queue) { const g = (m.generation[p] ||= {}); if (g.task?.status !== 'success') g.phase = 'queued'; }
  saveManifest(m);
  await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, async () => {
    while (queue.length) { const p = queue.shift(); try { await generatePart(m, p); } catch (e) { errors.push(e.message); say('FAILED', e.message); } }
  }));
  if (errors.length) throw new Error(errors.join(' | '));
}

// helpers for the local stages
const stageKey = (m, st, ...xs) => hashOf(st, PIPELINE_VERSION, ...xs);
const statKey = (f) => { const s = fs.statSync(f); return `${path.basename(f)}:${s.size}:${Math.round(s.mtimeMs)}`; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const rigIdOf = (id) => id.replace(/_/g, '-').toLowerCase();
const Q = (m) => QUALITY[m.quality] || QUALITY.hero;
function cached(m, st, key, outputs) {
  const s = m.stages[st];
  return s?.key === key && s.status === 'done' && outputs.every((f) => fs.existsSync(f));
}

// ═══ 4. assemble (Blender): body + head / hand donors → SOURCE_HIGH ═══
export async function assemble(m, { force } = {}) {
  const D = dirs(m.id), g = m.generation;
  if (!g.body?.sourceHigh) throw new Error('no body master yet (run generate)');
  const inp = Object.fromEntries(['body', 'head', 'hand_left', 'hand_right'].filter((p) => g[p]?.sourceHigh).map((p) => [p, abs(m.id, g[p].sourceHigh)]));
  const out = { out_blend: path.join(D.assembled, 'high.blend'), out_glb: path.join(D.assembled, 'high.glb'), report: path.join(D.assembled, 'assemble-report.json') };
  const key = stageKey(m, 'assemble', Object.values(inp).map(statKey), m.heightMeters);
  if (!force && cached(m, 'assemble', key, Object.values(out))) { say('assemble: cached'); return; }
  say('assemble: aligning', Object.keys(inp).join(', '));
  blender('assemble.py', { ...inp, height: m.heightMeters || 1.93, forward: '+x', ...out }, { log: path.join(ensure(path.join(D.root, 'logs')), 'assemble.log') });
  const rep = readJson(out.report);
  m.stages.assemble = { key, at: new Date().toISOString(), outputs: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, rel(m.id, v)])), report: rep };
  m.parts = { ...m.parts, sourceHigh: rep.triangles };
  for (const w of rep.warnings) say('warning:', w);
  saveManifest(m);
}

// ═══ 5. gamemesh (Blender): welded game surface + bake ═══
export async function gamemesh(m, { force } = {}) {
  const D = dirs(m.id), q = Q(m);
  const blend = abs(m.id, m.stages.assemble?.outputs?.out_blend || 'assembled/high.blend');
  const out = { out_glb: path.join(D.game, 'lod0.glb'), out_blend: path.join(D.game, 'game.blend'), report: path.join(D.game, 'gamemesh-report.json') };
  const key = stageKey(m, 'gamemesh', m.stages.assemble?.key, q.lods[0].tris, q.bakeSize);
  if (!force && cached(m, 'gamemesh', key, Object.values(out))) { say('gamemesh: cached'); return; }
  say(`gamemesh: ${q.lods[0].tris} tris, ${q.bakeSize}px bake`);
  blender('gamemesh.py', { blend, assemble_report: abs(m.id, m.stages.assemble?.outputs?.report || 'assembled/assemble-report.json'), tris: q.lods[0].tris, bake_size: q.bakeSize, tex_dir: D.textures, ...out }, { log: path.join(D.root, 'logs', 'gamemesh.log') });
  const rep = readJson(out.report);
  m.stages.gamemesh = { key, at: new Date().toISOString(), outputs: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, rel(m.id, v)])), report: rep };
  m.textureVersion = `bake-${q.bakeSize}-${key.slice(0, 8)}`;
  saveManifest(m);
}

// ═══ 6a. rig (MHR mode): the game's MHR body fitted to the mesh → skeleton + MHR weights ═══
function py(script, args, log) {
  if (!fs.existsSync(RIG.python)) throw new Blocked('the MHR rig needs its Python env and model files', 'run: bash tools/character_pipeline/mhr/setup.sh');
  const r = spawnSync(RIG.python, [path.join(ROOT, 'tools', 'character_pipeline', 'mhr', script), ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (log) fs.appendFileSync(log, `\n$ ${script} ${args.join(' ')}\n${out}`);
  if (r.status !== 0) throw new Error(`${script} failed: ${out.split('\n').filter((l) => /Error|Traceback|assert/i.test(l)).slice(-6).join(' | ') || out.slice(-600)}`);
  return out;
}
/** The mesh the rig is built on: a supplied finished model, or the pipeline's game mesh. */
const rigInput = (m) => (m.mode === 'model' ? abs(m.id, m.model.file) : abs(m.id, m.stages.gamemesh?.outputs?.out_glb || 'game/lod0.glb'));

async function rigMhr(m, { force } = {}) {
  const D = dirs(m.id), rid = rigIdOf(m.id), q = Q(m);
  const input = rigInput(m);
  if (!fs.existsSync(input)) throw new Error(`no mesh to rig (${path.relative(D.root, input)})`);
  const W = ensure(path.join(D.rigs, 'mhr')), log = path.join(ensure(path.join(D.root, 'logs')), 'rig-mhr.log');
  const scripts = ['fit_mhr.py', 'build_rig.py', 'glb_load.py'].map((f) => fileHash(path.join(ROOT, 'tools', 'character_pipeline', 'mhr', f)));
  // a finished model arrives at its tool's unit scale (Tripo: ~1 unit tall), so it is scaled to the
  // character's height here; pipeline meshes were already scaled by the assemble stage
  const height = m.mode === 'model' ? (m.heightMeters || 1.93) : null;
  const key = stageKey(m, 'rig-mhr', statKey(input), scripts, RIG.fitArgs, RIG.bind, m.material || null, m.mode === 'model' ? 'model' : q.lods.map((l) => l.tris), height);
  const r = (m.stages.rig ||= {});
  if (!force && r.key === key && fs.existsSync(path.join(RIGS_DIR, `${rid}.json.gz`))) { say('rig (MHR): cached'); return; }
  const exp = path.join(W, 'export'), fitDir = path.join(W, 'fit');
  // 1. mesh → arrays + its own textures (nothing re-baked)
  const expKey = hashOf(statKey(input), height);
  if (r.exportKey !== expKey || !fs.existsSync(path.join(exp, 'mesh.npz'))) { fs.rmSync(exp, { recursive: true, force: true }); py('glb_load.py', [input, exp, ...(height ? ['--height', String(height)] : [])], log); r.exportKey = expKey; }
  const scale = readJson(path.join(exp, 'mesh.json')).scale || 1;
  // 2. fit MHR (shape + bone scales + pose incl. fingers) — cached per mesh
  const fitKey = hashOf(expKey, scripts[0], RIG.fitArgs);
  if (r.fitKey !== fitKey || !fs.existsSync(path.join(fitDir, 'fit.npz'))) {
    say('rig (MHR): fitting the MHR body to the mesh (~6 min)');
    py('fit_mhr.py', [exp, fitDir, ...RIG.fitArgs, '--no-plots'], log); r.fitKey = fitKey; saveManifest(m);
  }
  const fit = readJson(path.join(fitDir, 'fit.json'));
  say(`rig (MHR): fit chamfer ${fit.chamferCm} cm (hands ${fit.meshToBodyCm?.hands} cm, head ${fit.meshToBodyCm?.head} cm)`);
  // 3. the game rig: MHR skeleton + MHR weights, bound in MHR's rest pose; the model's textures as is
  // a finished model keeps its own look (plain PBR, as in Tripo); pipeline characters get the
  // illustrated Soul Jam material; either can be overridden per character (m.material)
  const mat = m.material ? { preset: m.mode === 'model' ? 'pbr' : 'souljam-illustrated', ...m.material } : m.mode === 'model' ? { preset: 'pbr' } : null;
  const common = ['--id', rid, '--name', m.name || m.id, '--bind', RIG.bind, ...(mat ? ['--material', JSON.stringify(mat)] : [])];
  py('build_rig.py', [exp, fitDir, ...common, '--register'], log);
  const build0 = readJson(path.join(fitDir, `build-${rid}.json`));
  // 4. LODs from the same mesh (UVs + textures kept), bound to the same fit
  const src = build0.triangles;
  const ladder = m.mode === 'model'
    ? [0.5, 0.25, 0.1].map((f, i) => ({ tris: Math.round(src * f), dist: [9, 18, 32][i] })).filter((l) => l.tris >= 2500)
    : q.lods.slice(1).filter((l) => l.tris < src);
  const lodsOut = [{ lod: 0, triangles: src, dist: 0 }];
  if (ladder.length) {
    const lodDir = path.join(W, 'lods'), rep = path.join(lodDir, 'lods.json');
    blender('lods.py', { input, ratios: ladder.map((l) => l.tris / src), out_dir: lodDir, report: rep }, { log: path.join(D.root, 'logs', 'lods.log') });
    for (const l of readJson(rep).lods) {
      const le = path.join(lodDir, `export${l.lod}`);
      fs.rmSync(le, { recursive: true, force: true });
      py('glb_load.py', [l.file, le, '--scale', String(scale)], log);
      py('build_rig.py', [le, fitDir, ...common, '--lod', String(l.lod), '--lod-dist', String(ladder[l.lod - 1].dist)], log);
      lodsOut.push({ lod: l.lod, triangles: l.triangles, dist: ladder[l.lod - 1].dist });
    }
  }
  Object.assign(r, { key, mode: 'mhr', at: new Date().toISOString(), report: { fit, build: build0, lods: lodsOut } });
  m.lods = Object.fromEntries(lodsOut.map((l) => [`lod${l.lod}`, { triangles: l.triangles, dist: l.dist, file: null }]));
  m.skeletonVersion = 'SOUL_JAM_MASTER_SKELETON (MHR 127 joints) — MHR body fitted to the mesh';
  // the import stage's work (the game rig) is done here
  m.stages.import = { key, status: 'done', mode: 'mhr', at: new Date().toISOString(), finishedAt: new Date().toISOString(), rigId: rid, output: path.relative(ROOT, path.join(RIGS_DIR, `${rid}.json.gz`)), reports: [build0], warnings: [] };
  saveManifest(m);
  say(`rig (MHR): ${rid} — ${src} tris, ${lodsOut.length} LOD${lodsOut.length > 1 ? 's' : ''}, weights from the fitted MHR body (${build0.verticesOnTwoFingersAfter} vertices on two fingers)`);
}

// ═══ 6b. rig (Tripo mode): Tripo rig-check + rig (Mixamo spec) on the game mesh, merged back + LOD chain ═══
export async function rig(m, opts = {}) {
  if (RIG.mode === 'mhr' || m.mode === 'model') return rigMhr(m, opts);
  return rigTripo(m, opts);
}
async function rigTripo(m, { force } = {}) {
  const D = dirs(m.id), q = Q(m);
  const game = abs(m.id, m.stages.gamemesh?.outputs?.out_glb || 'game/lod0.glb');
  if (!fs.existsSync(game)) throw new Error('no game mesh yet (run gamemesh)');
  const r = (m.stages.rig ||= {});
  const key = stageKey(m, 'rig', statKey(game), q.lods.map((l) => l.tris), TRIPO.rigModel, TRIPO.fingerRigModel, fileHash(path.join(ROOT, 'tools', 'character_pipeline', 'blender', 'rigmerge.py')));
  const tk = stageKey(m, 'tripo-rig', statKey(game), TRIPO.rigSpec, TRIPO.rigOutFormat, TRIPO.rigModel, TRIPO.fingerRigModel);
  if (r.tripoKey !== tk) {
    for (const k of ['rigTask', 'fingerTask', 'convertTask']) if (r[k]?.task) (r.history ||= []).push({ step: k, task: r[k].task.id, status: r[k].task.status, credits: r[k].task.credits, key: r.tripoKey });
    r.check = {}; r.rigTask = {}; r.fingerTask = {}; r.convertTask = {}; r.tripoKey = tk; r.fileToken = null;
  }
  const rigFile = path.join(D.rigs, 'tripo_rig.glb'), fingerFile = path.join(D.rigs, 'tripo_fingers.glb');
  // (the rig files must belong to this game mesh: a stale pair from an earlier mesh is never reused)
  if (!fs.existsSync(rigFile) || (TRIPO.fingerRigModel && !fs.existsSync(fingerFile)) || r.filesKey !== tk || force === 'tripo') {
    const client = new TripoClient({ log: say });
    if (!r.fileToken || !r.check?.task?.id) { r.fileToken = await client.uploadFile(game); saveManifest(m); }
    const chk = await runTask(m, (r.check ||= {}), 'rig-check', (c) => c.rigCheck(r.fileToken));
    const out = chk.output || {};
    r.riggable = out.riggable; r.rigType = out.rig_type || 'biped';
    if (out.riggable === false) throw new Error('Tripo rig-check: the game mesh is not riggable');
    say(`rig-check: riggable, ${r.rigType}. rigging: Mixamo body (${TRIPO.rigModel})${TRIPO.fingerRigModel ? ` + fingers (${TRIPO.fingerRigModel})` : ''}`);
    const get = async (rec, what, model, dest) => {
      const t = await runTask(m, (r[rec] ||= {}), what, (c) => c.rig(r.fileToken, { rig_type: r.rigType, spec: TRIPO.rigSpec, out_format: TRIPO.rigOutFormat, model }));
      const files = await downloadOutputs(m, t, path.join(D.rigs, 'tripo', (t.task_id || r[rec].task.id).slice(0, 8)));
      fs.copyFileSync(abs(m.id, Object.values(files).find((f) => /\.(glb|fbx)$/i.test(f))), dest);
      r[rec].files = files;
    };
    await get('rigTask', 'rig (Mixamo body)', TRIPO.rigModel, rigFile);
    if (TRIPO.fingerRigModel) await get('fingerTask', 'rig (fingers)', TRIPO.fingerRigModel, fingerFile);
    r.filesKey = tk; saveManifest(m);
  }
  const outDir = path.join(D.rigs, 'lods');
  const rep = path.join(D.rigs, 'rigmerge-report.json');
  if (!force && r.key === key && fs.existsSync(rep)) { say('rig: cached'); return; }
  blender('rigmerge.py', { game, rig: rigFile, finger_rig: TRIPO.fingerRigModel && fs.existsSync(fingerFile) ? fingerFile : null, lods: q.lods.map((l) => l.tris), out_dir: outDir, report: rep }, { log: path.join(D.root, 'logs', 'rigmerge.log') });
  r.key = key; r.report = readJson(rep); r.at = new Date().toISOString();
  m.lods = Object.fromEntries(r.report.lods.map((l) => [`lod${l.lod}`, { triangles: l.triangles, file: rel(m.id, l.file), dist: q.lods[l.lod].dist }]));
  saveManifest(m);
}

// ═══ 7. import onto SOUL_JAM_MASTER_SKELETON (the game's 127-joint MHR skeleton) ═══
export async function importRig(m, { force } = {}) {
  if (m.stages.rig?.mode === 'mhr') { say('import: the MHR rig stage built the game rig'); return; }
  const q = Q(m), rid = rigIdOf(m.id);
  const lods = Object.values(m.lods || {});
  if (!lods.length) throw new Error('no rigged LODs yet (run rig)');
  const key = stageKey(m, 'import', lods.map((l) => statKey(abs(m.id, l.file))), q.texSize, m.material || null, fileHash(path.join(ROOT, 'scripts', 'import-mixamo-character.mjs')));
  const out = path.join(RIGS_DIR, `${rid}.json.gz`);
  if (!force && cached(m, 'import', key, [out])) { say('import: cached'); return; }
  const reports = [];
  for (const [i, l] of lods.entries()) {
    const extra = i === 0 ? ['--tex-size', String(q.texSize), ...(m.material ? ['--material', JSON.stringify({ preset: 'souljam-illustrated', ...m.material })] : [])] : ['--lod', String(i), '--lod-dist', String(l.dist)];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'import-mixamo-character.mjs'), abs(m.id, l.file), rid, m.displayName || m.id, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error(`importer (LOD${i}) failed: ${(r.stderr || r.stdout).slice(-800)}`);
    const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    reports.push(rep);
    say(`import LOD${i}: ${rep.triangles} tris · segRatio ${JSON.stringify(rep.segRatio)} · fingers crossing ${rep.verticesOnTwoFingers}`);
  }
  const r0 = reports[0];
  const warn = [];
  for (const [k, v] of Object.entries(r0.segRatio || {})) if (v < 0.8 || v > 1.25) warn.push(`segRatio.${k} = ${v} (outside 0.8–1.25: an auto-rig joint may be misplaced; compare --proportions game)`);
  if (r0.verticesOnTwoFingers) warn.push(`${r0.verticesOnTwoFingers} vertices weighted to two fingers`);
  m.stages.import = { key, at: new Date().toISOString(), rigId: rid, output: path.relative(ROOT, out), reports, warnings: warn };
  m.skeletonVersion = 'SOUL_JAM_MASTER_SKELETON (MHR 127 joints, player.json.gz)';
  for (const w of warn) say('warning:', w);
  saveManifest(m);
}
export { importRig as import };

// ═══ 8. lods: produced by the rig stage (LOD chain) and imported with the character ═══
export async function lods(m) {
  const rid = rigIdOf(m.id);
  const zlib = await import('zlib');
  const rigJson = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RIGS_DIR, `${rid}.json.gz`))));
  const got = [{ level: 0, dist: 0, tris: rigJson.parts.reduce((a, p) => a + Buffer.from(p.faces, 'base64').length / (p.faces32 ? 12 : 6), 0) }, ...(rigJson.lods || []).map((l) => ({ level: l.level, dist: l.dist, tris: l.parts.reduce((a, p) => a + Buffer.from(p.faces, 'base64').length / (p.faces32 ? 12 : 6), 0) }))];
  m.stages.lods = { at: new Date().toISOString(), lods: got };
  say('lods:', got.map((l) => `LOD${l.level} ${l.tris} tris from ${l.dist} m`).join(' · '));
  saveManifest(m);
}

// ═══ 9. preview: court screenshots, deformation poses, source vs game comparison ═══
export async function preview(m) {
  const D = dirs(m.id), rid = rigIdOf(m.id);
  const out = ensure(D.previews);
  const render = m.generation.body?.files?.rendered_image || m.generation.body?.files?.rendered_image_url;   // (the download keys by the output field)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'character_pipeline', 'deform-test.mjs'), '--char', rid, '--out', out, ...(render ? ['--source-render', abs(m.id, render)] : [])], { encoding: 'utf8', maxBuffer: 1 << 26 });
  process.stdout.write((r.stdout || '').split('\n').filter((l) => l.startsWith('[deform]')).join('\n') + '\n');
  if (r.status !== 0) throw new Error('deformation test failed: ' + (r.stderr || r.stdout).slice(-1200));
  const rep = readJson(path.join(out, 'deformation', 'report.json'));
  m.stages.preview = { at: new Date().toISOString(), report: rep };
  saveManifest(m);
}

// ═══ 10. courttest: the game's own court check with this character ═══
/** A stage that cannot run here (missing data / credentials): recorded as blocked, not failed. */
export class Blocked extends Error { constructor(msg, action) { super(msg); this.blocked = true; this.action = action; } }

export async function courttest(m) {
  const D = dirs(m.id), rid = rigIdOf(m.id);
  const base = process.env.COURT_BASE || 'http://localhost:3456';
  const lib = await fetch(`${base}/api/mocap3d/library`, { headers: process.env.SF_PASSWORD ? { Authorization: `Bearer ${process.env.SF_PASSWORD}` } : {} }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (lib.error) throw new Blocked(`the court server at ${base} did not answer (${lib.error})`, 'start the local server (bash mac-dev.sh) and retry');
  if (!(lib.court || []).some((c) => c.role === 'idle')) throw new Blocked('the clip library on this server is empty (cloud storage not configured), so the court cannot play animations', 'add FIREBASE_SERVICE_ACCOUNT or the R2_* keys to .env and restart the server, then run court-test again');
  const out = ensure(path.join(D.previews, 'court-test'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'court3d-test.js'), '--court', 'classic', '--char', rid, '--out', out], { encoding: 'utf8', maxBuffer: 1 << 26, env: process.env });
  const text = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(D.root, 'logs', 'courttest.log'), text);
  m.stages.courttest = { at: new Date().toISOString(), passed: r.status === 0, tail: text.split('\n').slice(-25) };
  saveManifest(m);
  say(`court test: ${r.status === 0 ? 'passed' : 'FAILED'} (log: logs/courttest.log)`);
  if (r.status !== 0) throw new Error('court test failed — see logs/courttest.log');
}

// ═══ Blender runner ═══
export function blender(script, args, { log } = {}) {
  const r = spawnSync(BLENDER, ['-b', '--factory-startup', '-P', path.join(ROOT, 'tools', 'character_pipeline', 'blender', script), '--', JSON.stringify(args)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (log) fs.writeFileSync(log, out);
  const lines = out.split('\n').filter((l) => l.startsWith('[cf]'));
  for (const l of lines) console.log('   ', l.slice(5));
  if (r.status !== 0 || /Traceback|Error: Python/.test(out)) throw new Error(`blender ${script} failed (log: ${log || 'stdout'})\n` + out.split('\n').filter((l) => /Error|Traceback|File "/.test(l)).slice(-12).join('\n'));
  return out;
}

export { QUALITY, PARTS, RIGS_DIR };
