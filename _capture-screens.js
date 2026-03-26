#!/usr/bin/env node
/**
 * Capture annotated screenshots of the Sprite Factory UI.
 * Uses Playwright for screenshots, Sharp for clean sidebar annotations.
 */
const { chromium } = require('playwright');
const sharp = require('../sprite-processor/node_modules/sharp');
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, '_screenshots');
const URL = 'http://localhost:3456';

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Select character + animation for all shots
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.char-card');
    if (cards.length > 0) cards[0].click();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.anim-btn');
    if (btns.length > 0) btns[0].click();
  });
  await page.waitForTimeout(1200);

  // === SCREEN 1: Main overview ===
  console.log('1. Main overview...');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const raw1 = await page.screenshot({ fullPage: false });
  await annotateWithMargin(raw1, '01-main-layout.png', 'MAIN LAYOUT — 3-panel design', [
    'LEFT: Character roster (3 characters) + 8 animation buttons (green dot = done)',
    'CENTER: Sprite preview + generation mode toggle (Strip / FBF / Auto-Test) + Generate button',
    'RIGHT: Cost tracker ($5.02 total), model breakdown, scale projections',
    'HEADER: Logo, mode tabs (Replicate/Video/New Character/Roster), running cost, model selector',
  ]);

  // === SCREEN 2: Reference images + prompt sections ===
  console.log('2. Reference images + prompt sections...');
  await page.evaluate(() => {
    const el = document.querySelector('.ref-images') || document.querySelector('[class*="ref-image"]');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    else window.scrollTo(0, 500);
  });
  await page.waitForTimeout(400);
  const raw2 = await page.screenshot({ fullPage: false });
  await annotateWithMargin(raw2, '02-reference-and-prompts.png', 'REFERENCE IMAGES + PROMPT EDITOR', [
    'IMG 1 — POSE REFERENCE: Breezy animation strip (gold standard poses to replicate)',
    'IMG 2 — CHARACTER: Full portrait of target character sent to Gemini API',
    'PROMPT SECTIONS: 6 toggleable blocks — Pose Replication, Image Description,',
    '   Body Position Rules, Character Swap, Output / Style, Size Consistency',
    'Each section has: checkbox toggle, editable textarea, [reset] link',
    'Sections control what instructions the AI receives per frame',
  ]);

  // === SCREEN 3: Prompt sections detail ===
  console.log('3. Prompt sections detail...');
  await page.evaluate(() => {
    const el = document.querySelector('.prompt-sections');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
  await page.waitForTimeout(400);
  const raw3 = await page.screenshot({ fullPage: false });
  await annotateWithMargin(raw3, '03-prompt-sections-detail.png', 'PROMPT SECTIONS — What each does', [
    'POSE REPLICATION: "Copy body position from Image 1 EXACTLY"',
    'IMAGE DESCRIPTION: Frame-specific pose (e.g. "ball at hip right hand")',
    'BODY POSITION: Arm/leg/weight matching rules',
    'CHARACTER SWAP: Face/outfit/skin tone transfer from Image 2',
    'OUTPUT / STYLE: Pixel art style, background color, outline rules',
    'SIZE CONSISTENCY: ~85% height fill, locked proportions, baseline anchoring',
    'RIGHT PANEL: Rate Output (1-5), feedback text, prompt history',
  ]);

  // === SCREEN 4: Auto-test mode ===
  console.log('4. Auto-test mode...');
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.gen-mode-btn');
    for (const b of btns) { if (b.textContent.includes('Auto')) b.click(); }
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const el = document.getElementById('replicateActions');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
  await page.waitForTimeout(300);
  const raw4 = await page.screenshot({ fullPage: false });
  await annotateWithMargin(raw4, '04-autotest-mode.png', 'AUTO-TEST MODE — Generate + Evaluate + Fix loop', [
    'Auto-Test button highlighted green = active mode',
    'BUDGET $: Maximum spend for this test run (default $1.00)',
    'MAX ITERS: How many generate-evaluate-fix cycles to run (default 5)',
    'Flow: Generate all frames → Evaluate quality (fill%, consistency, edge bleed)',
    '   → If FAIL: auto-apply prompt fixes → Regenerate with improved prompts',
    '   → If PASS (score >= 75): Deploy best strip to game assets',
    'Tracks best result across all iterations, deploys highest-scoring one',
  ]);

  // === SCREEN 5: Cost tracker detail ===
  console.log('5. Cost tracker...');
  await page.evaluate(() => {
    const el = document.querySelector('.cost-tracker') || document.getElementById('costTracker');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
  await page.waitForTimeout(400);
  const raw5 = await page.screenshot({ fullPage: false });
  await annotateWithMargin(raw5, '05-cost-tracker.png', 'COST TRACKER — API spend monitoring', [
    '$5.018 ALL-TIME: Total Gemini API spend across all sessions',
    'Session: $0.00 — Cost since page load',
    '66 GENERATIONS at $0.076 avg per generation',
    '$0.91 EST/CHARACTER — Projected cost for all 8 animations',
    'BY MODEL: Breakdown bars (Flash 2.5: $0.94, Pro 3: $2.45, Flash 3.1: $1.62)',
    'SCALE PROJECTIONS: 5 chars = $4.56, 10 = $9.12, 25 = $22.81, 50 = $45.62',
    'RECENT: Line-by-line log of every API call with cost',
  ]);

  // === SCREEN 6: Bottom panel (Build Grid + Generate All + Activity) ===
  console.log('6. Bottom panel...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  const raw6 = await page.screenshot({ fullPage: false });
  await annotateWithMargin(raw6, '06-bottom-actions.png', 'BOTTOM ACTIONS + ACTIVITY LOG', [
    'BUILD GRID SHEET: Combines all 8 animation strips into one sprite grid PNG',
    'GENERATE ALL: Runs generation for all 8 animations sequentially',
    'SIZE CONSISTENCY section: Anchoring rules for character height across frames',
    'ACTIVITY LOG: Timestamped log of all actions, errors, and results',
    'FRAME SELECTION WEIGHTS: Ball pos 41%, Motion 34%, Sharpness 16%, Spacing 14%',
  ]);

  await browser.close();
  console.log(`\nDone! Screenshots saved to: ${OUT_DIR}/`);
  fs.readdirSync(OUT_DIR).filter(f => !f.includes('raw')).sort().forEach(f => console.log(`  ${f}`));
}

/**
 * Annotate a screenshot by adding a labeled margin strip below it.
 */
async function annotateWithMargin(screenshotBuf, outputFile, title, bulletPoints) {
  const outputPath = path.join(OUT_DIR, outputFile);
  const meta = await sharp(screenshotBuf).metadata();
  const imgW = meta.width;
  const imgH = meta.height;

  // Margin area dimensions
  const lineH = 20;
  const padding = 16;
  const titleH = 28;
  const marginH = titleH + padding + (bulletPoints.length * lineH) + padding;

  // Build SVG for the margin annotation area
  let svg = `<svg width="${imgW}" height="${marginH}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${imgW}" height="${marginH}" fill="#0d0d18"/>`;
  svg += `<rect x="0" y="0" width="${imgW}" height="3" fill="#ff4400"/>`;

  // Title
  const escapedTitle = escXml(title);
  svg += `<text x="${padding}" y="${titleH}" font-family="monospace" font-size="16" font-weight="bold" fill="#ff4400">${escapedTitle}</text>`;

  // Bullet points
  for (let i = 0; i < bulletPoints.length; i++) {
    const y = titleH + padding + (i * lineH) + 14;
    const text = bulletPoints[i].startsWith('   ') ? bulletPoints[i] : '  ' + bulletPoints[i];
    const prefix = bulletPoints[i].startsWith('   ') ? '' : '> ';
    svg += `<text x="${padding}" y="${y}" font-family="monospace" font-size="12" fill="#b0b0c8">${escXml(prefix + text)}</text>`;
  }

  svg += `</svg>`;

  // Composite: original image on top, margin below
  await sharp({
    create: {
      width: imgW,
      height: imgH + marginH,
      channels: 4,
      background: { r: 13, g: 13, b: 24, alpha: 1 },
    },
  })
    .composite([
      { input: screenshotBuf, top: 0, left: 0 },
      { input: Buffer.from(svg), top: imgH, left: 0 },
    ])
    .png()
    .toFile(outputPath);

  console.log(`  + ${outputFile}`);
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

run().catch(err => { console.error(err); process.exit(1); });
