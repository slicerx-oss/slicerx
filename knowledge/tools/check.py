# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors

"""Check the SlicerX knowledge base.

Checks: YAML parses; every citation resolves to a source id or prefix; setting
keys exist in settings.yaml; change ops are valid; no em or en dashes or emoji;
filament, printer, workflow, goal and tree references resolve; eval checks use
known keys, goals, causes and citations. Set ORCA_PROFILES to a checkout of
OrcaSlicer resources/profiles at the pinned commit to also check that every
orca: path exists.

Usage: python3 knowledge/tools/check.py [knowledge_dir]   (needs PyYAML)
"""
import sys, os, re, glob, yaml
root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
errs = []
def load(p):
    try:
        return yaml.safe_load(open(p, encoding='utf-8'))
    except Exception as e:
        errs.append(f'{p}: YAML error {e}'); return None
files = sorted(glob.glob(os.path.join(root, '**', '*.yaml'), recursive=True))
settings = load(os.path.join(root, 'settings.yaml')) or {}
keys = {s['key'] for s in settings.get('settings', [])}
src_ids, prefixes = set(), set()
for p in glob.glob(os.path.join(root, 'sources', '*.yaml')):
    d = load(p) or {}
    for s in d.get('sources', []) or []:
        if s['id'] in src_ids: errs.append(f'{p}: duplicate source id {s["id"]}')
        src_ids.add(s['id'])
        for f in ('title', 'url', 'publisher'):
            if not s.get(f): errs.append(f'{p}: source {s["id"]} missing {f}')
    for x in d.get('prefixes', []) or []: prefixes.add(x['prefix'])
OPS = {'set', 'at_least', 'at_most', 'increase_by', 'decrease_by', 'multiply', 'enable', 'disable'}
BAD = re.compile('[\u2013\u2014\U0001F300-\U0001FAFF☀-➿]')
ids = {}
def walk(node, p, path):
    if isinstance(node, dict):
        if 'key' in node and isinstance(node['key'], str) and ('op' in node or 'why' in node):
            if node['key'] not in keys: errs.append(f'{p}:{path}: unknown setting key {node["key"]}')
            if node.get('op') not in OPS: errs.append(f'{p}:{path}: bad op {node.get("op")}')
        for k, v in node.items():
            if k == 'src':
                for s in (v if isinstance(v, list) else [v]):
                    if not isinstance(s, str): errs.append(f'{p}:{path}: src not string'); continue
                    if ':' in s:
                        if s.split(':', 1)[0] not in prefixes: errs.append(f'{p}:{path}: unknown prefix {s}')
                    elif s not in src_ids: errs.append(f'{p}:{path}: unknown source {s}')
            walk(v, p, f'{path}.{k}')
    elif isinstance(node, list):
        for i, v in enumerate(node): walk(v, p, f'{path}[{i}]')
for p in files:
    txt = open(p, encoding='utf-8').read()
    for ln, line in enumerate(txt.splitlines(), 1):
        if BAD.search(line): errs.append(f'{p}:{ln}: dash or emoji character')
    d = load(p)
    if not isinstance(d, dict): continue
    if 'sources' in p.split(os.sep)[-2:-1]: continue
    if d.get('kind') not in (None, 'settings_catalog') and 'id' in d:
        k = (d['kind'], d['id'])
        if k in ids: errs.append(f'{p}: duplicate id {k} also in {ids[k]}')
        ids[k] = p
    walk(d, p, '')

import collections
def L(p): return yaml.safe_load(open(p))
fil={L(p)['id'] for p in glob.glob(f'{root}/filaments/*.yaml')}
prn={}; 
for p in glob.glob(f'{root}/printers/*.yaml'):
    d=L(p); prn[d['id']]=d['kind']
fam={'bambu','prusa','klipper','marlin','creality','elegoo','voron','all','any'}
wf={}
for p in glob.glob(f'{root}/workflows/*/*.yaml'):
    d=L(p); wf[d['id']]=(d['kind'],p)
goals={L(p)['id'] for p in glob.glob(f'{root}/intents/*.yaml') if L(p)['kind']=='intent_goal'}
PLATES={'bambu_cool_plate','bambu_supertack_plate','bambu_textured_cool_plate','bambu_engineering_plate','bambu_high_temp_plate','textured_pei','smooth_pei','satin_pei','glass','garolite_g10','pp_sheet'}
xerrs=collections.defaultdict(list)
def chk(p,ids,valid,what,extra=set()):
    for i in ids or []:
        if isinstance(i,str) and i not in valid and i not in extra: xerrs[p].append(f'unknown {what}: {i}')
for p in sorted(glob.glob(f'{root}/**/*.yaml',recursive=True)):
    d=L(p)
    if not isinstance(d,dict): continue
    k=d.get('kind')
    if k=='filament':
        for pl in d.get('plates') or []: 
            if pl.get('plate') not in PLATES: xerrs[p].append(f"bad plate {pl.get('plate')}")
            if pl.get('fit') not in ('good','ok','glue','avoid'): xerrs[p].append(f"bad fit {pl.get('fit')}")
        chk(p,d.get('related'),fil,'filament')
    if k in ('printer','accessory'):
        m=d.get('materials') or {}
        for key in ('recommended','possible','not_recommended'): chk(p,m.get(key),fil,'filament')
        chk(p,d.get('compatible_printers'),prn,'printer')
        for pl in (d.get('bed') or {}).get('plates') or []:
            if pl not in PLATES: xerrs[p].append(f'bad plate {pl}')
    if k=='guide': chk(p,d.get('applies_to'),prn,'printer',fam)
    if k=='troubleshoot':
        t=d.get('tree') or {}; nodes=t.get('nodes') or {}; causes={c['id'] for c in d.get('causes') or []}
        if t.get('start') not in nodes: xerrs[p].append('tree start missing')
        for n,v in nodes.items():
            for ans in ('yes','no',True,False):
                if ans in v:
                    tgt=v[ans]
                    if tgt not in nodes and tgt not in causes: xerrs[p].append(f'node {n} -> {tgt} missing')
            for o in v.get('options',[]) or []:
                tgt=o.get('next') if isinstance(o,dict) else None
                if tgt and tgt not in nodes and tgt not in causes: xerrs[p].append(f'node {n} option -> {tgt} missing')
        reach=set(); stack=[t.get('start')]
        while stack:
            n=stack.pop()
            if n in reach: continue
            reach.add(n); v=nodes.get(n)
            if isinstance(v,dict):
                for ans in ('yes','no',True,False):
                    if ans in v: stack.append(v[ans])
                for o in v.get('options',[]) or []:
                    if isinstance(o,dict) and o.get('next'): stack.append(o['next'])
        unreached=causes-reach
        if unreached: xerrs[p].append(f'causes not reachable from tree: {sorted(unreached)}')
        for c in d.get('causes') or []:
            chk(p,c.get('filaments'),fil,'filament'); chk(p,c.get('printers'),prn,'printer',fam)
        chk(p,d.get('related'),{i for i,(kk,_) in wf.items() if kk=='troubleshoot'},'troubleshoot')
    if k=='calibration': chk(p,d.get('prereqs'),wf,'workflow')
    if k=='calibration_plan':
        chk(p,d.get('order'),wf,'workflow')
        for t in d.get('triggers',[]): chk(p,t.get('run'),wf,'workflow'); chk(p,t.get('optional'),wf,'workflow')
    if k=='intent_goal':
        mh=d.get('material_hints') or {}
        for key in ('prefer','avoid','acceptable'): chk(p,mh.get(key),fil,'filament')
        chk(p,(d.get('cooling_rule') or {}).get('applies_to'),fil,'filament')
        chk(p,d.get('requires_material_family'),fil,'filament')
        chk(p,d.get('implies'),goals,'goal')
        chk(p,list(((d.get('selection') or {}).get('reference_softening_c') or {}).keys()),fil,'filament')
        for pr in d.get('prerequisites') or []: chk(p,[pr.get('workflow')],wf,'workflow')
    if k=='intent_tradeoffs':
        for pr in d.get('pairs',[]): chk(p,pr['goals'],goals,'goal',{'any'})
    if k=='intent_examples':
        for e in d.get('examples',[]):
            chk(p,[g['id'] for g in e['intent']['goals']],goals,'goal'); chk(p,[e['intent'].get('material')],fil,'filament',{None})
    if k=='eval':
        pass
for p,e in xerrs.items():
    for x in e: print(f'{p}: {x}')
xref_count=sum(len(v) for v in xerrs.values())

# ---- evals and orca path existence ----
import re
srcids=set(); prefixes=set()
for p in glob.glob(f'{root}/sources/*.yaml'):
    d=L(p)
    for s in d.get('sources') or []: srcids.add(s['id'])
    for x in d.get('prefixes') or []: prefixes.add(x['prefix'])
keys={s['key'] for s in L(f'{root}/settings.yaml')['settings']}
ts={}
for p in glob.glob(f'{root}/workflows/troubleshooting/*.yaml'):
    d=L(p); ts[d['id']]={c['id'] for c in d.get('causes') or []}
E=[]
ORCA=os.environ.get('ORCA_PROFILES')
def cite_ok(c):
    if ':' in c: return c.split(':',1)[0] in prefixes
    return c in srcids
evids=set()
for p in glob.glob(f'{root}/evals/*.yaml'):
    d=L(p)
    for e in d['evals']:
        if e['id'] in evids: E.append(f'{p}: duplicate eval id {e["id"]}')
        evids.add(e['id'])
        x=e.get('expect',{})
        for fld in ('checks','checks_if_plan_offered','checks_if_moved_to_bay_1'):
            for c in x.get(fld) or []:
                if c['key'] not in keys: E.append(f'{p}:{e["id"]}: unknown key {c["key"]}')
                if c['is'] not in ('at_least','at_most','between','equals','one_of','unchanged','not'): E.append(f'{p}:{e["id"]}: bad is {c["is"]}')
        for g in x.get('goals') or []:
            if g not in goals: E.append(f'{p}:{e["id"]}: unknown goal {g}')
        if x.get('material') and x['material'] not in fil: E.append(f'{p}:{e["id"]}: unknown material')
        t=x.get('troubleshoot_id')
        if t and t not in ts: E.append(f'{p}:{e["id"]}: unknown troubleshoot {t}')
        if t and x.get('top_cause') and x['top_cause'] not in ts[t]: E.append(f'{p}:{e["id"]}: unknown cause {x["top_cause"]}')
        if t and x.get('top_cause_any_of') and not (set(x['top_cause_any_of'])&ts[t]): E.append(f'{p}:{e["id"]}: none of top_cause_any_of exist in {sorted(ts[t])}')
        for c in (x.get('citations') or {}).get('any_of') or []:
            if not cite_ok(c): E.append(f'{p}:{e["id"]}: unknown citation {c}')
        for w in (x.get('plan_includes') or [])+(x.get('plan_may_include') or []):
            if w not in wf: E.append(f'{p}:{e["id"]}: unknown workflow {w}')
if ORCA:
    allcites=set()
    for p in glob.glob(f'{root}/**/*.yaml',recursive=True):
        for m in re.finditer(r'"orca:([^"]+)"', open(p).read()): allcites.add((m.group(1),p))
    missing=[(c,p) for c,p in allcites if not os.path.exists(os.path.join(ORCA,c))]
    for c,p in sorted(missing): E.append(f'{p}: orca path not found: {c}')

# ---- skills catalog ----
sk_path = os.path.join(root, 'skills.yaml')
if os.path.exists(sk_path):
    sk = L(sk_path)
    sk_tools = {t for v in sk['tools'].values() if isinstance(v, list) for t in v}
    seen = set()
    for s in sk['skills']:
        if s['id'] in seen: E.append(f'{sk_path}: duplicate skill {s["id"]}')
        seen.add(s['id'])
        for t in s['tools']:
            if t not in sk_tools: E.append(f'{sk_path}:{s["id"]}: unknown tool {t}')
        if s['approval'] not in sk['permissions']: E.append(f'{sk_path}:{s["id"]}: unknown approval {s["approval"]}')
        for k in s.get('kb', []):
            if not glob.glob(os.path.join(root, k)): E.append(f'{sk_path}:{s["id"]}: kb path matches nothing: {k}')

if errs:
    print('\n'.join(errs))
for e in E: print(e)
total = len(errs) + xref_count + len(E)
print(f'{len(files)} files, {len(keys)} setting keys, {len(src_ids)} sources, {len(evids)} evals: {total} problems')
sys.exit(1 if total else 0)
