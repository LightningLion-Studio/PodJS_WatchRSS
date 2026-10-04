#!/usr/bin/env python3
"""Compare two unmodified, equally-sized renderer captures; never rescale inputs.
Run with: uv run --with pillow python scripts/compare-ui.py reference.png actual.png
Pixel differences are diagnostic, not a substitute for gesture/accessibility review.
"""
import argparse
import json
from PIL import Image, ImageChops, ImageStat

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('reference')
parser.add_argument('actual')
args = parser.parse_args()
reference = Image.open(args.reference).convert('RGB')
actual = Image.open(args.actual).convert('RGB')
if reference.size != actual.size:
    parser.error(f'capture sizes differ: {reference.size} != {actual.size}; capture at the same device density')
difference = ImageChops.difference(reference, actual)
count = reference.width * reference.height
changed = sum(1 for pixel in difference.getdata() if any(pixel))
stats = ImageStat.Stat(difference)
print(json.dumps({
    'reference': args.reference, 'actual': args.actual,
    'width': reference.width, 'height': reference.height,
    'changedPixels': changed, 'changedPixelFraction': changed / count,
    'meanAbsoluteErrorRGB': stats.mean,
    'differenceBounds': difference.getbbox(),
    'pixelIdentical': changed == 0,
    'interactionAcceptance': 'not assessed',
}, ensure_ascii=False, indent=2))
