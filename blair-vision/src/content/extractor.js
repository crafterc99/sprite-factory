// DOM helpers: visibility, sensitive-field filtering and clean visible-text extraction.
// Nothing here reads input values, storage, cookies or hidden fields.

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'HEAD', 'SELECT', 'TEXTAREA', 'INPUT']);
export const BOILERPLATE = 'nav, footer, [role=navigation], [role=contentinfo], [role=banner], [role=search], [role=menu], [role=menubar], [role=toolbar], [role=complementary]';
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'SECTION', 'ARTICLE', 'PRE', 'BLOCKQUOTE', 'FIELDSET', 'LEGEND', 'LABEL', 'FORM', 'TABLE']);

const SENSITIVE_NAME = /pass(word|wd)?|pwd|passcode|card|cc-?num|cvv|cvc|expir|iban|routing|ssn|social.?sec|token|secret|api.?key|otp|2fa/i;
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\s|$)/i;

export function hasLayout(doc) {
  return doc.documentElement.getClientRects().length > 0;
}

export function isVisible(el, layout = true) {
  const view = el.ownerDocument.defaultView;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (/** @type {HTMLElement} */ (n).hidden || n.getAttribute('aria-hidden') === 'true') return false;
    const cs = view.getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (n === el && cs.opacity === '0') return false;
  }
  if (!layout) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Password, card, token-like, hidden and file inputs are never read or transmitted. */
export function isSensitiveField(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (['password', 'hidden', 'file'].includes(type)) return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return true;
  const hay = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].filter(Boolean).join(' ');
  return SENSITIVE_NAME.test(hay);
}

export function isBoilerplate(el) {
  return !!el.closest(BOILERPLATE);
}

/** Redact things that look like secrets that could sit in surrounding page text. */
export function scrub(text) {
  return text
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[redacted]') // card-like numbers
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:sk|pk|rk|jbc|ghp|xox[bp])[-_][A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[redacted]');
}

export function collapse(s) {
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Visible text of an element with block boundaries as newlines.
 * Skips scripts, styles, form values, hidden subtrees and (optionally) page chrome.
 * @param {Element} root
 * @param {{ cap?: number, skip?: Set<Element>, boilerplate?: boolean }} [o]
 */
export function textOf(root, o = {}) {
  const { cap = 2000, skip, boilerplate = true } = o;
  const view = root.ownerDocument.defaultView;
  let out = '';
  let budget = 4000; // node budget keeps worst-case pages fast
  const walk = (node) => {
    if (out.length >= cap || budget-- <= 0) return;
    if (node.nodeType === 3) { out += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const el = /** @type {Element} */ (node);
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (skip && skip.has(el)) return;
    if (el !== root) {
      if (/** @type {HTMLElement} */ (el).hidden || el.getAttribute('aria-hidden') === 'true') return;
      const cs = view.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (!boilerplate && el.matches(BOILERPLATE)) return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out += '\n';
    for (const child of el.childNodes) walk(child);
    if (block) out += '\n';
  };
  walk(root);
  return collapse(scrub(out)).slice(0, cap);
}

/** Accessible label for a form control; never its value. */
export function labelTextFor(input) {
  const doc = input.ownerDocument;
  let text = '';
  const labelledby = input.getAttribute('aria-labelledby');
  if (labelledby) {
    text = labelledby.split(/\s+/).map((id) => { const n = doc.getElementById(id); return n ? textOf(n, { cap: 300 }) : ''; }).join(' ');
  }
  if (!text.trim() && input.labels && input.labels.length) {
    text = [...input.labels].map((l) => textOf(l, { cap: 300 })).join(' ');
  }
  if (!text.trim()) {
    const wrap = input.closest('label');
    if (wrap) text = textOf(wrap, { cap: 300 });
  }
  if (!text.trim() && input.getAttribute('aria-label')) text = input.getAttribute('aria-label');
  if (!text.trim()) {
    // Bare text right after the input: <input type=radio> Earth <br>
    let n = input.nextSibling;
    while (n && text.length < 200) {
      if (n.nodeType === 3) text += n.nodeValue;
      else if (n.nodeType === 1 && !/^(BR|INPUT|DIV|P|UL|OL|LI|FIELDSET)$/i.test(n.tagName)) text += n.textContent;
      else break;
      n = n.nextSibling;
    }
  }
  return collapse(text).replace(/\n/g, ' ');
}
