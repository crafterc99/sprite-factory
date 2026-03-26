/**
 * Nano Banana Pro API Client
 *
 * Uses Google's Gemini 3 Pro Image (Nano Banana Pro) via the @google/genai SDK.
 * Supports text-to-image and image-to-image with up to 14 reference images.
 *
 * Required env: GEMINI_API_KEY
 *
 * Model IDs:
 *   - Nano Banana Pro: gemini-3-pro-image-preview (best quality, $$$)
 *   - Nano Banana 2:   gemini-3.1-flash-image-preview (fast, cheaper)
 *   - Nano Banana:     gemini-2.5-flash-image (cheapest)
 */
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

/**
 * Race a promise against a timeout. Rejects with an error if the timeout fires first.
 * The original promise is left dangling (not cancelled) but we move on.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const MODELS = {
  pro: 'gemini-3-pro-image-preview',
  flash: 'gemini-3.1-flash-image-preview',
  legacy: 'gemini-2.5-flash-image',
};

class NanaBananaClient {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!this.apiKey) {
      throw new Error(
        'Gemini API key required. Set GEMINI_API_KEY env var.\n' +
        'Get your key at: https://aistudio.google.com/apikey'
      );
    }
    this.ai = new GoogleGenAI({
      apiKey: this.apiKey,
    });
    this.model = opts.model || MODELS.pro;
  }

  /**
   * Generate an image from text prompt + optional reference images.
   *
   * @param {string} prompt - Text prompt describing what to generate
   * @param {object} opts
   * @param {string[]} opts.referenceImages - Paths to reference image files
   * @param {string} opts.aspectRatio - e.g. "16:9", "1:1" (default: "16:9")
   * @param {string} opts.resolution - "1K", "2K", "4K" (default: "2K")
   * @param {string} opts.model - Override model ID
   * @returns {{ imageBuffer: Buffer, description: string }}
   */
  async generate(prompt, opts = {}) {
    const model = opts.model || this.model;
    const aspectRatio = opts.aspectRatio || '16:9';
    const resolution = opts.resolution || '2K';

    // Build content parts: reference images first, then text prompt
    const parts = [];

    // Add reference images if provided
    if (opts.referenceImages && opts.referenceImages.length > 0) {
      for (let i = 0; i < opts.referenceImages.length; i++) {
        const imgPath = opts.referenceImages[i];
        if (!fs.existsSync(imgPath)) {
          throw new Error(`Reference image not found: ${imgPath}`);
        }

        const imageData = fs.readFileSync(imgPath);
        const base64 = imageData.toString('base64');
        const ext = path.extname(imgPath).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.webp' ? 'image/webp'
          : 'image/png';

        parts.push({
          inlineData: {
            mimeType,
            data: base64,
          },
        });
      }
    }

    // Add text prompt
    parts.push({ text: prompt });

    // Make API call with retry for rate limits and transient errors
    const MAX_RETRIES = opts.maxRetries ?? 6;
    const TIMEOUT_MS = opts.timeoutMs || 90000; // 90s per attempt
    let response;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await withTimeout(
          this.ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: {
                aspectRatio,
                imageSize: resolution,
              },
            },
          }),
          TIMEOUT_MS,
          `API call timed out after ${TIMEOUT_MS / 1000}s (attempt ${attempt + 1})`
        );
        break; // Success — exit retry loop
      } catch (err) {
        const errMsg = err.message || '';
        const isRetryable = err.status === 429 ||
          err.status === 503 ||
          err.code === 429 ||
          err.code === 503 ||
          errMsg.includes('429') ||
          errMsg.includes('503') ||
          errMsg.includes('Service Unavailable') ||
          errMsg.includes('RESOURCE_EXHAUSTED') ||
          errMsg.includes('quota') ||
          errMsg.includes('exhausted') ||
          errMsg.includes('Too many requests') ||
          errMsg.includes('Retryable') ||
          errMsg.includes('UNAVAILABLE') ||
          errMsg.includes('overloaded') ||
          errMsg.includes('timed out') ||
          (err.name === 'ApiError' && (err.status === 429 || err.status === 503 || err.status >= 500));

        if (isRetryable && attempt < MAX_RETRIES) {
          // Start with longer delays: 5s, 10s, 20s, 40s, 60s, 60s
          const delay = Math.min(5000 * Math.pow(2, attempt) + Math.random() * 2000, 60000);
          console.log(`[NanaBanana] ${errMsg.includes('503') || errMsg.includes('Service Unavailable') ? 'Service unavailable' : 'Rate limited'} (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${(delay / 1000).toFixed(0)}s before retry...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        // Add helpful context to quota errors
        if (isRetryable) {
          throw new Error(
            `Gemini API quota exhausted after ${MAX_RETRIES} retries. ` +
            `Try: 1) Wait a few minutes  2) Switch to a cheaper model (--model flash or --model legacy)  ` +
            `3) Check quota at https://aistudio.google.com/apikey  ` +
            `Original error: ${errMsg.substring(0, 200)}`
          );
        }
        throw err;
      }
    }

    // Extract image from response
    const result = { imageBuffer: null, description: '', model, resolution };

    if (response.candidates && response.candidates[0]) {
      const candidate = response.candidates[0];
      const contentParts = candidate.content?.parts || [];

      for (const part of contentParts) {
        if (part.text) {
          result.description = part.text;
        }
        if (part.inlineData) {
          result.imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          result.mimeType = part.inlineData.mimeType;
        }
      }
    }

    if (!result.imageBuffer) {
      throw new Error('No image returned from Nano Banana Pro. Response: ' +
        JSON.stringify(response).substring(0, 500));
    }

    return result;
  }

  /**
   * Generate a sprite sheet from reference images + prompt.
   *
   * Pipeline A: Film-to-Sprite
   *   - referenceStrip = horizontal strip of real basketball frames
   *   - characterRef = character portrait image
   *
   * Pipeline B: Character Replication
   *   - referenceStrip = existing Breezy animation strip
   *   - characterRef = new character portrait
   *
   * @param {string} prompt - Sprite generation prompt
   * @param {string} referenceStrip - Path to pose/layout reference strip
   * @param {string} characterRef - Path to character portrait
   * @param {object} opts - { aspectRatio, resolution, model, outputPath }
   * @returns {{ outputPath: string, description: string }}
   */
  async generateSprite(prompt, referenceStrip, characterRef, opts = {}) {
    const referenceImages = [];

    // Image 1 = pose/layout reference strip
    if (referenceStrip && fs.existsSync(referenceStrip)) {
      referenceImages.push(referenceStrip);
    }

    // Image 2 = character portrait reference
    if (characterRef && fs.existsSync(characterRef)) {
      referenceImages.push(characterRef);
    }

    const result = await this.generate(prompt, {
      referenceImages,
      aspectRatio: opts.aspectRatio || '16:9',
      resolution: opts.resolution || '2K',
      model: opts.model,
    });

    // Save output
    if (opts.outputPath) {
      const dir = path.dirname(opts.outputPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(opts.outputPath, result.imageBuffer);
      result.outputPath = opts.outputPath;
    }

    return result;
  }

  /**
   * Generate a SINGLE frame from one pose reference + character portrait.
   * Optimized for frame-by-frame pipeline: 1:1 aspect ratio, 1K resolution.
   *
   * @param {string} prompt - Single-frame generation prompt
   * @param {string} poseFramePath - Path to upscaled single pose frame (Image 1)
   * @param {string} characterRef - Path to character portrait (Image 2)
   * @param {object} opts - { aspectRatio, resolution, model, outputPath }
   * @returns {{ outputPath: string, imageBuffer: Buffer, description: string }}
   */
  async generateSingleFrame(prompt, poseFramePath, characterRef, opts = {}) {
    const referenceImages = [];

    // Image 1 = single pose frame (upscaled)
    if (poseFramePath && fs.existsSync(poseFramePath)) {
      referenceImages.push(poseFramePath);
    }

    // Image 2 = character portrait
    if (characterRef && fs.existsSync(characterRef)) {
      referenceImages.push(characterRef);
    }

    const result = await this.generate(prompt, {
      referenceImages,
      aspectRatio: opts.aspectRatio || '1:1',
      resolution: opts.resolution || '1K',
      model: opts.model,
      maxRetries: opts.maxRetries ?? 1, // Fail fast — let caller (FBF server) handle retries
      timeoutMs: opts.timeoutMs || 60000, // 60s timeout for single frames
    });

    // Save output
    if (opts.outputPath) {
      const dir = path.dirname(opts.outputPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(opts.outputPath, result.imageBuffer);
      result.outputPath = opts.outputPath;
    }

    return result;
  }

  /**
   * List available models.
   */
  static get MODELS() {
    return { ...MODELS };
  }
}

module.exports = { NanaBananaClient, MODELS };
