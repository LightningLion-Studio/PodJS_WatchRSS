#!/usr/bin/env python3
"""Compare unchanged native/PodJS device frames; no alignment, crop, mask or resizing in metrics."""
from pathlib import Path
import base64
import hashlib
import html
import json
from PIL import Image, ImageChops, ImageStat

root = Path(__file__).resolve().parents[2] / "artifacts"
rows = []
sections = []
labels = {"title": "标题范围 2–5", "body": "正文范围 150–156 · 自动居中"}

def data(path):
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()

for name, label in labels.items():
    native_path, pod_path = root / f"reference-highlight-{name}.png", root / f"podjs-metrics-highlight-{name}.png"
    native, pod = Image.open(native_path), Image.open(pod_path)
    assert native.size == pod.size == (466, 466)
    assert native.convert("RGBA").getchannel("A").getextrema() == (255, 255)
    assert pod.convert("RGBA").getchannel("A").getextrema() == (255, 255)
    row = {"stage": name, "native": native_path.name, "podjs": pod_path.name, "width": 466, "height": 466, "nativeSha256": hashlib.sha256(native_path.read_bytes()).hexdigest(), "podjsSha256": hashlib.sha256(pod_path.read_bytes()).hexdigest()}
    if name != "error":
        diff = ImageChops.difference(native.convert("RGB"), pod.convert("RGB"))
        row.update(rgbMeanAbsoluteError=sum(ImageStat.Stat(diff).mean) / 3, changedPixels=sum(pixel != (0, 0, 0) for pixel in diff.get_flattened_data()), pixelIdentical=diff.getbbox() is None)
        note = f'全图 RGB MAE {row["rgbMeanAbsoluteError"]:.3f}/255；变化像素 {row["changedPixels"]:,}/217,156。未裁切、遮罩或平移。'
    else:
        row["metricExcludedReason"] = "Native error fixture uses 1x; PodJS correctly retains the previous session's 1.15x. Text and state differ."
        note = "原生错误样例为 1x，PodJS 保留此前的 1.15x；状态不相同，此组只展示画面，不计算像素一致指标。"
    rows.append(row)
    native_uri, pod_uri = data(native_path), data(pod_path)
    sections.append(f'''<section><h2>{label}</h2><p>{html.escape(note)}</p><div class="pair"><figure><figcaption>原生生产 Compose · 脚本状态</figcaption><img src="{native_uri}" alt="原生 {label}"></figure><figure><figcaption>PodJS 生产页面 · 脚本语音适配器</figcaption><img src="{pod_uri}" alt="PodJS {label}"></figure></div><details><summary>滑动叠加比较</summary><div class="overlay" style="--split:50%"><img src="{native_uri}" alt="原生底图"><img class="over" src="{pod_uri}" alt="PodJS 叠加图"></div><input type="range" min="0" max="100" value="50" aria-label="原生与 PodJS 分界" oninput="this.previousElementSibling.style.setProperty('--split',this.value+'%')"></details></section>''')

report = {"captureScope": "e3aca8af; isolated native reference APK and PodJS target; production UI with scripted playback states/adapter", "realAudioVerified": False, "metricPolicy": "Full 466x466 RGB frames; no crop, mask, registration or resampling", "comparisons": rows}
(root / "metrics-native-comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
summary = "标题选中相同源文字；正文输入范围 150–156 对应原文 UTF-16 范围 142–147。两端由生产页面自行居中，未通过截图平移掩盖排版或滚动差异。"
page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WatchRSS 行框、基线与朗读高亮对照</title><style>body{font-family:system-ui,sans-serif;background:#101113;color:#ededee;margin:0 auto;padding:32px 20px;max-width:1020px;line-height:1.65}h1{font-size:28px}h2{font-size:21px}p{color:#c8c9ce}.scope{border-left:3px solid #ff6026;padding:8px 18px;background:#191b20}section{padding:14px 0 30px;border-bottom:1px solid #393a40}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}figure{margin:0}figcaption{font-size:13px;color:#b7b9c0;padding:8px 0}img{display:block;width:100%;max-width:466px;height:auto;background:#000}details{margin-top:16px}summary{cursor:pointer;color:#ff956e}.overlay{position:relative;width:466px;max-width:100%;margin-top:12px}.over{position:absolute;left:0;top:0;clip-path:inset(0 0 0 var(--split))}input{width:466px;max-width:100%;accent-color:#ff6026}a{color:#ffad8f}code{background:#23252b;padding:2px 5px}.foot{font-size:13px}@media(max-width:620px){.pair{grid-template-columns:1fr}body{padding:18px 12px}}</style><h1>WatchRSS 行框、基线与朗读高亮对照</h1><div class="scope"><p>这些图片验证生产页面在指定状态下的显示。原生使用脚本状态；PodJS 使用不合成音频的测试语音适配器，实际走页面、控制器及宿主分发。它们不证明真实声音或物理输入已经验收。</p><p>READINESS</p><p>原图均为同一手表的 466×466 帧。仍有字形、缩放与坐标精度差异，行框匹配不代表逐像素一致。</p></div>SECTIONS<p class="foot"><a href="metrics-native-comparison.json">比较数据与图片 SHA-256</a> · <a href="metrics-highlight-scripted.json">脚本语音记录</a> · <a href="metrics-apk-receipt.json">构建与安装记录</a></p></html>'''
(root / "metrics-highlight-comparison.html").write_text(page.replace("READINESS", summary).replace("SECTIONS", "\n".join(sections)))
print(json.dumps(report, ensure_ascii=False, indent=2))
