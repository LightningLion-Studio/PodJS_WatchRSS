#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,argparse
p=Path(__file__).resolve().parents[2];parser=argparse.ArgumentParser();parser.add_argument('--serial',required=True);args=parser.parse_args();f=p/'artifacts/reference-alias-receive-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-alias-receive.json',str(f)],check=True)
r=json.loads(f.read_text());assert [c['input'] for c in r['cases']]==json.loads((p/'tests/reference/assets/alias-receive-input.json').read_text())
root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
r['sources']={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ['data/rss/DefaultRssRepository.kt','data/rss/ArticleSyncBody.kt','data/db/SavedEntryDao.kt','data/db/SavedSyncStateDao.kt']};r['scope']='Actual native mergeSyncedChunkedArticles into in-memory Room, including original RSS alias retention and per-type saved bindings. Native applied statistics are captured but not equivalent to the current article commit receipt.'
(p/'tests/fixtures/alias-receive-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n');print('Collected native alias cases:',len(r['cases']))
