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
    print('  box', b.get('cols'), 'x', b.get('rows'), '=', c.get('expected'), '| counts', {k: c.get(k) for k in ('pieces','sections','shaped','placed','located','border','corner','cornerUnplaced','cornerDoubt','islands')})
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
    # Diagnostics added in v0.9.1 (absent in older reports).
    fl = d.get('flow') or {}
    if fl.get('steps') is not None:
        print('  tracker', {k: fl.get(k) for k in ('every', 'msPerStep', 'readMs', 'matchMs', 'maxMs', 'steps', 'predicted', 'fullSearch', 'lowConf', 'resumes')})
    mt = d.get('mainThread')
    if mt: print('  main thread (display-frame gaps ms)', mt)
    sts = d.get('stats')
    if sts: print('  session', {k: v for k, v in sts.items() if k != 'started'})
    if d.get('settings'): print('  settings', d['settings'])
    if d.get('device'): print('  device', d['device'])
    es = w.get('engine')
    if es: print('  engine', {k: v for k, v in es.items() if k != 'cornerDoubts'}, '| corner doubts', len(es.get('cornerDoubts') or []))
    cat = w.get('catalog')
    if cat: print('  catalog', cat)
    ss = w.get('session')
    if ss:
        top = sorted(ss.get('stages', {}).items(), key=lambda kv: -kv[1]['mean'])[:8]
        print('  whole session', {k: ss.get(k) for k in ('minutes', 'frames', 'totalP50', 'totalP90', 'totalP99')}, '| slowest stages (mean/max)', [(k, v['mean'], v['max']) for k, v in top])
    if h and any(r.get('lag') is not None for r in h):
        print('  send->result lag ms median', st.median([r['lag'] for r in h if r.get('lag') is not None]), '| worker queue wait median', st.median([r.get('wait', 0) for r in h]))
    fb = (w.get('feedback') or {}).get('stats')
    if fb and fb.get('judged'):
        print('  ANSWER KEY', fb['judged'], 'judged |', fb['fits'], 'fit /', fb['no'], 'no | accuracy', fb.get('accuracy'))
        print('    by app probability', {k: f"{v['fits']}/{v['n']}" for k, v in fb.get('byProb', {}).items()},
              '| by rank', {k: f"{v['fits']}/{v['n']}" for k, v in fb.get('byRank', {}).items()},
              '| both shapes confirmed', {k: f"{v['fits']}/{v['n']}" for k, v in fb.get('byConfirmed', {}).items()},
              '| 2x2 loop', f"{fb['loopOk']['fits']}/{fb['loopOk']['n']}")
    gate = w.get('gate')
    if gate: print('  quality gate: rejected', gate.get('rejects'), '| provisional now', gate.get('candidates'), '| piece size', gate.get('pieceMM') and round(gate['pieceMM'], 1), 'mm')
    if pcs and any('views' in p for p in pcs):
        views = [p.get('views', 0) for p in pcs]
        print('  shapes: confirmed (>=2 views)', sum(1 for v in views if v >= 2), 'of', len(views), '| uncertain edges', sum((p.get('unc') or '').count('1') for p in pcs),
              '| read conflicts', sum(p.get('conflicts', 0) for p in pcs), '| quality median', sorted(p.get('q') or 0 for p in pcs)[len(pcs) // 2] if pcs else None)
    print('  errors', (d.get('errors') or [])[-3:] or None)
