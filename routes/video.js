/**
 * Video Routes — Video ingest, frame extraction, smart selection, manual selection, FBF generation
 */
const fs = require('fs');
const path = require('path');
const { NanaBananaClient } = require('../../sprite-generator/nano-banana');
const { CHARACTERS, buildFilmToSpritePrompt, buildFilmToSingleFramePrompt } = require('../../sprite-generator/prompts');
const { processSprite } = require('../../sprite-processor/index');
const { smartSelect, recordFeedback } = require('../../sprite-generator/smart-selector');
const { extract } = require('../../sprite-generator/video-extractor');
const { buildRefStrip } = require('../../sprite-generator/strip-builder');
const { recordCost } = require('../middleware/cost-tracker');
const { loadCustomAnimations, saveCustomAnimations } = require('./characters');

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
    const { sessionId, fps } = body;
    const sessionDir = path.join(TMP_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) return json(res, { error: 'Session not found' }, 404);

    try {
      const videoFiles = fs.readdirSync(sessionDir).filter(f => /\.(mov|mp4|avi|mkv|webm)$/i.test(f));
      if (!videoFiles.length) return json(res, { error: 'No video in session' }, 400);

      const framesDir = path.join(sessionDir, 'frames');
      fs.mkdirSync(framesDir, { recursive: true });
      const result = await extract(path.join(sessionDir, videoFiles[0]), framesDir, { fps: fps || 10 });
      const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
      return json(res, { frameCount: frames.length, framesDir, sessionId, frames: frames.map(f => ({ file: f, fileName: f, url: `/api/video/frame/${sessionId}/${f}` })) });
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
      const allFrames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort().map(f => path.join(framesDir, f));
      const result = await smartSelect(allFrames, count || 6, { moveType });
      const selectDir = path.join(TMP_DIR, sessionId, 'selected');
      fs.mkdirSync(selectDir, { recursive: true });
      result.selected.forEach((framePath, i) => {
        fs.copyFileSync(framePath, path.join(selectDir, `frame-${String(i).padStart(2,'0')}.png`));
      });

      // Also return the full frame file list for gallery pre-selection
      const allFrameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
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
            selectedUrl: `/api/video/selected/${sessionId}/frame-${String(i).padStart(2,'0')}.png`,
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

      // Copy selected frames in order
      frameFiles.forEach((file, i) => {
        const srcPath = path.join(framesDir, file);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, path.join(selectDir, `frame-${String(i).padStart(2,'0')}.png`));
        }
      });

      const selectedFiles = fs.readdirSync(selectDir).filter(f => f.endsWith('.png')).sort();
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

  // POST /api/video/strip — Build reference strip from selected frames
  router.post('/api/video/strip', async (req, res) => {
    const body = await parseBody(req);
    const { sessionId } = body;
    const selectDir = path.join(TMP_DIR, sessionId, 'selected');
    if (!fs.existsSync(selectDir)) return json(res, { error: 'No selected frames' }, 404);

    try {
      const frames = fs.readdirSync(selectDir).filter(f => f.endsWith('.png')).sort().map(f => path.join(selectDir, f));
      const stripPath = path.join(TMP_DIR, sessionId, 'ref-strip.png');
      await buildRefStrip(frames, stripPath, { targetHeight: 512 });
      return json(res, { stripUrl: `/api/video/strip-image/${sessionId}`, frameCount: frames.length });
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
      const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });

      const charRef = CHARACTERS[character] ? path.join(ASSETS_DIR, `${character === '99' ? '99' : character}full.png`) : null;
      const safeName = (animName || 'custom').replace(/[^a-zA-Z0-9_-]/g, '-');
      const outputPath = path.join(RAW_DIR, `${character}-${safeName}-raw.png`);
      fs.mkdirSync(RAW_DIR, { recursive: true });

      await client.generateSprite(data.prompt, stripPath, charRef, {
        aspectRatio: count >= 6 ? '21:9' : '16:9',
        resolution: '2K',
        model: model || 'gemini-2.5-flash-image',
        outputPath,
      });

      const vidCost = recordCost(model || 'gemini-2.5-flash-image', 'video', '2K', charRef ? 2 : 1, { character, animation: safeName });

      const processed = await processSprite(outputPath, `${character}-${safeName}`, {
        frameCount: count,
        targetSize: 180,
        outputDir: ASSETS_DIR,
      });

      // processSprite already saves frames to ${character}-${safeName}-frames/

      return json(res, {
        success: true,
        raw: `/raw/${character}-${safeName}-raw.png`,
        processed: `/assets/${character}-${safeName}.png`,
        frames: processed.frameCount,
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

    const selectedFrames = fs.readdirSync(selectDir).filter(f => f.endsWith('.png')).sort();
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
        const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });

        const rawPath = path.join(RAW_DIR, `${character}-${safeName}-frame-${i}-raw.png`);

        // Generate single frame using video frame as pose reference
        await client.generateSprite(promptData.prompt, videoFramePath, charRef, {
          aspectRatio: '1:1',
          resolution: '1K',
          model: model || 'gemini-2.5-flash-image',
          outputPath: rawPath,
        });

        const frameCost = recordCost(model || 'gemini-2.5-flash-image', 'video_fbf_frame', '1K', charRef ? 2 : 1, {
          character, animation: safeName, frame: i,
        });
        totalCost += frameCost?.totalCost || 0;

        // Process the frame (remove green bg, normalize size)
        const frameOutputPath = path.join(framesOutputDir, `frame-${i}.png`);
        try {
          // Process into a temp dir, then grab the single frame
          const tmpProcessDir = path.join(TMP_DIR, sessionId, `fbf-proc-${i}`);
          fs.mkdirSync(tmpProcessDir, { recursive: true });
          const processed = await processSprite(rawPath, `fbf-${i}`, {
            frameCount: 1,
            targetSize: 180,
            outputDir: tmpProcessDir,
          });
          // The processed single frame is in the -frames subdir
          const processedFrame = path.join(tmpProcessDir, `fbf-${i}-frames`, 'frame-0.png');
          if (fs.existsSync(processedFrame)) {
            fs.copyFileSync(processedFrame, frameOutputPath);
          } else if (processed.outputPath && fs.existsSync(processed.outputPath)) {
            fs.copyFileSync(processed.outputPath, frameOutputPath);
          } else {
            fs.copyFileSync(rawPath, frameOutputPath);
          }
          // Cleanup temp
          fs.rmSync(tmpProcessDir, { recursive: true, force: true });
        } catch (procErr) {
          // Fallback: use raw frame
          fs.copyFileSync(rawPath, frameOutputPath);
        }
        generatedFramePaths.push(frameOutputPath);

        sendSSE('frame_done', {
          frameIndex: i,
          totalFrames,
          url: `/assets/${character}-${safeName}-frames/frame-${i}.png`,
          cost: frameCost,
        });
      }

      // Assemble strip from individual frames
      const stripPath = path.join(ASSETS_DIR, `${character}-${safeName}.png`);
      await buildRefStrip(generatedFramePaths, stripPath, { targetHeight: 180 });

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

  // POST /api/video/feedback — Frame selection feedback
  router.post('/api/video/feedback', async (req, res) => {
    const body = await parseBody(req);
    recordFeedback(body);
    return json(res, { success: true });
  });
}

module.exports = { register };
