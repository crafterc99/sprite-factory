/**
 * Anchor Routes — Portrait, Angle References, Ball References, Replication
 *
 * These endpoints support the anchor package system:
 * - Master portrait generation (standardized outfit)
 * - 8 canonical angle references (turnaround)
 * - 6 ball-holding variant references
 * - Animation replication across characters
 *
 * All multi-image endpoints stream via SSE.
 */
const fs = require('fs');
const path = require('path');
const {
  CHARACTERS, ANGLE_NAMES, BALL_VARIANTS,
  buildAnglePrompt, buildBallRefPrompt,
} = require('../../sprite-generator/prompts');
const { NanaBananaClient } = require('../../sprite-generator/nano-banana');
const { processSingleFrame } = require('../../sprite-processor');
const { recordCost } = require('../middleware/cost-tracker');
const { loadCharacters, saveCharacters, getCharacterRegistry } = require('./characters');

function register(router, { ASSETS_DIR, RAW_DIR, json, parseBody, serveImage }) {

  // ─── Helper: SSE stream setup ──────────────────────────────────────
  function sseStart(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
  }

  function sseSend(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function sseEnd(res) {
    res.end();
  }

  // ─── Helper: Update anchor data in character registry ──────────────
  function updateAnchor(charName, updates) {
    const registry = loadCharacters();
    if (!registry[charName]) return;
    if (!registry[charName].anchor) {
      registry[charName].anchor = {
        portrait: null,
        angles: [],
        ballRefs: [],
        status: 'incomplete',
      };
    }
    Object.assign(registry[charName].anchor, updates);

    // Compute overall status
    const a = registry[charName].anchor;
    if (a.portrait && a.angles.length === 8 && a.ballRefs.length === 6) {
      a.status = 'complete';
    } else if (a.portrait || a.angles.length > 0 || a.ballRefs.length > 0) {
      a.status = 'partial';
    } else {
      a.status = 'incomplete';
    }
    saveCharacters(registry);
    return registry[charName].anchor;
  }

  // ─── 1. POST /api/anchor/portrait — Generate master portrait ──────
  router.post('/api/anchor/portrait', async (req, res) => {
    const body = await parseBody(req);
    const { character, model } = body;
    if (!character) return json(res, { error: 'character required' }, 400);

    const registry = getCharacterRegistry(ASSETS_DIR);
    const charData = registry[character];
    if (!charData) return json(res, { error: `Character "${character}" not found` }, 404);

    // Check if portrait already exists
    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    if (fs.existsSync(portraitPath)) {
      const anchor = updateAnchor(character, { portrait: `${character}full.png` });
      return json(res, {
        success: true,
        exists: true,
        url: `/assets/${character}full.png`,
        anchor,
      });
    }

    try {
      const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });

      const prompt = [
        `Create a FULL BODY standing character portrait showing the complete person from head to shoes.`,
        `The character must be standing upright, facing forward, arms relaxed at sides, in a neutral standing pose.`,
        `Show the ENTIRE body — head, torso, arms, hands, legs, feet/shoes. Do NOT crop or zoom in.`,
        ``,
        `CHARACTER DESCRIPTION: ${charData.description || 'Basketball player'}`,
        ``,
        `STANDARDIZED OUTFIT:`,
        `- Plain brown t-shirt (solid #8B4513 / saddle brown)`,
        `- Black baggy basketball pants/shorts`,
        `- Basketball held casually in the right hand at hip level`,
        ``,
        `STYLE: 16-bit arcade pixel art, GBA game style — chunky pixels, NOT high-resolution`,
        `- Bold thick black pixel outlines around the entire character body`,
        `- Limited color palette with high contrast arcade shading`,
        `- Sharp pixel edges — NO anti-aliasing, NO blur, NO smooth gradients`,
        ``,
        `Output on a pure bright green (#00FF00) background. NO green on the character.`,
        `FULL BODY only. No environment. No extra elements. No cropping.`,
      ].join('\n');

      const result = await client.generate(prompt, {
        aspectRatio: '3:4',
        resolution: '2K',
        model: model || 'gemini-2.5-flash-image',
      });

      fs.writeFileSync(portraitPath, result.imageBuffer);
      const cost = recordCost(model || 'gemini-2.5-flash-image', 'anchor-portrait', '2K', 0, { character });

      // Sync runtime CHARACTERS
      if (!CHARACTERS[character]) {
        CHARACTERS[character] = {
          description: charData.description || 'the character shown in Image 2',
          style: '16-bit pixel art, GBA style',
        };
      }

      const anchor = updateAnchor(character, { portrait: `${character}full.png` });
      return json(res, { success: true, url: `/assets/${character}full.png`, cost, anchor });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // ─── 2. POST /api/anchor/angles — SSE: generate 8 angle references ─
  router.post('/api/anchor/angles', async (req, res) => {
    const body = await parseBody(req);
    const { character, model, regenerate } = body;
    if (!character) return json(res, { error: 'character required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    if (!fs.existsSync(portraitPath)) {
      return json(res, { error: 'Portrait not found. Generate portrait first.' }, 400);
    }

    sseStart(res);
    sseSend(res, 'start', { character, totalAngles: ANGLE_NAMES.length });

    const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });
    const angles = [];
    let totalCost = 0;

    // If regenerate is an array of indices, only regenerate those
    const indicesToGenerate = Array.isArray(regenerate)
      ? regenerate
      : ANGLE_NAMES.map((_, i) => i);

    // Load existing angles if partial regen
    const registry = loadCharacters();
    const existingAngles = registry[character]?.anchor?.angles || [];

    for (const idx of indicesToGenerate) {
      const angleName = ANGLE_NAMES[idx];
      const fileName = `${character}-angle-${idx}.png`;
      const filePath = path.join(ASSETS_DIR, fileName);

      sseSend(res, 'angle_start', { index: idx, angle: angleName });

      try {
        const { prompt } = buildAnglePrompt(character, angleName, idx, ANGLE_NAMES.length);

        const result = await client.generate(prompt, {
          referenceImages: [portraitPath],
          aspectRatio: '3:4',
          resolution: '2K',
          model: model || 'gemini-2.5-flash-image',
        });

        fs.writeFileSync(filePath, result.imageBuffer);
        const cost = recordCost(model || 'gemini-2.5-flash-image', 'anchor-angle', '2K', 1, {
          character, angle: angleName, index: idx,
        });
        totalCost += cost?.totalCost || 0;

        angles[idx] = fileName;
        sseSend(res, 'angle_done', { index: idx, angle: angleName, url: `/assets/${fileName}`, cost: cost?.totalCost || 0 });

        // Delay between generations to avoid rate limits
        if (idx < indicesToGenerate[indicesToGenerate.length - 1]) {
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        sseSend(res, 'angle_error', { index: idx, angle: angleName, error: err.message });
        angles[idx] = existingAngles[idx] || null;
      }
    }

    // Merge with existing angles for partial regeneration
    const finalAngles = ANGLE_NAMES.map((_, i) => angles[i] || existingAngles[i] || null);
    const anchor = updateAnchor(character, { angles: finalAngles });

    sseSend(res, 'complete', {
      character,
      angles: finalAngles,
      totalCost,
      completedCount: finalAngles.filter(Boolean).length,
      anchor,
    });
    sseEnd(res);
  });

  // ─── 3. GET /api/anchor/angles/:char — Get existing angle refs ─────
  router.get('/api/anchor/angles/:char', (req, res, params) => {
    const charName = params.char;
    const registry = loadCharacters();
    const anchor = registry[charName]?.anchor || {};
    const angles = (anchor.angles || []).map((fileName, i) => {
      if (!fileName) return { index: i, angle: ANGLE_NAMES[i], exists: false, url: null };
      const filePath = path.join(ASSETS_DIR, fileName);
      return {
        index: i,
        angle: ANGLE_NAMES[i],
        exists: fs.existsSync(filePath),
        url: fs.existsSync(filePath) ? `/assets/${fileName}` : null,
        fileName,
      };
    });

    // Pad to 8 if less
    while (angles.length < 8) {
      angles.push({ index: angles.length, angle: ANGLE_NAMES[angles.length], exists: false, url: null });
    }

    return json(res, { character: charName, angles, status: anchor.status || 'incomplete' });
  });

  // ─── 4. POST /api/anchor/ball-refs — SSE: generate 6 ball variants ─
  router.post('/api/anchor/ball-refs', async (req, res) => {
    const body = await parseBody(req);
    const { character, model, regenerate } = body;
    if (!character) return json(res, { error: 'character required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    if (!fs.existsSync(portraitPath)) {
      return json(res, { error: 'Portrait not found. Generate portrait first.' }, 400);
    }

    sseStart(res);
    sseSend(res, 'start', { character, totalVariants: BALL_VARIANTS.length });

    const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });
    const ballRefs = [];
    let totalCost = 0;

    const indicesToGenerate = Array.isArray(regenerate)
      ? regenerate
      : BALL_VARIANTS.map((_, i) => i);

    const registry = loadCharacters();
    const existingRefs = registry[character]?.anchor?.ballRefs || [];

    // Optionally use front angle as second reference
    const frontAnglePath = path.join(ASSETS_DIR, `${character}-angle-0.png`);
    const referenceImages = [portraitPath];
    if (fs.existsSync(frontAnglePath)) {
      referenceImages.push(frontAnglePath);
    }

    for (const idx of indicesToGenerate) {
      const variant = BALL_VARIANTS[idx];
      const fileName = `${character}-ball-${variant}.png`;
      const filePath = path.join(ASSETS_DIR, fileName);

      sseSend(res, 'ballref_start', { index: idx, variant });

      try {
        const { prompt } = buildBallRefPrompt(character, variant, idx);

        const result = await client.generate(prompt, {
          referenceImages,
          aspectRatio: '3:4',
          resolution: '2K',
          model: model || 'gemini-2.5-flash-image',
        });

        fs.writeFileSync(filePath, result.imageBuffer);
        const cost = recordCost(model || 'gemini-2.5-flash-image', 'anchor-ball-ref', '2K', referenceImages.length, {
          character, variant, index: idx,
        });
        totalCost += cost?.totalCost || 0;

        ballRefs[idx] = fileName;
        sseSend(res, 'ballref_done', { index: idx, variant, url: `/assets/${fileName}`, cost: cost?.totalCost || 0 });

        if (idx < indicesToGenerate[indicesToGenerate.length - 1]) {
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        sseSend(res, 'ballref_error', { index: idx, variant, error: err.message });
        ballRefs[idx] = existingRefs[idx] || null;
      }
    }

    const finalRefs = BALL_VARIANTS.map((_, i) => ballRefs[i] || existingRefs[i] || null);
    const anchor = updateAnchor(character, { ballRefs: finalRefs });

    sseSend(res, 'complete', {
      character,
      ballRefs: finalRefs,
      totalCost,
      completedCount: finalRefs.filter(Boolean).length,
      anchor,
    });
    sseEnd(res);
  });

  // ─── 5. GET /api/anchor/ball-refs/:char — Get existing ball refs ───
  router.get('/api/anchor/ball-refs/:char', (req, res, params) => {
    const charName = params.char;
    const registry = loadCharacters();
    const anchor = registry[charName]?.anchor || {};
    const ballRefs = (anchor.ballRefs || []).map((fileName, i) => {
      if (!fileName) return { index: i, variant: BALL_VARIANTS[i] || `variant-${i}`, exists: false, url: null };
      const filePath = path.join(ASSETS_DIR, fileName);
      return {
        index: i,
        variant: BALL_VARIANTS[i] || `variant-${i}`,
        exists: fs.existsSync(filePath),
        url: fs.existsSync(filePath) ? `/assets/${fileName}` : null,
        fileName,
      };
    });

    while (ballRefs.length < 6) {
      ballRefs.push({ index: ballRefs.length, variant: BALL_VARIANTS[ballRefs.length] || `variant-${ballRefs.length}`, exists: false, url: null });
    }

    return json(res, { character: charName, ballRefs, status: anchor.status || 'incomplete' });
  });

  // ─── 6. POST /api/anchor/replicate — SSE: replicate animation ──────
  router.post('/api/anchor/replicate', async (req, res) => {
    const body = await parseBody(req);
    const { sourceCharacter, sourceAnimation, targetCharacters, model } = body;

    if (!sourceCharacter || !sourceAnimation || !targetCharacters?.length) {
      return json(res, { error: 'sourceCharacter, sourceAnimation, and targetCharacters[] required' }, 400);
    }

    // Load source animation frames
    const framesDir = path.join(ASSETS_DIR, `${sourceCharacter}-${sourceAnimation}-frames`);
    const stripPath = path.join(ASSETS_DIR, `${sourceCharacter}-${sourceAnimation}.png`);
    let sourceFrames = [];

    if (fs.existsSync(framesDir)) {
      sourceFrames = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.png'))
        .sort()
        .map(f => path.join(framesDir, f));
    }

    if (sourceFrames.length === 0 && !fs.existsSync(stripPath)) {
      return json(res, { error: `No frames found for ${sourceCharacter}-${sourceAnimation}` }, 400);
    }

    sseStart(res);
    sseSend(res, 'start', {
      sourceCharacter,
      sourceAnimation,
      targetCharacters,
      totalTargets: targetCharacters.length,
      framesPerTarget: sourceFrames.length,
    });

    const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });
    const results = {};
    let totalCost = 0;

    for (const targetChar of targetCharacters) {
      const targetPortrait = path.join(ASSETS_DIR, `${targetChar}full.png`);
      if (!fs.existsSync(targetPortrait)) {
        sseSend(res, 'target_skip', { target: targetChar, reason: 'No portrait found' });
        continue;
      }

      sseSend(res, 'target_start', { target: targetChar, totalFrames: sourceFrames.length });
      const targetFrames = [];

      // Create target frames directory
      const targetFramesDir = path.join(ASSETS_DIR, `${targetChar}-${sourceAnimation}-frames`);
      fs.mkdirSync(targetFramesDir, { recursive: true });

      for (let fi = 0; fi < sourceFrames.length; fi++) {
        sseSend(res, 'frame_start', { target: targetChar, frameIndex: fi });

        try {
          const prompt = [
            `STRICT POSE TRANSFER — REPLICATE ANIMATION FRAME`,
            ``,
            `Image 1 = source animation frame (the exact pose to replicate)`,
            `Image 2 = target character appearance reference`,
            ``,
            `This is frame ${fi + 1} of ${sourceFrames.length} in a "${sourceAnimation}" animation.`,
            ``,
            `POSE RULES:`,
            `- Match Image 1's body pose EXACTLY — same arm angles, leg positions, weight distribution`,
            `- Treat Image 1 as motion capture — do NOT reinterpret`,
            `- Copy the exact body angle, lean, center of gravity, and ball position`,
            ``,
            `CHARACTER:`,
            `- Use Image 2's face, skin tone, hairstyle, outfit, and proportions`,
            `- Maintain Image 2's exact clothing colors and build`,
            `- Character should fill ~85% of frame height`,
            ``,
            `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
            `OUTPUT: Single character, ONE frame only (NOT a strip)`,
            `Background: solid green (#00FF00), NO green on character`,
          ].join('\n');

          const result = await client.generate(prompt, {
            referenceImages: [sourceFrames[fi], targetPortrait],
            resolution: '2K',
            model: model || 'gemini-2.5-flash-image',
          });

          const framePath = path.join(targetFramesDir, `frame-${String(fi).padStart(3, '0')}.png`);
          fs.writeFileSync(framePath, result.imageBuffer);

          // Process frame (bg removal + normalization)
          try {
            await processSingleFrame(framePath, framePath);
          } catch {}

          const cost = recordCost(model || 'gemini-2.5-flash-image', 'anchor-replicate', '2K', 2, {
            sourceCharacter, targetCharacter: targetChar, animation: sourceAnimation, frame: fi,
          });
          totalCost += cost?.totalCost || 0;
          targetFrames.push(framePath);

          sseSend(res, 'frame_done', {
            target: targetChar,
            frameIndex: fi,
            url: `/assets/${targetChar}-${sourceAnimation}-frames/frame-${String(fi).padStart(3, '0')}.png`,
            cost: cost?.totalCost || 0,
          });

          // Rate limit delay
          if (fi < sourceFrames.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (err) {
          sseSend(res, 'frame_error', { target: targetChar, frameIndex: fi, error: err.message });
        }
      }

      results[targetChar] = { frames: targetFrames.length, dir: targetFramesDir };
      sseSend(res, 'target_done', { target: targetChar, completedFrames: targetFrames.length });
    }

    sseSend(res, 'complete', {
      results,
      totalCost,
      totalTargets: Object.keys(results).length,
    });
    sseEnd(res);
  });
}

module.exports = { register };
