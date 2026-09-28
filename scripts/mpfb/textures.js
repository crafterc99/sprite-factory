/**
 * Court textures for an exported MPFB character: 1024 px WebP, garments
 * re-coloured to the performer's outfit (fabric shading kept), optional
 * stripe masks painted on (scripts/mpfb/stripes.py).
 *   node scripts/mpfb/textures.js <export_dir>/tex lib/mocap/mhr-rigs/<char>-tex [stripes.raw]
 */
'use strict';
const sharp = require('sharp');
const fs = require('fs'), path = require('path');
const [src, out, stripesRaw] = process.argv.slice(2);

// IMG_7870 outfit: cream hoodie, light blue-grey track pants with white side
// stripes, grey slides over white socks, black hair
const RECOLOUR = {
  elvs_hooded_sweat_jacket1_diffuse: { rgb: [250, 242, 226], shade: 0.35 },
  'elvs_crude_t-shirt_male_diffuse': { rgb: [244, 236, 220], shade: 0.2 }, // under the open zip: reads as the pullover
  toigo_wool_pants_diffuse: { rgb: [178, 188, 206], shade: 0.3, stripes: [246, 246, 248] },
  elvs_male_flip_flop_sandals1_diffuse: { rgb: [92, 96, 102], shade: 0.3 },
  joepal_crude_low_socks_diffuse: { rgb: [244, 244, 244], shade: 0.2 },
  cortu_short_messy_hair_diffuse: { scale: 0.3 },
};

async function recolour(file, spec) {
  const img = sharp(file).resize({ width: 1024, height: 1024, fit: 'fill' });
  if (spec.scale) return img.linear(spec.scale, 0);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // keep the fabric's relative shading (folds, weave) around the new colour
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 8) { sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++; }
  const mean = Math.max(1, sum / Math.max(1, n));
  let mask = null;
  if (spec.stripes && stripesRaw) {
    mask = await sharp(fs.readFileSync(stripesRaw), { raw: { width: 1024, height: 1024, channels: 1 } })
      .resize(info.width, info.height).blur(0.8).extractChannel(0).raw().toBuffer();
  }
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const L = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const k = Math.max(0.55, Math.min(1.25, 1 + spec.shade * (L / mean - 1)));
    const m = mask ? mask[p] / 255 : 0;
    for (let c = 0; c < 3; c++) {
      const base = spec.rgb[c] * (1 - m) + (m ? spec.stripes[c] * m : 0);
      data[i + c] = Math.min(255, base * k);
    }
  }
  return sharp(data, { raw: info });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const base = path.basename(f, path.extname(f));
    const spec = RECOLOUR[base];
    const im = spec ? await recolour(path.join(src, f), spec) : sharp(path.join(src, f)).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
    await im.webp({ quality: /normal/.test(base) ? 90 : 86, alphaQuality: 90 }).toFile(path.join(out, base + '.webp'));
  }
  for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
})();
