#!/usr/bin/env python3
"""Measure physical-scale corrections from pinned native uniform density fields.
No photographs, color offsets or MAE fitting. Existing 8um calibration is retained.
Usage: python scripts/calibrate-grain-scales.py --output /tmp/grain-scales.json
Then node scripts/calibrate-grain-scales.cjs /tmp/grain-scales.json [output.js]
"""
from pathlib import Path
import argparse,json,sys,subprocess
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
a=argparse.ArgumentParser();a.add_argument('--reference',type=Path,default=ROOT.parent/'spektrafilm');a.add_argument('--output',type=Path,required=True);a.add_argument('--size',type=int,default=256);a.add_argument('--stocks',default='');a.add_argument('--scales',default='');a.add_argument('--levels',default='');args=a.parse_args()
assert subprocess.check_output(['git','-C',str(args.reference),'rev-parse','HEAD'],text=True).strip()=='6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507'
assert not subprocess.check_output(['git','-C',str(args.reference),'status','--porcelain','--untracked-files=no'],text=True).strip(), 'Native reference has tracked modifications'
sys.path.insert(0,str(args.reference/'src'))
from spektrafilm.runtime.params_builder import init_params,digest_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.model.grain import apply_grain
# Canonical profile ids are recorded in the original bake registry.
spec=__import__('importlib.util',fromlist=['spec_from_file_location']);sp=spec.spec_from_file_location('bake',ROOT/'scripts/bake-film-stocks.py');b=spec.module_from_spec(sp);sp.loader.exec_module(b)
# Read JS data without evaluating JavaScript: production files are JSON assignments.
def readjs(name,prefix):return json.loads((ROOT/name).read_text().removeprefix(prefix).strip().removesuffix(';'))
profiles=readjs('styles/presets.js','window.FILMIFY_STYLES=');stats=readjs('styles/grain-stats.js','window.FILMIFY_GRAIN_STATS=')
scales=[float(x) for x in args.scales.split(',')] if args.scales else [2**(x/2) for x in range(2,11)] # 2, sqrt(8), 4, ... 32um; content-independent log grid.
result={'reference':'6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507','patch_size':args.size,'scales':scales,'stocks':{}}
selected=args.stocks.split(',') if args.stocks else list(stats)
for key in selected:
 if not stats[key]:continue
 film,paper=b.PROFILES[key];p=digest_params(init_params(film_profile=film,print_profile=paper or 'kodak_2302'));s=SimulationPipeline(p);fp=profiles[key]['film'];tab=stats[key];curves=s.film.data.density_curves;curves=curves-np.nanmin(curves,axis=0);ch=len(fp['densityMin']);entries=[]
 for um in scales:
  entry={'um':um,'t':[float(x) for x in args.levels.split(',')] if args.levels else tab['t'],'rms':[],'corr':[],'corr2':[],'corr4':[],'diag':[],'skew':[],'channels':ch}
  for t in entry['t']:
   density=np.array(fp['densityMin'])+t*(np.array(fp['densityMax'])-np.array(fp['densityMin']));src=np.broadcast_to(density,(args.size,args.size,ch)).copy()
   np.random.seed(123);field=apply_grain(src,um,p.film_render.grain,curves,s.film.data.density_curves_layers,s.film.info.type)[12:-12,12:-12]
   mean=field.mean(axis=(0,1),dtype=np.float64);center=field-mean;var=(center*center).mean(axis=(0,1),dtype=np.float64);rms=np.sqrt(var)
   entry['rms'].append(rms.tolist());entry['skew'].append(((center**3).mean(axis=(0,1))/np.maximum(rms**3,1e-30)).tolist())
   for name,dy,dx in [('corr',0,1),('corr2',0,2),('corr4',0,4),('diag',1,1)]:
    aa=center[:center.shape[0]-dy,:center.shape[1]-dx];bb=center[dy:,dx:];entry[name].append(((aa*bb).mean(axis=(0,1))/np.maximum(var,1e-30)).tolist())
  entries.append(entry);print(key,round(um,3),flush=True)
 result['stocks'][key]=entries;args.output.parent.mkdir(parents=True,exist_ok=True);temp=args.output.with_suffix('.part.json');temp.write_text(json.dumps(result));temp.replace(args.output)
