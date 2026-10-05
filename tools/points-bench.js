/* Bench for the two point systems of an edge (PH.GEOM_PTS, PH.COLOUR_PTS).
 *   node tools/points-bench.js colour   # colour point designs, on real box pictures cut into pieces
 *   node tools/points-bench.js pairing  # how facing colour points are paired
 *   node tools/points-bench.js geom     # geometry point designs (synthetic joins + the owner's video)
 *   node tools/points-bench.js why      # which read conditions make true joins fail the colour rule
 * Each design: regions of the chickens and reef box pictures are cut into
 * 8x6 jigsaw puzzles (test/synth.js tab cuts), scattered on a board at close-
 * read size (~240 px a piece) with each piece's light (and the board around
 * it) varied as between frames, read through the app's photo path, and every
 * read edge paired with its true neighbour's. Reported per design:
 *   top1  colour alone ranks the true partner first among all edges of the
 *         right type (T vs B) of the other pieces;
 *   auc   chance a true join's colour distance is smaller than a wrong pair's;
 *   rej98 wrong pairs rejected by the limit that keeps 98% of true joins.
 * Colour distance of two edges = median over facing points (A's s with B's
 * n-1-s) of the light-corrected colour difference.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('../test/synth');
const { readImage } = require('../test/imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
const ROOT = path.join(__dirname, '..');
const mode = process.argv[2] || 'colour';

// pairing of facing points: 'index' (A's s with B's n-1-s), 'lag' (best of
// small shifts), 'pos' (B's points mirrored into A's edge frame, nearest);
// wL: weight of lightness in the colour difference
const CMP = { pair: 'index', lag: 2, wL: 0.7 };
function colourDist(eA, eB) {
  const a = eA.pcol, b = eB.pcol, n = a.length / 3, m = b.length / 3;
  const dd = (s, r) => PH.dE(a[3 * s], a[3 * s + 1], a[3 * s + 2], b[3 * r], b[3 * r + 1], b[3 * r + 2], CMP.wL);
  if (CMP.pair === 'lag') {
    let best = Infinity;
    for (let l = -CMP.lag; l <= CMP.lag; l++) { const d = []; for (let s = 0; s < n; s++) { const r = n - 1 - s + l; if (r >= 0 && r < m) d.push(dd(s, r)); } if (d.length > n / 2) best = Math.min(best, PH.median(d)); }
    return best;
  }
  if (CMP.pair === 'pos' && eA.pxy && eB.pxy) {
    const d = [];
    for (let s = 0; s < n; s++) {
      const x = eA.pxy[2 * s], y = eA.pxy[2 * s + 1];
      let br = -1, bd = Infinity;
      for (let r = 0; r < m; r++) { const bx = 1 - eB.pxy[2 * r], by = -eB.pxy[2 * r + 1], q = (bx - x) ** 2 + (by - y) ** 2; if (q < bd) { bd = q; br = r; } }
      if (Math.sqrt(bd) < 0.08) d.push(dd(s, br));
    }
    return d.length ? PH.median(d) : 99;
  }
  const d = []; for (let s = 0; s < n; s++) d.push(dd(s, Math.min(m - 1, Math.round(((n - 1 - s) * (m - 1)) / Math.max(1, n - 1)))));
  return PH.median(d);
}

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  // source pictures: chickens box (pale, ~70 px a cell) and the reef box (busy, from the owner's screenshot)
  const pics = [];
  {
    const im = readImage(path.join(__dirname, '..', 'test', 'fixtures', 'chickens-box.jpg'));
    const m = new cv.Mat(im.h, im.w, cv.CV_8UC4); m.data.set(im.data); pics.push({ name: 'chickens', mat: m, cell: im.w / 37 });
  }
  {
    const shot = path.join(ROOT, 'reports', 'IMG_3591.PNG');
    if (fs.existsSync(shot)) {
      const im = readImage(shot); const m = new cv.Mat(im.h, im.w, cv.CV_8UC4); m.data.set(im.data);
      const src = cv.matFromArray(4, 1, cv.CV_32FC2, [80, 312, 750, 320, 745, 1225, 92, 1218]), dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 675, 0, 675, 900, 0, 900]);
      const M = cv.getPerspectiveTransform(src, dst), w = new cv.Mat();
      cv.warpPerspective(m, w, M, new cv.Size(675, 900)); [m, src, dst, M].forEach((x) => x.delete());
      pics.push({ name: 'reef', mat: w, cell: 45 });
    }
  }
  const regions = [];
  for (const pic of pics) {
    const cw = pic.cell, R = (c0, r0) => ({ pic, x: Math.round(c0 * cw), y: Math.round(r0 * cw), w: Math.round(8 * cw), h: Math.round(6 * cw) });
    if (pic.name === 'chickens') regions.push(R(4, 4), R(16, 12), R(26, 18));
    else regions.push(R(2, 3), R(5, 12));
  }

  // read a scattered table through the photo path; read entries <-> ground
  // truth by centre, read edge k <-> true side by direction
  function readTable(sc) {
    const eng = new PH.Engine({ checkedOnly: false, autoTilt: false });
    eng.processSnap(S.matSource(cv, sc.table));
    const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const reads = new Map(); // gt index -> {t1, side2edge, g}
    for (const p of eng.pieces.values()) {
      if (!p.t1) continue;
      const c = p.t1.corners, cx = c.reduce((t, q) => t + q[0], 0) / 4, cy = c.reduce((t, q) => t + q[1], 0) / 4;
      let gi = -1, bd = Infinity;
      sc.gt.forEach((g, i) => { const d = Math.hypot(g.x - cx, g.y - cy); if (d < bd) { bd = d; gi = i; } });
      if (bd > sc.core * 0.4) continue;
      const g = sc.gt[gi], side2edge = [-1, -1, -1, -1];
      for (let k = 0; k < 4; k++) {
        const mx = (c[k][0] + c[(k + 1) % 4][0]) / 2 - cx, my = (c[k][1] + c[(k + 1) % 4][1]) / 2 - cy, ml = Math.hypot(mx, my) || 1;
        let bs = -1, bdot = -2;
        for (let sIdx = 0; sIdx < 4; sIdx++) { const [ux, uy] = DIR[sIdx], rx = Math.cos(g.rot) * ux - Math.sin(g.rot) * uy, ry = Math.sin(g.rot) * ux + Math.cos(g.rot) * uy, dot = (rx * mx + ry * my) / ml; if (dot > bdot) { bdot = dot; bs = sIdx; } }
        side2edge[bs] = k;
      }
      reads.set(gi, { t1: p.t1, side2edge, g });
    }
    return reads;
  }

  async function runDesign(design) {
    Object.assign(PH.COLOUR_PTS, design.colour || {});
    Object.assign(PH.GEOM_PTS, design.geom || {});
    const joins = [], edgesAll = [];
    let seed = 1;
    for (const rg of regions) {
      const crop = rg.pic.mat.roi(new cv.Rect(rg.x, rg.y, Math.min(rg.w, rg.pic.mat.cols - rg.x), Math.min(rg.h, rg.pic.mat.rows - rg.y))).clone();
      const cs = 60, P = S.makePuzzle(cv, { cols: 8, rows: 6, cs, seed: seed++, image: crop });
      const sc = S.scatter(cv, P, { scale: 240 / cs, seed: seed++ });
      // each piece's light as in its own frame: piece and the board around it
      const rnd = S.makeRng(seed++), td = sc.table.data, TW = sc.table.cols, TH = sc.table.rows, half = Math.round(sc.core * 0.95);
      for (const g of sc.gt) {
        const k = 0.8 + rnd() * 0.4, ca = (rnd() - 0.5) * 10, cb = (rnd() - 0.5) * 10;
        for (let y = Math.max(0, Math.round(g.y - half)); y < Math.min(TH, g.y + half); y++) for (let x = Math.max(0, Math.round(g.x - half)); x < Math.min(TW, g.x + half); x++) {
          const i = 4 * (y * TW + x);
          td[i] = Math.min(255, td[i] * k + ca); td[i + 1] = Math.min(255, td[i + 1] * k); td[i + 2] = Math.min(255, td[i + 2] * k + cb);
        }
      }
      const reads = readTable(sc);
      const at = new Map(); for (const [gi, r] of reads) at.set(r.g.r + ',' + r.g.c, r);
      const tag = rg.pic.name + ':' + rg.x;
      for (const [, r] of reads) {
        for (let side = 0; side < 4; side++) { const k = r.side2edge[side]; if (k >= 0) edgesAll.push({ tag, piece: r, side, e: r.t1.edges[k], type: r.g.code[side] }); }
        for (const [side, dr, dc, os] of [[1, 0, 1, 3], [2, 1, 0, 0]]) {
          const q = at.get((r.g.r + dr) + ',' + (r.g.c + dc));
          if (!q || r.g.code[side] === 'F') continue;
          const ka = r.side2edge[side], kb = q.side2edge[os];
          if (ka < 0 || kb < 0) continue;
          joins.push({ tag, a: r, b: q, ea: r.t1.edges[ka], eb: q.t1.edges[kb], ta: r.g.code[side], tb: q.g.code[os] });
        }
      }
      crop.delete(); sc.table.delete();
    }
    // colour metrics
    const flip = { T: 'B', B: 'T' };
    const tD = [], wD = [];
    let top1 = 0;
    for (const j of joins) {
      const dt = colourDist(j.ea, j.eb);
      tD.push(dt);
      let better = 0;
      for (const o of edgesAll) {
        if (o.tag !== j.tag || o.piece === j.a || o.piece === j.b || o.type !== flip[j.ta]) continue;
        const d = colourDist(j.ea, o.e); wD.push(d);
        if (d <= dt) better++;
      }
      if (!better) top1++;
    }
    tD.sort((a, b) => a - b); wD.sort((a, b) => a - b);
    let auc = 0, wi = 0; for (const t of tD) { while (wi < wD.length && wD[wi] < t) wi++; auc += 1 - wi / wD.length; } auc /= tD.length;
    const lim = tD[Math.floor((tD.length - 1) * 0.98)], rej = wD.filter((d) => d > lim).length / wD.length;
    return { joins: joins.length, top1: +(top1 / joins.length).toFixed(3), auc: +auc.toFixed(3), rej98: +rej.toFixed(3), lim: +lim.toFixed(1), trueMed: +PH.median(tD).toFixed(1) };
  }

  // ---- geometry ----
  const flip = { T: 'B', B: 'T' };
  // the join score without colour or box help: what the outline alone says
  const geo = (ea, eb) => { const r = PH.edgeScore(ea, eb); return r ? r.shape * 12 + Math.abs(Math.log(ea.lenRel / eb.lenRel)) * 4 : Infinity; };
  // an edge as its own partner would read it (to compare two reads of one edge)
  const partnerOf = (e) => {
    const n = e.sig.length / 2, sig = new Float32Array(2 * n);
    for (let s = 0; s < n; s++) { const r = n - 1 - s; sig[2 * r] = 1 - e.sig[2 * s]; sig[2 * r + 1] = -e.sig[2 * s + 1]; }
    return { type: flip[e.type] || e.type, sig, gtrim: e.gtrim, lenRel: e.lenRel, strip: e.strip, unc: false };
  };
  function rankStats(rows) { // rows: {t: true score, w: [wrong scores]}
    let top1 = 0, ties = 0, auc = 0, n = 0;
    for (const r of rows) {
      n++;
      if (!isFinite(r.t)) continue; // a true pair the outline can't even pair: a miss
      const below = r.w.filter((x) => x <= r.t).length;
      if (!below) top1++;
      if (r.w.some((x) => x <= r.t + PH.TIE_MARGIN)) ties++;
      auc += r.w.length ? 1 - below / r.w.length : 1;
    }
    const ts = rows.map((r) => r.t).filter(isFinite).sort((a, b) => a - b);
    return { n, p90: ts.length ? +ts[Math.floor((ts.length - 1) * 0.9)].toFixed(3) : null, top1: +(top1 / n).toFixed(3), tie: +(ties / n).toFixed(3), auc: +(auc / n).toFixed(4), med: +PH.median(rows.map((r) => r.t).filter(isFinite)).toFixed(3) };
  }
  // synthetic: one read at 240 px a piece, the other at ~140 px blurred (the
  // two reads of a join are made at different times and distances)
  async function runGeomSynth() {
    const rows = [], ids = [];
    let seed = 101, typeOk = 0, typeN = 0;
    for (const rg of regions) {
      const crop = rg.pic.mat.roi(new cv.Rect(rg.x, rg.y, Math.min(rg.w, rg.pic.mat.cols - rg.x), Math.min(rg.h, rg.pic.mat.rows - rg.y))).clone();
      const cs = 60, P = S.makePuzzle(cv, { cols: 8, rows: 6, cs, seed: seed++, image: crop });
      const scA = S.scatter(cv, P, { scale: 240 / cs, seed: seed++ }), scB = S.scatter(cv, P, { scale: 140 / cs, seed: seed++ });
      const bl = new cv.Mat(); cv.GaussianBlur(scB.table, bl, new cv.Size(0, 0), 1.2); bl.copyTo(scB.table); bl.delete();
      const A = readTable(scA), B = readTable(scB), atB = new Map();
      for (const [, r] of B) atB.set(r.g.r + ',' + r.g.c, r);
      for (const R of [A, B]) for (const [, r] of R) for (let side = 0; side < 4; side++) { const k = r.side2edge[side]; if (k < 0) continue; typeN++; if (r.t1.edges[k].type === r.g.code[side]) typeOk++; }
      for (const [, r] of A) {
        const twin = atB.get(r.g.r + ',' + r.g.c);
        if (twin) { const d = (q) => PH.shapeAlign(r.t1, q.t1).d; ids.push({ t: d(twin), w: [...B.values()].filter((q) => q !== twin).map(d) }); }
        for (const [side, dr, dc, os] of [[0, -1, 0, 2], [1, 0, 1, 3], [2, 1, 0, 0], [3, 0, -1, 1]]) {
          const q = atB.get((r.g.r + dr) + ',' + (r.g.c + dc));
          if (!q || r.g.code[side] === 'F') continue;
          const ka = r.side2edge[side], kb = q.side2edge[os];
          if (ka < 0 || kb < 0) continue;
          const ea = r.t1.edges[ka], t = geo(ea, q.t1.edges[kb]), w = [];
          for (const [, o] of B) if (o !== q && !(o.g.r === r.g.r && o.g.c === r.g.c)) for (const e of o.t1.edges) { const x = geo(ea, e); if (isFinite(x)) w.push(x); }
          rows.push({ t, w });
        }
      }
      crop.delete(); scA.table.delete(); scB.table.delete();
    }
    const j = rankStats(rows), id = rankStats(ids);
    return { join: j, ident: { top1: id.top1, auc: id.auc }, types: +(typeOk / typeN).toFixed(3) };
  }
  // the owner's video: pairs of close frames a fraction of a second apart ->
  // two reads of the same edges (true read noise, real blur and light) vs
  // every other edge of that type in the frame (look-alikes)
  const VIDEO_PAIRS = [[432, 438], [462, 468], [513, 522], [696, 705], [957, 963], [975, 987], [1200, 1206], [1212, 1218], [1464, 1470], [1875, 1878]];
  let frames = null;
  async function videoFramesCached() {
    if (frames) return frames;
    const { videoFrames } = require('../test/videoframes');
    const want = new Set(VIDEO_PAIRS.flat());
    frames = new Map();
    const file = path.join(ROOT, 'reports', 'IMG_3593.MOV');
    if (!fs.existsSync(file)) return frames;
    for await (const f of videoFrames(file, { step: 3, from: 14, to: 63 })) if (want.has(f.i)) frames.set(f.i, f);
    return frames;
  }
  function readFrame(f) {
    const m = new cv.Mat(f.h, f.w, cv.CV_8UC4); m.data.set(f.data);
    const eng = new PH.Engine({ checkedOnly: false }); eng.processSnap(S.matSource(cv, m)); m.delete();
    const out = [];
    for (const p of eng.pieces.values()) if (p.t1) { const c = p.t1.corners; out.push({ cx: c.reduce((t, q) => t + q[0], 0) / 4, cy: c.reduce((t, q) => t + q[1], 0) / 4, t1: p.t1, side: p.t1.meanSide }); }
    return out;
  }
  async function runGeomVideo() {
    const F = await videoFramesCached(), rows = [], ids = [];
    let pcs = 0, agree = 0;
    for (const [ia, ib] of VIDEO_PAIRS) {
      if (!F.has(ia) || !F.has(ib)) continue;
      const A = readFrame(F.get(ia)), B = readFrame(F.get(ib));
      const sp = A.length ? A.reduce((t, p) => t + p.side, 0) / A.length : 300;
      let best = null;
      for (const p of A) for (const q of B) {
        const dx = p.cx - q.cx, dy = p.cy - q.cy;
        if (Math.hypot(dx, dy) > sp * 0.45) continue;
        let n = 0;
        for (const p2 of A) for (const q2 of B) if (Math.hypot(p2.cx - q2.cx - dx, p2.cy - q2.cy - dy) < sp * 0.3) n++;
        if (!best || n > best.n) best = { dx, dy, n };
      }
      if (!best) continue;
      for (const q of B) {
        const p = A.find((o) => Math.hypot(o.cx - q.cx - best.dx, o.cy - q.cy - best.dy) < sp * 0.3);
        if (!p) continue;
        pcs++;
        { const d = (o) => PH.shapeAlign(p.t1, o.t1).d; ids.push({ t: d(q), w: B.filter((o) => o !== q).map(d) }); }
        const al = PH.shapeAlign(p.t1, q.t1);
        if (al.r < 0) continue;
        agree++;
        for (let k = 0; k < 4; k++) {
          const ea = p.t1.edges[k], eb = q.t1.edges[(k + al.r) % 4];
          if (ea.type === 'F' || ea.type !== eb.type) continue;
          const t = geo(ea, partnerOf(eb)), w = [];
          for (const o of B) if (o !== q) for (const e of o.t1.edges) if (e.type === ea.type) { const x = geo(ea, partnerOf(e)); if (isFinite(x)) w.push(x); }
          rows.push({ t, w });
        }
      }
    }
    const j = rankStats(rows), id = rankStats(ids);
    return { pieces: pcs, codesAgree: +(agree / Math.max(1, pcs)).toFixed(3), sameEdge: j, ident: { top1: id.top1, auc: id.auc } };
  }
  if (mode === 'geom') {
    const designs = process.argv[3] ? JSON.parse(process.argv[3]) : [
      ['32 points (now)', { n: 32, trim: 0 }], ['16 points', { n: 16, trim: 0 }], ['24 points', { n: 24, trim: 0 }], ['48 points', { n: 48, trim: 0 }], ['64 points', { n: 64, trim: 0 }],
      ['32, skip 3% at corners', { n: 32, trim: 0.03 }], ['32, skip 6% at corners', { n: 32, trim: 0.06 }], ['48, skip 3% at corners', { n: 48, trim: 0.03 }],
    ];
    for (const [name, g] of designs) {
      Object.assign(PH.GEOM_PTS, { n: 32, trim: 0 }, g);
      const t0 = Date.now();
      const syn = await runGeomSynth(), vid = await runGeomVideo();
      // cost of one edge comparison (the matcher runs thousands)
      const e1 = PH.GEOM_PTS.n, ea = { type: 'T', sig: new Float32Array(2 * e1).map((_, i) => (i % 2 ? 0.1 : i / (2 * e1))), lenRel: 1, strip: new Float32Array(48) }, eb = Object.assign({}, ea, { type: 'B' });
      const c0 = process.hrtime.bigint();
      for (let i = 0; i < 20000; i++) PH.edgeScore(ea, eb);
      const us = Number(process.hrtime.bigint() - c0) / 20000 / 1000;
      console.log(name.padEnd(30), JSON.stringify({ syn, vid, usPerScore: +us.toFixed(2), s: Math.round((Date.now() - t0) / 1000) }));
    }
    return;
  }

  // ---- when colour can't be trusted ----
  // Each piece gets one condition (as a phone frame might give it): normal
  // light; dark (underexposed, noisy); overexposed (light print washes out);
  // a glare spot; motion blur; a strong colour cast (lamp vs daylight); and a
  // whole table read small. Every true join and a sample of wrong pairs is
  // run through the colour rule (PH.colourAgree >= PH.COL_SHARE), with the
  // conditions each read records (edge.cc, t1.lf, t1.quality, t1.meanSide).
  const CONDS = ['normal', 'normal', 'dark', 'bright', 'glare', 'blur', 'cast'];
  function applyCond(sc, rnd, only) {
    const td = sc.table.data, TW = sc.table.cols, TH = sc.table.rows, half = Math.round(sc.core * 0.95);
    const cond = [];
    for (const g of sc.gt) {
      const c = only || CONDS[Math.floor(rnd() * CONDS.length)];
      cond.push(c);
      const x0 = Math.max(0, Math.round(g.x - half)), y0 = Math.max(0, Math.round(g.y - half)), x1 = Math.min(TW, Math.round(g.x + half)), y1 = Math.min(TH, Math.round(g.y + half));
      let k = 0.8 + rnd() * 0.4, ca = (rnd() - 0.5) * 10, cb = (rnd() - 0.5) * 10, noise = 0;
      if (c === 'dark') { k = 0.4 + rnd() * 0.15; noise = 8; }
      if (c === 'bright') k = 1.5 + rnd() * 0.4;
      if (c === 'cast') { ca = (rnd() < 0.5 ? -1 : 1) * (18 + rnd() * 12); cb = -ca * 0.8; }
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = 4 * (y * TW + x), nz = noise ? (rnd() - 0.5) * 2 * noise : 0;
        td[i] = PH.clamp(td[i] * k + ca + nz, 0, 255); td[i + 1] = PH.clamp(td[i + 1] * k + nz, 0, 255); td[i + 2] = PH.clamp(td[i + 2] * k + cb + nz, 0, 255);
      }
      if (c === 'glare') { // a soft white highlight on part of the piece
        const gx = g.x + (rnd() - 0.5) * sc.core * 0.6, gy = g.y + (rnd() - 0.5) * sc.core * 0.6, R = sc.core * (0.25 + rnd() * 0.15);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const d = Math.hypot(x - gx, y - gy) / R; if (d >= 1) continue;
          const a = Math.min(1, 1.6 * (1 - d)), i = 4 * (y * TW + x);
          for (let ch = 0; ch < 3; ch++) td[i + ch] = td[i + ch] * (1 - a) + 252 * a;
        }
      }
      if (c === 'blur') {
        const r = new cv.Rect(x0, y0, x1 - x0, y1 - y0), roi = sc.table.roi(r), b = new cv.Mat();
        const ksz = Math.round(sc.core * 0.06) | 1, K = cv.Mat.zeros(ksz, ksz, cv.CV_32F); // motion blur along a random direction
        const th = rnd() * Math.PI;
        for (let t = 0; t < ksz; t++) { const u = t - (ksz - 1) / 2, xx = Math.round((ksz - 1) / 2 + u * Math.cos(th)), yy = Math.round((ksz - 1) / 2 + u * Math.sin(th)); K.data32F[yy * ksz + xx] = 1 / ksz; }
        cv.filter2D(roi, b, -1, K); b.copyTo(roi); [roi, b, K].forEach((m) => m.delete());
      }
    }
    return cond;
  }
  async function runWhy() {
    const rows = [], wrong = [];
    let seed = 301;
    for (const small of [false, true]) for (const rg of regions) {
      const crop = rg.pic.mat.roi(new cv.Rect(rg.x, rg.y, Math.min(rg.w, rg.pic.mat.cols - rg.x), Math.min(rg.h, rg.pic.mat.rows - rg.y))).clone();
      const cs = 60, P = S.makePuzzle(cv, { cols: 8, rows: 6, cs, seed: seed++, image: crop });
      const sc = S.scatter(cv, P, { scale: (small ? 120 : 240) / cs, seed: seed++ });
      const rnd = S.makeRng(seed++), cond = applyCond(sc, rnd, small ? 'normal' : null);
      const reads = readTable(sc), at = new Map();
      for (const [gi, r] of reads) { r.cond = small ? 'small' : cond[gi]; at.set(r.g.r + ',' + r.g.c, r); }
      const fac = (r, e) => ({ clip: e.cc ? e.cc.clip : 0, busy: e.cc ? e.cc.busy : 0, k: r.t1.lf ? r.t1.lf.kRaw || r.t1.lf.k : 1, doubt: e.cdoubt || null, sharp: r.t1.quality ? r.t1.quality.sharp : 0, side: r.t1.meanSide, cond: r.cond });
      const all = [];
      for (const [, r] of reads) for (let side = 0; side < 4; side++) { const k = r.side2edge[side]; if (k >= 0 && r.g.code[side] !== 'F') all.push({ r, e: r.t1.edges[k], type: r.g.code[side] }); }
      for (const [, r] of reads) for (const [side, dr, dc, os] of [[1, 0, 1, 3], [2, 1, 0, 0]]) {
        const q = at.get((r.g.r + dr) + ',' + (r.g.c + dc));
        if (!q || r.g.code[side] === 'F') continue;
        const ka = r.side2edge[side], kb = q.side2edge[os];
        if (ka < 0 || kb < 0) continue;
        const ea = r.t1.edges[ka], eb = q.t1.edges[kb];
        rows.push({ share: PH.colourAgree(ea, eb), a: fac(r, ea), b: fac(q, eb) });
        // wrong partners of the right type for the same edge
        for (const o of all) if (o.r !== r && o.r !== q && o.type !== r.g.code[side] && rnd() < 0.15) wrong.push({ share: PH.colourAgree(ea, o.e), a: fac(r, ea), b: fac(o.r, o.e) });
      }
      crop.delete(); sc.table.delete();
    }
    return { rows, wrong };
  }
  if (mode === 'why') {
    PH.colTol = +(process.env.TOL || 20);
    if (process.env.LIGHTK) PH.LIGHT_K = JSON.parse(process.env.LIGHTK);
    const { rows, wrong } = await runWhy();
    const pass = (x) => x.share !== null && x.share >= PH.COL_SHARE;
    const rate = (L) => (L.length ? (L.filter(pass).length / L.length).toFixed(3) : '-');
    console.log(`colTol ${PH.colTol}: true joins ${rows.length}, pass ${rate(rows)}; wrong pairs ${wrong.length}, wrongly passed ${rate(wrong)}`);
    // by condition: the worse of the two reads decides
    const worse = (x) => (x.a.cond !== 'normal' ? x.a.cond : x.b.cond);
    for (const c of ['normal', 'dark', 'bright', 'glare', 'blur', 'cast', 'small']) {
      const T = rows.filter((x) => worse(x) === c), W = wrong.filter((x) => worse(x) === c);
      console.log(`  ${c.padEnd(7)} true pass ${rate(T)} (${T.length})   wrong passed ${rate(W)} (${W.length})`);
    }
    // by recorded factor (the worse of the two edges)
    const bins = {
      clip: [(x) => Math.max(x.a.clip, x.b.clip), [0, 0.01, 0.1, 0.2, 0.35, 0.5, 1.01]],
      busy: [(x) => Math.max(x.a.busy, x.b.busy), [0, 4, 8, 12, 16, 24, 99]],
      lightK: [(x) => Math.max(Math.abs(Math.log(x.a.k)), Math.abs(Math.log(x.b.k))), [0, 0.1, 0.2, 0.3, 0.45, 0.6, 9]],
      sharp: [(x) => Math.min(x.a.sharp, x.b.sharp), [0, 10, 15, 20, 30, 45, 999]],
      side: [(x) => Math.min(x.a.side, x.b.side), [0, 80, 100, 120, 160, 200, 999]],
    };
    for (const [name, [f, B]] of Object.entries(bins)) {
      const parts = [];
      for (let i = 0; i + 1 < B.length; i++) {
        const T = rows.filter((x) => f(x) >= B[i] && f(x) < B[i + 1]), W = wrong.filter((x) => f(x) >= B[i] && f(x) < B[i + 1]);
        if (T.length) parts.push(`[${B[i]},${B[i + 1]}) ${rate(T)}/${rate(W)} n${T.length}`);
      }
      console.log(`  ${name.padEnd(6)} true pass / wrong passed: ${parts.join('  ')}`);
    }
    if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify({ rows, wrong }));
    return;
  }

  const base = { n: 32, ends: 0, depth: 0.03, depth2: 0, patch: 1 };
  const designs = mode === 'colour' ? [
    ['baseline (on the geometry points, 32, 3% in)', {}],
    ['16 points', { n: 16 }], ['24 points', { n: 24 }], ['48 points', { n: 48 }],
    ['skip 5% at corners', { ends: 0.05 }], ['skip 10% at corners', { ends: 0.1 }],
    ['2% in', { depth: 0.02 }], ['4% in', { depth: 0.04 }], ['2% + 4% averaged', { depth: 0.02, depth2: 0.04 }],
    ['5x5 patch', { patch: 2 }], ['7x7 patch', { patch: 3 }],
  ] : JSON.parse(process.argv[3] || '[]');
  if (mode === 'pairing') designs.push(...[
    ['index pairing (now)', {}, { pair: 'index' }], ['shift search +-1', {}, { pair: 'lag', lag: 1 }], ['shift search +-2', {}, { pair: 'lag', lag: 2 }], ['shift search +-3', {}, { pair: 'lag', lag: 3 }],
    ['pair by position', {}, { pair: 'pos' }], ['pair by position, colour only (no L)', {}, { pair: 'pos', wL: 0 }], ['index, colour only (no L)', {}, { pair: 'index', wL: 0 }],
    ['pair by position, 48 pts', { n: 48 }, { pair: 'pos' }], ['pair by position, 2% in', { depth: 0.02 }, { pair: 'pos' }],
  ]);
  for (const [name, colour, cmp] of designs) {
    Object.assign(CMP, { pair: 'index', lag: 2, wL: 0.7 }, cmp || {});
    const r = await runDesign({ colour: Object.assign({}, base, colour) });
    console.log(name.padEnd(46), JSON.stringify(r));
  }
})();
