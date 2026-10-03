# Puzzle Helper

An iPhone web app (no App Store) for jigsaw puzzles. Point the camera at pieces spread on a table:

- **Scan:** sweep slowly over the table. Each piece gets a catalog entry and a dot, grey → blue (shape read) → green (placed on the box picture). The dots follow the camera between readings, so they stay on the pieces while you move. Gold dashed lines link loose pieces that very likely fit together.
- **Snap:** take a full-resolution photo to catalog every piece in it at once.
- **Box:** photograph the box picture. The app splits it into the puzzle's grid and works out where each piece belongs.
- **Find:** tap a piece to see its spot on the box and its best partners for each edge, with a percentage likelihood. A partner marked **2×2 ✓** is confirmed by a closed 2×2 block: the app found two more pieces that fit both this piece and the partner. These confirmed matches were right about 94% of the time in testing. Matching pieces glow on the table (gold = best). Pieces off-screen get an arrow pointing toward them.
  - **Corners / Edges:** light up every corner piece (orange) or edge piece (teal) on the table, with counts. **Unplaced** and **Unread** light up pieces not yet found on the box, or whose shape hasn't been read.
  - **Matches:** search the whole catalog for pairs that fit, with no box picture needed, and step through them with ‹ ›.
  - **Map:** hide or show the box picture.
- **Area search:** tap the small box picture to enlarge it, then drag across a region (e.g. sky). Every piece from that area lights up. Tap the enlarged picture to shrink it again.

Everything runs on the phone. Nothing is uploaded, and the catalog is saved on the phone (IndexedDB).

The camera is switched off while **More** or the box editor is open, and the app pauses itself if the phone is left still for 90 seconds (tap to carry on). The scan also slows down while nothing new is being learned. All of this saves battery.

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
- If the piece count goes past the puzzle's size, the same pieces were catalogued twice after tracking was lost. **More → Tidy up the catalog** folds the duplicates back together.
- **More → Scan detail** trades sensitivity for speed and battery; **More → Send report** saves the camera view, the box picture and diagnostic data (share it to Files/OneDrive) when something looks wrong.

## How it works (short)

| Step | When | What |
|---|---|---|
| Segmentation | every frame (live: 640 px long side) | background chosen from candidates (dominant colour, taught colours, box palette) by which one yields pieces; lamp shadows evened out; on steady frames, piece outlines closed with an edge channel so pale pieces aren't lost against a white board |
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
```

Working from real data (the phone's **Send report** files in `reports/`):

```
python tools/report-summary.py reports/puzzle-report-*.json   # speed per stage, tracking, catalog health
node test/report-replay.js reports/<report>.json --draw       # re-run a report's frame with its settings -> test/out/
node test/seg-lab.js --draw <photo.jpg> ...                   # compare segmentation option sets on real photos
node test/flow-video.js <dir of fNNNN.jpg frames>              # motion tracker on frames from a real phone video
node test/real-box.js test/fixtures/<box>.jpg                 # real box picture: corners, grid, placement + matching + 2x2 loops
node test/real-pieces.js test/fixtures/<photo>.jpg test/fixtures/<box>.jpg   # outlines found in a real photo -> test/out/
npm run serve       # http://localhost:8080 for desktop testing (add ?video=clip.mp4 to replay a recorded sweep)
```

If `node` isn't installed, VS Code's own copy works: in PowerShell,
`$env:ELECTRON_RUN_AS_NODE=1; & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/run-tests.js`.

The synthetic tests are a best case: computer-generated pieces under perfect lighting. Real phone frames are harder; the open problems and what has been measured on real reports are in `PLAN-hard-issues.md`.
