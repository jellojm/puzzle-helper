/* Test mode (owner, 2026-10-11: "try multiple things all at the same time
 * and build out a detailed report for analysis"): one picture read several
 * ways, each on a throwaway engine (the catalogue is not touched). Runs in
 * the worker (Settings -> Test mode) and in node (tools/testmode.js), so a
 * phone report and a PC run measure the same thing. */
(function (G) {
  'use strict';
  const PH = (G.PH = G.PH || {});
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // Every tested picture goes through several ways of reading it, each on a
  // throwaway engine (the catalogue is not touched); the numbers go into the
  // report for analysis.
  PH.TEST_VARIANTS = [
    { name: 'app as is' },
    { name: 'glass mode, outline level 30/80', opts: { snapBg: { kind: 'edges', edgeT: [30, 80] } } },
    { name: 'glass mode, outline level 50/120', opts: { snapBg: { kind: 'edges', edgeT: [50, 120] } } },
    { name: 'colour models only (no glass mode)', opts: { edgeBg: false } },
    { name: 'no learned background', opts: { learnBg: false } },
    { name: 'no shadow peel', ph: { SHADOW_PEEL: null } },
    { name: 'no corner splitter', ph: { CORNER_MAX_UNITS: 0 } },
    { name: 'no tilt estimate', opts: { autoTilt: false } },
    { name: 'no photo fit (first background choice kept)', opts: { photoFit: false } },
    { name: 'lower resolution (1200 px)', opts: { snapProcW: 1200 } },
    { name: 'old light window (1/10)', ph: { FLAT_DIV: 10 } },
  ];
  // how square a read is: each corner's angle off 90 deg (between its neighbours)
  function cornerOff(corners) {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const a = corners[(k + 3) % 4], b = corners[k], c = corners[(k + 1) % 4];
      const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
      const ang = (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v) || 1)))) * 180) / Math.PI;
      out.push(Math.abs(ang - 90));
    }
    return out;
  }
  const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[s.length >> 1].toFixed(3); };
  PH.runTestVariant = function (v, src, base, info) {
    const keep = {};
    for (const k in v.ph || {}) { keep[k] = PH[k]; PH[k] = v.ph[k]; }
    const AP = PH.analyzePiece;
    let reads = 0, readsOk = 0;
    PH.analyzePiece = (crop, ctx) => { reads++; const r = AP(crop, ctx); if (r) readsOk++; return r; };
    const t0 = now();
    try {
      const e = new PH.Engine(Object.assign({ checkedOnly: false, minDE: base ? base.opts.minDE : 8, procW: base ? base.opts.procW : 640 }, v.opts || {}));
      e.taught = base ? (base.taught || []).slice() : [];
      if (base && base.box) e.setBox(base.box);
      const r = e.processSnap(src, info || {});
      const P = [...e.pieces.values()].filter((p) => p.t1);
      const codes = {};
      for (const p of P) { const f = [...p.t1.code].filter((c) => c === 'F').length; const k = f >= 2 ? 'corner' : f === 1 ? 'edge' : 'inside'; codes[k] = (codes[k] || 0) + 1; }
      const offs = P.flatMap((p) => cornerOff(p.t1.corners));
      const m = e.snapModelUsed;
      return {
        name: v.name, dets: e.snapSeg ? e.snapSeg.n : null, clumps: e.snapSeg ? e.snapSeg.merged : null, cutByEdge: e.snapSeg ? e.snapSeg.border : null, found: r.found, added: r.added, shaped: r.shaped, placed: r.placed || 0, reads, readsOk,
        kinds: codes, unitPx: e.frameCtx && e.frameCtx.unitArea ? Math.round(e.frameCtx.unitArea) : null,
        model: m ? { kind: m.kind, edgeT: m.edgeT, bg: m.bg && [m.bg.L, m.bg.a, m.bg.b].map(Math.round), n: m.list ? m.list.length : undefined } : null,
        bgTried: (e.bgTried || []).map((t) => ({ kind: t.kind, bg: t.bg, good: t.good, fg: t.fg })),
        autoTilt: r.autoTilt || null, rejects: e.rejects || {},
        readQ: med(P.map((p) => (p.t1.quality ? p.t1.quality.q : 0))), cornerOffMed: med(offs), cornerOffP90: offs.length ? +offs.slice().sort((x, y) => x - y)[Math.floor(offs.length * 0.9)].toFixed(1) : null,
        pieces: P.slice(0, 40).map((p) => ({ id: p.id, code: p.t1.code, q: p.t1.quality ? +p.t1.quality.q.toFixed(2) : null, area: Math.round(p.area || 0), off: cornerOff(p.t1.corners).map((x) => +x.toFixed(1)) })),
        ms: Math.round(now() - t0),
      };
    } catch (err) {
      return { name: v.name, error: String((err && err.message) || err), ms: Math.round(now() - t0) };
    } finally {
      PH.analyzePiece = AP;
      for (const k in keep) PH[k] = keep[k];
    }
    };
})(typeof self !== 'undefined' ? self : globalThis);
