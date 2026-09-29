/** /factory — dashboard numbers (GET /api/cf/summary) + the character library (GET /api/cf/characters). */
import { html, useState, useEffect } from '/factory/ui/preact-htm.mjs';
import { useJson, useStore, useNow, jsend, ask, toast, bump, navigate, startJob, fmtNum, fmtK, fmtDur, fmtAgo, STAGES, STAGE_LABEL, PAID_STAGES, tripoReady } from '/factory/ui/lib.mjs';
import { Pnl, Kpi, Empty, Loading, FetchError, Pipe, StageTag, B, useTitle } from '/factory/ui/ui.mjs';
import { resumeCharacter } from '/factory/ui/actions.mjs';

const RESUMABLE = ['ready', 'failed', 'stale', 'partial'];
const FILTERS = [['all', 'All'], ['ready', 'Game ready'], ['progress', 'In progress'], ['failed', 'Failed'], ['draft', 'Drafts']];

export function busyOfSummary(c) {
  if (c.job) return `a ${c.job.op} job is ${c.job.status}`;
  if (c.runningStage) return `a pipeline process is running ${STAGE_LABEL[c.runningStage]}`;
  return null;
}
function CharCard({ c, status, onChanged }) {
  const busy = busyOfSummary(c);
  const [act, setAct] = useState(null);
  const base = `/factory/characters/${encodeURIComponent(c.id)}`;
  const preview = c.models?.game ? `${base}/appearance` : c.models?.assembled ? `${base}/assembly` : c.models?.source ? `${base}/parts` : null;
  const resumeWhy = busy || (!c.stage ? 'every stage is done' : !RESUMABLE.includes(c.stageStatus) ? `${STAGE_LABEL[c.stage]} is ${c.stageStatus}` : !tripoReady(status) ? 'Tripo API key not configured (Settings)' : null);
  const dup = async () => {
    setAct('dup');
    try { const n = await jsend('POST', `/api/cf/characters/${encodeURIComponent(c.id)}/duplicate`); toast(`Duplicated as ${n.id} (references copied, nothing generated)`, { tone: 'ok', action: { label: 'Open', href: `/factory/characters/${n.id}` } }); onChanged(); }
    catch (e) { toast(`Duplicate failed: ${e.message}`, { tone: 'bad' }); }
    setAct(null);
  };
  const del = async () => {
    const ok = await ask({ title: `Delete ${c.name}?`, tone: 'danger', typed: c.id, confirm: 'Delete forever',
      body: html`<p>Removes <code>assets/characters/${c.id}</code> — references, Tripo sources, assembled and game meshes, rig, previews — and its court rig. Credits already spent are not refunded. This cannot be undone.</p>` });
    if (!ok) return;
    setAct('del');
    try { await jsend('DELETE', `/api/cf/characters/${encodeURIComponent(c.id)}?confirm=${encodeURIComponent(c.id)}`); toast(`Deleted ${c.id}`, { tone: 'ok' }); onChanged(); }
    catch (e) { toast(`Delete failed: ${e.message}`, { tone: 'bad' }); }
    setAct(null);
  };
  return html`<article class="ccard" data-t=${'card-' + c.id}>
    <a class="thumb" href=${base} aria-label=${'Open ' + c.name}>
      ${c.thumbnail ? html`<img src=${c.thumbnail} alt="" loading="lazy" />` : html`<span class="none">No preview yet</span>`}
      <${Pipe} status=${c.status} text=${c.statusText} />
      ${busy && html`<span class="jobstrip"><i></i>${busy}</span>`}
    </a>
    <div class="cb">
      <div><a class="cn" href=${base}>${c.name}</a><div class="cid">${c.id} · ${c.quality} quality${c.heightMeters ? ` · ${c.heightMeters} m` : ''}</div></div>
      <div class="cstage">${c.stage ? html`<span>Next: <b>${STAGE_LABEL[c.stage]}</b></span><${StageTag} status=${c.stageStatus} />` : html`<span>All stages done</span>`}</div>
      <div class="cmeta">
        <div><div class="v">${c.triangles ? fmtK(c.triangles) : '—'}</div><div class="k">game tris</div></div>
        <div><div class="v">${c.rigStatus}</div><div class="k">rig</div></div>
        <div><div class="v">${c.lods ? c.lods + ' LOD' + (c.lods > 1 ? 's' : '') : c.lodStatus}</div><div class="k">LODs</div></div>
        <div><div class="v">${fmtNum(c.credits)}</div><div class="k">credits</div></div>
        <div><div class="v">${c.rigId ? 'yes' : 'no'}</div><div class="k">on court</div></div>
        <div><div class="v" title=${c.updatedAt}>${fmtAgo(c.updatedAt)}</div><div class="k">updated</div></div>
      </div>
    </div>
    <div class="cact">
      <${B} label="Open" kind="ink" href=${base} testid="card-open" />
      <${B} label="Resume" kind="pri" paid disabled=${!!resumeWhy} why=${resumeWhy} busy=${act === 'resume'} testid="card-resume" onClick=${async () => { setAct('resume'); await resumeCharacter(c, status); setAct(null); onChanged(); }} />
      <${B} label="Preview" href=${preview} disabled=${!preview} why="nothing generated yet — no 3D model to show" testid="card-preview" />
      <${B} label="Duplicate" busy=${act === 'dup'} onClick=${dup} testid="card-duplicate" title="New character with the same reference images (nothing generated)" />
      <${B} label="Delete" disabled=${!!busy} why=${busy} busy=${act === 'del'} onClick=${del} testid="card-delete" />
    </div>
  </article>`;
}

export function CharactersPage() {
  useTitle('Characters');
  const s = useStore();
  // every 3 s while a job or pipeline process runs on any character, otherwise on demand / when a job ends
  const [live, setLive] = useState(false);
  const list = useJson('/api/cf/characters', { poll: live ? 3000 : 0, deps: [s.tick] });
  const sum = useJson('/api/cf/summary', { poll: live ? 3000 : 0, deps: [s.tick] });
  const chars = list.data?.characters || [];
  const running = chars.some((c) => c.job || c.runningStage);
  useEffect(() => setLive(running), [running]);
  const [f, setF] = useState('all');
  const [qtext, setQ] = useState('');
  useNow(30000);
  const reload = () => { list.reload(); sum.reload(); bump(); };
  const shown = chars.filter((c) => (f === 'all' ? true : f === 'ready' ? c.status === 'GAME_READY' : f === 'failed' ? c.status === 'FAILED' : f === 'draft' ? ['DRAFT', 'REFERENCES_INCOMPLETE'].includes(c.status) : !['GAME_READY', 'FAILED', 'DRAFT', 'REFERENCES_INCOMPLETE'].includes(c.status)))
    .filter((c) => !qtext || (c.name + ' ' + c.id).toLowerCase().includes(qtext.toLowerCase()));
  const S = sum.data;
  const bal = s.status?.tripo;
  return html`<div class="wrap">
    <div class="phead">
      <div><div class="eyebrow">Character Factory</div><h1>Characters</h1><p class="lead">Reference images in, game-ready rigged characters out. Every number here is read from the pipeline's manifests and job records.</p></div>
      <span class="sp"></span>
      <a class="btn pri lg" href="/factory/create" data-t="create-cta">Create Character</a>
    </div>
    <${Pnl} title="Factory" meta="live from /api/cf/summary" right=${html`<button class="btn xs" onClick=${reload} data-t="dash-refresh">Refresh</button>`}>
      ${sum.error && !S ? html`<${FetchError} error=${sum.error} onRetry=${sum.reload} what="the dashboard" />` : !S ? html`<${Loading} label="Reading the manifests" />` : html`<div class="kpis" data-t="kpis">
        <${Kpi} v=${S.characters} k="characters" />
        <${Kpi} v=${S.gameReady} k="game ready" cls=${S.gameReady ? 'good' : ''} />
        <${Kpi} v=${S.processing} k="processing (jobs)" cls=${S.processing ? 'hot' : ''} />
        <${Kpi} v=${S.failed} k="failed" cls=${S.failed ? 'bad' : ''} />
        <${Kpi} v=${fmtNum(S.credits)} k="Tripo credits spent" x=${S.estimatedUsd != null ? `≈ $${S.estimatedUsd} estimated` : 'USD rate not set'} />
        <${Kpi} v=${S.jobsRunning} k="jobs running" cls=${S.jobsRunning ? 'hot' : ''} />
        <${Kpi} v=${S.averageBuildSeconds != null ? fmtDur(S.averageBuildSeconds) : '—'} k="average build time" x=${`${S.buildsMeasured} build${S.buildsMeasured === 1 ? '' : 's'} measured`} />
        <${Kpi} v=${bal ? (bal.configured ? (bal.balance != null ? fmtNum(bal.balance) : 'error') : 'off') : '…'} k="Tripo balance" x=${bal?.configured ? (bal.error ? bal.error.slice(0, 40) : 'credits available') : 'key not configured'} cls=${bal && !bal.configured ? 'bad' : ''} />
      </div>`}
    </${Pnl}>
    ${list.error && !list.data ? html`<${FetchError} error=${list.error} onRetry=${list.reload} what="the characters" />`
      : !list.data ? html`<${Loading} label="Loading characters" />`
        : !chars.length ? html`<${Empty} dark title="No characters yet" actions=${html`<a class="btn pri lg" href="/factory/create" data-t="empty-create">Create First Character</a>`}>A character starts from reference images of the body (and optionally head and hands). The factory classifies them, generates high-detail Tripo sources, assembles, bakes, rigs and tests them on the court.</${Empty}>`
          : html`
      <div class="row">
        <div class="subtabs sm" role="tablist">${FILTERS.map(([k, l]) => html`<button class=${f === k ? 'on' : ''} onClick=${() => setF(k)} data-t=${'filter-' + k}>${l}</button>`)}</div>
        <span class="sp"></span>
        <input class="inp sm" style="max-width:260px" placeholder="Search name or id" value=${qtext} onInput=${(e) => setQ(e.target.value)} aria-label="Search characters" data-t="search" />
      </div>
      ${!shown.length ? html`<${Empty} dark title="No match" actions=${html`<button class="btn" onClick=${() => { setF('all'); setQ(''); }}>Show all characters</button>`}>No character matches this filter.</${Empty}>` : html`
      <div class="libgrid">
        ${shown.map((c) => html`<${CharCard} key=${c.id} c=${c} status=${s.status} onChanged=${reload} />`)}
        <a class="ccard new" href="/factory/create"><span class="d">+ New character</span><span class="u mut">Create</span></a>
      </div>`}`}
  </div>`;
}
