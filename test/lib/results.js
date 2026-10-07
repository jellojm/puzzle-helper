/* One line of results per run, kept: prints `RESULT {json}` and appends it to
 * test/results/history.jsonl (committed; one JSON object per line, so runs on
 * either PC merge). `node tools/trend.js` shows the history.
 *   require('./lib/results').record('real-50', '3605', { checked: 29, ... });
 * Each record carries: time, test, case, app version, commit (+ "dirty" when
 * the tree has uncommitted changes), VISION (another engine copy), clock,
 * PHSET, CPU and wall seconds, and the metrics given.
 * RESULTS=0 prints without appending (exploratory runs).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function git(args) { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return null; } }
function appVersion() {
  try { const m = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8').match(/APP_VERSION = '([^']+)'/); return m ? m[1] : null; } catch (_) { return null; }
}

exports.record = function (test, caseName, metrics) {
  const u = process.cpuUsage(); // (since the process started)
  const dirty = git(['status', '--porcelain', '--', 'js', 'test/lib']);
  const rec = {
    time: new Date().toISOString(), test, case: caseName || null,
    version: appVersion(), commit: git(['rev-parse', '--short', 'HEAD']), dirty: !!dirty,
    vision: process.env.VISION || null, clock: require('./clock').mode() + (process.env.CLOCK && process.env.CLOCK.includes(':') ? ':' + process.env.CLOCK.split(':')[1] : ''),
    phset: process.env.PHSET || null, label: process.env.LABEL || null,
    cpuS: +((u.user + u.system) / 1e6).toFixed(1), wallS: +process.uptime().toFixed(1),
    metrics,
  };
  console.log('RESULT ' + JSON.stringify(rec));
  if (process.env.RESULTS === '0') return rec;
  const dir = path.join(ROOT, 'test', 'results');
  try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(rec) + '\n'); } catch (e) { console.log('(results not saved: ' + e.message + ')'); }
  return rec;
};
