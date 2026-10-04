#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts'
def read(n):return json.loads((out/n).read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
a=read('notes-sync-main-before.json');b=read('notes-sync-main-after.json');assert a['tables']==b['tables'];assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
g=read('notes-sync-guest-kv.json')['note-sync-result'];assert g['state']=='passed'
for k in ['productionActionHandler','sqliteMerge','cleanOlderOverwrite','dirtyOlderRejected','equalTimestampTombstone','malformedBatchNoPartialWrite','tombstoneExport','ownedRowsRemoved','articleCountUnchanged']:assert g[k]
assert '401 pass' in (out/'notes-sync-all-unit.log').read_text() and '0 fail' in (out/'notes-sync-all-unit.log').read_text();assert (out/'notes-sync-typecheck.log').read_text().strip()=='$ tsc --noEmit'
artifacts={}
for kind in ['main','guest']:
 data=read(f'notes-sync-{kind}-installed.json');apk=out/f'notes-sync-{kind}.apk';assert sha(apk.read_bytes())==data['sha256'];assert 'BUILD SUCCESSFUL' in (out/f'notes-sync-{kind}-gradle.log').read_text()
 path=subprocess.check_output(['adb','-s','e3aca8af','shell','pm','path',data['package']],text=True).strip().removeprefix('package:');actual=subprocess.check_output(['adb','-s','e3aca8af','shell','sha256sum',path],text=True).split()[0];assert actual==data['sha256']
 with zipfile.ZipFile(apk) as z:data['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
 artifacts[kind]=data
assert artifacts['main']['nativeLibraries']==artifacts['guest']['nativeLibraries']
resumed=[s.strip() for s in subprocess.check_output(['adb','-s','e3aca8af','shell','dumpsys','activity','activities'],text=True).splitlines() if 'mResumedActivity' in s];assert any('com.lightningstudio.watchrss.podjs/' in s for s in resumed)
sources=['src/notes/repository.ts','src/sync/note-actions.ts','src/sync/application-actions.ts','src/sync/application-host.ts','src/services.ts','src/ui/screen.tsx','tests/sync/note-actions.test.ts','tests/runtime-note-sync/main.tsx']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'guest':g,'tests':{'app':401,'typecheck':'passed'},'preservation':{'tables':len(a['tables']),'files':len(a['files']),'tableDigestsEqual':True,'nonDatabaseFilesEqual':True},'resumed':resumed,'sourceHashes':{p:sha((root/p).read_bytes()) for p in sources},'limits':['Native Kotlin source inspected, no native oracle executed.','Guest is an isolated production-handler/SQLite test, not paired-phone note transfer.','Native HTML entity conversion, note assets, large frames, concurrent edit and live detail refresh remain pending.','Main deployment/startup verified; existing main data unchanged.']}
(out/'notes-sync-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'guest':g,'preservation':r['preservation'],'tests':r['tests']},indent=2))
