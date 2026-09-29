/**
 * /factory/moves — the game's move library in the design's Library look, backed by the real roles
 * and clips from GET /api/mocap3d/library. Recording happens on the capture page (/mocap).
 */
import { html } from '/factory/ui/preact-htm.mjs';
import { useJson, useStore, setQuery } from '/factory/ui/lib.mjs';
import { Pnl, Chk, Loading, FetchError, Tag, Empty, useTitle } from '/factory/ui/ui.mjs';

const GROUP = { loops: ['Base loops', 'The hub stance every other clip starts and ends on.'], locomotion: ['Locomotion', 'Dribbling while moving: jog, backpedal, strafe, sprint.'], moves: ['Moves', 'Crossovers, spins, hesitations and hand changes.'], shots: ['Shots', 'Jumpers, step-backs and finishes.'], transitions: ['Transitions', 'Short clips that bridge one state to another.'] };

export function MovesPage({ q }) {
  useTitle('Moves');
  const s = useStore();
  const lib = useJson('/api/mocap3d/library');
  const L = lib.data;
  if (!L) return html`<div class="wrap">${lib.error ? html`<${FetchError} error=${lib.error} onRetry=${lib.reload} what="the clip library" />` : html`<${Loading} label="Reading the clip library" />`}</div>`;
  const roles = Object.entries(L.roles);
  const clipOf = (k) => (L.court || []).find((c) => c.role === k) || (L.clips || []).find((c) => c.game?.role === k);
  const groups = [...new Set(roles.map(([, r]) => r.group))];
  const cat = q.get('group') && groups.includes(q.get('group')) ? q.get('group') : groups[0];
  const sel = q.get('role') && L.roles[q.get('role')] ? q.get('role') : null;
  const filled = roles.filter(([k]) => clipOf(k)).length;
  const list = roles.filter(([, r]) => r.group === cat);
  const S = sel && L.roles[sel], SC = sel && clipOf(sel);
  const storage = s.status?.storage;
  return html`<div class="wrap">
    <div class="phead"><div><div class="eyebrow">Soul Jam · animation</div><h1>Moves</h1><p class="lead">The roles the game plays and whether a recorded clip fills each one. Record on the capture page, then give the clip its role there.</p></div><span class="sp"></span><a class="btn pri lg" href="/mocap" data-t="moves-record">Record on /mocap</a></div>
    ${!L.clips.length && html`<${Chk} tone="w"><span>${storage === false ? 'Clip library unavailable on this machine: storage not configured (FIREBASE_SERVICE_ACCOUNT / R2 in .env).' : 'No clips recorded yet.'} Every role below reads “no clip” until the library is reachable and has clips.</span><div class="row"><a class="btn sm" href="/factory/settings">Storage status</a></div></${Chk}>`}
    <${Pnl} title="Library" meta=${`${L.clips.length} clips · ${(L.court || []).length} on the court`}>
      <div class="cov"><div class="bar"><i style=${{ width: (roles.length ? (filled / roles.length) * 100 : 0) + '%' }}></i></div><span class="u"><b>${filled}</b> / ${roles.length} roles have a clip</span></div>
      <div class="cats">${groups.map((g) => { const l = roles.filter(([, r]) => r.group === g); const n = l.filter(([k]) => clipOf(k)).length; return html`<button class=${'cat' + (cat === g ? ' on' : '')} onClick=${() => setQuery({ group: g, role: null })} data-t=${'cat-' + g}><span>${GROUP[g]?.[0] || g}</span><span class="cn">${n}/${l.length}</span></button>`; })}</div>
      <p class="hint">${GROUP[cat]?.[1] || ''}</p>
      <div class="slots">${list.map(([k, r]) => { const c = clipOf(k); return html`<button class=${'slot' + (c ? ' has' : '') + (sel === k ? ' on' : '')} onClick=${() => setQuery({ role: k })} data-t=${'role-' + k}>
        <span class="sn">${r.label}</span>
        <span class="flow"><span class="tag">${k}</span><span class="tag">${r.type}</span>${r.required && html`<span class="tag or">required</span>`}${r.switchesHand && html`<span class="tag or">swaps hand</span>`}${r.shot && html`<span class="tag">shot</span>`}</span>
        <span class="flow"><span class=${'hp ' + (c ? 'f' : 'e')}>${c ? 'clip ✓' : 'no clip'}</span><span class="u mut">${r.runtime ? 'used by the game' : 'not used by the game yet'}</span></span>
      </button>`; })}</div>
    </${Pnl}>
    ${S ? html`<div class="pick" data-t="role-pick"><div><div class="u">Selected role</div><div class="d">${S.label}</div></div>
        <span class="flow"><span class="tag">${sel}</span><span class="tag">${S.type}</span><span class="tag">${S.group}</span>${S.trigger && html`<span class="tag">trigger ${S.trigger}</span>`}</span>
        <span class="sp"></span>
        <span class="u">${SC ? `clip: ${SC.name || SC.id}` : 'no clip yet'}</span>
        <a class="btn sm pri" href="/mocap" data-t="role-record">Record</a>
        ${SC && html`<a class="btn sm" href="/factory/playground">Play on the court</a>`}
      </div>
      <p class="hint" style="color:rgba(238,233,217,.7)">To fill <code>${sel}</code>: record or upload the move on /mocap, analyse it, then in its “3D game clip” settings give it the role <b>${sel}</b>. The court picks it up from the library.</p>`
      : html`<${Empty} dark title="Pick a role" actions=${html`<button class="btn" onClick=${() => setQuery({ role: list[0]?.[0] })} data-t="role-first">Select ${list[0]?.[1].label || 'the first role'}</button>`}>Select a role to see how to record it.</${Empty}>`}
  </div>`;
}
