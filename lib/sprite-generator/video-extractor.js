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
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const DEFAULT_FPS = 10;
const TEMP_DIR = path.resolve(__dirname, '../../.video-tmp');

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
 * Download a YouTube video to a local file using yt-dlp.
 */
function downloadYouTube(url, outputDir) {
  if (!checkDependency('yt-dlp')) {
    throw new Error('yt-dlp not installed. Run: brew install yt-dlp');
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, 'video.%(ext)s');

  console.log(chalk.cyan('  Downloading video...'));
  const result = spawnSync('yt-dlp', [
    '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    '--no-playlist',
    url,
  ], { stdio: 'pipe', timeout: 120000 });

  if (result.status !== 0) {
    throw new Error(`yt-dlp failed: ${result.stderr?.toString().substring(0, 200)}`);
  }

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
 * @param {string} videoPath - Path to local video file
 * @param {string} outputDir - Directory for output frame PNGs
 * @param {object} opts - { fps, start, duration, scale }
 * @returns {{ frames: string[], count: number }}
 */
function extractFrames(videoPath, outputDir, opts = {}) {
  const ffmpeg = getFFmpegPath();
  if (!ffmpeg) {
    throw new Error(
      'ffmpeg not found. Install it:\n' +
      '  macOS: brew install ffmpeg\n' +
      '  Or:    cd vance && npm install ffmpeg-static'
    );
  }

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const fps = opts.fps || DEFAULT_FPS;
  const outputPattern = path.join(outputDir, 'frame-%04d.png');

  // Build ffmpeg command (use resolved binary path)
  const args = ['-y'];

  // Start time
  if (opts.start) {
    args.push('-ss', opts.start);
  }

  args.push('-i', videoPath);

  // Duration
  if (opts.duration) {
    args.push('-t', String(opts.duration));
  }

  // Filter: fps + optional scale
  let filter = `fps=${fps}`;
  if (opts.scale) {
    filter += `,scale=${opts.scale}:-1`;
  }
  args.push('-vf', filter);

  args.push(outputPattern);

  console.log(chalk.gray(`  ${ffmpeg} ${args.join(' ')}`));

  const result = spawnSync(ffmpeg, args, {
    stdio: 'pipe',
    timeout: 300000, // 5 min
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || '';
    throw new Error(`ffmpeg failed: ${stderr.substring(0, 300)}`);
  }

  // List output frames
  const frames = fs.readdirSync(outputDir)
    .filter(f => f.match(/^frame-\d+\.png$/))
    .sort()
    .map(f => path.join(outputDir, f));

  return { frames, count: frames.length };
}

/**
 * Full extraction pipeline: handles URLs, local files, downloads.
 */
async function extract(source, outputDir, opts = {}) {
  console.log(chalk.cyan.bold('\n  Video Frame Extractor\n'));

  let videoPath = source;

  // Download if URL
  if (isUrl(source)) {
    const isYouTube = source.includes('youtube.com') || source.includes('youtu.be');
    if (isYouTube) {
      const dlDir = path.join(TEMP_DIR, 'downloads');
      videoPath = downloadYouTube(source, dlDir);
      console.log(chalk.green(`  Downloaded: ${path.basename(videoPath)}`));
    } else {
      // Direct video URL — download with curl
      fs.mkdirSync(TEMP_DIR, { recursive: true });
      videoPath = path.join(TEMP_DIR, 'direct-video.mp4');
      console.log(chalk.cyan('  Downloading video...'));
      execSync(`curl -L -o "${videoPath}" "${source}"`, { stdio: 'pipe', timeout: 60000 });
    }
  }

  // Extract frames
  const fps = opts.fps || DEFAULT_FPS;
  console.log(chalk.gray(`  Source: ${path.basename(videoPath)}`));
  console.log(chalk.gray(`  FPS: ${fps}`));
  if (opts.start) console.log(chalk.gray(`  Start: ${opts.start}`));
  if (opts.duration) console.log(chalk.gray(`  Duration: ${opts.duration}s`));

  const result = extractFrames(videoPath, outputDir, opts);
  console.log(chalk.green(`\n  Extracted ${result.count} frames → ${outputDir}`));

  return result;
}

// ─── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'extract' || args.length < 2) {
    console.log(chalk.cyan.bold('\n  Video Frame Extractor\n'));
    console.log(chalk.white('  Usage:'));
    console.log(chalk.gray('    node video-extractor.js extract <video-or-url> [options]\n'));
    console.log(chalk.white('  Options:'));
    console.log(chalk.gray('    --fps <n>        Frames per second (default: 10)'));
    console.log(chalk.gray('    --output <dir>   Output directory (default: ./frames/)'));
    console.log(chalk.gray('    --start <time>   Start time (e.g., 0:15 or 15)'));
    console.log(chalk.gray('    --duration <s>   Duration in seconds'));
    console.log(chalk.gray('    --scale <width>  Scale width (height auto)\n'));
    console.log(chalk.white('  Examples:'));
    console.log(chalk.gray('    node video-extractor.js extract highlights.mp4 --fps 10'));
    console.log(chalk.gray('    node video-extractor.js extract https://youtu.be/abc --fps 10 --start 0:15 --duration 3'));
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
    console.error(chalk.red(`\n  Error: ${err.message}`));
    process.exit(1);
  });
}

module.exports = { extract, extractFrames, downloadYouTube };
