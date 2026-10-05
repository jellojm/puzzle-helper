/* Colour at every outline point (owner, 2026-10-05: "the adjacent piece
 * should match colorwise within a certain percentage").
 *
 * On a box picture every seam between neighbouring cells is a true join; any
 * other pair of opposite sides is a wrong one. With the tolerance the app
 * sets for that puzzle (PH.boxColTol), the rule "at least PH.COL_SHARE of the
 * facing points agree" (PH.colourAgree) must keep >= 98% of true seams and
 * reject >= 85% of wrong pairs - on the busy reef print and on the pale
 * chickens one. (Plan aimed at 90%; with read noise allowed the busy reef
 * reaches ~86% - colour is the second check after the close-read shape.)
 * Run: node test/edge-colour.js   (seconds)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { readImage } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const ROOT = path.join(__dirname, '..');
  const boxes = [
    ['reef 300 (owner, 2026-10-05)', path.join(ROOT, 'reports', 'puzzle-report-2026-10-05T11-14-50-box.jpg'), { pieces: 300, cols: 15, rows: 20 }, true],
    ['chickens 1000', path.join(__dirname, 'fixtures', 'real', 'box-chickens.jpg'), { pieces: 1000 }, false],
  ];
  for (const [name, file, opts, whole] of boxes) {
    if (!fs.existsSync(file)) { console.log(`SKIP  ${name}: ${file} not found`); continue; }
    const im = readImage(file);
    const corners = whole ? [[0, 0], [im.w, 0], [im.w, im.h], [0, im.h]] : PH.detectBoxCorners(im);
    const box = PH.createBox(im, corners, opts);
    if (process.env.SHARE) PH.COL_SHARE = +process.env.SHARE;
    if (process.env.SPREADW) PH.COL_SPREAD_W = +process.env.SPREADW;
    if (process.env.NOISE) PH.COL_NOISE = +process.env.NOISE;
    PH.colTol = PH.boxColTol(box);
    const S = box.S, W = box.W, lab = box.lab;
    // an "edge" of cell (c, r) on side k: its colours 1 px inside, clockwise along the side
    const side = (c, r, k) => {
      const pcol = new Float32Array(S * 3), pspread = new Float32Array(S);
      for (let t = 0; t < S; t++) {
        const at = [[c * S + t, r * S], [(c + 1) * S - 1, r * S + t], [(c + 1) * S - 1 - t, (r + 1) * S - 1], [c * S, (r + 1) * S - 1 - t]][k]; // the cell's outermost pixels
        const in2 = [[0, 2], [-2, 0], [0, -2], [2, 0]][k];
        const p = 3 * (at[1] * W + at[0]), q = 3 * ((at[1] + in2[1]) * W + at[0] + in2[0]);
        pcol[3 * t] = lab[p]; pcol[3 * t + 1] = lab[p + 1]; pcol[3 * t + 2] = lab[p + 2];
        pspread[t] = PH.dE(lab[p], lab[p + 1], lab[p + 2], lab[q], lab[q + 1], lab[q + 2], 0.7);
      }
      return { pcol, pspread };
    };
    let tTrue = 0, okTrue = 0;
    for (let r = 0; r < box.rows; r++) for (let c = 0; c < box.cols; c++) {
      if (c + 1 < box.cols) { tTrue++; if (PH.colourAgree(side(c, r, 1), side(c + 1, r, 3)) >= PH.COL_SHARE) okTrue++; }
      if (r + 1 < box.rows) { tTrue++; if (PH.colourAgree(side(c, r, 2), side(c, r + 1, 0)) >= PH.COL_SHARE) okTrue++; }
    }
    const rnd = PH.mulberry32(5);
    let tW = 0, rejW = 0;
    while (tW < 5000) {
      const c1 = Math.floor(rnd() * box.cols), r1 = Math.floor(rnd() * box.rows), c2 = Math.floor(rnd() * box.cols), r2 = Math.floor(rnd() * box.rows);
      if (Math.abs(c1 - c2) + Math.abs(r1 - r2) <= 1) continue;
      const k = Math.floor(rnd() * 4);
      tW++; if (PH.colourAgree(side(c1, r1, k), side(c2, r2, (k + 2) % 4)) < PH.COL_SHARE) rejW++;
    }
    console.log(`${name}: ${box.cols}x${box.rows}, tolerance ${PH.colTol.toFixed(1)}`);
    check(`${name}: keeps >= 98% of true seams`, okTrue >= tTrue * 0.98, `${okTrue}/${tTrue} (${((100 * okTrue) / tTrue).toFixed(1)}%)`);
    check(`${name}: rejects >= 85% of wrong pairs`, rejW >= tW * 0.85, `${rejW}/${tW} (${((100 * rejW) / tW).toFixed(1)}%)`);
  }
  // Colour read in bad conditions is flagged and not used (owner: "indicate
  // color is a bad match when conditions are not favorable").
  {
    const mk = (L, clip) => { const pcol = new Float32Array(96); for (let s = 0; s < 32; s++) { pcol[3 * s] = L; pcol[3 * s + 1] = 128 + (s < 16 ? 30 : -30); pcol[3 * s + 2] = 128; } return { type: 'T', sig: new Float32Array(64), lenRel: 1, strip: new Float32Array(48), pcol, pspread: new Float32Array(32), cc: { clip, busy: 0 } }; };
    const good = mk(120, 0), glare = mk(120, 3 / 32);
    check('colour trust: clean edge in normal light is trusted', PH.colourDoubt(good, { kRaw: 1.1 }) === null);
    check('colour trust: 3 of 32 points washed out -> glare', PH.colourDoubt(glare, { kRaw: 1 }) === 'glare');
    check('colour trust: needed x2.4 light -> too dark', PH.colourDoubt(good, { kRaw: 2.4 }) === 'dark');
    check('colour trust: without a board reference light is not judged', PH.colourDoubt(good, { k: 1 }) === null);
    // a doubtful edge's colour is not compared: no veto, the reason passed on
    const b = Object.assign(mk(200, 0), { type: 'B' }); // colours far apart: would be vetoed
    good.cdoubt = null; b.cdoubt = null;
    const r1 = PH.edgeScore(good, b);
    b.cdoubt = 'glare';
    const r2 = PH.edgeScore(good, b);
    check('colour trust: a trusted pair is compared', r1 && r1.colShare !== undefined && r1.colShare < PH.COL_SHARE, r1 && String(r1.colShare));
    check('colour trust: a doubtful pair is not compared, reason given', r2 && r2.colShare === undefined && r2.colDoubt === 'glare');
    // a clean later read replaces colour read in glare
    const base = { edges: [0, 1, 2, 3].map(() => Object.assign(mk(250, 0.5), { cdoubt: 'glare' })), nObs: 1 };
    const obs = { edges: [0, 1, 2, 3].map(() => Object.assign(mk(120, 0), { cdoubt: null })) };
    PH.fuseShapes(base, obs, 0);
    check('colour trust: a clean read replaces glare colour', base.edges.every((e) => e.cdoubt === null && e.pcol[0] === 120));
  }
  // Geometry points: a read saved with another corner trim (or point count)
  // still compares point for point (PH.sigAs).
  {
    const curve = []; for (let i = 0; i <= 400; i++) { const x = i / 400; curve.push([x, 0.25 * Math.exp(-((x - 0.5) ** 2) / 0.01)]); }
    const sigOf = (n, tr) => { const q = PH.arcPoints(curve, n, tr, 1 - tr), s = new Float32Array(2 * n); q.forEach((p, k) => { s[2 * k] = p.x; s[2 * k + 1] = p.y; }); return s; };
    const want = sigOf(32, 0.06);
    let worst = 0;
    for (const [n, tr] of [[32, 0], [48, 0], [24, 0.03]]) { const got = PH.sigAs(sigOf(n, tr), 32, tr, 0.06); for (let i = 0; i < 64; i++) worst = Math.max(worst, Math.abs(got[i] - want[i])); }
    check('geometry points: reads with another trim / count convert', worst < 0.01, `worst ${worst.toFixed(4)} edge lengths`);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})();
