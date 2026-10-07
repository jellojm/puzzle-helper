# Plan v0.20 — exactly the right piece count, only fully checked pieces, trustworthy matches, UI clean-up

For review before any code changes. Evidence comes from the 2026-10-05
reports (`reports/puzzle-report-2026-10-05T11-08-52 / 11-13-32 / 11-14-50`),
the screenshots `IMG_3586–3592.PNG` and the video `IMG_3593.MOV`.

Test setup: **50 loose pieces** from the 300-piece reef puzzle, laid out
10 rows × 5 columns on a white counter, well apart.

**Owner's requirements (2026-10-05):**
1. The test must be tight and **end with exactly 50 pieces**.
2. **Pieces that are not fully checked are not shown.** A special dot marks
   a spot that needs more scanning.
3. Make sure the stored geometry is enough that a connection doesn't match
   several pieces (answered in §2).
4. Remove the cm size fields (U7).
5. Add a colour explanation to the More menu (U9).
6. Save names must use the typed piece count, not 999 (U10).

## Status (2026-10-05, implementation)

Shipped together as **v0.20.0**: the batches share the same code (counting,
moved pieces and housekeeping all run in one engine pass), so they are
tested and released as one.

Measured differences from the plan:

- **Colour rule** (§2b): "at least **half** of the facing points agree",
  not 80%. On the box pictures (`test/edge-colour.js`) it keeps 98.8% (reef)
  and 99.9% (chickens) of true seams and rejects **86%** (reef) and 92%
  (chickens) of wrong pairs, allowing for read noise. 80% of points needed a
  much wider tolerance and rejected only 73% on the busy reef. The 90% goal
  isn't met on the reef; colour stays the second check after close-read
  shape.
- **Texture** doesn't tell an assembled part from loose pieces. The owner's
  real puzzle measured 1.2× its table, loose pieces on a plain counter
  4–18×. Assembled parts are instead shown only once placed on the box
  picture. The false parts in the video were single close-up pieces
  ("big" was judged against a piece-size estimate that lagged while the phone
  came down) and thin strips along the frame edge.
- **Checking needs two close reads per piece**, and about 1–2 reads fit in a
  frame. A sweep therefore has to linger about twice as long over each
  piece. The rings show where.
- **Swap detection** needs a *clearly* different shape: 2+ edges of another
  type, or a far-off outline, 3 times at separate moments. A single misread
  tab never moves a piece.
- **U5** (highlight outlines): already drawn from the live detection; the
  wrong outlines came from duplicate identities (Batch 1).

### Results on the owner's video (test/real-50.js, final code)

| | v0.19.0 | v0.20.0 |
|---|---|---|
| Entries for 50 pieces | 52–80 | **50** |
| Checked (counted) | – | 47–49 (run to run) |
| "Scan closer" rings left | – | 1–3 |
| Duplicates | up to 30 | **0** |
| Ever more than 50 | yes | **never** |
| False assembled part / open spots / border | yes | **none** |
| Falsely "gone" | – | **0** |
| Edge types of matched pieces vs the hand-checked key | – | **all correct** |

Variants: overview only → 0 checked (as intended); phone speed → 45 + 10
rings; 30% detections missed → 47 + 5 rings; light bursts ±40% → 29 + 13
rings. Never over 50 in any of them.

### Two point systems per edge, and when colour can't be trusted (owner, 2026-10-05)

Owner: geometry and colour "could be different systems of points… one
focusing on color and the other getting the best locations for geometry";
and "indicate color is a bad match when conditions are not favorable…
reporting when it would hurt matches".

Each edge now has two separate point sets (`js/vision/pieceModel.js`):
`PH.GEOM_PTS` (where the outline is sampled for shape) and
`PH.COLOUR_PTS` (where colour is read just inside the cut). Each was tuned
on its own with `tools/points-bench.js`.

**Colour points** (`points-bench colour` / `pairing`): real box pictures
(reef, chickens) cut into 8×6 puzzles, read through the app at close range
with each piece's light varied, 408 true joins.

| Colour design | top1 | AUC | wrong rejected at 98% of true joins kept |
|---|---|---|---|
| 32 points, 3% in, paired by index (before) | .527 | .898 | .725 |
| 16 / 24 / 48 points | .512 / .532 / .532 | .900 / .898 / .897 | .730 / .722 / .720 |
| skip 5% / 10% at the corners | .510 / .493 | .893 / .889 | .710 / .702 |
| 2% in / 4% in / both averaged | .527 / .463 / .522 | .903 / .885 / .896 | .682 / .699 / .703 |
| 5×5 / 7×7 sample patch | .520 / .517 | .898 / .898 | .715 / .714 |
| shift search ±1 / ±2 | .522 / .495 | .893 / .888 | .718 / .706 |
| **paired by position along the seam (now)** | **.529** | **.902** | **.735** |

Point count barely matters; 3% inside the cut is best. Facing points are now
paired by where they sit along the seam (the two pieces' corners are found a
little differently), not by index.

**Geometry points** (`points-bench geom`): synthetic joins (one read at
240 px, the partner at 140 px blurred, 806 joins) and the owner's video
(10 pairs of close frames 0.2 s apart: two reads of the same 145 edges vs
every other edge of that type in the frame).

| Geometry design | synthetic join AUC | video: twin ranked 1st | video: look-alikes within the tie margin | same-edge noise median / p90 |
|---|---|---|---|---|
| 32 points, no trim (before) | .884 | 97.9% | 31.7% | 0.164 / 0.281 |
| 16 / 24 / 48 / 64 points | .878 / .883 / .886 / .886 | 97.9% | 31.7–32.4% | ~0.16 |
| corners left off 3% / 6% / 10% | .890 / .893 / .897 | 97.9 / 98.6 / 98.6% | 31.0 / 29.0 / 26.2% | 0.164–0.169 |
| **14% (now)** | **.900** | **98.6%** | **21.4%** | **0.172 / 0.281** |
| 18% / 22% | .902 / .902 | 98.6% | 19.3 / 17.2% | 0.174 |

The point count changes nothing (read noise limits shape, not sampling).
Leaving the corners off removes the jitter of corner finding: two reads of
one edge stay as close while look-alikes move away. 14% keeps nearly all of
the gain while true-pair distances (and so the identity, dedupe and tie
thresholds) stay where they were measured. Past ~20% synthetic top-1 drops
and video AUC dips. Old saved reads (no trim) are converted on comparison
(`PH.sigAs`). After the change: node suites pass, e2e passes, real-50 gives
49 checked + 2 rings, 49/50 one-to-one with the key (only #31 missing).

**Colour trust** (`points-bench why`): each piece read under one condition.
Share of true joins passing the colour rule:

| Condition | normal | dark | overexposed | glare spot | motion blur | colour cast | small (120 px) |
|---|---|---|---|---|---|---|---|
| True joins kept | 100% | 27% → **67%** | 41% | 89% | 80% | 83% | 98% |

(dark: the colour points now get their own wider light correction,
×0.4–2.5 instead of ×0.6–1.7.)

An edge's colour is **not trusted** when 2+ of its 32 colour points are washed
out (glare, overexposure) or the light needed more than ×2.2 / less than ×0.5
correction. True joins with such an edge passed the colour rule only **55%**
of the time, vs **93%** for the rest. So for those the colour test is skipped
(no veto, no penalty), and the fit card says "colour not checked" with the
reason. A later read in good light replaces the doubtful colour. On the
owner's video frames (white counter, good light) no edge was flagged. Dark
print is not counted as washed out: at first it flagged 13% of the reef's
edges.

Reports carry `colourHealth`: edges with untrusted colour by reason, and the
fits the box picture backs (both pieces placed side by side) that colour
agrees with, **would reject** (colour hurting), or can't judge.

### Real connections and shadows (owner's photos, 2026-10-06; v0.20.2)

Owner: photos of pieces assembled and then slid apart (same layout and turn:
IMG_3597 -> 3598, 2x2 on a cream counter under a low lamp; IMG_3601 -> 3602,
2x4 on the white board), plus loose pieces (3599/3600/3603/3604). Also:
"which direction shadows are thrown... the shadow on one side of the pieces
may deteriorate the quality of that edge... maybe a different method needed
on shadowed side to get true keyhole geometry".

`test/real-joins.js` ranks every true join among the edges of all ~75 pieces
read from these photos (the app's matcher, no box picture).

| | before | v0.20.2 |
|---|---|---|
| IMG_3598 (shadows) read | **0 pieces** (two pieces joined by their shadow; size guessed at a quarter) | 4 of 4 |
| Join sides with the true partner first | 13 / 28 | **20 / 28** |
| ... in the top 3 | 15 / 28 | **23 / 28** |
| Colour agrees along true seams | 24 / 28 (shadow side vetoed) | **28 / 28** |
| Shadow-side joins on the cream counter | ranked 7th-17th or vetoed | 1st-3rd |

What the shadow does: the lamp's shadow keeps the counter's colour and only
loses lightness (b +12..+15 against +15 lit; L 88-120 against 176), so the
colour-distance test took it for piece: on the shadow side the outline ran
into it and keyholes filled (shape score 0.09-0.12 vs ~0.02 for a clean
join), and the colour points 3% "inside" sat in the shadow. On the white
board with normal light it hardly matters (1-3% of outline points off).

Fixes: the shape read peels the shadow off - the bare board grows into the
piece's mask through "same colour, darker" pixels by small steps and stops
at the sharp cut. Only on a board with a colour of its own: on a neutral
board a shadow is grey like dark print (it ate a ship's hull off two pieces
on the white board). Two clean pieces of about the same size now set the
piece size (close-ups of a few pieces). Edge-length weight in the join score
4 -> 2: the two sides of a true seam read up to 8-11% apart in relative
length on real photos (pieces aren't square).

### Second video and the frame rate (2026-10-06; v0.20.3)

**IMG_3605** (2 min, loose reef pieces on the white counter): **38 pieces**,
counted by eye in its two whole-table views (72 s: 37 blobs - 3 counter
edges/handles + 4 touching pairs; 120 s: 37 blobs + 1 touching pair). Now
`node test/real-50.js 3605`.

| | v0.20.2 | v0.20.3 |
|---|---|---|
| Checked at the end (of 38) | 22-25 | 25-30 (timing varies) |
| Count during the close sweep (8-50 s) | stuck at 13-17 | rises |
| Marked "gone" though nothing moved | 1-8 | **0** |
| False assembled part | none (hidden by the bug below) | none |

- Up close only 1-2 whole pieces are in view; the piece size needed 3, so
  it froze at the far view's (4067 px) while pieces grew ~5x: every close-up
  piece was called a clump and never read. 1-2 clean pieces now grow the size
  (4 views in a row agreeing; never shrink it - a print fragment once did).
- The assembled-part search ignored a size over 5% of the view and then took
  any blob over 6% of the view: one close-up piece became an 82-cell part.
  The size is now trusted up to 15%.
- "Gone" needs 3 moments and 3 neighbours placing the spot (was 2 and 2):
  the map bends by about a piece between parts of the table.
- Still short of 38: reads up close (pieces 400 px wide) often disagree with
  the stored shape, so second agreeing reads are rare in this sweep.

**Frame rate** (owner's report 2026-10-06, 13.6 min, 1000-piece box): ~2 frames
a second, 373 ms per frame on average.

| Stage | ms per frame | |
|---|---|---|
| Image preparation (camera bitmap -> 640 px, tilt straightening) | 65 (p50 110) | 9 ms on a desktop: phone-specific; now timed in parts (seg_procDraw / Read / Warp) |
| Open spots of assembled parts | 66 (spikes to 2 s) | "every 0.4 s" was every frame at 0.5 s a frame: now waits >= 4x its own cost |
| Per-blob fingerprints | 48 | |
| Everything after segmentation | 179 (p50 190) | its 45 ms budget is gone before it starts; a minimum of reads and box placements still runs - now timed in parts (work_link / pose / assign / queue / house) |
| Background re-check | 8 | ran on 79 frames only |

The faster in-worker camera path switched itself off ("frame 1920x1440 vs
video 1440x1920": frames arrive in the sensor's landscape orientation while
the phone is upright). Not changed yet: the turn direction can't be checked
without the phone. The next report's timers decide what to cut next.

**Not met:** the owner's "exactly 50 checked" on this video. The pieces left
as rings got fewer than two agreeing close reads in this sweep: piece 31
(white sky print on the white counter; its straight top is misread) and one
or two pieces the sweep passed only once up close. That is the checked-only
rule working as asked, but the strict test fails. The decision is the
owner's (see the session summary).

---

## 1. Why the app counted 80 pieces

| Report | Time scanning | Entries | Real pieces |
|---|---|---|---|
| 11:08 | 1.2 min | 56 | 50 |
| 11:13 | 5.8 min | 76 | 50 |
| 11:14 | 7.1 min | 80 | 50 |

- **The map is right.** Grouping the 80 entries by map position gives 51
  spots. The extra 29 entries are second, third and fourth entries **on
  spots that already had a piece**, nearly always with the same edge
  reading. Examples: #2/#109, #11/#138, #4/#75; four entries (#3, #74,
  #93, #106) sit on one piece.
- **Cause: brightness.** A detection is linked to the entry on its spot
  only if the colours match ([engine.js:1135](js/vision/engine.js#L1135)).
  The colour fingerprint ([segment.js:816-845](js/vision/segment.js#L816-L845))
  includes absolute lightness. Up close, the phone's shadow and exposure
  changes swing it (e.g. #19/#131: L 68 vs 15) while the actual colour
  (a, b) stays the same. The piece then also fails `findMoved` and the
  blurry shape check, so it becomes a new entry. An entry's fingerprint
  is never updated after its first view.
- **Too little evidence per entry.** Up close, a new entry needed only 2
  frames and shape quality 0.15 ([engine.js:981](js/vision/engine.js#L981)).
  Most entries had 1–2 views, 5 never got a shape, and all of them counted.
- **False assembled part.** Any large blob in a steady frame counts as part
  of the assembled puzzle ([engine.js:2159](js/vision/engine.js#L2159)).
  Here that was the butter dish, jar lid, cap and bowl, which produced the
  open spots, the purple Map block and the border over the jar lid. The
  Map's Fit includes those blocks, so the real pieces get squeezed
  ([tableView.js:189](js/tableView.js#L189)).

---

## 2. Is the stored geometry enough to make connections unique?

### What is stored

Per edge:
- type: tab / blank / flat;
- length relative to the piece;
- a **32-point curve** of the edge, normalised to its length;
- a 16-sample colour strip along it.

Per piece:
- the outline (320 points);
- the 4 corners;
- a 24 × 24 picture of the piece's core.

Matching ([matcher.js:15](js/vision/matcher.js#L15)) compares a tab with a
blank by curve shape, length, and colour continuity across the seam. It then
adds evidence from the box picture (are the two pieces neighbours there?)
and from 2 × 2 loops (does a fourth piece close the square?).

### Measured on your 50 pieces

Method:
- **Same pieces, two reads.** Both pass through `PH.analyzePiece`, as the
  app's photo path does. Pairs were checked as correct by print
  correlation (median 0.61).
- **True join.** Each tab/blank edge is compared with a perfect partner
  built from its own second read, so the gap is pure reading noise. This is
  the best case: a real partner piece is a separate cut, so its fit can be
  slightly worse.
- **Wrong join.** Each edge is compared with every real opposite-type edge
  of the other 49 pieces.
- Shape and length only; colour and box picture are left out on purpose.

| | Far: whole layout in view (~80 px per piece) | Close: 2 columns in view (~260 px per piece) |
|---|---|---|
| Pieces whose edge types (T/B/F) agree between reads | **41 of 49** (8 misread, mostly a tab or blank read as flat) | **41 of 42** |
| Edge-length agreement within 8% | often not (another 10 pieces failed only on this) | yes |
| True-join score, median / 90th percentile | 0.49 / 0.74 | **0.14 / 0.29** |
| Among these 50: edges where a wrong edge scores as well as the true partner | **28 of 115** (1 in 4) | ~0 |
| Wrong edges tying a typical true join, at 300 pieces | **~2** | ~0.002 |
| … at 1000 pieces | **~7** | ~0.006 |
| … for the worst 10% of reads, at 300 / 1000 pieces | ~24 / ~80 | ~0.1 / ~0.3 |

(The 300- and 1000-piece figures come from fitting the lower tail of the
wrong-join scores. The method script is in the session notes; it will be
checked in as `tools/geom-check.js`.)

### Answer

- **From far-away reads: no.** One edge in four already has a look-alike
  among only 50 pieces. At 300–1000 pieces most edges would have several
  equally good wrong partners. A misread tab or blank (8 of 49 pieces) can
  even remove the true partner entirely, because a tab never matches a flat.
  Length noise above 15% does the same.
- **From close reads: yes, for nearly all edges.** Two close reads agree
  3.5× better, and a wrong edge almost never scores as well as the true
  partner, even at 1000 pieces. The weakest 10% of close reads still meet
  an occasional look-alike at 1000 pieces. Colour across the seam, the box
  picture and 2 × 2 loops are there to settle those.
- **The 32-point curve is fine-grained enough.** The limit is read quality,
  not storage.
- **What the app does today:**
  - A match can rest on a far-away read.
  - Up to 8 reads are averaged together, mixing far and close ones
    ([pieceModel.js:500](js/vision/pieceModel.js#L500)).
  - "Confirmed" means two reads agree, but both may be far-away reads.
  - Batch 3 changes all three.

---

## 2b. Colour at every outline point (owner request)

**Owner, 2026-10-05:** the puzzle points should also capture colour, as
another feature for matching. An adjacent piece must match colour-wise
within a certain percentage.

### What exists today

Each edge has 16 colour samples, taken 5% of the edge length inside the
cut, in absolute brightness. Matching adds their average difference as a
small soft term (`color / 15` in `edgeScore`). It never rules a pair out,
and a shadow or exposure change shifts every sample.

### Measured

**1. Across true seams (the box picture).** Your box photo (IMG_3591) was
cut along its 15 × 20 grid. Each true seam (neighbouring cells, 565 of them)
was compared with 6000 wrong pairs of edges.

| Sampled this far inside the cut | True seam, typical colour change | Limit that keeps 98% of true seams | Wrong pairs that limit rejects |
|---|---|---|---|
| 3% (~1 mm) | 4.9 | 18 | **92.5%** |
| 5% (today) | 8.5 | 29 | 69% |
| 8% | 12.2 | 40 | 41% |

The closer to the cut, the better. The print rarely changes in the last
millimetre, but often does a few millimetres in (fish, the ship's edge).

**2. The same edge in two photos (your video, real pieces).** This is the
noise any colour rule has to tolerate:

| Read | Colour change between two photos (median / 90%) | Colour only, without brightness |
|---|---|---|
| Far: whole layout in view | 15.9 / 23.9 | 5.5 / 8.1 |
| Close: ~260 px per piece | 7.5 / 13.3 | 3.2 / 4.6 |

Wrong pairs among your 50 pieces (far reads): 5% differ by less than 15.5,
median 28.6.

### Answer

- **From far-away reads, colour can't be a rule.** The same edge changes
  as much between two photos as two different pieces differ, mostly in
  brightness. Near the cut, a far read is mostly blur and the board's
  shadow.
- **From close reads, colour is a strong second check.** Sampled about
  1 mm inside the cut and corrected for lighting, a "must agree" rule keeps
  ~98% of real neighbours and throws out ~90% of wrong ones. Combined with
  close-read shapes (§2) this leaves very few look-alikes even at
  1000 pieces.
- **The rule should count points, not average them.** A fish crossing the
  seam changes only a few points. Requiring most points to agree is safer
  than a single average limit.
- **About 2% of real neighbours will fail any colour rule.** These are
  seams where the print changes exactly along the cut. So colour **vetoes**
  a pair only when the box picture doesn't support it either. A vetoed pair
  with the box picture behind it is shown as "possible".

### Changes (go into Batch 3)

- **C1. Colour at every outline point.** Each of the 32 shape points of
  every edge also stores:
  - its colour at two depths, about 1 mm and 2 mm inside the cut (scaled
    by the piece's size in the image);
  - how busy the print is right there (local colour spread).

  Taken from close reads only. A far read keeps shape only until a close
  read replaces it.
- **C2. Colour relative to the board.** Each frame's board colour is the
  white reference. Brightness and colour cast are taken relative to it, so
  the phone's shadow and exposure swings cancel out.
- **C3. The rule, as a percentage of points.** Two edges agree when **at
  least 80% of their facing points** are within a colour tolerance T. Facing
  points are paired along the same curve the shape match uses. A busy spot
  (high local spread) gets a wider tolerance than a plain one.
  - Fewer than 80% → the pair is vetoed (unless the box picture puts the two
    pieces side by side; then it shows as "possible").
  - Otherwise the share of agreeing points goes into the match score.
- **C4. Tolerance set per puzzle from its box picture.** When the box
  picture is set, the app measures its own seams, the same way as the
  table above. T is chosen to keep 98% of them, plus the close-read noise.
  A busy reef gets a wider T than a plain sky, with nothing for you to set.
  The chosen T goes in the report.
- **C5. Colour joins the existing evidence.** Shape decides first (§2). Then
  come the colour rule, the box picture and 2 × 2 loops. A gold ★ "sure fit"
  needs close shapes **and** passing colour **and** (mutual best, or box
  picture, or a closed loop).

### Tests for colour

- **Box picture seams** (`test/edge-colour.js`, seconds). On IMG_3591's
  picture, the per-puzzle T must keep ≥ 98% of true seams and reject ≥ 90%
  of wrong pairs. It is also run on the chickens box (pale, plain) so a
  plain puzzle isn't left with a useless T.
- **Same edge, different light.** Close reads from the video, re-read with
  frames darkened and brightened by 40%: ≥ 98% of edges still agree with
  themselves under C3.
- **No false sure fits.** On the 50 checked pieces, which have almost no
  true partners on the table: no gold ★ fits at all, and no more than a
  handful of "possible" ones (count reported).
- **Real joins (needs you, ~5 min; see the questions at the end).** About
  10 pieces that really fit together, photographed joined and then apart.
  This measures true-seam colour change on real cut pieces instead of the
  box picture. With them, the test checks that every real join passes.

---

## 3. Plan

Four batches. Each ships on its own once its tests pass.

### Batch 1 — v0.19.1: stop the duplicates

1. **Colour check that ignores brightness.** Compare colour (a, b) mainly.
   Compare lightness relative to the frame's own background.
   *Test:* the same piece 50% darker or brighter still matches; two
   different blue pieces still don't.
2. **Entries learn their look.** Update the fingerprint from each good,
   steady view, as a running average.
3. **The spot comes first.** If an entry isn't seen in this frame, sits
   within half a piece of the detection and is about the same size, the
   detection is that piece. The only veto: both shapes are close-read and
   clearly differ. This applies to far or dim views; once a close read
   exists, shape and colour decide identity (M5, Batch 2b).
4. **"Seen together" memory and automatic merge.** Each entry remembers
   which nearby entries it was ever detected with in the same frame. Two
   entries on the same spot that were never seen together are one piece:
   - merge automatically every 2 s and when a saved scan is loaded;
   - keep the older number;
   - keep the best reads and your Fits/No answers.

   Pieces genuinely lying together (piles) are seen together, so they never
   merge.

### Batch 2 — v0.19.2: only fully checked pieces are shown

5. **Two states:**
   - **Checked:** shown, counted and matched.
   - **Needs more scanning:** shown only as the special dot; not counted,
     not matched, not on the Map.

   A piece is **checked** only when all of these hold:
   - **(a) Close read.** At least one shape read with the piece at least
     ~150 px across in the camera image. That is the "close" column in §2;
     far reads are not reliable enough (see §2).
   - **(b) Read agreement.** A second read agrees with it: the same edge
     types and edge lengths within 8%, after turning.
   - **(c) Steady sightings.** At least 4 steady sightings at 2 or more
     separate moments (≥ 1 s apart, or after the camera moved).
   - **(d) Its own spot.** No other entry sits within half a piece, unless
     the two were seen together.
6. **The special dot: "scan closer here".** A hollow amber ring with a small
   "+" inside, drawn only where an unchecked entry sits:
   - it pulses gently while the phone is close enough to check it;
   - it disappears as soon as the piece becomes checked (or the entry is
     dropped).

   The top bar shows only checked pieces, plus a hint when needed:
   **"50 pieces"**, or "47 pieces · scan closer at 3 ●" with the ring icon.
7. **No new entries from bad frames.** A frame much darker or brighter than
   usual, or blurred, can update existing entries but never creates one.
8. **Entries that can't be checked are dropped.** An entry still unchecked
   after many close views is removed. Your last report had 5 such entries,
   which never got a shape.
9. **Report additions.** Per piece:
   - state;
   - sightings and separate moments;
   - read sizes;
   - "seen together" count.

   Also merged duplicates and dropped entries, so the next phone report shows
   exactly why each entry is or isn't checked.

### Batch 2b — v0.19.3: pieces moved around (owner: "the biggest thing")

**Owner, 2026-10-05:** every piece gets a close sweep for shape and colour,
which is fine on the 1000-piece glass table too. Once a piece is detailed:
- it is **never dropped from memory**;
- if the app **knows** it has disappeared from its spot, its dot goes away
  and it is **removed from the Map until it is found again**.

What happens today:
- A piece not detected for 12 frames is flagged `missing`. It stays on the
  Map, faded, at its old spot ([tableView.js:222](js/tableView.js#L222)).
- A moved piece is found again only through the brightness-sensitive colour
  check, which is how duplicates get made.
- Tidy up can **delete** checked pieces: false-edge clean-up and box cells
  filled by the assembled part ([engine.js:2073-2075](js/vision/engine.js#L2073-L2075)).

Changes:

M1. **A checked piece is permanent.** Nothing deletes it automatically. It
    leaves the catalogue only when:
    - it is merged as a duplicate into the older entry (keeping everything);
      or
    - you choose "New puzzle" or "Clear everything".

    Automatic housekeeping (Batch 2c, which replaces Tidy up) marks such
    pieces "in the puzzle" instead of deleting them. Only unchecked entries
    can be dropped.

M2. **Three places a checked piece can be:**
    - **on the table** at a known spot: dot, Map, highlights;
    - **not on the table**: left its spot, not found yet. No dot, not on the
      Map, no highlight or arrow points to it;
    - **in the puzzle**.

    Top bar: "50 pieces · 2 moved, not found yet". In match lists a moved
    piece still appears, labelled "moved — scan to find it".

M3. **"Gone" needs proof, not just a missed detection.** A piece becomes
    *not on the table* only when **all** of these hold:
    - its spot was in a steady, sharp view, close enough that the piece
      would have been read;
    - at least 85% of its footprint shows **bare board**;
    - nothing covers it (hand, other piece, assembled part);
    - all of this at 2 separate moments.

    If something is on the spot but isn't recognised, the app reads what's
    there instead (M5). A pale piece the detector missed never counts as
    gone, because the board isn't showing there.

M4. **Found again by shape and colour, anywhere on the table.** Before any
    detection can become a new entry, its close read is compared with:
    - every piece that is *not on the table*;
    - every piece not seen in the current view.

    The comparison uses the close-read shape (§2) and per-point colour
    (§2b), in any orientation. When it matches:
    - it is that piece, with the **same number**, its matches and your
      Fits/No answers intact;
    - its spot moves to the new place, and the old spot is cleared;
    - the match must be one-to-one: one physical piece, one entry.

    Until the close read exists, the detection is only a ring and never
    creates a new entry.

M5. **Close-read identity beats position.** Batch 1's "the spot comes first"
    rule is for far or dim views only. Once a close read exists, identity
    comes from shape and colour, so:
    - **two pieces swapped:** each is recognised in the other's spot; both
      entries move, with no duplicates;
    - **a piece turned in place:** same piece, new angle;
    - **a different piece put on a free spot:** recognised as itself, not
      as the piece that used to be there.

M6. **Moves seen live.** A hand over the table blocks every decision
    underneath it. When the hand leaves:
    - an empty spot follows M3;
    - the piece reappearing elsewhere follows M4.

    Usually both happen within a second or two of putting it down.

M7. **Into the puzzle.** A piece that is *not on the table* becomes
    *in the puzzle* automatically when its box-picture spot fills up in the
    assembled part, if its box placement is confident.

M8. **After reopening the app.** Pieces may have been moved while the app
    was closed. Every piece starts at its last spot and is re-confirmed or
    found gone (M3) as the camera passes. Nothing is hidden at start-up.

M9. **Report additions.** Per piece:
    - where it is (on the table / moved / in puzzle);
    - how many times it went missing and was found again;
    - for each find, the shape and colour scores and how far it moved.

### Batch 2c — with 2b: no "Tidy up" button (owner, 2026-10-05)

**Owner, 2026-10-05:** drop the Tidy up button. The app should look after
itself.

`tidy()` ([engine.js:2029](js/vision/engine.js#L2029)) does four jobs:

| Job | Runs automatically today? | Replaced by |
|---|---|---|
| 0. Merge duplicates on one box-picture spot (`dedupeByCell`) | Partly: 3 ms every 20 frames | Batch 1 item 4 (seen-together merge) plus close-read identity (M4/M5), running all the time |
| 1. Join scan groups: the same piece in two groups after tracking broke | Only for pieces in view (`mergeIslandsByShape`) | The same shape-and-colour identity check (M4) across groups; groups join as soon as 3 pieces link them |
| 2. Drop leftovers that never read as pieces | Button only | Batch 2 item 8: unchecked entries that can't be checked are dropped |
| 3. Remove "edge pieces" that are really chunks of the assembled puzzle | Button only, and it **deletes** checked pieces | M1/M7: a checked piece becomes "in the puzzle"; an unchecked one is dropped |

Changes:

T1. **Housekeeping runs by itself.** All four jobs run in the worker, in
    small time slices: at most ~5 ms per frame, working through the
    catalogue in turn, so the phone's frame rate doesn't drop. A full pass
    also runs:
    - when a saved scan is loaded (this cleans your existing 80-entry scan);
    - when the camera pauses (idle or menu open);
    - when the Map opens.
T2. **Remove the button and its messages:**
    - the "Tidy up the catalog" button (`index.html:117`, `main.js:1391-1396`);
    - the worker's `tidy` message (`worker.js:416`);
    - the three hints that tell you to tidy up (`main.js:692`, `:699`,
      `:700`). If the count still goes over the puzzle's size, which should
      no longer happen, the report flags it rather than asking you to act.
T3. **Silent, but recorded.** No pop-ups. The report counts what
    housekeeping did: duplicates merged, groups joined, entries dropped,
    pieces marked "in the puzzle". A mistake can then be traced.
T4. **Tests change from "press the button" to "it happened by itself":**
    - `test/dedupe.js` and `test/live-sections.js` currently call
      `eng.tidy()`. They will only process frames (and load a saved state),
      then check the same outcome: duplicates folded, groups joined, the
      false edge piece gone or marked in the puzzle.
    - A time check: housekeeping on a 1000-entry catalogue stays within its
      per-frame slice.
    - The e2e test checks the button is gone.

### Batch 3 — v0.19.4: trustworthy matches

10. **Reads carry their size.** Each shape read records how big the piece
    was in the image. Only close reads (≥ 150 px) are combined into the
    piece's shape; far reads are used only until a close one exists.
    Today all reads are averaged together.
11. **Matches only between checked pieces.** Both edges must come from
    checked pieces, so both have close, agreeing reads.
12. **Honest ties.** The noise margin comes from the measured true-join
    spread: 0.29, the close-read 90th percentile.
    - When the runner-up is within that margin, show "2 possible fits"
      instead of naming one.
    - It becomes one fit only when colour across the seam, the box picture
      or a closed 2 × 2 loop separates them.
    - A match is "sure" (gold ★) only when it is mutual (each is the
      other's best) **and** has one of those extra pieces of evidence.
13. **Geometry check tool.** `tools/geom-check.js` (the §2 and §2b
    measurements) runs on any video or report frames. Re-run it whenever
    shape or colour reading changes; it must not get worse.
13a. **Colour at every outline point**, items C1–C5 in §2b:
    - per-point colour at two depths;
    - colour relative to the board;
    - the "80% of points agree" rule;
    - a per-puzzle tolerance taken from the box picture;
    - a gold ★ needs passing colour as well.

### Batch 4 — v0.19.5: no assembled part unless there is one

14. A large blob feeds the assembled part only if:
    - its cells' print resembles the box picture;
    - its cells are piece-textured;
    - it isn't one flat colour (dish, lid, cap).

    When every detection is a separate, piece-sized blob, no assembly is
    started.
15. An assembled part is shown only after it has been placed on the box
    picture with confidence. "Shown" means the Map block, open spots, border
    dashes and "open spots" in the top bar.
16. The Map's Fit uses checked pieces plus shown assemblies only.

### Batch 5 — v0.20.0: UI

| # | What's wrong (screenshot) | Change |
|---|---|---|
| U1 | A ~48 pt black band sits under the tab bar on every screen. The app uses 848 of 896 pt (report `screen.viewH` vs `h`). | Fill the full screen in Home-Screen mode. The tab bar sits on the bottom edge and the camera view gets the space back. |
| U2 | "74 pieces · 27 placed · 15 open spots" (IMG_3586). "Placed" sounds like *in the puzzle*; the open spots were false. | "50 pieces · 27 on box picture". Open spots appear only with a real assembled part; unchecked pieces show only as the scan-closer hint (item 6). |
| U3 | Map: Fit / 90° cover the hint text; pieces fill a thin band; highlight discs hide the pictures (IMG_3589/3590). | Buttons go below the top bar; the hint becomes "Map · camera off"; Fit uses pieces only; highlights become rings around the picture. |
| U4 | Find: the box picture covers about a quarter of the screen; 7 chips in 2 rows plus the tab bar leave the camera about 60%. | Box picture becomes a small corner thumbnail (tap to enlarge) that moves aside when a highlighted piece is under it. One scrollable chip row. "Unread" is renamed "Need closer look". |
| U5 | Find highlights don't fit the piece under them, e.g. an edge outline on an interior piece (IMG_3587/3588). | After Batch 1: live outline when the piece is in view; stored outline only when it isn't detected. |
| U6 | Dot colours have no key. | One-line key the first time Find opens, pointing to U9. |
| U7 | **Box screen: "Finished size cm × cm" — remove** (owner: never used). | Remove from `index.html:233` and `boxSetup.js:170-174`. The typical size for the piece count is already used (reports show 30 mm with the fields empty). Saved puzzles with a size keep working. |
| U8 | The box photo is sideways (IMG_3591), so the picture in Find is sideways too. | **Rotate 90°** button on the box screen; columns × rows swap with it. |
| U9 | **Owner: a More-menu item explaining piece colouring.** | New entry **"What the colours mean"** in the More (≡) menu, next to Tips. Swatches are drawn from the app's own colour tables (`STATUS`/`ROLE` in `js/overlay.js`), so they can't drift. Content below. |
| U10 | **Save names show 999 for a 1000-piece puzzle.** The name uses grid columns × rows (27 × 37 = 999), not the typed count ([worker.js:200](js/worker.js#L200)). The same product feeds the "more than N pieces" warning and "% done" ([engine.js:104](js/vision/engine.js#L104)). | Store the typed count as `box.pieces` and use it everywhere. Old saves: a grid within 3% of a standard size (100, 150, 200, 300, 500, 750, 1000, 1500, 2000) shows that size. App-made names like "Puzzle 10/4/2026 (999 pieces)" are corrected; names you typed are never changed. Independent of everything else; can ship first. |

**U9 — "What the colours mean"** (wording to review):

*Dots on pieces*
- **amber ring with +** — needs more scanning: bring the phone closer and
  hold steady. Not counted yet.
- blue — checked piece
- green — checked and matched to a spot on the box picture
- orange dashed outline — pieces touching; spread them apart
- faint dashed outline — marked as already in the puzzle

*Highlights (Find, Border, Map)*
- white — the piece you tapped
- gold ★ — a sure fit; silver — a possible fit
- "2 possible fits" — the shapes can't tell them apart yet
- teal — edge pieces; orange — corner pieces
- pink — pieces picked by the filter you chose
- zone colours (red, cyan, yellow, purple, green, orange) — sorting areas
  A–F, same colours on the box picture
- red / cyan / yellow / purple side marks — the four sides of the selected
  piece, as named in its match list

*Map*
- shaded block — the assembled part
- dashed squares — open spots in it

---

## 4. Testing: end with exactly 50

### Answer key (built first)

`test/fixtures/v3593/answer.json` lists every one of the 50 pieces:
- its grid row and column in the layout;
- its 4 edge types;
- whether it is an edge or corner piece;
- its outline position in the opening overview frame.

It is built from the close-up reads and **checked by eye on every piece**,
before any fix. The checked contact sheet is saved to `test/out/` for you
to glance over.

### Main test `test/real-50.js`

Every frame of `IMG_3593.MOV` is run through the engine in node, the same
way the phone does (live frames, phone frame rate). It passes only if, at
the end:
- **exactly 50 checked pieces**;
- **0 unchecked entries left** (every piece was swept up close in this
  video);
- **one-to-one with the answer key:** every key piece has exactly one entry
  on its spot, and no entry is unmatched;
- **edge types** of every checked piece equal the key (50 / 50);
- **edge and corner counts** equal the key exactly;
- 0 assembled parts, 0 open spots, no border.

It also passes only if **at no point during the video**:
- more than 50 checked pieces are shown;
- a checked piece is merged away or replaced later (checked means final);
- two checked entries sit on one spot.

### Variants (all must also end at exactly 50)

- **Phone speed:** only every 6th frame (the phone's ~5 fps).
- **Missed detections:** a seeded random 30% of piece detections dropped in
  every frame, as in `dupes.js`.
- **Dark and bright swings:** frames darkened or brightened by up to 40% in
  bursts (the phone shadow and exposure).
- **Overview only:** just the first 3 s. Expect **0 checked pieces** and 50
  scan-closer rings, which proves far reads alone never count.

### Moved pieces (Batch 2b), all end at exactly 50 with the same numbers

**Synthetic, `test/moves.js` (seconds).** A 48-piece synthetic table is
swept close until every piece is checked. Then, one step at a time:

1. **Slide** 3 pieces to new spots while they are out of view.
2. **Swap** two pieces.
3. **Turn** one piece in place.
4. **Take one away** (off the table).
5. Sweep the **whole table, dark and bright**, with 30% of detections
   dropped.
6. **Put the taken piece back** at a new spot.

After every step:
- exactly the right number of pieces are checked: 48, or 47 while one is
  away;
- **every physical piece keeps its original number**;
- no new entries, ever;
- the moved pieces' Map spots are where they really are now;
- during step 4, the piece taken away:
  - has no dot;
  - is not on the Map;
  - nothing points to it;
  - and it is still in memory;
- after step 6 it is back with its old number, matches and Fits/No answers;
- a piece the detector merely missed (step 5) is **never** flagged gone.

**Real, `test/real-moves.js`** (needs your recording; see the questions).
Your table after a full sweep, then the same moves on the real pieces.
Same pass rules, against an answer key checked by eye.

### Supporting tests

- **Housekeeping never deletes a checked piece** (M1). It marks it "in
  the puzzle" instead, when its box cell is filled.
- **No Tidy up anywhere** (Batch 2c):
  - the old `dedupe.js` and `live-sections.js` outcomes happen with no
    button press;
  - the button and its hints are gone;
  - the per-frame time slice holds on a 1000-entry catalogue.
- **Old-catalogue merge.** The 80 entries of report 11:14 must merge to 51
  or fewer, with no two different grid spots merged. Exactly 50 isn't
  possible from that data: it only holds far reads, and one entry is a
  two-piece blob. That entry must end up *unchecked*, so the count shown
  is 50.
- **Fingerprint brightness check** (item 1).
- **Geometry check** (item 13): `tools/geom-check.js` on the video. The close
  true-join median stays ≤ 0.15, and look-alikes for close reads among the
  50 stay at 0.
- **Match ties:** among the 50 checked pieces, no edge shows a "sure" fit to
  another piece. Hardly any of their real partners are on the table, so
  any "sure" here is wrong.
- **Colour tests** from §2b:
  - box-picture seams;
  - the same edge under ±40% light;
  - real joins, once you've recorded them.
- **Save name** (U10): box set to 1000 → name says 1000; an old save without
  the stored count also says 1000.
- **Existing suites must still pass:**
  - `dupes.js`, `dedupe.js`;
  - `open-spots.js` and `border-auto.js` (a real assembled part and border
    still work);
  - `quality-gate.js`, `unit-area.js`, `young-island.js`,
    `seg-regression.js`;
  - then `run-tests.js`, then `e2e.js` once.

### On the phone

The same 50-piece layout, one sweep (overview, then close passes), then one
report:
- the top bar must read **"50 pieces"**;
- no amber rings left;
- no open spots, and no purple block on the Map.

The report must show 50 checked pieces, 0 unchecked, and the merge and drop
counters.

---

## 5. Risks

- **Scanning takes a close pass** (owner confirmed 2026-10-05: expected,
  fine on the 1000-piece table). An overview-only scan shows rings, not
  pieces; the rings show where to go.
- **A different piece put on another's old spot.** Handled by M5: close-read
  shape and colour decide identity, not position. While only a far read
  exists, the newcomer stays a ring rather than taking the old piece's
  number.
- **Two near-identical pieces both moved out of sight** (plain sky). Finding
  them again could swap their numbers. Mitigations:
  - one-to-one matching;
  - when the close reads can't separate the two, both stay rings until they
    can.

  A swap of two truly identical pieces would do no harm anyway: they fit
  the same way.
- **"Gone" too eagerly on the glass table.** Glass can show the wood
  underneath, which may not read as bare board. M3 then fails to prove
  "gone" and the piece stays at its last spot (shown, not hidden). This is
  the safe direction, and it is checked on the glass-table frames
  (`glass-table.js`).
- **Stricter assembly rules** could hide a small real assembled block (under
  ~8 pieces) until it matches the box picture. `open-spots.js` guards the
  normal case.
- **The "true join" in §2 is an ideal partner.** Real partner pieces fit a
  little less perfectly, so real tie rates will be somewhat higher than the
  close-read column. That is why matches also use colour, the box picture
  and loops, and why "2 possible fits" exists.

---

## 6. Questions for the owner

1. **Real joins for the colour test (about 5 minutes).** Find about 10 pairs
   of pieces that really fit together (corners and edges are easiest), then:
   - join each pair and take one photo from about 25 cm;
   - separate them, a finger's width apart, and take another.

   This gives the true colour change across real cuts on real pieces; the
   box picture can only approximate it.
2. **A moves video (about 3 minutes)**, for `test/real-moves.js`. Same
   50-piece layout:
   1. sweep everything up close;
   2. then, with the camera running:
      - swap two pieces;
      - turn one in place;
      - slide one to an empty spot;
      - take one off the table;
   3. sweep again;
   4. put the taken piece back somewhere new;
   5. sweep once more.

   Saying what you moved helps, but the answer key can also be read from
   the video.

*Decided 2026-10-05:*
- every piece gets a close sweep, so an overview-only scan shows rings
  only;
- detailed pieces are never forgotten;
- a piece known to be gone is hidden until it is found again.

---

## v0.21.0 — glass table (2026-10-07)

Reports 01-06-12 / 01-09-35 and video IMG_3609 (glass top over wood, dark
carpet and light tile; `node test/real-50.js 3609`, no key): 0 pieces shown.
No colour model separated the pieces from the floor seen through the glass
(the same with v0.19.0: not a regression); ~8-10 of ~80 pieces per frame
found, none ever checked (close reads were rare: 10 of 15 entries far-only).

- **Outline background model** (`kind: 'edges'`, `PH.edgeForeground`): the
  floor is ~2x further than the pieces and out of focus at full resolution,
  so Canny outlines at 2x the processing size close a ring around every
  piece; outline-free regions reaching the frame edge (plus enclosed
  regions coloured like the floor around them) = floor; 1 px trim. Two
  Canny levels are candidates in the background re-check (picked per
  scene, no setting). Offered only without a dominant table colour (top
  colour mode < 30% of the view) and chosen only when it beats the best
  colour model by 25%: the white-counter fixtures, `open-spots.js` and
  `real-50.js` (48 checked, same as before) are unchanged.
  Glass frames: 01-09-35 colour best 11 good -> outlines 15 (chosen);
  01-06-12 10 vs 11 (colour kept). On the video's motion-blurred,
  compressed frames outlines don't win; still 0 checked.
- **"Move closer to read the assembled part"** only when pieces are under
  ~22 px a side (it appeared with no assembled part on the glass table).

Next (research report 2026-10-07): per-edge sharpness ratio (Zhuo & Sim
2011) instead of a global Canny threshold; temporal voting of masks over
3-5 frames registered by the table-plane homography (also gives a parallax
cue: floor features don't fit it); watershed on the sharp-edge map for
piles; a "put a cloth under the pieces" prompt when confidence is low.

### Research items 2 and 3, measured (2026-10-07)

- **Per-edge sharpness ratio** (Zhuo & Sim: gradient / gradient after an
  extra Gaussian blur, at Canny edge pixels; `test/out`-style probe on
  report 01-06-12 at 960/1280/1920 px, sigma 1-2): one hump (1.1-1.5) for
  piece outlines and floor edges alike; only fine print scores high. The
  floor adds few edges anyway. Not used.
- **Frame voting** (`PH.EdgeVoter`, `opts.edgeVote: true`): LK corners +
  RANSAC homography on the table plane (98% inliers on IMG_3609), last 4
  outline masks warped in, majority vote. Clean detections a frame on
  IMG_3609 (outline model forced): 5.62 without, 4.95 with (moving frames
  2.79 -> 3.00). Off by default. The losses on that video are dense piles
  of touching pieces and lit floor between them at ~40 px a piece, not smear.
  `node test/real-50.js 3609` with FORCEBG='[30,80]', VOTE=1, DETSTATS=1.
