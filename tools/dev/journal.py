import json, sys
J = sys.argv[1]
skip = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else set()
res = []
for line in open(J, encoding='utf-8'):
    line = line.strip()
    if not line:
        continue
    o = json.loads(line)
    if o.get('type') == 'result':
        res.append(o)
def short(x):
    return x.replace(chr(92), '/').split('primacy2-space-simulator-b9a0b8/')[-1]
for o in res:
    r = None
    for k in ('result', 'value', 'output', 'data'):
        if k in o:
            r = o[k]
            break
    if isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    label = str(o.get('label') or o.get('agent') or o.get('id') or '?')
    print('=' * 24, label, '| keys:', [k for k in o.keys()][:8])
    if not isinstance(r, dict):
        print(str(r)[:400])
        continue
    for k, v in r.items():
        if k in skip:
            continue
        if isinstance(v, list):
            print('--- %s (%d)' % (k, len(v)))
            for x in v:
                print('  *', short(x) if 'files' in k.lower() else x)
        else:
            print('--- %s\n%s' % (k, v))
