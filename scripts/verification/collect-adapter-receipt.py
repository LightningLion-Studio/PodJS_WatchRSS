#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,sqlite3,zipfile,datetime
p=Path(__file__).resolve().parents[2];a=p/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def sha(data):return hashlib.sha256(data).hexdigest()
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args])
runtime=json.loads((a/'adapter-device-kv.json').read_text())['library-repository-result'];assert runtime['state']=='passed';assert [runtime[k] for k in ['nativeSources','nativeDeletions','nativeReplacements']]==[16,13,6]
for flag in ['actualAndroidUri','typedSqlQuery','adapterIncrementalReading','replaceRollback','replacement','coreSourceDeletion','journalMigration']:assert runtime[flag] is True
assert '369 pass' in (a/'adapter-all-unit.log').read_text() and '0 fail' in (a/'adapter-all-unit.log').read_text();assert '57 pass' in (a/'adapter-framework-tests.log').read_text();assert (a/'adapter-typecheck.log').read_text().strip()=='$ tsc --noEmit'
for name in ['adapter-main-gradle.log','adapter-harness-gradle.log','adapter-replacement-native-build.log']:assert 'BUILD SUCCESSFUL' in (a/name).read_text()
assert 'OK (1 test)' in (a/'adapter-replacement-native-instrument.log').read_text()
packages=[('com.lightningstudio.watchrss.podjs',a/'adapter-main.apk'),('dev.podjs.tests.syncstate',a/'adapter-harness.apk'),('com.lightningstudio.watchrss.reference',p.parent/'Android_WatchRSS/app/build/outputs/apk/release/app-release.apk'),('com.lightningstudio.watchrss.reference.test',p.parent/'Android_WatchRSS/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk')]
apks=[]
for package,path in packages:
 installed=adb('shell','pm','path',package).decode().strip().removeprefix('package:');digest=sha(path.read_bytes());assert adb('shell','sha256sum',installed).decode().split()[0]==digest;assets={}
 if package in ['com.lightningstudio.watchrss.podjs','dev.podjs.tests.syncstate']:
  with zipfile.ZipFile(path) as z:
   for name in ['main.js','main.pak']:
    key=next(k for k in z.namelist() if k.endswith('/'+name));assets[name]=sha(z.read(key));assert assets[name]==sha((sdk/'dist/projects'/package/'android-watch'/name).read_bytes())
 apks.append({'package':package,'path':str(path),'installedPath':installed,'sha256':digest,'assets':assets})
fixtures={}
with zipfile.ZipFile(packages[-1][1]) as z:
 for kind,key in [('library-repository','sourcesSha256'),('library-replacement','sources')]:
  inputPath='tests/reference/assets/'+kind+'-input.json';entry=next(n for n in z.namelist() if n.endswith('/'+kind+'-input.json'));assert z.read(entry)==(p/inputPath).read_bytes();fixture=json.loads((p/'tests/fixtures'/f'{kind}-android.json').read_text());hashes=fixture[key]
  for path,digest in hashes.items():assert sha((p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'/path).read_bytes())==digest
  fixtures[kind]={'inputSha256':sha(z.read(entry)),'nativeHashes':hashes}
comparison=json.loads((a/'adapter-main-data-comparison.json').read_text());assert comparison['changedExistingTables']==[] and comparison['changedExistingFiles']==[]
cleanup=sqlite3.connect(a/'adapter-harness-cleanup.sqlite');counts={t:cleanup.execute('SELECT count(*) FROM "'+t+'"').fetchone()[0] for t, in cleanup.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")};assert all(v==0 for t,v in counts.items() if t not in ['android_metadata','sync_local_identity','sync_library_revision']);cleanup.close()
files=adb('shell','run-as','dev.podjs.tests.syncstate','find','files/podjs/files','-type','f').decode().splitlines();assert not files
assert subprocess.run(['adb','-s','e3aca8af','shell','pidof','dev.podjs.tests.syncstate'],capture_output=True).returncode==1
pid=adb('shell','pidof','com.lightningstudio.watchrss.podjs').decode().strip();assert pid
resumed=[l.strip() for l in adb('shell','dumpsys','activity','activities').decode().splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
sourceFiles=['src/sync/library-repository.ts','src/sync/deletion-journal.ts','src/sync/snapshot-log.ts','src/sync/sql-pages.ts','src/sync/source-store.ts','src/sync/deletion-store.ts','src/sync/local-manifest.ts','src/sync/revision.ts','src/core/repository.ts','src/core/schema.ts','src/services.ts','tests/sync/library-adapter.test.ts','tests/helpers/library-repository-fixture.ts','tests/helpers/library-replacement-fixture.ts','tests/runtime-library-repository/main.tsx','tests/reference/LibraryReplacementReferenceTest.kt','docs/sync-library-adapter.md']
frameworkFiles=['platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodDeviceServices.java','packages/framework/src/services.ts','packages/framework/tests/services.test.ts']
result={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'serial':'e3aca8af','runtime':runtime,'apks':apks,'fixtures':fixtures,'sourceHashes':{n:sha((p/n).read_bytes()) for n in sourceFiles},'frameworkHashes':{n:sha((sdk/n).read_bytes()) for n in frameworkFiles},'dataPreservation':comparison,'cleanup':{'counts':counts,'files':files,'harnessStopped':True},'main':{'pid':pid,'resumed':resumed,'visualAcceptance':'not verified; charging-duration system warning covers display'},'tests':{'app':369,'appAssertions':46385,'framework':57,'frameworkAssertions':325,'typecheck':'passed'},'limits':['Main has local source-deletion journaling and typed SQL host fix; full repository adapter is exercised in isolated harness only.','Main phone-sync UI, Bluetooth/IP transport and actual media/cache cleanup remain pending.','Single inline body rows over host query byte limits require further streaming integration.','No physical gestures or final visual acceptance.']}
(a/'adapter-receipt.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'mainSha256':apks[0]['sha256'],'harnessSha256':apks[1]['sha256'],'runtime':runtime,'dataPreservation':comparison},indent=2))
