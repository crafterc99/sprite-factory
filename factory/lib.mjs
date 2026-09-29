/**
 * Character Factory UI core: API calls, History-API router, a tiny shared store (factory status,
 * jobs, toasts, dialogs), polling hooks and display formatters. Every status shown in the UI comes
 * from the API; the maps below only turn API values into labels.
 */
import { useState, useEffect, useRef, useCallback } from '/factory/ui/preact-htm.mjs';

// ═══ API ═══
export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
async function parse(r) {
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = { error: t.slice(0, 400) }; }
  if (!r.ok) throw new ApiError(r.status, (d && d.error) || `${r.status} ${r.statusText}`, d);
  return d;
}
export async function jget(url, { signal } = {}) {
  let r;
  try { r = await fetch(url, { cache: 'no-store', signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, `the server did not answer (${e.message}) — is it running?`); }
  return parse(r);
}
export async function jsend(method, url, body) {
  let r;
  try { r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new ApiError(0, `the server did not answer (${e.message})`); }
  return parse(r);
}
/** Raw image upload with real byte progress (XHR). */
export function uploadReference(id, file, { part, view, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ name: file.name });
    if (part) q.set('part', part);
    if (view) q.set('view', view);
    const x = new XMLHttpRequest();
    x.open('POST', `/api/cf/characters/${encodeURIComponent(id)}/references?${q}`);
    x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    x.upload.onload = () => onProgress && onProgress(file.size, file.size, true);
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch { d = { error: x.responseText.slice(0, 300) }; }
      if (x.status >= 200 && x.status < 300) resolve(d); else reject(new ApiError(x.status, (d && d.error) || `upload failed (${x.status})`, d));
    };
    x.onerror = () => reject(new ApiError(0, 'the upload did not reach the server'));
    x.send(file);
  });
}
export const fileUrl = (id, rel) => `/api/cf/characters/${encodeURIComponent(id)}/file?path=${encodeURIComponent(rel)}`;

// ═══ router ═══
const routeSubs = new Set();
export function navigate(to, { replace = false } = {}) {
  const cur = location.pathname + location.search + location.hash;
  if (to === cur) return;
  const samePath = new URL(to, location.origin).pathname === location.pathname;
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  routeSubs.forEach((f) => f());
  if (!samePath && !replace) window.scrollTo(0, 0);
}
export function useLocation() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    routeSubs.add(f); window.addEventListener('popstate', f);
    return () => { routeSubs.delete(f); window.removeEventListener('popstate', f); };
  }, []);
  return { path: location.pathname.replace(/\/+$/, '') || '/', q: new URLSearchParams(location.search), hash: location.hash };
}
/** Internal links: any <a href="/factory…"> without target/modifiers goes through the router. */
export function interceptLinks(root = document) {
  root.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith('/factory') || href.startsWith('/factory/ui/')) return;
    e.preventDefault();
    navigate(href);
  });
}
export function setQuery(patch, { replace = true } = {}) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') q.delete(k); else q.set(k, v); }
  const s = q.toString();
  navigate(location.pathname + (s ? '?' + s : ''), { replace });
}

// ═══ store ═══
export const store = {
  state: { status: null, statusError: null, jobs: null, jobsError: null, tick: 0, toasts: [], dialog: null, lightbox: null },
  subs: new Set(),
  set(p) { Object.assign(this.state, p); this.subs.forEach((f) => f()); },
};
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((x) => x + 1); store.subs.add(f); return () => store.subs.delete(f); }, []);
  return store.state;
}
/** Data changed server-side (a job ended, an action succeeded): pages reload what they show. */
export const bump = () => store.set({ tick: store.state.tick + 1 });

let toastId = 0;
export function toast(msg, { tone = '', action = null, ms = 5200 } = {}) {
  const t = { id: ++toastId, msg, tone, action };
  store.set({ toasts: [...store.state.toasts.slice(-3), t] });
  setTimeout(() => store.set({ toasts: store.state.toasts.filter((x) => x.id !== t.id) }), ms);
}
export const dismissToast = (id) => store.set({ toasts: store.state.toasts.filter((x) => x.id !== id) });
/** Confirmation dialog → Promise<boolean>. `typed`: the text the user must type to enable confirm. */
export function ask({ title, body, confirm = 'Confirm', tone = '', typed = null }) {
  return new Promise((resolve) => store.set({ dialog: { title, body, confirm, tone, typed, resolve: (v) => { store.set({ dialog: null }); resolve(v); } } }));
}
export const openLightbox = (src, caption) => store.set({ lightbox: { src, caption } });

// factory status (Tripo, Blender, limits…) and the job list, shared by every page
export async function loadStatus(refresh = false) {
  try { store.set({ status: await jget('/api/cf/status' + (refresh ? '?refresh=1' : '')), statusError: null }); }
  catch (e) { store.set({ statusError: e.message }); }
  return store.state.status;
}
let prevJobs = null;
export async function loadJobs() {
  try {
    const { jobs } = await jget('/api/cf/jobs?limit=200');
    // jobs that stopped since the last poll: say so and let pages reload
    if (prevJobs) {
      const was = new Map(prevJobs.map((j) => [j.id, j.status]));
      const ended = jobs.filter((j) => ['running', 'queued'].includes(was.get(j.id)) && !['running', 'queued'].includes(j.status));
      for (const j of ended) toast(`${opLabel(j.op)}${j.part ? ' ' + j.part : ''} · ${j.character}: ${j.status}${j.error ? ' — ' + j.error.split('\n')[0].slice(0, 120) : ''}`, { tone: j.status === 'done' ? 'ok' : 'bad', action: { label: 'Open job', href: `/factory/jobs/${j.id}` }, ms: 9000 });
      if (ended.length || jobs.length !== prevJobs.length) bump();
    }
    prevJobs = jobs;
    store.set({ jobs, jobsError: null });
  } catch (e) { store.set({ jobsError: e.message }); }
}
export const activeJobs = (jobs) => (jobs || []).filter((j) => j.status === 'running' || j.status === 'queued');

/** Starts a pipeline job; returns the job or null. Paid ops must be confirmed by the caller first. */
export async function startJob(character, op, part) {
  try {
    const j = await jsend('POST', `/api/cf/characters/${encodeURIComponent(character)}/jobs`, part ? { op, part } : { op });
    toast(`Started ${opLabel(op)}${part ? ' · ' + part : ''} for ${character}`, { tone: 'ok', action: { label: 'Follow job', href: `/factory/jobs/${j.id}` } });
    await loadJobs(); bump();
    return j;
  } catch (e) {
    if (e.status === 412) {
      await ask({ title: 'Tripo is not configured', tone: 'danger', confirm: 'OK', body: `${e.message}. ${e.data?.action || ''}. Settings shows the exact steps.` });
      navigate('/factory/settings');
    } else if (e.status === 409) toast(`Not started: ${e.message}`, { tone: 'bad', action: { label: 'Jobs', href: '/factory/jobs' } });
    else toast(`Could not start ${opLabel(op)}: ${e.message}`, { tone: 'bad' });
    return null;
  }
}

// ═══ hooks ═══
/** GET JSON with optional polling; skips polls while the tab is hidden. `poll` may change per render. */
export function useJson(url, { poll = 0, deps = [] } = {}) {
  const [s, set] = useState({ data: null, error: null, loading: !!url, status: 0, url });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    try { const d = await jget(url); if (n === seq.current) set({ data: d, error: null, loading: false, status: 200, url }); }
    catch (e) { if (n === seq.current) set((o) => ({ data: e.status === 404 ? null : o.data, error: e.message, loading: false, status: e.status, url })); }
  }, [url]);
  // a new URL starts empty (never shows another character's data); a reload keeps what is shown
  useEffect(() => { set((o) => (o.url === url ? { ...o, loading: true } : { data: null, error: null, loading: !!url, status: 0, url })); reload(); }, [url, ...deps]);
  useEffect(() => {
    if (!poll || !url) return;
    const t = setInterval(() => { if (!document.hidden) reload(); }, poll);
    return () => clearInterval(t);
  }, [url, poll, reload]);
  return { ...s, reload };
}
/** Re-renders every `ms` (live elapsed times). */
export function useNow(ms = 1000, on = true) {
  const [n, set] = useState(Date.now());
  useEffect(() => { if (!on) return; const t = setInterval(() => set(Date.now()), ms); return () => clearInterval(t); }, [ms, on]);
  return n;
}

// ═══ formatting ═══
export const fmtNum = (n) => (n == null || Number.isNaN(+n) ? '—' : Math.round(+n).toLocaleString('en-US'));
export const fmtK = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : fmtNum(n));
export function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
export function fmtDur(sec) {
  if (sec == null || Number.isNaN(+sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const toMs = (d) => (d == null ? null : typeof d === 'number' ? d : Date.parse(d));
export function fmtAgo(d, now = Date.now()) {
  const t = toMs(d); if (!t) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 14) return Math.round(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString();
}
export function fmtTime(d) {
  const t = toMs(d); if (!t) return '—';
  const x = new Date(t), today = new Date();
  const hm = x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return x.toDateString() === today.toDateString() ? hm : `${x.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}
export const secondsBetween = (a, b) => { const x = toMs(a), y = toMs(b); return x && y ? (y - x) / 1000 : null; };
export const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

// ═══ pipeline vocabulary (labels only; statuses come from the API) ═══
export const STAGES = ['ingest', 'validate', 'generate', 'assemble', 'gamemesh', 'rig', 'import', 'lods', 'preview', 'courttest'];
export const STAGE_LABEL = { ingest: 'References', validate: 'Validation', generate: 'Source generation', assemble: 'Assembly', gamemesh: 'Game mesh + bake', rig: 'Rig', import: 'Soul Jam skeleton', lods: 'LODs', preview: 'Animation + deformation', courttest: 'Court test' };
export const STAGE_OP = { validate: 'validate', assemble: 'assemble', gamemesh: 'gamemesh', rig: 'rig', import: 'import', lods: 'lods', preview: 'preview', courttest: 'courttest' };
export const PAID_STAGES = new Set(['generate', 'rig']);
export const PAID_OPS = new Set(['build', 'resume', 'generate', 'rig']);
const OP_LABEL = { build: 'Build', resume: 'Resume', generate: 'Generate', assemble: 'Assembly', gamemesh: 'Game mesh', rig: 'Rig', import: 'Import', lods: 'LODs', validate: 'Validate references', preview: 'Deformation validation', courttest: 'Court test' };
export const opLabel = (op) => OP_LABEL[op] || op;
export const CORE_PARTS = ['body', 'head', 'hand_left', 'hand_right'];
export const OPTIONAL_PARTS = ['hair', 'shoes', 'clothing', 'accessory'];
export const PART_LABEL = { body: 'Body', head: 'Head', hand_left: 'Left hand', hand_right: 'Right hand', hair: 'Hair', shoes: 'Shoes', clothing: 'Clothing', accessory: 'Accessory', hands: 'Two-hand sheet', unknown: 'Unassigned' };
export const partLabel = (p) => PART_LABEL[p] || p;
/** Multiview slots per part: the `view` value sent to the API for an upload into that slot. */
export const SLOTS = {
  body: [['front', 'Front'], ['left', 'Left'], ['back', 'Back'], ['right', 'Right']],
  head: [['front', 'Front'], ['left', 'Left'], ['back', 'Back'], ['right', 'Right']],
  hand_left: [['back', 'Front', 'back of hand'], ['palm', 'Back', 'palm'], ['thumb', 'Thumb side'], ['pinky', 'Pinky side']],
  hand_right: [['back', 'Front', 'back of hand'], ['palm', 'Back', 'palm'], ['thumb', 'Thumb side'], ['pinky', 'Pinky side']],
};
/** Which slot a reference fills (hand "front"/"back-of-hand" are the back of the hand, as the pipeline reads them). */
export function slotOf(part, view) {
  if (part.startsWith('hand_')) return { back: 'back', 'hand-back': 'back', 'back-of-hand': 'back', front: 'back', palm: 'palm', thumb: 'thumb', pinky: 'pinky' }[view] || null;
  return ['front', 'left', 'back', 'right'].includes(view) ? view : null;
}
export const VIEW_OPTIONS = {
  body: [['front', 'Front'], ['left', 'Left'], ['back', 'Back'], ['right', 'Right'], ['3/4', '3/4'], ['unknown', 'Unknown']],
  hand: [['back', 'Back of hand (front)'], ['palm', 'Palm (back)'], ['thumb', 'Thumb side'], ['pinky', 'Pinky side']],
};
export const viewOptionsFor = (part) => (part && (part.startsWith('hand') || part === 'hands') ? VIEW_OPTIONS.hand : VIEW_OPTIONS.body);
export const PART_OPTIONS = [...CORE_PARTS, 'hands', ...OPTIONAL_PARTS];

export const STAGE_TONE = { done: 'gr', running: 'run', ready: '', stale: 'yl', blocked: 'gy', failed: 'rd', partial: 'yl', missing: 'gy', interrupted: 'yl', queued: 'run', cancelled: 'gy', success: 'gr' };
export const PIPE_TONE = (s) => (s === 'GAME_READY' ? 'gr' : s === 'FAILED' ? 'bad' : ['GENERATING_SOURCE', 'ASSEMBLING', 'OPTIMIZING', 'RIGGING', 'ANIMATION_VALIDATION', 'COURT_VALIDATION'].includes(s) ? 'warn' : ['DRAFT', 'REFERENCES_INCOMPLETE'].includes(s) ? '' : 'ok');
export const JOB_TONE = { running: 'run', queued: 'run', done: 'gr', failed: 'rd', cancelled: 'gy', interrupted: 'yl' };

/** A character is busy when a job holds it or a pipeline process (CLI) is running a stage. */
export function busyOf(d) {
  if (!d) return null;
  if (d.summary?.job) return `a ${opLabel(d.summary.job.op).toLowerCase()} job is ${d.summary.job.status}`;
  const run = STAGES.find((s) => d.state?.stages?.[s]?.status === 'running');
  if (run) return `a pipeline process is running ${STAGE_LABEL[run]}`;
  return null;
}
export const tripoReady = (st) => !!st?.tripo?.configured;
/** Credits of past generate tasks across the character's own log (real history). */
export function creditHistory(logs) {
  const gen = logs.filter((l) => /^generate /.test(l.what) && l.credits != null).map((l) => +l.credits);
  if (!gen.length) return null;
  return { n: gen.length, min: Math.min(...gen), max: Math.max(...gen), avg: gen.reduce((a, b) => a + b, 0) / gen.length };
}
export const HISTORY_NOTE = 'Tripo reports exact credits after each task; the first character cost 70 credits per high-detail part.';
export const SKELETON = { name: 'SOUL_JAM_MASTER_SKELETON', joints: 127, mapping: 'tools/character_pipeline/tripo_to_souljam_bones.json' };
export const hashColor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; const p = ['#6A2AA6', '#FF8A4E', '#3f9b5a', '#1f8fb0', '#d9982a', '#b3121f', '#8A4536', '#5E6B4E']; return p[Math.abs(h) % p.length]; };
