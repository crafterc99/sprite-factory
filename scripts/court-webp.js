/**
 * Court GLB → smaller GLB: PNG textures re-encoded as WebP (EXT_texture_webp,
 * required), everything else byte-identical. Usage: node scripts/court-webp.js in.glb out.glb
 */
'use strict';
const fs = require('fs');
const sharp = require('sharp');
(async () => {
  const [inp, out] = process.argv.slice(2);
  const b = fs.readFileSync(inp);
  const jl = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + jl).toString());
  const binStart = 20 + jl + 8, bin = b.slice(binStart, binStart + b.readUInt32LE(20 + jl));
  const views = j.bufferViews.map((v) => bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength));
  const usage = {};
  for (const m of j.materials) {
    const note = (t, k) => { if (t) usage[j.textures[t.index].source] = k; };
    note(m.normalTexture, 'normal'); note(m.pbrMetallicRoughness?.baseColorTexture, 'color'); note(m.pbrMetallicRoughness?.metallicRoughnessTexture, 'data'); note(m.emissiveTexture, 'color');
  }
  for (const [i, im] of j.images.entries()) {
    if (im.mimeType !== 'image/png') continue;
    const q = usage[i] === 'normal' ? 92 : usage[i] === 'data' ? 88 : 86;
    const webp = await sharp(views[im.bufferView]).webp({ quality: q, effort: 5 }).toBuffer();
    console.log(im.name, usage[i] || '?', views[im.bufferView].length, '→', webp.length);
    views[im.bufferView] = webp; im.mimeType = 'image/webp';
  }
  for (const t of j.textures) { t.extensions = { ...(t.extensions || {}), EXT_texture_webp: { source: t.source } }; delete t.source; }
  j.extensionsUsed = [...new Set([...(j.extensionsUsed || []), 'EXT_texture_webp'])];
  j.extensionsRequired = [...new Set([...(j.extensionsRequired || []), 'EXT_texture_webp'])];
  // repack the binary chunk (4-byte aligned views)
  const parts = []; let off = 0;
  for (const [i, v] of j.bufferViews.entries()) { const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; } v.byteOffset = off; v.byteLength = views[i].length; parts.push(views[i]); off += views[i].length; }
  const pad = (4 - (off % 4)) % 4; if (pad) parts.push(Buffer.alloc(pad));
  const binOut = Buffer.concat(parts); j.buffers[0].byteLength = binOut.length;
  let js = Buffer.from(JSON.stringify(j)); const jp = (4 - (js.length % 4)) % 4; js = Buffer.concat([js, Buffer.alloc(jp, 0x20)]);
  const hdr = Buffer.alloc(12); hdr.write('glTF', 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + binOut.length, 8);
  const ch = (len, type) => { const c = Buffer.alloc(8); c.writeUInt32LE(len, 0); c.write(type, 4); return c; };
  fs.writeFileSync(out, Buffer.concat([hdr, ch(js.length, 'JSON'), js, ch(binOut.length, 'BIN\0'), binOut]));
  console.log('written', out, fs.statSync(out).size);
})();
