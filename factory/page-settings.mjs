/** /factory/settings — what this server has configured (GET /api/cf/status), and how to fix what is missing. */
import { html, useState } from '/factory/ui/preact-htm.mjs';
import { useStore, loadStatus, fmtNum, fmtK } from '/factory/ui/lib.mjs';
import { Pnl, Chk, Loading, FetchError, Tag, Copy, useTitle } from '/factory/ui/ui.mjs';

const CLI = [
  ['create <id> --name "Main Guy" --height 1.93 --quality hero', 'create an empty character'],
  ['build <id> --refs <folder> --quality hero --height 1.93', 'ingest a folder of references and run every stage (spends Tripo credits)'],
  ['resume <id>', 'continue from the first stage that is not done'],
  ['generate <id> --part head', 'regenerate one part: new seeds, new Tripo task (spends credits)'],
  ['generate <id> --part hand_left,hand_right', 'regenerate both hands (spends credits)'],
  ['rebuild <id> --stage <stage> --only', 'run one stage again (ingest, validate, generate, assemble, gamemesh, rig, import, lods, preview, courttest)'],
  ['status <id>', 'stage table, parts, warnings'],
  ['validate <id>', 'ingest + validate the references (free)'],
  ['preview <id>', 'deformation validation + previews on the court (free)'],
  ['court-test <id>', 'the game\'s court test with this character (free)'],
];
const PROVIDERS = [
  { n: 'Uploaded images', on: true, d: 'Reference images uploaded in Create / References: classified, cleaned and validated by the pipeline.' },
  { n: 'GPT Image', on: false, d: 'Not connected — provider interface only. Generated reference sheets are not wired into the factory.' },
  { n: 'Higgsfield', on: false, d: 'Not connected — provider interface only. Generated reference sheets are not wired into the factory.' },
];

export function SettingsPage() {
  useTitle('Settings');
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const S = s.status;
  const refresh = async () => { setBusy(true); await loadStatus(true); setBusy(false); };
  if (!S) return html`<div class="wrap">${s.statusError ? html`<${FetchError} error=${s.statusError} onRetry=${refresh} what="the factory status" />` : html`<${Loading} label="Reading the factory status" />`}</div>`;
  const T = S.tripo;
  return html`<div class="wrap">
    <div class="phead"><div><div class="eyebrow">Character Factory</div><h1>Settings</h1><p class="lead">What this server is configured with. Secrets live in the repo's <code>.env</code> (never shown here); change it and restart the server.</p></div></div>
    <div class="cols">
      <${Pnl} title="Tripo" meta="3D generation + rigging" right=${T.configured ? (T.error ? html`<${Tag} tone="rd">error</${Tag}>` : html`<${Tag} tone="gr">connected</${Tag}>`) : html`<${Tag} tone="rd">not configured</${Tag}>`}>
        ${!T.configured ? html`<${Chk} tone="bad"><span><b>No Tripo API key.</b> Add <code>TRIPO_API_KEY=</code> to <code>.env</code> and restart.</span><span class="u">Builds, part generation, rigging and Resume stay disabled until then; everything else works.</span></${Chk}>`
          : T.error ? html`<${Chk} tone="bad"><span>The key is set, but Tripo answered: ${T.error}</span></${Chk}>`
            : html`<div class="kpis"><div class="kpi good"><div class="v">${fmtNum(T.balance)}</div><div class="k">credits available</div></div><div class="kpi"><div class="v">${fmtNum(T.frozen)}</div><div class="k">frozen (running tasks)</div></div><div class="kpi"><div class="v">${S.usdPerCredit != null ? '$' + S.usdPerCredit : '—'}</div><div class="k">USD per credit</div><div class="x">${S.usdPerCredit != null ? 'TRIPO_USD_PER_CREDIT' : 'not set (TRIPO_USD_PER_CREDIT)'}</div></div></div>`}
        <div class="row"><button class="btn sm" disabled=${busy} onClick=${refresh} data-t="tripo-refresh">${busy ? 'Asking Tripo…' : 'Refresh balance'}</button><span class="u mut">the server asks Tripo at most once a minute; Refresh asks now</span></div>
        <dl class="kv">
          <dt>Source model</dt><dd class="mono">${S.models.source}</dd>
          <dt>Source params</dt><dd class="mono">${Object.entries(S.models.sourceParams).map(([k, v]) => `${k}=${v}`).join(' · ')}</dd>
          <dt>Rig model</dt><dd class="mono">${S.models.rig} · spec ${S.models.rigSpec}</dd>
        </dl>
      </${Pnl}>
      <${Pnl} title="Limits" meta="cost guards">
        <div class="kpis">
          <div class="kpi"><div class="v">${fmtNum(S.limits.maxCreditsPerCharacter)}</div><div class="k">max credits / character</div><div class="x">MAX_TRIPO_CREDITS_PER_CHARACTER</div></div>
          <div class="kpi"><div class="v">${S.limits.maxRetriesPerStage}</div><div class="k">retries per stage</div><div class="x">MAX_RETRIES_PER_STAGE</div></div>
          <div class="kpi"><div class="v">${S.limits.tripoConcurrency}</div><div class="k">Tripo tasks in parallel</div><div class="x">TRIPO_CONCURRENCY</div></div>
        </div>
        <span class="hint">A generation stops before creating a task once a character has spent the limit; a failed task is retried at most the retry count, then the stage fails.</span>
      </${Pnl}>
    </div>
    <${Pnl} title="Quality presets" meta="game budgets per LOD" bodyCls="flush">
      <div class="tbl-wrap"><table class="tbl" data-t="quality-table"><thead><tr><th>Preset</th>${[0, 1, 2, 3].map((i) => html`<th class="n">LOD${i}</th>`)}<th class="n">Textures</th><th class="n">Bake</th></tr></thead><tbody>
        ${Object.entries(S.quality).map(([k, q]) => html`<tr><td><b>${k}</b></td>${[0, 1, 2, 3].map((i) => html`<td class="n">${q.lods[i] ? html`${fmtK(q.lods[i].tris)} tris<br /><span class="u mut">from ${q.lods[i].dist} m</span>` : '—'}</td>`)}<td class="n">${q.texSize}px</td><td class="n">${q.bakeSize}px</td></tr>`)}
      </tbody></table></div>
    </${Pnl}>
    <div class="cols w3">
      <${Pnl} title="Blender" right=${S.blender.found ? html`<${Tag} tone="gr">found</${Tag}>` : html`<${Tag} tone="rd">missing</${Tag}>`}>
        ${S.blender.found ? html`<span class="mono" style="overflow-wrap:anywhere">${S.blender.path}</span><span class="hint">Runs assembly, game mesh + bake and the rig merge.</span>` : html`<${Chk} tone="bad"><span>Blender was not found. Install it, or set <code>BLENDER_BIN=</code> in <code>.env</code> and restart.</span></${Chk}>`}
      </${Pnl}>
      <${Pnl} title="Clip storage" right=${S.storage ? html`<${Tag} tone="gr">configured</${Tag}>` : html`<${Tag} tone="rd">not configured</${Tag}>`}>
        ${S.storage ? html`<dl class="kv"><dt>Clips</dt><dd>${S.clips.count}</dd><dt>On the court</dt><dd>${S.clips.court}</dd></dl>`
          : html`<${Chk} tone="w"><span>Clip library unavailable on this machine: storage not configured (FIREBASE_SERVICE_ACCOUNT / R2 in .env).</span><span class="u">${S.clips.count} clips · ${S.clips.court} on the court. The court and the deformation test need recorded clips.</span></${Chk}>`}
        ${S.clips.error && html`<${Chk} tone="bad"><span>${S.clips.error}</span></${Chk}>`}
        <div class="row"><a class="btn sm" href="/factory/moves">Moves library</a><a class="btn sm" href="/mocap">Capture (/mocap)</a></div>
      </${Pnl}>
      <${Pnl} title="Pipeline"><dl class="kv"><dt>Version</dt><dd class="mono">${S.pipelineVersion}</dd><dt>Code</dt><dd class="mono">tools/character_pipeline/</dd><dt>Characters</dt><dd class="mono">assets/characters/&lt;id&gt;/</dd><dt>Jobs</dt><dd class="mono">assets/characters/_jobs/</dd></dl></${Pnl}>
    </div>
    <${Pnl} title="Reference image providers" meta="ReferenceImageProvider">
      <div class="prov">${PROVIDERS.map((p) => html`<div class=${p.on ? '' : 'off'}><span class="d">${p.n}</span>${p.on ? html`<${Tag} tone="gr">active</${Tag}>` : html`<${Tag} tone="gy">not connected</${Tag}>`}<span class="hint">${p.d}</span></div>`)}</div>
    </${Pnl}>
    <${Pnl} title="Command line" meta="the same implementation the UI's jobs run">
      <div class="clist">${CLI.map(([c, h]) => html`<div class="ci"><${Copy} text=${`npm run character -- ${c}`} /><span class="hint">${h}</span></div>`)}</div>
    </${Pnl}>
  </div>`;
}
