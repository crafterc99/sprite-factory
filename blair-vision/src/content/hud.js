// Floating HUD inside a Shadow DOM so site CSS can't touch it.
import { formatCost } from '../shared/cost.js';

const PILL_TEXT = { idle: '·', detecting: '…', paused: 'II', error: '!', visual: '◫' };
const MARGIN = 8;

/**
 * @param {{ doc?: Document, css?: string, position?: {x:number,y:number}|null,
 *   onPause?: ()=>void, onSettings?: ()=>void, onMove?: (p:{x:number,y:number})=>void }} o
 */
export function createHud({ doc = document, css = '', position = null, onPause = () => {}, onSettings = () => {}, onMove = () => {} } = {}) {
  const win = doc.defaultView;
  const host = doc.createElement('div');
  host.id = 'blair-vision-host';
  host.setAttribute('data-blair-vision', '');
  const shadow = host.attachShadow({ mode: 'open' });

  const style = doc.createElement('style');
  style.textContent = css;
  const root = doc.createElement('div');
  root.className = 'root';
  root.dataset.kind = 'idle';
  const pill = doc.createElement('div');
  pill.className = 'pill';
  pill.setAttribute('role', 'button');
  pill.setAttribute('tabindex', '0');
  pill.setAttribute('aria-label', 'Blair Vision');
  const panel = doc.createElement('div');
  panel.className = 'panel';
  const live = doc.createElement('div');
  live.className = 'sr';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  root.append(pill, panel, live);
  shadow.append(style, root);

  let pos = position;
  let state = { kind: 'idle' };
  let pinned = false;
  let hoverTimer = null;
  let dragging = false;

  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const row = (k, v) => { const r = el('div', 'row'); r.append(el('span', 'k', k), el('span', 'v', v)); return r; };

  function place() {
    const w = win.innerWidth, h = win.innerHeight;
    const size = pill.getBoundingClientRect();
    const pw = size.width || 44, ph = size.height || 44;
    if (!pos) pos = { x: Math.max(MARGIN, w - pw - 16), y: 72 }; // upper-right, clear of Chrome's toolbar
    pos = { x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, w - pw - MARGIN)), y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, h - ph - MARGIN)) };
    root.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    root.dataset.side = pos.x + pw / 2 > w / 2 ? 'right' : 'left';
    root.dataset.flip = pos.y > h * 0.6 ? '1' : '0';
  }

  function renderPill() {
    pill.replaceChildren();
    const { kind } = state;
    if (kind === 'thinking') {
      const d = el('span', 'dots');
      d.append(el('span', '', '•'), el('span', '', '•'), el('span', '', '•'));
      pill.append(d);
    } else if (kind === 'result') pill.textContent = state.answer;
    else if (kind === 'low') pill.textContent = `${state.answer} ?`;
    else pill.textContent = PILL_TEXT[kind] ?? '·';
    root.dataset.kind = kind;
    const said = kind === 'result' ? `Answer ${state.answer}` : kind === 'low' ? `Low confidence answer ${state.answer}` : kind === 'error' ? 'Error' : kind === 'thinking' ? 'Thinking' : '';
    live.textContent = said;
    pill.setAttribute('aria-label', `Blair Vision: ${said || kind}`);
  }

  function renderPanel() {
    panel.replaceChildren();
    panel.append(el('div', 'title', 'Blair Vision'));
    const s = state;
    if (s.answer) {
      panel.append(row('Answer', s.answer + (s.answerText ? ` — ${s.answerText.slice(0, 40)}` : '')));
      panel.append(row('Confidence', `${Math.round((s.confidence ?? 0) * 100)}%`));
      panel.append(row(s.source === 'fallback' ? 'Latency' : 'Jev latency', `${Math.round(s.latencyMs ?? 0)} ms`));
      panel.append(row('Source', `${s.pageSource ?? 'DOM'}${s.source === 'cache' ? ' (cached)' : s.source === 'fallback' ? ' (fallback)' : ''}`));
      panel.append(row('Cost', formatCost(s.cost)));
    } else {
      panel.append(row('Status', { idle: 'Watching for a question', detecting: 'Question detected', thinking: 'Thinking…', paused: 'Paused', error: 'Error', visual: 'Visual content detected' }[s.kind] ?? s.kind));
    }
    if (s.message) panel.append(el('div', 'msg', s.message));

    const dist = el('div', 'dist');
    if (s.probabilities) {
      for (const [id, p] of Object.entries(s.probabilities).sort((a, b) => b[1] - a[1])) {
        const bar = el('div', 'bar');
        const track = el('div', 'track');
        const fill = el('div', 'fill');
        fill.style.width = `${Math.round(p * 100)}%`;
        track.append(fill);
        bar.append(el('span', 'lbl', id), track, el('span', 'pct', `${Math.round(p * 100)}%`));
        dist.append(bar);
      }
      if (s.reason) dist.append(el('div', 'row', s.reason));
    } else dist.append(el('div', 'row', 'No probabilities yet.'));
    panel.append(dist);

    const btns = el('div', 'btns');
    const bPause = el('button', 'b-pause', state.kind === 'paused' ? 'Resume' : 'Pause');
    const bExplain = el('button', 'b-explain', 'Explain');
    const bSettings = el('button', 'b-settings', 'Settings');
    bPause.addEventListener('click', () => onPause());
    bExplain.addEventListener('click', () => dist.classList.toggle('show'));
    bSettings.addEventListener('click', () => onSettings());
    btns.append(bPause, bExplain, bSettings);
    panel.append(btns);
  }

  function setOpen(open) {
    root.classList.toggle('open', open);
    if (open) place();
  }

  // ---- interaction ----
  let drag = null;
  pill.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    try { pill.setPointerCapture(e.pointerId); } catch { /* not supported in some environments */ }
  });
  pill.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    dragging = true;
    root.classList.add('dragging');
    pos = { x: drag.ox + dx, y: drag.oy + dy };
    place();
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    dragging = false;
    root.classList.remove('dragging');
    if (moved) onMove({ ...pos });
    else { pinned = !pinned; setOpen(pinned); }
  };
  pill.addEventListener('pointerup', endDrag);
  pill.addEventListener('pointercancel', () => { drag = null; dragging = false; root.classList.remove('dragging'); });
  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pinned = !pinned; setOpen(pinned); }
  });
  root.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (!dragging) setOpen(true); }, 250);
  });
  root.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    if (!pinned) setOpen(false);
  });
  win.addEventListener('resize', place);

  // Attach to <html>, not <body>, so the page's own body mutations/replacements never touch it.
  const attach = () => { if (!host.isConnected) doc.documentElement.append(host); };
  attach();
  renderPill(); renderPanel(); place();

  return {
    host,
    /** @param {{kind:string, answer?:string, answerText?:string, confidence?:number, latencyMs?:number, source?:string, pageSource?:string, cost?:number, message?:string, probabilities?:Record<string,number>, reason?:string}} next */
    setState(next) {
      state = next;
      attach(); // survive frameworks that wipe the document
      renderPill(); renderPanel(); place();
    },
    get state() { return state; },
    destroy() {
      clearTimeout(hoverTimer);
      win.removeEventListener('resize', place);
      host.remove();
    },
  };
}
