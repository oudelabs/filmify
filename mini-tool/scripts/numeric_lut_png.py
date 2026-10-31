"""Lossless packaging for RGB8 numeric LUT PNGs, using only the standard library.

Source assets remain byte-identical. The package uses reversible PNG scanline
filters; dimensions, channel order and every numeric node remain unchanged.
Color-profile chunks are rejected rather than silently discarded.
"""
import hashlib
import struct
import zlib

SIGNATURE = b'\x89PNG\r\n\x1a\n'


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def decode_rgb8(data):
    if data[:8] != SIGNATURE:
        raise ValueError('Invalid PNG signature')
    cursor, header, packed, ended, palette = 8, None, [], False, None
    tags = []
    while cursor < len(data):
        if cursor + 12 > len(data):
            raise ValueError('Truncated PNG chunk')
        size = struct.unpack_from('>I', data, cursor)[0]
        tag = data[cursor + 4:cursor + 8]
        end = cursor + size + 12
        if end > len(data):
            raise ValueError('Truncated PNG payload')
        body = data[cursor + 8:cursor + size + 8]
        crc = struct.unpack_from('>I', data, cursor + size + 8)[0]
        if zlib.crc32(tag + body) & 0xffffffff != crc:
            raise ValueError('Invalid PNG CRC')
        if tag not in {b'IHDR', b'PLTE', b'IDAT', b'IEND'}:
            raise ValueError('Numeric LUT packaging requires an untagged PNG: ' + repr(tag))
        tags.append(tag)
        if tag == b'IHDR':
            if header is not None or tags != [b'IHDR'] or size != 13:
                raise ValueError('Invalid IHDR')
            header = struct.unpack('>IIBBBBB', body)
        elif tag == b'IDAT':
            if header is None:
                raise ValueError('IDAT before IHDR')
            packed.append(body)
        elif tag == b'PLTE':
            if palette is not None or not body or len(body) > 768 or len(body) % 3 or packed:
                raise ValueError('Invalid RGB palette')
            palette = body
        elif tag == b'IEND':
            if size or end != len(data):
                raise ValueError('Invalid PNG end')
            ended = True
            break
        cursor = end
    if not ended or not packed or header is None:
        raise ValueError('Incomplete PNG')
    width, height, bits, kind, compression, filtering, interlace = header
    if width < 1 or height < 1 or width > 512 or height > 512 or bits != 8 or kind not in (2, 3) or (compression, filtering, interlace) != (0, 0, 0):
        raise ValueError('Expected bounded, noninterlaced RGB8 LUT PNG')
    if kind == 3 and palette is None:
        raise ValueError('Missing RGB palette')
    channels = 3 if kind == 2 else 1
    decoder = zlib.decompressobj()
    expected = (width * channels + 1) * height
    stream = decoder.decompress(b''.join(packed), expected + 1)
    if len(stream) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('Invalid PNG pixel stream')
    stride = width * channels
    pixels = bytearray(stride * height)
    for y in range(height):
        start = y * (stride + 1)
        mode, row = stream[start], stream[start + 1:start + stride + 1]
        target = y * stride
        if mode > 4:
            raise ValueError('Invalid PNG scanline filter')
        if mode == 0:
            pixels[target:target + stride] = row
            continue
        for x, value in enumerate(row):
            a = pixels[target + x - channels] if x >= channels else 0
            b = pixels[target + x - stride] if y else 0
            c = pixels[target + x - stride - channels] if y and x >= channels else 0
            prediction = a if mode == 1 else b if mode == 2 else (a + b) // 2 if mode == 3 else _paeth(a, b, c)
            pixels[target + x] = (value + prediction) & 255
    if kind == 3:
        rgb = bytearray(width * height * 3)
        for i, index in enumerate(pixels):
            if index * 3 + 3 > len(palette):
                raise ValueError('RGB palette index out of bounds')
            rgb[i * 3:i * 3 + 3] = palette[index * 3:index * 3 + 3]
        pixels = rgb
    return width, height, bytes(pixels)


def _chunk(tag, body):
    return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff)


def encode_rgb8(width, height, pixels, mode):
    stride = width * 3
    if len(pixels) != stride * height or mode not in (0, 1, 2, 4):
        raise ValueError('Invalid RGB8 encoding arguments')
    rows = []
    previous = bytes(stride)
    for y in range(height):
        row = pixels[y * stride:(y + 1) * stride]
        if mode == 0:
            filtered = row
        elif mode == 1:
            filtered = row[:3] + bytes((a - b) & 255 for a, b in zip(row[3:], row[:-3]))
        elif mode == 2:
            filtered = bytes((a - b) & 255 for a, b in zip(row, previous))
        else:
            filtered = bytes((value - _paeth(row[x - 3] if x >= 3 else 0, previous[x], previous[x - 3] if x >= 3 else 0)) & 255 for x, value in enumerate(row))
        rows.append(bytes([mode]) + filtered)
        previous = row
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return SIGNATURE + _chunk(b'IHDR', header) + _chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + _chunk(b'IEND', b'')


def pack_lut_png(data):
    width, height, pixels = decode_rgb8(data)
    if (width, height) != (512, 512):
        raise ValueError('Expected a 512x512, 64-cubed numeric LUT')
    candidates = [(None, data)] + [(mode, encode_rgb8(width, height, pixels, mode)) for mode in (1, 2, 4)]
    # An indexed PNG is exact only when the table already contains <=256 RGB
    # triples. No quantizer or nearest-color approximation is involved.
    colors = {}
    indices = bytearray(width * height)
    for i in range(width * height):
        color = pixels[i * 3:i * 3 + 3]
        if color not in colors:
            if len(colors) == 256:
                break
            colors[color] = len(colors)
        indices[i] = colors[color]
    else:
        colors = {color: i for i, color in enumerate(sorted(colors))}
        indices = bytearray(colors[pixels[i * 3:i * 3 + 3]] for i in range(width * height))
        for filter_mode in (0, 1, 2, 4):
            rows, previous = [], bytes(width)
            for y in range(height):
                row = indices[y * width:(y + 1) * width]
                filtered = row if filter_mode == 0 else row[:1] + bytes((a - b) & 255 for a, b in zip(row[1:], row[:-1])) if filter_mode == 1 else bytes((a - b) & 255 for a, b in zip(row, previous)) if filter_mode == 2 else bytes((value - _paeth(row[x - 1] if x else 0, previous[x], previous[x - 1] if x else 0)) & 255 for x, value in enumerate(row))
                rows.append(bytes([filter_mode]) + filtered)
                previous = row
            header = struct.pack('>IIBBBBB', width, height, 8, 3, 0, 0, 0)
            indexed = SIGNATURE + _chunk(b'IHDR', header) + _chunk(b'PLTE', b''.join(colors)) + _chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + _chunk(b'IEND', b'')
            candidates.append(('exact-palette-filter-' + str(filter_mode), indexed))
    mode, packed = min(candidates, key=lambda item: len(item[1]))
    if decode_rgb8(packed) != (width, height, pixels):
        raise ValueError('Lossless PNG packaging changed numeric nodes')
    sha = lambda value: hashlib.sha256(value).hexdigest()
    return packed, {
        'method': 'source' if mode is None else 'lossless-png-' + str(mode),
        'sourceSha256': sha(data), 'packedSha256': sha(packed),
        'decodedRgbSha256': sha(pixels), 'sourceBytes': len(data),
        'packedBytes': len(packed), 'numericNodesUnchanged': True,
    }
