#!/usr/bin/env python3
"""Compare unmodified native release and PodJS captures at equal dimensions.
Reports raster differences; does not infer interaction or whole-app completion.
"""
from pathlib import Path
import json
from PIL import Image, ImageChops, ImageStat

root = Path(__file__).resolve().parents[2] / 'artifacts'
pairs = [
    ('channel-settings', 'channel-settings'),
    ('local-channel-settings', 'local-channel-settings'),
    ('media-channel-settings', 'media-background-on'),
    ('delete-channel-confirm', 'channel-confirm'),
    ('clear-channel-confirm', 'local-clear-confirm'),
]

def bounds(image, color, box):
    x0,y0,x1,y1=box
    points=[(x,y) for y in range(y0,y1) for x in range(x0,x1) if image.getpixel((x,y))==color]
    if not points: return None
    return [min(x for x,y in points), min(y for x,y in points),max(x for x,y in points)+1,max(y for x,y in points)+1]

results=[]
for native,pod in pairs:
    native_path=root/f'reference-{native}.png'
    pod_path=root/f'podjs-rss-{pod}.png'
    reference=Image.open(native_path).convert('RGB')
    actual=Image.open(pod_path).convert('RGB')
    assert reference.size==actual.size==(466,466)
    difference=ImageChops.difference(reference,actual)
    changed=sum(any(pixel) for pixel in difference.getdata())
    regions = [('cancel',(35,39,42),(100,320,230,450)),('confirm',(229,77,77),(240,320,360,450))] if 'confirm' in native else [('originalRow',(42,42,42),(20,100,445,229)),('secondRow',(42,42,42),(20,265,445,390))]
    results.append({'native':str(native_path),'podjs':str(pod_path),'pixelIdentical':changed==0,
        'changedPixels':changed,'changedPixelFraction':changed/(466*466),'meanAbsoluteErrorRGB':ImageStat.Stat(difference).mean,
        'solidFillBounds':{name:{'native':bounds(reference,color,box),'podjs':bounds(actual,color,box)} for name,color,box in regions}})
print(json.dumps({'referenceBuild':'release, BuildConfig.DEBUG=false','captures':'unmodified 466x466 PNG; no rescaling or registration','cases':results},ensure_ascii=False,indent=2))
