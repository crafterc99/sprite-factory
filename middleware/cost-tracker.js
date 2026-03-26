/**
 * Cost Tracker Middleware — Extracted from server.js
 * Tracks Gemini API spend per model, type, and generation.
 */
const fs = require('fs');
const path = require('path');

const COST_FILE = path.resolve(__dirname, '../../../.cost-tracking.json');

// Per-image cost by model and resolution (USD)
const COST_PER_IMAGE = {
  'gemini-2.5-flash-image':         { '1K': 0.039, '2K': 0.039, '4K': 0.039 },
  'gemini-3.1-flash-image-preview': { '0.5K': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
  'gemini-3-pro-image-preview':     { '1K': 0.134, '2K': 0.134, '4K': 0.240 },
};

// Input image token cost (per image uploaded as reference)
const INPUT_IMAGE_TOKENS = {
  'gemini-2.5-flash-image':         { tokens: 560, costPer1M: 0.30 },
  'gemini-3.1-flash-image-preview': { tokens: 560, costPer1M: 0.50 },
  'gemini-3-pro-image-preview':     { tokens: 560, costPer1M: 2.00 },
};

function getImageCost(modelId, resolution = '2K') {
  const modelCosts = COST_PER_IMAGE[modelId] || COST_PER_IMAGE['gemini-2.5-flash-image'];
  return modelCosts[resolution] || modelCosts['2K'] || 0.039;
}

function getInputCost(modelId, numRefImages = 2) {
  const info = INPUT_IMAGE_TOKENS[modelId] || INPUT_IMAGE_TOKENS['gemini-2.5-flash-image'];
  return (info.tokens * numRefImages / 1_000_000) * info.costPer1M;
}

function loadCostData() {
  try {
    if (fs.existsSync(COST_FILE)) return JSON.parse(fs.readFileSync(COST_FILE, 'utf8'));
  } catch {}
  return { totalSpend: 0, totalGenerations: 0, byModel: {}, byType: {}, history: [] };
}

function saveCostData(data) {
  const dir = path.dirname(COST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COST_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record a generation cost.
 * @param {string} model - Model ID used
 * @param {string} type - 'strip' | 'fbf_frame' | 'character' | 'video'
 * @param {string} resolution - '1K' | '2K' | '4K'
 * @param {number} numRefImages - Number of reference images sent
 * @param {object} meta - { character, animation, frame }
 */
function recordCost(model, type, resolution = '2K', numRefImages = 2, meta = {}) {
  const data = loadCostData();
  const imageCost = getImageCost(model, resolution);
  const inputCost = getInputCost(model, numRefImages);
  const totalCost = imageCost + inputCost;

  data.totalSpend += totalCost;
  data.totalGenerations++;

  // By model
  if (!data.byModel[model]) data.byModel[model] = { spend: 0, count: 0 };
  data.byModel[model].spend += totalCost;
  data.byModel[model].count++;

  // By type
  if (!data.byType[type]) data.byType[type] = { spend: 0, count: 0 };
  data.byType[type].spend += totalCost;
  data.byType[type].count++;

  // History (keep last 200)
  data.history.push({
    model,
    type,
    resolution,
    imageCost,
    inputCost,
    totalCost,
    ...meta,
    timestamp: new Date().toISOString(),
  });
  if (data.history.length > 200) data.history = data.history.slice(-200);

  saveCostData(data);
  return { totalCost, imageCost, inputCost, runningTotal: data.totalSpend };
}

module.exports = {
  COST_PER_IMAGE,
  INPUT_IMAGE_TOKENS,
  getImageCost,
  getInputCost,
  loadCostData,
  saveCostData,
  recordCost,
};
