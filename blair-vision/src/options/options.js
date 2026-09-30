// @ts-nocheck -- DOM form wiring; typed access to every element adds noise, covered by e2e.
import { MSG } from '../shared/messages.js';
import { createStore } from '../shared/storage.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { averageLatency, formatCost } from '../shared/cost.js';

const store = createStore(chrome.storage.local);
const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'provider' && k !== 'costPerCallUsd');

function showProvider(p) {
  document.querySelectorAll('[data-for]').forEach((d) => { d.hidden = d.dataset.for !== p; });
}

async function load() {
  const s = await store.getSettings();
  document.querySelector(`input[name=provider][value=${s.provider}]`).checked = true;
  showProvider(s.provider);
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k];
  }
  $('fallbackFields').hidden = !s.reasoningFallback;
}

let saveTimer;
async function doSave() {
    const patch = { provider: document.querySelector('input[name=provider]:checked').value };
    for (const k of FIELDS) {
      const el = $(k);
      if (!el) continue;
      if (el.type === 'checkbox') patch[k] = el.checked;
      else if (el.type === 'number') patch[k] = Number(el.value);
      else patch[k] = el.value.trim();
    }
    await store.saveSettings(patch);
    $('saved').textContent = 'Saved.';
    setTimeout(() => { $('saved').textContent = ''; }, 1200);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 250);
}

async function renderStats() {
  const s = await store.getStats();
  const rows = [
    ['Questions analyzed', s.questionsAnalyzed], ['Cache hits', s.cacheHits], ['Jev calls', s.jevCalls],
    ['Fallback calls', s.fallbackCalls], ['Estimated cost', formatCost(s.estimatedCost)],
    ['Average latency', `${averageLatency(s)} ms`], ['Errors', s.errors],
  ];
  $('stats').replaceChildren(...rows.map(([k, v]) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td'); b.textContent = String(v);
    tr.append(a, b);
    return tr;
  }));
  $('cacheInfo').textContent = `${await store.cacheSize()} cached questions`;
}

document.querySelectorAll('input, textarea').forEach((el) => {
  el.addEventListener('change', () => {
    if (el.name === 'provider') showProvider(el.value);
    if (el.id === 'reasoningFallback') $('fallbackFields').hidden = !el.checked;
    save();
  });
});
$('test').onclick = async () => {
  clearTimeout(saveTimer);
  await doSave(); // make sure the latest key/endpoint is stored before testing
  const out = $('testResult');
  out.className = ''; out.textContent = 'Testing…';
  const r = await chrome.runtime.sendMessage({ type: MSG.TEST_CONNECTION });
  if (r.ok) { out.className = 'ok'; out.textContent = `OK — chose ${r.answer} (${Math.round(r.confidence * 100)}%) in ${r.latencyMs} ms`; }
  else { out.className = 'bad'; out.textContent = r.error; }
  renderStats();
};
$('clearCache').onclick = async () => { await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE }); renderStats(); };
$('resetStats').onclick = async () => { await chrome.runtime.sendMessage({ type: MSG.RESET_STATS }); renderStats(); };
chrome.storage.onChanged.addListener((c) => { if (c.bv_stats || c.bv_cache) renderStats(); });

load().then(renderStats);
