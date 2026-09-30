// Message types exchanged between content script, service worker, popup and options page.
export const MSG = {
  ANALYZE: 'bv:analyze', // content -> bg: { requestId, question }
  CANCEL: 'bv:cancel', // content -> bg: { requestId }
  EXPLAIN: 'bv:explain', // content -> bg: { question }
  GET_TAB_STATE: 'bv:get-tab-state', // content/popup -> bg
  OPEN_OPTIONS: 'bv:open-options',
  ENABLE_TAB: 'bv:enable-tab', // popup -> bg: { tabId }
  DISABLE_TAB: 'bv:disable-tab',
  PAUSE_TAB: 'bv:pause-tab', // { tabId, paused }
  ANALYZE_VISIBLE: 'bv:analyze-visible', // popup -> bg: { tabId }
  TEST_CONNECTION: 'bv:test-connection',
  CLEAR_CACHE: 'bv:clear-cache',
  RESET_STATS: 'bv:reset-stats',
  CONTROL: 'bv:control', // bg -> content: { paused?, disable?, visual? }
};
