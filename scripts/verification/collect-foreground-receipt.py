#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,datetime,zipfile
p=Path(__file__).resolve().parents[2];a=p/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def sha(data):return hashlib.sha256(data).hexdigest()
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args])
guest=json.loads((a/'foreground-guest-kv.json').read_text())['foreground-guest-result'];assert guest['state']=='passed';assert guest['visualFramesBefore']==guest['visualFramesAfter']
for flag in ['backgroundLifecycle','sql','timer','acceptCancelled','listenerClosed']:assert guest[flag] is True
for file,passed in [('foreground-all-unit.log','380 pass'),('foreground-framework-tests.log','59 pass'),('foreground-controller-test.log','6 pass')]:assert passed in (a/file).read_text() and '0 fail' in (a/file).read_text()
assert '58 passed; 0 failed' in (a/'foreground-runtime-tests.log').read_text()
assert (a/'foreground-typecheck.log').read_text().strip()=='$ tsc --noEmit'
for f in ['foreground-main-gradle.log','foreground-guest-gradle.log']:assert 'BUILD SUCCESSFUL' in (a/f).read_text()
assert 'PodJS Android runtime:' in (a/'foreground-runtime-build.log').read_text()
packages={}
for package,artifact in [('com.lightningstudio.watchrss.podjs','foreground-main.apk'),('dev.podjs.tests.syncstate','foreground-guest.apk')]:
 path=adb('shell','pm','path',package).decode().strip().removeprefix('package:');digest=sha((a/artifact).read_bytes());assert adb('shell','sha256sum',path).decode().split()[0]==digest
 assets={}
 with zipfile.ZipFile(a/artifact) as z:
  for name in ['main.js','main.pak']:
   key=next(k for k in z.namelist() if k.endswith('/'+name));data=z.read(key);assert data==(sdk/'dist/projects'/package/'android-watch'/name).read_bytes();assets[name]=sha(data)
 packages[package]={'artifact':artifact,'installedPath':path,'sha256':digest,'assets':assets}
comparison=json.loads((a/'foreground-main-data-comparison.json').read_text());assert not comparison['changedExistingTables'] and not comparison['changedExistingNonDatabaseFiles']
assert subprocess.run(['adb','-s','e3aca8af','shell','pidof','dev.podjs.tests.syncstate'],capture_output=True).returncode==1
pid=adb('shell','pidof','com.lightningstudio.watchrss.podjs').decode().strip();assert pid
resumed=[l.strip() for l in adb('shell','dumpsys','activity','activities').decode().splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
appFiles=['src/sync/foreground.ts','src/sync/rfcomm.ts','tests/sync/foreground.test.ts','tests/runtime-foreground/main.tsx','tests/runtime-foreground/pod.config.json','docs/sync-foreground.md']
sdkFiles=['vendor/pocketjs/framework/src/services.ts','crates/podjs-runtime/src/lib.rs','crates/podjs-runtime/include/podjs_runtime.h','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodRuntimeView.java','platforms/android/runtime/src/main/cpp/jni_bridge.cpp','packages/framework/tests/watch.test.ts']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'serial':'e3aca8af','packages':packages,'guest':guest,'tests':{'app':380,'appAssertions':46433,'framework':59,'frameworkAssertions':336,'portableRuntime':58,'foregroundControllerCases':6,'foregroundAssertions':32,'typecheck':'passed'},'dataPreservation':comparison,'main':{'pid':pid,'resumed':resumed,'visualAcceptance':'pending; not established by runtime completion tests'},'sourceHashes':{f:sha((p/f).read_bytes()) for f in appFiles},'frameworkHashes':{f:sha((sdk/f).read_bytes()) for f in sdkFiles},'limits':['Foreground policy controller is not yet instantiated in main.','Screen interactivity, screen-on and media lease ports still require production integration.','Main full session repository cleanup and other sync actions still require integration.','No remote peer connected in this background completion fixture.','This does not guarantee continuation after Android kills the owning process.']}
(a/'foreground-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'mainSha256':packages['com.lightningstudio.watchrss.podjs']['sha256'],'guest':guest,'dataPreservation':comparison},indent=2))
