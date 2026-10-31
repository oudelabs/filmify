#!/usr/bin/env python3
"""Build the self-contained demo edition; never reads a production catalog."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from numeric_lut_png import decode_rgb8

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT/'minitool'
OUT = ROOT/'dist/xhs-tool'
ARCHIVE = ROOT/'dist/filmify-demo-tool.zip'


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {'base', 'iframe', 'object'} or any(k.startswith('on') for k in attrs):
            raise ValueError('Unsupported page markup')
        if tag == 'script' and (attrs.get('type') == 'module' or not attrs.get('src')):
            raise ValueError('Use external classic scripts')
        for key in ('src', 'href'):
            value = attrs.get(key)
            if value and not value.startswith('data:'):
                if not value.startswith('./') or '..' in Path(value).parts:
                    raise ValueError('Expected local resource: '+value)
                self.paths.append(value[2:])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--include-local', action='store_true')
    args = ap.parse_args()
    command = [sys.executable, str(ROOT/'scripts/generate-demo-assets.py')]
    if args.include_local:
        command.append('--include-local')
    subprocess.run(command, cwd=ROOT, check=True)
    package = json.loads((ROOT/'package.json').read_text())
    manifest = json.loads((SOURCE/'assets/demo/manifest.json').read_text())
    if manifest['edition'] != 'open-source-demo' or manifest['defaultId'] != 'demo-identity':
        raise ValueError('This builder accepts the demonstration edition only')
    page = (SOURCE/'index.html').read_text()
    page = page.replace('<meta name="filmify-version" content="development">',
                        '<meta name="filmify-version" content="'+escape(package['version'], quote=True)+'">', 1)
    page = page.replace('<meta name="filmify-repository" content="">',
                        '<meta name="filmify-repository" content="https://github.com/oudelabs/filmify">', 1)
    notice = (SOURCE/'assets/third-party-licenses.txt').read_text()
    if not all(value in notice for value in ['GPL-3.0-only', 'Apache', 'CC BY-SA 4.0']):
        raise ValueError('Missing code/material attribution')
    if page.count('<!-- FILMIFY_LICENSE -->') != 1:
        raise ValueError('Expected one license placeholder')
    page = page.replace('<!-- FILMIFY_LICENSE -->', escape(notice), 1)
    refs = References()
    refs.feed(page)
    resources = json.loads((SOURCE/'assets/runtime-resources.json').read_text())
    names = set(refs.paths+resources['assets']+['assets/demo/manifest.json', 'assets/runtime-resources.json'])
    for row in manifest['styles']:
        if not isinstance(row['lut'], str) or Path(row['lut']).is_absolute() or '..' in Path(row['lut']).parts:
            raise ValueError('Invalid LUT resource path')
        names.add(row['lut'])
        data = (SOURCE/row['lut']).read_bytes()
        w, h, _ = decode_rgb8(data)
        if (w, h) != (512, 512) or hashlib.sha256(data).hexdigest() != row['sha256']:
            raise ValueError('Invalid LUT identity: '+row['id'])
        if not args.include_local and not row['lut'].startswith('assets/demo/'):
            raise ValueError('Default demo build cannot contain a local LUT')
    files = {'index.html': page.encode()}
    for name in sorted(names):
        source = SOURCE/name
        if '..' in Path(name).parts or Path(name).is_absolute() or not source.is_file():
            raise ValueError('Missing/invalid resource: '+name)
        if source.is_symlink() or not source.resolve().is_relative_to(SOURCE.resolve()):
            raise ValueError('Resource must remain in the source tree')
        files[name] = source.read_bytes()
    node = shutil.which('node') or 'node'
    allowed = {'.html', '.css', '.js', '.png', '.jpg', '.json', '.woff', '.woff2', '.webp'}
    for name, data in files.items():
        if Path(name).suffix not in allowed:
            raise ValueError('Unsupported resource type: '+name)
        if name.endswith('.js'):
            text = data.decode()
            for pattern in [r'\bfetch\s*\(', r'XMLHttpRequest', r'\bnew\s+(?:Worker|SharedWorker|WebSocket|EventSource|Function)\s*\(',
                            r'\beval\s*\(', r'WebAssembly', r'window\.(?:open|prompt)\s*\(']:
                if re.search(pattern, text):
                    raise ValueError('Unsupported runtime API in '+name)
            subprocess.run([node, '--check', str(SOURCE/name)], check=True)
            subprocess.run([node, '--expose-internals', '-e',
                            "require('internal/deps/acorn/acorn/dist/acorn').parse(require('fs').readFileSync(process.argv[1],'utf8'),{ecmaVersion:2017,sourceType:'script'})",
                            str(SOURCE/name)], check=True)
    # The only writable build outputs are this edition's generated directory/archive.
    if (ROOT/'dist').is_symlink() or OUT.is_symlink() or ARCHIVE.is_symlink():
        raise ValueError('Refusing a symlinked build directory')
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for name, data in files.items():
        target = OUT/name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    with zipfile.ZipFile(ARCHIVE, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 31, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(ARCHIVE) as archive:
        if archive.testzip() or any(archive.read(name) != data for name, data in files.items()):
            raise ValueError('Archive identity check failed')
    if ARCHIVE.stat().st_size >= 10*1024*1024:
        raise ValueError('Demo package exceeds 10 MiB')
    print('Built analytic demo: '+str(len(files))+' files, '+str(ARCHIVE.stat().st_size)+' bytes')
    subprocess.run([node, str(ROOT/'scripts/dist-smoke-check.cjs')], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
