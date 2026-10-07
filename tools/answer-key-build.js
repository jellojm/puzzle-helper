/* Build the answer key for test/real-50.js from the owner's 50-piece video.
 *   node tools/answer-key-build.js <key-pos.json> <out answer.json> <sheet.jpg>
 *   (VIDEO=reports/IMG_3605.MOV KEYT=76 for another video: KEYT = the
 *   overview's time in seconds, stored as the key's frame time)
 * key-pos.json: [{n,row,col,x,y}] the 50 pieces' centres in the opening
 * overview frame (found by colour on the white board, numbered by row).
 * Replays the video through the engine, keeps every CLOSE shape read
 * (piece >= 150 px across), assigns reads to key pieces through the table
 * map, and takes the majority edge code per piece. Writes a contact sheet of
 * each piece's largest read with its edge types drawn on, to be checked by
 * eye before the key is trusted.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('../test/synth');
const { videoFrames } = require('../test/videoframes');
const { writeJpg } = require('../test/imageio');
globalThis.self = globalThis;
require('../test/lib/vision')(); // (the modules the app's worker loads)
const PH = globalThis.PH;
const [posFile, outFile, sheetFile] = process.argv.slice(2);
const VIDEO = process.env.VIDEO ? path.resolve(process.env.VIDEO) : path.join(__dirname, '..', 'reports', 'IMG_3593.MOV');
const canon = (c) => { let b = c; for (let r = 1; r < 4; r++) { const x = c.slice(r) + c.slice(0, r); if (x < b) b = x; } return b; };

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const key = JSON.parse(fs.readFileSync(posFile, 'utf8'));
  const eng = new PH.Engine();
  const reads = [];
  const orig = eng.detT1.bind(eng);
  eng.detT1 = (d) => {
    const had = d.t1 !== undefined;
    const t1 = orig(d);
    if (!had && t1 && t1.meanSide >= 150) {
      // keep the crop to draw later (source px around the piece)
      const xs = t1.corners.map((c) => c[0]), ys = t1.corners.map((c) => c[1]);
      const m = t1.meanSide * 0.45, x0 = Math.max(0, Math.floor(Math.min(...xs) - m)), y0 = Math.max(0, Math.floor(Math.min(...ys) - m));
      const F = eng.frameCtx, x1 = Math.min(F.source.w, Math.ceil(Math.max(...xs) + m)), y1 = Math.min(F.source.h, Math.ceil(Math.max(...ys) + m));
      reads.push({ d, t1, side: t1.meanSide, code: t1.edges.map((e) => e.type).join(''), crop: F.source.getCrop(x0, y0, x1 - x0, y1 - y0), ox: x0, oy: y0, frame: n });
    }
    return t1;
  };
  let n = 0;
  const tilt = { pitch: 0, roll: 0 };
  for await (const f of videoFrames(VIDEO, { step: 5, to: +(process.env.TO || 1e9) })) {
    const mat = new cv.Mat(f.h, f.w, cv.CV_8UC4); mat.data.set(f.data);
    const src = S.matSource(cv, mat);
    if (n % 3 === 0) { const e = eng.estimatePhotoTilt(src); if (e && e.gain > 0.05) { tilt.pitch = tilt.pitch * 0.5 + e.pitch * 0.5; tilt.roll = tilt.roll * 0.5 + e.roll * 0.5; } }
    eng.processFrame(src, { still: f.still, tilt: { down: PH.downFromAngles(tilt.pitch, tilt.roll), fov: 66 } });
    for (const r of reads) if (r.frame === n && r.id === undefined) r.id = r.d.id || null; // the entry it was read for (followed through merges below)
    mat.delete(); n++;
  }
  // key (overview frame px) -> table map (perspective-aware: test/keymatch.js)
  const fit = require('../test/keymatch').fitKey(cv, PH, key, [...eng.pieces.values()].filter((p) => p.pos && p.state === 'checked'));
  const unit = fit.unit, best = { T: null };
  console.log(`key->map fit: ${fit.inliers}/${key.length} key pieces have a checked entry within half a piece`);
  // Each key piece's entry: the checked entry on its spot. Its code rests on
  // two agreeing close reads; the sheet shows the close read most like it, to
  // be checked by eye (the key must not just repeat what the app read).
  const checked = [...eng.pieces.values()].filter((p) => p.pos && p.state === 'checked' && p.t1);
  const out = [];
  const tiles = [];
  for (const k of key) {
    const q = fit.map(k.x, k.y);
    let e = null, ed = Infinity;
    for (const p of checked) { const d = Math.hypot(p.pos[0] - q[0], p.pos[1] - q[1]); if (d < ed) { ed = d; e = p; } }
    if (ed > unit * 0.5) e = null;
    let bestRead = null, bd = Infinity;
    if (e) for (const r of reads) { const m = PH.samePiece(r.t1, e.t1); if (m.ok && m.d < bd) { bd = m.d; bestRead = r; } }
    const top = e ? e.t1.code : null;
    const ranked = [];
    // the piece's reference shape (from its checked close reads), so tests can
    // identify it by outline and print whatever the map does
    const ref = e ? { code: e.t1.code, meanSide: e.t1.meanSide, edges: e.t1.edges.map((x) => ({ type: x.type, unc: !!x.unc, alt: x.alt, lenRel: x.lenRel, sig: Array.from(x.sig, (v) => +v.toFixed(4)) })),
      square: { lab: Array.from(e.t1.square.lab), mask: Array.from(e.t1.square.mask) }, white: e.t1.white || null, lf: e.t1.lf || null } : null;
    out.push({ n: k.n, row: k.row, col: k.col, x: k.x, y: k.y, code: top, entry: e ? e.id : null, closeAgree: e ? e.closeAgree : 0, ref });
    // tile: the crop with corners and edge letters
    const T = 300, tile = new cv.Mat(T, T, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));
    if (bestRead) {
      const c = bestRead.crop, cm = new cv.Mat(c.h, c.w, cv.CV_8UC4); cm.data.set(c.data);
      const s = Math.min(T / c.w, T / c.h), rm = new cv.Mat();
      cv.resize(cm, rm, new cv.Size(Math.round(c.w * s), Math.round(c.h * s)));
      rm.copyTo(tile.roi(new cv.Rect(0, 0, rm.cols, rm.rows)));
      const P = bestRead.t1.corners.map((q) => [(q[0] - bestRead.ox) * s, (q[1] - bestRead.oy) * s]);
      for (let ei = 0; ei < 4; ei++) {
        const A = P[ei], B = P[(ei + 1) % 4];
        cv.line(tile, new cv.Point(A[0], A[1]), new cv.Point(B[0], B[1]), new cv.Scalar(255, 0, 0, 255), 2);
        cv.putText(tile, bestRead.code[ei], new cv.Point((A[0] + B[0]) / 2 - 8, (A[1] + B[1]) / 2 + 8), 0, 1, new cv.Scalar(255, 120, 0, 255), 3);
      }
      cm.delete(); rm.delete();
    }
    cv.putText(tile, `${k.n}${e ? '' : ' NO ENTRY'}`, new cv.Point(4, 26), 0, 0.9, new cv.Scalar(220, 0, 0, 255), 2);
    tiles.push(tile);
  }
  const cols = 10, rows = Math.ceil(tiles.length / cols), T = 300;
  const sheet = new cv.Mat(rows * T, cols * T, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));
  tiles.forEach((t, i) => { t.copyTo(sheet.roi(new cv.Rect((i % cols) * T, Math.floor(i / cols) * T, T, T))); t.delete(); });
  writeJpg(sheetFile, sheet.cols, sheet.rows, sheet.data);
  const isBorder = (c) => /F/.test(c), isCorner = (c) => /FF/.test(c + c[0]);
  const counts = { pieces: out.length, corner: out.filter((p) => p.code && isCorner(p.code)).length, border: out.filter((p) => p.code && isBorder(p.code) && !isCorner(p.code)).length };
  fs.writeFileSync(outFile, JSON.stringify({ video: 'reports/' + path.basename(VIDEO), frame: process.env.KEYT ? null : 30, t: process.env.KEYT ? +process.env.KEYT : undefined, counts, pieces: out }, null, 1));
  console.log('counts', JSON.stringify(counts), 'without an entry:', out.filter((p) => !p.entry).map((p) => p.n).join(' ') || 'none');
})();
