#!/usr/bin/env python3
"""Native production AI settings surfaces versus device captures, retaining original PNGs."""
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import base64, json, html
root = Path(__file__).resolve().parents[2] / 'artifacts'
window = json.loads((root/'reference-ai-dialog-window.json').read_text())
pairs = [
    ('preset', '提示词预设', 'reference-ai-preset.png', 'podjs-ai-preset.png'),
    ('usage', '调用与趋势', 'reference-ai-usage.png', 'podjs-ai-usage.png'),
    ('empty', '清空后的状态', 'reference-ai-usage-empty.png', 'podjs-ai-usage-empty.png'),
    ('dialog', '清空确认', 'reference-ai-dialog-window.png', 'podjs-ai-usage-confirm.png'),
]
metrics, sections = {}, []
def uri(name):
    return 'data:image/png;base64,' + base64.b64encode((root/name).read_bytes()).decode()
for key, label, native, pod in pairs:
    a, b = [Image.open(root/name).convert('RGB') for name in (native, pod)]
    assert b.size == (466, 466)
    rect = [0, 0, 466, 466]
    native_style = ''
    if key == 'dialog':
        assert a.size == (window['width'], window['height'])
        rect = [window['left'], window['top'], window['left']+window['width'], window['top']+window['height']]
        assert 0 <= rect[0] < rect[2] <= 466 and 0 <= rect[1] < rect[3] <= 466
        b = b.crop(rect)
        native_style = f"left:{window['left']}px;top:{window['top']}px"
    else:
        assert a.size == (466, 466)
    diff = ImageChops.difference(a, b)
    metrics[key] = {'native':native, 'podjs':pod, 'comparisonRect':rect, 'meanAbsoluteErrorRGB':ImageStat.Stat(diff).mean, 'changedPixels':sum(any(p) for p in diff.get_flattened_data()), 'pixelIdentical':diff.getbbox() is None}
    sections.append(f'<section><h2>{label}</h2><div class="pair"><figure><figcaption>原生 Android</figcaption><div class="watch"><img style="{native_style}" src="{uri(native)}"></div></figure><figure><figcaption>PodJS</figcaption><div class="watch"><img src="{uri(pod)}"></div></figure></div></section>')
result = {'capturePolicy':'Original PNGs are unchanged. Full 466x466 comparisons except the dialog: compare its original window pixels to the PodJS rectangle at the native WindowInspector screen origin. No offset search, resampling or masking.', 'nativeDialogWindow':window, 'scope':'Production native Compose screens with an in-memory Room fixture; PodJS SQLite history and actual settings navigation on OWW242.', 'normalizationDifference':'PodJS also counts actual WatchRSS camelCase usage fields, which the native repository ignores. Raw history is retained.', 'realPaidBackendVerified':False, 'phoneAccountSyncVerified':False, 'regions':metrics}
(root/'ai-settings-native-comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
extras = ''.join(f'<figure><figcaption>{label}</figcaption><div class="watch"><img src="{uri(name)}"></div></figure>' for name,label in [('podjs-ai-usage-bars.png','输入与输出'),('podjs-ai-usage-providers.png','供应商与记录')])
page = '''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AI 设置与用量 · 原生对照</title><style>body{margin:32px auto;padding:0 20px;max-width:1060px;background:#16191c;color:#eceff1;font:16px system-ui}p{line-height:1.65;color:#c4cbd1}.pair{display:flex;gap:24px;flex-wrap:wrap}figure{margin:0}figcaption{margin:10px 0}.watch{position:relative;width:466px;height:466px;background:black;overflow:hidden}.watch img{position:absolute;left:0;top:0}section{margin-top:32px}pre{padding:16px;overflow:auto;background:#22282d}h1{font-size:28px}a{color:#ffa877}</style><h1>AI 设置与用量 · 原生对照</h1><p>原生使用生产 Compose 页面与隔离内存数据库；PodJS 使用真机 SQLite 记录和实际导航。截图仍有字体与像素位置差异，不能称为完全一致。图表使用受控数据，不代表真实付费后台或手机账号同步已验收。</p><p>清空弹窗来自原生的独立窗口，保留原始 466×364 PNG；这里只按系统报告的屏幕位置展示。对比时仅截取 PodJS 对应窗口区域，不搜索最佳对齐、不缩放或遮罩。PodJS 额外兼容真实接口的 camelCase 用量字段，修正原生漏计，历史原文不改写。</p>'''+''.join(sections)+'<section><h2>PodJS 滚动后的图表</h2><div class="pair">'+extras+'</div></section><details><summary>像素差异与对照口径</summary><pre>'+html.escape(json.dumps(result,ensure_ascii=False,indent=2))+'</pre></details></html>'
(root/'ai-settings-comparison.html').write_text(page)
print(json.dumps(result,ensure_ascii=False,indent=2))
