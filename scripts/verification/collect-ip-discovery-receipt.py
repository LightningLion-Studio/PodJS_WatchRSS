#!/usr/bin/env python3
"""Bind the mDNS increment to its deployed APK and stopped-data comparison."""
import datetime, hashlib, json, re, sqlite3, subprocess, tarfile, tempfile, zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('ip-discovery-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z:
 manifest=json.loads(z.read('assets/pod.manifest.json'));assert 'net.discovery' in manifest['capabilities']
 assert hashlib.sha256(z.read('assets/main.js')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.js')
probe=(out/'ip-discovery-main-probe-phone.log').read_text();assert 'OK (1 test)' in probe
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',probe)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay']
before=read('ip-discovery-main-before.json');after=read('ip-discovery-main-after.json');assert before['tables']==after['tables']
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'ip-discovery-main-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):
     (folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');tables={}
  for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
   tables[table]=db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall()
  work[side]=tables
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for name in work['before']:
 if name=='Preference':
  a,b=work['before'][name],work['after'][name];assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert work['before'][name]==work['after'][name]
cleanup=read('ip-discovery-main-cleanup.json');assert all(cleanup[k] for k in ['phoneTestPackageRemoved','relaysRemoved','wifiUnchanged'])
assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('ip-discovery-main-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')=='0'
nsd=(out/'ip-discovery-main-nsd-after.txt').read_text();assert 'what=DISCOVER_SERVICES' in nsd and 'what=STOP_DISCOVERY' in nsd
assert 'FATAL EXCEPTION' not in (out/'ip-discovery-main-session.log').read_text()
for log,needle in [('ip-discovery-native-phone.log','OK (8 tests)'),('ip-discovery-app-test.log','437 pass'),('ip-discovery-framework-test.log','63 pass'),('ip-discovery-main-build.log','pod: built android-watch'),('ip-discovery-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'ip-discovery-typecheck.log').read_text().strip()=='$ tsc --noEmit'
resumed=[line.strip() for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line];assert any(installed['package']+'/' in line for line in resumed)
files=[root/p for p in ['pod.config.json','src/sync/ip-controller.ts','src/sync/application-host.ts','src/sync/ip-connection.ts','tests/sync/ip-controller.test.ts','scripts/verification/run-ip-main-probe.py']]+[sdk/p for p in ['platforms/android/runtime/src/main/java/dev/podjs/runtime/PodDiscoveryServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodWebSocketServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/main/AndroidManifest.xml','platforms/android/runtime/src/main/cpp/jni_bridge.cpp','packages/framework/src/services.ts','packages/framework/src/targets.ts']]
receipt={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'tests':{'nativePhone':8,'framework':63,'app':437,'typecheck':True},'mainProbe':proof,'mainIdentityMatchesBeforeAfter':True,'preservation':{'appTablesUnchanged':len(before['tables']),'nonDatabaseFilesUnchanged':len(non_db(before))-1,'onlyChangedFile':'no_backup/androidx.work.workdb','workManagerOnlyChangedField':'Preference.last_force_stop_ms','workManagerOtherTablesUnchanged':len(work['before'])-1},'cleanup':cleanup,'nsdStartStopObserved':True,'wirelessVerified':False,'resumed':resumed,'sourceHashes':{str(p):sha(p) for p in files},'limits':['The main-app exchange used a temporary ADB relay, not wireless LAN.','Phone-local NSD publication/discovery is tested, but cross-device Wi-Fi discovery remains unverified.','BLE acquisition and network-change-driven discovery are pending.','Visual/interaction parity and complete migration remain unverified.']}
(out/'ip-discovery-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'installedSha256':installed['sha256'],'preservation':receipt['preservation'],'mainProbePassed':True,'wirelessVerified':False},indent=2))
