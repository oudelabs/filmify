"""Export true raw/density stage boundaries from pinned spektrafilm.
Spatial film effects run outside these pointwise tables. No legacy finish input.
"""
import argparse,copy,importlib,json,subprocess,sys
from pathlib import Path
import numpy as np
b=importlib.import_module('bake-film-stocks')

def pipeline(reference,film,paper):
 sys.path.insert(0,str(reference/'src'))
 from spektrafilm.runtime.params_builder import init_params,digest_params
 from spektrafilm.runtime.pipeline import SimulationPipeline
 p=init_params(film_profile=film,print_profile=paper or 'kodak_2302')
 p.io.scan_film=paper is None;p.io.input_color_space=p.io.output_color_space='sRGB'
 p.io.input_cctf_decoding=True;p.io.output_cctf_encoding=False
 native=digest_params(copy.deepcopy(p))
 p.debug.deactivate_spatial_effects=True;p.debug.deactivate_stochastic_effects=True
 s=SimulationPipeline(digest_params(p));s._filming_stage._auto_exposure=lambda raw:raw
 return native,s

def film_parameters(native,s):
 from spektrafilm.model.couplers import compute_dir_couplers_matrix,langmuir_donor_params,receiver_langmuir_params,compute_density_curves_before_dir_couplers
 from spektrafilm.model.grain import _layer_grain_params
 data=s.film.data;n=data.density_curves.shape[-1];positive=s.film.info.type=='positive'
 curves=data.density_curves-np.nanmin(data.density_curves,axis=0)
 layers=data.density_curves_layers
 if layers is None:layers=curves[:,None,:]
 params=native.film_render.dir_couplers;unit=compute_dir_couplers_matrix(params,n_ch=n)
 k,dref=langmuir_donor_params(curves,params.langmuir_donor_k_rgb,n)
 kr,cref=receiver_langmuir_params(dref,unit,params.langmuir_receiver_k_rgb,n)
 matrix=unit*params.amount
 corrected=compute_density_curves_before_dir_couplers(curves,data.log_exposure,matrix,langmuir_k=None if positive else k,langmuir_d_ref=dref,receiver_kr=kr if positive else None,receiver_c_ref=cref if positive else None,positive=positive)
 grain=native.film_render.grain;layermax=np.nanmax(layers,axis=0)
 dmin,lmin,lmax,counts=_layer_grain_params(layermax,grain.density_min,grain.rms_granularity,list(grain.particle_scale_sublayers)[:layers.shape[1]],grain.uniformity,n,1.,density_curves_layers=layers)
 return b.serial({'channels':n,'positive':positive,'logExposure':data.log_exposure,'curves':curves.T,'correctedCurves':corrected.T,'densityMax':curves.max(axis=0),'bwCorrection':s._color_reference_service.black_white_filming_exposure_correction(),'halation':native.film_render.halation,'dir':params,'matrix':matrix,'donorK':k,'donorRef':dref,'receiverK':kr,'receiverRef':cref,'grain':grain,'layers':layers.transpose(2,1,0),'layerMin':lmin.T,'layerMax':lmax.T,'particleCountsAt1um':counts.T,'densityMin':dmin,'cameraFilmFormatMm':native.camera.film_format_mm})

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--reference',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);args=ap.parse_args()
 assert subprocess.check_output(['git','-C',str(args.reference),'rev-parse','HEAD'],text=True).strip()==b.REV
 assert not subprocess.check_output(['git','-C',str(args.reference),'status','--porcelain','--untracked-files=no'],text=True).strip()
 out=args.output;(out/'luts').mkdir(parents=True,exist_ok=True)
 metadata=json.loads((b.ROOT/'scripts/runtime-stock-metadata.json').read_text())
 presets={};entries={};report={};rng=np.random.default_rng(2718)
 points=np.concatenate([b.grid(9).reshape(-1,3),rng.random((4096,3))])
 for key,(film,paper) in b.PROFILES.items():
  native,s=pipeline(args.reference,film,paper);fp=film_parameters(native,s);n=fp['channels']
  # These native optional camera stages are inactive in the selected recipes.
  # Reject future changes instead of silently dropping an unsupported stage.
  assert native.camera.exposure_compensation_ev==0 and native.camera.lens_blur_um==0
  assert not native.camera.diffusion_filter.active and native.film_render.halation.boost_ev==0
  assert native.camera.auto_exposure and native.camera.auto_exposure_method=='center_weighted'
  def raw(rgb):return s._filming_stage._rgb_to_film_raw(rgb.reshape(-1,1,3),color_space='sRGB',apply_cctf_decoding=True)
  size_raw=33;raw_grid=raw(b.grid(size_raw));scale=raw_grid.max(axis=(0,1));raw_table=(raw_grid/scale).reshape(size_raw,size_raw,size_raw,n)
  if n==1:raw_table=np.repeat(raw_table,3,-1)
  rp=out/'luts'/(key+'-raw.png');rh=b.write_png(rp,raw_table);raw_q=b.read_png(rp,size_raw)
  low=-np.array(fp['densityMin']);high=np.array(fp['densityMax'])+.5
  # Positive monochrome grain's multiplicative sharpening has an unbounded
  # stochastic tail. Dmax + 0.5 failed on a real 24 MP image; keep the native
  # samples and cover density 5 (scanner sRGB < 0.03 / 255) instead.
  # The runtime range guard still rejects values outside the baked domain.
  if fp['positive'] and n==1 and fp['grain']['active']:high=np.maximum(high,5.)
  span=high-low
  # Widening the domain must not coarsen the original 33-point sampling.
  minimum_density_size=int(np.ceil(32*np.max(span/(np.array(fp['densityMax'])+.5-low))))+1
  def model(d):return np.asarray(s.process(d.reshape(-1,1,n),inject='cmy_film')).reshape(-1,3)
  # Exercise post-AE raw headroom independently of the finite encoded input table.
  rr=raw(points).reshape(-1,n);ar=b.sample(raw_q,points)[...,:n]*scale
  correction=fp['bwCorrection'];native_by_ev={};approx_density={}
  for ev in [-4,0,4,8,12]:
   d=s._filming_stage.develop(np.log10(np.maximum(rr*2**ev*correction,0)+1e-10).reshape(-1,1,n));native_by_ev[ev]=b.encode(model(d))
   approx_density[ev]=s._filming_stage.develop(np.log10(np.maximum(ar*2**ev*correction,0)+1e-10).reshape(-1,1,n)).reshape(-1,n)
  chosen=None;candidates={};gate={'mae':.30,'p99':2.,'max':8.}
  for size in [33,41,49,57,65]:
   g=b.grid(size).reshape(-1,3)[...,:n];table=model(low+g*span).reshape(size,size,size,3)
   assert table.min()>=-1e-7 and table.max()<=1+1e-7
   cp=out/'luts'/(key+'-density.png');ch=b.write_png(cp,b.encode(table));q=b.read_png(cp,size);checks={}
   for ev,d in approx_density.items():
    c=(d-low)/span
    if n==1:c=np.repeat(c,3,-1)
    e=np.abs(b.sample(q,c)-native_by_ev[ev])*255
    checks[str(ev)]={'mae':float(e.mean()),'p99':float(np.percentile(e,99)),'max':float(e.max())}
   passes=size>=minimum_density_size and all(all(v[m]<=limit for m,limit in gate.items()) for v in checks.values())
   candidates[str(size)]={'errors':checks,'bytes':cp.stat().st_size,'passes':passes}
   if passes and chosen is None:chosen=(size,cp.read_bytes(),ch,[float(table.min()),float(table.max())])
  assert chosen is not None,(key,candidates)
  size,png,ch,linear_bounds=chosen;cp.write_bytes(png)
  vec=lambda x:np.repeat(x,3).tolist() if len(x)==1 else x.tolist()
  presets[key]={'id':key,**metadata[key],'nativeFilm':True,'size':size,'asset':'./styles/'+cp.name,'rawAsset':'./styles/'+rp.name,'rawSize':size_raw,'rawScale':vec(scale),'densityLow':vec(low),'densitySpan':vec(span),'stockMono':n==1,'scannerUSM':list(native.scanner.unsharp_mask),'film':fp}
  assets={name:{'file':path.name,'size':sz,'png_bytes':path.stat().st_size,'png_sha256':b.sha(path.read_bytes()),'sha256_uint16':digest} for name,path,sz,digest in [('asset',cp,size,ch),('rawAsset',rp,size_raw,rh)]}
  entries[key]={'stock_reference':film,'print':paper,'scan_film':paper is None,'assets':assets,'boundaries':{'axis_order':'RGB; R fastest, then G, then B','raw':{'input':'encoded sRGB [0,1]','output':'film raw exposure, normalized per channel in RGB16','scale':vec(scale),'actual_channels':n},'density_scan':{'input':'post-DIR, post-grain film density','low':vec(low),'span':vec(span),'output':'encoded scanner sRGB [0,1]; decoded before linear USM','pre_USM_linear_bounds':linear_bounds}},'resolved_native':b.serial(native),'runtime_deferred':['camera AE','raw scatter/halation','film curves/DIR','density grain','scanner USM'],'remaining':['print glare','digital darkroom controls'],'profile_sha256':{name:b.sha((args.reference/'src/spektrafilm/data/profiles'/(name+'.json')).read_bytes()) for name in [film,paper] if name}}
  report[key]={'selected':size,'gate':gate,'candidates':candidates,'density_domain':[low.tolist(),high.tolist()]}
  print(key,size,sum(a['png_bytes'] for a in assets.values()),flush=True)
 manifest={'version':'native-film-stages-v1','reference_commit':b.REV,'classification':'native spatial film stages; print glare/darkroom not yet ported','styles':entries,'asset_bytes':sum(a['png_bytes'] for e in entries.values() for a in e['assets'].values()),'generator_sha256':b.sha(Path(__file__).read_bytes()),'metadata_sha256':b.sha((b.ROOT/'scripts/runtime-stock-metadata.json').read_bytes())}
 for name,data in [('manifest.json',manifest),('bake-report.json',report)]: (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
 (out/'presets.js').write_text('window.FILMIFY_STYLES='+json.dumps(presets,ensure_ascii=False,separators=(',',':'))+';\n')
 print('TOTAL',manifest['asset_bytes'],flush=True)
 # Native density/raw tables are source-only (never packaged); the shipping
 # budget is the build-minitool 10 MiB zip gate, not this bake's byte count.
 print('asset_bytes(source-only)',manifest['asset_bytes'],flush=True)
if __name__=='__main__':main()
