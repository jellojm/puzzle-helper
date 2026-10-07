/* Pieces moved around (owner, 2026-10-05: "the biggest thing"). A checked
 * piece is never forgotten; when it is known to be gone from its spot its
 * dot and Map picture go away until a sweep finds it again, with its number.
 *
 * A 24-piece synthetic table is swept until every piece is checked (checking
 * takes two agreeing close reads per piece, ~1-2 reads fit a frame), then,
 * one step at a time with a sweep after each:
 *   1. slide 3 pieces to empty spots   2. swap two pieces   3. turn one in place
 *   4. take one off the table          5. sweep dark and bright, 30% of
 *      detections missed                6. put the taken piece back elsewhere
 * After every step: the right number of checked pieces, every physical piece
 * keeps its number, no new entries, the moved pieces' map spots are where
 * they really are; the piece taken away is hidden (not on the Map, no
 * highlight) but still in memory, and comes back with its number; a piece
 * the detector merely missed is never flagged gone.
 * Run: node test/moves.js   (~3 min)
 */
'use strict';
const path = require('path');
const S = require('./synth');
require('./lib/vision')(); // (the modules the app's worker loads; VISION=<dir> for another copy)
const PH = globalThis.PH;

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const cols = 6, rows = 4, n = cols * rows;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 3 });
  const sc = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const felt = [38, 92, 60];
  const core = sc.core, sp = core * 1.85, half = Math.round(core * 0.86);
  // the table, with an empty band on the right to move pieces into
  const TW = sc.TW + Math.round(sp * 2), TH = sc.TH;
  const table = new cv.Mat(TH, TW, cv.CV_8UC4, new cv.Scalar(felt[0], felt[1], felt[2], 255));
  { const v = table.roi(new cv.Rect(0, 0, sc.TW, sc.TH)); sc.table.copyTo(v); v.delete(); }
  const where = sc.gt.map((g) => [g.x, g.y]); // each physical piece's centre now (table px)
  const box = (x, y) => new cv.Rect(Math.round(x) - half, Math.round(y) - half, 2 * half, 2 * half);
  const grab = (j) => table.roi(box(...where[j])).clone();
  const clear = (x, y) => { const v = table.roi(box(x, y)); v.setTo(new cv.Scalar(felt[0], felt[1], felt[2], 255)); v.delete(); };
  const paste = (m, x, y) => { const v = table.roi(box(x, y)); m.copyTo(v); v.delete(); };
  const free = [];
  for (let y = sp; y < TH - sp / 2; y += sp) free.push([sc.TW + sp * 0.9, y]);

  // A generous time budget per frame: this test is about the logic of moves,
  // not about how many reads fit a frame (results must not depend on the
  // machine's load).
  const eng = new PH.Engine({ budgetMs: 400, housekeepMs: 30 });
  const FW = 1920, FH = 1080, zoom = 1.5, viewW = FW / zoom, viewH = FH / zoom;
  let light = 1, dropRate = 0, frames = 0;
  const rnd = S.makeRng(9);
  const sweep = () => {
    const stops = [];
    const stepX = viewW * 0.35, stepY = viewH * 0.45;
    let dir = 1;
    for (let y = viewH / 2; y <= TH - viewH / 2 + stepY * 0.6; y += stepY) {
      const xs = [];
      for (let x = viewW / 2; x <= TW - viewW / 2 + stepX * 0.6; x += stepX) xs.push(Math.min(x, TW - viewW / 2));
      if (dir < 0) xs.reverse();
      for (const x of xs) for (let k = 0; k < 5; k++) stops.push([x + k * 6, Math.min(y, TH - viewH / 2)]); // ~a second over each spot, like the owner's sweep
      dir = -dir;
    }
    eng.opts.dropDets = dropRate ? (d) => !d.border && rnd() < dropRate : null;
    for (const [x, y] of stops) {
      const fr = S.cameraFrame(cv, table, x, y, 0, zoom, FW, FH, felt);
      if (light !== 1) { const d = fr.data; for (let i = 0; i < d.length; i += 4) { d[i] *= light; d[i + 1] *= light; d[i + 2] *= light; } }
      eng.processFrame(S.matSource(cv, fr), { still: true });
      fr.delete(); frames++;
    }
  };
  // entry -> table px: a similarity fitted on the pieces that haven't moved
  let T = null;
  const fit = (still) => {
    const pairs = [];
    for (const j of still) { const id = idOf[j]; const p = id && eng.pieces.get(id); if (p && p.pos && !p.gone) pairs.push({ src: p.pos, dst: where[j] }); }
    const r = PH.simRansac(pairs, core * 0.4, 200, PH.mulberry32(4));
    T = r ? r.T : T;
  };
  const entryAt = (x, y) => {
    let best = null, bd = Infinity;
    for (const p of eng.pieces.values()) {
      if (!p.pos || p.gone || p.state !== 'checked') continue;
      const q = PH.simApply(T, p.pos[0], p.pos[1]), d = Math.hypot(q[0] - x, q[1] - y);
      if (d < bd) { bd = d; best = p; }
    }
    return bd < core * 0.5 ? best : null;
  };
  const idOf = [];

  // 0. sweep until checked (at most 4 sweeps)
  if (process.env.DBGQ) PH.DEBUG_Q = (...a) => { if (frames >= +(process.env.F0 || 30) && frames < +(process.env.F1 || 42)) console.log(...a); };
  sweep(); sweep();
  for (let k = 0; k < 2 && eng.counts().unchecked; k++) sweep();
  let c = eng.counts();
  console.log('after setup sweeps: unchecked because', JSON.stringify(eng.whyUnchecked()), 'frames', frames);
  if (process.env.SETUP_ONLY) for (const p of [...eng.pieces.values()].filter((q) => q.state !== 'checked').slice(0, 12)) console.log('   #' + p.id, 'side', p.t1 && Math.round(p.t1.meanSide), 'q', p.t1 && p.t1.quality && p.t1.quality.q, 'closeAgree', p.closeAgree, 'nObs', p.t1 && p.t1.nObs, 'conflicts', p.conflicts || 0, 'sightings', p.sightings, 'moments', p.moments, 'closeViews', p.closeViews, 't1Frame', p.t1Frame, 'code', p.t1 && p.t1.code);
  check('setup: every piece checked after at most 4 close sweeps', c.checked === n && c.unchecked === 0, `${c.checked} checked, ${c.unchecked} unchecked, ${c.entries} entries`);
  {
    // first fit: by the box-free layout, nearest entries to the ground truth via RANSAC over all pairs
    const ents = [...eng.pieces.values()].filter((p) => p.pos && p.state === 'checked');
    let best = null; const R = PH.mulberry32(2);
    for (let it = 0; it < 3000 && ents.length > 2; it++) {
      const a = Math.floor(R() * n), b = Math.floor(R() * n), A = ents[Math.floor(R() * ents.length)], B = ents[Math.floor(R() * ents.length)];
      if (a === b || A === B) continue;
      const t = PH.simFit([A.pos, B.pos], [where[a], where[b]]);
      if (!t) continue;
      let inl = 0; for (const p of ents) { const q = PH.simApply(t, p.pos[0], p.pos[1]); if (where.some((w) => Math.hypot(w[0] - q[0], w[1] - q[1]) < core * 0.4)) inl++; }
      if (!best || inl > best.inl) best = { t, inl };
    }
    T = best && best.t;
    for (let j = 0; j < n; j++) { const e = T && entryAt(...where[j]); idOf[j] = e ? e.id : null; }
    check('setup: one entry per piece', new Set(idOf.filter(Boolean)).size === n, `${new Set(idOf.filter(Boolean)).size} of ${n}`);
  }
  if (process.env.SETUP_ONLY) { process.exitCode = failures ? 1 : 0; return; }
  const stepLog = (name) => { if (process.env.STEPLOG) console.log('  after', name, JSON.stringify(eng.counts()), 'rejects', JSON.stringify(eng.rejects), 'island', eng.island, 'lost', eng.lost); };
  const all = [...Array(n).keys()];
  const verify = (step, moved, away) => {
    const still = all.filter((j) => !moved.includes(j) && j !== away);
    fit(still);
    c = eng.counts();
    const want = away === undefined ? n : n - 1;
    const kept = all.filter((j) => j !== away).filter((j) => { const e = entryAt(...where[j]); return e && e.id === idOf[j]; });
    check(`${step}: ${want} pieces on the table, each with its own number`, c.checked - c.gone === want && kept.length === want,
      `${c.checked} checked, ${c.gone} gone, ${c.unchecked} unchecked; ${kept.length}/${want} keep their number${kept.length < want ? ' (lost: ' + all.filter((j) => j !== away && !kept.includes(j)).slice(0, 6).join(',') + ')' : ''}`);
    check(`${step}: no new entries`, Math.max(...[...eng.pieces.keys()].filter((id) => eng.pieces.get(id).state === 'checked')) <= Math.max(...idOf) && c.checked === n,
      `${c.checked} checked (${c.entries} entries)`);
  };

  // 1. slide 3 pieces to empty spots (out of view: between sweeps)
  const slid = [3, 10, 17];
  slid.forEach((j, i) => { const m = grab(j); clear(...where[j]); where[j] = free[i]; paste(m, ...where[j]); m.delete(); });
  sweep(); sweep();
  verify('1 slide 3', slid);
  // 2. swap two pieces
  const [a, b] = [5, 20];
  { const ma = grab(a), mb = grab(b); paste(mb, ...where[a]); paste(ma, ...where[b]); [where[a], where[b]] = [where[b], where[a]]; ma.delete(); mb.delete(); }
  sweep(); sweep();
  verify('2 swap two', [a, b]);
  // 3. turn one in place
  { const j = 14, m = grab(j), r = new cv.Mat(); cv.rotate(m, r, cv.ROTATE_90_CLOCKWISE); paste(r, ...where[j]); m.delete(); r.delete(); }
  sweep(); sweep();
  verify('3 turn one', [14]);
  // 4. take one away
  const away = 8, taken = grab(away);
  clear(...where[away]);
  sweep(); sweep();
  verify('4 take one away', [], away);
  const P12 = eng.pieces.get(idOf[away]);
  check('4: the piece taken away is still in memory, flagged gone', !!P12 && P12.gone === true, P12 ? `gone=${P12.gone}` : 'deleted!');
  const md = eng.mapData();
  check('4: ... not on the Map', !md.pieces.some((q) => q.id === idOf[away]));
  eng.setFilter('edges'); const lit = eng.filterIds(); eng.setFilter(null);
  check('4: ... never highlighted', !lit.includes(idOf[away]));
  // 5. sweep dark and bright with 30% of detections missed
  const goneBefore = eng.counts().gone;
  if (process.env.STEPLOG) { let k = 0; PH.DEBUG_ASSIGN = (o) => { if (k++ < 25) console.log('   unlinked', JSON.stringify(o)); }; }
  dropRate = 0.3; light = 0.65; sweep(); stepLog('dark'); PH.DEBUG_ASSIGN = null; light = 1.35; sweep(); stepLog('bright'); light = 1; dropRate = 0;
  verify('5 dark/bright, 30% missed', [], away);
  check('5: missed detections never flag a piece gone', eng.counts().gone === goneBefore, `${eng.counts().gone} gone (was ${goneBefore})`);
  // 6. put it back somewhere new
  where[away] = free[3]; paste(taken, ...where[away]); taken.delete();
  if (process.env.STEPLOG) { let k = 0; PH.DEBUG_ASSIGN = (o) => { if (k++ < 20) console.log('   unlinked6', JSON.stringify(o)); }; }
  sweep(); stepLog('6a'); sweep(); stepLog('6b'); PH.DEBUG_ASSIGN = null;
  verify('6 put it back elsewhere', [away]);
  const back = eng.pieces.get(idOf[away]);
  check('6: it is back with its old number', !!back && !back.gone && back.refound >= 1, back ? `gone=${back.gone} refound=${back.refound}` : 'missing');
  console.log(`${frames} frames`);
  console.log('unchecked because', JSON.stringify(eng.whyUnchecked()), 'housekeeping', JSON.stringify(eng.hk));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})();
