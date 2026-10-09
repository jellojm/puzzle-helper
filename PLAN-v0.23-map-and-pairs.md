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

## For the next agent

Live: v0.23.4 (tags v0.22.0-v0.23.4). Start with `test/README.md` (clocks,
results history, `tools/ab.js`, `tools/trend.js`) and the milestone table.
Owner decisions and constraints: memory files project-owner-decisions-2026-10-07,
project-no-phone-reviews, feedback-no-environment-changes. Known at phone
pace (`CLOCK=model`), not yet fixed: run-tests "live sweep" catalogues 87/96,
table-view "every read piece has a placement" fails - read pieces may lack a
Map picture on the phone.

Since v0.23.3 (2026-10-08): judge changes at phone pace (`CLOCK=model`,
several phone speeds: `model:0.65/0.8/1/1.25`, plus a `cpu` run) and sum
them - single runs of IMG_3605 swing by 5-8 matched. Three experiments
are in the code, off, each with its numbers below: `PH.MOVE_PROOF`,
`PH.MOVE_CLAIM` (far re-finds), `PH.READ_RETRY`. The most promising open
lead: far re-finds are right about half the time - something that tells a
drift correction from a look-alike would fix both videos' map jumps.

## Milestones

| Version | Milestone | State |
|---|---|---|
| 0.23.0 | The map stays true on long close-up sweeps | published |
| 0.23.1 | Joined pairs read piece by piece (photos) | published |
| 0.23.2 | Find mode: a clumped partner drawn as itself; one verdict per pair | published |
| 0.23.3 | Cheaper reads at the phone's pace (same results); real pieces no longer dropped after one failed read | published |
| - | Close-up reads that failed only the quality floor count as agreement | dropped: they agree 1 in 10 (IMG_3605, model clock; accepted reads 65-88%) |
| - | Live reads at a capped resolution | not shipped: helps the phone model, costs edge codes (see below) |
| 0.23.4 | No more engine crashes on the oak table; one good read checks a piece; less work on still views; camera off after a report; tests that don't flake | published |
| - | Proof before a far re-find (`PH.MOVE_PROOF`), or a claim settled at the old spot (`PH.MOVE_CLAIM`) | not shipped: fix IMG_3593's jump, trade IMG_3605's jumps for extras (see below) |
| - | A failing colour-only read retried with the outline (`PH.READ_RETRY`) | not shipped: IMG_3605 worse (see below) |
| later | IMG_3627's third piece: `photoFit` picks a segmentation without it; far re-finds that tell a drift correction from a look-alike; false "assembled part" on IMG_3593 at PC pace; seam cut on live frames; seam edge read round the tab; Map placements at phone pace; shadow outlines (IMG_3627); glass table (IMG_3609) | |

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

## 0.23.1 — joined pairs read piece by piece (photos)

Owner: small joined groups are read as separate pieces, the seam counting as
a confirmed join. The pairs in IMG_3621 (1.58 pieces' area) and IMG_3622
(~2) were never cut: the notch, corner and distance cuts need a gap or a
neck, and a joined pair has neither.

**Built:** `PH.splitSeam` - the seam as the cheapest path across the clump
(Dijkstra) between two outline points (notches, and points every 0.3 piece
side: pieces pushed flush meet the outline without a notch), through
"lineness" (black-hat and a Hessian ridge of the lightness, each against
its own 98th percentile in the clump), never hugging the outline; searched
at ~110 px a side. Among the 12 cheapest paths the one whose parts look
most like pieces wins; a cut is taken only when every part is 0.55-1.6
pieces and piece-shaped (single pieces were never cut on any photo). For
clumps of 1.35-3.2 pieces left unsplit, **photos only** (0.1-1 s a clump on
the PC: too slow for live frames on the phone).

The path often takes a straight line across a tab's neck instead of round
the tab (the seam round a tab is faint against busy print), so the edge
along the cut is unreliable: `Engine.markSeamEdge` types it 'J' - never
flat (no false border piece), never matched - and the pair is recorded as
joined on those edges (`feedback` with `source: 'seam'`, kept out of the
answer statistics). The other three edges read normally.

Labelled photos: known-weak pieces read 16 -> 20 of 21 (IMG_3621 2 -> 4,
IMG_3622 2 -> 4); join sides measured 22 -> 30, top 3 11 -> 14 (first 9 ->
8). Main photo checks unchanged.

Next for joined pairs: live frames (budget: one clump per still frame), and
following the seam round the tab (a better line detector at the seam's own
scale) so the seam edge can be read too.

## 0.23.2 — Find mode tells the truth

From the owner's screenshots of 2026-10-07:
- **IMG_3630**: a suggested partner was shaded as a two-piece clump. A piece
  that touches another is linked to the clump's detection, and the overlay
  shades a piece by its detection. Now `Engine.output` gives the clump no
  piece number and adds the piece's own outline (its read placement in this
  view, else a ring at its map spot, status `inClump`); the overlay draws it
  only when highlighted, taps hit it, and the page says once: "Piece #N is
  touching another piece - nudge them apart so it can be read on its own."
- **IMG_3631** "Strong match 70%": the pairs list showed the lower of the
  two sides' probabilities with ONE side's word. Now the weaker side's word
  (`PH.weakerVerdict`): no pair is "strong" under 85%.

`test/find-mode.js`: 45 synthetic pairs, none with the other side's word,
none strong under 85%; a clump is unnumbered and the piece in it is drawn
where the map puts it, highlighted, marked as in a clump.

## Not shipped — live reads at a capped resolution

`real-50.js` with `CLOCK=model` now also **skips frames that arrive while
the engine is busy**, as the phone does (the page sends the newest frame
only when the worker is free). That changed the picture: at the phone's
own costs (its reports: ~85 ms a segmentation pass, ~170 ms to read a
~350 px close-up piece) IMG_3593 skipped 120 of 412 frames, its first piece
was checked at 11 s instead of 5 s, and 21 at 30 s instead of 35 - the
owner's "pieces took a while to read". A bigger frame budget made it worse
(more reads a frame, fewer frames: 45 ms stays).

Reading a big piece from a smaller crop (`PH.READ_SIDE_LIVE`, side 140 px,
live frames only - photos keep full resolution, where it cost accuracy):

| phone speed vs estimate | IMG_3605 checked | IMG_3593 checked | IMG_3593 at 30 s | IMG_3593 codes |
|---|---|---|---|---|
| x0.8 | 23 -> 31 | 44 -> 47 | 23 -> 35 | 44 -> 46 |
| x1.0 | 20 -> 27 | 48 -> 46 | 21 -> 34 | 48 -> 45 |
| x1.25 | 7 -> 19 | 44 -> 42 | 12 -> 21 | 43 -> 35 |

Frames skipped at x1.0: 180 -> 39 (counter), 120 -> 9 (white board).
The trade-off (accepted by the owner for checked counts): on the white
board 2 fewer checked at the end and 3 fewer edge codes right at the
estimated phone speed - more (8 codes) if the phone is slower than
estimated. Caps 160-260 were tried too (results jump between caps: the map
is chaotic); 140 and 160 were the best pair.

Next here: get the codes back - e.g. re-read a checked piece at full
resolution when a frame has time to spare, or keep the sharpest close read
per edge.

**Decision: not shipped.** At PC pace (`CLOCK=cpu`) the fixed cap fails the
IMG_3593 floors (key pieces matched 43 < 45, codes 42 < 45; 17 entries left
unchecked) and marks a piece gone on IMG_3605. An adaptive form (cap only
while the median of the last 8 frame times is over `PH.BEHIND_MS` 200 ms,
off under half of it) keeps the PC floors (47 checked, 46 codes) but at
phone pace it toggles and helps less than the fixed cap (IMG_3605 26 / 22 /
21 at x1 / x0.8 / x1.25; IMG_3593 45 / 45 / 34). Code, `Engine.behind` and
`PH.READ_SIDE_LIVE` are kept, off. The phone-paced harness (frames skipped
while busy) stays: it is the closest the tests get to the owner's phone.
The lever left: a cheaper full-resolution read (profile `PH.analyzePiece`).

## 0.23.3 — the same reads, at less than half the cost

The lever the capped reads pointed at. Profiled `PH.analyzePiece` over the
owner's photos (the phone's SIMD OpenCV build, in node): **25.3 -> 10.3 ms a
read (0.41)**, every read on every photo test identical (real-joins metrics,
edge-verify, open-spots, border-auto, seam-split: old vs new outputs diffed).

- the whole crop's Laplacian variance (`t1.sharp`) was a third of the time
  and read by nothing (`quality.sharp`, the outline's own, is what's used);
- the read's outline hint grown by a 25-35 px disc (`cv.dilate`, a quarter
  of the time) and the seam check's ~50 px erosion: `PH.dilateDisc` /
  `PH.erodeDisc` grow each row's runs by the kernel's half-width at each row
  offset - pixel for pixel cv.dilate / cv.erode (`test/dilate-disc.js`, 120
  random masks), 0.2 vs 1.5-8 ms;
- live segmentation 0.8 of its time: medians of Lab bytes counted instead of
  sorted (`PH.median` on 0-255 integers, `PH.localWhite`): identical values
  (20 000 random arrays; 3000 random localWhite cases).

`CLOCK=model` now charges reads 0.41 and segmentation 0.8 of the reports'
costs (`MODEL_READ=2.44 MODEL_SEG=1.25` = before).

Two things the faster engine showed:

- **Real pieces dropped after one failed read.** The read back-off counts
  the frames a failed piece waits in `t1Fail`, so the "6 failed reads and 20
  sightings: not a piece" rule fired after one failed read - before the
  retry (at 8). Their numbers changed when they came back. Now
  `p.readFails` (real failures), `PH.DROP_READ_FAILS` 3.
- **The "hold still" baseline** was the last 40 close reads; at the new
  read rate a blurred spell filled it and became "usual" (quality-gate
  failed at PC pace). `PH.SHARP_HIST` 100: the same span of time.

And one in the test: the key fit (`test/keymatch.js`) by position alone
turned the near-symmetric 5x10 key half round when two rows lost identity
(scored "40/50, 9 extra" for a map that was right: median 0.05 off). It now
starts from the pieces followed by identity.

Old engine (each at its own cost) vs new, `RESULTS=0`, 2026-10-08:

| | v0.23.2 | v0.23.3 |
|---|---|---|
| phone pace, IMG_3593 checked at 30 s | 21 | 38 |
| phone pace, IMG_3593 matched / codes / doubles | 48 / 48 / 4 | 48 / 47 / 2 |
| phone pace, IMG_3593 frames skipped | 120 | 4 |
| phone pace, IMG_3605 checked / at 30 s | 19 / 10 | 29 / 19 |
| phone pace, IMG_3605 matched / extra | 15 / 4 | 27 / 2 |
| phone pace, IMG_3605 frames skipped | 178 | 17 |
| PC pace (3 runs), IMG_3593 at 30 s / codes | 36 / 47-48 | 38 / 47 |
| PC pace (3 runs), IMG_3605 matched / extra | 23-24 / 5-8 | 24-26 / 2-7 |

At PC pace both engines show, about 1 run in 3, an "assembled part" on the
loose pieces of IMG_3593 and a piece marked gone on IMG_3605 - not new, not
seen at phone pace (also not at x0.25-x0.5 phone cost); next to look at.
`READ_SIDE_LIVE` stays off: at full resolution the phone now skips few frames.

## Not shipped — proof before a far re-find

Where counter-video pieces jump 4-15 pieces on the map (`MISSDBG=1` lists
each piece off the key's fit with its offset over time): every jump is a
**re-find** - a close read of a new entry matched a checked piece far away
("it was moved here"), only allowed when that piece's own spot is not in
view with something on it. No piece is moved in either video.

`PH.MOVE_PROOF` (kept, off): a far re-find also needs proof the piece left -
marked gone, or its spot in view and bare. Five settings per video (phone
pace x1 / x0.8 / x1.25, PC pace x2), summed:

| | off | on |
|---|---|---|
| IMG_3605 pieces > 1 off (worst) | 31 (22.2) | 14 (9.6) |
| IMG_3605 matched / extra | 140 / 18 | 132 / 35 |
| IMG_3593 the 12-piece jump | every run | never |
| IMG_3593 matched; doubles at PC pace | 239; 0 | 240; 6 |

Checked against the key (`MISSDBG` classifies each re-find): about half
the far re-finds put a piece on its **true** place (IMG_3605 at x0.8: 5
right, 7 wrong) - a drifted entry corrected, often one an earlier wrong
re-find had moved. Blocked, the drifted entry stays and the piece gets a
second one: as many extras as jumps saved. Next: tell the two apart -
e.g. hold a far claim until the old spot is seen (bare: move; taken: the
new entry is a look-alike and may not claim that piece again).

Also from this work:
- `real-50.js` "nothing marked gone" now counts **key pieces** only (a key
  piece's own entry hidden); a stray entry hidden because its spot is bare
  is reported, not failed (IMG_3605: an entry 1.4 off a piece whose own
  entry sat elsewhere).
- The false "assembled part" on IMG_3593 (PC pace only, ~1 run in 3, old
  and new engines): the owner lays the 50 pieces in rows with small gaps;
  touching neighbours merge into ~10-piece blobs that grid like a block
  (10 filled of 49 cells). A "seams joined" share didn't separate them: the
  blob mask closes the gaps (real parts 0.92-1.00, these >= 0.9 too). A
  test of the board colour along the seams is the next idea.

Tried next, `PH.MOVE_CLAIM` (kept, off): an unproven far match becomes a
**claim** on the checked piece; the claimed piece's spot is re-read
(priority) and settles it - bare, or a clearly different piece there: moved
(the claimant merges in, same number); the same piece there: the claimant
is a look-alike and may never claim it again (`Engine.settleClaim`). Five
settings per video (phone pace x0.65 / x0.8 / x1 / x1.25, PC pace), summed:

| | off | on |
|---|---|---|
| IMG_3593 sum of worst offsets | 54.2 | 4.8 |
| IMG_3593 matched / doubles | 240 / 2 | 240 / 8 |
| IMG_3605 pieces > 1 off | 40 | 31 |
| IMG_3605 matched / extra / doubles | 128 / 25 / 7 | 129 / 41 / 0 |

Few claims settle (13-15 a run, 1 refused): the claimed piece's own spot is
seldom read close again, so the claimant lives on as a second entry - the
same trade as above. Both rules fix the board video; neither is a clear gain
on the counter. What would: getting the old spot looked at (a "look here"
hint is a phone-side change the owner would have to try), or a way to tell
a drift correction from a look-alike by the map itself (does the claimant's
neighbourhood match the claimed piece's?).

## Not shipped — a failing read retried with the outline (IMG_3627)

IMG_3627's third piece is not lost to its shadow (as the v0.22 notes
guessed): its **colour outline cuts along the print** - the pale grey hull
matches the cream counter - and still passes as piece-sized (0.83), so the
outline rescue never runs; the corner score (0.028 < 0.03) then calls it
"not a piece". `PH.READ_RETRY` (kept, off): such a read is tried once more
with the outline channel - the piece then reads whole (corner score 0.27).

Two findings:
- In the photo it still doesn't count: `photoFit` judges segmentations by
  their blobs' shape scores; with that piece's blob cut short (score 0.03)
  it picks another background model, where the piece isn't a blob of its
  own. Next: let `photoFit` count read pieces, not blob scores.
- On the videos the retry hurts IMG_3605 (5 settings: matched 133 -> 122,
  pieces > 1 off 39 -> 48; IMG_3593 unchanged): there the outline channel
  takes in the lamp shadows, and the extra reads are poor. A retry would
  need the shadow peel on the outline too.

## 0.23.4 — the crash, "one good read", less work, steady tests

Owner, 2026-10-08 (reports 03-33/03-34/03-39, videos IMG_3635 white counter
and IMG_3636 oak herringbone table): "still drops pieces when zoomed out and
is losing track of so much ... not many matches"; "a good scan should be
everything we need ... drop the multiple pass rule if the first pass was
good ... reduce heavy compute"; "the camera should be switched off right
after snapshots are taken"; "testing should not be flaky".

- **Crash.** The oak report: two "Out of bounds memory access" traps,
  each restarting the vision worker (tracking lost, new scan groups -
  13 by the end). Replayed in node on our SIMD build (`OPENCV=simd`,
  `real-50.js 3636`): 6 of 6 runs crash (v0.23.2 too; also with the heap
  grown to 400 MB first - not memory growth); the CDN build 0 of 2. Our
  build rebuilt with Emscripten 3.1.74 (was 3.1.45): 0 of 3 crashes over
  the whole video, and ~10% faster (segmentation 41-50 vs 49-55 ms). The
  single call that trapped does not trap alone: state-dependent. **Not
  proven gone**: a JS-side misuse that a different allocator layout hides
  is still possible (next: a SAFE_HEAP debug build, replay IMG_3636).
  Shipped as `vendor/opencv-4.10.0-simd-em3174.js` (new name: no cache
  serves the old one); build script `C:/Users/jmott/dev/build-opencv-simd-3174.sh`.
- **Resume after a restart**: the worker saves the pose, scan group, piece
  size and background model when it retires; a fresh engine within 15 s
  starts from them. (e2e's new check passes, but also passes without the
  resume - its video re-finds its place anyway: unproven on the phone.)
- **One good read** (`PH.ONE_READ_Q` 0.6): a close read of quality >= 0.6
  checks a piece alone (still with 4 sightings at 2 moments). IMG_3593
  against the key: such reads right 115 of 116, first reads 32 of 32. Five
  settings per video, summed: IMG_3593 checked at 30 s 181 -> 201, first at
  5.0 -> 4.2 s, matched 239 = 239, codes 235 = 235; IMG_3605 at 30 s
  90 -> 119, matched 132 -> 138, extras 23 -> 34 (one run 40 checked of 38).
- **Less work on still views** (main.js `viewSettled`, `SETTLED_GAP`): the
  phone spent 45-82% of its time on still frames that read nothing new.
  Nothing changing for 6 results and nothing in view left to check -> a
  frame every 2 s; a 3% camera move wakes it at once. (Not measurable in
  node; e2e passes.)
- **No assembled part over checked loose pieces** (`PH.ASM_LOOSE_VETO`): a
  big blob over 2+ checked loose pieces' spots is those pieces touching
  (oak table: 3 phantom parts). Removes the false "assembled part" (oak, and
  the IMG_3593 PC-pace one); the search is still ~1/3 of an oak frame -
  next: why (hi-res pass, puzzleLike) on loose tables.
- **Report**: the camera stays on only for the snapshot, then off until
  Resume (e2e check).
- **Tests that don't flake**: e2e checks waited fixed times and then
  sampled once - under load the report took > 4 s ("no JSON"), and the tilt
  tap found only the 25 border pieces (counted "in the puzzle" once the
  border was marked) in view. All fixed sleeps before checks are now
  condition waits; "2 possible fits" is a verdict the check now knows;
  table-view's "> 30 read" edge (30-31 on a busy PC) is a floor of 25.
  e2e 41/41 in 5 runs under heavy load.
- `real-50.js`: cases 3635/3636 (no keys yet), `OPENCV=simd|<file>`,
  `HEAPLOG`, `STAGES`, `MISSDBG`, `ASMDBG`.

Direction review (fable subagent, 2026-10-08), next in order:
1. **Far views**: zoomed out, checked pieces are drawn as "scan closer"
   rings - the oak report's last frame: 35 detections, 10 linked, 17 rings;
   pieces ~20 px. Link far views as a whole (pose from inliers, then match
   piece-sized blobs to map spots within ~0.8 piece) and draw checked pieces
   at their map spots.
2. **Few matches**: shown pairs need both pieces checked, mutual top-1 and
   min(prob) >= 0.8; without a box picture `totalPieces` defaults to 1000
   (the owner's typed count should be used); 17 of 28 true join sides are
   near-ties. Measure the gate on real-joins before changing it.
3. The oak table itself: 7 checked at 30 s (IMG_3636).

## After 0.23.4 — measured, not shipped (2026-10-08)

- **Far views shown as their pieces** (`PH.FAR_SHOW`, off): a far detection
  left unlinked, whose map spot (neighbour-corrected) is its mutual nearest
  within 0.85 piece, drawn as that piece (display only). Rings ("scan
  closer") on still frames: IMG_3593 38.8 -> 38.0%, IMG_3605 46.1 -> 45.3%,
  IMG_3636 90.9 -> 90.7% - most rings are not known pieces in reach. Too
  little for the risk. (`real-50` now prints the ring share.)
- **Few matches - the gate measured** (`GATE=1 node test/real-joins.js`,
  one photo per physical piece, 65 pieces, 14 labelled joins): the Matches
  list (mutual first both ways, prob >= 0.8 both ways) shows **1 of 14**
  true joins; 10 of 14 ARE mutual first both ways, but at prob 0.2-0.6.
  The puzzle-size prior (`nullOdds`, 1000 without a box) changes nothing
  here. The probability doesn't separate them: among mutual-first pairs,
  true 10 (prob 0-.2/.2-.4/.4-.6/.6-.8/.8-1: 0/5/3/1/1), others 37
  (3/16/8/4/6) - some of the others may be unlabelled true joins. A lower
  bar shows more true joins and more others with them: the owner's call
  (e.g. a second "worth trying" list of mutual-first pairs).
  **Caveat (direction review, 2026-10-08): this measured the raw softmax
  (`findMatches` pSoft), not the app's calibrated prob (`calibrateMatches`:
  logistic over `CALIB_PRIOR`, +2.83 for mutual, +2.28 for lead) - so "1 of
  14" understates the phone's list; near-ties (17 of 28 sides) still can't
  reach 0.8. And "others 37" includes the weak layouts' labelled joins
  (IMG_3620-3627). Re-measure with the calibration and those joins before
  deciding.**
- **The oak table (IMG_3636)**: `real-50` used a default box picture of
  another puzzle; its "palette" model made the grain stripes into blobs
  (cases 3635/3636 now run without a box, as the owner's session did).
  Without it: the colour model cuts pieces short wherever their print is
  wood-coloured (dark/brown edges lost) - 7-9 checked at 30 s, rings
  78-84%. The outline rescue can't work there: the grain closes into rings
  (its fill was already rejected by the 30% guard). Board texture measured
  per frame (`seg_boardEdge`: share of background pixels on lightness edges
  - boards/counters p90 0.02-0.05, oak p50 0.40); above `PH.BOARD_TEXTURED`
  0.15 the outline fill is skipped (no change in results; saves the work).
  A textured board needs its own segmentation (e.g. outlines with the
  grain's orientation suppressed, or taught wood colours) - a bigger job.

## 0.23.5 — for the owner's phone test (2026-10-08 evening)

Same engine as 0.23.4 plus: the outline fill is skipped on a textured board
(`PH.BOARD_TEXTURED`; no change in results, saves work), `farShow` kept off;
tests: `run-tests.js` on the deterministic step clock by default (its live
sweep needed 91 of 96 and caught 89 once on a busy PC), real-50 cases
3635/3636 without a stray box picture, `MAXT`/`SNAPAT`/`EDGESTAT`, real-joins
`GATE=1`.

Next (direction review 2): re-measure the Matches gate with the app's
calibration, then a "worth trying" tier of mutual-first pairs; for the oak
table first allow the `edges` / `colors` models when the board is textured
(`bgCandidates` skips `edges` on "plainish" boards), then a grain-coherence
board mask if needed; an IMG_3636 key before scoring segmentation work;
rings measured on the last third of a video, by cause.


## The Matches gate re-measured with the app's calibration (2026-10-08, late)

`GATE=cal node test/real-joins.js`: an engine holding the 65-piece pool as
checked pieces, its own calibrated probabilities (`matchesFor` ->
`calibrateMatches`) and the Matches list's own gate (`Engine.scanPairs`),
with the known-weak photos' labelled joins counted as true (27 joins, 14
from the main photos). Puzzle size 65 / 300 / 1000 gives the same picture:

| minProb | true joins shown (of 27) | others shown | precision |
|---|---|---|---|
| 0.8 (now) | 0 | 2 | 0.00 |
| 0.65 | 2 | 6 | 0.25 |
| 0.5 | 7 | 19 | 0.27 |
| 0.35 | 10-11 | 31 | 0.24-0.26 |

Mutual-first pairs: true 13 (calibrated prob 0-.2/.2-.4/.4-.6/.6-.8/.8-1:
1/2/7/3/0), others 36-39 (4/2-6/22/6/2). The calibration does not separate
them either - the gate is not the problem, discrimination is. A "worth
trying" tier at any bar shows ~3 wrong pairs per right one. (Photos are
single reads: the `confirmed` feature is off for all; on the phone shapes
are confirmed and probabilities a little higher, the overlap the same.)
Not shipped. Next lever for matches: what separates a true join from a
look-alike (the 17 of 28 near-ties) - e.g. both edges' full outline incl.
the corners' angles, colour along the seam at higher resolution, or the
pocket/loop evidence (v0.21.3) once the owner joins pieces.

## 0.23.6 / 0.23.7 — flashlight, box photo memory (2026-10-09)

- **0.23.6 Flashlight wouldn't turn off** (owner). The worker reads frames
  from its own copy of the camera track; a copy keeps the torch setting it
  was made with. After any flashlight change the worker gets a fresh copy;
  it now stops old copies (they were only cancelled: every camera reopen
  left one running). Needs the phone to confirm.
- **0.23.7 Engine restart while setting the box** (report 01-21-54:
  "vision restart (heap) in boxCorners: 660.9 MB"). `boxCorners` and `box`
  copied the full 12 MP photo (~49 MB) into vision memory, which never
  shrinks. Now the photo goes in at 1280 px for the corner guess and at
  max(2048 px, 48 px a piece) for the box picture (24 px a piece); srcPx is
  still reported at the photo's own resolution.
- Measured on the way (not shipped): the outline model on the oak table -
  already offered there (no colour dominates the grain) and it scores 0-2
  good pieces; `CLOCK=model` runs are repeatable only when run one at a
  time (the engine still reads `Date.now()` in ~11 places: two runs at
  once gave 0 vs 7 checked at 30 s on IMG_3636).
- **0.23.8 Lens angle** (owner: "the angle in the settings seems
  incorrect"; the latest report had it at 60 deg, the one measurement in
  the reports read 98.9 deg from 4 readings). An XR's 1x camera is ~67 deg
  across the long side (4.25 mm on a ~5.65 mm-wide sensor; 26 mm equiv.),
  so the 66 deg default is right. The measurement took the median of single
  tracker steps (a pixel or two of the 96 px thumbnail over one instant gyro
  rate). Now `PH.fovFromSeries`: gyro turn added up event by event, compared
  with the picture's shift over ~0.25 s windows, least-squares focal length
  over all windows (`test/fov-measure.js`, simulated runs: median error
  2.7 -> 1.3 deg, worst 7.8 -> 2.8). The simulation does not reproduce
  98.9 deg, so the run's raw samples now go into the report (fovMeasure.series).
