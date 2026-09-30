(() => {
  // src/shared/messages.js
  var MSG = {
    ANALYZE: "bv:analyze",
    // content -> bg: { requestId, question }
    CANCEL: "bv:cancel",
    // content -> bg: { requestId }
    EXPLAIN: "bv:explain",
    // content -> bg: { question }
    GET_TAB_STATE: "bv:get-tab-state",
    // content/popup -> bg
    OPEN_OPTIONS: "bv:open-options",
    ENABLE_TAB: "bv:enable-tab",
    // popup -> bg: { tabId }
    DISABLE_TAB: "bv:disable-tab",
    PAUSE_TAB: "bv:pause-tab",
    // { tabId, paused }
    ANALYZE_VISIBLE: "bv:analyze-visible",
    // popup -> bg: { tabId }
    TEST_CONNECTION: "bv:test-connection",
    CLEAR_CACHE: "bv:clear-cache",
    RESET_STATS: "bv:reset-stats",
    CONTROL: "bv:control"
    // bg -> content: { paused?, disable?, visual? }
  };

  // src/popup/popup.js
  var $ = (id) => document.getElementById(id);
  var params = new URLSearchParams(location.search);
  async function currentTab() {
    if (params.get("tabId")) return chrome.tabs.get(Number(params.get("tabId")));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  async function refresh(tab) {
    const [st, settings] = await Promise.all([
      chrome.runtime.sendMessage({ type: MSG.GET_TAB_STATE, tabId: tab.id }),
      chrome.storage.local.get("visualFallback")
    ]);
    const enabled = !!st?.enabled;
    $("status").textContent = !enabled ? "Off" : st.paused ? "Paused" : "On";
    $("status").className = `pill ${!enabled ? "off" : st.paused ? "paused" : "on"}`;
    $("enable").hidden = enabled;
    $("pause").hidden = !enabled;
    $("pause").textContent = st?.paused ? "Resume" : "Pause";
    $("disable").hidden = !enabled;
    $("visual").hidden = !(enabled && settings.visualFallback);
  }
  (async () => {
    const tab = await currentTab();
    let host = "";
    try {
      host = new URL(tab.url).host;
    } catch {
    }
    $("host").textContent = host || "This page";
    const show = (r) => {
      $("msg").textContent = r && r.ok === false ? r.error || "Something went wrong." : "";
    };
    $("enable").onclick = async () => {
      show(await chrome.runtime.sendMessage({ type: MSG.ENABLE_TAB, tabId: tab.id }));
      refresh(tab);
    };
    $("disable").onclick = async () => {
      show(await chrome.runtime.sendMessage({ type: MSG.DISABLE_TAB, tabId: tab.id }));
      refresh(tab);
    };
    $("pause").onclick = async () => {
      const st = await chrome.runtime.sendMessage({ type: MSG.GET_TAB_STATE, tabId: tab.id });
      show(await chrome.runtime.sendMessage({ type: MSG.PAUSE_TAB, tabId: tab.id, paused: !st.paused }));
      refresh(tab);
    };
    $("visual").onclick = async () => {
      $("msg").textContent = "Analyzing\u2026";
      show(await chrome.runtime.sendMessage({ type: MSG.ANALYZE_VISIBLE, tabId: tab.id }));
    };
    $("settings").onclick = (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    };
    refresh(tab);
  })();
})();
