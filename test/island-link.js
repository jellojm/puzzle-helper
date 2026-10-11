/* Islands that show the same pieces are folded together (Engine.linkIslands).
 * Report 2026-10-11 18:58: 3 loose pieces on a wood floor, tracking broke 4
 * times, every new island catalogued the pieces again (9 entries) and the
 * reads differed too much for the strict shape join.
 * A steady synthetic view is read; then its pieces are moved off to another
 * island (as if tracking broke) and the same view is read again: two copies.
 * linkIslands must join the islands and merge the copies - also with the
 * copies' shapes made unmatchable (print and layout only). Islands showing
 * different pieces must stay apart.
 * Run: node test/island-link.js   (a few seconds)
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
  const view = (fx, fy) => S.cameraFrame(cv, scat.table, scat.TW * fx, scat.TH * fy, 0.2, 1.0, 960, 720);
  const checked = (eng) => [...eng.pieces.values()].filter((p) => eng.isChecked(p) && p.pos);
  const islands = (eng) => new Set(checked(eng).map((p) => p.island)).size;

  // the same view twice, with a break in between
  const forked = (scramble) => {
    const eng = new PH.Engine({ checkedOnly: false });
    const frame = view(0.5, 0.5);
    const run = (n) => { for (let i = 0; i < n; i++) eng.processFrame(S.matSource(cv, frame), { still: true }); };
    run(30);
    const first = checked(eng);
    // tracking broke: a new island, far off and turned, where the pieces in
    // view were catalogued again (the copies a fork leaves)
    const copies = first.slice(0, 5).map((p) => {
      const [x, y] = p.pos, q = eng.newPiece({ fp: p.fp }, [9000 - y, 4000 + x], 78, p.area);
      q.t1 = p.t1; q.state = 'checked'; q.sightings = 5;
      return q;
    });
    if (scramble) for (const p of copies) { p.t1 = Object.assign({}, p.t1, { edges: p.t1.edges.map((e) => Object.assign({}, e, { type: e.type === 'T' ? 'B' : 'T', sig: e.sig && e.sig.map((v) => -v) })) }); p.t1.code = p.t1.edges.map((e) => e.type).join(''); }
    return { eng, first, copies };
  };
  {
    const { eng, first, copies } = forked(false);
    check('first look: pieces checked', first.length >= 5, `${first.length}`);
    check('after the break: the same pieces catalogued again on a new island', copies.length >= 3 && islands(eng) === 2, `${copies.length} copies, ${islands(eng)} islands`);
    const n0 = checked(eng).length, linked = eng.linkIslands();
    check('the islands are joined and the copies merged', linked === 1 && islands(eng) === 1 && checked(eng).length <= n0 - 3, `linked ${linked}, ${n0} -> ${checked(eng).length} entries, ${islands(eng)} islands`);
  }
  {
    const { eng } = forked(true);
    const n0 = checked(eng).length, linked = eng.linkIslands();
    check('copies whose shapes read differently: joined by print and layout', linked === 1 && islands(eng) === 1 && checked(eng).length <= n0 - 3, `linked ${linked}, ${n0} -> ${checked(eng).length} entries`);
  }
  {
    // two views with no piece in common: islands must stay apart
    const eng = new PH.Engine({ checkedOnly: false });
    const a = view(0.25, 0.3), b = view(0.75, 0.7);
    for (let i = 0; i < 30; i++) eng.processFrame(S.matSource(cv, a), { still: true });
    for (const p of eng.pieces.values()) if (p.pos) { p.pos = [p.pos[0] + 9000, p.pos[1]]; p.island = 77; }
    for (let i = 0; i < 30; i++) eng.processFrame(S.matSource(cv, b), { still: true });
    const ids = (q) => new Set(q.map((p) => p.id));
    const n0 = checked(eng).length, before = ids(checked(eng)), linked = eng.linkIslands();
    check('islands of different pieces stay apart', linked === 0 && checked(eng).length === n0 && islands(eng) >= 2, `linked ${linked}, ${n0} -> ${checked(eng).length}, ${before.size} ids`);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
