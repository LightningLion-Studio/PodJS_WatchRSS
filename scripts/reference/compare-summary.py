#!/usr/bin/env python3
"""Compare untouched native DetailContent and PodJS inline-summary captures."""
from pathlib import Path
from PIL import Image,ImageChops,ImageStat
import base64,json
root=Path(__file__).resolve().parents[2]/'artifacts'
pairs=[('idle','未展开','reference-reader-short.png','podjs-summary-idle.png'),('error','错误后展开','reference-summary-error.png','podjs-summary-no-account.png'),('done','总结完成','reference-summary-done.png','podjs-summary-done.png')]
metrics={};panels=[]
for key,label,native,pod in pairs:
    paths=[root/native,root/pod];images=[Image.open(p).convert('RGB') for p in paths]
    assert all(im.size==(466,466) for im in images)
    diff=ImageChops.difference(*images)
    metrics[key]={'native':native,'podjs':pod,'meanAbsoluteErrorRGB':ImageStat.Stat(diff).mean,'changedPixels':sum(any(p) for p in diff.get_flattened_data()),'pixelIdentical':diff.getbbox() is None}
    data=['data:image/png;base64,'+base64.b64encode(p.read_bytes()).decode() for p in paths]
    panels.append(f'<h2>{label}</h2><div class="pair"><figure><figcaption>原生 Android</figcaption><img src="{data[0]}"></figure><figure><figcaption>PodJS</figcaption><img src="{data[1]}"></figure></div>')
result={'capturePolicy':'unmodified 466x466 PNGs; no alignment, resizing or masking','scope':'production native DetailContent with fixed summary state; PodJS loopback HTTP integration','realPaidBackendVerified':False,'regions':metrics}
(root/'summary-native-comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
html='<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AI 总结原生对照</title><style>body{background:#16191c;color:#eceff1;font:16px system-ui;max-width:1050px;margin:32px auto;padding:0 20px}p{line-height:1.6;color:#c4cbd1}.pair{display:flex;flex-wrap:wrap;gap:24px}figure{margin:0}img{width:466px;height:466px}figcaption{margin:10px 0}pre{background:#22282d;overflow:auto;padding:16px}</style><h1>阅读页 AI 总结 · 原始截图对照</h1><p>原生使用生产 DetailContent 与固定状态；PodJS 使用真机本地 HTTP 服务验证授权刷新、重试与成功结果。图片保留原始像素，没有对齐、缩放或遮罩。字体和位置仍有差异；这些证据不代表真实付费后台或手机账号同步已验收。</p>'+''.join(panels)+'<pre>'+json.dumps(result,ensure_ascii=False,indent=2)+'</pre></html>'
(root/'summary-comparison.html').write_text(html)
print(json.dumps(result,ensure_ascii=False,indent=2))
