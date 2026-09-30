// End-to-end test: loads the BUILT extension (dist/) into real Chromium, serves the demo page and a MOCK Jev
// endpoint, and checks HUD answers, live following, cache, duplicate-call prevention, pause/disable and privacy gating.
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServers } from './dev-server.mjs';

const dist = resolve('dist');
const chromePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
const shots = resolve('e2e-shots');
mkdirSync(shots, { recursive: true });
const DEMO = 'http://localhost:8788/practice-quiz.html';
const MOCK = 'http://localhost:8787';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = async () => (await (await fetch(`${MOCK}/stats`)).json()).calls;

const servers = await startServers({ quiet: true });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bv-')), {
  executablePath: chromePath, headless: false,
  args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox', '--window-size=1200,900'],
  viewport: { width: 1100, height: 800 },
});
try {
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ typesafeEndpoint: 'http://localhost:8787/v1/systemone', typesafeKey: 'mock-key', debug: true, heartbeatSec: 2 }));

  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(DEMO);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost:8788/*' }))[0].id);

  // ---- privacy: nothing happens until enabled ----
  await page.click('#next'); await sleep(1500); await page.click('#prev'); await sleep(500);
  ok((await calls()) === 0, 'not enabled: zero API calls');
  ok((await page.locator('#blair-vision-host').count()) === 0, 'not enabled: no HUD injected');
  const before = await page.evaluate(() => 1); void before;

  // ---- enable via the popup, like the user would ----
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await popup.click('#enable');
  await popup.waitForSelector('#disable:not([hidden])', { timeout: 3000 });
  await page.bringToFront();

  const hud = () => page.evaluate(() => {
    const h = document.getElementById('blair-vision-host');
    if (!h) return null;
    const r = h.shadowRoot.querySelector('.root');
    return { kind: r.dataset.kind, text: h.shadowRoot.querySelector('.pill').textContent.trim() };
  });
  const cnt = () => page.evaluate(() => +document.getElementById('s-ans').textContent);
  // Waits for a FRESH answer event (counter increments) and returns what the HUD shows.
  const waitAnswer = async (prev, timeout = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ((await cnt()) > prev) { const h = await hud(); return { ...h, ms: Date.now() - t0 }; }
      await sleep(15);
    }
    return null;
  };
  const step = async (sel) => { const prev = await cnt(); await page.click(sel); return waitAnswer(prev); };
  const expected = () => page.evaluate(() => window.__demoExpected());

  let h = await waitAnswer(0);
  ok(h && h.text === await expected(), `Q1 HUD shows ${h?.text} (expected ${await expected()})`);
  await page.screenshot({ path: join(shots, '1-answer.png') });

  // ---- walk all 12 questions with Next ----
  const latencies = [];
  for (let n = 2; n <= 12; n++) {
    const prev = await cnt();
    await page.click('#next');
    const t0 = Date.now();
    await sleep(60);
    const mid = await hud();
    if (n === 2) ok(mid.kind !== 'result' || mid.text !== 'C' || (await cnt()) > prev, `60ms after Next the HUD no longer shows the old answer (kind=${mid.kind})`);
    h = await waitAnswer(prev);
    const exp = await expected();
    latencies.push(Date.now() - t0);
    ok(h && h.text === exp, `Q${n} HUD shows ${h?.text} (expected ${exp})`);
    if (n === 3) await page.screenshot({ path: join(shots, '2-q3.png') });
  }
  const apiAfterForward = await calls();
  ok(apiAfterForward === 11, `12 questions incl. one repeat (Q9 = Q3, reordered) -> 11 API calls (got ${apiAfterForward})`);
  const stat = await page.evaluate(() => ({ api: +document.getElementById('s-api').textContent, hits: +document.getElementById('s-cache').textContent }));
  ok(stat.hits >= 1, `demo page counters: ${stat.api} API calls, ${stat.hits} cache hit(s)`);

  // ---- go all the way back: everything is cached -> zero new calls ----
  for (let n = 11; n >= 1; n--) { h = await step('#prev'); ok(h && h.text === await expected(), `back to Q${n}: ${h?.text} from cache`); }
  ok((await calls()) === apiAfterForward, `revisiting all questions: zero new API calls (still ${await calls()})`);

  // ---- idle: heartbeats with unchanged question make no requests ----
  await sleep(7000);
  ok((await calls()) === apiAfterForward, 'idle 7s with 2s heartbeat: zero new API calls');

  // ---- HUD expand + drag persistence ----
  const box = await page.evaluate(() => { const r = document.getElementById('blair-vision-host').shadowRoot.querySelector('.pill').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.w / 2 - 200, box.y + box.h / 2 + 150, { steps: 6 }); await page.mouse.up();
  await sleep(300);
  const saved = await sw.evaluate(() => chrome.storage.local.get('bv_hud_position'));
  ok(saved.bv_hud_position && Math.abs(saved.bv_hud_position.x - (box.x - 200)) < 12 && Math.abs(saved.bv_hud_position.y - (box.y + 150)) < 12, `HUD dragged and position saved ${JSON.stringify(saved.bv_hud_position)} (start ${Math.round(box.x)},${Math.round(box.y)})`);
  await page.hover('body', { position: { x: 1, y: 1 } });
  await page.mouse.move(box.x - 200 + box.w / 2, box.y + 150 + box.h / 2); await sleep(500);
  const panel = await page.evaluate(() => document.getElementById('blair-vision-host').shadowRoot.querySelector('.panel').innerText);
  ok(/Answer/.test(panel) && /Confidence/.test(panel) && /latency/i.test(panel) && /Cost/.test(panel), `expanded HUD shows details: ${JSON.stringify(panel.split('\n').slice(0, 6))}`);
  await page.screenshot({ path: join(shots, '3-expanded.png') });

  // ---- pause: changes are ignored; resume: follows again ----
  await popup.bringToFront(); await popup.click('#pause'); await sleep(300); await page.bringToFront();
  ok((await hud()).kind === 'paused', 'paused: HUD shows paused');
  const c0 = await calls();
  await page.click('#next'); await sleep(1200);
  ok((await calls()) === c0 && (await hud()).kind === 'paused', 'paused: question change causes zero calls');
  const beforeResume = await cnt();
  await popup.bringToFront(); await popup.click('#pause'); await sleep(300); await page.bringToFront();
  h = await waitAnswer(beforeResume); ok(h && h.text === await expected(), 'resume: HUD follows again');

  // ---- disable removes the HUD ----
  await popup.bringToFront(); await popup.click('#disable'); await sleep(400); await page.bringToFront();
  ok((await page.locator('#blair-vision-host').count()) === 0, 'disabled: HUD removed');
  const c1 = await calls(); await page.click('#prev'); await sleep(1500);
  ok((await calls()) === c1, 'disabled: zero calls');

  // ---- debug logging ----
  const blair = logs.filter((l) => l.startsWith('[Blair]'));
  ok(blair.some((l) => /candidate question found/.test(l)) && blair.some((l) => /fingerprint:/.test(l)) && blair.some((l) => /Answer [A-D1-4] confidence=/.test(l)) && blair.some((l) => /HUD updated/.test(l)), `debug logs present (${blair.length} lines)`);
  console.log('  sample log:', blair.slice(0, 6).join(' | '));

  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  console.log(`\nNext -> HUD answer latency (mock Jev 150-350ms): avg ${avg} ms, max ${Math.max(...latencies)} ms`);

  // ---- disabled-by-default: extension without debug leaves console clean ----
  await sw.evaluate(() => chrome.storage.local.set({ debug: false }));
  const page2 = await ctx.newPage(); const quiet = [];
  page2.on('console', (m) => quiet.push(m.text()));
  await page2.goto(DEMO);
  await popup.bringToFront();
  const tab2 = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost:8788/*' })).at(-1).id);
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tab2}`); await popup.click('#enable');
  await page2.bringToFront(); await sleep(2500);
  ok(!quiet.some((l) => l.startsWith('[Blair]')), 'debug off: console stays clean');
} catch (e) {
  console.error(e); failed++;
} finally {
  await ctx.close(); servers.close();
}
console.log(failed ? `\n${failed} e2e check(s) FAILED` : '\nAll e2e checks passed');
process.exit(failed ? 1 : 0);
