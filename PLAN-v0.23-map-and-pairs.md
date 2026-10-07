# Plan v0.23 — the map stays true, joined pairs read, Find fixes

2026-10-07/08. The owner is away and can't test on the phone. Their answers
(memory: project-owner-decisions-2026-10-07):
- milestone order: the map first, then joined pairs, then Find mode;
- joined pairs: read each piece (small groups of 2–3 cut along the seam,
  the seam counted as a confirmed join; bigger assembled parts unchanged);
- publish each milestone once its full tests pass;
- small trade-offs accepted: ship when the counter video clearly gains and
  the white-board video loses at most 1–2 pieces.

How changes are judged (test/README.md): `CLOCK=model` (repeatable, phone-
paced) for single comparisons; `tools/ab.js <ref> test/real-50.js <case>
--runs 3 --clock cpu` for the spread. The map is chaotic (one different
decision early changes the whole run), so a single run never decides.

## Milestones

| Version | Milestone | State |
|---|---|---|
| 0.23.0 | The map stays true on long close-up sweeps | see below |
| 0.23.1 | Joined pairs read piece by piece | next |
| 0.23.2 | Find mode: no clump as a partner; one verdict per pair | |
| later | quality-failed close reads as agreement; shadow outlines; glass table | |

## 0.23.0 — the map stays true

Measured first (IMG_3605 key, `real-50.js` map-error line):
- On the counter video the map bends: pieces up to 5–8 piece sides from
  where the table layout puts them (median 0.6–1.8 between runs); the white
  board: median 0.4. A returning piece is matched by its map position within
  0.55 piece (`Engine.assign`), so a bent map makes new entries (duplicate
  rings) instead of finding the piece.
- The per-frame pose fit took every tracked piece that disagreed with it as
  "moved" and put it where the frame saw it: 98 times on IMG_3605 and 30 on
  IMG_3593, where nothing moved; all 0.42–1.64 piece sides. The synthetic
  moves test uses this path 0 times (moved pieces are found by their shape).
  But switching it off made the white-board map worse (the relocations also
  repair the map) - the map is chaotic: every weight from 0 to 0.75 for
  the relocation gave the same bad white-board result, only 1 the good one.

**Built:**
1. `Engine.solveMap`: every 30 frames (`PH.MAP_SOLVE_EVERY`) the last 300
   views (`PH.MAP_VIEWS`: which pieces each successful pose fit saw, where)
   are solved together - each view's similarity and each piece's position,
   alternately, 20 rounds (`PH.MAP_ITERS`), weights falling off past 0.3
   piece sides and zero past 2 (wrong links, moved pieces; a piece's views
   from before it was moved don't count). The result is fitted back onto the
   old map as a whole, so the map never jumps. `test/map-solve.js`: a map
   bent by a random walk along the sweep (median 0.33, worst 0.90 piece
   sides) comes back to 0.06 / 0.15, with 5% wrong links.
2. Pose disagreements: relocated in full only from 2 piece sides
   (`PH.MOVE_MIN`); nearer, the piece stays linked and moves a quarter of the
   way (`PH.MOVE_W` 0.25).

A/B against v0.22.2, CPU clock, 3 runs each (median [range]):

| | v0.22.2 | v0.23.0 |
|---|---|---|
| IMG_3605 pieces > 1 piece off | 10 [9–11] | 3 [2–7] |
| IMG_3605 map error median | 0.26 | 0.14 |
| IMG_3605 doubles | 2 [1–5] | 0 [0–1] |
| IMG_3605 checked | 29 [29–33] | 27 [26–33] (noise: pairs 26/29, 27/29, 33/33) |
| IMG_3605 checked at 30 s | 19 | 20 |
| IMG_3593 pieces > 1 piece off | 5 | 1 |
| IMG_3593 doubles / extras | 4 / 1 | 0 / 0 |
| IMG_3593 checked | 48 | 47 (every run: the accepted trade-off) |

Most unchecked entries on the counter video stay at "one close read" in
both versions: the next lever is reads, not the map (see "later").
