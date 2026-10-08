/* End-to-end checks of the vision pipeline on a synthetic puzzle.
 * Run: npm test   (add --quick for a smaller puzzle, --save to write debug PNGs)
 * Reports segmentation, edge-type, box-placement, edge-matching and
 * live-tracking accuracy against ground truth, plus timings. */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');

globalThis.self = globalThis;
// The deterministic step clock unless another is asked for: the live sweep
// below runs on time budgets, and on the real clock a busy PC caught 89 of
// 96 pieces against the 91 it needs (2026-10-08) - a test must not depend on
// what else the machine is doing. Every check here passes on it (22/22).
if (!process.env.CLOCK) process.env.CLOCK = 'step';
require('./lib/vision')(); // (the modules the app's worker loads)
const PH = globalThis.PH;
PH.CLOSE_SIDE = 40; // synthetic pieces are small (the phone's close reads: 120+ px); these tests are about other things

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const SAVE = args.includes('--save');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');

async function loadCv() {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  // Wrapped: the Emscripten module is a thenable, and returning it from an
  // async function would make `await` try to resolve it forever.
  return { cv };
}

function savePng(cv, mat, name) {
  if (!SAVE) return;
  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  // Raw RGBA dump + python one-liner converts it (keeps Node deps at zero).
  const raw = path.join(dir, name + '.rgba');
  fs.writeFileSync(raw, Buffer.from(mat.data));
  fs.writeFileSync(raw + '.json', JSON.stringify({ w: mat.cols, h: mat.rows }));
}

(async function main() {
  const { cv } = await loadCv();
  PH.cv = cv;
  const cols = QUICK ? 8 : 12, rows = QUICK ? 6 : 8;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 3 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  savePng(cv, scat.table, 'table');
  const n = P.pieces.length;
  console.log(`Synthetic puzzle ${cols}x${rows} = ${n} pieces, table ${scat.TW}x${scat.TH}, core ≈ ${scat.core.toFixed(0)} px`);

  // ---------- 1. Snap: whole table in one high-res photo ----------
  const eng = new PH.Engine();
  const photo = S.boxPhoto(cv, P);
  savePng(cv, photo.mat, 'boxphoto');
  const guess = PH.detectBoxCorners({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data });
  const cornerErr = guess ? Math.max(...guess.map((c, i) => Math.hypot(c[0] - photo.corners[i][0], c[1] - photo.corners[i][1]))) : Infinity;
  check('box picture corners auto-detected', cornerErr < 8, guess ? `worst corner off by ${cornerErr.toFixed(1)} px` : 'not found');
  let t = Date.now();
  const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { pieces: n });
  check('box grid matches puzzle', box.cols === cols && box.rows === rows, `${box.cols}x${box.rows} in ${Date.now() - t} ms`);
  eng.setBox(box);

  t = Date.now();
  const snap = eng.processSnap(S.matSource(cv, scat.table));
  console.log(`snap: ${JSON.stringify(snap)}`);
  check('segmentation finds every piece', snap.added === n, `${snap.added}/${n}`);

  // Map engine pieces -> ground truth by table position (snap coords = table px).
  const sc = 1; // source == table
  const pieces = [...eng.pieces.values()];
  const gtOf = new Map();
  for (const p of pieces) {
    if (!p.t1) continue;
    const cx = p.t1.corners.reduce((s, c) => s + c[0], 0) / 4, cy = p.t1.corners.reduce((s, c) => s + c[1], 0) / 4;
    let best = null;
    for (const g of scat.gt) { const d = Math.hypot(g.x - cx * sc, g.y - cy * sc); if (!best || d < best.d) best = { d, g }; }
    if (best && best.d < scat.core * 0.3) gtOf.set(p.id, best.g);
  }
  check('T1 shape model succeeds', gtOf.size >= n * 0.95, `${gtOf.size}/${n} pieces with corners near the true core`);

  // Edge types + true side of each detected edge (via nearest true corner).
  let codeOk = 0, edgeOk = 0, edgeTot = 0;
  const sideOf = new Map(); // id -> [true side of detected edge 0..3]
  for (const [id, g] of gtOf) {
    const p = eng.pieces.get(id);
    const h = scat.core / 2, cs = Math.cos(g.rot), sn = Math.sin(g.rot);
    const tc = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => [g.x + cs * u - sn * v, g.y + sn * u + cs * v]);
    const c0 = p.t1.corners[0];
    let j0 = 0, bd = Infinity;
    tc.forEach((c, j) => { const d = Math.hypot(c[0] - c0[0], c[1] - c0[1]); if (d < bd) { bd = d; j0 = j; } });
    const sides = [0, 1, 2, 3].map((e) => (j0 + e) % 4);
    sideOf.set(id, sides);
    let all = true;
    for (let e = 0; e < 4; e++) {
      edgeTot++;
      if (p.t1.code[e] === g.code[sides[e]]) edgeOk++; else all = false;
    }
    if (all) codeOk++;
  }
  check('edge types (tab/blank/flat) correct', edgeOk / edgeTot > 0.95, `${pct(edgeOk, edgeTot)} of edges, ${pct(codeOk, gtOf.size)} of pieces fully right`);

  // ---------- 2. Box placement ----------
  let top1 = 0, top5 = 0, placedN = 0, skyN = 0, skyTop5 = 0;
  const skyRows = Math.ceil(rows * 0.18);
  for (const [id, g] of gtOf) {
    const p = eng.pieces.get(id);
    if (!p.t2 || !p.t2.cands.length) continue;
    placedN++;
    const k = p.t2.cands.findIndex((c) => c.col === g.c && c.row === g.r);
    if (k === 0) top1++;
    if (k >= 0 && k < 5) top5++;
    if (g.r < skyRows) { skyN++; if (k >= 0 && k < 5) skyTop5++; }
  }
  check('box placement top-5', top5 / placedN > 0.8, `top-1 ${pct(top1, placedN)}, top-5 ${pct(top5, placedN)} (sky rows: top-5 ${pct(skyTop5, skyN)})`);

  // ---------- 3. Edge matching ----------
  const byCell = new Map();
  for (const [id, g] of gtOf) byCell.set(g.r * cols + g.c, id);
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let m1 = 0, m3 = 0, mTot = 0, m1nb = 0, m3nb = 0;
  const calib = [], calibRaw = [];
  t = Date.now();
  for (const [id, g] of gtOf) {
    const p = eng.pieces.get(id);
    const sides = sideOf.get(id);
    const withBox = PH.findMatches(p, eng.pieces.values(), { topN: 10 });
    const saveT2 = new Map([...eng.pieces.values()].map((q) => [q.id, q.t2]));
    for (const q of eng.pieces.values()) q.t2 = null;
    const noBox = PH.findMatches(p, eng.pieces.values(), { topN: 10 });
    for (const q of eng.pieces.values()) q.t2 = saveT2.get(q.id);
    for (let e = 0; e < 4; e++) {
      const side = sides[e];
      const nb = byCell.get((g.r + DIRS[side][1]) * cols + (g.c + DIRS[side][0]));
      const inGrid = g.r + DIRS[side][1] >= 0 && g.r + DIRS[side][1] < rows && g.c + DIRS[side][0] >= 0 && g.c + DIRS[side][0] < cols;
      if (!inGrid || !nb || p.t1.code[e] === 'F') continue;
      const nbSides = sideOf.get(nb);
      const nbEdge = nbSides.indexOf((side + 2) % 4);
      mTot++;
      const rank = (list) => list.findIndex((m) => m.id === nb && m.edge === nbEdge);
      const tr = noBox[e].matches.find((m) => m.id === nb && m.edge === nbEdge), wr = noBox[e].matches.find((m) => !(m.id === nb && m.edge === nbEdge));
      if (process.env.CALIB) calibRaw.push({ scores: PH.findMatches(p, eng.pieces.values(), { topN: 1e6 })[e].matches.filter(() => true).map((m) => m.score), truth: rank(PH.findMatches(p, eng.pieces.values(), { topN: 1e6 })[e].matches) });
      if (tr) calib.push({ p: tr.prob, ok: rank(noBox[e].matches) === 0, trueScore: tr.score, wrongScore: wr ? wr.score : null });
      const rb = rank(withBox[e].matches), rn = rank(noBox[e].matches);
      if (rb === 0) m1++; if (rb >= 0 && rb < 3) m3++;
      if (rn === 0) m1nb++; if (rn >= 0 && rn < 3) m3nb++;
    }
  }
  const matchMs = (Date.now() - t) / gtOf.size / 2;
  {
    const ts = calib.map((c) => c.trueScore), ws = calib.filter((c) => c.wrongScore != null).map((c) => c.wrongScore);
    const top = calib.filter((c) => c.ok);
    console.log(`scores: true median ${PH.median(ts).toFixed(2)} (p90 ${ts.sort((a, b) => a - b)[Math.floor(ts.length * 0.9)].toFixed(2)}), best wrong median ${PH.median(ws).toFixed(2)} (p10 ${ws.sort((a, b) => a - b)[Math.floor(ws.length * 0.1)].toFixed(2)})`);
    if (process.env.CALIB) fs.writeFileSync(path.join(__dirname, 'out', 'calib.json'), JSON.stringify(calibRaw));
    const mp = calib.reduce((a, c) => a + (c.p || 0), 0) / calib.length;
    // Erring low (under-confident) is acceptable; over-confidence is not.
    check('match probabilities are calibrated', mp - top.length / calib.length < 0.05 && top.length / calib.length - mp < 0.15, `mean probability of the true partner ${(mp * 100).toFixed(0)}% vs top-1 rate ${pct(top.length, calib.length)}`);
  }
  console.log(`edge matching: ${mTot} true joins tested, ${matchMs.toFixed(1)} ms per piece query`);
  check('true neighbor in top-3 (shape+color only)', m3nb / mTot > 0.7, `top-1 ${pct(m1nb, mTot)}, top-3 ${pct(m3nb, mTot)}`);
  check('true neighbor in top-3 (with box adjacency)', m3 / mTot > 0.85, `top-1 ${pct(m1, mTot)}, top-3 ${pct(m3, mTot)}`);

  // ---------- 3b. Partial set: only half the pieces scanned so far ----------
  {
    const rnd = PH.mulberry32(77);
    const half = [...eng.pieces.values()].filter(() => rnd() < 0.5);
    const e2 = new PH.Engine();
    e2.importState({ pieces: half.map((p) => eng.exportPiece(p)), box });
    const inSet = new Set(half.map((p) => p.id));
    let absent = 0, absentSaid = 0, absentGold = 0, present = 0, presentFound = 0, presentConfidentWrong = 0;
    for (const p of half) {
      const g = gtOf.get(p.id); if (!g) continue;
      const res = e2.matchesFor(p.id);
      const sides = sideOf.get(p.id);
      for (const r of res) {
        if (r.type === 'F') continue;
        const side = sides[r.edge];
        const nb = byCell.get((g.r + DIRS[side][1]) * cols + (g.c + DIRS[side][0]));
        if (!nb) continue;
        if (!inSet.has(nb)) {
          absent++; if (r.pNone >= 0.5) absentSaid++;
          if (r.matches[0] && r.matches[0].prob >= 0.5) absentGold++;
          else if (process.env.DBG && absent < 400) console.log('missed', 'pNone', r.pNone.toFixed(2), 'top', r.matches[0] && r.matches[0].score.toFixed(2), 'adj', r.matches[0] && r.matches[0].adj.toFixed(2), 'conf', p.t2 && p.t2.conf.toFixed(2), 'spot', JSON.stringify(r.spot));
          continue;
        }
        present++;
        const top = r.matches[0];
        if (top && top.id === nb && top.prob >= 0.5) presentFound++;
        else if (top && top.prob >= 0.5) presentConfidentWrong++;
      }
    }
    console.log(`partial set (50% scanned): partner missing -> said "not scanned" ${pct(absentSaid, absent)}, still showed a gold (wrong) match ${pct(absentGold, absent)}; partner present -> found confidently ${pct(presentFound, present)}, confident but wrong ${pct(presentConfidentWrong, present)}`);
    check('partial set: few gold matches when the partner is missing', absentGold / absent < 0.35, `${pct(absentGold, absent)} gold, ${pct(absentSaid, absent)} said not scanned`);
    check('partial set: present partners still found', presentFound / present > 0.7, pct(presentFound, present));
  }

  // ---------- 4. Live sweep with tracking (pieces as anchors) ----------
  const live = new PH.Engine();
  live.setBox(box);
  // Camera held closer than the snap (pieces 1.5x larger), panning in a
  // serpentine with a few frames at each stop like a real hand.
  const FW = 1920, FH = 1080, zoom = 1.5;
  const viewW = FW / zoom, viewH = FH / zoom;
  const path_ = [];
  const stepX = viewW * 0.3, stepY = viewH * 0.45;
  let dir = 1;
  for (let y = viewH / 2; y <= scat.TH - viewH / 2 + stepY * 0.6; y += stepY) {
    const xs = [];
    for (let x = viewW / 2; x <= scat.TW - viewW / 2 + stepX * 0.6; x += stepX) xs.push(Math.min(x, scat.TW - viewW / 2));
    if (dir < 0) xs.reverse();
    for (const x of xs) for (let k = 0; k < 3; k++) path_.push([x + k * 6, Math.min(y, scat.TH - viewH / 2)]);
    dir = -dir;
  }
  // some in-plane rotation wobble like a real hand
  let frames = 0, tTot = 0, worst = 0;
  const flagged = new Map();
  const times = { seg: 0, map: 0, work: 0 };
  // Sweep, then come back over the table (as people do): shapes are only
  // trusted - and pairs only flagged - once a second, later view agrees.
  const sweep = path_.concat(path_.slice().reverse());
  sweep.forEach(([x, y], i) => {
    const phi = Math.sin(i * 0.15) * 0.08;
    const fr = S.cameraFrame(cv, scat.table, x, y, phi, zoom, FW, FH);
    const out = live.processFrame(S.matSource(cv, fr), { still: true });
    for (const l of out.links) flagged.set(Math.min(l.a, l.b) + ':' + Math.max(l.a, l.b), l);
    frames++; tTot += out.timings.total; worst = Math.max(worst, out.timings.total);
    for (const k in times) times[k] += out.timings[k];
    if (i === 3) savePng(cv, fr, 'frame3');
    fr.delete();
  });
  const lc = live.counts();
  console.log(`live sweep: ${frames} frames, avg ${(tTot / frames).toFixed(0)} ms (seg ${(times.seg / frames).toFixed(0)}, map ${(times.map / frames).toFixed(0)}, work ${(times.work / frames).toFixed(0)}), worst ${worst.toFixed(0)} ms; counts ${JSON.stringify(lc)}`);
  // (entries: a single quick sweep catalogues; checking - two close reads - is tested in moves.js / real-50.js)
  check('live sweep catalogs pieces without duplicates', lc.entries >= n * 0.95 && lc.entries <= n * 1.05, `${lc.entries} catalogued for ${n} pieces`);
  const islands = new Set([...live.pieces.values()].filter((p) => p.pos).map((p) => p.island));
  check('live sweep keeps one consistent table map', islands.size === 1, `${islands.size} island(s)`);

  // Map consistency: table positions should be a similarity of the true layout.
  const pairs = [];
  for (const p of live.pieces.values()) {
    if (!p.pos || !p.t1) continue;
    // match to gt by box placement + position is circular; use nearest gt after fitting with a few anchors
    pairs.push(p);
  }
  // Fit using fingerprints of snap engine: same pieces have near-identical histograms
  const corr = [], liveGt = new Map();
  for (const p of pairs) {
    let best = null;
    for (const [id, g] of gtOf) {
      const q = eng.pieces.get(id);
      const s = PH.fpSimilarity(p.fp, q.fp);
      if (!best || s > best.s) best = { s, g };
    }
    if (best && best.s > 0.8) { corr.push({ src: p.pos, dst: [best.g.x, best.g.y] }); liveGt.set(p.id, best.g); }
  }
  const fit = PH.simRansac(corr, scat.core * 0.4, 200, PH.mulberry32(1));
  {
    let ok = 0;
    for (const l of flagged.values()) {
      const a = liveGt.get(l.a), b = liveGt.get(l.b);
      if (a && b && Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1) ok++;
      else if (process.env.DBG) {
        const A = live.pieces.get(l.a), B = live.pieces.get(l.b);
        console.log('bad flag', l.a, l.b, 'prob', l.prob.toFixed(2), 'gt', a && [a.r, a.c], b && [b.r, b.c], 'box', A.t2 && A.t2.cands[0] && [A.t2.cands[0].row, A.t2.cands[0].col, A.t2.conf.toFixed(2)], B.t2 && B.t2.cands[0] && [B.t2.cands[0].row, B.t2.cands[0].col, B.t2.conf.toFixed(2)], 'codes', A.t1 && A.t1.code, B.t1 && B.t1.code, 'gtcodes', a && a.code, b && b.code);
      }
    }
    // Timing-dependent (budgets), so allow an occasional miss; typically all are right.
    check('auto-flagged pairs are real neighbors', flagged.size >= 2 && ok / flagged.size >= 0.75, `${ok}/${flagged.size} flagged pairs are true neighbors`);
  }
  check('table map matches true layout', fit && fit.inliers.length >= corr.length * 0.85, fit ? `${fit.inliers.length}/${corr.length} pieces within 0.4 piece of true position` : 'no fit');

  // ---------- 5. Moved piece is updated, not duplicated ----------
  {
    const before = live.pieces.size;
    // Re-render the table with two pieces swapped places by moving a crop region.
    const g0 = scat.gt[0], g1 = scat.gt[1];
    const half = Math.round(scat.core * 0.75);
    const tb = scat.table.clone();
    const r0 = new cv.Rect(Math.round(g0.x - half), Math.round(g0.y - half), 2 * half, 2 * half);
    const r1 = new cv.Rect(Math.round(g1.x - half), Math.round(g1.y - half), 2 * half, 2 * half);
    const a = scat.table.roi(r0).clone(), b = scat.table.roi(r1).clone();
    a.copyTo(tb.roi(r1)); b.copyTo(tb.roi(r0));
    const cx = (g0.x + g1.x) / 2, cy = (g0.y + g1.y) / 2;
    if (process.env.DBG) {
      const orig = live.findMoved.bind(live);
      live.findMoved = function (d, s, claimed) {
        const q = PH.simApply(this.pose, d.cx, d.cy);
        const best = [...this.pieces.values()].map((p) => ({ p, sim: PH.fpSimilarity(d.fp, p.fp) })).sort((a, b) => b.sim - a.sim)[0];
        console.log('findMoved det', d.cx.toFixed(0), d.cy.toFixed(0), 'best', best.p.id, best.sim.toFixed(3), 'claimed', claimed.has(best.p.id), 'dist/unit', best.p.pos ? (Math.hypot(best.p.pos[0] - q[0], best.p.pos[1] - q[1]) / this.unitTable()).toFixed(2) : 'nopos', 'island', best.p.island, this.island, 'still', this.frameCtx.still);
        return orig(d, s, claimed);
      };
    }
    for (let i = 0; i < 10; i++) {
      const fr = S.cameraFrame(cv, tb, PH.clamp(cx + i * 10, viewW / 2, scat.TW - viewW / 2), PH.clamp(cy, viewH / 2, scat.TH - viewH / 2), 0.02 * i, zoom, FW, FH);
      live.processFrame(S.matSource(cv, fr), { still: true });
      fr.delete();
    }
    [tb, a, b].forEach((m) => m.delete());
    if (process.env.DBG) for (const p of live.pieces.values()) if (p.id > before) {
      const best = [...live.pieces.values()].filter((q) => q.id <= before).map((q) => ({ id: q.id, sim: PH.fpSimilarity(p.fp, q.fp), shape: p.t1 && q.t1 ? PH.sameShape(p.t1, q.t1) : null })).sort((x, y) => y.sim - x.sim).slice(0, 2);
      console.log('new piece', p.id, 'area', p.area.toFixed(0), 't1', p.t1 && p.t1.code, JSON.stringify(best));
    }
    check('swapped pieces are re-identified, not duplicated', live.pieces.size <= before + 1, `${before} -> ${live.pieces.size}`);
  }

  // ---------- 6a. Assembled blocks (js/vision/assembly.js) ----------
  {
    const blocks = [{ r0: 2, c0: 1, rows: 3, cols: 3 }, { r0: 4, c0: 5, rows: 2, cols: 3 }];
    const inBlock = (p) => blocks.some((b) => p.r >= b.r0 && p.r < b.r0 + b.rows && p.c >= b.c0 && p.c < b.c0 + b.cols);
    const subset = P.pieces.map((p, i) => i).filter((i) => !inBlock(P.pieces[i]));
    const sc2 = S.scatter(cv, P, { scale: 2.2, seed: 21, subset, blocks });
    savePng(cv, sc2.table, 'sections');
    const e3 = new PH.Engine();
    e3.setBox(box);
    const t0 = Date.now();
    e3.processSnap(S.matSource(cv, sc2.table));
    const placedAsms = (e3.asms || []).filter((A) => A.place);
    // true cell of a catalogued loose piece (nearest ground truth by position)
    const trueCell = (q) => {
      let g = null, bd = Infinity;
      const cx = q.t1.corners.reduce((s, c) => s + c[0], 0) / 4, cy = q.t1.corners.reduce((s, c) => s + c[1], 0) / 4;
      for (const gg of sc2.gt) { const d = Math.hypot(gg.x - cx, gg.y - cy); if (d < bd) { bd = d; g = gg; } }
      return g && bd < sc2.core * 0.3 ? g.r * cols + g.c : null;
    };
    const byCell = new Map();
    for (const q of e3.pieces.values()) if (q.t1) { const c = trueCell(q); if (c !== null) byCell.set(c, q.id); }
    let located = 0, offeredOk = 0, offeredTot = 0;
    for (const bg of sc2.blocks) {
      let best = null;
      for (const A of placedAsms) {
        const f = A.filledBoxCells(box), ov = bg.cells.filter((c) => f.has(c)).length / bg.cells.length;
        if (!best || ov > best.ov) best = { ov, A };
      }
      if (!best || best.ov < 0.6) continue;
      located++;
      // the loose piece that truly belongs in each open spot is offered for it (top 3)
      for (const sp of best.A.spots(box)) {
        if (!sp.cell) continue;
        const id = byCell.get(sp.cell[1] * cols + sp.cell[0]);
        if (!id) continue;
        const need = ['?', '?', '?', '?'];
        sp.need.forEach((t, d) => (need[(d + best.A.place.k) % 4] = t));
        offeredTot++;
        if (e3.spotPieces(sp.cell[0], sp.cell[1], need, 3).some((x) => x.id === id)) offeredOk++;
      }
    }
    console.log(`assembled blocks: ${placedAsms.length} placed of ${(e3.asms || []).length} built (${Date.now() - t0} ms snap); ${located}/${sc2.blocks.length} blocks located; right piece offered for ${offeredOk}/${offeredTot} open spots`);
    check('assembled blocks are located on the box', located === sc2.blocks.length, `${located}/${sc2.blocks.length}`);
    check('the right loose piece is offered for their open spots', offeredTot > 0 && offeredOk / offeredTot >= 0.6, `${offeredOk}/${offeredTot}`);
  }

  // ---------- 6b. Phone held at an angle (tilt correction) ----------
  {
    const run = (pitch, roll, correct) => {
      const v = S.tiltedFrame(cv, scat.table, scat.TW / 2, scat.TH / 2, 1.3, 1080, 1920, pitch, roll, 66);
      const e = new PH.Engine({ tiltCorrection: correct });
      const res = e.processSnap(S.matSource(cv, v.mat), { tilt: { down: v.down, fov: 66 } });
      if (SAVE && correct && pitch) savePng(cv, v.mat, 'tilt');
      v.mat.delete();
      // same physical piece in the top-down reference catalog, by outline only
      let same = 0, n = 0;
      for (const p of e.pieces.values()) {
        if (!p.t1) continue; n++;
        let best = Infinity;
        for (const q of eng.pieces.values()) if (q.t1) best = Math.min(best, PH.sameShape(p.t1, q.t1));
        if (best < PH.SAME_SHAPE) same++;
      }
      return { found: res.found, n, same };
    };
    // Photo with no sensor data: tilt estimated from the pieces themselves.
    for (const [tp, tr] of [[30, 8], [45, -10]]) {
      const v = S.tiltedFrame(cv, scat.table, scat.TW / 2, scat.TH / 2, 1.3, 1080, 1920, tp, tr, 66);
      const e = new PH.Engine();
      const est = e.estimatePhotoTilt(S.matSource(cv, v.mat));
      v.mat.delete();
      const err = est ? Math.acos(Math.min(1, est.down[0] * v.down[0] + est.down[1] * v.down[1] + est.down[2] * v.down[2])) * 180 / Math.PI : 99;
      console.log(`auto tilt: true pitch ${tp} roll ${tr} -> estimated pitch ${est && est.pitch} roll ${est && est.roll} (error ${err.toFixed(1)}°)`);
      check(`tilt estimated from the photo itself (${tp}°)`, err < 6, `${err.toFixed(1)}° off`);
    }
    const TP = +(process.env.TILT || 30); const flat = run(0, 0, true), raw = run(TP, 8, false), fixed = run(TP, 8, true);
    console.log(`tilt ${TP}°: straight-down ${flat.same}/${flat.n} shapes match reference; tilted raw ${raw.same}/${raw.n}; tilted+corrected ${fixed.same}/${fixed.n}`);
    // Benefit = more correctly-read pieces (uncorrected, stretched pieces now
    // mostly fail the "looks like a piece" gate instead of being misread).
    check('tilted view is straightened (shapes match top-down)', fixed.n >= 5 && fixed.same / fixed.n >= 0.8 && fixed.same > raw.same * 1.5, `${fixed.same} correct pieces (${pct(fixed.same, fixed.n)}) vs ${raw.same} uncorrected`);
  }

  // ---------- 6. Persistence round-trip ----------
  {
    const dump = live.takeDirty();
    const e2 = new PH.Engine();
    e2.importState({ pieces: dump.put, box });
    check('catalog export/import round-trip', e2.pieces.size === live.pieces.size, `${e2.pieces.size} pieces`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
