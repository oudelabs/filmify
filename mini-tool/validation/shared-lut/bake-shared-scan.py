"""Bake the shipped shared direct-scan LUT (Velvia reference, global density domain).

The cubic20 transforms in pretransforms-scan.json map the other three reversal
stocks into this table. This script writes staging tables only.
"""
import argparse, importlib, os, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
b = importlib.import_module('bake-film-stocks')
n = importlib.import_module('bake-native-film')

REF = Path.home() / '.local/share/filmify/spektrafilm'
REF_FILM = 'fujifilm_velvia_100'
DOMAIN_LO, DOMAIN_SPAN = -0.45, 4.0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--sizes', default='41')
    ap.add_argument('--reference', type=Path, default=Path(os.environ.get('SPEKTRAFILM_REPO', str(REF))))
    ap.add_argument('--ref-film', default=REF_FILM)
    args = ap.parse_args()

    native, s = n.pipeline(args.reference.resolve(), args.ref_film, None)  # paper=None → 直扫
    fp = n.film_parameters(native, s)
    nch = fp['channels']

    def model(density):
        return np.asarray(s.process(np.asarray(density).reshape(-1, 1, nch), inject='cmy_film')).reshape(-1, 3)

    out = (ROOT / 'validation/shared-lut').resolve()
    (out / 'luts').mkdir(parents=True, exist_ok=True)
    for size in [int(x) for x in args.sizes.split(',')]:
        g = b.grid(size).reshape(-1, 3)
        d = g * DOMAIN_SPAN + DOMAIN_LO
        table = model(d).reshape(size, size, size, 3)
        # 直扫链在全域极端角(远超任何胶卷可达密度)会过冲到 ~1.002,编码端本就截断;
        # 容差放到 1.005 后 clip,可达域内不受影响。
        assert table.min() >= -1e-5 and table.max() <= 1.005, (size, table.min(), table.max())
        table = np.clip(table, 0, 1)
        cp = out / 'luts' / f'scan-{args.ref_film}-{size}.png'
        ch = b.write_png(cp, b.encode(table))
        print(f'{args.ref_film} size {size}: {cp.name} {cp.stat().st_size} bytes sha256_uint16 {ch[:16]}…', flush=True)

    print('domain', [DOMAIN_LO, DOMAIN_LO + DOMAIN_SPAN], 'ref_film', args.ref_film, 'direct-scan')


if __name__ == '__main__':
    main()
