# Puzzle Helper

An iPhone web app (no App Store) for jigsaw puzzles. Point the camera at pieces spread on a table:

- **Scan:** sweep slowly over the table. Each piece gets a catalog entry and a dot, grey → blue (shape read) → green (placed on the box picture). The dots follow the camera between readings, so they stay on the pieces while you move. Gold dashed lines link loose pieces that very likely fit together.
- **Border:** one tap lights up the whole frame of the puzzle — corner pieces orange, edge pieces teal — with arrows to the nearest ones off screen. Tap again to turn it off.
- **More → Catalog from a photo:** take a full-resolution photo to catalog every piece in it at once.
- **Box:** photograph the box picture. The app splits it into the puzzle's grid and works out where each piece belongs. Enter the **finished size** printed on the box (optional): with the real piece size the app can tell you how close to hold the phone.
- **Find:** tap a piece to see its spot on the box and its best partners for each edge. Each partner gets a word and a percentage: **Strong match** (very likely, and backed by a second check — the two pieces pick each other, or a closed 2×2 block), **Likely**, **Maybe**, **Look-alike** (another piece is about as good) or **Unlikely** (dimmed). The percentages are calibrated — "90%" means about 9 in 10 fit — and they keep learning from your **Fits / No** answers on your own puzzle. The box spot is said in words too (sure / likely / several spots look alike), with a warning for plain pieces whose spot is only a rough guess. Matching pieces glow on the table (gold = best). Pieces off-screen get an arrow pointing toward them.
  - **Easy to see:** every highlighted piece — the selected one, its partners, a Matches pair, anything a finder lights up — gets its whole outline drawn and is shaded in its colour, and curved lines arc from the selected piece to its likely partners (also toward ones off screen), so they're easy to follow while panning.
  - **Which way up:** a white arrow on the selected piece points to its top edge as it sits in the finished puzzle (also on the Map), and the panel shows the piece upright.
  - **Mark as in the puzzle:** once you've placed a piece, tap this in its panel. Its spot on the box is no longer offered for other pieces, Border and the finders skip it, it's dimmed on the table and the Map, and More shows how much is done. Tap again to undo.
  - **Corners / Edges:** light up every corner piece (orange) or edge piece (teal) on the table, with counts. **Unplaced** and **Unread** light up pieces not yet found on the box, or whose shape hasn't been read.
  - **Matches:** search the whole catalog for pairs that fit, with no box picture needed, and step through them with ‹ ›. Tap **Fits** or **No** on each: the app keeps an answer key and shows its running accuracy under **More**.
  - **Box picture:** hide or show the small box picture when it's in the way.
- **Map:** turns the camera off and shows every scanned piece from above, as its own picture at its place and angle on the table — so several people can work from one phone or iPad lying on the table. Drag to move, pinch to zoom, twist (or **↻ 90°**) to turn it toward you, **Fit** to see everything. Tap a piece for its matches (lines to its partners); Border, the finders and Matches work here too. Separate scan areas are shown side by side. Pieces moved since scanning: switch to Scan and sweep that area again.
- **Area search:** tap the small box picture to enlarge it, then drag across a region (e.g. sky). Every piece from that area lights up.
- **Fill this spot:** on the enlarged box picture, tap one spot. The panel lists the loose pieces that best fill it — by the picture, and by how well their edges fit the pieces already around that spot (in testing the right piece came first 74 of 80 times, vs 64 by the picture alone) — and the best one glows gold on the table.
- **Zones:** splits the box picture into six areas A–F and rings every piece in its area's colour: sort into six trays.
- **Next along the border:** a border piece's panel names the next border piece on each side of it (right 108 of 120 times in testing).

Everything runs on the phone. Nothing is uploaded, and the catalog is saved on the phone (IndexedDB).

**Dense piles and pale pieces:** in a dense pile the gaps between pieces look like pieces too; the app now checks which side carries print, so a pile of white pieces on dark glass is read the right way round, and pieces pressed together without a gap are cut apart along their notches. When pale pieces blend into a pale board, the app also uses the pieces' texture (fine print detail the board lacks) to find them.

**Capture coach:** if many pieces blend into the table (pale pieces on a white board) or glare washes out the view, a tip says what to change — once per problem. Pale pieces on a dark cloth read right far more often (in testing: none of the pale pieces on white, all of them on dark).

The camera is switched off while **More** or the box editor is open, and the app pauses itself if the phone is left still for 90 seconds (tap to carry on). The scan also slows down while nothing new is being learned, and the camera itself drops to 15 frames a second while the view is calm (24 while sweeping). All of this saves battery.

## Put it on your iPhone

The camera only works on an `https://` address. The free, simple option is GitHub Pages:

1. Create a free account at github.com, then create a new **public** repository (e.g. `puzzle-helper`).
2. Upload the contents of this folder. Leave out `node_modules` and `test/out`. The easiest way is the web uploader ("Add file → Upload files"), or use git:
   ```
   git init && git add . && git commit -m "Puzzle Helper"
   git branch -M main
   git remote add origin https://github.com/<you>/puzzle-helper.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages**, set Source = *Deploy from a branch*, Branch = `main` / `root`, and save.
4. After about a minute, open `https://<you>.github.io/puzzle-helper/` in Safari on the iPhone.
5. Tap **Share → Add to Home Screen** so it opens like an app.

The first launch downloads the vision library (about 10 MB). After that it's cached, and the app works offline.

### Testing on your home Wi-Fi instead (no GitHub)

```
npm install
npm run cert          # one-time self-signed certificate (uses openssl from Git for Windows)
npm run serve:https   # prints https://<PC-IP>:8443/
```
Open that address on the iPhone. Safari shows a certificate warning once: tap *Show Details → visit this website*. Allow the camera when asked.

## Tips for good results

- Best: a plain cloth or board in a color the puzzle doesn't use (black felt works for most puzzles). Under **More**, *Background sensitivity* adjusts how different a piece must look from the cloth.
- Mixed table (glass over tile, wood, a chair showing through): use **More → Teach background** and tap each bare surface once (tile, wood, glass, shadow, chair). Don't tap a piece. The app tries the taught colours alongside its own guesses and uses whichever finds pieces best.
- Taught colours are kept for the next puzzle. **New puzzle** asks whether to forget them — say yes if you moved to a different table or the light changed, because colours taught on one table can make another table look like a piece. **Clear everything** always forgets them.
- Pieces work best face up and not touching. The app tries to separate touching pieces, but loose pieces are read more reliably; a clump it can't separate shows an orange dashed outline.
- A lamp low and to one side makes each piece cast a thin shadow, which helps on cloths close in color to the pieces. **More → Flashlight** (iOS 17.5+) helps in dim rooms.
- Hold the phone flat, 30–40 cm up, and pause briefly over each area. Shapes are only read while the phone is steady. Holding it at an angle to avoid glare is fine (the app straightens the view), but closer is better: far-away pieces become too small to read.
- If the dot at the top turns red ("lost my place"), hold still over pieces you've already scanned. The app finds its position again from them.
- Only good shots make pieces: a piece is catalogued after the camera has seen it clearly in a few steady frames in a row, and not from a blurred, too-distant or partial view. Its shape is **confirmed** when a second, later look agrees; gold matches need confirmed shapes. If the top says "Too far to read pieces", move closer — the distance it suggests depends on the puzzle's piece size.
- If the piece count goes past the puzzle's size, the same pieces were catalogued twice after tracking was lost. **More → Tidy up the catalog** folds the duplicates back together.
- **More → Scan detail** trades sensitivity for speed and battery; **More → Send report** saves the camera view, the box picture and diagnostic data (share it to Files/OneDrive) when something looks wrong. The data covers speed per stage for the whole session, how smooth the screen was, the motion tracker's cost, the vision engine's state and settings — `python tools/report-summary.py` prints it.

## How it works (short)

| Step | When | What |
|---|---|---|
| Segmentation | every frame (live: 640 px long side) | background chosen from candidates (dominant colour, taught colours, box palette) by which one yields pieces; lamp shadows evened out; on steady frames, piece outlines closed with an edge channel so pale pieces aren't lost against a white board. All full-frame pixel work runs in OpenCV (WebAssembly): the same JavaScript loops ran 2 ms in one phone session and 80 ms in another |
| Motion | every other display frame (~1 ms, page side) | a 96 px thumbnail matched against the last analysed frame; moves the dots between readings and tells a blurred sweep from a steady view |
| Fingerprint | every piece, every frame (<1 ms) | color histogram + mean color; tracks pieces between frames |
| Table map | every frame | known pieces are used as landmarks to fit the camera position (RANSAC similarity). Moved pieces are noticed and updated; separate scan areas merge when seen together. |
| Shape | once per piece, when steady (~10 ms) | outline → 4 corners → 4 edges typed tab/blank/flat + shape curve + color strip |
| Box placement | once per piece (~10–30 ms) | corners fix rotation to 4 options and the grid fixes scale; color pre-filter over every cell, then pixel comparison over the top ~20 |
| Matching | on demand (~1 ms per piece) | tab↔blank only; shape distance after Procrustes alignment + color across the seam + box-adjacency bonus → softmax probability with a "partner not scanned yet" option |

The code is in `js/vision/` (plain JavaScript + OpenCV.js, runs in a Web Worker). The page UI is `index.html` + `js/main.js`.

## Developer checks

```
npm install
npm test            # synthetic 96-piece puzzle (segmentation, edge types, box placement, matching, live tracking)
                    # + live sections, piece-size stability, duplicate merging, real-frame segmentation guard
npm run test:quick  # 48-piece version of the synthetic suite
node test/e2e.js    # runs the real page in headless Edge/Chrome with a fake camera (2-3 min; needs internet for OpenCV.js)
```

Pointed checks (seconds each) — prefer these while working on one area:

```
node test/live-sections.js   # an assembled block is catalogued and located from live frames
node test/flow-overlay.js    # dots follow the camera: tracker + screen mapping land within ~1 px
node test/flow-lab.js        # motion tracker accuracy and cost on synthetic shifts
node test/worker-reset.js    # New puzzle / Clear everything forget taught table colours
node test/seg-regression.js  # segmentation on real white-table frames doesn't regress
node test/leak-check.js      # the live pipeline doesn't leak OpenCV (WebAssembly) memory
node test/dupes.js           # pieces that drop out of detection aren't catalogued twice
node test/quality-gate.js    # blurred, distant or one-off views never become pieces
node test/answer-key.js      # Fits/No answers are logged with what was claimed; accuracy stats
node test/table-view.js      # Map: each piece's picture at its place, angle and size; groups, fit, tap
node test/rectify-proc.js    # tilt-corrected frame: same bytes as the reference, and its time per frame
node test/trust.js           # calibrated match probabilities, refit from answers, verdicts, In puzzle, top-edge arrow
node test/capture-coach.js   # coach flags pale pieces on a white board; a dark cloth fixes them
node test/solve-aids.js      # "fill this spot" ranks the right piece first; next piece along the border
node test/glass-table.js     # owner's glass-table photos: dense piles of white pieces still catalogued
node tools/fit-calib.js      # refit the match-probability model's starting weights on synthetic puzzles
node test/speed.js           # per-stage timing (VISION=<dir> runs another copy of js/vision to compare)
```

Working from real data (the phone's **Send report** files in `reports/`):

```
python tools/report-summary.py reports/puzzle-report-*.json   # speed per stage, tracking, catalog health
node test/report-replay.js reports/<report>.json --draw       # re-run a report's frame with its settings -> test/out/
node test/seg-lab.js --draw <photo.jpg> ...                   # compare segmentation option sets on real photos
node test/flow-video.js <dir of fNNNN.jpg frames>              # motion tracker on frames from a real phone video
node test/shape-real.js <photo.jpg> 15 20 --autotilt          # shape reading on a real photo: outlines, flat edges, failures -> test/out/
node test/real-box.js test/fixtures/<box>.jpg                 # real box picture: corners, grid, placement + matching + 2x2 loops
node test/real-pieces.js test/fixtures/<photo>.jpg test/fixtures/<box>.jpg   # outlines found in a real photo -> test/out/
npm run serve       # http://localhost:8080 for desktop testing (add ?video=clip.mp4 to replay a recorded sweep)
```

If `node` isn't installed, VS Code's own copy works: in PowerShell,
`$env:ELECTRON_RUN_AS_NODE=1; & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/run-tests.js`.

The synthetic tests are a best case: computer-generated pieces under perfect lighting. Real phone frames are harder; the open problems and what has been measured on real reports are in `PLAN-hard-issues.md`.
