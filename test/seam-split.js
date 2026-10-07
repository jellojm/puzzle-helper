/* Pieces joined on the table, read from a photo (v0.23.1, PH.splitSeam).
 * A synthetic table: loose pieces and four joined pairs (two side by side,
 * two one above the other) whose seams show as a thin dark line, as real
 * joined pieces do. Read as a photo:
 *  - most pairs are cut along their seam and recorded as joined (a 'J' edge
 *    on each part, a seam join in the log);
 *  - no loose piece is cut (as many loose pieces read as without seams);
 *  - seam joins stay out of the owner's answer statistics.
 * Run: node test/seam-split.js   (a few seconds)
 */
'use strict';
const S = require('./synth');
const PH = require('./lib/vision')();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const blocks = [{ r0: 0, c0: 0, rows: 1, cols: 2 }, { r0: 2, c0: 3, rows: 2, cols: 1 }, { r0: 4, c0: 5, rows: 1, cols: 2 }, { r0: 1, c0: 6, rows: 2, cols: 1 }];
  const inBlock = (q) => blocks.some((b) => q.r >= b.r0 && q.r < b.r0 + b.rows && q.c >= b.c0 && q.c < b.c0 + b.cols);
  const loose = P.pieces.map((q, i) => i).filter((i) => !inBlock(P.pieces[i]));
  const read = (seams) => {
    const sc = S.scatter(cv, P, { scale: 2.2, seed: 21, subset: loose, blocks, seams });
    const eng = new PH.Engine({ checkedOnly: false, autoTilt: false });
    eng.processSnap(S.matSource(cv, sc.table));
    sc.table.delete();
    const ps = [...eng.pieces.values()].filter((p) => p.t1);
    return { eng, ps, withJ: ps.filter((p) => p.t1.edges.some((e) => e.type === 'J')).length, joins: (eng.fbLog || []).filter((e) => e.source === 'seam').length };
  };
  const plain = read(false), seamed = read(true);
  console.log(`no seams drawn: ${plain.ps.length} pieces read, ${plain.withJ} with a J edge; seams drawn: ${seamed.ps.length} read, ${seamed.withJ} with a J edge, ${seamed.joins} seam joins (${loose.length} loose + ${blocks.length} pairs)`);
  check('joined pairs are cut along the seam and recorded as joined', seamed.joins >= 3 && seamed.withJ >= 6, `${seamed.joins} of ${blocks.length} pairs joined, ${seamed.withJ} pieces with a J edge`);
  const looseRead = (r) => r.ps.filter((p) => !p.t1.edges.some((e) => e.type === 'J')).length;
  check('no loose piece is cut', Math.abs(looseRead(seamed) - looseRead(plain)) <= 1 && looseRead(seamed) >= loose.length * 0.85, `${looseRead(seamed)} loose read (without seams ${looseRead(plain)}; ${loose.length} on the table)`);
  const st = seamed.eng.feedbackStats();
  check('seam joins stay out of the answer statistics', st.judged === 0 && st.fits === 0, JSON.stringify({ judged: st.judged, fits: st.fits }));
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
