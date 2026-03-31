#!/usr/bin/env node
/**
 * Sprite Factory CLI
 * Agent-native CLI for controlling the Sprite Factory pipeline.
 * Outputs JSON by default for agent consumption.
 *
 * Usage: sf <command> [options]
 * Install: npm link  (then use `sf` from anywhere)
 */
const { Command } = require('commander');
const http = require('http');
const https = require('https');

const BASE_URL = process.env.SF_URL || 'http://localhost:3456';

// ─── HTTP helpers ────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const get  = (path)       => request('GET',    path);
const post = (path, body) => request('POST',   path, body);
const del  = (path)       => request('DELETE', path);

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function err(msg, detail) {
  console.error(JSON.stringify({ error: msg, detail }, null, 2));
  process.exit(1);
}

async function check(res, label) {
  if (res.status >= 400) err(`${label} failed (${res.status})`, res.body);
  return res.body;
}

// ─── CLI ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('sf')
  .description('Sprite Factory CLI — agent-native control for the sprite pipeline')
  .version('1.0.0')
  .option('--url <url>', 'Sprite Factory server URL', BASE_URL);

program.hook('preAction', (thisCommand) => {
  const url = thisCommand.opts().url || program.opts().url;
  if (url) process.env.SF_URL = url;
});

// ── characters ──────────────────────────────────────────────────────────

const chars = program.command('characters').alias('chars').description('Manage characters');

chars.command('list')
  .description('List all characters')
  .action(async () => {
    const res = await get('/api/characters');
    out(await check(res, 'characters list'));
  });

chars.command('get <name>')
  .description('Get character details')
  .action(async (name) => {
    const res = await get(`/api/character/${name}`);
    out(await check(res, 'character get'));
  });

chars.command('roster')
  .description('Get full roster with animation status')
  .action(async () => {
    const res = await get('/api/roster');
    out(await check(res, 'roster'));
  });

chars.command('contract <name>')
  .description('Get animation contract for a character')
  .action(async (name) => {
    const res = await get(`/api/animation-contract/${name}`);
    out(await check(res, 'contract'));
  });

// ── generate ─────────────────────────────────────────────────────────────

const gen = program.command('generate').alias('gen').description('Generate sprites');

gen.command('strip <character> <animation>')
  .description('Generate an animation strip (all frames in one call)')
  .option('-m, --model <model>', 'Model to use', 'gemini-3-pro-image-preview')
  .option('--prompt <prompt>', 'Custom prompt override')
  .action(async (character, animation, opts) => {
    console.error(`Generating ${animation} strip for ${character}...`);
    const res = await post('/api/generate', {
      character,
      animation,
      model: opts.model,
      customPrompt: opts.prompt,
    });
    out(await check(res, 'generate strip'));
  });

gen.command('fbf <character> <animation>')
  .description('Generate frame-by-frame (SSE stream, waits for completion)')
  .option('-m, --model <model>', 'Model to use', 'gemini-3-pro-image-preview')
  .action(async (character, animation, opts) => {
    console.error(`Generating ${animation} FBF for ${character}...`);
    // FBF uses SSE — collect all events
    const url = new URL('/api/generate-fbf', process.env.SF_URL || BASE_URL);
    const body = JSON.stringify({ character, animation, model: opts.model });
    const lib = url.protocol === 'https:' ? https : http;

    const events = [];
    await new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', chunk => {
          buf += chunk;
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6));
                events.push(ev);
                if (ev.type === 'frame_done') console.error(`  frame ${ev.frame} done`);
                if (ev.type === 'error') console.error(`  error: ${ev.message}`);
              } catch {}
            }
          }
        });
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const last = events[events.length - 1] || {};
    out({ done: true, events: events.length, last });
  });

gen.command('angles <character>')
  .description('Generate all 8 angle images for a character')
  .option('-m, --model <model>', 'Model to use', 'gemini-3-pro-image-preview')
  .action(async (character, opts) => {
    console.error(`Generating angles for ${character}...`);
    const res = await post('/api/generate/angles', { character, model: opts.model });
    out(await check(res, 'generate angles'));
  });

gen.command('frame <character> <animation> <frameIndex>')
  .description('Regenerate a single frame')
  .option('-m, --model <model>', 'Model to use', 'gemini-3-pro-image-preview')
  .action(async (character, animation, frameIndex, opts) => {
    const res = await post('/api/generate-frame', {
      character,
      animation,
      frameIndex: parseInt(frameIndex),
      model: opts.model,
    });
    out(await check(res, 'generate frame'));
  });

// ── pipeline ─────────────────────────────────────────────────────────────

const pipe = program.command('pipeline').alias('pipe').description('Run the full generation pipeline');

pipe.command('run <character>')
  .description('Run the full pipeline for a character (all animations)')
  .option('-m, --model <model>', 'Model override')
  .action(async (character, opts) => {
    console.error(`Running pipeline for ${character}...`);
    const res = await post('/api/pipeline/run', { character, model: opts.model });
    out(await check(res, 'pipeline run'));
  });

pipe.command('status <character>')
  .description('Get pipeline status for a character')
  .action(async (character) => {
    const res = await get(`/api/pipeline/status/${character}`);
    out(await check(res, 'pipeline status'));
  });

pipe.command('fill-gaps <character>')
  .description('Generate any missing animations for a character')
  .option('-m, --model <model>', 'Model override')
  .action(async (character, opts) => {
    console.error(`Filling gaps for ${character}...`);
    const res = await post(`/api/pipeline/fill-gaps/${character}`, { model: opts.model });
    out(await check(res, 'fill gaps'));
  });

pipe.command('bulk <animation> [characters...]')
  .description('Apply an animation to multiple characters at once')
  .option('-m, --model <model>', 'Model override', 'gemini-3-pro-image-preview')
  .option('-c, --concurrency <n>', 'Parallel jobs', '2')
  .action(async (animation, characters, opts) => {
    const chars = characters.length ? characters : undefined;
    if (!chars) return err('Specify at least one character');
    console.error(`Bulk generating ${animation} for: ${chars.join(', ')}`);
    const res = await post('/api/animation/apply-bulk', {
      animation,
      characters: chars,
      model: opts.model,
      concurrency: parseInt(opts.concurrency),
    });
    out(await check(res, 'bulk'));
  });

// ── evaluate ─────────────────────────────────────────────────────────────

const ev = program.command('evaluate').alias('eval').description('QA and evaluation');

ev.command('animation <character> <animation>')
  .description('Evaluate an animation (AI QC score)')
  .action(async (character, animation) => {
    const res = await post('/api/evaluate', { character, animation });
    out(await check(res, 'evaluate'));
  });

ev.command('audit <character>')
  .description('Full audit of all animations for a character')
  .action(async (character) => {
    const res = await get(`/api/audit/${character}`);
    out(await check(res, 'audit'));
  });

// ── export ───────────────────────────────────────────────────────────────

const exp = program.command('export').description('Export assets');

exp.command('soul-jam <character>')
  .description('Export character spritesheet to Soul Jam')
  .option('-o, --output <dir>', 'Output directory override')
  .action(async (character, opts) => {
    console.error(`Exporting ${character} to Soul Jam...`);
    const res = await post('/api/export/soul-jam', { character, outputDir: opts.output });
    out(await check(res, 'export'));
  });

exp.command('deploy <character>')
  .description('Deploy character to production')
  .action(async (character) => {
    const res = await post(`/api/pipeline/deploy/${character}`, {});
    out(await check(res, 'deploy'));
  });

// ── jobs ─────────────────────────────────────────────────────────────────

const jobs = program.command('jobs').description('Monitor generation jobs');

jobs.command('list')
  .description('List all active jobs')
  .action(async () => {
    const res = await get('/api/jobs');
    out(await check(res, 'jobs list'));
  });

jobs.command('get <id>')
  .description('Get details for a specific job')
  .action(async (id) => {
    const res = await get(`/api/jobs/${id}`);
    out(await check(res, 'job get'));
  });

// ── sprites ───────────────────────────────────────────────────────────────

program.command('sprites <character>')
  .description('List all sprites for a character')
  .action(async (character) => {
    const res = await get(`/api/sprites/${character}`);
    out(await check(res, 'sprites'));
  });

program.command('costs')
  .description('Show API cost tracking')
  .action(async () => {
    const res = await get('/api/costs');
    out(await check(res, 'costs'));
  });

program.command('status')
  .description('Check if the Sprite Factory server is running')
  .action(async () => {
    try {
      const res = await get('/api/characters');
      out({ online: true, url: process.env.SF_URL || BASE_URL, status: res.status });
    } catch (e) {
      out({ online: false, url: process.env.SF_URL || BASE_URL, error: e.message });
    }
  });

program.parse();
