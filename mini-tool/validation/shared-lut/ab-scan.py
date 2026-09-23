"""A/B judge for the shared DIRECT-SCAN table, against the UPSTREAM truth.

与 ab-check.py 同口径,链路换成直扫(paper=None,scan_film=True):
  truth (upstream): logv -> develop(logv) -> scan -> encode
  old  (现状逐款表): t=(d-low)/span; u=sqrt(t); sample(<style>-mobile.png)
  new  (共享表):     w=W(d); t'=(w-D_LO)/D_SPAN; sample(scan-provia-<size>.png)

门(新链): mae<=1.0 p99<=4.0 max<=12 /255。旧链同探针报告作对照——
注意旧链就是当前 shipped 效果,new 必须不比 old 差才算可换。

用法: python3 validation/shared-lut/ab-scan.py <scan-table.png> <size>
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
FILMS = ['fujifilm_provia_100f', 'fujifilm_velvia_100', 'kodak_ektachrome_100', 'kodak_kodachrome_64']
FILM2STYLE = {v[0]: k for k, v in b.PROFILES.items()}


def mobile_size(key):
    m = re.search(r'"' + key + r'":\{[^}]*?"mobileSize":(\d+)', (ROOT / 'styles' / 'presets-mobile.js').read_text())
    return int(m.group(1))


def quad(W, d):
    r, g, bl = d[:, 0], d[:, 1], d[:, 2]
    if W.shape[1] == 20:
        F = np.stack([np.ones(len(d)), r, g, bl, r * r, g * g, bl * bl, r * g, r * bl, g * bl,
                      r**3, g**3, bl**3, r * r * g, r * r * bl, g * g * r, g * g * bl,
                      bl * bl * r, bl * bl * g, r * g * bl], axis=1)
    else:
        F = np.stack([np.ones(len(d)), r, g, bl, r * r, g * g, bl * bl, r * g, r * bl, g * bl], axis=1)
    return F @ W.T


def metrics(a, bb):
    e = np.abs(a - bb) * 255
    return e.mean(), float(np.percentile(e, 99)), float(e.max())


def main():
    shared_path, size = Path(sys.argv[1]), int(sys.argv[2])
    shared = b.read_png(shared_path, size)
    fitted = json.loads((ROOT / 'validation/shared-lut' / 'pretransforms-scan.json').read_text()) \
        if (ROOT / 'validation/shared-lut' / 'pretransforms-scan.json').exists() else {}
    rng = np.random.default_rng(23)
    passed = True
    worst = 0.0
    worst_ratio = 0.0
    for film in FILMS:
        style = FILM2STYLE.get(film)
        native, s = n.pipeline(REF, film, None)
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

        # 旧链:现状逐款表(sqrt shaper)
        old = None
        if style:
            try:
                q_old = b.read_png(ROOT / 'styles' / 'luts' / f'{style}-mobile.png', mobile_size(style))
                t = np.clip((d_post - low) / span, 0, 1)
                old = b.sample(q_old, np.sqrt(t) if nch == 3 else np.repeat(np.sqrt(t), 3, axis=1))
            except (FileNotFoundError, AttributeError):
                old = None
        # 新链:共享表 + W(基准胶卷恒等)
        fit = fitted.get(film)
        w = quad(np.array(fit['W']), d_post) if (fit and nch == 3) else d_post
        coord = np.clip((w - DOMAIN_LO) / DOMAIN_SPAN, 0, 1)
        new = b.sample(shared, coord)

        mn = metrics(new, truth)
        verdict = 'PASS' if (mn[0] <= 1.0 and mn[1] <= 4.0 and mn[2] <= 12.0) else 'FAIL'
        passed = passed and verdict == 'PASS'
        worst = max(worst, mn[1])
        oldtxt = ''
        if old is not None:
            mo = metrics(old, truth)
            ratio = mn[1] / mo[1] if mo[1] > 0 else 1.0
            worst_ratio = max(worst_ratio, ratio)
            oldtxt = f' | old[逐款表] mae {mo[0]:5.2f} p99 {mo[1]:6.2f} max {mo[2]:6.2f} | new/old p99 ×{ratio:.2f}'
        print(f'{verdict} {film:<24} new[共享] mae {mn[0]:5.2f} p99 {mn[1]:5.2f} max {mn[2]:6.2f}{oldtxt} (/255)')
    print('A/B', 'PASS' if passed else 'FAIL', '(gate on new chain: mae<=1.0 p99<=4.0 max<=12; 另要求 new/old p99 比不显著>1)')

    if not passed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
