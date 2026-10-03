/* The marked border as the puzzle's real location (js/vision/frame.js).
 * An assembled puzzle lies on a table among loose pieces; its 4 corners are
 * marked in one camera view. In other views (panned, turned, closer, farther)
 * every box cell must land on its true spot.
 *  - box cells land within a quarter cell in each view;
 *  - a view of a different table area is not mistaken for the puzzle;
 *  - the mark survives a save/restore (JSON) unchanged.
 * Uses the owner's box picture when present (test/fixtures, not in the repo),
 * else a synthetic picture.
 * Run: node test/puzzle-frame.js   (a few seconds)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'frame', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const fixture = path.join(__dirname, 'fixtures', 'chickens-box.jpg');
  let image = null;
  if (fs.existsSync(fixture) && !process.env.NO_FIXTURES) {
    const { readImage } = require('./imageio');
    const im = readImage(fixture, 1200);
    image = new cv.Mat(im.h, im.w, cv.CV_8UC4); image.data.set(im.data);
  }
  const cols = 20, rows = 27, cs = 30;
  const P = S.makePuzzle(cv, { cols, rows, cs, seed: 4, image });
  console.log(`picture: ${image ? 'owner box (fixture)' : 'synthetic'}`);
  const scat = S.scatter(cv, P, { scale: 1.6, seed: 9, subset: P.pieces.map((q, i) => i).filter((i) => i % 3 === 0) });
  // a table with the loose pieces on its left and the assembled puzzle on its right
  const pic = S.innerBox(cv, P);
  const TW = scat.TW + pic.cols + 300, TH = Math.max(scat.TH, pic.rows + 300);
  const table = new cv.Mat(TH, TW, cv.CV_8UC4, new cv.Scalar(38, 92, 60, 255));
  scat.table.copyTo(table.roi(new cv.Rect(0, 0, scat.TW, scat.TH)));
  const X0 = scat.TW + 150, Y0 = 150;
  pic.copyTo(table.roi(new cv.Rect(X0, Y0, pic.cols, pic.rows)));
  const cellT = (c, r) => [X0 + c * cs, Y0 + r * cs]; // box cell corner -> table px

  const FW = 960, FH = 540;
  // table point -> frame pixel for S.cameraFrame(cx, cy, phi, zoom)
  const toFrame = (v, x, y) => {
    const c = Math.cos(v.phi) / v.zoom, s = Math.sin(v.phi) / v.zoom;
    const bx = v.cx - (c * FW / 2 - s * FH / 2), by = v.cy - (s * FW / 2 + c * FH / 2);
    const det = c * c + s * s, dx = x - bx, dy = y - by;
    return [(c * dx + s * dy) / det, (-s * dx + c * dy) / det];
  };
  const shot = (v) => {
    const m = S.cameraFrame(cv, table, v.cx, v.cy, v.phi, v.zoom, FW, FH);
    const img = { w: m.cols, h: m.rows, data: new Uint8ClampedArray(m.data) };
    m.delete();
    return img;
  };
  const pc = [X0 + pic.cols / 2, Y0 + pic.rows / 2];
  const mark = { cx: pc[0], cy: pc[1], phi: Math.PI / 2, zoom: 0.55 }; // phone turned: portrait puzzle across a landscape view
  const corners = [[0, 0], [cols, 0], [cols, rows], [0, rows]].map(([c, r]) => toFrame(mark, ...cellT(c, r)));
  const inView = corners.every(([x, y]) => x > 0 && y > 0 && x < FW && y < FH);
  check('the marked view shows the whole puzzle', inView, corners.map((p) => p.map(Math.round).join(',')).join('  '));
  const t0 = Date.now();
  const F = new PH.PuzzleFrame(shot(mark), corners, cols, rows);
  console.log(`  marked: ${F.feat.n} features, ${Date.now() - t0} ms`);

  const err = (v, H) => {
    let worst = 0;
    for (let r = 0; r <= rows; r += 3) for (let c = 0; c <= cols; c += 3) {
      const t = toFrame(v, ...cellT(c, r));
      if (t[0] < 0 || t[1] < 0 || t[0] > FW || t[1] > FH) continue; // only spots in view
      const p = PH.applyHom(H, c, r);
      const cellPx = cs * 1 / v.zoom; // a cell's size in this view
      worst = Math.max(worst, Math.hypot(p[0] - t[0], p[1] - t[1]) / cellPx);
    }
    return worst;
  };
  const views = [
    ['same view', mark],
    ['panned to the top half', { cx: pc[0], cy: Y0 + pic.rows * 0.3, phi: Math.PI / 2, zoom: 0.8 }],
    ['turned 25 degrees', { cx: pc[0] - 40, cy: pc[1] + 30, phi: Math.PI / 2 + 0.44, zoom: 0.6 }],
    ['closer, over a corner', { cx: X0 + pic.cols * 0.8, cy: Y0 + pic.rows * 0.8, phi: Math.PI / 2 - 0.1, zoom: 1.1 }],
    ['portrait phone, farther', { cx: pc[0] - 100, cy: pc[1], phi: 0, zoom: 0.45 }],
  ];
  let ms = 0;
  for (const [name, v] of views) {
    const t1 = Date.now();
    const loc = F.locate(shot(v));
    ms = Math.max(ms, Date.now() - t1);
    const e = loc ? err(v, loc.H) : Infinity;
    check(`${name}: box cells land on their spots`, e < 0.25, loc ? `worst ${e.toFixed(2)} cell, ${loc.inliers} inliers` : `not found (${JSON.stringify(F.lastMatch)})`);
  }
  console.log(`  locate: up to ${ms} ms per view`);

  // loose pieces only, far from the puzzle: must not "find" it
  const away = F.locate(shot({ cx: scat.TW / 2, cy: scat.TH / 2, phi: 0, zoom: 1 }));
  check('a view without the puzzle does not find it', !away, away ? `${away.inliers} inliers` : '');

  const G = PH.PuzzleFrame.fromJSON(JSON.parse(JSON.stringify(F, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))));
  const v2 = views[2][1], loc2 = G.locate(shot(v2));
  check('restored mark still locates the puzzle', loc2 && err(v2, loc2.H) < 0.25, loc2 ? `${loc2.inliers} inliers` : 'not found');

  // Through the engine, as the app runs it: mark on a camera frame (camera
  // px), then a selected piece's target spot in a live frame of another view.
  {
    const eng = new PH.Engine({ frameEveryMs: 0 });
    const bp = S.boxPhoto(cv, P);
    const box = PH.createBox({ w: bp.mat.cols, h: bp.mat.rows, data: bp.mat.data }, bp.corners, { cols, rows });
    eng.setBox(box);
    const camW = 1280, camH = 720, k = camW / FW; // camera frames are bigger than the analysed view
    const camShot = (v) => S.cameraFrame(cv, table, v.cx, v.cy, v.phi, v.zoom / k, camW, camH);
    const mk = camShot(mark);
    const r = eng.setPuzzleFrame(S.matSource(cv, mk), {}, corners.map(([x, y]) => [x * k, y * k]));
    mk.delete();
    check('engine: marking the border works', r.ok, JSON.stringify(r));
    const [col, row] = [13, 4];
    eng.pieces.set(999, { id: 999, kind: 'piece', wrong: [], joined: [false, false, false, false], t2: { cands: [{ col, row, rot: 0 }], conf: 0.9 }, fp: null });
    eng.selection = { id: 999 };
    const v = views[2][1];
    const fr = camShot(v);
    const out = eng.processFrame(S.matSource(cv, fr), { still: true });
    fr.delete();
    const T = out.pframe && out.pframe.target;
    let e = Infinity;
    if (T) {
      // out coords are the analysed (proc) image: camera px * proc scale
      const procScale = Math.min(1, eng.opts.procW / Math.max(camW, camH));
      const cxy = T.quad.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]).map((q) => q / procScale / k);
      const truth = toFrame(v, ...cellT(col + 0.5, row + 0.5));
      e = Math.hypot(cxy[0] - truth[0], cxy[1] - truth[1]) / (cs / v.zoom);
    }
    check('engine: the selected piece spot is shown where it belongs', e < 0.3, T ? `off by ${e.toFixed(2)} cell` : `no target (${JSON.stringify(out.pframe)})`);
    bp.mat.delete();
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
