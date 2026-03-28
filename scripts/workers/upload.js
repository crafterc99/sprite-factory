#!/usr/bin/env node
/**
 * Upload Worker — polls task-board.md for Upload-owned tasks and executes them.
 *
 * Usage:
 *   node scripts/workers/upload.js
 *   node scripts/workers/upload.js --once   # run one cycle then exit
 *   node scripts/workers/upload.js --dry    # print tasks without executing
 *
 * Owns:
 *   - source intake (headshot / bodyshot / clothing)
 *   - upload-related file handling
 *   - package / source metadata
 *   - normalization flow
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../../');
const TASK_BOARD = path.join(ROOT, 'coordination/task-board.md');
const RESULTS = path.join(ROOT, 'coordination/results.md');
const BLOCKERS = path.join(ROOT, 'coordination/blockers.md');
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3456';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const OWNER_TAG = /^\*\*Owner:\*\*\s*Upload/i;
const STATUS_TODO = /^\*\*Status:\*\*\s*(TODO|QUEUED)/i;
const STATUS_LINE = /^(\*\*Status:\*\*\s*).+$/m;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ONCE = args.includes('--once');

// ─── Task Board Parsing ────────────────────────────────────────────────────

function parseTasks(md) {
  const tasks = [];
  const blocks = md.split(/\n(?=###\s)/);
  for (const block of blocks) {
    const idMatch = block.match(/^###\s+(\S+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (!OWNER_TAG.test(block)) continue;
    if (!STATUS_TODO.test(block)) continue;
    const filesMatch = block.match(/^\*\*Files?:\*\*\s*(.+)$/m);
    const actionMatch = block.match(/^\*\*Action:\*\*\s*(.+)$/m);
    const briefMatch = block.match(/^\*\*Brief:\*\*\s*(.+)$/m);
    tasks.push({
      id,
      raw: block,
      files: filesMatch ? filesMatch[1].trim() : null,
      action: actionMatch ? actionMatch[1].trim() : null,
      brief: briefMatch ? briefMatch[1].trim() : null,
    });
  }
  return tasks;
}

// ─── Task Board Writers ───────────────────────────────────────────────────

function setTaskStatus(taskId, status) {
  const md = fs.readFileSync(TASK_BOARD, 'utf8');
  // Find the task block and update its status line
  const taskBlockRe = new RegExp(`(###\\s+${escapeRegex(taskId)}[\\s\\S]*?)(?=\\n###|\\n##|$)`);
  const updated = md.replace(taskBlockRe, (block) =>
    block.replace(STATUS_LINE, `**Status:** ${status}`)
  );
  if (updated !== md) fs.writeFileSync(TASK_BOARD, updated);
}

function appendResult(entry) {
  const md = fs.readFileSync(RESULTS, 'utf8');
  fs.writeFileSync(RESULTS, md.trimEnd() + '\n\n---\n\n' + entry.trimStart() + '\n');
}

function appendBlocker(entry) {
  const md = fs.readFileSync(BLOCKERS, 'utf8');
  fs.writeFileSync(BLOCKERS, md.trimEnd() + '\n\n' + entry.trimStart() + '\n');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── API Helpers ──────────────────────────────────────────────────────────

async function apiGet(route) {
  const res = await fetch(`${SERVER_URL}${route}`);
  if (!res.ok) throw new Error(`GET ${route} → ${res.status}`);
  return res.json();
}

async function apiPost(route, body) {
  const res = await fetch(`${SERVER_URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${route} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Task Execution ────────────────────────────────────────────────────────

/**
 * Dispatch a single Upload-owned task.
 * Returns { success, message } — never throws.
 */
async function executeTask(task) {
  console.log(`[upload] executing ${task.id}: ${task.action || task.brief || '(no description)'}`);

  try {
    // Verify server is reachable
    await apiGet('/api/characters');
  } catch (err) {
    return { success: false, message: `Server unreachable: ${err.message}` };
  }

  // ── Routing by task ID prefix / action keyword ─────────────────────────
  const action = (task.action || '').toLowerCase();
  const id = task.id.toLowerCase();

  // Source upload / normalize
  if (id.includes('upload') || action.includes('upload') || action.includes('ingest') || action.includes('normalize')) {
    return await runSourceUpload(task);
  }

  // Package creation / init
  if (id.includes('package') || action.includes('package') || action.includes('create character')) {
    return await runPackageCreate(task);
  }

  // Clothing registry
  if (id.includes('clothing') || action.includes('clothing')) {
    return await runClothingTask(task);
  }

  // Fallback — unknown task type
  return { success: false, message: `Unknown task type — no handler matched for: ${task.action}` };
}

async function runSourceUpload(task) {
  // Parse character and source type from task metadata
  const charMatch = task.raw.match(/\*\*Character:\*\*\s*(\S+)/i);
  const typeMatch = task.raw.match(/\*\*Type:\*\*\s*(headshot|bodyshot|clothing)/i);
  const fileMatch = task.raw.match(/\*\*File:\*\*\s*(\S+)/i);

  if (!charMatch || !fileMatch) {
    return { success: false, message: 'Missing Character or File field in task' };
  }

  const character = charMatch[1];
  const sourceType = typeMatch ? typeMatch[1] : 'headshot';
  const filePath = path.resolve(ROOT, fileMatch[1]);

  if (!fs.existsSync(filePath)) {
    return { success: false, message: `Source file not found: ${filePath}` };
  }

  const result = await apiPost('/api/character/source', { character, type: sourceType, file: filePath });
  return { success: true, message: `Uploaded ${sourceType} for ${character}: ${JSON.stringify(result)}` };
}

async function runPackageCreate(task) {
  const charMatch = task.raw.match(/\*\*Character:\*\*\s*(\S+)/i);
  if (!charMatch) return { success: false, message: 'Missing Character field in task' };
  const character = charMatch[1];
  const result = await apiPost('/api/character/create', { character });
  return { success: true, message: `Created package for ${character}: ${JSON.stringify(result)}` };
}

async function runClothingTask(task) {
  return { success: false, message: 'Clothing handler not yet implemented — see TASK-1002' };
}

// ─── Poll Loop ─────────────────────────────────────────────────────────────

async function poll() {
  const md = fs.readFileSync(TASK_BOARD, 'utf8');
  const tasks = parseTasks(md);

  if (tasks.length === 0) {
    console.log(`[upload] no tasks found — sleeping ${POLL_INTERVAL_MS / 1000}s`);
    return;
  }

  const task = tasks[0]; // take first available
  console.log(`[upload] claimed: ${task.id}`);

  if (DRY) {
    console.log(`[upload] DRY RUN — would execute:`, task);
    return;
  }

  setTaskStatus(task.id, 'IN_PROGRESS');

  const { success, message } = await executeTask(task);
  const status = success ? 'DONE' : 'BLOCKED';
  setTaskStatus(task.id, status);

  const timestamp = new Date().toISOString();
  const resultEntry = [
    `### ${task.id}`,
    `- Owner: upload terminal`,
    `- Status: ${status}`,
    `- Files changed: ${task.files || 'none'}`,
    `- What changed: ${message}`,
    `- Validation: automated via upload worker`,
    `- Timestamp: ${timestamp}`,
    `- Follow-up: ${success ? 'none' : 'manual review required'}`,
  ].join('\n');

  appendResult(resultEntry);

  if (!success) {
    appendBlocker([
      `### BLOCKER-UPLOAD-${task.id}`,
      `- Reported by: upload worker`,
      `- Related task: ${task.id}`,
      `- Description: ${message}`,
      `- Suggested next action: Review task definition and retry`,
    ].join('\n'));
  }

  console.log(`[upload] ${task.id} → ${status}: ${message}`);
}

// ─── Entry Point ──────────────────────────────────────────────────────────

async function main() {
  console.log(`[upload] worker started — polling ${TASK_BOARD}`);
  console.log(`[upload] server: ${SERVER_URL} | interval: ${POLL_INTERVAL_MS}ms | dry: ${DRY} | once: ${ONCE}`);

  if (ONCE) {
    await poll();
    return;
  }

  while (true) {
    try {
      await poll();
    } catch (err) {
      console.error(`[upload] poll error:`, err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error('[upload] fatal:', err);
  process.exit(1);
});
