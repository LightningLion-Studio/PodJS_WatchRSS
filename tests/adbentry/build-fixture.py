#!/usr/bin/env python3
"""Build the real application with an offline transport; restore package imports even on failure."""
import json,subprocess,sys
from pathlib import Path
app=Path(__file__).resolve().parents[2]
package=app/'package.json';original=package.read_bytes()
try:
 value=json.loads(original);value['imports']['#douyin-transport-build']={'default':'./tests/adbentry/transport.ts'}
 package.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
 config=json.loads((app/'pod.config.json').read_text());config.update(entry='tests/adbentry/entry.tsx',appId='com.lightningstudio.watchrss.adbentry',versionCode=28,name='ADBENTRY offline fixture')
 for key in ('takeover','workManagerTakeover','debugExternal'):config['android'].pop(key,None)
 config['android']['signing']={'keystoreProperties':config['android']['signing']['keystoreProperties']}
 path=app/'.codex-tmp/adbentry-fixture.config.json';path.parent.mkdir(parents=True,exist_ok=True)
 # Paths in pod.config resolve relative to its parent, so put the generated config at the app root.
 path=app/'pod.adbentry.generated.config.json';path.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
 try:subprocess.run(['bun',sys.argv[1],'package','android-watch','--project='+str(path),'--release'],cwd=app,check=True)
 finally:path.unlink(missing_ok=True)
finally:package.write_bytes(original)
