#!/usr/bin/env python3
"""Rebuild shipped shared LUTs with committed calibration, then run numeric gates.

Run in a disposable checkout: the final promotion overwrites shared PNGs and
registries in styles/. No automatic refit or production parameter change.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REV = '6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507'


def registry(name, marker):
    return json.loads((ROOT / 'styles' / name).read_text().split(marker, 1)[1].strip().rstrip(';'))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--reference', type=Path, required=True)
    args = ap.parse_args()
    ref = args.reference.resolve()
    assert subprocess.check_output(['git', '-C', str(ref), 'rev-parse', 'HEAD'], text=True).strip() == REV, 'Wrong upstream revision'
    assert not subprocess.check_output(['git', '-C', str(ref), 'status', '--porcelain', '--untracked-files=no'], text=True).strip(), 'Modified upstream source'
    env = dict(os.environ, SPEKTRAFILM_REPO=str(ref))
    env.setdefault('OPENBLAS_NUM_THREADS', '1')
    env.setdefault('OMP_NUM_THREADS', '1')

    def run(script, *args):
        subprocess.run([sys.executable, script, *map(str, args)], cwd=ROOT, env=env, check=True)

    staging = ROOT / 'validation/shared-lut'
    prints = registry('presets-prints.js', 'window.FILMIFY_PRINTS=')
    films = registry('presets.js', 'window.FILMIFY_STYLES=')
    # Profile names are taken from the same catalog used by the promotion scripts.
    import importlib
    catalog = importlib.import_module('bake-film-stocks').PROFILES
    for paper, spec in prints.items():
        run('scripts/bake-shared-print.py', '--reference', ref, '--output', staging,
            '--print', paper, '--ref-film', spec['refFilm'], '--sizes', spec['size'])
        profiles = [catalog[sid][0] for sid in spec['W'] if sid in films]
        profiles.append(spec['refFilm'])
        run('validation/shared-lut/ab-check.py', staging / 'luts' / Path(spec['asset']).name,
            spec['size'], '--films', ','.join(profiles))
    scan = registry('presets-scans.js', 'window.FILMIFY_SCANS=')['direct_scan']
    run('validation/shared-lut/bake-shared-scan.py', '--reference', ref,
        '--ref-film', scan['refFilm'], '--sizes', scan['size'])
    run('validation/shared-lut/ab-scan.py', staging / 'luts' / Path(scan['asset']).name, scan['size'])
    run('scripts/build-shared-prints.py')
    run('scripts/build-shared-scans.py')
    print('Shared LUT rebuild and numeric gates: PASS')


if __name__ == '__main__':
    main()
