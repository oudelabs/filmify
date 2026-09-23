"""A/B judge v2: shared-domain print table + per-film pretransform W, judged
against the UPSTREAM truth (not the shipped combo tables).

Background (2026-09-22 probes): shipped <key>-mobile.png encodes
printscan(DIRforward(pre-DIR density)) — DIR is baked INTO the table — while
the shipped shader also applies pointwise DIR and feeds the POST-DIR density
as the table coordinate. Production therefore applies DIR twice
(table-semantics-probe.py / double-dir-probe.py; mae ~5-6, max ~105 /255 vs
upstream on saturated probes; invisible on near-neutral content because
DIRforward is identity on gray ramps by construction). The shared-table
architecture (bare printscan(d), post-DIR coordinate, shader DIR x1) is the
correct semantics, so this judge measures both chains against upstream:

  truth (upstream): logv -> develop(logv) [DIR x1] -> printscan -> encode
  old  (shipped):   d_post=develop(logv); t=(d_post-low)/span; sample(mobile.png)
  new  (shared):    w=W(d_post); t'=(w-D_LO)/D_SPAN; sample(shared.png)

Gate on the NEW chain: mae<=1.0 p99<=4.0 max<=12 /255.
The OLD chain is reported for the record (expected to fail on saturated
probes until the runtime switches to the shared table).

Usage: python3 validation/shared-lut/ab-check.py <shared-table.png> <size>
"""
import json, os, re, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import importlib
b = importlib.import_module('bake-film-stocks')
n = importlib.import_module('bake-native-film')

REF = Path(os.environ.get('SPEKTRAFILM_REPO', str(Path.home() / '.local/share/filmify/spektrafilm')))
DOMAIN_LO, DOMAIN_SPAN = -0.45, 4.0
sys.path.insert(0, str(ROOT / 'validation' / 'shared-lut'))
bf = importlib.import_module('batch-fit')
COLOR_FILMS, REF_FILM = bf.COLOR_FILMS, bf.REF_FILM
FILM2STYLE = {v[0]: k for k, v in b.PROFILES.items()}
# 每组默认裁判的组合（已发货组合 + 基准）；--films 可指定任意胶卷（profile 名）
GROUPS = {
    'kodak_portra_endura': ['kodak_portra_400', 'kodak_gold_200', 'kodak_ektar_100', 'kodak_ultramax_400'],
    'fujifilm_crystal_archive_typeii': ['fujifilm_xtra_400', 'fujifilm_pro_400h'],
    'kodak_2383': ['kodak_vision3_250d', 'kodak_vision3_500t'],
    'kodak_2302': ['kodak_doublex'],
}


def mobile_size(key):
    m = re.search(r'"' + key + r'":\{[^}]*?"mobileSize":(\d+)', (ROOT / 'styles' / 'presets-mobile.js').read_text())
    return int(m.group(1))


def quad(W, d):
    r, g, bl = d[:, 0], d[:, 1], d[:, 2]
    F = np.stack([np.ones(len(d)), r, g, bl, r * r, g * g, bl * bl, r * g, r * bl, g * bl], axis=1)
    return F @ W.T


def metrics(a, bb):
    e = np.abs(a - bb) * 255
    return e.mean(), float(np.percentile(e, 99)), float(e.max())


def main():
    shared_path, size = Path(sys.argv[1]), int(sys.argv[2])
    paper = shared_path.name[len('print-'):-len(f'-{size}.png')]
    if '--films' in sys.argv:
        films = sys.argv[sys.argv.index('--films') + 1].split(',')
    else:
        films = GROUPS[paper]
    shared = b.read_png(shared_path, size)
    fitted = json.loads((ROOT / 'validation/shared-lut' / 'pretransforms.json').read_text())
    rng = np.random.default_rng(23)
    passed = True
    worst = 0.0
    for film in films:
        style = FILM2STYLE.get(film)
        native, s = n.pipeline(REF, film, paper)
        fp = n.film_parameters(native, s)
        nch = fp['channels']
        low = -np.asarray(fp['densityMin'], float)
        span = np.asarray(fp['densityMax'], float) + .5 - low
        axis = np.asarray(fp['logExposure'], float)

        def model(d, s=s, nch=nch):
            return np.asarray(s.process(np.asarray(d).reshape(-1, 1, nch), inject='cmy_film')).reshape(-1, 3)

        def develop(logv, s=s, nch=nch):
            return np.asarray(s._filming_stage.develop(np.asarray(logv).reshape(-1, 1, nch))).reshape(-1, nch)

        lo_a, hi_a = float(axis.min()), float(axis.max())
        logs = np.concatenate([
            np.repeat(np.linspace(lo_a + .1, hi_a - .1, 25)[:, None], nch, 1),
            rng.uniform(lo_a + .1, hi_a - .1, (1200, nch)),
        ])
        d_post = develop(logs)
        truth = b.encode(model(d_post))

        old = None
        if style:
            # 逐组合 mobile.png 已随共享表上线退役(2026-09-22);旧链数据缺失时只评新链
            try:
                q_old = b.read_png(ROOT / 'styles' / 'luts' / f'{style}-mobile.png', mobile_size(style))
                coord_old = np.clip((d_post - low) / span, 0, 1)
                old = b.sample(q_old, coord_old if nch == 3 else np.repeat(coord_old, 3, axis=1))
            except (FileNotFoundError, AttributeError):
                old = None
        # W 预变换（拟合带 paper 字段，必须匹配当前印相表；基准胶卷恒等）
        f = fitted.get(film) or {}
        fits = f.get('fits', [f] if 'W' in f else [])
        fit = next((x for x in fits if x.get('paper') == paper), None)
        w = quad(np.array(fit['W']), d_post) if (fit and nch == 3) else d_post
        coord = np.clip((w - DOMAIN_LO) / DOMAIN_SPAN, 0, 1)
        if nch == 1:
            coord = np.repeat(coord, 3, axis=1)
        new = b.sample(shared, coord)

        mn = metrics(new, truth)
        verdict = 'PASS' if (mn[0] <= 1.0 and mn[1] <= 4.0 and mn[2] <= 12.0) else 'FAIL'
        passed = passed and verdict == 'PASS'
        worst = max(worst, mn[1])
        oldtxt = ''
        if old is not None:
            mo = metrics(old, truth)
            oldtxt = f' | old[shipped] mae {mo[0]:5.2f} p99 {mo[1]:6.2f} max {mo[2]:6.2f}'
        print(f'{verdict} {film:<22} new[shared] mae {mn[0]:5.2f} p99 {mn[1]:5.2f} max {mn[2]:6.2f}{oldtxt} (/255)')
    print('A/B', 'PASS' if passed else 'FAIL', '(gate on new chain: mae<=1.0 p99<=4.0 max<=12)')

    if not passed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
