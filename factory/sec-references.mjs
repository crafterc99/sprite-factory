/**
 * References: uploads (one by one, real byte progress, then the server's classification), the
 * multiview slots per part, reclassify / delete, and the validation list. Used by the Create wizard
 * (steps 2–3) and the character's References section.
 */
import { html, useState, useRef, useEffect } from '/factory/ui/preact-htm.mjs';
import { uploadReference, jsend, ask, toast, bump, startJob, useNow, fmtBytes, fmtDur, CORE_PARTS, OPTIONAL_PARTS, SLOTS, slotOf, partLabel, PART_OPTIONS, viewOptionsFor, busyOf } from '/factory/ui/lib.mjs';
import { Pnl, Chk, B, Empty, Img, Tag } from '/factory/ui/ui.mjs';

const ACCEPT = 'image/png,image/jpeg,image/webp';
const OK_TYPE = /^image\/(png|jpeg|webp)$/;

// ═══ uploads ═══
let rowId = 0;
/** Sequential upload queue: one image at a time, each classified by the server before the next. */
export function useUploads(id, onDone) {
  const [rows, setRows] = useState([]);
  const q = useRef([]), running = useRef(false), done = useRef(onDone);
  done.current = onDone;
  const patch = (rid, p) => setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...p } : r)));
  async function pump() {
    if (running.current) return;
    running.current = true;
    while (q.current.length) {
      const r = q.current.shift();
      if (!OK_TYPE.test(r.file.type)) { patch(r.rid, { st: 'error', error: `${r.file.type || 'unknown type'}: images only (PNG, JPEG, WebP)` }); continue; }
      if (r.file.size > 20 * 1048576) { patch(r.rid, { st: 'error', error: `${fmtBytes(r.file.size)} is over the 20 MB limit` }); continue; }
      patch(r.rid, { st: 'uploading', loaded: 0 });
      try {
        const res = await uploadReference(id, r.file, { part: r.part, view: r.view, onProgress: (l, t, fin) => patch(r.rid, fin ? { st: 'classifying', loaded: t, at: Date.now() } : { loaded: l }) });
        patch(r.rid, { st: 'done', res, doneAt: Date.now() });
      } catch (e) { patch(r.rid, { st: 'error', error: e.message }); }
      done.current && done.current();
    }
    running.current = false;
  }
  const add = (files, { part, view } = {}) => {
    const list = [...files].map((file) => ({ rid: ++rowId, file, part, view, st: 'queued', loaded: 0, thumb: URL.createObjectURL(file) }));
    if (!list.length) return;
    q.current.push(...list);
    setRows((rs) => [...list.reverse(), ...rs].slice(0, 40));
    pump();
  };
  const clear = () => setRows((rs) => rs.filter((r) => ['queued', 'uploading', 'classifying'].includes(r.st)));
  return { rows, add, clear, active: rows.some((r) => ['queued', 'uploading', 'classifying'].includes(r.st)) };
}

function UploadRow({ r }) {
  const now = useNow(1000, r.st === 'classifying');
  const refs = r.res?.references || [];
  return html`<div class=${'upr' + (r.st === 'error' ? ' err' : r.st === 'done' ? ' ok' : '')} data-t="upload-row">
    <div class="th"><img src=${refs[0]?.cleanedUrl || r.thumb} alt="" /></div>
    <div>
      <div class="fn">${r.file.name} <span class="u mut">${fmtBytes(r.file.size)}${r.part ? ` · into ${partLabel(r.part)}${r.view ? ' / ' + r.view : ''}` : ''}</span></div>
      ${r.st === 'queued' && html`<div class="st">waiting for the previous image</div>`}
      ${r.st === 'uploading' && html`<div class="st">uploading ${fmtBytes(r.loaded)} of ${fmtBytes(r.file.size)}</div><div class="bytes"><i style=${{ width: Math.round((100 * r.loaded) / (r.file.size || 1)) + '%' }}></i></div>`}
      ${r.st === 'classifying' && html`<div class="st">uploaded · the server is classifying and cleaning it (${fmtDur((now - r.at) / 1000)})</div>`}
      ${r.st === 'error' && html`<div class="st"><b>Not added:</b> ${r.error}</div>`}
      ${r.st === 'done' && (refs.length ? refs.map((x) => html`<div class="st">→ <b>${partLabel(x.part)} / ${x.view}</b> · ${x.source}, ${x.confidence} confidence · crop ${x.cropWidth}×${x.cropHeight}${x.upscaled > 1 ? ` · upscaled ×${x.upscaled}` : ''}</div>`)
        : html`<div class="st">saved, but no reference came out of it (no subject found?) — check the validation list</div>`)}
    </div>
    <div>${r.st === 'done' ? html`<${Tag} tone="gr">added</${Tag}>` : r.st === 'error' ? html`<${Tag} tone="rd">error</${Tag}>` : html`<${Tag} tone="run">${r.st}</${Tag}>`}</div>
  </div>`;
}
export function UploadRows({ up }) {
  if (!up.rows.length) return null;
  return html`<div class="stack" data-t="upload-rows">
    <div class="row"><span class="sec" style="flex:1">Uploads this session</span>${!up.active && html`<button class="link" onClick=${up.clear}>clear list</button>`}</div>
    <div class="uprows">${up.rows.map((r) => html`<${UploadRow} key=${r.rid} r=${r} />`)}</div>
  </div>`;
}

/** Drop zone + file browser. */
export function DropZone({ up, busy, part, view, title = 'Drop reference images', sub, small = false, testid = 'dropzone' }) {
  const [over, setOver] = useState(false);
  const inp = useRef();
  const disabled = !!busy;
  return html`<div class=${'drop' + (small ? ' sm' : '') + (over ? ' over' : '') + (disabled ? ' dis' : '')} data-t=${testid}
      onDragOver=${(e) => { if (disabled) return; e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); if (!disabled) up.add(e.dataTransfer.files, { part, view }); }}>
    <span class="d">${title}</span>
    ${sub && html`<span class="hint">${sub}</span>`}
    <input type="file" accept=${ACCEPT} multiple ref=${inp} style="display:none" onChange=${(e) => { up.add(e.target.files, { part, view }); e.target.value = ''; }} data-t="file-input" />
    <${B} label="Choose images" kind="pri" size="" disabled=${disabled} why=${busy} showWhy onClick=${() => inp.current.click()} testid="choose-images" />
    <span class="u mut">PNG · JPEG · WebP · up to 20 MB each · uploaded one at a time</span>
  </div>`;
}

// ═══ slot state (display of API data) ═══
function refIssues(d, r) {
  const v = d.manifest.validation || { warnings: [], blocking: [] };
  const w = (v.warnings || []).filter((x) => x.startsWith(r.name + ':'));
  const b = (v.blocking || []).filter((x) => x.includes(r.name));
  if (r.part === 'unknown') b.push('part not recognised — set the part');
  if (r.confidence === 'low' && !w.some((x) => /low confidence/.test(x))) w.push('classified with low confidence');
  return { w, b, state: b.length ? 'invalid' : w.length ? 'warning' : 'ready' };
}
export function partRefs(d, part) { return d.references.filter((r) => r.part === part); }
/** First reference per slot (the one generation uses) + the rest. */
export function slotted(d, part) {
  const map = {}, rest = [];
  for (const r of partRefs(d, part)) { const s = slotOf(part, r.view); if (s && !map[s]) map[s] = r; else rest.push(r); }
  return { map, rest };
}

// ═══ reclassify / delete ═══
function RefEditor({ d, r, onClose, onChanged }) {
  const sheet = d.references.filter((x) => x.name === r.name).length > 1;
  const [part, setPart] = useState(sheet ? 'hands' : r.part);
  const [view, setView] = useState(slotOf(r.part.startsWith('hand') ? 'hand_x' : r.part, r.view) || r.view);
  const [busy, setBusy] = useState(false);
  const views = viewOptionsFor(part);
  useEffect(() => { if (!views.find(([v]) => v === view)) setView(views[0][0]); }, [part]);
  const save = async () => {
    setBusy(true);
    try {
      const res = await jsend('PATCH', `/api/cf/characters/${encodeURIComponent(d.summary.id)}/references/${encodeURIComponent(r.name)}`, { part, view });
      const out = (res.references || []).map((x) => `${partLabel(x.part)} / ${x.view}`).join(', ');
      toast(`${r.name} → ${out || 'no reference produced'} (re-ingested)`, { tone: 'ok' });
      onClose(); onChanged();
    } catch (e) { toast(`Reclassify failed: ${e.message}`, { tone: 'bad' }); }
    setBusy(false);
  };
  return html`<div class="edit" data-t="ref-editor" onClick=${(e) => e.stopPropagation()}>
    <span class="lbl" style="margin:0">Reclassify ${r.name}</span>
    ${sheet && html`<span class="why">This image is a two-hand sheet: the change applies to the whole image (both hands).</span>`}
    <label><span class="lbl">Part</span><select class="inp sm" value=${part} onChange=${(e) => setPart(e.target.value)} data-t="edit-part">${PART_OPTIONS.map((p) => html`<option value=${p}>${partLabel(p)}</option>`)}</select></label>
    <label><span class="lbl">View</span><select class="inp sm" value=${view} onChange=${(e) => setView(e.target.value)} data-t="edit-view">${views.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
    <div class="row"><button class="btn xs pri" disabled=${busy} onClick=${save} data-t="edit-save">${busy ? 'Saving…' : 'Save'}</button><button class="btn xs" onClick=${onClose} data-t="edit-cancel">Cancel</button></div>
  </div>`;
}
export async function deleteRef(d, r, onChanged) {
  const from = d.references.filter((x) => x.name === r.name);
  const ok = await ask({ title: 'Delete reference image?', tone: 'danger', confirm: 'Delete image',
    body: html`<p>Removes the uploaded original <code>${r.name}</code> and re-runs ingest.${from.length > 1 ? html` It produced ${from.length} references (${from.map((x) => `${partLabel(x.part)} / ${x.view}`).join(', ')}) — all of them go.` : ''}</p><p>Sources already generated from it stay, but turn stale (their references changed).</p>` });
  if (!ok) return;
  try { await jsend('DELETE', `/api/cf/characters/${encodeURIComponent(d.summary.id)}/references/${encodeURIComponent(r.name)}`); toast(`Deleted ${r.name}`, { tone: 'ok' }); onChanged(); }
  catch (e) { toast(`Delete failed: ${e.message}`, { tone: 'bad' }); }
}

/** One slot (or one extra reference) card. */
function Slot({ d, part, slot, r, up, busy, orig, onChanged, label, sub }) {
  const [edit, setEdit] = useState(false);
  const [over, setOver] = useState(false);
  const inp = useRef();
  const is = r && refIssues(d, r);
  const state = r ? is.state : 'missing';
  const drop = (e) => { e.preventDefault(); setOver(false); if (!busy) up.add(e.dataTransfer.files, { part, view: slot }); };
  return html`<div class=${'mvs ' + state + (over ? ' over' : '')} data-t=${`slot-${part}-${slot || r?.view}`}
      onDragOver=${(e) => { if (!busy && !r) { e.preventDefault(); setOver(true); } }} onDragLeave=${() => setOver(false)} onDrop=${r ? undefined : drop}>
    <div class="sh"><span class="d">${label}</span>${sub && html`<span class="u">${sub}</span>`}<span class="sp"></span>
      ${state === 'missing' ? html`<${Tag} tone="gy">missing</${Tag}>` : state === 'ready' ? html`<${Tag} tone="gr">ready</${Tag}>` : state === 'warning' ? html`<${Tag} tone="yl">warning</${Tag}>` : html`<${Tag} tone="rd">invalid</${Tag}>`}
    </div>
    <div class="im">
      ${r ? html`<${Img} src=${orig ? r.originalUrl : r.cleanedUrl} alt=${`${part} ${r.view}`} caption=${`${partLabel(part)} · ${r.view} · ${orig ? 'original ' + r.name : 'cleaned crop'}`} />`
        : html`<div class="miss"><span>no ${label.toLowerCase()} view</span>
            <input type="file" accept=${ACCEPT} ref=${inp} style="display:none" onChange=${(e) => { up.add(e.target.files, { part, view: slot }); e.target.value = ''; }} data-t=${`slot-file-${part}-${slot}`} />
            <${B} label="Upload" disabled=${!!busy} why=${busy} onClick=${() => inp.current.click()} testid=${`upload-${part}-${slot}`} />
            <span>or drop an image here</span></div>`}
    </div>
    ${r && html`<div class="ft">
      <span class="m">${r.name}${r.view !== slot && slot ? ` · view ${r.view}` : ''} · ${r.source}, ${r.confidence}<br />crop ${r.cropWidth}×${r.cropHeight}${r.upscaled > 1 ? ` · upscaled ×${r.upscaled}` : ''}</span>
      ${[...is.b, ...is.w].map((x) => html`<span class="m" style=${{ color: is.b.includes(x) ? '#8c1d2c' : '#7a4a00' }}>${x.replace(r.name + ': ', '')}</span>`)}
      <div class="row">
        <${B} label="Reclassify" size="xs" disabled=${!!busy} why=${busy} onClick=${() => setEdit(!edit)} testid="reclassify" />
        <${B} label="Delete" size="xs" disabled=${!!busy} why=${busy} onClick=${() => deleteRef(d, r, onChanged)} testid="ref-delete" />
      </div>
    </div>`}
    ${edit && r && html`<${RefEditor} d=${d} r=${r} onClose=${() => setEdit(false)} onChanged=${onChanged} />`}
  </div>`;
}

function partState(d, part) {
  const refs = partRefs(d, part);
  const v = d.manifest.validation || { warnings: [], blocking: [] };
  const blocked = (v.blocking || []).some((b) => b.includes(part) || (part === 'body' && /body/.test(b)));
  if (!refs.length) return part === 'body' ? ['BLOCKED', 'rd'] : ['MISSING', 'gy'];
  if (blocked || refs.some((r) => refIssues(d, r).state === 'invalid')) return ['BLOCKED', 'rd'];
  if (refs.some((r) => refIssues(d, r).state === 'warning') || (v.warnings || []).some((w) => w.startsWith(part + ':'))) return ['WARNING', 'yl'];
  return ['READY', 'gr'];
}

/** BODY / HEAD / HANDS multiview panels, optional parts and unassigned images. */
export function MultiviewPanels({ d, up, busy, orig, onChanged }) {
  const fileFor = useRef();
  const [target, setTarget] = useState(null);
  const pick = (part) => { setTarget(part); setTimeout(() => fileFor.current.click(), 0); };
  const extras = OPTIONAL_PARTS.filter((p) => partRefs(d, p).length);
  const unknown = partRefs(d, 'unknown');
  return html`<div class="stack">
    <input type="file" accept=${ACCEPT} multiple ref=${fileFor} style="display:none" onChange=${(e) => { up.add(e.target.files, { part: target }); e.target.value = ''; }} />
    ${CORE_PARTS.map((part) => {
      const { map, rest } = slotted(d, part);
      const [st, tone] = partState(d, part);
      const n = Object.keys(map).length;
      const gen = d.state?.parts?.[part];
      return html`<${Pnl} key=${part} id=${'refs-' + part} title=${partLabel(part)} meta=${`${n}/4 views${gen ? ' · source ' + gen.status : ''}`} right=${html`<${Tag} tone=${tone}>${st}</${Tag}>`}>
        ${!partRefs(d, part).length && html`<${Chk} tone=${part === 'body' ? 'bad' : 'info'}>
          <span>${part === 'body' ? 'No full-body reference: the body master cannot be generated.' : `No ${partLabel(part).toLowerCase()} references: the body master's own ${partLabel(part).toLowerCase()} is used (no high-detail donor).`}</span>
          <div class="row"><${B} label=${part === 'head' ? 'Add Head Views' : part === 'body' ? 'Add Body Views' : `Add ${partLabel(part)} Views`} kind="pri" disabled=${!!busy} why=${busy} onClick=${() => pick(part)} testid=${'add-' + part} /></div>
        </${Chk}>`}
        <div class="slot4">${SLOTS[part].map(([slot, label, sub]) => html`<${Slot} key=${slot} d=${d} part=${part} slot=${slot} r=${map[slot]} up=${up} busy=${busy} orig=${orig} onChanged=${onChanged} label=${label} sub=${sub} />`)}</div>
        ${rest.length > 0 && html`<span class="sec">Other ${partLabel(part).toLowerCase()} images (not a multiview slot, or a duplicate view — generation uses the slot image)</span>
          <div class="others">${rest.map((r, i) => html`<${Slot} key=${r.name + i} d=${d} part=${part} r=${r} up=${up} busy=${busy} orig=${orig} onChanged=${onChanged} label=${r.view} />`)}</div>`}
        ${gen && gen.status === 'stale' && html`<${Chk} tone="w"><span>The ${partLabel(part).toLowerCase()} source was generated from different references (${gen.reason}). Regenerating it spends Tripo credits — see Parts.</span></${Chk}>`}
      </${Pnl}>`;
    })}
    <${Pnl} title="Optional parts" meta="hair · shoes · clothing · accessory">
      <p class="hint">Extra parts are generated as their own Tripo sources when they have references. Upload into a part:</p>
      <div class="row">${OPTIONAL_PARTS.map((p) => html`<${B} label=${'+ ' + partLabel(p)} disabled=${!!busy} why=${busy} onClick=${() => pick(p)} testid=${'add-' + p} />`)}</div>
      ${extras.length ? html`<div class="others">${extras.flatMap((p) => partRefs(d, p).map((r, i) => html`<${Slot} key=${p + r.name + i} d=${d} part=${p} r=${r} up=${up} busy=${busy} orig=${orig} onChanged=${onChanged} label=${partLabel(p)} sub=${r.view} />`))}</div>` : html`<span class="u mut">No optional-part references.</span>`}
    </${Pnl}>
    ${unknown.length > 0 && html`<${Pnl} title="Unassigned" meta="the classifier could not tell the part">
      <div class="others">${unknown.map((r, i) => html`<${Slot} key=${r.name + i} d=${d} part="unknown" r=${r} up=${up} busy=${busy} orig=${orig} onChanged=${onChanged} label="Unknown" sub=${r.view} />`)}</div>
    </${Pnl}>`}
  </div>`;
}

/** Validation: green READY / yellow WARNING / red BLOCKED rows from the manifest's validation. */
export function ValidationList({ d, busy, onValidate }) {
  const v = d.manifest.validation;
  if (!v) return html`<${Chk} tone="info"><span>Not validated yet — validation runs after every upload, or run it now.</span>${onValidate && html`<div class="row"><${B} label="Validate references" disabled=${!!busy} why=${busy} onClick=${onValidate} testid="validate" /></div>`}</${Chk}>`;
  const ready = CORE_PARTS.filter((p) => partRefs(d, p).length && !(v.blocking || []).some((b) => b.includes(p)));
  return html`<div class="checks" data-t="validation">
    ${ready.map((p) => { const vs = [...new Set(partRefs(d, p).map((r) => r.view))]; return html`<${Chk}><span><b>READY</b> · ${partLabel(p)}: ${vs.length} view${vs.length > 1 ? 's' : ''} (${vs.join(', ')})</span></${Chk}>`; })}
    ${(v.blocking || []).map((b) => html`<${Chk} tone="bad"><span><b>BLOCKED</b> · ${b}</span></${Chk}>`)}
    ${(v.warnings || []).map((w) => html`<${Chk} tone="w"><span><b>WARNING</b> · ${w}</span></${Chk}>`)}
    <div class="row"><span class="u mut" style="flex:1">validated ${new Date(v.at).toLocaleString()} · ${v.ok ? 'generation allowed' : 'generation blocked'}</span>
      ${onValidate && html`<${B} label="Validate references" disabled=${!!busy} why=${busy} onClick=${onValidate} testid="validate" title="runs ingest + validation as a job (free)" />`}</div>
  </div>`;
}

/** All references as cards (wizard step 2: the cleaned crop + part / view correction per image). */
export function RefCards({ d, up, busy, orig, onChanged }) {
  if (!d.references.length) return null;
  return html`<div class="others" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">${d.references.map((r, i) => html`<${Slot} key=${r.name + r.part + i} d=${d} part=${r.part} slot=${slotOf(r.part, r.view)} r=${r} up=${up} busy=${busy} orig=${orig} onChanged=${onChanged} label=${partLabel(r.part)} sub=${r.view} />`)}</div>`;
}

/** The character's References section. */
export function ReferencesSection({ d, reload }) {
  const busy = busyOf(d);
  const [orig, setOrig] = useState(false);
  const up = useUploads(d.summary.id, () => { reload(); bump(); });
  const onChanged = () => { reload(); bump(); };
  // deep links such as …/references#refs-head (Parts → Replace References) scroll to the part
  useEffect(() => { const id = location.hash.slice(1); if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }, []);
  return html`<div class="stack">
    <div class="row">
      <div class="subtabs sm" role="tablist" aria-label="Image"><button class=${!orig ? 'on' : ''} onClick=${() => setOrig(false)} data-t="show-cleaned">Cleaned</button><button class=${orig ? 'on' : ''} onClick=${() => setOrig(true)} data-t="show-original">Original</button></div>
      <span class="u" style="color:rgba(238,233,217,.6)">${d.references.length} references from ${new Set(d.references.map((r) => r.name)).size} images</span>
      <span class="sp"></span>
      ${busy && html`<${Tag} tone="run">${busy}</${Tag}>`}
    </div>
    <${DropZone} up=${up} busy=${busy} title=${d.references.length ? 'Add more references' : 'No references yet — add reference images'}
      sub=${d.references.length ? 'Drop images here, or onto a specific slot below to set its part and view.' : 'Full-body images (front, left, back, right) and, for high-detail donors, head and hand views. The classifier assigns part and view; you can correct any slot.'} small=${d.references.length > 0} />
    <${UploadRows} up=${up} />
    <${Pnl} title="Validation" meta="checked before any credits are spent">
      <${ValidationList} d=${d} busy=${busy} onValidate=${() => startJob(d.summary.id, 'validate')} />
    </${Pnl}>
    <${MultiviewPanels} d=${d} up=${up} busy=${busy} orig=${orig} onChanged=${onChanged} />
  </div>`;
}
