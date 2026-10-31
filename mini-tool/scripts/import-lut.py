#!/usr/bin/env python3
"""Import a self-supplied local 512x512 RGB8 LUT; never downloads any assets."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from numeric_lut_png import decode_rgb8

ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input', type=Path)
    ap.add_argument('--id', required=True, help='user- followed by lowercase letters, numbers or dashes')
    ap.add_argument('--name', required=True)
    ap.add_argument('--black-and-white', action='store_true')
    ap.add_argument('--replace', action='store_true')
    args = ap.parse_args()
    if not re.fullmatch(r'user-[a-z0-9][a-z0-9-]{0,47}', args.id):
        ap.error('Invalid local id; use e.g. user-my-look')
    if not args.name.strip() or len(args.name) > 80:
        ap.error('Name must contain 1..80 characters')
    if args.input.is_symlink() or not args.input.is_file() or args.input.stat().st_size > 2*1024*1024:
        ap.error('Expected a regular PNG file no larger than 2 MiB')
    data = args.input.read_bytes()
    w, h, pixels = decode_rgb8(data)
    if (w, h) != (512, 512):
        ap.error('Expected 512x512 RGB8 PNG, 64^3 cube / 8x8 blue slices')
    if args.black_and_white and any(pixels[i] != pixels[i+1] or pixels[i] != pixels[i+2]
                                    for i in range(0, len(pixels), 3)):
        ap.error('Black-and-white table must have equal RGB channels')
    local = ROOT/'local-luts'
    if local.is_symlink() or local.exists() and not local.is_dir():
        ap.error('local-luts must be a regular directory')
    local.mkdir(exist_ok=True)
    catalog = local/'catalog.json'
    if catalog.is_symlink():
        ap.error('Refusing a symlinked catalog')
    rows = json.loads(catalog.read_text()) if catalog.exists() else []
    if not isinstance(rows, list) or len(rows) > 32:
        ap.error('Invalid local catalog')
    target = local/(args.id+'.png')
    if target.is_symlink() or (target.exists() or any(row['id'] == args.id for row in rows)) and not args.replace:
        ap.error('Id already exists or target is a symlink; use --replace for regular files')
    row = {'id': args.id, 'name': args.name, 'sha256': hashlib.sha256(data).hexdigest(),
           'blackAndWhite': args.black_and_white}
    rows = [old for old in rows if old['id'] != args.id]+[row]
    if len(rows) > 32:
        ap.error('At most 32 local LUTs are supported')
    target.write_bytes(data)
    catalog.write_text(json.dumps(rows, ensure_ascii=False, indent=2)+'\n')
    print('Imported '+args.id+' locally. Build with: npm run build:local')
    print('Default npm run build excludes all local LUTs. Check your rights before distributing local builds.')


if __name__ == '__main__':
    main()
