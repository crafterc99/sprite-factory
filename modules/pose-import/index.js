'use strict';
/**
 * SAM 3D Pose Import — skeleton JSON parser and joint extractor.
 * Accepts joint data from Meta SAM 3D or any standard 17-point body format.
 * Derives facing direction, body lean, and per-direction prompt hints.
 */

// Standard joint indices (COCO 17-point body keypoints)
const JOINT_IDX = {
  nose: 0, left_eye: 1, right_eye: 2, left_ear: 3, right_ear: 4,
  left_shoulder: 5, right_shoulder: 6, left_elbow: 7, right_elbow: 8,
  left_wrist: 9, right_wrist: 10, left_hip: 11, right_hip: 12,
  left_knee: 13, right_knee: 14, left_ankle: 15, right_ankle: 16,
};

const DIRECTION_LABELS = [
  null, 'Front', 'Front-Right', 'Right', 'Back-Right',
  'Back', 'Back-Left', 'Left', 'Front-Left',
];

// Camera angle description per direction id (injected into Gemini prompts)
const DIR_CAMERA_HINTS = {
  1: 'front view — player faces camera directly toward basket',
  2: 'front-right 3/4 view — player slightly turned right, facing toward basket',
  3: 'right side profile — player faces right',
  4: 'back-right 3/4 view — player mostly facing away, turned right',
  5: 'back view — player faces directly away from camera, back to basket side',
  6: 'back-left 3/4 view — player mostly facing away, turned left',
  7: 'left side profile — player faces left',
  8: 'front-left 3/4 view — player slightly turned left, facing toward basket',
};

/**
 * Parse raw skeleton joint data from various formats into named joints.
 * Supports:
 *   - Array of 17 [x,y,z] or {x,y,z} positions (COCO order)
 *   - Object with named joints { joint_name: [x,y,z] }
 */
function parseJoints(raw) {
  if (!raw) throw new Error('No skeleton data provided');

  if (Array.isArray(raw)) {
    const joints = {};
    for (const [name, idx] of Object.entries(JOINT_IDX)) {
      const pt = raw[idx];
      if (pt) joints[name] = Array.isArray(pt) ? { x: pt[0], y: pt[1], z: pt[2] } : pt;
    }
    return joints;
  }

  if (typeof raw === 'object') {
    const joints = {};
    for (const name of Object.keys(JOINT_IDX)) {
      if (raw[name]) {
        const pt = raw[name];
        joints[name] = Array.isArray(pt) ? { x: pt[0], y: pt[1], z: pt[2] } : pt;
      }
    }
    return joints;
  }

  throw new Error('Unsupported skeleton format — expected array or named object');
}

function dist3(a, b) {
  if (!a || !b) return null;
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function midpoint(a, b) {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/** Compute body proportions from joints. All values in input units. */
function computeProportions(joints) {
  const lS = joints.left_shoulder, rS = joints.right_shoulder;
  const lH = joints.left_hip,      rH = joints.right_hip;
  const lK = joints.left_knee,     rK = joints.right_knee;
  const lA = joints.left_ankle,    rA = joints.right_ankle;
  const lE = joints.left_elbow,    rE = joints.right_elbow;
  const lW = joints.left_wrist,    rW = joints.right_wrist;

  const shoulderMid = midpoint(lS, rS);
  const hipMid = midpoint(lH, rH);

  return {
    shoulderWidth: dist3(lS, rS),
    hipWidth: dist3(lH, rH),
    torsoLength: dist3(shoulderMid, hipMid),
    upperLegLength: dist3(lH, lK),
    lowerLegLength: dist3(lK, lA),
    upperArmLength: dist3(lS, lE),
    forearmLength: dist3(lE, lW),
  };
}

/**
 * Derive facing yaw angle (degrees) from shoulder vector.
 * 0° ≈ facing toward +Z axis.
 */
function deriveFacingAngle(joints) {
  const lS = joints.left_shoulder, rS = joints.right_shoulder;
  if (!lS || !rS) return null;
  const dx = lS.x - rS.x;
  const dz = lS.z - rS.z;
  return Math.round(Math.atan2(-dx, dz) * 180 / Math.PI);
}

/** Compute torso forward lean angle (degrees). Positive = leaning forward. */
function deriveTorsoLean(joints) {
  const lS = joints.left_shoulder, rS = joints.right_shoulder;
  const lH = joints.left_hip,      rH = joints.right_hip;
  if (!lS || !rS || !lH || !rH) return null;
  const sMid = midpoint(lS, rS);
  const hMid = midpoint(lH, rH);
  const dy = sMid.y - hMid.y;
  const dz = sMid.z - hMid.z;
  return Math.round(Math.atan2(dz, Math.abs(dy)) * 180 / Math.PI);
}

/** Compute knee bend angle (degrees, 0=straight). Uses left leg as primary. */
function deriveKneeBend(joints) {
  const hip = joints.left_hip, knee = joints.left_knee, ankle = joints.left_ankle;
  if (!hip || !knee || !ankle) return null;
  const v1 = { x: knee.x - hip.x, y: knee.y - hip.y, z: knee.z - hip.z };
  const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y, z: ankle.z - knee.z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const mag1 = Math.sqrt(v1.x ** 2 + v1.y ** 2 + v1.z ** 2);
  const mag2 = Math.sqrt(v2.x ** 2 + v2.y ** 2 + v2.z ** 2);
  if (mag1 < 1e-9 || mag2 < 1e-9) return 0;
  const cosA = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.round(Math.acos(cosA) * 180 / Math.PI);
}

/**
 * Rotate joint positions around Y axis to simulate viewing from direction dirId.
 * d1=Front (0°), d2=Front-Right (45°)... d5=Back (180°)... d8=Front-Left (-45°)
 */
function rotateSkeletonToDirection(joints, dirId) {
  const degs = { 1: 0, 2: 45, 3: 90, 4: 135, 5: 180, 6: -135, 7: -90, 8: -45 };
  const rad = (degs[dirId] ?? 0) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rotated = {};
  for (const [name, pt] of Object.entries(joints)) {
    if (!pt) { rotated[name] = pt; continue; }
    rotated[name] = { x: pt.x * cos - pt.z * sin, y: pt.y, z: pt.x * sin + pt.z * cos };
  }
  return rotated;
}

/**
 * Generate natural-language pose hint for a direction id.
 * Rotates the skeleton to simulate that viewing angle, then extracts pose data.
 */
function skeletonToPromptHints(joints, dirId) {
  const rotated = rotateSkeletonToDirection(joints, dirId);
  const kneeBend = deriveKneeBend(rotated);
  const torsoLean = deriveTorsoLean(rotated);

  const hints = [];
  if (kneeBend !== null) {
    if (kneeBend < 10) hints.push('legs straight, upright stance');
    else if (kneeBend < 30) hints.push(`knees slightly bent (${kneeBend}°)`);
    else if (kneeBend < 60) hints.push(`knees moderately bent (${kneeBend}°)`);
    else hints.push(`knees deeply bent (${kneeBend}°), low stance`);
  }
  if (torsoLean !== null) {
    if (Math.abs(torsoLean) < 5) hints.push('torso upright');
    else if (torsoLean > 0) hints.push(`torso leaning forward ${torsoLean}°`);
    else hints.push(`torso leaning backward ${Math.abs(torsoLean)}°`);
  }

  return {
    cameraHint: DIR_CAMERA_HINTS[dirId] ?? `direction ${dirId} view`,
    poseHints: hints.join(', '),
  };
}

/**
 * Full parse pipeline: raw skeleton JSON → joints + derived metrics + per-direction hints.
 */
function parseSkeleton(rawJson, poseSource = 'manual') {
  const joints = parseJoints(rawJson);
  const proportions = computeProportions(joints);
  const directionHints = {};
  for (let d = 1; d <= 8; d++) directionHints[d] = skeletonToPromptHints(joints, d);

  return {
    joints,
    facingAngleDeg: deriveFacingAngle(joints),
    bodyLean: deriveTorsoLean(joints),
    kneeBend: deriveKneeBend(joints),
    proportions,
    directionHints,
    poseSource,
  };
}

module.exports = {
  parseSkeleton, parseJoints, computeProportions,
  deriveFacingAngle, deriveTorsoLean, deriveKneeBend,
  rotateSkeletonToDirection, skeletonToPromptHints,
  JOINT_IDX, DIR_CAMERA_HINTS, DIRECTION_LABELS,
};
