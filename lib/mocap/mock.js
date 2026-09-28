/**
 * Deterministic synthetic mocap source (MOCAP_MOCK=1).
 *
 * Produces SAM 3 / SAM 3D Body shaped results for a procedural right-hand
 * dribble, filmed from a camera that is yawed 30° and pitched down 6°, so the
 * canonicalisation, ground alignment, ball depth and foot-lock paths all get
 * exercised without any API key. Never used unless MOCAP_MOCK=1.
 */
'use strict';

const path = require('path');
const sharp = require('sharp');
const S = require('./skeleton');

const FOCAL = 1500;
const FPS = 12;

function frameIndex(framePath) {
  const m = path.basename(framePath).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** World-space (y-up, metres, facing +Z) pose at time t. */
function poseAt(t) {
  const P = new Array(70).fill(null);
  const bob = 0.03 * Math.sin(t * Math.PI * 2 * 1.5);
  const crouch = 0.08;
  const pelvisY = 0.98 - crouch + bob;
  const set = (name, x, y, z) => { P[S.J[name]] = [x, y, z]; };

  set('left-hip', 0.10, pelvisY, 0);
  set('right-hip', -0.10, pelvisY, 0);
  set('left-knee', 0.14, 0.52, 0.10);
  set('right-knee', -0.14, 0.52, 0.10);
  set('left-ankle', 0.16, 0.08, 0);
  set('right-ankle', -0.16, 0.08, 0);
  set('left-heel', 0.16, 0.02, -0.06);
  set('right-heel', -0.16, 0.02, -0.06);
  set('left-big-toe-tip', 0.17, 0.02, 0.16);
  set('right-big-toe-tip', -0.17, 0.02, 0.16);
  set('left-small-toe-tip', 0.21, 0.02, 0.13);
  set('right-small-toe-tip', -0.21, 0.02, 0.13);
  const shY = pelvisY + 0.50;
  set('left-shoulder', 0.19, shY, 0.03);
  set('right-shoulder', -0.19, shY, 0.03);
  set('left-acromion', 0.21, shY + 0.02, 0.03);
  set('right-acromion', -0.21, shY + 0.02, 0.03);
  set('neck', 0, shY + 0.06, 0.03);
  const headY = shY + 0.22;
  set('nose', 0, headY, 0.13);
  set('left-eye', 0.035, headY + 0.03, 0.11);
  set('right-eye', -0.035, headY + 0.03, 0.11);
  set('left-ear', 0.08, headY + 0.01, 0.03);
  set('right-ear', -0.08, headY + 0.01, 0.03);
  // Left arm guards, right arm dribbles
  set('left-elbow', 0.30, shY - 0.25, 0.20);
  set('left-wrist', 0.24, shY - 0.35, 0.42);
  const phase = (t * 1.5) % 1; // one bounce per 0.67s
  const push = Math.sin(phase * Math.PI * 2);
  const wristY = pelvisY - 0.02 + 0.06 * push;
  set('right-elbow', -0.33, shY - 0.27, 0.10);
  set('right-wrist', -0.38, wristY, 0.30);
  for (const side of ['left', 'right']) {
    const w = P[S.J[`${side}-wrist`]];
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      for (const k of ['first-joint', 'second-joint', 'third-joint', 'tip']) {
        const d = k === 'tip' ? 0.09 : k === 'first-joint' ? 0.06 : 0.04;
        set(`${side}-${f}-${k}`, w[0], w[1] - d, w[2] + 0.02);
      }
    }
  }
  const le = P[S.J['left-elbow']], re = P[S.J['right-elbow']];
  set('left-olecranon', le[0], le[1], le[2] - 0.03);
  set('right-olecranon', re[0], re[1], re[2] - 0.03);
  set('left-cubital-fossa', le[0], le[1], le[2] + 0.03);
  set('right-cubital-fossa', re[0], re[1], re[2] + 0.03);

  // Ball: floor ↔ hand, below the right hand
  const bh = 0.12 + (wristY - 0.22) * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2));
  const ball = [-0.40, Math.max(0.12, bh), 0.34];
  return { P, ball };
}

function toCamera(p) {
  // Subject yawed 30°, camera 4 m away at 1.2 m, pitched down 6°
  const yaw = S.rotY((30 * Math.PI) / 180);
  const w = S.mulMV(yaw, p);
  const rel = [w[0], -(w[1] - 1.2), -(w[2] - 4)]; // x right, y down, z forward
  return S.mulMV(S.rotX((-6 * Math.PI) / 180), rel);
}

function sample(framePath, W, H) {
  const t = frameIndex(framePath) / FPS;
  const { P, ball } = poseAt(t);
  const cam = P.map(toCamera);
  const pelvis = S.mid(cam[S.J['left-hip']], cam[S.J['right-hip']]);
  const proj = (c) => [FOCAL * c[0] / c[2] + W / 2, FOCAL * c[1] / c[2] + H / 2];
  const bc = toCamera(ball);
  const bp = proj(bc);
  return {
    cam, pelvis,
    kp2d: cam.map(proj),
    ball: { u: bp[0], v: bp[1], r: (FOCAL * 0.12) / bc[2], score: 0.95 },
  };
}

async function segmentFrame(framePath, W, H) {
  const s = sample(framePath, W, H);
  const xs = s.kp2d.map((p) => p[0]), ys = s.kp2d.map((p) => p[1]);
  const bbox = [Math.min(...xs) - 20, Math.min(...ys) - 60, Math.max(...xs) + 20, Math.max(...ys) + 10];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#000"/>` +
    `<rect x="${bbox[0]}" y="${bbox[1]}" width="${bbox[2] - bbox[0]}" height="${bbox[3] - bbox[1]}" rx="40" fill="#fff"/></svg>`;
  const personMaskPng = await sharp(Buffer.from(svg)).png().toBuffer();
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  return { personMaskPng, person: { area: (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]), cx, cy, bbox }, ball: s.ball, imgW: W, imgH: H, cost: 0 };
}

async function bodyFrame(framePath, W, H) {
  const s = sample(framePath, W, H);
  // HMR convention: keypoints_3d root-relative, camT = translation to camera
  const kp3d = s.cam.map((c) => S.sub(c, s.pelvis));
  const xs = s.kp2d.map((p) => p[0]), ys = s.kp2d.map((p) => p[1]);
  return {
    kp2d: s.kp2d, kp3d, camT: s.pelvis, focal: FOCAL,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    imgW: W, imgH: H, visualizationUrl: null, cost: 0,
  };
}

module.exports = { segmentFrame, bodyFrame, poseAt, FPS };
