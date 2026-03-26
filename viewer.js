#!/usr/bin/env node
/**
 * Sprite Factory Viewer — Playwright-based browser for viewing generations
 * and training prompt quality through visual feedback.
 *
 * Usage:
 *   node viewer.js                     # Open Sprite Factory UI in browser
 *   node viewer.js screenshot          # Screenshot current state
 *   node viewer.js review <char>       # Review all sprites for a character
 *   node viewer.js train <char> <anim> # Generate + screenshot + prompt for feedback
 *   node viewer.js compare <char>      # Side-by-side compare all animations
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 3456;
const BASE_URL = `http://localhost:${PORT}`;
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../.screenshots');
const ASSETS_DIR = path.resolve(__dirname, '../../../soul-jam/public/assets/images');
const TRAINING_FILE = path.resolve(__dirname, '../../.training-data/viewer-sessions.json');

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────────────

function toDataUri(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${data.toString('base64')}`;
}

async function waitForServer(maxWait = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await fetch(`${BASE_URL}/api/characters`);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function saveSession(data) {
  let sessions = [];
  if (fs.existsSync(TRAINING_FILE)) {
    sessions = JSON.parse(fs.readFileSync(TRAINING_FILE, 'utf8'));
  }
  sessions.push({ ...data, timestamp: new Date().toISOString() });
  fs.writeFileSync(TRAINING_FILE, JSON.stringify(sessions, null, 2));
}

// ─── Commands ────────────────────────────────────────────────────────────

async function openUI() {
  console.log('\n  Launching Sprite Factory viewer...\n');

  const serverUp = await waitForServer();
  if (!serverUp) {
    console.log('  Server not running — starting it...');
    const { spawn } = require('child_process');
    const server = spawn('node', [path.resolve(__dirname, 'server.js')], {
      stdio: 'pipe',
      env: { ...process.env, PORT: String(PORT) },
    });
    server.stdout.on('data', d => process.stdout.write('  [server] ' + d));
    server.stderr.on('data', d => process.stderr.write('  [server] ' + d));
    await new Promise(r => setTimeout(r, 2000));
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1440,900'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(BASE_URL);
  await page.waitForSelector('.char-card', { timeout: 10000 });

  console.log('  Sprite Factory open at', BASE_URL);
  console.log('  Browser window is live — interact freely.\n');
  console.log('  Press Ctrl+C to close.\n');

  // Keep alive
  await new Promise(() => {});
}

async function screenshot(name) {
  const serverUp = await waitForServer();
  if (!serverUp) { console.log('Server not running'); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE_URL);
  await page.waitForSelector('.char-card', { timeout: 10000 });
  await page.waitForTimeout(1000);

  const filename = `${name || 'factory'}-${timestamp()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });

  console.log(`  Screenshot: ${filepath}`);
  await browser.close();
  return filepath;
}

async function reviewCharacter(charName) {
  console.log(`\n  Reviewing all sprites for "${charName}"...\n`);

  const serverUp = await waitForServer();
  if (!serverUp) { console.log('Server not running'); process.exit(1); }

  // Fetch character data
  const res = await fetch(`${BASE_URL}/api/sprites/${charName}`);
  const data = await res.json();

  const animRes = await fetch(`${BASE_URL}/api/characters`);
  const animData = await animRes.json();
  const animations = animData.animations;

  // Launch browser for visual review
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const reviewDir = path.join(SCREENSHOTS_DIR, `review-${charName}-${timestamp()}`);
  fs.mkdirSync(reviewDir, { recursive: true });

  // Screenshot the portrait
  const portraitPath = path.join(ASSETS_DIR, `${charName}full.png`);
  if (fs.existsSync(portraitPath)) {
    fs.copyFileSync(portraitPath, path.join(reviewDir, `00-portrait.png`));
    console.log(`  Portrait: ${charName}full.png`);
  }

  // Screenshot each animation strip
  let existing = 0;
  let missing = 0;
  const results = [];

  for (const [animName, animConfig] of Object.entries(animations)) {
    const sprite = data.sprites[animName];
    if (sprite?.exists) {
      const spritePath = path.join(ASSETS_DIR, sprite.file);
      fs.copyFileSync(spritePath, path.join(reviewDir, `${animName}.png`));
      console.log(`  ✓ ${animName} — ${animConfig.frames} frames`);
      existing++;
      results.push({ animation: animName, status: 'exists', frames: animConfig.frames });
    } else {
      console.log(`  ✗ ${animName} — MISSING`);
      missing++;
      results.push({ animation: animName, status: 'missing' });
    }
  }

  // Build an HTML review page
  const reviewHTML = buildReviewPage(charName, results, animations);
  const htmlPath = path.join(reviewDir, 'review.html');
  fs.writeFileSync(htmlPath, reviewHTML);

  // Screenshot the review page
  await page.setContent(reviewHTML);
  await page.waitForTimeout(500);
  const reviewShot = path.join(reviewDir, 'review-overview.png');
  await page.screenshot({ path: reviewShot, fullPage: true });

  console.log(`\n  Summary: ${existing} done, ${missing} missing`);
  console.log(`  Review: ${reviewDir}`);
  console.log(`  Overview: ${reviewShot}\n`);

  saveSession({ type: 'review', character: charName, existing, missing, results });
  await browser.close();
  return { reviewDir, existing, missing, results, screenshotPath: reviewShot };
}

function buildReviewPage(charName, results, animations) {
  const displayName = charName === '99' ? '99' : charName.charAt(0).toUpperCase() + charName.slice(1);
  const portraitSrc = path.join(ASSETS_DIR, `${charName}full.png`);
  const hasPortrait = fs.existsSync(portraitSrc);

  let spriteRows = '';
  for (const r of results) {
    const spritePath = path.join(ASSETS_DIR, `${charName}-${r.animation}.png`);
    const hasSprite = r.status === 'exists' && fs.existsSync(spritePath);
    const animConfig = animations[r.animation] || {};

    spriteRows += `
      <div style="background:#12121a;border:1px solid #2a2a3a;border-radius:12px;padding:16px;margin:8px 0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div>
            <span style="font-family:monospace;font-size:13px;font-weight:700;color:${hasSprite ? '#00ff88' : '#ff2244'}">${hasSprite ? '●' : '○'}</span>
            <span style="font-family:monospace;font-size:13px;font-weight:700;color:#e8e8f0;margin-left:8px">${r.animation}</span>
          </div>
          <span style="font-family:monospace;font-size:10px;color:#6a6a80">${animConfig.frames || '?'}f @ ${animConfig.fps || '?'}fps</span>
        </div>
        ${hasSprite
          ? `<img src="${toDataUri(spritePath)}" style="max-width:100%;image-rendering:pixelated;border-radius:6px;background:#1a1a28" />`
          : `<div style="padding:24px;text-align:center;color:#44445a;font-family:monospace;font-size:11px">Not generated yet</div>`
        }
        ${animConfig.frameBreakdown ? `<p style="font-family:monospace;font-size:9px;color:#44445a;margin-top:6px">${animConfig.frameBreakdown}</p>` : ''}
      </div>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { background:#0a0a0f; color:#e8e8f0; font-family:'Outfit',system-ui,sans-serif; padding:32px; margin:0; }
  h1 { font-family:monospace; font-size:18px; font-weight:700; letter-spacing:3px; text-transform:uppercase; color:#ff4400; }
</style></head><body>
  <div style="display:flex;align-items:center;gap:20px;margin-bottom:24px">
    ${hasPortrait ? `<img src="${toDataUri(portraitSrc)}" style="width:100px;height:130px;object-fit:contain;image-rendering:pixelated;border-radius:8px;background:#1a1a28;border:1px solid #2a2a3a" />` : ''}
    <div>
      <h1>${displayName}</h1>
      <p style="font-family:monospace;font-size:11px;color:#6a6a80;margin-top:4px">${results.filter(r=>r.status==='exists').length}/${results.length} animations complete</p>
    </div>
  </div>
  ${spriteRows}
</body></html>`;
}

async function trainAnimation(charName, animName) {
  console.log(`\n  Training: ${charName} / ${animName}\n`);

  const serverUp = await waitForServer();
  if (!serverUp) { console.log('Server not running'); process.exit(1); }

  const browser = await chromium.launch({ headless: false, args: ['--window-size=1440,900'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE_URL);
  await page.waitForSelector('.char-card', { timeout: 10000 });

  // Select the character
  const charCards = await page.$$('.char-card');
  for (const card of charCards) {
    const text = await card.textContent();
    if (text.toLowerCase().includes(charName.toLowerCase())) {
      await card.click();
      break;
    }
  }
  await page.waitForTimeout(500);

  // Select the animation
  const animBtns = await page.$$('.anim-btn');
  for (const btn of animBtns) {
    const text = await btn.textContent();
    if (text.includes(animName)) {
      await btn.click();
      break;
    }
  }
  await page.waitForTimeout(500);

  // Screenshot before generation
  const trainDir = path.join(SCREENSHOTS_DIR, `train-${charName}-${animName}-${timestamp()}`);
  fs.mkdirSync(trainDir, { recursive: true });
  await page.screenshot({ path: path.join(trainDir, '01-before.png') });

  // Click generate
  console.log('  Generating...');
  await page.click('#generateBtn');

  // Wait for generation to complete (watch spinner)
  await page.waitForSelector('#genSpinner:not(.active)', { timeout: 120000 });
  await page.waitForTimeout(1000);

  // Screenshot after generation
  await page.screenshot({ path: path.join(trainDir, '02-after.png') });

  // Capture the preview image
  const previewImg = await page.$('#previewImg');
  if (previewImg) {
    const previewVisible = await previewImg.isVisible();
    if (previewVisible) {
      await previewImg.screenshot({ path: path.join(trainDir, '03-sprite-output.png') });
    }
  }

  // Capture the prompt used
  const promptText = await page.$eval('#promptText', el => el.value);
  fs.writeFileSync(path.join(trainDir, 'prompt.txt'), promptText);

  // Capture the log
  const logText = await page.$eval('#logArea', el => el.textContent);
  fs.writeFileSync(path.join(trainDir, 'log.txt'), logText);

  console.log(`  Screenshots saved: ${trainDir}`);
  console.log('  Browser is open — rate the output in the UI, then close.\n');

  saveSession({
    type: 'train',
    character: charName,
    animation: animName,
    outputDir: trainDir,
  });

  // Keep browser open for manual feedback
  await new Promise(() => {});
}

async function compareAll(charName) {
  console.log(`\n  Building comparison view for "${charName}"...\n`);

  const serverUp = await waitForServer();
  if (!serverUp) { console.log('Server not running'); process.exit(1); }

  // Fetch all data
  const charRes = await fetch(`${BASE_URL}/api/characters`);
  const charData = await charRes.json();
  const animations = charData.animations;

  // Build comparison HTML with Breezy reference side-by-side
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

  let rows = '';
  for (const [animName, animConfig] of Object.entries(animations)) {
    const breezyPath = path.join(ASSETS_DIR, animConfig.breezyFile || '');
    const charPath = path.join(ASSETS_DIR, `${charName}-${animName}.png`);
    const hasBreezy = animConfig.breezyFile && fs.existsSync(breezyPath);
    const hasChar = fs.existsSync(charPath);

    rows += `
      <div style="display:flex;gap:16px;align-items:flex-start;margin:12px 0;padding:16px;background:#12121a;border-radius:12px;border:1px solid #2a2a3a">
        <div style="min-width:120px">
          <div style="font-family:monospace;font-size:12px;font-weight:700;color:#e8e8f0">${animName}</div>
          <div style="font-family:monospace;font-size:9px;color:#6a6a80;margin-top:2px">${animConfig.frames}f @ ${animConfig.fps}fps</div>
          <div style="font-family:monospace;font-size:8px;color:#44445a;margin-top:4px;max-width:120px;word-wrap:break-word">${animConfig.action}</div>
        </div>
        <div style="flex:1">
          <div style="font-family:monospace;font-size:9px;color:#6a6a80;margin-bottom:4px">BREEZY REF</div>
          ${hasBreezy ? `<img src="${toDataUri(breezyPath)}" style="max-width:100%;height:80px;image-rendering:pixelated;border-radius:4px;background:#1a1a28" />` : '<div style="color:#44445a;font-size:10px">—</div>'}
        </div>
        <div style="flex:1">
          <div style="font-family:monospace;font-size:9px;color:${hasChar ? '#00ff88' : '#ff2244'};margin-bottom:4px">${charName.toUpperCase()}</div>
          ${hasChar ? `<img src="${toDataUri(charPath)}" style="max-width:100%;height:80px;image-rendering:pixelated;border-radius:4px;background:#1a1a28" />` : '<div style="color:#44445a;font-size:10px;padding:20px 0">Not generated</div>'}
        </div>
      </div>`;
  }

  const compareHTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { background:#0a0a0f; color:#e8e8f0; font-family:'Outfit',system-ui,sans-serif; padding:32px; margin:0; }
</style></head><body>
  <div style="font-family:monospace;font-size:16px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#ff4400;margin-bottom:20px">
    ${charName} vs Breezy — Side by Side
  </div>
  ${rows}
</body></html>`;

  const compareDir = path.join(SCREENSHOTS_DIR, `compare-${charName}-${timestamp()}`);
  fs.mkdirSync(compareDir, { recursive: true });

  fs.writeFileSync(path.join(compareDir, 'compare.html'), compareHTML);

  await page.setContent(compareHTML);
  await page.waitForTimeout(500);

  const shotPath = path.join(compareDir, 'comparison.png');
  await page.screenshot({ path: shotPath, fullPage: true });

  console.log(`  Comparison: ${shotPath}`);
  console.log(`  HTML: ${path.join(compareDir, 'compare.html')}\n`);

  saveSession({ type: 'compare', character: charName, screenshotPath: shotPath });

  await browser.close();
  return { screenshotPath: shotPath, compareDir };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || 'open';

(async () => {
  try {
    switch (command) {
      case 'open':
        await openUI();
        break;
      case 'screenshot':
        await screenshot(args[1]);
        break;
      case 'review':
        if (!args[1]) { console.log('Usage: viewer.js review <character>'); process.exit(1); }
        await reviewCharacter(args[1]);
        break;
      case 'train':
        if (!args[1] || !args[2]) { console.log('Usage: viewer.js train <character> <animation>'); process.exit(1); }
        await trainAnimation(args[1], args[2]);
        break;
      case 'compare':
        if (!args[1]) { console.log('Usage: viewer.js compare <character>'); process.exit(1); }
        await compareAll(args[1]);
        break;
      default:
        console.log('Commands: open, screenshot, review <char>, train <char> <anim>, compare <char>');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();

// Export for programmatic use
module.exports = { openUI, screenshot, reviewCharacter, trainAnimation, compareAll };
