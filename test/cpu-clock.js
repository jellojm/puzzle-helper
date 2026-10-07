/* performance.now() on this process's CPU time (kept for `node -r
 * ./test/cpu-clock.js <test>`; tests can also use CLOCK=cpu, test/lib/clock.js). */
'use strict';
require('./lib/clock').install('cpu');
