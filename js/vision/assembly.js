/* The assembled part of the puzzle, built up from close views.
 *
 * Telling a finished border from any other strip needs the whole thing in
 * view, but reading which spots are open needs the phone close. So the
 * assembled block is built up as a grid of piece cells while the phone
 * follows it: every steady view's grid (PH.sectionSpots) is lined up with
 * what is known so far by its overlap - which cells are filled or empty, and
 * the print in them - and its cells are added in. No loose pieces need to be
 * in view to keep the place. Once enough is known, the whole assembly is put
 * on the box picture (PH.placeOnBox), which names every cell: where the
 * border is, how much of it is done, which spots are open and what fits them.
 *
 * Cells are keyed "i,j" in the assembly's own grid (the first view's
 * orientation). Each keeps filled/empty votes, the running mean of its 6x6
 * lightness patch, and votes for the type (T/B/F) of each side that faced an
 * empty cell. Sides: 0 up, 1 right, 2 down, 3 left. */
(function (G) {
  const PH = G.PH;
  const PS = 6, NP = PS * PS;
  const D4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const key = (i, j) => i + ',' + j;

  class Assembly {
    constructor(id) {
      this.id = id;
      this.cells = new Map();
      this.views = 0;
      this.place = null; // box placement: {k, oc, or, score, margin, n}
      this.placeAt = 0;
      this.version = 0;
    }
    cell(i, j, make) {
      const k = key(i, j);
      let c = this.cells.get(k);
      if (!c && make) { c = { i, j, f: 0, e: 0, patch: null, pn: 0, sides: [null, null, null, null] }; this.cells.set(k, c); }
      return c;
    }
    filled(c) { return !!c && c.f > c.e; }
    emptyCell(c) { return !!c && c.e > c.f; }
    /**
     * Line a frame grid up with this assembly. `fc` = frame cells
     * [{i,j,filled,patch(36)|null}]. Tries every turn k and shift (around
     * `near` = {k, di, dj} first if given) and scores the overlap: filled /
     * empty agreement and the print correlation of cells filled in both.
     * `near` = predicted shift per turn ([{di,dj}] x4, from the last view):
     * only a few cells around it are tried; without it, every overlap.
     * @returns {k, di, dj, corr, agree, n} or null
     */
    register(fc, near) {
      if (!this.cells.size) return null;
      let ai0 = Infinity, aj0 = Infinity, ai1 = -Infinity, aj1 = -Infinity;
      for (const c of this.cells.values()) { ai0 = Math.min(ai0, c.i); aj0 = Math.min(aj0, c.j); ai1 = Math.max(ai1, c.i); aj1 = Math.max(aj1, c.j); }
      let best = null;
      const tryOne = (k, di, dj, rc, sIdx) => {
        let agree = 0, dis = 0, n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
        for (let q = 0; q < fc.length; q++) {
          const a = this.cells.get(key(rc[q][0] + di, rc[q][1] + dj));
          if (!a || a.f === a.e) continue;
          const af = a.f > a.e, f = fc[q];
          if (af === f.filled) agree++; else dis++;
          if (af && f.filled && a.patch && f.patch) {
            n++;
            const pa = a.patch, inv = 1 / a.pn;
            for (let t = 0; t < NP; t++) { const x = f.patch[sIdx[t]], y = pa[t] * inv; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; m++; }
          }
        }
        if (n < 4 || agree + dis < 6) return;
        const vx = sxx - (sx * sx) / m, vy = syy - (sy * sy) / m;
        const corr = vx > 0 && vy > 0 ? (sxy - (sx * sy) / m) / Math.sqrt(vx * vy) : 0;
        const ag = agree / (agree + dis);
        const score = corr * ag + 0.002 * n;
        if (!best || score > best.score) best = { k, di, dj, corr, agree: ag, n, score };
      };
      for (let k = 0; k < 4; k++) {
        const rc = fc.map((c) => PH.rotCell(k, c.i, c.j)), sIdx = PH.patchTurn(k);
        let fi0 = Infinity, fj0 = Infinity, fi1 = -Infinity, fj1 = -Infinity;
        for (const [a, b] of rc) { fi0 = Math.min(fi0, a); fj0 = Math.min(fj0, b); fi1 = Math.max(fi1, a); fj1 = Math.max(fj1, b); }
        if (near) {
          const q = near[k];
          for (let dj = q.dj - 3; dj <= q.dj + 3; dj++) for (let di = q.di - 3; di <= q.di + 3; di++) tryOne(k, di, dj, rc, sIdx);
        } else {
          for (let dj = aj0 - fj1; dj <= aj1 - fj0; dj++) for (let di = ai0 - fi1; di <= ai1 - fi0; di++) tryOne(k, di, dj, rc, sIdx);
        }
      }
      return best;
    }
    /** Add a lined-up frame's cells (turn k, shift di,dj). `sides` = frame
     *  side readings Map "i,j" -> [T|B|F|null x4] of its filled cells. */
    add(fc, sides, k, di, dj) {
      const sIdx = PH.patchTurn(k);
      for (const f of fc) {
        const [a, b] = PH.rotCell(k, f.i, f.j);
        const c = this.cell(a + di, b + dj, true);
        if (f.filled) {
          c.f++;
          if (f.patch) {
            if (!c.patch) c.patch = new Float32Array(NP);
            // a running sum, capped so later (closer, steadier) views still count
            if (c.pn >= 12) { for (let t = 0; t < NP; t++) c.patch[t] *= 11 / 12; c.pn = 11; }
            for (let t = 0; t < NP; t++) c.patch[t] += f.patch[sIdx[t]];
            c.pn++;
          }
          const sd = sides && sides.get(f.i + ',' + f.j);
          if (sd) sd.forEach((t, d) => {
            if (!t) return;
            const dd = (d + k) % 4, v = c.sides[dd] || (c.sides[dd] = { T: 0, B: 0, F: 0 });
            v[t]++;
          });
        } else c.e++;
      }
      this.views++;
      this.version++;
    }
    sideType(c, d) {
      const v = c && c.sides[d];
      if (!v) return '?';
      const n = v.T + v.B + v.F;
      if (v.T > v.B && v.T > v.F && v.T >= n * 0.6) return 'T';
      if (v.B > v.T && v.B > v.F && v.B >= n * 0.6) return 'B';
      if (v.F >= n * 0.7 && n >= 2) return 'F';
      return '?';
    }
    /** Filled cells with a mean patch, for box placement. */
    placeInput() {
      const cells = [], X = [], flats = [];
      for (const c of this.cells.values()) {
        if (!this.filled(c) || !c.patch) continue;
        cells.push([c.i, c.j]);
        for (let t = 0; t < NP; t++) X.push(c.patch[t] / c.pn);
        for (let d = 0; d < 4; d++) if (this.sideType(c, d) === 'F') flats.push([c.i, c.j, d]);
      }
      return { cells, X: Float32Array.from(X), flats };
    }
    /** Put the assembly on the box picture (when it has grown since). */
    locate(box, force) {
      if (!box) return this.place;
      if (!force && this.place && this.version - this.placeAt < 4) return this.place;
      this.placeAt = this.version;
      const inp = this.placeInput();
      if (inp.cells.length < 6) return (this.place = null);
      const p = PH.placeOnBox(box, inp.cells, inp.X, inp.flats);
      // a clear winner, or a strong one (right placements scored 0.3-0.6
      // with margins of 0.1-0.35 on synthetic blocks; wrong ones trail)
      const ok = p && ((p.score >= 0.3 && p.margin >= 0.08) || (p.score >= 0.45 && p.margin >= 0.04));
      this.place = ok ? { k: p.k, oc: p.oc, or: p.or, score: +p.score.toFixed(3), margin: +p.margin.toFixed(3), n: p.n } : null;
      return this.place;
    }
    cellOf(i, j) {
      const p = this.place;
      if (!p) return null;
      const [a, b] = PH.rotCell(p.k, i, j);
      return [a + p.oc, b + p.or];
    }
    /** Open spots: empty cells next to filled ones, with what the missing
     *  piece needs on each side (assembly directions) and its box cell. */
    spots(box) {
      const out = [];
      for (const c of this.cells.values()) {
        if (!this.emptyCell(c)) continue;
        const need = ['?', '?', '?', '?'];
        let n = 0;
        for (let d = 0; d < 4; d++) {
          const nb = this.cell(c.i + D4[d][0], c.j + D4[d][1]);
          if (!this.filled(nb)) continue;
          n++;
          const t = this.sideType(nb, (d + 2) % 4);
          need[d] = t === 'T' ? 'B' : t === 'B' ? 'T' : '?';
        }
        if (!n) continue;
        let cell = null;
        if (this.place && box) {
          cell = this.cellOf(c.i, c.j);
          if (cell[0] < 0 || cell[1] < 0 || cell[0] >= box.cols || cell[1] >= box.rows) continue; // beyond the puzzle's edge
        }
        out.push({ i: c.i, j: c.j, n, need, cell });
      }
      return out;
    }
    /** Border progress once placed: border cells of the box filled here. */
    borderStatus(box) {
      if (!this.place || !box) return null;
      const filled = new Set();
      for (const c of this.cells.values()) if (this.filled(c)) { const [a, b] = this.cellOf(c.i, c.j); filled.add(b * box.cols + a); }
      let total = 0, done = 0, inside = 0;
      for (let r = 0; r < box.rows; r++) for (let q = 0; q < box.cols; q++) {
        const on = filled.has(r * box.cols + q);
        if (r === 0 || q === 0 || r === box.rows - 1 || q === box.cols - 1) { total++; if (on) done++; } else if (on) inside++;
      }
      return { total, done, inside, cells: filled.size };
    }
    filledBoxCells(box) {
      const out = new Set();
      if (!this.place || !box) return out;
      for (const c of this.cells.values()) if (this.filled(c)) { const [a, b] = this.cellOf(c.i, c.j); if (a >= 0 && b >= 0 && a < box.cols && b < box.rows) out.add(b * box.cols + a); }
      return out;
    }
    toJSON() {
      return { id: this.id, views: this.views, place: this.place, tab: this.tab && this.tab.T ? { island: this.tab.island, T: this.tab.T } : null,
        cells: [...this.cells.values()].map((c) => ({ i: c.i, j: c.j, f: c.f, e: c.e, pn: c.pn, patch: c.patch ? Array.from(c.patch, (v) => Math.round(v)) : null, sides: c.sides })) };
    }
    static fromJSON(o) {
      const A = new Assembly(o.id);
      A.views = o.views || 0; A.place = o.place || null;
      A.tab = o.tab ? { island: o.tab.island, T: o.tab.T, pairs: [] } : null; // where it lies on the table map
      for (const c of o.cells || []) A.cells.set(key(c.i, c.j), { i: c.i, j: c.j, f: c.f, e: c.e, pn: c.pn, patch: c.patch ? Float32Array.from(c.patch) : null, sides: c.sides || [null, null, null, null] });
      return A;
    }
  }
  PH.Assembly = Assembly;
})(typeof self !== 'undefined' ? self : globalThis);
