#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts'
def read(n):return json.loads((out/n).read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
a=read('note-assets-main-before.json');b=read('note-assets-main-after.json');assert a['tables']==b['tables'];assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
g=read('note-assets-guest-kv.json')['note-assets-result'];assert g['state']=='passed' and g['nativeScenarios']==8 and g['nativeSteps']==22
for k in ['realHostFiles','chunk512KiB','hashValidation','preservedOldTarget','ownedFilesRemoved']:assert g[k]
native=json.loads((root/'tests/fixtures/note-assets-native.json').read_text());assert sha((root.parent/native['source']).read_bytes())==native['sourceSha256']
assert '405 pass' in (out/'note-assets-all-unit.log').read_text() and '0 fail' in (out/'note-assets-all-unit.log').read_text();assert (out/'note-assets-typecheck.log').read_text().strip()=='$ tsc --noEmit'
artifacts={}
for kind,pkg in [('main','com.lightningstudio.watchrss.podjs'),('guest','dev.podjs.tests.syncstate')]:
 data=read(f'note-assets-{kind}-installed.json');apk=out/f'note-assets-{kind}.apk';assert sha(apk.read_bytes())==data['sha256'];assert 'BUILD SUCCESSFUL' in (out/f'note-assets-{kind}-gradle.log').read_text()
 path=subprocess.check_output(['adb','-s','e3aca8af','shell','pm','path',pkg],text=True).strip().removeprefix('package:');assert subprocess.check_output(['adb','-s','e3aca8af','shell','sha256sum',path],text=True).split()[0]==data['sha256']
 with zipfile.ZipFile(apk) as z:data['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
 artifacts[kind]=data
assert artifacts['main']['nativeLibraries']==artifacts['guest']['nativeLibraries']
resumed=[l.strip() for l in subprocess.check_output(['adb','-s','e3aca8af','shell','dumpsys','activity','activities'],text=True).splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
sources=['src/sync/note-assets.ts','src/sync/application-actions.ts','src/sync/application-host.ts','src/sync/article-batches.ts','tests/fixtures/note-assets-native.json','tests/sync/note-assets.test.ts','tests/runtime-note-assets/main.tsx']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'tests':{'app':405,'typecheck':'passed','nativeAssetSteps':22},'nativeOracle':{'sourceSha256':native['sourceSha256'],'runtime':native['runtime']},'guest':g,'preservation':{'tables':len(a['tables']),'files':len(a['files']),'allTableDigestsEqual':True,'allNonDatabaseFilesEqual':True},'resumed':resumed,'sourceHashes':{p:sha((root/p).read_bytes()) for p in sources},'limits':['Actual host file transfer and native file states, not a paired-phone Bluetooth asset transfer.','Rich note image rendering and visual parity remain pending.','System charging warning previously obscured UI; no new visual acceptance claimed.']}
(out/'note-assets-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'tests':r['tests'],'guest':g,'preservation':r['preservation']},indent=2))
