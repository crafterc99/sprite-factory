#!/usr/bin/env node
/**
 * A game pose for draping garments: the court's real game tick run headless for a character
 * (tests/helpers/ball-harness.mjs — the Player, MHR skinning, ball session, IK), standing in its idle
 * dribble, and its bone matrices at one moment written in the character's own frame (bind space:
 * facing +z, feet at the origin) — garments draped in this pose rest on the body the way the game
 * shows it (arms down, the dribble stance), not the rig's A-pose.
 *
 *   node tools/character_pipeline/garments/export_pose.mjs <rig id> <out.json> [--at 1.4]
 *
 * Needs the clip library (data/mocap: npm run clips:pull).
 */
import fs from 'fs';

const [rig, out] = process.argv.slice(2);
const at = +(process.argv[process.argv.indexOf('--at') + 1] || 1.4);
if (!rig || !out) { console.error('usage: export_pose.mjs <rig id> <out.json> [--at seconds]'); process.exit(2); }
const H = await import('../../../tests/helpers/ball-harness.mjs');
const game = await H.makeGame({ rig, fps: 60 });
let mats = null, pos = null, yaw = null;
game.run([[0, at, {}]], { onTick: ({ t, mats: m, P }) => { if (t >= at - 1e-6 || !mats) { mats = Float32Array.from(m); pos = [...P.pos]; yaw = P.yaw; } } });
// world → the character's frame: undo the court position and facing (the rig faces +z at yaw 0)
const c = Math.cos(yaw), s = Math.sin(yaw);
const nb = mats.length / 16, local = [];
for (let b = 0; b < nb; b++) {
  const m = mats.subarray(b * 16, b * 16 + 16);
  // column-major 4×4: rotate each column's x/z by -yaw about y, then translate by -pos
  const L = new Array(16);
  for (let col = 0; col < 4; col++) {
    let x = m[col * 4], y = m[col * 4 + 1], z = m[col * 4 + 2];
    if (col === 3) { x -= pos[0]; z -= pos[1]; }
    L[col * 4] = c * x - s * z; L[col * 4 + 1] = y; L[col * 4 + 2] = s * x + c * z; L[col * 4 + 3] = m[col * 4 + 3];
  }
  local.push(L);
}
fs.writeFileSync(out, JSON.stringify({ rig, at, yaw, pos, note: 'column-major 4x4 per bone: bind space → posed, in the character frame', mats: local }));
console.log(JSON.stringify({ rig, at, bones: nb, out }));
