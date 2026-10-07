/* Engine: ties segmentation, tracking, the table map, the catalog and the
 * T1/T2 work queue together. Pure logic, no DOM/worker APIs, so it runs the
 * same in the browser worker and in Node tests.
 *
 * Coordinates:
 *   frame  = processing-resolution pixels of the current frame
 *   source = full-resolution pixels of the current frame (frame / scale)
 *   table  = a stable 2D map of the tabletop. `pose` maps frame -> table.
 *            Pieces with known positions act as anchors for the pose.
 *            Disconnected scans start a new "island"; islands merge
 *            automatically when a frame sees pieces from both. */
(function (G) {
  const PH = G.PH;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // "Gone" needs proof: the spot placed by at least GONE_NB neighbours in
  // view and seen bare at GONE_VOTES separate moments. (2 and 2 marked 2-8
  // pieces gone in the owner's 2-minute video IMG_3605, where nothing moved:
  // the map bends between parts of the table by about a piece.)
  PH.GONE_NB = 3;
  PH.GONE_VOTES = 3;

  class Engine {
    constructor(opts) {
      // procW is the long side the live camera frames are analyzed at. Every
      // per-pixel pass (Lab conversion, background distance, threshold) scales
      // with its square, and those passes are what makes a phone sweat, so it
      // is deliberately well below the camera's own resolution.
      this.opts = Object.assign({ procW: +(typeof process !== 'undefined' && process.env && process.env.PROCW) || 640, snapProcW: 1600, minDE: 8, lightW: 0.5, budgetMs: 45 , minSidePx: 40, confirmSightings: 2, fov: 66}, opts || {});
      this.reset();
    }

    reset() {
      this.pframe = null; this.pfLoc = null; this.asms = []; this.asmLast = null; this.spotView = null; this.asmSentKey = null; this.cellVotes = null;
      this.pieces = new Map();
      this.nextId = 1;
      this.pose = null;
      this.island = 0;
      this.nextIsland = 1;
      this.tracks = [];
      this.bg = null;
      this.thresh = this.opts.minDE;
      this.lost = 0;
      this.version = 0;
      this.selection = null;
      this.region = null;
      this.dirty = new Set();
      this.calib = { n: 0, sL: 0, sLL: 0 };
      this.rnd = PH.mulberry32(12345);
      this.matchCache = new Map();
      this.taught = this.taught || [];
      // Cleared too: "Clear everything" used to leave the box picture live in
      // memory, so the minimap stayed up and old placements kept coming back.
      this.box = null;
      this.filter = null;   // 'border' | 'corner' | 'unplaced' | 'unread'
      this.pairSel = null;  // the pair being cycled through in the Matches bar
      this.lastProc = null;
      this.lastReloc = 0;
      // Provisional pieces (live scanning): detections followed frame to
      // frame until seen often enough to catalogue. Kept apart from
      // this.pieces, so the per-frame catalog loops don't grow with them.
      this.cands = new Map();
      this.nextCid = 1;
      this.fbLog = [];   // Fits/No answers with what was claimed (answer key)
      this.calibW = null; // match-probability weights refitted on the answer key (null = PH.CALIB_PRIOR)
      this.bestCache = new Map(); // 'id:edge' -> {v, best}: best partner per edge (mutual-best check)
      this.rejects = {}; // why detections were not catalogued (reports)
      this.boardRef = null; this.boardSeen = null; // the scan's board colour (noteBoard)
    }

    // ---------- catalog helpers ----------
    unitTable() {
      const areas = [];
      for (const p of this.pieces.values()) if (p.area) areas.push(p.area);
      return areas.length >= 3 ? Math.sqrt(PH.median(areas)) : null;
    }
    calibStats() {
      const c = this.calib;
      if (!c.n) return null;
      const Lmu = c.sL / c.n;
      return { n: c.n, Lmu, Lsd: Math.sqrt(Math.max(1, c.sLL / c.n - Lmu * Lmu)) };
    }
    touch(p) { this.dirty.add(p.id); }
    newPiece(d, pos, island, area) {
      const p = { id: this.nextId++, fp: d.fp, area, pos, island, miss: 0, t1: null, t1Fail: 0, t2: null, wrong: [], joined: [false, false, false, false], created: Date.now() };
      this.pieces.set(p.id, p);
      this.touch(p);
      return p;
    }
    /** Shown, counted and matched only once checked (owner, 2026-10-05:
     *  "don't show pieces not fully checked"). */
    // (opts.checkedOnly === false: tests of other features - the Map, assembled
    // parts - may treat every read entry as shown)
    isChecked(p) { return p.state === 'checked' || (this.opts.checkedOnly === false && !!p.t1); }
    checkedPieces() { const out = []; for (const p of this.pieces.values()) if (this.isChecked(p)) out.push(p); return out; }
    counts() {
      let shaped = 0, placed = 0, located = 0, pieces = 0, border = 0, cornerShaped = 0, cornerDoubt = 0, unchecked = 0, gone = 0;
      const islands = new Set();
      const doubt = this.cornerDoubts();
      for (const p of this.pieces.values()) {
        if (!this.isChecked(p)) { unchecked++; continue; }
        if (p.gone) gone++;
        pieces++;
        if (p.t1) shaped++;
        if (p.t2 && p.t2.conf >= 0.35) placed++;
        if (p.pos) { located++; islands.add(p.island); }
        const f = edgeFlags(p);
        if (f.corner) { if (doubt.has(p.id)) cornerDoubt++; else cornerShaped++; } else if (f.border) border++;
      }
      // `islands` is how many disconnected scan groups the table map is in.
      // More than a few means tracking keeps breaking and the same physical
      // pieces are being catalogued more than once.
      // With a box picture a puzzle has exactly 4 corners: `corner` counts the
      // corner spots that have a confidently placed winner (<= 4), and corner-
      // shaped pieces not confidently placed yet are `cornerUnplaced` (they are
      // still lit by the Corners/Border finders — they need finding). Before,
      // every undoubted corner shape was counted: 6 corners on a 15x20 box.
      const corner = this.box ? doubt.winners.size : cornerShaped;
      const cornerUnplaced = this.box ? cornerShaped - doubt.winners.size : 0;
      return { inPuzzle: [...this.pieces.values()].filter((p) => p.inPuzzle && this.isChecked(p)).length, pieces, checked: pieces, unchecked, gone, entries: this.pieces.size, shaped, placed, located, border, corner, cornerUnplaced, cornerDoubt, islands: islands.size, expected: PH.boxPieces(this.box) };
    }

    /**
     * A puzzle has exactly 4 corner pieces, one per corner spot of the box.
     * Corner-shaped pieces placed on the same corner spot compete: the most
     * confident (box placement, corner quality, times seen) is "the" corner,
     * the rest are doubtful (a duplicate that couldn't be merged, or a piece
     * whose straight edges were misread). Returns the set of doubtful ids.
     */
    // Corner-shaped pieces to doubt (a better piece holds that corner spot, or
    // placed mid-edge). The returned Set also carries `.winners`: the ids that
    // hold a corner spot.
    cornerDoubts() {
      const doubt = new Set();
      doubt.winners = new Set();
      if (!this.box) return doubt;
      const { cols, rows } = this.box;
      const isCornerCell = (c, r) => (c === 0 || c === cols - 1) && (r === 0 || r === rows - 1);
      const best = new Map();
      for (const p of this.pieces.values()) {
        if (!this.isChecked(p) || !edgeFlags(p).corner || !p.t2 || !p.t2.cands.length || p.t2.conf < 0.35) continue;
        const c = p.t2.cands[0];
        if (!isCornerCell(c.col, c.row)) { doubt.add(p.id); continue; } // corner shape but placed mid-edge: misread
        const key = c.row * cols + c.col;
        const score = p.t2.conf + 0.5 * Math.min(1, (p.t1.cornerScore || 0) / 0.1) + 0.1 * Math.min(5, p.t1.nObs || 1);
        const cur = best.get(key);
        if (!cur) best.set(key, { p, score });
        else if (score > cur.score) { doubt.add(cur.p.id); best.set(key, { p, score }); }
        else doubt.add(p.id);
      }
      for (const { p } of best.values()) doubt.winners.add(p.id);
      return doubt;
    }

    /**
     * Duplicate clean-up keyed on the box picture: one spot holds one piece.
     * Pieces placed on the same spot whose outline and print match are the
     * same physical piece (catalogued twice after tracking broke): merge
     * them. When >= 3 such pairs link two scan islands, the islands are
     * aligned and joined too. budgetMs limits the work (live scanning);
     * Infinity = all (Tidy up). Returns {merged, islands}.
     */
    dedupeByCell(budgetMs) {
      if (!this.box) return { merged: 0, islands: 0 };
      const end = budgetMs === Infinity ? Infinity : now() + budgetMs;
      const groups = new Map();
      for (const p of this.pieces.values()) {
        if (!p.t1 || !p.t2 || !p.t2.cands.length || p.t2.conf < 0.35) continue;
        const c = p.t2.cands[0], key = c.row * this.box.cols + c.col;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const keys = [...groups.keys()].filter((k) => groups.get(k).length > 1);
      // resume where the last (budgeted) pass stopped
      keys.sort((a, b) => a - b);
      const start = this.dedupeCursor || 0;
      const order = keys.filter((k) => k >= start).concat(keys.filter((k) => k < start));
      const links = new Map(); // "islA>islB" -> [{src: posB, dst: posA}]
      let merged = 0;
      for (const key of order) {
        if (now() > end) { this.dedupeCursor = key; break; }
        const g = groups.get(key).filter((p) => this.pieces.has(p.id));
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
          const A = g[i], B = g[j];
          if (!this.pieces.has(A.id) || !this.pieces.has(B.id)) continue;
          const m = PH.samePiece(A.t1, B.t1);
          if (!m.ok) continue;
          const keep = (A.t1.nObs || 1) >= (B.t1.nObs || 1) ? A : B, drop = keep === A ? B : A;
          if (keep.pos && drop.pos && keep.island !== drop.island) {
            const k = keep.island + '>' + drop.island;
            if (!links.has(k)) links.set(k, []);
            links.get(k).push({ src: drop.pos, dst: keep.pos });
          }
          PH.fuseShapes(keep.t1, drop.t1, keep === A ? m.r : (4 - m.r) % 4);
          if (!keep.pos && drop.pos) { keep.pos = drop.pos; keep.island = drop.island; }
          keep.wrong = [...new Set(keep.wrong.concat(drop.wrong))];
          for (let k = 0; k < 4; k++) keep.joined[k] = keep.joined[k] || drop.joined[k];
          this.touch(keep);
          this.removePiece(drop.id);
          merged++;
        }
      }
      if (now() <= end) this.dedupeCursor = 0;
      // Join islands linked by >= 3 consistent duplicate pairs.
      let joinedIslands = 0;
      const unitT = this.unitTable() || 1;
      for (const [k, pairs] of links) {
        if (pairs.length < 3) continue;
        const [ia, ib] = k.split('>').map(Number);
        if (ia === ib) continue;
        const r = PH.simRansac(pairs, unitT * 1.0, 100, this.rnd);
        if (!r || r.inliers.length < 3) continue;
        for (const p of this.pieces.values()) {
          if (p.island === ib && p.pos) { this.moveWithGroup(p, r.T); p.island = ia; this.touch(p); }
        }
        if (this.island === ib) { this.island = ia; if (this.pose) this.pose = composeSim(r.T, this.pose); }
        joinedIslands++;
      }
      // After islands are joined, copies that slipped through (placed on a
      // different spot, or a weaker shape match) now sit at the same table
      // position: same island, within half a piece, and alike -> merge.
      if (joinedIslands || budgetMs === Infinity) {
        const list = [...this.pieces.values()].filter((p) => p.pos);
        const cell = unitT, grid = new Map();
        const key = (x, y, isl) => isl + ':' + Math.floor(x / cell) + ':' + Math.floor(y / cell);
        for (const p of list) { const k = key(p.pos[0], p.pos[1], p.island); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
        for (const A of list) {
          if (!this.pieces.has(A.id)) continue;
          const gx = Math.floor(A.pos[0] / cell), gy = Math.floor(A.pos[1] / cell);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const B of grid.get(A.island + ':' + (gx + dx) + ':' + (gy + dy)) || []) {
              if (B === A || !this.pieces.has(B.id) || !this.pieces.has(A.id) || B.id < A.id) continue;
              if (Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1]) > unitT * 0.5) continue;
              const alike = A.t1 && B.t1 ? PH.samePiece(A.t1, B.t1, PH.ANCHOR_SHAPE * 1.5).ok || PH.fpSimilarity(A.fp, B.fp) > 0.85 : PH.fpSimilarity(A.fp, B.fp) > 0.85;
              if (!alike) continue;
              const keep = (A.t1 ? A.t1.nObs || 1 : 0) >= (B.t1 ? B.t1.nObs || 1 : 0) ? A : B, drop = keep === A ? B : A;
              if (!keep.t1 && drop.t1) { keep.t1 = drop.t1; keep.t2 = drop.t2; }
              keep.wrong = [...new Set(keep.wrong.concat(drop.wrong))];
              this.touch(keep); this.removePiece(drop.id); merged++;
            }
          }
        }
      }
      if (merged) { this.version++; this.matchCache.clear(); }
      return { merged, islands: joinedIslands };
    }

    /**
     * Housekeeping (v0.20; replaces the Tidy up button): runs by itself, a
     * few ms per frame, and in full when a saved scan is loaded.
     *  - same-spot duplicates: two entries on one spot (within half a piece,
     *    one scan group, alike in size) that were never detected in the same
     *    frame are one piece - merged, unless two close reads clearly differ;
     *  - "checked": an entry becomes a counted, shown piece once it has two
     *    agreeing close reads (or one from a still photo), 4+ steady
     *    sightings at 2+ separate moments, and its own spot;
     *  - entries that never check out after many close views are dropped;
     *  - the box-picture duplicate clean-up (dedupeByCell).
     */
    housekeep(budgetMs) {
      const t0 = now(), end = budgetMs === Infinity ? Infinity : t0 + budgetMs;
      const unitT = this.unitTable();
      const st = this.hk || (this.hk = { merged: 0, dropped: 0, checked: 0 });
      if (unitT) {
        const cell = unitT, grid = new Map();
        const key = (isl, gx, gy) => isl + ':' + gx + ':' + gy;
        for (const p of this.pieces.values()) {
          if (!p.pos || p.gone) continue;
          const k = key(p.island, Math.floor(p.pos[0] / cell), Math.floor(p.pos[1] / cell));
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(p);
        }
        const near = (A) => {
          const out = [], gx = Math.floor(A.pos[0] / cell), gy = Math.floor(A.pos[1] / cell);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const B of grid.get(key(A.island, gx + dx, gy + dy)) || []) {
              if (B !== A && this.pieces.has(B.id) && Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1]) < unitT * 0.5) out.push(B);
            }
          }
          return out;
        };
        // round robin: each frame's slice continues where the last one stopped
        const list = [...this.pieces.values()], L = list.length, start = L ? (this.hkCursor || 0) % L : 0;
        for (let i = 0; i < L; i++) {
          if (now() > end) { this.hkCursor = (start + i) % L; break; }
          const A = list[(start + i) % L];
          if (!this.pieces.has(A.id) || !A.pos || A.gone) continue;
          let own = true;
          for (const B of near(A)) {
            if ((A.seenWith && A.seenWith.has(B.id)) || (B.seenWith && B.seenWith.has(A.id))) continue; // two pieces side by side
            const ar = (A.area || 1) / (B.area || 1);
            const veto = A.t1 && B.t1 && PH.isCloseRead(A.t1) && PH.isCloseRead(B.t1) && PH.clearlyDifferent(A.t1, B.t1);
            if (ar < 0.6 || ar > 1.6 || veto) { own = false; A.sharedSpot = true; continue; }
            this.mergeEntries(A, B);
            st.merged++;
            if (!this.pieces.has(A.id)) break;
          }
          if (!this.pieces.has(A.id)) continue;
          if (own) A.sharedSpot = false;
          if (A.state !== 'checked') {
            const close = A.t1 && PH.isCloseRead(A.t1);
            const reads = close && ((A.closeAgree || 0) >= 2 || A.photoRead);
            const seen = A.photoRead || ((A.sightings || 0) >= 4 && (A.moments || 0) >= 2);
            if (reads && seen && own) { A.state = 'checked'; A.checkedAt = Date.now(); st.checked++; this.touch(A); this.version++; this.matchCache.clear(); }
            else if (!close && (A.closeViews || 0) >= 20 || (!A.t1 && (A.t1Fail || 0) >= 6 && (A.sightings || 0) >= 20)) {
              // seen up close many times and still no good close read: not a piece
              this.removePiece(A.id); st.dropped++;
            }
          }
        }
      }
      if (this.box && now() < end) this.dedupeByCell(Math.max(1, end - now()));
      if (budgetMs === Infinity || (this.frameNo || 0) % 60 === 30) this.groupsAndEdges();
      let nc = 0; for (const p of this.pieces.values()) if (this.isChecked(p)) nc++;
      this.nChecked = nc;
      return st;
    }
    /** A short log of what changed entries (reports, tests): merges,
     *  re-finds, drops, gone. */
    logEvt(kind, a, b) {
      const L = this.events || (this.events = []);
      const pa = a && this.pieces.get(a);
      L.push({ f: this.fNo || 0, kind, a, b: b || null, pos: pa && pa.pos ? pa.pos.map(Math.round) : null });
      if (L.length > 400) L.shift();
    }
    /** Entry `from` turned out to be entry `to` (merged): kept so reports and
     *  tests can follow an entry number to the piece it became. */
    noteMerged(from, to) {
      this.logEvt('merge', from, to);
      const m = this.mergedInto || (this.mergedInto = new Map());
      m.set(from, to);
      if (m.size > 20000) m.delete(m.keys().next().value);
    }
    /** The entry number `id` became after merges (itself if never merged). */
    finalId(id) {
      const m = this.mergedInto;
      for (let k = 0; m && m.has(id) && k < 50; k++) id = m.get(id);
      return id;
    }
    /** Why entries are not checked yet (reports, tests): counts per missing
     *  requirement over the unchecked entries. */
    whyUnchecked() {
      const why = { noRead: 0, farOnly: 0, oneClose: 0, fewSightings: 0, oneMoment: 0, sharedSpot: 0, n: 0 };
      for (const p of this.pieces.values()) {
        if (p.state === 'checked') continue;
        why.n++;
        if (!p.t1) why.noRead++;
        else if (!PH.isCloseRead(p.t1)) why.farOnly++;
        else if ((p.closeAgree || 0) < 2 && !p.photoRead) why.oneClose++;
        if ((p.sightings || 0) < 4) why.fewSightings++;
        if ((p.moments || 0) < 2) why.oneMoment++;
        if (p.sharedSpot) why.sharedSpot++;
      }
      return why;
    }
    /** How far colour can be trusted in this scan (reports): checked pieces'
     *  edges whose colour was read in bad conditions, by reason; and the
     *  fits the box picture backs (both pieces placed with confidence, side
     *  by side there) that colour agrees with, rejects ("would hurt": the
     *  colour test would throw out a real fit), or can't judge. */
    colourHealth() {
      const out = { edges: 0, doubt: {}, box: { pairs: 0, agree: 0, reject: 0, doubt: 0 }, rejects: [] };
      const ps = this.checkedPieces().filter((p) => p.t1 && !p.gone), cell = new Map();
      for (const p of ps) {
        for (const e of p.t1.edges) if (e.type !== 'F') { out.edges++; if (e.cdoubt) out.doubt[e.cdoubt] = (out.doubt[e.cdoubt] || 0) + 1; }
        const c = p.t2 && p.t2.conf >= PH.BOX_VETO_CONF && p.t2.cands && p.t2.cands[0];
        if (c) cell.set(c.col + ',' + c.row, { p, c });
      }
      const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (const { p, c } of cell.values()) for (let k = 0; k < 4; k++) {
        const side = (k + c.rot) % 4;
        if (side !== 1 && side !== 2) continue; // each pair once
        const nb = cell.get((c.col + DIRS[side][0]) + ',' + (c.row + DIRS[side][1]));
        if (!nb) continue;
        const m = (((side + 2) % 4) - nb.c.rot + 4) % 4, eA = p.t1.edges[k], eB = nb.p.t1.edges[m];
        if (eA.type === 'F' || eB.type === 'F') continue;
        const r = PH.edgeScore(eA, eB);
        if (!r) continue;
        out.box.pairs++;
        if (r.colDoubt) out.box.doubt++;
        else if (r.colShare === undefined) continue;
        else if (r.colShare >= PH.COL_SHARE) out.box.agree++;
        else {
          out.box.reject++;
          if (out.rejects.length < 20) out.rejects.push({ a: p.id, b: nb.p.id, share: +r.colShare.toFixed(2), clip: [eA.cc && +eA.cc.clip.toFixed(2), eB.cc && +eB.cc.clip.toFixed(2)], k: [p.t1.lf && p.t1.lf.kRaw && +p.t1.lf.kRaw.toFixed(2), nb.p.t1.lf && nb.p.t1.lf.kRaw && +nb.p.t1.lf.kRaw.toFixed(2)] });
        }
      }
      return out;
    }
    /** Fold entry `drop` into `keep` (the same physical piece catalogued
     *  twice): the checked one, else the better-read one, else the older one
     *  keeps its number; evidence, shapes and the owner's answers are joined. */
    mergeEntries(A, B) {
      const rank = (p) => (p.state === 'checked' ? 1e6 : 0) + (p.t1 && PH.isCloseRead(p.t1) ? 1e4 : 0) + (p.closeAgree || 0) * 100 + (p.sightings || 0) - p.id * 1e-6;
      const keep = rank(A) >= rank(B) ? A : B, drop = keep === A ? B : A;
      if (drop.t1) {
        if (!keep.t1 || (PH.isCloseRead(drop.t1) && !PH.isCloseRead(keep.t1))) { keep.t1 = drop.t1; keep.t2 = drop.t2; keep.closeAgree = drop.closeAgree || 0; }
        else if (PH.isCloseRead(drop.t1) === PH.isCloseRead(keep.t1)) {
          const m = PH.samePiece(drop.t1, keep.t1); // (read, stored): the turn fuseShapes takes
          if (m.ok && (keep.t1.nObs || 1) < 8) PH.fuseShapes(keep.t1, drop.t1, m.r);
          keep.closeAgree = Math.max(keep.closeAgree || 0, drop.closeAgree || 0) + (m.ok && PH.isCloseRead(keep.t1) ? 1 : 0);
        }
      }
      keep.sightings = (keep.sightings || 0) + (drop.sightings || 0);
      keep.moments = Math.max(keep.moments || 0, drop.moments || 0) + (drop.moments ? 1 : 0);
      keep.closeViews = (keep.closeViews || 0) + (drop.closeViews || 0);
      keep.photoRead = keep.photoRead || drop.photoRead;
      keep.wrong = [...new Set((keep.wrong || []).concat(drop.wrong || []))];
      for (let k = 0; k < 4; k++) keep.joined[k] = keep.joined[k] || (drop.joined && drop.joined[k]);
      keep.inPuzzle = Math.max(keep.inPuzzle || 0, drop.inPuzzle || 0);
      keep.created = Math.min(keep.created || Infinity, drop.created || Infinity);
      if (drop.seenWith) { const sw = keep.seenWith || (keep.seenWith = new Set()); for (const id of drop.seenWith) if (id !== keep.id) sw.add(id); }
      for (const p of this.pieces.values()) if (p.seenWith && p.seenWith.delete(drop.id)) p.seenWith.add(keep.id);
      if (!keep.pos && drop.pos) { keep.pos = drop.pos; keep.island = drop.island; }
      if (drop.fp && keep.fp) keep.fp = PH.blendFp(keep.fp, drop.fp, 0.3);
      for (const f of this.fbLog || []) { if (f.a === drop.id) f.a = keep.id; if (f.b === drop.id) f.b = keep.id; }
      this.noteMerged(drop.id, keep.id);
      this.touch(keep); this.removePiece(drop.id);
      this.matchCache.clear();
      return keep;
    }

    // ---------- tracking ----------
    link(dets, unitF) {
      const prev = this.tracks;
      if (!prev.length || !dets.length) return;
      // Global shift: median displacement to each det's most similar nearby track.
      const dxs = [], dys = [];
      for (const d of dets) {
        let best = null;
        for (const t of prev) {
          const s = PH.fpSimilarity(d.fp, t.fp);
          if (s < 0.85) continue; // the same piece frame-to-frame is ~0.95+
          const dist = Math.hypot(d.cx - t.x, d.cy - t.y);
          if (dist > unitF * 6) continue;
          const c = dist / unitF + (1 - s) * 3;
          if (!best || c < best.c) best = { c, t };
        }
        if (best) { dxs.push(d.cx - best.t.x); dys.push(d.cy - best.t.y); }
      }
      const sx = PH.median(dxs), sy = PH.median(dys);
      const pairs = [];
      for (let i = 0; i < dets.length; i++) for (let j = 0; j < prev.length; j++) {
        const d = dets[i], t = prev[j];
        const dist = Math.hypot(d.cx - t.x - sx, d.cy - t.y - sy);
        if (dist > unitF * 0.7) continue;
        const s = PH.fpSimilarity(d.fp, t.fp);
        if (s < 0.75) continue;
        pairs.push({ i, j, c: dist / unitF + (1 - s) * 2, s });
      }
      pairs.sort((a, b) => a.c - b.c);
      const usedD = new Set(), usedT = new Set();
      for (const p of pairs) {
        if (usedD.has(p.i) || usedT.has(p.j)) continue;
        usedD.add(p.i); usedT.add(p.j);
        const t = prev[p.j];
        if (t.id && this.pieces.has(t.id)) { dets[p.i].id = t.id; dets[p.i].linkSim = p.s; }
        else if (t.cid && this.cands.has(t.cid)) dets[p.i].cid = t.cid; // still a provisional piece
        dets[p.i].tracked = true;
      }
    }

    // ---------- pose ----------
    // Fit frame->table from dets already linked to located pieces. Handles
    // moved pieces (outliers) and merges islands seen together.
    fitPose(dets, unitF) {
      const unitT = this.unitTable();
      const groups = new Map();
      for (const d of dets) {
        if (!d.id) continue;
        const p = this.pieces.get(d.id);
        if (!p || !p.pos) continue;
        if (!groups.has(p.island)) groups.set(p.island, []);
        groups.get(p.island).push({ src: [d.cx, d.cy], dst: p.pos, d, p });
      }
      if (!groups.size || !unitT) return false;
      let main = null;
      for (const [isl, g] of groups) if (!main || g.length > main.g.length || (g.length === main.g.length && isl === this.island)) main = { isl, g };
      const res = PH.simRansac(main.g, unitT * 0.4, 60, this.rnd);
      if (!res) return false;
      const T = res.T;
      const expScale = unitT / unitF;
      const sOk = Math.abs(Math.log(PH.simScale(T) / expScale)) < 0.5;
      const enough = res.inliers.length >= 3 || (res.inliers.length === 2 && main.g.length === 2 && this.pose && this.island === main.isl &&
        Math.abs(Math.log(PH.simScale(T) / PH.simScale(this.pose))) < 0.15);
      if (!sOk || !enough) return false;
      this.pose = T;
      this.island = main.isl;
      // Outliers: a confidently tracked piece that disagrees with the consensus moved.
      const inl = new Set(res.inliers);
      const frozen = this.frameCtx && this.frameCtx.offLight; // (odd light: pieces anchor the pose, nothing is moved)
      main.g.forEach((pr, k) => {
        if (frozen) { if (!inl.has(k)) pr.d.id = null; return; }
        if (inl.has(k)) {
          // gentle refinement keeps the map consistent
          const q = PH.simApply(T, pr.src[0], pr.src[1]);
          pr.p.pos = [pr.p.pos[0] * 0.9 + q[0] * 0.1, pr.p.pos[1] * 0.9 + q[1] * 0.1];
        } else if (pr.d.tracked && pr.d.linkSim > 0.7) {
          pr.p.pos = PH.simApply(T, pr.src[0], pr.src[1]);
          this.markMoved(pr.p);
          this.touch(pr.p);
        } else {
          pr.d.id = null;
        }
      });
      // Merge any other island that is visible in the same frame.
      for (const [isl, g] of groups) {
        if (isl === main.isl || g.length < 2) continue;
        const r2 = PH.simRansac(g.map((pr) => ({ src: pr.p.pos, dst: PH.simApply(T, pr.src[0], pr.src[1]) })), unitT * 0.5, 40, this.rnd);
        if (!r2 || r2.inliers.length < Math.min(3, g.length)) continue;
        for (const p of this.pieces.values()) {
          if (p.island === isl && p.pos) { this.moveWithGroup(p, r2.T); p.island = main.isl; this.touch(p); }
        }
      }
      return true;
    }

    /** The camera barely moves between two analysed frames, so the last
     *  pose still nearly fits: pieces are matched by spot and size alone
     *  (no colours - a sudden exposure change or the phone's shadow broke the
     *  colour links, and the map was lost and restarted, cataloguing every
     *  piece again) and the pose is refitted. Needs 3+ pieces agreeing. */
    poseBySpots(dets, unitF) {
      const T0 = this.pose, unitT = this.unitTable();
      if (!T0 || !this.island || !unitT) return false;
      const s0 = PH.simScale(T0), pairs = [], used = new Set();
      for (const d of dets) {
        if (d.merged || d.border) continue;
        const q = PH.simApply(T0, d.cx, d.cy);
        let best = null, bd = Infinity, n = 0;
        for (const p of this.pieces.values()) {
          if (!p.pos || p.gone || p.island !== this.island) continue;
          const dist = Math.hypot(p.pos[0] - q[0], p.pos[1] - q[1]);
          if (dist > unitT * 0.6) continue;
          const ar = (d.area * s0 * s0) / (p.area || 1);
          if (ar < 0.6 || ar > 1.6) continue;
          n++; if (dist < bd) { bd = dist; best = p; }
        }
        if (best && n === 1 && !used.has(best.id)) { used.add(best.id); pairs.push({ src: [d.cx, d.cy], dst: best.pos, d, p: best }); }
      }
      if (pairs.length < 3) return false;
      const r = PH.simRansac(pairs, unitT * 0.35, 60, this.rnd);
      if (!r || r.inliers.length < 3 || r.inliers.length < pairs.length * 0.6 || Math.abs(Math.log(PH.simScale(r.T) / s0)) > 0.2) return false;
      this.pose = r.T;
      for (const k of r.inliers) pairs[k].d.id = pairs[k].p.id;
      this.rejects.poseBySpots = (this.rejects.poseBySpots || 0) + 1;
      return true;
    }
    // Find the pose from scratch by matching fingerprints against located pieces.
    relocalize(dets, unitF, onlyIsland) {
      const unitT = this.unitTable();
      if (!unitT) return null;
      const placed = [];
      for (const p of this.pieces.values()) if (p.pos && !p.gone && (onlyIsland === undefined || p.island === onlyIsland)) placed.push(p);
      if (placed.length < 3) return null;
      const expScale = unitT / unitF;
      const cand = [];
      for (const d of dets) {
        if (d.merged) continue;
        const list = [];
        for (const p of placed) {
          const s = PH.fpSimilarity(d.fp, p.fp);
          if (s < 0.6) continue;
          const ar = (d.area * expScale * expScale) / p.area;
          if (ar < 0.5 || ar > 2) continue;
          list.push({ p, s });
        }
        list.sort((a, b) => b.s - a.s);
        if (list.length) cand.push({ d, list: list.slice(0, 4) });
      }
      if (cand.length < 3) return null;
      let best = null;
      const tol2 = (unitT * 0.4) ** 2;
      for (let it = 0; it < 400; it++) {
        const A = cand[(this.rnd() * cand.length) | 0], B = cand[(this.rnd() * cand.length) | 0];
        if (A === B) continue;
        const pa = A.list[(this.rnd() * A.list.length) | 0].p, pb = B.list[(this.rnd() * B.list.length) | 0].p;
        if (pa === pb || pa.island !== pb.island) continue;
        const T = PH.simFit([[A.d.cx, A.d.cy], [B.d.cx, B.d.cy]], [pa.pos, pb.pos]);
        if (!T || Math.abs(Math.log(PH.simScale(T) / expScale)) > 0.4) continue;
        const assign = [];
        for (const c of cand) {
          const q = PH.simApply(T, c.d.cx, c.d.cy);
          for (const e of c.list) {
            if (e.p.island !== pa.island) continue;
            const ex = q[0] - e.p.pos[0], ey = q[1] - e.p.pos[1];
            if (ex * ex + ey * ey < tol2) { assign.push({ d: c.d, p: e.p }); break; }
          }
        }
        if (!best || assign.length > best.assign.length) best = { T, assign, island: pa.island };
      }
      if (!best || best.assign.length < 3 || best.assign.length < cand.length * 0.3) return null;
      const T = PH.simFit(best.assign.map((a) => [a.d.cx, a.d.cy]), best.assign.map((a) => a.p.pos)) || best.T;
      return { T, assign: best.assign, island: best.island };
    }

    // Shape-based anchors for photos: candidates are located pieces whose
    // outline matches (lighting/zoom independent), then RANSAC for the pose.
    shapeCands(d, filter) {
      if (!d.t1) return [];
      const out = [];
      for (const p of this.pieces.values()) {
        if (!p.t1 || !p.pos || p.gone || (filter && !filter(p))) continue;
        // Outline (looser than SAME_SHAPE: views differ in zoom/angle) plus
        // matching print; RANSAC consensus then guards against the rest.
        const m = PH.samePiece(d.t1, p.t1);
        if (m.ok) out.push({ p, s: m.d });
      }
      return out.sort((a, b) => a.s - b.s).slice(0, 3);
    }
    relocalizeByShape(dets, unitF) {
      const unitT = this.unitTable();
      if (!unitT) return null;
      const cand = [];
      for (const d of dets) { const list = this.shapeCands(d); if (list.length) cand.push({ d, list }); }
      if (cand.length < 3) return null;
      const expScale = unitT / unitF, tol2 = (unitT * 0.5) ** 2;
      let best = null;
      for (let it = 0; it < 600; it++) {
        const A = cand[(this.rnd() * cand.length) | 0], B = cand[(this.rnd() * cand.length) | 0];
        if (A === B) continue;
        const pa = A.list[(this.rnd() * A.list.length) | 0].p, pb = B.list[(this.rnd() * B.list.length) | 0].p;
        if (pa === pb || pa.island !== pb.island) continue;
        const T = PH.simFit([[A.d.cx, A.d.cy], [B.d.cx, B.d.cy]], [pa.pos, pb.pos]);
        if (!T || Math.abs(Math.log(PH.simScale(T) / expScale)) > 0.4) continue;
        const assign = [], used = new Set();
        for (const c of cand) {
          const q = PH.simApply(T, c.d.cx, c.d.cy);
          for (const e of c.list) {
            if (e.p.island !== pa.island || used.has(e.p.id)) continue;
            const ex = q[0] - e.p.pos[0], ey = q[1] - e.p.pos[1];
            if (ex * ex + ey * ey < tol2) { assign.push({ d: c.d, p: e.p }); used.add(e.p.id); break; }
          }
        }
        if (!best || assign.length > best.assign.length) best = { T, assign, island: pa.island };
      }
      if (!best || best.assign.length < 3) return null;
      const T = PH.simFit(best.assign.map((a) => [a.d.cx, a.d.cy]), best.assign.map((a) => a.p.pos)) || best.T;
      return { T, assign: best.assign, island: best.island };
    }
    // Pieces from another island recognized (by shape) in this photo tie that
    // island to the current one: move it into the current frame.
    mergeIslandsByShape(dets) {
      const T = this.pose, unitT = this.unitTable();
      if (!T || !unitT) return 0;
      const groups = new Map();
      for (const d of dets) {
        const list = this.shapeCands(d, (p) => p.island !== this.island);
        if (!list.length || (list[1] && list[1].s < list[0].s * 1.3)) continue; // need a clear match
        const p = list[0].p;
        if (!groups.has(p.island)) groups.set(p.island, []);
        groups.get(p.island).push({ src: p.pos, dst: PH.simApply(T, d.cx, d.cy), d, p });
      }
      let merged = 0;
      for (const [isl, g] of groups) {
        if (g.length < 3) continue;
        const r = PH.simRansac(g, unitT * 0.5, 100, this.rnd);
        if (!r || r.inliers.length < 3) continue;
        for (const p of this.pieces.values()) if (p.island === isl && p.pos) { this.moveWithGroup(p, r.T); p.island = this.island; this.touch(p); }
        for (const k of r.inliers) if (!g[k].d.id) g[k].d.id = g[k].p.id;
        merged++;
      }
      return merged;
    }

    // ---------- main entry points ----------
    /**
     * @param source {w,h, getProc(maxW)->{w,h,data,scale}, getCrop(x,y,w,h)->{w,h,data}}
     * @param info {still:boolean}
     */
    // Tilt correction: with the phone's gravity direction, serve a virtual
    // top-down view of the table instead of the raw (tilted) image.
    straighten(source, info) {
      const t = info && info.tilt;
      if (!t || !t.down || this.opts.tiltCorrection === false || PH.tiltDeg(t.down) < 8) return { source, rect: null }; // under 8° the distortion is < 1%: not worth the cost
      const rect = PH.tiltHomography(source.w, source.h, PH.focalPx(source.w, source.h, t.fov), t.down, 3);
      return rect ? { source: PH.rectifiedSource(source, rect), rect } : { source, rect: null };
    }

    processFrame(source, info) {
      info = info || {};
      const t0 = now();
      const st = this.straighten(source, info);
      source = st.source;
      this.curSource = source; // (the 'edges' background model reads it larger)
      const tp = now();
      PH.procT = {};
      const proc = source.getProc(this.opts.procW);
      // Per-stage segmentation timings ride along in out.timings (as flat
      // seg_* numbers) so a phone report shows where the time actually goes.
      // seg_proc = straightening + the processing-size image; seg_bgChoice =
      // background re-checks (both used to be in "seg" but in no sub-stage).
      const segT = { proc: now() - t0, procTilt: tp - t0 };
      for (const k in PH.procT) segT['proc' + k] = PH.procT[k]; // where getProc's time went (draw / read / warp)
      this.lastProc = proc; // kept for debug reports (what the app actually analyzed)
      const pfFound = this.findPuzzleFrame(proc);
      if (this.unitLiveW !== proc.w) { this.unitLive = null; this.unitLiveW = proc.w; } // Scan detail changed
      // Pick (or re-check) the background model: at the start, every ~90
      // frames, and when detections have collapsed for a while. Each
      // candidate costs a whole extra segmentation, so when the last re-check
      // kept the model (the view is just sparse - few pieces, the box, an
      // empty patch) the next "collapsed" re-check waits ~45 frames (report
      // 19:12: re-checks ran on most frames of a sparse view).
      this.fNo = (this.fNo || 0) + 1;
      if (this.opts.autoBg !== false && info.still !== false) {
        const poor = (this.poorStreak || 0) >= 6 && (!this.bgKept || this.fNo - this.bgModelAt > 45);
        const due = !this.bgModelAt || this.fNo - this.bgModelAt > 90 || poor;
        const tb = now();
        if (this.bgEval || due) {
          if (!this.bgEval) { this.bgModelAt = this.fNo; this.poorStreak = 0; }
          // First frame with no model at all: decide right away; later
          // re-checks run one candidate per frame in the background.
          if (!this.bgModel && !this.bgEval) { const b = this.chooseBackground(proc); this.bgModel = b ? b.c : null; }
          else this.stepBgChoice(proc);
          segT.bgChoice = now() - tb;
        }
      }
      const seg = PH.segment(proc, this.liveSegOpts(info, { timings: segT }));
      this.bg = seg.bg; this.thresh = seg.thresh;
      // the board as this frame shows it (seg.bg is the chosen model's colour,
      // which stays put when the light changes)
      const boardNow = this.measureBoard(seg, proc) || seg.bg;
      this.noteBoard(boardNow, info.still !== false);
      this.updateUnitLive(seg, proc, source);
      this.lastSegUnit = seg.unitArea; // the unit actually used this frame (for tests/reports)
      const t1 = now();
      const wT = {}; // where the time after segmentation goes (reports: work_*)
      let dets = this.classify(seg.dets, seg.unitArea);
      if (this.opts.dropDets) dets = dets.filter((d) => !this.opts.dropDets(d)); // tests: detections missed at random
      // Capture coach: pieces whose colour barely differs from the board
      // (pale pieces on a pale board: on synthetic tables half of them, vs
      // <= 3% on good setups; a dark cloth fixes it), and glare.
      let cLow = 0, cN = 0;
      for (const d of dets) {
        if (d.border || !d.fp) continue;
        cN++;
        const c = d.fp.raw || [d.fp.L, d.fp.a, d.fp.b]; // plain colours: the board's own contrast
        if (PH.dE(c[0], c[1], c[2], seg.bg.L, seg.bg.a, seg.bg.b, 1) < 25) cLow++;
      }
      this.coachNow = { n: cN, low: cLow, glare: +(seg.glare || 0).toFixed(3), boardL: Math.round(seg.bg.L) };
      // Pale pieces on a pale board: turn the texture channel on (with
      // hysteresis: on above 30% blending in, off below 15%).
      if (cN >= 4) {
        this.paleShare = (this.paleShare === undefined ? cLow / cN : this.paleShare * 0.85 + (cLow / cN) * 0.15);
        if (!this.useTexture && this.paleShare >= 0.3) this.useTexture = true;
        else if (this.useTexture && this.paleShare < 0.15) this.useTexture = false;
      }
      this.coachNow.texture = !!this.useTexture;
      this.poorStreak = dets.filter((d) => !d.border).length < 3 ? (this.poorStreak || 0) + 1 : 0;
      const unitF = this.unitFrame(dets);
      let tw = now();
      this.link(dets, unitF);
      wT.link = now() - tw;
      // Set before the pose work so the shape-based fallback below can read
      // outlines; nothing in it depends on the pose.
      this.frameCtx = { source, scale: proc.scale, bg: this.bg, thresh: this.thresh, lut: seg.lut, unitArea: seg.unitArea, still: info.still !== false, deadline: t0 + this.opts.budgetMs, live: true, fg: seg.fg, procW: proc.w, procH: proc.h,
        rgba: proc.invalid ? proc.data : null }; // (a straightened tilted view has empty corners outside the camera image: alpha 0)
      this.frameCtx.view = this.viewGeometry(this.unitLive || seg.unitArea, proc.scale, source.w, source.h);
      // A frame much darker or brighter than the scan's usual board (the
      // phone's shadow over the whole view, an exposure jump): its colours and
      // even its outlines are off. It may keep pieces linked to their spots,
      // but decides nothing new - no new entries, no "gone" or "swapped", no
      // re-finding by shape (plan item 7).
      this.frameCtx.offLight = !!(this.boardRef && boardNow && Math.abs(Math.log((boardNow.L || 1) / this.boardRef.L)) > Math.log(1.25));
      this.frameCtx.boardL = boardNow ? Math.round(boardNow.L) : null;
      if (this.frameCtx.offLight) this.rejects.offLight = (this.rejects.offLight || 0) + 1;
      for (const [k, c] of this.cands) if (this.fNo - c.last > 6) this.cands.delete(k); // lost from view
      tw = now();
      let ok = this.fitPose(dets, unitF);
      if (!ok) ok = this.poseBySpots(dets, unitF);
      if (!ok) {
        const r = this.relocalize(dets, unitF);
        if (r) {
          this.pose = r.T; this.island = r.island; ok = true;
          for (const d of dets) d.id = null;
          for (const a of r.assign) a.d.id = a.p.id;
        }
      }
      // A young scan group (< 3 located pieces) can't fit a pose yet - that
      // needs 3 anchors. Treating that as "lost" (v0.10.1) skipped cataloguing
      // for 20 frames, the half-seen pieces expired, and a new group was forked
      // with nothing in it, over and over (report 19:12: 3 pieces in 4.6 min,
      // each in its own group). Instead keep the pose, shifted by the pieces
      // followed from the last frame, until the group has its 3 anchors.
      if (!ok && this.pose && this.island) {
        let own = 0;
        for (const p of this.pieces.values()) if (p.pos && p.island === this.island && ++own >= 3) break;
        if (own < 3) {
          let dx = 0, dy = 0, n = 0;
          for (const d of dets) {
            const p = d.id && this.pieces.get(d.id);
            if (!p || !p.pos || p.island !== this.island) continue;
            const q = PH.simApply(this.pose, d.cx, d.cy);
            dx += p.pos[0] - q[0]; dy += p.pos[1] - q[1]; n++;
          }
          // with group pieces known but none of them in view, the camera may
          // have moved anywhere: don't guess
          if (n || !own) {
            if (n) this.pose = Object.assign({}, this.pose, { tx: this.pose.tx + dx / n, ty: this.pose.ty + dy / n });
            ok = true;
          }
        }
      }
      if (!ok) {
        this.lost++;
        // Is there a map worth waiting for? Only with >= 3 located loose
        // pieces: sections can't anchor a pose. (v0.10.0 counted any located
        // entry, so one early section - a towel fold, two touching pieces -
        // made the engine wait to re-find a map it never had; provisional
        // pieces expired meanwhile and nothing was ever catalogued.)
        let anchors = 0;
        for (const p of this.pieces.values()) if (p.pos && ++anchors >= 3) break;
        const anyPlaced = anchors >= 3;
        const goodDets = dets.filter((d) => !d.border && !d.merged).length;
        // Color fingerprints fail under changed light or zoom; outlines don't.
        // Try the (slower) shape match before giving up, but only on a steady
        // view and at most once a second. It needs outlines, so read a few
        // first — capped, because this runs on the slow path already.
        if (anyPlaced && this.lost > 3 && this.frameCtx.still && now() - this.lastReloc > 1200) {
          this.lastReloc = now();
          let budget = 8;
          for (const d of dets) {
            if (budget <= 0 || now() > t0 + this.opts.budgetMs * 2) break;
            if (d.border || d.merged) continue;
            this.detT1(d); budget--;
          }
          const r = this.relocalizeByShape(dets, unitF);
          if (r) {
            this.pose = r.T; this.island = r.island; ok = true;
            for (const d of dets) d.id = null;
            for (const a of r.assign) a.d.id = a.p.id;
          }
        }
        // Start the map (first frame), or fork a new scan group after a
        // sustained loss. Forking early is what fragments the catalog (every
        // piece in view is re-catalogued as new, so the count runs past the
        // real puzzle size), but refusing to fork stalls cataloguing
        // altogether, so this is a compromise — `tidy()` folds duplicate
        // groups back together afterwards.
        if (!ok && goodDets >= 2 && (!anyPlaced || this.lost > 20)) {
          this.startIsland(unitF);
          ok = true;
        } else if (!ok) {
          this.pose = null;
        }
      }
      wT.pose = now() - tw; tw = now();
      if (ok) { this.lost = 0; this.assign(dets, unitF, proc); }
      wT.assign = now() - tw;
      const t2 = now();
      const work = this.runQueue(dets, t0 + this.opts.budgetMs);
      const ts = now();
      wT.queue = ts - t2;
      if (this.pframe) {
        // The border is marked: open spots come from reading the puzzle cell
        // by cell against the box (js/vision/border.js) in every view where
        // the border was just found again.
        this.spotView = null;
        if (pfFound && info.still !== false) this.voteCells(proc, seg);
      } else {
        const ran = this.spotsAt;
        this.findSpots(dets, seg, proc, info.still !== false);
        if (this.box && info.still !== false) this.autoBorder(proc, seg);
        if (this.spotsAt !== ran) this.spotsCost = now() - ts; // (a search ran this frame)
      }
      segT.spots = now() - ts;
      // Housekeeping (duplicates, "checked", leftovers), a few ms per frame.
      this.frameNo = (this.frameNo || 0) + 1;
      tw = now();
      this.housekeep(this.opts.housekeepMs === undefined ? 4 : this.opts.housekeepMs);
      wT.house = now() - tw; tw = now();
      this.tracks = dets.map((d) => ({ id: d.id, cid: d.cid, x: d.cx, y: d.cy, fp: d.fp }));
      const pfOut = this.puzzleFrameOut(proc, pfFound); // (also sets this.pfViewH for the spots)
      const out = this.output(dets, proc);
      // How far the camera is, for the page's "move closer" hint.
      const v = this.frameCtx.view;
      if (v) {
        out.view = { sidePx: Math.round(v.sidePx), distCm: v.distMM ? Math.round(v.distMM / 10) : null, tooFar: v.sidePx < this.opts.minSidePx,
          needCm: v.f && this.pieceMM() ? Math.round((v.f * this.pieceMM()) / this.opts.minSidePx / 10) : null, candidates: this.cands.size };
      }
      // Lets the page map straightened coordinates back onto the camera view.
      out.rect = st.rect ? { H: st.rect.H, Hinv: st.rect.Hinv, tilt: PH.tiltDeg(info.tilt.down) } : null;
      out.pframe = pfOut;
      if (this.borderFoundNow) { out.borderFound = true; this.borderFoundNow = false; }
      out.coach = this.coachNow;
      if (this.cellsDirty && now() - (this.cellsAt || 0) > 2000) this.assignCellsNow();
      out.timings = { seg: t1 - t0, map: t2 - t1, work: now() - t2, total: now() - t0, t1: work.t1, t2: work.t2, border: this.pfMs || 0 };
      this.pfMs = 0;
      for (const k in segT) out.timings['seg_' + k] = segT[k];
      wT.out = now() - tw;
      for (const k in wT) out.timings['work_' + k] = +wT[k].toFixed(1);
      return out;
    }

    // A high-resolution photo: catalog everything in it, no time budget.
    processSnap(source, info) {
      const t0 = now();
      info = info || {};
      // No sensor tilt with this photo: estimate it from the pieces.
      let autoTilt = null;
      if (!info.tilt && this.opts.tiltCorrection !== false && this.opts.autoTilt !== false) {
        autoTilt = this.estimatePhotoTilt(source);
        if (autoTilt && autoTilt.tilt >= 8 && autoTilt.gain > 0.05) {
          // Safety check: use it only if the straightened photo shows at least
          // as many clean piece outlines as the original (a wrong tilt hurts).
          const cand = Object.assign({}, info, { tilt: { down: autoTilt.down, fov: info.fov } });
          const before = this.countPieceLike(source), after = this.countPieceLike(this.straighten(source, cand).source);
          autoTilt.check = { before, after };
          if (after >= before) info = cand;
        }
      }
      source = this.straighten(source, info).source;
      this.curSource = source;
      const saved = { pose: this.pose, island: this.island, tracks: this.tracks, lost: this.lost };
      const proc = source.getProc(this.opts.snapProcW);
      // A photo may show a different table: pick its background model from scratch.
      // (scored without the live split budget: a photo is analysed once, and
      // with 40 ms the choice depended on the machine's speed - test
      // glass-table pieces-1 flipped to a wrong model and 1 piece)
      const snapBest = this.opts.autoBg !== false ? this.chooseBackground(proc, { splitBudgetMs: undefined }) : null;
      const snapModel = snapBest ? snapBest.c : null;
      const seg = PH.segment(proc, this.segOpts(snapModel ? { bgModel: snapModel } : { bg: this.bg, bgSmooth: 0.5 }));
      if (!this.bg) this.bg = seg.bg;
      if (!this.boardRef && seg.bg && seg.bg.L > 15) { this.boardRef = { L: seg.bg.L, a: seg.bg.a, b: seg.bg.b }; this.boardRefDirty = true; } // (a first photo sets the scan's board)
      this.frameCtx = { source, scale: proc.scale, bg: seg.bg, thresh: seg.thresh, lut: seg.lut, unitArea: seg.unitArea, still: true, deadline: Infinity, fg: seg.fg, procW: proc.w, procH: proc.h };
      const dets = this.classify(seg.dets, seg.unitArea);
      const unitF = this.unitFrame(dets);
      const before = this.pieces.size;
      const known = new Set(this.pieces.keys());
      // Read every shape first: shapes identify the same piece across photos
      // regardless of lighting and zoom, which color fingerprints don't.
      for (const d of dets) this.detT1(d);
      // In a still photo every piece gets a full read; anything that doesn't
      // read as a jigsaw piece is not catalogued.
      for (let i = dets.length - 1; i >= 0; i--) if (!dets[i].t1 && !dets[i].merged && !dets[i].border) dets.splice(i, 1); // clumps (merged) stay: they're not catalogued
      // Shape + print only: color fingerprints can't tell look-alike pieces
      // apart (e.g. a puzzle with lots of plain white), so they can't anchor a photo.
      const r = this.relocalizeByShape(dets, unitF);
      let located = false;
      if (r) {
        this.pose = r.T; this.island = r.island; located = true;
        for (const a of r.assign) a.d.id = a.p.id;
      } else {
        this.startIsland(unitF);
      }
      const merged = this.mergeIslandsByShape(dets);
      this.assign(dets, unitF, proc);
      const work = this.runQueue(dets, Infinity);
      // A still photo is the best view there will be: a close read in it
      // checks the piece on its own (live scanning needs two agreeing ones).
      for (const d of dets) {
        const p = d.id && this.pieces.get(d.id);
        if (!p) continue;
        p.sightings = (p.sightings || 0) + 1;
        if (d.t1 && PH.isCloseRead(d.t1) && p.t1 && PH.isCloseRead(p.t1)) p.photoRead = true;
      }
      this.housekeep(Infinity);
      // (housekeeping may have merged entries: follow the photo's detections to the survivors)
      for (const d of dets) if (d.id && !this.pieces.has(d.id)) { const f = this.finalId(d.id); d.id = this.pieces.has(f) ? f : null; }
      this.findSpots(dets, seg, proc, true, true); // assembled parts in the photo
      if (this.cellsDirty) this.assignCellsNow();
      Object.assign(this, saved);
      return {
        found: dets.filter((d) => d.id).length,
        added: this.pieces.size - before,
        located, mergedIslands: merged,
        tilt: info.tilt ? Math.round(PH.tiltDeg(info.tilt.down)) : 0, autoTilt: autoTilt && { pitch: autoTilt.pitch, roll: autoTilt.roll, gain: +autoTilt.gain.toFixed(3), check: autoTilt.check },
        // pieces this photo recognized from earlier views (for checking/stitch UI)
        recognized: dets.filter((d) => d.id && known.has(d.id) && this.pieces.has(d.id)).map((d) => ({ id: d.id, corners: d.t1 ? d.t1.corners : null, firstCorners: this.pieces.get(d.id).t1 ? this.pieces.get(d.id).t1.corners : null })),
        shaped: work.t1, placed: work.t2,
        ms: now() - t0,
        counts: this.counts(),
      };
    }

    // Tilt estimation and its safety check run once per photo, not per frame,
    // so they use a fixed good resolution rather than the live scan width
    // (which is tuned down for speed and costs a degree or two of accuracy).
    stillProcW() { return Math.max(this.opts.procW, 960); }
    countPieceLike(source) {
      this.curSource = source;
      const proc = source.getProc(this.stillProcW());
      const seg = PH.segment(proc, this.segOpts({ splitBudgetMs: 60 }));
      return seg.dets.filter((d) => !d.border && PH.pieceScore(d.pts, d.area) > PH.MIN_CORNER_SCORE).length;
    }
    estimatePhotoTilt(source) {
      this.curSource = source;
      const proc = source.getProc(this.stillProcW());
      const seg = PH.segment(proc, this.segOpts({ splitBudgetMs: 60 }));
      const unit = seg.unitArea || PH.median(seg.dets.map((d) => d.area));
      // Pick blobs by shape (4 good corners), not size: the small far-away
      // pieces are exactly the ones that reveal the tilt.
      const blobs = seg.dets.filter((d) => !d.border && d.area > unit * 0.1 && d.area < unit * 4 && PH.pieceScore(d.pts, d.area) > PH.MIN_CORNER_SCORE)
        .map((d) => ({ pts: Array.from(d.pts, (v) => v / proc.scale), area: d.area }));
      return PH.estimateTilt(blobs, source.w, source.h);
    }

    // Segmentation options: taught background colors win, then the box palette,
    // then the single-color-cloth model.
    // Options for a live camera frame. One place, so tests run exactly what
    // the app runs (test/seg-regression.js).
    liveSegOpts(info, extra) {
      const unitArea = this.opts.stableUnit === false ? null : this.unitLive || null;
      // still frames may spend more on splitting piles of touching pieces
      const o = { bg: this.bg, bgSmooth: 0.3, splitBudgetMs: info && info.still !== false ? 40 : 25, unitArea };
      if (this.bgModel) { o.bgModel = this.bgModel; if (this.bgModel.kind === 'color') delete o.bg; }
      // outline model: the last few views vote (smeared frames lose outlines).
      // Off by default: on the glass video (IMG_3609, dense piles) it gave
      // 4.95 clean detections a frame vs 5.62 without - the losses there are
      // touching pieces and lit floor between them, not smear, and voting
      // carries those along. Its plane registration (98% inliers) is the
      // base for a parallax cue (floor moves less than the pieces).
      if (this.bgModel && this.bgModel.kind === 'edges' && this.opts.edgeVote === true) o.edgeVote = this.edgeVoter || (this.edgeVoter = new PH.EdgeVoter());
      else if (this.edgeVoter && this.edgeVoter.hist.length) this.edgeVoter.reset();
      // WP2: on still frames also use the pieces' outlines (lightness edges),
      // closed into rings and filled. That recovers pale pieces whose print
      // matches the table. Moving frames stay colour-only (blur makes edges
      // one-sided). The ring-closing kernel scales with piece size.
      if (info && info.still !== false && this.opts.boundary !== false) {
        const odd = (v) => (v % 2 ? v : v + 1);
        o.boundary = 'fill';
        o.boundaryT = 10;
        // Measured on the owner's white-table frames: close 3 beat 5/7/9 at
        // piece areas ~1000-2000 px² (bigger kernels fuse neighbours). Only
        // grow it for much larger pieces (very close-up / high Scan detail).
        o.boundaryClose = unitArea ? PH.clamp(odd(Math.round(0.07 * Math.sqrt(unitArea))), 3, 7) : 3;
        o.openK = this.opts.boundaryOpenK === undefined ? 0 : this.opts.boundaryOpenK; // the 3x3 open sheared tabs
      }
      // pale pieces blending into the board: add the texture channel (still frames)
      if (this.useTexture && info && info.still !== false && this.opts.texture !== false) o.texture = { T: 5, erode: 1 };
      return this.segOpts(Object.assign(o, extra));
    }

    /**
     * Which background model fits this table? Candidates: the 4 most common
     * colours (on a dense pile the most common one can be the *pieces*), the
     * taught colours, and the box-picture palette. Each is tried on this
     * frame; the one that yields the most piece-shaped blobs wins. That
     * needs no assumptions about which colour is the board.
     */
    bgCandidates(proc) {
      const lab = PH.rgbaToLab(proc.data, proc.w, proc.h);
      let valid = null;
      if (proc.invalid) { const v = PH.validFromAlpha(proc); valid = v.valid; v.validMat.delete(); } // (a per-pixel JS callback before)
      const modes = PH.colorModes(lab, proc.w, proc.h, valid, 4).filter((m) => m.frac > 0.03);
      const cands = modes.map((bg) => ({ kind: 'color', bg }));
      // mixed tables: pairs of the 3 most common colours as a two-colour background
      const top = modes.slice(0, 3);
      for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) cands.push({ kind: 'colors', list: [top[i], top[j]] });
      if (this.taught && this.taught.length) {
        cands.push({ kind: 'taught' });
        const t = this.taught, k = t.length;
        cands.push({ kind: 'color', bg: { L: t.reduce((s, x) => s + x.L, 0) / k, a: t.reduce((s, x) => s + x.a, 0) / k, b: t.reduce((s, x) => s + x.b, 0) / k } });
      }
      if (this.box && this.box.palette) cands.push({ kind: 'palette' });
      // See-through table (glass over a floor): pieces by their sharp
      // outlines (PH.edgeForeground), at each outline threshold.
      // Only without a dominant table colour (glass frames: the commonest
      // colour covers ~10-13% of the view; a board 30%+): on a plain board
      // the tuned colour path stays, even where outlines score a little more.
      const plainish = modes.length && modes[0].frac >= 0.3;
      if (this.curSource && this.opts.edgeBg !== false && !plainish) for (const edgeT of PH.EDGE_T) cands.push({ kind: 'edges', edgeT });
      return cands;
    }
    // How many piece-shaped blobs does this background model produce here?
    scoreBg(proc, c, extra) {
      const seg = PH.segment(proc, this.segOpts(Object.assign({ bgModel: c, splitBudgetMs: 40, unitArea: this.unitLive || null }, extra)));
      let area = 0;
      const like = [];
      for (const d of seg.dets) {
        area += d.area;
        if (!d.border && PH.pieceScore(d.pts, d.area) > PH.MIN_CORNER_SCORE) like.push(d.area);
      }
      // Real pieces share one size; scraps of print (from a wrong model that
      // calls the pieces' own colour "table") don't. Count only piece-shaped
      // blobs within 0.5-2x their common size.
      const mid = like.length ? PH.median(like) : 0;
      const good = like.filter((a) => a > mid * 0.5 && a < mid * 2).length;
      // a model that calls most of the frame "foreground" is wrong even if
      // a few blobs happen to look like pieces
      const fg = area / (proc.w * proc.h);
      // Inverted models: in a dense pile the GAPS between pieces are jigsaw-
      // shaped too, and a model calling the pieces' own colour "table" counts
      // them as pieces (owner's glass-table photo pieces-1: 38 "pieces", all
      // gaps). Real pieces carry print and cut edges; gaps and tables are
      // smoother. Foreground smoother than background -> mostly not pieces.
      const tex = this.texRatio(proc, seg.dets);
      const inverted = tex !== null && tex < 1 ? tex * 0.4 : 1;
      return { c, good, fg: +fg.toFixed(2), tex: tex === null ? null : +tex.toFixed(2), score: good * (fg > 0.75 ? 0.3 : 1) * inverted };
    }
    /** Mean local lightness spread (texture) inside the detections vs outside
     *  them, for this processing image (the texture map is cached per image). */
    texRatio(proc, dets) {
      if (!dets.length) return null;
      const cv = PH.cv;
      if (!this.texCache || this.texCache.proc !== proc) {
        if (this.texCache) this.texCache.map.delete();
        const P = PH.labPlanes(PH.rgbaToLab(proc.data, proc.w, proc.h), proc.w, proc.h);
        const Lf = new cv.Mat(), mu = new cv.Mat(), m2 = new cv.Mat(), sq = new cv.Mat();
        P.L.convertTo(Lf, cv.CV_32F);
        cv.blur(Lf, mu, new cv.Size(5, 5)); cv.multiply(Lf, Lf, sq); cv.blur(sq, m2, new cv.Size(5, 5));
        cv.multiply(mu, mu, sq); cv.subtract(m2, sq, m2);
        cv.max(m2, new cv.Mat(proc.h, proc.w, cv.CV_32F, new cv.Scalar(0)), m2);
        cv.sqrt(m2, m2);
        [Lf, mu, sq].forEach((x) => x.delete()); P.delete();
        this.texCache = { proc, map: m2 };
      }
      const fgm = cv.Mat.zeros(proc.h, proc.w, cv.CV_8UC1), mv = new cv.MatVector();
      for (const d of dets) mv.push_back(cv.matFromArray(d.pts.length / 2, 1, cv.CV_32SC2, Array.from(d.pts)));
      cv.drawContours(fgm, mv, -1, new cv.Scalar(255), -1);
      for (let i = 0; i < mv.size(); i++) mv.get(i).delete();
      const bgm = new cv.Mat(); cv.bitwise_not(fgm, bgm);
      const inside = cv.mean(this.texCache.map, fgm)[0], outside = cv.mean(this.texCache.map, bgm)[0];
      [fgm, bgm, mv].forEach((x) => x.delete());
      return inside / Math.max(0.1, outside);
    }
    /**
     * Which background model fits this table? Candidates: the 4 most common
     * colours (on a dense pile the most common one can be the *pieces*),
     * pairs of colours (mixed tables), the taught colours and the box
     * palette. Each is tried; the one yielding the most piece-shaped blobs
     * wins - no assumption about which colour is the board. All at once
     * (photos); live scanning spreads it over frames (stepBgChoice).
     */
    chooseBackground(proc, extra) {
      const tried = this.bgCandidates(proc).map((c) => this.scoreBg(proc, c, extra));
      return this.pickBg(tried);
    }
    pickBg(tried) {
      const r3 = (c) => c && [c.L, c.a, c.b].map(Math.round);
      this.bgTried = tried.map((t) => ({ kind: t.c.kind, bg: r3(t.c.bg) || (t.c.list && t.c.list.map(r3)) || t.c.edgeT, good: t.good, fg: t.fg }));
      let best = null, bestColour = null;
      for (const t of tried) {
        if (!best || t.score > best.score) best = t;
        if (t.c.kind !== 'edges' && (!bestColour || t.score > bestColour.score)) bestColour = t;
      }
      // The outline model (see-through tables) costs a second, larger image
      // per frame on the phone, and the colour models are the tuned path on a
      // plain board (where outlines win by only ~10%): it must clearly win.
      if (best && best.c.kind === 'edges' && bestColour && best.score < bestColour.score * 1.25) best = bestColour;
      return best && best.good >= 2 ? best : null;
    }
    // Live: one candidate per still frame; when all are scored, switch only if
    // clearly better than the current model (no flip-flopping).
    stepBgChoice(proc) {
      if (!this.bgEval) {
        const cands = this.bgCandidates(proc);
        // the current model is re-scored too, so the comparison is fair
        if (this.bgModel) cands.unshift(this.bgModel);
        this.bgEval = { cands, i: 0, tried: [] };
      }
      const E = this.bgEval;
      E.tried.push(this.scoreBg(proc, E.cands[E.i++]));
      if (E.i < E.cands.length) return false;
      this.bgEval = null;
      const best = this.pickBg(E.tried);
      const prev = this.bgModel, cur = prev && E.tried.find((t) => t.c === prev);
      if (best && (!cur || best.c === cur.c || best.score > cur.score * 1.2)) this.bgModel = best.c;
      this.bgKept = !!prev && this.bgModel === prev; // nothing better: back off (processFrame)
      return true;
    }

    /** Table view: remember how the view a piece's shape was read in maps
     *  onto the table map - a similarity from source pixels to table units -
     *  and where the piece stood then. The map draws the piece's picture
     *  (thumbnail + outline, in source pixels) through it: right position,
     *  angle and size. Later small position refinements are a translation.
     *  `pic` (thumbnail + corners, optionally its own edge outlines) is the
     *  picture of THIS read when it is not the stored shape's own - the map
     *  must draw the picture that goes with the placement (same view, same
     *  pixel scale); null = the stored shape's picture. */
    notePlacement(p, pic) {
      const T = this.pose, F = this.frameCtx;
      if (!T || !p.pos || !F) return;
      const s = F.scale;
      p.rd = { a: T.a * s, b: T.b * s, tx: T.tx, ty: T.ty, pos0: p.pos.slice() };
      p.pic = pic || null;
    }
    /** Move a piece with its whole scan group (islands being joined): its
     *  position and its read placement both go through T. */
    moveWithGroup(p, T) {
      p.pos = PH.simApply(T, p.pos[0], p.pos[1]);
      const r = p.rd;
      if (r) {
        p.rd = { a: T.a * r.a - T.b * r.b, b: T.b * r.a + T.a * r.b,
          tx: T.a * r.tx - T.b * r.ty + T.tx, ty: T.b * r.tx + T.a * r.ty + T.ty,
          pos0: PH.simApply(T, r.pos0[0], r.pos0[1]), stale: r.stale };
      }
    }
    /** A piece that physically moved: the map keeps drawing its picture
     *  (following its new position) but its angle is out of date until the
     *  next live read places it again. */
    markMoved(p) { if (p.rd) p.rd.stale = true; }
    /** Everything the Table view needs, for every catalogued entry. */
    mapData() {
      const doubt = this.cornerDoubts();
      const out = [];
      for (const p of this.pieces.values()) {
        if (!p.pos || !this.isChecked(p) || p.gone) continue; // the Map shows checked pieces where they are now
        const f = edgeFlags(p);
        const t1 = p.t1, pic = p.rd && p.pic;
        out.push({
          id: p.id, pos: p.pos, island: p.island, rd: p.rd || null, missing: !!p.missing,
          inPuzzle: !!p.inPuzzle, upT: (this.upOf(p) || {}).vt || null,
          zone: this.box && p.t2 && p.t2.cands.length && p.t2.conf >= 0.2 ? PH.zoneOf(this.box, p.t2.cands[0].col, p.t2.cands[0].row) : null,
          area: p.area, shaped: !!t1, placed: !!(p.t2 && p.t2.conf >= 0.35), confirmed: shapeConfirmed(p),
          border: f.border && !f.corner, corner: f.corner && !doubt.has(p.id),
          thumb: pic ? pic.thumb : t1 ? t1.thumb : null, corners: pic ? pic.corners : t1 ? t1.corners : null,
          sigs: pic && pic.sigs ? pic.sigs : t1 ? t1.edges.map((e) => e.sig) : null,
        });
      }
      const unit = this.unitTable() || 30;
      // Drawn size: a read whose view was distorted (a wrong tilt reading
      // straightens the far side up to ~2x) would draw its piece too big or
      // too small. Pieces of one puzzle are all about one size, so a picture
      // more than ~15% off the typical size is drawn at the typical size,
      // centred where it was and at its own angle.
      const side = (c) => { let s = 0; for (let k = 0; k < 4; k++) s += Math.hypot(c[(k + 1) % 4][0] - c[k][0], c[(k + 1) % 4][1] - c[k][1]) / 4; return s; };
      const drawn = out.filter((q) => q.rd && q.corners);
      const ratio = drawn.map((q) => Math.hypot(q.rd.a, q.rd.b) * side(q.corners) / unit);
      const typ = PH.median(ratio);
      drawn.forEach((q, i) => {
        if (!(typ > 0) || Math.abs(Math.log(ratio[i] / typ)) < 0.15) return;
        const r = q.rd, k = typ / ratio[i], a = r.a * k, b = r.b * k;
        const cx = q.corners.reduce((s, c) => s + c[0], 0) / 4, cy = q.corners.reduce((s, c) => s + c[1], 0) / 4;
        const mx = r.a * cx - r.b * cy + r.tx, my = r.b * cx + r.a * cy + r.ty; // where its centre was drawn
        q.rd = { a, b, tx: mx - (a * cx - b * cy), ty: my - (b * cx + a * cy), pos0: r.pos0, stale: r.stale };
      });
      return { pieces: out, unit, asm: this.asmMapData() };
    }
    /** Assembled parts on the Map: filled cells and open spots as table-map
     *  squares (for assemblies whose place on the table map is known - see
     *  noteAsmTable). */
    asmMapData() {
      const out = [];
      for (const A of this.asms || []) {
        const T = A.tab && A.tab.T;
        if (!T || !this.asmShown(A)) continue;
        const sq = (i, j) => [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => PH.simApply(T, a, b));
        const cells = [];
        for (const c of A.cells.values()) if (A.filled(c)) cells.push(sq(c.i, c.j));
        out.push({ island: A.tab.island, cells, spots: A.spots(this.box).map((sp) => ({ q: sq(sp.i, sp.j), n: sp.n, cell: sp.cell })), border: A.borderStatus(this.box) });
      }
      return out;
    }

    /** Why detection `d` is not good enough to become a new piece (null = OK).
     *  'moving' blurred frame, 'far' too few pixels per piece to read its shape,
     *  'size' not one piece's area (fragment or clump), 'shape' not piece-shaped. */
    shotQuality(d) {
      const F = this.frameCtx;
      if (!F.still) return 'moving';
      if (Math.sqrt(d.area) / F.scale < this.opts.minSidePx) return 'far';
      const u = F.unitArea;
      if (u && (d.area < u * 0.6 || d.area > u * 1.7)) return 'size';
      if (PH.pieceScore(d.pts, d.area) <= PH.MIN_CORNER_SCORE) return 'shape';
      return null;
    }
    /** Provisional pieces: count a good sighting of `d` (followed from the
     *  previous frame via its candidate id); true once it has been seen in
     *  `confirmSightings` steady frames in a row with a consistent size. */
    promote(d, need) {
      need = need || this.opts.confirmSightings;
      let c = d.cid && this.cands.get(d.cid);
      if (c && Math.abs(Math.log(d.area / c.area)) > 0.25) { this.cands.delete(c.id); c = null; } // size jumped: not the same thing
      if (!c) { c = { id: this.nextCid++, n: 0, area: d.area, last: -1 }; this.cands.set(c.id, c); }
      d.cid = c.id;
      if (c.last !== this.fNo) c.n++;
      c.area = c.area * 0.5 + d.area * 0.5; c.last = this.fNo;
      return c.n >= need; // the caller drops the candidate once it's catalogued (dropCand)
    }
    candOf(d) { return (d.cid && this.cands.get(d.cid)) || {}; }
    dropCand(d) { if (d.cid) this.cands.delete(d.cid); d.cid = null; }
    /** How much a new piece must show before it's catalogued, by how big
     *  pieces look (piece side in source px): close up the outline is crisp
     *  and two steady sightings and a fair read are enough; far away outlines
     *  are coarse, so more sightings, a better read, and a stricter "same
     *  piece?" test. Automatic - nothing for the owner to set. */
    detailTier(d) {
      const side = Math.sqrt(d.area) / this.frameCtx.scale;
      const base = this.opts.confirmSightings;
      if (side >= 110) return { need: base, q: 0.15, tol: PH.SAME_SHAPE * 1.2 };
      if (side >= 70) return { need: base + 1, q: 0.22, tol: PH.SAME_SHAPE };
      return { need: base + 2, q: 0.28, tol: PH.SAME_SHAPE * 0.9 };
    }
    /** A new view's shape against every catalogued piece not seen in this
     *  frame: `same` = the piece it is (outline and print agree), else
     *  `ambiguous` when one is close in outline and similar in colour. */
    identify(t1, d, claimed, tier) {
      let same = null, sameD = Infinity, amb = false;
      for (const p of this.pieces.values()) {
        if (claimed.has(p.id) || !p.t1) continue;
        const al = PH.shapeAlign(t1, p.t1); // cheap: edge types and lengths rule most out
        if (!(al.d < tier.tol * 1.6)) continue;
        const m = PH.samePiece(t1, p.t1, tier.tol);
        if (m.ok && m.d < sameD) { same = p; sameD = m.d; } else if (!m.ok && PH.fpSimilarity(d.fp, p.fp) > 0.6) amb = true;
      }
      return { same, ambiguous: !same && amb };
    }
    /** A new entry's first shape read. Too little detail for how far away it
     *  was seen: not attached (tried again on later views; an entry that
     *  never reads well enough is dropped). The same outline and print as a
     *  catalogued piece not in this view: that piece moved here - merged into
     *  it, whatever the colours look like under this light. Close to one but
     *  not clearly the same: wait for a better view (at most a few).
     *  @returns 'ok' | 'wait' | 'merged' */
    verifyNew(p, d, t1, dets) {
      const tier = this.detailTier(d);
      p.verifyTries = (p.verifyTries || 0) + 1;
      // (a photo is the best view there will be: no waiting for a better one)
      if (this.frameCtx.live && (!t1.quality || t1.quality.q < tier.q)) {
        this.reject('detail');
        if (p.verifyTries >= 8) { this.removePiece(p.id); d.id = null; }
        return 'wait';
      }
      const inView = new Set(dets.map((x) => x.id).filter(Boolean));
      const idn = this.identify(t1, d, inView, tier);
      // In another scan group it is far more likely the same table seen after
      // tracking was lost than a moved piece: left as a duplicate, which
      // Tidy up uses to join the two groups (tidy()).
      if (idn.same && idn.same.pos && !idn.same.missing && idn.same.island !== p.island) return 'ok';
      if (idn.same) {
        const o = idn.same;
        o.pos = p.pos; o.island = p.island; o.miss = 0; o.missing = false; o.lastSeen = Date.now();
        this.markMoved(o); this.touch(o);
        this.noteMerged(p.id, o.id);
        this.removePiece(p.id); d.id = o.id;
        this.rejects.relinked = (this.rejects.relinked || 0) + 1;
        return 'merged';
      }
      if (idn.ambiguous && this.frameCtx.live && p.verifyTries < 4) { this.reject('ambiguous'); return 'wait'; }
      return 'ok';
    }
    /** The puzzle's piece side in mm: from the box's finished size when given,
     *  else typical for its piece count (a 1000-piece puzzle's pieces are much
     *  smaller than a 300's). null without a box picture. */
    pieceMM() {
      if (!this.box) return null;
      return this.box.pieceMM || PH.typicalPieceMM(this.box.cols * this.box.rows);
    }
    /** Camera geometry from a piece area (proc px^2): piece side in source px,
     *  and - with the real piece size and the lens's field of view - the
     *  camera's distance from the table (mm). */
    viewGeometry(unitProcArea, scale, srcW, srcH) {
      if (!unitProcArea) return null;
      const sidePx = Math.sqrt(unitProcArea / 1.2) / scale; // piece area includes tabs: ~1.2x the square core
      const f = PH.focalPx(srcW, srcH, this.opts.fov);
      const mm = this.pieceMM();
      return { sidePx, f, distMM: mm ? (f * mm) / sidePx : null };
    }

    /**
     * WP1: one stable "one piece" area for live scanning. A frame's own
     * estimate (from >= 3 piece-like blobs) is blended in slowly when it is
     * within 1.5x of the running value. Frames far off are ignored, unless 4
     * in a row agree with each other (the phone really moved up/down), then
     * the running value jumps to them. Seeded by the first good frame.
     */
    updateUnitLive(seg, proc, source) {
      // Up close only 1-2 whole pieces are in view (the rest cut by the frame
      // edge): they count too, but only through the "4 views in a row agree"
      // path below. Requiring 3 froze the size at the far view's (owner's
      // video IMG_3605: 4067 px from 7 s on while the pieces grew to ~5x, so
      // every close-up piece was called a clump and never read; 14 -> 16
      // checked over the 40 s sweep).
      const few = seg.unitN < 3;
      const own = few ? (seg.unitN >= 1 ? seg.unitOwn || seg.likeMed : null) : seg.unitOwn;
      if (!own) return;
      // With the puzzle's real piece size, an estimate implying the camera is
      // closer than 6 cm or further than 2 m is wrong (a wall or a pile, not a piece).
      if (proc && source && this.pieceMM()) {
        const g = this.viewGeometry(own, proc.scale, source.w, source.h);
        if (g && g.distMM && (g.distMM < 60 || g.distMM > 2000)) { this.rejects.unitImplausible = (this.rejects.unitImplausible || 0) + 1; return; }
      }
      if (!this.unitLive) { if (!few) { this.unitLive = own; this.unitOff = []; } return; }
      const r = own / this.unitLive;
      if (r < 1.5 && r > 1 / 1.5) {
        if (!few) this.unitLive = this.unitLive * 0.8 + own * 0.2; // (1-2 pieces: agrees, too few to refine it)
        this.unitOff = [];
        return;
      }
      // 1-2 pieces only ever make it bigger (coming closer); moving away
      // brings many pieces into view. (A lone print fragment, 4 frames in a
      // row, once set it to 496 px and made every piece a "clump".)
      if (few && r < 1) return;
      this.unitOff = (this.unitOff || []).concat(own).slice(-4);
      const o = this.unitOff;
      if (o.length === 4 && Math.max(...o) / Math.min(...o) < 1.5) { this.unitLive = PH.median(o); this.unitOff = []; }
    }

    segOpts(extra) {
      return Object.assign({
        boardRef: this.boardRef || null, // this session's usual board colour (PH.lightFix)
        minDE: this.opts.minDE, lightW: this.opts.lightW,
        taught: this.taught, palette: this.opts.useBoxPalette !== false && this.box ? this.box.palette : null,
        paletteWhite: this.box ? this.box.white : null,
        edgeSource: () => this.curSource, // the 'edges' model reads this view at a larger size
      }, extra);
    }
    teachBackground(lab) { this.taught.push(lab); }
    clearBackground() { this.taught = []; }

    classify(dets, unitArea) {
      const areas = dets.filter((d) => !d.border).map((d) => d.area);
      // Unknown unit: call nothing merged (a bad guess would turn single
      // pieces into "sections"); the median still filters out crumbs.
      const medA = unitArea || PH.median(areas.length ? areas : dets.map((d) => d.area));
      const out = [];
      for (const d of dets) {
        d.merged = !!d.big || (!!unitArea && d.area > unitArea * 1.9);
        if (d.area < medA * 0.3) continue; // crumbs, glare, fingers' edges
        d.id = null;
        out.push(d);
      }
      return out;
    }
    unitFrame(dets) {
      const a = dets.filter((d) => !d.merged && !d.border).map((d) => d.area);
      return Math.sqrt(PH.median(a.length ? a : dets.map((d) => d.area))) || 40;
    }

    startIsland(unitF) {
      const unitT = this.unitTable();
      const isl = this.nextIsland++;
      const s = unitT ? unitT / unitF : 1;
      // Park new islands far from existing pieces so they never overlap.
      let maxX = 0;
      for (const p of this.pieces.values()) if (p.pos) maxX = Math.max(maxX, p.pos[0]);
      const tx = this.pieces.size ? maxX + 5000 : 0;
      this.pose = { a: s, b: 0, tx, ty: 0 };
      this.island = isl;
    }

    // Give every det a piece id: nearby located piece, re-found lost piece, or new.
    assign(dets, unitF, proc) {
      let T = this.pose;
      const s = PH.simScale(T);
      const unitT = this.unitTable() || unitF * s;
      const claimed = new Set(dets.filter((d) => d.id).map((d) => d.id));
      const nearest = (d, T) => {
        const q = PH.simApply(T, d.cx, d.cy);
        let best = null, spot = null, spots = 0;
        for (const p of this.pieces.values()) {
          if (!p.pos || p.gone || p.island !== this.island || claimed.has(p.id)) continue; // a gone piece is found again by its shape, not its old spot
          const dist = Math.hypot(p.pos[0] - q[0], p.pos[1] - q[1]);
          if (dist > unitT * (d.merged ? 1.2 : 0.55)) continue;
          const sim = PH.fpSimilarity(d.fp, p.fp);
          // The spot comes first (v0.20): one piece-sized thing on a piece's
          // spot is that piece, even when its colours look different - the
          // phone's shadow and exposure changed them (owner's report 11:14:
          // 25 pieces catalogued twice on their own spots). Only a clear
          // shape disagreement between two close reads says otherwise.
          if (!d.merged && dist < unitT * 0.5) {
            const ar = (d.area * s * s) / (p.area || 1);
            if (ar > 0.6 && ar < 1.6) { spots++; if (!spot || dist < spot.dist) spot = { p, dist, sim }; }
          }
          // A piece flagged missing is matched at its last-known spot too, but
          // needs a closer colour match (another piece may have taken the spot).
          if (sim < (p.missing ? 0.6 : 0.5)) continue;
          const c = dist / unitT + (1 - sim);
          if (!best || c < best.c) best = { c, p };
        }
        if (best) return best.p;
        if (spot && spots === 1 && !this.shapeVeto(d, spot.p)) { d.bySpot = true; return spot.p; }
        if (PH.DEBUG_ASSIGN) {
          let nb = null, nd = Infinity;
          for (const p of this.pieces.values()) { if (!p.pos || p.island !== this.island) continue; const dd = Math.hypot(p.pos[0] - q[0], p.pos[1] - q[1]); if (dd < nd) { nd = dd; nb = p; } }
          PH.DEBUG_ASSIGN({ det: Math.round(d.area), nearest: nb && nb.id, dist: +(nd / unitT).toFixed(2), claimed: nb && claimed.has(nb.id), gone: nb && nb.gone, sim: nb && +PH.fpSimilarity(d.fp, nb.fp).toFixed(2), area: nb && +((d.area * s * s) / nb.area).toFixed(2), spots, veto: spot ? 'checked' : 'nospot' });
        }
        return null;
      };
      // Pass 1: match by position; then refit the pose on every match so a
      // slightly-off pose (just relocalized, few anchors) doesn't cause misses.
      for (const d of dets) {
        if (d.id || d.merged) continue; // clumps and assembled parts are never catalogued (assembly.js)
        const p = nearest(d, T);
        if (p) { d.id = p.id; claimed.add(p.id); }
      }
      const pairs = [];
      for (const d of dets) {
        const p = d.id && this.pieces.get(d.id);
        if (p && p.pos && p.island === this.island) pairs.push({ src: [d.cx, d.cy], dst: p.pos });
      }
      if (pairs.length >= 3) {
        const r = PH.simRansac(pairs, unitT * 0.35, 60, this.rnd);
        if (r && r.inliers.length >= Math.max(3, pairs.length * 0.6)) { T = this.pose = r.T; }
      }
      for (const d of dets) {
        if (d.id || d.merged) continue;
        const q = PH.simApply(T, d.cx, d.cy);
        const near = nearest(d, T);
        if (near) { d.id = near.id; claimed.add(near.id); continue; }
        if (d.border) continue;
        // Before adding a new piece, check whether a known piece was moved here
        // (or went missing earlier). Look-alikes are common (sky!), so a
        // candidate with a shape model must also match by shape.
        const moved = this.frameCtx.offLight ? null : this.findMoved(d, s, claimed); // (colours are off in odd light)
        if (moved === 'defer') continue; // out of time this frame; decide next frame
        if (moved) {
          moved.pos = q; moved.island = this.island; moved.miss = 0; moved.missing = false; this.markMoved(moved); d.id = moved.id; claimed.add(moved.id); this.touch(moved);
          if (moved.gone) { moved.gone = false; moved.refound = (moved.refound || 0) + 1; this.version++; }
          continue;
        }
        // Only good shots make new pieces: steady, close enough to read, piece-
        // sized, piece-shaped (never a fragment of a pale piece). On live frames
        // the detection is then provisional until seen in a few such frames in
        // a row - one-off blur smears, shadow blobs and fragments never reach
        // the catalog.
        const why = this.frameCtx.offLight ? 'offLightNew' : this.shotQuality(d);
        if (why) { this.rejects[why] = (this.rejects[why] || 0) + 1; continue; }
        // A far view never starts a new entry right next to a checked piece
        // that isn't accounted for in this frame: far away the map can be
        // half a piece off (owner's video: false rings in the last overview),
        // and a far read can't tell which piece it is. Close up, it can.
        if (Math.sqrt(d.area) / this.frameCtx.scale / 1.1 < PH.CLOSE_SIDE) {
          let besideChecked = false;
          for (const p of this.pieces.values()) {
            if (p.state !== 'checked' || !p.pos || p.gone || p.island !== this.island || claimed.has(p.id)) continue;
            if (Math.hypot(p.pos[0] - q[0], p.pos[1] - q[1]) < unitT * 1.0) { besideChecked = true; break; }
          }
          if (besideChecked) { this.rejects.farNearChecked = (this.rejects.farNearChecked || 0) + 1; continue; }
        }
        // Far away a piece must be seen in more steady frames first (detailTier);
        // its first shape read then decides whether it's new (verifyNew).
        if (this.frameCtx.live && !this.promote(d, this.detailTier(d).need)) continue;
        if (this.frameCtx.live) this.dropCand(d);
        const p = this.newPiece(d, q, this.island, d.area * s * s);
        d.id = p.id; claimed.add(p.id);
        this.version++;
      }
      // Located pieces that should be in view but aren't: maybe moved, but on
      // a white board far more often just not detected this frame (pale
      // pieces; report 15:52 had a median of 16 detections with many more
      // pieces in view). Forgetting the position (as before v0.9.2) made the
      // piece's next detection a NEW entry whenever the strict shape/colour
      // re-identification failed — 566 entries for ~150 pieces. Now a piece
      // only gets flagged `missing` after 12 steady-frame misses and keeps its
      // last-known spot, where it is re-linked when it shows up again;
      // findMoved() still catches pieces that really were moved.
      const inv = PH.simInvert(T);
      const seen = new Set(dets.map((d) => d.id));
      const margin = unitF;
      // Where this frame's matched pieces really are vs where the map puts
      // them: the map bends a little over a long sweep (owner's video: up to
      // about a piece), so a spot is checked relative to its neighbours.
      const anchors = [];
      for (const d of dets) {
        const q = d.id && this.pieces.get(d.id);
        if (!q || !q.pos || q.island !== this.island || d.merged || d.border) continue;
        const f = PH.simApply(inv, q.pos[0], q.pos[1]);
        anchors.push({ pos: q.pos, dx: d.cx - f[0], dy: d.cy - f[1] });
      }
      if (this.frameCtx.still) for (const p of [...this.pieces.values()]) {
        if (!p.pos || p.gone || p.island !== this.island || seen.has(p.id)) continue;
        const f = PH.simApply(inv, p.pos[0], p.pos[1]);
        const nb = anchors.filter((a) => Math.hypot(a.pos[0] - p.pos[0], a.pos[1] - p.pos[1]) < unitT * 3);
        if (nb.length >= 2) { f[0] += PH.median(nb.map((a) => a.dx)); f[1] += PH.median(nb.map((a) => a.dy)); }
        if (f[0] < margin || f[1] < margin || f[0] > proc.w - margin || f[1] > proc.h - margin) continue;
        const covered = dets.some((d) => (d.merged || d.border) && f[0] >= d.bbox[0] && f[1] >= d.bbox[1] && f[0] <= d.bbox[0] + d.bbox[2] && f[1] <= d.bbox[1] + d.bbox[3]);
        if (covered) continue;
        // Gone (owner, 2026-10-05: "drop the dot if you know that it
        // disappeared"): proof, not a missed detection - the spot is in a
        // steady view close enough to read the piece, and the board shows
        // across its footprint, at 2 separate moments. A pale piece the
        // detector missed leaves no bare board there, so it never counts.
        const sideF = Math.sqrt(p.area || 1) / s; // the piece's size in this frame (processing px)
        // close enough that the piece would have been read up close: far
        // views (the map is least exact there) never prove a piece gone
        const readable = sideF / this.frameCtx.scale / 1.1 >= PH.CLOSE_SIDE;
        // (the map can be off by part of a piece during a close sweep: a
        // detection near the spot may well be this piece - no proof then)
        const nearDet = dets.some((d) => !d.border && Math.hypot(d.cx - f[0], d.cy - f[1]) < sideF * 1.0);
        if (readable && !nearDet && nb.length >= PH.GONE_NB && !this.frameCtx.offLight && this.bareBoard(f, sideF * 0.4) >= 0.85) { // (no neighbours seen: the spot can't be placed well enough to prove anything)
          if (this.fNo - (p.goneF === undefined ? -1e9 : p.goneF) >= 6) { p.goneVotes = (p.goneVotes || 0) + 1; p.goneF = this.fNo; }
          if (p.goneVotes >= PH.GONE_VOTES) {
            p.goneVotes = 0;
            if (this.isChecked(p)) { p.gone = true; p.goneAt = Date.now(); p.missing = true; this.touch(p); this.version++; this.matchCache.clear(); this.logEvt('gone', p.id); }
            else this.removePiece(p.id); // an unchecked ring on bare board was nothing
            continue;
          }
        } else if (readable) p.goneVotes = 0; // something is there: not proof of absence
        if (++p.miss > 12) { p.missing = true; p.miss = 0; this.touch(p); }
      }
      const steady = this.frameCtx && this.frameCtx.still;
      const seenNow = [];
      for (const d of dets) {
        if (!d.id) continue;
        const p = this.pieces.get(d.id);
        if (!p) continue; // (merged away meanwhile)
        p.miss = 0; p.missing = false; p.lastSeen = Date.now(); p.goneVotes = 0;
        if (p.gone) { p.gone = false; p.refound = (p.refound || 0) + 1; this.touch(p); this.version++; }
        if (d.merged || d.border) continue;
        seenNow.push(p);
        if (!steady) continue;
        // Evidence for "checked": steady sightings, at separate moments
        // (>= 6 analysed frames apart, ~1 s on the phone).
        p.sightings = (p.sightings || 0) + 1;
        if (this.fNo - (p.momentF === undefined ? -1e9 : p.momentF) >= 6) { p.moments = (p.moments || 0) + 1; p.momentF = this.fNo; }
        if (Math.sqrt(d.area) / this.frameCtx.scale / 1.1 >= PH.CLOSE_SIDE) p.closeViews = (p.closeViews || 0) + 1;
        // The entry learns its look from every steady view (a fingerprint
        // frozen at a first, dim view stopped matching the same piece later).
        if (d.fp && !this.frameCtx.offLight) p.fp = PH.blendFp(p.fp, d.fp, d.bySpot ? 0.3 : 0.15); // (not from odd-light frames)
      }
      // Seen together: two entries detected in the same frame are two
      // different pieces - the duplicate clean-up never merges them.
      if (seenNow.length > 1) {
        const R = unitT * 2;
        for (let i = 0; i < seenNow.length; i++) for (let j = i + 1; j < seenNow.length; j++) {
          const A = seenNow[i], B = seenNow[j];
          if (!A.pos || !B.pos || A.island !== B.island || Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1]) > R) continue;
          (A.seenWith || (A.seenWith = new Set())).add(B.id);
          (B.seenWith || (B.seenWith = new Set())).add(A.id);
        }
      }
    }
    /** Median colour of the frame's board pixels (not foreground), sampled. */
    measureBoard(seg, proc) {
      if (!seg.fg || !seg.lab) return null;
      const W = proc.w, H = proc.h, Ls = [], As = [], Bs = [];
      for (let y = 2; y < H; y += 7) for (let x = 2; x < W; x += 7) {
        const p = y * W + x;
        if (seg.fg[p] || (proc.invalid && !proc.data[4 * p + 3])) continue; // (not outside a straightened view's image)
        Ls.push(seg.lab[3 * p]); As.push(seg.lab[3 * p + 1]); Bs.push(seg.lab[3 * p + 2]);
      }
      return Ls.length >= 50 ? { L: PH.median(Ls), a: PH.median(As), b: PH.median(Bs) } : null;
    }
    /** The scan's board colour, the fixed reference colours are corrected
     *  against (PH.lightFix): the median board of the first steady frames,
     *  then kept (and saved with the scan) - a reference that followed the
     *  light would undo the correction. Until it is set, colours are read
     *  as they are. */
    noteBoard(bg, steady) {
      if (this.boardRef || !bg || !(bg.L > 15) || !steady) return;
      const S = this.boardSeen || (this.boardSeen = []);
      S.push([bg.L, bg.a, bg.b]);
      if (S.length < 8) return;
      this.boardRef = { L: PH.median(S.map((v) => v[0])), a: PH.median(S.map((v) => v[1])), b: PH.median(S.map((v) => v[2])) };
      this.boardSeen = null; this.boardRefDirty = true;
    }
    /** Share of the processing frame's pixels within radius r of point f that
     *  show bare board (not foreground). */
    bareBoard(f, r) {
      const F = this.frameCtx;
      if (!F || !F.fg) return 0;
      const W = F.procW, H = F.procH, x0 = Math.max(0, Math.floor(f[0] - r)), x1 = Math.min(W - 1, Math.ceil(f[0] + r));
      const y0 = Math.max(0, Math.floor(f[1] - r)), y1 = Math.min(H - 1, Math.ceil(f[1] + r)), st = Math.max(1, Math.floor(r / 8));
      let n = 0, bare = 0;
      for (let y = y0; y <= y1; y += st) for (let x = x0; x <= x1; x += st) {
        if ((x - f[0]) ** 2 + (y - f[1]) ** 2 > r * r) continue;
        if (F.rgba && !F.rgba[4 * (y * W + x) + 3]) continue; // outside the camera image: neither board nor piece
        n++; if (!F.fg[y * W + x]) bare++;
      }
      return n >= 12 ? bare / n : 0;
    }
    /** Which checked piece is this close read? Compared by close-read shape
     *  and print, any orientation, with every checked piece not in `skip`
     *  (the ones seen elsewhere in this frame). One clear answer or none: a
     *  runner-up nearly as close means look-alikes, and the read waits. */
    identifyChecked(t1, skip, at) {
      if (!PH.isCloseRead(t1)) return null;
      const unitT = this.unitTable() || 1;
      let best = null, second = Infinity, nearBest = null;
      for (const q of this.pieces.values()) {
        if (!this.isChecked(q) || !q.t1 || !PH.isCloseRead(q.t1) || (skip && skip.has(q.id))) continue;
        const m = PH.samePiece(t1, q.t1, PH.ANCHOR_SHAPE);
        if (!m.ok) continue;
        // nearby: almost always the same piece, a little off on the map (owner's video)
        // (on essentially the same spot: the same piece; a neighbour a piece
        // or two away only if its own spot is empty - else it is lying there)
        const dq = at && q.pos && !q.gone && q.island === this.island ? Math.hypot(q.pos[0] - at[0], q.pos[1] - at[1]) : Infinity;
        if (dq < unitT * 2.5 && (dq < unitT * 0.6 || !this.spotTaken(q)) && (!nearBest || m.d < nearBest.d)) nearBest = { p: q, d: m.d, r: m.r };
        if (!best || m.d < best.d) { if (best) second = best.d; best = { p: q, d: m.d, r: m.r }; } else if (m.d < second) second = m.d;
      }
      if (nearBest) return nearBest;
      // far away: a clearly unique match, and not a piece whose own spot is
      // in view and still taken (then it's there, and this is a look-alike)
      if (!best || !(second > best.d * 1.5)) return null;
      if (best.p.pos && !best.p.gone && this.spotTaken(best.p)) return null;
      return best;
    }
    /** Is piece p's spot in the current view with something lying on it? */
    spotTaken(p) {
      const F = this.frameCtx, T = this.pose;
      if (!F || !T || p.island !== this.island || !F.fg) return false;
      const f = PH.simApply(PH.simInvert(T), p.pos[0], p.pos[1]);
      if (f[0] < 0 || f[1] < 0 || f[0] >= F.procW || f[1] >= F.procH) return false;
      const r = Math.sqrt(p.area || 1) / PH.simScale(T) * 0.4;
      return this.bareBoard(f, r) < 0.5;
    }
    /** Another close read agreed with piece p's close shape: one more
     *  independent confirmation when it comes from a later view (4+ frames). */
    noteCloseAgree(p, t1) {
      if (!PH.isCloseRead(t1) || !PH.isCloseRead(p.t1)) return;
      if (this.fNo - (p.closeAgreeF === undefined ? -1e9 : p.closeAgreeF) < 4) return;
      p.closeAgree = (p.closeAgree || 1) + 1; p.closeAgreeF = this.fNo;
    }
    /** Two close reads of clearly different shapes: detection d is not piece
     *  p, whatever its spot says. Only decided when both reads are close
     *  (far reads misread tabs too often: 8 of 49 pieces in the owner's
     *  overview). Reads d's shape only when there is time left this frame. */
    shapeVeto(d, p) {
      if (!p.t1 || !PH.isCloseRead(p.t1) || this.frameCtx.offLight) return false;
      if (Math.sqrt(d.area) / this.frameCtx.scale / 1.1 < PH.CLOSE_SIDE) return false;
      if (d.t1 === undefined && now() > this.frameCtx.deadline) return false;
      const t1 = this.detT1(d);
      if (!t1 || !PH.isCloseRead(t1)) return false;
      return PH.clearlyDifferent(t1, p.t1);
    }

    findMoved(d, s, claimed) {
      const cands = [];
      for (const p of this.pieces.values()) {
        if (claimed.has(p.id)) continue;
        const sim = PH.fpSimilarity(d.fp, p.fp);
        const ar = (d.area * s * s) / p.area;
        if (sim > 0.75 && ar > 0.7 && ar < 1.4) cands.push({ p, sim });
      }
      if (!cands.length) return null;
      cands.sort((a, b) => b.sim - a.sim);
      if (d.t1 === undefined && cands.some((c) => c.p.t1) && now() > this.frameCtx.deadline) return 'defer';
      const t1 = this.detT1(d);
      const q = PH.simApply(this.pose, d.cx, d.cy);
      const unitT = this.unitTable() || 1;
      for (const c of cands.slice(0, 6)) {
        if (c.p.t1 && t1) { if (PH.samePiece(t1, c.p.t1, PH.SAME_SHAPE).ok) return c.p; continue; }
        const near = c.p.pos && c.p.island === this.island && Math.hypot(c.p.pos[0] - q[0], c.p.pos[1] - q[1]) < unitT * 2.5;
        if (c.sim > 0.9 && (!c.p.pos || c.p.missing || near)) return c.p;
      }
      return null;
    }

    // Lazily run T1 on a detection of the current frame (cached on the det).
    detT1(d) {
      if (d.t1 !== undefined) return d.t1;
      d.t1 = null;
      const F = this.frameCtx;
      if (!F || !F.still || d.border || d.merged) return null;
      const scale = F.scale, source = F.source;
      const [bx, by, bw, bh] = d.bbox;
      const m = Math.max(bw, bh) * 0.18;
      const x0 = Math.max(0, Math.floor((bx - m) / scale)), y0 = Math.max(0, Math.floor((by - m) / scale));
      const x1 = Math.min(source.w, Math.ceil((bx + bw + m) / scale)), y1 = Math.min(source.h, Math.ceil((by + bh + m) / scale));
      const crop = source.getCrop(x0, y0, x1 - x0, y1 - y0);
      const why = {};
      try {
        const hint = d.split ? Array.from(d.pts, (v, i) => v / scale - (i % 2 ? y0 : x0)) : null;
        d.t1 = PH.analyzePiece(crop, { bg: F.bg, threshDE: F.thresh, lut: F.lut, hint, lightW: this.opts.lightW, ox: x0, oy: y0, why, boardRef: this.boardRef || null,
          // one piece's area in this crop's (source) pixels, for the partial-outline check
          unitArea: F.unitArea ? F.unitArea / (scale * scale) : null });
      } catch (e) { d.t1 = null; }
      if (why.seam) this.reject('seam', d);
      // Background scraps and half-detected pieces don't have 4 good corners.
      if (d.t1 && d.t1.cornerScore < PH.MIN_CORNER_SCORE) { d.t1 = null; d.notPiece = true; }
      // A straight side with more puzzle right beyond it is a cut through an
      // assembled section (or a piece pressed against another), not the
      // puzzle's border: not read as a piece from this view.
      // Only for parts split off a big compact blob (an assembled section): in
      // a pile of loose pieces a real edge piece may lie against another one.
      const fromSection = d.parent && d.parent.area >= 4 && d.parent.solidity >= 0.85;
      if (d.t1 && fromSection && d.t1.flats.some(Boolean) && this.cutSide(d.t1, F)) { this.reject('cutSide', d); d.t1 = null; d.notPiece = true; }
      return d.t1;
    }
    reject(why, d) {
      this.rejects[why] = (this.rejects[why] || 0) + 1;
      if (d && d.id) { // already catalogued from an earlier view: its border reading can't be trusted
        const p = this.pieces.get(d.id);
        if (p) p.cutSeen = (p.cutSeen || 0) + 1;
      }
    }
    /** Does any straight side of shape t1 (source px) have foreground just
     *  beyond it in this frame? Samples a line 12% of the side outside it. */
    cutSide(t1, F) {
      if (!F.fg) return false;
      const s = F.scale, W = F.procW, H = F.procH;
      for (let k = 0; k < 4; k++) {
        if (!t1.flats[k]) continue;
        const A = t1.corners[k], B = t1.corners[(k + 1) % 4];
        const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
        const nx = dy / L, ny = -dx / L; // outward for a clockwise outline (y down)
        let on = 0, n = 0;
        for (const t of [0.25, 0.37, 0.5, 0.63, 0.75]) {
          const x = Math.round((A[0] + dx * t + nx * 0.12 * L) * s), y = Math.round((A[1] + dy * t + ny * 0.12 * L) * s);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          n++; if (F.fg[y * W + x]) on++;
        }
        if (n >= 4 && on >= n * 0.6) return true;
      }
      return false;
    }

    // T1 (shape) and T2 (box placement) within a time budget.
    runQueue(dets, deadline) {
      let n1 = 0, n2 = 0;
      // Shape reading may use ~70% of what's left; box placement always gets
      // the rest (and at least 2 pieces) so it never starves while scanning.
      const start = now();
      const t1Deadline = deadline === Infinity ? Infinity : start + (deadline - start) * 0.7;
      const F = this.frameCtx, scale = F.scale;
      // Another view of an already-shaped piece: average it into the model.
      for (const d of dets) {
        if (!d.id || !d.t1 || d.fused) continue;
        const p = this.pieces.get(d.id);
        if (!p) { d.id = null; continue; } // (merged away this frame)
        d.fused = true;
        if (!p.t1 || p.t1 === d.t1) continue;
        if (PH.isCloseRead(d.t1) !== PH.isCloseRead(p.t1)) { d.fused = false; continue; } // far and close reads never mix (the job loop below upgrades far to close)
        let m = PH.samePiece(d.t1, p.t1);
        if (!m.ok) { const sa = PH.shapeAgree(d.t1, p.t1); if (sa) m = { ok: true, r: sa.r, d: sa.d }; }
        if (m.ok) {
          if ((p.t1.nObs || 1) < 8) PH.fuseShapes(p.t1, d.t1, m.r);
          this.noteCloseAgree(p, d.t1);
          if (!p.rd || p.rd.stale) this.notePlacement(p, { thumb: d.t1.thumb, corners: [0, 1, 2, 3].map((k) => d.t1.corners[(k - m.r + 4) % 4]) }); // (the job loop skips this read now)
          this.touch(p); this.version++;
        } else d.fused = false; // not folded in: the job loop below decides
      }
      if (F.still) {
        const jobs = [];
        for (const d of dets) {
          if (!d.id || d.border || d.merged) continue;
          const p = this.pieces.get(d.id);
          if (!p) continue; // (merged away this frame)
          const sidePx = Math.sqrt(d.area) / scale;
          let pri = 0;
          if (p.t1) {
            const closeNow = sidePx / 1.1 >= PH.CLOSE_SIDE, pc = PH.isCloseRead(p.t1);
            // (a piece with one close read gets its second whatever the blob's
            // size says - the read's own corner-to-corner size decides)
            if ((closeNow && !pc) || (pc && (p.closeAgree || 0) < 2 && !p.photoRead)) { // (a photo's close read checks a piece on its own)
              // Checking a piece needs two agreeing close reads (v0.20): a
              // far-only shape gets its close read now, a single close read
              // its second one from a later view (4+ frames on).
              if (pc && this.fNo - (p.t1Frame || 0) < 4) continue;
              pri = pc ? 1 : 0.5;
            } else if (closeNow && pc && this.isChecked(p) && p.rd && !p.rd.stale && this.fNo - (p.verifyF === undefined ? p.t1Frame || 0 : p.verifyF) >= 60) { // (a missing Map placement is read first, below)
              // Now and then a checked piece in view is read again: pieces get
              // picked up and swapped (owner: "the biggest thing"). Spare time only.
              pri = 3;
            } else {
              // A shape is trusted once two independent views agree. Until then
              // re-read it from a later view (not the next few frames: those are
              // the same view); after that only from a much closer one.
              const confirmed = (p.t1.nObs || 1) >= 2 || p.photoRead || (p.closeAgree || 0) >= 2;
              // ... and a piece without a map placement (or a stale one: it
              // was moved) gets a read first, so the Map draws it where and
              // how it lies now.
              const needPlace = !p.rd || p.rd.stale;
              if (confirmed && !needPlace && sidePx < p.t1.meanSide * 1.4) continue;
              if (!confirmed && !needPlace && this.fNo - (p.t1Frame || 0) < 8) continue;
              pri = needPlace ? 0.8 : confirmed ? 2 : 1;
            }
          }
          if (!p.t1 && p.t1Fail > 0 && (p.t1Fail++ % 8) !== 0) continue;
          jobs.push({ d, p, pri });
        }
        // Within a priority, pieces near the middle of the view first: toward
        // the edges the camera sees the piece's side wall (outline bulges on
        // that side) and lens distortion grows (puzzle-bot keeps the most
        // central of several views for the same reason).
        const pc = this.lastProc, cxv = pc ? pc.w / 2 : 0, cyv = pc ? pc.h / 2 : 0, rv = Math.hypot(cxv, cyv) || 1;
        for (const j of jobs) j.centre = pc ? 1 - Math.hypot(j.d.cx - cxv, j.d.cy - cyv) / rv : 0.5;
        jobs.sort((a, b) => a.pri - b.pri || b.centre - a.centre);
        if (PH.DEBUG_Q) PH.DEBUG_Q('jobs', this.fNo, jobs.map((j) => j.p.id + ':' + j.pri + (j.d.t1 !== undefined ? '*' : '')).join(' '), 'over budget', now() > t1Deadline);
        let confirms = 0;
        for (const j of jobs) {
          // Always read at least 2 shapes per steady frame: when segmentation
          // alone overruns the budget (dense views on a slow phone), shape
          // reading would otherwise never run and nothing gets matched.
          if (j.pri === 0 && j.d.t1 === undefined && n1 >= 2 && now() > t1Deadline) break;
          // Confirmation re-reads (a second, later view of an already-read
          // piece): free when the frame has spare budget; when it doesn't (a
          // slow phone, where a read costs ~50-100 ms) at most one every other
          // frame, so revisiting costs about half a read per frame and only
          // until the pieces in view are confirmed (one re-read each).
          // (reads a piece needs to get checked - pri <= 1 - get one a frame;
          // routine re-checks only every other frame)
          if (j.pri > 0 && j.d.t1 === undefined && now() > t1Deadline && (confirms >= 1 || (j.pri >= 2 && this.fNo % 2))) break;
          if (j.pri > 0) confirms++;
          const t1 = this.detT1(j.d);
          if (t1) t1.centre = +j.centre.toFixed(2);
          if (PH.DEBUG_Q) PH.DEBUG_Q('  read', j.p.id, 'pri', j.pri, t1 ? 'side ' + Math.round(t1.meanSide) + ' q ' + (t1.quality && t1.quality.q) + ' code ' + t1.code + ' amp ' + t1.edges.map((e) => e.amp.toFixed(2) + (e.unc ? '?' : '')).join('/') : 'FAILED', 'stored', j.p.t1 && j.p.t1.code, 'fused', !!j.d.fused, t1 && j.p.t1 ? 'same ' + JSON.stringify((({ ok, d }) => ({ ok, d: +d.toFixed(3) }))(PH.samePiece(t1, j.p.t1))) : '');
          if (!t1) {
            j.p.t1Fail = (j.p.t1Fail || 0) + 1;
            if (!j.p.t1 && j.d.notPiece && j.p.t1Fail >= 4) { this.removePiece(j.p.id); j.d.id = null; }
            continue;
          }
          if (j.d.fused && j.p.t1) continue; // this read was already folded in above
          const nc = PH.isCloseRead(t1);
          const inFrame = () => new Set(dets.map((x) => x.id).filter((id) => id && id !== j.p.id));
          // A close read of an entry that isn't checked yet: is it a checked
          // piece that was moved here? Then it is that piece - same number,
          // its matches and answers kept (owner, 2026-10-05).
          if (nc && !this.isChecked(j.p) && !F.offLight) {
            const idn = this.identifyChecked(t1, inFrame(), j.p.pos);
            if (idn) {
              const Q = idn.p, here = j.p.pos, isl = j.p.island;
              this.mergeEntries(Q, j.p);
              if (here) { if (Q.pos && Math.hypot(Q.pos[0] - here[0], Q.pos[1] - here[1]) > (this.unitTable() || 1) * 0.5) this.markMoved(Q); Q.pos = here; Q.island = isl; }
              if (Q.gone) { Q.gone = false; Q.refound = (Q.refound || 0) + 1; }
              Q.missing = false; Q.miss = 0;
              j.d.id = Q.id;
              if ((Q.t1.nObs || 1) < 8) PH.fuseShapes(Q.t1, t1, idn.r); // (samePiece(read, stored).r, as fuseShapes takes it)
              this.rejects.refound = (this.rejects.refound || 0) + 1; this.logEvt('refound', Q.id, null);
              this.touch(Q); this.version++; this.matchCache.clear(); n1++;
              continue;
            }
          }
          // A checked piece's re-read that clearly disagrees (two close reads):
          // something else lies on its spot. Twice, at separate moments ->
          // the piece is not here: gone, or the read is another checked piece
          // (two pieces swapped). Its stored shape is never overwritten.
          if (nc && this.isChecked(j.p) && j.p.t1 && PH.isCloseRead(j.p.t1)) {
            j.p.verifyF = this.fNo;
            if (F.offLight) { n1++; continue; } // (a read in odd light proves nothing either way)
            const m = PH.samePiece(t1, j.p.t1, PH.ANCHOR_SHAPE);
            if (m.ok || !PH.clearlyDifferent(t1, j.p.t1)) {
              j.p.notHere = 0;
              if (!m.ok) { // a doubtful read: neither agreement nor proof; the stored shape stays, the Map may use this view's picture
                j.p.conflicts = (j.p.conflicts || 0) + 1;
                if (!j.p.rd || j.p.rd.stale) this.notePlacement(j.p, { thumb: t1.thumb, corners: t1.corners, sigs: t1.edges.map((e) => e.sig) });
                n1++; continue;
              }
              const m2 = PH.samePiece(t1, j.p.t1);
              if (m2.ok && (j.p.t1.nObs || 1) < 8) PH.fuseShapes(j.p.t1, t1, m2.r);
              this.noteCloseAgree(j.p, t1);
              if (!j.p.rd || j.p.rd.stale) this.notePlacement(j.p, { thumb: t1.thumb, corners: [0, 1, 2, 3].map((k) => t1.corners[(k - m.r + 4) % 4]) });
              this.touch(j.p); n1++;
              continue;
            }
            if (this.fNo - (j.p.notHereF === undefined ? -1e9 : j.p.notHereF) >= 6) { j.p.notHere = (j.p.notHere || 0) + 1; j.p.notHereF = this.fNo; }
            j.p.conflicts = (j.p.conflicts || 0) + 1;
            if (j.p.notHere >= 3) {
              const P = j.p, spot = P.pos, isl = P.island;
              P.notHere = 0; P.gone = true; P.goneAt = Date.now(); P.missing = true; this.touch(P);
              const idn = this.identifyChecked(t1, new Set([...inFrame(), P.id]));
              if (idn) {
                const Q = idn.p;
                Q.pos = spot; Q.island = isl; this.markMoved(Q);
                if (Q.gone) { Q.gone = false; Q.refound = (Q.refound || 0) + 1; }
                Q.missing = false; Q.miss = 0; j.d.id = Q.id; this.touch(Q);
              } else j.d.id = null; // an unknown piece on this spot: it starts as a new candidate
              this.rejects.notHere = (this.rejects.notHere || 0) + 1; this.logEvt('notHere', P.id);
              this.version++; this.matchCache.clear();
            }
            n1++; continue;
          }
          if (j.p.t1 && PH.isCloseRead(j.p.t1) && !nc) {
            // A far read of a piece with a close shape: never mixed in (far
            // reads misread tabs and lengths); it may still place the picture.
            j.p.t1Frame = this.fNo;
            const m = PH.samePiece(t1, j.p.t1);
            if (!j.p.rd || j.p.rd.stale) this.notePlacement(j.p, m.ok ? { thumb: t1.thumb, corners: [0, 1, 2, 3].map((k) => t1.corners[(k - m.r + 4) % 4]) } : { thumb: t1.thumb, corners: t1.corners, sigs: t1.edges.map((e) => e.sig) });
            n1++; continue;
          }
          if (j.p.t1 && !PH.isCloseRead(j.p.t1) && nc) this.uncalibrate(j.p.t1); // the first close read replaces a far one (below)
          else if (j.p.t1) {
            const old = j.p.t1;
            j.p.t1Frame = this.fNo;
            let m = PH.samePiece(t1, old);
            // (a piece linked to this spot only needs its shape to agree)
            if (!m.ok) { const sa = PH.shapeAgree(t1, old); if (sa) m = { ok: true, r: sa.r, d: sa.d }; }
            if (m.ok) { // two views agree: the shape is confirmed (averaged)
              if ((old.nObs || 1) < 8) PH.fuseShapes(old, t1, m.r);
              this.noteCloseAgree(j.p, t1);
              // No map placement yet (moved, or catalogued before v0.10.1):
              // place it from this read, with this read's picture - the stored
              // one may come from another view (e.g. a photo, at a different
              // pixel scale). Corners re-ordered to the stored edges' order.
              if (!j.p.rd || j.p.rd.stale) this.notePlacement(j.p, { thumb: t1.thumb, corners: [0, 1, 2, 3].map((k) => t1.corners[(k - m.r + 4) % 4]) });
              this.touch(j.p); this.version++; n1++;
              continue;
            }
            // They disagree: keep the better-quality read.
            j.p.conflicts = (j.p.conflicts || 0) + 1;
            // (a more central view counts a little more: less side wall, less distortion)
            const cw = (t) => 0.85 + 0.3 * (t.centre === undefined ? 0.5 : t.centre);
            const qn = (t1.quality ? t1.quality.q : 0) * cw(t1), qo = (old.quality ? old.quality.q : 0) * cw(old);
            if (qn <= qo * 1.15) {
              // the stored shape stays; the map still needs this view's picture
              if (!j.p.rd || j.p.rd.stale) this.notePlacement(j.p, { thumb: t1.thumb, corners: t1.corners, sigs: t1.edges.map((e) => e.sig) });
              n1++; continue;
            }
            this.uncalibrate(old);
          }
          // First shape of a new entry: enough detail for this distance, and
          // not a catalogued piece that moved (verifyNew).
          if (!j.p.t1) {
            const v = this.verifyNew(j.p, j.d, t1, dets);
            if (v === 'wait') continue;
            if (v === 'merged') { n1++; continue; }
          }
          j.p.t1 = t1;
          j.p.t1Frame = this.fNo;
          j.p.t1Fail = 0;
          j.p.closeAgree = nc ? 1 : 0; j.p.closeAgreeF = this.fNo;
          this.notePlacement(j.p);
          j.p.t2 = null;
          this.calibrate(t1);
          this.touch(j.p);
          this.version++;
          n1++;
        }
      }
      if (this.box) {
        // Visible pieces first, then the backlog.
        const order = [];
        // (a detection's entry may have been merged away meanwhile: follow it)
        for (const d of dets) if (d.id) { const p = this.pieces.get(this.finalId(d.id)); if (p) order.push(p); }
        for (const p of this.pieces.values()) order.push(p);
        const done = new Set();
        const cal = this.calibStats();
        for (const p of order) {
          if (!p || done.has(p.id) || !p.t1 || p.t2) continue;
          done.add(p.id);
          if (n2 >= 2 && now() > deadline) break;
          p.t2 = PH.placePiece(this.box, p.t1, cal) || { cands: [], conf: 0, failed: true };
          this.cellsDirty = true;
          this.touch(p);
          n2++;
        }
      }
      return { t1: n1, t2: n2 };
    }

    calibrate(t1, sign) {
      sign = sign || 1;
      const { lab, mask } = t1.square;
      let n = 0, s = 0, ss = 0;
      for (let p = 0; p < mask.length; p++) if (mask[p]) { const L = lab[3 * p]; s += L; ss += L * L; n++; }
      if (!n) return;
      this.calib.n += sign;
      this.calib.sL += (sign * s) / n;
      this.calib.sLL += (sign * ss) / n;
    }
    uncalibrate(t1) { this.calibrate(t1, -1); }

    // ---------- the marked border: the puzzle's real place on the table ----------
    /**
     * Mark the finished border: `corners` = its 4 outer corners in the camera
     * frame `source` (camera pixels), clockwise from the box picture's
     * top-left. Analysed in the same (straightened) view as live frames.
     */
    setPuzzleFrame(source, info, corners) {
      if (!this.box) return { ok: false, why: 'Add the box picture first.' };
      const st = this.straighten(source, info || {});
      const proc = st.source.getProc(this.opts.procW);
      const pts = corners.map(([x, y]) => {
        const p = st.rect ? PH.applyH(st.rect.H, x, y) : [x, y];
        return [p[0] * proc.scale, p[1] * proc.scale];
      });
      this.pframe = new PH.PuzzleFrame(proc, pts, this.box.cols, this.box.rows);
      if (this.pframe.feat.n < 60) { this.pframe = null; return { ok: false, why: 'Too little detail in that view to recognise the table again.' }; }
      // t: 0 = look for it again on the very next live frame (the phone moves on)
      this.pfLoc = { H: this.pframe.Hbox, t: 0, fNo: this.fNo || 0, w: proc.w, h: proc.h, inliers: this.pframe.feat.n };
      return { ok: true, features: this.pframe.feat.n };
    }
    clearPuzzleFrame() { this.pframe = null; this.pfLoc = null; this.pfViewH = null; }
    /** No border marked yet: look for the finished border in a steady view
     *  (js/vision/border.js) - a small copy of the view (480 px: ~0.1 s on a
     *  PC), at most every 4 s, backing off to 30 s while it isn't found.
     *  Found: marked exactly as if its 4 corners had been tapped. */
    autoBorder(proc, seg) {
      if (this.opts.autoBorder === false || !PH.findBorderQuad) return;
      const wait = Math.min(30000, 4000 * 2 ** (this.borderFails || 0));
      if (this.borderAt !== undefined && now() - this.borderAt < wait) return; // (the first try right away)
      if (this.lastSharp && this.lastSharp.sh < this.lastSharp.ref * 0.6) return; // a blurred view
      this.borderAt = now();
      const cv = PH.cv, k = Math.min(1, 480 / Math.max(proc.w, proc.h));
      let small = proc;
      if (k < 1) {
        const a = new cv.Mat(proc.h, proc.w, cv.CV_8UC4); a.data.set(proc.data);
        const b = new cv.Mat(); cv.resize(a, b, new cv.Size(Math.round(proc.w * k), Math.round(proc.h * k)), 0, 0, cv.INTER_AREA);
        small = { w: b.cols, h: b.rows, data: new Uint8ClampedArray(b.data) };
        a.delete(); b.delete();
      }
      const dbgQ = PH.DEBUG_BORDER ? {} : null;
      const q = PH.findBorderQuad(small, this.box, dbgQ);
      if (dbgQ) PH.DEBUG_BORDER('autoBorder', small.w, small.h, q ? 'found ' + q.score.toFixed(2) : dbgQ.why);
      if (!q) { this.borderFails = Math.min(3, (this.borderFails || 0) + 1); return; }
      const corners = q.corners.map(([x, y]) => [x / k, y / k]);
      const pf = new PH.PuzzleFrame(proc, corners, this.box.cols, this.box.rows);
      if (PH.DEBUG_BORDER) PH.DEBUG_BORDER('features', pf.feat.n);
      if (pf.feat.n < 60) { this.borderFails = Math.min(3, (this.borderFails || 0) + 1); return; }
      // A finished border is a closed ring of pieces carrying the box's print
      // along its edge cells; loose pieces laid out in a grid are mostly bare
      // board there (owner's 50-piece video, v0.19.0: a "border" over a jar
      // lid and loose pieces). Most visible edge cells must read as filled.
      if (PH.readCells) {
        const r = PH.readCells(proc, pf.Hbox, this.box), { cols, rows } = this.box;
        let vis = 0, fil = 0;
        for (let c = 0; c < cols; c++) for (let rr = 0; rr < rows; rr++) {
          if (c > 0 && c < cols - 1 && rr > 0 && rr < rows - 1) continue;
          const v = r.cells[rr * cols + c];
          if (v) { vis++; if (v > 0) fil++; }
        }
        if (PH.DEBUG_BORDER) PH.DEBUG_BORDER('edge cells', fil, '/', vis);
        if (vis < 8 || fil < vis * 0.7) { this.rejects.borderNotFilled = (this.rejects.borderNotFilled || 0) + 1; this.borderFails = Math.min(3, (this.borderFails || 0) + 1); return; }
      }
      this.pframe = pf;
      this.pfLoc = { H: pf.Hbox, t: now(), fNo: this.fNo || 0, w: proc.w, h: proc.h, inliers: pf.feat.n, pose: this.pose ? Object.assign({}, this.pose) : null, island: this.island };
      this.borderFails = 0;
      this.borderFoundNow = true; // the page says so
      this.pframeDirty = true;    // the worker saves it
      this.voteCells(proc, seg);
    }
    /** Read the puzzle cell by cell in this view (the border just found
     *  again here) and add a vote per visible cell. */
    voteCells(proc, seg) {
      if (!this.box || !PH.readCells || !this.pfLoc || !this.pfLoc.H) return;
      // only sharp views: a blurred one reads every printed cell as "open"
      const sh = this.frameSharpness(seg.lab, proc.w, proc.h);
      const hist = this.sharpHist || (this.sharpHist = []);
      hist.push(sh); if (hist.length > 40) hist.shift();
      const ref = hist.slice().sort((a, b) => a - b)[Math.floor(hist.length * 0.75)];
      this.lastSharp = { sh: +sh.toFixed(1), ref: +ref.toFixed(1) };
      if (hist.length >= 5 && sh < ref * 0.6) { this.rejects.blurView = (this.rejects.blurView || 0) + 1; return; }
      const n = this.box.cols * this.box.rows;
      if (!this.cellVotes || this.cellVotes.f.length !== n) this.cellVotes = { f: new Uint16Array(n), o: new Uint16Array(n), views: 0 };
      const V = this.cellVotes, r = PH.readCells(proc, this.pfLoc.H, this.box);
      for (let i = 0; i < n; i++) {
        if (r.cells[i] > 0) V.f[i]++; else if (r.cells[i] < 0) V.o[i]++;
        if (V.f[i] + V.o[i] > 40) { V.f[i] >>= 1; V.o[i] >>= 1; } // later views (pieces added since) still count
      }
      V.views++;
      this.cellVotesV = (this.cellVotesV || 0) + 1;
      this.cellVotesDirty = true;
    }
    /** A box cell by its votes: 1 a piece is in place, -1 open, 0 not known.
     *  Open needs 2+ open readings and twice as many as filled ones. */
    cellState(i) {
      const V = this.cellVotes;
      if (!V) return 0;
      const f = V.f[i], o = V.o[i];
      if (o >= 2 && o > 2 * f) return -1;
      if (f >= 1 && f >= o) return 1;
      return 0;
    }
    /** Open cells of the marked puzzle: [{col, row, n (pieces around it)}]. */
    cellSpots() {
      if (!this.cellVotes || !this.box) return [];
      const { cols, rows } = this.box, out = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (this.cellState(r * cols + c) !== -1) continue;
        let n = 0;
        for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const cc = c + dc, rr = r + dr;
          if (cc >= 0 && rr >= 0 && cc < cols && rr < rows && this.cellState(rr * cols + cc) === 1) n++;
        }
        out.push({ col: c, row: r, n });
      }
      return out;
    }
    /** Box cells the votes call filled. */
    cellFilledSet() {
      const out = new Set();
      if (!this.cellVotes) return out;
      for (let i = 0; i < this.cellVotes.f.length; i++) if (this.cellState(i) === 1) out.add(i);
      return out;
    }
    exportCellVotes() { const V = this.cellVotes; return V ? { f: Array.from(V.f), o: Array.from(V.o), views: V.views, cols: this.box && this.box.cols, rows: this.box && this.box.rows } : null; }
    importCellVotes(o) {
      this.cellVotes = o && this.box && o.cols === this.box.cols && o.rows === this.box.rows ? { f: Uint16Array.from(o.f), o: Uint16Array.from(o.o), views: o.views || 0 } : null;
      this.cellVotesV = (this.cellVotesV || 0) + 1;
    }
    // Re-find the marked border in this view, at most every frameEveryMs
    // (ORB matching is ~60-90 ms on a PC). Returns true when found now.
    findPuzzleFrame(proc) {
      if (!this.pframe) return false;
      const t = now();
      if (this.pfLoc && t - this.pfLoc.t < (this.opts.frameEveryMs || 700)) return false;
      const loc = this.pframe.locate(proc);
      this.pfMs = now() - t;
      this.pfTries = (this.pfTries || 0) + 1;
      if (!loc) { if (this.pfLoc) this.pfLoc.t = t; else this.pfLoc = { H: null, t }; return false; }
      this.pfFound = (this.pfFound || 0) + 1;
      this.pfLoc = { H: loc.H, t, fNo: this.fNo || 0, w: proc.w, h: proc.h, inliers: loc.inliers, pose: null, island: null };
      return true;
    }
    /** Where the border is in this view (proc px) for the page, plus the
     *  selected piece's (or region's) target spot inside it. Between ORB fixes
     *  the last fix is carried along with the table map's camera pose. */
    puzzleFrameOut(proc, foundNow) {
      const L = this.pfLoc;
      this.pfViewH = null;
      if (!this.pframe || !L || !L.H || L.w !== proc.w) return this.pframe ? { marked: true, visible: false } : null;
      let H = null;
      if (foundNow) { H = L.H; if (this.pose) { L.pose = Object.assign({}, this.pose); L.island = this.island; } }
      else if (L.pose && this.pose && L.island === this.island) {
        // box -> fix view -> table -> this view
        const S = (T) => [T.a, -T.b, T.tx, T.b, T.a, T.ty, 0, 0, 1];
        H = PH.homMul(S(PH.simInvert(this.pose)), PH.homMul(S(L.pose), L.H));
      } else if ((this.fNo || 0) - L.fNo <= 2) H = L.H; // just found: the page's motion tracker covers the rest
      this.pfViewH = H;
      if (!H) return { marked: true, visible: false };
      const { cols, rows } = this.pframe;
      const out = { marked: true, visible: true, quad: PH.PuzzleFrame.cellQuad(H, 0, 0, cols, rows), cols, rows };
      const sel = this.selection && this.pieces.get(this.selection.id);
      if (sel && sel.t2 && sel.t2.cands.length && sel.t2.conf >= 0.15) {
        const c = sel.t2.cands[0];
        out.target = { quad: PH.PuzzleFrame.cellQuad(H, c.col, c.row), col: c.col, row: c.row, conf: sel.t2.conf };
      } else if (this.region) {
        const R = this.region;
        out.target = { quad: PH.PuzzleFrame.cellQuad(H, R.c0, R.r0, R.c1 - R.c0 + 1, R.r1 - R.r0 + 1) };
      }
      return out;
    }

    // ---------- "In puzzle": pieces the owner has physically placed ----------
    /** Box cells held by pieces marked in the puzzle: 'col,row' -> piece id. */
    takenCells() {
      const m = new Map();
      for (const p of this.pieces.values()) {
        if (!p.inPuzzle || !p.t2) continue;
        const c = (p.t2.orig || p.t2).cands[0];
        if (c && (p.t2.orig || p.t2).conf >= 0.35) m.set(c.col + ',' + c.row, p.id);
      }
      return m;
    }
    /** Box cell rules over the whole catalog, from each piece's own placement
     *  (kept in t2.orig when changed, so this can always be redone):
     *  - cells held by pieces marked in the puzzle are out (Piece Finder's
     *    "mark as placed");
     *  - one piece per cell: a joint assignment (PH.assignCells) puts each
     *    piece in its best cell that no better-fitting piece needs. A piece
     *    that loses its first choice keeps the rest of its list, with its
     *    confidence recomputed (often "several spots look alike").
     *  Cheap (sparse auction); run after placements change (cellsDirty). */
    assignCellsNow() {
      this.cellsDirty = false;
      this.cellsAt = now();
      const taken = this.takenCells();
      const items = [];
      for (const p of this.pieces.values()) {
        if (!p.t2 || p.t2.failed || !this.isChecked(p)) continue;
        const base = p.t2.orig || p.t2;
        if (p.inPuzzle) { if (p.t2 !== base) { p.t2 = base; this.touch(p); } continue; }
        const cands = base.cands.filter((c) => { const id = taken.get(c.col + ',' + c.row); return !id || id === p.id; });
        items.push({ p, base, cands });
      }
      const keyOf = (c) => c.col + ',' + c.row;
      const res = PH.assignCells(items.map((it) => it.cands.map((c) => ({ key: keyOf(c), score: c.score }))),
        items.map((it) => (it.cands.length ? it.cands[it.cands.length - 1].score + 0.5 : 0)));
      let changed = 0;
      items.forEach((it, i) => {
        const { p, base } = it;
        let cands = it.cands;
        const k = res[i], at = k ? cands.findIndex((c) => keyOf(c) === k) : -1;
        if (at > 0) cands = [cands[at], ...cands.slice(0, at), ...cands.slice(at + 1)];
        let t2 = base;
        if (cands.length !== base.cands.length || at > 0) {
          if (!cands.length) t2 = { cands: [], conf: 0, tex: base.tex, orig: base };
          else {
            const s1 = cands[0].score, other = cands.find((s) => Math.abs(s.col - cands[0].col) + Math.abs(s.row - cands[0].row) > 1);
            // lost its first choice to a better-fitting piece: never surer than before
            const conf = Math.min(base.conf, other ? PH.clamp((other.score - s1) / 0.25, 0, 1) : 0.5);
            t2 = { cands, conf, tex: base.tex, orig: base };
          }
        }
        const was = p.t2 && p.t2.cands[0], now0 = t2.cands[0];
        if (p.t2 !== t2 && (!was !== !now0 || (was && now0 && keyOf(was) !== keyOf(now0)) || p.t2.cands.length !== t2.cands.length)) changed++;
        if (p.t2 !== t2) { p.t2 = t2; this.touch(p); }
      });
      if (changed) this.version++;
      return changed;
    }
    /** Mark (or un-mark) a piece as physically in the puzzle. Its box cell
     *  leaves every other piece's candidates, Border and the finders skip it,
     *  and Matches skips pairs of two placed pieces. */
    setInPuzzle(id, on) {
      const P = this.pieces.get(id);
      if (!P) return false;
      P.inPuzzle = on ? Date.now() : 0;
      this.assignCellsNow();
      this.touch(P);
      this.version++;
      return true;
    }

    setBox(box) {
      this.clearPuzzleFrame(); // the mark is in the old box's grid
      this.box = box;
      if (box && box.lab && PH.boxColTol) PH.colTol = box.colT = box.colT || PH.boxColTol(box); // this puzzle's colour tolerance along seams
      for (const p of this.pieces.values()) { p.t2 = null; this.touch(p); }
      for (const A of this.asms || []) { A.place = null; A.placeAt = -1e9; A.version++; A.locate(box, true); } // placed again on the new grid
      this.cellVotes = null; this.cellVotesDirty = true; // cell votes are on the old grid
      this.asmDirty = true;
      this.version++;
    }
    /** Assemblies for saving (and back). */
    exportAsms() { return (this.asms || []).map((A) => A.toJSON()); }
    importAsms(list) {
      this.asms = PH.Assembly && Array.isArray(list) ? list.map((o) => PH.Assembly.fromJSON(o)) : [];
      this.nextAsm = this.asms.reduce((m, A) => Math.max(m, A.id), 0);
      this.asmLast = null; this.asmDirty = false;
    }

    // ---------- matching / selection ----------
    skipFn() {
      // judged wrong, or both already in the puzzle (nothing left to find there)
      return (P, Q) => P.wrong.includes(Q.id) || (!!P.inPuzzle && !!Q.inPuzzle);
    }
    /** Which of P's edges is its top in the finished puzzle (box placement:
     *  edge k faces box side (k + rot) % 4, 0 = top), and that edge's outward
     *  direction on the table map (table units) when its read placement
     *  allows (not after the piece moved). null without a confident spot. */
    /** Frame chain: for a border piece, the next border piece along the frame
     *  on each side - the best candidate on an edge next to its flat edge that
     *  is itself a border piece with its flat edge on the same side (frame
     *  first, as in Zolver / pondruska's FrameSolver). Joining P's edge f+1 to
     *  Q's edge m puts Q's flat at m+1 (and f-1 / m-1). */
    chainFor(P, res) {
      if (!P.t1 || !res) return [];
      const E = P.t1.edges, out = [];
      for (let f = 0; f < 4; f++) {
        if (E[f].type !== 'F' || E[f].unc) continue;
        for (const s of [1, 3]) {
          const k = (f + s) % 4;
          if (E[k].type === 'F' || !res[k] || P.joined[k]) continue;
          const m = res[k].matches.find((c) => { const Q = this.pieces.get(c.id); const g = Q && Q.t1 && Q.t1.edges[(c.edge + s) % 4]; return g && g.type === 'F' && !g.unc; });
          if (m) out.push({ edge: k, id: m.id, edgeB: m.edge, prob: m.prob, verdict: m.verdict, rank: res[k].matches.indexOf(m) + 1 });
        }
      }
      return out;
    }
    upOf(P) {
      const t2 = P.t2;
      if (!P.t1 || !t2 || !t2.cands.length || t2.conf < 0.35) return null;
      const k = (4 - (t2.cands[0].rot % 4)) % 4;
      let vt = null;
      const r = P.rd;
      if (r && !r.stale && !(P.pic && P.pic.sigs)) {
        const c = (P.pic && P.pic.corners) || P.t1.corners;
        const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
        const vx = (c[k][0] + c[(k + 1) % 4][0]) / 2 - cx, vy = (c[k][1] + c[(k + 1) % 4][1]) / 2 - cy;
        vt = [r.a * vx - r.b * vy, r.b * vx + r.a * vy];
      }
      return { k, vt };
    }
    // opts.loops: also run the 2x2 loop check (~30 ms; done for the selected piece).
    // Probabilities are calibrated (calibrateMatches); candidates are ordered
    // by that probability.
    matchesFor(id, opts) {
      const P = this.pieces.get(id);
      if (!P || !P.t1 || !this.isChecked(P)) return null;
      const c = this.matchCache.get(id);
      if (c && c.version === this.version && (c.loops || !(opts && opts.loops))) return c.res;
      const all = this.checkedPieces(); // matches only between checked pieces (close, agreeing reads)
      const res = PH.findMatches(P, all, { topN: 5, skip: this.skipFn(), nullOdds: (k) => this.nullOdds(P, k).odds });
      for (const r of res) r.spot = this.nullOdds(P, r.edge).spot;
      if (opts && opts.loops) PH.confirmWithLoops(res, PH.findLoops(P, all, { K: 6, skip: this.skipFn() }));
      for (const r of res) if (P.joined[r.edge]) r.matches = [];
      this.calibrateMatches(P, res, all);
      this.matchCache.set(id, { version: this.version, res, loops: !!(opts && opts.loops) });
      return res;
    }
    // Q's best partner on edge e (cached per catalog version).
    bestOf(Q, e, all) {
      // Q's own matches already worked out for this catalog version: its top one.
      const mc = this.matchCache.get(Q.id);
      if (mc && mc.version === this.version && mc.res[e]) { const t = mc.res[e].matches[0]; return t ? { id: t.id, edge: t.edge, score: t.score } : null; }
      const key = Q.id + ':' + e, c = this.bestCache.get(key);
      if (c && c.v === this.version) return c.best;
      const best = PH.bestPartner(Q, e, all || this.pieces.values(), this.skipFn());
      this.bestCache.set(key, { v: this.version, best });
      if (this.bestCache.size > 8000) this.bestCache.clear();
      return best;
    }
    /** Calibrated probability per candidate (see PH.CALIB_FEATURES): the
     *  softmax probability plus the consistency evidence - lead over the
     *  runner-up, mutual best, closed 2x2 loop, both shapes confirmed, box
     *  agreement - through the logistic model. Candidates of one edge exclude
     *  each other, so their probabilities are capped to sum to at most 1. */
    calibrateMatches(P, res, all) {
      const w = this.calibW || PH.CALIB_PRIOR;
      const confP = shapeConfirmed(P);
      for (const r of res) {
        const L = r.matches;
        if (!L.length) continue;
        L.forEach((m, i) => {
          const Q = this.pieces.get(m.id);
          const lead = i === 0 ? (L[1] ? L[1].score - m.score : 1) : L[0].score - m.score;
          // mutual best: worth checking only for candidates with a real chance
          let mutual = false;
          if (i < 2 && (m.pSoft || 0) >= 0.15) {
            const back = this.bestOf(Q, m.edge, all);
            mutual = !!back && back.id === P.id && back.edge === r.edge;
          }
          m.mutual = mutual;
          m.x = PH.candFeatures({ pSoft: m.pSoft, lead, mutual, loop: m.loopOk, loops: m.loops || 0, confirmed: confP && shapeConfirmed(Q), adj: m.adj,
            unsure: P.t1.edges[r.edge].type === 'F' || Q.t1.edges[m.edge].type === 'F' });
          m.prob = PH.calibProb(w, m.x);
        });
        const sum = L.reduce((s, m) => s + m.prob, 0);
        if (sum > 1) for (const m of L) m.prob /= sum;
        L.sort((a, b) => b.prob - a.prob);
        L.forEach((m, i) => (m.verdict = PH.matchVerdict(m, L[i + 1])));
      }
    }
    /** Refit the match-probability model on the answer key: every Fits/No
     *  answer that recorded its features. Needs a few of each before it moves
     *  (and stays pulled toward the synthetic prior while answers are few). */
    refitCalib() {
      const S = (this.fbLog || []).filter((e) => Array.isArray(e.x) && e.x.length === PH.CALIB_PRIOR.length).map((e) => ({ x: e.x, y: e.kind === 'joined' ? 1 : 0 }));
      const fits = S.filter((s) => s.y).length;
      this.calibN = S.length;
      this.calibW = S.length >= 12 && fits >= 3 && S.length - fits >= 3 ? PH.fitCalib(S, PH.CALIB_PRIOR, 6) : null;
      this.version++;
    }
    /**
     * Prior odds that piece P's partner on edge k has NOT been scanned yet.
     * Partial sets: with 400 of 1000 pieces catalogued, most partners simply
     * aren't on the table. The box picture sharpens this: if P is placed on
     * the box, its neighbor's cell is known; when no catalogued piece is
     * placed there, the partner almost certainly isn't scanned (and `spot`
     * says where in the picture it comes from).
     */
    nullOdds(P, k) {
      const total = this.box ? this.box.cols * this.box.rows : this.opts.totalPieces || 1000;
      const cov = PH.clamp((this.nChecked === undefined ? this.pieces.size : this.nChecked) / total, 0.02, 1);
      let odds = Math.max(0.2, (1 - cov) / cov);
      let spot = null;
      const t2 = P.t2;
      if (this.box && t2 && t2.cands.length && t2.conf >= 0.4) {
        const A = t2.cands[0], side = (k + A.rot) % 4;
        const D = [[0, -1], [1, 0], [0, 1], [-1, 0]][side];
        const col = A.col + D[0], row = A.row + D[1];
        if (col < 0 || row < 0 || col >= this.box.cols || row >= this.box.rows) return { odds: 0.01, spot: null };
        let near = 0;
        for (const q of this.pieces.values()) {
          if (q === P || !q.t2 || !q.t2.cands.length || q.t2.conf < 0.3) continue;
          const c = q.t2.cands[0];
          if (c.col === col && c.row === row) near++;
        }
        odds *= near ? 0.5 : 10; // box placement is right ~86-93% of the time
        spot = { col, row, scanned: near > 0 };
      }
      return { odds: PH.clamp(odds, 0.05, 50), spot };
    }

    select(id) {
      if (!id) { this.selection = null; return null; }
      const P = this.pieces.get(id);
      if (!P || !this.isChecked(P)) return null; // not checked yet: only its "scan closer" ring shows
      this.selection = { id };
      this.region = null;
      this.filter = null;
      this.pairSel = null;
      return this.describe(id);
    }
    /** The assembled part's open spot that piece P's box cell is, if any:
     *  {col, row, n (pieces around it), fit (its edges agree with the spot's needs)}. */
    asmSpotOf(P) {
      if (!this.box || !P.t2 || !P.t2.cands.length || P.t2.conf < 0.2 || !P.t1) return null;
      const c = P.t2.cands[0];
      if (this.pframe && this.cellVotes) {
        const sp = this.cellSpots().find((x) => x.col === c.col && x.row === c.row);
        return sp ? { col: c.col, row: c.row, n: sp.n, fit: true } : null;
      }
      for (const A of this.asms || []) {
        if (!A.place) continue;
        const sp = A.spots(this.box).find((x) => x.cell && x.cell[0] === c.col && x.cell[1] === c.row);
        if (!sp) continue;
        const need = ['?', '?', '?', '?'];
        sp.need.forEach((t, d) => (need[(d + A.place.k) % 4] = t));
        const fit = this.spotPieces(c.col, c.row, need, 12).some((x) => x.id === P.id);
        return { col: c.col, row: c.row, n: sp.n, fit };
      }
      return null;
    }
    // Everything the UI panel needs about a piece and its candidate partners.
    describe(id) {
      const P = this.pieces.get(id);
      const res = this.matchesFor(id, { loops: true });
      const brief = (Q) => ({ id: Q.id, code: Q.t1 ? Q.t1.code : null, thumb: Q.t1 ? Q.t1.thumb : null, corners: Q.t1 ? Q.t1.corners : null, sigs: Q.t1 ? Q.t1.edges.map((e) => e.sig) : null, t2: Q.t2 ? { cands: Q.t2.cands.slice(0, 3), conf: Q.t2.conf, tex: Q.t2.tex } : null, located: !!Q.pos && !Q.gone, gone: !!Q.gone,
        inPuzzle: !!Q.inPuzzle, up: (this.upOf(Q) || {}).k,
        confirmed: shapeConfirmed(Q), views: Q.t1 ? Q.t1.nObs || 1 : 0, quality: Q.t1 && Q.t1.quality ? Q.t1.quality.q : null, unc: Q.t1 ? Q.t1.edges.map((e) => !!e.unc) : null });
      return {
        piece: brief(P),
        spot: this.asmSpotOf(P),
        chain: this.chainFor(P, res),
        status: !P.t1 ? 'Hold steady over this piece to read its shape' : null,
        edges: res ? res.map((r) => ({ edge: r.edge, type: r.type, unc: !!(P.t1.edges[r.edge] && P.t1.edges[r.edge].unc), joined: P.joined[r.edge], loop: r.loop, pNone: r.pNone, spot: r.spot, matches: r.matches.map((m) => Object.assign(brief(this.pieces.get(m.id)), { edgeB: m.edge, score: m.score, prob: m.prob, loopOk: !!m.loopOk, loops: m.loops || 0, mutual: !!m.mutual, verdict: m.verdict, shape: m.shape, color: m.color, adj: m.adj, tie: !!m.tie, colOk: m.colOk, colShare: m.colShare === undefined ? null : +m.colShare.toFixed(2), colDoubt: m.colDoubt || null, sure: PH.sureFit(m, 0) && m === r.matches[0] })) })) : [],
      };
    }
    /** "Fill this spot" (a cheaper stand-in for PuzPal's gap scan): rank the
     *  loose pieces for one box cell by how well their print matches it (their
     *  own placement score there, any rotation) and how well their edges fit
     *  the pieces already around it - marked in the puzzle, or confidently
     *  placed on a neighbouring cell - each in the rotation the cell implies.
     *  Late in a puzzle the pool is small and shape decides. */
    fillSpot(col, row, topN) {
      const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const nb = [];
      for (const q of this.pieces.values()) {
        if (!q.t1 || !q.t2 || !q.t2.cands.length || !this.isChecked(q)) continue;
        const c = q.t2.cands[0];
        if (!q.inPuzzle && q.t2.conf < 0.35) continue;
        for (let d = 0; d < 4; d++) if (c.col === col + D[d][0] && c.row === row + D[d][1]) nb.push({ q, d, rot: c.rot });
      }
      const nbRes = new Map(nb.map((n) => [n.q.id, this.matchesFor(n.q.id)]));
      const out = [];
      for (const p of this.pieces.values()) {
        if (!p.t1 || p.inPuzzle || !this.isChecked(p) || p.gone) continue;
        const base = p.t2 ? p.t2.orig || p.t2 : null;
        const own = base ? base.cands.filter((c) => c.col === col && c.row === row) : [];
        // print: how much worse this cell is than the piece's own best spot
        // (raw placement scores carry a per-piece texture offset, so only
        // differences within one piece compare); unlisted = worse than its list
        const s0 = base && base.cands.length ? base.cands[0].score : 0;
        const worst = base && base.cands.length ? base.cands[base.cands.length - 1].score - s0 + 0.3 : 1;
        const rots = own.length ? own.map((c) => ({ rot: c.rot, print: c.score - s0 })) : [0, 1, 2, 3].map((rot) => ({ rot, print: worst }));
        let best = null;
        for (const { rot, print } of rots) {
          // fit: how likely p is each neighbour's partner on the edge facing
          // the spot (its calibrated match list; not listed = 1%)
          let fit = 0, ok = 0;
          for (const n of nb) {
            if (n.q === p) continue;
            const k = (n.d - rot + 8) % 4, e = (n.d + 2 - n.rot + 8) % 4; // p's edge toward n, n's edge back
            const lst = nbRes.get(n.q.id), r = lst && lst[e];
            const m = r && r.matches.find((x) => x.id === p.id && x.edge === k);
            const pr = m ? Math.max(0.01, m.prob) : 0.01;
            fit -= Math.log(pr); if (pr >= 0.5) ok++;
          }
          const score = print + (nb.length ? (PH.FILL_FIT * fit) / nb.length : 0);
          if (!best || score < best.score) best = { id: p.id, score, rot, print: own.length > 0, fits: ok, of: nb.length };
        }
        out.push(best);
      }
      out.sort((a, b) => a.score - b.score);
      return { col, row, neighbours: nb.length, cands: out.slice(0, topN || 8) };
    }
    selectRegion(c0, r0, c1, r1) {
      this.selection = null;
      const ids = [];
      for (const p of this.pieces.values()) {
        if (!p.t2 || !p.t2.cands.length || !this.isChecked(p) || p.gone) continue;
        const k = p.t2.cands[0];
        if (k.col >= c0 && k.col <= c1 && k.row >= r0 && k.row <= r1 && p.t2.conf >= 0.15) ids.push(p.id);
      }
      this.region = { c0, r0, c1, r1, ids: new Set(ids) };
      return ids.length;
    }
    /** Highlight a whole class of pieces at once, with no box picture needed.
     *  'border' = at least one straight edge, 'corner' = two straight edges
     *  meeting, 'edges' = both of those (the toolbar's Edges button: the whole
     *  frame of the puzzle, corners and edge pieces in their own colours),
     *  'unplaced' = shape read but not found on the box picture,
     *  'unread' = seen but its shape hasn't been read yet. */
    setFilter(kind) {
      this.filter = kind || null;
      this.selection = null;
      this.region = null;
      this.pairSel = null;
      return this.filterIds().length;
    }
    filterIds() {
      if (!this.filter) return [];
      // The assembled border is complete (js/vision/assembly.js): no loose
      // piece can be a border piece any more; anything with a straight side
      // is a misread (owner, 2026-10-04).
      const asm = this.assemblyInfo();
      if (asm && asm.border && asm.border.done >= asm.border.total && ['corner', 'border', 'edges'].includes(this.filter)) return [];
      // "Need closer look": where entries still wait to be checked (their
      // amber rings), so the owner knows where to sweep up close.
      if (this.filter === 'unread') return [...this.pieces.values()].filter((p) => !this.isChecked(p) && p.pos && !p.gone && p.island === this.island).map((p) => p.id);
      const out = [];
      const doubt = this.filter === 'corner' || this.filter === 'edges' ? this.cornerDoubts() : null;
      for (const p of this.pieces.values()) {
        if (p.inPuzzle || !this.isChecked(p) || p.gone) continue; // placed pieces are done; unchecked / moved ones aren't shown
        const f = edgeFlags(p);
        const hit = this.filter === 'corner' ? f.corner && !doubt.has(p.id)
          : this.filter === 'edges' ? (f.corner && !doubt.has(p.id)) || (f.border && !f.corner)
          : this.filter === 'border' ? f.border && !f.corner
            : this.filter === 'unplaced' ? !!p.t1 && !(p.t2 && p.t2.conf >= 0.35)
              : this.filter === 'unread' ? !p.t1
                : this.filter === 'zones' ? !!this.box && !!p.t2 && p.t2.cands.length > 0 && p.t2.conf >= 0.2
                  : false;
        if (hit) out.push(p.id);
      }
      return out;
    }

    /** Every confident pair in the catalog, strongest first — "show me any
     *  matches you have" with no piece selected and no box picture.
     *  A pair is kept when each piece's best partner on that edge is the other
     *  piece (mutual best) and the probability clears `minProb`.
     *
     *  Matching is O(pieces^2), so this runs against a time budget and is
     *  resumable: call again with the returned `from` to continue. The per
     *  piece results land in matchCache, so a second pass over the same
     *  catalog version is nearly free.
     */
    scanPairs(opts) {
      opts = opts || {};
      const minProb = opts.minProb || 0.8;
      const deadline = now() + (opts.budgetMs || 1200);
      const ids = [];
      for (const p of this.pieces.values()) if (p.t1 && this.isChecked(p)) ids.push(p.id);
      ids.sort((a, b) => a - b);
      const from = opts.from || 0;
      let i = from;
      const best = new Map();
      for (; i < ids.length; i++) {
        best.set(ids[i], this.matchesFor(ids[i]));
        if (now() > deadline) { i++; break; }
      }
      const scanned = i;
      // Pair up whatever has been matched so far (both halves must be in the cache).
      const seen = new Set();
      const pairs = [];
      const cached = (id) => { const c = this.matchCache.get(id); return c && c.version === this.version ? c.res : null; };
      for (const id of ids.slice(0, scanned)) {
        const res = cached(id);
        if (!res) continue;
        for (const r of res) {
          const m = r.matches[0];
          if (!m || (m.prob || 0) < minProb) continue;
          const backRes = cached(m.id);
          if (!backRes) continue;
          const back = backRes[m.edge] && backRes[m.edge].matches[0];
          if (!back || back.id !== id || back.edge !== r.edge) continue;
          const key = id < m.id ? id + ':' + m.id : m.id + ':' + id;
          if (seen.has(key)) continue;
          seen.add(key);
          const A = this.pieces.get(id), B = this.pieces.get(m.id);
          pairs.push({
            a: id, b: m.id, edgeA: r.edge, edgeB: m.edge,
            prob: Math.min(m.prob, back.prob || 0),
            loopOk: !!m.loopOk, verdict: m.verdict,
            aLocated: !!A.pos && A.island === this.island,
            bLocated: !!B.pos && B.island === this.island,
          });
        }
      }
      pairs.sort((x, y) => y.prob - x.prob);
      return { pairs, from: scanned, total: ids.length, done: scanned >= ids.length };
    }
    // Highlight one pair from scanPairs on the camera view.
    selectPair(a, b) {
      this.filter = null;
      this.region = null;
      this.selection = null;
      this.pairSel = a && b ? { a, b } : null;
    }

    /** Tidy up's old jobs, now part of housekeeping (no button since v0.20;
     *  owner: "the app should handle itself"):
     *  - scan groups (islands) that hold the same checked pieces - matched by
     *    close-read shape and print - are joined once 3 pieces link them;
     *    a piece found in two groups with fewer links keeps the entry of the
     *    group being scanned now;
     *  - an "edge piece" that can't be one (its box spot is filled in the
     *    assembled part, the assembled border is complete, or its straight
     *    side was seen to be a cut through the assembly) is a chunk of the
     *    assembled puzzle: a checked piece is marked in the puzzle, an
     *    unchecked entry dropped. Never deletes a checked piece. */
    groupsAndEdges() {
      const st = this.hk || (this.hk = { merged: 0, dropped: 0, checked: 0 });
      // 1. join scan groups by shape
      const shaped = this.checkedPieces().filter((p) => p.pos && p.t1 && PH.isCloseRead(p.t1));
      const byIsl = new Map();
      for (const p of shaped) { if (!byIsl.has(p.island)) byIsl.set(p.island, []); byIsl.get(p.island).push(p); }
      const isls = [...byIsl.values()];
      const links = new Map();
      // only pieces of different groups are compared (usually there is one group: nothing to do)
      for (let gi = 0; gi < isls.length; gi++) for (let gj = gi + 1; gj < isls.length; gj++) for (const A of isls[gi]) for (const B of isls[gj]) {
        if (!this.pieces.has(A.id) || !this.pieces.has(B.id)) continue;
        if (!PH.samePiece(A.t1, B.t1, PH.SAME_SHAPE).ok) continue;
        const [P, Q] = A.island < B.island ? [A, B] : [B, A];
        const k = P.island + '>' + Q.island;
        if (!links.has(k)) links.set(k, []);
        links.get(k).push({ src: Q.pos, dst: P.pos, P, Q });
      }
      const unitT = this.unitTable() || 1;
      let joined = 0;
      for (const [k, pairs] of links) {
        const [ia, ib] = k.split('>').map(Number);
        const r = pairs.length >= 3 ? PH.simRansac(pairs, unitT * 1.0, 100, this.rnd) : null;
        if (r && r.inliers.length >= 3) {
          for (const p of this.pieces.values()) if (p.island === ib && p.pos) { this.moveWithGroup(p, r.T); p.island = ia; this.touch(p); }
          if (this.island === ib) { this.island = ia; if (this.pose) this.pose = composeSim(r.T, this.pose); }
          joined++;
        } else {
          for (const { P, Q } of pairs) {
            if (!this.pieces.has(P.id) || !this.pieces.has(Q.id)) continue;
            const here = Q.island === this.island ? Q : P, other = here === Q ? P : Q;
            const keep = this.mergeEntries(here, other);
            if (keep === other) { keep.pos = here.pos; keep.island = here.island; } // the entry stays where the piece is being seen now
            st.merged++;
          }
        }
      }
      // 2. "edge pieces" that are chunks of the assembled puzzle
      let inPuzzle = 0;
      const asm = this.assemblyInfo();
      const borderDone = !!(asm && asm.border && asm.border.done >= asm.border.total);
      const filled = new Set();
      for (const A of this.asms || []) if (A.place) for (const id of A.filledBoxCells(this.box)) filled.add(id);
      for (const id of this.cellFilledSet()) filled.add(id);
      for (const p of [...this.pieces.values()]) {
        if (p.inPuzzle || !p.t1) continue;
        const f = edgeFlags(p);
        if (!f.border && !f.corner && !(p.cutSeen >= 2 && p.t1.flats.some(Boolean))) continue;
        const c = this.box && p.t2 && p.t2.cands.length && p.t2.conf >= 0.35 ? p.t2.cands[0] : null;
        const inFilled = borderDone || (c && filled.has(c.row * this.box.cols + c.col));
        if (!(inFilled || (p.cutSeen || 0) >= 2)) continue;
        // a checked piece only on real evidence that its spot is taken (a cut
        // seen along its side may have been a neighbour lying against it)
        if (this.isChecked(p)) { if (inFilled) { p.inPuzzle = Date.now(); this.touch(p); inPuzzle++; } }
        else { this.removePiece(p.id); st.dropped++; }
      }
      if (joined || inPuzzle) { this.version++; this.matchCache.clear(); }
      return { joined, inPuzzle };
    }
    /** Everything housekeeping does, in full (tests; a saved scan loading). */
    tidy() {
      const before = this.counts();
      const m0 = this.hk ? this.hk.merged + this.hk.dropped : 0;
      this.housekeep(Infinity);
      const r = this.groupsAndEdges();
      this.housekeep(Infinity);
      this.selection = null; this.region = null; this.pairSel = null;
      return { removed: (this.hk.merged + this.hk.dropped) - m0, falseEdges: r.inPuzzle, before, after: this.counts(), joinedIslands: r.joined };
    }

    /** Match accuracy from the answer key: share of judged suggestions that
     *  fit, overall and by the app's own probability, by rank, and by whether
     *  both shapes were confirmed. Well-calibrated: ~70% of the 0.6-0.8
     *  bucket should fit. */
    feedbackStats() {
      const L = this.fbLog || [];
      const bucket = (pr) => (pr === null ? 'not listed' : pr < 0.5 ? '<0.5' : pr < 0.8 ? '0.5-0.8' : pr < 0.95 ? '0.8-0.95' : '>=0.95');
      const add = (o, k, fit) => { const b = o[k] || (o[k] = { n: 0, fits: 0 }); b.n++; if (fit) b.fits++; };
      const out = { judged: L.length, fits: 0, no: 0, byProb: {}, byRank: {}, byConfirmed: {}, loopOk: { n: 0, fits: 0 } };
      for (const e of L) {
        const fit = e.kind === 'joined';
        if (fit) out.fits++; else out.no++;
        add(out.byProb, bucket(e.prob), fit);
        add(out.byRank, e.rank ? (e.rank > 3 ? '4+' : String(e.rank)) : 'not listed', fit);
        add(out.byConfirmed, e.confirmed && e.confirmed[0] && e.confirmed[1] ? 'both' : 'not both', fit);
        if (e.loopOk) { out.loopOk.n++; if (fit) out.loopOk.fits++; }
      }
      out.accuracy = L.length ? +(out.fits / L.length).toFixed(3) : null;
      // the match-probability model: refitted on this many answers (null = synthetic prior)
      out.calib = { n: this.calibN || 0, fitted: !!this.calibW, w: (this.calibW || PH.CALIB_PRIOR).map((v) => +v.toFixed(3)), features: PH.CALIB_FEATURES };
      out.byVerdict = {};
      for (const e of L) if (e.verdict) add(out.byVerdict, e.verdict, e.kind === 'joined');
      return out;
    }
    feedback(f) {
      const A = this.pieces.get(f.a), B = this.pieces.get(f.b);
      if (!A || !B) return;
      // The answer key: what the app claimed about this pair when the owner
      // judged it. Fits/No taps are ground truth, so the log measures match
      // accuracy on the real puzzle, by confidence (see feedbackStats).
      if (f.kind === 'joined' || f.kind === 'wrong') {
        let prob = null, rank = null, loopOk = false, adj = null, x = null, pSoft = null, mutual = false, verdict = null;
        const res = A.t1 ? this.matchesFor(f.a) : null;
        const list = res && res[f.ka] ? res[f.ka].matches : [];
        const i = list.findIndex((m) => m.id === f.b && m.edge === f.kb);
        if (i >= 0) {
          const m = list[i];
          rank = i + 1; prob = +m.prob.toFixed(3); loopOk = !!m.loopOk; adj = +(m.adj || 0).toFixed(2);
          x = m.x ? m.x.map((v) => +v.toFixed(4)) : null; pSoft = m.pSoft !== undefined ? +m.pSoft.toFixed(3) : null; mutual = !!m.mutual; verdict = m.verdict || null;
        }
        this.fbLog.push({ t: Date.now(), kind: f.kind, a: f.a, ka: f.ka, b: f.b, kb: f.kb, prob, rank, loopOk, adj, x, pSoft, mutual, verdict,
          confirmed: [shapeConfirmed(A), shapeConfirmed(B)], q: [A.t1 && A.t1.quality ? A.t1.quality.q : null, B.t1 && B.t1.quality ? B.t1.quality.q : null],
          source: f.source || 'panel' });
        if (this.fbLog.length > 2000) this.fbLog.shift();
        if (x) this.refitCalib();
      }
      if (f.kind === 'wrong') { A.wrong.push(B.id); B.wrong.push(A.id); }
      if (f.kind === 'joined') { A.joined[f.ka] = true; B.joined[f.kb] = true; }
      this.touch(A); this.touch(B);
      this.version++;
    }
    removePiece(id) { if (this.pieces.has(id) && !(this.mergedInto && this.mergedInto.get(id))) this.logEvt('drop', id); this.pieces.delete(id); this.dirty.add(id); this.version++; }

    // ---------- open spots of assembled sections ----------
    /** Every steady view with a big blob (the assembled part) adds to an
     *  Assembly (js/vision/assembly.js): its grid is lined up with what is
     *  known by the overlap and its cells are added in, so following the
     *  border or the block close up builds the whole of it. Each assembly is
     *  put on the box picture as it grows; its open spots are then shown on
     *  the view this frame lined up with. */
    findSpots(dets, seg, proc, still, photo) {
      // Paced on live frames: on the owner's phone this work ran ~140 ms per
      // frame (up to 1.4 s) and the app fell to 2 frames a second (report
      // 22:58). At most every 0.4 s; the previous result stays meanwhile.
      // (and by its own cost: on a phone frames take ~0.5 s, so "every 0.4 s"
      // was every frame - report 2026-10-06: 66 ms a frame on average, spikes
      // to 2 s. After a search that took C ms the next waits >= 4C: at most
      // ~1/5 of the time.)
      const every = this.opts.spotEveryMs === undefined ? Math.max(400, 4 * (this.spotsCost || 0)) : this.opts.spotEveryMs;
      if (!photo && now() - (this.spotsAt || 0) < every) {
        if (!still) this.spotView = null; // a steady view keeps the last spots; a moving one drops them
        return;
      }
      this.spotsAt = now();
      this.spotView = null;
      this.asmFar = false;
      if (!still) return;
      // The piece size from loose pieces is only a hint here: a view of just
      // the assembled block has none, and its own estimate can be the block.
      // This frame's own piece size when it has one: the running estimate
      // lags while the phone comes down, and a single close-up piece then
      // looked several pieces big (owner's video: false assembled parts).
      const own = seg.unitN >= 3 && seg.unitOwn ? seg.unitOwn : null;
      const unit = own && this.unitLive && Math.abs(Math.log(own / this.unitLive)) > Math.log(1.5) ? own : this.unitLive || seg.unitArea;
      // (up close one piece is ~5-12% of the view: trusted up to 15%, else a
      // single close-up piece passed the "6% of the view" fallback below and
      // was read as an 82-cell assembled part - owner's video IMG_3605)
      const side = unit && unit < proc.w * proc.h * 0.15 ? Math.sqrt(unit) : null;
      const pick = (ds, P, sd) => ds.filter((d) => (d.big || d.area > (sd ? sd * sd * 3.5 : P.w * P.h * 0.06)) && (!sd || Math.min(d.bbox[2], d.bbox[3]) >= sd * 1.2)) // (not a thin strip along the frame edge)
        .sort((x, y) => y.area - x.area).slice(0, photo ? 6 : 2);
      const blobs = pick(dets, proc, side).filter((d) => {
        const v = this.puzzleLike(d, seg, proc);
        if (PH.DEBUG_BLOB) PH.DEBUG_BLOB(d, v);
        if (!v.ok) this.rejects.notPuzzle = (this.rejects.notPuzzle || 0) + 1;
        return v.ok;
      });
      if (!blobs.length) return;
      if (!PH.Assembly) return; // js/vision/assembly.js not loaded (some tests)
      // Only sharp views build the assembled part: a motion-blurred one
      // (owner's video: a quick sweep, most frames smeared) gives a wrong grid
      // and lines up badly. Sharpness = lightness Laplacian spread, against
      // the recent views' own (the print sets the level, not a fixed number).
      if (!photo) {
        const sh = this.frameSharpness(seg.lab, proc.w, proc.h);
        const hist = this.sharpHist || (this.sharpHist = []);
        hist.push(sh); if (hist.length > 40) hist.shift();
        const ref = hist.slice().sort((a, b) => a - b)[Math.floor(hist.length * 0.75)];
        this.lastSharp = { sh: +sh.toFixed(1), ref: +ref.toFixed(1) };
        if (hist.length >= 5 && sh < ref * 0.6) { this.rejects.blurView = (this.rejects.blurView || 0) + 1; return; }
      }
      if (!this.asms) this.asms = [];
      if (this.addBlobs(blobs, seg, proc, 1, side, photo)) return;
      // Nothing readable: far away the pieces are only ~10-15 px at the
      // processing size (owner's video, whole puzzle in view), too few for
      // tabs and blanks. The camera image has 2-3x the detail: look again at
      // up to 1440 px (at most about once a second).
      const S = this.frameCtx && this.frameCtx.source;
      const hw = S ? Math.min(1440, Math.max(S.w, S.h)) : 0;
      // A whole-frame segmentation at that size costs ~0.5-1 s on a phone:
      // every 5 s at most, backing off to 30 s while it keeps failing.
      const wait = Math.min(30000, 5000 * 2 ** (this.hiResFails || 0));
      if (!photo && S && hw >= Math.max(proc.w, proc.h) * 1.4 && now() - (this.hiResAt || 0) > wait) {
        this.hiResAt = now();
        const hp = S.getProc(hw), f = hp.w / proc.w;
        const hs = PH.segment(hp, this.liveSegOpts({ still: true }, { split: false, unitArea: unit ? unit * f * f : null }));
        const hb = pick(hs.dets, hp, side ? side * f : null);
        if (hb.length && this.addBlobs(hb, hs, hp, f, side ? side * f : null, false)) { this.hiResFails = 0; return; }
        this.hiResFails = Math.min(3, (this.hiResFails || 0) + 1);
      }
      // The page says "move closer" - only when the pieces really are small
      // (far views: ~10-15 px a side). With pieces big enough to read, the
      // blob wasn't a readable assembled part at all (glass table 2026-10-07:
      // loose pieces merged with the floor seen through the glass), and
      // "move closer" sent the owner after a part that wasn't there.
      if (!side || side < 22) this.asmFar = true;
    }
    /** Grid each blob (in image P, f x the processing size), line it up with
     *  the assemblies and add it. True when at least one was added. */
    addBlobs(blobs, seg, P, f, side, photo) {
      let L = null, added = false;
      for (const d of blobs) {
        const g = PH.sectionSpots(d, side, P.w, P.h, (seg.unitN || 0) >= 6);
        if (PH.DEBUG_ASM) PH.DEBUG_ASM('grid', 'x' + f.toFixed(2), g ? (g.failed ? 'failed crisp ' + g.crisp.toFixed(2) + ' pitch ' + g.pitch.toFixed(1) : g.occ.length + ' filled ' + g.empty.length + ' empty crisp ' + g.crisp.toFixed(2) + ' pitch ' + g.pitch.toFixed(1)) : 'null', 'area', Math.round(d.area), 'big', !!d.big);
        if (!g || g.failed || g.occ.length < 4) continue;
        // Under ~16 px per piece tabs and blanks are a few pixels: the grid
        // is a guess, and a wrong one would spoil the assembly.
        if (g.pitch < 16) continue;
        // A clump of a few loose pieces touching each other is small and
        // ragged (solidity well under ~0.8); a small assembled block is
        // compact. Bigger ones count whatever their shape (a border run is an
        // L or a hollow ring).
        if (d.solidity < 0.78 && g.occ.length < 8) continue;
        if (!L) {
          const cv = PH.cv, m = new cv.Mat(P.h, P.w, cv.CV_8UC1);
          for (let p = 0, n = P.w * P.h; p < n; p++) m.data[p] = seg.lab[3 * p];
          cv.GaussianBlur(m, m, new cv.Size(0, 0), Math.max(0.8, g.pitch / 10));
          L = new Uint8Array(m.data); m.delete();
        }
        g.f = f; // this grid's image is f x the processing frame
        const X = PH.gridPatches(g, g.occ, L, P.w, P.h), NP = PH.PATCH * PH.PATCH;
        const fc = g.occ.map(([i, j], n) => ({ i, j, filled: true, patch: X.subarray(n * NP, (n + 1) * NP) }))
          .concat(g.empty.map(([i, j]) => ({ i, j, filled: false, patch: null })));
        const reg = this.registerView(fc, g, photo);
        if (PH.DEBUG_ASM) PH.DEBUG_ASM('reg', reg ? JSON.stringify({ k: reg.k, di: reg.di, dj: reg.dj, corr: +reg.corr.toFixed(2), agree: +reg.agree.toFixed(2), n: reg.n }) : 'none');
        if (!reg) continue;
        const A = reg.A;
        A.add(fc, g.sides, reg.k, reg.di, reg.dj);
        this.noteAsmTable(A, g, reg);
        this.asmLast = { id: A.id, k: reg.k, di: reg.di, dj: reg.dj, g, t: now() };
        A.locate(this.box);
        this.asmDirty = true;
        added = true;
        if (!this.spotView) this.spotView = { A, g, k: reg.k, di: reg.di, dj: reg.dj };
      }
      return added;
    }
    /** Where an assembly lies on the table map (for the Map): when a view
     *  lines up with it while the pose is known, its cells' centres in the
     *  frame -> table map give pairs (assembly cell -> table point); a
     *  similarity is fitted to the recent ones of the current scan group. */
    noteAsmTable(A, g, reg) {
      if (!this.pose || !this.island) return;
      if (!A.tab || A.tab.island !== this.island) A.tab = { island: this.island, T: null, pairs: [] };
      const P = A.tab.pairs || (A.tab.pairs = []);
      const step = Math.max(1, Math.floor(g.occ.length / 12));
      for (let n = 0; n < g.occ.length; n += step) {
        const [i, j] = g.occ[n];
        const [x, y] = g.toXY(g.u0 + (i + 0.5) * g.pitch, g.v0 + (j + 0.5) * g.pitch);
        const [a, b] = PH.rotCell(reg.k, i, j), f = g.f || 1;
        P.push({ src: [a + reg.di + 0.5, b + reg.dj + 0.5], dst: PH.simApply(this.pose, x / f, y / f) });
      }
      if (P.length > 240) P.splice(0, P.length - 240);
      const r = P.length >= 6 ? PH.simRansac(P, (this.unitTable() || 30) * 0.4, 60, this.rnd) : null;
      if (r && r.inliers.length >= P.length * 0.5) A.tab.T = r.T;
    }
    /** Does big blob d look like part of the puzzle? Owner's 50-piece video
     *  (v0.19.0): a butter dish, a jar lid and a fruit bowl became "assembled
     *  parts" with 52 open spots and a border. Measured per blob:
     *  - pal: share of its pixels whose colour is in the box picture
     *    (white-balanced like the segmentation's palette model);
     *  - tex: its print texture (mean lightness step between neighbours)
     *    over the board's around it.
     *  Returns {pal, tex, ok}. */
    puzzleLike(d, seg, P) {
      const W = P.w, H = P.h, L = seg.lab, fg = seg.fg;
      const [bx, by, bw, bh] = d.bbox;
      const st = Math.max(1, Math.floor(Math.sqrt((bw * bh) / 2500)));
      let corr = null;
      if (this.box && this.box.white) {
        const wf = PH.whitePoint(L, W * H), wb = this.box.white;
        if (wf.L > 120) corr = { k: wb.L / wf.L, fL: wf.L, da: wf.a - wb.a, db: wf.b - wb.b };
      }
      let n = 0, inPal = 0, tIn = 0, nIn = 0, tOut = 0, nOut = 0;
      const pad = Math.round(Math.max(bw, bh) * 0.15);
      for (let y = Math.max(1, by - pad); y < Math.min(H - 1, by + bh + pad); y += st) {
        for (let x = Math.max(1, bx - pad); x < Math.min(W - 1, bx + bw + pad); x += st) {
          const p = y * W + x, inside = x >= bx && x < bx + bw && y >= by && y < by + bh && fg && fg[p];
          const t = Math.abs(L[3 * p] - L[3 * (p + 1)]) + Math.abs(L[3 * p] - L[3 * (p + W)]);
          if (inside) {
            tIn += t; nIn++; n++;
            if (this.box && this.box.palette && this.box.palette[PH.correctedBin(L[3 * p], L[3 * p + 1], L[3 * p + 2], corr)] > PH.PAL_MIN) inPal++;
          } else if (!(fg && fg[p])) { tOut += t; nOut++; }
        }
      }
      const pal = this.box && this.box.palette && n ? inPal / n : null;
      const tex = nIn && nOut ? (tIn / nIn) / Math.max(0.5, tOut / nOut) : null;
      // (texture is reported, not required: the owner's real assembled puzzle
      // measured 1.2x its table, loose pieces on a plain counter 4-18x)
      const ok = pal === null || pal >= PH.PAL_SHARE;
      return { pal, tex, ok };
    }
    /** Lightness Laplacian spread of the processing frame (every 2nd pixel). */
    frameSharpness(lab, w, h) {
      let s = 0, ss = 0, n = 0;
      for (let y = 2; y < h - 2; y += 2) for (let x = 2; x < w - 2; x += 2) {
        const p = y * w + x, v = 4 * lab[3 * p] - lab[3 * (p - 1)] - lab[3 * (p + 1)] - lab[3 * (p - w)] - lab[3 * (p + w)];
        s += v; ss += v * v; n++;
      }
      return Math.sqrt(Math.max(0, ss / n - (s / n) ** 2));
    }
    /** Which assembly (and where in it) a view's cells belong to; a new
     *  assembly when nothing known overlaps. Two assemblies that one view
     *  lines up with are joined. */
    registerView(fc, g, photo) {
      const good = (r) => r && r.corr >= 0.6 && r.agree >= 0.85 && r.n >= 6;
      const last = this.asmLast && now() - this.asmLast.t < 4000 ? this.asmLast : null;
      let best = null;
      if (last) {
        const A = this.asms.find((x) => x.id === last.id);
        // predicted: the frame cell nearest the view's centre sits where the
        // last view's grid put that spot of the table (the phone moves little
        // between steady views)
        const c = g.occ[g.occ.length >> 1];
        const [x, y] = g.toXY(g.u0 + (c[0] + 0.5) * g.pitch, g.v0 + (c[1] + 0.5) * g.pitch);
        const k = (last.g.f || 1) / (g.f || 1); // into the last view's image size
        const [u, v] = last.g.toUV(x * k, y * k);
        const ip = Math.floor((u - last.g.u0) / last.g.pitch), jp = Math.floor((v - last.g.v0) / last.g.pitch);
        const [ai, aj] = PH.rotCell(last.k, ip, jp);
        const near = [0, 1, 2, 3].map((k) => { const [a, b] = PH.rotCell(k, c[0], c[1]); return { di: ai + last.di - a, dj: aj + last.dj - b }; });
        const r = A && A.register(fc, near);
        if (good(r)) best = Object.assign(r, { A });
      }
      // Full search when the local one failed: its cost grows with the
      // assemblies' size, so small ones every frame, big ones up to every 1.5 s.
      const known = (this.asms || []).reduce((n, A) => n + A.cells.size, 0);
      if (!best && (photo || now() - (this.asmGlobalAt || 0) > Math.min(1500, known * 1.5))) {
        this.asmGlobalAt = now();
        const hits = [];
        for (const A of this.asms) { const r = A.register(fc, null); if (PH.DEBUG_ASM) PH.DEBUG_ASM('global', A.id, r && JSON.stringify({ k: r.k, di: r.di, dj: r.dj, corr: +r.corr.toFixed(2), agree: +r.agree.toFixed(2), n: r.n })); if (good(r)) hits.push(Object.assign(r, { A })); }
        hits.sort((a, b) => b.score - a.score);
        best = hits[0] || null;
        for (const h of hits.slice(1)) this.joinAssemblies(best, h);
        if (!best) {
          // Nothing known overlaps: a new assembly - but only from a view with
          // enough cells, and not while a recent one is just failing to line
          // up (a blurred or misread view would split it).
          this.asmMiss = (this.asmMiss || 0) + 1;
          // (a photo is one sharp view: each block in it starts its own)
          if (g.occ.length >= (photo ? 6 : 8) && (photo || !this.asms.length || this.asmMiss >= 3)) {
            const A = new PH.Assembly(this.nextAsm = (this.nextAsm || 0) + 1);
            A.born = now();
            // One-off views that never lined up again (20 s) are dropped, and
            // at most 3 are kept: every full search tries each of them.
            this.asms = this.asms.filter((x) => x.place || x.views >= 2 || !x.born || now() - x.born < 20000);
            this.asms.push(A);
            if (this.asms.length > 3) this.asms.sort((a, b) => (b.place ? 1e6 : 0) + b.views * 100 + b.cells.size - ((a.place ? 1e6 : 0) + a.views * 100 + a.cells.size)).length = 3;
            this.asmMiss = 0;
            return { A, k: 0, di: 0, dj: 0, corr: 1, agree: 1, n: 0 };
          }
          return null;
        }
      }
      if (best) this.asmMiss = 0;
      return best;
    }
    /** Fold assembly B into A: the same view lines up with both (view -> A
     *  is ra, view -> B is rb), so a B cell maps view-wise into A. */
    joinAssemblies(ra, rb) {
      const A = ra.A, B = rb.A;
      if (A === B) return;
      const NP = PH.PATCH * PH.PATCH, turn = (ra.k - rb.k + 4) % 4, sIdx = PH.patchTurn(turn);
      for (const c of B.cells.values()) {
        // B -> view: undo rb's shift and turn; view -> A: ra's turn and shift
        const [fi, fj] = PH.rotCell((4 - rb.k) % 4, c.i - rb.di, c.j - rb.dj);
        const [a, b] = PH.rotCell(ra.k, fi, fj);
        const t = A.cell(a + ra.di, b + ra.dj, true);
        t.f += c.f; t.e += c.e;
        if (c.patch) {
          if (!t.patch) t.patch = new Float32Array(NP);
          for (let q = 0; q < NP; q++) t.patch[q] += c.patch[sIdx[q]];
          t.pn += c.pn;
        }
        c.sides.forEach((v, d) => {
          if (!v) return;
          const dd = (d + turn) % 4, w = t.sides[dd] || (t.sides[dd] = { T: 0, B: 0, F: 0 });
          w.T += v.T; w.B += v.B; w.F += v.F;
        });
      }
      A.views += B.views; A.version++;
      this.asms = this.asms.filter((x) => x !== B);
      A.locate(this.box, true);
    }
    /** An assembly worth showing: placed on the box, or confirmed by a few
     *  views (a one-off view - a misread blob in a photo - is not). */
    // With a box picture, an assembled part is shown only once it is placed on
    // it with confidence (v0.20: a butter dish and close-up single pieces
    // became "assembled parts" with 52 open spots); without one, after 3 views.
    asmShown(A) { return this.box ? !!A.place : A.views >= 3; }
    /** The main assembly: placed ones first, then the most cells. */
    mainAssembly() {
      let best = null;
      const filled = (A) => { let n = 0; for (const c of A.cells.values()) if (A.filled(c)) n++; return n; };
      for (const A of this.asms || []) {
        if (!this.asmShown(A)) continue;
        const key = (A.place ? 1e6 : 0) + filled(A);
        if (!best || key > best.key) best = { A, key };
      }
      return best && best.A;
    }
    /** The main assembly's state, for the page and reports. */
    assemblyInfo(withCells) {
      if (this.pframe && this.cellVotes && this.box) {
        const filled = this.cellFilledSet(), spots = this.cellSpots();
        const { cols, rows } = this.box;
        const out = { n: 1, cells: filled.size, views: this.cellVotes.views, place: { k: 0, marked: true },
          border: { total: 2 * (cols + rows) - 4, done: 2 * (cols + rows) - 4, inside: 0, cells: filled.size }, spots: spots.length, fromBorder: true };
        const key = 'cells:' + this.cellVotesV;
        if (withCells && key !== this.asmSentKey) { this.asmSentKey = key; out.boxCells = { filled: [...filled], open: spots.map((s) => s.row * cols + s.col) }; }
        return out;
      }
      const A = this.mainAssembly();
      if (!A) return null;
      let filled = 0;
      for (const c of A.cells.values()) if (A.filled(c)) filled++;
      const out = { n: this.asms.length, cells: filled, views: A.views, place: A.place, border: A.borderStatus(this.box), spots: A.spots(this.box).length };
      // Its box cells (filled / open) for the page's box picture: only when they changed.
      const key = A.id + ':' + A.version + ':' + !!A.place;
      if (withCells && key !== this.asmSentKey) {
        this.asmSentKey = key;
        out.boxCells = A.place ? { filled: [...A.filledBoxCells(this.box)], open: A.spots(this.box).filter((s) => s.cell).map((s) => s.cell[1] * this.box.cols + s.cell[0]) } : { filled: [], open: [] };
      }
      return out;
    }
    /** Loose pieces for box cell (col,row) whose edges agree with the spot's
     *  needs (box directions; '?' = unknown), best first (PH fillSpot ranking). */
    spotPieces(col, row, need, topN) {
      const f = this.fillSpot(col, row, 12);
      const out = [];
      // The turn the print suggests can be wrong (plain or repeating print),
      // so any turn whose edges agree with the spot's needs will do; the
      // print's own turn first.
      const fits = (P, rot) => {
        for (let d = 0; d < 4; d++) {
          if (need[d] === '?') continue;
          const e = P.t1.edges[(d - rot + 8) % 4];
          if (e.type !== need[d] && !(e.unc && e.alt === need[d])) return false;
        }
        return true;
      };
      for (const c of f.cands) {
        const P = this.pieces.get(c.id);
        if (!P || !P.t1 || !P.pos) continue;
        const rot = [c.rot, (c.rot + 1) % 4, (c.rot + 2) % 4, (c.rot + 3) % 4].find((r) => fits(P, r));
        if (rot !== undefined) out.push({ id: c.id, rot, print: c.print });
        if (out.length >= topN) break;
      }
      return out;
    }
    /** This frame's open spots: the assembly's spots (with box cell, needs
     *  and the best loose pieces) drawn through the grid this view lined up
     *  with. Piece suggestions are cached per assembly/catalogue version. */
    spotsOut(inv, byId) {
      if (this.pframe) return this.cellSpotsOut(inv, byId);
      const V = this.spotView;
      if (!V || !this.asmShown(V.A)) return [];
      const A = V.A, g = V.g;
      if (!A.spotCache || A.spotCache.version !== A.version || A.spotCache.pieces !== this.version) {
        const list = A.spots(this.box).sort((a, b) => b.n - a.n);
        let budget = 12;
        for (const sp of list) {
          sp.best = [];
          if (!sp.cell || budget <= 0) continue;
          const need = ['?', '?', '?', '?'];
          sp.need.forEach((t, d) => (need[(d + A.place.k) % 4] = t)); // assembly side -> box side
          sp.best = this.spotPieces(sp.cell[0], sp.cell[1], need, 3);
          budget--;
        }
        A.spotCache = { version: A.version, pieces: this.version, list };
      }
      return A.spotCache.list.map((sp) => {
        const [fi, fj] = PH.rotCell((4 - V.k) % 4, sp.i - V.di, sp.j - V.dj);
        const poly = [];
        const f = g.f || 1; // the grid's image -> the processing frame
        for (const [a, b] of [[fi, fj], [fi + 1, fj], [fi + 1, fj + 1], [fi, fj + 1]]) { const q = g.toXY(g.u0 + a * g.pitch, g.v0 + b * g.pitch); poly.push(q[0] / f, q[1] / f); }
        let [cx, cy] = g.toXY(g.u0 + (fi + 0.5) * g.pitch, g.v0 + (fj + 0.5) * g.pitch);
        cx /= f; cy /= f;
        // needs in this view's directions (for drawing)
        const need = ['?', '?', '?', '?'];
        sp.need.forEach((t, d) => (need[(d - V.k + 4) % 4] = t));
        const best = (sp.best || []).map((b) => {
          const d = byId.get(b.id), P = this.pieces.get(b.id);
          const at = d ? [d.cx, d.cy] : P && P.pos && inv && P.island === this.island ? PH.simApply(inv, P.pos[0], P.pos[1]) : null;
          return { id: b.id, x: at ? at[0] : null, y: at ? at[1] : null, visible: !!d };
        });
        return { poly: poly.map((v) => Math.round(v * 10) / 10), cx, cy, n: sp.n, need, cell: sp.cell, best };
      });
    }

    /** Open spots of the marked puzzle, drawn through where the border is in
     *  this view, with the best loose pieces (cached per votes/catalogue). */
    cellSpotsOut(inv, byId) {
      const H = this.pfViewH;
      if (!H || !this.cellVotes) return [];
      if (!this.cellCache || this.cellCache.v !== this.cellVotesV || this.cellCache.pieces !== this.version) {
        const list = this.cellSpots().sort((a, b) => b.n - a.n);
        let budget = 12;
        for (const sp of list) sp.best = budget-- > 0 ? this.spotPieces(sp.col, sp.row, ['?', '?', '?', '?'], 3) : [];
        this.cellCache = { v: this.cellVotesV, pieces: this.version, list };
      }
      return this.cellCache.list.map((sp) => {
        const q = PH.PuzzleFrame.cellQuad(H, sp.col, sp.row), [cx, cy] = PH.applyHom(H, sp.col + 0.5, sp.row + 0.5);
        const best = sp.best.map((b) => {
          const d = byId.get(b.id), P = this.pieces.get(b.id);
          const at = d ? [d.cx, d.cy] : P && P.pos && inv && P.island === this.island ? PH.simApply(inv, P.pos[0], P.pos[1]) : null;
          return { id: b.id, x: at ? at[0] : null, y: at ? at[1] : null, visible: !!d };
        });
        return { poly: q.flat().map((v) => Math.round(v * 10) / 10), cx, cy, n: sp.n, need: ['?', '?', '?', '?'], cell: [sp.col, sp.row], best };
      });
    }

    // ---------- output for the overlay ----------
    output(dets, proc) {
      const inv = this.pose ? PH.simInvert(this.pose) : null;
      const byId = new Map();
      const outDets = dets.map((d) => {
        const p = d.id ? this.pieces.get(d.id) : null;
        let status = 'unknown';
        if (d.merged) status = 'merged';
        else if (p && this.isChecked(p)) status = p.inPuzzle ? 'done' : p.t2 && p.t2.conf >= 0.35 ? 'placed' : 'shaped';
        else if (!d.border) status = 'checking'; // not a checked piece yet: the "scan closer" ring
        if (p) byId.set(p.id, d);
        // `r` lets the page draw a marker without walking the outline at all.
        // The outline itself is simplified harder than it used to be: it is
        // only used for hit-testing a tap and for the optional outline view,
        // and every point costs a transform (a homography, with tilt on).
        const close = status === 'checking' && Math.sqrt(d.area || 1) / proc.scale / 1.1 >= PH.CLOSE_SIDE; // near enough to check it now
        return { id: status === 'checking' ? null : d.id, status, close, cx: d.cx, cy: d.cy, r: Math.round(Math.sqrt(d.area || 1) / 2), pts: simplify(d.pts, this.opts.outlineEps || 2.5), border: d.border };
      });
      const hl = [];
      const locate = (id, role, extra) => {
        const d = byId.get(id);
        if (d) return hl.push(Object.assign({ id, role, x: d.cx, y: d.cy, visible: true }, extra));
        const p = this.pieces.get(id);
        if (p && p.pos && !p.gone && inv && p.island === this.island) { // (no arrow to a moved piece's old spot)
          const f = PH.simApply(inv, p.pos[0], p.pos[1]);
          hl.push(Object.assign({ id, role, x: f[0], y: f[1], visible: false }, extra));
        }
      };
      if (this.selection) {
        const sid = this.selection.id;
        // Arrow from the piece toward its top edge (as it sits in the puzzle):
        // table-map direction -> this frame through the inverse pose.
        const u = this.upOf(this.pieces.get(sid) || {}), dSel = byId.get(sid);
        let up = null;
        if (u && u.vt && dSel && this.pose) {
          const a = this.pose.a, b = this.pose.b, n2 = a * a + b * b;
          const px = (a * u.vt[0] + b * u.vt[1]) / n2, py = (-b * u.vt[0] + a * u.vt[1]) / n2, n = Math.hypot(px, py) || 1;
          const len = Math.sqrt(dSel.area || 400) * 0.85;
          up = [dSel.cx + (px / n) * len, dSel.cy + (py / n) * len];
        }
        locate(sid, 'sel', up ? { up } : undefined);
        const P = this.pieces.get(sid);
        const res = this.matchesFor(sid);
        // Gold only for a likely match; otherwise candidates are just "maybe".
        // Gold = a likely match between two confirmed shapes (or one closed into
        // a 2x2 block); anything resting on a single, possibly bad read is a
        // "maybe" (silver), however good its score looks.
        if (res) for (const r of res) r.matches.slice(0, 3).forEach((m, i) => {
          const gold = PH.sureFit(m, i);
          locate(m.id, gold ? 'gold' : 'silver', { edge: r.edge, edgeB: m.edge, rank: i });
        });
      }
      if (this.region) for (const id of this.region.ids) locate(id, id === this.region.best ? 'gold' : 'region');
      if (this.pairSel) {
        locate(this.pairSel.a, 'sel');
        locate(this.pairSel.b, 'gold');
      }
      if (this.filter) {
        // A class filter can match hundreds of pieces. Everything in view is
        // outlined, but only the nearest few off-screen ones get an arrow,
        // otherwise the edges of the screen fill up with clutter.
        const fixed = this.filter === 'corner' ? 'corner' : this.filter === 'border' ? 'border' : 'find';
        const role = (id) => this.filter !== 'edges' ? fixed : edgeFlags(this.pieces.get(id)).corner ? 'corner' : 'border';
        const off = [];
        const zones = this.filter === 'zones';
        for (const id of this.filterIds()) {
          if (zones) { // every piece in view ringed in its zone's colour; no arrows (it's sorting, not finding)
            if (byId.has(id)) { const c = this.pieces.get(id).t2.cands[0]; locate(id, 'zone', { zone: PH.zoneOf(this.box, c.col, c.row) }); }
            continue;
          }
          if (byId.has(id)) { locate(id, role(id)); continue; }
          const p = this.pieces.get(id);
          if (p && p.pos && inv && p.island === this.island) off.push(p);
        }
        if (off.length) {
          const c = PH.simApply(this.pose, proc.w / 2, proc.h / 2);
          off.sort((x, y) => Math.hypot(x.pos[0] - c[0], x.pos[1] - c[1]) - Math.hypot(y.pos[0] - c[0], y.pos[1] - c[1]));
          for (const p of off.slice(0, 6)) locate(p.id, role(p.id));
        }
      }
      // Auto-flag: mutual best matches among visible pieces.
      const links = [];
      const vis = [...byId.keys()].filter((id) => this.pieces.get(id).t1 && this.isChecked(this.pieces.get(id)));
      if (vis.length <= 80) {
        let budget = 4; // fresh match computations per frame
        const best = new Map();
        for (const id of vis) {
          const c = this.matchCache.get(id);
          if (!(c && c.version === this.version) && budget-- <= 0) { if (c) best.set(id, c.res); continue; }
          best.set(id, this.matchesFor(id));
        }
        for (const [id, res] of best) for (const r of res || []) {
          const m = r.matches[0];
          if (!m || m.prob < 0.8 || m.tie || m.colOk === false || !best.has(m.id) || id > m.id) continue; // (as a sure fit: no tie, colour agrees)
          if (!shapeConfirmed(this.pieces.get(id)) || !shapeConfirmed(this.pieces.get(m.id))) continue; // both shapes seen twice
          if (this.pieces.get(id).inPuzzle && this.pieces.get(m.id).inPuzzle) continue; // both already placed
          // Both confidently placed on the box but not side by side: not a pair.
          const P = this.pieces.get(id), Q = this.pieces.get(m.id);
          // With a box picture, wait until both are placed so it can veto the pair.
          if (this.box && (!P.t2 || !Q.t2 || P.t2.conf < 0.2 || Q.t2.conf < 0.2)) continue; // (placed at least loosely, or the box can't veto)
          // The box must agree they're neighbors, unless a placement is too
          // uncertain to judge and the shape/color match is near-certain.
          if (this.box && m.adj === 0 && !((P.t2.conf < 0.3 || Q.t2.conf < 0.3) && m.prob >= 0.95)) continue;
          const back = best.get(m.id)[m.edge].matches[0];
          if (back && back.id === id && back.edge === r.edge && back.prob >= 0.8) {
            const a = byId.get(id), b = byId.get(m.id);
            links.push({ a: id, b: m.id, x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy, prob: Math.min(m.prob, back.prob) });
          }
        }
      }
      links.sort((a, b) => b.prob - a.prob);
      links.length = Math.min(links.length, 6);
      return {
        procW: proc.w, procH: proc.h, scale: proc.scale,
        dets: outDets, highlights: hl, links,
        tracking: !!this.pose, island: this.island,
        spots: this.spotsOut(inv, byId), assembly: this.assemblyInfo(true), asmFar: !!this.asmFar,
        counts: this.counts(),
        bg: this.bg, thresh: this.thresh,
      };
    }

    // ---------- persistence ----------
    exportPiece(p) {
      return { id: p.id, fp: p.fp, area: p.area, pos: p.pos, island: p.island, t1: p.t1, t2: p.t2, wrong: p.wrong, joined: p.joined, created: p.created, rd: p.rd || null, pic: p.pic || null, missing: !!p.missing, inPuzzle: p.inPuzzle || 0, cutSeen: p.cutSeen || 0,
        // evidence for "checked" (v0.20) and the duplicate clean-up
        state: p.state || 'checking', sightings: p.sightings || 0, moments: p.moments || 0, closeViews: p.closeViews || 0, closeAgree: p.closeAgree || 0,
        seenWith: p.seenWith ? [...p.seenWith] : [], gone: !!p.gone, goneAt: p.goneAt || 0, refound: p.refound || 0, photoRead: !!p.photoRead };
    }
    importState(state) {
      this.reset();
      if (state.boardRef && state.boardRef.L > 15) this.boardRef = state.boardRef;
      for (const q of state.pieces || []) {
        if (q.kind === 'section') { this.dirty.add(q.id); continue; } // v0.16 and older: replaced by the assembly
        const p = Object.assign({ miss: 0, t1Fail: 0, wrong: [], joined: [false, false, false, false] }, q);
        p.seenWith = new Set(q.seenWith || []);
        p.momentF = undefined; // frame numbers restart
        this.pieces.set(p.id, p);
        if (p.t1) this.calibrate(p.t1);
        this.nextId = Math.max(this.nextId, p.id + 1);
        if (p.island) this.nextIsland = Math.max(this.nextIsland, p.island + 1);
      }
      if (state.box) {
        this.box = state.box;
        if (!this.box.palette || !this.box.white) PH.computeCells(this.box); // boxes saved before palettes existed
        if (this.box.lab && PH.boxColTol) PH.colTol = this.box.colT = this.box.colT || PH.boxColTol(this.box);
      }
      this.dirty.clear();
      // A saved scan is cleaned up as it loads (duplicates from older
      // versions merged); what changed is saved back (dirty).
      this.housekeep(Infinity); // (also joins scan groups and settles false edge pieces)
    }
    takeDirty() {
      const ids = [...this.dirty];
      this.dirty.clear();
      return {
        put: ids.filter((id) => this.pieces.has(id)).map((id) => this.exportPiece(this.pieces.get(id))),
        del: ids.filter((id) => !this.pieces.has(id)),
      };
    }
  }

  // Compose similarity transforms: (A o B)(x) = A(B(x)).
  function composeSim(A, B) {
    return { a: A.a * B.a - A.b * B.b, b: A.a * B.b + A.b * B.a, tx: A.a * B.tx - A.b * B.ty + A.tx, ty: A.b * B.tx + A.a * B.ty + A.ty };
  }

  /** Typical piece side (mm) for a puzzle of n pieces, from common finished
   *  sizes (1000 pcs ~ 69x51 cm -> ~19 mm; 500 ~ 61x46 -> ~24; 300 ~ 30 mm;
   *  big-piece 100-200 ~ 31-33). Interpolated on log(n). */
  PH.typicalPieceMM = function (n) {
    const T = [[100, 33], [200, 31], [300, 30], [500, 24], [1000, 19], [1500, 18], [2000, 18], [3000, 17]];
    if (!n || n <= T[0][0]) return T[0][1];
    for (let i = 1; i < T.length; i++) if (n <= T[i][0]) {
      const [n0, m0] = T[i - 1], [n1, m1] = T[i];
      const t = Math.log(n / n0) / Math.log(n1 / n0);
      return m0 + (m1 - m0) * t;
    }
    return T[T.length - 1][1];
  };

  /** A shape is trusted once two independent views agreed on it. */
  function shapeConfirmed(p) { return !!(p && p.t1 && (p.t1.nObs || 1) >= 2); }
  PH.shapeConfirmed = shapeConfirmed;
  /** A sure fit (gold): only between checked pieces (both close-read, so
   *  only they get matches at all), likely, not within reading noise of
   *  another candidate, passing the colour rule along the seam, and backed by
   *  something independent - each picks the other, a closed 2x2 loop, or
   *  the box picture putting them side by side. */
  PH.sureFit = (m, rank) => rank === 0 && (m.prob || 0) >= 0.5 && !m.tie && m.colOk !== false && !!(m.mutual || m.loopOk || (m.adj || 0) >= 0.3);
  // Assembled-part blob checks (Engine.puzzleLike); set from the owner's video
  // and the real assembled-puzzle photo, see test/real-50.js.
  PH.PAL_MIN = 1.2e-4; // a box-palette bin at least as common as an even spread counts as "a puzzle colour"
  PH.PAL_SHARE = 0.5;  // share of a blob's pixels in puzzle colours

  /** Flat-edge summary of a piece: how many straight edges it has, and whether
   * two of them meet (a corner piece). Edges are stored clockwise, so adjacent
   * flats are neighbours in the array. */
  function edgeFlags(p) {
    const t1 = p && p.t1;
    if (!t1 || !t1.flats) return { n: 0, border: false, corner: false };
    // Seen again with more puzzle right past its straight side: a chunk cut
    // out of an assembled section, not a border piece.
    if ((p.cutSeen || 0) >= 2) return { n: 0, border: false, corner: false };
    // Only certain flats count: an edge near the flat/tab threshold may be a
    // shallow tab, and calling it border is how "Edges (108)" happened.
    const f = t1.flats, e = t1.edges || [];
    const flat = (i) => f[i] && !(e[i] && e[i].unc);
    let n = 0, corner = false;
    for (let i = 0; i < 4; i++) {
      if (!flat(i)) continue;
      n++;
      if (flat((i + 1) % 4)) corner = true;
    }
    return { n, border: n > 0, corner };
  }
  PH.edgeFlags = edgeFlags;

  // Douglas-Peucker on a flat Int32Array outline, returns flat array.
  function simplify(pts, eps) {
    const n = pts.length / 2;
    if (n < 8) return Array.from(pts);
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1];
      const L = Math.hypot(bx - ax, by - ay) || 1;
      let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - pts[2 * i + 1]) - (ax - pts[2 * i]) * (by - ay)) / L;
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
    return out;
  }
  PH.simplify = simplify;
  PH.Engine = Engine;
})(typeof self !== 'undefined' ? self : globalThis);
