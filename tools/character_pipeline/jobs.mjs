/**
 * Persistent jobs (assets/characters/_jobs/<job>.json). The server creates a record and starts the
 * CLI with `--job <id>`; the CLI updates its own record (running → done / failed) with its pid,
 * the stage it is on and the credits it spent. Records survive restarts: a "running" record whose
 * process is gone reads as `interrupted`.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { CHAR_DIR, ROOT } from './config.mjs';

export const JOBS_DIR = path.join(CHAR_DIR, '_jobs');
export const OPS = ['build', 'resume', 'generate', 'assemble', 'gamemesh', 'rig', 'import', 'lods', 'validate', 'preview', 'courttest'];
const file = (id) => path.join(JOBS_DIR, `${id}.json`);
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function readJob(id) {
  if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(file(id))) return null;
  const j = JSON.parse(fs.readFileSync(file(id), 'utf8'));
  if (j.status === 'running' && !alive(j.pid)) j.status = 'interrupted';
  if (j.startedAt) j.durationSec = Math.round(((j.endedAt ? Date.parse(j.endedAt) : Date.now()) - Date.parse(j.startedAt)) / 1000);
  return j;
}
export function writeJob(j) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(file(j.id) + '.tmp', JSON.stringify(j, null, 1));
  fs.renameSync(file(j.id) + '.tmp', file(j.id));
  return j;
}
export function updateJob(id, patch) { const j = readJob(id); if (!j) return null; return writeJob({ ...j, ...patch, status: patch.status || (j.status === 'interrupted' ? 'running' : j.status) }); }
export function listJobs({ character } = {}) {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json')).map((f) => readJob(f.slice(0, -5))).filter((j) => j && (!character || j.character === character))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
export const activeJob = (character) => listJobs({ character }).find((j) => j.status === 'running' || j.status === 'queued');

/** Creates the record and starts the CLI detached (argv only, no shell). */
export function startJob({ character, op, part, stage }) {
  if (!OPS.includes(op)) throw new Error('unknown operation ' + op);
  if (!/^[a-z0-9_-]{2,40}$/.test(character)) throw new Error('bad character id');
  if (part && !/^(body|head|hand_left|hand_right|hair|shoes|clothing|accessory)(,(body|head|hand_left|hand_right|hair|shoes|clothing|accessory))*$/.test(part)) throw new Error('bad part');
  const busy = activeJob(character);
  if (busy) { const e = new Error(`${character} already has a ${busy.op} job running (${busy.id})`); e.status = 409; throw e; }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const logDir = path.join(CHAR_DIR, character, 'logs'); fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `job-${id}.log`);
  // the CLI command for each operation
  const args = { build: ['resume', character], resume: ['resume', character], generate: ['rebuild', character, '--stage', 'generate', '--only', ...(part ? ['--part', part] : [])],
    assemble: ['rebuild', character, '--stage', 'assemble', '--only'], gamemesh: ['rebuild', character, '--stage', 'gamemesh', '--only'], rig: ['rebuild', character, '--stage', 'rig', '--only'],
    import: ['rebuild', character, '--stage', 'import', '--only'], lods: ['rebuild', character, '--stage', 'lods', '--only'], validate: ['validate', character],
    preview: ['rebuild', character, '--stage', 'preview', '--only'], courttest: ['rebuild', character, '--stage', 'courttest', '--only'] }[op];
  if (op === 'generate' && part) args.push('--regenerate');
  const j = writeJob({ id, character, op, part: part || null, stage: stage || null, status: 'queued', createdAt: new Date().toISOString(), log: path.relative(ROOT, log), args });
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'character_pipeline', 'cli.mjs'), ...args, '--job', id], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  return writeJob({ ...j, pid: child.pid });
}

export function cancelJob(id) {
  const j = readJob(id); if (!j) return null;
  if (j.pid && alive(j.pid)) { try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} } }
  return writeJob({ ...j, status: 'cancelled', endedAt: new Date().toISOString(), note: 'stopped locally; a Tripo task already submitted keeps running on Tripo and is billed' });
}

export function logTail(j, n = 80) {
  const f = path.join(ROOT, j.log || '');
  if (!j.log || !fs.existsSync(f)) return '';
  const s = fs.readFileSync(f, 'utf8').replace(/\r/g, '\n');
  return s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}
