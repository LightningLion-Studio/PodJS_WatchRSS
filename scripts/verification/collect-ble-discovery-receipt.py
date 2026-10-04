#!/usr/bin/env python3
"""Record BLE discovery evidence without treating BLE as IP/visual acceptance."""
from pathlib import Path
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
proof=read('ip-ble-pair-proof.json');assert proof['actualBleRadio'] and not proof['wirelessIpVerified'];assert proof['phone']['selectedBondedWatch'] and proof['phone']['gattDisconnected'];assert proof['watch']['bytes']==324 and proof['watch']['foregroundActivity'] and not proof['watch']['privateServiceCacheRefreshed'];assert proof['watch']['sha256']==proof['phone']['sha256']==proof['ready']['sha256']
for file,needle in [('ip-ble-native-phone.log','OK (2 tests)'),('ip-ble-pair-watch.log','OK (1 test)'),('ip-ble-pair-phone.log','OK (1 test)'),('ip-ble-app-test.log','444 pass'),('ip-ble-framework-test.log','64 pass'),('ip-ble-native-build.log','BUILD SUCCESSFUL'),('ip-ble-app-build.log','pod: built android-watch')]:assert needle in (out/file).read_text()
assert (out/'ip-ble-typecheck.log').read_text().strip()=='$ tsc --noEmit'
cache=json.loads(re.search(r'bleDiscoveryCacheProbe=(\{[^\n]+\})',(out/'ip-ble-pair-watch.log').read_text())[1]);assert not cache['privateServiceMissing']
for installed in read('ip-ble-native-installed.json'):assert sha(out/installed['artifact'])==installed['sha256']
cleanup=read('ip-ble-cleanup.json');assert cleanup['watchOriginalTestApkRestored'] and cleanup['watchTemporaryLocationGrantsRevoked'] and cleanup['phoneTestPackageRemoved'] and cleanup['watchWifiUnchanged']
path=adb('e3aca8af','shell','pm','path','dev.podjs.runtime.test').removeprefix('package:');assert adb('e3aca8af','shell','sha256sum',path).split()[0]==cleanup['watchOriginalSha256'];assert sha(out/'ip-ble-watch-test-original.apk')==cleanup['watchOriginalSha256']
permissions=adb('e3aca8af','shell','dumpsys','package','dev.podjs.runtime.test');assert 'android.permission.ACCESS_FINE_LOCATION: granted=false' in permissions and 'android.permission.ACCESS_COARSE_LOCATION: granted=false' in permissions
assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test');assert adb('e3aca8af','shell','settings','get','global','wifi_on')=='0'
data=read('ip-ble-watch-test-data.json');assert data['changed']==['no_backup/androidx.work.workdb']
work={}
with tempfile.TemporaryDirectory() as temp:
 for side in ['before','after']:
  folder=Path(temp)/side;folder.mkdir()
  with tarfile.open(out/f'ip-ble-watch-test-{side}.tar') as tar:
   for item in tar.getmembers():
    if item.isfile() and item.name.startswith('no_backup/androidx.work.workdb'):(folder/Path(item.name).name).write_bytes(tar.extractfile(item).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');tables={}
  for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():tables[name]=db.execute('SELECT * FROM "'+name.replace('"','""')+'" ORDER BY rowid').fetchall()
  work[side]=tables
assert work['before'].keys()==work['after'].keys()
for name in work['before']:
 if name=='Preference':
  a,b=work['before'][name],work['after'][name];assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>=a[0][1]
 else:assert work['before'][name]==work['after'][name]
main=read('ip-discovery-main-installed.json');path=adb('e3aca8af','shell','pm','path',main['package']).removeprefix('package:');assert adb('e3aca8af','shell','sha256sum',path).split()[0]==main['sha256']
resumed=[line.strip() for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line];assert any(main['package']+'/' in line for line in resumed)
sources=[root/p for p in ['src/sync/ip-discovery.ts','src/sync/ip-controller.ts','src/sync/application-host.ts','tests/sync/ip-discovery.test.ts','tests/sync/ip-controller.test.ts','tests/android-ip-peer/WatchRssBleDiscoveryPairTest.java','scripts/verification/run-ble-discovery-pair.py']]+[sdk/p for p in ['platforms/android/runtime/src/main/java/dev/podjs/runtime/PodBleDiscoveryServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodBluetoothPermission.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/androidTest/java/dev/podjs/runtime/PodBleDiscoveryServicesTest.java','packages/framework/src/services.ts']]
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tests':{'app':444,'framework':64,'nativeBleBoundary':2,'pairedBle':True,'typecheck':True,'guestBuild':True},'paired':proof,'cacheRefreshExecuted':False,'fixtureArtifacts':read('ip-ble-native-installed.json'),'cleanup':cleanup,'testPackageDataPreservedExceptForceStopTimestamp':True,'mainStillDeployedMdnsBuild':main,'resumed':resumed,'bleMainDeployed':False,'sourceHashes':{str(p):sha(p) for p in sources},'limits':['The bonded BLE read used a private temporary advertisement and GATT service, not the normal companion provider.','Raw BLE bytes were checked; signed descriptor integration is covered offline, not by a real guest/companion exchange.','The production main app still runs the earlier mDNS APK; BLE and network-change integration are not deployed.','The watch main app has not granted location permission; no production permission was changed by these tests.','Wireless IP routing, full functionality, and physical visual/gesture acceptance remain incomplete.']}
(out/'ip-ble-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'tests':r['tests'],'pairedBytes':proof['watch']['bytes'],'cacheRefreshExecuted':False,'bleMainDeployed':False,'cleanup':cleanup},indent=2))
