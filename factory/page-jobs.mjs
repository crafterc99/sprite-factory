/** /factory/jobs and /factory/jobs/:id — every pipeline job (server records, survive restarts). */
import { html, useState, useEffect, useRef } from '/factory/ui/preact-htm.mjs';
import { useJson, useStore, jsend, ask, toast, startJob, loadJobs, setQuery, fmtTime, fmtDur, opLabel, PAID_OPS, HISTORY_NOTE, tripoReady } from '/factory/ui/lib.mjs';
import { Pnl, Empty, Loading, FetchError, JobTag, B, Elapsed, Copy, useTitle } from '/factory/ui/ui.mjs';

const FILTERS = [['all', 'All'], ['active', 'Running'], ['failed', 'Failed'], ['done', 'Done'], ['stopped', 'Cancelled / interrupted']];
const isActive = (j) => j.status === 'running' || j.status === 'queued';

export async function cancelJob(j) {
  const ok = await ask({ title: 'Cancel this job?', tone: 'danger', confirm: 'Cancel job', body: html`<p>Stops the local ${opLabel(j.op)} process for ${j.character}.</p><p><b>A Tripo task that was already submitted keeps running on Tripo and is billed.</b> Resume picks it up later without paying again.</p>` });
  if (!ok) return false;
  try { await jsend('POST', `/api/cf/jobs/${j.id}/cancel`); toast('Job cancelled', { tone: 'ok' }); await loadJobs(); return true; }
  catch (e) { toast(`Cancel failed: ${e.message}`, { tone: 'bad' }); return false; }
}
export async function retryJob(j, status) {
  if (PAID_OPS.has(j.op)) {
    if (!tripoReady(status)) { toast('Tripo API key not configured — see Settings', { tone: 'bad', action: { label: 'Settings', href: '/factory/settings' } }); return null; }
    const ok = await ask({ title: `Retry ${opLabel(j.op)}${j.part ? ' · ' + j.part : ''}?`, tone: 'paid', confirm: 'Retry (may spend credits)', body: html`<p>Starts ${opLabel(j.op).toLowerCase()} again for ${j.character}${j.part ? ` (${j.part})` : ''}.</p><p><b>${j.op === 'generate' ? 'Regenerating spends Tripo credits (new task, new seeds).' : 'May spend Tripo credits.'}</b> ${HISTORY_NOTE}</p>` });
    if (!ok) return null;
  }
  return startJob(j.character, j.op, j.part || undefined);
}
function Actions({ j, status }) {
  const [busy, setBusy] = useState(false);
  const run = async (f) => { setBusy(true); await f(); setBusy(false); };
  return html`<div class="acts">
    ${isActive(j) && html`<${B} label="Cancel" size="xs" kind="danger" busy=${busy} onClick=${() => run(() => cancelJob(j))} testid="job-cancel" />`}
    ${['failed', 'cancelled', 'interrupted'].includes(j.status) && html`<${B} label="Retry" size="xs" paid=${PAID_OPS.has(j.op)} busy=${busy} onClick=${() => run(() => retryJob(j, status))} testid="job-retry" />`}
    <${B} label="Character" size="xs" href=${`/factory/characters/${encodeURIComponent(j.character)}`} testid="job-char" />
    <${B} label="Details" size="xs" kind="ink" href=${`/factory/jobs/${j.id}`} testid="job-open" />
  </div>`;
}

function JobDetail({ id, status }) {
  const [live, setLive] = useState(true);
  const job = useJson(`/api/cf/jobs/${encodeURIComponent(id)}`, { poll: live ? 3000 : 0 });
  const j = job.data;
  useEffect(() => { if (j) setLive(isActive(j)); }, [j?.status]);
  useTitle(j ? `Job ${opLabel(j.op)} · ${j.character}` : 'Job');
  const logRef = useRef();
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [j?.logTail]);
  if (job.status === 404) return html`<${Empty} dark title="No such job" actions=${html`<a class="btn pri" href="/factory/jobs">All jobs</a>`}>Job <code>${id}</code> is not in assets/characters/_jobs.</${Empty}>`;
  if (!j) return job.error ? html`<${FetchError} error=${job.error} onRetry=${job.reload} what="the job" />` : html`<${Loading} label="Loading the job" />`;
  return html`<div class="stack">
    <div class="phead"><div><div class="eyebrow">Job ${j.id}</div><h1>${opLabel(j.op)}${j.part ? ' · ' + j.part : ''}</h1></div><span class="sp"></span><${JobTag} status=${j.status} /></div>
    <div class="cols w2">
      <${Pnl} title="Log" meta=${isActive(j) ? 'refreshing every 3 s' : 'last 120 lines'} right=${html`<button class="btn xs" onClick=${job.reload} data-t="log-refresh">Refresh</button>`}>
        <pre class="log tall" ref=${logRef} data-t="log">${j.logTail || '(no output yet)'}</pre>
      </${Pnl}>
      <${Pnl} title="Record">
        <dl class="kv">
          <dt>Character</dt><dd><a href=${`/factory/characters/${encodeURIComponent(j.character)}`}>${j.character}</a></dd>
          <dt>Operation</dt><dd>${j.op}${j.part ? ' · part ' + j.part : ''}</dd>
          <dt>Status</dt><dd><${JobTag} status=${j.status} /></dd>
          <dt>Stage</dt><dd>${j.stage || '—'}${j.step && j.step !== j.stage ? ' · ' + j.step : ''}</dd>
          <dt>Created</dt><dd>${fmtTime(j.createdAt)}</dd>
          <dt>Started</dt><dd>${fmtTime(j.startedAt)}</dd>
          <dt>Ended</dt><dd>${fmtTime(j.endedAt)}</dd>
          <dt>Duration</dt><dd>${j.startedAt ? html`<${Elapsed} since=${j.startedAt} until=${j.endedAt} />` : '—'}</dd>
          <dt>Credits</dt><dd>${j.credits != null ? j.credits : '—'}</dd>
          <dt>Process</dt><dd class="mono">${j.pid || '—'}</dd>
          <dt>Command</dt><dd><${Copy} text=${`node tools/character_pipeline/cli.mjs ${(j.args || []).join(' ')}`} /></dd>
          <dt>Log file</dt><dd class="mono">${j.log}</dd>
        </dl>
        ${j.error && html`<div class="chk bad"><b>✕</b><div class="body"><span>${j.error}</span></div></div>`}
        ${j.note && html`<div class="chk w"><b>!</b><div class="body"><span>${j.note}</span></div></div>`}
        <${Actions} j=${j} status=${status} />
      </${Pnl}>
    </div>
    <div><a class="link" style="color:rgba(238,233,217,.7)" href="/factory/jobs">← All jobs</a></div>
  </div>`;
}

export function JobsPage({ job, q }) {
  useTitle(job ? 'Job' : 'Jobs');
  const s = useStore();
  const f = q.get('status') || 'all', ch = q.get('character') || '';
  if (job) return html`<div class="wrap"><${JobDetail} id=${job} status=${s.status} /></div>`;
  const jobs = s.jobs;
  const chars = [...new Set((jobs || []).map((j) => j.character))].sort();
  const shown = (jobs || []).filter((j) => (f === 'all' ? true : f === 'active' ? isActive(j) : f === 'stopped' ? ['cancelled', 'interrupted'].includes(j.status) : j.status === f)).filter((j) => !ch || j.character === ch);
  return html`<div class="wrap">
    <div class="phead"><div><div class="eyebrow">Character Factory</div><h1>Jobs</h1><p class="lead">Every pipeline run started from the factory: server records in assets/characters/_jobs, kept across restarts. A running record whose process died reads as interrupted.</p></div>
      <span class="sp"></span><button class="btn sm" onClick=${loadJobs} data-t="jobs-refresh">Refresh</button></div>
    ${s.jobsError && !jobs ? html`<${FetchError} error=${s.jobsError} onRetry=${loadJobs} what="the jobs" />` : !jobs ? html`<${Loading} label="Loading jobs" />` : !jobs.length
      ? html`<${Empty} dark title="No jobs yet" actions=${html`<a class="btn pri" href="/factory">Open Characters</a><a class="btn" href="/factory/create">Create a character</a>`}>Jobs appear here when a build, a stage re-run or a validation is started from the factory.</${Empty}>`
      : html`
      <div class="row">
        <div class="subtabs sm">${FILTERS.map(([k, l]) => html`<button class=${f === k ? 'on' : ''} onClick=${() => setQuery({ status: k === 'all' ? null : k })} data-t=${'jf-' + k}>${l} ${k === 'all' ? jobs.length : ''}</button>`)}</div>
        <span class="sp"></span>
        <select class="inp sm" style="max-width:240px" value=${ch} onChange=${(e) => setQuery({ character: e.target.value || null })} aria-label="Character" data-t="jobs-character"><option value="">All characters</option>${chars.map((c) => html`<option value=${c}>${c}</option>`)}</select>
      </div>
      <${Pnl} title=${`${shown.length} job${shown.length === 1 ? '' : 's'}`} meta=${s.jobs.some(isActive) ? 'refreshing every 3 s' : 'refreshing every 15 s'} bodyCls="flush">
        ${!shown.length ? html`<div style="padding:14px"><${Empty} title="No job matches" actions=${html`<button class="btn" onClick=${() => setQuery({ status: null, character: null })}>Show all jobs</button>`}>Nothing with this filter.</${Empty}></div>` : html`
        <div class="tbl-wrap"><table class="tbl" data-t="jobs-table"><thead><tr><th>Character</th><th>Operation</th><th>Part</th><th>Status</th><th>Stage</th><th>Started</th><th class="n">Duration</th><th class="n">Credits</th><th class="n">Actions</th></tr></thead><tbody>
          ${shown.map((j) => html`<tr key=${j.id} class=${j.status === 'failed' ? 'badrow' : ''}>
            <td><a href=${`/factory/characters/${encodeURIComponent(j.character)}`}><b>${j.character}</b></a><br /><a class="mono" style="font-size:11px" href=${`/factory/jobs/${j.id}`}>${j.id}</a></td>
            <td>${opLabel(j.op)}</td><td class="m">${j.part || '—'}</td><td><${JobTag} status=${j.status} />${j.error && html`<div class="mono" style="font-size:11px;max-width:320px;color:#8c1d2c" title=${j.error}>${j.error.split('\n')[0].slice(0, 110)}</div>`}</td>
            <td class="m">${j.stage || '—'}</td><td class="m">${fmtTime(j.startedAt || j.createdAt)}</td>
            <td class="n">${isActive(j) && j.startedAt ? html`<${Elapsed} since=${j.startedAt} />` : fmtDur(j.durationSec)}</td><td class="n">${j.credits ?? '—'}</td>
            <td><${Actions} j=${j} status=${s.status} /></td></tr>`)}
        </tbody></table></div>`}
      </${Pnl}>`}
  </div>`;
}
