#!/usr/bin/env python3
from pathlib import Path
import json,hashlib,subprocess,datetime,zipfile
p=Path(__file__).resolve().parents[2];a=p/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def sha(data):return hashlib.sha256(data).hexdigest()
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args])
result=json.loads((a/'rfcomm-guest-kv.json').read_text())['rfcomm-guest-result'];assert result['state']=='passed'
assert '374 pass' in (a/'phone-ui-all-unit.log').read_text() and '0 fail' in (a/'phone-ui-all-unit.log').read_text()
assert '58 pass' in (a/'rfcomm-enable-framework-tests.log').read_text() and '0 fail' in (a/'rfcomm-enable-framework-tests.log').read_text()
assert 'OK (6 tests)' in (a/'rfcomm-enable-native-test-result.log').read_text()
assert (a/'phone-ui-typecheck.log').read_text().strip()=='$ tsc --noEmit'
for f in ['phone-ui-main-gradle.log','rfcomm-guest-apk-build.log','rfcomm-enable-native-build.log']:assert 'BUILD SUCCESSFUL' in (a/f).read_text()
packages={}
for package,artifact in [('com.lightningstudio.watchrss.podjs','phone-ui-main.apk'),('dev.podjs.tests.syncstate','rfcomm-guest.apk'),('dev.podjs.runtime.test','rfcomm-enable-runtime-tests.apk')]:
 path=adb('shell','pm','path',package).decode().strip().removeprefix('package:');digest=sha((a/artifact).read_bytes());assert adb('shell','sha256sum',path).decode().split()[0]==digest
 packages[package]={'artifact':artifact,'installedPath':path,'sha256':digest}
 if package!='dev.podjs.runtime.test':
  with zipfile.ZipFile(a/artifact) as z:
   assets={}
   for name in ['main.js','main.pak']:
    key=next(k for k in z.namelist() if k.endswith('/'+name));data=z.read(key);assert data==(sdk/'dist/projects'/package/'android-watch'/name).read_bytes();assets[name]=sha(data)
   packages[package]['assets']=assets
comparison=json.loads((a/'phone-ui-main-data-comparison.json').read_text());assert not comparison['changedExistingTables'] and not comparison['changedExistingNonDatabaseFiles']
assert subprocess.run(['adb','-s','e3aca8af','shell','pidof','dev.podjs.tests.syncstate'],capture_output=True).returncode==1
pid=adb('shell','pidof','com.lightningstudio.watchrss.podjs').decode().strip();assert pid
resumed=[l.strip() for l in adb('shell','dumpsys','activity','activities').decode().splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
appFiles=['src/ui/PhoneConnectionScreen.tsx','src/ui/DownloadPhoneAppDialog.tsx','src/ui/ReaderPresetScreen.tsx','src/ui/screen.tsx','tests/runtime-rfcomm/main.tsx','tests/runtime-rfcomm/pod.config.json','docs/phone-connection.md']
sdkFiles=['platforms/android/runtime/src/main/java/dev/podjs/runtime/PodBluetoothPermission.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodByteStreamServices.java','packages/framework/src/services.ts','packages/framework/src/targets.ts','packages/framework/tests/services.test.ts','platforms/android/runtime/src/main/cpp/jni_bridge.cpp']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'serial':'e3aca8af','packages':packages,'guest':result,'tests':{'app':374,'appAssertions':46401,'framework':58,'frameworkAssertions':334,'nativeStreamCases':6,'typecheck':'passed'},'dataPreservation':comparison,'main':{'pid':pid,'resumed':resumed,'visualAcceptance':'pending; charging-duration system warning covers display'},'sourceHashes':{f:sha((p/f).read_bytes()) for f in appFiles},'frameworkHashes':{f:sha((sdk/f).read_bytes()) for f in sdkFiles},'limits':['Main phone page is implemented; actual navigation and visual comparison remain unverified.','Main does not yet start the foreground sync listener or instantiate the full session repository.','No remote client connected during the guest test.','Android 12+ permission dialog interaction remains unverified.','The observed bounded accept failure is host_error Try again, not a typed timeout.']}
(a/'phone-connection-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'mainSha256':packages['com.lightningstudio.watchrss.podjs']['sha256'],'guest':result,'dataPreservation':comparison},indent=2))
