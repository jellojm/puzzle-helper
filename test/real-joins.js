/* Real connections (owner, 2026-10-06): pieces photographed assembled and
 * then slid apart in the same layout and turn - IMG_3597 -> IMG_3598 (2x2,
 * cream counter, low lamp with shadows) and IMG_3601 -> IMG_3602 (2x4, white
 * board). In the apart photo the true joins follow from the layout: right
 * side of a piece <-> left side of the next one, bottom <-> top below.
 *
 * Each apart photo is read through the app's photo path; every true join is
 * then ranked by the app's matcher among the edges of ALL pieces read from
 * the owner's new photos (the loose ones in IMG_3599/3600/3603/3604 too, ~70
 * pieces of the same reef puzzle, different boards and light). A candidate
 * that is the true partner itself, photographed again, doesn't count against
 * it (samePiece).
 *   - every piece of the layout is read, and both sides of every join read as
 *     tab <-> blank;
 *   - the true partner ranks first (shape + colour) for most joins (2026-10-06:
 *     20/28 join sides first, 23/28 in the top 3 - before the shadow peel
 *     13 and 15: the shadow photo's joins ranked 7th-17th or were vetoed);
 *   - colour along the seam agrees for true joins (or is flagged untrusted).
 * Run: node test/real-joins.js   (~1 min; needs reports/IMG_35xx.JPG, skipped if missing)
 *   NOPEEL=1: without the shadow peel (comparison)   DIV=3: read photos at 1/3
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
if (process.env.NOPEEL) PH.SHADOW_PEEL = null;
if (process.env.COLW) PH.COL_W = +process.env.COLW;
if (process.env.STRIPW) PH.STRIP_W = +process.env.STRIPW;
if (process.env.LENW) PH.LEN_W = +process.env.LENW;
if (process.env.PEELDBG) PH.DEBUG_PEEL = (o) => console.log('  peel', JSON.stringify(o));
const REP = path.join(__dirname, '..', 'reports');
const DIV = +(process.env.DIV || 2);

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const LAYOUTS = [
  { file: 'IMG_3598.JPG', cols: 2, rows: 2, what: '2x2 on the cream counter, low lamp (shadows)' },
  { file: 'IMG_3602.JPG', cols: 2, rows: 4, what: '2x4 on the white board' },
];
const LOOSE = ['IMG_3599.JPG', 'IMG_3600.JPG', 'IMG_3603.JPG', 'IMG_3604.JPG'];

(async () => {
  if (!LAYOUTS.every((l) => fs.existsSync(path.join(REP, l.file)))) { console.log('SKIP  the owner\'s photos are not in reports/'); return; }
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  let nextId = 1;
  const read = (file) => {
    const im = readImage(path.join(REP, file));
    const full = new cv.Mat(im.h, im.w, cv.CV_8UC4); full.data.set(im.data);
    const mat = new cv.Mat(); cv.resize(full, mat, new cv.Size(Math.round(im.w / DIV), Math.round(im.h / DIV)), 0, 0, cv.INTER_AREA); full.delete();
    const eng = new PH.Engine({ checkedOnly: false, autoTilt: false });
    eng.processSnap(S.matSource(cv, mat)); mat.delete();
    const out = [];
    for (const p of eng.pieces.values()) {
      if (!p.t1) continue;
      const c = p.t1.corners;
      out.push({ id: nextId++, file, t1: p.t1, cx: c.reduce((t, q) => t + q[0], 0) / 4, cy: c.reduce((t, q) => t + q[1], 0) / 4 });
    }
    return out;
  };
  // the edge of a piece facing a direction (0 up, 1 right, 2 down, 3 left)
  const DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const edgeToward = (p, dir) => {
    const c = p.t1.corners; let best = -1, bd = -2;
    for (let k = 0; k < 4; k++) {
      const mx = (c[k][0] + c[(k + 1) % 4][0]) / 2 - p.cx, my = (c[k][1] + c[(k + 1) % 4][1]) / 2 - p.cy, l = Math.hypot(mx, my) || 1;
      const d = (mx * DIRV[dir][0] + my * DIRV[dir][1]) / l;
      if (d > bd) { bd = d; best = k; }
    }
    return best;
  };

  const pool = [], joins = [];
  for (const L of LAYOUTS) {
    if (process.env.PEELDBG) console.log(L.file);
    const ps = read(L.file);
    pool.push(...ps);
    // the layout: the rows by height, each row left to right (pieces cut by
    // the photo's edge are never read)
    const n = L.cols * L.rows;
    const ok = ps.length >= n;
    check(`${L.file} (${L.what}): every piece of the layout read`, ok, `${ps.length} read, ${n} in the layout; codes ${ps.map((p) => p.t1.code).join(' ')}`);
    if (!ok) continue;
    // keep the n pieces of the main group (closest to their common centre)
    const mx = PH.median(ps.map((p) => p.cx)), my = PH.median(ps.map((p) => p.cy));
    const grid = ps.slice().sort((a, b) => Math.hypot(a.cx - mx, a.cy - my) - Math.hypot(b.cx - mx, b.cy - my)).slice(0, n).sort((a, b) => a.cy - b.cy);
    const at = [];
    for (let r = 0; r < L.rows; r++) at.push(grid.slice(r * L.cols, (r + 1) * L.cols).sort((a, b) => a.cx - b.cx));
    for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) {
      if (c + 1 < L.cols) joins.push({ file: L.file, where: `r${r + 1}c${c + 1}-right`, a: at[r][c], ka: edgeToward(at[r][c], 1), b: at[r][c + 1], kb: edgeToward(at[r][c + 1], 3) });
      if (r + 1 < L.rows) joins.push({ file: L.file, where: `r${r + 1}c${c + 1}-down`, a: at[r][c], ka: edgeToward(at[r][c], 2), b: at[r + 1][c], kb: edgeToward(at[r + 1][c], 0) });
    }
  }
  if (process.env.PEELDBG) return;
  for (const f of LOOSE) if (fs.existsSync(path.join(REP, f))) pool.push(...read(f));
  console.log(`pool: ${pool.length} pieces read from ${LAYOUTS.length + LOOSE.length} photos; ${joins.length} true joins`);

  // the matcher's own ranking (shape + colour along the seam; no box picture here)
  PH.colTol = 15; // (what the reef box picture gives: report 2026-10-06 colTol 14.8)
  let typeOk = 0, top1 = 0, top3 = 0, shapeTop1 = 0, colPass = 0, colDoubt = 0, colN = 0, ties = 0;
  const rows = [];
  for (const j of joins) for (const [P, k, Q, m] of [[j.a, j.ka, j.b, j.kb], [j.b, j.kb, j.a, j.ka]]) {
    const eP = P.t1.edges[k], eQ = Q.t1.edges[m];
    const comp = (eP.type === 'T' && eQ.type === 'B') || (eP.type === 'B' && eQ.type === 'T');
    if (comp) typeOk++;
    const res = PH.findMatches({ id: P.id, t1: P.t1, t2: null }, pool.filter((o) => o !== P).map((o) => ({ id: o.id, t1: o.t1, t2: null })), { topN: 999 });
    const list = (res.find((r) => r.edge === k) || { matches: [] }).matches;
    // the true partner photographed again elsewhere: not a rival
    const rival = (x) => { const o = pool.find((q) => q.id === x.id); return o !== Q && !(o.file !== Q.file && PH.samePiece(o.t1, Q.t1).ok); };
    const iT = list.findIndex((x) => x.id === Q.id && x.edge === m);
    const rank = iT < 0 ? Infinity : list.slice(0, iT).filter(rival).length;
    const sh = PH.edgeScore(eP, eQ);
    let shapeRank = Infinity;
    if (sh) { shapeRank = 0; for (const o of pool) if (o !== P && o !== Q) for (const e of o.t1.edges) { const r2 = PH.edgeScore(eP, e); if (r2 && r2.shape < sh.shape && rival({ id: o.id })) shapeRank++; } }
    if (rank === 0) top1++;
    if (rank < 3) top3++;
    if (shapeRank === 0) shapeTop1++;
    if (iT >= 0 && list[iT].tie) ties++;
    if (sh) { if (sh.colDoubt) colDoubt++; else if (sh.colShare !== undefined) { colN++; if (sh.colShare >= PH.COL_SHARE) colPass++; } }
    rows.push(`  ${j.file} ${j.where.padEnd(12)} ${P.t1.code}[${k}]=${eP.type} -> ${Q.t1.code}[${m}]=${eQ.type}  rank ${rank === Infinity ? 'none' : rank + 1}${iT >= 0 && list[iT].tie ? ' (tie)' : ''}  shape rank ${shapeRank === Infinity ? '-' : shapeRank + 1}  shape ${sh ? sh.shape.toFixed(3) : '-'}${sh ? ` strip ${sh.color.toFixed(1)} len ${(Math.log(eP.lenRel / eQ.lenRel) * 100).toFixed(1)}%` : ''}${iT >= 0 && process.env.SHOW > 1 ? ` | best: ${list.slice(0, 2).map((x) => `#${x.id} sh ${x.shape.toFixed(3)} strip ${x.color.toFixed(1)} sc ${x.score.toFixed(2)}`).join(', ')} | true sc ${list[iT].score.toFixed(2)}` : ''}  colour ${sh ? (sh.colDoubt ? 'untrusted: ' + sh.colDoubt : sh.colShare !== undefined ? (sh.colShare * 100).toFixed(0) + '% agree' : '-') : '-'}`);
  }
  if (process.env.SHOW) console.log(rows.join('\n'));
  const N = joins.length * 2;
  console.log(`${N} join sides: partner first ${top1}, in top 3 ${top3}, first by shape alone ${shapeTop1}, near-ties ${ties}; colour agrees ${colPass}/${colN}${colDoubt ? `, untrusted ${colDoubt}` : ''}`);
  check('every true join reads tab <-> blank on both sides', typeOk === N, `${typeOk}/${N}`);
  check('the true partner ranks first for at least 65% of join sides', top1 >= 0.65 * N, `${top1}/${N}`);
  check('the true partner is in the top 3 for at least 80%', top3 >= 0.8 * N, `${top3}/${N}`);
  check('colour along the seam agrees for at least 90% of true joins (where trusted)', colPass >= 0.9 * colN, `${colPass}/${colN}`);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})();
