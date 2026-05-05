/**
 * Quiz Answerer — extract survey screenshots from a screen recording and answer them with AI
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

function getFFmpegPath() {
  try { execSync('which ffmpeg', { stdio: 'pipe' }); return 'ffmpeg'; }
  catch { try { return require('ffmpeg-static'); } catch { return null; } }
}

const ANSWER_PROMPT = `You are looking at a screenshot of a quiz or survey question.
Your job:
1. Find the question text (exactly as shown).
2. List every multiple-choice answer option (label them A, B, C … even if the screenshot uses numbers or bullets).
3. Pick the single best / correct answer.
4. Write a one-sentence explanation.

Reply with ONLY valid JSON — no markdown fences, no extra text:
{"question":"exact question text","options":["A: option text","B: option text"],"correct":"A","explanation":"..."}

If this frame does NOT contain a recognisable quiz or survey question, reply:
{"skip":true}`;

function register(router, { TMP_DIR, json }) {

  router.post('/api/quiz/analyze', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) return json(res, { error: 'GEMINI_API_KEY env var not set' }, 500);

    const ffmpeg = getFFmpegPath();
    if (!ffmpeg) return json(res, { error: 'ffmpeg not found on server' }, 500);

    // ── 1. Save uploaded video to temp ────────────────────────────────────
    const sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const sessionDir = path.join(TMP_DIR || path.join(__dirname, '../data/.video-tmp'), 'quiz-' + sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    const videoPath = path.join(sessionDir, 'input.mp4');

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(videoPath);
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
    });

    if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 100) {
      return json(res, { error: 'Upload failed or empty file' }, 400);
    }

    // ── 2. Extract frames ─────────────────────────────────────────────────
    const framesDir = path.join(sessionDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    // Scene-change detection: only extract frames where screen actually changes
    const sceneArgs = [
      '-y', '-i', videoPath,
      '-vf', "select='gt(scene,0.18)',scale=1280:-1",
      '-vsync', 'vfr', '-q:v', '3',
      path.join(framesDir, 'frame-%04d.jpg'),
    ];
    spawnSync(ffmpeg, sceneArgs, { stdio: 'pipe', timeout: 120000 });

    let frames = fs.readdirSync(framesDir)
      .filter(f => /^frame-\d+\.jpg$/.test(f)).sort()
      .map(f => path.join(framesDir, f));

    // Fallback: 1 fps if scene detection yielded too few
    if (frames.length < 2) {
      frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      spawnSync(ffmpeg, ['-y', '-i', videoPath, '-vf', 'fps=1,scale=1280:-1', '-q:v', '3',
        path.join(framesDir, 'fallback-%04d.jpg')], { stdio: 'pipe', timeout: 120000 });
      frames = fs.readdirSync(framesDir)
        .filter(f => /\.(jpg|jpeg)$/.test(f)).sort()
        .map(f => path.join(framesDir, f));
    }

    // Hard cap: max 30 question screens is already a lot
    if (frames.length > 30) frames = frames.slice(0, 30);

    if (!frames.length) {
      cleanup(sessionDir);
      return json(res, { error: 'Could not extract any frames from the video' }, 400);
    }

    // ── 3. Ask Gemini about each frame (batched, 6 at a time) ────────────
    const ai = new GoogleGenAI({ apiKey });
    const CONCURRENCY = 6;
    const questions = [];

    for (let i = 0; i < frames.length; i += CONCURRENCY) {
      const batch = frames.slice(i, i + CONCURRENCY);
      const answers = await Promise.all(batch.map(async (framePath, bi) => {
        try {
          const b64 = fs.readFileSync(framePath).toString('base64');
          const resp = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: [{ parts: [
              { inlineData: { mimeType: 'image/jpeg', data: b64 } },
              { text: ANSWER_PROMPT },
            ]}],
          });
          const raw  = (resp.text ?? '').trim().replace(/^```json\s*|```$/g, '');
          const m    = raw.match(/\{[\s\S]*\}/);
          if (!m) return null;
          const parsed = JSON.parse(m[0]);
          if (parsed.skip) return null;
          return { frameIdx: i + bi, thumb: 'data:image/jpeg;base64,' + b64, ...parsed };
        } catch (e) {
          console.warn('[quiz] frame', i + bi, 'failed:', e.message);
          return null;
        }
      }));
      questions.push(...answers.filter(Boolean));
    }

    cleanup(sessionDir);

    return json(res, {
      totalFrames:   frames.length,
      questionCount: questions.length,
      questions,
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = { register };
