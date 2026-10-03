# Open technical issues — handoff notes

Written for: an engineer picking up the vision/perf work on Puzzle Helper.

Context for all of it: the target device is an **iPhone XR (A12, 2018, 3 GB)**,
usually running **Chrome on iOS** (which is WKWebView — same engine as Safari,
the owner confirms Add to Home Screen works and the screen stays awake; motion
sensors work too, per the reports). Measurements below come from
two real session reports in `reports/` (2026-10-03) plus the fixtures in
`test/fixtures/`.

Everything in this file is *unfixed*. The UI/power work that was done is in the
git history; this is the list that was deliberately left alone because each item
needs real investigation and its own measurements.

---

## 1. The overlay is slow because the architecture couples drawing to analysis

**Symptom (user's words):** "how does night sky app or other lens type programs
draw overlay so fast. we are missing some sort of speed."

**Why those apps are fast:** star-chart apps do *no per-frame image analysis*.
They render a precomputed catalog using an IMU-derived pose at 60 fps on the
GPU; the camera is just a backdrop layer. Pose is cheap (gyro integration),
content is static.

**What this app does per live frame** (`main.js: sendFrame` → `worker.js: frame`
→ `engine.processFrame`):

1. `createImageBitmap(video)` — 7–110 ms on device (see `history[].grab`).
2. `getProc()` — `drawImage` + **`getImageData`** full RGBA readback.
3. `PH.rgbaToLab` over every pixel.
4. `PH.estimateBackground` (every 3rd pixel, two passes).
5. The ΔE distance loop over every pixel.
6. Otsu + threshold + `MORPH_OPEN` + `MORPH_CLOSE` + `findContours`.
7. Per blob: `convexHull`, `pieceScore`, `moments`, `minAreaRect`, `arcLength`,
   a `drawContours` mask, and the `PH.fingerprint` loop.
8. Optionally `splitBlob` watershed per clumped blob.

Measured `seg` on device: **184 ms median (report A) → 500 ms median (report B)**
as the catalog grew. End-to-end fps fell **4.2 → 1.35**. The same code on a
desktop runs `seg` in 15–19 ms, so the device is ~10–25× slower — these are
per-pixel JS loops over typed arrays plus WASM OpenCV, with thermal throttling
on an A12.

The overlay then only repaints when a worker result arrives, so marks lag the
camera by a whole analysis period and visibly jump.

**What was already done** (don't redo): markers instead of outlines by default,
all `ctx.shadowBlur` removed, outline simplification 1.5 → 2.5 px, live analysis
width 960 → 640 (`Engine.opts.procW`, Settings → Scan detail), redraw gated on
new results, adaptive frame pacing, camera released behind menus.

**What is left, in order of expected payoff:**

- **Decouple the mark positions from the analysis rate.** Between analyses,
  transform the last result's marks by a cheap per-frame motion estimate so they
  stay glued to the pieces at 60 fps. Two candidate sources:
  - IMU: `S.gravity` + `rotationRate` are already collected in `main.js`. Gives
    rotation, not translation — enough for a hand sweep at a fixed height.
    Works on the owner's phone (reports carry `gravity`/`tilt`); still keep a
    fallback for users who deny motion permission.
  - Tiny optical flow: downsample the video to ~64×48 grayscale on a canvas
    (~3k pixels, well under 1 ms) and estimate (dx, dy, scale) against the
    previous downsample. Sensor-independent, and the right answer for this app.
  Apply the result as a 2D transform in `frameMapping` before drawing.
- **Stop the full-resolution readback.** `getImageData` at 640×360 is still
  230k px of readback per frame. Consider `WebGL`/`WebGPU` for the Lab
  conversion + thresholding (it is a pure per-pixel kernel), reading back only
  the binary mask, or even only the contour summary.
- **Move the per-pixel loops to WASM.** `rgbaToLab` and the ΔE loop are plain JS
  over `Uint8ClampedArray`. They are the two hottest passes and are trivially
  vectorisable.
- **Cache the fingerprint work.** `PH.fingerprint` runs for every blob every
  frame, including for pieces that were already identified and have not moved.

---

## 2. Pieces with busy print get carved into fragments

**Symptom (user's words):** "pieces with lots of colors were getting split into
smaller shapes. this was against a white background."

**Reproduce:** `node test/real-pieces.js test/fixtures/straight-1.jpg` and look
at `test/out/straight-1-seg.jpg`. Orange outlines trace *print texture* inside
the large dark-patterned pieces instead of their boundaries, and the whole pale
right-hand region of the table is missed entirely.

### There are two independent mechanisms, and they feed each other

**(a) Thresholding cuts a piece in half.**
`PH.segment` classifies a pixel as foreground by ΔE from the background, with
`lightW = 0.5` — lightness is *halved* in the distance. On a dark cloth that is
right (it tolerates shadows). On a **white** table, lightness is almost the only
thing separating a pale print region from the table, and it is exactly the
channel being suppressed. Pale bands inside a piece then fall below threshold.
`MORPH_OPEN` (3×3) erodes the remaining thin connections and `MORPH_CLOSE`
(5×5) only bridges ~4 px, so a pale band ~6 px wide severs the blob, and
`RETR_EXTERNAL` hands back two unrelated contours.

Note interior *holes* alone are harmless (`RETR_EXTERNAL` ignores them). Only a
band that crosses the whole piece splits it.

**(b) `unitArea` collapses, and then the splitter attacks real pieces.**
`PH.splitBlob` (watershed) fires on any blob with `area > 1.8 * unitA`, and
`classify()` calls a blob `merged` when `area > medA * 1.9`. Both are keyed to
one number. `unitA` is the median area of "piece-like" blobs *recomputed from
scratch every frame*, so once (a) produces fragments, the median drops, real
single pieces start exceeding `1.8 * unitA`, and watershed cuts them — on a
colourful piece it cuts along the strong internal colour gradients, producing
exactly the "smaller shapes" reported. Self-reinforcing.

**Direct evidence of the instability.** With `DBG=1`, the same photo analysed at
the live width and at the snap width (6.25× the area) gives:

| fixture      | live `unitA` | snap `unitA` | ratio | expected |
|--------------|-------------:|-------------:|------:|---------:|
| `straight-1` |        701.75|          2093|  2.98 |     6.25 |
| `pieces-3`   |        789.25|          2281|  2.89 |     6.25 |
| `close-1`    |          5222|        763.25|  0.15 |     6.25 |

`close-1` is the clearest failure: only one blob qualified as "piece-like", so
`unitA` fell back to `median(all blob areas)` — which included a 578 456 px
background blob.

### Suggested fixes, cheapest first

1. **Carry `unitArea` across frames.** `PH.segment` already accepts
   `opts.unitArea` and the engine **never passes it** (`Engine.segOpts`). Feed
   it a smoothed estimate (the engine already has `unitTable()`), and reject
   per-frame estimates that jump more than ~1.5×. This alone breaks the cascade
   and is a few lines. Do this first and re-measure before anything else.
2. **Make `lightW` adapt to the background.** When `bg.L` is high (a white
   table), raise the lightness weight; when low, keep it suppressed. A fixed
   0.5 cannot be right for both felt and white melamine.
3. **Add a boundary channel.** A piece has a crisp outline against *any* plain
   table. A Scharr/Sobel magnitude, closed into a boundary mask and OR-ed with
   the colour mask, is far more lighting-robust than colour distance alone and
   would fix both the white-table case and the glass-table case in
   `straight-1`.
4. **Guard `splitBlob`.** Require evidence of a real neck (a saddle in the
   distance transform between two seed components) before cutting, and never
   split a blob whose `PH.pieceScore` already says it is a good single piece.
5. **Reconsider the background LUT on busy tables.** `straight-1` is a glass
   table, so `buildBgLut` uses the box palette; it classifies the pieces' own
   dark/patterned pixels as background. Worth checking whether the
   `paletteRatio` of 8 is doing more harm than good on dark prints.

### Suggested test

Write a pointed fixture test (seconds, not minutes) that asserts a *fragment
rate* on the real photos: segment each `test/fixtures/*.jpg`, count blobs whose
area is below ~0.5 × the robust unit area, and fail if the fraction rises.
Right now there is no regression guard on this at all — the synthetic puzzle in
`run-tests.js` has clean flat colours and never reproduces it.

---

## 3. Duplicate cataloguing ("300-piece puzzle shows 448 pieces")

**Symptom:** the catalog grows past the real piece count.

**Diagnosis from `reports/puzzle-report-2026-10-03T03-14-50.json`:** the box is
15×20 = **300** cells, but the catalog held **448 pieces + 84 sections** spread
over **39 scan islands** (island 4: 232, island 28: 52, island 27: 46, island 6:
36 …). Every time tracking is lost, `Engine.processFrame` calls `startIsland()`,
which parks a brand-new coordinate frame 5000 units away; every piece in view is
then re-catalogued as new. `mergeIslandsByShape` only ever ran inside
`processSnap`, never during live scanning, so islands accumulated.

**Partly addressed:** the fork threshold was raised (`lost > 12` → `> 20`), a
shape-based relocalisation attempt was added on the lost path, and a manual
**Tidy up** action (`Engine.tidy()`, Settings) now folds duplicate islands
together by shape and drops never-identified leftovers. The UI also warns when
the count exceeds the box's cell count or when there are more than 3 islands.

**Still open:**
- Tidy is manual and O(shaped²) in `PH.samePiece`. It should run incrementally
  in the background, and it needs a cap or an index before a real 1000-piece
  puzzle.
- The lost-path `relocalizeByShape` reads at most 8 outlines per attempt
  (once per 1.2 s) — that budget is a guess, never tuned against a real session.
- `assign()` and `findMoved()` are **O(dets × catalog)** per frame with no
  spatial index. At 500 entries this is already a measurable share of `map`
  time; at 1000+ it will dominate. A grid index over `p.pos` is the obvious fix.
- Nothing merges islands automatically once tracking recovers.

---

## 4. Smaller things worth a look

- `Engine.relocalizeByShape` on the live path needs `d.t1` to be populated or it
  silently does nothing (`shapeCands` early-returns on `!d.t1`). It now reads a
  few outlines first, but verify it actually fires in a real session — the
  reports show `tracking: false` across whole windows.
- Section entries that fail to place (`p.sec.failed`) are only cleaned up by
  Tidy. The 84 sections in report B were mostly clumps of touching pieces, not
  real assembled blocks.
- `test/e2e.js` check *"tapping an assembled section shows where it goes"* is
  timing-sensitive: it requires a section to be on screen at the moment it
  polls, and the frame pacing is wall-clock dependent. `test/live-sections.js`
  covers the same engine path deterministically in seconds — prefer it, and
  consider making the e2e check tolerant.
- The report now includes the rectified box picture with the piece grid drawn
  over it (`puzzle-report-*-box.jpg`), which makes a wrong grid or bad corner
  placement obvious. Use it when triaging placement complaints.
