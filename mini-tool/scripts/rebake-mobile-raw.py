#!/usr/bin/env python3
"""Regenerate styles/luts/*-mobile-raw.png with per-channel normalization.

One-off repair for the 2026-09-21 root cause (validation/spektrafilm-grid/
raw-scale-rootcause.md): bake-mobile-film.py normalized the raw table by a
global scalar (2D max(axis=(0,1))) while the runtime pairs the table with the
per-channel rawScale from styles/presets.js, underexposing every non-max
channel (v3500t R/G by ~0.11 log10E). The canonical fix lives in
scripts/bake-mobile-film.py; this script regenerates only the raw tables so
the full scan-LUT rebake (unaffected) can be skipped.

For each stock: rebuild the pinned pipeline exactly like the original bake,
recompute the 33^3 raw grid, normalize per channel, write the PNG, then
verify the runtime pairing (table x presets.js rawScale) against a direct
_rgb_to_film_raw call on an exact 9^3 node set (must be ~zero log offset).

用法: python scripts/rebake-mobile-raw.py --reference /path/to/spektrafilm [key ...]   # 默认全部 11 款
"""
import argparse, importlib, json, os, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
b = importlib.import_module('bake-film-stocks')
n = importlib.import_module('bake-native-film')

OUT = b.ROOT / 'styles' / 'luts'


def presets_rawscale():
    text = (b.ROOT / 'styles' / 'presets.js').read_text()
    body = text.split('window.FILMIFY_STYLES=', 1)[1].strip().rstrip(';')
    data = json.loads(body)
    return {k: np.array(v['rawScale'], float) for k, v in data.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--reference', type=Path, required=True,
                    help='Clean spektrafilm checkout at the pinned revision')
    ap.add_argument('keys', nargs='*')
    args = ap.parse_args()
    REF = args.reference.resolve()
    keys = args.keys or list(b.PROFILES)
    assert __import__('subprocess').check_output(['git', '-C', str(REF), 'rev-parse', 'HEAD'], text=True).strip() == b.REV
    scales = presets_rawscale()
    nodes = b.grid(9).reshape(-1, 3)
    for key in keys:
        film, paper = b.PROFILES[key]
        native, s = n.pipeline(REF, film, paper)
        nch = s.film.data.density_curves.shape[-1]

        def raw(rgb):
            return np.asarray(s._filming_stage._rgb_to_film_raw(
                rgb.reshape(-1, 1, 3), color_space='sRGB', apply_cctf_decoding=True)).reshape(-1, nch)

        raw_grid = raw(b.grid(33))
        scale = raw_grid.max(axis=0)  # per-channel (the fix)
        raw_table = (raw_grid / scale).reshape(33, 33, 33, nch)
        if nch == 1:
            raw_table = np.repeat(raw_table, 3, -1)
        rp = OUT / (key + '-mobile-raw.png')
        b.write_png(rp, raw_table)
        # Verify the exact runtime pairing: decoded table x presets.js rawScale
        # vs direct _rgb_to_film_raw on exact grid nodes -> log10 offset ~ 0.
        q = b.read_png(rp, 33)
        ref_scale = scales[key]
        direct = np.asarray(s._filming_stage._rgb_to_film_raw(
            nodes.reshape(-1, 1, 3), color_space='sRGB', apply_cctf_decoding=True)).reshape(-1, nch)
        approx = b.sample(q, nodes)[..., :nch] * ref_scale[:nch]
        d = np.log10(np.maximum(approx, 0) + 1e-10) - np.log10(np.maximum(direct, 0) + 1e-10)
        err = np.abs(d).max()
        # Threshold 0.01 log10E: covers 16-bit quantization at near-zero raw
        # (superia node tail ~0.006) while staying 10x below the fixed bug
        # (smallest real offset was 0.0038, typical 0.02-0.12).
        status = 'OK' if err <= 0.01 else 'FAIL'
        print(f'{key:12s} scale {np.atleast_1d(scale).round(4).tolist()} vs presets {ref_scale[:nch].round(4).tolist()} '
              f'node max|dlog| {err:.5f} {status}', flush=True)
        assert status == 'OK', (key, d.mean(0), d.min(0), d.max(0))
    print('DONE ->', OUT, flush=True)


if __name__ == '__main__':
    main()
