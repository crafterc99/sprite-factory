/** Character Factory shell: header (app tabs, Tripo balance, running jobs), History-API routes. */
import { html, render, useEffect } from '/factory/ui/preact-htm.mjs';
import { useLocation, useStore, store, interceptLinks, loadStatus, loadJobs, activeJobs, fmtNum } from '/factory/ui/lib.mjs';
import { Overlays, Empty } from '/factory/ui/ui.mjs';
import { CharactersPage } from '/factory/ui/page-characters.mjs';
import { CreatePage } from '/factory/ui/page-create.mjs';
import { CharacterPage } from '/factory/ui/page-character.mjs';
import { JobsPage } from '/factory/ui/page-jobs.mjs';
import { SettingsPage } from '/factory/ui/page-settings.mjs';
import { MovesPage } from '/factory/ui/page-moves.mjs';
import { PlaygroundPage } from '/factory/ui/page-playground.mjs';

const TABS = [['characters', 'Characters', '/factory'], ['create', 'Create', '/factory/create'], ['moves', 'Moves', '/factory/moves'], ['playground', 'Playground', '/factory/playground'], ['jobs', 'Jobs', '/factory/jobs'], ['settings', 'Settings', '/factory/settings']];

export function parseRoute(path) {
  const p = path.split('/').filter(Boolean);
  if (p[0] !== 'factory') return { page: 'notfound' };
  const [, a, b, c, extra] = p;
  if (!a) return { page: 'characters', tab: 'characters' };
  if (a === 'characters' && !b) return { page: 'characters', tab: 'characters' };
  if (a === 'characters' && b && !extra) return { page: 'character', tab: 'characters', id: decodeURIComponent(b), section: c || 'overview' };
  if (a === 'create' && !b) return { page: 'create', tab: 'create' };
  if (a === 'jobs' && !c) return { page: 'jobs', tab: 'jobs', job: b ? decodeURIComponent(b) : null };
  if (a === 'settings' && !b) return { page: 'settings', tab: 'settings' };
  if (a === 'moves' && !b) return { page: 'moves', tab: 'moves' };
  if (a === 'playground' && !b) return { page: 'playground', tab: 'playground' };
  return { page: 'notfound' };
}

function Header({ tab }) {
  const s = useStore();
  const t = s.status?.tripo;
  const run = activeJobs(s.jobs);
  const tripo = !s.status ? (s.statusError ? html`<a class="svc down" href="/factory/settings" title=${s.statusError}><i></i>status unavailable</a>` : html`<span class="svc wait"><i></i>Tripo …</span>`)
    : !t.configured ? html`<a class="svc down" href="/factory/settings" data-t="tripo-chip" title="TRIPO_API_KEY is not set"><i></i>Tripo · not configured</a>`
      : t.error ? html`<a class="svc down" href="/factory/settings" data-t="tripo-chip" title=${t.error}><i></i>Tripo · balance error</a>`
        : html`<a class="svc" href="/factory/settings" data-t="tripo-chip" title="Tripo credit balance (live from Tripo; refreshed at most once a minute)"><i></i>Tripo · ${fmtNum(t.balance)} credits${t.frozen ? ` · ${fmtNum(t.frozen)} frozen` : ''}</a>`;
  return html`<header class="sf-top">
    <a class="sf-logo" href="/factory"><span class="u">Soul Jam · Character Factory</span><span class="d">Sprite Factory</span></a>
    <nav class="apptabs" aria-label="Factory">${TABS.map(([k, l, h]) => html`<a class=${tab === k ? 'on' : ''} href=${h} data-t=${'tab-' + k} aria-current=${tab === k ? 'page' : null}>${l}</a>`)}</nav>
    <span class="sp"></span>
    <div class="svcs">
      ${tripo}
      ${run.length > 0 && html`<a class="svc busy" href="/factory/jobs" data-t="jobs-chip"><i></i>${run.length} job${run.length > 1 ? 's' : ''} running</a>`}
    </div>
    <nav class="sf-links"><a class="btn sm" href="/" data-t="studio-link">← Studio</a></nav>
  </header>`;
}

function NotFound({ path }) {
  return html`<div class="wrap"><div class="nf"><${Empty} dark title="No such page" actions=${html`<a class="btn pri" href="/factory">Go to Characters</a><a class="btn" href="/factory/jobs">Jobs</a>`}>Nothing lives at <code>${path}</code> in the Character Factory.</${Empty}></div></div>`;
}

function App() {
  const loc = useLocation();
  const r = parseRoute(loc.path);
  const s = useStore();
  const running = activeJobs(s.jobs).length > 0;
  useEffect(() => { window.__cfBooted = true; interceptLinks(document); loadStatus(); const t = setInterval(() => { if (!document.hidden) loadStatus(); }, 60000); return () => clearInterval(t); }, []);
  // jobs: every 3 s while one runs, otherwise every 15 s (a job may be started elsewhere)
  useEffect(() => { loadJobs(); const t = setInterval(() => { if (!document.hidden) loadJobs(); }, running ? 3000 : 15000); return () => clearInterval(t); }, [running]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && store.state.lightbox) store.set({ lightbox: null }); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, []);
  let page;
  if (r.page === 'characters') page = html`<${CharactersPage} />`;
  else if (r.page === 'create') page = html`<${CreatePage} q=${loc.q} />`;
  else if (r.page === 'character') page = html`<${CharacterPage} key=${r.id} id=${r.id} section=${r.section} q=${loc.q} />`;
  else if (r.page === 'jobs') page = html`<${JobsPage} job=${r.job} q=${loc.q} />`;
  else if (r.page === 'settings') page = html`<${SettingsPage} />`;
  else if (r.page === 'moves') page = html`<${MovesPage} q=${loc.q} />`;
  else if (r.page === 'playground') page = html`<${PlaygroundPage} q=${loc.q} />`;
  else page = html`<${NotFound} path=${loc.path} />`;
  return html`<${Header} tab=${r.tab} /><main id="main">${page}</main><${Overlays} />`;
}

const root = document.getElementById('app');
root.textContent = '';
render(html`<${App} />`, root);
