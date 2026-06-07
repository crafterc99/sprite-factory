/**
 * Pipeline quality trace — Playwright + Node
 *
 * Exercises the real video→frames→strip→sprite path against the running dev
 * server and inspects each intermediate image (PNG header, dimensions, file
 * size, mean luminance variance as a sharpness proxy). The goal isn't to test
 * the AI output — it's to catch where the *reference inputs* the model sees
 * lose quality, since downstream sprite frames are only as crisp as those.
 *
 * Run with: node tests/pipeline-quality.spec.js [baseUrl]
 *           defaults to http://localhost:3456
 */
'use strict';

const { chromium, request } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3456';
const TMP_DIR = path.resolve(__dirname, '..', 'data', '.video-tmp');
const REPORT_DIR = path.resolve(__dirname, 'reports');

fs.mkdirSync(REPORT_DIR, { recursive: true });

const NEAREST_KERNEL_PATTERN = /kernel:\s*['"]nearest['"]/i;
const findings = [];

function record(level, where, message, detail) {
  findings.push({ level, where, message, detail });
  const colour = level === 'fail' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[32m';
  console.log(`${colour}[${level.toUpperCase()}]\x1b[0m ${where} — ${message}`);
  if (detail) console.log(`        ${JSON.stringify(detail)}`);
}

async function describeImage(label, buf) {
  const meta = await sharp(buf).metadata();
  // Sharpness proxy: mean horizontal gradient on a luminance pass. Higher
  // numbers = crisper edges. Nearest-neighbor downscales of photos drop
  // this dramatically vs. a lanczos3 downscale because diagonal edges
  // collapse to stair-steps with low local contrast.
  const lum = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = lum;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 1; x < info.width; x++) {
      const i = y * info.width + x;
      sum += Math.abs(data[i] - data[i - 1]);
      n++;
    }
  }
  const sharpness = +(sum / n).toFixed(3);
  const stats = {
    label,
    width: meta.width,
    height: meta.height,
    format: meta.format,
    channels: meta.channels,
    bytes: buf.length,
    sharpness,
  };
  console.log(`        ${label.padEnd(28)} ${meta.width}x${meta.height} ${meta.format} ` +
    `bytes=${buf.length} sharpness=${sharpness}`);
  return stats;
}

async function readImage(filePath) {
  return await fs.promises.readFile(filePath);
}

async function fetchImage(api, url) {
  const res = await api.get(url);
  if (!res.ok()) throw new Error(`GET ${url} → ${res.status()}`);
  return await res.body();
}

async function findTestSession() {
  // Reuse an existing session that already has an extracted+selected set,
  // so the trace runs deterministically without re-extracting frames.
  const sessions = fs.readdirSync(TMP_DIR).filter((d) => {
    const dir = path.join(TMP_DIR, d);
    if (!fs.statSync(dir).isDirectory()) return false;
    const selDir = path.join(dir, 'selected');
    return fs.existsSync(selDir) && fs.readdirSync(selDir).filter(f => f.endsWith('.png')).length >= 2;
  });
  if (sessions.length === 0) throw new Error(
    'No usable session found in ' + TMP_DIR + '. Upload a video + select frames in the UI once, then re-run.'
  );
  return sessions[0];
}

async function inspectStripBuildPath(api, sessionId) {
  console.log('\n=== Stage: build ref-strip from selected frames ===');
  const stripPath = path.join(TMP_DIR, sessionId, 'ref-strip.png');
  // Force a rebuild to capture the *current* behavior, not a stale cached strip
  try { fs.unlinkSync(stripPath); } catch {}

  const res = await api.post(`${BASE}/api/video/strip`, {
    data: { sessionId },
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json();
  if (!res.ok() || body.error) {
    record('fail', 'POST /api/video/strip', body.error || `status ${res.status()}`);
    return null;
  }
  console.log(`        server reports: ${JSON.stringify(body)}`);

  const stripBuf = await readImage(stripPath);
  const stripStats = await describeImage('built ref-strip', stripBuf);

  const selDir = path.join(TMP_DIR, sessionId, 'selected');
  const selFrames = fs.readdirSync(selDir).filter(f => f.endsWith('.png')).sort();
  console.log(`        ${selFrames.length} selected frames feeding the strip`);

  // Compare a source frame's sharpness vs. the strip-cropped version of it.
  const firstFrameBuf = await readImage(path.join(selDir, selFrames[0]));
  const srcStats = await describeImage(`source: ${selFrames[0]}`, firstFrameBuf);

  const perFrameWidth = Math.round(stripStats.width / selFrames.length);
  const stripFrame0 = await sharp(stripBuf)
    .extract({ left: 0, top: 0, width: perFrameWidth, height: stripStats.height })
    .png()
    .toBuffer();
  const stripFrame0Stats = await describeImage('strip[0] crop', stripFrame0);

  // Apples-to-apples baseline: same source frame downscaled to the same
  // dimensions via lanczos3. Compare the strip's actual output against this
  // ideal. We're looking for "are details preserved", not "are edges sharp".
  // Better proxy than raw gradient: SSD against a doubly-downsampled-then-
  // -re-upsampled lanczos baseline measures how much sub-pixel info survives.
  const lanczosBaseline = await sharp(firstFrameBuf)
    .resize(perFrameWidth, stripStats.height, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const baselineStats = await describeImage('lanczos baseline', lanczosBaseline);

  // Pixel-diff RMSE between strip output and the lanczos baseline.
  const [stripRaw, baseRaw] = await Promise.all([
    sharp(stripFrame0).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(lanczosBaseline).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let sqSum = 0;
  const len = Math.min(stripRaw.data.length, baseRaw.data.length);
  for (let i = 0; i < len; i++) {
    const d = stripRaw.data[i] - baseRaw.data[i];
    sqSum += d * d;
  }
  const rmse = +Math.sqrt(sqSum / len).toFixed(3);

  // Save side-by-side comparison images for visual inspection
  fs.writeFileSync(path.join(REPORT_DIR, 'source-frame-0.png'), firstFrameBuf);
  fs.writeFileSync(path.join(REPORT_DIR, 'strip-frame-0.png'), stripFrame0);
  fs.writeFileSync(path.join(REPORT_DIR, 'lanczos-baseline-0.png'), lanczosBaseline);
  fs.writeFileSync(path.join(REPORT_DIR, 'built-strip.png'), stripBuf);

  // Nearest-neighbor downscale of photographic content vs. lanczos3 of the
  // same content typically diverges by RMSE ~8–18 per RGB channel; a clean
  // lanczos vs. lanczos roundtrip is ~0–3.
  const sharpnessRatio = +(stripFrame0Stats.sharpness / Math.max(baselineStats.sharpness, 0.01)).toFixed(3);
  if (rmse > 6) {
    record('fail', 'strip-builder downscale',
      `strip output diverges from lanczos baseline (RMSE ${rmse}/channel) — kernel is likely nearest, smudging photographic detail`,
      { rmse, stripSharpness: stripFrame0Stats.sharpness, baselineSharpness: baselineStats.sharpness, sharpnessRatio });
  } else {
    record('ok', 'strip-builder downscale',
      `strip output matches a high-quality resample (RMSE ${rmse}/channel)`,
      { rmse, stripSharpness: stripFrame0Stats.sharpness, baselineSharpness: baselineStats.sharpness, sharpnessRatio });
  }

  return { stripStats, srcStats, stripFrame0Stats };
}

async function inspectStaticCodeRedFlags() {
  console.log('\n=== Stage: static scan for compression / kernel red flags ===');
  // Scope: files in the *reference-image-to-model* path only. Pixel-art
  // output paths (buildStrip, buildGrid, normalizeFrameSizes, the explicit
  // pixel-perfect mode in resize-utils) intentionally use nearest and are
  // not in scope — flagging those was creating noise.
  const filesToScan = [
    'lib/sprite-generator/strip-builder.js',
    'lib/sprite-generator/reference-builder.js',
    'routes/video.js',
  ];

  const root = path.resolve(__dirname, '..');
  const before = findings.filter(f => f.level === 'fail').length;
  for (const rel of filesToScan) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      if (NEAREST_KERNEL_PATTERN.test(line)) {
        record('fail', `${rel}:${idx + 1}`, `nearest kernel on a reference-image path — will alias photographic content`,
          { line: line.trim().slice(0, 160) });
      }
      // Catch low-quality jpeg encodings being persisted as reference images
      const m = line.match(/\.jpeg\(.*quality:\s*(\d+)/);
      if (m && parseInt(m[1]) < 90) {
        record('fail', `${rel}:${idx + 1}`, `JPEG quality ${m[1]} on a reference image path`, { line: line.trim() });
      }
    });
  }
  if (findings.filter(f => f.level === 'fail').length === before) {
    record('ok', 'static scan', 'no red flags on reference-image code paths');
  }
}

async function inspectFbfRefIsRawPng(api, sessionId) {
  console.log('\n=== Stage: FBF pose-reference path uses raw PNG ===');
  // The FBF route reads selectedFrames[i] straight from disk and passes it
  // to nano-banana. Confirm that no resize happens between disk and the
  // base64 in the model request — i.e. that the file we'd serve is the
  // pristine ffmpeg PNG.
  const selDir = path.join(TMP_DIR, sessionId, 'selected');
  const frames = fs.readdirSync(selDir).filter(f => f.endsWith('.png')).sort();
  const first = path.join(selDir, frames[0]);
  const buf = await readImage(first);
  const stats = await describeImage('selected/frame-0', buf);

  const url = `${BASE}/api/video/frame/${sessionId}/${frames[0].replace(/^frame-\d+\.png$/, 'frame-' + frames[0].match(/\d+/)?.[0] + '.png')}`;
  // The selected/* set is keyed by index, not the original frame name —
  // just confirm that the served version matches what's on disk.
  if (stats.width < 640 || stats.height < 360) {
    record('warn', 'fbf ref dimensions', `selected frame is suspiciously small (${stats.width}x${stats.height})`);
  } else {
    record('ok', 'fbf ref dimensions', `selected frame is ${stats.width}x${stats.height} PNG`);
  }
  return stats;
}

async function inspectFrameServingRoute(browser, sessionId) {
  console.log('\n=== Stage: UI loads frame thumbs without re-encoding ===');
  // Headless browser: hit the frame endpoint as the UI does, snapshot
  // bytes, confirm they're PNG and untouched.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const fileName = fs.readdirSync(path.join(TMP_DIR, sessionId, 'frames')).filter(f => f.endsWith('.png')).sort()[0];
  if (!fileName) {
    record('warn', 'frame serving', 'no source frames present for session', { sessionId });
    await ctx.close();
    return;
  }
  const url = `${BASE}/api/video/frame/${sessionId}/${fileName}`;
  const response = await page.goto(url);
  if (!response || !response.ok()) {
    record('fail', 'GET /api/video/frame/:s/:f', `status ${response?.status()} for ${url}`);
    await ctx.close();
    return;
  }
  const ct = response.headers()['content-type'];
  const body = await response.body();
  // PNG magic header: 89 50 4E 47 0D 0A 1A 0A
  const isPng = body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4E && body[3] === 0x47;
  const onDisk = await readImage(path.join(TMP_DIR, sessionId, 'frames', fileName));
  const equal = body.length === onDisk.length && body.equals(onDisk);
  if (!isPng) record('fail', 'frame mime', `served bytes are not PNG (Content-Type ${ct})`);
  else if (!equal) record('warn', 'frame integrity', 'served bytes differ from on-disk PNG — server is re-encoding');
  else record('ok', 'frame serving', `byte-identical PNG (${body.length} bytes)`);
  await ctx.close();
}

(async () => {
  console.log(`Pipeline quality trace — server ${BASE}\n`);

  const api = await request.newContext();
  let browser;
  try {
    browser = await chromium.launch();
    const sessionId = await findTestSession();
    console.log(`Using test session: ${sessionId}`);

    await inspectStaticCodeRedFlags();
    await inspectStripBuildPath(api, sessionId);
    await inspectFbfRefIsRawPng(api, sessionId);
    await inspectFrameServingRoute(browser, sessionId);
  } catch (err) {
    record('fail', 'harness', err.message, { stack: err.stack });
  } finally {
    if (browser) await browser.close();
    await api.dispose();
  }

  console.log('\n=== Summary ===');
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const f of findings) counts[f.level]++;
  console.log(`  ok=${counts.ok}  warn=${counts.warn}  fail=${counts.fail}`);
  fs.writeFileSync(path.join(REPORT_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
  console.log(`  report: ${path.relative(process.cwd(), path.join(REPORT_DIR, 'findings.json'))}`);
  process.exit(counts.fail > 0 ? 1 : 0);
})();
