#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,argparse
p=Path(__file__).resolve().parents[2];parser=argparse.ArgumentParser();parser.add_argument('--serial',required=True);args=parser.parse_args();out=p/'artifacts/reference-library-session-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-library-session.json',str(out)],check=True)
r=json.loads(out.read_text());assert [c['input'] for c in r['cases']]==json.loads((p/'tests/reference/assets/library-session-input.json').read_text())
root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
names=['phoneconnection/bluetooth/WatchBluetoothSyncServer.kt','phoneconnection/bluetooth/LibrarySyncPayload.kt','phoneconnection/bluetooth/BluetoothSyncProtocol.kt','data/rss/DefaultRssRepository.kt']
r['sources']={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in names}
r['scope']='Actual native WatchBluetoothSyncServer.serveStreams with in-memory Room repository injected only into the isolated reference application; no Bluetooth or IP radio connection. Native response frames and persisted peer state captured, including an outgoing saved article.'
(p/'tests/fixtures/library-session-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n');print('Collected native session cases:',len(r['cases']))
