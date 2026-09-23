#!/usr/bin/env python3
"""Stamp mobile LUT integrity hashes into styles/presets-mobile.js.

For each mobile LUT PNG, decode exactly like runtime decodeAsset (paired RGB8
pixels -> uint16 -> /65535 -> float32) and FNV-1a-32 over the little-endian
float32 byte stream. The hash is re-encode-proof: it covers decoded pixel
values, not PNG file bytes, so a platform that losslessly re-compresses the
PNG still verifies. Run after any rebake of styles/luts/*-mobile*.png;
build-minitool.py refuses to package entries without hashes.
"""
import json
import re
import numpy as np
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PRESETS = ROOT / 'styles/presets-mobile.js'


def fnv1a32(data: bytes) -> int:
    h = 0x811C9DC5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def lut_values(path: Path) -> bytes:
    """Mirror engine.js decodeAsset: canvas RGBA bytes -> float32 values."""
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.uint32)
    n2 = im.shape[0] * im.shape[1] // 2  # entries
    pairs = im.reshape(n2, 2, 3)
    values = (pairs[:, 0, :] + pairs[:, 1, :] * 256).astype(np.float64) / 65535.0
    return values.astype('<f4').tobytes()


def main():
    text = PRESETS.read_text()
    body = text.split('window.FILMIFY_MOBILE=', 1)[1].strip().rstrip(';')
    presets = json.loads(body)
    for sid, entry in sorted(presets.items()):
        for field, hash_field in (('mobileAsset', 'mobileHash'), ('mobileRawAsset', 'mobileRawHash')):
            if field not in entry:
                continue  # 共享印相表路径(2026-09-22):逐组合 mobile.png 退役,只剩 raw 表
            name = Path(entry[field]).name
            digest = fnv1a32(lut_values(ROOT / 'styles/luts' / name))
            entry[hash_field] = digest
            print(f'{sid:12s} {name:32s} {hash_field}={digest}')
    out = 'window.FILMIFY_MOBILE=' + json.dumps(presets, ensure_ascii=False, separators=(',', ':')) + ';\n'
    PRESETS.write_text(out)
    print('updated', PRESETS)


if __name__ == '__main__':
    main()
