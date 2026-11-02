#!/usr/bin/env python3
"""Create an isolated build config from the complete production resource config."""
from pathlib import Path
import json,sys
app=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[3]
c=json.loads((app/'pod.config.json').read_text())
c.update(entry='src/dystock-fixture.tsx',appId='com.lightningstudio.watchrss.podjs',versionCode=1201,name='DYSTOCK loopback verification')
for key in ('signing','takeover','workManagerTakeover'):c['android'].pop(key,None)
(app/'pod.dystock-fixture.config.json').write_text(json.dumps(c,ensure_ascii=False,indent=2)+'\n')
print('fixture build config ready')
