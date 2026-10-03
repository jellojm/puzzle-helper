/* Pointed check: an assembled block is catalogued AND located on the box from
 * LIVE camera frames (not just from a Snap photo). The full browser e2e covers
 * this too, but takes minutes and its frame pacing is wall-clock dependent, so
 * this runs the same engine path directly in a few seconds.
 * Run: node test/live-sections.js
 */
'use strict';
const path = require('path');
const S = require('./synth');

globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
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

  let sawSectionStatus = false, sawMerged = false;
  stops.forEach(([x, y], i) => {
    const fr = S.cameraFrame(cv, scat.table, x, y, Math.sin(i * 0.15) * 0.08, zoom, FW, FH);
    const out = eng.processFrame(S.matSource(cv, fr), { still: true });
    for (const d of out.dets) {
      if (d.status === 'section') sawSectionStatus = true;
      if (d.status === 'merged') sawMerged = true;
    }
    fr.delete();
  });

  const all = [...eng.pieces.values()].filter((p) => p.kind === 'section');
  const placed = all.filter((p) => p.sec && p.sec.cells);
  const trueCells = scat.blocks[0].cells;
  const best = placed.map((p) => ({ p, ov: p.sec.cells.filter((c) => trueCells.includes(c)).length / trueCells.length }))
    .sort((a, b) => b.ov - a.ov)[0];

  console.log(`live sections: ${all.length} catalogued, ${placed.length} located; counts ${JSON.stringify(eng.counts())}`);
  check('a merged blob is seen at all during a live sweep', sawMerged || sawSectionStatus);
  check('the assembled block is catalogued as a section', all.length >= 1, `${all.length} section entr${all.length === 1 ? 'y' : 'ies'}`);
  check('the section is located on the box picture', !!best && best.ov >= 0.6, best ? `best overlap ${(best.ov * 100).toFixed(0)}%` : 'none located');
  check('the overlay reports it as a section', sawSectionStatus);
  check('loose pieces are offered for the section', !best || eng.sectionPartners(best.p).length > 0,
    best ? `${eng.sectionPartners(best.p).length} partners` : 'n/a');

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
