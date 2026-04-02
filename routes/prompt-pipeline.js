/**
 * Prompt Pipeline Routes — Prompt Composition Engine API
 *
 * Exposes the new modular pipeline system to the UI.
 * Endpoints prefixed with /api/pipeline2/ to avoid collision with existing pipeline.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

const {
  getActivePipeline,
  getPipelineForUI,
  getModuleLibrary,
  saveModuleOverride,
  clearModuleOverride,
  saveCustomModule,
  deleteCustomModule,
} = require('../prompt-system/PromptRenderer');

const { buildFinalPrompt, validatePipeline } = require('../prompt-system/PromptPipeline');
const { buildState } = require('../prompt-system/PromptState');
const { createModule, MODULE_TYPES } = require('../prompt-system/PromptModule');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { CHARACTERS, ANIMATIONS } = require('../lib/sprite-generator/prompts');
const { recordCost } = require('../middleware/cost-tracker');
const { cutFrames, upscaleNN, processSingleFrame } = require('../lib/sprite-processor/index');

function register(router, { ASSETS_DIR, RAW_DIR, json, parseBody }) {

  // GET /api/prompt-pipeline/library
  router.get('/api/prompt-pipeline/library', (req, res) => {
    try {
      return json(res, { library: getModuleLibrary(), types: MODULE_TYPES });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/prompt-pipeline/active?animation=X&character=Y
  router.get('/api/prompt-pipeline/active', (req, res, params, query) => {
    try {
      const { animation, character = '99' } = query;
      if (!animation) return json(res, { error: 'animation required' }, 400);

      const animData = ANIMATIONS[animation];
      if (!animData) return json(res, { error: `Unknown animation: ${animation}` }, 400);

      if (!CHARACTERS[character]) {
        const pp = path.join(ASSETS_DIR, `${character}full.png`);
        CHARACTERS[character] = {
          description: fs.existsSync(pp) ? 'the character shown in Image 2' : 'the character shown in Image 2',
          style: '16-bit pixel art, GBA style',
        };
      }

      const charData = CHARACTERS[character];
      const uiData = getPipelineForUI(animation, animData);
      const pipeline = getActivePipeline(animation, animData);
      const state = buildState({
        character_name: character,
        animation_type: animData.action || animation,
        frames: animData.frames,
        fps: animData.fps,
        frame_breakdown: animData.frameBreakdown || '',
        character_description: charData?.description,
        has_pose_ref: !!animData.breezyFile,
      });

      return json(res, {
        ...uiData,
        compiledPrompt: buildFinalPrompt(pipeline, state),
        animData: {
          frames: animData.frames, fps: animData.fps, action: animData.action,
          hasBreezyRef: !!animData.breezyFile, breezyFile: animData.breezyFile || null,
        },
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/prompt-pipeline/build — compile prompt from inline modules (no persist)
  router.post('/api/prompt-pipeline/build', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { animation, character = '99', modules, mode = 'strip' } = body;
      if (!animation) return json(res, { error: 'animation required' }, 400);

      const animData = ANIMATIONS[animation];
      if (!animData) return json(res, { error: `Unknown animation: ${animation}` }, 400);

      const pipeline = modules || getActivePipeline(animation, animData);
      const charData = CHARACTERS[character];
      const state = buildState({
        character_name: character,
        animation_type: animData.action || animation,
        frames: animData.frames, fps: animData.fps, mode,
        frame_breakdown: animData.frameBreakdown || '',
        character_description: charData?.description,
        has_pose_ref: !!animData.breezyFile,
      });

      const compiledPrompt = buildFinalPrompt(pipeline, state);
      const { valid, warnings } = validatePipeline(pipeline);
      return json(res, { compiledPrompt, valid, warnings });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/prompt-pipeline/test — compile + generate test frame
  router.post('/api/prompt-pipeline/test', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { animation, character = '99', modules, model } = body;
      if (!animation) return json(res, { error: 'animation required' }, 400);

      const animData = ANIMATIONS[animation];
      if (!animData) return json(res, { error: `Unknown animation: ${animation}` }, 400);
      if (!animData.breezyFile) return json(res, { error: `No pose reference for ${animation}` }, 400);

      if (!CHARACTERS[character]) {
        CHARACTERS[character] = { description: 'the character shown in Image 2', style: '16-bit pixel art, GBA style' };
      }

      const pipeline = modules || getActivePipeline(animation, animData);
      const state = buildState({
        character_name: character,
        animation_type: animData.action || animation,
        frames: animData.frames, fps: animData.fps,
        frame_breakdown: animData.frameBreakdown || '',
        character_description: CHARACTERS[character]?.description,
        has_pose_ref: true,
      });
      const compiledPrompt = buildFinalPrompt(pipeline, state);

      const modelId = model || 'gemini-3.1-flash-image-preview';
      const client = new NanaBananaClient({ model: modelId });
      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      const poseRefPath = path.join(ASSETS_DIR, animData.breezyFile);
      if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found' }, 400);
      if (!fs.existsSync(poseRefPath)) return json(res, { error: 'Pose ref not found' }, 400);

      const labDir = path.join(RAW_DIR, `${character}-${animation}-pt`);
      fs.mkdirSync(labDir, { recursive: true });
      const refFramesDir = path.join(labDir, 'ref-frames');
      fs.mkdirSync(refFramesDir, { recursive: true });
      if (fs.readdirSync(refFramesDir).filter(f => f.endsWith('.png')).length === 0) {
        await cutFrames(poseRefPath, refFramesDir);
      }
      const refFrames = fs.readdirSync(refFramesDir).filter(f => f.endsWith('.png')).sort();
      const upscaledDir = path.join(labDir, 'upscaled');
      fs.mkdirSync(upscaledDir, { recursive: true });
      const upPath = path.join(upscaledDir, 'frame-000.png');
      if (!fs.existsSync(upPath)) {
        await upscaleNN(path.join(refFramesDir, refFrames[0]), upPath, { width: 512, height: 512 });
      }

      const outPath = path.join(labDir, `pt-test-${Date.now()}.png`);
      await client.generateSingleFrame(compiledPrompt, upPath, portraitPath, { model: modelId, outputPath: outPath });

      const costInfo = recordCost(modelId, 'pipeline_test', '1K', 2, { character, animation });
      const processedPath = outPath.replace('.png', '-proc.png');
      await processSingleFrame(outPath, processedPath, { width: 180, height: 180 });

      const relDir = path.relative(RAW_DIR, labDir);
      return json(res, {
        success: true, compiledPrompt,
        imageUrl: `/fbf-working/${relDir}/${path.basename(outPath)}`,
        processedUrl: `/fbf-working/${relDir}/${path.basename(processedPath)}`,
        cost: +(costInfo?.totalCost || 0).toFixed(4),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/prompt-pipeline/module/save
  router.post('/api/prompt-pipeline/module/save', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { animationId, moduleId, patch } = body;
      if (!animationId || !moduleId || !patch) return json(res, { error: 'animationId, moduleId, patch required' }, 400);
      saveModuleOverride(animationId, moduleId, patch);
      const uiData = getPipelineForUI(animationId, ANIMATIONS[animationId] || {});
      return json(res, { success: true, ...uiData });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/prompt-pipeline/module/override
  router.delete('/api/prompt-pipeline/module/override', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { animationId, moduleId } = body;
      if (!animationId || !moduleId) return json(res, { error: 'animationId and moduleId required' }, 400);
      clearModuleOverride(animationId, moduleId);
      const uiData = getPipelineForUI(animationId, ANIMATIONS[animationId] || {});
      return json(res, { success: true, ...uiData });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/prompt-pipeline/module/custom
  router.post('/api/prompt-pipeline/module/custom', async (req, res) => {
    try {
      const body = await parseBody(req);
      const mod = createModule(body.module || body);
      saveCustomModule(mod);
      return json(res, { success: true, module: mod });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/prompt-pipeline/module/custom
  router.delete('/api/prompt-pipeline/module/custom', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { moduleId } = body;
      if (!moduleId) return json(res, { error: 'moduleId required' }, 400);
      deleteCustomModule(moduleId);
      return json(res, { success: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/prompt-pipeline/example?animation=static-dribble
  router.get('/api/prompt-pipeline/example', (req, res, params, query) => {
    try {
      const animationId = query.animation || 'static-dribble';
      const character = query.character || '99';
      const animData = ANIMATIONS[animationId];
      if (!animData) return json(res, { error: `Unknown animation: ${animationId}` }, 400);
      const charData = CHARACTERS[character] || { description: 'the character in Image 2', style: '16-bit pixel art' };
      const pipeline = getActivePipeline(animationId, animData);
      const state = buildState({
        character_name: character,
        animation_type: animData.action || animationId,
        frames: animData.frames, fps: animData.fps,
        frame_breakdown: animData.frameBreakdown || '',
        character_description: charData.description,
        has_pose_ref: !!animData.breezyFile,
      });
      const compiledPrompt = buildFinalPrompt(pipeline, state);
      const { valid, warnings } = validatePipeline(pipeline);
      return json(res, {
        animationId, character, compiledPrompt,
        pipelineSummary: pipeline.filter(m => m.enabled).sort((a,b)=>a.order-b.order).map(m => `[${m.type}] ${m.title}`),
        valid, warnings,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
