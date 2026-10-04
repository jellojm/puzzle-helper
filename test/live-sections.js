/* Pointed check: an assembled block is built up (js/vision/assembly.js) AND
 * located on the box from LIVE camera frames, never catalogued as loose
 * pieces, and loose pieces are offered for its open spots. Runs the engine
 * path directly in a few seconds (test/open-spots.js covers more cases).
 * Run: node test/live-sections.js
 */
'use strict';
const path = require('path');
const S = require('./synth');

globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

async function loadCv() {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  return { cv };
}

(async function main() {
  const { cv } = await loadCv();
  PH.cv = cv;
  const cols = 8, rows = 6;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 3 });
  const photo = S.boxPhoto(cv, P);
  const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows });

  // A table with one 3x3 assembled block plus the remaining loose pieces.
  const blocks = [{ r0: 2, c0: 1, rows: 3, cols: 3 }];
  const inBlock = (p) => blocks.some((b) => p.r >= b.r0 && p.r < b.r0 + b.rows && p.c >= b.c0 && p.c < b.c0 + b.cols);
  const subset = P.pieces.map((p, i) => i).filter((i) => !inBlock(P.pieces[i]));
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 21, subset, blocks });

  const eng = new PH.Engine();
  eng.setBox(box);

  // Serpentine sweep, a few frames per stop, as in the main live-sweep test.
  const FW = 1920, FH = 1080, zoom = 1.5;
  const viewW = FW / zoom, viewH = FH / zoom;
  const stops = [];
  const stepX = viewW * 0.3, stepY = viewH * 0.45;
  let dir = 1;
  for (let y = viewH / 2; y <= scat.TH - viewH / 2 + stepY * 0.6; y += stepY) {
    const xs = [];
    for (let x = viewW / 2; x <= scat.TW - viewW / 2 + stepX * 0.6; x += stepX) xs.push(Math.min(x, scat.TW - viewW / 2));
    if (dir < 0) xs.reverse();
    for (const x of xs) for (let k = 0; k < 3; k++) stops.push([x + k * 6, Math.min(y, scat.TH - viewH / 2)]);
    dir = -dir;
  }

  let sawMerged = false;
  stops.forEach(([x, y], i) => {
    const fr = S.cameraFrame(cv, scat.table, x, y, Math.sin(i * 0.15) * 0.08, zoom, FW, FH);
    const out = eng.processFrame(S.matSource(cv, fr), { still: true });
    for (const d of out.dets) if (d.status === 'merged') sawMerged = true;
    fr.delete();
  });

  const A = (eng.asms || []).reduce((a, b) => (!a || b.cells.size > a.cells.size ? b : a), null);
  const trueCells = scat.blocks[0].cells;
  const f = A ? A.filledBoxCells(box) : new Set();
  const ov = trueCells.filter((c) => f.has(c)).length / trueCells.length;
  const spots = A ? A.spots(box).filter((s) => s.cell) : [];
  const offered = spots.filter((sp) => {
    const need = ['?', '?', '?', '?'];
    sp.need.forEach((t, d) => (need[(d + A.place.k) % 4] = t));
    return eng.spotPieces(sp.cell[0], sp.cell[1], need, 3).length > 0;
  }).length;
  console.log(`live: ${eng.pieces.size} catalogued for ${subset.length} loose pieces; assembly ${A ? A.cells.size : 0} cells, place ${JSON.stringify(A && A.place)}`);
  check('a merged blob is seen during a live sweep', sawMerged);
  check('the assembled block is built up and located on the box', !!(A && A.place) && ov >= 0.6, `${(ov * 100).toFixed(0)}% of its cells`);
  check('the block is not catalogued as loose pieces', eng.pieces.size <= subset.length * 1.05, `${eng.pieces.size} for ${subset.length}`);
  check('loose pieces are offered for its open spots', offered > 0, `${offered} of ${spots.length} spots`);

  // The Map draws it: cells and open spots at its place on the table map.
  const md = eng.mapData();
  const ma = (md.asm || [])[0];
  check('the Map gets the assembled part', !!ma && ma.cells.length >= 6 && ma.spots.length > 0, ma ? `${ma.cells.length} cells, ${ma.spots.length} spots` : 'not on the Map');
  // Tidy up drops an "edge piece" whose box spot is already in the assembled part.
  const fakeCell = trueCells[0];
  const real = [...eng.pieces.values()].find((p) => p.t1);
  const fake = eng.newPiece({ fp: real.fp }, [0, 0], eng.island, real.area);
  fake.t1 = JSON.parse(JSON.stringify(real.t1)); fake.t1.flats = [true, false, false, false];
  fake.t1.edges[0].type = 'F'; fake.t1.edges[0].unc = false;
  fake.t2 = { cands: [{ col: fakeCell % cols, row: (fakeCell / cols) | 0, rot: 0, score: 0 }], conf: 0.9 };
  const td = eng.tidy();
  check('Tidy up removes an edge piece that is part of the assembled puzzle', !eng.pieces.has(fake.id) && td.falseEdges >= 1, `${td.falseEdges} removed`);
  // Old catalogues: section entries (v0.16 and older) are dropped on import.
  const st = { pieces: [...eng.pieces.values()].map((p) => eng.exportPiece(p)).concat([{ id: 9999, kind: 'section', pos: [0, 0], island: 1 }]), box };
  const e2 = new PH.Engine();
  e2.importState(st);
  check('old section entries are dropped when a catalogue is loaded', !e2.pieces.has(9999) && e2.pieces.size === eng.pieces.size);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
