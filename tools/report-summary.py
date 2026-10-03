"""Summarize Puzzle Helper phone reports.
Usage: python tools/report-summary.py reports/puzzle-report-*.json
Prints version, speed (per-stage medians), tracking, catalog health
(pieces vs box cells, islands, corners) and detections in the last frame."""
import json, sys, math, statistics as st

def is_corner(c):
    f = [ch == 'F' for ch in c]
    return sum(f) == 2 and any(f[k] and f[(k + 1) % 4] for k in range(4))

for f in sys.argv[1:]:
    d = json.load(open(f)); w = d.get('worker') or {}; h = d.get('history') or []; lf = d.get('lastFrame') or {}
    t = d.get('tilt'); deg = round(math.degrees(math.acos(min(1, t['down'][2]))), 1) if t else None
    print('=====', f.split('report-')[-1], '| app', d.get('app'), '| mode', d.get('mode'), '| fps', round(d.get('fps') or 0, 1),
          '| tilt', deg, '(corrected)' if lf.get('rect') else '')
    b = w.get('box') or {}
    c = w.get('counts') or {}
    print('  box', b.get('cols'), 'x', b.get('rows'), '=', c.get('expected'), '| counts', {k: c.get(k) for k in ('pieces','sections','shaped','placed','located','border','corner','cornerDoubt','islands')})
    o = w.get('opts') or {}
    print('  settings procW', o.get('procW'), 'minDE', o.get('minDE'), '| taught', len(w.get('taught') or []), '| bg', lf.get('bg') and {k: round(v) for k, v in lf['bg'].items() if k in 'Lab'})
    if h:
        keys = sorted({k for r in h for k in r if isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool) and k not in ('t', 'island', 'dets')})
        med = {k: round(st.median([r[k] for r in h if isinstance(r.get(k), (int, float))]), 1) for k in keys}
        med = {k: v for k, v in med.items() if v}
        print('  last', len(h), 'frames over', round((h[-1]['t'] - h[0]['t']) / 1000, 1), 's | dets median', st.median([r.get('dets', 0) for r in h]),
              '| tracking', round(sum(1 for r in h if r.get('tracking')) / len(h), 2), '| still', round(sum(1 for r in h if r.get('still')) / len(h), 2),
              '| islands seen', sorted({r.get('island') for r in h}))
        print('  ms medians', med)
    st_ = {}
    for x in lf.get('dets') or []: st_[x.get('status')] = st_.get(x.get('status'), 0) + 1
    print('  last frame', lf.get('procW'), 'x', lf.get('procH'), '| dets by status', st_)
    pcs = [p for p in (w.get('pieces') or []) if p.get('code')]
    cs = [p for p in pcs if is_corner(p['code'])]
    if cs: print('  corner-shaped', len(cs), '->', [(p['id'], p['code'], p.get('island'), p.get('box') and (p['box']['col'], p['box']['row'])) for p in cs][:12])
    print('  errors', (d.get('errors') or [])[-3:] or None)
