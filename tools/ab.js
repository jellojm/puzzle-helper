/* Before/after: the same test, today's harness, the engine (js/vision) of an
 * older commit vs the working tree, run in turns (A B A B ...), side by side.
 *   node tools/ab.js <ref> <test.js> [test args] [--runs 3] [--clock model]
 *   node tools/ab.js v0.22.2 test/real-50.js 3605 --runs 3
 * The old engine comes from `git show <ref>:js/vision/*` into the system's
 * temp folder (no worktree, nothing in .git to clean up). Each run writes its
 * RESULT line (test/lib/results.js); the summary shows each metric's median
 * [min-max] for A (ref) and B (working tree) and the paired median change.
 * CLOCK=model (default here) is repeatable, so --runs 1 is enough with it;
 * with CLOCK=cpu use 3+ runs (the counter video varies a lot).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const runs = +opt('--runs', 1), clock = opt('--clock', 'model');
const [ref, testFile, ...testArgs] = argv;
if (!ref || !testFile) { console.log('usage: node tools/ab.js <ref> <test.js> [args] [--runs N] [--clock model|cpu]'); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-ab-'));
const visionA = path.join(dir, 'js', 'vision');
fs.mkdirSync(visionA, { recursive: true });
// (each file by `git show`: no archive tool needed - GNU tar on Windows reads C:\ as a host)
for (const f of execFileSync('git', ['ls-tree', '--name-only', ref, 'js/vision/'], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)) {
  fs.writeFileSync(path.join(visionA, path.basename(f)), execFileSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, maxBuffer: 64 << 20 }));
}

function run(side) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { CLOCK: clock, LABEL: `ab ${side === 'A' ? ref : 'tree'}` });
    if (side === 'A') env.VISION = visionA; else delete env.VISION;
    const p = spawn(process.execPath, [path.join(ROOT, testFile), ...testArgs], { cwd: ROOT, env });
    let out = '';
    p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { out += b; });
    p.on('close', () => { const m = out.match(/^RESULT (.*)$/m); resolve(m ? JSON.parse(m[1]).metrics : null); });
  });
}
const flat = (m, pre = '') => Object.entries(m || {}).reduce((o, [k, v]) => (typeof v === 'number' ? Object.assign(o, { [pre + k]: v }) : v && typeof v === 'object' && !Array.isArray(v) ? Object.assign(o, flat(v, pre + k + '.')) : o), {});
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
(async () => {
  console.log(`A = ${ref} (js/vision from git), B = working tree; ${testFile} ${testArgs.join(' ')}; CLOCK=${clock}; ${runs} run(s) each`);
  const A = [], B = [];
  for (let i = 0; i < runs; i++) {
    const [a, b] = await Promise.all([run('A'), run('B')]); // (side by side: the same load on both)
    A.push(flat(a)); B.push(flat(b));
    process.stdout.write(`  run ${i + 1}/${runs} done\n`);
  }
  const keys = [...new Set([...A, ...B].flatMap((x) => Object.keys(x)))];
  const fmt = (v) => (v === null || v === undefined ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(2));
  console.log('\n' + 'metric'.padEnd(26) + 'A median [min-max]'.padEnd(24) + 'B median [min-max]'.padEnd(24) + 'B-A (paired median)');
  for (const k of keys) {
    const a = A.map((x) => x[k]).filter((v) => v !== undefined), b = B.map((x) => x[k]).filter((v) => v !== undefined);
    if (!a.length && !b.length) continue;
    const d = A.map((x, i) => (x[k] !== undefined && B[i][k] !== undefined ? B[i][k] - x[k] : null)).filter((v) => v !== null);
    const r = (v) => `${fmt(med(v))} [${fmt(Math.min(...v))}-${fmt(Math.max(...v))}]`;
    console.log(k.padEnd(26) + (a.length ? r(a) : '-').padEnd(24) + (b.length ? r(b) : '-').padEnd(24) + (d.length ? (med(d) > 0 ? '+' : '') + fmt(med(d)) : '-'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();
