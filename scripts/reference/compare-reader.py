#!/usr/bin/env python3
"""Report raw native/PodJS reader differences and build a local comparison viewer."""
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import base64, json

root=Path(__file__).resolve().parents[2]/'artifacts'
paths=[root/'reference-reader-short.png',root/'podjs-reader-short.png']
images=[Image.open(p).convert('RGB') for p in paths]
assert all(im.size==(466,466) for im in images)
def stats(box):
    difference=ImageChops.difference(images[0].crop(box),images[1].crop(box))
    changed=sum(any(p) for p in difference.getdata())
    return {'changedPixels':changed,'changedFraction':changed/(difference.width*difference.height),'meanAbsoluteErrorRGB':ImageStat.Stat(difference).mean}
def bounds(im,box):
    x0,y0,x1,y1=box
    points=[(x,y) for y in range(y0,y1) for x in range(x0,x1) if im.getpixel((x,y))==(35,39,42)]
    return [min(x for x,y in points),min(y for x,y in points),max(x for x,y in points)+1,max(y for x,y in points)+1] if points else None
result={'referenceBuild':'isolated release; production DetailContent, default AI enabled',
        'capturePolicy':'unmodified 466x466 PNG; no rescaling, alignment or masking',
        'pixelIdentical':False,'knownMissing':'full read-aloud workflow, exact typography/position, AI settings and phone account sync',
        'regions':{label:stats(box) for label,box in [('full',(0,0,466,466)),('title',(98,40,368,110)),('actionsIncludingAI',(20,110,446,190)),('footer',(100,260,366,342))]},
        'originalActionBounds':{'native':bounds(images[0],(20,110,180,195)),'podjs':bounds(images[1],(20,110,180,195))}}
(root/'reader-native-comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
data=['data:image/png;base64,'+base64.b64encode(p.read_bytes()).decode() for p in paths]
html='''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>阅读页原生对照</title><style>body{background:#16191c;color:#eceff1;font:16px system-ui;margin:32px auto;max-width:1050px;padding:0 20px}h1{font-size:25px}p{line-height:1.6;color:#c4cbd1}.pair{display:flex;flex-wrap:wrap;gap:24px}figure{margin:0}img{width:466px;height:466px;max-width:none}figcaption{margin:10px 0}.overlay{position:relative;width:466px;height:466px}.overlay img{position:absolute;inset:0}.actual{clip-path:inset(0 50% 0 0)}input{width:466px;display:block;margin:16px 0}pre{overflow:auto;background:#22282d;padding:16px;font-size:13px}</style><h1>阅读页 · 原始截图对照</h1><p>同一短文章、字号14、收藏状态开启。原生参考包使用发布分支，保留默认 AI 入口。PodJS 已接入行内 AI 总结；完整朗读流程、精确字体与位置仍未完成，不能视为画面一致。</p><div class="pair"><figure><figcaption>原生 Android</figcaption><img src="NATIVE"></figure><figure><figcaption>PodJS</figcaption><img src="POD"></figure></div><h2>拖动比较</h2><p>分界线左侧为 PodJS，右侧为原生；均按 466×466 原始像素显示。</p><div class="overlay"><img src="NATIVE"><img class="actual" src="POD"></div><label>PodJS 显示范围<input aria-label="PodJS显示范围" type="range" min="0" max="100" value="50" oninput="document.querySelector('.actual').style.clipPath='inset(0 '+(100-this.value)+'% 0 0)'"></label><pre>METRICS</pre></html>'''
html=html.replace('NATIVE',data[0]).replace('POD',data[1]).replace('METRICS',json.dumps(result,ensure_ascii=False,indent=2))
(root/'reader-comparison.html').write_text(html)
print(json.dumps(result,ensure_ascii=False,indent=2))
