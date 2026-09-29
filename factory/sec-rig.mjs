/** Rig (Tripo rig + merge + Soul Jam skeleton import), Animation (clip roles + deformation report), LODs. */
import { html, useState } from '/factory/ui/preact-htm.mjs';
import { useJson, useStore, busyOf, tripoReady, navigate, fmtNum, fmtK, fmtTime, fmtBytes, secondsBetween, fmtDur, STAGES, STAGE_LABEL, SKELETON } from '/factory/ui/lib.mjs';
import { Pnl, Empty, Chk, B, Tag, StageTag, Img, Copy, Loading, FetchError } from '/factory/ui/ui.mjs';
import { Viewer } from '/factory/ui/viewer.mjs';
import { rerig, runLocal, resumeCharacter } from '/factory/ui/actions.mjs';
import { GameBadge } from '/factory/ui/sec-parts.mjs';

const blockedBy = (d, st) => { const i = STAGES.indexOf(st); const dep = STAGES.slice(0, i).reverse().find((x) => d.state.stages[x].status !== 'done'); return dep ? `${STAGE_LABEL[dep]} is ${d.state.stages[dep].status}` : 'dependencies not done'; };
export const stageWhy = (d, st) => busyOf(d) || (d.state.stages[st].status === 'blocked' ? `blocked: ${blockedBy(d, st)}` : null);

function TaskRow({ label, rec }) {
  const t = rec?.task;
  if (!t?.id) return html`<tr><td>${label}</td><td colspan="4" class="m">no task yet</td></tr>`;
  const dur = secondsBetween(t.createdAt, t.finishedAt);
  return html`<tr><td>${label}</td><td class="m"><${Copy} text=${t.id} label=${t.id.slice(0, 13) + '…'} /></td><td><${StageTag} status=${t.status} /></td><td class="n">${t.credits ?? '—'}</td><td class="m">${fmtTime(t.createdAt)}${dur ? ` · ${fmtDur(dur)}` : ''}${t.error ? html`<br /><span style="color:#8c1d2c">${t.error}</span>` : ''}</td></tr>`;
}

export function RigSection({ d, status }) {
  const R = d.manifest.stages?.rig || {}, I = d.manifest.stages?.import || {};
  const rst = d.state.stages.rig, ist = d.state.stages.import;
  const noTripo = !tripoReady(status) ? 'Tripo API key not configured (Settings)' : null;
  const whyRig = stageWhy(d, 'rig') || noTripo, whyImp = stageWhy(d, 'import');
  const base = `/factory/characters/${encodeURIComponent(d.summary.id)}`;
  const rep = R.report, r0 = I.reports?.[0];
  const models = [d.lods?.lod0?.url && { key: 'lod0', label: 'Rigged LOD0', url: d.lods.lod0.url, bytes: d.lods.lod0.bytes, triangles: d.lods.lod0.triangles }, d.files.rigGlb && { key: 'tripo', label: 'Tripo rig', url: d.files.rigGlb.url, bytes: d.files.rigGlb.bytes }].filter(Boolean);
  if (!R.check && !rep && rst.status !== 'running') {
    const gm = d.state.stages.gamemesh;
    return html`<div class="stack"><${Empty} dark title=${rst.status === 'failed' ? 'Rigging failed' : 'Not rigged yet'} actions=${html`
        <${B} label="Run Rigging" kind="pri" paid disabled=${!!whyRig} why=${whyRig} showWhy onClick=${() => rerig(d)} testid="rig-run" />
        ${rst.status === 'blocked' && gm.status !== 'done' && html`<${B} label="Rebuild Game Mesh" disabled=${!!stageWhy(d, 'gamemesh')} why=${stageWhy(d, 'gamemesh')} showWhy onClick=${() => runLocal(d, 'gamemesh', 'Rebuild the game mesh')} testid="rig-gamemesh" />`}`}>
      ${rst.status === 'failed' ? rst.error : `The rig stage uploads the game mesh (${gm.status === 'done' ? 'ready' : 'not built yet: ' + (gm.status === 'running' ? 'game mesh is running' : 'game mesh ' + gm.status)}) to Tripo for rig-check + rig (Mixamo spec), then merges the rig onto the LOD chain; the import maps it onto ${SKELETON.name}.`}</${Empty}>
      <${SkeletonFacts} d=${d} /></div>`;
  }
  return html`<div class="stack">
    <div class="cols">
      <${Pnl} title="Rig" meta=${`Tripo ${status?.models?.rig || ''} · spec ${status?.models?.rigSpec || 'mixamo'}`} right=${html`<${StageTag} status=${rst.status} />`}>
        ${rst.status === 'failed' && html`<${Chk} tone="bad"><span>${rst.error}</span></${Chk}>`}
        ${rst.status === 'stale' && html`<${Chk} tone="w"><span>Stale: ${rst.reason}</span></${Chk}>`}
        <dl class="kv"><dt>Riggable</dt><dd>${R.riggable == null ? '—' : R.riggable ? 'yes' : 'no'}${R.rigType ? ' · ' + R.rigType : ''}</dd><dt>Bones</dt><dd>${rep?.bones ?? '—'}</dd>
          <dt>Alignment</dt><dd>${rep?.rig_alignment ? `${rep.rig_alignment.turns_about_y} quarter turns · scale ${(+rep.rig_alignment.scale).toFixed(3)} · mean gap ${(+rep.rig_alignment.mean_gap_cm).toFixed(2)} cm` : '—'}</dd>
          <dt>Unweighted</dt><dd>${rep?.unweighted_vertices ?? '—'} vertices</dd><dt>Merged</dt><dd>${R.at ? fmtTime(R.at) : '—'}</dd></dl>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tripo task</th><th>ID</th><th>Status</th><th class="n">Credits</th><th>Created</th></tr></thead><tbody>
          <${TaskRow} label="rig-check" rec=${R.check} /><${TaskRow} label="rig" rec=${R.rigTask} /></tbody></table></div>
        ${(rep?.warnings || []).map((w) => html`<${Chk} tone="w"><span>${w}</span></${Chk}>`)}
        <div class="row"><${B} label="Re-Rig" paid disabled=${!!whyRig} why=${whyRig} showWhy onClick=${() => rerig(d)} testid="rig-rerig" /></div>
      </${Pnl}>
      <${Pnl} title="Soul Jam skeleton" meta="import onto the game's skeleton" right=${html`<${StageTag} status=${ist.status} />`}>
        ${ist.status === 'failed' && html`<${Chk} tone="bad"><span>${ist.error}</span></${Chk}>`}
        ${ist.status === 'stale' && html`<${Chk} tone="w"><span>Stale: ${ist.reason}</span></${Chk}>`}
        <${SkeletonFacts} d=${d} inline />
        ${r0 ? html`<dl class="kv"><dt>Rig id</dt><dd class="mono">${I.rigId}</dd><dt>Triangles</dt><dd>${fmtNum(r0.triangles)} (LOD0)</dd><dt>Vertices</dt><dd>${fmtNum(r0.vertices)}</dd><dt>Height</dt><dd>${r0.heightM} m · scale ${r0.scale}</dd><dt>Textures</dt><dd>${Array.isArray(r0.textures) ? r0.textures.join(', ') : r0.textures}</dd><dt>Hand vertices</dt><dd>${fmtNum(r0.handVertices)}</dd><dt>On two fingers</dt><dd>${r0.verticesOnTwoFingers ?? '—'} vertices</dd></dl>` : html`<span class="hint">Not imported yet.</span>`}
        ${(I.warnings || []).map((w) => html`<${Chk} tone="w"><span>${w}</span></${Chk}>`)}
        <div class="row"><${B} label="Re-import" disabled=${!!whyImp} why=${whyImp} showWhy onClick=${() => runLocal(d, 'import', 'Re-import onto the Soul Jam skeleton')} testid="rig-reimport" />${d.courtUrl && html`<a class="btn sm" href=${`${base}/court`}>Test on court</a>`}</div>
      </${Pnl}>
    </div>
    ${r0?.segRatio && Object.keys(r0.segRatio).length > 0 && html`<${Pnl} title="Segment ratios" meta="model ÷ game skeleton · expected 0.8–1.25" bodyCls="flush">
      <div class="tbl-wrap"><table class="tbl" data-t="segratio"><thead><tr><th>Segment</th><th class="n">Ratio</th><th>Check</th></tr></thead><tbody>
        ${Object.entries(r0.segRatio).map(([k, v]) => { const bad = v < 0.8 || v > 1.25; return html`<tr class=${bad ? 'warnrow' : ''}><td><b>${k}</b></td><td class="n">${v}</td><td>${bad ? html`<${Tag} tone="yl">outside 0.8–1.25</${Tag}> an auto-rig joint may be misplaced` : html`<${Tag} tone="gr">ok</${Tag}>`}</td></tr>`; })}
      </tbody></table></div>
      ${r0.jointShiftCm?.length > 0 && html`<p class="hint" style="padding:10px 14px">Largest joint shifts (cm): ${r0.jointShiftCm.join(' · ')}</p>`}
    </${Pnl}>`}
    ${rep?.bone_names?.length > 0 && html`<${Pnl} title="Bones" meta=${`${rep.bones} bones in the Tripo rig`}><details class="adv"><summary>Show all ${rep.bone_names.length} bone names</summary><div class="in"><div class="chips">${rep.bone_names.map((b) => html`<span class="tag">${b}</span>`)}</div></div></details></${Pnl}>`}
    ${models.length > 0 && html`<${Viewer} title="Rigged model" badge=${html`<${GameBadge} />`} models=${models} testid="rig-viewer" />`}
  </div>`;
}
function SkeletonFacts({ d, inline }) {
  const body = html`<dl class="kv"><dt>Skeleton</dt><dd class="mono">${SKELETON.name}</dd><dt>Joints</dt><dd>${SKELETON.joints} (MHR)</dd><dt>Bone mapping</dt><dd class="mono">${SKELETON.mapping}</dd><dt>Recorded</dt><dd>${d.manifest.skeletonVersion || 'not imported yet'}</dd></dl>`;
  return inline ? body : html`<${Pnl} title="Soul Jam skeleton">${body}</${Pnl}>`;
}

// ═══ Animation ═══
export function AnimationSection({ d }) {
  const s = useStore();
  const lib = useJson('/api/mocap3d/library');
  const P = d.manifest.stages?.preview || {}, rep = P.report;
  const pst = d.state.stages.preview;
  const why = stageWhy(d, 'preview');
  const base = `/factory/characters/${encodeURIComponent(d.summary.id)}`;
  const L = lib.data;
  const have = new Set((L?.court || []).map((c) => c.role));
  const storage = s.status?.storage;
  const shot = (r) => d.previews[`previews/${r}`];
  return html`<div class="stack">
    <${Pnl} title="Deformation validation" meta=${rep ? `ran ${fmtTime(rep.at)} on the real court` : 'not run yet'} right=${html`<${StageTag} status=${pst.status} />`}>
      ${pst.status === 'failed' && html`<${Chk} tone="bad"><span>${pst.error || pst.reason}</span></${Chk}>`}
      ${rep ? html`
        <div class="row">${rep.allPassed ? html`<span class="pipe ok" data-t="deform-pass"><i></i>All ${rep.results.length} poses passed</span>` : html`<span class="pipe bad" data-t="deform-fail"><i></i>${rep.results.filter((r) => !r.pass).length} of ${rep.results.length} poses failed</span>`}
          ${rep.missingClips?.length > 0 && html`<span class="u">clips not on the court: ${rep.missingClips.join(', ')}</span>`}</div>
        <div class="tbl-wrap"><table class="tbl" data-t="deform-table"><thead><tr><th>Pose</th><th>Result</th><th class="n">Stretched</th><th class="n">Squashed</th><th class="n">Collapsed</th><th class="n">NaN</th><th class="n">Exploding</th><th>Worst near</th></tr></thead><tbody>
          ${rep.results.map((r) => html`<tr class=${r.pass ? '' : 'badrow'}><td><b>${r.pose}</b></td><td>${r.pass ? html`<${Tag} tone="gr">PASS</${Tag}>` : html`<${Tag} tone="rd">FAIL</${Tag}>`}</td><td class="n">${r.stretchedPct}%</td><td class="n">${r.squashedPct}%</td><td class="n">${r.collapsedPct}%</td><td class="n">${r.nan}</td><td class="n">${r.exploding}</td><td class="m">${Object.entries(r.worstNear || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</td></tr>`)}
        </tbody></table></div>
        <span class="u mut">Pass: no NaN / exploding vertices, stretched edges &lt; 0.2 %, squashed &lt; 0.5 %, collapsed triangles &lt; 0.5 % (tools/character_pipeline/deform-test.mjs).</span>
        <div class="gal">${rep.results.filter((r) => shot(r.screenshot)).map((r) => html`<figure class=${r.pass ? 'pass' : 'fail'}><${Img} src=${shot(r.screenshot)} alt=${r.pose} caption=${`${r.pose} · ${r.pass ? 'PASS' : 'FAIL'}`} /><figcaption>${r.pose} · ${r.pass ? 'pass' : 'fail'}</figcaption></figure>`)}</div>
        ${rep.pageErrors?.length > 0 && html`<${Chk} tone="bad"><span>Court page errors during the test: ${rep.pageErrors.join(' | ')}</span></${Chk}>`}`
      : html`<${Empty} title="No deformation report" actions=${html`<${B} label="Run Validation" kind="pri" disabled=${!!why} why=${why} showWhy onClick=${() => runLocal(d, 'preview', 'Run the deformation validation')} testid="anim-validate" />`}>
          The validation poses the character on the real court (A-pose, knee bend, elbows, arms overhead, wrists, hands, and the game's clips) and measures stretched / collapsed geometry. It needs the Soul Jam skeleton import first.</${Empty}>`}
      ${rep && html`<div class="row"><${B} label="Run Validation again" disabled=${!!why} why=${why} showWhy onClick=${() => runLocal(d, 'preview', 'Run the deformation validation')} testid="anim-validate" />${d.courtUrl && html`<a class="btn sm" href=${`${base}/court`}>Play clips on the court</a>`}</div>`}
    </${Pnl}>
    <${Pnl} title="Clip roles" meta="the game's animation roles (/api/mocap3d/library)">
      ${lib.error && !L ? html`<${FetchError} error=${lib.error} onRetry=${lib.reload} what="the clip library" />` : !L ? html`<${Loading} label="Reading the clip library" />` : html`
        ${!L.clips.length && html`<${Chk} tone="w"><span>${storage === false ? 'Clip library unavailable on this machine: storage not configured (FIREBASE_SERVICE_ACCOUNT / R2 in .env).' : 'No clips recorded yet.'} The court and the deformation test use the clips that exist; roles without a clip are skipped.</span>
          <div class="row"><a class="btn sm" href="/mocap">Record on /mocap</a><a class="btn sm" href="/factory/settings">Storage status</a><a class="btn sm" href="/factory/moves">Moves library</a></div></${Chk}>`}
        <div class="tbl-wrap"><table class="tbl" data-t="roles-table"><thead><tr><th>Role</th><th>Label</th><th>Type</th><th>Group</th><th>In game</th><th>Clip</th></tr></thead><tbody>
          ${Object.entries(L.roles).map(([k, r]) => { const c = (L.court || []).find((x) => x.role === k); return html`<tr><td class="m">${k}</td><td>${r.label}${r.required ? html` <${Tag} tone="or">required</${Tag}>` : ''}</td><td class="m">${r.type}</td><td class="m">${r.group}</td><td>${r.runtime ? 'yes' : html`<span class="u mut">not used yet</span>`}</td><td>${c ? html`<${Tag} tone="gr">${c.name || c.id}</${Tag}>` : html`<${Tag} tone="gy">no clip</${Tag}>`}</td></tr>`; })}
        </tbody></table></div>
        <span class="u mut">${have.size} of ${Object.keys(L.roles).length} roles have a clip on the court.</span>`}
    </${Pnl}>
  </div>`;
}

// ═══ LODs ═══
export function LodsSection({ d, status }) {
  const lods = Object.entries(d.lods || {}).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  const measured = d.manifest.stages?.lods?.lods || [];
  const Q = d.quality?.lods || [];
  const lst = d.state.stages.lods;
  const base = `/factory/characters/${encodeURIComponent(d.summary.id)}`;
  const noTripo = !tripoReady(status) ? 'Tripo API key not configured (Settings)' : null;
  if (!lods.length) return html`<div class="stack"><${Empty} dark title="No LODs yet" actions=${html`<${B} label="Run Rigging" kind="pri" paid disabled=${!!(stageWhy(d, 'rig') || noTripo)} why=${stageWhy(d, 'rig') || noTripo} showWhy onClick=${() => rerig(d)} testid="lods-rig" />`}>
      The LOD chain (${Q.map((l) => fmtK(l.tris)).join(' / ')} triangles for ${d.summary.quality} quality) is produced by the rig stage and imported with the character.</${Empty}>
    <${Pnl} title="Targets" meta=${`${d.summary.quality} quality preset`}><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Level</th><th class="n">Target triangles</th><th class="n">Switch distance</th></tr></thead><tbody>${Q.map((l, i) => html`<tr><td>LOD${i}</td><td class="n">${fmtNum(l.tris)}</td><td class="n">${l.dist} m</td></tr>`)}</tbody></table></div></${Pnl}></div>`;
  const models = lods.filter(([, l]) => l.url).map(([k, l]) => ({ key: k, label: k.toUpperCase(), url: l.url, bytes: l.bytes, triangles: l.triangles }));
  return html`<div class="stack">
    <${Pnl} title="Levels of detail" meta=${`${lods.length} levels · ${d.summary.quality}`} right=${html`<${StageTag} status=${lst.status} />`} bodyCls="flush">
      <div class="tbl-wrap"><table class="tbl" data-t="lods-table"><thead><tr><th>Level</th><th class="n">Triangles</th><th class="n">Target</th><th class="n">On the court</th><th class="n">Switch at</th><th>File</th><th class="n">Size</th><th></th></tr></thead><tbody>
        ${lods.map(([k, l], i) => { const m = measured.find((x) => x.level === i); return html`<tr><td><b>${k.toUpperCase()}</b></td><td class="n">${fmtNum(l.triangles)}</td><td class="n">${Q[i] ? fmtNum(Q[i].tris) : '—'}</td><td class="n">${m ? fmtNum(m.tris) : '—'}</td><td class="n">${l.dist} m</td><td class="m">${l.file}</td><td class="n">${fmtBytes(l.bytes)}</td>
          <td><div class="acts"><${B} label="Court check" size="xs" disabled=${!d.courtUrl} why="no court rig yet" onClick=${() => navigate(`${base}/court?lod=${i}`)} testid=${'lod-court-' + i} /></div></td></tr>`; })}
      </tbody></table></div>
      <p class="hint" style="padding:10px 14px">“On the court” is counted from the imported court rig (the LODs stage). Court check opens the court with <code>?lod=N</code>, which forces that level at every distance.</p>
    </${Pnl}>
    ${models.length > 0 ? html`<${Viewer} title="LOD viewer" badge=${html`<${GameBadge} />`} models=${models} testid="lods-viewer" />` : html`<${Empty} dark title="LOD files missing" actions=${html`<${B} label="Re-Rig" paid disabled=${!!(stageWhy(d, 'rig') || noTripo)} why=${stageWhy(d, 'rig') || noTripo} showWhy onClick=${() => rerig(d)} testid="lods-rerig" />`}>The manifest lists LODs but their GLB files are not on disk; the rig stage writes them.</${Empty}>`}
  </div>`;
}
