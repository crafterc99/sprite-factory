/**
 * Job Store — JSON-file-based generation job tracking
 *
 * Records every generation attempt with full metadata for:
 * - Cherry-picking frames from multiple attempts
 * - Prompt history and version tracking
 * - Pipeline checkpoint/resume
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JOB_DIR = path.resolve(__dirname, '../../.job-history');

function ensureDir() {
  if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR, { recursive: true });
}

function jobPath(id) {
  return path.join(JOB_DIR, `${id}.json`);
}

/**
 * Create a new generation job.
 * @param {object} opts
 * @returns {object} The created job
 */
function createJob(opts = {}) {
  ensureDir();
  const id = crypto.randomUUID();
  const job = {
    id,
    character: opts.character || '',
    animation: opts.animation || '',
    mode: opts.mode || 'fbf', // 'strip' | 'fbf' | 'autotest' | 'single'
    model: opts.model || 'gemini-2.5-flash-image',
    status: 'pending', // pending | generating | processing | complete | failed
    totalFrames: opts.totalFrames || 0,
    completedFrames: 0,
    rawPaths: [],
    processedPaths: [],
    stripPath: null,
    qualityScore: null,
    promptSections: opts.promptSections || null,
    promptText: opts.promptText || null,
    totalCost: 0,
    attempts: [], // Array of { frameIndex, attemptNum, rawPath, processedPath, score, timestamp }
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  fs.writeFileSync(jobPath(id), JSON.stringify(job, null, 2));
  return job;
}

/**
 * Get a job by ID.
 */
function getJob(id) {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Update a job.
 */
function updateJob(id, updates) {
  const job = getJob(id);
  if (!job) return null;
  Object.assign(job, updates);
  fs.writeFileSync(jobPath(id), JSON.stringify(job, null, 2));
  return job;
}

/**
 * Record a frame attempt for a job.
 */
function recordAttempt(jobId, frameIndex, attemptData) {
  const job = getJob(jobId);
  if (!job) return null;

  job.attempts.push({
    frameIndex,
    attemptNum: job.attempts.filter(a => a.frameIndex === frameIndex).length + 1,
    rawPath: attemptData.rawPath || null,
    processedPath: attemptData.processedPath || null,
    score: attemptData.score || null,
    promptText: attemptData.promptText || null,
    timestamp: new Date().toISOString(),
  });

  fs.writeFileSync(jobPath(jobId), JSON.stringify(job, null, 2));
  return job;
}

/**
 * Get all attempts for a specific frame in a job.
 */
function getFrameAttempts(jobId, frameIndex) {
  const job = getJob(jobId);
  if (!job) return [];
  return job.attempts.filter(a => a.frameIndex === frameIndex);
}

/**
 * List all jobs, optionally filtered.
 */
function listJobs(filter = {}) {
  ensureDir();
  const files = fs.readdirSync(JOB_DIR).filter(f => f.endsWith('.json'));
  let jobs = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(JOB_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);

  if (filter.character) jobs = jobs.filter(j => j.character === filter.character);
  if (filter.animation) jobs = jobs.filter(j => j.animation === filter.animation);
  if (filter.status) jobs = jobs.filter(j => j.status === filter.status);

  // Sort by most recent first
  jobs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

  return jobs;
}

/**
 * Get the latest completed job for a character/animation.
 */
function getLatestJob(character, animation) {
  const jobs = listJobs({ character, animation });
  return jobs.find(j => j.status === 'complete') || jobs[0] || null;
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  recordAttempt,
  getFrameAttempts,
  listJobs,
  getLatestJob,
  JOB_DIR,
};
