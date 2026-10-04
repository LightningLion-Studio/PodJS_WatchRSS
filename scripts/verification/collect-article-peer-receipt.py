#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,re,subprocess,tarfile,tempfile,sqlite3,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts'
def read(n):return json.loads((out/n).read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
log=(out/'article-peer-phone.log').read_text();assert 'OK (1 test)' in log
phone=json.loads(re.search(r'articlePeerProof=(\{[^\n]+\})',log)[1]);guest=read('article-peer-guest-kv.json')['article-peer-result'];assert guest['state']=='passed'
for field in ['watchId','contentSha256','savedFlags']:assert phone[field]==guest[field]
assert phone['incomingBodyBytes']==phone['returnedBodyBytes']==180598
assert phone['incomingChunks']==phone['returnedChunks']==2 and phone['responseFrames']==2
assert phone['exactTextRoundtrip'] and guest['ownedArticleExported'] and guest['ownedDataRemoved']
assert guest['cursorBeforeApplied']==0 and guest['cursorAfterApplied']==11
assert guest['visualAcceptance'] is False
assert (out/'article-peer-typecheck.log').read_text().strip()=='$ tsc --noEmit'
assert 'BUILD SUCCESSFUL' in (out/'article-peer-gradle.log').read_text()
artifacts={}
for kind in ['main','guest','phone']:
 data=read(f'article-peer-{kind}-installed.json');assert sha((out/data['artifact']).read_bytes())==data['sha256'];artifacts[kind]=data
 if kind!='phone':
  p=subprocess.check_output(['adb','-s',data['serial'],'shell','pm','path',data['package']],text=True).strip().removeprefix('package:');assert subprocess.check_output(['adb','-s',data['serial'],'shell','sha256sum',p],text=True).split()[0]==data['sha256']
  with zipfile.ZipFile(out/data['artifact']) as z:data['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
assert artifacts['main']['nativeLibraries']==artifacts['guest']['nativeLibraries']
assert read('article-peer-phone-before.json')['wasAbsent'];cleanup=read('article-peer-phone-cleanup.json');assert cleanup['uninstalled'] and cleanup['verifiedAbsent']
a=read('article-peer-main-before.json');b=read('article-peer-main-after.json');assert a['tables']==b['tables'];assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
with tarfile.open(out/'article-peer-main-before.tar') as t,tempfile.TemporaryDirectory() as tmp:
 for m in t.getmembers():
  if m.isfile() and m.name.startswith('databases/'):Path(tmp,Path(m.name).name).write_bytes(t.extractfile(m).read())
 identity=sqlite3.connect(str(Path(tmp)/'podjs.sqlite')).execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0];assert identity!=guest['watchId']
bodyCleanup=read('article-peer-file-cleanup.json');assert bodyCleanup['onlyNewHashedBodyFiles'] and len(bodyCleanup['removedFiles'])==3
for path in bodyCleanup['removedFiles']:
 probe=subprocess.run(['adb','-s','e3aca8af','shell','run-as','dev.podjs.tests.syncstate','test','-e',path]);assert probe.returncode==1
resumed=[l.strip() for l in subprocess.check_output(['adb','-s','e3aca8af','shell','dumpsys','activity','activities'],text=True).splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
sources=['tests/android-article-peer/WatchRssArticlePeerTest.java','tests/runtime-article-peer/main.tsx','src/sync/library-repository.ts','src/sync/article-receiver.ts','src/sync/local-manifest.ts','src/sync/session.ts','src/sync/rfcomm.ts']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'phone':phone,'watch':guest,'phoneCleanup':cleanup,'bodyFileCleanup':bodyCleanup,'mainIdentityDistinctFromTestReceiver':True,'preservation':{'tables':len(a['tables']),'files':len(a['files']),'allTableDigestsEqual':True,'allNonDatabaseFilesEqual':True},'resumed':resumed,'typecheck':'passed','sourceHashes':{p:sha((root/p).read_bytes()) for p in sources},'limits':['Physical paired-phone Android protocol fixture, not normal companion UI/production client.','Main executable was unchanged; isolated receiver exercised same production session/action/file services.','The cursor probe runs before the applied ACK; it does not independently timestamp receipt of the received-only ACK.','Normal companion client, IP upgrade, remaining actions and visual/gesture acceptance are pending.']}
(out/'article-peer-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'phone':phone,'watch':guest,'preservation':r['preservation'],'cleanup':cleanup},indent=2))
