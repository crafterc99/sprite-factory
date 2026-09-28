/**
 * Image model adapter — one call shape for every generation provider.
 *
 *   generateImage({ model, prompt, images: [path|Buffer...], quality })
 *     → { buffer, transparent, provider, model, cost }
 *
 * Providers:
 *   gemini  — Nano Banana Pro / 2 (existing NanaBananaClient, GEMINI_API_KEY).
 *             Returns a green (#00FF00) background → chroma-keyed downstream.
 *   openai  — GPT Image 2.5 Sunburst / Flare via /v1/images/edits with up to 16
 *             reference images (OPENAI_API_KEY). background:"transparent" → real
 *             alpha, no chroma key, no green fringe.
 *   mock    — MOCAP_MOCK=1 only: recolours the pose image so the full pipeline
 *             can be exercised offline.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const MODELS = [
  { id: 'gpt-image-2.5-sunburst',         provider: 'openai', label: 'GPT Image 2.5 Sunburst (precise edits)', transparent: true },
  { id: 'gpt-image-2.5-flare',            provider: 'openai', label: 'GPT Image 2.5 Flare (fast)',             transparent: true },
  { id: 'gemini-3-pro-image-preview',     provider: 'gemini', label: 'Nano Banana Pro (Gemini 3 Pro Image)',   transparent: false },
  { id: 'gemini-3.1-flash-image-preview', provider: 'gemini', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)', transparent: false },
];

// GPT Image 2.5 token rates (USD / 1M tokens), from the OpenAI model page
const OPENAI_RATES = { text: 5, image: 8, output: 30 };

const isMock = () => process.env.MOCAP_MOCK === '1';
const openaiKey = () => (process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '').trim();

function providerStatus() {
  return {
    openai: !!openaiKey(),
    gemini: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    mock: isMock(),
  };
}

function listModels() {
  const st = providerStatus();
  return MODELS.map((m) => ({ ...m, available: st.mock || !!st[m.provider] }));
}

function modelInfo(id) {
  return MODELS.find((m) => m.id === id) || MODELS[2];
}

async function toPngBuffer(img) {
  if (Buffer.isBuffer(img)) return sharp(img).png().toBuffer();
  return sharp(fs.readFileSync(img)).png().toBuffer();
}

// ── OpenAI rate limiting ───────────────────────────────────────────────────
// Low usage tiers cap "input-images per min" (e.g. 5). Calls are paced to the
// learned limit (from the 429 message or OPENAI_INPUT_IMAGES_PER_MIN), and a
// rate-limit 429 waits the "try again in Ns" OpenAI asks for. An exhausted
// quota ("no credits") fails immediately — waiting can't fix it.
const RL = {
  limit: +process.env.OPENAI_INPUT_IMAGES_PER_MIN || null,
  log: [],            // [{ t, n }] input images sent in the last 60s
  chain: Promise.resolve(),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inputImageLimit() { return RL.limit; }

/** Serialise + pace calls so n input images fit the per-minute budget. */
function acquire(n) {
  const run = RL.chain.then(async () => {
    for (;;) {
      const now = Date.now();
      RL.log = RL.log.filter((e) => now - e.t < 60000);
      const used = RL.log.reduce((a, e) => a + e.n, 0);
      if (!RL.limit || used + n <= RL.limit || !RL.log.length) break;
      await sleep(Math.max(250, 60000 - (now - RL.log[0].t) + 150));
    }
    RL.log.push({ t: Date.now(), n: Math.max(1, n) });
  });
  RL.chain = run.catch(() => {});
  return run;
}

function parseRateLimit(msg) {
  const lim = msg.match(/Limit (\d+)/);
  const wait = msg.match(/try again in ([\d.]+)\s*(ms|s)/i);
  return {
    limit: lim ? +lim[1] : null,
    waitMs: wait ? Math.ceil(+wait[1] * (wait[2].toLowerCase() === 'ms' ? 1 : 1000)) + 500 : 15000,
    perImages: /input-images/i.test(msg),
  };
}

// ── OpenAI (GPT Image 2.5) ─────────────────────────────────────────────────
async function openaiEdit({ model, prompt, images, size = '1024x1536', quality = 'high' }) {
  const key = openaiKey();
  if (!key) throw new Error('OPENAI_API_KEY is not set — add it in Railway → Variables');
  if (!images || !images.length) return openaiGenerateOnly({ key, model, prompt, size, quality });
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('background', 'transparent');
  form.append('output_format', 'png');
  form.append('n', '1');
  for (let i = 0; i < images.length; i++) {
    const buf = await toPngBuffer(images[i]);
    form.append('image[]', new Blob([buf], { type: 'image/png' }), `ref-${i}.png`);
  }
  let lastErr;
  for (let attempt = 0; attempt < 14; attempt++) {
    await acquire(images.length);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 240000);
    try {
      const res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.error?.message || 'request failed';
        const err = new Error(`OpenAI ${res.status}: ${msg}`);
        err.status = res.status;
        if (res.status === 429 && /credit|quota|billing/i.test(msg) && !/Rate limit/i.test(msg)) err.fatal = true;
        if (res.status === 429 && /Rate limit/i.test(msg)) {
          const rl = parseRateLimit(msg);
          if (rl.perImages && rl.limit) RL.limit = rl.limit;
          err.waitMs = rl.waitMs;
        }
        throw err;
      }
      const b64 = body?.data?.[0]?.b64_json;
      if (!b64) throw new Error('OpenAI returned no image');
      const u = body.usage || {};
      const imgIn = u.input_tokens_details?.image_tokens ?? 0;
      const txtIn = u.input_tokens_details?.text_tokens ?? Math.max(0, (u.input_tokens || 0) - imgIn);
      const cost = (txtIn * OPENAI_RATES.text + imgIn * OPENAI_RATES.image + (u.output_tokens || 0) * OPENAI_RATES.output) / 1e6;
      return { buffer: Buffer.from(b64, 'base64'), transparent: true, cost, usage: u };
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      const transient = err.name === 'AbortError' || !err.status || err.status === 429 || err.status >= 500;
      if (!transient) break;
      if (err.waitMs) { console.warn(`[openai] rate limited — waiting ${Math.round(err.waitMs / 1000)}s (limit ${RL.limit || '?'} input images/min)`); await sleep(err.waitMs); }
      else await sleep(Math.min(30000, 3000 * Math.pow(2, attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function openaiGenerateOnly({ key, model, prompt, size, quality }) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, quality, background: 'transparent', output_format: 'png', n: 1 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body?.error?.message || 'request failed'}`);
  const u = body.usage || {};
  const imgIn = u.input_tokens_details?.image_tokens ?? 0;
  const cost = (((u.input_tokens || 0) - imgIn) * OPENAI_RATES.text + imgIn * OPENAI_RATES.image + (u.output_tokens || 0) * OPENAI_RATES.output) / 1e6;
  return { buffer: Buffer.from(body.data[0].b64_json, 'base64'), transparent: true, cost, usage: u };
}

/**
 * Gemini aspectRatio/resolution → a GPT Image size (multiples of 16, 1:3–3:1,
 * 655,360–8,294,400 px, edges ≤ 3840).
 */
function gptSize(aspectRatio = '1:1', resolution = '1K') {
  const [a, b] = String(aspectRatio).split(':').map(Number);
  const r = Math.max(1 / 3, Math.min(3, a > 0 && b > 0 ? a / b : 1));
  const P = { '0.5K': 700000, '1K': 1100000, '2K': 4200000, '4K': 8200000 }[resolution] || 1100000;
  let w = Math.sqrt(P * r), h = Math.sqrt(P / r);
  const k = Math.min(1, 3840 / Math.max(w, h));
  w = Math.max(16, Math.round((w * k) / 16) * 16);
  h = Math.max(16, Math.round((h * k) / 16) * 16);
  while (w * h > 8294400) { w -= 16; h = Math.round((w / r) / 16) * 16; }
  while (w * h < 655360) { w += 16; h = Math.round((w / r) / 16) * 16; }
  return `${w}x${h}`;
}

// ── Gemini (Nano Banana) ───────────────────────────────────────────────────
async function geminiGenerate({ model, prompt, images }) {
  const { NanaBananaClient } = require('../sprite-generator/nano-banana');
  const { getImageCost, getInputCost } = require('../../middleware/cost-tracker');
  // NanaBananaClient reads reference images from disk
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-gem-'));
  try {
    const paths = await Promise.all(images.map(async (img, i) => {
      if (!Buffer.isBuffer(img)) return img;
      const p = path.join(tmpDir, `ref-${i}.png`);
      fs.writeFileSync(p, img);
      return p;
    }));
    const client = new NanaBananaClient({ model });
    const result = await client.generate(prompt, {
      referenceImages: paths, aspectRatio: '2:3', resolution: '1K', model, maxRetries: 1, timeoutMs: 120000,
    });
    return { buffer: result.imageBuffer, transparent: false, cost: getImageCost(model, '1K') + getInputCost(model, paths.length) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Mock ───────────────────────────────────────────────────────────────────
async function mockGenerate({ images, poseIndex = 1, model, poseBuf }) {
  // Treat the pose render as "the character": white → background, slight
  // size/offset jitter so the alignment stage has real work to do.
  const pose = poseIndex < 0 && poseBuf ? poseBuf : images[poseIndex] || images[0];
  const { data, info } = await sharp(await toPngBuffer(pose)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const transparent = modelInfo(model).transparent;
  for (let i = 0; i < data.length; i += 4) {
    const white = data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240;
    if (white) {
      if (transparent) data[i + 3] = 0; else { data[i] = 0; data[i + 1] = 255; data[i + 2] = 0; }
    } else {
      data[i] = Math.min(255, data[i] * 0.6 + 90); data[i + 1] = data[i + 1] * 0.5; data[i + 2] = data[i + 2] * 0.7 + 40;
    }
  }
  const jitter = (0.92 + Math.random() * 0.14) * Math.min(1, 1300 / info.height, 900 / info.width);
  const img = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(Math.round(info.width * jitter), Math.round(info.height * jitter)).png().toBuffer();
  const bg = transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 0, g: 255, b: 0, alpha: 1 };
  const buffer = await sharp({ create: { width: 1024, height: 1536, channels: 4, background: bg } })
    .composite([{ input: img, left: 60 + Math.round(Math.random() * 40), top: 80 + Math.round(Math.random() * 60) }])
    .png().toBuffer();
  return { buffer, transparent, cost: 0 };
}

/**
 * @param {object} o { model, prompt, images, quality, poseIndex }
 */
async function generateImage(o) {
  const info = modelInfo(o.model);
  if (isMock()) return { ...(await mockGenerate(o)), provider: 'mock', model: info.id };
  const out = info.provider === 'openai'
    ? await openaiEdit({ ...o, model: info.id })
    : await geminiGenerate({ ...o, model: info.id });
  return { ...out, provider: info.provider, model: info.id };
}

module.exports = { MODELS, listModels, modelInfo, providerStatus, generateImage, openaiEdit, gptSize, openaiKey, inputImageLimit, _rl: RL };
