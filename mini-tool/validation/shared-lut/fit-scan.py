"""Fit cubic20 pretransforms for the shipped Velvia-based direct-scan LUT.

Uses the reachable film density domain and clamps transformed density to the
shared domain, matching runtime sampling. Re-fitting is optional: the committed
pretransforms-scan.json contains the calibrated coefficients used by releases.
"""
import argparse, importlib, json, os, sys
from multiprocessing import Pool
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
b = importlib.import_module('bake-film-stocks')
n = importlib.import_module('bake-native-film')
REF = Path(os.environ.get('SPEKTRAFILM_REPO', str(Path.home() / '.local/share/filmify/spektrafilm')))
OUT = ROOT / 'validation/shared-lut/pretransforms-scan.json'

REF_FILM = 'fujifilm_velvia_100'
FILMS = ['fujifilm_provia_100f', 'kodak_ektachrome_100', 'kodak_kodachrome_64']


def feats(dd):
    r, g, bl = dd[:, 0], dd[:, 1], dd[:, 2]
    return np.stack([np.ones(len(dd)), r, g, bl, r * r, g * g, bl * bl, r * g, r * bl, g * bl,
                     r**3, g**3, bl**3, r*r*g, r*r*bl, g*g*r, g*g*bl,
                     bl*bl*r, bl*bl*g, r*g*bl], axis=1)


def fit_one(film):
    from scipy.optimize import least_squares
    _, sref = n.pipeline(REF, REF_FILM, None)
    native_f, sf = n.pipeline(REF, film, None)
    fpf = n.film_parameters(native_f, sf)

    def model(s, d):
        return b.encode(np.asarray(s.process(d.reshape(-1, 1, 3), inject='cmy_film'))).reshape(-1, 3)

    low = -np.asarray(fpf['densityMin'], float)
    high = np.asarray(fpf['densityMax'], float) + .5
    rng = np.random.default_rng(7)
    pts = np.concatenate([b.grid(7).reshape(-1, 3), rng.random((400, 3))])
    d = pts * (high - low) + low
    F = feats(d)
    out_f = model(sf, d)

    def resid(x):
        # 钳位感知:运行时将 W 输出钳进共享域([-0.45,3.55])后再采样;
        # 拟合损失必须评估同一个语义,否则 ~10% 越界角被静默压坏(2026-09-22 velvia 诊断)
        w = F @ x.reshape(3, 20).T
        w = np.clip(w, -0.45, -0.45 + 4.0)
        return ((model(sref, w) - out_f) * 255).ravel()

    x0 = np.zeros(60)
    x0[1] = x0[22] = x0[43] = 1
    r = least_squares(resid, x0, method='lm', max_nfev=80)
    e = np.abs(r.fun).reshape(-1, 3)
    return film, {'paper': '__scan__', 'features': 'cubic20', 'reference_film': REF_FILM, 'W': r.x.reshape(3, 20).tolist(),
                  'domain': {'low': low.tolist(), 'high': high.tolist()}, 'sampled': 'film',
                  'residual_255': {'mae': float(e.mean()), 'p99': float(np.percentile(e, 99)), 'max': float(e.max())}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--jobs', type=int, default=3)
    args = ap.parse_args()
    data = json.loads(OUT.read_text()) if OUT.exists() else {}
    with Pool(args.jobs) as pool:
        for film, fit in pool.imap_unordered(fit_one, FILMS):
            data[film] = fit
            OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
            r = fit['residual_255']
            print(f"{film:<24} mae {r['mae']:.3f} p99 {r['p99']:.3f} max {r['max']:.3f}", flush=True)
    print('saved', OUT)


if __name__ == '__main__':
    main()
