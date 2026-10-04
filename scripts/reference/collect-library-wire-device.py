#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,argparse
p=Path(__file__).resolve().parents[2];parser=argparse.ArgumentParser();parser.add_argument('--serial',required=True);args=parser.parse_args();out=p/'artifacts/reference-library-wire-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-library-wire.json',str(out)],check=True)
r=json.loads(out.read_text());assert [c['input'] for c in r['cases']]==json.loads((p/'tests/reference/assets/library-wire-input.json').read_text())
root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss';names=['phoneconnection/bluetooth/LibrarySyncPayload.kt','data/rss/ArticleSyncBody.kt']
r['sources']={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in names};r['scope']='Actual native outgoing chunk response frames, progress byte estimates and Float JSON values. Large bodies generated deterministically from input length.'
(p/'tests/fixtures/library-wire-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n');print('Collected native outgoing cases:',len(r['cases']))
