/**
 * The real Soul Jam court (/court3d, same origin) in an iframe, driven through its test hooks:
 * window.__court3d (camFixed, charLod, player) and window.__c3dTest (poseClip, release, clips, kp,
 * facing, lod). Nothing is simulated here: when the court cannot start, its own error is shown.
 */
import { html, useState, useEffect, useRef, useCallback } from '/factory/ui/preact-htm.mjs';
import { useStore } from '/factory/ui/lib.mjs';

export const CAMS = [['front', 'Front'], ['34', '3/4'], ['side', 'Side'], ['closeup', 'Closeup'], ['gameplay', 'Gameplay']];
/** Pose / animation buttons → the court's real roles (first one the court has is used). */
export const POSES = [
  { key: 'idle', label: 'Idle', roles: ['idle'], how: 'play' },
  { key: 'run', label: 'Run', roles: ['loco-sprint'], how: 'play' },
  { key: 'dribble', label: 'Dribble', roles: ['loco-fwd'], how: 'play' },
  { key: 'shoot', label: 'Shoot', roles: ['shot-jumper', 'shot-stepback'], how: 'play' },
  { key: 'jump', label: 'Jump', roles: ['shot-jumper', 'shot-stepback'], how: 'hold', frac: 0.55 },
];
export const courtSrc = (char, { court = 'classic', lod } = {}) => `/court3d?char=${encodeURIComponent(char)}&court=${court}${lod != null && lod !== '' ? `&lod=${lod}` : ''}`;

export function useCourt() {
  const ref = useRef(null);
  const [st, set] = useState({ phase: 'loading', msg: 'starting the court…', err: null, fps: null, lod: null, clips: [], ready: false });
  const anim = useRef({ raf: 0, cycle: 0 });
  const [active, setActive] = useState(null);   // pose key playing / held, 'live', or cycle
  const [cam, setCam] = useState('gameplay');

  // read the court's own state twice a second
  useEffect(() => {
    const t = setInterval(() => {
      const f = ref.current; if (!f) return;
      let w, d;
      try { w = f.contentWindow; d = w && w.document; } catch { return; }
      if (!d || !d.body) return;
      const e = d.getElementById('err');
      const errText = e && e.getAttribute('data-src') === 'error' && e.firstChild ? String(e.firstChild.textContent || '').trim() : null;
      const ready = !!(w.__c3dReady && w.__c3dTest && w.__court3d);
      let clips = [], lod = null;
      if (ready) { try { clips = w.__c3dTest.clips(); } catch {} try { lod = w.__court3d.charLod || w.__c3dTest.lod(); } catch {} }
      const fps = d.getElementById('fps')?.textContent?.trim() || null;
      const msg = d.getElementById('loadMsg')?.textContent || '';
      set((o) => {
        const n = { phase: errText ? 'error' : ready ? 'ready' : 'loading', err: errText, msg, fps: ready ? fps : null, lod, clips, ready };
        return JSON.stringify(n) === JSON.stringify(o) ? o : n;
      });
    }, 500);
    return () => { clearInterval(t); stopAnim(); };
  }, []);

  const win = () => { try { return ref.current?.contentWindow; } catch { return null; } };
  function stopAnim() { cancelAnimationFrame(anim.current.raf); clearTimeout(anim.current.cycle); anim.current.raf = 0; }
  const roleFor = (p) => p.roles.find((r) => st.clips.includes(r)) || null;

  const camera = useCallback((name) => {
    const w = win(); const S = w?.__court3d, T = w?.__c3dTest; if (!S || !T) return;
    setCam(name);
    if (name === 'gameplay') { S.camFixed = null; return; }
    const pel = T.kp('pelvis') || (S.player?.pos ? [S.player.pos[0], 0.95, S.player.pos[1]] : [0, 0.95, 0]);
    const [fx, fz] = T.facing();
    const turn = { front: 0, '34': Math.PI / 4, side: Math.PI / 2, closeup: Math.PI / 10 }[name];
    const dist = name === 'closeup' ? 0.95 : 3.3;
    let look = [pel[0], pel[1] + 0.1, pel[2]];
    if (name === 'closeup') look = T.kp('nose') || [pel[0], pel[1] + 0.68, pel[2]];
    const dx = fx * Math.cos(turn) - fz * Math.sin(turn), dz = fx * Math.sin(turn) + fz * Math.cos(turn);
    S.camFixed = { pos: [look[0] + dx * dist, look[1] + (name === 'closeup' ? 0.03 : 0.25), look[2] + dz * dist], look };
  }, []);

  function playRole(w, role, loop = true, onEnd) {
    const S = w.__court3d, T = w.__c3dTest;
    const c = S.player?.lib?.[role] || (S.player?.lib?.[role + ':variants'] || [])[0];
    const dur = Math.max(0.4, (c?.F || 60) / (c?.fps || 30));
    const t0 = performance.now();
    const step = () => {
      const el = (performance.now() - t0) / 1000;
      if (!loop && el > dur) { onEnd && onEnd(); return; }
      try { T.poseClip(role, (el % dur) / dur); } catch { return; }
      anim.current.raf = requestAnimationFrame(step);
    };
    step();
  }
  const pose = (p) => {
    const w = win(); if (!w?.__c3dTest) return;
    const role = roleFor(p); if (!role) return;
    stopAnim(); setActive(p.key);
    if (p.how === 'hold') w.__c3dTest.poseClip(role, p.frac);
    else playRole(w, role);
    if (cam !== 'gameplay') setTimeout(() => camera(cam), 30);
  };
  const cycle = () => {
    const w = win(); if (!w?.__c3dTest) return;
    if (active === 'cycle') { live(); return; }
    const list = POSES.filter((p) => p.how === 'play' && roleFor(p));
    if (!list.length) return;
    stopAnim(); setActive('cycle');
    let i = 0;
    const next = () => { const role = roleFor(list[i % list.length]); i++; playRole(w, role, false, next); };
    next();
  };
  const live = () => { const w = win(); stopAnim(); setActive('live'); try { w?.__c3dTest?.release(); } catch {} };
  const reload = () => { stopAnim(); setActive(null); set((o) => ({ ...o, phase: 'loading', err: null, ready: false })); try { ref.current.contentWindow.location.reload(); } catch {} };
  return { ref, st, cam, active, camera, pose, cycle, live, reload, roleFor };
}

export function CourtFrame({ court, src, title = 'Soul Jam court', children }) {
  const s = useStore();
  const { st } = court;
  const noStorage = s.status && !s.status.storage;
  return html`<div class="courtbox" data-t="courtbox">
    <iframe ref=${court.ref} src=${src} title=${title} allow="fullscreen; gamepad"></iframe>
    ${st.phase === 'loading' && html`<div class="cover loading"><span class="d">Loading the court</span><span class="msg">${st.msg || 'starting…'}</span></div>`}
    ${st.phase === 'error' && html`<div class="cover err" data-t="court-error">
      <span class="d">The court could not start</span>
      <span class="msg"><b>Court says:</b> ${st.err}</span>
      ${/idle/i.test(st.err || '') && html`<span class="msg">The court plays the game's recorded clips; it needs at least an idle dribble (role <code>idle</code>).${noStorage ? ' Clip library unavailable on this machine: storage not configured (FIREBASE_SERVICE_ACCOUNT / R2 in .env).' : ''}</span>`}
      <div class="row" style="justify-content:center">
        <a class="btn sm" href="/mocap" data-t="court-record">Record an idle dribble on /mocap</a>
        ${noStorage && html`<a class="btn sm" href="/factory/settings">Storage status</a>`}
        <button class="btn sm" onClick=${court.reload} data-t="court-retry">Retry</button>
      </div>
    </div>`}
    ${children}
  </div>`;
}

/** Camera presets + pose buttons + telemetry. */
export function CourtControls({ court, bones = 127 }) {
  const { st } = court;
  const why = st.phase === 'error' ? 'the court could not start (see its message)' : st.phase === 'loading' ? 'the court is still loading' : null;
  return html`<div class="stack">
    <div class="pnl dark"><div class="ph"><span class="d">Camera</span></div><div class="pb tight">
      <div class="chips">${CAMS.map(([k, l]) => html`<button class=${'chip sm' + (court.cam === k && !why ? ' on' : '')} disabled=${!!why} title=${why || (k === 'gameplay' ? 'the game\'s own camera' : 'fixed camera around the player')} onClick=${() => court.camera(k)} data-t=${'cam-' + k}>${l}</button>`)}</div>
      ${why && html`<span class="why">${why}</span>`}
    </div></div>
    <div class="pnl dark"><div class="ph"><span class="d">Pose / animation</span></div><div class="pb tight">
      <div class="chips">
        ${POSES.map((p) => { const role = court.roleFor(p); const w = why || (!role ? `no clip for role ${p.roles.join(' / ')} on this court` : null);
          return html`<button class=${'chip sm' + (court.active === p.key ? ' on' : '')} disabled=${!!w} title=${w || `${p.how === 'hold' ? 'holds frame ' + Math.round(p.frac * 100) + ' % of' : 'plays'} ${role}`} onClick=${() => court.pose(p)} data-t=${'pose-' + p.key}>${p.label}</button>`; })}
        <button class=${'chip sm' + (court.active === 'cycle' ? ' on' : '')} disabled=${!!why || !POSES.some((p) => court.roleFor(p))} title=${why || 'plays each available clip in turn'} onClick=${court.cycle} data-t="pose-cycle">Cycle</button>
        <button class=${'chip sm' + (court.active === 'live' ? ' on' : '')} disabled=${!!why} title=${why || 'hand control back to the game (keyboard / controller in the court)'} onClick=${court.live} data-t="pose-live">Live</button>
      </div>
      ${!why && !st.clips.length && html`<span class="why">The court loaded no clips.</span>`}
      ${why && html`<span class="why">${why}</span>`}
    </div></div>
    <div class="pnl dark"><div class="ph"><span class="d">Telemetry</span><span class="u">from the court</span></div><div class="pb tight">
      <div class="tele">
        <div><div class="v">${st.fps || '—'}</div><div class="k">frame rate</div></div>
        <div><div class="v">${st.lod ? 'LOD' + st.lod.level : '—'}</div><div class="k">active LOD</div></div>
        <div><div class="v">${st.lod?.triangles ? Math.round(st.lod.triangles).toLocaleString() : '—'}</div><div class="k">triangles (LOD)</div></div>
        <div><div class="v">${bones}</div><div class="k">skeleton joints</div></div>
        <div><div class="v">${st.ready ? st.clips.length : '—'}</div><div class="k">clips loaded</div></div>
        <div><div class="v">${st.phase}</div><div class="k">court state</div></div>
      </div>
      ${st.ready && st.lod && !st.lod.triangles && html`<span class="why">Triangle count is reported by the court only for characters with 2+ LODs.</span>`}
    </div></div>
  </div>`;
}
