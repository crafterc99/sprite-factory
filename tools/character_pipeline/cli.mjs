#!/usr/bin/env node
/**
 * Character factory — the one implementation the UI's jobs also run.
 *
 *   npm run character -- create <id> [--name "Main Guy"] [--height 1.93] [--quality hero|standard|draft]
 *   npm run character -- build <id> --refs <folder> [--quality hero] [--height 1.93]
 *   npm run character -- resume <id>
 *   npm run character -- generate <id> --part head            (regenerate one part: new seeds, new task)
 *   npm run character -- generate <id> --part hand_left,hand_right
 *   npm run character -- rebuild <id> --stage <stage> [--only]
 *   npm run character -- status <id>
 *   npm run character -- validate <id> [--refs <folder>]
 *   npm run character -- preview <id>
 *   npm run character -- court-test <id>
 *
 * Stages: ingest → validate → generate → assemble → gamemesh → rig → import → lods → preview → courttest
 */
import fs from 'fs';
import path from 'path';
import { loadManifest, saveManifest, manifestPath, dirs } from './manifest.mjs';
import { computeState, STAGES } from './state.mjs';
import { updateJob } from './jobs.mjs';
import { RIGS_DIR } from './config.mjs';
import * as S from './stages.mjs';

const ORDER = STAGES;
const argv = process.argv.slice(2);
let cmd = argv[0]; const id = argv[1];
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const JOB = opt('job');

if (!cmd || !id || !/^[a-z0-9_-]{2,40}$/.test(id)) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 17).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(cmd ? 2 : 0);
}
const m = loadManifest(id);
if (opt('quality')) m.quality = opt('quality');
if (opt('height')) m.heightMeters = +opt('height');
if (opt('name')) m.name = opt('name');
m.name ||= id;
if (cmd !== 'status') saveManifest(m);        // status is read-only (safe while a stage runs)

// one pipeline process per character
const lock = path.join(dirs(id).root, '.lock');
const readOnly = ['status'].includes(cmd);
if (!readOnly) {
  if (fs.existsSync(lock)) {
    const pid = +fs.readFileSync(lock, 'utf8');
    let alive = false; try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive && pid !== process.pid) { console.error(`[character] ${id} is locked by process ${pid} (another job is running)`); if (JOB) updateJob(JOB, { status: 'failed', error: 'another job is running for this character', endedAt: new Date().toISOString() }); process.exit(3); }
  }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => { try { if (+fs.readFileSync(lock, 'utf8') === process.pid) fs.unlinkSync(lock); } catch {} });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (JOB) updateJob(JOB, { status: 'cancelled', endedAt: new Date().toISOString() }); process.exit(130); });
}
const credits0 = m.credits.spent;
if (JOB) updateJob(JOB, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });

function snapshotVersion(note) {
  const rid = S.rigIdOf(id), src = path.join(RIGS_DIR, `${rid}.json.gz`);
  if (!fs.existsSync(src)) return;
  m.versions ||= [];
  const v = m.versions.length + 1, dir = path.join(dirs(id).root, 'versions', `v${v}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, `${rid}.json.gz`));
  fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify(m, null, 1));
  m.versions.push({ v, at: new Date().toISOString(), note, sources: Object.fromEntries(Object.entries(m.generation).map(([p, g]) => [p, g.task?.id])), triangles: m.stages.import?.reports?.[0]?.triangles });
}

async function run(from, to = ORDER.at(-1), { force = false } = {}) {
  for (const st of ORDER.slice(ORDER.indexOf(from), ORDER.indexOf(to) + 1)) {
    const fn = S[st];
    if (!fn) continue;
    if (JOB) updateJob(JOB, { stage: st, step: st });
    const t0 = Date.now();
    m.stages[st] = { ...(m.stages[st] || {}), status: 'running', startedAt: new Date().toISOString() };
    saveManifest(m);
    try {
      await fn(m, { refsDir: opt('refs'), only: opt('part') ? String(opt('part')).split(',') : undefined, force: force && st === from });
      m.stages[st] = { ...(m.stages[st] || {}), status: 'done', error: null, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
      if (st === 'import') snapshotVersion(opt('note') || (cmd === 'generate' ? `regenerated ${opt('part')}` : 'build'));
      saveManifest(m);
    } catch (e) {
      if (e.blocked) {
        m.stages[st] = { ...(m.stages[st] || {}), status: 'blocked', error: null, reason: e.message, action: e.action, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
        saveManifest(m);
        console.log(`[character] ${st}: BLOCKED — ${e.message}\n  to unblock: ${e.action}`);
        continue;
      }
      m.stages[st] = { ...(m.stages[st] || {}), status: 'failed', error: e.message, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
      m.errors.push({ stage: st, part: opt('part') || null, error: e.message, creditsSpentInJob: +(m.credits.spent - credits0).toFixed(2), at: new Date().toISOString() });
      saveManifest(m);
      if (JOB) updateJob(JOB, { status: 'failed', error: `${st}: ${e.message}`, endedAt: new Date().toISOString(), credits: +(m.credits.spent - credits0).toFixed(2) });
      console.error(`\n[character] ${st} FAILED: ${e.message}\n  manifest: ${manifestPath(id)}\n  fix, then: npm run character -- resume ${id}`);
      process.exit(1);
    }
  }
}

const firstOpen = () => { const s = computeState(m).stages; return ORDER.find((x) => s[x].status !== 'done') || null; };
if (cmd === 'court-test') cmd = 'courttest';
if (cmd === 'create') { m.createdAt ||= new Date().toISOString(); saveManifest(m); console.log(`[character] ${id} created: ${manifestPath(id)}`); }
else if (cmd === 'build') await run('ingest', opt('to') || undefined);
else if (cmd === 'resume') { const f = firstOpen(); if (f) await run(f, opt('to') || undefined); else console.log('[character] everything is up to date'); }
else if (cmd === 'generate' || (cmd === 'rebuild' && opt('regenerate'))) {
  // regenerate parts: new task (new seeds unless --keep-seeds); downstream stages turn stale
  const parts = String(opt('part') || '').split(',').filter(Boolean);
  for (const p of parts) if (m.generation[p]) { const g = m.generation[p]; g.key = 'regenerate'; if (!opt('keep-seeds')) g.seeds = null; }
  saveManifest(m);
  await run('generate', 'generate', { force: true });
  if (!opt('only')) { const f = firstOpen(); if (f && f !== 'generate') await run(f, opt('to') || undefined); }
} else if (cmd === 'rebuild') {
  const st = opt('stage'); if (!ORDER.includes(st)) { console.error('--stage one of: ' + ORDER.join(', ')); process.exit(2); }
  await run(st, opt('to') || (opt('only') ? st : undefined), { force: true });
} else if (cmd === 'validate') await run('ingest', 'validate');
else if (cmd === 'preview' || cmd === 'courttest') await run(cmd, cmd, { force: true });
else if (cmd === 'status') {
  const st = computeState(m);
  console.log(`${id} (${m.name})  ${typeof st.pipeline === 'string' ? st.pipeline : ''}  quality ${m.quality}  credits spent ${m.credits.spent}`);
  for (const s of ORDER) console.log(`  ${s.padEnd(10)} ${st.stages[s].status.padEnd(9)} ${st.stages[s].reason || st.stages[s].error || ''}`.slice(0, 200));
  for (const [p, v] of Object.entries(st.parts)) console.log(`  gen ${p.padEnd(11)} ${v.status.padEnd(9)} ${m.generation[p]?.task?.id || ''} ${v.credits != null ? v.credits + ' cr' : ''}`);
  if (m.validation?.warnings?.length) console.log('  warnings:\n    ' + m.validation.warnings.join('\n    '));
} else { console.error('unknown command ' + cmd); process.exit(2); }

if (JOB) updateJob(JOB, { status: 'done', endedAt: new Date().toISOString(), credits: +(m.credits.spent - credits0).toFixed(2) });
