/**
 * Character factory configuration: pipeline version, Tripo generation parameters, quality presets,
 * cost limits. Everything that decides whether a cached result can be reused is hashed from here.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PIPELINE_VERSION = 'cf-2026-09-29a';
export const CHAR_DIR = path.join(ROOT, 'assets', 'characters');
export const RIGS_DIR = path.join(ROOT, 'lib', 'mocap', 'mhr-rigs');

/** Reads KEY=value lines from the repo's .env (gitignored) without printing anything. */
export function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

export const TRIPO = {
  baseUrl: process.env.TRIPO_BASE_URL || 'https://openapi.tripo3d.ai',
  // high-detail source masters (body, head, hands)
  sourceModel: 'v3.1-20260211',
  source: { geometry_quality: 'detailed', texture: true, pbr: true, texture_quality: 'extreme', texture_version: 'v3.5-20260815', export_uv: true },
  // Tripo rigging, two tasks: rig v1.0 with spec mixamo → the Mixamo-named body skeleton (23 bones,
  // no fingers); rig v2.5 → finger chains (its own `tripo::` names; spec mixamo and a Mixamo FBX
  // convert both keep those names). rigmerge.py grafts the v2.5 fingers onto the Mixamo body.
  rigModel: 'v1.0-20240301',
  fingerRigModel: 'v2.5-20260210',
  rigSpec: 'mixamo',
  rigOutFormat: 'glb',
};

export const LIMITS = {
  maxCreditsPerCharacter: +(process.env.MAX_TRIPO_CREDITS_PER_CHARACTER || 600),
  maxRetriesPerStage: +(process.env.MAX_RETRIES_PER_STAGE || 2),
};

/**
 * Game budgets. The project's own budget (docs/character-brief: 40k–80k faces for the player)
 * sets LOD0; the lower LODs follow the requested ladder.
 */
export const QUALITY = {
  hero: { lods: [{ tris: 70000, dist: 0 }, { tris: 36000, dist: 9 }, { tris: 16000, dist: 18 }, { tris: 6000, dist: 32 }], texSize: 4096, bakeSize: 4096 },
  standard: { lods: [{ tris: 50000, dist: 0 }, { tris: 28000, dist: 8 }, { tris: 12000, dist: 16 }, { tris: 5000, dist: 28 }], texSize: 2048, bakeSize: 2048 },
  draft: { lods: [{ tris: 20000, dist: 0 }, { tris: 8000, dist: 12 }], texSize: 1024, bakeSize: 1024 },
};

export const PARTS = ['body', 'head', 'hand_left', 'hand_right'];
export const OPTIONAL_PARTS = ['hair', 'shoes', 'clothing', 'accessory'];
export const VIEWS = ['front', 'left', 'back', 'right'];

export const BLENDER = process.env.BLENDER_BIN || ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender'].find((p) => fs.existsSync(p)) || 'blender';
