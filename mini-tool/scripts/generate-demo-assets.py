#!/usr/bin/env python3
"""Generate original, analytic demo LUTs without any product/catalog inputs."""
import argparse
import hashlib
import json
import math
import re
import shutil
from pathlib import Path
from numeric_lut_png import decode_rgb8, encode_rgb8

ROOT = Path(__file__).resolve().parents[1]
SIZE = 64
DEMOS = [
    ('identity', '恒等演示', 'identity: (r,g,b)'),
    ('warm', '暖色演示', '(r+.08*r*(1-r), g, b-.08*b*(1-b))'),
    ('cool', '冷色演示', '(r-.08*r*(1-r), g, b+.08*b*(1-b))'),
    ('soft', '柔和演示', '.06 + .88*channel'),
    ('vivid', '对比演示', '1.15 saturation around encoded RGB luma; cubic contrast'),
    ('mono', '黑白演示', 'encoded RGB luma: .2126*r + .7152*g + .0722*b'),
]


def transform(kind, r, g, b):
    if kind == 'warm':
        return r + .08*r*(1-r), g, b - .08*b*(1-b)
    if kind == 'cool':
        return r - .08*r*(1-r), g, b + .08*b*(1-b)
    if kind == 'soft':
        return tuple(.06 + .88*x for x in (r, g, b))
    if kind == 'vivid':
        y = .2126*r + .7152*g + .0722*b
        values = [max(0, min(1, y + 1.15*(x-y))) for x in (r, g, b)]
        return tuple(x + .3*x*(1-x)*(2*x-1) for x in values)
    if kind == 'mono':
        y = .2126*r + .7152*g + .0722*b
        return y, y, y
    if kind != 'identity':
        raise ValueError('Unknown analytic demonstration')
    return r, g, b


def make_lut(kind):
    pixels = bytearray(512*512*3)
    for b in range(SIZE):
        for g in range(SIZE):
            for r in range(SIZE):
                p = (((b//8)*SIZE+g)*512+(b % 8)*SIZE+r)*3
                rgb = transform(kind, r/63, g/63, b/63)
                pixels[p:p+3] = bytes(math.floor(max(0, min(1, x))*255+.5) for x in rgb)
    return encode_rgb8(512, 512, pixels, 2)


def entry(identifier, name, asset, data, mono=False, formula=None):
    return {'id': identifier, 'name': name, 'sourceName': name,
            'stockCategory': 'black-and-white' if mono else 'creative',
            'blackAndWhite': mono, 'lut': asset, 'sha256': hashlib.sha256(data).hexdigest(),
            'texture': {'grain': 1, 'soft': 0, 'halation': 0},
            'origin': 'original analytic demo' if formula else 'locally supplied data',
            **({'formula': formula} if formula else {})}


def generate(include_local=False):
    folder = ROOT/'minitool/assets/demo'
    folder.mkdir(parents=True, exist_ok=True)
    styles = []
    for kind, name, formula in DEMOS:
        data = make_lut(kind)
        (folder/(kind+'.png')).write_bytes(data)
        styles.append(entry('demo-'+kind, name, 'assets/demo/'+kind+'.png', data,
                            mono=kind == 'mono', formula=formula))
    if include_local:
        local = ROOT/'local-luts'
        catalog = json.loads((local/'catalog.json').read_text())
        if not isinstance(catalog, list) or len(catalog) > 32:
            raise ValueError('Expected at most 32 local LUT records')
        used = {s['id'] for s in styles}
        for row in catalog:
            identifier, name = row['id'], row['name']
            if not re.fullmatch(r'user-[a-z0-9][a-z0-9-]{0,47}', identifier) or identifier in used:
                raise ValueError('Invalid or duplicate local LUT id')
            if not isinstance(name, str) or not name.strip() or len(name) > 80:
                raise ValueError('Invalid local LUT display name')
            source = local/(identifier+'.png')
            if source.is_symlink() or source.resolve().parent != local.resolve():
                raise ValueError('Local LUT must be a regular local file')
            data = source.read_bytes()
            width, height, pixels = decode_rgb8(data)
            if (width, height) != (512, 512):
                raise ValueError('Expected 512x512 64-cube PNG')
            if row.get('blackAndWhite') and any(pixels[i] != pixels[i+1] or pixels[i] != pixels[i+2]
                                               for i in range(0, len(pixels), 3)):
                raise ValueError('Monochrome LUT channels must be equal')
            if hashlib.sha256(data).hexdigest() != row['sha256']:
                raise ValueError('Local LUT identity changed; import it again')
            target = ROOT/'minitool/assets/local'/(identifier+'.png')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            styles.append(entry(identifier, name, 'assets/local/'+identifier+'.png', data,
                                mono=bool(row.get('blackAndWhite'))))
            used.add(identifier)
    manifest = {'schema': 1, 'edition': 'open-source-demo', 'defaultId': 'demo-identity',
                'layout': '64^3; 8x8 blue tiles, red x / green y; encoded sRGB SDR',
                'generator': 'scripts/generate-demo-assets.py', 'styles': styles}
    (folder/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    registry = [{k: v for k, v in row.items() if k in
                 {'id', 'name', 'sourceName', 'stockCategory', 'blackAndWhite', 'lut', 'texture'}}
                for row in styles]
    for row in registry:
        row['lut'] = './'+row['lut']
    script = ("/* Original demo styles; generated from explicit mathematical functions. GPL-3.0-only. */\n"
              "(function(root){'use strict';\n const items="+json.dumps(registry, ensure_ascii=False)+";\n"
              " function get(id){return items.find(item=>item.id===id)||items[0];}\n"
              " function settings(id){const item=get(id);return Object.assign({style:item.id,tone:0,color:0},item.texture);}\n"
              " root.FilmifyStyles={defaultId:'demo-identity',items:items,get:get,settings:settings};\n"
              " if(typeof module==='object'&&module.exports)module.exports=root.FilmifyStyles;\n"
              "})(typeof window==='object'?window:global);\n")
    (ROOT/'minitool/style-config.js').write_text(script)
    return manifest


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--include-local', action='store_true', help='Explicitly include local-luts/catalog.json')
    args = ap.parse_args()
    result = generate(args.include_local)
    print('Generated '+str(len(result['styles']))+' analytic/local styles; no product LUT inputs')
