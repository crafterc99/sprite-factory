// Finds a likely multiple-choice question in the DOM and returns the smallest useful payload:
// { question, choices:[{id,text}], context, url, fingerprint, contentKey }.
// Strategies (in priority order): native radios/checkboxes, ARIA roles, generic button/list
// groups (Canvas/Moodle/React quizzes), and plain-text "A. ... B. ..." blocks.

import { hasLayout, isVisible, isSensitiveField, isBoilerplate, textOf, labelTextFor, collapse } from './extractor.js';
import { fingerprintQuestion, normalizeText } from './fingerprint.js';

const MAX_CHOICES = 10;
const OPT_PREFIX = /^\(?([A-Za-z]|\d{1,2})[).:]\s*(?=\S)/;
const OPT_LINE = /^\s*\(?([A-Da-d]|[1-5])[).:]\s+\S/;
const QUESTION_TEXT_SEL = '.qtext, .question_text, .question-text, .questionText, [class*="question-text" i], [class*="question_text" i], [data-question], [class*="prompt" i]';
const CHOICE_CONTROLS = 'input[type=radio], input[type=checkbox], [role=radio], [role=option], [role=checkbox]';
const QUIZ_HINT = /quiz|question|answer|choice|option/i;
const NAV_WORDS = /^(next|previous|prev|back|submit|finish|check( answer)?|continue|skip|reset|restart|start|retry)$/i;

/** @typedef {{ node: Element, text: string, anchor?: Element }} Item */
/** @typedef {{ strategy: string, priority: number, container: Element, items: Item[], multi?: boolean, textLead?: string }} Group */

export function cleanQuestion(raw) {
  const lines = String(raw).split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(question\s*)?\d+\s*(of|\/)\s*\d+$/i.test(l))
    .filter((l) => !/^question\s*\d+$/i.test(l))
    .filter((l) => !/^\(?\d+(\.\d+)?\s*(points?|pts?|marks?)\)?$/i.test(l))
    .filter((l) => !/^(not yet answered|marked out of.*|flag question|answer saved|required)$/i.test(l));
  return lines.join(' ')
    .replace(/^\s*(question|q)\s*\d+\s*(of\s*\d+)?\s*[:.)-]?\s*/i, '')
    .replace(/^\s*\d+\s*[.)]\s+/, '')
    .replace(/\(\s*\d+(\.\d+)?\s*(points?|pts?|marks?)\s*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-600);
}

/** Order the group's items and derive ids: prefix letters/numbers when present and sequential, else A,B,C… or 1,2,3… */
export function buildChoices(rawTexts, { numbered = false } = {}) {
  const texts = rawTexts.map((t) => collapse(t).replace(/\n/g, ' ').slice(0, 300));
  const m = texts.map((t) => OPT_PREFIX.exec(t));
  if (m.every(Boolean)) {
    const ids = m.map((x) => x[1].toUpperCase());
    const alpha = ids.every((id, i) => id === String.fromCharCode(65 + i));
    const num = ids.every((id, i) => Number(id) === i + 1);
    if (alpha || num) {
      return texts.map((t, i) => ({ id: ids[i], text: t.replace(OPT_PREFIX, '').trim() }));
    }
  }
  return texts.map((t, i) => ({ id: numbered ? String(i + 1) : String.fromCharCode(65 + i), text: t }));
}

function controlRoot(input) {
  return (input.labels && input.labels[0]) || input.closest('label') || input;
}

function commonAncestor(els) {
  let a = els[0].parentElement;
  while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
  return a || els[0].parentElement;
}

// ---- strategies ---------------------------------------------------------------------------

function nativeGroups(doc, layout) {
  const inputs = /** @type {HTMLInputElement[]} */ ([...doc.querySelectorAll('input[type=radio], input[type=checkbox]')])
    .filter((i) => !isSensitiveField(i) && !i.disabled && isVisible(controlRoot(i), layout) && !isBoilerplate(i));
  /** @type {Map<string, Element[]>} */
  const buckets = new Map();
  for (const i of inputs) {
    const type = i.type;
    let key;
    if (type === 'radio' && i.name) key = `r|${i.form ? [...doc.forms].indexOf(i.form) : -1}|${i.name}`;
    else {
      let a = i.parentElement;
      while (a && a.querySelectorAll(`input[type=${type}]`).length < 2 && a !== doc.body) a = a.parentElement;
      key = `${type}|${a ? [...doc.querySelectorAll('*')].indexOf(a) : 0}`; // nameless / checkbox groups: nearest shared container
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }
  const groups = [];
  for (const els of buckets.values()) {
    if (els.length < 2 || els.length > MAX_CHOICES) continue;
    groups.push({
      strategy: 'native', priority: 30,
      container: commonAncestor(els),
      multi: /** @type {HTMLInputElement} */ (els[0]).type === 'checkbox',
      items: els.map((i) => ({ node: controlRoot(i), anchor: i, text: labelTextFor(i) })),
    });
  }
  return groups;
}

function ariaGroups(doc, layout) {
  const roles = [...doc.querySelectorAll('[role=radio], [role=option], [role=checkbox]')]
    .filter((e) => isVisible(e, layout) && !isBoilerplate(e) && !isSensitiveField(e));
  const buckets = new Map();
  for (const e of roles) {
    const g = e.closest('[role=radiogroup], [role=listbox], [role=group]') || e.parentElement;
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(e);
  }
  const groups = [];
  for (const [container, els] of buckets) {
    if (els.length < 2 || els.length > MAX_CHOICES) continue;
    groups.push({
      strategy: 'aria', priority: 20, container,
      multi: els[0].getAttribute('role') === 'checkbox',
      items: els.map((e) => ({ node: e, text: e.getAttribute('aria-label') || textOf(e, { cap: 300 }) })),
    });
  }
  return groups;
}

function genericGroups(doc, layout) {
  const els = [...doc.querySelectorAll('button, [role=button], li, [class*="answer" i], [class*="choice" i], [class*="option" i]')]
    .filter((e) => !isBoilerplate(e) && !e.querySelector(CHOICE_CONTROLS) && !e.matches(CHOICE_CONTROLS) && e.parentElement);
  const buckets = new Map();
  for (const e of els) {
    const p = e.parentElement;
    if (!buckets.has(p)) buckets.set(p, []);
    buckets.get(p).push(e);
  }
  const groups = [];
  for (const [container, kids] of buckets) {
    if (kids.length < 2 || kids.length > MAX_CHOICES) continue;
    // Drop sub-elements that live inside a sibling candidate (e.g. a button inside an li).
    const items = kids.filter((k) => isVisible(k, layout)).map((k) => ({ node: k, text: textOf(k, { cap: 300 }) })).filter((it) => !NAV_WORDS.test(it.text));
    if (items.length < 2 || items.some((it) => !it.text || it.text.length > 200)) continue;
    const numbered = container.tagName === 'OL';
    groups.push({
      strategy: 'generic', priority: 10, container, items, numbered,
      hinted: QUIZ_HINT.test(`${container.className} ${container.id} ${container.closest('[class*=quiz i], [class*=question i], [id*=quiz i], [id*=question i]') ? 'quiz' : ''}`),
    });
  }
  return groups;
}

function textGroups(doc) {
  const cands = [...doc.querySelectorAll('p, div, li, pre, blockquote, section, article, td')].slice(0, 600);
  let best = null;
  for (const el of cands) {
    const len = (el.textContent || '').length;
    if (len < 12 || len > 1500 || isBoilerplate(el)) continue;
    const lines = textOf(el, { cap: 1500 }).split('\n');
    const optIdx = lines.map((l, i) => (OPT_LINE.test(l) ? i : -1)).filter((i) => i >= 0);
    if (optIdx.length < 2 || optIdx.length > MAX_CHOICES) continue;
    if (best && best.container.contains(el) === false && el.contains(best.container) === false) continue;
    // Deepest (smallest) matching element wins.
    if (!best || best.container.contains(el)) {
      best = {
        strategy: 'text', priority: 5, container: el,
        items: optIdx.map((i) => ({ node: el, text: lines[i] })),
        textLead: lines.slice(0, optIdx[0]).join('\n'),
      };
    }
  }
  return best ? [best] : [];
}

// ---- question text --------------------------------------------------------------------------

function nearestQuestionText(group, layout) {
  const { container } = group;
  const itemNodes = new Set(group.items.map((i) => i.node));
  if (group.textLead) return { text: group.textLead, strategy: 'lead' };

  const legend = (container.closest('fieldset') || container).querySelector?.(':scope > legend, legend');
  if (legend && isVisible(legend, layout)) return { text: textOf(legend, { cap: 700 }), strategy: 'legend' };

  for (let a = container; a && a.tagName !== 'BODY'; a = a.parentElement) {
    const lab = a.getAttribute?.('aria-labelledby');
    if (lab && ['radiogroup', 'listbox', 'group'].includes(a.getAttribute('role') || '')) {
      const t = lab.split(/\s+/).map((id) => { const n = container.ownerDocument.getElementById(id); return n ? textOf(n, { cap: 700 }) : ''; }).join(' ');
      if (t.trim()) return { text: t, strategy: 'aria-labelledby' };
    }
    if (a.getAttribute?.('aria-label') && ['radiogroup', 'listbox', 'group'].includes(a.getAttribute('role') || '')) {
      return { text: a.getAttribute('aria-label'), strategy: 'aria-label' };
    }
  }

  // Known LMS/quiz question containers (Moodle .qtext, Canvas .question_text, …)
  let levels = 0;
  for (let a = container; a && a.tagName !== 'BODY' && levels < 7; a = a.parentElement, levels++) {
    for (const q of a.querySelectorAll(QUESTION_TEXT_SEL)) {
      if (!container.contains(q) && !itemNodes.has(q) && isVisible(q, layout) && !q.querySelector(CHOICE_CONTROLS)) {
        const t = textOf(q, { cap: 800, boilerplate: false });
        if (t.length >= 4) return { text: t, strategy: 'known-selector' };
      }
    }
  }

  // Walk up from the first choice, looking at previous siblings at each level (this also covers text
  // that sits inside the choices' own container): nearest text wins, '?' preferred.
  levels = 0;
  const start = group.items[0].anchor || group.items[0].node;
  for (let a = start; a && a.tagName !== 'BODY' && levels < 8; a = a.parentElement, levels++) {
    const found = [];
    let s = a.previousElementSibling;
    for (let n = 0; s && n < 4; s = s.previousElementSibling, n++) {
      if (isBoilerplate(s) || itemNodes.has(s) || s.querySelector(CHOICE_CONTROLS) || s.contains(container) || group.items.some((it) => s.contains(it.node))) continue;
      if (!isVisible(s, false)) continue;
      const t = textOf(s, { cap: 800, boilerplate: false });
      if (t.length >= 6) found.push(t);
    }
    if (found.length) return { text: found.find((t) => t.includes('?')) || found[0], strategy: 'previous-sibling' };
  }
  return { text: '', strategy: 'none' };
}

function splitPassage(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    let qi = -1;
    lines.forEach((l, i) => { if (l.includes('?')) qi = i; });
    if (qi >= 0) return { question: lines[qi], extra: lines.filter((_, i) => i !== qi).join(' ') };
    return { question: lines[lines.length - 1], extra: lines.slice(0, -1).join(' ') };
  }
  return { question: text, extra: '' };
}

function buildContext(group, question, choices, extra, layout) {
  const { container } = group;
  const skip = new Set(group.items.map((i) => i.node));
  const need = question.length + choices.reduce((n, c) => n + c.text.length, 0) + 40;
  let a = container;
  while (a && a.parentElement && a.parentElement.tagName !== 'BODY' && a.parentElement !== a.ownerDocument.documentElement) {
    if ((a.textContent || '').length > need) break;
    a = a.parentElement;
  }
  let text = '';
  if (a && a.tagName !== 'BODY' && group.strategy !== 'text') {
    const nq = normalizeText(question);
    const ch = new Set(choices.map((c) => normalizeText(c.text)));
    text = textOf(a, { cap: 1500, skip, boilerplate: false })
      .split('\n')
      .filter((l) => {
        const n = normalizeText(l);
        return n && !nq.includes(n) && !n.includes(nq) && !ch.has(n) && !/^(question\s*\d+|\d+\s*(of|\/)\s*\d+)/i.test(n) && !/^(previous|next|submit|finish|check|back)$/i.test(n);
      })
      .join(' ');
  }
  void layout;
  return collapse(`${extra} ${text}`).slice(0, 500);
}

// ---- main ---------------------------------------------------------------------------------

function score(group, doc, layout) {
  let s = group.priority;
  if (layout) {
    const r = group.container.getBoundingClientRect();
    const vh = doc.defaultView.innerHeight || 800;
    const overlap = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    s += overlap > 0 ? 10000 + overlap - Math.abs((r.top + r.bottom) / 2 - vh / 2) * 0.1 : -Math.abs(r.top);
  }
  return s;
}

export function detectVisualContent(doc = document) {
  const layout = hasLayout(doc);
  const vw = doc.defaultView.innerWidth || 1;
  const vh = doc.defaultView.innerHeight || 1;
  for (const el of doc.querySelectorAll('canvas, img, svg, video')) {
    if (!isVisible(el, layout)) continue;
    if (!layout) { if (el.tagName === 'CANVAS') return true; continue; }
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= 0.25 * vw * vh) return true;
  }
  return false;
}

/**
 * @param {Document} [doc]
 * @returns {{ found: true, payload: import('../shared/types.js').QuestionPayload } | { found: false, visual: boolean }}
 */
export function detectQuestion(doc = document) {
  const layout = hasLayout(doc);
  const groups = [...nativeGroups(doc, layout), ...ariaGroups(doc, layout), ...genericGroups(doc, layout), ...textGroups(doc)];
  let best = null;
  for (const g of groups) {
    const found = nearestQuestionText(g, layout);
    const { question: rawQ, extra } = splitPassage(found.text);
    const question = cleanQuestion(rawQ);
    if (question.length < 6) continue;
    if (g.strategy === 'generic' && !(g.hinted || question.includes('?') || question.endsWith(':') || g.items.every((i) => OPT_PREFIX.test(i.text)))) continue;
    const choices = buildChoices(g.items.map((i) => i.text), { numbered: !!g.numbered && numberedList(g.container) });
    if (choices.length < 2 || choices.length > MAX_CHOICES) continue;
    const empty = choices.filter((c) => !c.text).length;
    if (empty > 0) continue; // image-only choices: not a DOM question (see visual fallback)
    if (new Set(choices.map((c) => normalizeText(c.text))).size < 2) continue;
    const s = score(g, doc, layout);
    if (!best || s > best.s) best = { s, g, question, choices, extra };
  }
  if (!best) return { found: false, visual: detectVisualContent(doc) };

  const { g, question, choices, extra } = best;
  const loc = doc.location;
  const context = buildContext(g, question, choices, extra, layout);
  const { fingerprint, contentKey } = fingerprintQuestion(question, choices);
  return {
    found: true,
    payload: {
      question, choices, context,
      url: loc ? `${loc.origin}${loc.pathname}` : '', // no query string / hash: they can carry tokens
      fingerprint, contentKey, multi: !!g.multi, source: 'DOM',
    },
  };
}

function numberedList(container) {
  const t = container.ownerDocument.defaultView.getComputedStyle(container).listStyleType;
  return ['', 'decimal', 'decimal-leading-zero'].includes(t);
}
