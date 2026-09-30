// DecisionProvider router: cache -> Jev -> (optional) reasoning fallback.
import { callCost, applyResultToStats } from '../shared/cost.js';
import { normalizeText } from '../content/fingerprint.js';

const REASONING_HINT = /\b(calculate|compute|solve|evaluate|simplify|derive|prove|how many|what is the (value|sum|product|result)|which of the following (is|are) (not|false|incorrect))\b|\d\s*[-+*/×÷^=]\s*\d/i;

export function needsReasoning(question) {
  return REASONING_HINT.test(question.question);
}

/**
 * @param {{ store: ReturnType<typeof import('../shared/storage.js').createStore>, jev: any, fallback: any, log?: (...a:any[])=>void }} deps
 */
export function createRouter({ store, jev, fallback, log: defaultLog = () => {} }) {
  const textToId = (question, text) => {
    const n = normalizeText(text);
    return question.choices.find((c) => normalizeText(c.text) === n)?.id;
  };

  async function record(result) {
    await store.updateStats((s) => applyResultToStats(s, result));
    return result;
  }

  return {
    /**
     * @param {any} question
     * @param {any} settings
     * @param {{ signal?: AbortSignal, log?: (...a:any[])=>void }} [opts]
     * @returns {Promise<import('../shared/types.js').DecisionResult>}
     */
    async analyze(question, settings, opts = {}) {
      const { signal, log = defaultLog } = opts;
      const cached = await store.cacheGet(question.contentKey);
      const cachedId = cached && textToId(question, cached.answerText);
      if (cached && cachedId) {
        log('cache hit');
        const probs = cached.probabilitiesByText
          ? Object.fromEntries(question.choices.map((c) => [c.id, cached.probabilitiesByText[normalizeText(c.text)] ?? 0]))
          : undefined;
        return record({
          answer: cachedId, answerText: cached.answerText, confidence: cached.confidence, latencyMs: cached.latencyMs,
          source: 'cache', cost: 0, probabilities: probs, lowConfidence: cached.confidence < settings.threshold, reason: cached.reason, model: cached.model,
        });
      }
      log('cache miss');

      log('Jev request started');
      const j = await jev.decide(question, settings, { signal });
      log(`Jev response ${j.latencyMs}ms`);
      let result = {
        answer: j.answer, confidence: j.confidence, latencyMs: j.latencyMs, source: 'jev', cost: callCost(j.usage, settings),
        probabilities: j.probabilities, model: j.model, usedJev: true,
      };

      const wantFallback = settings.reasoningFallback && (j.confidence < settings.threshold || j.ambiguous || needsReasoning(question));
      if (wantFallback) {
        log('reasoning fallback started');
        try {
          const f = await fallback.decide(question, settings, { signal });
          result = {
            ...result, answer: f.answer, confidence: f.confidence, source: 'fallback', reason: f.reason, model: f.model,
            latencyMs: j.latencyMs + f.latencyMs, cost: result.cost + callCost(f.usage, { costPerCallUsd: 0 }),
          };
        } catch (err) {
          if (signal?.aborted) throw err;
          log('fallback failed, keeping Jev answer:', err.message);
        }
      }

      const answerText = question.choices.find((c) => c.id === result.answer)?.text ?? '';
      result.answerText = answerText;
      result.lowConfidence = result.confidence < settings.threshold;

      // Store by text so a reordered repeat of the question still hits the cache with the right letter.
      const probabilitiesByText = result.probabilities
        ? Object.fromEntries(question.choices.map((c) => [normalizeText(c.text), result.probabilities[c.id] ?? 0]))
        : undefined;
      await store.cacheSet(question.contentKey, {
        answerText, confidence: result.confidence, latencyMs: result.latencyMs, source: result.source,
        reason: result.reason, model: result.model, probabilitiesByText,
      });
      return record(result);
    },
  };
}
