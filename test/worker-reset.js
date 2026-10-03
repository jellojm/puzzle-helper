/* Pointed check: "New puzzle" / "Clear everything" can forget the taught table
 * colours, and forgetting them also drops the background model chosen with
 * them. Runs the real js/worker.js message handlers in node (importScripts and
 * postMessage stubbed; no IndexedDB, so nothing is persisted).
 * Run: node test/worker-reset.js   (a few seconds: loads OpenCV)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

const JS = path.join(__dirname, '..', 'js');
const posted = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => posted.push(m);
globalThis.importScripts = function stub(u) {
  if (/^https?:/.test(u)) {
    // OpenCV's loader takes `importScripts` as "I'm in a browser worker" and
    // reads self.location; hide the stub while it loads as a node module.
    delete globalThis.importScripts;
    try { globalThis.cv = require('@techstark/opencv-js'); } finally { globalThis.importScripts = stub; }
    return;
  }
  vm.runInThisContext(fs.readFileSync(path.join(JS, u), 'utf8'), { filename: u });
};
// worker.js as a classic script in this realm, so its top-level `engine`
// binding can be inspected afterwards with runInThisContext('engine').
vm.runInThisContext(fs.readFileSync(path.join(JS, 'worker.js'), 'utf8'), { filename: 'worker.js' });

const send = (msg) => { self.onmessage({ data: msg }); return new Promise((r) => setTimeout(r, 0)); };
const settle = async () => { for (let i = 0; i < 400 && !vm.runInThisContext('typeof engine !== "undefined" && engine'); i++) await new Promise((r) => setTimeout(r, 25)); };
const lastReady = () => [...posted].reverse().find((m) => m.type === 'ready');
const waitFor = async (pred) => { for (let i = 0; i < 400; i++) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

(async () => {
  await send({ type: 'init' });
  await settle();
  await waitFor(() => posted.some((m) => m.type === 'ready'));
  const engine = () => vm.runInThisContext('engine');
  check('worker initialised in node', !!engine(), posted.map((m) => m.type).join(','));

  // Teach two table colours and pretend the engine picked the taught model.
  await send({ type: 'teachBg', rgb: [180, 170, 150] });
  await send({ type: 'teachBg', rgb: [120, 110, 100] });
  await waitFor(() => engine().taught.length === 2);
  const setModel = () => { const e = engine(); e.bgModel = { kind: 'taught' }; e.bgModelAt = 5; e.bgEval = null; };
  setModel();

  // New puzzle, same table: colours and model survive.
  posted.length = 0;
  await send({ type: 'reset', keepBox: true, forgetTable: false });
  await waitFor(() => lastReady());
  check('New puzzle keeping the table keeps taught colours', lastReady().settings.taught === 2 && engine().taught.length === 2, `taught ${lastReady().settings.taught}`);

  // New puzzle, different table: both go.
  setModel();
  posted.length = 0;
  await send({ type: 'reset', keepBox: true, forgetTable: true });
  await waitFor(() => lastReady());
  check('New puzzle on another table forgets taught colours', lastReady().settings.taught === 0 && engine().taught.length === 0, `taught ${lastReady().settings.taught}`);
  check('...and the background model chosen with them', engine().bgModel === null && !engine().bgModelAt, JSON.stringify({ bgModel: engine().bgModel, at: engine().bgModelAt }));

  // The Clear button in the teach bar takes the same path.
  await send({ type: 'teachBg', rgb: [200, 200, 200] });
  await waitFor(() => engine().taught.length === 1);
  setModel();
  posted.length = 0;
  await send({ type: 'clearBg' });
  await waitFor(() => posted.some((m) => m.type === 'taught'));
  check('teach-bar Clear also drops the taught model', engine().taught.length === 0 && engine().bgModel === null);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
