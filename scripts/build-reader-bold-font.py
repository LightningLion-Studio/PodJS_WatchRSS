#!/usr/bin/env python3
"""Build the OWW242 default-reader bold profile from captured system fonts.

adb pull /system/fonts/OPlusSans3.ttf /tmp/watchrss-OPlusSans3.ttf
adb pull /system/fonts/Roboto-Bold.ttf /tmp/watchrss-Roboto-Bold.ttf
uv run --with fonttools python scripts/build-reader-bold-font.py \
  --cjk /tmp/watchrss-OPlusSans3.ttf --latin /tmp/watchrss-Roboto-Bold.ttf

Roboto takes precedence for its mapped characters; the OWW242 fonts.xml maps
Chinese weight 700 to OPlusSans3 wght=750. This profile is device-specific.
"""
from pathlib import Path
import argparse, hashlib, json, tempfile
from fontTools import __version__ as fonttools_version
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.merge import Merger
from fontTools.subset import Options, Subsetter
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--cjk',type=Path,required=True);parser.add_argument('--latin',type=Path,required=True)
args=parser.parse_args()
primary=TTFont(args.latin)
fallback=instantiateVariableFont(TTFont(args.cjk),{'wght':750},inplace=False,updateFontNames=True)
primary_chars=set(primary.getBestCmap())
fallback_chars=set(fallback.getBestCmap())-primary_chars
compat_source=root/'assets/fonts/watch_sans.ttf'
compat=instantiateVariableFont(TTFont(compat_source),{'wght':700},inplace=False,updateFontNames=True)
compat_chars=set(compat.getBestCmap())-primary_chars-fallback_chars
options=Options();options.hinting=False;options.recalc_timestamp=False
for font,chars in [(primary,primary_chars),(fallback,fallback_chars),(compat,compat_chars)]:
    subset=Subsetter(options=options);subset.populate(unicodes=chars);subset.subset(font)
    font.recalcTimestamp=False
    scale_upem(font,1000)
with tempfile.TemporaryDirectory() as folder:
    sources=[]
    for i,font in enumerate([primary,fallback,compat]):
        path=Path(folder)/f'{i}.ttf';font.save(path);sources.append(str(path))
    merger=Merger();merger.options.drop_tables=['BASE','GDEF','GPOS','GSUB','JSTF','MATH','STAT','DSIG','vhea','vmtx','VORG']
    combined=merger.merge(sources)
    combined.recalcTimestamp=False
    combined['head'].created=primary['head'].created;combined['head'].modified=primary['head'].modified
    destination=root/'assets/fonts/reader_default_bold.ttf';combined.save(destination)
    charset=set((root/'assets/fonts/charset.txt').read_text())
    missing=sorted(charset-set(map(chr,combined.getBestCmap())))
    originally_supported=set(map(chr,TTFont(compat_source).getBestCmap()))
    assert not (set(missing)&originally_supported), 'font migration lost supported characters'
receipt={'profile':'OWW242 Android 11 default reader bold','fontToolsVersion':fonttools_version,
         'sources':{'Roboto-Bold.ttf':hashlib.sha256(args.latin.read_bytes()).hexdigest(),'OPlusSans3.ttf':hashlib.sha256(args.cjk.read_bytes()).hexdigest(),'compatibility-watch_sans.ttf':hashlib.sha256(compat_source.read_bytes()).hexdigest()},
         'cjkAxis':{'wght':750},'latinWeight':700,'otherCharacters':'retain existing WatchRSS font coverage with weight 700','outputSha256':hashlib.sha256(destination.read_bytes()).hexdigest(),
         'missingCharsetCodepoints':[f'U+{ord(c):04X}' for c in missing if not c.isspace()],
         'scope':'reader title roles; other screens retain their existing regular face; not a universal Android font profile'}
(root/'assets/fonts/reader-default-bold-provenance.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(receipt,ensure_ascii=False,indent=2))
