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

  class Engine {
    constructor(opts) {
      // procW is the long side the live camera frames are analyzed at. Every
      // per-pixel pass (Lab conversion, background distance, threshold) scales
      // with its square, and those passes are what makes a phone sweat, so it
      // is deliberately well below the camera's own resolution.
      this.opts = Object.assign({ procW: +(typeof process !== 'undefined' && process.env && process.env.PROCW) || 640, snapProcW: 1600, minDE: 8, lightW: 0.5, budgetMs: 45 }, opts || {});
      this.reset();
    }

    reset() {
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
    counts() {
      let shaped = 0, placed = 0, located = 0, sections = 0, pieces = 0, border = 0, corner = 0;
      const islands = new Set();
      for (const p of this.pieces.values()) {
        if (p.kind === 'section') { sections++; continue; }
        pieces++;
        if (p.t1) shaped++;
        if (p.t2 && p.t2.conf >= 0.35) placed++;
        if (p.pos) { located++; islands.add(p.island); }
        const f = edgeFlags(p);
        if (f.corner) corner++; else if (f.border) border++;
      }
      // `islands` is how many disconnected scan groups the table map is in.
      // More than a few means tracking keeps breaking and the same physical
      // pieces are being catalogued more than once.
      return { pieces, sections, shaped, placed, located, border, corner, islands: islands.size, expected: this.box ? this.box.cols * this.box.rows : 0 };
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
      main.g.forEach((pr, k) => {
        if (inl.has(k)) {
          // gentle refinement keeps the map consistent
          const q = PH.simApply(T, pr.src[0], pr.src[1]);
          pr.p.pos = [pr.p.pos[0] * 0.9 + q[0] * 0.1, pr.p.pos[1] * 0.9 + q[1] * 0.1];
        } else if (pr.d.tracked && pr.d.linkSim > 0.7) {
          pr.p.pos = PH.simApply(T, pr.src[0], pr.src[1]);
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
          if (p.island === isl && p.pos) { p.pos = PH.simApply(r2.T, p.pos[0], p.pos[1]); p.island = main.isl; this.touch(p); }
        }
      }
      return true;
    }

    // Find the pose from scratch by matching fingerprints against located pieces.
    relocalize(dets, unitF, onlyIsland) {
      const unitT = this.unitTable();
      if (!unitT) return null;
      const placed = [];
      for (const p of this.pieces.values()) if (p.pos && (onlyIsland === undefined || p.island === onlyIsland)) placed.push(p);
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
        if (!p.t1 || !p.pos || (filter && !filter(p))) continue;
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
        for (const p of this.pieces.values()) if (p.island === isl && p.pos) { p.pos = PH.simApply(r.T, p.pos[0], p.pos[1]); p.island = this.island; this.touch(p); }
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
      if (!t || !t.down || this.opts.tiltCorrection === false || PH.tiltDeg(t.down) < 4) return { source, rect: null };
      const rect = PH.tiltHomography(source.w, source.h, PH.focalPx(source.w, source.h, t.fov), t.down, 3);
      return rect ? { source: PH.rectifiedSource(source, rect), rect } : { source, rect: null };
    }

    processFrame(source, info) {
      info = info || {};
      const t0 = now();
      const st = this.straighten(source, info);
      source = st.source;
      const proc = source.getProc(this.opts.procW);
      this.lastProc = proc; // kept for debug reports (what the app actually analyzed)
      // Per-stage segmentation timings ride along in out.timings (as flat
      // seg_* numbers) so a phone report shows where the time actually goes.
      const segT = {};
      const seg = PH.segment(proc, this.segOpts({ bg: this.bg, bgSmooth: 0.3, splitBudgetMs: 25, timings: segT }));
      this.bg = seg.bg; this.thresh = seg.thresh;
      const t1 = now();
      const dets = this.classify(seg.dets, seg.unitArea);
      const unitF = this.unitFrame(dets);
      this.link(dets, unitF);
      // Set before the pose work so the shape-based fallback below can read
      // outlines; nothing in it depends on the pose.
      this.frameCtx = { source, scale: proc.scale, bg: this.bg, thresh: this.thresh, lut: seg.lut, unitArea: seg.unitArea, still: info.still !== false, deadline: t0 + this.opts.budgetMs };
      let ok = this.fitPose(dets, unitF);
      if (!ok) {
        const r = this.relocalize(dets, unitF);
        if (r) {
          this.pose = r.T; this.island = r.island; ok = true;
          for (const d of dets) d.id = null;
          for (const a of r.assign) a.d.id = a.p.id;
        }
      }
      if (!ok) {
        this.lost++;
        const anyPlaced = [...this.pieces.values()].some((p) => p.pos);
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
      if (ok) { this.lost = 0; this.assign(dets, unitF, proc); }
      const t2 = now();
      const work = this.runQueue(dets, t0 + this.opts.budgetMs);
      this.tracks = dets.map((d) => ({ id: d.id, x: d.cx, y: d.cy, fp: d.fp }));
      const out = this.output(dets, proc);
      // Lets the page map straightened coordinates back onto the camera view.
      out.rect = st.rect ? { H: st.rect.H, Hinv: st.rect.Hinv, tilt: PH.tiltDeg(info.tilt.down) } : null;
      out.timings = { seg: t1 - t0, map: t2 - t1, work: now() - t2, total: now() - t0, t1: work.t1, t2: work.t2 };
      for (const k in segT) out.timings['seg_' + k] = segT[k];
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
      const saved = { pose: this.pose, island: this.island, tracks: this.tracks, lost: this.lost };
      const proc = source.getProc(this.opts.snapProcW);
      const seg = PH.segment(proc, this.segOpts({ bg: this.bg, bgSmooth: 0.5 }));
      if (!this.bg) this.bg = seg.bg;
      this.frameCtx = { source, scale: proc.scale, bg: seg.bg, thresh: seg.thresh, lut: seg.lut, unitArea: seg.unitArea, still: true, deadline: Infinity };
      const dets = this.classify(seg.dets, seg.unitArea);
      const unitF = this.unitFrame(dets);
      const before = this.pieces.size;
      const known = new Set(this.pieces.keys());
      // Read every shape first: shapes identify the same piece across photos
      // regardless of lighting and zoom, which color fingerprints don't.
      for (const d of dets) this.detT1(d);
      // In a still photo every piece gets a full read; anything that doesn't
      // read as a jigsaw piece is not catalogued.
      for (let i = dets.length - 1; i >= 0; i--) if (!dets[i].t1 && !dets[i].merged && !dets[i].border) dets.splice(i, 1); // sections (merged) stay
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
      Object.assign(this, saved);
      return {
        found: dets.filter((d) => d.id).length,
        added: this.pieces.size - before,
        located, mergedIslands: merged,
        tilt: info.tilt ? Math.round(PH.tiltDeg(info.tilt.down)) : 0, autoTilt: autoTilt && { pitch: autoTilt.pitch, roll: autoTilt.roll, gain: +autoTilt.gain.toFixed(3), check: autoTilt.check },
        // pieces this photo recognized from earlier views (for checking/stitch UI)
        recognized: dets.filter((d) => d.id && known.has(d.id)).map((d) => ({ id: d.id, corners: d.t1 ? d.t1.corners : null, firstCorners: this.pieces.get(d.id).t1 ? this.pieces.get(d.id).t1.corners : null })),
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
      const proc = source.getProc(this.stillProcW());
      const seg = PH.segment(proc, this.segOpts({ splitBudgetMs: 60 }));
      return seg.dets.filter((d) => !d.border && PH.pieceScore(d.pts, d.area) > PH.MIN_CORNER_SCORE).length;
    }
    estimatePhotoTilt(source) {
      const proc = source.getProc(this.stillProcW());
      const seg = PH.segment(proc, this.segOpts({ splitBudgetMs: 60 }));
      const unit = seg.unitArea;
      // Pick blobs by shape (4 good corners), not size: the small far-away
      // pieces are exactly the ones that reveal the tilt.
      const blobs = seg.dets.filter((d) => !d.border && d.area > unit * 0.1 && d.area < unit * 4 && PH.pieceScore(d.pts, d.area) > PH.MIN_CORNER_SCORE)
        .map((d) => ({ pts: Array.from(d.pts, (v) => v / proc.scale), area: d.area }));
      return PH.estimateTilt(blobs, source.w, source.h);
    }

    // Segmentation options: taught background colors win, then the box palette,
    // then the single-color-cloth model.
    segOpts(extra) {
      return Object.assign({
        minDE: this.opts.minDE, lightW: this.opts.lightW,
        taught: this.taught, palette: this.opts.useBoxPalette !== false && this.box ? this.box.palette : null,
        paletteWhite: this.box ? this.box.white : null,
      }, extra);
    }
    teachBackground(lab) { this.taught.push(lab); }
    clearBackground() { this.taught = []; }

    classify(dets, unitArea) {
      const areas = dets.filter((d) => !d.border).map((d) => d.area);
      const medA = unitArea || PH.median(areas.length ? areas : dets.map((d) => d.area));
      const out = [];
      for (const d of dets) {
        d.merged = d.area > medA * 1.9;
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
        let best = null;
        for (const p of this.pieces.values()) {
          if (!p.pos || p.island !== this.island || claimed.has(p.id)) continue;
          if ((p.kind === 'section') !== !!d.merged) continue;
          const dist = Math.hypot(p.pos[0] - q[0], p.pos[1] - q[1]);
          if (dist > unitT * (d.merged ? 1.2 : 0.55)) continue;
          const sim = PH.fpSimilarity(d.fp, p.fp);
          if (sim < 0.5) continue;
          const c = dist / unitT + (1 - sim);
          if (!best || c < best.c) best = { c, p };
        }
        return best && best.p;
      };
      // Pass 1: match by position; then refit the pose on every match so a
      // slightly-off pose (just relocalized, few anchors) doesn't cause misses.
      for (const d of dets) {
        if (d.id) continue;
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
        if (d.id) continue;
        const q = PH.simApply(T, d.cx, d.cy);
        const near = nearest(d, T);
        if (near) { d.id = near.id; claimed.add(near.id); continue; }
        if (d.border) continue;
        if (d.merged) {
          // An assembled section (or a clump of touching pieces): catalogued
          // separately and located on the box picture as a whole.
          if (!this.frameCtx.still) continue;
          const p = this.newPiece(d, q, this.island, d.area * s * s);
          p.kind = 'section';
          d.id = p.id; claimed.add(p.id);
          continue;
        }
        // Before adding a new piece, check whether a known piece was moved here
        // (or went missing earlier). Look-alikes are common (sky!), so a
        // candidate with a shape model must also match by shape.
        const moved = this.findMoved(d, s, claimed);
        if (moved === 'defer') continue; // out of time this frame; decide next frame
        if (moved) {
          moved.pos = q; moved.island = this.island; moved.miss = 0; d.id = moved.id; claimed.add(moved.id); this.touch(moved);
          continue;
        }
        if (!this.frameCtx.still && this.pieces.size) continue; // wait for a steady view before cataloging
        const p = this.newPiece(d, q, this.island, d.area * s * s);
        d.id = p.id; claimed.add(p.id);
        this.version++;
      }
      // Located pieces that should be in view but aren't were probably moved.
      const inv = PH.simInvert(T);
      const seen = new Set(dets.map((d) => d.id));
      const margin = unitF;
      for (const p of this.pieces.values()) {
        if (!p.pos || p.island !== this.island || seen.has(p.id)) continue;
        const f = PH.simApply(inv, p.pos[0], p.pos[1]);
        if (f[0] < margin || f[1] < margin || f[0] > proc.w - margin || f[1] > proc.h - margin) continue;
        const covered = dets.some((d) => (d.merged || d.border) && f[0] >= d.bbox[0] && f[1] >= d.bbox[1] && f[0] <= d.bbox[0] + d.bbox[2] && f[1] <= d.bbox[1] + d.bbox[3]);
        if (covered) continue;
        if (++p.miss > 6) { p.pos = null; p.miss = 0; this.touch(p); }
      }
      for (const d of dets) if (d.id) { const p = this.pieces.get(d.id); p.miss = 0; p.lastSeen = Date.now(); }
    }

    findMoved(d, s, claimed) {
      const cands = [];
      for (const p of this.pieces.values()) {
        if (claimed.has(p.id) || p.kind === 'section') continue;
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
        if (c.sim > 0.9 && (!c.p.pos || near)) return c.p;
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
      try {
        const hint = d.split ? Array.from(d.pts, (v, i) => v / scale - (i % 2 ? y0 : x0)) : null;
        d.t1 = PH.analyzePiece(crop, { bg: F.bg, threshDE: F.thresh, lut: F.lut, hint, lightW: this.opts.lightW, ox: x0, oy: y0 });
      } catch (e) { d.t1 = null; }
      // Background scraps and half-detected pieces don't have 4 good corners.
      if (d.t1 && d.t1.cornerScore < PH.MIN_CORNER_SCORE) { d.t1 = null; d.notPiece = true; }
      return d.t1;
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
        d.fused = true;
        if (!p.t1 || p.t1 === d.t1 || (p.t1.nObs || 1) >= 8) continue;
        const m = PH.samePiece(d.t1, p.t1);
        if (m.ok) { PH.fuseShapes(p.t1, d.t1, m.r); this.touch(p); this.version++; }
      }
      if (F.still) {
        const jobs = [];
        for (const d of dets) {
          if (!d.id || d.border || d.merged) continue;
          const p = this.pieces.get(d.id);
          const sidePx = Math.sqrt(d.area) / scale;
          if (p.t1 && sidePx < p.t1.meanSide * 1.4) continue; // only redo when much closer
          if (!p.t1 && p.t1Fail > 0 && (p.t1Fail++ % 8) !== 0) continue;
          jobs.push({ d, p, pri: p.t1 ? 1 : 0 });
        }
        jobs.sort((a, b) => a.pri - b.pri);
        for (const j of jobs) {
          if (j.d.t1 === undefined && now() > t1Deadline) break;
          const t1 = this.detT1(j.d);
          if (!t1) {
            j.p.t1Fail = (j.p.t1Fail || 0) + 1;
            if (!j.p.t1 && j.d.notPiece && j.p.t1Fail >= 4) { this.removePiece(j.p.id); j.d.id = null; }
            continue;
          }
          if (j.p.t1) this.uncalibrate(j.p.t1);
          j.p.t1 = t1;
          j.p.t1Fail = 0;
          j.p.t2 = null;
          this.calibrate(t1);
          this.touch(j.p);
          this.version++;
          n1++;
        }
      }
      if (this.box && F.still) {
        // Sections: one per live frame (they're slower), all of them in a photo.
        let ns = 0;
        for (const d of dets) {
          if (!d.id || !d.merged || d.border) continue;
          const p = this.pieces.get(d.id);
          if (!p || p.kind !== 'section' || p.sec) continue;
          if (deadline !== Infinity && (ns >= 1 || now() > deadline)) break;
          p.sec = this.placeSectionDet(d) || { failed: true };
          this.touch(p); this.version++; ns++;
        }
      }
      if (this.box) {
        // Visible pieces first, then the backlog.
        const order = [];
        for (const d of dets) if (d.id) order.push(this.pieces.get(d.id));
        for (const p of this.pieces.values()) order.push(p);
        const done = new Set();
        const cal = this.calibStats();
        for (const p of order) {
          if (done.has(p.id) || !p.t1 || p.t2 || p.kind === 'section') continue;
          done.add(p.id);
          if (n2 >= 2 && now() > deadline) break;
          p.t2 = PH.placePiece(this.box, p.t1, cal) || { cands: [], conf: 0, failed: true };
          this.touch(p);
          n2++;
        }
      }
      return { t1: n1, t2: n2 };
    }

    placeSectionDet(d) {
      const F = this.frameCtx, scale = F.scale, source = F.source;
      const [bx, by, bw, bh] = d.bbox;
      const m = Math.max(bw, bh) * 0.05;
      const x0 = Math.max(0, Math.floor((bx - m) / scale)), y0 = Math.max(0, Math.floor((by - m) / scale));
      const x1 = Math.min(source.w, Math.ceil((bx + bw + m) / scale)), y1 = Math.min(source.h, Math.ceil((by + bh + m) / scale));
      // Work at a moderate resolution: the box match runs at ~12 px per piece.
      let crop = source.getCrop(x0, y0, x1 - x0, y1 - y0);
      const pts = Array.from(d.pts, (v, i) => v / scale - (i % 2 ? y0 : x0));
      const sidePx = Math.sqrt(F.unitArea || d.area / 4) / scale / 1.05;
      try {
        return PH.placeSection(this.box, crop, pts, sidePx);
      } catch (e) { return null; }
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

    setBox(box) {
      this.box = box;
      for (const p of this.pieces.values()) { p.t2 = null; this.touch(p); }
      this.version++;
    }

    // ---------- matching / selection ----------
    skipFn() {
      return (P, Q) => P.wrong.includes(Q.id);
    }
    // opts.loops: also run the 2x2 loop check (~30 ms; done for the selected piece).
    matchesFor(id, opts) {
      const P = this.pieces.get(id);
      if (!P || !P.t1) return null;
      const c = this.matchCache.get(id);
      if (c && c.version === this.version && (c.loops || !(opts && opts.loops))) return c.res;
      const all = [...this.pieces.values()];
      const res = PH.findMatches(P, all, { topN: 5, skip: this.skipFn(), nullOdds: (k) => this.nullOdds(P, k).odds });
      for (const r of res) r.spot = this.nullOdds(P, r.edge).spot;
      if (opts && opts.loops) PH.confirmWithLoops(res, PH.findLoops(P, all, { K: 6, skip: this.skipFn() }));
      for (const r of res) if (P.joined[r.edge]) r.matches = [];
      this.matchCache.set(id, { version: this.version, res, loops: !!(opts && opts.loops) });
      return res;
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
      const cov = PH.clamp(this.pieces.size / total, 0.02, 1);
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
      if (!P) return null;
      this.selection = { id };
      this.region = null;
      this.filter = null;
      this.pairSel = null;
      return P.kind === 'section' ? this.describeSection(id) : this.describe(id);
    }
    // Loose pieces that attach to section S (by box placement).
    sectionPartners(S) {
      if (!this.box || !S.sec || !S.sec.cells) return [];
      const out = [];
      for (const P of this.pieces.values()) {
        if (P.kind === 'section') continue;
        const a = PH.sectionAttach(this.box, S.sec, P);
        if (a) out.push({ id: P.id, edges: a.edges, conf: a.conf, cell: a.cell });
      }
      return out.sort((a, b) => b.conf - a.conf);
    }
    // Sections that loose piece P attaches to.
    attachmentsOf(P) {
      if (!this.box || !P.t2) return [];
      const out = [];
      for (const S of this.pieces.values()) {
        if (S.kind !== 'section' || !S.sec || !S.sec.cells) continue;
        const a = PH.sectionAttach(this.box, S.sec, P);
        if (a) out.push({ section: S.id, edges: a.edges, located: !!S.pos });
      }
      return out;
    }
    describeSection(id) {
      const S = this.pieces.get(id);
      const sec = S.sec;
      return {
        section: true,
        piece: { id: S.id, code: null, thumb: null, t2: null, located: !!S.pos },
        status: !this.box ? 'Add a box picture to locate this section' : !sec ? 'Hold steady over this section to locate it on the box' :
          sec.failed ? 'Couldn\'t find this section on the box picture (if it is a clump of loose pieces, spread them apart)' : null,
        sec: sec && sec.cells ? { cells: sec.cells, open: sec.open, center: sec.center, score: sec.score } : null,
        partners: sec && sec.cells ? this.sectionPartners(S).map((p) => {
          const Q = this.pieces.get(p.id);
          return Object.assign(p, { thumb: Q.t1 ? Q.t1.thumb : null, corners: Q.t1 ? Q.t1.corners : null, sigs: Q.t1 ? Q.t1.edges.map((e) => e.sig) : null, located: !!Q.pos });
        }) : [],
        edges: [],
      };
    }
    // Everything the UI panel needs about a piece and its candidate partners.
    describe(id) {
      const P = this.pieces.get(id);
      const res = this.matchesFor(id, { loops: true });
      const brief = (Q) => ({ id: Q.id, code: Q.t1 ? Q.t1.code : null, thumb: Q.t1 ? Q.t1.thumb : null, corners: Q.t1 ? Q.t1.corners : null, sigs: Q.t1 ? Q.t1.edges.map((e) => e.sig) : null, t2: Q.t2 ? { cands: Q.t2.cands.slice(0, 3), conf: Q.t2.conf } : null, located: !!Q.pos });
      return {
        piece: brief(P),
        attach: this.attachmentsOf(P),
        status: !P.t1 ? 'Hold steady over this piece to read its shape' : null,
        edges: res ? res.map((r) => ({ edge: r.edge, type: r.type, joined: P.joined[r.edge], loop: r.loop, pNone: r.pNone, spot: r.spot, matches: r.matches.map((m) => Object.assign(brief(this.pieces.get(m.id)), { edgeB: m.edge, score: m.score, prob: m.prob, loopOk: !!m.loopOk, shape: m.shape, color: m.color, adj: m.adj })) })) : [],
      };
    }
    selectRegion(c0, r0, c1, r1) {
      this.selection = null;
      const ids = [];
      for (const p of this.pieces.values()) {
        if (!p.t2 || !p.t2.cands.length) continue;
        const k = p.t2.cands[0];
        if (k.col >= c0 && k.col <= c1 && k.row >= r0 && k.row <= r1 && p.t2.conf >= 0.15) ids.push(p.id);
      }
      this.region = { c0, r0, c1, r1, ids: new Set(ids) };
      return ids.length;
    }
    /** Highlight a whole class of pieces at once, with no box picture needed.
     *  'border' = at least one straight edge, 'corner' = two straight edges
     *  meeting, 'unplaced' = shape read but not found on the box picture,
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
      const out = [];
      for (const p of this.pieces.values()) {
        if (p.kind === 'section') continue;
        const f = edgeFlags(p);
        const hit = this.filter === 'corner' ? f.corner
          : this.filter === 'border' ? f.border && !f.corner
            : this.filter === 'unplaced' ? !!p.t1 && !(p.t2 && p.t2.conf >= 0.35)
              : this.filter === 'unread' ? !p.t1
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
      for (const p of this.pieces.values()) if (p.t1 && p.kind !== 'section') ids.push(p.id);
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
            loopOk: !!m.loopOk,
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

    /** Housekeeping after a messy session: fold scan groups back together by
     *  shape and drop entries that never turned out to be pieces. Returns what
     *  it changed so the UI can say so. */
    tidy() {
      const before = this.counts();
      // 1. Merge islands: a piece whose shape matches a piece in another island
      //    is the same physical piece seen after tracking broke.
      const shaped = [...this.pieces.values()].filter((p) => p.t1 && p.kind !== 'section');
      const dropped = [];
      for (let i = 0; i < shaped.length; i++) {
        const A = shaped[i];
        if (!this.pieces.has(A.id)) continue;
        for (let j = i + 1; j < shaped.length; j++) {
          const B = shaped[j];
          if (!this.pieces.has(B.id) || B.island === A.island) continue;
          if (!PH.samePiece(A.t1, B.t1, PH.SAME_SHAPE).ok) continue;
          // Keep the better-observed copy and fold the other one's evidence in.
          const keep = (A.t1.nObs || 1) >= (B.t1.nObs || 1) ? A : B, drop = keep === A ? B : A;
          keep.wrong = [...new Set(keep.wrong.concat(drop.wrong))];
          for (let k = 0; k < 4; k++) keep.joined[k] = keep.joined[k] || drop.joined[k];
          this.removePiece(drop.id);
          dropped.push(drop.id);
          if (drop === A) break;
        }
      }
      // 2. Drop never-identified leftovers: no shape, not on the table map, and
      //    repeated attempts to read them failed (glare, shadows, crumbs).
      for (const p of [...this.pieces.values()]) {
        if (p.kind === 'section') {
          if (p.sec && p.sec.failed) { this.removePiece(p.id); dropped.push(p.id); }
          continue;
        }
        if (!p.t1 && !p.pos && (p.t1Fail || 0) >= 3) { this.removePiece(p.id); dropped.push(p.id); }
      }
      this.matchCache.clear();
      this.selection = null; this.region = null; this.pairSel = null;
      return { removed: dropped.length, before, after: this.counts() };
    }

    feedback(f) {
      const A = this.pieces.get(f.a), B = this.pieces.get(f.b);
      if (!A || !B) return;
      if (f.kind === 'wrong') { A.wrong.push(B.id); B.wrong.push(A.id); }
      if (f.kind === 'joined') { A.joined[f.ka] = true; B.joined[f.kb] = true; }
      this.touch(A); this.touch(B);
      this.version++;
    }
    removePiece(id) { this.pieces.delete(id); this.dirty.add(id); this.version++; }

    // ---------- output for the overlay ----------
    output(dets, proc) {
      const inv = this.pose ? PH.simInvert(this.pose) : null;
      const byId = new Map();
      const outDets = dets.map((d) => {
        const p = d.id ? this.pieces.get(d.id) : null;
        let status = 'unknown';
        if (d.merged) status = p && p.kind === 'section' && p.sec && p.sec.cells ? 'section' : 'merged';
        else if (p) status = p.t2 && p.t2.conf >= 0.35 ? 'placed' : p.t1 ? 'shaped' : 'seen';
        if (p) byId.set(p.id, d);
        // `r` lets the page draw a marker without walking the outline at all.
        // The outline itself is simplified harder than it used to be: it is
        // only used for hit-testing a tap and for the optional outline view,
        // and every point costs a transform (a homography, with tilt on).
        return { id: d.id, status, cx: d.cx, cy: d.cy, r: Math.round(Math.sqrt(d.area || 1) / 2), pts: simplify(d.pts, this.opts.outlineEps || 2.5), border: d.border };
      });
      const hl = [];
      const locate = (id, role, extra) => {
        const d = byId.get(id);
        if (d) return hl.push(Object.assign({ id, role, x: d.cx, y: d.cy, visible: true }, extra));
        const p = this.pieces.get(id);
        if (p && p.pos && inv && p.island === this.island) {
          const f = PH.simApply(inv, p.pos[0], p.pos[1]);
          hl.push(Object.assign({ id, role, x: f[0], y: f[1], visible: false }, extra));
        }
      };
      if (this.selection && this.pieces.get(this.selection.id) && this.pieces.get(this.selection.id).kind === 'section') {
        const S = this.pieces.get(this.selection.id);
        locate(S.id, 'sel');
        for (const p of this.sectionPartners(S)) locate(p.id, 'gold', { edge: p.edges[0] });
      } else if (this.selection) {
        const sid = this.selection.id;
        locate(sid, 'sel');
        const P = this.pieces.get(sid);
        if (P) for (const a of this.attachmentsOf(P)) locate(a.section, 'section');
        const res = this.matchesFor(sid);
        // Gold only for a likely match; otherwise candidates are just "maybe".
        if (res) for (const r of res) r.matches.slice(0, 3).forEach((m, i) => locate(m.id, i === 0 && m.prob >= 0.5 ? 'gold' : 'silver', { edge: r.edge, edgeB: m.edge }));
      }
      if (this.region) for (const id of this.region.ids) locate(id, 'region');
      if (this.pairSel) {
        locate(this.pairSel.a, 'sel');
        locate(this.pairSel.b, 'gold');
      }
      if (this.filter) {
        // A class filter can match hundreds of pieces. Everything in view is
        // outlined, but only the nearest few off-screen ones get an arrow,
        // otherwise the edges of the screen fill up with clutter.
        const role = this.filter === 'corner' ? 'corner' : this.filter === 'border' ? 'border' : 'find';
        const off = [];
        for (const id of this.filterIds()) {
          if (byId.has(id)) { locate(id, role); continue; }
          const p = this.pieces.get(id);
          if (p && p.pos && inv && p.island === this.island) off.push(p);
        }
        if (off.length) {
          const c = PH.simApply(this.pose, proc.w / 2, proc.h / 2);
          off.sort((x, y) => Math.hypot(x.pos[0] - c[0], x.pos[1] - c[1]) - Math.hypot(y.pos[0] - c[0], y.pos[1] - c[1]));
          for (const p of off.slice(0, 6)) locate(p.id, role);
        }
      }
      // Auto-flag: mutual best matches among visible pieces.
      const links = [];
      const vis = [...byId.keys()].filter((id) => this.pieces.get(id).t1);
      if (vis.length <= 80) {
        let budget = 4; // fresh match computations per frame
        const best = new Map();
        for (const id of vis) {
          const c = this.matchCache.get(id);
          if (!(c && c.version === this.version) && budget-- <= 0) { if (c) best.set(id, c.res); continue; }
          best.set(id, this.matchesFor(id));
        }
        for (const [id, res] of best) for (const r of res) {
          const m = r.matches[0];
          if (!m || m.prob < 0.8 || !best.has(m.id) || id > m.id) continue;
          // Both confidently placed on the box but not side by side: not a pair.
          const P = this.pieces.get(id), Q = this.pieces.get(m.id);
          // With a box picture, wait until both are placed so it can veto the pair.
          if (this.box && (!P.t2 || !Q.t2)) continue;
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
        counts: this.counts(),
        bg: this.bg, thresh: this.thresh,
      };
    }

    // ---------- persistence ----------
    exportPiece(p) {
      return { id: p.id, kind: p.kind, sec: p.sec, fp: p.fp, area: p.area, pos: p.pos, island: p.island, t1: p.t1, t2: p.t2, wrong: p.wrong, joined: p.joined, created: p.created };
    }
    importState(state) {
      this.reset();
      for (const q of state.pieces || []) {
        const p = Object.assign({ miss: 0, t1Fail: 0, wrong: [], joined: [false, false, false, false] }, q);
        this.pieces.set(p.id, p);
        if (p.t1) this.calibrate(p.t1);
        this.nextId = Math.max(this.nextId, p.id + 1);
        if (p.island) this.nextIsland = Math.max(this.nextIsland, p.island + 1);
      }
      if (state.box) {
        this.box = state.box;
        if (!this.box.palette || !this.box.white) PH.computeCells(this.box); // boxes saved before palettes existed
      }
      this.dirty.clear();
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

  /** Flat-edge summary of a piece: how many straight edges it has, and whether
   * two of them meet (a corner piece). Edges are stored clockwise, so adjacent
   * flats are neighbours in the array. */
  function edgeFlags(p) {
    const t1 = p && p.t1;
    if (!t1 || !t1.flats) return { n: 0, border: false, corner: false };
    const f = t1.flats;
    let n = 0, corner = false;
    for (let i = 0; i < 4; i++) {
      if (!f[i]) continue;
      n++;
      if (f[(i + 1) % 4]) corner = true;
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
