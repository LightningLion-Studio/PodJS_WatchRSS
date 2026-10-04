#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def sha(b):return hashlib.sha256(b).hexdigest()
def read(name):return json.loads((out/name).read_text())
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args]).decode().strip()
profile=read('encoding-profile-kv.json')['sync-encoding-profile'];assert profile['state']=='passed' and profile['nativeAvailable']
body=read('encoding-storage-kv.json')['storage-guest-result'];assert body['state']=='passed'
for flag in ['productionFactory','oversizedQueryRejected','inlineBody','chunkBody','originalBody','nulAndSupplementaryText','metadataOnlyReceive','replacement']:assert body[flag] is True
oracle=read('encoding-oracle-kv.json')['library-repository-result'];assert oracle['state']=='passed' and [oracle[k] for k in ['nativeSources','nativeDeletions','nativeReplacements']]==[16,13,6]
cleanup=read('encoding-storage-cleanup.json');assert not any(cleanup['counts'].values()) and not cleanup['remainingBodyFiles']
for file,expected in [('encoding-all-unit.log','390 pass'),('encoding-framework-tests.log','60 pass')]:s=(out/file).read_text();assert expected in s and '0 fail' in s
assert '59 passed; 0 failed' in (out/'encoding-runtime-tests.log').read_text()
assert (out/'encoding-typecheck.log').read_text().strip()=='$ tsc --noEmit'
for kind in ['profile','storage','main','oracle']:assert 'BUILD SUCCESSFUL' in (out/f'encoding-{kind}-gradle.log').read_text()
artifacts={}
for kind in ['profile','storage','main','oracle']:
 f=out/f'encoding-{kind}.apk'
 with zipfile.ZipFile(f) as z:
  libs={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')};assets={n:sha(z.read(n)) for n in z.namelist() if n.endswith('/main.js') or n.endswith('/main.pak')}
 assert libs
 artifacts[kind]={'sha256':sha(f.read_bytes()),'nativeLibraries':libs,'assets':assets}
assert all(artifacts[k]['nativeLibraries']==artifacts['profile']['nativeLibraries'] for k in ['storage','main','oracle'])
for kind in ['profile','storage']:assert read(f'encoding-{kind}-installed.json')['sha256']==artifacts[kind]['sha256']
for package,kind in [('com.lightningstudio.watchrss.podjs','main'),('dev.podjs.tests.syncstate','oracle')]:
 path=adb('shell','pm','path',package).removeprefix('package:');assert adb('shell','sha256sum',path).split()[0]==artifacts[kind]['sha256'];artifacts[kind]['currentlyInstalledPath']=path
before=read('encoding-main-before.json');after=read('encoding-main-after.json')
changedTables=[k for k,v in before['tables'].items() if after['tables'].get(k)!=v];changedFiles=[k for k,v in before['files'].items() if not k.startswith('databases/') and after['files'].get(k)!=v]
assert not changedTables and not changedFiles
comparison={'beforeArchiveSha256':before['archiveSha256'],'afterArchiveSha256':after['archiveSha256'],'existingFiles':len(before['files']),'existingTables':len(before['tables']),'changedExistingTables':changedTables,'changedExistingNonDatabaseFiles':changedFiles,'limitation':'Actual main library is empty; populated behavior uses isolated test data.'}
(out/'encoding-main-data-comparison.json').write_text(json.dumps(comparison,indent=2)+'\n')
old=read('storage-receipt.json');fixture='tests/runtime-storage/main.tsx';assert sha((root/fixture).read_bytes())==old['sourceHashes'][fixture]
pid=adb('shell','pidof','com.lightningstudio.watchrss.podjs');resumed=[l.strip() for l in adb('shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in l];assert pid and any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
source=['crates/podjs-runtime/src/lib.rs','packages/framework/src/services.ts','packages/framework/tests/byte-encoding.test.ts','docs/android-http-and-toast.md']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'serial':'e3aca8af','artifacts':artifacts,'profile':profile,'storage':body,'storageCleanup':cleanup,'oracle':oracle,'baselineStorage':old['guest'],'unchangedStorageFixtureSha256':sha((root/fixture).read_bytes()),'dataPreservation':comparison,'main':{'pid':pid,'resumed':resumed},'tests':{'runtime':59,'framework':60,'app':390,'typecheck':'passed'},'sdkSourceHashes':{f:sha((sdk/f).read_bytes()) for f in source},'limits':['Component timing averages only three iterations with millisecond resolution.','Whole fixture timing is not paired-phone sync latency or throughput.','Initial file-cache state differs: previous run reused immutable files; new run began with an empty body directory.','Native Kotlin was not rerun; separate PodJS harness replays 35 existing native captures.','Main full radio/IP sync, power/media ports, interaction and visual acceptance remain pending.']}
(out/'encoding-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'profile':profile,'storageElapsedMs':body['elapsedMs'],'baselineElapsedMs':old['guest']['elapsedMs'],'mainSha256':artifacts['main']['sha256'],'dataPreservation':comparison},indent=2))
