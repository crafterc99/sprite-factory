/** /factory/playground — the real court with a player strip built from the court's own rigs. */
import { html } from '/factory/ui/preact-htm.mjs';
import { useJson, setQuery, hashColor } from '/factory/ui/lib.mjs';
import { Loading, FetchError, Empty, useTitle } from '/factory/ui/ui.mjs';
import { useCourt, CourtFrame, CAMS, courtSrc } from '/factory/ui/court.mjs';

export function PlaygroundPage({ q }) {
  useTitle('Playground');
  const chars = useJson('/api/mocap3d/characters');
  const court = useCourt();
  const list = chars.data?.characters || [];
  const id = q.get('char') && list.find((c) => c.id === q.get('char')) ? q.get('char') : list[0]?.id;
  const kind = q.get('court') === 'vantheah' ? 'vantheah' : 'classic';
  if (!chars.data) return html`<div class="wrap">${chars.error ? html`<${FetchError} error=${chars.error} onRetry=${chars.reload} what="the court characters" />` : html`<${Loading} label="Loading the court roster" />`}</div>`;
  if (!list.length) return html`<div class="wrap"><${Empty} dark title="No court characters" actions=${html`<a class="btn pri" href="/factory">Characters</a>`}>The court has no rigs registered. A factory character joins the roster after its Soul Jam skeleton import.</${Empty}></div>`;
  const src = courtSrc(id, { court: kind });
  const { st } = court;
  const why = st.phase !== 'ready' ? (st.phase === 'error' ? 'the court could not start' : 'the court is loading') : null;
  const cur = list.find((c) => c.id === id);
  return html`<div class="pgw">
    <div class="tb">
      <span class="tp">3D COURT <span class=${'st' + (st.phase === 'error' ? ' bad' : st.phase === 'loading' ? ' wait' : '')}>${st.phase.toUpperCase()}</span></span>
      <span class="tp">Court <span class="sg">${[['classic', 'Classic'], ['vantheah', 'VANTHEAH']].map(([k, l]) => html`<button class=${kind === k ? 'on' : ''} onClick=${() => setQuery({ court: k === 'classic' ? null : k }, { replace: false })} data-t=${'court-' + k}>${l}</button>`)}</span></span>
      <span class="tp">Cam <span class="sg">${CAMS.map(([k, l]) => html`<button class=${court.cam === k && !why ? 'on' : ''} disabled=${!!why} title=${why || ''} onClick=${() => court.camera(k)} data-t=${'pcam-' + k}>${l}</button>`)}</span></span>
      <span class="tp" data-t="pg-fps">${st.fps || '— fps'}</span>
      <span class="tp">${st.lod ? `LOD${st.lod.level}${st.lod.triangles ? ' · ' + Math.round(st.lod.triangles).toLocaleString() + ' tris' : ''}` : 'LOD —'}</span>
      <span class="tp">clips ${st.ready ? st.clips.length : '—'}</span>
      <a class="tp" href=${src} target="_blank" rel="noopener" data-t="pg-open">open full court ↗</a>
    </div>
    <${CourtFrame} court=${court} src=${src} title=${`${cur?.name || id} on the court`} />
    <div class="psrow" role="listbox" aria-label="Player">
      ${list.map((c) => html`<button key=${c.id} role="option" aria-selected=${c.id === id} class=${'pscard' + (c.id === id ? ' on' : '')} style=${{ '--pc': hashColor(c.id) }} onClick=${() => setQuery({ char: c.id }, { replace: false })} data-t=${'player-' + c.id}>
        <span class="pcn">${c.name.split('·')[0].trim()}</span><span class="pch">${c.heightM ? c.heightM.toFixed(2) + ' m' : ''} · ${c.id}</span></button>`)}
    </div>
  </div>`;
}
