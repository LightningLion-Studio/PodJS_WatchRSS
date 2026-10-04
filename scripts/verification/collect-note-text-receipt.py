#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts'
def read(n):return json.loads((out/n).read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
a=read('note-text-main-before.json');b=read('note-text-main-after.json');assert a['tables']==b['tables'];assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
g=read('note-text-guest-kv.json')['note-sync-result'];assert g['state']=='passed' and g['nativeTextCases']==73 and g['ownedRowsRemoved'];live=read('note-live-result.json');assert live['state']=='passed' and live['refreshEvents']==3 and live['ownedRowsRemoved'];visual=read('note-live-visual-status.json');assert visual['status']=='unverified'
assert '402 pass' in (out/'note-text-all-unit.log').read_text() and '0 fail' in (out/'note-text-all-unit.log').read_text();assert (out/'note-text-typecheck.log').read_text().strip()=='$ tsc --noEmit'
native=json.loads((root/'tests/fixtures/note-text-native.json').read_text());source=root.parent/native['source'];assert sha(source.read_bytes())==native['sourceSha256'];functions=source.read_text().split('fun watchPlainText(',1)[1];assert sha(('fun watchPlainText('+functions).encode())==native['functionsSha256']
artifacts={}
for kind,prefix in [('main','note-text-main'),('textGuest','note-text-guest'),('liveGuest','note-live')]:
 data=read(prefix+'-installed.json');apk=out/(prefix+'.apk');assert sha(apk.read_bytes())==data['sha256'];assert 'BUILD SUCCESSFUL' in (out/(prefix+'-gradle.log')).read_text()
 with zipfile.ZipFile(apk) as z:data['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
 artifacts[kind]=data
assert all(a['nativeLibraries']==artifacts['main']['nativeLibraries'] for a in artifacts.values())
for package,kind in [('com.lightningstudio.watchrss.podjs','main'),('dev.podjs.tests.syncstate','liveGuest')]:
 path=subprocess.check_output(['adb','-s','e3aca8af','shell','pm','path',package],text=True).strip().removeprefix('package:');assert subprocess.check_output(['adb','-s','e3aca8af','shell','sha256sum',path],text=True).split()[0]==artifacts[kind]['sha256']
resumed=[l.strip() for l in subprocess.check_output(['adb','-s','e3aca8af','shell','dumpsys','activity','activities'],text=True).splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
sources=['src/notes/text.ts','src/notes/repository.ts','src/ui/NotesScreen.tsx','src/ui/screen.tsx','tests/runtime-note-live/main.tsx','tests/runtime-note-sync/main.tsx','tests/fixtures/note-text-native.json','package.json','bun.lock']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'tests':{'app':402,'typecheck':'passed','nativeTextCases':73},'nativeOracle':{'sourceSha256':native['sourceSha256'],'functionsSha256':native['functionsSha256'],'runtime':native['runtime']},'guest':g,'liveGuest':live,'visual':visual,'preservation':{'tables':len(a['tables']),'files':len(a['files']),'allTableDigestsEqual':True,'allNonDatabaseFilesEqual':True},'resumed':resumed,'sourceHashes':{p:sha((root/p).read_bytes()) for p in sources},'limits':['Visual refresh unverified: continuous charging warning covered screenshots.','Paired-phone note exchange and note assets remain pending.','Existing stored plainText fields were not rewritten.','Oracle cases do not prove every possible input, concurrency policy or full application parity.']}
(out/'note-text-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'tests':r['tests'],'visual':visual,'preservation':r['preservation']},indent=2))
