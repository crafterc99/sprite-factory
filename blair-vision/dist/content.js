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
  function isBlockedHost(blockedDomains, url) {
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return String(blockedDomains || "").split(/[\n,]+/).map((s) => s.trim().toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean).some((b) => host === b || host.endsWith("." + b));
  }

  // src/shared/cost.js
  function formatCost(usd) {
    const n = Number(usd) || 0;
    if (n === 0) return "$0.000000";
    return "$" + (n < 0.01 ? n.toFixed(6) : n.toFixed(4));
  }

  // src/content/hud.js
  var PILL_TEXT = { idle: "\xB7", detecting: "\u2026", paused: "II", error: "!", visual: "\u25EB" };
  var MARGIN = 8;
  function createHud({ doc = document, css = "", position = null, onPause = () => {
  }, onSettings = () => {
  }, onMove = () => {
  } } = {}) {
    const win = doc.defaultView;
    const host = doc.createElement("div");
    host.id = "blair-vision-host";
    host.setAttribute("data-blair-vision", "");
    const shadow = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = css;
    const root = doc.createElement("div");
    root.className = "root";
    root.dataset.kind = "idle";
    const pill = doc.createElement("div");
    pill.className = "pill";
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.setAttribute("aria-label", "Blair Vision");
    const panel = doc.createElement("div");
    panel.className = "panel";
    const live = doc.createElement("div");
    live.className = "sr";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    root.append(pill, panel, live);
    shadow.append(style, root);
    let pos = position;
    let state = { kind: "idle" };
    let pinned = false;
    let hoverTimer = null;
    let dragging = false;
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== void 0) e.textContent = text;
      return e;
    };
    const row = (k, v) => {
      const r = el("div", "row");
      r.append(el("span", "k", k), el("span", "v", v));
      return r;
    };
    function place() {
      const w = win.innerWidth, h = win.innerHeight;
      const size = pill.getBoundingClientRect();
      const pw = size.width || 44, ph = size.height || 44;
      if (!pos) pos = { x: Math.max(MARGIN, w - pw - 16), y: 72 };
      pos = { x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, w - pw - MARGIN)), y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, h - ph - MARGIN)) };
      root.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      root.dataset.side = pos.x + pw / 2 > w / 2 ? "right" : "left";
      root.dataset.flip = pos.y > h * 0.6 ? "1" : "0";
    }
    function renderPill() {
      pill.replaceChildren();
      const { kind } = state;
      if (kind === "thinking") {
        const d = el("span", "dots");
        d.append(el("span", "", "\u2022"), el("span", "", "\u2022"), el("span", "", "\u2022"));
        pill.append(d);
      } else if (kind === "result") pill.textContent = state.answer;
      else if (kind === "low") pill.textContent = `${state.answer} ?`;
      else pill.textContent = PILL_TEXT[kind] ?? "\xB7";
      root.dataset.kind = kind;
      const said = kind === "result" ? `Answer ${state.answer}` : kind === "low" ? `Low confidence answer ${state.answer}` : kind === "error" ? "Error" : kind === "thinking" ? "Thinking" : "";
      live.textContent = said;
      pill.setAttribute("aria-label", `Blair Vision: ${said || kind}`);
    }
    function renderPanel() {
      panel.replaceChildren();
      panel.append(el("div", "title", "Blair Vision"));
      const s = state;
      if (s.answer) {
        panel.append(row("Answer", s.answer + (s.answerText ? ` \u2014 ${s.answerText.slice(0, 40)}` : "")));
        panel.append(row("Confidence", `${Math.round((s.confidence ?? 0) * 100)}%`));
        panel.append(row(s.source === "fallback" ? "Latency" : "Jev latency", `${Math.round(s.latencyMs ?? 0)} ms`));
        panel.append(row("Source", `${s.pageSource ?? "DOM"}${s.source === "cache" ? " (cached)" : s.source === "fallback" ? " (fallback)" : ""}`));
        panel.append(row("Cost", formatCost(s.cost)));
      } else {
        panel.append(row("Status", { idle: "Watching for a question", detecting: "Question detected", thinking: "Thinking\u2026", paused: "Paused", error: "Error", visual: "Visual content detected" }[s.kind] ?? s.kind));
      }
      if (s.message) panel.append(el("div", "msg", s.message));
      const dist = el("div", "dist");
      if (s.probabilities) {
        for (const [id, p] of Object.entries(s.probabilities).sort((a, b) => b[1] - a[1])) {
          const bar = el("div", "bar");
          const track = el("div", "track");
          const fill = el("div", "fill");
          fill.style.width = `${Math.round(p * 100)}%`;
          track.append(fill);
          bar.append(el("span", "lbl", id), track, el("span", "pct", `${Math.round(p * 100)}%`));
          dist.append(bar);
        }
        if (s.reason) dist.append(el("div", "row", s.reason));
      } else dist.append(el("div", "row", "No probabilities yet."));
      panel.append(dist);
      const btns = el("div", "btns");
      const bPause = el("button", "b-pause", state.kind === "paused" ? "Resume" : "Pause");
      const bExplain = el("button", "b-explain", "Explain");
      const bSettings = el("button", "b-settings", "Settings");
      bPause.addEventListener("click", () => onPause());
      bExplain.addEventListener("click", () => dist.classList.toggle("show"));
      bSettings.addEventListener("click", () => onSettings());
      btns.append(bPause, bExplain, bSettings);
      panel.append(btns);
    }
    function setOpen(open) {
      root.classList.toggle("open", open);
      if (open) place();
    }
    let drag = null;
    pill.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
      try {
        pill.setPointerCapture(e.pointerId);
      } catch {
      }
    });
    pill.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      dragging = true;
      root.classList.add("dragging");
      pos = { x: drag.ox + dx, y: drag.oy + dy };
      place();
    });
    const endDrag = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      dragging = false;
      root.classList.remove("dragging");
      if (moved) onMove({ ...pos });
      else {
        pinned = !pinned;
        setOpen(pinned);
      }
    };
    pill.addEventListener("pointerup", endDrag);
    pill.addEventListener("pointercancel", () => {
      drag = null;
      dragging = false;
      root.classList.remove("dragging");
    });
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pinned = !pinned;
        setOpen(pinned);
      }
    });
    root.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!dragging) setOpen(true);
      }, 250);
    });
    root.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      if (!pinned) setOpen(false);
    });
    win.addEventListener("resize", place);
    const attach = () => {
      if (!host.isConnected) doc.documentElement.append(host);
    };
    attach();
    renderPill();
    renderPanel();
    place();
    return {
      host,
      /** @param {{kind:string, answer?:string, answerText?:string, confidence?:number, latencyMs?:number, source?:string, pageSource?:string, cost?:number, message?:string, probabilities?:Record<string,number>, reason?:string}} next */
      setState(next) {
        state = next;
        attach();
        renderPill();
        renderPanel();
        place();
      },
      get state() {
        return state;
      },
      destroy() {
        clearTimeout(hoverTimer);
        win.removeEventListener("resize", place);
        host.remove();
      }
    };
  }

  // src/content/extractor.js
  var SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "HEAD", "SELECT", "TEXTAREA", "INPUT"]);
  var BOILERPLATE = "nav, footer, [role=navigation], [role=contentinfo], [role=banner], [role=search], [role=menu], [role=menubar], [role=toolbar], [role=complementary]";
  var BLOCK_TAGS = /* @__PURE__ */ new Set(["P", "DIV", "LI", "UL", "OL", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "SECTION", "ARTICLE", "PRE", "BLOCKQUOTE", "FIELDSET", "LEGEND", "LABEL", "FORM", "TABLE"]);
  var SENSITIVE_NAME = /pass(word|wd)?|pwd|passcode|card|cc-?num|cvv|cvc|expir|iban|routing|ssn|social.?sec|token|secret|api.?key|otp|2fa/i;
  var SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\s|$)/i;
  function hasLayout(doc) {
    return doc.documentElement.getClientRects().length > 0;
  }
  function isVisible(el, layout = true) {
    const view = el.ownerDocument.defaultView;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (
        /** @type {HTMLElement} */
        n.hidden || n.getAttribute("aria-hidden") === "true"
      ) return false;
      const cs = view.getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
      if (n === el && cs.opacity === "0") return false;
    }
    if (!layout) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function isSensitiveField(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["password", "hidden", "file"].includes(type)) return true;
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "")) return true;
    const hay = [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label")].filter(Boolean).join(" ");
    return SENSITIVE_NAME.test(hay);
  }
  function isBoilerplate(el) {
    return !!el.closest(BOILERPLATE);
  }
  function scrub(text) {
    return text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, "[redacted]").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\b(?:sk|pk|rk|jbc|ghp|xox[bp])[-_][A-Za-z0-9_-]{16,}\b/g, "[redacted]").replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted]");
  }
  function collapse(s) {
    return s.replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  }
  function textOf(root, o = {}) {
    const { cap = 2e3, skip, boilerplate = true } = o;
    const view = root.ownerDocument.defaultView;
    let out = "";
    let budget = 4e3;
    const walk = (node) => {
      if (out.length >= cap || budget-- <= 0) return;
      if (node.nodeType === 3) {
        out += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = (
        /** @type {Element} */
        node
      );
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (skip && skip.has(el)) return;
      if (el !== root) {
        if (
          /** @type {HTMLElement} */
          el.hidden || el.getAttribute("aria-hidden") === "true"
        ) return;
        const cs = view.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        if (!boilerplate && el.matches(BOILERPLATE)) return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += "\n";
      for (const child of el.childNodes) walk(child);
      if (block) out += "\n";
    };
    walk(root);
    return collapse(scrub(out)).slice(0, cap);
  }
  function labelTextFor(input) {
    const doc = input.ownerDocument;
    let text = "";
    const labelledby = input.getAttribute("aria-labelledby");
    if (labelledby) {
      text = labelledby.split(/\s+/).map((id) => {
        const n = doc.getElementById(id);
        return n ? textOf(n, { cap: 300 }) : "";
      }).join(" ");
    }
    if (!text.trim() && input.labels && input.labels.length) {
      text = [...input.labels].map((l) => textOf(l, { cap: 300 })).join(" ");
    }
    if (!text.trim()) {
      const wrap = input.closest("label");
      if (wrap) text = textOf(wrap, { cap: 300 });
    }
    if (!text.trim() && input.getAttribute("aria-label")) text = input.getAttribute("aria-label");
    if (!text.trim()) {
      let n = input.nextSibling;
      while (n && text.length < 200) {
        if (n.nodeType === 3) text += n.nodeValue;
        else if (n.nodeType === 1 && !/^(BR|INPUT|DIV|P|UL|OL|LI|FIELDSET)$/i.test(n.tagName)) text += n.textContent;
        else break;
        n = n.nextSibling;
      }
    }
    return collapse(text).replace(/\n/g, " ");
  }

  // src/content/fingerprint.js
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var rotr = (x, n) => x >>> n | x << 32 - n;
  function sha256(str) {
    const bytes = new TextEncoder().encode(str);
    const l = bytes.length;
    const padded = new Uint8Array(l + 9 + 63 >> 6 << 6);
    padded.set(bytes);
    padded[l] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(l * 8 / 4294967296));
    view.setUint32(padded.length - 4, l * 8 >>> 0);
    const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = e & f ^ ~e & g;
        const t1 = hh + S1 + ch + K[i] + w[i] | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = S0 + maj | 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 | 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 | 0;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
      h[5] += f;
      h[6] += g;
      h[7] += hh;
    }
    return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
  }
  function normalizeText(s) {
    return String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  }
  function fingerprintQuestion(question, choices) {
    const q = normalizeText(question);
    const ordered = choices.map((c) => `${normalizeText(c.id)}:${normalizeText(c.text)}`).join("|");
    const sorted = choices.map((c) => normalizeText(c.text)).sort().join("|");
    return {
      fingerprint: sha256(`${q}
${ordered}`).slice(0, 24),
      contentKey: sha256(`${q}
${sorted}`).slice(0, 24)
    };
  }

  // src/content/question-detector.js
  var MAX_CHOICES = 10;
  var OPT_PREFIX = /^\(?([A-Za-z]|\d{1,2})[).:]\s*(?=\S)/;
  var OPT_LINE = /^\s*\(?([A-Da-d]|[1-5])[).:]\s+\S/;
  var QUESTION_TEXT_SEL = '.qtext, .question_text, .question-text, .questionText, [class*="question-text" i], [class*="question_text" i], [data-question], [class*="prompt" i]';
  var CHOICE_CONTROLS = "input[type=radio], input[type=checkbox], [role=radio], [role=option], [role=checkbox]";
  var QUIZ_HINT = /quiz|question|answer|choice|option/i;
  var NAV_WORDS = /^(next|previous|prev|back|submit|finish|check( answer)?|continue|skip|reset|restart|start|retry)$/i;
  function cleanQuestion(raw) {
    const lines = String(raw).split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/^(question\s*)?\d+\s*(of|\/)\s*\d+$/i.test(l)).filter((l) => !/^question\s*\d+$/i.test(l)).filter((l) => !/^\(?\d+(\.\d+)?\s*(points?|pts?|marks?)\)?$/i.test(l)).filter((l) => !/^(not yet answered|marked out of.*|flag question|answer saved|required)$/i.test(l));
    return lines.join(" ").replace(/^\s*(question|q)\s*\d+\s*(of\s*\d+)?\s*[:.)-]?\s*/i, "").replace(/^\s*\d+\s*[.)]\s+/, "").replace(/\(\s*\d+(\.\d+)?\s*(points?|pts?|marks?)\s*\)\s*$/i, "").replace(/\s+/g, " ").trim().slice(-600);
  }
  function buildChoices(rawTexts, { numbered = false } = {}) {
    const texts = rawTexts.map((t) => collapse(t).replace(/\n/g, " ").slice(0, 300));
    const m = texts.map((t) => OPT_PREFIX.exec(t));
    if (m.every(Boolean)) {
      const ids = m.map((x) => x[1].toUpperCase());
      const alpha = ids.every((id, i) => id === String.fromCharCode(65 + i));
      const num = ids.every((id, i) => Number(id) === i + 1);
      if (alpha || num) {
        return texts.map((t, i) => ({ id: ids[i], text: t.replace(OPT_PREFIX, "").trim() }));
      }
    }
    return texts.map((t, i) => ({ id: numbered ? String(i + 1) : String.fromCharCode(65 + i), text: t }));
  }
  function controlRoot(input) {
    return input.labels && input.labels[0] || input.closest("label") || input;
  }
  function commonAncestor(els) {
    let a = els[0].parentElement;
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a || els[0].parentElement;
  }
  function nativeGroups(doc, layout) {
    const inputs = (
      /** @type {HTMLInputElement[]} */
      [...doc.querySelectorAll("input[type=radio], input[type=checkbox]")].filter((i) => !isSensitiveField(i) && !i.disabled && isVisible(controlRoot(i), layout) && !isBoilerplate(i))
    );
    const buckets = /* @__PURE__ */ new Map();
    for (const i of inputs) {
      const type = i.type;
      let key;
      if (type === "radio" && i.name) key = `r|${i.form ? [...doc.forms].indexOf(i.form) : -1}|${i.name}`;
      else {
        let a = i.parentElement;
        while (a && a.querySelectorAll(`input[type=${type}]`).length < 2 && a !== doc.body) a = a.parentElement;
        key = `${type}|${a ? [...doc.querySelectorAll("*")].indexOf(a) : 0}`;
      }
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }
    const groups = [];
    for (const els of buckets.values()) {
      if (els.length < 2 || els.length > MAX_CHOICES) continue;
      groups.push({
        strategy: "native",
        priority: 30,
        container: commonAncestor(els),
        multi: (
          /** @type {HTMLInputElement} */
          els[0].type === "checkbox"
        ),
        items: els.map((i) => ({ node: controlRoot(i), anchor: i, text: labelTextFor(i) }))
      });
    }
    return groups;
  }
  function ariaGroups(doc, layout) {
    const roles = [...doc.querySelectorAll("[role=radio], [role=option], [role=checkbox]")].filter((e) => isVisible(e, layout) && !isBoilerplate(e) && !isSensitiveField(e));
    const buckets = /* @__PURE__ */ new Map();
    for (const e of roles) {
      const g = e.closest("[role=radiogroup], [role=listbox], [role=group]") || e.parentElement;
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(e);
    }
    const groups = [];
    for (const [container, els] of buckets) {
      if (els.length < 2 || els.length > MAX_CHOICES) continue;
      groups.push({
        strategy: "aria",
        priority: 20,
        container,
        multi: els[0].getAttribute("role") === "checkbox",
        items: els.map((e) => ({ node: e, text: e.getAttribute("aria-label") || textOf(e, { cap: 300 }) }))
      });
    }
    return groups;
  }
  function genericGroups(doc, layout) {
    const els = [...doc.querySelectorAll('button, [role=button], li, [class*="answer" i], [class*="choice" i], [class*="option" i]')].filter((e) => !isBoilerplate(e) && !e.querySelector(CHOICE_CONTROLS) && !e.matches(CHOICE_CONTROLS) && e.parentElement);
    const buckets = /* @__PURE__ */ new Map();
    for (const e of els) {
      const p = e.parentElement;
      if (!buckets.has(p)) buckets.set(p, []);
      buckets.get(p).push(e);
    }
    const groups = [];
    for (const [container, kids] of buckets) {
      if (kids.length < 2 || kids.length > MAX_CHOICES) continue;
      const items = kids.filter((k) => isVisible(k, layout)).map((k) => ({ node: k, text: textOf(k, { cap: 300 }) })).filter((it) => !NAV_WORDS.test(it.text));
      if (items.length < 2 || items.some((it) => !it.text || it.text.length > 200)) continue;
      const numbered = container.tagName === "OL";
      groups.push({
        strategy: "generic",
        priority: 10,
        container,
        items,
        numbered,
        hinted: QUIZ_HINT.test(`${container.className} ${container.id} ${container.closest("[class*=quiz i], [class*=question i], [id*=quiz i], [id*=question i]") ? "quiz" : ""}`)
      });
    }
    return groups;
  }
  function textGroups(doc) {
    const cands = [...doc.querySelectorAll("p, div, li, pre, blockquote, section, article, td")].slice(0, 600);
    let best = null;
    for (const el of cands) {
      const len = (el.textContent || "").length;
      if (len < 12 || len > 1500 || isBoilerplate(el)) continue;
      const lines = textOf(el, { cap: 1500 }).split("\n");
      const optIdx = lines.map((l, i) => OPT_LINE.test(l) ? i : -1).filter((i) => i >= 0);
      if (optIdx.length < 2 || optIdx.length > MAX_CHOICES) continue;
      if (best && best.container.contains(el) === false && el.contains(best.container) === false) continue;
      if (!best || best.container.contains(el)) {
        best = {
          strategy: "text",
          priority: 5,
          container: el,
          items: optIdx.map((i) => ({ node: el, text: lines[i] })),
          textLead: lines.slice(0, optIdx[0]).join("\n")
        };
      }
    }
    return best ? [best] : [];
  }
  function nearestQuestionText(group, layout) {
    const { container } = group;
    const itemNodes = new Set(group.items.map((i) => i.node));
    if (group.textLead) return { text: group.textLead, strategy: "lead" };
    const legend = (container.closest("fieldset") || container).querySelector?.(":scope > legend, legend");
    if (legend && isVisible(legend, layout)) return { text: textOf(legend, { cap: 700 }), strategy: "legend" };
    for (let a = container; a && a.tagName !== "BODY"; a = a.parentElement) {
      const lab = a.getAttribute?.("aria-labelledby");
      if (lab && ["radiogroup", "listbox", "group"].includes(a.getAttribute("role") || "")) {
        const t = lab.split(/\s+/).map((id) => {
          const n = container.ownerDocument.getElementById(id);
          return n ? textOf(n, { cap: 700 }) : "";
        }).join(" ");
        if (t.trim()) return { text: t, strategy: "aria-labelledby" };
      }
      if (a.getAttribute?.("aria-label") && ["radiogroup", "listbox", "group"].includes(a.getAttribute("role") || "")) {
        return { text: a.getAttribute("aria-label"), strategy: "aria-label" };
      }
    }
    let levels = 0;
    for (let a = container; a && a.tagName !== "BODY" && levels < 7; a = a.parentElement, levels++) {
      for (const q of a.querySelectorAll(QUESTION_TEXT_SEL)) {
        if (!container.contains(q) && !itemNodes.has(q) && isVisible(q, layout) && !q.querySelector(CHOICE_CONTROLS)) {
          const t = textOf(q, { cap: 800, boilerplate: false });
          if (t.length >= 4) return { text: t, strategy: "known-selector" };
        }
      }
    }
    levels = 0;
    const start = group.items[0].anchor || group.items[0].node;
    for (let a = start; a && a.tagName !== "BODY" && levels < 8; a = a.parentElement, levels++) {
      const found = [];
      let s = a.previousElementSibling;
      for (let n = 0; s && n < 4; s = s.previousElementSibling, n++) {
        if (isBoilerplate(s) || itemNodes.has(s) || s.querySelector(CHOICE_CONTROLS) || s.contains(container) || group.items.some((it) => s.contains(it.node))) continue;
        if (!isVisible(s, false)) continue;
        const t = textOf(s, { cap: 800, boilerplate: false });
        if (t.length >= 6) found.push(t);
      }
      if (found.length) return { text: found.find((t) => t.includes("?")) || found[0], strategy: "previous-sibling" };
    }
    return { text: "", strategy: "none" };
  }
  function splitPassage(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      let qi = -1;
      lines.forEach((l, i) => {
        if (l.includes("?")) qi = i;
      });
      if (qi >= 0) return { question: lines[qi], extra: lines.filter((_, i) => i !== qi).join(" ") };
      return { question: lines[lines.length - 1], extra: lines.slice(0, -1).join(" ") };
    }
    return { question: text, extra: "" };
  }
  function buildContext(group, question, choices, extra, layout) {
    const { container } = group;
    const skip = new Set(group.items.map((i) => i.node));
    const need = question.length + choices.reduce((n, c) => n + c.text.length, 0) + 40;
    let a = container;
    while (a && a.parentElement && a.parentElement.tagName !== "BODY" && a.parentElement !== a.ownerDocument.documentElement) {
      if ((a.textContent || "").length > need) break;
      a = a.parentElement;
    }
    let text = "";
    if (a && a.tagName !== "BODY" && group.strategy !== "text") {
      const nq = normalizeText(question);
      const ch = new Set(choices.map((c) => normalizeText(c.text)));
      text = textOf(a, { cap: 1500, skip, boilerplate: false }).split("\n").filter((l) => {
        const n = normalizeText(l);
        return n && !nq.includes(n) && !n.includes(nq) && !ch.has(n) && !/^(question\s*\d+|\d+\s*(of|\/)\s*\d+)/i.test(n) && !/^(previous|next|submit|finish|check|back)$/i.test(n);
      }).join(" ");
    }
    void layout;
    return collapse(`${extra} ${text}`).slice(0, 500);
  }
  function score(group, doc, layout) {
    let s = group.priority;
    if (layout) {
      const r = group.container.getBoundingClientRect();
      const vh = doc.defaultView.innerHeight || 800;
      const overlap = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      s += overlap > 0 ? 1e4 + overlap - Math.abs((r.top + r.bottom) / 2 - vh / 2) * 0.1 : -Math.abs(r.top);
    }
    return s;
  }
  function detectVisualContent(doc = document) {
    const layout = hasLayout(doc);
    const vw = doc.defaultView.innerWidth || 1;
    const vh = doc.defaultView.innerHeight || 1;
    for (const el of doc.querySelectorAll("canvas, img, svg, video")) {
      if (!isVisible(el, layout)) continue;
      if (!layout) {
        if (el.tagName === "CANVAS") return true;
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= 0.25 * vw * vh) return true;
    }
    return false;
  }
  function detectQuestion(doc = document) {
    const layout = hasLayout(doc);
    const groups = [...nativeGroups(doc, layout), ...ariaGroups(doc, layout), ...genericGroups(doc, layout), ...textGroups(doc)];
    let best = null;
    for (const g2 of groups) {
      const found = nearestQuestionText(g2, layout);
      const { question: rawQ, extra: extra2 } = splitPassage(found.text);
      const question2 = cleanQuestion(rawQ);
      if (question2.length < 6) continue;
      if (g2.strategy === "generic" && !(g2.hinted || question2.includes("?") || question2.endsWith(":") || g2.items.every((i) => OPT_PREFIX.test(i.text)))) continue;
      const choices2 = buildChoices(g2.items.map((i) => i.text), { numbered: !!g2.numbered && numberedList(g2.container) });
      if (choices2.length < 2 || choices2.length > MAX_CHOICES) continue;
      const empty = choices2.filter((c) => !c.text).length;
      if (empty > 0) continue;
      if (new Set(choices2.map((c) => normalizeText(c.text))).size < 2) continue;
      const s = score(g2, doc, layout);
      if (!best || s > best.s) best = { s, g: g2, question: question2, choices: choices2, extra: extra2 };
    }
    if (!best) return { found: false, visual: detectVisualContent(doc) };
    const { g, question, choices, extra } = best;
    const loc = doc.location;
    const context = buildContext(g, question, choices, extra, layout);
    const { fingerprint, contentKey } = fingerprintQuestion(question, choices);
    return {
      found: true,
      payload: {
        question,
        choices,
        context,
        url: loc ? `${loc.origin}${loc.pathname}` : "",
        // no query string / hash: they can carry tokens
        fingerprint,
        contentKey,
        multi: !!g.multi,
        source: "DOM"
      }
    };
  }
  function numberedList(container) {
    const t = container.ownerDocument.defaultView.getComputedStyle(container).listStyleType;
    return ["", "decimal", "decimal-leading-zero"].includes(t);
  }

  // src/content/observer.js
  var DEBOUNCE_MS = 180;
  var MAX_WAIT_MS = 1e3;
  var STABILIZE_MS = 150;
  var ERROR_RETRY_MS = 15e3;
  var MAX_ERROR_RETRIES = 2;
  function createObserver(deps) {
    const { doc = document, hud, analyze, cancel = () => {
    }, getSettings, detect = detectQuestion, log = () => {
    }, now = () => Date.now(), onResult = () => {
    } } = deps;
    const win = (
      /** @type {any} */
      deps.win ?? doc.defaultView
    );
    let state = "IDLE";
    let lastFp = null;
    let pendingFp = null;
    let currentReq = 0;
    let inflight = 0;
    let paused = false;
    let destroyed = false;
    let timer = null;
    let firstAt = 0;
    let stabilizeTimer = null;
    let heartbeatTimer = null;
    let mo = null;
    let lastError = null;
    let lastPayload = null;
    let lastResult = null;
    let lastShown = null;
    let invalidated = false;
    let lastQuick = 0;
    const listeners = [];
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      listeners.push(() => target.removeEventListener(type, fn, opts));
    };
    function abortInflight() {
      if (inflight) {
        cancel(inflight);
        inflight = 0;
      }
      currentReq++;
    }
    function setKind(kind, extra = {}) {
      hud.setState({ kind, ...extra });
    }
    function schedule(reason) {
      if (destroyed || paused) return;
      const s = getSettings();
      if (!s.autoDetect) return;
      const t = now();
      if (!firstAt) firstAt = t;
      clearTimeout(timer);
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - t));
      timer = setTimeout(() => {
        firstAt = 0;
        check("mutation");
      }, wait);
      if (reason) log(`${reason} detected`);
      quickInvalidate();
    }
    function quickInvalidate() {
      if (invalidated || state !== "ANSWERED" && state !== "WAITING_FOR_CHANGE") return;
      const t = now();
      if (t - lastQuick < 60) return;
      lastQuick = t;
      const r = detect(doc);
      if (r.found && r.payload.fingerprint === lastFp) return;
      invalidated = true;
      setKind("detecting");
    }
    function check(trigger = "manual", { force = false } = {}) {
      if (destroyed || paused) return;
      const settings = getSettings();
      if (doc.visibilityState === "hidden" && !settings.runWhenHidden) return;
      if (!settings.autoDetect && trigger !== "manual") return;
      const r = detect(doc);
      if (!r.found) {
        if (lastFp !== null || pendingFp !== null) {
          abortInflight();
          lastFp = pendingFp = null;
          lastPayload = lastResult = lastShown = null;
        }
        invalidated = false;
        if (state !== "IDLE" || hud.state?.kind !== (r.visual ? "visual" : "idle")) {
          state = "IDLE";
          setKind(r.visual ? "visual" : "idle", r.visual ? { message: "Visual content detected. Use \u201CAnalyze visible content\u201D from the popup." } : {});
        }
        return;
      }
      const p = r.payload;
      if (!force && p.fingerprint === lastFp) {
        if (invalidated && lastShown) {
          invalidated = false;
          hud.setState(lastShown);
        }
        if (state === "ANSWERED") state = "WAITING_FOR_CHANGE";
        maybeRetryAfterError(p);
        return;
      }
      if (state === "IDLE" || state === "ANSWERED" || state === "WAITING_FOR_CHANGE") {
        state = "DETECTED";
        log("candidate question found:", p.question.slice(0, 80));
      }
      if (!force && trigger !== "mutation" && pendingFp !== p.fingerprint) {
        pendingFp = p.fingerprint;
        state = "STABILIZING";
        setKind("detecting");
        clearTimeout(stabilizeTimer);
        stabilizeTimer = setTimeout(() => check("stabilize"), STABILIZE_MS);
        return;
      }
      if (trigger === "mutation" || trigger === "stabilize" || force) pendingFp = null;
      startAnalysis(p);
    }
    function startAnalysis(p) {
      abortInflight();
      const reqId = ++currentReq;
      inflight = reqId;
      lastFp = p.fingerprint;
      lastPayload = p;
      lastError = null;
      invalidated = false;
      state = "ANALYZING";
      log("fingerprint:", p.fingerprint);
      setKind("thinking");
      Promise.resolve(analyze({ requestId: reqId, question: p })).then((res) => {
        if (destroyed || reqId !== currentReq || p.fingerprint !== lastFp) {
          log("stale response ignored");
          return;
        }
        inflight = 0;
        if (res?.ok) {
          lastError = null;
          lastResult = res.result;
          const r = res.result;
          log(`Answer ${r.answer} confidence=${r.confidence.toFixed(2)}`);
          state = "ANSWERED";
          lastShown = {
            kind: r.lowConfidence ? "low" : "result",
            answer: r.answer,
            answerText: r.answerText,
            confidence: r.confidence,
            latencyMs: r.latencyMs,
            source: r.source,
            pageSource: p.source,
            cost: r.cost,
            probabilities: r.probabilities,
            reason: r.reason
          };
          hud.setState(lastShown);
          log("HUD updated");
          onResult(r, p);
        } else if (!res?.aborted) {
          state = "WAITING_FOR_CHANGE";
          lastError = { fp: p.fingerprint, at: now(), retries: lastError?.retries ?? 0, code: res?.code };
          log("error:", res?.error);
          setKind("error", { message: res?.error || "Request failed" });
        }
      }, (err) => {
        if (destroyed || reqId !== currentReq) return;
        inflight = 0;
        state = "WAITING_FOR_CHANGE";
        lastError = { fp: p.fingerprint, at: now(), retries: 0, code: "exception" };
        setKind("error", { message: String(err?.message || err) });
      });
    }
    function maybeRetryAfterError(p) {
      if (!lastError || lastError.fp !== p.fingerprint) return;
      if (["no_key", "bad_key", "config", "no_credits"].includes(lastError.code)) return;
      if (lastError.retries >= MAX_ERROR_RETRIES || now() - lastError.at < ERROR_RETRY_MS) return;
      const prev = lastError;
      startAnalysis(p);
      lastError = { ...prev, at: now(), retries: prev.retries + 1 };
    }
    function start() {
      if (mo || destroyed) return;
      mo = new win.MutationObserver((records) => {
        const host = hud.host;
        if (host && records.every((r) => host.contains(r.target))) return;
        schedule("mutation");
      });
      mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "style", "aria-hidden", "aria-checked", "aria-selected", "disabled"] });
      on(doc, "visibilitychange", () => {
        if (doc.visibilityState === "visible") check("visible");
      });
      on(win, "scroll", () => schedule(""), { passive: true });
      on(win, "popstate", () => schedule("navigation"));
      on(win, "hashchange", () => schedule("navigation"));
      const beat = () => {
        clearInterval(heartbeatTimer);
        const sec = Math.max(2, Number(getSettings().heartbeatSec) || 5);
        heartbeatTimer = setInterval(() => check("heartbeat"), sec * 1e3);
      };
      beat();
      check("mutation");
    }
    return {
      start,
      check,
      get state() {
        return state;
      },
      get lastResult() {
        return lastResult;
      },
      get lastPayload() {
        return lastPayload;
      },
      /** Re-read settings (e.g. heartbeat interval) and re-evaluate the page. */
      refresh() {
        clearInterval(heartbeatTimer);
        const sec = Math.max(2, Number(getSettings().heartbeatSec) || 5);
        heartbeatTimer = setInterval(() => check("heartbeat"), sec * 1e3);
        lastFp = pendingFp = null;
        if (!paused) check("mutation");
      },
      setPaused(p) {
        if (paused === p) return;
        paused = p;
        if (p) {
          abortInflight();
          clearTimeout(timer);
          clearTimeout(stabilizeTimer);
          state = "IDLE";
          setKind("paused");
        } else {
          lastFp = pendingFp = null;
          setKind("idle");
          check("mutation");
        }
      },
      get paused() {
        return paused;
      },
      destroy() {
        destroyed = true;
        abortInflight();
        clearTimeout(timer);
        clearTimeout(stabilizeTimer);
        clearInterval(heartbeatTimer);
        mo?.disconnect();
        listeners.forEach((off) => off());
      }
    };
  }

  // src/content/hud.css
  var hud_default = ':host { all: initial; }\n* { box-sizing: border-box; }\n.root {\n  position: fixed; z-index: 2147483647; left: 0; top: 0;\n  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;\n  color: #e8ecf3; user-select: none; -webkit-user-select: none;\n  --bg: rgba(17, 20, 28, 0.94); --line: rgba(255, 255, 255, 0.14); --accent: #7cc4ff;\n}\n.pill {\n  min-width: 44px; height: 44px; padding: 0 12px; display: flex; align-items: center; justify-content: center;\n  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;\n  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35); cursor: grab; touch-action: none;\n  font-size: 22px; font-weight: 700; letter-spacing: 0.02em; transition: border-color .15s, background .15s;\n}\n.pill:active { cursor: grabbing; }\n.root.dragging .pill { cursor: grabbing; }\n.root[data-kind="result"] .pill { border-color: #5bd48a; }\n.root[data-kind="low"] .pill { border-color: #f1b84a; color: #ffe2a3; }\n.root[data-kind="error"] .pill { border-color: #ef6a6a; color: #ffb4b4; }\n.root[data-kind="paused"] .pill, .root[data-kind="idle"] .pill { color: #9aa4b6; }\n.root[data-kind="thinking"] .pill { border-color: var(--accent); }\n.dots span { display: inline-block; animation: bv-blink 1s infinite both; }\n.dots span:nth-child(2) { animation-delay: .15s; }\n.dots span:nth-child(3) { animation-delay: .3s; }\n@keyframes bv-blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }\n.panel {\n  position: absolute; top: 50px; width: 236px; padding: 10px 12px; display: none;\n  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4); cursor: default; user-select: text; -webkit-user-select: text;\n}\n.root.open .panel { display: block; }\n.root[data-side="right"] .panel { right: 0; }\n.root[data-side="left"] .panel { left: 0; }\n.root[data-flip="1"] .panel { top: auto; bottom: 50px; }\n.title { font-weight: 600; color: var(--accent); margin-bottom: 4px; letter-spacing: .02em; }\n.row { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }\n.row .k { color: #9aa4b6; }\n.msg { color: #ffb4b4; margin: 4px 0; word-break: break-word; }\n.btns { display: flex; gap: 6px; margin-top: 8px; }\nbutton {\n  all: unset; box-sizing: border-box; flex: 1; text-align: center; cursor: pointer; padding: 5px 6px; font-size: 12px;\n  border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.06); color: inherit;\n}\nbutton:hover { background: rgba(255, 255, 255, 0.14); }\nbutton:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n.dist { margin-top: 6px; display: none; }\n.dist.show { display: block; }\n.bar { display: flex; align-items: center; gap: 6px; font-size: 11px; margin: 2px 0; }\n.bar .lbl { width: 22px; color: #9aa4b6; }\n.bar .track { flex: 1; height: 6px; background: rgba(255, 255, 255, 0.1); border-radius: 3px; overflow: hidden; }\n.bar .fill { height: 100%; background: var(--accent); }\n.bar .pct { width: 32px; text-align: right; color: #9aa4b6; }\n.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }\n@media (prefers-reduced-motion: reduce) { .dots span { animation: none; opacity: .7; } }\n';

  // src/content/index.js
  var POS_KEY = "bv_hud_position";
  (async function main() {
    if (
      /** @type {any} */
      window.__blairVision
    ) return;
    if (location.protocol === "chrome:" || location.protocol === "chrome-extension:") return;
    let settings = { ...DEFAULT_SETTINGS };
    try {
      const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
      settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch {
      return;
    }
    if (isBlockedHost(settings.blockedDomains, location.href)) return;
    const log = (...a) => {
      if (settings.debug) console.log("[Blair]", ...a);
    };
    const savedPos = (await chrome.storage.local.get(POS_KEY).catch(() => ({})))[POS_KEY] ?? null;
    const send = (msg) => chrome.runtime.sendMessage(msg);
    let obs;
    const hud = createHud({
      css: hud_default,
      position: savedPos,
      onPause: () => obs.setPaused(!obs.paused),
      onSettings: () => send({ type: MSG.OPEN_OPTIONS }),
      onMove: (p) => chrome.storage.local.set({ [POS_KEY]: p })
    });
    const isDemo = document.documentElement.hasAttribute("data-blair-demo");
    obs = createObserver({
      hud,
      log,
      getSettings: () => settings,
      analyze: (m) => send({ type: MSG.ANALYZE, ...m }),
      cancel: (requestId) => {
        send({ type: MSG.CANCEL, requestId }).catch(() => {
        });
      },
      onResult: (r, p) => {
        if (isDemo && settings.debug) {
          document.dispatchEvent(new CustomEvent("blair-vision", { detail: JSON.stringify({ answer: r.answer, source: r.source, latencyMs: r.latencyMs, question: p.question }) }));
        }
      }
    });
    window.__blairVision = { obs, hud };
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== MSG.CONTROL) return;
      if (msg.disable) {
        obs.destroy();
        hud.destroy();
        delete /** @type {any} */
        window.__blairVision;
      } else if (typeof msg.paused === "boolean") obs.setPaused(msg.paused);
      if (msg.visual) {
        hud.setState({
          kind: msg.visual.answer ? "result" : "error",
          answer: msg.visual.answer,
          confidence: msg.visual.confidence,
          latencyMs: msg.visual.latencyMs,
          source: "fallback",
          pageSource: "Screenshot (one-off)",
          cost: msg.visual.cost,
          message: msg.visual.error || (msg.visual.answer ? "" : "No multiple-choice question found in the screenshot."),
          reason: msg.visual.reason
        });
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((k) => k in DEFAULT_SETTINGS)) {
        for (const k of Object.keys(changes)) if (k in DEFAULT_SETTINGS) settings[k] = changes[k].newValue ?? DEFAULT_SETTINGS[k];
        if (isBlockedHost(settings.blockedDomains, location.href)) {
          obs.destroy();
          hud.destroy();
          delete /** @type {any} */
          window.__blairVision;
          return;
        }
        obs.refresh();
      }
    });
    const st = await send({ type: MSG.GET_TAB_STATE }).catch(() => null);
    obs.start();
    if (st?.paused) obs.setPaused(true);
    log("Blair Vision active on this tab");
  })();
})();
