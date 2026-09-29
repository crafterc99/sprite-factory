#!/usr/bin/env node
/**
 * Character Factory UI smoke test (Playwright, real server, real data).
 *
 *   node tools/character_pipeline/ui-smoke.mjs [--base http://localhost:3456] [--char main_guy_001]
 *                                              [--shots <dir>] [--no-viewer] [--headed]
 *
 * Visits every /factory route (deep links for --char), clicks every non-destructive, non-paid
 * control and asserts that each click changed something (URL, DOM or a network request) and that
 * no page error / console error happened. Paid controls (Build, Resume, Generate, Regenerate,
 * Re-Rig) are only checked for presence and the enabled / disabled state the API implies — never
 * clicked. A network guard aborts any job start, delete or edit that does not target the throwaway
 * character `zz_ui_smoke`, which the test creates through the wizard (with a PNG made by sharp),
 * validates (op validate, free), duplicates, and finally deletes through the API.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const BASE = String(opt('base', 'http://localhost:3456')).replace(/\/$/, '');
const CHAR = String(opt('char', 'main_guy_001'));
const SMOKE = 'zz_ui_smoke';
const SHOTS = opt('shots') ? path.resolve(String(opt('shots'))) : null;
const VIEWER = !argv.includes('--no-viewer');

// ═══ reporting ═══
const R = { pass: 0, fail: 0, skip: 0, fails: [] };
let step = 'setup';
const pass = (n) => { R.pass++; console.log(`  PASS ${n}`); };
const fail = (n, why) => { R.fail++; R.fails.push(`${n}: ${why}`); console.log(`  FAIL ${n} — ${why}`); };
const skip = (n, why) => { R.skip++; console.log(`  SKIP ${n} — ${why}`); };
const check = (n, cond, why = 'condition false') => (cond ? pass(n) : fail(n, why));
const section = (n) => { step = n; console.log(`\n▸ ${n}`); };

// ═══ API (Node fetch) ═══
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitNoJob(id, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { data } = await api('GET', `/api/cf/jobs?character=${id}`);
    if (!(data.jobs || []).some((j) => j.status === 'running' || j.status === 'queued')) return true;
    await sleep(1500);
  }
  return false;
}
async function removeSmoke() {
  const { data } = await api('GET', '/api/cf/characters');
  for (const c of (data.characters || []).filter((x) => x.id === SMOKE || x.id.startsWith(SMOKE + '_'))) {
    await waitNoJob(c.id);
    const r = await api('DELETE', `/api/cf/characters/${c.id}?confirm=${c.id}`);
    console.log(`  cleanup: DELETE ${c.id} → ${r.status}`);
  }
  // the smoke test's own job records (the API deletes the character folder, not its job records)
  const JOBS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'characters', '_jobs');
  if (fs.existsSync(JOBS)) for (const f of fs.readdirSync(JOBS).filter((x) => x.endsWith('.json'))) {
    try { const j = JSON.parse(fs.readFileSync(path.join(JOBS, f), 'utf8')); if (j.character === SMOKE || String(j.character).startsWith(SMOKE + '_')) { fs.rmSync(path.join(JOBS, f)); console.log(`  cleanup: job record ${f}`); } } catch {}
  }
}

(async () => {
  console.log(`Character Factory UI smoke · ${BASE} · character ${CHAR}`);
  const st0 = await api('GET', '/api/cf/status');
  if (st0.status !== 200) { console.error('server not reachable: /api/cf/status → ' + st0.status); process.exit(2); }
  const STATUS = st0.data;
  const det0 = await api('GET', `/api/cf/characters/${CHAR}`);
  if (det0.status !== 200) { console.error(`no character ${CHAR}`); process.exit(2); }
  await removeSmoke();

  // a small reference: a tall dark figure on a flat light background (classifies as a body)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ui-smoke-'));
  const png = path.join(tmp, 'zz-smoke-figure.png'), png2 = path.join(tmp, 'zz-smoke-head.png');
  const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f2efe8"/>${body}</svg>`);
  await sharp(svg(400, 900, '<rect x="160" y="60" width="80" height="780" fill="#2b2b33"/><circle cx="200" cy="70" r="46" fill="#8a5a3c"/><rect x="110" y="170" width="180" height="60" fill="#2b2b33"/>')).png().toFile(png);
  await sharp(svg(600, 700, '<ellipse cx="300" cy="340" rx="180" ry="230" fill="#9a6444"/><rect x="220" y="520" width="160" height="170" fill="#8a5a3c"/>')).png().toFile(png2);

  const browser = await chromium.launch({ headless: !argv.includes('--headed'), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  let reqs = 0, lastReqs = [];
  page.on('pageerror', (e) => errors.push(`[${step}] page error: ${e.message}`));
  // the one expected failure: the deliberate deep link to a character that does not exist (404)
  const expected404 = (m) => /status of 404/.test(m.text()) && (m.location()?.url || '').includes('/api/cf/characters/does_not_exist');
  page.on('console', (m) => { if (m.type() === 'error' && !expected404(m)) errors.push(`[${step}] console error: ${m.text()} (${m.location()?.url || ''})`); });
  page.on('request', (q) => { reqs++; lastReqs.push(q.method() + ' ' + q.url().replace(BASE, '')); if (lastReqs.length > 60) lastReqs.shift(); });
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errors.push(`[${step}] ${r.status()} from ${r.url().replace(BASE, '')}`); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  // ── network guard: nothing paid or destructive may leave the browser except on the smoke character ──
  const guarded = [];
  await page.route(/\/api\/cf\/(characters\/[^/?]+(\/.*)?|jobs\/[^/]+\/cancel)(\?.*)?$/, async (route) => {
    const q = route.request(), m = q.method(), u = new URL(q.url());
    const id = decodeURIComponent((/\/api\/cf\/characters\/([^/?]+)/.exec(u.pathname) || [])[1] || '');
    const mutating = m !== 'GET';
    const smokeish = id === SMOKE || id.startsWith(SMOKE + '_');
    let ok = !mutating || smokeish || (m === 'POST' && u.pathname === '/api/cf/characters');
    if (mutating && /\/jobs$/.test(u.pathname)) { const b = JSON.parse(q.postData() || '{}'); ok = smokeish && b.op === 'validate'; }
    if (/\/cancel$/.test(u.pathname)) ok = false;
    if (!ok) { guarded.push(`${m} ${u.pathname}${u.search} ${q.postData() || ''}`); return route.abort('blockedbyclient'); }
    return route.continue();
  });

  const hash = () => page.evaluate(() => { const s = document.body.innerHTML.replace(/\d+/g, '#'); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; });
  /** Clicks and asserts that the URL, the DOM (ignoring digits: timers) or the network changed. */
  async function act(name, locator, { expect, wait = 350 } = {}) {
    try {
      const el = typeof locator === 'string' ? page.locator(locator).first() : locator;
      await el.waitFor({ state: 'visible', timeout: 15000 });
      if (await el.isDisabled().catch(() => false)) return fail(name, 'control is disabled');
      const u0 = page.url(), h0 = await hash(), r0 = reqs;
      await el.click();
      await page.waitForTimeout(wait);
      if (expect) { const r = await expect(); return r === true ? pass(name) : fail(name, r || 'expectation not met'); }
      const changed = page.url() !== u0 ? 'url' : reqs !== r0 ? 'network' : (await hash()) !== h0 ? 'dom' : null;
      return changed ? pass(`${name} (${changed})`) : fail(name, 'nothing changed (url, dom, network)');
    } catch (e) { return fail(name, e.message.split('\n')[0]); }
  }
  const go = async (p, sel) => {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    if (sel) await page.locator(sel).first().waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(250);
  };
  const exists = async (sel) => (await page.locator(sel).count()) > 0;
  const enabled = async (sel) => !(await page.locator(sel).first().isDisabled());
  const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
  /**
   * A control whose enabled state follows the API (paid ones are never clicked). The pipeline can
   * change state during the run (another process), so the API is re-read and the check retried for
   * ~8 s (the UI polls every 3 s) before it fails.
   */
  let refreshState = async () => {};
  const val = (x) => (typeof x === 'function' ? x() : x);
  async function stateCheck(name, sel, expectEnabled, reason, { paid = false } = {}) {
    if (!(await exists(sel))) return fail(name, `missing (${sel})`);
    let exp, en;
    for (let i = 0; i < 12; i++) {
      await refreshState(); exp = !!val(expectEnabled); en = await enabled(sel);
      if (en === exp) { const r = val(reason); return pass(`${name} is ${exp ? 'enabled' : 'disabled'}${r ? ' (' + r + ')' : ''}${paid ? ' — not clicked' : ''}`); }
      await page.waitForTimeout(700);
    }
    fail(name, `expected ${exp ? 'enabled' : 'disabled'}, is ${en ? 'enabled' : 'disabled'} (UI and API disagreed for 8 s)`);
  }
  const paidState = (name, sel, exp, reason) => stateCheck(name, sel, exp, reason, { paid: true });

  try {
    // ═══ 1. every route renders (deep links included) ═══
    section('routes');
    const SECTIONS = ['overview', 'references', 'parts', 'assembly', 'rig', 'animation', 'appearance', 'lods', 'court'];
    const routes = [['/factory', '[data-t=kpis]'], ['/factory/create', '[data-t=f-name]'], ['/factory/jobs', 'h1'], ['/factory/settings', '[data-t=quality-table]'], ['/factory/moves', '.slots'], ['/factory/playground', '[data-t=courtbox]'],
      ...SECTIONS.map((s) => [`/factory/characters/${CHAR}/${s}`, `[data-t=sec-${s}].on`]), [`/factory/characters/${CHAR}`, '[data-t=sec-overview].on'], ['/factory/no-such-page', '.empty2'], ['/factory/characters/does_not_exist', '.empty2']];
    for (const [p, sel] of routes) {
      const e0 = errors.length;
      try { await go(p, sel); check(`renders ${p}`, errors.length === e0, errors.slice(e0).join(' | ')); }
      catch (e) { fail(`renders ${p}`, e.message.split('\n')[0]); }
    }
    await go('/factory/no-such-page', '.empty2');
    check('unknown route shows a real page with an action', await exists('.empty2 a.btn[href="/factory"]'));

    // ═══ 2. header tabs, back / forward ═══
    section('header + history');
    await go('/factory', '[data-t=kpis]');
    for (const [t, p] of [['create', '/factory/create'], ['moves', '/factory/moves'], ['playground', '/factory/playground'], ['jobs', '/factory/jobs'], ['settings', '/factory/settings'], ['characters', '/factory']]) {
      await act(`tab ${t}`, `[data-t=tab-${t}]`, { expect: async () => (new URL(page.url()).pathname === p && (await exists(`[data-t=tab-${t}].on`))) || `url ${page.url()}` });
    }
    await page.goBack(); await page.waitForTimeout(300);
    check('browser back → previous page', new URL(page.url()).pathname === '/factory/settings' && (await exists('[data-t=tab-settings].on')), page.url());
    await page.goForward(); await page.waitForTimeout(300);
    check('browser forward', new URL(page.url()).pathname === '/factory' && (await exists('[data-t=kpis]')), page.url());
    await act('Tripo chip → settings', '[data-t=tripo-chip]', { expect: async () => page.url().endsWith('/factory/settings') || page.url() });
    check('← Studio links to /', (await page.locator('[data-t=studio-link]').getAttribute('href')) === '/');

    // ═══ 3. characters library ═══
    section('characters');
    await go('/factory', `[data-t=card-${CHAR}]`);
    await act('dashboard Refresh', '[data-t=dash-refresh]', { expect: async () => lastReqs.some((r) => r.includes('/api/cf/summary')) || 'no /api/cf/summary request' });
    await act('filter In progress', '[data-t=filter-progress]');
    await act('filter All', '[data-t=filter-all]');
    await page.fill('[data-t=search]', 'zzzz-nothing'); await page.waitForTimeout(200);
    check('search with no match shows an empty state with an action', await exists('.empty2 button'));
    await act('empty search → Show all', '.empty2 button', { expect: async () => (await exists(`[data-t=card-${CHAR}]`)) || 'card not back' });
    let sum, busySum;
    refreshState = async () => { sum = (await api('GET', '/api/cf/characters')).data.characters.find((c) => c.id === CHAR); busySum = !!(sum.job || sum.runningStage); };
    await refreshState();
    const card = `[data-t=card-${CHAR}]`;
    await paidState('card Resume', `${card} [data-t=card-resume]`, () => !busySum && !!sum.stage && ['ready', 'failed', 'stale', 'partial'].includes(sum.stageStatus) && !!STATUS.tripo.configured, () => (busySum ? 'busy' : sum.stageStatus));
    await stateCheck('card Delete (disabled while busy)', `${card} [data-t=card-delete]`, () => !busySum, () => (busySum ? 'busy' : ''));
    check('card Preview state matches the models on disk', (await exists(`${card} a[data-t=card-preview]`)) === !!(sum.models.game || sum.models.assembled || sum.models.source));
    if (await exists(`${card} a[data-t=card-preview]`)) { await act('card Preview', `${card} [data-t=card-preview]`, { expect: async () => /\/factory\/characters\/[^/]+\/(appearance|assembly|parts)$/.test(new URL(page.url()).pathname) || page.url() }); await page.goBack(); await page.waitForTimeout(300); }
    await act('card Open', `${card} [data-t=card-open]`, { expect: async () => new URL(page.url()).pathname === `/factory/characters/${CHAR}` || page.url() });

    // ═══ 4. character sub-nav + overview ═══
    section(`character ${CHAR}: sub-nav + overview`);
    await go(`/factory/characters/${CHAR}`, '[data-t=pipeline]');
    for (const s of SECTIONS.slice(1).concat(['overview'])) await act(`sub-nav ${s}`, `[data-t=sec-${s}]`, { expect: async () => (new URL(page.url()).pathname === `/factory/characters/${CHAR}/${s}` && (await exists(`[data-t=sec-${s}].on`))) || page.url() });
    await page.goBack(); await page.waitForTimeout(300);
    check('back inside the character → previous section', new URL(page.url()).pathname.endsWith('/court'), page.url());
    await go(`/factory/characters/${CHAR}/overview`, '[data-t=pipeline]');
    let D, S, busy, next;
    const tripo = !!STATUS.tripo.configured;
    refreshState = async () => { D = (await api('GET', `/api/cf/characters/${CHAR}`)).data; S = D.state.stages; busy = !!D.summary.job || Object.values(S).some((x) => x.status === 'running'); next = D.state.next; };
    await refreshState();
    check('pipeline lists all 10 stages', (await page.locator('[data-t=pipeline] .stg:not(.sub)').count()) === 10);
    const why = (st) => () => (busy ? 'busy' : st ? S[st].status : '');
    await paidState('Overview Resume', '[data-t=ov-resume]', () => !busy && !!next && ['ready', 'failed', 'stale', 'partial'].includes(S[next].status) && tripo, () => (busy ? 'busy' : next && `${next} ${S[next].status}`));
    await paidState('Overview Regenerate Part', '[data-t=ov-regen]', () => !busy && tripo && Object.keys(D.state.parts).length > 0, why());
    await paidState('Overview Re-Rig', '[data-t=ov-rerig]', () => !busy && S.rig.status !== 'blocked' && tripo, why('rig'));
    await stateCheck('Overview Rebuild Game Mesh', '[data-t=ov-gamemesh]', () => !busy && S.gamemesh.status !== 'blocked', why('gamemesh'));
    await stateCheck('Overview Run Validation', '[data-t=ov-validate]', () => !busy && S.preview.status !== 'blocked', why('preview'));
    check('Test On Court enabled iff a court rig exists', (await exists('a[data-t=ov-court]')) === !!D.courtUrl);
    if (await exists('[data-t=ov-gamemesh]:not([disabled])')) {
      await act('Rebuild Game Mesh opens a confirmation', '[data-t=ov-gamemesh]', { expect: async () => (await exists('.modal')) || 'no dialog' });
      const r0 = guarded.length;
      await act('confirmation Cancel closes it, starts nothing', '[data-t=dialog-cancel]', { expect: async () => (!(await exists('.modal')) && guarded.length === r0) || 'dialog still open or a job request was made' });
    } else skip('Rebuild Game Mesh dialog', 'disabled right now (' + (busy ? 'busy' : S.gamemesh.status) + ')');
    if (await exists('[data-t=ov-regen]:not([disabled])')) {
      await act('Regenerate Part menu opens', '[data-t=ov-regen]', { expect: async () => (await exists('.menu .pop')) || 'no menu' });
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      check('Regenerate Part menu closes on Escape (no paid item clicked)', !(await exists('.menu .pop')));
    } else skip('Regenerate Part menu', 'disabled right now');
    if (await exists('[data-t=hero-thumb]')) {
      const n = await page.locator('[data-t=hero-thumb]').count();
      if (n > 1) await act('hero preview thumbnail', page.locator('[data-t=hero-thumb]').nth(1), { expect: async () => (await page.locator('[data-t=hero-thumb]').nth(1).getAttribute('class')) === 'on' || 'thumb not selected' });
      await act('hero image → lightbox', '.hero .main img', { expect: async () => (await exists('[data-t=lightbox]')) || 'no lightbox' });
      await act('lightbox closes', '[data-t=lightbox]', { expect: async () => !(await exists('[data-t=lightbox]')) || 'still open' });
    }
    if (await exists('[data-t=error-detail]')) {
      await act('error Technical detail opens (logs fetched)', '[data-t=error-detail]', { wait: 900, expect: async () => (await page.locator('[data-t=error-item] .log').count()) > 0 || 'no log shown' });
      await act('error Technical detail closes', '[data-t=error-detail]');
    } else skip('error detail', 'no errors recorded');
    await shot('overview');

    // ═══ 5. references ═══
    section(`character ${CHAR}: references`);
    await go(`/factory/characters/${CHAR}/references`, '[data-t=validation]');
    const img0 = await page.locator('.mvs .im img').first().getAttribute('src');
    await act('Original toggle', '[data-t=show-original]', { expect: async () => (await page.locator('.mvs .im img').first().getAttribute('src')) !== img0 || 'image did not switch' });
    await act('Cleaned toggle', '[data-t=show-cleaned]', { expect: async () => (await page.locator('.mvs .im img').first().getAttribute('src')) === img0 || 'image did not switch back' });
    check('multiview panels for body, head and both hands', (await page.locator('#refs-body, #refs-head, #refs-hand_left, #refs-hand_right').count()) === 4);
    check('each core panel has 4 slots', (await page.locator('#refs-body .mvs, #refs-head .mvs').count()) >= 8);
    await refreshState();
    if (busy) { check('reclassify / delete / upload are disabled while a pipeline process runs', !(await enabled('[data-t=reclassify]')) && !(await enabled('[data-t=choose-images]'))); }
    else {
      await act('reclassify editor opens', '[data-t=reclassify]', { expect: async () => (await exists('[data-t=ref-editor]')) || 'no editor' });
      await act('reclassify editor closes (Cancel)', '[data-t=edit-cancel]', { expect: async () => !(await exists('[data-t=ref-editor]')) || 'still open' });
    }

    // ═══ 6. parts + 3D viewer ═══
    section(`character ${CHAR}: parts + viewer`);
    await go(`/factory/characters/${CHAR}/parts`, '.partgrid');
    const partN = await page.locator('.pcard').count();
    check(`a card per part (${partN})`, partN >= Object.keys(D.generation).length && partN >= 2);
    for (const p of Object.keys(D.generation)) {
      const regen = `[data-t=part-${p}] [data-t=part-regenerate]`;
      if (await exists(regen)) await paidState(`Parts ${p} Regenerate`, regen, () => !busy && tripo, why());
      if (D.generation[p].sourceUrl) check(`Parts ${p} Download Source link`, (await page.locator(`[data-t=part-${p}] a[data-t=part-download]`).getAttribute('href')) === D.generation[p].sourceUrl);
    }
    if (D.generation.body?.sourceUrl) {
      await act('Inspect body source', '[data-t=part-body] [data-t=part-inspect]', { expect: async () => (await exists('[data-t=parts-viewer] [data-t=viewer-load]')) || 'no viewer gate' });
      check('viewer shows the download size before loading', /MB/.test(await page.locator('[data-t=parts-viewer] .gate').textContent()));
      if (VIEWER) {
        const glbReq = page.waitForRequest((q) => q.url().includes('model.glb'), { timeout: 60000 }).then(() => true, () => false);
        await act('viewer Load (real GLB download)', '[data-t=viewer-load]', { wait: 300, expect: async () => (await glbReq) || 'no GLB request within 60 s' });
        try {
          await page.locator('[data-t=parts-viewer] .vstats').waitFor({ state: 'visible', timeout: 240000 });
          const tris = await page.locator('[data-t=parts-viewer] .vstats .v').first().textContent();
          check(`viewer reports triangles from the loaded scene (${tris})`, +tris.replace(/,/g, '') > 100000);
          for (const m of ['clay', 'wire', 'normals', 'textured']) await act(`viewer mode ${m}`, `[data-t=mode-${m}]`, { expect: async () => (await page.locator(`[data-t=mode-${m}]`).getAttribute('class')) === 'on' || 'mode not active' });
          check('viewer Skeleton mode disabled for an unrigged source', await page.locator('[data-t=mode-skeleton]').isDisabled());
          await act('viewer Reset view', '[data-t=viewer-reset]', { expect: async () => true });
          await shot('viewer-source');
          await act('viewer Unload (frees GPU)', '[data-t=viewer-unload]', { expect: async () => (await exists('[data-t=viewer-load]')) || 'gate not back' });
        } catch (e) { fail('viewer loads the source GLB', e.message.split('\n')[0]); }
      } else skip('viewer load', '--no-viewer');
    }

    // ═══ 7. assembly, rig, animation, appearance, lods, court ═══
    section(`character ${CHAR}: other sections`);
    await go(`/factory/characters/${CHAR}/assembly`, '[data-t=sec-assembly].on');
    if (D.manifest.stages?.assemble?.report) {
      check('assembly: measurements table', await exists('[data-t=asm-table]'));
      check('assembly: head + both hands classified', (await page.locator('[data-t^=align-]').count()) === 3);
      await stateCheck('assembly: Re-run Assembly', '[data-t=asm-rerun]', () => !busy && S.assemble.status !== 'blocked', why('assemble'));
      check('assembly: viewer gated behind Load with the size shown', (await exists('[data-t=asm-viewer] [data-t=viewer-load]')) && /MB|GB/.test(await page.locator('[data-t=asm-viewer] .gate').textContent()));
      if (await exists('.gal figure img')) { await act('assembly render → lightbox', '.gal figure img', { expect: async () => (await exists('[data-t=lightbox]')) || 'no lightbox' }); await act('lightbox closes', '[data-t=lightbox]'); }
    } else check('assembly: empty state with an action', await exists('.empty2 [data-t=asm-run]'));
    await go(`/factory/characters/${CHAR}/rig`, '[data-t=sec-rig].on');
    await refreshState();
    if (await exists('[data-t=rig-rerig]')) { await paidState('Rig Re-Rig', '[data-t=rig-rerig]', () => !busy && S.rig.status !== 'blocked' && tripo, why('rig')); await stateCheck('rig: Re-import', '[data-t=rig-reimport]', () => !busy && S.import.status !== 'blocked', why('import')); }
    else await paidState('Rig empty state: Run Rigging', '[data-t=rig-run]', () => !busy && S.rig.status !== 'blocked' && tripo, why('rig'));
    await go(`/factory/characters/${CHAR}/animation`, '[data-t=roles-table]');
    check('animation: all clip roles listed', (await page.locator('[data-t=roles-table] tbody tr').count()) === Object.keys((await api('GET', '/api/mocap3d/library')).data.roles).length);
    const rep = D.manifest.stages?.preview?.report;
    check('animation: PASS shown only when the report says so', rep ? (await exists('[data-t=deform-pass]')) === !!rep.allPassed : !(await exists('[data-t=deform-pass]')));
    await stateCheck('animation: Run Validation', '[data-t=anim-validate]', () => !busy && S.preview.status !== 'blocked', why('preview'));
    await go(`/factory/characters/${CHAR}/appearance`, '[data-t=sec-appearance].on');
    if (await exists('[data-t=app-viewer]')) {
      check('appearance: textures table', await exists('[data-t=textures]'));
      check('appearance: Save needs a change', await page.locator('[data-t=mat-save]').isDisabled());
      const rampVal = () => page.locator('[data-t=mat-ramp]').locator('xpath=following-sibling::span').textContent();
      const r0 = await rampVal();
      await page.locator('[data-t=mat-ramp]').fill('0.8'); await page.waitForTimeout(250);
      check(`appearance: ramp slider moves the live value (${r0} → ${await rampVal()})`, (await rampVal()) === '0.80');
      await refreshState();
      await stateCheck('appearance: Save after a change', '[data-t=mat-save]', () => !busy, () => (busy ? 'busy: a pipeline process would overwrite the manifest' : ''));
      await act('appearance: Plain PBR preset', '[data-t=mat-pbr]', { expect: async () => (await rampVal()) === '0.00' || 'ramp not 0' });
      await act('appearance: Revert', '[data-t=mat-revert]', { expect: async () => ((await rampVal()) === r0 && (await page.locator('[data-t=mat-save]').isDisabled())) || 'not reverted' });
    } else check('appearance: empty state with an action (no game model)', await exists('.empty2 [data-t=app-gamemesh]'));
    await go(`/factory/characters/${CHAR}/lods`, '[data-t=sec-lods].on');
    await refreshState();
    if (Object.keys(D.lods || {}).length) { check('lods: table', await exists('[data-t=lods-table]')); if (D.courtUrl) await act('lods: Court check LOD1', '[data-t=lod-court-1]', { expect: async () => page.url().includes('/court?lod=1') || page.url() }); }
    else await paidState('lods empty state: Run Rigging', '[data-t=lods-rig]', () => !busy && S.rig.status !== 'blocked' && tripo, why('rig'));
    await go(`/factory/characters/${CHAR}/court`, '[data-t=sec-court].on');
    await refreshState();
    if (D.courtUrl) {
      await page.locator('[data-t=courtbox]').waitFor();
      await page.waitForFunction(() => !document.querySelector('.courtbox .cover:not(.err)'), null, { timeout: 90000 }).catch(() => {});
      if (await exists('[data-t=court-error]')) { check('court test: the court\'s own error is shown with actions', await exists('[data-t=court-record]')); check('court test: camera presets disabled while the court cannot run', await page.locator('[data-t=cam-front]').isDisabled()); }
      else { for (const c of ['front', '34', 'side', 'closeup', 'gameplay']) await act(`court camera ${c}`, `[data-t=cam-${c}]`, { expect: async () => (await page.locator(`[data-t=cam-${c}]`).getAttribute('class')).includes('on') || 'not active' }); }
    } else await paidState('court test empty state: Run the pipeline', '[data-t=court-resume]', () => !busy && !!next && ['ready', 'failed', 'stale', 'partial'].includes(S[next].status) && tripo, () => (busy ? 'busy' : next && `${next} ${S[next].status}`));

    // ═══ 8. create wizard with the throwaway character ═══
    section(`create wizard (${SMOKE})`);
    await go('/factory/create', '[data-t=f-name]');
    check('Create is disabled without a name', await page.locator('[data-t=wz-create]').isDisabled());
    await page.fill('[data-t=f-name]', 'ZZ UI Smoke'); await page.fill('[data-t=f-id]', SMOKE); await page.fill('[data-t=f-height]', '1.90');
    await act('quality tile Draft', '[data-t=q-draft]', { expect: async () => (await page.locator('[data-t=q-draft]').getAttribute('class')).includes('on') || 'not selected' });
    await act('Create character (POST)', '[data-t=wz-create]', { wait: 1200, expect: async () => page.url().includes(`id=${SMOKE}`) && page.url().includes('step=2') || page.url() });
    await page.setInputFiles('[data-t=file-input]', png);
    await page.locator('[data-t=upload-row] .tag.gr').first().waitFor({ timeout: 60000 }).then(() => pass('upload: file uploaded and classified (real byte progress, then the server result)'), (e) => fail('upload', e.message.split('\n')[0]));
    const classified = await page.locator('[data-t=upload-row]').first().textContent();
    check(`upload row shows the classification (${classified.replace(/\s+/g, ' ').slice(0, 90)})`, /→/.test(classified));
    await page.locator('.mvs [data-t=reclassify]').first().waitFor({ timeout: 20000 });
    await act('reclassify dropdown opens', '.mvs [data-t=reclassify]', { expect: async () => (await exists('[data-t=ref-editor]')) || 'no editor' });
    await act('reclassify dropdown closes', '[data-t=edit-cancel]', { expect: async () => !(await exists('[data-t=ref-editor]')) || 'still open' });
    await act('reclassify again', '.mvs [data-t=reclassify]');
    await page.selectOption('[data-t=edit-part]', 'body'); await page.selectOption('[data-t=edit-view]', 'left');
    await act('reclassify Save (PATCH, re-ingest)', '[data-t=edit-save]', { wait: 2500, expect: async () => ((await api('GET', `/api/cf/characters/${SMOKE}`)).data.references.some((r) => r.part === 'body' && r.view === 'left')) || 'reference not body/left' });
    await act('wizard → step 3', '[data-t=wz-next-3]', { expect: async () => page.url().includes('step=3') || page.url() });
    await page.locator('[data-t=validation]').waitFor();
    check('step 3: multiview panels', (await page.locator('#refs-body, #refs-head, #refs-hand_left, #refs-hand_right').count()) === 4);
    await page.setInputFiles('[data-t=slot-file-head-front]', png2);
    await page.locator('#refs-head [data-t=slot-head-front].missing').waitFor({ state: 'detached', timeout: 60000 }).then(() => pass('slot upload: head / front filled (part + view sent)'), (e) => fail('slot upload head/front', e.message.split('\n')[0]));
    const smokeD = (await api('GET', `/api/cf/characters/${SMOKE}`)).data;
    check('slot upload reached the API as head / front', smokeD.references.some((r) => r.part === 'head' && r.view === 'front'));
    await act('wizard progress → step 4', '[data-t=prog-4]', { expect: async () => page.url().includes('step=4') || page.url() });
    await page.locator('[data-t=wz-start]').waitFor();
    const v = smokeD.manifest.validation;
    refreshState = async () => {};
    await paidState('wizard Start build', '[data-t=wz-start]', !!(tripo && v && v.ok && smokeD.references.length), v && !v.ok ? 'validation blocked' : '');
    await shot('create-review');
    await act('wizard Save as draft', '[data-t=wz-draft]', { expect: async () => new URL(page.url()).pathname === `/factory/characters/${SMOKE}` || page.url() });

    // ═══ 9. a free job on the smoke character, jobs pages ═══
    section('jobs (validate on the smoke character)');
    await go(`/factory/characters/${SMOKE}/references`, '[data-t=validate]');
    await act('Validate references (op validate, free)', '[data-t=validate]', { wait: 1200, expect: async () => lastReqs.some((r) => r.startsWith('POST') && r.includes(`/characters/${SMOKE}/jobs`)) || 'no job request' });
    check('validate job finished', await waitNoJob(SMOKE, 90000));
    const jobs = (await api('GET', `/api/cf/jobs?character=${SMOKE}`)).data.jobs;
    check(`validate job recorded (${jobs[0]?.status})`, jobs[0]?.op === 'validate' && ['done', 'failed'].includes(jobs[0]?.status));
    await go('/factory/jobs', '[data-t=jobs-table]');
    await act('jobs Refresh', '[data-t=jobs-refresh]', { expect: async () => lastReqs.some((r) => r.includes('/api/cf/jobs')) || 'no request' });
    await act('jobs filter Done', '[data-t=jf-done]', { expect: async () => page.url().includes('status=done') || page.url() });
    await act('jobs filter All', '[data-t=jf-all]', { expect: async () => !page.url().includes('status=') || page.url() });
    await page.selectOption('[data-t=jobs-character]', SMOKE); await page.waitForTimeout(300);
    check('jobs character filter (URL)', page.url().includes(`character=${SMOKE}`));
    await act('open job detail', '[data-t=job-open]', { expect: async () => /\/factory\/jobs\/[a-z0-9-]+$/.test(new URL(page.url()).pathname) || page.url() });
    await page.locator('[data-t=log]').waitFor();
    check('job detail shows the log tail', ((await page.locator('[data-t=log]').textContent()) || '').length > 10);
    await act('job log Refresh', '[data-t=log-refresh]', { expect: async () => lastReqs.some((r) => /\/api\/cf\/jobs\/[a-z0-9-]+$/.test(r.split(' ')[1])) || 'no request' });
    await shot('job-detail');
    await page.goBack(); await page.waitForTimeout(300);
    check('back from job detail → filtered list', page.url().includes(`character=${SMOKE}`));

    // ═══ 10. duplicate + delete dialog on the smoke character ═══
    section('duplicate + delete dialog (smoke character)');
    await go('/factory', `[data-t=card-${SMOKE}]`);
    await act('Duplicate (POST)', `[data-t=card-${SMOKE}] [data-t=card-duplicate]`, { wait: 3000, expect: async () => ((await api('GET', '/api/cf/characters')).data.characters.some((c) => c.id.startsWith(SMOKE + '_'))) || 'no copy created' });
    await act('Delete opens a typed confirmation', `[data-t=card-${SMOKE}] [data-t=card-delete]`, { expect: async () => (await exists('[data-t=typed-confirm]')) || 'no typed confirmation' });
    check('Delete confirm is disabled until the id is typed', await page.locator('[data-t=dialog-ok]').isDisabled());
    await page.fill('[data-t=typed-confirm]', 'wrong-id'); check('wrong id keeps it disabled', await page.locator('[data-t=dialog-ok]').isDisabled());
    await page.fill('[data-t=typed-confirm]', SMOKE); check('typing the id enables it', !(await page.locator('[data-t=dialog-ok]').isDisabled()));
    await act('Delete dialog Cancel (deleted through the API below instead)', '[data-t=dialog-cancel]', { expect: async () => !(await exists('.modal')) || 'still open' });

    // ═══ 11. settings, moves, playground ═══
    section('settings');
    await go('/factory/settings', '[data-t=quality-table]');
    await act('Tripo Refresh balance', '[data-t=tripo-refresh]', { wait: 2500, expect: async () => lastReqs.some((r) => r.includes('/api/cf/status?refresh=1')) || 'no refresh request' });
    check('quality presets table has 3 presets', (await page.locator('[data-t=quality-table] tbody tr').count()) === 3);
    await act('CLI command Copy', '[data-t=copy]', { expect: async () => ((await page.locator('[data-t=copy]').first().textContent()) === 'copied') || 'not copied' });
    check('providers: GPT Image / Higgsfield marked not connected (no buttons)', (await page.locator('.prov .off').count()) === 2 && (await page.locator('.prov button').count()) === 0);
    if (!STATUS.tripo.configured) check('settings shows the TRIPO_API_KEY instruction', /TRIPO_API_KEY=/.test(await page.textContent('main')));
    section('moves');
    await go('/factory/moves', '.slots');
    await act('category Locomotion', '[data-t=cat-locomotion]', { expect: async () => page.url().includes('group=locomotion') || page.url() });
    await act('select a role', '.slots .slot', { expect: async () => (page.url().includes('role=') && (await exists('[data-t=role-pick]'))) || page.url() });
    check('Record links to the capture page', (await page.locator('[data-t=role-record]').getAttribute('href')) === '/mocap');
    await page.goBack(); await page.waitForTimeout(250);
    check('back → role deselected', !page.url().includes('role='));
    section('playground');
    await go('/factory/playground', '[data-t=courtbox]');
    const roster = (await api('GET', '/api/mocap3d/characters')).data.characters;
    check(`player strip = the court's rigs (${roster.length})`, (await page.locator('.pscard').count()) === roster.length);
    if (roster[1]) await act(`player ${roster[1].id}`, `[data-t=player-${roster[1].id}]`, { expect: async () => page.url().includes(`char=${roster[1].id}`) && (await page.locator('.courtbox iframe').getAttribute('src')).includes(`char=${roster[1].id}`) || page.url() });
    await act('court VANTHEAH', '[data-t=court-vantheah]', { expect: async () => page.url().includes('court=vantheah') || page.url() });
    await act('court Classic', '[data-t=court-classic]', { expect: async () => !page.url().includes('court=vantheah') || page.url() });
    await page.waitForFunction(() => !document.querySelector('.courtbox .cover.loading'), null, { timeout: 90000 }).catch(() => {});
    if (await exists('[data-t=court-error]')) {
      check('playground: the court\'s own error is surfaced (no fake success)', /could not start/i.test(await page.locator('[data-t=court-error]').textContent()));
      check('playground: camera presets disabled while the court cannot run', await page.locator('[data-t=pcam-front]').isDisabled());
      await act('court Retry reloads the court', '[data-t=court-retry]', { wait: 800, expect: async () => lastReqs.some((r) => r.includes('/court3d')) || 'no reload' });
    } else {
      for (const c of ['front', 'side', 'gameplay']) await act(`playground camera ${c}`, `[data-t=pcam-${c}]`, { expect: async () => (await page.locator(`[data-t=pcam-${c}]`).getAttribute('class')) === 'on' || 'not active' });
    }
    await shot('playground');
  } catch (e) { fail(`unexpected: ${step}`, e.stack); }

  // ═══ result ═══
  section('guards + errors');
  check('no paid / destructive request left the browser outside the smoke character', !guarded.length, guarded.join(' | '));
  check('no page errors / console errors / 5xx', !errors.length, errors.slice(0, 12).join('\n      '));
  await browser.close();
  section('cleanup');
  await removeSmoke();
  const left = (await api('GET', '/api/cf/characters')).data.characters.filter((c) => c.id.startsWith(SMOKE));
  check('smoke characters deleted through the API', !left.length, left.map((c) => c.id).join(', '));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${R.fail ? 'FAILED' : 'PASSED'} — ${R.pass} passed, ${R.fail} failed, ${R.skip} skipped`);
  if (R.fails.length) console.log(R.fails.map((f) => '  ✕ ' + f).join('\n'));
  process.exit(R.fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await removeSmoke(); } catch {} process.exit(1); });
