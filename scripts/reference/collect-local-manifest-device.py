#!/usr/bin/env python3
"""Collect finished native in-memory Room export, retaining raw capture separately."""
from pathlib import Path
import json,hashlib,subprocess,argparse
p=Path(__file__).resolve().parents[2];parser=argparse.ArgumentParser();parser.add_argument('--serial',required=True);args=parser.parse_args()
f=p/'artifacts/reference-local-manifest-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-local-manifest.json',str(f)],check=True)
r=json.loads(f.read_text());assert r['input']==json.loads((p/'tests/reference/assets/local-manifest-input.json').read_text())
# Reflection captured Compose's static stability marker; it is not a field of
# the native sync wire schema. Preserve all actual instance fields unchanged.
for kind in ['first','second']:
 for m in r[kind]:m.pop('$stable',None)
for kind in ['articles','payloads']:
 for m in r[kind]:m['article'].pop('$stable',None)
root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
r['sources']={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ['data/rss/DefaultRssRepository.kt','data/rss/ArticleSyncBody.kt','data/rss/SyncedSavedArticle.kt','data/rss/ArticleContentStore.kt']}
r['scope']='Production DefaultRssRepository, in-memory Room DAOs and isolated file store on Android. Captures initial/repeated manifests and requested bodies; excludes static Compose $stable marker from comparison.'
(p/'tests/fixtures/local-manifest-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n')
print('Collected',len(r['first']),'native Room manifests,',len(r['urls']),'URI identities,',len(r['payloads']),'bodies')
