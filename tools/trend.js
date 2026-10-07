/* The kept test results as a table (test/results/history.jsonl, written by
 * test/lib/results.js).
 *   node tools/trend.js                 every test, last 12 runs each
 *   node tools/trend.js real-50 3605    one test (and case)
 *   node tools/trend.js --last 30       more rows
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const li = args.indexOf('--last');
const last = li >= 0 ? +args[li + 1] : 12;
if (li >= 0) args.splice(li, 2);
const [test, kase] = args;
const file = path.join(__dirname, '..', 'test', 'results', 'history.jsonl');
if (!fs.existsSync(file)) { console.log('no results yet (' + file + ')'); process.exit(0); }
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

// the columns worth seeing per test
const COLS = {
  'real-50': [['checked', 'chk'], ['at30', '@30s'], ['firstAt', '1st'], ['entries', 'ent'], ['unchecked', 'unc'], ['identity', 'id'], [(m) => m.mapErr && m.mapErr.median, 'mapErr'], [(m) => m.mapErr && m.mapErr.off, 'off'], ['matched', 'match'], ['extra', 'extra'], ['codeOk', 'codes']],
  'real-joins': [['top1', 'first'], ['top3', 'top3'], ['joinSides', 'sides'], ['weakRead', 'weakRd'], ['weakTop1', 'wFirst'], ['weakTop3', 'wTop3'], ['weakSides', 'wSides']],
};
const groups = new Map();
for (const r of rows) {
  if (test && r.test !== test) continue;
  if (kase && String(r.case) !== kase) continue;
  const k = r.test + (r.case ? ' ' + r.case : '');
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const pad = (s, n) => String(s === undefined || s === null ? '-' : s).padEnd(n);
for (const [k, rs] of groups) {
  const cols = COLS[rs[0].test] || Object.keys(rs[rs.length - 1].metrics).filter((m) => typeof rs[rs.length - 1].metrics[m] === 'number').slice(0, 10).map((m) => [m, m]);
  console.log(`\n== ${k} (${rs.length} runs, last ${Math.min(last, rs.length)})`);
  console.log(pad('when', 17) + pad('version', 9) + pad('commit', 10) + pad('clock', 8) + cols.map(([, h]) => pad(h, 7)).join('') + 'note');
  for (const r of rs.slice(-last)) {
    const v = (c) => (typeof c === 'function' ? c(r.metrics) : r.metrics[c]);
    const note = [r.label, r.phset, r.vision ? 'VISION=' + path.basename(path.dirname(path.dirname(r.vision))) : null, r.metrics.failures ? r.metrics.failures + ' failed' : null].filter(Boolean).join(' ');
    console.log(pad(r.time.slice(5, 16).replace('T', ' '), 17) + pad(r.version, 9) + pad(r.commit + (r.dirty ? '*' : ''), 10) + pad(r.clock, 8) + cols.map(([c]) => pad(v(c), 7)).join('') + note);
  }
}
