import { EMPTY_STATS } from './types.js';

/** Real cost when the API reports it, otherwise a flat per-call estimate. */
export function callCost(usage, settings) {
  const c = Number(usage?.cost);
  if (Number.isFinite(c) && c >= 0 && usage?.cost !== undefined) return c;
  return Number(settings?.costPerCallUsd) || 0;
}

export function formatCost(usd) {
  const n = Number(usd) || 0;
  if (n === 0) return '$0.000000';
  return '$' + (n < 0.01 ? n.toFixed(6) : n.toFixed(4));
}

export function averageLatency(stats) {
  const calls = (stats.jevCalls || 0) + (stats.fallbackCalls || 0);
  return calls ? Math.round(stats.totalLatencyMs / calls) : 0;
}

/** Pure reducer so it can be unit-tested. */
export function applyResultToStats(stats, result) {
  const s = { ...EMPTY_STATS, ...stats };
  s.questionsAnalyzed += 1;
  if (result.source === 'cache') {
    s.cacheHits += 1;
  } else {
    if (result.source === 'jev' || result.usedJev) s.jevCalls += 1;
    if (result.source === 'fallback') s.fallbackCalls += 1;
    s.estimatedCost += result.cost || 0;
    s.totalLatencyMs += result.latencyMs || 0;
  }
  return s;
}
