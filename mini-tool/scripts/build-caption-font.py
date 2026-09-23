#!/usr/bin/env python3
"""Build offline caption subsets from the upstream Libre Baskerville variable TTF.

Optional authoring dependency: fonttools. Pass the original TTF path; no network
or original font is needed by the app/build. Preserve its OFL alongside outputs.
"""
import argparse
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('font', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
for weight, style in [(400, 'Regular'), (600, 'SemiBold')]:
    font = instantiateVariableFont(TTFont(args.font), {'wght': weight}, inplace=False)
    options = subset.Options()
    options.name_IDs = ['*']
    options.name_legacy = True
    options.name_languages = ['*']
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=list(range(0x20, 0x100)) + [0x2013, 0x2014, 0x2019, 0x2022])
    sub.subset(font)
    # OFL reserved name: modified subsets use their own internal family name.
    names = {1: 'Filmify Caption', 2: style, 3: 'FilmifyCaption-' + style,
             4: 'Filmify Caption ' + style, 6: 'FilmifyCaption-' + style,
             16: 'Filmify Caption', 17: style}
    for record in font['name'].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    font.flavor = 'woff'
    output = root / 'minitool' / 'assets' / f'caption-{weight}.woff'
    font.save(output)
    print(output.name, output.stat().st_size)
