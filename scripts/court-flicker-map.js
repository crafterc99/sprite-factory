// Flicker map of the 3D court: a near-still camera sweep, pixels that change frame to frame drawn red (aliasing / z-fighting show up as speckle). node scripts/court-flicker-map.js
const { chromium } = require('playwright');
const sharp = require('sharp');
const OUT = '/tmp/claude-0/-home-user/147773c6-e8d6-54e1-bd7a-3d3eea03f61f/scratchpad';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  await p.goto('http://localhost:3456/court3d.html');
  await p.waitForFunction(() => window.__c3dReady && window.__court3d.loadingRest === 0, null, { timeout: 240000 });
  await p.evaluate(() => { window.__court3d.speed = 0; for (const e of document.body.children) if (e.tagName !== 'CANVAS' && !e.querySelector('canvas')) e.style.visibility = 'hidden'; });
  const step = +(process.env.STEP || 0.002);
  const shots = [];
  for (let i = 0; i < 4; i++) {
    await p.evaluate(([i, step]) => new Promise((r) => { window.__court3d.camFixed = { pos: [-6 + i * step, 1.7, 26], look: [0, 0.4, 6] }; requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))); }), [i, step]);
    shots.push(await p.screenshot());
  }
  const raws = await Promise.all(shots.map((s) => sharp(s).greyscale().raw().toBuffer()));
  const W = 640, H = 400, heat = Buffer.alloc(W * H * 3);
  const base = await sharp(shots[0]).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < W * H; i++) {
    let d = 0; for (let k = 1; k < raws.length; k++) d = Math.max(d, Math.abs(raws[k][i] - raws[k - 1][i]));
    const c = base.info.channels;
    heat[i * 3] = d > 20 ? 255 : base.data[i * c] * 0.35; heat[i * 3 + 1] = d > 20 ? 0 : base.data[i * c + 1] * 0.35; heat[i * 3 + 2] = d > 20 ? 0 : base.data[i * c + 2] * 0.35;
  }
  await sharp(heat, { raw: { width: W, height: H, channels: 3 } }).png().toFile(OUT + '/flicker-heat.png');
  await sharp(shots[0]).toFile(OUT + '/flicker-frame.png');
  await b.close();
})();
