/**
 * Video Routes — Video ingest, frame extraction, smart selection, manual selection, FBF generation
 */
const fs = require('fs');
const path = require('path');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { CHARACTERS, buildFilmToSpritePrompt, buildFilmToSingleFramePrompt } = require('../lib/sprite-generator/prompts');
const { processSprite, cropToContent, removeBackground } = require('../lib/sprite-processor/index');
const { smartSelect, recordFeedback } = require('../lib/sprite-generator/smart-selector');
const { extract } = require('../lib/sprite-generator/video-extractor');
const { buildRefStrip } = require('../lib/sprite-generator/strip-builder');
const { recordCost } = require('../middleware/cost-tracker');
const { loadCustomAnimations, saveCustomAnimations } = require('./characters');

// Extracted frames are JPEG since the fast-extraction change; older sessions
// have PNGs. Match both, and never treat gallery thumbnails as frames.
const IMG_RE = /\.(png|jpe?g)$/i;
const isFrameFile = (f) => IMG_RE.test(f) && !f.startsWith('thumb-');

function register(router, { ASSETS_DIR, RAW_DIR, TMP_DIR, json, parseBody, serveImage, runWithConcurrency }) {

  // POST /api/video/upload — Upload video file (multipart binary)
  router.post('/api/video/upload', async (req, res) => {
    try {
      const sessionId = Date.now().toString(36);
      const sessionDir = path.join(TMP_DIR, sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const videoPath = path.join(sessionDir, 'input.mov');
      const writeStream = fs.createWriteStream(videoPath);
      await new Promise((resolve, reject) => {
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      const stats = fs.statSync(videoPath);
      return json(res, { sessionId, videoPath, size: stats.size });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/video/from-url — Download TikTok/YouTube URL via yt-dlp
  router.post('/api/video/from-url', async (req, res) => {
    const body = await parseBody(req);
    const { url } = body;
    if (!url) return json(res, { error: 'url required' }, 400);
    const sessionId = Date.now().toString(36);
    const sessionDir = path.join(TMP_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      const videoPath = await new Promise((resolve, reject) => {
        try { resolve(require('../lib/sprite-generator/video-extractor').downloadYouTube(url, sessionDir)); }
        catch (e) { reject(e); }
      });
      return json(res, { sessionId, videoPath, size: fs.statSync(videoPath).size });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/video/from-direct-url — Download any direct HTTP video URL (HiggsField CDN, etc.)
  router.post('/api/video/from-direct-url', async (req, res) => {
    const body = await parseBody(req);
    const { url } = body;
    if (!url || !/^https?:\/\//.test(url)) return json(res, { error: 'Valid http/https URL required' }, 400);
    const sessionId = Date.now().toString(36);
    const sessionDir = path.join(TMP_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const ext = (url.match(/\.(mp4|mov|webm|mkv)(\?|$)/i)?.[1] || 'mp4').toLowerCase();
    const videoPath = path.join(sessionDir, `input.${ext}`);
    try {
      const { execSync } = require('child_process');
      execSync(`curl -fsSL -o "${videoPath}" "${url}"`, { stdio: 'pipe', timeout: 120000 });
      if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1024) {
        throw new Error('Downloaded file is empty or too small');
      }
      return json(res, { sessionId, videoPath, size: fs.statSync(videoPath).size });
    } catch (err) {
      return json(res, { error: 'Download failed: ' + err.message.substring(0, 200) }, 500);
    }
  });

  // POST /api/video/from-path — Use existing video file on disk
  router.post('/api/video/from-path', async (req, res) => {
    const body = await parseBody(req);
    const { videoPath } = body;
    if (!videoPath || !fs.existsSync(videoPath)) {
      return json(res, { error: 'Video file not found: ' + videoPath }, 400);
    }
    const sessionId = Date.now().toString(36);
    const sessionDir = path.join(TMP_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const linkPath = path.join(sessionDir, 'input' + path.extname(videoPath));
    fs.copyFileSync(videoPath, linkPath);
    return json(res, { sessionId, videoPath: linkPath, size: fs.statSync(videoPath).size });
  });

  // POST /api/video/extract — Extract frames from uploaded video
  router.post('/api/video/extract', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, fps, startTime, endTime } = body;
    const sessionDir = path.join(TMP_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) return json(res, { error: 'Session not found' }, 404);

    try {
      const videoFiles = fs.readdirSync(sessionDir).filter(f => /\.(mov|mp4|avi|mkv|webm)$/i.test(f));
      if (!videoFiles.length) return json(res, { error: 'No video in session' }, 400);

      const framesDir = path.join(sessionDir, 'frames');
      // Clear previous extraction if re-extracting with new trim
      if (fs.existsSync(framesDir)) {
        fs.readdirSync(framesDir).filter(f => IMG_RE.test(f)).forEach(f => fs.unlinkSync(path.join(framesDir, f)));
      }
      fs.mkdirSync(framesDir, { recursive: true });

      const extractOpts = { fps: fps || 10 };
      if (startTime != null && startTime > 0) extractOpts.start = String(startTime);
      if (startTime != null && endTime != null && endTime > startTime) {
        extractOpts.duration = String(Math.max(0.1, endTime - startTime));
      }

      const result = await extract(path.join(sessionDir, videoFiles[0]), framesDir, extractOpts);
      const allFiles = fs.readdirSync(framesDir);
      const frames = allFiles.filter(isFrameFile).sort();
      const thumbs = new Set(allFiles.filter(f => f.startsWith('thumb-')));
      return json(res, {
        frameCount: frames.length, framesDir, sessionId,
        frames: frames.map(f => {
          const thumb = f.replace(/^frame-/, 'thumb-');
          return {
            file: f, fileName: f,
            url: `/api/video/frame/${sessionId}/${f}`,
            thumbUrl: thumbs.has(thumb) ? `/api/video/frame/${sessionId}/${thumb}` : undefined,
          };
        }),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/video/frame/:session/:file — Serve extracted frame
  router.get('/api/video/frame/:session/:file', (req, res, params) => {
    const framePath = path.join(TMP_DIR, params.session, 'frames', params.file);
    return serveImage(res, framePath);
  });

  // POST /api/video/smart-select — Smart select key frames
  router.post('/api/video/smart-select', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, count, moveType } = body;
    const framesDir = path.join(TMP_DIR, sessionId, 'frames');
    if (!fs.existsSync(framesDir)) return json(res, { error: 'Frames not found' }, 404);

    try {
      const allFrames = fs.readdirSync(framesDir).filter(isFrameFile).sort().map(f => path.join(framesDir, f));
      const result = await smartSelect(allFrames, count || 6, { moveType });
      const selectDir = path.join(TMP_DIR, sessionId, 'selected');
      fs.mkdirSync(selectDir, { recursive: true });
      result.selected.forEach((framePath, i) => {
        fs.copyFileSync(framePath, path.join(selectDir, `frame-${String(i).padStart(2,'0')}${path.extname(framePath).toLowerCase()}`));
      });

      // Also return the full frame file list for gallery pre-selection
      const allFrameFiles = fs.readdirSync(framesDir).filter(isFrameFile).sort();
      const selectedFileNames = result.selected.map(p => path.basename(p));

      return json(res, {
        count: result.selected.length,
        selectedIndices: result.selectedIndices,
        selectedFileNames,
        frames: result.selected.map((framePath, i) => {
          const analysis = result.analysis.find(a => a.path === framePath) || {};
          return {
            index: result.selectedIndices[i],
            file: path.basename(framePath),
            url: `/api/video/frame/${sessionId}/${path.basename(framePath)}`,
            selectedUrl: `/api/video/selected/${sessionId}/frame-${String(i).padStart(2,'0')}${path.extname(framePath).toLowerCase()}`,
            scores: { ballFound: analysis.ball?.found || false, ballConfidence: analysis.ball?.confidence || 0, ballInflection: analysis.ballInflection || false, motion: analysis.motion || 0, sharpness: analysis.sharpness || 0, total: analysis.score || 0 },
          };
        }),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/video/selected/:session/:file — Serve selected frames
  router.get('/api/video/selected/:session/:file', (req, res, params) => {
    return serveImage(res, path.join(TMP_DIR, params.session, 'selected', params.file));
  });

  // POST /api/video/select-manual — Manually select frames from gallery
  router.post('/api/video/select-manual', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, frameFiles } = body;
    if (!sessionId || !frameFiles || !frameFiles.length) {
      return json(res, { error: 'sessionId and frameFiles[] required' }, 400);
    }

    const framesDir = path.join(TMP_DIR, sessionId, 'frames');
    if (!fs.existsSync(framesDir)) return json(res, { error: 'Frames not found' }, 404);

    try {
      const selectDir = path.join(TMP_DIR, sessionId, 'selected');
      // Clear previous selections
      if (fs.existsSync(selectDir)) {
        fs.readdirSync(selectDir).forEach(f => fs.unlinkSync(path.join(selectDir, f)));
      }
      fs.mkdirSync(selectDir, { recursive: true });

      // Copy selected frames in order (preserve source format)
      frameFiles.forEach((file, i) => {
        const srcPath = path.join(framesDir, file);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, path.join(selectDir, `frame-${String(i).padStart(2,'0')}${path.extname(file).toLowerCase()}`));
        }
      });

      const selectedFiles = fs.readdirSync(selectDir).filter(f => IMG_RE.test(f)).sort();
      return json(res, {
        success: true,
        count: selectedFiles.length,
        frames: selectedFiles.map((f, i) => ({
          index: i,
          url: `/api/video/selected/${sessionId}/${f}`,
        })),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/video/strip — Build reference strip from selected frames.
  // Prefers subject-extracted frames (cut out + bg removed) if they exist;
  // falls back to raw selected frames.
  router.post('/api/video/strip', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId } = body;
    const selectDir   = path.join(TMP_DIR, sessionId, 'selected');
    const subjectsDir = path.join(TMP_DIR, sessionId, 'subjects');
    if (!fs.existsSync(selectDir)) return json(res, { error: 'No selected frames' }, 404);

    try {
      // Use processed subject frames when available (player+ball cutouts, bg removed)
      let frames;
      const subjectFiles = fs.existsSync(subjectsDir)
        ? fs.readdirSync(subjectsDir).filter(f => /^subject-\d+\.png$/.test(f)).sort((a, b) => {
            const ai = parseInt(a.match(/\d+/)[0]);
            const bi = parseInt(b.match(/\d+/)[0]);
            return ai - bi;
          }).map(f => path.join(subjectsDir, f))
        : [];

      if (subjectFiles.length > 0) {
        frames = subjectFiles;
      } else {
        frames = fs.readdirSync(selectDir).filter(f => IMG_RE.test(f)).sort().map(f => path.join(selectDir, f));
      }

      // Full subject height (1024) — the reference strip keeps every pixel the
      // cutout produced instead of downscaling to the old 720px default
      const stripPath = path.join(TMP_DIR, sessionId, 'ref-strip.png');
      await buildRefStrip(frames, stripPath, { targetHeight: 1024 });
      return json(res, {
        stripUrl: `/api/video/strip-image/${sessionId}`,
        frameCount: frames.length,
        source: subjectFiles.length > 0 ? 'subjects' : 'selected',
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/video/strip-image/:session — Serve built strip
  router.get('/api/video/strip-image/:session', (req, res, params) => {
    return serveImage(res, path.join(TMP_DIR, params.session, 'ref-strip.png'));
  });

  // POST /api/video/generate — Film-to-sprite generation from video strip (enhanced)
  router.post('/api/video/generate', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, character, animName, frameCount, model, fps, loop, action } = body;
    const stripPath = path.join(TMP_DIR, sessionId, 'ref-strip.png');
    if (!fs.existsSync(stripPath)) return json(res, { error: 'Build strip first' }, 400);

    try {
      const count = frameCount || 6;
      const animDescription = action || animName || 'custom move';
      const data = buildFilmToSpritePrompt(character, animDescription, count);
      const client = new NanaBananaClient({ model: model || 'gemini-3-pro-image-preview' });

      const charRef = CHARACTERS[character] ? path.join(ASSETS_DIR, `${character === '99' ? '99' : character}full.png`) : null;
      const safeName = (animName || 'custom').replace(/[^a-zA-Z0-9_-]/g, '-');
      const outputPath = path.join(RAW_DIR, `${character}-${safeName}-raw.png`);
      fs.mkdirSync(RAW_DIR, { recursive: true });

      await client.generateSprite(data.prompt, stripPath, charRef, {
        aspectRatio: count >= 6 ? '21:9' : '16:9',
        resolution: '2K',
        model: model || 'gemini-3-pro-image-preview',
        outputPath,
      });

      const vidCost = recordCost(model || 'gemini-3-pro-image-preview', 'video', '2K', charRef ? 2 : 1, { character, animation: safeName });

      return json(res, {
        success: true,
        raw: `/raw/${character}-${safeName}-raw.png`,
        processed: `/raw/${character}-${safeName}-raw.png`,
        frames: count,
        cost: vidCost,
        animName: safeName,
        fps: fps || 8,
        loop: loop || false,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/video/generate-fbf — Frame-by-frame generation from video (SSE)
  router.post('/api/video/generate-fbf', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, character, animName, model, fps, loop, action } = body;

    const selectDir = path.join(TMP_DIR, sessionId, 'selected');
    if (!fs.existsSync(selectDir)) {
      return json(res, { error: 'No selected frames. Select frames first.' }, 400);
    }

    const selectedFrames = fs.readdirSync(selectDir).filter(f => IMG_RE.test(f)).sort();
    if (!selectedFrames.length) {
      return json(res, { error: 'No selected frames found' }, 400);
    }

    // SSE setup
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    function sendSSE(eventType, data) {
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const totalFrames = selectedFrames.length;
    const safeName = (animName || 'custom').replace(/[^a-zA-Z0-9_-]/g, '-');
    const animDescription = action || animName || 'custom move';
    const charRef = CHARACTERS[character] ? path.join(ASSETS_DIR, `${character === '99' ? '99' : character}full.png`) : null;
    const framesOutputDir = path.join(ASSETS_DIR, `${character}-${safeName}-frames`);
    fs.mkdirSync(framesOutputDir, { recursive: true });
    fs.mkdirSync(RAW_DIR, { recursive: true });

    sendSSE('start', { totalFrames, animName: safeName, character });

    let totalCost = 0;
    const generatedFramePaths = [];

    try {
      for (let i = 0; i < totalFrames; i++) {
        sendSSE('frame_start', { frameIndex: i, totalFrames });

        const videoFramePath = path.join(selectDir, selectedFrames[i]);
        const promptData = buildFilmToSingleFramePrompt(character, animDescription, i, totalFrames);
        const client = new NanaBananaClient({ model: model || 'gemini-3-pro-image-preview' });

        const rawFramePath = path.join(RAW_DIR, `${character}-${safeName}-frame-${i}-raw.png`);
        const frameOutputPath = path.join(framesOutputDir, `frame-${i}.png`);

        // Generate single frame using video frame as pose reference
        await client.generateSprite(promptData.prompt, videoFramePath, charRef, {
          aspectRatio: '1:1',
          resolution: '1K',
          model: model || 'gemini-3-pro-image-preview',
          outputPath: rawFramePath,
        });

        // Remove green background — nothing else
        await removeBackground(rawFramePath, frameOutputPath);

        const frameCost = recordCost(model || 'gemini-3-pro-image-preview', 'video_fbf_frame', '1K', charRef ? 2 : 1, {
          character, animation: safeName, frame: i,
        });
        totalCost += frameCost?.totalCost || 0;
        generatedFramePaths.push(frameOutputPath);

        sendSSE('frame_done', {
          frameIndex: i,
          totalFrames,
          url: `/assets/${character}-${safeName}-frames/frame-${i}.png`,
          cost: frameCost,
        });
      }

      // Assemble strip from individual frames — save at native 1K height so no
      // quality is lost; the game scales sprites at draw time anyway.
      const stripPath = path.join(ASSETS_DIR, `${character}-${safeName}.png`);
      await buildRefStrip(generatedFramePaths, stripPath, { targetHeight: 1024 });

      sendSSE('complete', {
        success: true,
        totalFrames,
        totalCost,
        stripUrl: `/assets/${character}-${safeName}.png`,
        animName: safeName,
        fps: fps || 8,
        loop: loop || false,
      });
    } catch (err) {
      sendSSE('error', { message: err.message, frameIndex: generatedFramePaths.length });
    }

    res.end();
  });

  // POST /api/video/regenerate-frame — Regenerate a single frame from a completed video animation
  router.post('/api/video/regenerate-frame', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, character, animName, frameIndex, customPrompt, model } = body;
    if (!sessionId || !character || !animName || frameIndex == null) {
      return json(res, { error: 'sessionId, character, animName, frameIndex required' }, 400);
    }

    const safeName = animName.replace(/[^a-zA-Z0-9_-]/g, '-');
    const framesOutputDir = path.join(ASSETS_DIR, `${character}-${safeName}-frames`);
    const frameOutputPath = path.join(framesOutputDir, `frame-${frameIndex}.png`);

    if (!fs.existsSync(framesOutputDir)) {
      return json(res, { error: `Frames directory not found: ${framesOutputDir}` }, 404);
    }

    // Find matching reference frame from session selected dir
    const selectDir = path.join(TMP_DIR, sessionId, 'selected');
    const selectedFiles = fs.existsSync(selectDir)
      ? fs.readdirSync(selectDir).filter(f => IMG_RE.test(f)).sort()
      : [];
    const videoRefPath = selectedFiles[frameIndex]
      ? path.join(selectDir, selectedFiles[frameIndex])
      : null;

    try {
      const totalFrames = fs.readdirSync(framesOutputDir).filter(f => f.endsWith('.png')).length;
      const promptData = buildFilmToSingleFramePrompt(character, safeName, frameIndex, totalFrames);
      const fullPrompt = customPrompt
        ? `${promptData.prompt}\n\nSPECIFIC INSTRUCTION: ${customPrompt}\nKeep everything else identical.`
        : promptData.prompt;

      const charRef = CHARACTERS[character] ? path.join(ASSETS_DIR, `${character === '99' ? '99' : character}full.png`) : null;
      const rawPath = path.join(RAW_DIR, `${character}-${safeName}-frame-${frameIndex}-regen-raw.png`);
      fs.mkdirSync(RAW_DIR, { recursive: true });

      const client = new NanaBananaClient({ model: model || 'gemini-3-pro-image-preview' });
      const refImage = videoRefPath && fs.existsSync(videoRefPath) ? videoRefPath : charRef;

      await client.generateSprite(fullPrompt, refImage, charRef && refImage !== charRef ? charRef : null, {
        aspectRatio: '1:1',
        resolution: '1K',
        model: model || 'gemini-3-pro-image-preview',
        outputPath: rawPath,
      });

      recordCost(model || 'gemini-3-pro-image-preview', 'video_fbf_frame', '1K', (refImage ? 1 : 0) + (charRef && refImage !== charRef ? 1 : 0), {
        character, animation: safeName, frame: frameIndex,
      });

      // Process the regenerated frame
      const tmpProcessDir = path.join(TMP_DIR, sessionId, `regen-proc-${frameIndex}-${Date.now()}`);
      fs.mkdirSync(tmpProcessDir, { recursive: true });
      try {
        const processed = await processSprite(rawPath, `regen-${frameIndex}`, {
          frameCount: 1,
          targetSize: 180,
          outputDir: tmpProcessDir,
        });
        const processedFrame = path.join(tmpProcessDir, `regen-${frameIndex}-frames`, 'frame-0.png');
        if (fs.existsSync(processedFrame)) {
          fs.copyFileSync(processedFrame, frameOutputPath);
        } else if (processed.outputPath && fs.existsSync(processed.outputPath)) {
          fs.copyFileSync(processed.outputPath, frameOutputPath);
        } else {
          fs.copyFileSync(rawPath, frameOutputPath);
        }
      } catch {
        fs.copyFileSync(rawPath, frameOutputPath);
      } finally {
        fs.rmSync(tmpProcessDir, { recursive: true, force: true });
      }

      // Rebuild full strip from all frames
      const allFramePaths = fs.readdirSync(framesOutputDir)
        .filter(f => f.endsWith('.png'))
        .sort((a, b) => {
          const ai = parseInt(a.match(/\d+/)?.[0] ?? '0');
          const bi = parseInt(b.match(/\d+/)?.[0] ?? '0');
          return ai - bi;
        })
        .map(f => path.join(framesOutputDir, f));

      const stripPath = path.join(ASSETS_DIR, `${character}-${safeName}.png`);
      await buildRefStrip(allFramePaths, stripPath, { targetHeight: 1024 });

      return json(res, {
        success: true,
        frameUrl: `/assets/${character}-${safeName}-frames/frame-${frameIndex}.png`,
        stripUrl: `/assets/${character}-${safeName}.png`,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/video/extract-subject — Extract a SINGLE subject frame (for progressive UI)
  // Body: { sessionId, frameFile, frameIndex, customPrompt? }
  router.post('/api/video/extract-subject', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, frameFile, frameIndex, customPrompt } = body;
    if (!sessionId || !frameFile) return json(res, { error: 'sessionId and frameFile required' }, 400);

    const framesDir   = path.join(TMP_DIR, sessionId, 'frames');
    const subjectsDir = path.join(TMP_DIR, sessionId, 'subjects');
    const framePath   = path.join(framesDir, frameFile);

    if (!fs.existsSync(framePath)) return json(res, { error: 'Frame not found' }, 404);
    fs.mkdirSync(subjectsDir, { recursive: true });

    // Green background so removeBackground (chroma-key) works reliably
    let prompt = 'Extract the basketball player from this image. Place them centered on a PURE GREEN (#00FF00) background — no court, no arena, no floor, no shadows. Scale the player up so they fill approximately 60% of the image height — if they are far from the camera, zoom in so the player is large and centered. Keep their exact pose, body proportions, and the basketball if visible. Solid pure green everywhere the player is not.';
    if (customPrompt) prompt += '\n\nSPECIFIC INSTRUCTION: ' + customPrompt + '\nKeep everything else identical.';

    const RETRY_DELAYS = [3000, 8000, 15000];

    function _is503(err) {
      const s = String(err?.message ?? err);
      return s.includes('503') || s.includes('UNAVAILABLE') || s.includes('high demand');
    }

    async function runExtraction(attempt = 0) {
      const { removeBackground } = require('../lib/sprite-processor/index');
      const client = new NanaBananaClient({ model: 'gemini-3-pro-image-preview' });
      const result  = await client.generate(prompt, {
        referenceImages: [framePath],
        aspectRatio:     '3:4',
        resolution:      '1K',
        model:           'gemini-3-pro-image-preview',
      });

      const outFile = `subject-${frameIndex}.png`;
      const rawPath = path.join(subjectsDir, `raw-${frameIndex}.png`);
      const greenRemovedPath = path.join(subjectsDir, `green-${frameIndex}.png`);
      const croppedPath = path.join(subjectsDir, `cropped-${frameIndex}.png`);
      fs.writeFileSync(rawPath, result.imageBuffer);

      // Soft-edged chroma key (de-spill + feathered alpha — these are
      // photographic refs, not pixel art) and a 768x1024 canvas at native
      // crop resolution: the old 384x512 target threw away half the pixels
      // the AI produced.
      await removeBackground(rawPath, greenRemovedPath, { softEdges: true });
      await cropToContent(greenRemovedPath, croppedPath, { width: 768, height: 1024, padding: 8, noUpscale: true });
      const sharp = require('sharp');
      await sharp({ create: { width: 768, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } } })
        .composite([{ input: croppedPath, gravity: 'centre' }])
        .png()
        .toFile(path.join(subjectsDir, outFile));

      recordCost('gemini-3-pro-image-preview', 'subject-extract', '1K', 1, { sessionId, frameIndex });
      return json(res, { frameIndex, url: `/api/video/subject/${sessionId}/${outFile}` });
    }

    async function withRetry(attempt) {
      try {
        return await runExtraction(attempt);
      } catch (err) {
        if (_is503(err) && attempt < RETRY_DELAYS.length) {
          console.warn(`[extract-subject] 503 on frame ${frameIndex}, retry ${attempt + 1} in ${RETRY_DELAYS[attempt]}ms`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          return withRetry(attempt + 1);
        }
        // Clean up error message — strip raw JSON if present
        let msg = String(err?.message ?? err);
        try {
          const parsed = JSON.parse(msg);
          msg = parsed?.error?.message ?? parsed?.message ?? msg;
        } catch {}
        if (_is503(err)) msg = 'AI model busy — please retry in a moment';
        return json(res, { frameIndex, error: msg }, _is503(err) ? 503 : 500);
      }
    }

    return withRetry(0);
  });

  // POST /api/video/extract-subjects — Extract ALL subjects (kept for compatibility)
  router.post('/api/video/extract-subjects', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId, frameFiles, customPrompt } = body;
    if (!sessionId || !frameFiles || !frameFiles.length) {
      return json(res, { error: 'sessionId and frameFiles[] required' }, 400);
    }

    const framesDir = path.join(TMP_DIR, sessionId, 'frames');
    if (!fs.existsSync(framesDir)) return json(res, { error: 'Frames not found' }, 404);

    const subjectsDir = path.join(TMP_DIR, sessionId, 'subjects');
    fs.mkdirSync(subjectsDir, { recursive: true });

    let prompt = 'Extract the basketball player from this image. Place them centered on a PURE GREEN (#00FF00) background — no court, no arena, no floor, no shadows. Scale the player up so they fill approximately 60% of the image height — if they are far from the camera, zoom in so the player is large and centered. Keep their exact pose, body proportions, and the basketball if visible. Solid pure green everywhere the player is not.';
    if (customPrompt) prompt += '\n\nSPECIFIC INSTRUCTION: ' + customPrompt + '\nKeep everything else identical.';
    const { removeBackground: removeBg } = require('../lib/sprite-processor/index');
    const client = new NanaBananaClient({ model: 'gemini-3-pro-image-preview' });
    const subjects = [];

    for (let i = 0; i < frameFiles.length; i++) {
      const framePath = path.join(framesDir, frameFiles[i]);
      if (!fs.existsSync(framePath)) {
        subjects.push({ frameIndex: i, error: 'Frame not found' });
        continue;
      }
      try {
        const result = await client.generate(prompt, {
          referenceImages: [framePath],
          aspectRatio: '3:4',
          resolution: '1K',
          model: 'gemini-3-pro-image-preview',
        });
        const outFile    = `subject-${i}.png`;
        const rawPath    = path.join(subjectsDir, `raw-${i}.png`);
        const greenPath  = path.join(subjectsDir, `green-${i}.png`);
        const cropPath   = path.join(subjectsDir, `crop-${i}.png`);
        fs.writeFileSync(rawPath, result.imageBuffer);
        await removeBg(rawPath, greenPath, { softEdges: true });
        await cropToContent(greenPath, cropPath, { width: 768, height: 1024, padding: 8, noUpscale: true });
        const sharp2 = require('sharp');
        await sharp2({ create: { width: 768, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } } })
          .composite([{ input: cropPath, gravity: 'centre' }])
          .png()
          .toFile(path.join(subjectsDir, outFile));
        recordCost('gemini-3-pro-image-preview', 'subject-extract', '1K', 1, { sessionId, frameIndex: i });
        subjects.push({ frameIndex: i, url: `/api/video/subject/${sessionId}/${outFile}` });
      } catch (err) {
        subjects.push({ frameIndex: i, error: err.message });
      }
    }

    return json(res, { subjects });
  });

  // GET /api/video/subject/:session/:file — Serve extracted subject
  router.get('/api/video/subject/:session/:file', (req, res, params) => {
    return serveImage(res, path.join(TMP_DIR, params.session, 'subjects', params.file));
  });

  // POST /api/video/feedback — Frame selection feedback
  router.post('/api/video/feedback', async (req, res) => {
    const body = await parseBody(req);
    recordFeedback(body);
    return json(res, { success: true });
  });
}

module.exports = { register };
