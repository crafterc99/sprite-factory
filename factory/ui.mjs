/** Shared components in the Soul Jam design language (panels, tags, buttons with reasons, overlays). */
import { html, useState, useEffect, useRef } from '/factory/ui/preact-htm.mjs';
import { store, useStore, dismissToast, openLightbox, useNow, fmtDur, STAGE_TONE, PIPE_TONE, JOB_TONE, secondsBetween } from '/factory/ui/lib.mjs';

/** Sets the document title for a page. */
export const useTitle = (t) => useEffect(() => { document.title = t ? `${t} · Sprite Factory` : 'Soul Jam · Sprite Factory'; }, [t]);

export const Tag = ({ tone = '', children, title }) => html`<span class=${'tag ' + tone} title=${title}>${children}</span>`;
export const StageTag = ({ status, title }) => html`<span class=${'tag ' + (STAGE_TONE[status] ?? '')} title=${title}>${status || '—'}</span>`;
export const JobTag = ({ status }) => html`<span class=${'tag ' + (JOB_TONE[status] ?? '')}>${status}</span>`;
export const Pipe = ({ status, text, title }) => html`<span class=${'pipe ' + PIPE_TONE(status)} title=${title || status}><i></i>${text || status}</span>`;

export function Pnl({ title, meta, right, children, cls = '', id, bodyCls = '' }) {
  return html`<section class=${'pnl fade ' + cls} id=${id}>
    ${(title || right) && html`<div class="ph"><span class="d">${title}</span>${meta && html`<span class="u">${meta}</span>`}<span class="sp"></span>${right}</div>`}
    <div class=${'pb ' + bodyCls}>${children}</div>
  </section>`;
}
export const Kpi = ({ v, k, x, cls = '', title }) => html`<div class=${'kpi ' + cls} title=${title}><div class="v">${v}</div><div class="k">${k}</div>${x && html`<div class="x">${x}</div>`}</div>`;

export function Empty({ title, children, actions, dark = false }) {
  return html`<div class=${'empty2' + (dark ? ' dk' : '')}><span class="d">${title}</span>${children && html`<p class="hint">${children}</p>`}${actions && html`<div class="row" style="justify-content:center">${actions}</div>`}</div>`;
}
export const Loading = ({ label = 'Loading' }) => html`<div class="loadrow"><i></i>${label}…</div>`;
export function FetchError({ error, onRetry, what = 'data' }) {
  return html`<div class="errbox"><span class="d">Could not load ${what}</span><span>${error}</span>${onRetry && html`<div><button class="btn sm" onClick=${onRetry}>Retry</button></div>`}</div>`;
}
export const Chk = ({ tone = '', icon, children }) => html`<div class=${'chk ' + tone}><b>${icon ?? (tone === 'w' ? '!' : tone === 'bad' ? '✕' : tone === 'info' ? 'i' : '✓')}</b><div class="body">${children}</div></div>`;

/**
 * Button that is either live or disabled *with the reason shown* (tooltip + optional caption).
 * href → a link styled as a button (internal /factory links go through the router).
 */
export function B({ label, onClick, href, kind = '', size = 'sm', disabled = false, why, showWhy = false, paid = false, busy = false, title, testid, target, download }) {
  const cls = ['btn', size, kind, paid ? 'paid' : ''].filter(Boolean).join(' ');
  const off = disabled || busy;
  const tip = off && why ? why : title;
  const el = href && !off
    ? html`<a class=${cls} href=${href} title=${tip} data-t=${testid} target=${target} download=${download}>${label}</a>`
    : html`<button class=${cls} disabled=${off} title=${tip} data-t=${testid} onClick=${onClick}>${busy ? label + '…' : label}</button>`;
  return showWhy && disabled && why ? html`<span class="act">${el}<span class="why">${why}</span></span>` : el;
}

export function Elapsed({ since, until }) {
  const now = useNow(1000, !until);
  const s = secondsBetween(since, until || now);
  return html`<span>${fmtDur(s)}</span>`;
}
export function Copy({ text, label }) {
  const [ok, set] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(text); set(true); setTimeout(() => set(false), 1400); } catch { set(false); prompt('Copy:', text); } };
  return html`<span class="copy"><code>${label || text}</code><button type="button" onClick=${copy} data-t="copy">${ok ? 'copied' : 'copy'}</button></span>`;
}
export const Img = ({ src, alt = '', caption, cls, style }) => html`<img src=${src} alt=${alt} class=${cls} style=${style} loading="lazy" onClick=${() => openLightbox(src, caption || alt)} />`;

export function Menu({ label, items, kind = '', disabled = false, why, paid = false, testid }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', f); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('pointerdown', f); document.removeEventListener('keydown', k); };
  }, [open]);
  return html`<span class="menu" ref=${ref}>
    <${B} label=${label + ' ▾'} kind=${kind} paid=${paid} disabled=${disabled} why=${why} testid=${testid} onClick=${() => setOpen(!open)} />
    ${open && html`<div class="pop" role="menu">${items.map((it) => html`<button role="menuitem" disabled=${it.disabled} title=${it.why} onClick=${() => { setOpen(false); it.onClick(); }}>${it.label}${it.meta && html`<span>${it.meta}</span>`}</button>`)}</div>`}
  </span>`;
}

// ═══ global overlays ═══
function Dialog({ d }) {
  const [txt, setTxt] = useState('');
  const inp = useRef(), okb = useRef();
  useEffect(() => { setTimeout(() => (d.typed ? inp.current : okb.current)?.focus(), 30); const k = (e) => { if (e.key === 'Escape') d.resolve(false); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [d]);
  const ok = !d.typed || txt.trim() === d.typed;
  return html`<div class="modal-bg" onClick=${(e) => { if (e.target === e.currentTarget) d.resolve(false); }}>
    <div class=${'modal ' + (d.tone || '')} role="dialog" aria-modal="true" aria-label=${d.title}>
      <span class="d">${d.title}</span>
      <div class="body">${typeof d.body === 'string' ? html`<p>${d.body}</p>` : d.body}</div>
      ${d.typed && html`<label><span class="lbl">Type <code>${d.typed}</code> to confirm</span><input class="inp" ref=${inp} value=${txt} onInput=${(e) => setTxt(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && ok) d.resolve(true); }} autocomplete="off" spellcheck="false" data-t="typed-confirm" /></label>`}
      <div class="row end">
        <button class="btn sm" onClick=${() => d.resolve(false)} data-t="dialog-cancel">Cancel</button>
        <button ref=${okb} class=${'btn sm ' + (d.tone === 'danger' ? 'danger' : 'pri')} disabled=${!ok} onClick=${() => d.resolve(true)} data-t="dialog-ok">${d.confirm}</button>
      </div>
    </div>
  </div>`;
}
export function Overlays() {
  const s = useStore();
  return html`
    ${s.dialog && html`<${Dialog} d=${s.dialog} />`}
    ${s.lightbox && html`<div class="lightbox" onClick=${() => store.set({ lightbox: null })} data-t="lightbox"><img src=${s.lightbox.src} alt=${s.lightbox.caption || ''} /><span class="u">${s.lightbox.caption} · click to close</span></div>`}
    <div class="toasts" aria-live="polite">${s.toasts.map((t) => html`<div class=${'toast ' + t.tone} key=${t.id}><span>${t.msg}</span>${t.action && html`<a href=${t.action.href} onClick=${() => dismissToast(t.id)}>${t.action.label}</a>`}<button class="x" onClick=${() => dismissToast(t.id)} aria-label="dismiss">✕</button></div>`)}</div>`;
}
