/**
 * render-hoop-preview.cjs — renders the procedural hoop geometry to PNG so the
 * vector rim can be visually compared against the reference art before the
 * same coordinates are ported to the testing-tab canvas and Soul Jam's
 * HoopRenderer. Run: node scripts/render-hoop-preview.cjs
 */
'use strict';
const sharp = require('sharp');
const path = require('path');

// All coordinates live in a 1920x1080 space measured off the reference image.
// Palette measured off the reference image.
const C = {
  poleFill:    '#5d6470',
  poleDark:    '#3a3f48',
  poleLight:   '#7a818d',
  boardBorder: '#e0512f',
  boardDark:   '#b53e22',
  glass:       '#cfe9f5',
  glassShade:  '#aed6e9',
  glassShine:  '#ffffff',
  square:      '#e8772a',
  rim:         '#e8772a',
  rimDark:     '#c75d18',
  net:         '#ffffff',
  netShade:    '#c8cdd4',
};

function netLattice(cx, rimY, topHalfW, botHalfW, netLen, ry) {
  // Diamond lattice: cols u across the rim, rows v down the net.
  const COLS = 6, ROWS = 4;
  const pt = (u, v) => {
    const fu = u / COLS, fv = v / ROWS;
    const side = (fu - 0.5) * 2;
    const halfW = topHalfW * (1 - fv) + botHalfW * fv;
    const x = cx + side * halfW;
    // top row follows the front of the rim ellipse; net sags slightly outward mid-way
    const sag = Math.sin(fv * Math.PI) * 6;
    const y = v === 0
      ? rimY + Math.sqrt(Math.max(0, 1 - side * side)) * ry
      : rimY + ry * 0.55 + fv * netLen + sag;
    return [x, y];
  };
  const segs = [];
  for (let v = 0; v < ROWS; v++) {
    for (let u = 0; u < COLS; u++) {
      segs.push([pt(u, v), pt(u + 1, v + 1)]);
      segs.push([pt(u + 1, v), pt(u, v + 1)]);
    }
  }
  // bottom rim of the net
  const bottom = [];
  for (let u = 0; u <= COLS; u++) bottom.push(pt(u, ROWS));
  return { segs, bottom };
}

function buildHoopSVG() {
  const parts = [];
  const P = (pts) => pts.map((p) => p.join(',')).join(' ');

  // ── Pole (gooseneck: vertical shaft + horizontal arm with mitred elbow) ──
  // front face
  parts.push(`<polygon points="${P([[668,1060],[668,490],[700,430],[905,430],[905,478],[730,478],[718,500],[718,1060]])}" fill="${C.poleFill}" stroke="${C.poleDark}" stroke-width="6" stroke-linejoin="round"/>`);
  // shaft side highlight
  parts.push(`<polygon points="${P([[700,1060],[700,505],[718,505],[718,1060]])}" fill="${C.poleLight}" opacity="0.55"/>`);
  // arm underside shadow
  parts.push(`<polygon points="${P([[730,478],[905,478],[905,462],[730,462]])}" fill="${C.poleDark}" opacity="0.45"/>`);

  // ── Support struts (elbow → top of backboard back) ──
  parts.push(`<line x1="762" y1="432" x2="884" y2="196" stroke="${C.poleDark}" stroke-width="11" stroke-linecap="round"/>`);
  parts.push(`<line x1="790" y1="448" x2="892" y2="252" stroke="${C.poleDark}" stroke-width="11" stroke-linecap="round"/>`);

  // ── Backboard (3/4 view — right edge nearest the viewer) ──
  // depth face (left/bottom dark edge behind)
  parts.push(`<polygon points="${P([[880,170],[858,182],[860,556],[882,540]])}" fill="${C.boardDark}"/>`);
  parts.push(`<polygon points="${P([[882,540],[860,556],[1086,608],[1105,590]])}" fill="${C.boardDark}"/>`);
  // right-side depth tab (visible sliver right of the front face)
  parts.push(`<polygon points="${P([[1095,45],[1123,62],[1133,575],[1105,590]])}" fill="${C.boardBorder}"/>`);
  parts.push(`<polygon points="${P([[1095,45],[1123,62],[1133,575],[1105,590]])}" fill="#000" opacity="0.18"/>`);
  // front face border
  parts.push(`<polygon points="${P([[880,170],[1095,45],[1105,590],[882,540]])}" fill="${C.boardBorder}"/>`);
  // glass (inset)
  parts.push(`<polygon points="${P([[901,180],[1074,80],[1083,560],[903,520]])}" fill="${C.glass}"/>`);
  // glass shading patches
  parts.push(`<polygon points="${P([[901,180],[1074,80],[1080,300],[902,330]])}" fill="${C.glassShade}" opacity="0.5"/>`);
  // diagonal shine streaks
  parts.push(`<polygon points="${P([[955,170],[990,150],[935,505],[915,500]])}" fill="${C.glassShine}" opacity="0.65"/>`);
  parts.push(`<polygon points="${P([[1010,140],[1026,131],[975,512],[962,509]])}" fill="${C.glassShine}" opacity="0.5"/>`);
  // inner shooter's square (perspective quad)
  parts.push(`<polygon points="${P([[962,302],[1042,262],[1046,468],[966,452]])}" fill="none" stroke="${C.square}" stroke-width="14"/>`);
  parts.push(`<polygon points="${P([[962,302],[1042,262],[1046,468],[966,452]])}" fill="none" stroke="${C.boardDark}" stroke-width="4" opacity="0.4"/>`);

  // ── Rim ──
  const rimCX = 1148, rimCY = 430, rimRX = 96, rimRY = 36, rimTilt = -7;
  // mount bracket: glass bottom-centre → rim
  parts.push(`<polygon points="${P([[1046,420],[1076,408],[1076,468],[1046,470]])}" fill="${C.rim}" stroke="${C.rimDark}" stroke-width="5" stroke-linejoin="round"/>`);
  parts.push(`<circle cx="1061" cy="442" r="9" fill="${C.rimDark}"/>`);
  parts.push(`<polygon points="${P([[1076,414],[1066,452],[1060,430]])}" fill="${C.rimDark}" opacity="0.0"/>`);

  // net BEHIND the front of the rim
  const { segs, bottom } = netLattice(rimCX, rimCY, rimRX * 0.94, 42, 290, rimRY);
  const net = [];
  for (const [[x1, y1], [x2, y2]] of segs) {
    net.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
  }
  parts.push(`<g stroke="${C.netShade}" stroke-width="9" fill="none" stroke-linecap="round" opacity="0.9">${net.join('')}</g>`);
  parts.push(`<g stroke="${C.net}" stroke-width="5.5" fill="none" stroke-linecap="round">${net.join('')}</g>`);
  parts.push(`<polyline points="${P(bottom.map(p => [p[0].toFixed(1), p[1].toFixed(1)]))}" fill="none" stroke="${C.net}" stroke-width="6"/>`);

  // rim ring (over the net top)
  const rimT = `transform="rotate(${rimTilt} ${rimCX} ${rimCY})"`;
  parts.push(`<ellipse cx="${rimCX}" cy="${rimCY}" rx="${rimRX}" ry="${rimRY}" ${rimT} fill="none" stroke="${C.rimDark}" stroke-width="22"/>`);
  parts.push(`<ellipse cx="${rimCX}" cy="${rimCY}" rx="${rimRX}" ry="${rimRY}" ${rimT} fill="none" stroke="${C.rim}" stroke-width="14"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="960" height="540">
  <rect width="1920" height="1080" fill="#ffffff"/>
  ${parts.join('\n  ')}
</svg>`;
}

(async () => {
  const svg = buildHoopSVG();
  const out = path.join(__dirname, '..', '_screenshots', 'hoop-preview.png');
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log('wrote', out);
})();
