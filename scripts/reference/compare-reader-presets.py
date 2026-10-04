#!/usr/bin/env python3
"""Compare original device captures; exclude the invalid native popup frame."""
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import base64, html, json
root=Path(__file__).resolve().parents[2]/'artifacts'
def uri(name): return 'data:image/png;base64,'+base64.b64encode((root/name).read_bytes()).decode()
def figure(name,label): return f'<figure><figcaption>{html.escape(label)}</figcaption><img width="466" height="466" src="{uri(name)}"></figure>'
sections=[]; metrics={}
for mode,label in [('dark','深色'),('light','浅色'),('system','自动')]:
 native=f'reference-reader-presets-{mode}.png';pod=f'podjs-reader-presets-{mode}.png'
 a,b=[Image.open(root/name).convert('RGB') for name in [native,pod]]
 assert a.size==b.size==(466,466)
 diff=ImageChops.difference(a,b)
 metrics[mode]={'native':native,'podjs':pod,'meanAbsoluteErrorRGB':ImageStat.Stat(diff).mean,'changedPixels':sum(any(p) for p in diff.get_flattened_data()),'pixelIdentical':diff.getbbox() is None}
 sections.append(f'<h2>{label}</h2><div class="pair">'+figure(native,'原生 Android')+figure(pod,'PodJS')+'</div>')
sections.append('<h2>自动时间控件</h2><p>两张原图滚动位置及选定时间不同，仅展示控件布局，不计算像素一致率。</p><div class="pair">'+figure('reference-reader-presets-system-controls.png','原生 Android')+figure('podjs-reader-presets-schedule.png','PodJS：时间已改为 08:15')+'</div>')
sections.append('<h2>PodJS 功能状态</h2><p>原生菜单独立窗口全透明，已标为无效截图；这里只展示 PodJS 实际菜单，不以透明图作对照。阅读页使用本轮专用文章，尚无对应原生同内容画面。</p><div class="pair">'+''.join(figure(f'podjs-reader-presets-{stage}.png',label) for stage,label in [('menu','预设菜单'),('download','手机端下载提示'),('light-article','浅色阅读'),('auto-article','按手表本地时间选择浅色')])+'</div>')
result={'policy':'Unmodified full 466x466 originals; no offset optimization, crop, resize or masking. Only matching top views receive pixel metrics. Automatic controls have different scroll offsets and times. Native popup has zero visible pixels and is excluded.','nativePopup':json.loads((root/'reference-reader-presets-menu-window.json').read_text()),'realLocationAccepted':False,'phoneResourceSyncAccepted':False,'scheduledBoundaryObserved':False,'localClockSelectionVerified':True,'regions':metrics}
(root/'reader-presets-native-comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
(root/'reader-presets-comparison.html').write_text('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>阅读器预设 · 原生对照</title><style>body{max-width:1060px;margin:32px auto;padding:0 20px;background:#16191c;color:#eceff1;font:16px system-ui}p{line-height:1.7;color:#c4cbd1}.pair{display:flex;gap:24px;flex-wrap:wrap}figure{margin:0}figcaption{margin:12px 0}img{max-width:100%;height:auto}h2{margin-top:36px}pre{overflow:auto}</style><h1>阅读器预设 · 原生对照</h1><p>生产原生 Activity 在隔离参考包中运行；PodJS 来自 OWW242 实际页面。保留原图，不调整偏移、不缩放后计算差异、不遮罩。字体与位置仍有差异，未达到像素一致。真实定位、手机字体与图片/视频资源同步尚未验收。</p>'+''.join(sections)+'<details><summary>对照口径与数值</summary><pre>'+html.escape(json.dumps(result,ensure_ascii=False,indent=2))+'</pre></details></html>')
print(json.dumps(metrics,ensure_ascii=False,indent=2))
