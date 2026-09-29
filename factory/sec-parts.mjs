/** Parts (Tripo source generations, SOURCE HIGH) and Assembly (automatic alignment report + previews). */
import { html, useState, useRef } from '/factory/ui/preact-htm.mjs';
import { busyOf, tripoReady, startJob, fmtBytes, fmtNum, fmtK, fmtTime, fmtDur, secondsBetween, partLabel, CORE_PARTS, STAGE_LABEL } from '/factory/ui/lib.mjs';
import { Pnl, Empty, Chk, B, Tag, StageTag, Img, Copy } from '/factory/ui/ui.mjs';
import { Viewer } from '/factory/ui/viewer.mjs';
import { regenerate, runLocal, resumeCharacter } from '/factory/ui/actions.mjs';

export const SourceBadge = () => html`<span class="srcbadge" title="Tripo high-detail source master — not a game asset">Source high</span>`;
export const GameBadge = () => html`<span class="srcbadge game" title="Optimised, baked game mesh">Game ready</span>`;

function refFor(d, part, g) {
  const front = g?.views?.front;
  return d.references.find((r) => r.part === part && r.cleaned === front) || d.references.find((r) => r.part === part);
}

function PartCard({ d, part, status, onInspect, inspecting }) {
  const g = d.generation[part] || {};
  const ps = d.state.parts[part] || { status: 'missing', reason: 'no references' };
  const t = g.task || {};
  const busy = busyOf(d);
  const noTripo = !tripoReady(status) ? 'Tripo API key not configured (Settings)' : null;
  const ref = refFor(d, part, g);
  const base = `/factory/characters/${encodeURIComponent(d.summary.id)}`;
  const dur = secondsBetween(t.createdAt, t.finishedAt);
  return html`<article class="pcard" data-t=${'part-' + part}>
    <div class="pimgs">
      <div>${ref ? html`<${Img} src=${ref.cleanedUrl} alt=${part + ' reference'} caption=${`${partLabel(part)} · reference ${ref.view}`} />` : html`<span class="no">no reference</span>`}<span class="cap">reference${ref ? ' · ' + ref.view : ''}</span></div>
      <div>${g.renderUrl ? html`<${Img} src=${g.renderUrl} alt=${part + ' Tripo render'} caption=${`${partLabel(part)} · Tripo render`} />` : html`<span class="no">${ps.status === 'done' ? 'Tripo gave no render' : 'not generated'}</span>`}<span class="cap">Tripo render</span></div>
    </div>
    <div class="ph2"><span class="d">${partLabel(part)}</span>${g.sourceUrl && html`<${SourceBadge} />`}<span class="sp"></span><${StageTag} status=${ps.status} />${ps.phase && ps.status === 'running' && html`<${Tag} tone="run">${ps.phase}</${Tag}>`}</div>
    <div class="pbody">
      ${(ps.reason || ps.error) && html`<${Chk} tone=${ps.status === 'failed' ? 'bad' : ps.status === 'stale' || ps.status === 'interrupted' ? 'w' : 'info'}><span>${ps.error || ps.reason}</span></${Chk}>`}
      ${t.id ? html`<dl class="kv">
        <dt>Tripo task</dt><dd><${Copy} text=${t.id} /></dd>
        <dt>Task status</dt><dd>${t.status}${t.type ? ' · ' + t.type : ''}${g.phase ? ' · phase ' + g.phase : ''}</dd>
        <dt>Mode</dt><dd>${g.mode === 'multiview' ? 'multiview' : 'single image'} · ${Object.keys(g.views || {}).join(', ') || '—'}</dd>
        <dt>Model</dt><dd class="mono">${g.model || '—'}</dd>
        <dt>Seeds</dt><dd class="mono">${g.seeds ? `model ${g.seeds.model_seed} · texture ${g.seeds.texture_seed}` : '—'}</dd>
        <dt>Credits</dt><dd>${t.credits != null ? t.credits : 'not reported yet'}</dd>
        <dt>Time</dt><dd>${fmtTime(t.createdAt)} → ${t.finishedAt ? fmtTime(t.finishedAt) : '…'}${dur ? ` (${fmtDur(dur)})` : ''}</dd>
        <dt>Source</dt><dd>${g.sourceBytes ? fmtBytes(g.sourceBytes) + ' GLB' : 'not downloaded'}${d.manifest.parts?.sourceHigh?.[{ body: 'BODY_HIGH', head: 'HEAD_DONOR', hand_left: 'HAND_LEFT_DONOR', hand_right: 'HAND_RIGHT_DONOR' }[part]] ? ` · ${fmtK(d.manifest.parts.sourceHigh[{ body: 'BODY_HIGH', head: 'HEAD_DONOR', hand_left: 'HAND_LEFT_DONOR', hand_right: 'HAND_RIGHT_DONOR' }[part]])} tris after assembly cut` : ''}</dd>
        <dt>Attempts</dt><dd>${g.attempts ?? '—'}${g.history?.length ? ` · ${g.history.length} earlier source${g.history.length > 1 ? 's' : ''}` : ''}</dd>
      </dl>` : html`<p class="hint">${ps.status === 'missing' ? 'No references for this part yet.' : 'Not generated yet: no Tripo task.'}</p>`}
      ${g.history?.length > 0 && html`<details class="adv"><summary>Earlier sources (${g.history.length})</summary><div class="in">${g.history.map((h) => html`<div class="mono" style="font-size:12px">${fmtTime(h.at)} · task ${String(h.task).slice(0, 8)} · ${h.credits ?? '?'} cr · seeds ${h.seeds ? h.seeds.model_seed + '/' + h.seeds.texture_seed : '—'}</div>`)}</div></details>`}
    </div>
    <div class="pact">
      ${ps.status === 'missing' && html`<${B} label="Add references" kind="pri" href=${`${base}/references#refs-${part}`} testid="part-addrefs" />`}
      ${ps.status === 'ready' && html`<${B} label="Generate" kind="pri" paid disabled=${!!(busy || noTripo)} why=${busy || noTripo} onClick=${() => regenerate(d, part)} testid="part-generate" />`}
      ${ps.status === 'interrupted' && html`<${B} label="Resume task" kind="pri" disabled=${!!(busy || noTripo)} why=${busy || noTripo} title="picks up the Tripo task already paid for" onClick=${() => resumeCharacter(d.summary, status)} testid="part-resume" />`}
      ${['done', 'stale', 'failed'].includes(ps.status) && html`<${B} label="Regenerate" paid disabled=${!!(busy || noTripo)} why=${busy || noTripo} onClick=${() => regenerate(d, part)} testid="part-regenerate" />`}
      <${B} label=${inspecting ? 'Inspecting ↓' : 'Inspect'} kind=${inspecting ? 'ink' : ''} disabled=${!g.sourceUrl} why="no source model downloaded" onClick=${() => onInspect(part)} testid="part-inspect" />
      <${B} label="Download Source" href=${g.sourceUrl} download=${`${d.summary.id}-${part}-source.glb`} disabled=${!g.sourceUrl} why="no source model downloaded" testid="part-download" />
      ${ps.status !== 'missing' && html`<${B} label="Replace References" href=${`${base}/references#refs-${part}`} testid="part-refs" />`}
    </div>
  </article>`;
}

export function PartsSection({ d, status }) {
  const parts = [...new Set([...CORE_PARTS.filter((p) => d.state.parts[p] || d.generation[p] || p === 'body' || p === 'head'), ...Object.keys(d.state.parts), ...Object.keys(d.generation)])];
  const [insp, setInsp] = useState(null);
  const vref = useRef();
  const g = insp && d.generation[insp];
  const inspect = (p) => { setInsp(p); setTimeout(() => vref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); };
  const gen = d.state.stages.generate;
  return html`<div class="stack">
    <div class="row" style="color:var(--paper)"><span class="sec" style="flex:1">Tripo source generation · <${StageTag} status=${gen.status} />${gen.reason ? ' · ' + gen.reason : ''}</span><${SourceBadge} /><span class="u mut">= high-detail Tripo masters (≈70 MB, 1.5–2M triangles each). The game uses the baked game mesh (<${GameBadge} />).</span></div>
    <div class="partgrid">${parts.map((p) => html`<${PartCard} key=${p} d=${d} part=${p} status=${status} onInspect=${inspect} inspecting=${insp === p} />`)}</div>
    <div ref=${vref}>${g && g.sourceUrl ? html`<${Viewer} key=${insp} title=${`${partLabel(insp)} source`} badge=${html`<${SourceBadge} />`} models=${[{ key: insp, label: partLabel(insp), url: g.sourceUrl, bytes: g.sourceBytes, triangles: null }]} autoLoadBelow=${0}
        warn=${`Tripo source masters are large (${fmtBytes(g.sourceBytes)}, typically 1.5–2 million triangles): allow time and memory; on a phone or older iPad it may not load.`} testid="parts-viewer" />`
      : html`<${Empty} dark title="No source open" actions=${html`<${B} label="Inspect the body source" disabled=${!d.generation.body?.sourceUrl} why="the body has no source yet" onClick=${() => inspect('body')} testid="parts-inspect-body" />`}>Inspect loads one part's source GLB into the 3D viewer. Only one model is loaded at a time.</${Empty}>`}</div>
  </div>`;
}

// ═══ Assembly ═══
const RMS_LIMIT = 1;
function alignState(d, key, rep) {
  const st = d.state.stages.assemble;
  const warns = (d.manifest.stages?.assemble?.report?.warnings || []).filter((w) => w.toLowerCase().includes(key.replace('_', ' ')) || w.includes(key));
  if (!rep) return st.status === 'failed' ? ['FAILED', 'rd', st.error] : d.generation[key]?.sourceHigh ? ['NOT ASSEMBLED', 'gy', 'this source was not part of the last assembly'] : ['NO DONOR', 'gy', 'no source for this part: the body keeps its own'];
  if (rep.icp_rms_cm > RMS_LIMIT || warns.length) return ['NEEDS REVIEW', 'yl', [rep.icp_rms_cm > RMS_LIMIT ? `ICP rms ${rep.icp_rms_cm.toFixed(2)} cm > ${RMS_LIMIT} cm` : null, ...warns].filter(Boolean).join(' · ')];
  return ['AUTO ALIGNED', 'gr', `ICP rms ${rep.icp_rms_cm?.toFixed(2) ?? '—'} cm`];
}
const cm = (x) => (x == null ? '—' : (+x).toFixed(2) + ' cm');
const f3 = (x) => (x == null ? '—' : (+x).toFixed(3));

export function AssemblySection({ d, status }) {
  const A = d.manifest.stages?.assemble || {}, R = A.report;
  const st = d.state.stages.assemble;
  const busy = busyOf(d);
  const why = busy || (st.status === 'blocked' ? 'blocked until Source generation is done' : null);
  const imgs = Object.entries(d.previews).filter(([k]) => k.startsWith('previews/assembled/'));
  const totalTris = R ? Object.values(R.triangles || {}).reduce((a, b) => a + b, 0) : null;
  const base = `/factory/characters/${encodeURIComponent(d.summary.id)}`;
  if (!R) return html`<${Empty} dark title=${st.status === 'failed' ? 'Assembly failed' : 'Not assembled yet'} actions=${html`<${B} label="Run Assembly" kind="pri" disabled=${!!why} why=${why} showWhy onClick=${() => runLocal(d, 'assemble', 'Run assembly')} testid="asm-run" /><a class="btn" href=${`${base}/parts`}>Parts</a>`}>
    ${st.status === 'failed' ? st.error : 'Assembly aligns the head and hand sources onto the body master (Blender, automatic alignment) once the body source exists.'}</${Empty}>`;
  const rows = [['head', R.head], ['hand_left', R.hand_left], ['hand_right', R.hand_right]];
  return html`<div class="stack">
    <div class="cols w2">
      <${Pnl} title="Alignment" meta=${`mode: automatic alignment · ${fmtTime(A.at)} · ${A.seconds ?? st.seconds ?? '?'} s`} right=${html`<${StageTag} status=${st.status} />`}>
        ${st.status === 'stale' && html`<${Chk} tone="w"><span>Stale: ${st.reason}. Re-run assembly to use the current sources.</span></${Chk}>`}
        <div class="checks">${rows.map(([k, rep]) => { const [lab, tone, txt] = alignState(d, k, rep); return html`<div class=${'chk ' + (tone === 'gr' ? '' : tone === 'rd' ? 'bad' : 'w')} data-t=${'align-' + k}><b>${tone === 'gr' ? '✓' : tone === 'rd' ? '✕' : '!'}</b><div class="body"><span><b>${partLabel(k)}</b> · <${Tag} tone=${tone}>${lab}</${Tag}></span><span class="u">${txt}</span></div></div>`; })}</div>
        <span class="u mut">Review rule: ICP rms above ${RMS_LIMIT} cm, or a warning from the assembler. Manual adjustment is not available — fix the references or regenerate the part, then re-run assembly.</span>
        <div class="row"><${B} label="Re-run Assembly" kind="pri" disabled=${!!why} why=${why} showWhy onClick=${() => runLocal(d, 'assemble', 'Re-run assembly')} testid="asm-rerun" /><a class="btn sm" href=${fileUrlSafe(d, 'logs/assemble.log')} target="_blank" rel="noopener">Assembly log</a></div>
      </${Pnl}>
      <${Pnl} title="Body master" meta="SOURCE HIGH">
        <dl class="kv">
          <dt>Vertices</dt><dd>${fmtNum(R.body?.vertices)}</dd><dt>Triangles</dt><dd>${fmtNum(R.body?.triangles)}</dd><dt>Height</dt><dd>${R.body?.height} m</dd>
          <dt>Neck</dt><dd>y ${f3(R.neck?.y)} · radius ${cm(R.neck?.radius * 100)}</dd>
          <dt>Assembled</dt><dd>${fmtNum(totalTris)} triangles in ${Object.keys(R.triangles || {}).length} pieces</dd>
        </dl>
        ${(R.warnings || []).map((w) => html`<${Chk} tone="w"><span>${w}</span></${Chk}>`)}
        ${!(R.warnings || []).length && html`<span class="u mut">No assembler warnings.</span>`}
      </${Pnl}>
    </div>
    <${Pnl} title="Measurements" meta="from assembled/assemble-report.json" bodyCls="flush">
      <div class="tbl-wrap"><table class="tbl" data-t="asm-table"><thead><tr><th>Part</th><th class="n">Scale</th><th class="n">ICP rms</th><th class="n">ICP rotation</th><th class="n">Ring before → after</th><th>Other</th></tr></thead><tbody>
        <tr><td><b>Head</b></td><td class="n">${f3(R.head?.scale)}<br /><span class="u mut">landmarks ${f3(R.head?.landmark_scale)}</span></td><td class="n">${cm(R.head?.icp_rms_cm)}</td><td class="n">—</td><td class="n">${cm(R.head?.neck_ring?.ring_mismatch_before_cm)} → ${cm(R.head?.neck_ring?.ring_mismatch_after_cm)}</td>
          <td class="m">landmark error: ${Object.entries(R.head?.landmark_error_cm || {}).map(([k, v]) => html`<span style=${{ background: v > 5 ? '#f5d9a4' : '' }}>${k} ${v} cm</span> `)}<br />donor ${fmtK(R.head?.donor_triangles)} tris · cut body ${fmtNum(R.head?.cut?.body_vertices_removed)} / donor ${fmtNum(R.head?.cut?.donor_vertices_removed)} verts</td></tr>
        ${['hand_left', 'hand_right'].map((k) => { const h = R[k]; return h ? html`<tr><td><b>${partLabel(k)}</b></td><td class="n">${f3(h.scale)}<br /><span class="u mut">length ${f3(h.scale_from_length)} · wrist ${f3(h.scale_from_wrist)}</span></td><td class="n">${h.icp_used ? cm(h.icp_rms_cm) : 'not used'}</td><td class="n">${h.icp_rotation_deg != null ? h.icp_rotation_deg.toFixed(1) + '°' : '—'}</td><td class="n">${cm(h.wrist_ring?.ring_mismatch_before_cm)} → ${cm(h.wrist_ring?.ring_mismatch_after_cm)}</td>
          <td class="m">wrist [${(h.wrist || []).map((x) => x.toFixed(3)).join(', ')}] r ${cm(h.wrist_radius_cm)} · body hand ${cm(h.body_hand_length_cm)} · ${h.traced_slices} slices · donor ${fmtK(h.donor_triangles)} tris</td></tr>` : html`<tr><td><b>${partLabel(k)}</b></td><td colspan="5" class="m">not in this assembly</td></tr>`; })}
      </tbody></table></div>
      <p class="hint" style="padding:10px 14px">Landmark errors (highlighted above 5 cm) come from landmark detection on the donor and are shown for reference; the review rule uses the ICP fit and the assembler's warnings.</p>
    </${Pnl}>
    ${imgs.length > 0 && html`<${Pnl} title="Assembled renders" meta="previews/assembled"><div class="gal">${imgs.map(([k, u]) => html`<figure><${Img} src=${u} alt=${k} caption=${k.split('/').pop()} /><figcaption>${k.split('/').pop().replace('.png', '').replace('_', ' ')}</figcaption></figure>`)}</div></${Pnl}>`}
    ${d.files.assembledGlb ? html`<${Viewer} title="Assembled model" badge=${html`<${SourceBadge} />`} models=${[{ key: 'high', label: 'assembled/high.glb', url: d.files.assembledGlb.url, bytes: d.files.assembledGlb.bytes, triangles: totalTris }]} autoLoadBelow=${0}
        warn=${`This is the full SOURCE HIGH assembly (${fmtBytes(d.files.assembledGlb.bytes)}, ~${fmtK(totalTris)} triangles). Loading it needs several GB of memory and can take minutes; the renders above are usually enough.`} testid="asm-viewer" />`
      : html`<${Empty} dark title="No assembled GLB" actions=${html`<${B} label="Re-run Assembly" disabled=${!!why} why=${why} onClick=${() => runLocal(d, 'assemble', 'Re-run assembly')} />`}>assembled/high.glb is missing.</${Empty}>`}
  </div>`;
}
const fileUrlSafe = (d, rel) => `/api/cf/characters/${encodeURIComponent(d.summary.id)}/file?path=${encodeURIComponent(rel)}`;
