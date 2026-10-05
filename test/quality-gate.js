/* Pointed check of the shot-quality gate and provisional pieces: only good,
 * repeated sightings become catalogue entries.
 *  - a sweep while the phone moves (blurred frames) catalogues nothing;
 *  - an overview from far away (pieces too small to read) catalogues nothing;
 *  - views that never show the same piece twice in a row catalogue nothing;
 *  - a normal steady sweep catalogues the pieces, once each;
 *  - the camera distance from a known piece size comes out right.
 * Run: node test/quality-gate.js   (a few seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
// (v0.20: counts().pieces = checked pieces only; this test is about what gets
// catalogued at all, i.e. entries)

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const FW = 1920, FH = 1080;
  const stopsAt = (zoom, per) => {
    const vw = FW / zoom, vh = FH / zoom, out = [];
    for (let y = vh / 2; y <= Math.max(vh / 2, scat.TH - vh / 2) + 1; y += vh * 0.45) for (let x = vw / 2; x <= Math.max(vw / 2, scat.TW - vw / 2) + 1; x += vw * 0.3) for (let k = 0; k < per; k++) out.push([x + k * 6, y]);
    return out;
  };
  const run = (stops, zoom, still, order) => {
    const eng = new PH.Engine();
    const seq = order ? order(stops) : stops;
    for (const [x, y] of seq) {
      const fr = S.cameraFrame(cv, scat.table, x, y, 0, zoom, FW, FH);
      eng.processFrame(S.matSource(cv, fr), { still });
      fr.delete();
    }
    return eng;
  };
  const n = P.pieces.length;

  const moving = run(stopsAt(1.5, 3), 1.5, false);
  check('blurred (moving) frames catalogue nothing', moving.counts().entries === 0, `${moving.counts().entries} pieces; rejects ${JSON.stringify(moving.rejects)}`);

  // Overview from far away: pieces ~25 px across in the camera image.
  const far = run(stopsAt(0.24, 3), 0.24, true);
  check('a far overview catalogues nothing', far.counts().entries === 0, `${far.counts().entries} pieces; rejects ${JSON.stringify(far.rejects)}`);

  // Four views that don't overlap, visited in turn (each three times): every
  // piece is seen three times, but never in two frames in a row.
  const Z = 3, vw = FW / Z, vh = FH / Z;
  const quads = [[vw / 2, vh / 2], [scat.TW - vw / 2, vh / 2], [vw / 2, scat.TH - vh / 2], [scat.TW - vw / 2, scat.TH - vh / 2]];
  const jumpy = run(quads.concat(quads, quads), Z, true);
  check('sightings that are never consecutive do not become pieces', jumpy.counts().entries === 0, `${jumpy.counts().entries} pieces`);

  const good = run(stopsAt(1.5, 3), 1.5, true);
  const c = good.counts();
  check('a steady sweep catalogues the pieces, once each', c.entries >= n * 0.85 && c.entries <= n, `${c.entries} of ${n}`);

  // v0.10.0 deadlock (owner's 200-piece session: 0 pieces in 3 minutes): a
  // section (merged blob) catalogued in the very first steady frame made the
  // engine wait to re-find a map that had no real anchors, and provisional
  // pieces expired meanwhile. Start the sweep right over an assembled block.
  {
    const blocks = [{ r0: 2, c0: 1, rows: 3, cols: 3 }];
    const inBlock = (q) => blocks.some((b) => q.r >= b.r0 && q.r < b.r0 + b.rows && q.c >= b.c0 && q.c < b.c0 + b.cols);
    const loose = P.pieces.map((q, i) => i).filter((i) => !inBlock(P.pieces[i]));
    const sc = S.scatter(cv, P, { scale: 2.2, seed: 21, subset: loose, blocks });
    const bl = sc.blocks[0];
    const bx = bl.x, by = bl.y; // the block's centre on the synthetic table
    const zoom = 1.5, vw = FW / zoom, vh = FH / zoom, stops = [];
    for (let k = 0; k < 3; k++) stops.push([Math.min(Math.max(bx, vw / 2), sc.TW - vw / 2) + k * 6, Math.min(Math.max(by, vh / 2), sc.TH - vh / 2)]);
    for (let y = vh / 2; y <= sc.TH - vh / 2 + 1; y += vh * 0.45) for (let x = vw / 2; x <= sc.TW - vw / 2 + 1; x += vw * 0.3) for (let k = 0; k < 3; k++) stops.push([x + k * 6, y]);
    const eng = new PH.Engine();
    // The sweep starts on the assembled block (no loose pieces in view): the
    // block is never catalogued, so it can't hold up the map.
    let tracked = 0;
    for (const [x, y] of stops) {
      const fr = S.cameraFrame(cv, sc.table, x, y, 0, zoom, FW, FH);
      const o = eng.processFrame(S.matSource(cv, fr), { still: true });
      if (o.tracking) tracked++;
      fr.delete();
    }
    const cc = eng.counts();
    check('an assembled block in the first frames does not stall cataloguing', cc.entries >= loose.length * 0.8, `${cc.entries} of ${loose.length} loose pieces, tracking ${Math.round(100 * tracked / stops.length)}% of frames`);
  }

  // Camera distance from the real piece size: 25 mm pieces, 100 px side in a
  // 1920-wide frame with a 66 degree lens -> f = 960/tan(33deg) = 1478 px ->
  // distance = 1478 * 25 / 100 = 370 mm.
  const e = new PH.Engine();
  e.box = { cols: 10, rows: 10, pieceMM: 25 };
  const g = e.viewGeometry(100 * 100 * 1.2 * 0.25, 0.5, 1920, 1080); // proc area at scale 0.5 for a 100 px source side
  check('camera distance from the piece size', Math.abs(g.distMM - 370) < 10, `${g.distMM.toFixed(0)} mm (expect ~370)`);
  check('typical piece size follows the piece count', PH.typicalPieceMM(1000) < PH.typicalPieceMM(300) && Math.abs(PH.typicalPieceMM(1000) - 19) < 0.5, `1000 pcs ${PH.typicalPieceMM(1000).toFixed(1)} mm, 300 pcs ${PH.typicalPieceMM(300).toFixed(1)} mm`);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
