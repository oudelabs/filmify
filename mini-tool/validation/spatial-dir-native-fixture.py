# Regenerate with the pinned spektrafilm 6cd00c8 source and NumPy/Numba installed.
# Usage: python validation/spatial-dir-native-fixture.py /path/to/spektrafilm/src
import sys,json,numpy as np
sys.path.insert(0,sys.argv[1])
from spektrafilm.utils.fast_gaussian_filter import fast_gaussian_filter,fast_exponential_filter
w,h=512,384
y,x=np.mgrid[:h,:w]
a=(0.1+0.5*(x>=w//2)+0.2*(y>=h//2)+0.3*((x%79)<2)).astype(np.float32)
indices=[int(yy*w+xx) for yy in [0,1,95,190,191,192,193,287,382,383] for xx in [0,1,78,79,80,254,255,256,257,394,510,511]]
cases=[]
for um in [35000/512,16000/4096]:
    core=fast_gaussian_filter(a,20/um)
    b=.97*core+.03*fast_exponential_filter(a,200/um)
    cases.append(dict(w=w,h=h,um=um,indices=indices,expected=[float(b.flat[i]) for i in indices],core=[float(core.flat[i]) for i in indices]))
json.dump(dict(cases=cases,source='spektrafilm 6cd00c8 fast_gaussian_filter + fast_exponential_filter; arrived-inhibitor domain'),open('validation/spatial-dir-native-fixture.json','w'),indent=2)
