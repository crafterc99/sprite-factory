/**
 * /factory/characters/:id/:section — header, sub-nav, live job bar and the Overview section.
 * The detail (GET /api/cf/characters/:id) is polled every 3 s while a job or pipeline process runs.
 */
import { html, useState, useEffect } from '/factory/ui/preact-htm.mjs';
import { useJson, useStore, jget, jsend, ask, toast, startJob, busyOf, tripoReady, navigate, fmtNum, fmtDur, fmtTime, fmtAgo, fmtK, firstLine, opLabel, partLabel, STAGES, STAGE_LABEL, STAGE_OP, PAID_STAGES, HISTORY_NOTE, fileUrl } from '/factory/ui/lib.mjs';
import { Pnl, Kpi, Empty, Loading, FetchError, Pipe, StageTag, JobTag, Tag, B, Menu, Elapsed, Img, Chk, Copy, useTitle } from '/factory/ui/ui.mjs';
import { resumeCharacter, regenerate, rerig, runLocal } from '/factory/ui/actions.mjs';
import { ReferencesSection } from '/factory/ui/sec-references.mjs';
import { PartsSection, AssemblySection } from '/factory/ui/sec-parts.mjs';
import { RigSection, AnimationSection, LodsSection } from '/factory/ui/sec-rig.mjs';
import { AppearanceSection } from '/factory/ui/sec-appearance.mjs';
import { CourtSection } from '/factory/ui/sec-court.mjs';

export const SECTIONS = [['overview', 'Overview'], ['references', 'References'], ['parts', 'Parts'], ['assembly', 'Assembly'], ['rig', 'Rig'], ['animation', 'Animation'], ['appearance', 'Appearance'], ['lods', 'LODs'], ['court', 'Court Test']];
const RESUMABLE = ['ready', 'failed', 'stale', 'partial'];
const tone = (st) => ({ done: 'ok', running: 'run', failed: 'bad', stale: 'warn', partial: 'warn' }[st] || '');

// ═══ header / job bar ═══
function JobBar({ d, reload }) {
  const j = d.summary.job;
  const job = useJson(j ? `/api/cf/jobs/${j.id}` : null, { poll: j ? 3000 : 0 });
  const [busy, setBusy] = useState(false);
  const runSt = STAGES.find((s) => d.state.stages[s].status === 'running');
  if (!j && !runSt) return null;
  if (!j) {
    const rec = d.manifest.stages?.[runSt] || {};
    return html`<div class="jobbar" data-t="jobbar"><span class="d">${STAGE_LABEL[runSt]}</span><${Tag} tone="run">running</${Tag}>
      <span class="u">pipeline process started outside the factory UI (CLI) · started ${fmtTime(rec.startedAt)} · <${Elapsed} since=${rec.startedAt} /></span><span class="sp"></span>
      <span class="u">no job record — cancel it where it was started</span></div>`;
  }
  const J = job.data || j;
  const cancel = async () => {
    const ok = await ask({ title: 'Cancel this job?', tone: 'danger', confirm: 'Cancel job', body: html`<p>Stops the local ${opLabel(J.op)} process for ${d.summary.id}.</p><p><b>A Tripo task that was already submitted keeps running on Tripo and is billed.</b> The next Resume picks it up without paying again.</p>` });
    if (!ok) return;
    setBusy(true);
    try { await jsend('POST', `/api/cf/jobs/${J.id}/cancel`); toast('Job cancelled', { tone: 'ok' }); reload(); } catch (e) { toast(`Cancel failed: ${e.message}`, { tone: 'bad' }); }
    setBusy(false);
  };
  const part = runSt === 'generate' ? Object.entries(d.state.parts).filter(([, p]) => p.status === 'running').map(([k, p]) => `${partLabel(k)}: ${p.phase || 'queued'}`).join(' · ') : null;
  return html`<div class="jobbar" data-t="jobbar">
    <span class="d">${opLabel(J.op)}${J.part ? ' · ' + J.part : ''}</span><${JobTag} status=${J.status} />
    <span class="u">${J.stage ? 'stage ' + STAGE_LABEL[J.stage] : 'starting'}${part ? ' · ' + part : ''} · started ${fmtTime(J.startedAt || J.createdAt)} · <${Elapsed} since=${J.startedAt || J.createdAt} /></span>
    <span class="sp"></span>
    <a class="btn sm" href=${`/factory/jobs/${J.id}`} data-t="jobbar-open">Job detail</a>
    <${B} label="Cancel" kind="danger" busy=${busy} onClick=${cancel} testid="jobbar-cancel" />
    ${J.logTail && html`<pre class="log">${J.logTail.split('\n').slice(-6).join('\n')}</pre>`}
  </div>`;
}

function Head({ d }) {
  const sm = d.summary;
  return html`<div class="chead">
    <div class="av">${sm.thumbnail && html`<img src=${sm.thumbnail} alt="" />`}</div>
    <div class="nm"><span class="u">${sm.id} · ${sm.quality} quality${sm.heightMeters ? ' · ' + sm.heightMeters + ' m' : ''}</span><span class="d">${sm.name}</span></div>
    <span class="sp"></span>
    <div class="facts">
      <${Pipe} status=${sm.status} text=${sm.statusText} />
      ${sm.status === 'GAME_READY' ? html`<span class="pipe gr" data-t="game-ready">Game Ready</span>` : html`<span class="tag">not game ready</span>`}
      <span class="tag">${fmtNum(sm.credits)} credits</span>
      <span class="tag" title=${sm.updatedAt}>updated ${fmtAgo(sm.updatedAt)}</span>
    </div>
  </div>`;
}
function SubNav({ d, section }) {
  const st = d.state.stages, v = d.manifest.validation;
  const dot = { overview: tone(st.courttest.status === 'done' ? 'done' : busyOf(d) ? 'running' : ''), references: v ? (v.ok ? (v.warnings.length > 1 ? 'warn' : 'ok') : 'bad') : '', parts: tone(st.generate.status), assembly: tone(st.assemble.status), rig: tone(st.rig.status === 'done' ? st.import.status : st.rig.status), animation: tone(st.preview.status), appearance: '', lods: tone(st.lods.status), court: tone(st.courttest.status) };
  return html`<nav class="subnav" aria-label="Character sections">${SECTIONS.map(([k, l]) => html`<a class=${section === k ? 'on' : ''} href=${`/factory/characters/${encodeURIComponent(d.summary.id)}/${k}`} data-t=${'sec-' + k}>${l}${dot[k] && html`<span class=${'dt ' + dot[k]}></span>`}</a>`)}</nav>`;
}

// ═══ Overview ═══
function heroImages(d) {
  const P = d.previews, out = [];
  const add = (k, cap) => { if (P[k]) out.push({ src: P[k], cap }); };
  add('previews/in-game-front.png', 'In game · court');
  add('previews/compare-source-vs-game.png', 'Tripo source vs in game');
  for (const v of ['front', 'three_quarter', 'side', 'back', 'face', 'neck_seam', 'hand_left', 'hand_right']) add(`previews/assembled/${v}.png`, `Assembled · ${v.replace('_', ' ')}`);
  if (d.generation.body?.renderUrl) out.push({ src: d.generation.body.renderUrl, cap: 'Tripo render · body' });
  const ref = d.references.find((r) => r.part === 'body');
  if (ref) out.push({ src: ref.cleanedUrl, cap: `Reference · body ${ref.view}` });
  return out;
}
function Hero({ d }) {
  const imgs = heroImages(d);
  const [i, setI] = useState(0);
  const cur = imgs[Math.min(i, imgs.length - 1)];
  if (!cur) return html`<${Empty} title="No preview yet" actions=${html`<a class="btn pri" href=${`/factory/characters/${d.summary.id}/references`}>Add references</a>`}>Previews appear after assembly (renders) and after the deformation validation (in-game).</${Empty}>`;
  return html`<div class="hero">
    <div class="main"><${Img} src=${cur.src} alt=${cur.cap} caption=${cur.cap} /><span class="cap">${cur.cap}</span></div>
    <div class="strip">${imgs.map((x, k) => html`<button class=${k === i ? 'on' : ''} onClick=${() => setI(k)} title=${x.cap} data-t="hero-thumb"><img src=${x.src} alt="" loading="lazy" /><span>${x.cap}</span></button>`)}</div>
  </div>`;
}

function Pipeline({ d }) {
  const st = d.state.stages, M = d.manifest.stages || {};
  return html`<div class="stages" data-t="pipeline">${STAGES.map((k, i) => {
    const s = st[k], rec = M[k] || {};
    const secs = s.seconds ?? rec.seconds;
    return html`<div key=${k} class=${'stg ' + s.status}>
      <span class="n">${String(i + 1).padStart(2, '0')}</span>
      <span class="nm">${STAGE_LABEL[k]}<small>${k}${PAID_STAGES.has(k) ? ' · Tripo credits' : ''}</small></span>
      <span><${StageTag} status=${s.status} /></span>
      <span class="rs">${s.status === 'failed' ? html`<span class="err">${firstLine(s.reason || s.error)}</span>` : s.reason || (s.status === 'running' && rec.startedAt ? html`running · <${Elapsed} since=${rec.startedAt} />` : '')}${s.error && s.status !== 'failed' && s.status !== 'done' ? html` <span class="err">· previous run failed: ${firstLine(s.error)}</span>` : ''}</span>
      <span class="tm">${secs != null && s.status !== 'running' ? fmtDur(secs) : ''}${s.finishedAt && s.status !== 'running' ? html`<br />${fmtTime(s.finishedAt)}` : ''}</span>
    </div>
    ${k === 'generate' && Object.entries(s.parts || {}).map(([p, ps]) => html`<div key=${p} class=${'stg sub ' + ps.status}>
      <span class="nm">${partLabel(p)}</span><span><${StageTag} status=${ps.status} /></span>
      <span class="rs">${ps.phase ? 'phase ' + ps.phase + ' · ' : ''}${ps.reason || ps.error || (ps.task ? 'task ' + ps.task.slice(0, 8) : '')}</span>
      <span class="tm">${ps.credits != null ? ps.credits + ' cr' : ''}${ps.finishedAt ? html`<br />${fmtTime(ps.finishedAt)}` : ''}</span>
    </div>`)}`;
  })}</div>`;
}

function ErrorItem({ d, e, current, jobs, status }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const logRel = (/\(log: ([^)]+\.log)\)/.exec(e.error || '') || [])[1];
  const rel = logRel && logRel.includes(`/assets/characters/${d.summary.id}/`) ? logRel.split(`/assets/characters/${d.summary.id}/`)[1] : null;
  const job = (jobs || []).filter((j) => j.character === d.summary.id && j.status === 'failed' && (j.error || '').startsWith(e.stage)).sort((a, b) => Math.abs(Date.parse(a.endedAt) - Date.parse(e.at)) - Math.abs(Date.parse(b.endedAt) - Date.parse(e.at)))[0];
  const matchJob = job && Math.abs(Date.parse(job.endedAt) - Date.parse(e.at)) < 120000 ? job : null;
  useEffect(() => { if (!open || detail) return; (async () => {
    const out = {};
    if (matchJob) { try { out.jobTail = (await jget(`/api/cf/jobs/${matchJob.id}`)).logTail; } catch (x) { out.jobTail = 'could not read the job log: ' + x.message; } }
    if (rel) { try { const r = await fetch(fileUrl(d.summary.id, rel)); out.log = r.ok ? (await r.text()).split('\n').filter((l) => l.trim()).slice(-60).join('\n') : `${rel}: ${r.status}`; } catch (x) { out.log = x.message; } }
    setDetail(out);
  })(); }, [open]);
  const stageSt = d.state.stages[e.stage]?.status;
  const op = e.stage === 'generate' ? 'generate' : e.stage === 'ingest' || e.stage === 'validate' ? 'validate' : STAGE_OP[e.stage];
  const busy = busyOf(d);
  const credits = e.creditsSpentInJob != null ? (e.creditsSpentInJob > 0 ? `${e.creditsSpentInJob} Tripo credits were spent in that job before it failed` : 'no Tripo credits were spent in that job') : 'credit use was not recorded for this error (older pipeline version)';
  const retry = async () => {
    if (e.stage === 'generate') { const parts = e.part || Object.entries(d.state.parts).filter(([, p]) => p.status === 'failed').map(([k]) => k).join(','); if (parts) return regenerate(d, parts); return resumeCharacter(d.summary, status); }
    if (op === 'rig') return rerig(d);
    return runLocal(d, op, `Retry ${STAGE_LABEL[e.stage]}`);
  };
  return html`<div class=${'erri' + (current ? '' : ' res')} data-t="error-item">
    <div class="eh"><span class="d">${STAGE_LABEL[e.stage] || e.stage}${e.part ? ' · ' + e.part : ''}</span>
      ${current ? html`<${Tag} tone="rd">current</${Tag}>` : stageSt === 'running' ? html`<${Tag} tone="run">retrying now</${Tag}>` : html`<${Tag} tone="gy">${stageSt === 'done' ? 'resolved since' : 'earlier attempt'}</${Tag}>`}
      <span class="sp"></span><span class="u">${fmtTime(e.at)} · ${fmtAgo(e.at)}</span></div>
    <div class="em">${firstLine(e.error) || '(no message)'}</div>
    <div class="ef">
      <span class="u">${credits}</span><span style="flex:1"></span>
      ${current && op && html`<${B} label=${`Retry ${STAGE_LABEL[e.stage]}`} paid=${PAID_STAGES.has(e.stage)} disabled=${!!busy} why=${busy} onClick=${retry} testid="error-retry" />`}
      <button class="btn xs" onClick=${() => setOpen(!open)} data-t="error-detail">${open ? 'Hide' : 'Technical detail'}</button>
    </div>
    ${open && html`<div style="padding:0 12px 12px;display:flex;flex-direction:column;gap:8px">
      <pre class="log">${e.error}</pre>
      ${!detail ? html`<${Loading} label="Reading logs" />` : html`
        ${detail.jobTail != null && html`<span class="lbl">Job ${matchJob.id} · log tail</span><pre class="log">${detail.jobTail || '(empty)'}</pre>`}
        ${detail.log != null && html`<span class="lbl">${rel} · last lines <a href=${fileUrl(d.summary.id, rel)} target="_blank" rel="noopener">open full log</a></span><pre class="log">${detail.log}</pre>`}
        ${detail.jobTail == null && detail.log == null && html`<span class="u mut">No job record or log file is linked to this error.</span>`}`}
    </div>`}
  </div>`;
}

function Overview({ d, status, jobs }) {
  const sm = d.summary, M = d.manifest, st = d.state.stages;
  const busy = busyOf(d);
  const base = `/factory/characters/${encodeURIComponent(sm.id)}`;
  const partsHave = Object.keys(d.state.parts || {});
  const noTripo = !tripoReady(status) ? 'Tripo API key not configured (Settings)' : null;
  const next = d.state.next;
  const resumeWhy = busy || (!next ? 'every stage is done' : !RESUMABLE.includes(st[next].status) ? `${STAGE_LABEL[next]} is ${st[next].status}` : noTripo);
  const why = (stage) => busy || (st[stage].status === 'blocked' ? `blocked until ${STAGE_LABEL[STAGES[STAGES.indexOf(stage) - 1]]} is done` : null);
  const buildSecs = Object.values(M.stages || {}).reduce((a, s) => a + (s.status === 'done' && s.seconds ? s.seconds : 0), 0);
  const errors = [...(M.errors || [])].reverse();
  const latestByStage = {};
  for (const e of errors) if (!latestByStage[e.stage]) latestByStage[e.stage] = e;
  const isCurrent = (e) => latestByStage[e.stage] === e && st[e.stage]?.status === 'failed';
  const warnings = [
    ...(M.validation?.warnings || []).map((w) => ['References', w, `${base}/references`]),
    ...(M.stages?.assemble?.report?.warnings || []).map((w) => ['Assembly', w, `${base}/assembly`]),
    ...(M.stages?.gamemesh?.report?.warnings || []).map((w) => ['Game mesh', w, null]),
    ...(M.stages?.rig?.report?.warnings || []).map((w) => ['Rig', w, `${base}/rig`]),
    ...(M.stages?.import?.warnings || []).map((w) => ['Skeleton import', w, `${base}/rig`]),
    ...(M.warnings || []).map((w) => ['Pipeline', typeof w === 'string' ? w : JSON.stringify(w), null]),
  ];
  const regenItems = [...partsHave.map((p) => ({ label: partLabel(p), meta: d.generation[p]?.task?.credits != null ? `last ${d.generation[p].task.credits} cr` : 'not generated', onClick: () => regenerate(d, p) })),
    ...(partsHave.includes('hand_left') && partsHave.includes('hand_right') ? [{ label: 'Both hands', meta: 'hand_left + hand_right', onClick: () => regenerate(d, 'hand_left,hand_right') }] : [])];
  return html`<div class="stack">
    <div class="cols w2">
      <${Hero} d=${d} />
      <div class="stack">
        <${Pnl} title="Status" meta=${sm.statusText}>
          <div class="row"><${Pipe} status=${sm.status} text=${sm.statusText} />${sm.status === 'GAME_READY' ? html`<span class="pipe gr">Game Ready</span>` : html`<span class="u">${next ? `next: ${STAGE_LABEL[next]} (${st[next].status})` : ''}</span>`}</div>
          ${busy && html`<${Chk} tone="info" icon="…"><span>${busy}. Actions that start a job wait until it ends.</span></${Chk}>`}
          <div class="kpis dense">
            <${Kpi} v=${fmtNum(sm.credits)} k="credits spent" x=${`limit ${fmtNum(status?.limits?.maxCreditsPerCharacter)}`} />
            <${Kpi} v=${buildSecs ? fmtDur(buildSecs) : '—'} k="build time" x="sum of finished stages" />
            <${Kpi} v=${sm.triangles ? fmtK(sm.triangles) : '—'} k="game triangles" />
            <${Kpi} v=${Object.keys(d.lods || {}).length || '—'} k="LODs" />
          </div>
        </${Pnl}>
        <${Pnl} title="Actions" meta="cr = spends Tripo credits (asks first)">
          <div class="alist" data-t="overview-actions">
            ${[
              [html`<${B} label="Resume" kind="pri" paid disabled=${!!resumeWhy} why=${resumeWhy} onClick=${() => resumeCharacter(sm, status)} testid="ov-resume" />`, next ? `Continue from ${STAGE_LABEL[next]} through the remaining stages.` : 'Every stage is done.', resumeWhy],
              [html`<${B} label="Edit References" href=${`${base}/references`} testid="ov-refs" />`, `Add, reclassify or delete reference images (${d.references.length} now).`, null],
              [html`<${Menu} label="Regenerate Part" paid items=${regenItems} disabled=${!!(busy || noTripo || !regenItems.length)} why=${busy || noTripo || 'no parts with references'} testid="ov-regen" />`, 'New Tripo task with new seeds for one part; downstream stages turn stale.', busy || noTripo || (!regenItems.length ? 'no parts with references' : null)],
              [html`<${B} label="Rebuild Game Mesh" disabled=${!!why('gamemesh')} why=${why('gamemesh')} onClick=${() => runLocal(d, 'gamemesh', 'Rebuild the game mesh')} testid="ov-gamemesh" />`, `Blender: welded ${fmtK(d.quality.lods[0].tris)}-triangle game surface + ${d.quality.bakeSize}px texture bake (local).`, why('gamemesh')],
              [html`<${B} label="Re-Rig" paid disabled=${!!(why('rig') || noTripo)} why=${why('rig') || noTripo} onClick=${() => rerig(d)} testid="ov-rerig" />`, 'Tripo rig-check + rig, merged onto the LOD chain.', why('rig') || noTripo],
              [html`<${B} label="Run Validation" disabled=${!!why('preview')} why=${why('preview')} onClick=${() => runLocal(d, 'preview', 'Run the deformation validation')} testid="ov-validate" />`, 'Deformation poses + previews on the real court (local).', why('preview')],
              [html`<${B} label="Test On Court" href=${`${base}/court`} disabled=${!d.courtUrl} why="no court rig yet — the Soul Jam skeleton import makes one" testid="ov-court" />`, 'Open this character on the Soul Jam court.', d.courtUrl ? null : 'no court rig yet — the Soul Jam skeleton import makes one'],
            ].map(([btn, desc, no]) => html`<div class="ai">${btn}<span class="at">${desc}${no && html`<span class="no">${no}</span>`}</span></div>`)}
          </div>
        </${Pnl}>
      </div>
    </div>
    <${Pnl} title="Pipeline" meta=${`${STAGES.filter((k) => st[k].status === 'done').length}/${STAGES.length} stages done`} bodyCls="flush"><${Pipeline} d=${d} /></${Pnl}>
    ${errors.length > 0 && html`<${Pnl} title="Errors" meta=${`${errors.filter(isCurrent).length} current · ${errors.length} recorded`}><div class="errs">${errors.map((e, i) => html`<${ErrorItem} key=${i} d=${d} e=${e} current=${isCurrent(e)} jobs=${jobs} status=${status} />`)}</div></${Pnl}>`}
    ${warnings.length > 0 && html`<${Pnl} title="Warnings" meta=${`${warnings.length} from validation and stage reports`}><div class="checks">${warnings.map(([src, w, href]) => html`<${Chk} tone="w"><span><b>${src}</b> · ${w}</span>${href && html`<div class="row"><a class="link" href=${href}>Open ${src}</a></div>`}</${Chk}>`)}</div></${Pnl}>`}
    <div class="cols">
      <${Pnl} title="Credits" meta=${`${fmtNum(M.credits?.spent || 0)} spent on ${sm.id}`}>
        ${M.credits?.log?.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>What</th><th>Tripo task</th><th class="n">Credits</th><th>When</th></tr></thead><tbody>
          ${M.credits.log.map((l) => html`<tr><td>${l.what}</td><td class="m"><${Copy} text=${l.taskId} label=${l.taskId?.slice(0, 8)} /></td><td class="n">${l.credits}</td><td class="m">${fmtTime(l.at)}</td></tr>`)}
        </tbody></table></div>` : html`<span class="hint">No Tripo credits spent on this character yet.</span>`}
      </${Pnl}>
      <${Pnl} title="Versions" meta="snapshots taken after each Soul Jam skeleton import">
        ${M.versions?.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>v</th><th>Note</th><th class="n">Triangles</th><th>Sources</th><th>When</th></tr></thead><tbody>
          ${[...M.versions].reverse().map((v) => html`<tr><td><b>v${v.v}</b></td><td>${v.note}</td><td class="n">${fmtNum(v.triangles)}</td><td class="m">${Object.entries(v.sources || {}).map(([p, t]) => `${p} ${String(t || '—').slice(0, 8)}`).join(' · ')}</td><td class="m">${fmtTime(v.at)}</td></tr>`)}
        </tbody></table></div>` : html`<${Empty} title="No versions yet" actions=${html`<${B} label="Resume the pipeline" kind="pri" paid disabled=${!!resumeWhy} why=${resumeWhy} onClick=${() => resumeCharacter(sm, status)} testid="ov-resume-2" />`}>A version is saved each time the character is imported onto the Soul Jam skeleton.</${Empty}>`}
      </${Pnl}>
    </div>
    ${sm.notes && html`<${Pnl} title="Notes"><p class="hint" style="white-space:pre-wrap">${sm.notes}</p></${Pnl}>`}
  </div>`;
}

export function CharacterPage({ id, section, q }) {
  const s = useStore();
  const [live, setLive] = useState(false);
  const det = useJson(`/api/cf/characters/${encodeURIComponent(id)}`, { poll: live ? 3000 : 0, deps: [s.tick] });
  const d = det.data;
  const busy = busyOf(d);
  useEffect(() => setLive(!!busy), [!!busy]);
  useTitle(d ? `${d.summary.name} · ${(SECTIONS.find(([k]) => k === section) || [, section])[1]}` : id);
  if (det.status === 404) return html`<div class="wrap"><div class="nf"><${Empty} dark title="No such character" actions=${html`<a class="btn pri" href="/factory">All characters</a><a class="btn" href="/factory/create">Create a character</a>`}><code>${id}</code> does not exist (or was deleted).</${Empty}></div></div>`;
  if (!d) return html`<div class="wrap">${det.error ? html`<${FetchError} error=${det.error} onRetry=${det.reload} what=${id} />` : html`<${Loading} label=${'Loading ' + id} />`}</div>`;
  if (!SECTIONS.find(([k]) => k === section)) return html`<div class="wrap"><${Head} d=${d} /><${SubNav} d=${d} section=${section} /><${Empty} dark title="No such section" actions=${html`<a class="btn pri" href=${`/factory/characters/${id}`}>Overview</a>`}><code>${section}</code> is not a character section.</${Empty}></div>`;
  const props = { d, reload: det.reload, status: s.status, q };
  const body = section === 'overview' ? html`<${Overview} ...${props} jobs=${s.jobs} />`
    : section === 'references' ? html`<${ReferencesSection} ...${props} />`
      : section === 'parts' ? html`<${PartsSection} ...${props} />`
        : section === 'assembly' ? html`<${AssemblySection} ...${props} />`
          : section === 'rig' ? html`<${RigSection} ...${props} />`
            : section === 'animation' ? html`<${AnimationSection} ...${props} />`
              : section === 'appearance' ? html`<${AppearanceSection} ...${props} />`
                : section === 'lods' ? html`<${LodsSection} ...${props} />`
                  : html`<${CourtSection} ...${props} />`;
  return html`<div class="wrap">
    <${Head} d=${d} />
    <${SubNav} d=${d} section=${section} />
    <${JobBar} d=${d} reload=${det.reload} />
    ${det.error && html`<${Chk} tone="w"><span>Showing the last data: refresh failed (${det.error}).</span></${Chk}>`}
    <div key=${section} class="fade">${body}</div>
  </div>`;
}
