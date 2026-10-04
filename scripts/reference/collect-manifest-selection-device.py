#!/usr/bin/env python3
"""Collect completed production manifest instrumentation; never runs or rebuilds it."""
from pathlib import Path
import argparse,json,hashlib,subprocess
p=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--serial',required=True);args=parser.parse_args()
path=p/'artifacts/reference-manifest-selection-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-manifest-selection.json',str(path)],check=True)
r=json.loads(path.read_text());inputs=json.loads((p/'tests/reference/assets/manifest-selection-input.json').read_text())
assert [{k:row[k] for k in ('name','local','remote','limit','support')} for row in r['cases']]==inputs
root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
names=['phoneconnection/bluetooth/LibrarySyncPayload.kt','data/rss/SyncedSavedArticle.kt']
r['sources']={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in names}
r['scope']='Actual Android production parseArticleManifest and buildBodyRequestsForRemoteArticles, isolated reference instrumentation. Local manifests are constructed from parsed fixture values, not exported from Room.'
(p/'tests/fixtures/manifest-selection-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n')
print('Captured native manifest cases:',len(r['cases']))
