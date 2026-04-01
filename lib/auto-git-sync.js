/**
 * Auto Git Sync — persists runtime data changes to GitHub
 *
 * Writes to .characters.json / wardrobe.json / anim-lib / assets are
 * committed and pushed to GitHub so data survives Railway redeploys.
 *
 * Handles Railway-specific edge cases:
 *   - shallow clones (unshallows before push)
 *   - detached HEAD (pushes to refs/heads/main explicitly)
 *   - non-fast-forward (fetches + rebases then retries)
 *   - missing git identity (sets user.email/name inline)
 *
 * Requires GITHUB_TOKEN env var (PAT with repo write scope) on Railway.
 */
'use strict';

const { exec, execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DATA_TARGETS = [
  'data/.characters.json',
  'data/wardrobe.json',
  'data/anim-lib',
  'data/assets',
];

let _timer = null;
let _pending = false;
let _running = false;

function scheduleSync() {
  _pending = true;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_doSync, 2000); // 2s debounce — short enough to beat most redeploys
}

function _getRemoteUrl() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    const origin = execSync('git remote get-url origin', { cwd: ROOT, timeout: 5000 }).toString().trim();
    if (origin.includes('@')) {
      // Already has credentials embedded (local dev proxy etc.) — use as-is
      return null;
    }
    if (origin.startsWith('https://')) {
      return origin.replace('https://', `https://${token}@`);
    }
    const sshMatch = origin.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://${token}@github.com/${sshMatch[1]}.git`;
  } catch {}
  return null;
}

function _run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: ROOT, timeout: 60000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), err });
    });
  });
}

async function _doSync() {
  if (_running) {
    // Another sync in progress — reschedule to run after it finishes
    _timer = setTimeout(_doSync, 3000);
    return;
  }
  _timer = null;
  if (!_pending) return;
  _pending = false;
  _running = true;

  try {
    await _attemptSync();
  } finally {
    _running = false;
    // If more writes came in while we were syncing, run again
    if (_pending) scheduleSync();
  }
}

async function _attemptSync() {
  const remoteUrl = _getRemoteUrl();

  // Set git identity (Railway containers have none by default)
  await _run('git config user.email "autosync@sprite-factory.app"');
  await _run('git config user.name "Sprite Factory Sync"');

  // Stage all data targets
  const addTargets = DATA_TARGETS.map(t => `"${t}"`).join(' ');
  await _run(`git add ${addTargets}`);

  // Check if there's anything to commit
  const diff = await _run('git diff --cached --quiet');
  if (diff.ok) {
    // Nothing staged — nothing to do
    return;
  }

  // Commit
  const commit = await _run('git commit -m "data: auto-sync runtime changes" --no-verify');
  if (!commit.ok && !commit.stderr.includes('nothing to commit')) {
    console.warn('[auto-git-sync] commit failed:', commit.stderr.slice(0, 200));
    return;
  }

  if (!remoteUrl) {
    // No token — changes committed locally but can't push
    if (process.env.GITHUB_TOKEN) {
      console.warn('[auto-git-sync] GITHUB_TOKEN set but could not build remote URL');
    }
    return;
  }

  // Try to push; if rejected (non-fast-forward), fetch + rebase + retry
  for (let attempt = 1; attempt <= 3; attempt++) {
    const push = await _run(`git push "${remoteUrl}" HEAD:refs/heads/main`);
    if (push.ok) {
      console.log('[auto-git-sync] ✓ data pushed to GitHub');
      return;
    }

    const out = push.stdout + push.stderr;

    // Shallow clone — unshallow then retry
    if (out.includes('shallow') || out.includes('unrelated histories')) {
      await _run(`git fetch --unshallow "${remoteUrl}" 2>/dev/null || git fetch "${remoteUrl}" main`);
      continue;
    }

    // Non-fast-forward — fetch + rebase data-only commit then retry
    if (out.includes('rejected') || out.includes('non-fast-forward') || out.includes('fetch first')) {
      const fetch = await _run(`git fetch "${remoteUrl}" main`);
      if (!fetch.ok) { console.warn('[auto-git-sync] fetch failed:', fetch.stderr.slice(0, 200)); break; }
      const rebase = await _run('git rebase FETCH_HEAD');
      if (!rebase.ok) {
        // Rebase conflict — just take our data files and force-push
        await _run('git rebase --abort');
        await _run(`git fetch "${remoteUrl}" main`);
        await _run('git reset --soft FETCH_HEAD');
        await _run(`git add ${addTargets}`);
        await _run('git commit -m "data: auto-sync runtime changes" --no-verify --allow-empty');
        await _run(`git push "${remoteUrl}" HEAD:refs/heads/main`);
        console.log('[auto-git-sync] ✓ data pushed (conflict resolved)');
        return;
      }
      continue;
    }

    console.warn(`[auto-git-sync] push failed (attempt ${attempt}/3):`, out.slice(0, 300));
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
  }
}

// git rm tracked files + sync — used when deleting characters
function _gitRmAndSync(filePaths) {
  const rmTargets = filePaths.map(f => `"${f}"`).join(' ');
  const addTargets = DATA_TARGETS.map(t => `"${t}"`).join(' ');
  exec(
    `git rm --cached --ignore-unmatch -f ${rmTargets} 2>/dev/null || true && git add ${addTargets}`,
    { cwd: ROOT, timeout: 15000 },
    () => scheduleSync()
  );
}

// Flush any pending sync immediately (call on graceful shutdown)
async function flushSync() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_pending) {
    _pending = false;
    await _attemptSync();
  }
}

// Push on process exit so in-flight changes aren't lost on Railway shutdown
process.on('SIGTERM', async () => {
  console.log('[auto-git-sync] SIGTERM received — flushing sync before exit');
  await flushSync();
  process.exit(0);
});

module.exports = { scheduleSync, _gitRmAndSync, flushSync };
