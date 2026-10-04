#!/usr/bin/env python3
"""Compare original native and PodJS GPU captures without resizing either input."""
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

root = Path(__file__).resolve().parents[2]
out = root / 'artifacts'
native = json.loads((out / 'onboarding-native-proof.json').read_text())
actual = json.loads((out / 'onboarding-ui-proof.json').read_text())
assert native['captured'] == actual['captured']
comparisons = []
for stage in native['captured']:
    paths = [out / f'onboarding-native-{stage}.png', out / f'onboarding-{stage}.png']
    reference, candidate = [Image.open(path).convert('RGB') for path in paths]
    assert reference.size == candidate.size == (466, 466)
    diff = ImageChops.difference(reference, candidate)
    changed = sum(any(pixel) for pixel in diff.get_flattened_data())
    comparisons.append({
        'stage': stage,
        'referenceSha256': hashlib.sha256(paths[0].read_bytes()).hexdigest(),
        'actualSha256': hashlib.sha256(paths[1].read_bytes()).hexdigest(),
        'changedPixelFraction': changed / (466 * 466),
        'meanAbsoluteErrorRGB': ImageStat.Stat(diff).mean,
        'pixelIdentical': changed == 0,
        'animationPhaseMatched': stage != 'network-checking',
    })
result = {'sameSize': True, 'rescaled': False, 'comparisons': comparisons,
          'nativePixelEqualityVerified': all(row['pixelIdentical'] for row in comparisons),
          'physicalInputAcceptance': False, 'fullMigrationVerified': False}
(out / 'onboarding-native-comparison.json').write_text(json.dumps(result, indent=2) + '\n')
for row in comparisons:
    print(row['stage'], f"changed={row['changedPixelFraction']:.4%}",
          f"MAE={sum(row['meanAbsoluteErrorRGB']) / 3:.3f}")
