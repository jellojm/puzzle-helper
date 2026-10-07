# Plan v0.22 — pieces show up sooner, matches you can trust

2026-10-07. Written from the owner's four newest screenshots
(`reports/IMG_3628-3631.PNG`, 22:38), the three phone reports from the same
evening (03-23-12 scan, 03-30-35 and 03-37-08 find), the handoff
`HANDOFF-2026-10-07.md`, and a read of the matcher, piece model and checked
rule. Earlier plans: `PLAN-v0.20-piece-count-and-ui.md`, `PLAN-hard-issues.md`;
research: `RESEARCH-ai-puzzle.md`.

## 1. What the owner saw, and why

| Screenshot | What it shows | Cause found |
|---|---|---|
| IMG_3629 (10:24) | Four dark, clear pieces on the cream counter, headline **"0 pieces"**, "scan closer at 29". | Report 03-23-12: **418 of 420 frames were `offLight`** (board brightness > 25% from the reference, `engine.js:764`). In that state no new entry is ever made (`offLightNew` 1331 rejections, `engine.js:1509`). The reference was set once and never re-based; a lamp-lit counter plus auto-exposure moves the board brightness more than 25% between spots. 29 entries, **0 checked**. |
| IMG_3628 (10:22) | One dark blue piece, blurry, "0 pieces", and the **"lay a dark cloth" hint** although the pieces are dark on a pale table. | Hint fires when 30% of detections have a fingerprint colour within dE 25 of the board (`main.js:796`, `engine.js:733`). With the frame blurred and the view mostly table, the "detections" were shadows and stains, not pieces. |
| IMG_3630 (10:35) | Find mode: the highlighted partner (#27) is a **clump of two pieces** outlined as one; arrow leads off screen. | A blob > 1.9 units is flagged `merged` (`engine.js:1410`) but still becomes a catalog entry and a match partner. Nothing stops a clump from being offered. |
| IMG_3631 (10:36) | **"Strong match 70%"**; the white outline sits off the piece. | `scanPairs` shows `prob = min(both sides)` but `verdict` from one side (`engine.js:2707`). The outline is drawn through a pose that is stale while the camera moves (v0.21.4 `edgeInView`, 2 px synthetic, not yet measured on the phone). |
| all four | **Every frame is blurred.** | Lamp light → long exposure → motion blur. Find reports: `read conflicts` 174 and 182, shapes confirmed 18 of 23 and 19 of 28, quality median 0.64-0.69. No per-frame sharpness gate for shape reads besides `still` (`engine.js:1737`); `frameSharpness` exists but is used only for assemblies and cell votes (`engine.js:3039`). |
| all reports | `worker camera off: frame 1920x1440 vs video 1440x1920`; fps 3.5-6, lag 100-250 ms. | In-worker frames arrive in sensor orientation; the fast path turns itself off. |

Owner's words that still stand: "pieces took a while to read", "the last piece
of a set shows no match" (done, v0.21.3, not yet seen), "the biggest thing"
was moved pieces (done, v0.19.3).

## 2. The push, in batches

Each batch ships on its own once its tests pass; the owner then checks it on
the phone. No new settings; values are tuned by tests.

### Batch 1 — v0.22.0: pieces appear while you look at them

1. **Re-base the light reference.** `offLight` means "don't trust colour this
   frame", not "never make pieces again". When the board brightness has been
   steady at a new level for ~10 analysed frames, that level becomes the
   reference (colour fingerprints already blend over frames). In the
   meantime, new entries from close, sharp, piece-shaped detections are
   allowed; only `findMoved` by colour stays off.
2. **Honest headline.** "4 seen · 0 checked" instead of "0 pieces" while
   detections are in view. Checked stays the number that must reach the
   typed count; "seen" shows the app is working.
3. **No cloth hint.** Owner, 2026-10-07: "we are not going to change the
   environment by adding cloth." The glass table and the white counter are
   the test environments as they are. The "lay a dark cloth" coach is
   removed; the app must cope with the table it is given.
4. **Fast camera path on the phone.** Rotate in-worker frames to the video
   orientation instead of switching the path off (check the turn direction
   on the phone with a report).

**Built (v0.22.0, 2026-10-07):**
- Cause of IMG_3629's "0 pieces", found in the reports: the 03-23-12 session
  continued the glass-table scan (same 20×15 box) on the counter. The board
  reference saved with that scan came from the glass (L ≈ 110-137); the
  counter reads L ≈ 175, so every frame was "odd light". The check now
  compares with the median board lightness of the last ~24 frames
  (`Engine.boardLevel`), not the saved reference. The reference itself is
  kept for the colour correction (`PH.lightFix`), so colours stay comparable
  within a scan. `quality-gate.js`: a reference carried from another table
  gives 0 of 43 pieces on the old engine and 43 of 43 now. A sudden dark frame
  is still "odd light"; the same light held for ~12 frames is normal.
- Headline: "reading N in view" in place of "0 pieces" until the first piece
  is checked.
- The cloth tip is removed. Pale pieces still switch on the texture channel.
  The glare tip now says only "tilt the phone".
- Worker camera: sideways frames are turned to match the video. The turn is
  worked out from the picture: the worker sends
  32 px grey thumbnails turned 90° and 270°, and the page keeps the one that
  correlates with its own video (by at least 0.2 more, and at least 0.5).
  After 8 views it can't decide on, it falls back to bitmaps as before. Reports
  carry `camProbe`. New `test/cam-turn.js` (headless Edge, real VideoFrames)
  checks pixel-exact turns, crops and scaling, and that the right turn is
  picked both ways.

Measured against v0.21.4 on the same machine (CPU-time clock, run side by
side): IMG_3593 48 vs 48 checked, identical timeline, first piece checked at
5.0 s in both. IMG_3605 23 vs 24 checked (noise), 16 vs 15 at 30 s.
`run-tests.js` on a step clock (deterministic): identical (93/96, 85
checked). Its "live sweep" check fails under load, on the old code too. e2e
all passed.

Tests: `quality-gate.js` covers the carried reference (a single report frame
can't: the check needs the frames before it). `cam-turn.js` is in `npm test`.
`real-50.js` now prints *first checked piece at* and *checked at 30 s*; it
must not do worse than the old engine run on the same idle machine (it has
time budgets, so a loaded machine changes its result).

### Batch 2 — v0.22.1: sharp reads only

1. **Best-of-N frame for shape reads.** Keep the last ~6 steady frames'
   sharpness (`frameSharpness`, already computed); a close read is taken
   only from a frame at or above the 75th percentile of the recent
   sharpness, as assemblies already do. Fewer reads, far fewer conflicts.
2. **Sharpness cue.** A tiny bar beside the status pill: full when the frame
   is sharp, hollow when smeared. "Hold still" text only when it stays
   hollow for 2 s. The owner learns the pace without a setting.
3. **Torch and exposure probe (small, check on the phone first).** Try
   `track.applyConstraints({advanced:[{torch:true}]})` and `exposureMode`;
   WebKit's support changed across iOS 17-18 and nothing online is reliable.
   If the torch works, offer it as a one-tap light in Find mode: shorter
   exposure, fewer smears, and shadows filled from the camera side.
4. **Prefer the centre-of-frame, sharpest view when fusing** (already
   partly in `fuseShapes`); add the per-read sharpness to the fusion weight.

Tests: replay of the find reports: `read conflicts` must drop by half with
no loss of confirmed shapes; `real-joins.js` known-weak line should improve.

### Batch 3 — v0.22.2: no false comfort in Find

1. **A clump is never a partner.** A `merged` entry (area > 1.9 units that
   the splitter couldn't cut) is shown with a dotted outline and the hint
   "two pieces touching — nudge them apart"; it is left out of matching.
2. **One verdict per pair.** `scanPairs` derives the word from the shown
   (minimum) probability and from both sides' backing. "Strong" only when
   both sides say so.
3. **Edge-to-edge arrow only when the pose is fresh**: measure the overlay
   offset on the phone (report field: outline-to-detection distance), fall
   back to the centre arrow above ~6 px.
4. **Look-alike photo IMG_3627 → test.** Needs the owner's answer (§5).

### Batch 4 — v0.22.3: outlines that follow the cut, not the shadow

The known-weak joins (IMG_3620, IMG_3625) read the right tab/blank types but
with shape distance 0.19-0.31 (good is 0.01-0.05). The colour mask grows
into the shadow on the lamp side and erodes on the bright side, so the
outline is a different curve from the real cut.

1. **Snap the outline to the intensity edge.** After the mask, move each of
   the 320 outline points along its normal to the strongest gradient within
   ±3 px (sub-pixel, parabola fit), with smoothness between neighbours
   (a one-pass active contour). This is the standard refinement step we
   don't have; it fixes shadow bloat and mask erosion at once.
2. **Shadow-aware colour distance.** A pixel that is a darker version of the
   board colour (same a/b within tolerance, lower L) is board, not piece,
   unless the texture channel says otherwise.
3. **The photo's background check must not pick a shadow-joined model.**
   IMG_3627 (owner's labelled look-alike trio, now a known-weak case in
   `real-joins.js`, join `[0, 2, 2, 1]`): the app reads 0 of 3 pieces. Of the
   candidates, the single-colour model fuses each piece with its lamp shadow
   (blobs with corner scores 0.05-0.10, nothing reads). The two-colour model
   gives the three piece-sized blobs (0.03, 0.31, 0.37) but scores 1 against
   3. Two scraps of 205 and 3838 px pass the shape test, pull the median blob
   size down, and an 86k px piece counts as "too big" (`scoreBg`). Forced to
   the two-colour model, the top and middle pieces read (BTBT, BTBT, as the
   owner's marks show). The bottom one still fails: its strong shadow joins
   along the top-left. Fix: a mass-weighted common size, with candidate
   models scored by how well their blobs read, not only how many there are.
   For photos, which are analysed once, compare shape reads. Then 2 above
   (shadow-aware colour) for the third piece.
   IMG_3622 (owner, 2026-10-07: three joins marked in colour; assembled in
   IMG_3615 as a 2×2) is now known-weak too, with pieces labelled by
   position. 2 of 4 read: the top-left piece and the pair's upper piece. The
   bottom-left piece and the pair's lower piece don't. The one join that can
   be measured (green) doesn't rank its partner first. These two photos are
   the bar for Batch 4: all 7 pieces read, and the 4 joins ranked.
4. **Neck and head width, and depth, as explicit edge features** (research
   item 11, never built): three numbers per edge that are robust to
   outline noise and cheap to compare before the 32-point signature.

Tests: `real-joins.js` known-weak line moves to the main line; `shape-real.js`
shape distances on the true pairs ≤ 0.08; `edge-verify.js` unchanged.

### Batch 5 — v0.22.4: counting pieces in a clump

1. **An integer count per blob**: `round(area / unit)` corrected by
   piece-likeness, printed in reports. The splitters then cut *to that
   number*: a 2-piece blob gets exactly one cut, chosen as the best of
   notch, corner and watershed cuts by the combined piece score of the
   parts. Today each splitter decides alone and none knows the target.
2. **Watershed on the gradient, not the distance.** Keep the distance-peak
   markers (`splitBlob`) but flood the Sobel gradient of the piece image:
   the dark seam between two touching pieces is exactly a gradient ridge.
   Interlocked tabs have no neck for the distance transform but do have a
   seam.
3. **Template fit along the outline** (handoff idea) only if 1-2 leave
   `clump-split.js` under 85% exactly right (now 77%).

Tests: `clump-split.js` ≥ 85%; glass straight-1 piece count; `open-spots.js`
border intact.

### Later — glass table (keep measuring, don't build yet)

- Parallax cue from `EdgeVoter.register`: pieces move ~2.7× more than the
  floor seen through the glass; a per-pixel "moves with the table plane"
  mask would replace the colour model where the floor shows through.
- No cloth (owner, 2026-10-07): the glass table stays a hard test
  environment, and the work on it continues. The white counter is the
  normal case, with its own problems (lamp shadows, exposure swings).

## 3. Methods we don't have yet — worth a look

Ordered by expected value for this app on this phone.

1. **Sharp-frame selection for every read** (Batch 2). Cheapest, broadest
   win: all four screenshots are motion-blurred, and blur is behind the
   read conflicts, the poor shape distances and the slow "checked".
2. **Outline refinement to the image gradient** (Batch 4). Segmentation
   gives a region; shape matching needs the cut. Every published real-piece
   solver (puzzle-bot, jigsawlutioner, Hoff & Olver) refines or smooths the
   contour before reading it; we read the raw mask boundary.
3. **Count-constrained splitting** (Batch 5). Knowing "this blob is 2
   pieces" turns splitting from a heuristic cascade into a search with a
   known answer.
4. **Gradient-landscape watershed with distance markers** (Batch 5). Marker
   watershed is what OpenCV's `watershed` is for; we only use the distance
   transform.
5. **Light re-basing instead of a frozen reference** (Batch 1). A general
   principle: every "reference" taken at session start (board colour,
   brightness, unit size) should drift with steady evidence.
6. **Torch / exposure control** (Batch 2 probe). Unverified on iOS; a
   working torch is the only lever we have on exposure time.
7. **Edge geometry invariants** (neck, head, depth; Batch 4). Cheap
   pre-filter and robust to noise; the signature alone is sensitive to
   where the corners land.
8. **Per-session calibration already exists** (`refitCalib`, ≥ 12 answers);
   missing is a report line showing how calibrated the shown percentages
   are (predicted vs. owner's Fits/No). Add it; it tells us whether "81%"
   means 81%.
9. **Multi-frame outline averaging in image space.** `fuseShapes` averages
   the 32-point signatures; averaging the aligned 320-point outlines over
   3-5 sharp views (after Batch 2) would cut outline noise further. Only if
   Batch 4 leaves shape distances above 0.08.
10. **Synthetic end-to-end renders** of a puzzle cut from a real box image
    with blur, lamp shadow and a glass floor, to test the whole pipeline
    and to measure each batch on a known answer. `synth.js` and
    `clump-split.js` do parts of this; nothing renders a lit scene.
11. **A tiny WASM segmenter on steady crops** (research item 22) only if 2-4
    still leave the glass table and lamp shadows unsolved; trained on 10.

Not worth doing (unchanged from the research): WebGPU, WASM threads,
SAM/YOLO per frame, chat-model vision.

## 4. Testing

- New metrics printed by `real-50.js` and the report replay: *seconds to
  first checked*, *checked at 30 s*, *read conflicts per 100 reads*,
  *outline-to-detection px* (overlay freshness).
- Replay fixtures from the three new reports (`report-replay.js`) go into
  `npm test` as "lamp counter" cases: entries must appear, no cloth hint.
- `clump-split.js` target 85%; `real-joins.js` known-weak joins promoted.
- The flaky "live sweep catalogs pieces without duplicates" (91-93 of 96)
  gets a fixed frame schedule so it stops depending on timing.

## 5. Questions for the owner

1. A Find-mode report with a 2×2 set: three joined, one loose (to see
   v0.21.3 pockets and the v0.21.4 arrows).
2. IMG_3627 (three pieces, one look-alike): which pair truly joins? (Owner
   is looking into it.)
3. One short video sweeping the four pieces of IMG_3629 under the same lamp,
   slowly, then quickly: it gives the blur test both ends.
4. After Batch 2 ships: does the torch button appear, and does it light?

*Answered 2026-10-07:* no cloth on the glass table; the environments stay
as they are.
