/* performance.now() on this process's CPU time instead of the wall clock.
 * The engine's live time budgets (frame deadlines, split budgets) then barely
 * depend on other work on the machine - other agents' tests share this PC.
 * Preload it: node -r ./test/cpu-clock.js test/run-tests.js
 * (test/real-50.js loads it itself with CLOCK=cpu.)
 */
'use strict';
const c0 = process.cpuUsage();
performance.now = () => { const u = process.cpuUsage(c0); return (u.user + u.system) / 1000; };
