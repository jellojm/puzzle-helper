/* "No" (doesn't fit) triggers a fresh read (owner, 2026-10-11: "one of the
 * pieces is not measured well enough or the actual piece has not been
 * found"). Before, a "No" only stopped that pair being suggested, and a bad
 * stored shape was never replaced (re-reads that disagreed only counted as
 * conflicts). Engine.rereadDone.
 * A live, steady view of a synthetic table: every piece is read. Then one
 * piece's stored shape is swapped for another piece's (a bad read, low
 * quality) and the pair is turned down with "No"; after a few more views its
 * stored shape must be its own again. A piece whose shape was right keeps it.
 * Run: node test/no-reread.js   (a few seconds)
 */
'use strict';
const S = require('./synth');
const PH = require('./lib/vision')();
PH.CLOSE_SIDE = 40;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 4 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 9 });
  const frame = S.cameraFrame(cv, scat.table, scat.TW / 2, scat.TH / 2, 0.2, 1.0, 960, 720);
  const eng = new PH.Engine({ checkedOnly: false });
  const run = (n) => { for (let i = 0; i < n; i++) eng.processFrame(S.matSource(cv, frame), { still: true }); };
  run(20);
  const read = [...eng.pieces.values()].filter((p) => p.t1 && PH.isCloseRead(p.t1));
  check('pieces read in the steady view', read.length >= 6, `${read.length}`);
  if (read.length < 6) { process.exitCode = 1; return; }
  const [bad, other, good, other2] = read;
  const own = bad.t1;
  // a bad read: another piece's shape, low quality
  bad.t1 = Object.assign({}, other.t1, { quality: Object.assign({}, other.t1.quality, { q: 0.3 }) });
  check('the swapped shape really differs', !PH.samePiece(bad.t1, own).ok);
  eng.feedback({ kind: 'wrong', a: bad.id, ka: 0, b: other2.id, kb: 0 });
  eng.feedback({ kind: 'wrong', a: good.id, ka: 0, b: other2.id, kb: 1 });
  const goodBefore = good.t1;
  check('both pieces flagged for a fresh read', bad.reread > 0 && good.reread > 0, `${bad.reread} / ${good.reread}`);
  run(80); // (checked pieces' re-reads come first in the queue, a frame or more apart)
  const ev = (eng.events || []).filter((e) => /^reread/.test(e.kind)).map((e) => `${e.kind}#${e.a}`);
  check('the bad shape is replaced by a fresh read of the piece', !!bad.replaced && PH.samePiece(bad.t1, own).ok, `replaced ${bad.replaced || 0}; ${ev.join(' ')}`);
  check('the good shape is kept (its re-read agreed)', !good.replaced && good.reread === 0 && PH.samePiece(good.t1, goodBefore).ok, `replaced ${good.replaced || 0}, reread ${good.reread}`);
  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
