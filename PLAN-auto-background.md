# Plan: automatic background (v0.27 →)

Owner, 2026-10-11: "maybe we need to deal with background first", "make a plan
for automatic background, remove manual modes".

## Why

Most failures in recent reports trace back to cutting pieces from the table:

| Surface | What goes wrong | Reports |
|---|---|---|
| Glass | reflections cut as pieces, pieces lost against them | 2026-10-09/10, IMG_3609 video (1 of 300 checked) |
| Wood floor | grain/seams cut as "pieces" (#2 at 18:58 is bare floor), the same piece reads differently each time (BBFB vs BFTB), so duplicates and wrong codes follow | 2026-10-11 18:58, 19:15 |
| White board | pale print dropped with the background (colour cut lost 3 of 4 outlines) | 2026-10-11 03:26 |

A bad cut makes the size estimate, clumps, reads, duplicates and matching all
worse. Fixing it at the source should help everything after it.

## What exists now

- Fixed background models tried every ~90 frames, the best kept by how
  jigsaw-like its cut-outs are (`chooseBackground` / `stepBgChoice` /
  `scoreBg`): one board colour, several colours, a palette, taught colours,
  and an outline model for glass (`PH.edgeForeground`).
- Reads also try an outline cut per piece (v0.26.2, `segmentCropEdges`).
- Manual controls (removed in v0.27): "Background sensitivity" slider and
  "Teach background" taps. Saved values from older versions are ignored.
  The engine's taught-colour support stays, for step 4's automatic version.

What's missing is a model **learned from this table**: the fixed models judge
colour distance only and can't learn wood grain, glare or a printed cloth.

## Design: learn from what the app is already sure of

### 1. Confident examples, no help from the owner
- **Piece pixels:** inside cut-outs that read as clean pieces (pieceScore
  high, 4 corners, quality ≥ 0.6), shrunk a few pixels from the outline.
- **Background pixels:** a ring just outside those outlines, plus large regions
  touching the frame edge with no piece-like shape in them.
- Collected each frame from the processing image (640 px), kept as a capped
  reservoir (~20k samples per class) so old light fades out.

### 2. Features beyond colour (per pixel, cheap box filters at 640 px)
- Lab colour (as now).
- **Texture direction:** structure-tensor coherence. Wood grain is strongly
  one-directional; piece print isn't.
- **Fine detail energy:** small-scale gradient magnitude (local mean).
- **Sharpness:** high-pass energy vs a blurred copy. Pieces are in focus;
  glass reflections are soft (the depth-of-field idea).
- **Glare:** bright and grey (high L, low chroma).

### 3. Classifier
- Quantise features into a small lookup table (e.g. Lab 16³ × texture 4 ×
  sharpness 4), counts of piece vs background per bin, smoothed, giving a
  piece likelihood per pixel. Training is counting, and use is one lookup a
  pixel, so it's fast on the phone (target ≤ 8 ms a frame at 640 px).
- Then the existing pipeline: threshold, morphology, contours, split.

### 4. Safety, adapting, remembering
- Becomes one more candidate in `chooseBackground` ("learned"). It's used only
  while its cut-outs score at least as well as the fixed models, so it can't
  make things worse.
- Retrained every few seconds from new confident examples (light changes,
  moving to another patch of floor).
- Saved with the puzzle (lookup table + reservoir summary): the same table
  works from the first frame next time; "New puzzle" keeps it (same table),
  "Forget everything" clears it.
- **Ask only when stuck:** if no model gives clean pieces for ~10 s, one hint,
  "Point at an empty patch of the table for 2 seconds". That view becomes
  pure background examples (the automatic replacement for Teach background).

## Steps

1. **Measure first (Test mode / PC).** Build features + lookup-table
   classifier in `js/vision/bgLearn.js`, trained from confident examples in
   the owner's photos and videos. Run it as a Test mode variant and in
   `tools/testmode.js` against the current models.
   - Data: IMG_3593 (white board, 50-piece key), IMG_3605/3609 (glass),
     IMG_3665–3669 + 18:58/19:15 frames (wood), labelled join photos.
   - Measure: pieces found, clean reads, false pieces (bare floor), corner
     error, outline right/wrong (labelling page), real-50 key scores.
   - Go on only if it beats the best fixed model on wood and glass without
     losing on the white board.
2. **Live candidate.** Add "learned" to `chooseBackground` with the scoring
   safety; retrain on a timer; report what it learned (sample counts, chosen
   share, ms). e2e quick + real-50 3593/3605/3609 must not regress.
3. **Remember per table.** Save and restore with the puzzle; reports carry it.
4. **"Empty patch" hint** when nothing works; learned from that view.
5. **Retire what it replaces.** If "learned" wins nearly always, drop the
   colour models it beats (fewer candidates means less background-search time:
   `seg_bgChoice` is 113–142 ms medians in the latest reports).

## What would help from the owner

- Photos of the **bare** wood floor and the **bare** glass table (no pieces):
  pure background for testing.
- A short video on the wood floor, slow sweep, a few loose pieces.
- New reports after v0.27 (manual modes gone: what the automatic path does
  on its own).

## Risks

- **Pieces that look like the table** (wood-print puzzle on a wood floor): the
  safety check keeps the fixed models then; the outline cut still helps.
- **Feedback loop:** a wrong confident example teaches the wrong thing. Only
  high-quality reads feed it, the reservoir caps any one moment, and the
  score check vetoes a model that gets worse.
- **Phone time:** features must stay within ~8 ms a frame; measured in step 1
  with the model clock and on the phone through reports.
