/**
 * Auto Git Sync — persists runtime data changes to GitHub
 *
 * Called after any write to characters, wardrobe, or anim-lib.
 * Debounced 8s so rapid saves are batched into one commit.
 *
 * On Railway: set GITHUB_TOKEN env var (PAT with repo write scope)
 * to enable auto-push. Without it, data is disk-only until the
 * next manual deploy-button commit.
 *
 * On local dev: uses existing git credentials (macOS keychain etc.)
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

function scheduleSync() {
  _pending = true;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_doSync, 8000);
}

function _buildRemoteUrl() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    const origin = execSync('git remote get-url origin', { cwd: ROOT, timeout: 5000 }).toString().trim();
    if (origin.startsWith('https://')) {
      return origin.replace('https://', `https://${token}@`);
    }
    const sshMatch = origin.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://${token}@github.com/${sshMatch[1]}.git`;
  } catch {}
  return null;
}

function _doSync() {
  _timer = null;
  if (!_pending) return;
  _pending = false;

  const addTargets = DATA_TARGETS.map(t => `"${t}"`).join(' ');
  const remoteUrl = _buildRemoteUrl();
  const pushCmd = remoteUrl
    ? `git push "${remoteUrl}" HEAD:main`
    : 'git push origin main';

  const cmd = [
    `git add ${addTargets}`,
    'git diff --cached --quiet || git commit -m "data: auto-sync runtime changes" --no-verify',
    pushCmd,
  ].join(' && ');

  exec(cmd, { cwd: ROOT, timeout: 45000 }, (err, stdout, stderr) => {
    const out = ((stdout || '') + (stderr || '')).trim();
    if (err) {
      if (!out.includes('nothing to commit') && !out.includes('up to date')) {
        console.warn('[auto-git-sync] push failed (data is still saved locally):', out.slice(0, 300));
      }
    } else {
      if (out && !out.includes('up to date')) {
        console.log('[auto-git-sync] data pushed to git');
      }
    }
  });
}

module.exports = { scheduleSync };
