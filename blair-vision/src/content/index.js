// Content-script entry. Injected only into tabs the user explicitly enabled.
import { MSG } from '../shared/messages.js';
import { DEFAULT_SETTINGS, isBlockedHost } from '../shared/types.js';
import { createHud } from './hud.js';
import { createObserver } from './observer.js';
import hudCss from './hud.css';

const POS_KEY = 'bv_hud_position';

(async function main() {
  if (/** @type {any} */ (window).__blairVision) return; // already injected on this page
  if (location.protocol === 'chrome:' || location.protocol === 'chrome-extension:') return;

  let settings = { ...DEFAULT_SETTINGS };
  try {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    settings = { ...DEFAULT_SETTINGS, ...stored };
  } catch { /* extension context invalidated */ return; }
  if (isBlockedHost(settings.blockedDomains, location.href)) return;

  const log = (...a) => { if (settings.debug) console.log('[Blair]', ...a); };
  const savedPos = (await chrome.storage.local.get(POS_KEY).catch(() => ({})))[POS_KEY] ?? null;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  let obs;
  const hud = createHud({
    css: hudCss,
    position: savedPos,
    onPause: () => obs.setPaused(!obs.paused),
    onSettings: () => send({ type: MSG.OPEN_OPTIONS }),
    onMove: (p) => chrome.storage.local.set({ [POS_KEY]: p }),
  });

  const isDemo = document.documentElement.hasAttribute('data-blair-demo');
  obs = createObserver({
    hud,
    log,
    getSettings: () => settings,
    analyze: (m) => send({ type: MSG.ANALYZE, ...m }),
    cancel: (requestId) => { send({ type: MSG.CANCEL, requestId }).catch(() => {}); },
    onResult: (r, p) => {
      // Only the bundled demo page gets a (string-only) event, so it can show latency / call counts.
      if (isDemo && settings.debug) {
        document.dispatchEvent(new CustomEvent('blair-vision', { detail: JSON.stringify({ answer: r.answer, source: r.source, latencyMs: r.latencyMs, question: p.question }) }));
      }
    },
  });
  /** @type {any} */ (window).__blairVision = { obs, hud };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== MSG.CONTROL) return;
    if (msg.disable) {
      obs.destroy(); hud.destroy(); delete /** @type {any} */ (window).__blairVision;
    } else if (typeof msg.paused === 'boolean') obs.setPaused(msg.paused);
    if (msg.visual) {
      hud.setState({
        kind: msg.visual.answer ? 'result' : 'error', answer: msg.visual.answer, confidence: msg.visual.confidence,
        latencyMs: msg.visual.latencyMs, source: 'fallback', pageSource: 'Screenshot (one-off)', cost: msg.visual.cost,
        message: msg.visual.error || (msg.visual.answer ? '' : 'No multiple-choice question found in the screenshot.'), reason: msg.visual.reason,
      });
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k in DEFAULT_SETTINGS)) {
      for (const k of Object.keys(changes)) if (k in DEFAULT_SETTINGS) settings[k] = changes[k].newValue ?? DEFAULT_SETTINGS[k];
      if (isBlockedHost(settings.blockedDomains, location.href)) { obs.destroy(); hud.destroy(); delete /** @type {any} */ (window).__blairVision; return; }
      obs.refresh();
    }
  });

  const st = await send({ type: MSG.GET_TAB_STATE }).catch(() => null);
  obs.start();
  if (st?.paused) obs.setPaused(true);
  log('Blair Vision active on this tab');
})();
