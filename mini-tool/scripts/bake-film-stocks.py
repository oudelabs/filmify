"""Unpromoted spektrafilm sRGB reference recipes. Development-only; never runs in the container.

Uses the pinned spektrafilm end-to-end model, with spatial/random effects off.
Full-chain LUTs avoid clipped, undocumented intermediate density/log domains.
This reference does not authorize spatial/stochastic omissions in production.
Only final export quantization belongs to Filmify. No claim of real-film matching.
"""
import argparse
import dataclasses
import copy
import time
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.interpolate import RegularGridInterpolator

ROOT = Path(__file__).resolve().parents[1]
REV = '6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507'
WEIGHTS = np.array([.2126, .7152, .0722])
PROFILES = {
    'portrait': ('kodak_portra_400', 'kodak_portra_endura'),
    'gold': ('kodak_gold_200', 'kodak_portra_endura'),
    'superia': ('fujifilm_xtra_400', 'fujifilm_crystal_archive_typeii'),
    'vision250d': ('kodak_vision3_250d', 'kodak_2383'),
    'doublex': ('kodak_doublex', 'kodak_2302'),
    'trix': ('kodak_trix', None),
    'ektar': ('kodak_ektar_100', 'kodak_portra_endura'),
    'pro400h': ('fujifilm_pro_400h', 'kodak_portra_endura'),
    'ultramax': ('kodak_ultramax_400', 'kodak_portra_endura'),
    'velvia': ('fujifilm_velvia_100', None),
    'v3500t': ('kodak_vision3_500t', 'kodak_2383'),
    # 扩展胶卷：上游 31 档案内、
    # 首批 11 款之外的 9 款；不包含迫冲变体 portra_800_push1/2。
    'portra160': ('kodak_portra_160', 'kodak_portra_endura'),
    'portra800': ('kodak_portra_800', 'kodak_portra_endura'),
    'c200': ('fujifilm_c200', 'fujifilm_crystal_archive_typeii'),
    'vision50d': ('kodak_vision3_50d', 'kodak_2383'),
    'vision200t': ('kodak_vision3_200t', 'kodak_2383'),
    'verita200d': ('kodak_verita_200d', 'kodak_2383'),
    'provia': ('fujifilm_provia_100f', None),
    'ektachrome': ('kodak_ektachrome_100', None),
    'kodachrome': ('kodak_kodachrome_64', None),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode(x):
    return np.where(x <= .04045, x / 12.92, ((x + .055) / 1.055) ** 2.4)


def encode(x):
    x = np.maximum(x, 0)
    return np.where(x <= .0031308, 12.92 * x, 1.055 * x ** (1 / 2.4) - .055)


def grid(size):
    b, g, r = np.meshgrid(*([np.linspace(0, 1, size)] * 3), indexing='ij')
    return np.stack([r, g, b], -1)


def sample(table, points):
    # numpy [B,G,R] -> WebGL texture x=R, y=G, z=B.
    axes = [np.linspace(0, 1, table.shape[0])] * 3
    return RegularGridInterpolator(axes, table)(np.clip(points, 0, 1)[..., ::-1])


def read_png(path, size):
    rgb = np.asarray(Image.open(path).convert('RGB'), dtype=np.uint16).reshape(-1, 2, 3)
    return ((rgb[:, 0] + rgb[:, 1] * 256) / 65535).reshape(size, size, size, 3)


def write_png(path, table):
    codes = np.round(np.clip(table, 0, 1) * 65535).astype('<u2')
    pixels = np.stack([codes & 255, codes >> 8], -2).astype(np.uint8)
    Image.fromarray(pixels.reshape(table.shape[0] ** 2, table.shape[0] * 2, 3)).save(path, compress_level=9)
    restored = read_png(path, table.shape[0])
    assert np.array_equal(np.round(restored * 65535).astype('<u2'), codes)
    return sha(codes.tobytes())


def serial(value):
    if dataclasses.is_dataclass(value):
        return {f.name: serial(getattr(value, f.name)) for f in dataclasses.fields(value) if f.name not in ('film', 'print')}
    if isinstance(value, dict): return {k: serial(v) for k,v in value.items()}
    if isinstance(value, (list, tuple)): return [serial(v) for v in value]
    if isinstance(value, np.ndarray): return value.tolist()
    if isinstance(value, np.generic): return value.item()
    return value


def parameter_diff(native, reference, prefix=''):
    changes=[]
    for key in sorted(set(native) | set(reference)):
        a,b=native.get(key),reference.get(key)
        path=prefix+'.'+key if prefix else key
        if isinstance(a,dict) and isinstance(b,dict):
            changes.extend(parameter_diff(a,b,path))
        elif a!=b:
            category=('io_adapter' if path.startswith('io.') else
                      'control_flag' if path.startswith('debug.') else
                      'metering' if path.startswith('camera.auto_exposure') else
                      'stochastic' if '.grain.' in path or '.glare.' in path else 'spatial')
            changes.append(dict(path=path,native=a,lut_reference=b,category=category,
                                production_omission_authorized=False))
    return changes


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--reference', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True, help='Staging styles directory; never overwrites source by default')
    ap.add_argument('--recipes', type=Path, default=ROOT / 'validation/eleven-stocks/upstream-reference/recipes.json')
    ap.add_argument('--sizes', default='17,25,33')
    args = ap.parse_args()
    ref = args.reference.resolve()
    assert subprocess.check_output(['git', '-C', str(ref), 'rev-parse', 'HEAD'], text=True).strip() == REV
    assert not subprocess.check_output(['git', '-C', str(ref), 'status', '--porcelain', '--untracked-files=no'], text=True).strip(), 'Reference source modified'
    sys.path.insert(0, str(ref / 'src'))
    import spektrafilm
    assert Path(spektrafilm.__file__).resolve().is_relative_to(ref)
    from spektrafilm.runtime.params_builder import init_params, digest_params
    from spektrafilm.runtime.pipeline import SimulationPipeline
    recipes = json.loads(args.recipes.read_text())
    manifest = json.loads((ROOT / 'styles/manifest.json').read_text())
    assert manifest['reference_commit'] == REV, 'Profile manifest revision differs'
    known = {}
    for entry in manifest['styles'].values():
        for name, digest in entry['profile_sha256'].items():
            assert name not in known or known[name] == digest, ('Conflicting profile hashes', name)
            known[name] = digest
    profiles = ref / 'src/spektrafilm/data/profiles'
    sizes = [int(n) for n in args.sizes.split(',')]
    assert set(recipes) == set(PROFILES)
    out = args.output; (out / 'luts').mkdir(parents=True, exist_ok=True)
    presets, entries, report = {}, {}, {}
    ramp = np.linspace(0, 1, 1025)
    points = np.concatenate([np.repeat(ramp[:, None], 3, axis=1), grid(9).reshape(-1, 3), np.random.default_rng(20260919).random((4096, 3))])
    for key, (stock, paper) in PROFILES.items():
        print('Bake', key, flush=True)
        recipe = recipes[key]
        hashes = {}
        for name in filter(None, [stock, paper]):
            hashes[name] = sha((profiles / (name + '.json')).read_bytes())
            assert hashes[name] == known[name], name
        info = json.loads((profiles / (stock + '.json')).read_text())['info']
        assert (info['type'] == 'positive') == (paper is None)
        bw = info['channel_model'] == 'bw'
        params = init_params(film_profile=stock, print_profile=paper or 'kodak_2302')
        params.io.input_color_space = params.io.output_color_space = 'sRGB'
        params.io.input_cctf_decoding = params.io.output_cctf_encoding = True
        params.io.scan_film = paper is None
        native = digest_params(copy.deepcopy(params))
        params.debug.lut_mode = True
        resolved = digest_params(params)
        pipeline = SimulationPipeline(resolved)

        def model(rgb):
            shape = rgb.shape
            linear = rgb.reshape(-1, 1, 3)
            reference = np.asarray(pipeline.process(linear), float).reshape(shape)
            assert np.isfinite(reference).all()
            return np.clip(reference, 0, 1)

        expected = model(points)
        encoded_params = copy.deepcopy(params)
        encoded_params.io.input_cctf_decoding = False
        encoded_params.io.output_cctf_encoding = False
        encoded_pipe = SimulationPipeline(digest_params(encoded_params))
        encoded = np.clip(encode(encoded_pipe.process(decode(points).reshape(-1,1,3)).reshape(points.shape)),0,1)
        io_error = float(np.max(np.abs(encoded-expected)))
        assert io_error < .1/255, (key, 'external sRGB adapter difference', io_error)
        # Canonical output uses upstream encoding, including its RGB_to_RGB matrix.
        # External transfer functions are measured only, never used in the table.
        scan_print_error = None
        if paper is None:
            alternate = init_params(film_profile=stock, print_profile='kodak_portra_endura')
            alternate.debug.lut_mode = True
            alternate.io.input_color_space = alternate.io.output_color_space = 'sRGB'
            alternate.io.input_cctf_decoding = alternate.io.output_cctf_encoding = True
            alternate.io.scan_film = True
            alternate_pipe = SimulationPipeline(digest_params(alternate))
            alternate_out = np.clip(alternate_pipe.process(points.reshape(-1,1,3)).reshape(points.shape),0,1)
            scan_print_error = float(np.max(np.abs(alternate_out-expected)))
            assert scan_print_error < 1e-7, (key, 'unused print influences direct scan', scan_print_error)
        studies = {}
        for size in sizes:
            table = model(grid(size))
            quantized = np.round(table * 65535) / 65535
            actual = sample(quantized, points)
            error = np.abs(actual - expected) * 255
            neutral = sample(quantized, np.repeat(ramp[:, None], 3, axis=1))
            studies[str(size)] = dict(mae=float(error.mean()), p99=float(np.percentile(error, 99)), max=float(error.max()), neutral_reversals=int(np.sum(np.diff(neutral @ WEIGHTS) < -1e-7)))
            if size == recipe['size']:
                chosen = quantized
        # Fixed thresholds judge LUT approximation, not photographic identity.
        metrics = studies[str(recipe['size'])]
        assert metrics['neutral_reversals'] == 0, (key, metrics)
        assert metrics['mae'] < 1.0 and metrics['p99'] < 5.0, (key, metrics)
        # Do not project BW output to gray: preserve upstream scanning colour.
        path = out / 'luts' / (key + '.png')
        raw_sha = write_png(path, chosen)
        presets[key] = dict(id=key, name=recipe['name'], description=recipe['description'], size=recipe['size'], asset='./styles/'+key+'.png', mono=False, stockMono=bw, finish=dict(soft=0,bloom=0,grain=0,grainSize=1,grainChroma=0,vignette=0))
        entries[key] = dict(stock_reference=stock, print=paper, scan_film=paper is None, mono=bw, reference_commit=REV, profile_sha256=hashes, size=recipe['size'], topology='combined sRGB to sRGB; upstream LUT mode without source blend', resolved_native=serial(native), resolved_lut_mode=serial(resolved), parameter_changes=parameter_diff(serial(native),serial(resolved)), asset=key+'.png', png_sha256=sha(path.read_bytes()), sha256_uint16=raw_sha, png_bytes=path.stat().st_size)
        report[key] = dict(sizes=studies, io_adapter_max_error=io_error, direct_scan_unused_print_max_error=scan_print_error, selected_size=recipe['size'], stock_mono=bw, black=chosen[0,0,0].tolist(), white=chosen[-1,-1,-1].tolist())
        print(key, json.dumps(report[key]), flush=True)
    manifest = dict(version='eleven-stocks-v2', reference_commit=REV, input='encoded sRGB SDR', output='encoded sRGB SDR', order='B,G,R,channel; R fastest; WebGL coordinates RGB', encoding='PNG RGB8 paired pixels: low bytes then high bytes', classification='inspired; model-derived, not real-film-match certified', topology='combined LUT per fixed film/print/scan recipe', spatial_development='upstream LUT mode reference only; production omission requires separate evidence', recipes_sha256=sha(args.recipes.read_bytes()), generator_sha256=sha(Path(__file__).read_bytes()), styles=entries, lut_count=len(entries), asset_bytes=sum(v['png_bytes'] for v in entries.values()))
    # Reference LUTs are a staging artifact; the shipping budget lives in
    # build-minitool's 10 MiB zip gate. Log instead of asserting (20-stock era).
    print('asset_bytes(staging reference)', manifest['asset_bytes'], flush=True)
    (out/'presets.js').write_text('/* Generated by scripts/bake-film-stocks.py; CC BY-SA 4.0. See NOTICE.md. */\nwindow.FILMIFY_STYLES='+json.dumps(presets,ensure_ascii=False,separators=(',',':'))+';\n')
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (out/'bake-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print('LUT bytes',manifest['asset_bytes'],flush=True)


if __name__ == '__main__':
    main()
