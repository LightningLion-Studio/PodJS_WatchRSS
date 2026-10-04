#!/usr/bin/env python3
"""Rasterize native IntroHero's radial alpha gradient for the PodJS image baker.

The SVG baker does not support gradient fills. Pixel centers, a half-size
radius, and transparent outer pixels reproduce the native radial brush.
"""
from pathlib import Path
import math
from PIL import Image

size = 256
image = Image.new('RGBA', (size, size))
image.putdata([
    (255, 138, 61, round(255 * .22 * max(
        0, 1 - math.hypot(x + .5 - size / 2, y + .5 - size / 2) / (size / 2)
    )))
    for y in range(size) for x in range(size)
])
image.save(Path(__file__).resolve().parents[1] / 'assets/icons/onboarding-glow.png')
