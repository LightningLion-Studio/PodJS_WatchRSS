#!/usr/bin/env python3
"""Compare unchanged native/PodJS device captures and decode their actual QR pixels."""
import hashlib
import io
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageOps, ImageStat

root = Path(__file__).resolve().parents[2]
out = root / "artifacts"
names = ["native-beian-reference.png", "startup-legal-beian-before.png", "startup-legal-beian-after.png"]
images = [Image.open(out / name).convert("RGB") for name in names]
assert all(image.size == (466, 466) for image in images)


def region(image, box):
    crop = image.crop(box)
    bounds = crop.getbbox()
    return {"contentBounds": None if bounds is None else [bounds[0] + box[0], bounds[1] + box[1], bounds[2] + box[0], bounds[3] + box[1]]}


def decoded(image):
    # The source uses white modules on black. Inversion only prepares the
    # decoder input; comparison always uses the unmodified captured pixels.
    data = io.BytesIO()
    ImageOps.invert(image.crop((85, 155, 380, 445))).save(data, format="PNG")
    result = subprocess.run(["zbarimg", "--quiet", "--raw", "-"], input=data.getvalue(), capture_output=True, check=True)
    return result.stdout.decode().strip()


reference, before, after = images
difference = ImageChops.difference(reference, before)


def pixel_difference(box=None):
    crop = difference if box is None else difference.crop(box)
    pixels = list(crop.get_flattened_data())
    return {
        "changedPixels": sum(any(pixel) for pixel in pixels),
        "maxChannelDelta": max(max(pixel) for pixel in pixels),
        "meanAbsoluteErrorRGB": ImageStat.Stat(crop).mean,
    }


result = {
    "sameSize": True, "rescaled": False, "captureSize": [466, 466],
    "entryAnimationSettled": True, "animationParityVerified": False,
    "nativeApi": 30, "nativeBlurAppliesOnThisDevice": False,
    "captures": [{"file": name, "sha256": hashlib.sha256((out / name).read_bytes()).hexdigest(),
                  "title": region(image, (0, 0, 466, 111)),
                  "subtitle": region(image, (0, 111, 466, 155)),
                  "qr": region(image, (0, 160, 466, 440)),
                  "decodedQrUrl": decoded(image)} for name, image in zip(names, images)],
    "meanAbsoluteErrorRGB": ImageStat.Stat(difference).mean,
    "changedPixelFraction": sum(any(pixel) for pixel in difference.get_flattened_data()) / (466 * 466),
    "nativePixelEqualityVerified": difference.getbbox() is None,
    "pixelDifference": pixel_difference(),
    "regionDifferences": {
        "title": pixel_difference((0, 0, 466, 111)),
        "subtitle": pixel_difference((0, 111, 466, 155)),
        "qr": pixel_difference((0, 160, 466, 440)),
    },
    "podRecreationPixelsEqual": ImageChops.difference(before, after).getbbox() is None,
    "physicalInputAcceptance": False, "fullMigrationVerified": False,
}
assert all(capture["decodedQrUrl"] == "https://beian.miit.gov.cn/" for capture in result["captures"])
(out / "beian-native-static-comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
