/** Court Test: this character on the real Soul Jam court, with camera presets, poses and telemetry. */
import { html } from '/factory/ui/preact-htm.mjs';
import { setQuery, busyOf, fmtTime, STAGE_LABEL } from '/factory/ui/lib.mjs';
import { Pnl, Empty, Chk, B, StageTag } from '/factory/ui/ui.mjs';
import { useCourt, CourtFrame, CourtControls, courtSrc } from '/factory/ui/court.mjs';
import { runLocal, resumeCharacter } from '/factory/ui/actions.mjs';
import { stageWhy } from '/factory/ui/sec-rig.mjs';

export function CourtSection({ d, q, status }) {
  const lod = q.get('lod');
  const court = useCourt();
  const ct = d.state.stages.courttest, rec = d.manifest.stages?.courttest;
  const next = d.state.next;
  if (!d.courtUrl) {
    const why = busyOf(d) || (!next ? null : !['ready', 'failed', 'stale', 'partial'].includes(d.state.stages[next].status) ? `${STAGE_LABEL[next]} is ${d.state.stages[next].status}` : null);
    return html`<${Empty} dark title="No court rig yet" actions=${html`<${B} label="Run the pipeline" kind="pri" paid disabled=${!!why} why=${why} showWhy onClick=${() => resumeCharacter(d.summary, status)} testid="court-resume" /><a class="btn" href=${`/factory/characters/${encodeURIComponent(d.summary.id)}/overview`}>Pipeline status</a>`}>
      The court plays the character once it is rigged and imported onto the Soul Jam skeleton (next open stage: <b>${next ? STAGE_LABEL[next] : '—'}</b>).</${Empty}>`;
  }
  const lodN = Object.keys(d.lods || {}).length;
  const src = courtSrc(d.rigId, { court: 'classic', lod });
  const why = stageWhy(d, 'courttest');
  return html`<div class="stack">
    <div class="courtwrap">
      <div class="stack">
        <${CourtFrame} court=${court} src=${src} title=${`${d.summary.name} on the court`} />
        <div class="row">
          <span class="u" style="color:rgba(238,233,217,.7)">LOD</span>
          <div class="subtabs sm"><button class=${lod == null ? 'on' : ''} onClick=${() => setQuery({ lod: null })} data-t="lod-auto">Auto</button>${Array.from({ length: lodN }, (_, i) => html`<button class=${lod === String(i) ? 'on' : ''} onClick=${() => setQuery({ lod: i })} data-t=${'lod-' + i}>LOD${i}</button>`)}</div>
          <span class="sp"></span>
          <a class="btn sm" href=${src} target="_blank" rel="noopener" data-t="court-open">Open the court page ↗</a>
        </div>
      </div>
      <div class="on-dark"><${CourtControls} court=${court} /></div>
    </div>
    <${Pnl} title="Automated court test" meta="scripts/court3d-test.js with this character" right=${html`<${StageTag} status=${ct.status} />`}>
      ${rec ? html`<${Chk} tone=${rec.passed ? '' : 'bad'}><span>${rec.passed ? 'Passed' : 'Failed'} · ${fmtTime(rec.at)}</span></${Chk}>${rec.tail?.length > 0 && html`<pre class="log">${rec.tail.join('\n')}</pre>`}` : html`<span class="hint">Not run yet.</span>`}
      ${ct.status === 'failed' && ct.error && html`<${Chk} tone="bad"><span>${ct.error}</span></${Chk}>`}
      <div class="row"><${B} label=${rec ? 'Run court test again' : 'Run court test'} disabled=${!!why} why=${why} showWhy onClick=${() => runLocal(d, 'courttest', 'Run the court test')} testid="court-test" /></div>
    </${Pnl}>
  </div>`;
}
