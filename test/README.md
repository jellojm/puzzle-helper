# Tests

Node is not on PATH on the owner's PCs; run scripts with VS Code's Node:
`ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" <script>`.

## Tiers

| Command | What | Time |
|---|---|---|
| `npm test` | synthetic + unit suites (28 scripts, stops at the first failure) | ~10 min |
| `npm run test:real` | the owner's videos and photos (`reports/`, not in git) | 20–40 min |
| `node test/e2e.js` | the app in headless Edge | 3 min |

Real-data tests print **PASS/FAIL** (floors: what the last release reaches,
less the run-to-run spread) and **GOAL/MET** (targets the app does not reach
yet; never fail the run).

## Loading the engine: `test/lib/vision.js`

`const PH = require('./lib/vision')();` loads the modules the app's worker
loads (the list is read from `js/worker.js`), so tests run the phone's engine.
Settings:

- `VISION=<dir>` – another copy of `js/vision` (an older version).
- `PHSET='{"NAME":value}'` – override `PH` constants (experiments).
- `CLOCK=` – what the engine's time budgets run on (`test/lib/clock.js`):
  - `wall` (default) – the real clock: depends on the machine and on what else runs.
  - `cpu` – this process's CPU time: other agents' tests barely matter.
  - `step` – 0.02 ms per reading: repeatable, but budgets and waits mean nothing.
  - `model[:k]` – a virtual clock charged per segmentation pass and per shape
    read at the **phone's** cost (from its reports; `k` scales), frames at
    their video time. **Repeatable whatever else runs, and paced like the
    phone.** Use it for before/after comparisons. Thresholds in the suites
    were tuned at PC speed, so two suites fail under it (2026-10-08:
    run-tests "live sweep" 87/96, table-view "every read piece has a
    placement") – that is the phone's pacing, worth knowing, not a bug in
    the clock.

## Results over time

`test/real-50.js` and `test/real-joins.js` print one `RESULT {json}` line and
append it to `test/results/history.jsonl` (version, commit, dirty flag,
clock, PHSET, metrics). `RESULTS=0` skips the append (exploration).

- `node tools/trend.js [test] [case] [--last N]` – the history as a table.
- `node tools/ab.js <ref> test/real-50.js 3605 [--runs N] [--clock model]` –
  the engine of an older commit (via `git archive`, no worktree) against the
  working tree, side by side, metric by metric.

## Answer keys

`test/fixtures/v3593/answer.json` (IMG_3593, 50 pieces, codes checked by eye)
and `test/fixtures/v3605/answer.json` (IMG_3605, 38 pieces: positions on the
76 s overview by eye, reference shapes from that frame; codes not yet
checked – `refCode` is an unverified far read). Only the answer keys are in
git; the rest of `test/fixtures/` (photos, frames) stays local.

`real-50.js` with a key prints: identity (pieces followed from the key's
overview), **map error** (how far each piece sits from where the key puts it,
in piece sides; robust fit), one-to-one, doubles, codes.

## Studying one run

- `READSTUDY=<file.json>` (real-50): every close read, what it was compared
  with, whether it agreed, and the key piece it shows. **It runs inside the
  frame's time budget, so it changes the run it measures** – use
  `CLOCK=model` or compare studies only with studies.
- `SHEET=<file.json>` (real-50 with a key): each key piece's entry and its
  stored picture, for checking by eye.
- `KEYDBG=1`: the per-frame shift that lines the key up with the frame.
