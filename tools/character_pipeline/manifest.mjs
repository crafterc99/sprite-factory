/**
 * character.json: the reproducible record of a character — references (with hashes and
 * classification), generation parameters and seeds, every Tripo task, credits, stage outputs and
 * their cache keys. Written after every change so a crash or restart resumes where it stopped.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CHAR_DIR, PIPELINE_VERSION } from './config.mjs';

export const dirs = (id) => {
  const root = path.join(CHAR_DIR, id);
  const d = { root, references: path.join(root, 'references'), source: path.join(root, 'source'), tripo: path.join(root, 'source', 'tripo'), assembled: path.join(root, 'assembled'),
    game: path.join(root, 'game'), textures: path.join(root, 'textures'), rigs: path.join(root, 'rigs'), animations: path.join(root, 'animations'), previews: path.join(root, 'previews'), manifests: path.join(root, 'manifests') };
  return d;
};
export const manifestPath = (id) => path.join(dirs(id).manifests, 'character.json');

export function loadManifest(id) {
  const f = manifestPath(id);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return { id, style: 'soul-jam-illustrated', pipelineVersion: PIPELINE_VERSION, createdAt: new Date().toISOString(), heightMeters: null, quality: 'hero',
    references: [], validation: null, generation: {}, credits: { spent: 0, log: [] }, stages: {}, parts: {}, skeletonVersion: '', textureVersion: '', lods: {}, sourceFiles: [], warnings: [], errors: [] };
}
export function saveManifest(m) {
  m.updatedAt = new Date().toISOString();
  const f = manifestPath(m.id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 1));
  fs.renameSync(f + '.tmp', f);
}

export const hashOf = (...xs) => crypto.createHash('sha256').update(JSON.stringify(xs)).digest('hex').slice(0, 16);
export const fileHash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
export const rel = (id, p) => path.relative(dirs(id).root, p);
export const abs = (id, p) => path.join(dirs(id).root, p);
