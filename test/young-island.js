/* v0.10.1 deadlock (owner's reports 19:10/19:12: 3 pieces in 4.6 minutes, each
 * in its own scan group, a new group every ~20 frames): a freshly started scan
 * group has no anchors, so the next frame "lost" the map, cataloguing stopped
 * for 20 frames, the half-seen pieces expired, and another empty group was
 * forked. A young group now keeps its pose (shifted by the pieces followed
 * from frame to frame) until it has 3 anchors.
 *  - a steady sweep from scratch catalogues the pieces in one or two groups;
 *  - the same with 3 stray pieces already in other groups (the phone's state).
 * Run: node test/young-island.js   (a few seconds)
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
  const FW = 1920, FH = 1080, zoom = 1.5, vw = FW / zoom, vh = FH / zoom;
  // a slow steady pan: small steps, every piece in view for many frames
  const stops = [];
  for (let y = vh / 2; y <= scat.TH - vh / 2 + 1; y += vh * 0.45) for (let x = vw / 2; x <= scat.TW - vw / 2 + 1; x += vw * 0.08) stops.push([x, y]);
  stops.push(...stops.slice().reverse()); // there and back
  const n = P.pieces.length;
  const sweep = (eng) => {
    for (const [x, y] of stops) {
      const fr = S.cameraFrame(cv, scat.table, x, y, 0, zoom, FW, FH);
      eng.processFrame(S.matSource(cv, fr), { still: true });
      fr.delete();
    }
    const groups = new Set();
    for (const p of eng.pieces.values()) if (p.pos && !p.stray) groups.add(p.island);
    return { c: eng.counts(), groups: groups.size };
  };

  {
    const eng = new PH.Engine({ budgetMs: 400 }); // (generous: the result must not depend on machine speed)
    const { c, groups } = sweep(eng);
    check('a steady sweep from scratch catalogues the pieces', c.entries >= n * 0.85 && c.entries <= n, `${c.entries} of ${n}`);
    check('... in one or two scan groups', groups <= 2, `${groups} groups`);
  }
  {
    const eng = new PH.Engine({ budgetMs: 400 }); // (generous: the result must not depend on machine speed)
    // the phone's state: 3 located pieces, each in its own old group, far away
    const fp = { hist: new Float32Array(PH.HIST_BINS), L: 250, a: 0, b: 0, sdL: 0 };
    for (let k = 0; k < 3; k++) { const p = eng.newPiece({ fp }, [90000 + k * 5000, 90000], eng.nextIsland++, 5000); p.stray = true; }
    const { c, groups } = sweep(eng);
    check('with stray pieces in old groups, the sweep still catalogues', c.entries - 3 >= n * 0.85 && c.entries - 3 <= n, `${c.entries - 3} of ${n}`);
    check('... in one or two new scan groups', groups <= 2, `${groups} groups`);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
