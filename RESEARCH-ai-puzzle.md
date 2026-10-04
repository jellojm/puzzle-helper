# Research: AI puzzle solving and iPhone sensing — what to adopt

2026-10-03. Five research passes (piece finding and shape reading, matching and solving, iPhone browser limits, existing apps, a feature-gap matrix), merged and checked against our code at v0.11.1. Sources are linked inline. **(inf)** = the researcher's inference, not a measured or published result.

## The short version

- **Nobody has solved pale pieces on a pale table in software.** Every project that read white pieces reliably changed the *capture*: backlight, black felt, or scanning the backs ([Jigzilla](https://hackaday.com/2022/08/04/jigsaw-puzzles-are-defeated/), [puzzle-bot](https://github.com/roksenhorn/puzzle-bot), [Nerdshack](https://nerdshack.co.uk/solving-jigsaw-puzzles/), [jigsawlutioner](https://github.com/byWulf/jigsawlutioner)). The closest comparable app, [Piece Finder](https://github.com/Harstil/piece-finder), lists "colours matching the table are missed" as its main limit.
- **Trust comes from consistency, not from a better pair score.** A single pairwise match is unreliable. Matches confirmed by loops, by mutual-best, or by a large lead over the runner-up are reliable ([Son et al. ECCV 2014](https://faculty.cc.gatech.edu/~hays/papers/puzzle_eccv14.pdf), [Pomeranz 2011](https://www.cs.bgu.ac.il/~ben-shahar/Publications/2011-Pomeranz_Shemesh_and_Ben_Shahar-A_Fully_Automated_Greedy_Square_Jigsaw_Puzzle_Solver.pdf), [Paikin & Tal 2015](https://www.cv-foundation.org/openaccess/content_cvpr_2015/app/3B_042_ext.pdf)). Our 2×2 check is the right idea; extend it.
- **Placement on the box picture is "right region, not exact cell"** at 300–1000 pieces. SIFT placement falls from 91% to 54% between 24 and 96 pieces ([WPI MQP](https://digital.wpi.edu/downloads/9593tz483)). Users of the Android apps say "the region is mostly correct". Show honest confidence.
- **No machine learning in the live loop on an iPhone XR.** It is capped at iOS 18, so there is no WebGPU. ONNX Runtime Web's WebGPU backend fails on iOS ([ORT #22776](https://github.com/microsoft/onnxruntime/issues/22776)). The XR also has no WebXR, ARKit or depth from the web.
  - Realistic: a small (<10 MB) WASM model on one steady crop, about 13 ms on an A13 ([zenn](https://zenn.dev/kaz_sakai/articles/ios-safari-onnx-memory?locale=en)).
  - Not realistic: SAM or YOLO-seg per frame.
  - General chat-model vision is about 30% on jigsaws ([John August](https://johnaugust.com/2026/ai-jigsaw-puzzles)).
- **Our OpenCV.js has no SIMD.** The researcher checked the exact 4.10 bundle we ship: 0 SIMD instructions. A custom build is the biggest untapped speed lever.
- **Where we're ahead:**
  - a live multi-piece sweep with a table map;
  - pair matching across the whole table, with a 2×2 check;
  - tilt correction from the gravity sensor;
  - background teaching;
  - the shared Map and Mark border;
  - an answer key.

  No other app found combines these. PuzPal does pair matching, but shape-only and one piece at a time. Piece Finder does a live sweep, but box placement only.

## Ranked plan

Effort: S ≈ a day, M ≈ a few days, L ≈ a week or more. "Verified" means checked in our code today.

### Tier 1: cheap, high value — **done in v0.12.0** (see PLAN-hard-issues.md)

1. **Rotation hint ("turn ↻ 90°")** — S, high.
   - **Verified:** box placement already finds each piece's rotation (`box.js:304`, `t2.cands[0].rot`). It only reaches the diagnostics report (`worker.js:305`) and is never shown.
   - Show it in the Find panel and as an arrow on the piece, as [Piece Finder](https://github.com/Harstil/piece-finder) does (`src/engine/pose.ts`) and as [johnb8005](https://github.com/johnb8005/puzzle-piece-finder) does.
2. **Trustworthy match ranking** — S–M, high.
   - Add features: the margin between the best and second-best candidate (Paikin & Tal), mutual-best ("best buddies": 99.7% precision in Pomeranz), and loop order.
   - Feed them into a small logistic/Platt calibrator trained on the Fits/No answer key. That replaces the hand-set MATCH_TEMP / MATCH_NULL, which are effectively a 2-parameter calibrator. Use sigmoid calibration under ~1000 answers ([sklearn](https://scikit-learn.org/stable/modules/calibration.html)).
   - **Verified:** the matcher uses a softmax with a null hypothesis today, with no margin or mutual-best feature.
3. **Honest verdicts and abstention** — S, high perceived trust.
   - Words instead of bare percentages: "Strong match" / "Likely" / "Several spots look alike" ([johnb8005](https://github.com/johnb8005/puzzle-piece-finder) `verdict.ts`).
   - Grey out suggestions with a low margin and no loop support, especially for near-identical "ribbon" cuts, where shape cannot decide ([jigsawlutioner](https://github.com/byWulf/jigsawlutioner): only Ravensburger-style cuts solve by shape).
   - For the box: a lock/margin rule (Piece Finder locks at top ≥ 0.55 and margin ≥ 0.25 over ≥ 2 views, `tracker.ts`), and a per-region "low confidence: sky" warning.
4. **"In puzzle" marking with exclusion, undo and progress** — S–M, high.
   - The user marks a piece as physically placed. That box cell leaves every other piece's candidates (Piece Finder `forgetCell()`), and the piece dims on the camera view and the Map. Add a progress count and undo.
   - It needs a new name: our "placed" already means "found on the box".
5. **Capture coach and "shape mode"** — S, high for pale pieces.
   - Before scanning, check contrast, glare and distance.
   - When pieces are pale on a pale board, suggest a dark cloth, or a tablet showing white under the glass table (backlight). Offer a shape-only background model: a luminance threshold, no colour logic.
   - Optionally do a separate colour pass, which is jigsawlutioner's two-photo pattern.
   - Also mention cross-polarising film for glare on the glass table ([guide](https://docs.sharktacos.com/photography/xpol.html)).
6. **Camera request: 720p or 4:3 at ~20 fps, and read back `getSettings()`** — S.
   - We request 1080×1920 and immediately shrink it to 640.
   - A 4:3 preset shows ~33% more table and uses the full sensor, as opposed to the 16:9 crop.
   - Less processing in the image chip, less heat. The real size it reports also corrects our FOV assumption.

### Tier 2: medium effort, solid gains

Status 2026-10-03: items 7, 13, 14, 15, 16 **done in v0.13.0**; item 12 tested and **rejected** (made matching worse on synthetic puzzles, see PLAN dead ends). v0.14.0: items 10 and 20 done; 11 needs no change (current rule 99.3% right) and 19 doesn't apply to a moving phone (see PLAN); plus a texture channel for pale pieces and a fix for dense piles on the glass table.

7. **Loops of loops: 3×3 blocks and best-buddy growth** — M, high.
   - A false 4-loop needs at least two wrong matches. Higher-order loops push precision toward 1 ([Son et al.](https://faculty.cc.gatech.edu/~hays/papers/puzzle_eccv14.pdf), [JigsawNet](https://arxiv.org/abs/1809.04137)).
   - Rank suggestions by the highest loop order that confirms them.
8. **Worker-side camera frames via `MediaStreamTrackProcessor`** — M.
   - Supported from iOS 18.0, in a DedicatedWorker only ([WebKit 18.0](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)).
   - Transfer the track to the worker and read `VideoFrame`s. Optionally take just the luma (Y) plane with `copyTo(NV12)`.
   - Removes the main-thread `createImageBitmap`, the transfer and the CPU resize. Keep the current path as the fallback.
   - Measure first: v0.11.1 added the `seg_proc` timing, which shows what this would save.
9. **Custom OpenCV.js build: `--simd`, only the modules we use** — M.
   - Fixed-width SIMD works from iOS 16.4. Do not use relaxed SIMD, because iOS rejects the whole module.
   - Expected 1.5–3× on resize, blur, morphology and colour conversion (inf), a smaller download and less heap.
   - Risk: Emscripten breakage with `--simd` ([opencv #18097](https://github.com/opencv/opencv/issues/18097)).
   - Skip WASM threads: GitHub Pages can't send the headers they need, and the threads build fails in a worker ([opencv #25790](https://github.com/opencv/opencv/issues/25790)).
10. **Better separation of touching pieces** — M, medium–high.
    - Pair deep inward notches (convexity defects) across the outline and cut there. Use 1×/2×/3× the piece area to count how many pieces a blob holds. Keep watershed as the fallback.
    - Splitting by concave-point pairs exceeds 96% for touching cells ([ref](https://www.researchgate.net/publication/222155276_Splitting_touching_cells_based_on_concave_points_and_ellipse_fitting)). Watershed needs a narrow neck, which interlocked tabs don't give.
11. **Sturdier corners and tab/blank reading** — S–M, medium–high.
    - Pick corners by quadrilateral fit, scored on angles near 90° and side ratios ([bminaiev](https://bminaiev.github.io/jigsaw-puzzle-solver)).
    - Refine each corner by intersecting the two neighbouring side fits ([puzzle-bot](https://github.com/roksenhorn/puzzle-bot)).
    - Decide tab vs blank by the signed area between the edge and its chord, with a hole-depth bias correction: holes read about 68% as deep ([assistant](https://github.com/Mohammed-Jameal-J/jigsaw-puzzle-assistant)).
    - Smooth the outline before reading curvature ([Hoff & Olver](https://www-users.cse.umn.edu/~olver/v_/puzzles.pdf)).
    - Global sanity checks: exactly 4 corners, at most 2 flats per piece, flat count consistent with the border count.
    - Add explicit neck width, head width and depth features to the edge signature ([jigsawlutioner](https://github.com/byWulf/jigsawlutioner)).
12. **Seam colour as gradient continuity** — M, medium–high on pictorial puzzles.
    - Sample a few pixels inside the outline, not at the cut, because the boundary pixels are eroded ([Bridger CVPR 2020](https://openaccess.thecvf.com/content_CVPR_2020/papers/Bridger_Solving_Jigsaw_Puzzles_With_Eroded_Boundaries_CVPR_2020_paper.pdf)).
    - Score with MGC-style gradient prediction, weighted by how much texture the strip has (flat sky = low weight).
13. **Box placement: distinctive pieces first, then one piece per cell** — M–L, medium.
    - Normalise both photos' colour cast (shades-of-gray or gray-edge), then compare chroma histograms against local box statistics.
    - Place distinctive pieces first, then spread through neighbours.
    - Solve a joint assignment (Hungarian) so two pieces can't claim one cell. **Verified:** today only the 4 corners are kept exclusive (`cornerDoubts().winners`).
    - Also from Piece Finder: a gradient channel, a rim-eroded mask, and a "box photo too small: under 48 px per piece" warning.
14. **Colour zones and tray sorting** — S–M, medium–high on 1000 pieces.
    - Split the box into N zones and colour every piece by its zone on the camera view and the Map, with a legend. This is PuzAI's main feature.
    - Extends Area search from "find the pieces in the region I draw" to "colour everything by region".
15. **"Fill this spot"** — M, high late in the build.
    - Pick a box cell, or tap next to an assembled section. Rank loose pieces by the known neighbours' edge shapes, the colour across the seam and the box colour there.
    - A cheaper stand-in for PuzPal's gap scan. Late in a build the candidate pool is small, so shape matching works best there.

### Tier 3: later or optional

Status 2026-10-03: 16 (frame chain) done in v0.13.0; 9 (SIMD OpenCV) in v0.15.0; 8, 17, 18, 21 in v0.16.0; 19 not applicable to a moving phone; 20 done in v0.14.0; 22 skipped (owner). All 22 items handled.

16. **Frame-chain assistant: "next edge piece after #12"** — M. Solve the border first, as in [Zolver](https://github.com/Kawaboongawa/Zolver) and pondruska's FrameSolver. Only the frame (~70–130 pieces); a full interior solve isn't worth it on real pieces.
17. **Field-of-view self-calibration** — S–M. Compare the gyro rotation against the optical-flow shift during a ~20° pan to get the focal length per device. Our 66° is close; the XR is about 63–69° depending on the video crop (inf).
18. **Sharp stills with `ImageCapture.takePhoto()`** — S. Available from iOS 18.4 ([WebKit 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)). Verify the actual still size on the XR first.
19. **Empty-board reference frame** — S–M. Divide by an empty-board photo to cancel the board's texture and lamp gradient. Helps less than item 5.
20. **Prefer the centre-of-frame view when the same piece is seen twice** — S. Least parallax ([puzzle-bot](https://github.com/roksenhorn/puzzle-bot)); fits our duplicate handling.
21. **Saved puzzle library** — M, low–medium. Piece Finder, johnb8005 and LZ store several puzzles.
22. **Small WASM segmenter on steady crops** — L, uncertain.
    - Only if items 5, 10 and 11 still leave gaps.
    - Train on synthetic composites: clean contours from dark-mat or backlit scans, pasted onto white boards with shadows and glare.

### Not worth doing on this phone
- WebGPU: needs iOS 26, which the XR can't get.
- WASM threads.
- A WebGL compute rewrite.
- SAM / MobileSAM / YOLO-seg per frame, or SuperPoint/LightGlue in WASM.
- Diffusion or GNN solvers: evaluated on synthetic squares only.
- Chat-model vision for matching.
- Learned edge embeddings: no real-photo training data.

## Caveats
- Reddit was blocked for the researchers, so user-wish evidence comes from app stores, READMEs and blogs.
- Most solver literature uses synthetic square pieces. Real-photo results are small (24–204 pieces).
- Competitor accuracy figures are the developers' own (e.g. Piece Finder: top-1 78–86%, 93–97% when confident).
- iOS web-API facts change quickly. Several stale claims online ("takePhoto unsupported") are wrong as of iOS 18.4. Test on the phone.
