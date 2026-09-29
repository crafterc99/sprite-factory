/**
 * /factory/create — wizard: 1 Identity → 2 References → 3 Multiview check → 4 Review & start.
 * The character exists from step 1 on (POST /api/cf/characters); the URL carries ?id=&step= so a
 * refresh or a shared link returns to the same step.
 */
import { html, useState, useEffect } from '/factory/ui/preact-htm.mjs';
import { useJson, useStore, jsend, jget, navigate, setQuery, toast, bump, ask, startJob, busyOf, tripoReady, fmtNum, fmtK, partLabel, CORE_PARTS, HISTORY_NOTE, creditHistory } from '/factory/ui/lib.mjs';
import { Chk, B, Loading, FetchError, Tag, useTitle } from '/factory/ui/ui.mjs';
import { useUploads, DropZone, UploadRows, RefCards, MultiviewPanels, ValidationList, partRefs } from '/factory/ui/sec-references.mjs';

const STEPS = ['Identity', 'References', 'Multiview check', 'Review & start'];
const ID_RE = /^[a-z0-9_-]{2,40}$/;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
const ftIn = (m) => { const i = Math.round(m / 0.0254); return `${Math.floor(i / 12)}′${i % 12}″`; };

function Identity({ d, status, onDone }) {
  const sm = d?.summary;
  const [name, setName] = useState(sm?.name || '');
  const [id, setId] = useState('');
  const [h, setH] = useState(sm?.heightMeters ? String(sm.heightMeters) : '');
  const [notes, setNotes] = useState(sm?.notes || '');
  const [quality, setQ] = useState(sm?.quality || 'hero');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const Q = status?.quality || {};
  const hv = h === '' ? null : +h;
  const hBad = hv != null && (Number.isNaN(hv) || hv < 1.2 || hv > 2.4);
  const idBad = id && !ID_RE.test(id);
  const can = name.trim() && !hBad && !idBad && !busy;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (sm) { await jsend('PATCH', `/api/cf/characters/${sm.id}`, { name: name.trim(), notes, heightMeters: hv, quality }); onDone(sm.id); }
      else { const c = await jsend('POST', '/api/cf/characters', { name: name.trim(), id: id || undefined, heightMeters: hv || undefined, notes, quality, style: 'soul-jam-illustrated' }); toast(`Created ${c.id}`, { tone: 'ok' }); bump(); onDone(c.id); }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return html`<div><div class="eyebrow">Step 1 of 4${sm ? ' · ' + sm.id : ''}</div><h1>Who is it?</h1></div>
    <div class="fgrid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)">
      <label><span class="lbl">Name</span><input class="inp big-inp" value=${name} maxlength="60" placeholder="Main Guy" onInput=${(e) => setName(e.target.value)} data-t="f-name" /></label>
      <label><span class="lbl">ID ${sm ? '(fixed)' : '(optional)'}</span><input class="inp big-inp" style="font-family:var(--font-mono);font-size:18px" value=${sm ? sm.id : id} disabled=${!!sm} placeholder=${name ? slug(name) + '_001' : 'auto from name'} onInput=${(e) => setId(e.target.value.toLowerCase())} data-t="f-id" />
        <div class="field-note">${sm ? 'folder assets/characters/' + sm.id : idBad ? '2–40 of a–z, 0–9, _ or -' : id ? 'folder assets/characters/' + id : 'the server picks the first free <name>_NNN'}</div></label>
    </div>
    <div class="fgrid">
      <label><span class="lbl">Height (metres)</span><input class="inp" type="number" min="1.2" max="2.4" step="0.01" value=${h} placeholder="1.93 (default)" onInput=${(e) => setH(e.target.value)} data-t="f-height" />
        <div class="field-note">${hBad ? 'between 1.2 and 2.4 m' : hv ? ftIn(hv) + ' · the body master is scaled to this' : 'empty: the pipeline uses 1.93 m'}</div></label>
      <div><span class="lbl">Style</span><div class="inp" style="display:flex;align-items:center">Soul Jam illustrated</div><div class="field-note">the pipeline's one style (soul-jam-illustrated)</div></div>
    </div>
    <label><span class="lbl">Notes</span><textarea class="inp" maxlength="2000" placeholder="Anything the next person should know about this character" value=${notes} onInput=${(e) => setNotes(e.target.value)} data-t="f-notes"></textarea></label>
    <div><span class="lbl">Quality</span>
      <div class="tiles">${['hero', 'standard', 'draft'].map((k) => { const q = Q[k]; return html`<button class=${'tl' + (quality === k ? ' on' : '')} onClick=${() => setQ(k)} data-t=${'q-' + k}>
        <span class="tn">${k}</span>
        ${q ? html`<span class="tm">LOD0 ${fmtK(q.lods[0].tris)} tris · ${q.lods.length} LODs<br />textures ${q.texSize}px · bake ${q.bakeSize}px<br />${q.lods.map((l) => fmtK(l.tris)).join(' / ')}</span>` : html`<span class="td">loading presets…</span>`}
      </button>`; })}</div>
    </div>
    ${err && html`<${Chk} tone="bad"><span>${err}</span></${Chk}>`}
    <div class="nav"><a class="link" href="/factory">Cancel</a><span class="sp"></span><${B} label=${sm ? 'Save & continue →' : 'Create character →'} kind="pri" size="lg" disabled=${!can} why=${!name.trim() ? 'a name is required' : hBad ? 'height out of range' : idBad ? 'invalid id' : null} busy=${busy} onClick=${submit} testid="wz-create" /></div>`;
}

function ReviewStep({ d, status, go }) {
  const sm = d.summary, v = d.manifest.validation;
  const busy = busyOf(d);
  const parts = Object.keys(d.state.parts || {});
  const [hist, setHist] = useState(null);
  // real credit history: this factory's generate tasks (from each character's credit log)
  useEffect(() => { (async () => {
    try {
      const { characters } = await jget('/api/cf/characters');
      const logs = [];
      for (const c of characters.filter((x) => x.credits > 0).slice(0, 8)) { try { const x = await jget(`/api/cf/characters/${c.id}`); logs.push(...(x.manifest.credits?.log || [])); } catch {} }
      setHist(creditHistory(logs) || false);
    } catch { setHist(false); }
  })(); }, []);
  const blocked = v && !v.ok ? 'validation is blocked: ' + v.blocking.join('; ') : !d.references.length ? 'no references yet' : null;
  const startWhy = busy || blocked || (!tripoReady(status) ? 'Tripo API key not configured' : null);
  const bal = status?.tripo;
  const start = async () => {
    const ok = await ask({ title: 'Start the build?', tone: 'paid', confirm: 'Start build (spends credits)', body: html`
      <p>Runs every stage for <b>${sm.id}</b>: generate ${parts.map(partLabel).join(', ')} on Tripo, assemble, game mesh + bake, rig (Tripo), Soul Jam skeleton, LODs, validation, court test.</p>
      <p><b>Spends Tripo credits</b> — one high-detail task per part plus rig-check and rig. ${HISTORY_NOTE}</p>
      <p class="u">Balance ${bal?.balance != null ? fmtNum(bal.balance) : '—'} credits · the build stops before a task once this character has spent ${fmtNum(status?.limits?.maxCreditsPerCharacter)} credits.</p>` });
    if (!ok) return;
    const j = await startJob(sm.id, 'build');
    if (j) navigate(`/factory/characters/${sm.id}`);
  };
  return html`<div><div class="eyebrow">Step 4 of 4 · ${sm.id}</div><h1>Review & start</h1></div>
    <div class="kpis">
      <div class="kpi"><div class="v">${sm.name}</div><div class="k">name</div></div>
      <div class="kpi"><div class="v">${sm.quality}</div><div class="k">quality · LOD0 ${fmtK(d.quality.lods[0].tris)} tris</div></div>
      <div class="kpi"><div class="v">${sm.heightMeters ? sm.heightMeters + ' m' : '1.93 m'}</div><div class="k">height${sm.heightMeters ? '' : ' (default)'}</div></div>
      <div class="kpi"><div class="v">${d.references.length}</div><div class="k">references</div></div>
    </div>
    <div class="sec">Parts to generate</div>
    ${parts.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Part</th><th>Views</th><th>Status</th><th>Credits</th></tr></thead><tbody>
      ${parts.map((p) => { const vs = [...new Set(partRefs(d, p).map((r) => r.view))]; const st = d.state.parts[p]; return html`<tr><td><b>${partLabel(p)}</b></td><td class="m">${vs.join(', ') || '—'}</td><td><${Tag} tone=${st.status === 'done' ? 'gr' : st.status === 'failed' ? 'rd' : ''}>${st.status}</${Tag}></td><td class="m">${st.status === 'done' ? (st.credits ?? '?') + ' spent' : 'reported by Tripo after the task'}</td></tr>`; })}
    </tbody></table></div>` : html`<${Chk} tone="bad"><span>No parts: add references first.</span><div class="row"><button class="btn sm" onClick=${() => go(2)}>Add references</button></div></${Chk}>`}
    ${!parts.includes('head') && parts.length > 0 && html`<${Chk} tone="info"><span>No head references: the body master's own head is kept (no high-detail head donor).</span><div class="row"><button class="btn xs" onClick=${() => go(3)} data-t="wz-add-head">Add Head Views</button></div></${Chk}>`}
    <div class="sec">Cost</div>
    <div class="summary"><span class="d">${parts.length}</span><span class="u">Tripo generation tasks</span><span style="flex:1"></span><span class="u">+ rig-check + rig</span></div>
    <div class="note"><span class="k">From history</span>${HISTORY_NOTE}${hist ? ` This factory has recorded ${hist.n} generate task${hist.n > 1 ? 's' : ''}: ${hist.min === hist.max ? hist.min : `${hist.min}–${hist.max}`} credits each.` : ''} The exact cost is not known before a task runs.</div>
    <div class="kpis dense">
      <div class=${'kpi' + (bal && !bal.configured ? ' bad' : '')}><div class="v">${bal ? (bal.configured ? (bal.balance != null ? fmtNum(bal.balance) : 'error') : 'not set') : '…'}</div><div class="k">Tripo balance</div></div>
      <div class="kpi"><div class="v">${fmtNum(status?.limits?.maxCreditsPerCharacter)}</div><div class="k">credit limit / character</div></div>
      <div class="kpi"><div class="v">${fmtNum(sm.credits)}</div><div class="k">spent on ${sm.id}</div></div>
      <div class="kpi"><div class="v">${status?.limits?.tripoConcurrency ?? '—'}</div><div class="k">parts in parallel</div></div>
    </div>
    ${v && html`<${ValidationList} d=${d} />`}
    ${!tripoReady(status) && html`<${Chk} tone="bad"><span>Tripo is not configured on this server, so the build cannot start.</span><div class="row"><a class="btn sm pri" href="/factory/settings" data-t="configure-tripo">Configure Tripo</a></div></${Chk}>`}
    <div class="nav">
      <button class="link" onClick=${() => go(3)}>← Back</button><span class="sp"></span>
      <${B} label="Save as draft" size="lg" onClick=${() => { toast(`${sm.id} saved as a draft — nothing was generated`, { tone: 'ok' }); navigate(`/factory/characters/${sm.id}`); }} testid="wz-draft" />
      <${B} label="Start build →" kind="pri" size="lg" paid disabled=${!!startWhy} why=${startWhy} showWhy onClick=${start} testid="wz-start" />
    </div>`;
}

export function CreatePage({ q }) {
  useTitle('Create character');
  const s = useStore();
  const id = q.get('id');
  const step = Math.max(1, Math.min(4, +(q.get('step') || (id ? 2 : 1))));
  const det = useJson(id ? `/api/cf/characters/${encodeURIComponent(id)}` : null, { poll: 0, deps: [s.tick] });
  const d = det.data;
  const [orig, setOrig] = useState(false);
  const up = useUploads(id, () => det.reload());
  const go = (n) => setQuery({ step: n }, { replace: false });
  const busy = busyOf(d);
  let body;
  if (step > 1 && !id) body = html`<${Chk} tone="bad"><span>Start with step 1: the character has to exist before references can be added.</span><div class="row"><a class="btn sm" href="/factory/create">Step 1</a></div></${Chk}>`;
  else if (id && det.status === 404) body = html`<${Chk} tone="bad"><span>No character <code>${id}</code> (deleted?).</span><div class="row"><a class="btn sm pri" href="/factory/create">Start a new character</a></div></${Chk}>`;
  else if (id && !d) body = det.error ? html`<${FetchError} error=${det.error} onRetry=${det.reload} what="the character" />` : html`<${Loading} label="Loading the character" />`;
  else if (step === 1) body = html`<${Identity} key=${id || 'new'} d=${d} status=${s.status} onDone=${(nid) => navigate(`/factory/create?id=${encodeURIComponent(nid)}&step=2`)} />`;
  else if (step === 2) body = html`<div><div class="eyebrow">Step 2 of 4 · ${id}</div><h1>References</h1></div>
    <p class="lead">Drop every reference you have. Each image is uploaded, classified (part + view) and cleaned on the server one at a time; correct anything the classifier got wrong on the card.</p>
    <${DropZone} up=${up} busy=${busy} />
    <${UploadRows} up=${up} />
    ${d.references.length > 0 && html`<div class="row"><span class="sec" style="flex:1">${d.references.length} references</span><div class="subtabs sm"><button class=${!orig ? 'on' : ''} onClick=${() => setOrig(false)}>Cleaned</button><button class=${orig ? 'on' : ''} onClick=${() => setOrig(true)}>Original</button></div></div>
      <${RefCards} d=${d} up=${up} busy=${busy} orig=${orig} onChanged=${det.reload} />`}
    <div class="nav"><button class="link" onClick=${() => go(1)}>← Back</button><span class="sp"></span>${up.active && html`<span class="u">uploads in progress…</span>`}<${B} label="Check multiview →" kind="pri" size="lg" disabled=${up.active} why="wait for the uploads to finish" onClick=${() => go(3)} testid="wz-next-3" /></div>`;
  else if (step === 3) body = html`<div><div class="eyebrow">Step 3 of 4 · ${id}</div><h1>Multiview check</h1></div>
    <p class="lead">Body and head take front / left / back / right; each hand takes the back of the hand, the palm and both sides. Two or more views of a part → Tripo multiview; one view → single-image generation (the unseen sides are inferred).</p>
    <${ValidationList} d=${d} busy=${busy} />
    <${MultiviewPanels} d=${d} up=${up} busy=${busy} orig=${false} onChanged=${det.reload} />
    <${UploadRows} up=${up} />
    <div class="nav"><button class="link" onClick=${() => go(2)}>← Back</button><span class="sp"></span><${B} label="Review →" kind="pri" size="lg" disabled=${up.active} why="wait for the uploads to finish" onClick=${() => go(4)} testid="wz-next-4" /></div>`;
  else body = html`<${ReviewStep} d=${d} status=${s.status} go=${go} />`;
  const reach = (i) => i + 1 <= 1 || !!id;
  return html`<div class="wrap"><div class="wz">
    <div class="prog">${STEPS.map((t, i) => html`<button class=${'pg' + (i + 1 < step ? ' done' : i + 1 === step ? ' on' : '')} disabled=${!reach(i)} title=${reach(i) ? '' : 'create the character first'} onClick=${() => go(i + 1)} data-t=${'prog-' + (i + 1)}><i></i><span>${i + 1} · ${t}</span></button>`)}</div>
    <div class="card" key=${step}>${body}</div>
  </div></div>`;
}
