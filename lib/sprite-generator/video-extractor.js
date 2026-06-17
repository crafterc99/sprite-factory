#!/usr/bin/env node
/**
 * Video Frame Extractor
 *
 * Extracts frames from basketball footage (or any video) using ffmpeg.
 * Supports local files and YouTube URLs (via yt-dlp).
 *
 * Usage:
 *   node video-extractor.js extract <video-path-or-url> --fps 10 --output ./frames/
 *   node video-extractor.js extract https://youtube.com/watch?v=... --fps 10 --start 0:15 --duration 3
 */
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_FPS = 10;
const TEMP_DIR = path.resolve(__dirname, '../../.video-tmp');

/**
 * Run a command asynchronously. Never blocks the Node event loop, so multiple
 * extractions/downloads can run truly in parallel while the server keeps
 * serving requests.
 */
function run(cmd, args, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)} timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 65536) stderr = stderr.slice(-32768); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(cmd)} failed (${code}): ${stderr.substring(stderr.length - 300)}`));
    });
  });
}

/**
 * Resolve the ffmpeg binary path.
 * Prefers system ffmpeg, falls back to ffmpeg-static npm package.
 */
function getFFmpegPath() {
  try {
    execSync('which ffmpeg', { stdio: 'pipe' });
    return 'ffmpeg';
  } catch {
    try {
      return require('ffmpeg-static');
    } catch {
      return null;
    }
  }
}

function checkDependency(cmd) {
  if (cmd === 'ffmpeg') return !!getFFmpegPath();
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a YouTube video to a local file using yt-dlp (async — does not
 * block the event loop while downloading).
 */
async function downloadYouTube(url, outputDir) {
  if (!checkDependency('yt-dlp')) {
    throw new Error('yt-dlp not installed. Run: brew install yt-dlp');
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, 'video.%(ext)s');

  console.log('  Downloading video...');
  await run('yt-dlp', [
    '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    '--no-playlist',
    url,
  ], { timeout: 120000 });

  // Find the downloaded file
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('video.'));
  if (files.length === 0) throw new Error('yt-dlp produced no output');
  return path.join(outputDir, files[0]);
}

/**
 * Check if a string looks like a URL.
 */
function isUrl(str) {
  return str.startsWith('http://') || str.startsWith('https://') || str.startsWith('www.');
}

/**
 * Extract frames from a video file using ffmpeg.
 *
 * Writes high-quality JPEGs (-q:v 2) instead of PNGs — encoding is several
 * times faster and files are ~10x smaller, so the browser gallery loads much
 * quicker with zero practical quality loss (the source video is already
 * lossy-compressed). The same single decode pass also emits small thumb-*.jpg
 * gallery thumbnails so the UI never has to download full frames to browse.
 *
 * Async — runs ffmpeg via spawn so concurrent extractions never block the
 * server or each other.
 *
 * @param {string} videoPath - Path to local video file
 * @param {string} outputDir - Directory for output frame JPEGs
 * @param {object} opts - { fps, start, duration, scale }
 * @returns {Promise<{ frames: string[], count: number }>}
 */
async function extractFrames(videoPath, outputDir, opts = {}) {
  const ffmpeg = getFFmpegPath();
  if (!ffmpeg) {
    throw new Error(
      'ffmpeg not found. Install it:\n' +
      '  macOS: brew install ffmpeg\n' +
      '  Or:    cd sprite-factory && npm install ffmpeg-static'
    );
  }

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const fps = opts.fps || DEFAULT_FPS;

  // Build ffmpeg command (use resolved binary path)
  const args = ['-y'];

  // Input-side fast seek + duration: applied before -i so ffmpeg jumps to the
  // keyframe instead of decoding everything up to the start point
  if (opts.start) args.push('-ss', opts.start);
  if (opts.duration) args.push('-t', String(opts.duration));

  args.push('-i', videoPath);

  // Skip audio/subtitle/data streams entirely and use all cores
  args.push('-an', '-sn', '-dn', '-threads', '0');

  // Output 1: full-resolution frames as lossless PNG. No -q:v flag needed —
  // PNG is always lossless. Zero chroma or block artifacts before the
  // green-screen key. Slightly larger files and slower to write than JPEG
  // but extraction quality is exact source fidelity.
  let filter = `fps=${fps}`;
  if (opts.scale) {
    filter += `,scale=${opts.scale}:-2:flags=lanczos`;
  }
  args.push('-vf', filter, path.join(outputDir, 'frame-%04d.png'));

  // Output 2: gallery thumbnails from the same decode pass — 480px tall with
  // lanczos so they stay sharp in the ~300px gallery cells on retina screens
  args.push('-vf', `fps=${fps},scale=-2:480:flags=lanczos`, '-q:v', '3', path.join(outputDir, 'thumb-%04d.jpg'));

  console.log(`  ${ffmpeg} ${args.join(' ')}`);

  await run(ffmpeg, args, { timeout: 300000 }); // 5 min

  // List output frames (thumbnails excluded)
  const frames = fs.readdirSync(outputDir)
    .filter(f => f.match(/^frame-\d+\.(png|jpe?g)$/i))
    .sort()
    .map(f => path.join(outputDir, f));

  return { frames, count: frames.length };
}

/**
 * Full extraction pipeline: handles URLs, local files, downloads.
 */
async function extract(source, outputDir, opts = {}) {
  console.log('\n  Video Frame Extractor\n');

  let videoPath = source;

  // Download if URL
  if (isUrl(source)) {
    const isYouTube = source.includes('youtube.com') || source.includes('youtu.be');
    if (isYouTube) {
      const dlDir = path.join(TEMP_DIR, 'downloads');
      videoPath = await downloadYouTube(source, dlDir);
      console.log(`  Downloaded: ${path.basename(videoPath)}`);
    } else {
      // Direct video URL — download with curl (async)
      fs.mkdirSync(TEMP_DIR, { recursive: true });
      videoPath = path.join(TEMP_DIR, 'direct-video.mp4');
      console.log('  Downloading video...');
      await run('curl', ['-L', '-o', videoPath, source], { timeout: 60000 });
    }
  }

  // Extract frames
  const fps = opts.fps || DEFAULT_FPS;
  console.log(`  Source: ${path.basename(videoPath)}`);
  console.log(`  FPS: ${fps}`);
  if (opts.start) console.log(`  Start: ${opts.start}`);
  if (opts.duration) console.log(`  Duration: ${opts.duration}s`);

  const result = await extractFrames(videoPath, outputDir, opts);
  console.log(`\n  Extracted ${result.count} frames → ${outputDir}`);

  return result;
}

// ─── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'extract' || args.length < 2) {
    console.log('\n  Video Frame Extractor\n');
    console.log('  Usage:');
    console.log('    node video-extractor.js extract <video-or-url> [options]\n');
    console.log('  Options:');
    console.log('    --fps <n>        Frames per second (default: 10)');
    console.log('    --output <dir>   Output directory (default: ./frames/)');
    console.log('    --start <time>   Start time (e.g., 0:15 or 15)');
    console.log('    --duration <s>   Duration in seconds');
    console.log('    --scale <width>  Scale width (height auto)\n');
    console.log('  Examples:');
    console.log('    node video-extractor.js extract highlights.mp4 --fps 10');
    console.log('    node video-extractor.js extract https://youtu.be/abc --fps 10 --start 0:15 --duration 3');
    process.exit(0);
  }

  const source = args[1];
  const getOpt = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const opts = {
    fps: getOpt('fps') ? parseInt(getOpt('fps')) : DEFAULT_FPS,
    start: getOpt('start'),
    duration: getOpt('duration'),
    scale: getOpt('scale'),
  };
  const outputDir = getOpt('output') || './frames/';

  extract(source, outputDir, opts).catch(err => {
    console.error(`\n  Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { extract, extractFrames, downloadYouTube, run };
