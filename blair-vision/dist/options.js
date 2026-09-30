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

  // src/shared/types.js
  var PROVIDERS = {
    typesafe: { label: "Jev / TypeSafe (System One)", endpoint: "https://api.typesafe.ai/v1/systemone" },
    openrouter: { label: "OpenRouter", endpoint: "https://openrouter.ai/api/alpha/decisions" },
    jbc: { label: "Jev Browser Control (credits)", endpoint: "https://jevbrowsercontrol.com/api/v1/decisions" }
  };
  var DEFAULT_SETTINGS = {
    provider: "typesafe",
    typesafeKey: "",
    typesafeEndpoint: PROVIDERS.typesafe.endpoint,
    // override, e.g. the local mock: http://localhost:8787/v1/systemone
    openrouterKey: "",
    jbcKey: "",
    jbcBase: "https://jevbrowsercontrol.com",
    jevModel: "~typesafe/jev-latest",
    threshold: 0.7,
    autoDetect: true,
    heartbeatSec: 5,
    reasoningFallback: false,
    fallbackModel: "anthropic/claude-haiku-4.5",
    fallbackKey: "",
    // empty -> reuse the OpenRouter key
    visualFallback: false,
    runWhenHidden: false,
    debug: false,
    blockedDomains: "mail.google.com\npaypal.com",
    costPerCallUsd: 4e-4
    // used only when the API reports no usage.cost (estimate)
  };
  var EMPTY_STATS = {
    questionsAnalyzed: 0,
    cacheHits: 0,
    jevCalls: 0,
    fallbackCalls: 0,
    estimatedCost: 0,
    totalLatencyMs: 0,
    // over model calls only
    errors: 0
  };

  // src/shared/storage.js
  var CACHE_KEY = "bv_cache";
  var STATS_KEY = "bv_stats";
  var CACHE_LIMIT = 500;
  function queue() {
    let p = Promise.resolve();
    return (fn) => {
      const run = p.then(fn, fn);
      p = run.catch(() => {
      });
      return run;
    };
  }
  function createStore(area) {
    const enqueue = queue();
    const store2 = {
      async getSettings() {
        const stored = await area.get(Object.keys(DEFAULT_SETTINGS));
        return { ...DEFAULT_SETTINGS, ...stored };
      },
      async saveSettings(patch) {
        const clean = {};
        for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) clean[k] = v;
        await area.set(clean);
        return store2.getSettings();
      },
      // fingerprint (contentKey) -> { answerText, answer, confidence, latencyMs, probabilities, source, ts }
      async cacheGet(key) {
        const { [CACHE_KEY]: cache = {} } = await area.get(CACHE_KEY);
        return cache[key] || null;
      },
      cacheSet(key, entry) {
        return enqueue(async () => {
          const { [CACHE_KEY]: cache = {} } = await area.get(CACHE_KEY);
          cache[key] = { ...entry, ts: Date.now() };
          const keys = Object.keys(cache);
          if (keys.length > CACHE_LIMIT) {
            keys.sort((a, b) => cache[a].ts - cache[b].ts).slice(0, keys.length - CACHE_LIMIT).forEach((k) => delete cache[k]);
          }
          await area.set({ [CACHE_KEY]: cache });
        });
      },
      async cacheSize() {
        const { [CACHE_KEY]: cache = {} } = await area.get(CACHE_KEY);
        return Object.keys(cache).length;
      },
      cacheClear: () => enqueue(() => area.remove(CACHE_KEY)),
      async getStats() {
        const { [STATS_KEY]: s = {} } = await area.get(STATS_KEY);
        return { ...EMPTY_STATS, ...s };
      },
      updateStats(reducer) {
        return enqueue(async () => {
          const { [STATS_KEY]: s = {} } = await area.get(STATS_KEY);
          const next = reducer({ ...EMPTY_STATS, ...s });
          await area.set({ [STATS_KEY]: next });
          return next;
        });
      },
      resetStats: () => enqueue(() => area.remove(STATS_KEY))
    };
    return store2;
  }

  // src/shared/cost.js
  function formatCost(usd) {
    const n = Number(usd) || 0;
    if (n === 0) return "$0.000000";
    return "$" + (n < 0.01 ? n.toFixed(6) : n.toFixed(4));
  }
  function averageLatency(stats) {
    const calls = (stats.jevCalls || 0) + (stats.fallbackCalls || 0);
    return calls ? Math.round(stats.totalLatencyMs / calls) : 0;
  }

  // src/options/options.js
  var store = createStore(chrome.storage.local);
  var $ = (id) => document.getElementById(id);
  var FIELDS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== "provider" && k !== "costPerCallUsd");
  function showProvider(p) {
    document.querySelectorAll("[data-for]").forEach((d) => {
      d.hidden = d.dataset.for !== p;
    });
  }
  async function load() {
    const s = await store.getSettings();
    document.querySelector(`input[name=provider][value=${s.provider}]`).checked = true;
    showProvider(s.provider);
    for (const k of FIELDS) {
      const el = $(k);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!s[k];
      else el.value = s[k];
    }
    $("fallbackFields").hidden = !s.reasoningFallback;
  }
  var saveTimer;
  async function doSave() {
    const patch = { provider: document.querySelector("input[name=provider]:checked").value };
    for (const k of FIELDS) {
      const el = $(k);
      if (!el) continue;
      if (el.type === "checkbox") patch[k] = el.checked;
      else if (el.type === "number") patch[k] = Number(el.value);
      else patch[k] = el.value.trim();
    }
    await store.saveSettings(patch);
    $("saved").textContent = "Saved.";
    setTimeout(() => {
      $("saved").textContent = "";
    }, 1200);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 250);
  }
  async function renderStats() {
    const s = await store.getStats();
    const rows = [
      ["Questions analyzed", s.questionsAnalyzed],
      ["Cache hits", s.cacheHits],
      ["Jev calls", s.jevCalls],
      ["Fallback calls", s.fallbackCalls],
      ["Estimated cost", formatCost(s.estimatedCost)],
      ["Average latency", `${averageLatency(s)} ms`],
      ["Errors", s.errors]
    ];
    $("stats").replaceChildren(...rows.map(([k, v]) => {
      const tr = document.createElement("tr");
      const a = document.createElement("td");
      a.textContent = k;
      const b = document.createElement("td");
      b.textContent = String(v);
      tr.append(a, b);
      return tr;
    }));
    $("cacheInfo").textContent = `${await store.cacheSize()} cached questions`;
  }
  document.querySelectorAll("input, textarea").forEach((el) => {
    el.addEventListener("change", () => {
      if (el.name === "provider") showProvider(el.value);
      if (el.id === "reasoningFallback") $("fallbackFields").hidden = !el.checked;
      save();
    });
  });
  $("test").onclick = async () => {
    clearTimeout(saveTimer);
    await doSave();
    const out = $("testResult");
    out.className = "";
    out.textContent = "Testing\u2026";
    const r = await chrome.runtime.sendMessage({ type: MSG.TEST_CONNECTION });
    if (r.ok) {
      out.className = "ok";
      out.textContent = `OK \u2014 chose ${r.answer} (${Math.round(r.confidence * 100)}%) in ${r.latencyMs} ms`;
    } else {
      out.className = "bad";
      out.textContent = r.error;
    }
    renderStats();
  };
  $("clearCache").onclick = async () => {
    await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE });
    renderStats();
  };
  $("resetStats").onclick = async () => {
    await chrome.runtime.sendMessage({ type: MSG.RESET_STATS });
    renderStats();
  };
  chrome.storage.onChanged.addListener((c) => {
    if (c.bv_stats || c.bv_cache) renderStats();
  });
  load().then(renderStats);
})();
