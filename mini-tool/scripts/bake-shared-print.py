"""Bake a shared-domain print-medium 3D LUT (2026-09-22 LUT 重新设计, docs/shared-lut-design.md).

Unlike bake-mobile-film.py (per film x print combo tables, input = film's own
normalized density t), this bakes ONE table per print medium over the GLOBAL
density domain [DOMAIN_LO, DOMAIN_LO+DOMAIN_SPAN]. The runtime maps each film's
post-DIR density into reference-film-equivalent density via a per-film 3x10
quadratic pretransform (validation/shared-lut/pretransforms.json), then into
this table with global constants — so N films x M prints need N raw/param
sets + M tables instead of N x M tables.

Quality gate lives in validation/shared-lut/ab-check.py (shared+W A/B against
the shipped per-combo LUTs); this script only emits candidate tables.
"""
import argparse, importlib, os, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
b = importlib.import_module('bake-film-stocks')
n = importlib.import_module('bake-native-film')

DOMAIN_LO = -0.45
DOMAIN_SPAN = 4.0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--reference', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--print', dest='paper', required=True, help='print medium profile, e.g. kodak_portra_endura')
    ap.add_argument('--ref-film', required=True, help='reference camera film for this print, e.g. kodak_portra_400')
    ap.add_argument('--sizes', default='49,57')
    args = ap.parse_args()

    native, s = n.pipeline(args.reference.resolve(), args.ref_film, args.paper)
    fp = n.film_parameters(native, s)
    nch = fp['channels']

    def model(density):
        return np.asarray(s.process(np.asarray(density).reshape(-1, 1, nch), inject='cmy_film')).reshape(-1, 3)

    out = args.output.resolve()
    (out / 'luts').mkdir(parents=True, exist_ok=True)
    for size in [int(x) for x in args.sizes.split(',')]:
        g = b.grid(size).reshape(-1, 3)
        d = g * DOMAIN_SPAN + DOMAIN_LO
        if nch == 1:
            # Mono chain: table content depends on R only; runtime samples (d,d,d).
            # grid() is R-fastest, so the first `size` rows are the R ramp.
            ramp = model(d[:, :1])[:size].reshape(size, 1, 1, 3)
            table = ramp * np.ones((1, size, size, 1))
        else:
            table = model(d).reshape(size, size, size, 3)
        # Shared domain reaches more extreme densities than per-film bakes; the
        # spectral chain can undershoot zero by ~1e-6 there. Clamp after check.
        assert table.min() >= -1e-5 and table.max() <= 1 + 1e-5, (size, table.min(), table.max())
        table = np.clip(table, 0, 1)
        cp = out / 'luts' / f'print-{args.paper}-{size}.png'
        ch = b.write_png(cp, b.encode(table))
        print(f'{args.paper} size {size}: {cp.name} {cp.stat().st_size} bytes sha256_uint16 {ch[:16]}…', flush=True)

    # Chain self-description for the runtime manifest (filled when promoted).
    print('domain', [DOMAIN_LO, DOMAIN_LO + DOMAIN_SPAN], 'ref_film', args.ref_film, 'paper', args.paper)


if __name__ == '__main__':
    main()
