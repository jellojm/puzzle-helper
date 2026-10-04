# Puzzle Helper — plan for the hard issues

Implementation plan for engineers/agents picking up the vision and performance
work. Every claim below was measured in this repo on 2026-10-03; the tools used
are checked in, so re-measure before and after each change.

Target device: **iPhone XR (A12, 2018, 3 GB)** running **Chrome on iOS**
(WKWebView: same engine as Safari). Confirmed by the owner and the reports
(2026-10-03): Add to Home Screen works, the screen stays awake, and motion
sensors work (reports carry `gravity`/`tilt`; iOS 18.7). Table: white board, warm lamp,
pale-printed pieces (see `reports/*-frame.jpg`).

---

## Status (2026-10-03)

| WP | State | Result |
|---|---|---|
| WP8 | **Done** (828a415) | `test/seg-regression.js` on white-1/2, white-close-1/2 (video frames 2 and 881); `--baseline` reproduces the old numbers; in `npm test` |
| WP1 | **Done** (828a415) | Running `unitLive` + mass-mode own estimate (≥ 3 blobs, else null). Fragments are never catalogued as new pieces. `test/unit-area.js`: unit within 7%, no duplicate entries |
| WP2 | **Done** (5f7aeaf) | Boundary fill on still frames, open off. good/frag: white-1 20/8 → 31/2, white-2 21/10 → 35/1, close-1 14/8 → 13/4, close-2 9/4 → 7/2 |
| WP4 + WP9 | **Done** (uncommitted, v0.9.0 candidate) | `PH.FlowTracker` in `js/vision/flow.js`: 96 px thumbnail matched against the last *analysed* frame (keyframe, not chained steps — chaining 12 30-Hz steps drifted ~9 css px from sub-pixel bias), re-key near the search edge, one chained step as fallback. Confidence = best vs *typical* shift cost (vs zero shift rejected every ~1 px step). `frameMapping(..., shift)` applies the camera-image shift in screen space, exact with tilt correction too; taps use the same mapping. Settings toggle; report `flow` block. Stillness falls back to tracker speed when no motion sensor. `test/flow-overlay.js`: marks land within 0.97 css px after a 12-step sweep (67.9 px without following); real video: confident 314/314 steps, 0.67 ms/step in node |
| WP3, WP5–WP7 | Open | WP7 partly covered by "Corners / duplicates" |
| Phone speed (v0.9.0 reports 15:17/15:18) | **Done** (v0.9.1) | `seg` 343–406 ms even *untilted*: `seg_dist` 75–81, `seg_flatten` 97–111. 74c030f's always-present mask did not help — untilted frames got as slow as tilted ones, and v0.7.1 had run the same masked `dist` loop in 3 ms (14:29) and 57 ms (14:42), so it is not the mask type. Best fit: iOS sometimes runs a big function's per-pixel loops in a slow JIT tier. Fix that holds regardless: full-frame per-pixel work in OpenCV WebAssembly (`PH.labDistance`, `flattenLight` ratio + counts, splitter seeds/basins, boundary mask), mask null again when untilted. Outputs match the old code (bg within 0.2, counts same on 34/36 frame×option cases); node 35% faster. **Needs a phone report to confirm** — compare `seg_*` |
| Tracker cost on phone | **Done** (v0.9.1) | 21–54 ms/step on the phone (0.7 in node). Predicted small-window search first (handles 304/314 real-video steps, half the matching cost), self-limiting rate (`every` = ms/8 frames, 2–12), no tracking when there are no dots to move, `readMs`/`matchMs` split in the report to show whether video read-back or matching costs |
| WebAssembly memory leak | **Done** (v0.9.1) | Found while checking the new code: `splitBlob` did `labMat.roi(R).clone()` and never deleted the roi view, which pins the whole frame's Lab buffer (~0.7 MB) per split. Engine on the owner's white-board frames: v0.9.0 heap 128 -> 256 MB in 240 frames (~128 MB per 2 min at the phone's rate; memory pressure slows the phone and iOS eventually kills the tab), now flat. Also a double `MatVector.get()` on tilted frames. `test/leak-check.js` (in `npm test`) fails on the old code and passes now. Rule: delete every `roi()` view and every `MatVector.get()` result |
| Pile split overrun | **Done** (v0.9.1) | `seg_split` 28–50 ms vs a 25 ms budget: a whole-pile split now starts only with 60% of the budget left, one per live frame |
| Report diagnostics | **Done** (v0.9.1) | Whole-session stage stats (mean/max, total p50/p90/p99), send→result lag and worker queue wait per frame, display-frame gap stats + overlay draw cost, engine state (frame no., lost frames, unit size, background model + age, WASM heap MB for leak spotting), catalog shape (per island, confidence histogram, never-shaped), session counters, settings, device/storage, camera capabilities; history 60 → 240 frames; `tools/report-summary.py` prints them |
| Duplicate cataloguing with tracking working | **Done** (v0.9.2) | Report 15:52 (v0.9.0): 566 entries + 75 sections for ~150 pieces on the counter (owner's photo IMG_3573), tracking 92%, 1 island — but 419 entries had lost their table position. A piece missed for 7 frames had its position forgotten; on a white board pale pieces miss often (median 16 detections with many more pieces in view), and the returning piece became a NEW entry whenever strict shape/colour re-identification failed (light changed, shape reads starved). Now: misses count only on still frames, after 12 the piece is flagged `missing` but keeps its last-known spot and re-links there (colour sim >= 0.6); `findMoved` still catches real moves. `test/dupes.js` (2/3 of pieces missing 2/3 of the time, shifted light, starved shape reads): 15 of 48 lost position before, 0 now |
| "Catalog from a photo" found nothing | **Done** (v0.9.2) | On IMG_3573 (kitchen counter, wall and dishwasher in frame) the piece size came out 125,702 px² (true ~1,200): a wall region touching the frame edge scored as "piece-shaped" (0.034) and won the area-weighted size mode, so every real piece was dropped — `found: 0`. Blobs cut by the frame edge no longer set the piece size: now 45 found, 44 shaped |
| Shape reading on pale / colourful pieces (owner) | **Partly done** (v0.9.2) | Per-piece masks (`segmentCrop`) are colour-distance only: on a pale board the outline follows just the colourful part, and the cut along a print boundary reads as a FALSE FLAT edge (seen directly on IMG_3573 crops; `test/shape-real.js --autotilt` draws them). Now: (1) a piece-size check — an outline under 0.6x or over 1.9x one piece's area is rejected (partial / merged with a neighbour) instead of trusted; (2) when colour gives a partial piece, a lightness-edge outline (closed, filled, centre region only) is added to rescue it. Outline-first was worse (its fill also takes the lamp shadow into blanks). On the straightened photo: reads 65% -> 64%, clearly-false flats among flagged pieces ~5/18 -> ~3/18 by eye; the flat-share metric (28-29% vs 22% possible) is within its ±5-point noise at n≈60, so it can't rank variants. **Next:** (a) measure the piece-size reference on outline masks — colour masks under-size pale pieces, so 60-80% partials still pass; (b) a hand-labelled set of edge types from the owner's photos to tune against; (c) the photo tilt safety check rejects straightening IMG_3573 (43 -> 23 clean blobs) — it counts at a fixed 960 px width of a much larger straightened image, so pieces shrink below the minimum area |
| Quality gate + provisional pieces | **Done** (v0.10.0) | A new piece needs 2 steady, good sightings in consecutive frames (3 starved the browser e2e: a moving view rarely gives 3 steady frames in a row) (followed frame to frame; candidates live outside the catalog). Good = steady, piece side >= 40 source px, 0.6-1.7x one piece, piece-shaped. Reasons counted in reports (`gate.rejects`). `test/quality-gate.js`: moving / far / never-consecutive views -> 0 pieces; steady sweep 43/48 |
| Real piece size | **Done** (v0.10.0) | Box setup takes the finished size (else typical for the piece count: 1000 pcs ~19 mm, 300 ~30 mm). With the 66 deg lens this gives the camera distance: "Too far — hold about N cm above the table", and piece-size estimates implying < 6 cm or > 2 m are ignored |
| Confirmed shapes, best read, uncertain edges | **Done** (v0.10.0) | 94% of shapes in report 15:52 came from one view. Now a piece is re-read from a later view until two reads agree (fused, `nObs` >= 2 = confirmed); on disagreement the higher-quality read wins (quality = outline sharpness x resolution x corner clarity). Edges within ±0.035 of the flat threshold are `unc`: not counted as border, matched as their other type (+0.4 score), settled by a clear later view. Gold and auto-flagged pairs need both shapes confirmed or a 2x2 loop. run-tests live sweep now revisits the table: 23/23 flagged pairs true |
| Speed of the above | Measured | `test/speed.js` vs v0.9.2 (node): synthetic 42 -> 47 ms/frame (confirmation re-reads in spare budget), real frames unchanged. Phone-like budget (segmentation over budget): reads 0.8 -> 1.1/frame — confirmation re-reads capped at one every other frame when over budget, only until the pieces in view are confirmed |
| Answer key | **Done** (v0.10.0) | Every Fits/No is logged with the claimed probability, rank, 2x2 loop and confirmation; saved with the catalog; `feedbackStats()` by probability/rank/confirmed; in reports and printed by `report-summary.py`; running accuracy under More; Fits/No in the Matches bar. `test/answer-key.js` (synthetic: 82/84 top suggestions right, 80/80 at >= 0.95). **Needs the owner's answers on the real puzzle** to tune MATCH_TEMP / MATCH_NULL / UNCERTAIN_PENALTY |
| v0.10.0 found 0 pieces on the phone | **Done** (v0.10.1) | Assembled sections bypassed the quality gate; one section made the engine think the table was already mapped, so it waited to relocalize before cataloguing anything and every candidate expired. Now relocalizing needs >= 3 placed pieces (not sections) and sections pass the gate too. `test/quality-gate.js` has the case; on the owner's frame with jitter: 0 -> 73 pieces |
| SIMD OpenCV.js (research item 9, owner approved 2026-10-03) | **Done** (v0.15.0) | Own build of OpenCV 4.10.0 with WebAssembly SIMD (fixed-width only; iOS 16.4+), single-threaded, single file, same function list as the CDN build (`vendor/opencv-4.10.0-simd.js`, 12.9 MB, techstark's `var Module` patch applied). Speed (node `test/speed.js`): segmentation 20.7 -> 12.7 ms synthetic, 34 -> 22.6 ms real white-board (-35%), whole frame -19% mean (the freed time reads more shapes: 68 -> 80, 40 -> 70); browser e2e session median 20 -> 14 ms. All 19 node suites pass on it. `js/worker.js` loads it when `WebAssembly.validate` accepts a one-instruction SIMD module, else (or if it fails to load) the CDN build; `report.worker.cvBuild` says which ran. The CDN fallback first hung (the old build's module is a thenable; returning it from an async function never settles) - fixed and covered by an e2e run with the file hidden. Service worker: cache-first for `vendor/`. **Rebuild** (Windows, no WSL): `pip install --user cmake ninja`; `git clone emsdk` -> `emsdk install/activate 3.1.45`; `git clone --depth 1 -b 4.10.0 opencv`; `source emsdk_env.sh`; `python opencv/platforms/js/build_js.py build_simd --build_wasm --simd --config_only --cmake_option="-GNinja"`; `cd build_simd && ninja opencv.js` (~45 min); then apply `node_modules/@techstark/opencv-js/dist/opencv.js.patch` (`Module = {}` -> `var Module = {}`). Toolchain lives in C:/Users/jmott/dev (outside OneDrive) |
| Highlights easy to see (owner, 2026-10-03: "pieces for matching did not show well") | **Done** (v0.14.0) | Every highlighted piece (selection, partners, Matches pair, finders, zones) is drawn with its whole outline (dark under-stroke + colour) and shaded ~40-55% in its colour, in dot mode too (was a small ring around the dot); arcs (quadratic, bulging to one side, dark under-stroke) from the selected piece to each edge's top candidate and between a Matches pair, also toward off-screen partners; same arcs and shaded rings on the Map. Verdict fix: a candidate under 20% is always "Unlikely" (two 0% candidates showed as "Look-alike"). e2e screenshots e2e-border-lit.png, e2e-matches.png |
| Research batch B2, shape reading (items 10, 11, 19, 20 + owner's "spatial cues") | **Done** (v0.14.0) | **Texture channel for pale pieces** (owner asked: "instead of colour, something spatial?"): on the owner's white-board photos local lightness texture outlines every piece incl. pale ones (test/out/spatial-cues-white-close-1.jpg); added to the frame mask only while the coach measures >= 30% of detections blending into the board (off below 15%) - the owner's frames measure 3-16%, so unchanged for that setup; synthetic pale-on-white: catalogued 19 -> 31/48, moderately pale +1-2, normal setups identical. **Inverted background vote** (found on the owner's glass-table photos, 1000-piece puzzle): in dense piles the gaps between pieces are jigsaw-shaped, and a model calling the pieces' colour "table" won (pieces-1: 4 "pieces", all gaps); `Engine.texRatio` - a model whose "pieces" are smoother than its "table" scores x0.4*ratio: pieces-1 4 -> 22 pieces, others unchanged. **(10) Notch-pair splitting** `PH.splitConcave` (after watershed fails; both halves must be piece-sized and piece-shaped): straight-1 34 -> 39, pieces-3 31 -> 33; merged clumps are rare in those photos (0-1). `test/glass-table.js` pins these. **(20) Centre-first reading**: re-reads ordered by distance from the view centre; a disagreement favours the more central read slightly (side wall / distortion; not measurable on synthetic frames). **(11) Tab/blank by signed area: no change** - the current rule reads 99.3% of synthetic codes right at every piece size, signed area 10-19%; impossible 3+ flat reads: 0 in 421 real shapes since v0.9. **(19) Empty-board reference: not applicable** - dividing by a reference only works for a fixed camera; per-frame board-surface estimation (flattenLight) already does this for a moving phone |
| Research batch B1, matching (items 7, 12-16) | **Done** (v0.13.0) | (7) **Loops of loops**: a match whose 2x2 blocks close on both sides of the seam (each corner's best loop only - counting any closed loop was 37% precise) = 2x3: 103/132 right, with mutual best 98/98; new calibration feature `loop2` (weight 1.35), '2×3 ✓' label. (12) Seam colour by prediction: **rejected**, see Dead ends. (13) **One piece per box cell**: `PH.assignCells` sparse forward auction (eps 0.003, single round - eps-scaling with private "not placed" options sent ~60/96 pieces there) over each piece's candidate cells; `Engine.assignCellsNow` after snaps and at most every 2 s live, also applies the In-puzzle exclusion (t2.orig kept); synthetic 292 pieces: placement top-1 84.2% -> 87.0% (optimal 87.3%); 2 ms for 1000 pieces in node; box photo px per piece recorded (`box.srcPx`), warning under 48. (14) **Zones**: `PH.zoneOf` 3x2 / 2x3 areas A-F, chip + rings in zone colours (camera, Map) + tinted box picture. (15) **Fill this spot**: tap a spot on the enlarged box picture; `Engine.fillSpot` ranks loose pieces by print (relative to each piece's own best spot - raw placement scores are not comparable between pieces) + 0.6 x mean -log(calibrated probability) of being each known neighbour's partner on the facing edge; `test/solve-aids.js`: right piece first 74/80 vs 64/80 by the picture alone (raw edge scores as fit made it worse: 16/80). (16) **Frame chain**: `Engine.chainFor` - best candidate that is itself a border piece with its flat on the same side; 108/120 right |
| Research tier 1 (RESEARCH-ai-puzzle.md) | **Done** (v0.12.0) | (1) **Rotation hint**: `Engine.upOf` - the box placement's rotation gives the piece's top edge; arrow on the selected piece (camera view via rd + inverse pose, and Map) and an upright thumbnail; `test/trust.js`: 37/37 within 20 deg of the truth. (2) **Calibrated match probability**: logistic model on softmax logit, lead over the runner-up, mutual best (`PH.bestPartner`, cached), 2x2 loop, both confirmed, box, uncertain flat (`PH.CALIB_*`); starting weights from `tools/fit-calib.js` (held-out synthetic log-loss 0.236 -> 0.12, calibration error 0.048 -> 0.02); refit on the answer key (`Engine.refitCalib`, >= 12 answers with >= 3 of each, L2 pull toward the prior); each answer now logs its feature vector. (3) **Verdicts**: Strong (>= 85% and mutual or loop) / Likely / Maybe / Look-alike / Unlikely (dimmed); box spot in words + plain-piece warning (t2.tex < 0.2). (4) **In the puzzle**: `Engine.setInPuzzle` - its box cell leaves other pieces' candidates (`withoutTaken`, original kept in t2.orig for undo), finders skip it, Matches skips placed pairs, dimmed on camera and Map, counted. (5) **Capture coach**: per-frame share of detections within dE 25 of the board + glare (L >= 250); tip at >= 30% / 4%; synthetic: pale on white 100% flagged, 0/48 read right; on dark cloth 0% flagged, 48/48 right (no special "shape mode" needed - the background picker handles a dark cloth). (6) **Camera**: 4:3 1920x1440 request, 24 fps sweeping / 15 fps calm via applyConstraints (rate-limited), what iOS gave is in reports (video.settings, cameraFps) |
| Table view (owner idea) | **Done** (v0.10.1) | Built as the **Map** button: `js/tableView.js` draws each piece's own picture (thumbnail clipped to its outline) through the placement recorded at its read (`rd`: source px -> table, kept through group joins; when a piece moved its picture follows it with the angle marked stale until the next live read places it again; a read from another view keeps its own picture `pic`; a picture more than ~15% off the typical size - a distorted view, e.g. a wrong tilt reading - is drawn at the typical size). `test/table-view.js`: centred within 0.08 piece, angle within 1.7 deg, drawn size 0.96-0.98 of a piece; the e2e's fake tilt (gravity says 35 deg, video is flat) stretched reads up to 2x before the size rule, 0.82-1.08 after; e2e checks camera off, tap, Border, back to Scan. Design: camera-off top-down map of the scanned pieces with the same finders (Border/Corners/Edges/Unplaced), tap-a-piece panel with lines to its matches, and Matches stepping (zoom to each pair). Owner's decisions (2026-10-03): **one shared screen** (a phone or iPad lying on the table; no sharing/server), **real piece pictures** at their scanned position and angle (store a ~150 px thumbnail from each piece's best read + its rotation on the table map, from the read's corners and the pose at that frame), **rotatable** (two-finger twist / 90° button), pan/zoom/fit-all, separate scan groups as separate clusters; **pieces that moved are updated by rescanning** that area (no manual dragging/marking). Layout must also work on an iPad |
| Catalog stuck, new scan group every ~20 frames | **Done** (v0.10.2) | Reports 19:10/19:12: 3 pieces in 4.6 min, each in its own group. A fresh group has no anchors, so the next frame counted as lost, cataloguing paused 20 frames and the provisional pieces expired. A young group (< 3 located pieces) now keeps its pose, shifted by the pieces followed from frame to frame. `test/young-island.js`: 0 -> 45 of 48 |
| Finished border = the puzzle's real location (owner) | **Done, tap-to-mark** (v0.11.0) | More -> Mark the finished border: aim with the whole border in view, Capture, drag 4 numbered dots onto its outer corners (1 = box picture's top-left, clockwise; "Turn numbers" if rotated). `js/vision/frame.js` keeps that view's ORB features and re-finds it in live frames (every 0.7 s; carried with the table-map pose in between): box cell -> live view, so the selected piece's (or section's / region's) spot is lit inside the real border; "Show spot" folds the piece panel. Saved with the catalog (meta 'pframe'), forgotten on a new box/puzzle. `test/puzzle-frame.js`: cells within 0.02-0.13 cell across pan/turn/zoom, no false find; e2e marks and finds it |
| Automatic border finding (owner wants it) | Open | Needs a photo with the whole border in view (owner asked). Tried on the owner's video (IMG_3576, border only partly in view): ORB box art vs table 6-21 inliers (useless); box-patch matchTemplate no consensus; ring-colour mask fails under glass glare (border white L 140-220, hue drifts). Next idea: outer-edge line quad (Hough) with box aspect + a band check, proposed as the default corners on the Mark screen |
| Quick-suite 45 deg photo tilt | Open | `run-tests.js --quick`: the 45 deg synthetic photo gives 0 detections (also v0.9.1/v0.9.2); the full suite passes |
| Find chips over the piece panel | **Done** (v0.9.2) | Owner's screenshot: chips covered the Fits/No buttons. Hidden while the panel is open |
| Toolbar | **Done** (v0.9.1) | Snap retired from the toolbar (owner wasn't using it) → **Border** toggle (corners + edge pieces, `filter: 'edges'`); photo cataloguing kept under More |
| Live shape relocalisation | Unverified | `Engine.relocalizeByShape` on the lost-tracking path needs `d.t1` or silently does nothing (`shapeCands` early-returns on `!d.t1`); it reads a few outlines first now, but no real session has shown it firing (glass-table reports: tracking 0–5%). Check in the next report with tracking losses |
| Taught colours across tables | **Done** (uncommitted) | New puzzle asks whether to forget taught table colours; Clear everything always forgets them; forgetting also drops the background model chosen with them. `test/worker-reset.js` |
| Report fixes | **Done** (v0.7.0) | Black report frame (last view kept when the camera is released); tilt-border streaks marked out-of-image (alpha 0) and ignored |
| Lighting | **Done** (v0.7.0) | `PH.flattenLight` evens shadows (board surface by closing/opening/median at ~1/120 scale, ratio correction; skipped when light is even). Near-neutral, alike taught colours = plain board; stale taught colours (< 20% of frame) fall back per frame. Per-crop board lightness from the crop border in `analyzePiece`. Replays: 13:36 2 → 25 good, 13:42 0 → 29 good; close-2 9 → 14 |
| UI (owner) | **Done** (v0.7.0) | Tap the enlarged box picture to shrink it; Find buttons wrap (all reachable); top message wraps; banner/debug placed below the top bar's real height |
| Corners / duplicates | **Done** (v0.7.1) | One piece per box spot: `cornerDoubts()` keeps the most confident corner per corner spot (others doubtful, not counted/filtered); `dedupeByCell()` merges same-spot duplicates by shape+print, joins islands linked by >= 3 pairs, then merges same-position look-alikes (live: 3 ms every 20 frames; Tidy: all). `test/dedupe.js`: 96 entries / 2 islands / 8 corner-shaped -> 48 / 1 / 4. Partly covers WP7 |
| Dense piles / mixed table | **Done** (v0.8.0) | Reports 14:27-14:29 (chickens 1000-pc, glass table, dense piles): 0 detections because plain-board taught colours made the app call the white *pieces* the board. Now `chooseBackground()` scores candidates (4 common colours, pairs of the top 3, taught, palette) by size-consistent piece-shaped blobs; live re-checks run one candidate per still frame and switch only if 20% better. `PH.pileUnit` (distance-transform peaks) sizes pieces in piles with no isolated ones; whole piles may be split; one piece never sets the size if > 12% of the view; boundary fill skipped when it would claim > 30% of the remaining table. 14:28 0 -> 23 detections with tracking; white-board frames unchanged |
| Shape reading starved | **Done** (after v0.8.0) | Reports 14:41/14:42 (v0.7.1 on the phone, 300-pc white board): detection fine (45-98 per frame, tracking 100%) but only 3 of 282-360 pieces shaped - segmentation (188-395 ms) used the whole 45 ms budget, so T1 never ran. Now >= 2 shape reads per still frame regardless of budget |
| Tilt slowdown on phone | Partly done | `valid` mask is now always a Uint8Array (all-ones cache when untilted), so segment.js hot loops are monomorphic (JSC deopt hypothesis from open-items-survey); tilt correction skipped under 8 deg (< 1% distortion). Needs a tilted phone report to confirm |
| Far/steep views | Note | 14:29 (33 deg, far): pieces ~8 px after straightening - too small; hold the phone closer |
| Tilted report 13:40 | Checked | Straightened image replayed: 27 -> 76 good pieces with v0.7 segmentation |
| Repo hazard | Note | The repo lives in OneDrive: git intermittently fails with `.git/index: unable to map index file` while OneDrive syncs `.git` (clears on retry within seconds), and OneDrive conflict copies (`*-BBI-NB-*`) appear — now gitignored. Never `git add -A`; stage explicit paths |

**Phone reports 13:36–13:42 (v0.6.0, before WP1/WP2 shipped)** — replay any report with
`node test/report-replay.js reports/<report>.json --draw` (same taught colours, tilt, Scan detail):
- Speed is fine: 6–7 fps, `total` 44 ms median without tilt correction. **With tilt correction**
  `seg` is 108–115 ms: `seg_dist` 38–40 ms and `seg_thresh` 16–17 ms vs ~1 ms untilted, though the
  image is the same size (346–385×640). Not reproducible in node (38 ms total). Suspect GC from the
  per-frame warp allocations in `PH.rectifiedSource` — reuse buffers (WP5).
- **Taught background goes stale when the light changes.** The two taught colours are both the
  *shadowed* board (L 110–117); in the 13:42 report the lit board is L≈203, so the board itself is
  "foreground" (only 22% of the frame classed as background) → one huge blob → 0 pieces found among
  ~35 visible. In 13:36 the lit half fails the same way (published: 2 good; with WP1/WP2: 9, all on
  the shadow side).
- **Lamp shadows** on every frame (see NEW above): the dominant-colour model and the taught table
  both treat the shadowed vs lit board as different colours.
- Consequence: few detections → tracking lost (5% of frames in 13:42) → 16 → 25 → 35 islands and
  344 pieces + 25 sections for a 300-piece box.
- **Report frame is black** when the camera was released behind the menu (13:40) — capture the
  frame before releasing, or keep the last good frame.
- Tilt-corrected frames have `BORDER_REPLICATE` streaks at the edges that become border blobs —
  mark out-of-image pixels as background instead.

**Correction to §1.1 / WP2 step 2:** measured on all four frames, close 3 beat 5/7/9
at unit ~1000–2000 px² (larger kernels fuse neighbours; close 9 also lost pieces
on the close-up). The engine uses `clamp(odd(0.07·√unit), 3, 7)`, not 0.18·√unit.
Also: score segmentation against the result's *own* robust unit. The colour-only
unit under-sizes pale pieces, so complete pieces would look "merged".

---

## 0. How to work in this repo

**Node is not on PATH on this machine.** VS Code's bundled Node works:

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/run-tests.js        # full suite, ~2 min
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/run-tests.js --quick
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/live-sections.js    # seconds
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/seg-lab.js --draw   # segmentation lab
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/flow-lab.js         # motion tracker, synthetic
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/flow-video.js <dir> # motion tracker, real frames
```

Ground rules the owner has asked for:

- **Pointed tests over the browser e2e.** `test/e2e.js` takes minutes and its
  frame pacing is wall-clock dependent. Write a node-level test for the exact
  path you are changing (see `test/live-sections.js` as the model) and run the
  e2e once at the end.
- **Measure on the white-table frames**, not only on the synthetic puzzle. The
  synthetic puzzle has flat colours and never reproduces the real failures.
  `test/seg-lab.js` with no arguments runs the two report frames plus three
  fixtures; add video frames with `python` + `cv2` (see §A.3).
- Don't change a vision default without a before/after `seg-lab` table on
  `reports/puzzle-report-2026-10-03T03-08-58-frame.jpg` and `...03-14-50-frame.jpg`.

Lab tooling already in place:

| Tool | What it gives you |
|---|---|
| `test/seg-lab.js` | `PH.segment` on real photos at the live width, N option sets, per-stage ms, good/fragment/merged counts, `--draw` overlays in `test/out/` |
| `PH.segment(..., {timings:{}})` | per-stage ms; the engine forwards these as `timings.seg_*` so **phone reports now carry a stage breakdown** (`history[].seg_lab`, `seg_dist`, …) |
| `PH.segment` experimental opts | `openK`, `closeK`, `boundary` (`true` = OR edges, `'fill'` = closed-ring fill), `boundaryT`, `boundaryClose`. **All default to the old behaviour.** |
| `js/vision/flow.js` + `test/flow-lab.js` / `flow-video.js` | thumbnail motion tracker prototype, validated (see §1.3) |
| `test/live-sections.js` | deterministic live-frame section test |
| report `-box.jpg` | the rectified box picture with the grid drawn on it |

---

## 1. What was found (evidence)

### 1.1 Pale pieces vanish; only their colourful patches survive — that is the "splitting"

On the owner's white table, `PH.segment` classifies a pixel as foreground by
Lab distance from the background colour. A piece whose print is mostly pale
(sky, paper, cream) is within a few ΔE of the white table, so **the piece is
lost and only its colourful islands are detected**, each as a small
fragment. That is what the owner saw as "pieces with lots of colours getting
split into smaller shapes". It is a recall problem on pale pieces, not a
cutting problem on colourful ones. Look at
`test/out/puzzle-report-2026-10-03T03-08-58-frame-lab-baseline.jpg` (red =
fragment, missing outline = lost piece) next to `...-lab-fill_T10_c5.jpg`.

Measured at the live width (640), `good` = single piece with 4 good corners
and plausible area, `frag` = non-border blob under 0.45 × a robust unit area:

| frame (white table) | variant | good | frag | merged | boundary stage ms (node) |
|---|---|---:|---:|---:|---:|
| 03-08-58 | baseline | 20 | 8 | 0 | – |
| 03-08-58 | no 3×3 open | 24 | 5 | 0 | – |
| 03-08-58 | boundary OR | 28 | 2 | 0 | 3–5 |
| 03-08-58 | **boundary fill, T10, close 5** | **30** | **1** | 1 | 6 |
| 03-14-50 | baseline | 21 | 10 | 0 | – |
| 03-14-50 | no 3×3 open | 24 | 4 | 1 | – |
| 03-14-50 | **boundary fill, T10, close 5** | **25** | **1** | 3 | 5 |
| 03-14-50 | boundary fill, close 9 | 20 | 0 | 8 | 10 |
| video f0000 (closer) | baseline | 14 | 8 | 0 | – |
| video f0000 | boundary fill, T7, close 9 | **18** | **0** | 0 | 10 |

Readings:

- **The lightness-weight hypothesis is dead.** `lightW` 0.75 / 1.0 made both
  white frames slightly *worse* (good 20→18, 21→18). Don't spend time there.
- **The 3×3 `MORPH_OPEN` is shearing off tabs**: removing it alone cuts
  fragments roughly in half on both frames. But alone it does not recover the
  lost pale pieces.
- **A boundary (lightness-gradient) channel recovers the pale pieces.** A
  piece has a crisp outline against any plain table even where its print
  matches the table. Closing the edge rings and filling their interiors
  ("fill") is better than OR-ing raw edges: an unclosed ring then adds
  nothing instead of adding a stray fragment.
- **The close kernel must scale with piece size.** Close 5 is right at a unit
  of ~860 px² (pieces ~29 px), close 9 is right at ~2000 px² (~45 px), and
  close 9 at the small scale fuses neighbours (merged 0→8). Rule of thumb from
  the data: `closeK ≈ odd(0.17–0.2 × √unitArea)`, clamped to 3..9. Which is
  one more reason the unit area has to be stable (§1.2).
- **Under motion blur the boundary channel is unreliable** (video f0450:
  pale pieces come out as one-sided shadow slivers). That is acceptable: the
  engine only reads shapes on *still* frames, and §WP4 provides a sensor-free
  stillness signal. Gate the boundary channel on `still`.
- Cost: 5–7 ms in node at 360×640 for T10/close 5–7 (Scharr ×2, abs ×2, add,
  threshold, close, not, one flood fill, two ORs, one split). Expect ~3–5×
  that on the XR. Budget it; a half-resolution L plane is the first lever if
  it is too slow.

### 1.2 `unitArea` is recomputed from scratch every frame and is unstable

`PH.segment` estimates "one piece" as the median area of piece-like blobs in
*that frame*. Both the merged test in `Engine.classify` (`area > 1.9 ×`) and
the watershed splitter in `PH.segment` (`area > 1.8 ×`) key off it. Once pale
pieces are reduced to fragments the median drops, real pieces exceed 1.8× and
get watershedded along their print gradients — a self-reinforcing cascade.

Direct evidence of the instability (same photo, two resolutions; areas should
scale by 6.25):

| fixture | live unitA | snap unitA | ratio | expected |
|---|---:|---:|---:|---:|
| straight-1 | 702 | 2093 | 2.98 | 6.25 |
| pieces-3 | 789 | 2281 | 2.89 | 6.25 |
| close-1 | 5222 | 763 | 0.15 | 6.25 |

`close-1` fell back to the median of *all* blobs, which included a 578 456 px
background blob. `PH.segment` already accepts `opts.unitArea` and
`Engine.segOpts` never passes it.

### 1.3 A thumbnail motion tracker is viable — this is the "Night Sky" fix

Star-chart apps do no per-frame image analysis: pose from the IMU at 60 fps,
content from a static catalog. The analogue here is to run the real analysis
at 2–5 fps and move the last result's marks between analyses with a cheap
per-display-frame motion estimate.

`js/vision/flow.js` (`PH.flowGray`, `PH.flowShift`) does coarse-to-fine SAD
block matching on a ~64 px thumbnail with parabolic sub-pixel refinement.
Validated:

- Synthetic (`test/flow-lab.js`): worst error **0.14 thumbnail px** (≈ 3 px in
  a 1280-wide frame) over shifts up to 7.5 thumbnail px, **0.37 ms/call**.
- Real video (`reports/IMG_3568.MOV`, 315 frames sampled at 10 fps,
  `test/flow-video.js`): **261/314 steps confident**, transitivity (two steps
  = double step) violated in 3/86 triplets (fast-motion steps), **0.77 ms per
  call** on a 54×96 thumbnail in node. Expect single-digit ms on the XR.
- Featureless input reports `conf = 0` rather than a random shift.

The IMU works on the owner's phone (reports carry `gravity` and `tilt`), so
`isStill()` is live there. It gives rotation, not translation, so the
thumbnail tracker is still the better source for moving the marks. Its
per-frame shift is also a useful second stillness signal (AND it with the
sensor) and a fallback if a user denies motion permission.

### 1.4 Duplicate cataloguing and the O(dets × catalog) loops

From `reports/puzzle-report-2026-10-03T03-14-50.json`: 15×20 = 300 cells,
catalog 448 pieces + 84 sections across **39 islands** (232/52/46/36/…).
Every tracking loss forked a new island and re-catalogued the view. Partly
addressed (fork threshold 12→20, manual **Tidy up**, UI warning), but merging
is still manual and `assign()`/`findMoved()` scan the whole catalog per
detection with no spatial index; `map` time will dominate at 1000 pieces.

### 1.5 Per-stage timing on device is still unknown

In node the stages are all 1–6 ms at 640 and nothing dominates; the phone is
10–25× slower overall (184–500 ms `seg`). Phone reports now include the
breakdown (`history[].seg_*`). **Get one report from a real 2-minute session
before optimising any particular stage** (WP5).

---

## 2. Work packages

Sizes: S = hours, M = a day, L = several days. Each WP lists the acceptance
check that must pass; "suite" means `test/run-tests.js` + `test/live-sections.js`.

### WP1 — Stable unit area carried across frames (S) — do this first

**Why:** breaks the fragmentation cascade (§1.2) and is required by WP2's
adaptive close kernel and WP3's guard.

**Where:** `js/vision/engine.js` (`segOpts`, `processFrame`, `startIsland`,
`relocalize`), `js/vision/segment.js` (around `let unitA = opts.unitArea`).

**Approach:**
1. Engine keeps `this.unitLive` (proc px² at the live width). After each
   frame, if the frame's own estimate came from ≥ 3 piece-like blobs and is
   within 1.5× of `unitLive`, blend it in (`k ≈ 0.2`); otherwise keep the
   prior. Seed it from the first frame that has ≥ 3 piece-like blobs.
2. Pass `unitArea: this.unitLive` in `segOpts` for live frames only (a Snap is
   a different photo at a different height — let it self-estimate, but apply
   the same ≥ 3-blob rule there).
3. In `PH.segment`, when `opts.unitArea` is given still compute the frame's
   own `like` list and return both (`unitArea` used, `unitOwn`, `unitN`) so
   the engine can apply the rule above.
4. Reset `unitLive` when `procW` changes (Settings → Scan detail) and scale it
   when the camera height changes: `unitFrame(dets)` vs the prior tells you.
5. Replace the `median(all blobs)` fallback with "no estimate" (`null`) and
   have callers treat `null` as "don't split, don't call anything merged".

**Acceptance:** new `test/unit-area.js`: run the live sweep from
`run-tests.js` while erasing random pale bands across 30% of pieces in each
frame (simulate lost print); assert `unitLive` stays within 20% of the true
piece area throughout and the catalog does not exceed `n × 1.05`. Suite green.

### WP2 — Boundary-fill segmentation on still frames (M)

**Why:** §1.1 — the only change that recovers pale pieces: good 20→30 and
21→25 on the owner's frames, fragments 8→1 and 10→1.

**Where:** `js/vision/segment.js` (`opts.boundary === 'fill'` block, already
prototyped), `js/vision/engine.js` (`segOpts`, `processFrame`).

**Approach:**
1. Make `'fill'` the live default **only when `info.still` is true**; keep the
   colour-only path for moving frames (blur makes the edges one-sided).
2. `boundaryClose = clamp(odd(round(0.18 × √unitArea)), 3, 9)` using WP1's
   `unitLive`; with no estimate yet, use 5.
3. Keep `boundaryT = 10` (the Scharr magnitude is scaled by 1/16). `T7` only
   won on the close-up frame; `T16` lost pieces on 03-14-50.
4. The ring adds ~1 px of outline swelling. The live mask only feeds
   detection/tracking (`PH.analyzePiece` re-thresholds its own full-res crop),
   so shape quality is unaffected — but check `fp` (colour fingerprint)
   stability frame-to-frame, since it samples inside the mask.
5. Drop the 3×3 open when the boundary channel is on (it was shearing tabs;
   the boundary ring makes it redundant). Measure; if it brings back table
   speckle, use open 3 on the *colour* mask only, before the OR.
6. Cost control: if `seg_boundary` on the phone exceeds ~25 ms, compute the L
   plane and Scharr at half resolution and upsample the ring mask (nearest).

**Acceptance:** `seg-lab` on both white frames: good ≥ 28 / ≥ 24, frag ≤ 2,
merged ≤ 3 at the live width. Suite green. `WP8` regression test added and
green. A phone report whose `seg_boundary` median is under 25 ms.

### WP3 — Guard the watershed splitter (S–M)

**Why:** `PH.splitBlob` fires on area alone; with a bad unit it cuts real
pieces along print gradients (straight-1: 36 fragments out of 45 blobs, 6 of
them from the splitter).

**Where:** `js/vision/segment.js` (`splitBlob`, the `b.area > 1.8 * unitA` gate).

**Approach:**
1. Veto: never split a blob whose `PH.pieceScore` already exceeds
   `2 × MIN_CORNER_SCORE` and whose area is under `2.6 × unit`.
2. Require a real neck: after `connectedComponents` on the seeds, split only
   if the distance-transform saddle between two seed components is below
   `0.6 ×` the smaller component's peak distance (a two-piece clump has a
   narrow waist; a single piece with print texture does not).
3. Accept the watershed result only if every part has area ≥ 0.5 × unit and
   `pieceScore > MIN_CORNER_SCORE`; otherwise keep the whole blob.
4. With WP1's `null` unit → no splitting at all.

**Acceptance:** suite green (the sections test depends on splitting clumps;
`live-sections.js` must stay at 100% overlap). `seg-lab` on straight-1: frag
≤ 20 (from 36) with good not lower. White frames unchanged or better.

### WP4 — Motion-tracked overlay + sensor-free stillness (M–L)

**Why:** §1.3. Marks that follow the camera at display rate are the
difference between "laggy" and "feels like a lens app", independent of how
fast analysis gets.

**Where:** `js/main.js` (`loop`, `sendFrame`, worker `frame` handler),
`js/overlay.js` (`frameMapping`), `index.html` (load `js/vision/flow.js` as a
classic script before `main.js`, it is an IIFE on `self`), `js/vision/flow.js`.

**Approach:**
1. Every other `requestAnimationFrame` while active: `drawImage(video)` into a
   64-px-wide `OffscreenCanvas` (`willReadFrequently`), `getImageData`,
   `PH.flowGray`, `PH.flowShift(prevThumb, thumb, w, h, {range: w/6})`.
   Accumulate a running total `S.flowTotal += shift` (thumbnail px) when
   `conf ≥ 0.25`; when `conf < 0.25` hold (no update) and set a flag.
2. In `sendFrame`, record `S.flowAtGrab = S.flowTotal` with the frame. When
   the worker result for that frame arrives, store `result.flowBase =
   flowAtGrab`. Offset to draw with = `(S.flowTotal − result.flowBase) ×
   (result.procW / thumbW)` in proc px.
3. `frameMapping(video, canvas, res, offset)`: translate proc coordinates by
   the offset before the existing transform (with tilt correction, apply the
   translation in proc space before `Hinv`; it is an approximation that
   holds for small inter-analysis motion).
4. Hit-testing (`overlay pointerup`) must use the same offset.
5. Lost: if `|shift|` hits the search range or `conf` stays low for > 300 ms,
   stop compensating (draw marks un-offset, dimmed) until the next result.
6. Stillness: `still = |shift per frame| < 0.3 thumbnail px` over the last
   ~150 ms. Use it in place of `isStill()` when `S.hasMotion` is false, and
   AND it with the sensor when available. This stops shape reads on blurred
   frames on iOS Chrome.
7. Report: add `flow: {meanAbs, confHist, lostCount, msPerCall}` to the
   diagnostic JSON.

**Acceptance:** `flow-lab.js` and `flow-video.js` green. New
`test/flow-overlay.js`: with synthetic frames and a known shift between the
analysed frame and "now", `frameMapping` with the offset puts a mark within
3 frame px of the true piece centre. Suite green. On device (owner check):
marks stay on pieces during a slow pan with analysis at ~2 fps.

### WP5 — Phone profile, then one targeted optimisation (M, after data)

**Why:** §1.5 — nothing dominates in node; the phone's distribution is unknown.

**Approach:**
1. Ask the owner for one report after a 2-minute real session (reports now
   carry `history[].seg_*`). Compute medians of `grab`, `seg_lab`, `seg_dist`,
   `seg_morph`, `seg_blobStats`, `seg_dets`, `seg_split`, `map`, `work`.
2. Decision rule:
   - `seg_lab + seg_dist` dominate → move Lab conversion + ΔE into one WASM or
     WebGL pass (pure per-pixel kernel), or read back only a binary mask.
   - `seg_blobStats + seg_dets` dominate → cache `fp`/`pieceScore` for
     detections linked to tracked pieces (skip recompute when the blob moved
     < 1 px and area changed < 5%).
   - `grab` dominates → `createImageBitmap` with `resizeWidth` to the proc
     width (lets the browser downscale on the GPU) instead of full-res
     bitmaps.
   - `map` dominates → WP6.
3. Only one of these per PR, measured against the same report format.

**Acceptance:** before/after `history` medians from the device; node suite green.

### WP6 — Spatial index for `assign()` / `findMoved()` (M)

**Why:** O(dets × catalog) per frame; a 1000-piece puzzle will spend most of
`map` here.

**Where:** `js/vision/engine.js` (`assign`, `nearest`, `findMoved`, `fitPose`).

**Approach:**
1. Uniform grid over table coordinates, cell = `2 × unitTable()`, keyed by
   `island`. Rebuild per frame in O(n) (cheap) or maintain on `touch()`.
2. `nearest()` queries the 3×3 neighbourhood only.
3. `findMoved()`: pre-filter by area ratio (cheap) before `fpSimilarity`;
   index shaped pieces by `PH.canonicalCode(t1.code)` so `samePiece` only runs
   against the ~1/20 of the catalog with the same edge-type pattern.

**Acceptance:** new `test/scale.js`: import a synthetic 1000-piece catalog
(positions on a grid, random `fp`) and time `processFrame` on a frame with 30
detections: `map` < 8 ms in node (now: measure first and record). Suite green.

### WP7 — Automatic island merging (M)

**Why:** §1.4 — Tidy is manual and O(shaped²).

**Where:** `js/vision/engine.js` (`tidy`, `processFrame`, `relocalize*`).

**Approach:**
1. Incremental background merge: each frame, within a 3 ms budget, take the
   next few shaped pieces from the current island and look for a same-shape
   piece in another island using the canonical-code index from WP6; on ≥ 3
   consistent matches between two islands, fit a similarity and merge (the
   `mergeIslandsByShape` logic already exists for snaps — generalise it).
2. On successful `relocalize()` onto island A while the previous island was
   B and B was created recently (< 60 s) with few pieces, merge B into A
   using the pieces seen in both.
3. Drop sections whose placement failed 3 times.

**Acceptance:** new `test/islands.js`: run the live sweep, force
`startIsland()` at frame 15 and again at 30 (simulated losses), continue the
sweep; assert `counts().islands === 1` and `pieces ≤ n × 1.05` at the end
*without* calling `tidy()`. Suite green.

### WP8 — Fragment-rate regression test on real frames (S) — do alongside WP1/WP2

**Why:** there is no regression guard for the real failure mode; the synthetic
puzzle never reproduces it.

**Approach:**
1. Copy `reports/puzzle-report-2026-10-03T03-08-58-frame.jpg` and
   `...03-14-50-frame.jpg` into `test/fixtures/white-1.jpg`, `white-2.jpg`;
   add two sharp frames from `IMG_3568.MOV` (e.g. f0000, f0900) as
   `white-close-1/2.jpg`.
2. `test/seg-regression.js`: for each, run `PH.segment` at 640 with the
   engine's live defaults, compute good/frag with the `seg-lab` classifier,
   assert thresholds (set to the post-WP2 numbers minus a small margin).
3. Add it to `npm test`.

### WP9 — Blur rejection without sensors (S) — folded into WP4 step 6

Listed separately so it is not lost if WP4 is deferred: a Laplacian-variance
sharpness score on the 64-px thumbnail (one `cv.Laplacian` on a tiny image) is
a fine standalone stillness proxy and can ship before the overlay work.

---

## 3. Order and parallelism

```
WP8 (fixtures + regression test)   ─┐
WP1 (stable unit)  ──► WP2 (boundary fill) ──► WP3 (splitter guard)     agent A
WP4 (motion overlay + stillness)                                         agent B  (independent)
WP6 (spatial index) ──► WP7 (auto island merge)                          agent C  (independent)
WP5 (phone profile → one optimisation)      after the owner sends a report
```

Agents A/B/C touch different functions: A is `segment.js` + `Engine.segOpts`/
`processFrame`; B is `main.js`/`overlay.js`/`flow.js`; C is `Engine.assign`/
`findMoved`/`tidy`. Merge conflicts are limited to `engine.js`
`processFrame`; keep those edits small and rebase often.

---

## 4. Dead ends — don't repeat

- **Per-piece texture rescue in the shape read (2026-10-03).** A third mask attempt in analyzePiece from local lightness texture (after colour and the outline ring). Synthetic: on moderately pale tables no change in correct edge codes (39 and 27 either way); on an extremely pale table it only added shapes that were wrong (photo: 0 codes right before and after). Not shipped. The whole-frame texture channel (on only while the coach measures pale pieces blending in) was kept: catalogued 19 -> 31 of 48 there, +1-2 shapes on moderately pale tables, no change on normal setups or the owner's frames.
- **Seam colour by prediction (research item 12, 2026-10-03).** A second colour strip twice as deep, each side extrapolated across the seam and compared with the other (Gallagher-style), mixed half and half with the plain colour difference. On synthetic puzzles (tools/fit-calib.js, 9 tables) it made matching worse: top suggestion right 66.3% -> 66.2% (step 0.5) -> 65.6% (step 1), softmax log-loss 0.236 -> 0.283 -> 0.392. Reverted. Worth re-testing only with real labelled answers (the answer key) on a strongly pictorial puzzle.

- **Raising `lightW`** on a white table: measured worse on both frames.
- **A larger close kernel alone** (`close 9`): fewer fragments but fuses
  neighbours at the small scale; must scale with the unit area (WP2 step 2).
- **Sections area gate** (`area ≥ 3 × unit` before cataloguing a section): it
  starved the live-frame section path; reverted. Clean up failed sections
  instead (WP7 step 3).
- **Blocking island forks for a long time** (`lost > 45`): stalls cataloguing
  entirely; 20 is the compromise until WP7 lands.
- **Matching the box ART against the table** (ORB, or box-patch template
  matching at the known piece scale) to find the assembled border: print vs.
  real pieces under glass is too different (6-21 ORB inliers). Match camera
  view against camera view instead (`js/vision/frame.js`: hundreds of inliers).
- **The browser e2e "assembled section" check** was failing because the fake
  camera is a video file that restarts when the page releases the camera
  behind a modal (which the owner wants). It now falls back to selecting the
  section from the catalog; the engine path is covered by `live-sections.js`.

---

## A. Appendix

### A.1 Full lab tables (640 live width; node timings)

See the run logs in the conversation of 2026-10-03; re-create with:

```
seg-lab.js --variants='[{"label":"baseline"},{"label":"no open","openK":0},
  {"label":"fill T10 c5","boundary":"fill"},{"label":"fill T10 c7","boundary":"fill","boundaryClose":7},
  {"label":"fill T10 c9","boundary":"fill","boundaryClose":9}]' --drawv="fill T10 c5"
  reports/puzzle-report-2026-10-03T03-08-58-frame.jpg reports/puzzle-report-2026-10-03T03-14-50-frame.jpg
```

### A.2 Metric definitions used by `seg-lab.js`

- *robust unit*: mass-weighted mode of log₂(area) over blobs with
  `pieceScore > MIN_CORNER_SCORE` (fragments are many but carry little mass).
- *good*: non-border, `pieceScore > MIN_CORNER_SCORE`, area in [0.6, 1.6] × unit.
- *frag*: non-border, area < 0.45 × unit.
- *merged*: non-border, area > 1.9 × unit.
Perspective makes near pieces bigger than far ones, so a few "merged"/"other"
labels on a correct outline are metric artefacts; always look at the drawing.

### A.3 Extracting frames from the owner's video

```python
import cv2, os
cap = cv2.VideoCapture('reports/IMG_3568.MOV')   # 1080x1920, 30 fps, 943 frames
i = 0
while True:
    ok, fr = cap.read()
    if not ok: break
    if i % 3 == 0: cv2.imwrite(f'out/f{i:04d}.jpg', fr, [cv2.IMWRITE_JPEG_QUALITY, 92])
    i += 1
```
`python` with `cv2` 5.0 is installed on this machine; `ffmpeg` is not.
