/** Job-starting actions with their confirmations (paid ones say so and ask first). */
import { html } from '/factory/ui/preact-htm.mjs';
import { ask, startJob, fmtNum, opLabel, partLabel, STAGES, STAGE_LABEL, PAID_STAGES, HISTORY_NOTE } from '/factory/ui/lib.mjs';

/** Resume: `resume` from the next open stage; says what runs and whether it can spend credits. `c` = character summary. */
export async function resumeCharacter(c, status) {
  const rest = STAGES.slice(Math.max(0, STAGES.indexOf(c.stage)));
  const paid = rest.filter((s) => PAID_STAGES.has(s));
  const ok = await ask({
    title: `Resume ${c.name}`, tone: paid.length ? 'paid' : '', confirm: 'Resume pipeline',
    body: html`<p>Runs <b>${c.id}</b> from <b>${STAGE_LABEL[c.stage]}</b> (${c.stageStatus}) through: ${rest.map((s) => STAGE_LABEL[s]).join(' → ')}.</p>
      ${paid.length ? html`<p><b>May spend Tripo credits:</b> ${paid.map((s) => (s === 'generate' ? 'source generation (only parts without a finished task; an interrupted task is resumed without paying again)' : 'rig (Tripo rig-check + rig tasks, unless a Tripo rig already exists)')).join('; ')}. Tripo reports the exact credits after each task.</p>` : html`<p>No Tripo credits: the remaining stages run locally.</p>`}
      ${status?.tripo?.configured && status.tripo.balance != null && html`<p class="u">Balance: ${fmtNum(status.tripo.balance)} credits · limit per character ${fmtNum(status.limits?.maxCreditsPerCharacter)} · spent on this character ${fmtNum(c.credits)}</p>`}`,
  });
  return ok ? startJob(c.id, 'resume') : null;
}
export async function regenerate(d, part) {
  const parts = part.split(',');
  const prev = parts.map((p) => d.generation[p]?.task?.credits).filter((x) => x != null);
  const fresh = parts.every((p) => !d.generation[p]?.task);
  const ok = await ask({ title: `${fresh ? 'Generate' : 'Regenerate'} ${parts.map(partLabel).join(' + ')}?`, tone: 'paid', confirm: `${fresh ? 'Generate' : 'Regenerate'} (spends credits)`, body: html`
    <p>Starts ${parts.length > 1 ? 'new Tripo tasks' : 'a new Tripo task'}${fresh ? '' : ' with new seeds'} for <b>${parts.map(partLabel).join(', ')}</b> of ${d.summary.id}.${fresh ? '' : ' The current source stays in the part\'s history.'}</p>
    <p><b>Spends Tripo credits.</b> ${prev.length ? `The current source${prev.length > 1 ? 's' : ''} cost ${prev.join(' + ')} credits.` : ''} ${HISTORY_NOTE}</p>
    <p>Assembly, game mesh, rig and everything after turn stale and must be rebuilt (Resume).</p>` });
  return ok ? startJob(d.summary.id, 'generate', part) : null;
}
export async function rerig(d) {
  const hasRig = !!d.files?.rigGlb;
  const ok = await ask({ title: hasRig ? 'Re-rig?' : 'Run rigging?', tone: 'paid', confirm: 'Run the rig stage', body: html`
    <p>Runs the rig stage for ${d.summary.id}: ${hasRig ? 'a Tripo rig file already exists and is reused (no new Tripo task); the rig is merged again' : 'uploads the game mesh to Tripo, runs rig-check + rig (spends Tripo credits), then merges the rig'} onto the LOD chain in Blender.</p>
    <p>Soul Jam skeleton import, LODs, validation and the court test turn stale afterwards.</p>` });
  return ok ? startJob(d.summary.id, 'rig') : null;
}
export async function runLocal(d, op, what) {
  const ok = await ask({ title: `${what}?`, confirm: what, body: html`<p>Runs <b>${opLabel(op)}</b> for ${d.summary.id} locally (no Tripo credits). Stages after it turn stale until they run again.</p>` });
  return ok ? startJob(d.summary.id, op) : null;
}
