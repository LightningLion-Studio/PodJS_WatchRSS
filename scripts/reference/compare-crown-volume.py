#!/usr/bin/env python3
"""Compare complete, unmodified 466x466 native and PodJS volume frames."""
from pathlib import Path
import hashlib
import json
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[2]
art = root / 'artifacts'
paths = {name:art / filename for name,filename in {
    'native':'native-speech-volume.png','podjs':'podjs-speech-volume.png','first':'podjs-speech-volume-first.png'
}.items()}
arrays = {name:np.asarray(Image.open(path).convert('RGB'),dtype=np.int16) for name,path in paths.items()}
assert all(value.shape==(466,466,3) for value in arrays.values())
def metrics(a,b):
    delta=np.abs(a-b)
    return {'mae':float(delta.mean()),'rmse':float(np.sqrt((delta.astype(float)**2).mean())),
            'changedPixels':int(np.any(delta!=0,axis=2).sum()),'maxChannelDifference':int(delta.max()),'pixelIdentical':bool((delta==0).all())}
report={'scope':'Full 466x466 RGB frames, no crop, rescale, alignment, exclusion or masking',
        'presentation':'Native production PlayerVolumeOverlay fixed at 21 percent using presentation-only state; PodJS production UI driven by instrumented raw Android events and isolated stream indices.',
        'sha256':{name:hashlib.sha256(path.read_bytes()).hexdigest() for name,path in paths.items()},
        'current':metrics(arrays['native'],arrays['podjs']),'beforeLayoutCorrection':metrics(arrays['native'],arrays['first']),
        'limitations':['This establishes scripted frame comparison, not actual physical crown or audible volume acceptance.','Residual text rasterization and existing playback-control differences remain; this is not pixel identity.']}
(art/'crown-volume-native-comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
html='''<!doctype html><html lang="zh"><meta charset="utf-8"><title>朗读音量浮层对照</title>
<style>body{font:16px system-ui;background:#121416;color:#eee;max-width:1120px;margin:35px auto;padding:0 20px}p{line-height:1.7;color:#bdc4cc}.grid{display:flex;gap:24px;flex-wrap:wrap}figure{margin:0}img{width:466px;max-width:100%;border-radius:50%;background:black}figcaption{margin:10px 0}#mix{position:relative;width:466px;height:466px}#mix img{position:absolute;inset:0}.slider{display:block;margin:15px 0}a{color:#ffaa78}strong{color:#fff}</style>
<h1>朗读音量浮层 · 21%</h1><p>两张原始 466 × 466 真机帧，未裁剪、缩放、对齐或屏蔽差异。原生使用生产浮层的固定展示状态；PodJS 使用生产输入与音量通路，写入对象为隔离测试适配器。</p>
<div class="grid"><figure><img src="native-speech-volume.png"><figcaption>原生 Android</figcaption></figure><figure><img src="podjs-speech-volume.png"><figcaption>PodJS · 最新安装包</figcaption></figure></div>
<p>全帧 RGB 平均绝对差：<strong>MAE_VALUE</strong>（0–255）；布局修正前：FIRST_VALUE。仍非像素一致，字形边缘和部分既有播控元素保留差异。</p>
<label class="slider">叠加检查：原生 ← <input type="range" min="0" max="100" value="50" oninput="document.getElementById('over').style.opacity=this.value/100"> → PodJS</label>
<div id="mix"><img src="native-speech-volume.png"><img id="over" src="podjs-speech-volume.png" style="opacity:.5"></div>
<p><a href="crown-volume-native-comparison.json">完整指标与图像哈希</a> · <a href="crown-volume-apk-receipt.json">构建、安装与测试证据</a><br>此次没有调节真实系统音量，也未验证实体旋钮手感或可听音频。</p></html>'''
html=html.replace('MAE_VALUE',f"{report['current']['mae']:.4f}").replace('FIRST_VALUE',f"{report['beforeLayoutCorrection']['mae']:.4f}")
(art/'crown-volume-comparison.html').write_text(html)
print(json.dumps(report,ensure_ascii=False,indent=2))
