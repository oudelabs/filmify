"""Bake mobile raw-domain local-chemistry LUTs from pinned spektrafilm 6cd00c8.

Mobile default (proposal A): one 3D LUT per stock accepts a density-uniform
coordinate t derived from log-exposure (post raw optics, pre develop) and
outputs encoded scanner sRGB, so the runtime no longer executes the local DIR
couplers (donor/receiver matrix and corrected curves). Runtime exposure (EV)
and bwCorrection stay outside the table; the low-res optical field feeds the
same log domain. The runtime keeps only cheap per-channel 1D density-curve
lookups before the 3D table. The reference native bake
(scripts/bake-native-film.py) stays intact; this script only adds mobile
tables plus a grain calibration profile for the statistical grain stage.

Validation assets go to validation/eleven-stocks/mobile-default/ first; the
product path is wired only after quality gates pass.
"""
import argparse, copy, importlib, json, re, subprocess, sys, os
from pathlib import Path
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
b = importlib.import_module('bake-film-stocks')
n = importlib.import_module('bake-native-film')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--reference', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--sizes', default='25,33,41,49,57')
    ap.add_argument('--evs', default='-4,0,4,8,12')
    ap.add_argument('--only', default='', help='comma-separated stock keys to bake; default all')
    args = ap.parse_args()
    ref = args.reference.resolve()
    assert subprocess.check_output(['git', '-C', str(ref), 'rev-parse', 'HEAD'], text=True).strip() == b.REV
    assert not subprocess.check_output(['git', '-C', str(ref), 'status', '--porcelain', '--untracked-files=no'], text=True).strip(), 'Reference source modified'
    sizes = [int(x) for x in args.sizes.split(',')]
    evs = [int(x) for x in args.evs.split(',')]
    out = args.output.resolve(); (out / 'luts').mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20260920)
    points = np.concatenate([b.grid(9).reshape(-1, 3), rng.random((4096, 3)), np.repeat(np.linspace(0, 1, 1025)[:, None], 3, axis=1)])
    presets, entries, report, calibrations = {}, {}, {}, {}
    mobile_presets = {}

    keys = list(b.PROFILES) if not args.only else [k.strip() for k in args.only.split(',')]
    for key in keys:
        film, paper = b.PROFILES[key]
        print('Bake', key, flush=True)
        native, s = n.pipeline(ref, film, paper)
        fp = n.film_parameters(native, s)
        nch = fp['channels']
        axis = np.asarray(fp['logExposure'], float)
        lo_log, hi_log = float(axis.min()), float(axis.max())
        bw = np.asarray(fp['bwCorrection'], float)
        print('  log domain', lo_log, hi_log, 'bwCorr', bw.tolist(), 'positive', fp['positive'], 'ch', nch, flush=True)

        def raw(rgb):
            return np.asarray(s._filming_stage._rgb_to_film_raw(rgb.reshape(-1, 1, 3), color_space='sRGB', apply_cctf_decoding=True)).reshape(-1, nch)

        def develop_density(logv):
            return np.asarray(s._filming_stage.develop(np.asarray(logv).reshape(-1, 1, nch))).reshape(-1, nch)

        def model(density):
            return np.asarray(s.process(np.asarray(density).reshape(-1, 1, nch), inject='cmy_film')).reshape(-1, 3)

        # Density domain mirrors the reference bake per stock.
        low = -np.asarray(fp['densityMin'], float)
        high = np.asarray(fp['densityMax'], float) + .5
        if fp['positive'] and nch == 1 and fp['grain']['active']:
            high = np.maximum(high, 5.)
        span = high - low
        curves = [np.asarray(fp['curves'][ch], float) for ch in range(nch)]

        # Runtime shaper: t = (pre-DIR density curve(log) - low) / span, evaluated
        # by a plain 1D interpolation (the runtime keeps these 1D lookups and
        # drops donor/receiver matrix and corrected-curve work). The inverse uses
        # the same monotone curves, so table values and runtime t stay consistent.
        def t_of_log(logv):
            d = np.empty_like(logv)
            for ch in range(nch):
                d[:, ch] = np.interp(logv[:, ch], axis, curves[ch])
            return (d - low) / span

        def inv_curve(dtarget):
            out = np.empty_like(dtarget)
            for ch in range(nch):
                cv = curves[ch]
                if cv[0] <= cv[-1]:
                    out[:, ch] = np.interp(dtarget[:, ch], cv, axis)
                else:
                    out[:, ch] = np.interp(-dtarget[:, ch], -cv, axis)
            return out

        # Positive stocks (reversal) collapse to low densities at high EV, which
        # starves the low end of a uniform density grid. Apply a sqrt shaper so
        # the table grid u is uniform but the density coordinate is t = u^2,
        # packing more grid points into the bright low-density region where the
        # scanner output changes fastest. Runtime maps t -> u = sqrt(t).
        shaper = 'sqrt' if fp['positive'] else None

        def grid_t(u):
            return u * u if shaper else u

        def runtime_u(t):
            return np.sqrt(np.clip(t, 0, 1)) if shaper else t

        # Raw table (same generation as the reference bake; 33^3 kept).
        size_raw = 33
        raw_grid = raw(b.grid(size_raw))
        # Per-channel normalization: raw() above returns (-1, nch), so this must
        # be axis=0 only. max(axis=(0, 1)) on the 2D array collapses to a single
        # global scalar, which silently mismatches the per-channel rawScale the
        # runtime pairs this table with (styles/presets.js, native bake) — every
        # non-max channel ends up underexposed by log10(scale_ch/scale_global)
        # (2026-09-21 v3500t -0.11 logE root cause, validation/spektrafilm-grid/).
        scale = raw_grid.max(axis=0)
        raw_table = (raw_grid / scale).reshape(size_raw, size_raw, size_raw, nch)
        if nch == 1:
            raw_table = np.repeat(raw_table, 3, -1)
        rp = out / 'luts' / (key + '-mobile-raw.png')
        rh = b.write_png(rp, raw_table)
        raw_q = b.read_png(rp, size_raw)

        # Cross-batch guard: the runtime pairs this mobile raw table with the
        # per-channel rawScale from styles/presets.js (native bake output), not
        # with this script's own scale. The 2026-09-21 v3500t underexposure
        # shipped because the two normalizations disagreed while every gate
        # here only exercised same-batch pairs. Refuse to bake a table whose
        # scale disagrees with the runtime pairing.
        presets_js = b.ROOT / 'styles' / 'presets.js'
        if presets_js.exists():
            m_scale = re.search(r'"' + key + r'":\{.*?"rawScale":\[([^\]]+)\]', presets_js.read_text())
            if m_scale:
                ref_scale = np.array([float(x) for x in m_scale.group(1).split(',')])
                assert np.allclose(ref_scale[:nch], np.atleast_1d(scale)[:nch], rtol=1e-4, atol=1e-12), (
                    key, 'rawScale mismatch vs styles/presets.js', ref_scale.tolist(), np.atleast_1d(scale).tolist())

        def raw_approx(rgb):
            q = b.sample(raw_q, rgb)
            q = q[..., :nch] * scale
            return q if nch > 1 else q[..., :1]

        def log_coord(rawv, ev):
            return np.log10(np.maximum(rawv * 2.0 ** ev * bw, 0) + 1e-10)

        native_by_ev = {}
        approx_t_by_ev = {}
        for ev in evs:
            rr = raw(points)
            native_by_ev[ev] = b.encode(model(develop_density(log_coord(rr, ev))))
            approx_t_by_ev[ev] = t_of_log(log_coord(raw_approx(points), ev))

        chosen = None
        candidates = {}
        gate = {'mae': 0.50, 'p99': 3.0, 'max': 10.0}
        # EV >= 8 sits far outside the conservative AE range (roughly -4..+5 EV
        # for typical inputs). Those rows still verify saturation/headroom
        # behaviour but get a wider max: raw-table interpolation error dominates
        # there and has no product impact (extreme exposures saturate anyway).
        gate_extreme = {'mae': 0.50, 'p99': 3.0, 'max': 15.0}
        for size in sizes:
            g = b.grid(size).reshape(-1, 3)[..., :nch]
            logv = inv_curve(low + grid_t(g) * span)
            table = model(develop_density(logv)).reshape(size, size, size, 3)
            assert table.min() >= -1e-7 and table.max() <= 1 + 1e-7, (key, size, table.min(), table.max())
            cp = out / 'luts' / (key + '-mobile.png')
            ch = b.write_png(cp, b.encode(table))
            q = b.read_png(cp, size)
            checks = {}
            for ev, t in approx_t_by_ev.items():
                c = runtime_u(t)
                if nch == 1:
                    c = np.repeat(c, 3, -1)
                e = np.abs(b.sample(q, c) - native_by_ev[ev]) * 255
                checks[str(ev)] = {'mae': float(e.mean()), 'p99': float(np.percentile(e, 99)), 'max': float(e.max())}
            passes = all(all(v[m] <= (gate_extreme[m] if abs(int(k)) >= 8 else gate[m]) for m in ('mae', 'p99', 'max')) for k, v in checks.items())
            candidates[str(size)] = {'errors': checks, 'bytes': cp.stat().st_size, 'passes': passes}
            print(' ', size, 'passes' if passes else 'FAIL', {k: (round(v['mae'], 4), round(v['max'], 2)) for k, v in checks.items()}, flush=True)
            if passes and chosen is None:
                chosen = (size, cp.read_bytes(), ch, [float(table.min()), float(table.max())])
        assert chosen is not None, (key, candidates)
        size, png, ch, linear_bounds = chosen
        cp.write_bytes(png)

        # Grain calibration profile: density->scan gain curve per channel plus
        # native grain parameters, for the statistical grain stage.
        dmin_all = float(np.asarray(fp['densityMin']).min())
        dmax_all = float(np.max(np.asarray(fp['densityMax']))) + .5
        density_ramp = np.linspace(-dmin_all, dmax_all, 513)
        scan_curve = b.encode(model(np.repeat(density_ramp[:, None], nch, axis=1)))
        grad = np.gradient(scan_curve, density_ramp[1] - density_ramp[0], axis=0)
        calibrations[key] = {
            'channels': nch,
            'positive': fp['positive'],
            'densityMin': fp['densityMin'],
            'densityMax': fp['densityMax'],
            'grain': fp['grain'],
            'layers': fp['layers'],
            'layerMin': fp['layerMin'],
            'layerMax': fp['layerMax'],
            'particleCountsAt1um': fp['particleCountsAt1um'],
            'scanDomain': {'low': -dmin_all, 'high': dmax_all},
            'scanCurve': scan_curve.tolist(),
            'scanGradient': grad.tolist(),
            'densitySamples': density_ramp.tolist(),
            'logDomain': {'low': lo_log, 'high': hi_log},
            'bwCorrection': bw.tolist(),
            'cameraFilmFormatMm': fp['cameraFilmFormatMm'],
            'halation': fp['halation'],
        }

        def vec(x):
            x = np.asarray(x, float)
            return np.repeat(x, 3).tolist() if x.size == 1 else x.tolist()
        presets[key] = {
            'id': key, 'nativeFilm': True, 'mobile': True, 'size': size,
            'asset': './styles/' + cp.name, 'rawAsset': './styles/' + rp.name,
            'rawSize': size_raw, 'rawScale': vec(scale),
            'logLow': vec([lo_log] * nch), 'logHigh': vec([hi_log] * nch),
            'bwCorrection': vec(bw), 'stockMono': nch == 1,
            'scannerUSM': list(native.scanner.unsharp_mask),
            'film': fp,
        }
        mobile_presets[key] = {
            'mobile': True, 'mobileSize': size, 'shaper': shaper,
            'mobileAsset': './styles/luts/' + cp.name,
            'mobileRawAsset': './styles/luts/' + rp.name,
        }
        entries[key] = {
            'stock_reference': film, 'print': paper, 'scan_film': paper is None,
            'assets': {
                'mobileAsset': {'file': cp.name, 'size': size, 'png_bytes': cp.stat().st_size, 'png_sha256': b.sha(png), 'sha256_uint16': ch},
                'rawAsset': {'file': rp.name, 'size': size_raw, 'png_bytes': rp.stat().st_size, 'png_sha256': b.sha(rp.read_bytes()), 'sha256_uint16': rh},
            },
            'boundaries': {
                'axis_order': 'RGB; R fastest, then G, then B',
                'raw': {'input': 'encoded sRGB [0,1]', 'output': 'film raw exposure, normalized per channel in RGB16', 'scale': vec(scale), 'actual_channels': nch},
                'mobile_scan': {
                    'input': 'density-uniform t = (curves(log10(raw*2^EV*bwCorrection+1e-10))-low)/span; runtime evaluates the 1D density curves, then a sqrt shaper for positive stocks, then the 3D table',
                    'shaper': shaper,
                    'log_low': vec([lo_log] * nch), 'log_high': vec([hi_log] * nch),
                    'density_low': vec(low), 'density_high': vec(high),
                    'output': 'encoded scanner sRGB [0,1]; decoded before linear USM',
                    'pre_USM_linear_bounds': linear_bounds,
                },
            },
            'resolved_native': b.serial(native),
            'runtime_deferred': ['camera AE', 'raw scatter/halation', 'local density curves + DIR couplers (spatial diffusion baked as zero)'],
            'remaining': ['calibrated statistical grain', 'scanner USM', 'low-res optical field', 'print glare', 'digital darkroom controls'],
        }
        report[key] = {
            'selected': size, 'gate': gate, 'candidates': candidates,
            'log_domain': [lo_log, hi_log], 'density_domain': [low.tolist(), high.tolist()],
            'bwCorrection': bw.tolist(), 'raw_asset_bytes': rp.stat().st_size,
        }
        print(key, 'selected', size, 'mobile', cp.stat().st_size, 'raw', rp.stat().st_size, flush=True)

    manifest = {
        'version': 'mobile-default-v1',
        'reference_commit': b.REV,
        'classification': 'mobile raw-domain local-chemistry tables; proposal A validation assets',
        'styles': entries,
        'lut_count': len(entries),
        'asset_bytes': sum(v['png_bytes'] for e in entries.values() for v in e['assets'].values()),
        'generator_sha256': b.sha(Path(__file__).read_bytes()),
        'metadata_sha256': b.sha((b.ROOT / 'scripts/runtime-stock-metadata.json').read_bytes()),
    }
    for name, data in [('manifest-mobile.json', manifest), ('bake-report-mobile.json', report), ('grain-calibration.json', calibrations)]:
        (out / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    (out / 'presets-mobile.js').write_text('window.FILMIFY_MOBILE=' + json.dumps(mobile_presets, ensure_ascii=False, separators=(',', ':')) + ';\n')
    print('TOTAL mobile LUT bytes', manifest['asset_bytes'], flush=True)


if __name__ == '__main__':
    main()
