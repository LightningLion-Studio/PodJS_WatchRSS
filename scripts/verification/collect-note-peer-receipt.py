#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,re,subprocess,tarfile,tempfile,sqlite3,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts'
def read(n):return json.loads((out/n).read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
log=(out/'note-peer-phone.log').read_text();assert 'OK (1 test)' in log
phone=json.loads(re.search(r'notePeerProof=(\{[^\n]+\})',log)[1]);guest=read('note-peer-guest-kv.json')['note-peer-result'];assert guest['state']=='passed'
for field in ['watchId','pngSha256','pngBytes','pngChunks','actions','persistentSession']:assert phone[field]==guest[field]
assert guest['actions']==guest['appliedAcks']==10 and guest['pngBytes']==917035 and guest['pngChunks']==2
for flag in ['pngDecoded','durableTombstone','ownedDataRemoved','articleCountUnchanged','persistentSession']:assert guest[flag]
assert guest['visualAcceptance'] is False
assert (out/'note-peer-typecheck.log').read_text().strip()=='$ tsc --noEmit'
for f in ['note-peer-phone-build.log','note-peer-guest-gradle.log']:assert 'BUILD SUCCESSFUL' in (out/f).read_text()
artifacts={}
for kind in ['main','guest','phone']:
 data=read(f'note-peer-{kind}-installed.json');assert sha((out/data['artifact']).read_bytes())==data['sha256'];artifacts[kind]=data
 if kind!='phone':
  p=subprocess.check_output(['adb','-s',data['serial'],'shell','pm','path',data['package']],text=True).strip().removeprefix('package:');assert subprocess.check_output(['adb','-s',data['serial'],'shell','sha256sum',p],text=True).split()[0]==data['sha256']
  with zipfile.ZipFile(out/data['artifact']) as z:data['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
assert artifacts['main']['nativeLibraries']==artifacts['guest']['nativeLibraries']
assert read('note-peer-phone-before.json')['wasAbsent'];cleanup=read('note-peer-phone-cleanup.json');assert cleanup['uninstalled'] and cleanup['verifiedAbsent']
a=read('note-peer-main-before.json');b=read('note-peer-main-after.json');assert a['tables']==b['tables'];assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
with tarfile.open(out/'note-peer-main-before.tar') as t,tempfile.TemporaryDirectory() as tmp:
 for m in t.getmembers():
  if m.isfile() and m.name.startswith('databases/'):Path(tmp,Path(m.name).name).write_bytes(t.extractfile(m).read())
 identity=sqlite3.connect(str(Path(tmp)/'podjs.sqlite')).execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0];assert identity!=guest['watchId']
resumed=[l.strip() for l in subprocess.check_output(['adb','-s','e3aca8af','shell','dumpsys','activity','activities'],text=True).splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
sources=['tests/android-note-peer/WatchRssNotePeerTest.java','tests/runtime-note-peer/main.tsx','src/sync/application-actions.ts','src/sync/note-assets.ts','src/sync/note-actions.ts','src/sync/session.ts','src/sync/rfcomm.ts','src/notes/repository.ts']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'phone':phone,'watch':guest,'phoneCleanup':cleanup,'mainIdentityDistinctFromTestReceiver':True,'preservation':{'tables':len(a['tables']),'files':len(a['files']),'allTableDigestsEqual':True,'allNonDatabaseFilesEqual':True},'resumed':resumed,'typecheck':'passed','sourceHashes':{p:sha((root/p).read_bytes()) for p in sources},'limits':['Physical paired-phone Android protocol fixture, not normal companion UI/production client.','Main executable was unchanged; isolated receiver exercised same production session/action/file services.','Single run latency is not a general throughput benchmark.','Full article exchange, IP upgrade, remaining actions and visual/gesture acceptance are pending.']}
(out/'note-peer-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'phone':phone,'watch':guest,'preservation':r['preservation'],'cleanup':cleanup},indent=2))
