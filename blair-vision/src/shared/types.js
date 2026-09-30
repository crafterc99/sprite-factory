/**
 * @typedef {{ id: string, text: string }} Choice
 * @typedef {{
 *   question: string, choices: Choice[], context: string, url: string,
 *   fingerprint: string, contentKey: string, multi?: boolean, source?: string
 * }} QuestionPayload
 * @typedef {{
 *   answer: string, answerText: string, confidence: number, latencyMs: number,
 *   source: 'cache'|'jev'|'fallback', cost: number, probabilities?: Record<string, number>,
 *   lowConfidence: boolean, reason?: string, model?: string
 * }} DecisionResult
 */

export const PROVIDERS = {
  typesafe: { label: 'Jev / TypeSafe (System One)', endpoint: 'https://api.typesafe.ai/v1/systemone' },
  openrouter: { label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/alpha/decisions' },
  jbc: { label: 'Jev Browser Control (credits)', endpoint: 'https://jevbrowsercontrol.com/api/v1/decisions' },
};

export const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';

// Nothing secret is ever hard-coded: keys default to '' and live only in chrome.storage.local.
export const DEFAULT_SETTINGS = {
  provider: 'typesafe',
  typesafeKey: '',
  typesafeEndpoint: PROVIDERS.typesafe.endpoint, // override, e.g. the local mock: http://localhost:8787/v1/systemone
  openrouterKey: '',
  jbcKey: '',
  jbcBase: 'https://jevbrowsercontrol.com',
  jevModel: '~typesafe/jev-latest',
  threshold: 0.7,
  autoDetect: true,
  heartbeatSec: 5,
  reasoningFallback: false,
  fallbackModel: 'anthropic/claude-haiku-4.5',
  fallbackKey: '', // empty -> reuse the OpenRouter key
  visualFallback: false,
  runWhenHidden: false,
  debug: false,
  blockedDomains: 'mail.google.com\npaypal.com',
  costPerCallUsd: 0.0004, // used only when the API reports no usage.cost (estimate)
};

export const STATES = ['IDLE', 'DETECTED', 'STABILIZING', 'ANALYZING', 'ANSWERED', 'WAITING_FOR_CHANGE'];

export const EMPTY_STATS = {
  questionsAnalyzed: 0,
  cacheHits: 0,
  jevCalls: 0,
  fallbackCalls: 0,
  estimatedCost: 0,
  totalLatencyMs: 0, // over model calls only
  errors: 0,
};

export function isBlockedHost(blockedDomains, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return String(blockedDomains || '')
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
    .some((b) => host === b || host.endsWith('.' + b));
}
