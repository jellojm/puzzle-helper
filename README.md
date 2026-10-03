# Puzzle Helper

An iPhone web app (no App Store) for jigsaw puzzles. Point the camera at pieces spread on a table:

- **Scan:** sweep slowly over the table. Each piece gets a catalog entry, outlined grey → blue (shape read) → green (placed on the box picture). Gold dashed lines link loose pieces that very likely fit together.
- **Snap:** take a full-resolution photo to catalog every piece in it at once.
- **Box:** photograph the box picture. The app splits it into the puzzle's grid and works out where each piece belongs.
- **Find:** tap a piece to see its spot on the box and its best partners for each edge, with a percentage likelihood. A partner marked **2×2 ✓** is confirmed by a closed 2×2 block: the app found two more pieces that fit both this piece and the partner. These confirmed matches were right about 94% of the time in testing. Matching pieces glow on the table (gold = best). Pieces off-screen get an arrow pointing toward them.
- **Area search:** tap the small box picture to enlarge it, then drag across a region (e.g. sky). Every piece from that area lights up.

Everything runs on the phone. Nothing is uploaded, and the catalog is saved on the phone (IndexedDB).

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
- Mixed table (glass over tile, wood, a chair showing through): use **More → Teach background** and tap each bare surface once (tile, wood, glass, shadow, chair). Don't tap a piece. This is saved and used for every frame and photo. Without it, the app guesses the background from the box picture's colors. That guess works for most frames, but it can mistake a big pile of one color (e.g. all the purple pieces) for table.
- Pieces should be face up and not touching. Touching pieces show an orange dashed outline and are skipped.
- A lamp low and to one side makes each piece cast a thin shadow, which helps on cloths close in color to the pieces. **More → Flashlight** (iOS 17.5+) helps in dim rooms.
- Hold the phone flat, 30–40 cm up, and pause briefly over each area. Shapes are only read while the phone is steady.
- If the dot at the top turns red ("lost my place"), hold still over pieces you've already scanned. The app finds its position again from them.

## How it works (short)

| Step | When | What |
|---|---|---|
| Fingerprint | every piece, every frame (<1 ms) | color histogram + mean color; tracks pieces between frames |
| Table map | every frame | known pieces are used as landmarks to fit the camera position (RANSAC similarity). Moved pieces are noticed and updated; separate scan areas merge when seen together. |
| Shape | once per piece, when steady (~10 ms) | outline → 4 corners → 4 edges typed tab/blank/flat + shape curve + color strip |
| Box placement | once per piece (~10–30 ms) | corners fix rotation to 4 options and the grid fixes scale; color pre-filter over every cell, then pixel comparison over the top ~20 |
| Matching | on demand (~1 ms per piece) | tab↔blank only; shape distance after Procrustes alignment + color across the seam + box-adjacency bonus → softmax probability with a "partner not scanned yet" option |

The code is in `js/vision/` (plain JavaScript + OpenCV.js, runs in a Web Worker). The page UI is `index.html` + `js/main.js`.

## Developer checks

```
npm install
npm test            # synthetic 96-piece puzzle: segmentation, edge types, box placement, matching, live tracking
npm run test:quick  # 48-piece version
node test/e2e.js    # runs the real page in headless Edge/Chrome with a fake camera (needs internet for OpenCV.js)
node test/real-box.js test/fixtures/<box>.jpg          # real box picture: corners, grid, placement + matching + 2x2 loops
node test/real-pieces.js test/fixtures/<photo>.jpg test/fixtures/<box>.jpg   # outlines found in a real photo -> test/out/
node test/real-stitch.js <box>.jpg <photo1>.jpg <photo2>.jpg ...            # do overlapping photos join one table map?
npm run serve       # http://localhost:8080 for desktop testing (add ?video=clip.mp4 to replay a recorded sweep)
```

The synthetic tests are a best case: computer-generated pieces under perfect lighting. Expect lower accuracy on real photos. The match-probability settings (`PH.MATCH_TEMP`, `PH.MATCH_NULL` in `js/vision/matcher.js`) and the thresholds should be re-tuned once there are real photos to test against.
