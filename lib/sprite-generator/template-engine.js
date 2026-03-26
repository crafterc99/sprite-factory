/**
 * Template Engine — Phase 8 of Sprite Production Studio
 *
 * Handles saving, loading, and applying animation templates.
 * A template captures a known-good animation (e.g., Breezy's dribble)
 * so it can be reused as a pose reference when generating the same
 * animation for other characters.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = path.resolve(__dirname, '../../templates');

// Ensure the templates directory exists on module load
if (!fs.existsSync(TEMPLATES_DIR)) {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively remove a directory and all its contents.
 * Works on Node 14+ (uses fs.rmSync where available, falls back to manual).
 */
function removeDir(dirPath) {
  if (fs.rmSync) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } else {
    // Fallback for older Node versions
    if (fs.existsSync(dirPath)) {
      for (const entry of fs.readdirSync(dirPath)) {
        const entryPath = path.join(dirPath, entry);
        if (fs.lstatSync(entryPath).isDirectory()) {
          removeDir(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      }
      fs.rmdirSync(dirPath);
    }
  }
}

/**
 * Copy a file from src to dest, creating parent directories as needed.
 */
function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Save a current animation as a template.
 *
 * @param {object} opts
 * @param {string} opts.character    - Source character name (e.g. 'breezy')
 * @param {string} opts.animation    - Animation name (e.g. 'dribble')
 * @param {string} opts.stripPath    - Absolute path to the sprite-strip image
 * @param {string[]} opts.framePaths - Paths to individual frame images
 * @param {number} [opts.quality]    - Quality score 0-100 (if available)
 * @param {string} [opts.model]      - AI model used for generation
 * @param {object} [opts.promptSections] - Prompt sections used during generation
 * @param {string} [opts.name]       - Human-readable template name
 * @returns {object} The saved template object
 */
function saveTemplate(opts) {
  const {
    character,
    animation,
    stripPath,
    framePaths = [],
    quality,
    model,
    promptSections,
    name,
  } = opts;

  const id = `${character}-${animation}-${Date.now()}`;
  const templateDir = path.join(TEMPLATES_DIR, id);

  // Create the template directory
  fs.mkdirSync(templateDir, { recursive: true });

  // Copy the strip image into the template directory
  const stripFilename = path.basename(stripPath);
  const newStripPath = path.join(templateDir, stripFilename);
  copyFile(stripPath, newStripPath);

  // Copy each frame image into the template directory
  const newFramePaths = framePaths.map((fp) => {
    const frameFilename = path.basename(fp);
    const dest = path.join(templateDir, frameFilename);
    copyFile(fp, dest);
    return dest;
  });

  // Build the template object
  const template = {
    id,
    name: name || `${character} ${animation} (Template)`,
    sourceCharacter: character,
    animation,
    stripPath: newStripPath,
    framePaths: newFramePaths,
    frameCount: framePaths.length,
    metadata: {
      createdAt: new Date().toISOString(),
      quality: quality != null ? quality : null,
      model: model || null,
      promptSections: promptSections || null,
    },
  };

  // Write the metadata JSON
  const metadataPath = path.join(templateDir, 'template.json');
  fs.writeFileSync(metadataPath, JSON.stringify(template, null, 2), 'utf-8');

  return template;
}

/**
 * Load a template by its ID.
 *
 * @param {string} templateId - The template ID (directory name)
 * @returns {object|null} The template object, or null if not found
 */
function loadTemplate(templateId) {
  const metadataPath = path.join(TEMPLATES_DIR, templateId, 'template.json');

  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(metadataPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[template-engine] Failed to load template "${templateId}":`, err.message);
    return null;
  }
}

/**
 * List all saved templates, optionally filtered by animation and/or character.
 *
 * @param {object} [filter]
 * @param {string} [filter.animation] - Filter by animation name
 * @param {string} [filter.character] - Filter by source character
 * @returns {object[]} Array of template objects, sorted by createdAt descending
 */
function listTemplates(filter) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  const templates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadataPath = path.join(TEMPLATES_DIR, entry.name, 'template.json');
    if (!fs.existsSync(metadataPath)) continue;

    try {
      const raw = fs.readFileSync(metadataPath, 'utf-8');
      const template = JSON.parse(raw);
      templates.push(template);
    } catch (err) {
      // Skip malformed template directories
      console.error(`[template-engine] Skipping "${entry.name}":`, err.message);
    }
  }

  // Apply optional filters
  let filtered = templates;

  if (filter) {
    if (filter.animation) {
      filtered = filtered.filter(
        (t) => t.animation === filter.animation
      );
    }
    if (filter.character) {
      filtered = filtered.filter(
        (t) => t.sourceCharacter === filter.character
      );
    }
  }

  // Sort by createdAt descending (most recent first)
  filtered.sort((a, b) => {
    const dateA = a.metadata && a.metadata.createdAt ? a.metadata.createdAt : '';
    const dateB = b.metadata && b.metadata.createdAt ? b.metadata.createdAt : '';
    return dateB.localeCompare(dateA);
  });

  return filtered;
}

/**
 * Delete a template by its ID.
 *
 * @param {string} templateId - The template ID to delete
 * @returns {{ success: boolean }}
 */
function deleteTemplate(templateId) {
  const templateDir = path.join(TEMPLATES_DIR, templateId);

  if (!fs.existsSync(templateDir)) {
    console.error(`[template-engine] Template "${templateId}" not found.`);
    return { success: false };
  }

  removeDir(templateDir);
  return { success: true };
}

/**
 * Apply a template's frames as a pose reference for a new character.
 *
 * This does NOT generate any new sprites — it copies the template's
 * reference images into the target assets directory so the generation
 * pipeline can use them as pose/motion references.
 *
 * @param {string} templateId       - The template to apply
 * @param {string} targetCharacter  - The character to generate for
 * @param {string} assetsDir        - Directory to place reference images in
 * @returns {object} Reference setup info for the generation pipeline
 */
function applyTemplate(templateId, targetCharacter, assetsDir) {
  const template = loadTemplate(templateId);

  if (!template) {
    throw new Error(`Template "${templateId}" not found.`);
  }

  // Ensure the assets directory exists
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  // Copy the strip as the pose reference
  const stripFilename = path.basename(template.stripPath);
  const refStripPath = path.join(assetsDir, `ref-${stripFilename}`);
  copyFile(template.stripPath, refStripPath);

  // Copy individual frames as reference frames
  const refFramePaths = template.framePaths.map((fp) => {
    const frameFilename = path.basename(fp);
    const dest = path.join(assetsDir, `ref-${frameFilename}`);
    copyFile(fp, dest);
    return dest;
  });

  return {
    templateId: template.id,
    targetCharacter,
    refStripPath,
    refFramePaths,
    promptSections: template.metadata.promptSections || null,
  };
}

/**
 * Get absolute paths to all frame PNG images stored in a template.
 *
 * @param {string} templateId - The template ID
 * @returns {string[]} Array of absolute paths to frame PNGs
 */
function getTemplateFrames(templateId) {
  const templateDir = path.join(TEMPLATES_DIR, templateId);

  if (!fs.existsSync(templateDir)) {
    return [];
  }

  // First try loading from the template metadata (most reliable)
  const template = loadTemplate(templateId);
  if (template && template.framePaths && template.framePaths.length > 0) {
    // Filter to only paths that still exist on disk
    return template.framePaths.filter((fp) => fs.existsSync(fp));
  }

  // Fallback: scan the directory for PNG files (excluding the strip)
  const files = fs.readdirSync(templateDir);
  const framePaths = files
    .filter((f) => f.endsWith('.png') && !f.includes('strip'))
    .sort()
    .map((f) => path.join(templateDir, f));

  return framePaths;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  TEMPLATES_DIR,
  saveTemplate,
  loadTemplate,
  listTemplates,
  deleteTemplate,
  applyTemplate,
  getTemplateFrames,
};
