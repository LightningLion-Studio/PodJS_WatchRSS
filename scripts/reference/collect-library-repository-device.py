#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,argparse
p=Path(__file__).resolve().parents[2]
a=argparse.ArgumentParser();a.add_argument('--serial',required=True);args=a.parse_args()
out=p/'artifacts/reference-library-repository-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-library-repository.json',str(out)],check=True)
r=json.loads(out.read_text());assert r['input']==json.loads((p/'tests/reference/assets/library-repository-input.json').read_text())
for k in ['sources','deletions']:assert [c['input'] for c in r[k]]==r['input'][k]
root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
r['sourcesSha256']={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ['data/rss/DefaultRssRepository.kt','data/rss/ArticleSyncBody.kt','phoneconnection/bluetooth/LibrarySyncPayload.kt']}
r['scope']='Actual native repository in isolated in-memory Room databases on Android; captures source merge/export and chunked article deletion state and manifests. No phone transport or user app database.'
(p/'tests/fixtures/library-repository-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n')
print('Collected',len(r['sources']),'sources and',len(r['deletions']),'deletions')
