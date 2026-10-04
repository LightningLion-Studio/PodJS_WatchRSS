#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,argparse
p=Path(__file__).resolve().parents[2];a=argparse.ArgumentParser();a.add_argument('--serial',required=True);args=a.parse_args();out=p/'artifacts/reference-library-replacement-device.json'
subprocess.run(['adb','-s',args.serial,'pull','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-library-replacement.json',str(out)],check=True)
r=json.loads(out.read_text());assert [c['input'] for c in r['cases']]==json.loads((p/'tests/reference/assets/library-replacement-input.json').read_text())
r['sources']={'data/rss/DefaultRssRepository.kt':hashlib.sha256((p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/rss/DefaultRssRepository.kt').read_bytes()).hexdigest()};r['scope']='Actual native finalizeAuthoritativeLibrarySnapshot with isolated in-memory Room rows; real native offline/cache services belong only to the reference app. Captures successful SQL outcomes, not physical media acceptance.'
(p/'tests/fixtures/library-replacement-android.json').write_text(json.dumps(r,ensure_ascii=True,indent=2)+'\n');print('Captured',len(r['cases']),'native replacements')
