// Blair Vision service worker: owns API keys, provider calls, cache, stats and per-tab enablement.
import { MSG } from '../shared/messages.js';
import { createStore } from '../shared/storage.js';
import { isBlockedHost } from '../shared/types.js';
import { callCost } from '../shared/cost.js';
import { createJevProvider, ProviderError } from '../providers/jev.js';
import { createFallbackProvider } from '../providers/fallback-llm.js';
import { createRouter } from './provider-router.js';

const store = createStore(chrome.storage.local);
const router = createRouter({ store, jev: createJevProvider(), fallback: createFallbackProvider() });
const TABS_KEY = 'bv_tabs';

/** tabId -> { requestId, ac } (one in-flight analysis per tab; a newer one aborts the older) */
const inflight = new Map();

// ---- per-tab state (chrome.storage.session survives service-worker restarts) ----
let tabsQueue = Promise.resolve();
function withTabs(fn) {
  const run = tabsQueue.then(async () => {
    const { [TABS_KEY]: tabs = {} } = await chrome.storage.session.get(TABS_KEY);
    const out = await fn(tabs);
    await chrome.storage.session.set({ [TABS_KEY]: tabs });
    return out;
  });
  tabsQueue = run.catch(() => {});
  return run;
}
const getTab = async (tabId) => (await chrome.storage.session.get(TABS_KEY))[TABS_KEY]?.[tabId] ?? null;

async function setBadge(tabId, text, color = '#2d7d46') {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch { /* tab gone */ }
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function enableTab(tabId) {
  const settings = await store.getSettings();
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && isBlockedHost(settings.blockedDomains, tab.url)) return { ok: false, error: 'This domain is in your blocked list.' };
  if (tab.url && !/^(https?|file):/.test(tab.url)) return { ok: false, error: 'Blair Vision cannot run on this kind of page.' };
  try { await inject(tabId); } catch (e) { return { ok: false, error: `Could not inject: ${e.message}` }; }
  await withTabs((t) => { t[tabId] = { enabled: true, paused: false }; });
  await setBadge(tabId, 'ON');
  return { ok: true };
}

async function disableTab(tabId) {
  abortTab(tabId);
  await withTabs((t) => { delete t[tabId]; });
  await chrome.tabs.sendMessage(tabId, { type: MSG.CONTROL, disable: true }).catch(() => {});
  await setBadge(tabId, '');
  return { ok: true };
}

async function pauseTab(tabId, paused) {
  await withTabs((t) => { if (t[tabId]) t[tabId].paused = paused; });
  if (paused) abortTab(tabId);
  await chrome.tabs.sendMessage(tabId, { type: MSG.CONTROL, paused }).catch(() => {});
  await setBadge(tabId, paused ? 'II' : 'ON', paused ? '#8a8f99' : '#2d7d46');
  return { ok: true };
}

function abortTab(tabId) {
  const cur = inflight.get(tabId);
  if (cur) { cur.ac.abort(); inflight.delete(tabId); }
}

// ---- analysis ----
async function analyze(tabId, requestId, question) {
  const tab = await getTab(tabId);
  if (!tab?.enabled) return { ok: false, error: 'Blair Vision is not enabled on this tab.', code: 'disabled' }; // privacy gate
  if (tab.paused) return { ok: false, aborted: true };
  const settings = await store.getSettings();
  const log = (...a) => { if (settings.debug) console.log('[Blair]', ...a); };

  abortTab(tabId); // a newer question supersedes the older request
  const ac = new AbortController();
  inflight.set(tabId, { requestId, ac });
  try {
    const result = await router.analyze(question, settings, { signal: ac.signal, log });
    if (inflight.get(tabId)?.requestId !== requestId) return { ok: false, aborted: true };
    inflight.delete(tabId);
    return { ok: true, result };
  } catch (err) {
    if (ac.signal.aborted || err?.name === 'AbortError') return { ok: false, aborted: true };
    if (inflight.get(tabId)?.requestId === requestId) inflight.delete(tabId);
    await store.updateStats((s) => ({ ...s, errors: s.errors + 1 }));
    log('error:', err.message);
    return { ok: false, error: err.message, code: err instanceof ProviderError ? err.code : 'error' };
  }
}

async function testConnection() {
  const settings = await store.getSettings();
  const question = {
    question: 'What is 2 + 2?', choices: [{ id: 'A', text: '3' }, { id: 'B', text: '4' }, { id: 'C', text: '5' }], context: '', url: '',
  };
  try {
    const r = await createJevProvider().decide(question, settings);
    return { ok: true, answer: r.answer, confidence: r.confidence, latencyMs: r.latencyMs, cost: callCost(r.usage, settings), model: r.model };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

async function analyzeVisible(tabId) {
  const settings = await store.getSettings();
  if (!settings.visualFallback) return { ok: false, error: 'Enable “Visual fallback” in settings first.' };
  const tab = await getTab(tabId);
  if (!tab?.enabled) return { ok: false, error: 'Enable Blair Vision on this tab first.' };
  try {
    const t = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 60 }); // one shot, only on request
    const r = await createFallbackProvider().analyzeImage(dataUrl, settings);
    const cost = callCost(r.usage, settings);
    await store.updateStats((s) => ({ ...s, fallbackCalls: s.fallbackCalls + 1, estimatedCost: s.estimatedCost + cost, totalLatencyMs: s.totalLatencyMs + r.latencyMs }));
    await chrome.tabs.sendMessage(tabId, { type: MSG.CONTROL, visual: { answer: r.answer, confidence: r.confidence, latencyMs: r.latencyMs, cost, reason: r.reason } });
    return { ok: true, answer: r.answer };
  } catch (e) {
    await chrome.tabs.sendMessage(tabId, { type: MSG.CONTROL, visual: { error: e.message } }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// ---- message routing ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId ?? sender.tab?.id; // popup/options pass tabId explicitly; content scripts are identified by sender
  const run = async () => {
    switch (msg?.type) {
      case MSG.ANALYZE: return analyze(tabId, msg.requestId, msg.question);
      case MSG.CANCEL: {
        const cur = inflight.get(tabId);
        if (cur && cur.requestId === msg.requestId) abortTab(tabId);
        return { ok: true };
      }
      case MSG.GET_TAB_STATE: return (await getTab(tabId)) ?? { enabled: false, paused: false };
      case MSG.OPEN_OPTIONS: await chrome.runtime.openOptionsPage(); return { ok: true };
      case MSG.ENABLE_TAB: return enableTab(msg.tabId);
      case MSG.DISABLE_TAB: return disableTab(msg.tabId);
      case MSG.PAUSE_TAB: return pauseTab(msg.tabId, msg.paused);
      case MSG.ANALYZE_VISIBLE: return analyzeVisible(msg.tabId);
      case MSG.TEST_CONNECTION: return testConnection();
      case MSG.CLEAR_CACHE: await store.cacheClear(); return { ok: true };
      case MSG.RESET_STATS: await store.resetStats(); return { ok: true };
      default: return undefined;
    }
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// Keep enabled tabs enabled across (same-origin) navigations; forget closed tabs.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const tab = await getTab(tabId);
  if (!tab?.enabled) return;
  const settings = await store.getSettings();
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.url && isBlockedHost(settings.blockedDomains, t.url)) throw new Error('blocked');
    await inject(tabId);
  } catch {
    await withTabs((s) => { delete s[tabId]; }); // permission for the new origin is gone: user must re-enable
    await setBadge(tabId, '');
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { abortTab(tabId); withTabs((t) => { delete t[tabId]; }); });
