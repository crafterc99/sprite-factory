/**
 * Appearance: the game model in the 3D viewer with the Soul Jam character material (ramp, key /
 * shadow tint, rim, normal strength, planar) applied live; Save stores it on the manifest
 * (PATCH material) and it reaches the court at the next Soul Jam skeleton import.
 */
import { html, useState, useEffect } from '/factory/ui/preact-htm.mjs';
import { PRESETS } from '/js/souljam-material.mjs';
import { jsend, toast, bump, busyOf, fmtBytes, fmtTime } from '/factory/ui/lib.mjs';
import { Pnl, Empty, Chk, B, Tag } from '/factory/ui/ui.mjs';
import { Viewer } from '/factory/ui/viewer.mjs';
import { runLocal, resumeCharacter } from '/factory/ui/actions.mjs';
import { GameBadge } from '/factory/ui/sec-parts.mjs';
import { stageWhy } from '/factory/ui/sec-rig.mjs';

const KEYS = ['ramp', 'keyTint', 'shadowTint', 'rim', 'normalStrength', 'planar'];
const pick = (S) => Object.fromEntries(KEYS.map((k) => [k, Array.isArray(S[k]) ? S[k].map((x) => +(+x).toFixed(3)) : +(+S[k]).toFixed(3)]));
const DEF = PRESETS['souljam-illustrated'];

/** First bytes of a PNG → its size (IHDR), without downloading the whole texture. */
async function pngSize(url) {
  const r = await fetch(url); const rd = r.body.getReader();
  let buf = new Uint8Array(0);
  while (buf.length < 24) { const { value, done } = await rd.read(); if (done) break; const n = new Uint8Array(buf.length + value.length); n.set(buf); n.set(value, buf.length); buf = n; }
  rd.cancel().catch(() => {});
  const dv = new DataView(buf.buffer);
  return dv.getUint32(0) === 0x89504e47 ? [dv.getUint32(16), dv.getUint32(20)] : null;
}
function Textures({ d }) {
  const [sizes, set] = useState({});
  useEffect(() => { let off = false; (async () => { for (const t of d.textures) { try { const s = await pngSize(t.url); if (!off) set((o) => ({ ...o, [t.name]: s })); } catch { if (!off) set((o) => ({ ...o, [t.name]: false })); } } })(); return () => { off = true; }; }, [d.textures.map((t) => t.name).join()]);
  if (!d.textures.length) return html`<span class="hint">No baked textures yet (the game mesh stage bakes them).</span>`;
  return html`<div class="tbl-wrap"><table class="tbl" data-t="textures"><thead><tr><th>Texture</th><th class="n">Resolution</th><th>Colour space</th><th class="n">Size</th></tr></thead><tbody>
    ${d.textures.map((t) => { const s = sizes[t.name]; const srgb = /basecolor|albedo|diffuse/i.test(t.name); return html`<tr><td><a href=${t.url} target="_blank" rel="noopener">${t.name}</a></td><td class="n">${s ? `${s[0]}×${s[1]}` : s === false ? 'unreadable' : '…'}</td><td>${srgb ? html`<${Tag} tone="or">sRGB</${Tag}>` : html`<${Tag}>non-color</${Tag}>`}</td><td class="n">${fmtBytes(t.bytes)}</td></tr>`; })}
  </tbody></table></div>`;
}

function Slider({ k, label, v, min, max, step = 0.01, on }) {
  return html`<label class="ctl"><span class="k">${label}</span><input class="range" type="range" min=${min} max=${max} step=${step} value=${v} onInput=${(e) => on(+e.target.value)} data-t=${'mat-' + k} /><span class="v">${(+v).toFixed(2)}</span></label>`;
}
function Tint({ k, label, v, on }) {
  const sw = `rgb(${v.map((x) => Math.round(Math.min(1, x / 1.3) * 255)).join(',')})`;
  return html`<div class="stack" style="gap:6px"><span class="lbl" style="display:flex;gap:8px;align-items:center;margin:0">${label}<i style=${{ width: '16px', height: '16px', border: '2px solid var(--ink)', background: sw }}></i><span class="mono" style="font-weight:400">${v.map((x) => x.toFixed(2)).join(' · ')}</span></span>
    ${['R', 'G', 'B'].map((c, i) => html`<${Slider} k=${k + c} label=${c} v=${v[i]} min="0.7" max="1.3" on=${(x) => on(v.map((y, j) => (j === i ? x : y)))} />`)}</div>`;
}

export function AppearanceSection({ d, reload, status }) {
  const saved = d.manifest.material || null;
  const base = { ...DEF, ...(saved || {}) };
  const [S, setS] = useState(base);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const running = busyOf(d);
  const dirty = JSON.stringify(pick(S)) !== JSON.stringify(pick(base));
  const set = (k) => (v) => setS((o) => ({ ...o, [k]: v }));
  const model = d.lods?.lod0?.url ? { key: 'lod0', label: 'Rigged LOD0', url: d.lods.lod0.url, bytes: d.lods.lod0.bytes, triangles: d.lods.lod0.triangles }
    : d.files.gameGlb ? { key: 'game', label: 'game/lod0.glb', url: d.files.gameGlb.url, bytes: d.files.gameGlb.bytes } : null;
  const imp = d.state.stages.import;
  const whyImport = stageWhy(d, 'import');
  const save = async () => {
    setBusy(true);
    try { await jsend('PATCH', `/api/cf/characters/${encodeURIComponent(d.summary.id)}`, { material: pick(S) }); toast('Material saved — it takes effect on the next Soul Jam skeleton import', { tone: 'ok' }); setJustSaved(true); reload(); bump(); }
    catch (e) { toast(`Save failed: ${e.message}`, { tone: 'bad' }); }
    setBusy(false);
  };
  if (!model) {
    const gm = d.state.stages.gamemesh;
    const why = stageWhy(d, 'gamemesh');
    return html`<${Empty} dark title="No game model yet" actions=${html`<${B} label="Rebuild Game Mesh" kind="pri" disabled=${!!why} why=${why} showWhy onClick=${() => runLocal(d, 'gamemesh', 'Build the game mesh')} testid="app-gamemesh" /><a class="btn" href=${`/factory/characters/${encodeURIComponent(d.summary.id)}/overview`}>Pipeline</a>`}>
      Appearance works on the baked game mesh (game/lod0.glb), which the Game mesh + bake stage produces (currently <b>${gm.status}</b>${gm.status === 'failed' && gm.error ? ': ' + gm.error.split('\n')[0] : ''}).</${Empty}>`;
  }
  return html`<div class="cols w2">
    <${Viewer} title="Game model · Soul Jam material" badge=${html`<${GameBadge} />`} models=${[model]} styleParams=${S} autoLoadBelow=${60e6} testid="app-viewer" />
    <div class="stack">
      <${Pnl} title="Material" meta="SoulJamCharacterMaterial · live" right=${saved ? html`<${Tag} tone="gr">saved</${Tag}>` : html`<${Tag}>preset</${Tag}>`}>
        <div class="mat">
          <${Slider} k="ramp" label="Ramp" v=${S.ramp} min="0" max="1" on=${set('ramp')} />
          <${Tint} k="key" label="Key tint" v=${S.keyTint} on=${set('keyTint')} />
          <${Tint} k="shadow" label="Shadow tint" v=${S.shadowTint} on=${set('shadowTint')} />
          <${Slider} k="rim" label="Rim" v=${S.rim} min="0" max="1" on=${set('rim')} />
          <${Slider} k="normal" label="Normal strength" v=${S.normalStrength} min="0" max="2" on=${set('normalStrength')} />
          <${Slider} k="planar" label="Planar" v=${S.planar} min="0" max="1" on=${set('planar')} />
        </div>
        <div class="row">
          <button class="btn xs" onClick=${() => setS({ ...DEF })} data-t="mat-preset">Soul Jam preset</button>
          <button class="btn xs" onClick=${() => setS({ ...DEF, ...PRESETS.pbr })} data-t="mat-pbr">Plain PBR</button>
          <button class="btn xs" disabled=${!dirty} onClick=${() => setS(base)} data-t="mat-revert">Revert</button>
        </div>
        <div class="row"><${B} label="Save" kind="pri" disabled=${!dirty || !!running} why=${running ? running + ' — it would overwrite the manifest' : 'no changes'} busy=${busy} showWhy onClick=${save} testid="mat-save" /></div>
        <span class="u mut">Saved to the manifest (material). The court reads it from the imported rig: it takes effect on the next Soul Jam skeleton import${imp.finishedAt ? ` (last import ${fmtTime(imp.finishedAt)})` : ' (not imported yet)'}.</span>
        ${(justSaved || saved) && html`<${Chk} tone=${justSaved ? 'w' : 'info'}><span>${justSaved ? 'Saved. The court still shows the previous material until the character is re-imported.' : 'A saved material exists; re-import if the court does not show it yet.'}</span>
          <div class="row"><${B} label="Re-import now" kind=${justSaved ? 'pri' : ''} disabled=${!!whyImport} why=${whyImport} showWhy onClick=${() => runLocal(d, 'import', 'Re-import onto the Soul Jam skeleton')} testid="mat-reimport" /></div></${Chk}>`}
      </${Pnl}>
      <${Pnl} title="Textures" meta="baked by the game mesh stage"><${Textures} d=${d} /></${Pnl}>
    </div>
  </div>`;
}
