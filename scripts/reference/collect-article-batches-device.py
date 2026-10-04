#!/usr/bin/env python3
"""Collect a completed isolated native parser capture; does not run the test."""
from pathlib import Path
import argparse,json,hashlib,subprocess
p=Path(__file__).resolve().parents[2];parser=argparse.ArgumentParser();parser.add_argument('--serial',required=True);args=parser.parse_args()
path=p/'artifacts/reference-article-batches-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-article-batches.json',str(path)],check=True)
r=json.loads(path.read_text());source=json.loads((p/'tests/reference/assets/article-batches-input.json').read_text())
assert [(x['name'],x['frames']) for x in r['articles']]==[(x['name'],x['frames']) for x in source['articles']]
assert [(x['frame'],x['index'],x['count']) for x in r['batches']]==[(x['frame'],x['index'],x['count']) for x in source['batches']]
assert [x['input'] for x in r['base64']]==source['base64']
root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
names=['phoneconnection/bluetooth/LibrarySyncPayload.kt','phoneconnection/bluetooth/BluetoothSyncProtocol.kt','data/rss/ArticleSyncBody.kt','data/rss/SyncedSavedArticle.kt']
r['sources']={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in names};r['scope']='Actual Android production LibrarySyncPayload and ArticleSyncBody parsing, captured by isolated reference instrumentation.'
(p/'tests/fixtures/article-batches-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n');print('Collected native parser/batch/Base64:',len(r['articles']),len(r['batches']),len(r['base64']))
