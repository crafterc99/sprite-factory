/**
 * Stage graph and derived status. Nothing here is UI state: everything is computed from the
 * persisted manifest (+ the files it points at and the job records).
 *
 *   ingest → validate → generate:<part>… → assemble → gamemesh → rig → import → lods / preview / courttest
 *
 * A stage is `done` when it finished and is newer than everything it depends on (and, for a
 * generation, its inputs still hash to the recorded key); `stale` when it finished but an input
 * changed after it; `ready` when its dependencies are done; `blocked` otherwise; `running` when a
 * job holds it; `failed` with the last error.
 */
import fs from 'fs';
import path from 'path';
import { abs, dirs } from './manifest.mjs';
import { genPlan, partsOf } from './stages.mjs';

export const STAGES = ['ingest', 'validate', 'generate', 'assemble', 'gamemesh', 'rig', 'import', 'lods', 'preview', 'courttest'];
export const DEPS = { ingest: [], validate: ['ingest'], generate: ['ingest'], assemble: ['generate'], gamemesh: ['assemble'], rig: ['gamemesh'], import: ['rig'], lods: ['import'], preview: ['import'], courttest: ['import'] };
export const LABEL = { ingest: 'References', validate: 'Validation', generate: 'Source generation', assemble: 'Assembly', gamemesh: 'Game mesh + bake', rig: 'Rig', import: 'Soul Jam skeleton', lods: 'LODs', preview: 'Animation + deformation', courttest: 'Court test' };

const t = (x) => (typeof x === 'number' ? x : x ? Date.parse(x) || 0 : 0);
const exists = (m, p) => !!p && fs.existsSync(abs(m.id, p));

/** Finish time of a stage record (stages record `at` when they produce output). */
function finishedAt(m, st) {
  const s = m.stages[st];
  if (!s || s.status !== 'done') return 0;
  return t(s.finishedAt || s.at);
}

export function partStatus(m, part, job) {
  const g = m.generation[part] || {};
  if (g.local && g.task?.status === 'success' && g.sourceHigh && exists(m, g.sourceHigh)) return { status: 'done', finishedAt: g.task.finishedAt, credits: 0, task: g.task.id, local: g.local.file };
  const refs = m.references.filter((r) => r.part === part);
  if (!refs.length) return { status: 'missing', reason: 'no references' };
  let plan; try { plan = genPlan(m, part); } catch { plan = null; }
  if (job && job.status === 'running' && (!job.part || job.part === part) && ['build', 'resume', 'generate'].includes(job.op) && g.task?.status !== 'success') return { status: 'running', phase: g.phase || 'queued', task: g.task?.id };
  if (g.task?.status === 'success' && g.sourceHigh && exists(m, g.sourceHigh)) {
    if (plan && g.key && g.key !== plan.key) return { status: 'stale', reason: 'references changed since this source was generated', finishedAt: g.task.finishedAt };
    return { status: 'done', finishedAt: g.task.finishedAt, credits: g.task.credits, task: g.task.id };
  }
  if (g.task?.status === 'failed') return { status: 'failed', error: g.task.error, attempts: g.attempts };
  if (g.task?.id && g.task.status !== 'success') return { status: 'interrupted', reason: 'a Tripo task was started and can be resumed without paying again', task: g.task.id };
  return { status: 'ready' };
}

/** pid holding the character's pipeline lock, if that process is alive */
export function lockHolder(id) {
  try {
    const pid = +fs.readFileSync(path.join(dirs(id).root, '.lock'), 'utf8');
    process.kill(pid, 0); return pid;
  } catch (e) { return e.code === 'EPERM' ? -1 : null; }
}

export function computeState(m, { job } = {}) {
  const S = {};
  const locked = lockHolder(m.id);
  const parts = partsOf(m);
  const P = Object.fromEntries(parts.map((p) => [p, partStatus(m, p, job)]));
  for (const st of STAGES) {
    const rec = m.stages[st] || {};
    const deps = DEPS[st];
    let status, reason;
    if (st === 'generate') {
      const vals = Object.values(P);
      const need = ['body'];
      if (!parts.includes('body')) { status = 'blocked'; reason = 'no body reference'; }
      else if (vals.some((v) => v.status === 'running')) status = 'running';
      else if (vals.some((v) => v.status === 'failed')) { status = 'failed'; reason = Object.entries(P).filter(([, v]) => v.status === 'failed').map(([k, v]) => `${k}: ${v.error}`).join(' | '); }
      else if (vals.length && vals.every((v) => v.status === 'done')) status = 'done';
      else if (vals.some((v) => v.status === 'stale')) { status = 'stale'; reason = 'a part\'s references changed'; }
      else if (need.every((p) => P[p]?.status === 'done') && vals.some((v) => ['ready', 'interrupted'].includes(v.status))) { status = 'partial'; reason = 'body ready; other parts not generated'; }
      else status = S.ingest?.status === 'done' ? 'ready' : 'blocked';
      const fin = Math.max(0, ...Object.values(m.generation || {}).map((g) => (g.task?.status === 'success' ? t(g.task.finishedAt) : 0)));
      S[st] = { status, reason, finishedAt: fin ? new Date(fin).toISOString() : null, parts: P };
      continue;
    }
    const depStates = deps.map((d) => S[d]);
    const depsDone = depStates.every((d) => d && ['done', 'partial'].includes(d.status));
    const depFin = Math.max(0, ...deps.map((d) => (d === 'generate' ? t(S.generate.finishedAt) : finishedAt(m, d))));
    if ((job && job.status === 'running' && job.stage === st) || (locked && rec.status === 'running')) status = 'running';
    else if (rec.status === 'failed') { status = 'failed'; reason = rec.error; }
    else if (rec.status === 'blocked' && depsDone) { status = 'blocked'; reason = rec.reason; }
    else if (rec.status === 'done') {
      const mine = finishedAt(m, st);
      if (!depsDone) { status = 'stale'; reason = `${deps.map((d) => LABEL[d]).join(', ')} not current`; }
      else if (depFin && mine && depFin > mine + 1000) { status = 'stale'; reason = `${deps.map((d) => LABEL[d]).join(', ')} changed after this ran`; }
      else status = 'done';
    } else status = depsDone ? 'ready' : 'blocked';
    if (st === 'validate' && m.validation) { S[st] = { status: m.validation.ok ? (status === 'failed' ? 'failed' : 'done') : 'failed', reason: m.validation.ok ? (m.validation.warnings.length ? `${m.validation.warnings.length} warnings` : '') : m.validation.blocking.join('; '), finishedAt: m.validation.at, warnings: m.validation.warnings.length }; continue; }
    if (st === 'ingest') { const n = m.references.length, loc = Object.values(m.generation || {}).some((g) => g.local); S[st] = { status: n || loc ? 'done' : 'ready', reason: n ? `${n} references` : loc ? 'local models are the masters' : 'add reference images', finishedAt: m.stages.ingest?.at || null }; continue; }
    S[st] = { status, reason, finishedAt: rec.finishedAt || rec.at || null, seconds: rec.seconds ?? null, error: rec.error || null, action: rec.status === 'blocked' ? rec.action || null : null };
  }
  return { stages: S, parts: P, pipeline: pipelineStatus(m, S), next: STAGES.find((s) => !['done'].includes(S[s].status)) || null };
}

/** The persisted pipeline status (never from UI state). */
export function pipelineStatus(m, S) {
  const st = (x) => S[x]?.status;
  const local = Object.values(m.generation || {}).some((g) => g.local);
  if (!m.references.length && !local) return 'DRAFT';
  const running = STAGES.find((s) => st(s) === 'running');
  if (running) return { generate: 'GENERATING_SOURCE', assemble: 'ASSEMBLING', gamemesh: 'OPTIMIZING', rig: 'RIGGING', import: 'RIGGING', lods: 'OPTIMIZING', preview: 'ANIMATION_VALIDATION', courttest: 'COURT_VALIDATION', ingest: 'REFERENCES_INCOMPLETE', validate: 'REFERENCES_INCOMPLETE' }[running];
  const firstOpen = STAGES.find((s) => !['done'].includes(st(s)));
  if (firstOpen && st(firstOpen) === 'failed') return 'FAILED';
  if (!m.references.some((r) => r.part === 'body') && !m.generation?.body?.local) return 'REFERENCES_INCOMPLETE';
  if (!firstOpen) return 'GAME_READY';
  return { validate: 'REFERENCES_INCOMPLETE', generate: 'REFERENCES_READY', assemble: 'SOURCE_READY', gamemesh: 'ASSEMBLED', rig: 'GAME_MESH_READY', import: 'RIGGED', lods: 'RIGGED', preview: 'ANIMATION_VALIDATION', courttest: 'COURT_VALIDATION' }[firstOpen] || 'REFERENCES_READY';
}
