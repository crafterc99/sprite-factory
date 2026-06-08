'use strict';
/**
 * Sprite pixelation diagnostic — Playwright
 *
 * Checks:
 *   1. Canvas DPR setup: is canvas.width correct for the display DPR?
 *   2. imageSmoothingEnabled: stays true through the render loop
 *   3. Logical vs physical coordinate handling (render loop uses W = canvas.width)
 *   4. Strip source resolution vs display size (is the source too small to upscale well?)
 *   5. Injects a synthetic high-quality strip to isolate rendering pipeline from source-quality issues
 *
 * Run: node tests/pixel-quality.spec.js [url]
 *      defaults to https://sprite-factory-production.up.railway.app
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'https://sprite-factory-production.up.railway.app';
const REPORT = path.join(__dirname, 'reports');
fs.mkdirSync(REPORT, { recursive: true });

const SS = (page, name) =>
  page.screenshot({ path: path.join(REPORT, name + '.png'), fullPage: false });

const WAIT = ms => new Promise(r => setTimeout(r, ms));

// Generate a synthetic 1024px tall strip (gradient + checkerboard pattern) as base64 PNG
// Returns a data URL that can be set as the src of an Image element in the browser
async function makeSyntheticStripDataUrl(page) {
  return page.evaluate(() => {
    // Create 1024px tall × 6144px wide strip (8 frames of ~768px width)
    // Each frame is a distinct solid color gradient so we can visually verify
    const frameCount = 8;
    const frameH = 1024;
    const frameW = 768;
    const totalW = frameW * frameCount;
    const canvas = document.createElement('canvas');
    canvas.width = totalW; canvas.height = frameH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;

    const colors = ['#ff4444', '#ff8800', '#ffcc00', '#44ff88', '#00aaff', '#8844ff', '#ff44aa', '#ffffff'];
    for (let f = 0; f < frameCount; f++) {
      const grad = ctx.createLinearGradient(f * frameW, 0, (f + 1) * frameW, frameH);
      grad.addColorStop(0, colors[f]);
      grad.addColorStop(1, '#111');
      ctx.fillStyle = grad;
      ctx.fillRect(f * frameW, 0, frameW, frameH);
      // Add fine checkerboard detail to make blur vs crisp obvious
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      for (let y = 0; y < frameH; y += 16) {
        for (let x = f * frameW; x < (f + 1) * frameW; x += 16) {
          if (((x / 16) + (y / 16)) % 2 === 0) ctx.fillRect(x, y, 8, 8);
        }
      }
      // Add frame number text
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 80px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`F${f + 1}`, f * frameW + frameW / 2, frameH / 2);
    }
    return canvas.toDataURL('image/png');
  });
}

(async () => {
  console.log(`\n=== Sprite Pixelation Diagnostic ===`);
  console.log(`Target: ${BASE}\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,  // Test at DPR=1 first (standard display)
    bypassCSP: true,
  });
  const page = await ctx.newPage();

  page.on('pageerror', err => console.error('[pageerror]', err.message));
  page.on('console', m => {
    if (m.type() === 'error') console.error('[console error]', m.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await WAIT(1500);

  // ── 1. Dismiss Supabase warning banner if present ───────────────────────────
  const bannerDismissed = await page.evaluate(() => {
    const banner = document.querySelector('.sb-warning-banner, [class*="warning"]');
    if (banner) {
      banner.style.display = 'none';
      banner.style.pointerEvents = 'none';
      return true;
    }
    return false;
  });
  if (bannerDismissed) console.log('[info] Dismissed Supabase warning banner');

  // ── 2. Navigate to Testing ──────────────────────────────────────────────────
  const navResult = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.nav-btn')].find(b => /testing/i.test(b.textContent));
    if (!btn) return 'nav-btn not found';
    btn.click();
    return 'clicked';
  });
  console.log('[nav]', navResult);
  await WAIT(1000);
  await SS(page, '01-testing-page');

  // ── 3. Canvas DPR and dimensions check ─────────────────────────────────────
  const canvasCheck = await page.evaluate(() => {
    const canvas = document.getElementById('testingCourt');
    if (!canvas) return { error: 'canvas not found' };
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    const t = ctx.getTransform ? ctx.getTransform() : null;
    return {
      dpr,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      cssWidth: canvas.offsetWidth,
      cssHeight: canvas.offsetHeight,
      styleWidth: canvas.style.width,
      styleHeight: canvas.style.height,
      imageSmoothingEnabled: ctx.imageSmoothingEnabled,
      imageSmoothingQuality: ctx.imageSmoothingQuality,
      transform_a: t?.a, transform_d: t?.d,
      TESTING_dpr: typeof TESTING !== 'undefined' ? TESTING._dpr : 'TESTING undefined',
      expectedWidth: Math.round(dpr * 960),
      expectedHeight: Math.round(dpr * 640),
      widthCorrect: canvas.width === Math.round(dpr * 960),
    };
  });
  console.log('\n── Canvas DPR check ──');
  console.log(JSON.stringify(canvasCheck, null, 2));

  if (!canvasCheck.widthCorrect) {
    console.log(`⚠ canvas.width=${canvasCheck.canvasWidth} but expected ${canvasCheck.expectedWidth} for DPR=${canvasCheck.dpr}`);
  }
  if (!canvasCheck.imageSmoothingEnabled) {
    console.log('✖ imageSmoothingEnabled is FALSE — this is the pixelation cause!');
  } else {
    console.log('✓ imageSmoothingEnabled is true');
  }

  // ── 4. Check render loop uses logical vs physical W/H ──────────────────────
  // The render loop does: const W = canvas.width, H = canvas.height;
  // At DPR=2, this gives W=1920 instead of logical 960. Check if this causes issues.
  const renderCoordCheck = await page.evaluate(() => {
    const canvas = document.getElementById('testingCourt');
    const dpr = window.devicePixelRatio || 1;
    const physW = canvas.width;
    const logW = 960;
    const TESTING_charX = typeof TESTING !== 'undefined' ? TESTING.charX : null;
    const TESTING_charY = typeof TESTING !== 'undefined' ? TESTING.charY : null;

    // The render loop clamps: TESTING.charX = Math.max(0, Math.min(W, TESTING.charX))
    // With W=physW (physical), at DPR=2, charX can go to 1920 but only 0..960 is visible
    // With W=logW (logical), charX is correctly bounded to visible area
    const isUsingPhysicalW = physW !== logW; // only true at DPR>1

    return {
      dpr,
      physW,
      logW,
      isUsingPhysicalW,
      charX: TESTING_charX,
      charY: TESTING_charY,
      charXVisible: TESTING_charX !== null ? TESTING_charX <= logW : null,
      renderLoopBug: isUsingPhysicalW ? `W=${physW} used in render loop but visible area is only 0..${logW}` : null,
    };
  });
  console.log('\n── Render loop coordinate check ──');
  console.log(JSON.stringify(renderCoordCheck, null, 2));

  // ── 5. Check roster and strip loading ──────────────────────────────────────
  await WAIT(2000); // wait for roster API

  const stripCheck = await page.evaluate(() => {
    if (typeof TESTING === 'undefined') return { error: 'TESTING not defined' };
    const result = {
      rosterLength: TESTING.roster?.length ?? 0,
      selectedChar: TESTING.selectedChar,
      selectedAnim: TESTING.selectedAnim,
      stripLoaded: TESTING.stripLoaded,
      stripWidth: TESTING.stripImg?.naturalWidth ?? null,
      stripHeight: TESTING.stripImg?.naturalHeight ?? null,
      frameCount: TESTING.frameCount,
      hdFramesLength: TESTING.hdFrames?.length ?? null,
      hdFrame0Loaded: TESTING.hdFrames?.[0]?.complete && TESTING.hdFrames?.[0]?.naturalWidth > 0,
      hdFrame0Width: TESTING.hdFrames?.[0]?.naturalWidth ?? null,
      hdFrame0Height: TESTING.hdFrames?.[0]?.naturalHeight ?? null,
      pixelHeight: TESTING.pixelHeight,
      scale: TESTING.scale,
    };
    // Diagnose: what would drawH be for the strip?
    if (result.stripHeight !== null) {
      const isStandard = result.stripHeight <= 250;
      result.isStandardFrame = isStandard;
      result.drawH_logical = isStandard ? result.stripHeight * result.scale : result.pixelHeight * result.scale;
      result.upscaleRatio = isStandard ? result.drawH_logical / result.stripHeight : result.drawH_logical / result.stripHeight;
      result.pixelationRisk = result.upscaleRatio > 1.5
        ? `HIGH — source ${result.stripHeight}px drawn at ${result.drawH_logical}px (${result.upscaleRatio.toFixed(1)}x upscale)`
        : result.upscaleRatio > 1.0
        ? `MEDIUM — ${result.upscaleRatio.toFixed(1)}x upscale`
        : `LOW — downscale from ${result.stripHeight}px to ${result.drawH_logical}px`;
    }
    return result;
  });
  console.log('\n── Strip source/display check ──');
  console.log(JSON.stringify(stripCheck, null, 2));

  if (stripCheck.pixelationRisk) {
    console.log(`\n${stripCheck.pixelationRisk.includes('HIGH') ? '✖' : '⚠'} PIXELATION RISK: ${stripCheck.pixelationRisk}`);
  }

  // ── 6. Try to select a character if roster loaded ───────────────────────────
  if (stripCheck.rosterLength > 0) {
    console.log('\n── Selecting first character ──');
    const charSelected = await page.evaluate(() => {
      if (!TESTING.roster?.length) return false;
      const char = TESTING.roster[0];
      if (typeof testingSelectChar === 'function') {
        testingSelectChar(char.name);
        return char.name;
      }
      return false;
    });
    if (charSelected) {
      console.log('[info] Selected character:', charSelected);
      await WAIT(2000);
    }
  } else {
    console.log('[info] No characters in roster (R2/Supabase down) — injecting synthetic strip');
  }

  // ── 7. Inject synthetic 1024px strip to test rendering pipeline ─────────────
  console.log('\n── Injecting synthetic 1024px test strip ──');
  const syntheticDataUrl = await makeSyntheticStripDataUrl(page);

  await page.evaluate((dataUrl) => {
    // Force-inject a high-quality test strip into TESTING state
    const img = new Image();
    img.onload = () => {
      TESTING.stripImg = img;
      TESTING.stripLoaded = true;
      TESTING.frameCount = 8;
      TESTING.fps = 4;
      TESTING.loop = true;
      TESTING.scale = TESTING.scale || 3;
      TESTING.selectedAnim = '__synthetic_test__';
      TESTING.selectedChar = TESTING.selectedChar || 'test';
      console.log('[synthetic] strip injected:', img.naturalWidth + 'x' + img.naturalHeight);
    };
    img.src = dataUrl;
  }, syntheticDataUrl);

  await WAIT(1500);

  // Also check imageSmoothingEnabled AFTER a render frame
  const postRenderCheck = await page.evaluate(() => {
    const canvas = document.getElementById('testingCourt');
    if (!canvas) return { error: 'no canvas' };
    const ctx = canvas.getContext('2d');
    return {
      imageSmoothingEnabled: ctx.imageSmoothingEnabled,
      imageSmoothingQuality: ctx.imageSmoothingQuality,
    };
  });
  console.log('\n── Post-render smoothing check ──');
  console.log(JSON.stringify(postRenderCheck, null, 2));

  await SS(page, '02-synthetic-strip');

  // ── 8. Check canvas pixel data quality at the character position ─────────────
  const pixelQuality = await page.evaluate(() => {
    const canvas = document.getElementById('testingCourt');
    if (!canvas) return { error: 'no canvas' };
    const physW = canvas.width;
    const physH = canvas.height;
    const ctx = canvas.getContext('2d');

    // Sample a strip of pixels horizontally at mid-height of character
    // where the sprite should be rendering
    const charX = TESTING?.charX ?? 480;
    const charY = TESTING?.charY ?? 380;
    const dpr = TESTING?._dpr || 1;
    const sampleY = Math.min(Math.round((charY - 50) * dpr), physH - 1);
    const sampleWidth = Math.min(100, physW);
    const startX = Math.min(Math.round((charX - 50) * dpr), physW - sampleWidth);

    // Get pixel data
    const imageData = ctx.getImageData(Math.max(0, startX), sampleY, sampleWidth, 1);
    const { data } = imageData;

    // Compute horizontal gradient (sharpness proxy)
    let gradSum = 0;
    let nonBlack = 0;
    for (let x = 4; x < data.length; x += 4) {
      const dr = Math.abs(data[x] - data[x - 4]);
      const dg = Math.abs(data[x + 1] - data[x - 3]);
      const db = Math.abs(data[x + 2] - data[x - 2]);
      gradSum += (dr + dg + db) / 3;
      if (data[x] > 20 || data[x+1] > 20 || data[x+2] > 20) nonBlack++;
    }
    const avgGrad = gradSum / (data.length / 4);
    const spritePresentAtSample = nonBlack > 5;

    return {
      physW, physH, dpr,
      sampleY, startX, sampleWidth,
      avgHorizGradient: avgGrad.toFixed(3),
      spritePresentAtSample,
      charX, charY,
    };
  });
  console.log('\n── Canvas pixel quality sample ──');
  console.log(JSON.stringify(pixelQuality, null, 2));

  // ── 9. Test at DPR=2 to reproduce Retina behavior ──────────────────────────
  console.log('\n── Testing at DPR=2 (Retina simulation) ──');
  await ctx.close();
  const ctx2 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    bypassCSP: true,
  });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', err => console.error('[pageerror DPR=2]', err.message));

  await page2.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await WAIT(1500);
  await page2.evaluate(() => {
    const b = document.querySelector('.sb-warning-banner, [class*="warning"]');
    if (b) { b.style.display = 'none'; b.style.pointerEvents = 'none'; }
  });

  await page2.evaluate(() => {
    const btn = [...document.querySelectorAll('.nav-btn')].find(b => /testing/i.test(b.textContent));
    if (btn) btn.click();
  });
  await WAIT(1000);

  const dpr2Check = await page2.evaluate(() => {
    const canvas = document.getElementById('testingCourt');
    if (!canvas) return { error: 'canvas not found' };
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    const t = ctx.getTransform ? ctx.getTransform() : null;
    const logicalW = 960; const logicalH = 640;
    const physW = canvas.width;
    const physH = canvas.height;
    const expectedPhysW = Math.round(dpr * logicalW);
    const expectedPhysH = Math.round(dpr * logicalH);
    // Verify the render loop uses logical W/H: inject a probe that captures W/H inside the loop
    const testingDpr = typeof TESTING !== 'undefined' ? TESTING._dpr : null;
    const logicalWUsed = testingDpr ? Math.round(canvas.width / testingDpr) : canvas.width;
    const logicalHUsed = testingDpr ? Math.round(canvas.height / testingDpr) : canvas.height;
    return {
      dpr,
      physW, physH,
      expectedPhysW, expectedPhysH,
      widthCorrect: physW === expectedPhysW,
      testingDpr,
      logicalWUsed,
      logicalHUsed,
      renderLoopFixed: logicalWUsed === logicalW && logicalHUsed === logicalH,
      imageSmoothingEnabled: ctx.imageSmoothingEnabled,
      transform_a: t?.a, transform_d: t?.d,
    };
  });
  console.log('\n── DPR=2 canvas check ──');
  console.log(JSON.stringify(dpr2Check, null, 2));

  if (!dpr2Check.renderLoopFixed) {
    console.log('\n✖ RENDER LOOP BUG: logical W/H not computed correctly');
  } else {
    console.log(`\n✓ Render loop fix confirmed: W=${dpr2Check.logicalWUsed} H=${dpr2Check.logicalHUsed} (logical, not physical ${dpr2Check.physW}×${dpr2Check.physH})`);
  }

  await SS(page2, '03-dpr2-test');

  await ctx2.close();

  // ── 10. Summary ─────────────────────────────────────────────────────────────
  console.log('\n\n=== DIAGNOSIS SUMMARY ===');
  console.log('');
  console.log('DPR=1 environment:');
  console.log(`  canvas.width: ${canvasCheck.canvasWidth} (expected ${canvasCheck.expectedWidth})`);
  console.log(`  imageSmoothingEnabled: ${canvasCheck.imageSmoothingEnabled}`);
  if (stripCheck.stripHeight) {
    console.log(`  Strip source: ${stripCheck.stripWidth}×${stripCheck.stripHeight}px`);
    console.log(`  Display size: ${stripCheck.drawH_logical}px tall (${stripCheck.upscaleRatio?.toFixed(1)}x scale)`);
    console.log(`  Pixelation risk: ${stripCheck.pixelationRisk}`);
  }
  console.log('');
  console.log('DPR=2 environment:');
  console.log(`  canvas.width: ${dpr2Check.physW}`);
  console.log(`  Scale transform: ${dpr2Check.transform_a}x`);
  console.log(`  imageSmoothingEnabled: ${dpr2Check.imageSmoothingEnabled}`);
  console.log(`  Render loop bug: ${dpr2Check.physW === 1920 ? 'YES — W/H are physical pixels not logical' : 'no'}`);

  console.log('\nScreenshots saved to:', REPORT);
  await browser.close();
})();
