"""Build the offline Xiaohongshu package and matching consumer homepage."""
from pathlib import Path
from html import escape
from html.parser import HTMLParser
import re
import hashlib
import json
import struct
import sys
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist' / 'xhs-tool'
OUT.mkdir(parents=True, exist_ok=True)


def replace_once(source, old, new):
    assert source.count(old) == 1, f'Source changed; review build adapter: {old[:90]}'
    return source.replace(old, new, 1)


def recompress_png(data):
    """Rewrite only the deflate stream of a PNG's IDAT chunks at zlib level 9.

    The decompressed byte stream (filter bytes + pixel bytes) is preserved
    exactly, so decoded pixels — and the decoded-value integrity hashes
    (fnv1a32 over LUT values, re-encode-proof by design) — are unchanged.
    2026-09-22 package-size governance: LUT PNGs baked at PIL's default
    level 6 carry ~10% slack; measured on the full styles/ set. Returns the
    original bytes when recompression would not shrink the file."""
    import zlib as _zlib
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return data
    pos = 8
    parts = []
    idat = b''
    seen_idat = False
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]
        typ = data[pos+4:pos+8]
        body = data[pos+8:pos+8+ln]
        if typ == b'IDAT':
            idat += body
            if not seen_idat:
                parts.append((typ, None))
                seen_idat = True
        else:
            parts.append((typ, body))
        pos += 12 + ln
    if not idat:
        return data
    comp = _zlib.compress(_zlib.decompress(idat), 9)
    if len(comp) >= len(idat):
        return data
    out = bytearray(data[:8])
    for typ, body in parts:
        if typ == b'IDAT':
            body = comp
        out += struct.pack('>I', len(body)) + typ + body
        out += struct.pack('>I', _zlib.crc32(typ + body) & 0xffffffff)
    return bytes(out)


page = (ROOT / 'minitool/index.html').read_text()
package = json.loads((ROOT / 'package.json').read_text())
version = package['version']
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?', version), 'Invalid package version'
page = replace_once(page, '<meta name="filmify-version" content="development">',
                    '<meta name="filmify-version" content="' + escape(version, quote=True) + '">')
repository = package.get('repository', '')
if isinstance(repository, dict):
    repository = repository.get('url', '')
repository = repository.removeprefix('git+').removesuffix('.git')
assert not repository or re.fullmatch(r'https://[A-Za-z0-9.-]+/[A-Za-z0-9_./-]+', repository), 'Use an HTTPS repository URL'
page = replace_once(page, '<meta name="filmify-repository" content="">',
                    '<meta name="filmify-repository" content="' + escape(repository, quote=True) + '">')
notice = (ROOT / 'styles/NOTICE.md').read_text()
notice = notice.replace('The complete upstream license is in SPEKTRAFILM_LICENSE.txt.', 'The complete upstream license is included below.')
notice += '\nUpload package modification: LUT uint16 bytes are stored losslessly in pairs of RGB8 PNG pixels (low bytes, high bytes), then reconstructed to the same float values at runtime.\n'
license_text = (ROOT / 'styles/SPEKTRAFILM_LICENSE.txt').read_text()
# The container accepts HTML but not .txt. Preserve both complete licenses in
# the existing in-page notice instead of shipping a disallowed file type.
notice = notice.replace('its code license is supplied in SPEKTRAFILM_CODE_LICENSE.txt.', 'its complete code license is included below.')
license_text += '\n\nSpektrafilm code license (GPLv3)\n\n' + (ROOT / 'styles/SPEKTRAFILM_CODE_LICENSE.txt').read_text()
# Caption typeface (Libre Baskerville basic-Latin subsets, assets/caption-400/600.woff):
# OFL 1.1 §2 requires the copyright notice + license to travel with bundled copies;
# the container rejects .txt, so the repo copy lives at minitool/assets/caption-font-OFL.txt
# and the packaged copy rides inside this same in-page notice (2026-09-22, pre-review).
license_text += '\n\nCaption typeface license (Libre Baskerville, SIL OFL 1.1)\n\n' + (ROOT / 'minitool/assets/caption-font-OFL.txt').read_text()
page = replace_once(page, '<!-- FILMIFY_LICENSE -->', escape(notice + '\n\n' + license_text))

# v1 ships the mobile baked-core path only; filmify.js/spatial-gpu.js (native
# GPU path) stay in the repo but are no longer packaged.
presets_text = (ROOT / 'styles/presets.js').read_text().split('window.FILMIFY_STYLES=',1)[1].strip().rstrip(';')
presets = json.loads(presets_text)
files = {
    'index.html': page,
    'flex-gap.js': (ROOT / 'minitool/flex-gap.js').read_text(),
    'yield.js': (ROOT / 'minitool/yield.js').read_text(),
    'negative-preview.js': (ROOT / 'minitool/negative-preview.js').read_text(),
    # native-film.js stays: the mobile optics field calls FilmifyNativeFilm.optics
    # (scatter/halation kernels). spatial-gpu.js is native-path-only and not packaged.
    'native-film.js': (ROOT / 'minitool/native-film.js').read_text(),
    'app.js': (ROOT / 'minitool/app.js').read_text(),
    'materials.js': (ROOT / 'minitool/materials.js').read_text(),
    'engine.js': (ROOT / 'minitool/engine.js').read_text(),
    'exposure.js': (ROOT / 'minitool/exposure.js').read_text(),
    'mobile-film.js': (ROOT / 'minitool/mobile-film.js').read_text(),
    'mobile-optics.js': (ROOT / 'minitool/mobile-optics.js').read_text(),
    'styles/grain-stats.js': (ROOT / 'styles/grain-stats.js').read_text(),
    'host.js': (ROOT / 'minitool/host.js').read_text(),
    # 4s development live photo (single-photo single-recipe share group).
    'print-design.js': (ROOT / 'minitool/print-design.js').read_text(),
    'live-wipe.js': (ROOT / 'minitool/live-wipe.js').read_text(),
    # 整组拼图(固定竖版 3:4 黑底方格 + 负片渐变显影动图,2026-09-22 下午定稿)。
    'collage-grid.js': (ROOT / 'minitool/collage-grid.js').read_text(),
    # 原片×成片对比图(2026-09-22 拍板:分享组原图位替换为对比图)。
    'collage-compare.js': (ROOT / 'minitool/collage-compare.js').read_text(),
    'studio.css': (ROOT / 'minitool/studio.css').read_text(),
    # styles/manifest.json 不打包(2026-09-22 包体积治理):运行时零引用,纯溯源
    # 元数据,构建期校验直接读源文件;源文件留仓库。
}
# Brand mark used by the v2 flow (home header). 2026-09-22 12:56 拍板删浅色主题后,
# 暖白版成为唯一 Logo(橙色保留);浅色版 logo-mark-t.png 退役(入退役清单)。
files['assets/logo-mark-t-dark.png'] = (ROOT / 'minitool/assets/logo-mark-t-dark.png').read_bytes()
# Seamless low-frequency mottle tile for the dark-theme background (FFT-periodized; the
# feTurbulence stitchTiles approach only stitches the first octave and showed tile seams).
files['assets/bg-mottle.png'] = (ROOT / 'minitool/assets/bg-mottle.png').read_bytes()
# logo-mark-dark.png removed from repo 2026-09-21 (dead asset after the
# brand-free export decision; git history retains it).
# Negative-film picker preview LUT (from CAM NegativePickerLUT; selection display only).
# 2026-09-22: 64³→32³ 降阶(512²→256²,26.4KB→5.6KB;预览示意性质,三线性自检 max 1.25/255),
# GPU 着色器直接采样图集;64³ 原表留仓库作烘焙源,不再进包。
files['assets/negative-picker-lut32.png'] = (ROOT / 'minitool/assets/negative-picker-lut32.png').read_bytes()
# Film-frame placeholders retired 2026-09-22 (empty state is now a dashed frame + big plus,
# no recipe-tinted placeholder image; the retired source assets have been removed).
# Live-photo caption typeface (Libre Baskerville 400/600, basic-Latin subset;
# packaged as WOFF per minitool zip spec §2 (ttf/woff2 not in the allowed
# list / brotli unavailable), falls back to Didot if font load fails).
files['assets/caption-400.woff'] = (ROOT / 'minitool/assets/caption-400.woff').read_bytes()
files['assets/caption-600.woff'] = (ROOT / 'minitool/assets/caption-600.woff').read_bytes()
# Red "WORKING" darkroom sign shown above the stage line on the processing page
# (2026-09-22; cropped to content incl. glow, 440w for ~200pt display @DPR2,
# 256-color quantized RGBA ~20KB).
files['assets/working-sign.png'] = (ROOT / 'minitool/assets/working-sign.png').read_bytes()
# Processing-page stage illustrations removed 2026-09-21 (user call: each route's real
# process differs, so the page now lists the route's actual steps with no artwork;
# the retired proc-*.png source assets have been removed).
# v1 flow has no handbook entry; handbook module and darkroom print path were
# removed from the repo on 2026-09-21 (user confirmed; git history retains both).
previous_assets=set()
previous_presets=OUT/'styles/presets.js'
if previous_presets.exists():
    previous=json.loads(previous_presets.read_text().split('window.FILMIFY_STYLES=',1)[1].strip().rstrip(';'))
    for recipe in previous.values():
        for field,value in recipe.items():
            if (field.startswith('asset') or field in ('meterAsset','rawAsset')) and isinstance(value,str) and value.startswith('./styles/'):
                previous_assets.add(value[2:])
# 退役的逐组合 mobile.png 只在 presets-mobile.js 里被引用过(2026-09-22 共享印相表
# 重构),上面的 presets.js 扫描覆盖不到;连同 presets-prints.js 一起扫。
for prev_name, marker in (('presets-mobile.js','window.FILMIFY_MOBILE='),('presets-prints.js','window.FILMIFY_PRINTS='),('presets-scans.js','window.FILMIFY_SCANS=')):
    prev_file=OUT/'styles'/prev_name
    if prev_file.exists():
        prev_reg=json.loads(prev_file.read_text().split(marker,1)[1].strip().rstrip(';'))
        for entry in prev_reg.values():
            for field,value in entry.items():
                if field.endswith('Asset') or field=='asset':
                    if isinstance(value,str) and value.startswith('./styles/'):
                        previous_assets.add(value[2:])
source_manifest = json.loads((ROOT / 'styles/manifest.json').read_text())
assert source_manifest['version']=='native-film-stages-v1'
for field,path in [('generator_sha256','scripts/bake-native-film.py'),('metadata_sha256','scripts/runtime-stock-metadata.json')]:
    assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==source_manifest[field], ('Regenerate stale manifest',path)
assert set(source_manifest['styles']) == set(presets), 'Manifest and preset inventories differ'
for id, style in presets.items():
    entry = source_manifest['styles'][id]
    assert entry['assets']['asset']['size'] == style['size'], (id, 'LUT size differs')
    assert style.get('nativeFilm') is True, (id, 'Only native colour cores are supported')
    required = ['asset','rawAsset']
    assert set(entry['assets']) == set(required), (id, 'Manifest asset set differs')
    for field in required:
        path = style.get(field)
        assert path and path.startswith('./styles/'), (id, field, 'Missing table declaration')
        name = Path(path).name
        assert path == './styles/'+name and entry['assets'][field]['file'] == name
        data = (ROOT / 'styles/luts' / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry['assets'][field]['png_sha256'], (id, field, 'Table checksum differs')
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        size = entry['assets'][field].get('size',style['size'])
        assert struct.unpack('>II',data[16:24]) == (size*2,size**2), (id, field, 'Bad dimensions')
        # Native density/raw tables are validated but NOT packaged: every v1
        # stock renders through the mobile baked core, so these stay source-only.
assert 2 * len(source_manifest['styles']) == sum(len(v['assets']) for v in source_manifest['styles'].values())
mobile_presets_text = (ROOT / 'styles/presets-mobile.js').read_text()
mobile_presets = json.loads(mobile_presets_text.split('window.FILMIFY_MOBILE=',1)[1].strip().rstrip(';'))
assert set(mobile_presets) == set(presets), 'Mobile preset inventory differs from styles'
# 2026-09-22 共享印相表重构(docs/shared-lut-design.md):印相胶卷的逐组合
# mobile.png(DIR 烘进表,与 shader 逐点 DIR 叠加成双重 DIR)被「每印相载体一张
# 全局域表 + 逐胶卷 W 预变换」取代,不再打包;直扫反转片保留逐款表。
# 判定按 shaper:反转片(positive)烘表时用 sqrt shaper(bake-mobile-film.py),
# 负片 shaper=None——第二批 provia/ektachrome/kodachrome 自动落入直扫分支。
PRINT_ROUTED = {id for id, e in mobile_presets.items() if e.get('shaper') != 'sqrt'}
prints_text = (ROOT / 'styles/presets-prints.js').read_text()
prints_reg = json.loads(prints_text.split('window.FILMIFY_PRINTS=',1)[1].strip().rstrip(';'))
print_files = {}
for pid, pentry in prints_reg.items():
    name = Path(pentry['asset']).name
    assert pentry['asset'] == './styles/luts/' + name, (pid, 'Path shape')
    assert isinstance(pentry.get('hash'), int) and pentry['hash'] >= 0, \
        (pid, 'Missing print LUT integrity hash — run scripts/build-shared-prints.py')
    data = (ROOT / 'styles/luts' / name).read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II', data[16:24]) == (pentry['size'] * 2, pentry['size'] ** 2), (pid, 'Bad dimensions')
    print_files['styles/' + name] = data
    files['styles/' + name] = data
    pentry['asset'] = './styles/' + name
files['styles/presets-prints.js'] = 'window.FILMIFY_PRINTS=' + json.dumps(prints_reg, ensure_ascii=False, separators=(',', ':')) + ';\n'
# 2026-09-22 下午 共享直扫表:四款彩色反转片(velvia=基准恒等/provia/
# ektachrome/kodachrome)共用一张基准 Velvia 全局域裸 scan 表+3x20 三次 W
# (scripts/build-shared-scans.py 生成),根治逐款直扫表的双重 DIR。
# 成员以注册表为准(不能按 shaper 判:trix 黑白反转片同为 sqrt 但保留逐款表)。
scans_text = (ROOT / 'styles/presets-scans.js').read_text()
scans_reg = json.loads(scans_text.split('window.FILMIFY_SCANS=',1)[1].strip().rstrip(';'))
SCAN_SHARED = set()
for sid, sentry in scans_reg.items():
    SCAN_SHARED |= set(sentry['styles'])
assert all(mobile_presets[id].get('shaper') == 'sqrt' for id in SCAN_SHARED), 'Scan-shared film must be a sqrt-shaper reversal'
assert 'trix' not in SCAN_SHARED, 'trix keeps its per-film direct-scan table'
scan_files = {}
for sid, sentry in scans_reg.items():
    name = Path(sentry['asset']).name
    assert sentry['asset'] == './styles/luts/' + name, (sid, 'Path shape')
    assert isinstance(sentry.get('hash'), int) and sentry['hash'] >= 0, \
        (sid, 'Missing scan LUT integrity hash — run scripts/build-shared-scans.py')
    data = (ROOT / 'styles/luts' / name).read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II', data[16:24]) == (sentry['size'] * 2, sentry['size'] ** 2), (sid, 'Bad dimensions')
    scan_files['styles/' + name] = data
    files['styles/' + name] = data
    sentry['asset'] = './styles/' + name
files['styles/presets-scans.js'] = 'window.FILMIFY_SCANS=' + json.dumps(scans_reg, ensure_ascii=False, separators=(',', ':')) + ';\n'
mobile_files = {}
for id, entry in mobile_presets.items():
    style = presets[id]
    if id in PRINT_ROUTED:
        # 印相胶卷:逐组合表退役,包内只留 raw 表(色彩由 presets-prints.js 接管)
        for dead in ('mobileAsset', 'mobileSize', 'mobileHash'):
            entry.pop(dead, None)
    elif id in SCAN_SHARED:
        # 共享直扫反转片:逐款表退役,包内只留 raw 表(色彩由 presets-scans.js 接管)
        for dead in ('mobileAsset', 'mobileSize', 'mobileHash'):
            entry.pop(dead, None)
    fields = [('mobileAsset', 'mobileSize'), ('mobileRawAsset', 'rawSize')] if id not in PRINT_ROUTED and id not in SCAN_SHARED else [('mobileRawAsset', 'rawSize')]
    for field, size_field in fields:
        name = Path(entry[field]).name
        assert entry[field] == './styles/luts/' + name, (id, field, 'Path shape')
        # Integrity hash coverage: rebaked LUTs must be re-stamped
        # (scripts/stamp-mobile-lut-hashes.py) or the runtime cannot detect
        # toolchain/platform-side corruption of the colour tables.
        hash_field = 'mobileHash' if field == 'mobileAsset' else 'mobileRawHash'
        assert isinstance(entry.get(hash_field), int) and entry[hash_field] >= 0, \
            (id, hash_field, 'Missing LUT integrity hash — run scripts/stamp-mobile-lut-hashes.py')
        data = (ROOT / 'styles/luts' / name).read_bytes()
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        size = entry.get(size_field) or style[size_field]
        assert struct.unpack('>II', data[16:24]) == (size * 2, size * size), (id, field, 'Bad dimensions')
        mobile_files['styles/' + name] = data
        files['styles/' + name] = data
        # The package flattens LUTs to styles/; rewrite the runtime reference so
        # the packaged presets-mobile.js never points at the source-only luts/ dir.
        entry[field] = './styles/' + name
files['styles/presets-mobile.js'] = 'window.FILMIFY_MOBILE=' + json.dumps(mobile_presets, ensure_ascii=False, separators=(',', ':')) + ';\n'
expected_luts = {a['file'] for entry in source_manifest['styles'].values() for a in entry['assets'].values()} | {Path(k).name for k in mobile_files} | {Path(k).name for k in print_files} | {Path(k).name for k in scan_files}
assert {p.name for p in (ROOT/'styles/luts').glob('*.png')} == expected_luts, 'Remove unused LUTs from styles/luts; only manifest/mobile/print/scan assets belong here'
lut_asset_bytes = sum(len(data) for name, data in files.items() if name.startswith('styles/') and name.endswith('.png'))
mobile_asset_bytes = sum(len(v) for v in mobile_files.values()) + sum(len(v) for v in print_files.values()) + sum(len(v) for v in scan_files.values())
assert lut_asset_bytes == mobile_asset_bytes, 'Only mobile+print+scan LUTs are packaged in v1'
# 预算口径:2026-09-22 包体积治理后 20 胶卷 raw 表 + 9 印相表 + 1 共享直扫表
# ≈5.4MB;真正对外约束是下方 ZIP 10 MiB 门禁,此处留余量防无声膨胀。
assert mobile_asset_bytes < 7_000_000, f'Mobile LUT budget exceeded: {mobile_asset_bytes}'
print(f'All packaged LUT PNG assets: {lut_asset_bytes:,} bytes (mobile raw + shared print/scan tables; native tables validated but source-only)')
# The packaged registry drops native-only LUT references (asset/rawAsset);
# the mobile runtime resolves mobileAsset/mobileRawAsset from presets-mobile.js.
# It also drops film subfields only the (unpackaged) native full-size pipeline
# reads — layers/grain/langmuir/density bounds —
# keeping exactly what the mobile core, optics field and engine consume:
# channels, positive, logExposure, curves, bwCorrection, halation,
# cameraFilmFormatMm — plus the pointwise DIR coupler set (2026-09-21 移动
# 端补完逐点 DIR 矩阵): correctedCurves, matrix, donorK/donorRef,
# receiverK/receiverRef, densityMax, dir(active 判定;diffusion 参数随包但
# 空间 DIR 不移植,见 dir-field 实验). Source styles/presets.js keeps the
# full definitions.
MOBILE_FILM_FIELDS = {'channels', 'positive', 'logExposureLin', 'curves', 'bwCorrection', 'halation', 'cameraFilmFormatMm', 'correctedCurves', 'matrix', 'donorK', 'donorRef', 'receiverK', 'receiverRef', 'densityMax', 'densityMin', 'dir'}
for id, style in presets.items():
    style.pop('asset', None)
    style.pop('rawAsset', None)
    style.pop('stockMono', None)  # no runtime reader in the packaged tool
    film = style['film']
    # logExposure 端点重建(2026-09-22 包体积治理):全部 20 款的曝光轴实测为
    # 完美等差数列,包内只存 [lo,hi,n] 三数,engine.expandLogAxis 首次加载时
    # 无损展开(浮点回读偏差 < 1e-9,插值用途无可感知差异)。
    axis = film.get('logExposure')
    assert isinstance(axis, list) and len(axis) >= 2, (id, 'logExposure axis missing')
    lo, hi, n = axis[0], axis[-1], len(axis)
    step = (hi - lo) / (n - 1)
    assert all(abs(v - (lo + step * i)) < 1e-9 for i, v in enumerate(axis)), (id, 'logExposure axis is not arithmetic')
    film.pop('logExposure')
    film['logExposureLin'] = [lo, hi, n]
    style['film'] = {k: v for k, v in film.items() if k in MOBILE_FILM_FIELDS}
files['styles/presets.js'] = 'window.FILMIFY_STYLES='+json.dumps(presets,ensure_ascii=False,separators=(',',':'))+';\n'
# Every './styles/...' reference inside the packaged JS registries must resolve
# to a packaged file; the HTML whitelist below only covers index.html.
for registry, fields in ((presets, ('asset', 'rawAsset', 'meterAsset')), (mobile_presets, ('mobileAsset', 'mobileRawAsset')), (prints_reg, ('asset',)), (scans_reg, ('asset',))):
    for id, entry in registry.items():
        for field in fields:
            ref = entry.get(field)
            if isinstance(ref, str):
                assert ref.startswith('./styles/'), (id, field, 'Unexpected asset path')
                assert ref[2:] in files, (id, field, ref, 'Asset not packaged')
# styles/manifest.json 的 encoding/runtime 增广段随 2026-09-22 不打包决定一并
# 撤除(原本只写给包内副本看);溯源信息以源文件 styles/manifest.json 为准。


class CheckHTML(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        assert tag not in {'base', 'iframe', 'object', 'video', 'audio', 'form'}
        assert not any(k.startswith('on') for k in attrs)
        assert 'download' not in attrs and attrs.get('target') != '_blank'
        assert attrs.get('http-equiv', '').lower() != 'content-security-policy'
        if tag == 'script' and 'src' in attrs:
            assert attrs.get('src', '').startswith('./') and attrs.get('type') != 'module'
        for key in ('src', 'href'):
            if key in attrs and not attrs[key].startswith('data:'):
                assert attrs[key].startswith('./'), attrs[key]
                assert attrs[key][2:] in files, attrs[key]


allowed_suffixes={'.html','.css','.js','.png','.jpg','.jpeg','.gif','.webp','.svg','.woff','.woff2','.ttf','.json'}
assert all(Path(name).suffix.lower() in allowed_suffixes for name in files), 'Unsupported file type in minitool package'
CheckHTML().feed(page)
for name, content in files.items():
    if name.endswith('.js') and name != 'styles/presets.js':
        for pattern in [r'\bfetch\s*\(', r'XMLHttpRequest', r'\bnew\s+(?:Worker|SharedWorker|WebSocket|EventSource|RTCPeerConnection|Function)\s*\(', r'\beval\s*\(', r'WebAssembly', r'window\.(?:open|prompt)\s*\(', r'\.download\s*=', r'navigator\.(?:clipboard|geolocation|serviceWorker)', r'VideoEncoder', r'FILMIFY_SAMPLES']:
            assert not re.search(pattern, content), (name, pattern)
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content,bytes):
        if name.endswith('.png'): content = recompress_png(content)
        path.write_bytes(content)
    else: path.write_text(content)
    if name.endswith('.js'):
        subprocess.run([shutil.which('node') or 'node', '--check', str(path)], check=True)
        subprocess.run([shutil.which('node') or 'node', '--expose-internals', '-e', "require('internal/deps/acorn/acorn/dist/acorn').parse(require('fs').readFileSync(process.argv[1],'utf8'),{ecmaVersion:2017,sourceType:'script'})", str(path)], check=True)

for name in previous_assets-set(files):
    stale=OUT/name
    if stale.exists():stale.unlink()

# Retired files are removed only from this builder-owned generated directory.
for name in ['preview.js','cpu-renderer.js','styles/SPEKTRAFILM_CODE_LICENSE.txt','filmify.js','spatial-gpu.js',
             'assets/proc-load.png','assets/proc-enlarge.png','assets/proc-develop.png','assets/proc-dry.png',
             'assets/placeholder.png','assets/placeholder-color.png',
             'assets/logo-mark-t.png',
             'assets/caption-400.ttf','assets/caption-600.ttf',
             'styles/manifest.json',
             'collage-lab.html']:
    retired = OUT / name
    if retired.exists(): retired.unlink()
retired_silver = OUT / 'styles/silver.png'
if 'silver' not in presets and retired_silver.exists(): retired_silver.unlink()
# styles/*.png 全是本 builder 写入的 LUT;注册表考古漏网的一律清除
# (2026-09-22 教训:旧注册表被上一次失败的构建先行改写后,previous_assets 扫不到
#  退役的逐组合 mobile.png,最终 assert 假失败)。
if (OUT/'styles').exists():
    for stale_png in (OUT/'styles').glob('*.png'):
        if 'styles/'+stale_png.name not in files: stale_png.unlink()
# The output directory is owned by this builder; refuse unexpected artifacts.
assert {p.relative_to(OUT).as_posix() for p in OUT.rglob('*') if p.is_file()} == set(files)
auditor = ROOT / 'scripts/audit-artifact.py'
subprocess.run([sys.executable,str(auditor),str(OUT)],check=True)
archive = ROOT / 'dist/filmify-xhs-tool.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in files:
        z.write(OUT / name, name)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None and set(z.namelist()) == set(files)
assert archive.stat().st_size < 10 * 1024 * 1024
print(f'Checked {len(files)} files; ZIP {archive.stat().st_size:,} bytes\n{archive}')
print('NOT A RUNTIME PASS: latest XHS performance, memory and device compatibility need device validation; see docs/public-runtime-status.md')

subprocess.run([sys.executable,str(auditor),str(archive)],check=True)

# Smoke gate: load the PACKAGED tool (not the source tree) in a real browser
# and render once, so asset-path and missing-script regressions fail the build.
smoke = subprocess.run([shutil.which('node') or 'node', str(ROOT / 'scripts/dist-smoke-check.cjs')]).returncode
if smoke == 77:
    print('WARNING: dist smoke skipped (Playwright unavailable); packaged runtime NOT verified')
elif smoke != 0:
    raise SystemExit('dist smoke check failed')
