# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Output-only G-code fingerprint. Python standard library; run with python3 -I."""
import argparse
from collections import Counter,defaultdict
import hashlib,json,math,re,statistics
from pathlib import Path

FEATURES=['outer_wall','inner_wall','sparse_infill','solid_infill','top','bottom','bridge','support','support_interface','skirt_brim']
MAPPING={
 'Outer wall':'outer_wall','External perimeter':'outer_wall','Overhang wall':'outer_wall','Overhang perimeter':'outer_wall',
 'Inner wall':'inner_wall','Perimeter':'inner_wall',
 'Sparse infill':'sparse_infill','Internal infill':'sparse_infill',
 'Internal solid infill':'solid_infill','Solid infill':'solid_infill','Gap infill':'solid_infill','Gap fill':'solid_infill','Floating vertical shell':'solid_infill',
 'Top surface':'top','Top solid infill':'top','Bottom surface':'bottom','Bottom solid infill':'bottom',
 'Bridge':'bridge','Bridge infill':'bridge','Internal Bridge':'bridge','Internal bridge':'bridge','Internal bridge infill':'bridge',
 'Support':'support','Support material':'support','Support transition':'support',
 'Support interface':'support_interface','Support material interface':'support_interface',
 'Skirt':'skirt_brim','Brim':'skirt_brim','Skirt/Brim':'skirt_brim',
 'Prime tower':'prime_tower','Wipe tower':'prime_tower','Custom':'custom'}
NUM=r'[-+]?(?:\d*\.\d+|\d+\.?\d*)'
WORDS=re.compile(r'([A-Z])\s*('+NUM+r')')
def duration(s):
 return sum(float(v)*{'d':86400,'h':3600,'m':60,'s':1}[u] for v,u in re.findall(r'('+NUM+r')\s*([dhms])',s))
def arc_length(op,args,old,new):
 chord=math.hypot(new['X']-old['X'],new['Y']-old['Y'])
 if 'I' in args or 'J' in args:
  cx=old['X']+args.get('I',0);cy=old['Y']+args.get('J',0)
  radius=math.hypot(old['X']-cx,old['Y']-cy)
  a=math.atan2(old['Y']-cy,old['X']-cx);b=math.atan2(new['Y']-cy,new['X']-cx)
  angle=((a-b) if op=='G2' else (b-a))%(2*math.pi)
  if angle<1e-10:angle=2*math.pi
  angle+=max(0,int(args.get('P',1))-1)*2*math.pi
 elif 'R' in args and abs(args['R'])>0:
  radius=abs(args['R']);angle=2*math.asin(min(1,chord/(2*radius)))
  if args['R']<0:angle=2*math.pi-angle
 else:return math.dist(tuple(old[k] for k in 'XYZ'),tuple(new[k] for k in 'XYZ'))
 return math.hypot(radius*angle,new['Z']-old['Z'])
def fingerprint(path):
 raw=path.read_bytes();text=raw.decode(errors='replace')
 pos=dict(X=0.,Y=0.,Z=0.,E=0.);absolute=True;relative_e=False;scale=1.;feature='custom';layer=-1
 layers=[];stats=defaultdict(lambda:{'extrusion_mm':0.,'moves':0,'path_mm':0.,'layers':set()})
 labels=Counter();unknown=Counter();seams=defaultdict(list);travel_count=0;travel_mm=0.;retract=0;hop=0;hop_active=False;outer_active=False;commands=Counter();retracting=False;negative_e_moves=0
 for line in text.splitlines():
  s=line.strip()
  if re.match(r'^;\s*(LAYER_CHANGE|CHANGE_LAYER)\s*$',s):
   layer+=1;layers.append({'index':layer,'z_mm':None,'height_mm':None});feature='custom';outer_active=False;hop_active=False
  z=re.match(r'^;\s*(Z|Z_HEIGHT):\s*('+NUM+')',s)
  ht=re.match(r'^;\s*(HEIGHT|LAYER_HEIGHT):\s*('+NUM+')',s)
  if layer>=0:
   if z and layers[layer]['z_mm'] is None:layers[layer]['z_mm']=float(z[2])
   if ht and layers[layer]['height_mm'] is None:layers[layer]['height_mm']=float(ht[2])
  typ=re.match(r'^;\s*(TYPE|FEATURE):\s*(.+)',s)
  if typ:
   label=typ[2].strip();labels[label]+=1
   newfeature=MAPPING.get(label,'unknown')
   if newfeature=='unknown':unknown[label]+=1
   if newfeature!=feature:outer_active=False
   feature=newfeature
  code=s.split(';',1)[0].strip()
  if not code:continue
  m=re.match(r'^([GMT]\d+)',code)
  if not m:continue
  op=m[1];commands[op]+=1;args={k:float(v)*scale for k,v in WORDS.findall(code[len(op):])}
  if op=='G20':scale=25.4;continue
  if op=='G21':scale=1.;continue
  if op=='G90':absolute=True;continue
  if op=='G91':absolute=False;continue
  if op=='M82':relative_e=False;continue
  if op=='M83':relative_e=True;continue
  if op=='G92':
   for k in pos:
    if k in args:pos[k]=args[k]
   continue
  if op=='G10' and not any(k in args for k in 'PL'):retract+=1;outer_active=False
  if op not in ('G0','G1','G2','G3'):continue
  new=pos.copy()
  for k in 'XYZ':
   if k in args:new[k]=args[k] if absolute else pos[k]+args[k]
  de=0.
  if 'E' in args:
   new['E']=pos['E']+args['E'] if relative_e else args['E'];de=new['E']-pos['E']
  distance=arc_length(op,args,pos,new) if op in ('G2','G3') else math.dist(tuple(pos[k] for k in 'XYZ'),tuple(new[k] for k in 'XYZ'))
  deposition=de>1e-8 and distance>1e-8
  if de< -1e-8:
   negative_e_moves+=1
   if not retracting:retract+=1
   retracting=True;outer_active=False
  elif de>1e-8:retracting=False
  if deposition:
   st=stats[feature];st['extrusion_mm']+=de;st['moves']+=1;st['path_mm']+=distance
   if layer>=0:st['layers'].add(layer)
   if feature=='outer_wall' and not outer_active and layer>=0:seams[layer].append([pos['X'],pos['Y']])
   outer_active=feature=='outer_wall';hop_active=False
  elif distance>1e-8:
   travel_count+=1;travel_mm+=distance;outer_active=False
   nominal=layers[layer]['z_mm'] if layer>=0 else None
   if nominal is not None:
    if new['Z']>pos['Z']+1e-6 and new['Z']>nominal+1e-5:hop_active=True
    elif hop_active and new['Z']<=nominal+1e-5:hop+=1;hop_active=False
  pos=new
 for key in FEATURES+['prime_tower','custom','unknown']:
  st=stats[key];ids=sorted(st['layers']);st['layers']=ids;st['layer_count']=len(ids);st['z_mm']=[layers[i]['z_mm'] for i in ids];st['height_mm']=[layers[i]['height_mm'] for i in ids]
 seam_layers=[]
 for i in range(len(layers)):
  pts=seams[i];spread=math.hypot(max(p[0] for p in pts)-min(p[0] for p in pts),max(p[1] for p in pts)-min(p[1] for p in pts)) if pts else None
  seam_layers.append({'layer':i,'candidates':pts,'bbox_diagonal_mm':spread})
 estimates={}
 t=re.search(r'total estimated time:\s*([^\n;]+)',text)
 if not t:t=re.search(r'estimated printing time \(normal mode\)\s*=\s*([^\n;]+)',text)
 if t:estimates['print_time_s']=duration(t[1]);estimates['print_time_raw']=t[1].strip()
 t=re.search(r'model printing time:\s*([^\n;]+)',text)
 if t:estimates['model_print_time_s']=duration(t[1])
 for unit,key in [('mm','filament_mm'),('g','filament_g'),('cm3','filament_cm3')]:
  alt='length' if unit=='mm' else 'weight' if unit=='g' else 'volume'
  pattern=rf'^;\s*(?:total filament {alt}\s*\[{re.escape(unit)}\]\s*:|filament used\s*\[{re.escape(unit)}\]\s*=)\s*(.+)$'
  m=re.search(pattern,text,re.M)
  if m:estimates[key]=sum(float(x) for x in re.findall(NUM,m[1]));estimates[key+'_raw']=m[1].strip()
 zs=[l['z_mm'] for l in layers if l['z_mm'] is not None];hs=[l['height_mm'] for l in layers if l['height_mm'] is not None]
 spreads=[s['bbox_diagonal_mm'] for s in seam_layers if s['bbox_diagonal_mm'] is not None]
 return {'file':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'layer_count':len(layers),'layers':layers,'z_max_mm':max(zs) if zs else None,'height_min_mm':min(hs) if hs else None,'height_max_mm':max(hs) if hs else None,'features':dict(stats),'travel_count':travel_count,'travel_mm':travel_mm,'retractions':retract,'negative_e_moves':negative_e_moves,'z_hops':hop,'seam_candidate_count':sum(len(v) for v in seams.values()),'seam_spread_median_mm':statistics.median(spreads) if spreads else None,'seams':seam_layers,'estimates':estimates,'feature_labels':dict(labels),'unmapped_labels':dict(unknown),'commands':dict(commands)}
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('gcode',type=Path);parser.add_argument('-o','--output',type=Path);args=parser.parse_args()
 result=json.dumps(fingerprint(args.gcode),indent=2)+'\n'
 if args.output:args.output.write_text(result)
 else:print(result,end='')
