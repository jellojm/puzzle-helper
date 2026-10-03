/* Edge matching between pieces.
 * Two edges can join only if one is a tab and the other a blank of similar
 * length. Joined edges run in opposite directions, so edge B is reversed and
 * mirrored into edge A's frame: (x, y) -> (1 - x, -y). The score combines shape
 * distance, color continuity across the seam, and a bonus when the box
 * placements put the two pieces side by side. Lower score = better. */
(function (G) {
  const PH = G.PH;
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // top, right, bottom, left

  // Effective type for matching: an uncertain flat edge (shallow tab or blank
  // near the threshold) is matched as the type its shape leans to.
  const mType = (e) => (e.type === 'F' && e.unc ? e.alt : e.type);
  PH.UNCERTAIN_PENALTY = 0.4; // score cost of matching an edge read as flat
  PH.edgeScore = function (eA, eB) {
    const ta = mType(eA), tb = mType(eB);
    if (!((ta === 'T' && tb === 'B') || (ta === 'B' && tb === 'T'))) return null;
    const lr = Math.log(eA.lenRel / eB.lenRel);
    if (Math.abs(lr) > 0.15) return null;
    const a = eA.sig, b = eB.sig, n = a.length / 2;
    // Compare at a common absolute scale: signatures are in units of each edge's own length.
    const kb = eB.lenRel / eA.lenRel;
    // Map B into A's frame, then align it with the best small rotation +
    // translation (2D Procrustes) so corner-detection jitter isn't penalized
    // as shape difference. Large corrections are suspicious, so they cost a bit.
    const bx = new Float64Array(n), by = new Float64Array(n);
    let ax0 = 0, ay0 = 0, bx0 = 0, by0 = 0;
    for (let s = 0; s < n; s++) {
      const r = n - 1 - s;
      bx[s] = 1 - b[2 * r] * kb; by[s] = -b[2 * r + 1] * kb;
      ax0 += a[2 * s]; ay0 += a[2 * s + 1]; bx0 += bx[s]; by0 += by[s];
    }
    ax0 /= n; ay0 /= n; bx0 /= n; by0 /= n;
    let sc = 0, ss = 0;
    for (let s = 0; s < n; s++) {
      const px = bx[s] - bx0, py = by[s] - by0, qx = a[2 * s] - ax0, qy = a[2 * s + 1] - ay0;
      sc += px * qx + py * qy; ss += px * qy - py * qx;
    }
    const th = Math.atan2(ss, sc), c = Math.cos(th), sn = Math.sin(th);
    let shape = 0;
    for (let s = 0; s < n; s++) {
      const px = bx[s] - bx0, py = by[s] - by0;
      shape += Math.hypot(ax0 + c * px - sn * py - a[2 * s], ay0 + sn * px + c * py - a[2 * s + 1]);
    }
    shape = shape / n + 0.15 * Math.abs(th) + 0.3 * Math.hypot(ax0 - bx0, ay0 - by0);
    const sa = eA.strip, sb = eB.strip, m = sa.length / 3;
    let color = 0;
    for (let s = 0; s < m; s++) {
      const r = m - 1 - s;
      color += PH.dE(sa[3 * s], sa[3 * s + 1], sa[3 * s + 2], sb[3 * r], sb[3 * r + 1], sb[3 * r + 2], 0.7);
    }
    color /= m;
    const unsure = (eA.type === 'F' ? 1 : 0) + (eB.type === 'F' ? 1 : 0); // matched through an uncertain flat
    return { shape, color, score: shape * 12 + color / 15 + Math.abs(lr) * 4 + unsure * PH.UNCERTAIN_PENALTY };
  };

  // Bonus (0..1) when box placements put B's edge kB right against A's edge kA.
  // Softmax temperature and the score of the "partner not catalogued yet"
  // option. TEMP is the log-loss fit on synthetic data (npm test checks
  // calibration). NULL sits at the typical best-wrong score: synthetic data
  // always contains the partner and would push it higher, but on a real
  // table many partners haven't been scanned yet. Refit with real photos.
  PH.MATCH_TEMP = 0.2;
  PH.BOX_VETO = +(typeof process !== 'undefined' && process.env && process.env.VETO) || 0.8;
  PH.BOX_VETO_CONF = 0.5;
  PH.MATCH_NULL = 3.0;

  PH.boxAdjacency = function (pa, kA, pb, kB) {
    if (!pa || !pb) return 0;
    const w = [1, 0.35, 0.2]; // weight of 1st/2nd/3rd box placement candidates
    let best = 0;
    for (let i = 0; i < Math.min(3, pa.cands.length); i++) {
      const A = pa.cands[i];
      const side = (kA + A.rot) % 4;
      const nc = A.col + DIRS[side][0], nr = A.row + DIRS[side][1];
      for (let j = 0; j < Math.min(3, pb.cands.length); j++) {
        const B = pb.cands[j];
        if (B.col === nc && B.row === nr && (kB + B.rot) % 4 === (side + 2) % 4) {
          best = Math.max(best, w[i] * w[j]);
        }
      }
    }
    return best * Math.sqrt(Math.max(0.2, pa.conf) * Math.max(0.2, pb.conf));
  };

  // Score of Q's edge m as the partner of P's edge k (null = can't join).
  // Shared by findMatches and bestPartner so both rank the same way.
  function candScore(P, k, Q, m) {
    const r = PH.edgeScore(P.t1.edges[k], Q.t1.edges[m]);
    if (!r) return null;
    const adj = PH.boxAdjacency(P.t2, k, Q.t2, m);
    r.adj = adj;
    r.score -= adj * 1.2;
    // Both confidently placed on the box but not neighbors there:
    // probably a look-alike (matters most when the real partner
    // hasn't been scanned yet).
    if (!adj && P.t2 && Q.t2 && P.t2.conf >= PH.BOX_VETO_CONF && Q.t2.conf >= PH.BOX_VETO_CONF) r.score += PH.BOX_VETO;
    return r;
  }
  /** The single best partner {id, edge, score} for edge e of piece Q (the
   *  "is it mutual?" check), or null. One edge only: a quarter of findMatches. */
  PH.bestPartner = function (Q, e, pieces, skip) {
    const eQ = Q.t1.edges[e];
    if (eQ.type === 'F' && !eQ.unc) return null;
    let best = null;
    for (const R of pieces) {
      if (R === Q || !R.t1 || (skip && skip(Q, R))) continue;
      for (let m = 0; m < 4; m++) {
        const r = candScore(Q, e, R, m);
        if (r && (!best || r.score < best.score)) best = { id: R.id, edge: m, score: r.score };
      }
    }
    return best;
  };

  /**
   * Best partners for every edge of piece P.
   * @param pieces iterable of catalog pieces (with .t1, optional .t2)
   * @returns [{edge, type, matches:[{id, edge, score, shape, color, adj}]}] x4
   */
  PH.findMatches = function (P, pieces, opts) {
    opts = opts || {};
    const topN = opts.topN || 5;
    const all = Array.isArray(pieces) ? pieces : Array.from(pieces); // may be a one-shot iterator
    const out = [];
    for (let k = 0; k < 4; k++) {
      const eA = P.t1.edges[k];
      const list = [];
      if (eA.type !== 'F' || eA.unc) {
        for (const Q of all) {
          if (Q === P || !Q.t1 || (opts.skip && opts.skip(P, Q))) continue;
          for (let m = 0; m < 4; m++) {
            const r = candScore(P, k, Q, m);
            if (!r) continue;
            r.id = Q.id; r.edge = m;
            list.push(r);
          }
        }
        list.sort((x, y) => x.score - y.score);
        // Probability that each candidate is the true partner: softmax over
        // all candidates plus a "partner not catalogued yet" option.
        if (list.length) {
          // nullOdds: prior odds that the partner hasn't been scanned yet
          // (from catalog coverage and the box picture), see Engine.nullOdds.
          const T = opts.temp || PH.MATCH_TEMP, s0 = list[0].score;
          const odds = opts.nullOdds ? opts.nullOdds(k) : 1;
          const zNull = Math.exp(-(PH.MATCH_NULL - s0) / T) * odds;
          let z = zNull;
          for (const m of list) z += Math.exp(-(m.score - s0) / T);
          for (const m of list) m.prob = m.pSoft = Math.exp(-(m.score - s0) / T) / z;
          var pNone = zNull / z;
        }
      }
      out.push({ edge: k, type: eA.type, matches: list.slice(0, topN), pNone: eA.type === 'F' && !eA.unc ? 0 : list.length ? pNone : 1 });
    }
    return out;
  };

  /**
   * 2x2 loop check ("solve the 4-piece set"). For each corner of P where two
   * non-flat edges k and k+1 meet: take P's top candidates B (on edge k) and
   * C (on edge k+1), then look for a fourth piece D that fits B and C at the
   * same time. With pieces in their own frames (edges 0..3 = top, right,
   * bottom, left), placing P unrotated gives:
   *   B at side k:   rotation rB = k+2-mB,  B's edge toward D: eB = k+1-rB
   *   C at side k+1: rotation rC = k+3-mC,  C's edge toward D: eC = k-rC
   *   D: the edge facing B is eD, the one facing C is eD-1 (mod 4).
   * A wrong match rarely closes a loop, so closed loops are strong evidence.
   * Returns loops sorted by loop score (weakest join + 1/4 of the sum; lower = better).
   */
  PH.findLoops = function (P, pieces, opts) {
    opts = opts || {};
    const K = opts.K || 6;
    const all = Array.isArray(pieces) ? pieces : Array.from(pieces);
    const byId = new Map(all.map((q) => [q.id, q]));
    const cache = new Map();
    const cands = (Q, e) => {
      const key = Q.id + ':' + e;
      if (!cache.has(key)) {
        const eA = Q.t1.edges[e], list = [];
        if (eA.type !== 'F') {
          for (const R of all) {
            if (R === Q || !R.t1 || (opts.skip && opts.skip(Q, R))) continue;
            for (let m = 0; m < 4; m++) {
              const r = PH.edgeScore(eA, R.t1.edges[m]);
              if (!r) continue;
              const adj = PH.boxAdjacency(Q.t2, e, R.t2, m);
              list.push({ id: R.id, edge: m, score: r.score - adj * 1.2 });
            }
          }
          list.sort((x, y) => x.score - y.score);
        }
        cache.set(key, list.slice(0, K));
      }
      return cache.get(key);
    };
    const mod = (x) => ((x % 4) + 4) % 4;
    const loops = [];
    for (let k = 0; k < 4; k++) {
      const k2 = mod(k + 1);
      if (P.t1.edges[k].type === 'F' || P.t1.edges[k2].type === 'F') continue;
      for (const b of cands(P, k)) {
        const B = byId.get(b.id), rB = mod(k + 2 - b.edge), eB = mod(k + 1 - rB);
        if (B.t1.edges[eB].type === 'F') continue;
        const dB = cands(B, eB);
        for (const c of cands(P, k2)) {
          if (c.id === b.id) continue;
          const C = byId.get(c.id), rC = mod(k2 + 2 - c.edge), eC = mod(k - rC);
          if (C.t1.edges[eC].type === 'F') continue;
          const dC = cands(C, eC);
          for (const x of dB) {
            if (x.id === P.id || x.id === b.id || x.id === c.id) continue;
            const y = dC.find((q) => q.id === x.id && q.edge === mod(x.edge - 1));
            if (!y) continue;
            loops.push({ corner: k, B: b.id, mB: b.edge, C: c.id, mC: c.edge, D: x.id, eDB: x.edge, eDC: y.edge,
              score: PH.loopScore([b.score, c.score, x.score, y.score]), parts: [b.score, c.score, x.score, y.score] });
          }
        }
      }
    }
    loops.sort((x, y) => x.score - y.score);
    return loops;
  };

  /**
   * Mark matches confirmed by a closed 2x2 loop: the best loop through an edge
   * names the same partner as that edge's own top match. On the real-picture
   * test this held for ~78% of edges and those were right ~92% of the time
   * (vs ~81% for single-edge top matches), so a confirmed match's probability
   * is raised to at least LOOP_CONF.
   */
  PH.confirmWithLoops = function (res, loops) {
    for (const r of res) {
      const L = loops.find((q) => q.corner === r.edge || (q.corner + 1) % 4 === r.edge);
      r.loop = null;
      if (!L) continue;
      const asB = L.corner === r.edge;
      const partner = asB ? L.B : L.C, pEdge = asB ? L.mB : L.mC;
      r.loop = { partner, others: asB ? [L.C, L.D] : [L.B, L.D] };
      for (const m of r.matches) m.loopOk = m.id === partner && m.edge === pEdge;
      const top = r.matches[0];
      if (top && top.loopOk) top.prob = Math.max(top.prob || 0, PH.LOOP_CONF);
    }
    return res;
  };
  PH.LOOP_CONF = 0.9;

  /* ---- Calibrated match probability ----
   * The softmax above only knows how a candidate's score compares with the
   * others. Solvers that are right when they say so lean on consistency
   * instead (RESEARCH-ai-puzzle.md): a clear lead over the runner-up (Paikin
   * & Tal 2015), mutual best partners ("best buddies", Pomeranz 2011: 99.7%
   * precise), closed loops (Son et al. 2014). A small logistic model combines
   * them. Its starting weights (CALIB_PRIOR) are fitted on synthetic puzzles
   * with known answers (tools/fit-calib.js); the owner's Fits/No answers
   * refit it on the real puzzle (Engine.refitCalib), pulled toward the prior
   * while there are few answers. */
  PH.CALIB_FEATURES = ['bias', 'logit', 'lead', 'mutual', 'loop', 'confirmed', 'box', 'unsure'];
  // Fitted by tools/fit-calib.js (2026-10-03: held-out synthetic log-loss
  // 0.236 -> 0.12, calibration error 0.048 -> 0.02 vs the softmax alone).
  // Two set by hand: 'box' fitted slightly negative (box agreement is already
  // in the score) -> 0; 'unsure' never occurs on synthetic pieces -> a modest
  // penalty for matching through an edge read as flat. 'confirmed' only
  // varies on real tables (photo catalogues see each piece once) -> 0.5.
  PH.CALIB_PRIOR = [-3.04, 0.11, 2.31, 2.75, 0.84, 0.5, 0, -0.5];
  PH.candFeatures = function (f) {
    const p = PH.clamp(f.pSoft || 0, 1e-4, 1 - 1e-4);
    return [1, PH.clamp(Math.log(p / (1 - p)), -6, 6), PH.clamp(f.lead, -2, 2), f.mutual ? 1 : 0, f.loop ? 1 : 0, f.confirmed ? 1 : 0, f.adj || 0, f.unsure ? 1 : 0];
  };
  PH.calibProb = function (w, x) {
    let z = 0;
    for (let i = 0; i < w.length; i++) z += w[i] * x[i];
    return 1 / (1 + Math.exp(-PH.clamp(z, -30, 30)));
  };
  /** Logistic regression on samples [{x, y: 0|1}] by Newton steps, with an
   *  L2 pull of strength `lambda` toward `prior` (few answers -> stays near
   *  the prior). Returns the weights. */
  PH.fitCalib = function (samples, prior, lambda, iters) {
    const d = prior.length, w = prior.slice();
    lambda = lambda === undefined ? 4 : lambda;
    for (let it = 0; it < (iters || 12); it++) {
      const g = new Float64Array(d), H = Array.from({ length: d }, () => new Float64Array(d));
      for (const s of samples) {
        const p = PH.calibProb(w, s.x), r = p - s.y, v = Math.max(1e-6, p * (1 - p));
        for (let i = 0; i < d; i++) {
          g[i] += r * s.x[i];
          for (let j = 0; j < d; j++) H[i][j] += v * s.x[i] * s.x[j];
        }
      }
      for (let i = 0; i < d; i++) { g[i] += lambda * (w[i] - prior[i]); H[i][i] += lambda; }
      const step = solve(H, g);
      if (!step) break;
      let big = 0;
      for (let i = 0; i < d; i++) { w[i] -= step[i]; big = Math.max(big, Math.abs(step[i])); }
      if (big < 1e-6) break;
    }
    return w;
  };
  // Gaussian elimination with partial pivoting (small dense systems).
  function solve(A, b) {
    const n = b.length, M = A.map((row, i) => Float64Array.from([...row, b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }
  /** Plain-words verdict for a candidate partner, from its calibrated
   *  probability and whether anything independent backs it (loop or mutual
   *  best). 'alike' = it and the runner-up are about equally likely. */
  PH.matchVerdict = function (m, next) {
    const p = m.prob || 0, backed = m.loopOk || m.mutual;
    if (next && (next.prob || 0) >= p * 0.7 && p < 0.7) return 'alike';
    if (p >= 0.85 && backed) return 'strong';
    if (p >= 0.5) return 'likely';
    if (p >= 0.2) return 'maybe';
    return 'weak';
  };
  // A loop is only as good as its weakest join.
  PH.loopScore = (p) => Math.max(p[0], p[1], p[2], p[3]) + 0.25 * (p[0] + p[1] + p[2] + p[3]);
})(typeof self !== 'undefined' ? self : globalThis);
