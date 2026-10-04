#!/usr/bin/env python3
from pathlib import Path
import subprocess,json,hashlib,sqlite3,zipfile,datetime
p=Path(__file__).resolve().parents[2];a=p/'artifacts';fw=Path('/home/wilf/data/PodJS/podjs-watch')
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args])
def sha(b):return hashlib.sha256(b).hexdigest()
result=json.loads((a/'session-device-kv.json').read_text())['library-session-result'];assert result['state']=='passed'
assert (result['nativeSessions'],result['nativeOutgoingCases'],result['nativeCountedReceives'])==(12,9,14)
assert '323 pass' in (a/'session-all-unit.log').read_text() and '0 fail' in (a/'session-all-unit.log').read_text()
assert '56 pass' in (a/'session-framework-tests.log').read_text()
assert (a/'session-typecheck.log').read_text().strip()=='$ tsc --noEmit'
assert 'PocketJS build: done' in (a/'session-main-build.log').read_text()
packages=[('dev.podjs.tests.syncstate',a/'session-harness.apk'),('com.lightningstudio.watchrss.podjs',a/'watchrss-podjs-0.1.0-dev.apk'),('com.lightningstudio.watchrss.reference',p.parent/'Android_WatchRSS/app/build/outputs/apk/release/app-release.apk'),('com.lightningstudio.watchrss.reference.test',p.parent/'Android_WatchRSS/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk')]
apks=[]
for package,path in packages:
 installed=adb('shell','pm','path',package).decode().strip().removeprefix('package:');digest=sha(path.read_bytes());remote=adb('shell','sha256sum',installed).decode().split()[0];assert digest==remote,package
 apks.append({'package':package,'path':str(path),'sha256':digest,'installedPath':installed,'installedSha256':remote})
assert apks[1]['sha256']=='67074d38ee42315094c22b3133b4ff106b5543ccc4d0f9ab08a85b4bf84842bc'
assets={}
with zipfile.ZipFile(packages[0][1]) as z:
 for name in ['main.js','main.pak']:
  key=next(n for n in z.namelist() if n.endswith('/'+name));digest=sha(z.read(key));assert digest==sha((fw/'dist/projects/dev.podjs.tests.syncstate/android-watch'/name).read_bytes());assets[name]=digest
nativeFixtures={}
with zipfile.ZipFile(packages[-1][1]) as z:
 for kind in ['library-session','library-wire']:
  name=kind+'-input.json';key=next(n for n in z.namelist() if n.endswith('/'+name));assert z.read(key)==(p/'tests/reference/assets'/name).read_bytes()
  fixture=json.loads((p/'tests/fixtures'/f'{kind}-android.json').read_text())
  for source,digest in fixture['sources'].items():assert sha((p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'/source).read_bytes())==digest
  nativeFixtures[kind]={'inputSha256':sha(z.read(key)),'sources':fixture['sources'],'cases':len(fixture['cases'])}
db=sqlite3.connect(a/'session-harness-cleanup.sqlite');names=['articles','channels','sync_saved_states','sync_article_ids','sync_article_aliases','article_saved_entry_times','local_article_deletions','article_sync_content','article_reading_state','article_saved_states','article_body_chunks','article_original_chunks','article_previews','article_original_previews','article_original_meta','sync_peer_state','sync_change_log'];counts={n:db.execute('SELECT COUNT(*) FROM '+n).fetchone()[0] for n in names};assert all(c==0 for c in counts.values());db.close()
files=adb('shell','run-as','dev.podjs.tests.syncstate','find','files/podjs/files','-type','f').decode().splitlines();assert not files
assert subprocess.run(['adb','-s','e3aca8af','shell','pidof','dev.podjs.tests.syncstate'],capture_output=True).returncode==1
activities=adb('shell','dumpsys','activity','activities').decode();resumed=[s.strip() for s in activities.splitlines() if 'mResumedActivity' in s];assert any('com.lightningstudio.watchrss.podjs/' in s for s in resumed)
sourceFiles=['src/sync/library-wire.ts','src/sync/session.ts','src/sync/stream.ts','src/sync/sequence-store.ts','src/sync/article-receiver.ts','src/core/types.ts','src/core/schema.ts','tests/sync/session.test.ts','tests/sync/library-wire.test.ts','tests/sync/sequence-store.test.ts','tests/sync/alias-receive.test.ts','tests/runtime-library-session/main.tsx','tests/runtime-library-session/pod.config.json','tests/reference/LibrarySessionReferenceTest.kt','tests/reference/LibraryWireReferenceTest.kt','tests/helpers/library-session-fixture.ts','tests/helpers/library-wire-fixture.ts','docs/sync-library-session.md']
frameworkFiles=['packages/framework/src/services.ts','packages/framework/tests/services.test.ts','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','docs/device-services.md']
r={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'serial':'e3aca8af','deviceResult':result,'apks':apks,'harnessAssets':assets,'nativeFixtures':nativeFixtures,'sourceHashes':{n:sha((p/n).read_bytes()) for n in sourceFiles},'frameworkHashes':{n:sha((fw/n).read_bytes()) for n in frameworkFiles},'cleanup':{'counts':counts,'files':files,'testStopped':True,'mainResumed':resumed},'tests':{'appPassed':323,'appAssertions':46099,'frameworkPassed':56,'frameworkAssertions':323,'typecheck':'passed','mainCliBuild':'passed','harnessGradle':'passed'},'limits':['No actual Bluetooth or IP radio connection; both session fixture transports are byte/JSON test peers.','Main installed APK remains 67074d38; session UI/transport and production source/deletion/replacement repository integration are pending.','Nonchunked library transfer and unsolicited source-replacement bodies are not implemented.','Change log still needs main-app mutation hooks and concurrent snapshot-to-sequence coverage.','Legacy Float formatting at exponent edges may differ textually while preserving the exact Android Float value.','Media side effects and final physical UI/visual acceptance remain unverified.']}
(a/'session-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'deviceResult':result,'mainSha256':apks[1]['sha256'],'harnessSha256':apks[0]['sha256'],'cleanupCounts':counts},indent=2))
