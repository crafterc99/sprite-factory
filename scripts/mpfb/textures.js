/**
 * Court textures for an exported MPFB character: 1024 px WebP, the tank top
 * and shorts re-coloured to the red jersey, the hair darkened.
 *   node scripts/mpfb/textures.js <export_dir>/tex lib/mocap/mhr-rigs/<char>-tex
 */
const sharp = require('sharp');
const fs = require('fs'), path = require('path');
const src = process.argv[2], out = process.argv[3];
const RED = { toigo_keyhole_tank_top_diffuse: [200, 24, 36], cortu_jeans_shorts_diffuse: [176, 18, 30] };
(async () => {
  for (const f of fs.readdirSync(src)) {
    const base = path.basename(f, path.extname(f));
    let im = sharp(path.join(src, f)).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
    if (RED[base]) {
      // jersey red: keep the fabric's shading (luminance), replace its colour
      const { data, info } = await im.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const [r, g, b] = RED[base];
      for (let i = 0; i < data.length; i += 4) {
        const L = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        const k = Math.min(1.6, 0.35 + L * 1.3);
        data[i] = Math.min(255, r * k); data[i + 1] = Math.min(255, g * k); data[i + 2] = Math.min(255, b * k);
      }
      im = sharp(data, { raw: info });
    } else if (base === 'cortu_short_messy_hair_diffuse') {
      im = im.linear(0.3, 0); // black hair (MPFB's hair texture is a light neutral meant to be tinted)
    }
    const q = /normal/.test(base) ? 90 : 86;
    await im.webp({ quality: q, alphaQuality: 90 }).toFile(path.join(out, base + '.webp'));
  }
  for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
})();
