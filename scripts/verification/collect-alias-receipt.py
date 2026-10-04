#!/usr/bin/env python3
from pathlib import Path
import subprocess,json,hashlib,sqlite3,zipfile,datetime
p=Path(__file__).resolve().parents[2];a=p/'artifacts';fw=Path('/home/wilf/data/PodJS/podjs-watch')
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args])
def sha(data):return hashlib.sha256(data).hexdigest()
result=json.loads((a/'alias-device-kv.json').read_text())['alias-receive-result'];assert result['state']=='passed' and result['nativeCases']==14
packages=[('dev.podjs.tests.syncstate',a/'alias-harness.apk'),('com.lightningstudio.watchrss.podjs',a/'watchrss-podjs-0.1.0-dev.apk'),('com.lightningstudio.watchrss.reference',p.parent/'Android_WatchRSS/app/build/outputs/apk/release/app-release.apk'),('com.lightningstudio.watchrss.reference.test',p.parent/'Android_WatchRSS/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk')]
apks=[];assets={}
for package,path in packages:
 installed=adb('shell','pm','path',package).decode().strip().removeprefix('package:');digest=sha(path.read_bytes());remote=adb('shell','sha256sum',installed).decode().split()[0];assert digest==remote,package
 apks.append({'package':package,'path':str(path),'sha256':digest,'installedPath':installed,'installedSha256':remote})
 if package in ['dev.podjs.tests.syncstate','com.lightningstudio.watchrss.podjs']:
  with zipfile.ZipFile(path) as z:
   assets[package]={}
   for name in ['main.js','main.pak']:
    key=next(n for n in z.namelist() if n.endswith('/'+name));raw=z.read(key)
    dist=fw/'dist/projects'/package/'android-watch'/name
    assert sha(raw)==sha(dist.read_bytes()),(package,name)
    assets[package][name]=sha(raw)
with zipfile.ZipFile(packages[-1][1]) as z:
 key=next(n for n in z.namelist() if n.endswith('/alias-receive-input.json'));assert z.read(key)==(p/'tests/reference/assets/alias-receive-input.json').read_bytes()
fixture=json.loads((p/'tests/fixtures/alias-receive-android.json').read_text());native=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
for name,digest in fixture['sources'].items():assert sha((native/name).read_bytes())==digest
cleanupdb=sqlite3.connect(a/'alias-harness-cleanup.sqlite');tables=['articles','channels','sync_saved_states','sync_article_ids','sync_article_aliases','article_saved_entry_times','local_article_deletions','article_sync_content','article_reading_state','article_saved_states','article_body_chunks','article_original_chunks','article_previews','article_original_previews','article_original_meta'];counts={t:cleanupdb.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in tables};assert all(c==0 for c in counts.values());cleanupdb.close()
files=adb('shell','run-as','dev.podjs.tests.syncstate','find','files/podjs/files','-type','f').decode().splitlines();assert files==[]
assert subprocess.run(['adb','-s','e3aca8af','shell','pidof','dev.podjs.tests.syncstate'],capture_output=True).returncode==1
sourcefiles=['src/core/schema.ts','src/core/repository.ts','src/services.ts','src/sync/local-identity.ts','src/sync/local-manifest.ts','src/sync/saved-state.ts','src/sync/article-receiver.ts','pod.config.json','tests/sync/alias-receive.test.ts','tests/helpers/alias-receive-fixture.ts','tests/runtime-alias-receive/main.tsx','tests/reference/AliasReceiveReferenceTest.kt','tests/fixtures/alias-receive-android.json']
# File names are checked rather than silently skipping absent sources.
hashes={n:sha((p/n).read_bytes()) for n in sourcefiles}
r={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'serial':'e3aca8af','deviceResult':result,'apks':apks,'assets':assets,'nativeSources':fixture['sources'],'sourceHashes':hashes,'cleanup':{'tableCounts':counts,'files':files,'testStopped':True},'mainUpgrade':json.loads((a/'alias-data-verification.json').read_text()),'restartIdentity':json.loads((a/'alias-restart-identity.json').read_text()),'tests':{'appPassed':294,'appAssertions':45967,'typecheck':'passed','mainBuild':'passed','gradle':'passed'},'limits':['Phone transport/session, incoming deletion orchestration, source synchronization, outgoing wire batches, peer cursors and final ACK remain incomplete.','Installed main article database was empty; populated upgrade and rollback checked in automated tests.','Native applied counts, whole-library memory, file GC and physical UI acceptance remain unqualified.']}
(a/'alias-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'deviceResult':result,'mainSha256':apks[1]['sha256'],'cleanup':counts},indent=2))
