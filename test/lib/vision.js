/* The vision engine as the app's worker loads it, for tests and tools.
 *   const PH = require('./lib/vision')();          // from test/
 *   const PH = require('../test/lib/vision')();    // from tools/
 * - modules: the list in js/worker.js (VISION = [...]), so tests run the
 *   phone's engine (a hand-kept list once left out frame/border in 31 suites:
 *   auto-border never ran there); extra modules a test needs (e.g. 'flow')
 *   via load({ extra: ['flow'] }), loaded before 'engine';
 * - VISION=<dir>: load the modules from another js/vision (an old version,
 *   for before/after runs);
 * - PHSET='{"NAME":value}': override PH constants (experiments);
 * - CLOCK=wall (default) | cpu | step | model[:k]: see test/lib/clock.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function workerModules() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'worker.js'), 'utf8');
  const m = src.match(/const VISION = \[([^\]]*)\]/);
  if (!m) throw new Error('test/lib/vision.js: no VISION list in js/worker.js');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

let loaded = null;
module.exports = function load(opts) {
  if (loaded) return loaded;
  opts = opts || {};
  require('./clock').install(process.env.CLOCK);
  globalThis.self = globalThis;
  const dir = process.env.VISION ? path.resolve(process.env.VISION) : path.join(ROOT, 'js', 'vision');
  const mods = workerModules();
  for (const x of opts.extra || []) if (!mods.includes(x)) mods.splice(mods.indexOf('engine'), 0, x);
  for (const f of mods) require(path.join(dir, f + '.js'));
  const PH = globalThis.PH;
  if (process.env.PHSET) Object.assign(PH, JSON.parse(process.env.PHSET));
  require('./clock').hook(PH); // (CLOCK=model: charge the heavy steps)
  loaded = PH;
  return PH;
};
module.exports.workerModules = workerModules;
