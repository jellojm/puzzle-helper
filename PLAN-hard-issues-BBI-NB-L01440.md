# Puzzle Helper — plan for the hard issues

Implementation plan for engineers/agents picking up the vision and performance
work. Every claim below was measured in this repo on 2026-10-03; the tools used
are checked in, so re-measure before and after each change.

Target device: **iPhone XR (A12, 2018, 3 GB)** running **Chrome on iOS**
(WKWebView: same engine as Safari, but no Wake Lock API, no Add-to-Home-Screen,
and motion-sensor permission is usually off). Table: white board, warm lamp,
pale-printed pieces (see `reports/*-frame.jpg`).

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

The IMU is *not* a good primary source here: on iOS Chrome the motion
permission is usually off, and then `isStill()` already returns true always
(so shapes get read from blurred frames). The tracker's per-frame shift
magnitude doubles as a sensor-free stillness signal.

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

- **Raising `lightW`** on a white table: measured worse on both frames.
- **A larger close kernel alone** (`close 9`): fewer fragments but fuses
  neighbours at the small scale; must scale with the unit area (WP2 step 2).
- **Sections area gate** (`area ≥ 3 × unit` before cataloguing a section): it
  starved the live-frame section path; reverted. Clean up failed sections
  instead (WP7 step 3).
- **Blocking island forks for a long time** (`lost > 45`): stalls cataloguing
  entirely; 20 is the compromise until WP7 lands.
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
