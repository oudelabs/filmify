"""Batch-fit per-film quadratic pretransforms W for the shared-domain print LUTs.

For every (color negative film, color print paper) pair, fit W (3x10 quad
features) so that  printscan_{ref,paper}(W(d)) ≈ printscan_{film,paper}(d)
over the global density domain. Reference films are identity (no fit stored).

Output: merges into validation/shared-lut/pretransforms.json with format
  { film: { fits: [ {paper, reference_film, W, domain, residual_255}, ... ] } }

Usage: python3 validation/shared-lut/batch-fit.py --paper kodak_portra_endura [--jobs 6]
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
OUT = ROOT / 'validation/shared-lut/pretransforms.json'

DOMAIN_LO, DOMAIN_SPAN = -0.45, 4.0

COLOR_FILMS = ['kodak_portra_400', 'kodak_portra_160', 'kodak_portra_800',
               'kodak_gold_200', 'kodak_ektar_100', 'kodak_ultramax_400',
               'fujifilm_pro_400h', 'fujifilm_xtra_400', 'fujifilm_c200',
               'kodak_vision3_50d', 'kodak_vision3_250d', 'kodak_vision3_200t',
               'kodak_vision3_500t', 'kodak_verita_200d']
REF_FILM = {'kodak_portra_endura': 'kodak_portra_400',
            'kodak_endura_premier': 'kodak_portra_400',
            'kodak_supra_endura': 'kodak_portra_400',
            'kodak_ultra_endura': 'kodak_portra_400',
            'kodak_ektacolor_edge': 'kodak_portra_400',
            'fujifilm_crystal_archive_typeii': 'fujifilm_xtra_400',
            'kodak_2383': 'kodak_vision3_250d',
            'kodak_2393': 'kodak_vision3_250d'}


def feats(dd):
    r, g, bl = dd[:, 0], dd[:, 1], dd[:, 2]
    return np.stack([np.ones(len(dd)), r, g, bl, r * r, g * g, bl * bl, r * g, r * bl, g * bl], axis=1)


def fit_one(task):
    film, paper, reffilm, domain_mode = task
    from scipy.optimize import least_squares
    _, sref = n.pipeline(REF, reffilm, paper)
    native_f, sf = n.pipeline(REF, film, paper)
    fpf = n.film_parameters(native_f, sf)

    def model(s, d):
        return b.encode(np.asarray(s.process(d.reshape(-1, 1, 3), inject='cmy_film'))).reshape(-1, 3)

    low = -np.asarray(fpf['densityMin'], float)
    high = np.asarray(fpf['densityMax'], float) + .5
    rng = np.random.default_rng(7)
    pts = np.concatenate([b.grid(7).reshape(-1, 3), rng.random((400, 3))])
    if domain_mode == 'film':
        # 只在胶卷可达密度域内采样：W 的容量全部花在运行时真正经过的区域
        d = pts * (high - low) + low
    else:
        d = pts * DOMAIN_SPAN + DOMAIN_LO
    F = feats(d)
    out_f = model(sf, d)

    def resid(x):
        return ((model(sref, F @ x.reshape(3, 10).T) - out_f) * 255).ravel()

    x0 = np.zeros(30)
    x0[0] = x0[11] = x0[22] = 1
    r = least_squares(resid, x0, method='lm', max_nfev=80)
    e = np.abs(r.fun).reshape(-1, 3)
    return film, {'paper': paper, 'reference_film': reffilm, 'W': r.x.reshape(3, 10).tolist(),
                  'domain': {'low': low.tolist(), 'high': high.tolist()}, 'sampled': domain_mode,
                  'residual_255': {'mae': float(e.mean()), 'p99': float(np.percentile(e, 99)), 'max': float(e.max())}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paper', required=True, choices=sorted(REF_FILM))
    ap.add_argument('--jobs', type=int, default=6)
    ap.add_argument('--films', default='', help='comma-separated profile names; default all non-reference color films')
    ap.add_argument('--domain', default='film', choices=['global', 'film'],
                    help='sample domain for the fit: global cube or per-film reachable density')
    args = ap.parse_args()
    reffilm = REF_FILM[args.paper]
    films = [f for f in COLOR_FILMS if f != reffilm] if not args.films else args.films.split(',')
    tasks = [(f, args.paper, reffilm, args.domain) for f in films]
    data = json.loads(OUT.read_text()) if OUT.exists() else {}
    # 迁移旧格式 {film: {W, paper, ...}} -> {film: {fits:[...]}}
    for k, v in list(data.items()):
        if 'fits' not in v:
            data[k] = {'fits': [v]}
    with Pool(args.jobs) as pool:
        for film, fit in pool.imap_unordered(fit_one, tasks):
            entry = data.setdefault(film, {'fits': []})
            entry['fits'] = [f for f in entry['fits'] if f['paper'] != args.paper] + [fit]
            OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
            r = fit['residual_255']
            print(f"{film:<22} mae {r['mae']:.3f} p99 {r['p99']:.3f} max {r['max']:.3f}", flush=True)
    print('saved', OUT)


if __name__ == '__main__':
    main()
