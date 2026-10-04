#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,re,subprocess,tarfile,tempfile,sqlite3,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(data):return hashlib.sha256(data).hexdigest()
def proof(name,key):
 text=(out/name).read_text();assert 'OK (1 test)' in text;return json.loads(re.search(key+r'=(\{[^\n]+\})',text)[1])
phone=proof('ip-peer-phone.log','ipPeerProof');main=proof('ip-main-probe-phone.log','ipMainProbeProof');watch=read('ip-peer-guest-kv.json')['ip-peer-result'];assert watch['state']=='passed'
for field in ['watchId','contentSha256','bootstrapAccepted','authenticated','routeKind','endpointAddress','savedFlags']:assert watch[field]==phone[field]
assert phone['incomingBodyBytes']==phone['returnedBodyBytes']==180598 and phone['incomingChunks']==phone['returnedChunks']==2 and phone['exactTextRoundtrip']
assert watch['cursorAfterApplied']==11 and watch['ownedDataRemoved'] and watch['leasesReleased'] and watch['visualAcceptance'] is False
assert main['authenticated'] and main['bootstrapAccepted'] and main['readOnly'] and main['probes']==2
assert main['adbRelay'] and phone['adbRelay'] and main['routeKind']==phone['routeKind']=='unknownLocal'
for name,count in [('ip-app-test.log',432),('ip-framework-test.log',62)]:log=(out/name).read_text();assert f'{count} pass' in log and '0 fail' in log
assert 'OK (3 tests)' in (out/'ip-native-phone.log').read_text();assert (out/'ip-typecheck.log').read_text().strip()=='$ tsc --noEmit'
for name in ['ip-peer-gradle.log','ip-guest-gradle.log','ip-main-gradle.log','ip-main-probe-gradle.log']:assert 'BUILD SUCCESSFUL' in (out/name).read_text()
for name in ['ip-guest-build.log','ip-main-build.log']:assert 'PocketJS build: done' in (out/name).read_text()
oracle=json.loads((root/'tests/fixtures/ip-protocol-native.json').read_text());assert len(oracle['cases'])==11;native=root.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/phoneconnection/ip/IpSyncProtocol.kt';assert sha(native.read_bytes())==oracle['sourceSha256']
artifacts={}
for kind,name in [('main','ip-main-installed.json'),('guest','ip-peer-guest-installed.json'),('articlePhone','ip-peer-phone-installed.json'),('mainProbePhone','ip-main-probe-phone-installed.json')]:
 data=read(name);assert sha((out/data['artifact']).read_bytes())==data['sha256'];artifacts[kind]=data
 if kind in ['main','guest']:
  apk=subprocess.check_output(['adb','-s',data['serial'],'shell','pm','path',data['package']],text=True).strip().removeprefix('package:');assert subprocess.check_output(['adb','-s',data['serial'],'shell','sha256sum',apk],text=True).split()[0]==data['sha256']
  with zipfile.ZipFile(out/data['artifact']) as z:data['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
assert artifacts['main']['nativeLibraries']==artifacts['guest']['nativeLibraries']
a=read('ip-main-before.json');b=read('ip-main-after.json');assert a['tables']==b['tables'];assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
with tarfile.open(out/'ip-main-before.tar') as archive,tempfile.TemporaryDirectory() as temp:
 for m in archive.getmembers():
  if m.isfile() and m.name.startswith('databases/'):Path(temp,Path(m.name).name).write_bytes(archive.extractfile(m).read())
 identity=sqlite3.connect(str(Path(temp)/'podjs.sqlite')).execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0];assert main['watchId']==identity!=watch['watchId']
assert read('ip-main-native-identity-check.json')['mainIdentityDistinctFromNative']
assert read('ip-phone-before.json')['wasAbsent'];cleanup=read('ip-phone-cleanup.json');assert cleanup['uninstalled'] and cleanup['verifiedAbsent'];assert not subprocess.check_output(['adb','-s','RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test'],text=True).strip()
body=read('ip-body-cleanup.json');assert body['onlyNewHashedBodyFiles'] and len(body['removedFiles'])==2
for path in body['removedFiles']:assert subprocess.run(['adb','-s','e3aca8af','shell','run-as','dev.podjs.tests.syncstate','test','-e',path]).returncode==1
network=read('ip-network-after.json');assert network['watchWifiOn']==read('ip-network-before.json')['watchWifiOn']=='0' and network['restoredOriginalState'] and not network['wirelessVerified']
relays=[read(n) for n in ['ip-relay.json','ip-main-relay.json']]
for relay in relays:assert relay['removed'] and not relay['active'] and relay['forwardBefore']==relay['forwardAfter'] and relay['reverseBefore']==relay['reverseAfter']
resumed=[l.strip() for l in subprocess.check_output(['adb','-s','e3aca8af','shell','dumpsys','activity','activities'],text=True).splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
pid=subprocess.check_output(['adb','-s','e3aca8af','shell','pidof','com.lightningstudio.watchrss.podjs'],text=True).strip();assert pid.isdecimal();assert 'FATAL EXCEPTION' not in (out/'ip-main-session.log').read_text()
sources=['src/sync/ip-protocol.ts','src/sync/ip-crypto-host.ts','src/sync/ip-connection.ts','src/sync/ip-controller.ts','src/sync/application-host.ts','src/sync/session.ts','tests/runtime-ip-peer/main.tsx','tests/android-ip-peer/WatchRssIpPeerTest.java','tests/android-ip-peer/WatchRssIpMainProbeTest.java']
sdk_sources=['packages/framework/src/services.ts','packages/framework/src/targets.ts','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodWebSocketServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/main/cpp/jni_bridge.cpp']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'tests':{'app':432,'framework':62,'androidWebSocket':3,'nativeOracleCases':11,'typecheck':'passed'},'nativeOracleSourceSha256':oracle['sourceSha256'],'pairedArticle':{'phone':phone,'watch':watch},'mainProbe':main,'mainIdentityMatchesBeforeDatabase':True,'mainIdentityDistinctFromNativeApp':True,'preservation':{'tables':len(a['tables']),'files':len(a['files']),'allTableDigestsEqual':True,'allNonDatabaseFilesEqual':True},'cleanup':{'phone':cleanup,'bodyFiles':body,'network':network,'relays':relays},'mainPid':pid,'resumed':resumed,'sourceHashes':{p:sha((root/p).read_bytes()) for p in sources},'sdkSourceHashes':{p:sha((sdk/p).read_bytes()) for p in sdk_sources},'limits':['Physical device exchange used an explicitly configured temporary ADB relay; wireless LAN/hotspot/proxy routing is unverified.','Phone tests use Android protocol fixtures, not the normal companion UI/client.','BLE/mDNS discovery and network-driven reconnection are incomplete.','Pre-authentication binary-message ordering remains a native-fidelity follow-up.','Visual/gesture parity and full migration remain incomplete.']}
(out/'ip-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'tests':r['tests'],'preservation':r['preservation'],'mainPid':pid,'mainReadOnlyProbe':main,'wirelessVerified':False},indent=2))
