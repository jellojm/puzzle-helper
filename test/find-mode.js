/* Find mode tells the truth (v0.23.2), from the owner's screenshots:
 *  - IMG_3631 "Strong match 70%": the pairs list showed the lower of the two
 *    sides' probabilities with ONE side's word. Now the word is the weaker
 *    side's too: no pair is "strong" under 85%;
 *  - IMG_3630: a match partner shaded as a two-piece clump. A piece that now
 *    lies against another (its detection is a clump) is drawn by its own
 *    outline; the clump carries no piece number.
 * Run: node test/find-mode.js   (a few seconds)
 */
'use strict';
const S = require('./synth');
const PH = require('./lib/vision')();
PH.CLOSE_SIDE = 40; // synthetic pieces are small; this test is about Find mode

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 31 });
  const scat = S.scatter(cv, P, { scale: 2.0, seed: 33 });
  const eng = new PH.Engine({ checkedOnly: false });
  eng.processSnap(S.matSource(cv, scat.table));

  // 1. one word per pair, the weaker side's
  let res = null;
  for (let i = 0; i < 20 && !(res && res.done); i++) res = eng.scanPairs({ budgetMs: 1e9 });
  const pairs = res ? res.pairs : [];
  const side = (a, ka, b) => { const r = eng.matchesFor(a); const m = r && r[ka] && r[ka].matches.find((x) => x.id === b); return m ? m.verdict : null; };
  let bad = 0, strongLow = 0;
  for (const q of pairs) {
    const va = side(q.a, q.edgeA, q.b), vb = side(q.b, q.edgeB, q.a);
    if (va && vb && q.verdict !== PH.weakerVerdict(va, vb)) bad++;
    if (q.verdict === 'strong' && q.prob < 0.85) strongLow++;
  }
  check('a pair carries the weaker side\'s word', pairs.length >= 5 && bad === 0, `${pairs.length} pairs, ${bad} with the other side's word`);
  check('no pair is "strong" under 85%', strongLow === 0, `${strongLow} strong under 85% (of ${pairs.filter((q) => q.verdict === 'strong').length} strong)`);

  // 2. a piece in a clump: its own outline, the clump unnumbered
  const p = [...eng.pieces.values()].find((x) => x.t1 && x.pos);
  eng.pose = { a: 1, b: 0, tx: 0, ty: 0 }; eng.island = p.island; // (the view = the table here)
  const c = p.t1.corners, cx = c.reduce((a, q) => a + q[0], 0) / 4, cy = c.reduce((a, q) => a + q[1], 0) / 4, R = p.t1.meanSide;
  const clump = { id: p.id, merged: true, area: R * R * 2.2, cx: cx + R * 0.5, cy, border: false, bbox: [cx - R, cy - R, 3 * R, 2 * R],
    pts: Int32Array.from([cx - R, cy - R, cx + 2 * R, cy - R, cx + 2 * R, cy + R, cx - R, cy + R].map(Math.round)) };
  eng.selection = { id: p.id };
  const out = eng.output([clump], { scale: 1 });
  const dets = out.dets || [];
  const clumpOut = dets.find((d) => d.status === 'merged'), mine = dets.find((d) => d.status === 'inClump');
  check('the clump carries no piece number', clumpOut && !clumpOut.id, JSON.stringify(clumpOut && { id: clumpOut.id }));
  // (where the engine's own map puts the piece, through the view's pose - here the identity)
  const u = Math.sqrt(p.area || R * R), inside = mine && Math.hypot(mine.cx - p.pos[0], mine.cy - p.pos[1]) < u * 0.6;
  check('the piece in it has its own outline, where the map puts it', !!mine && mine.id === p.id && inside, mine ? `centre ${Math.round(mine.cx)},${Math.round(mine.cy)} vs ${Math.round(p.pos[0])},${Math.round(p.pos[1])}` : 'none');
  const h = (out.highlights || []).find((x) => x.id === p.id);
  check('its highlight is on screen and says it is in a clump', !!h && h.visible && h.inClump, JSON.stringify(h && { visible: h.visible, inClump: h.inClump }));
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
