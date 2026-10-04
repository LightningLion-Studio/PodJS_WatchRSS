#!/usr/bin/env python3
"""Bind HTTP, native protocol, QR decoding, and bonded Bluetooth proof to the deployed runtime and data audit."""
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('remote-input-deploy-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'remote-input-runtime-app.apk') as fixture:
 for n in ['main.js','main.pak']:assert hashlib.sha256(z.read('assets/'+n)).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch'/n)
 for n in fixture.namelist():
  if n.endswith('.so') or n.endswith('.dex'):assert z.read(n)==fixture.read(n),n
 assert 'net.tcp' in json.loads(z.read('assets/pod.manifest.json'))['capabilities']
 for abi in ['arm64-v8a','armeabi-v7a']:assert b'net.tcp' in z.read('lib/'+abi+'/libpodjs_android.so')
phone=read('remote-input-deploy-phone-installed.json');assert sha(out/phone['artifact'])==phone['sha256']
log=(out/'remote-input-deploy-probe-phone.log').read_text();assert 'OK (1 test)' in log
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',log)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay'] and proof['tokenUsageProbed'] and proof['tokenUsageRequests']==3 and proof['tokenUsageRecords']==0 and proof['readerManifestProbed'] and proof['readerPresets']==2
before=read('remote-input-deploy-before.json');after=read('remote-input-deploy-after.json');assert before['tables']==after['tables'];assert before['tables']['llm_token_usage']['rows']==0
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'remote-input-deploy-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):(folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={table:db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert a==b
assert all(read('remote-input-deploy-cleanup.json').values());assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('remote-input-deploy-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')==read('remote-input-deploy-phone-before.json')['wifi']
for side in ['before','active','resumed']:assert len(read('remote-input-deploy-network-'+side+'.json'))==2
assert read('remote-input-deploy-network-stopped.json')==[]
for state in [(out/'remote-input-deploy-permissions-before.txt').read_text(),(out/'remote-input-deploy-permissions-after.txt').read_text(),adb('e3aca8af','shell','dumpsys','package',installed['package'])]:
 for permission in ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']:assert re.search(r'android.permission.'+permission+r': granted=false',state)
assert 'FATAL EXCEPTION' not in (out/'remote-input-deploy-session.log').read_text()
for log,needle in [('remote-input-app-tests.log','486 pass'),('remote-input-main-build.log','pod: built android-watch'),('remote-input-main-phone-gradle.log','BUILD SUCCESSFUL'),('remote-input-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'remote-input-typecheck.log').read_text().strip()=='$ tsc --noEmit'
assert any(installed['package']+'/' in line for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line)

http=read('remote-input-http-proof.json');bt=read('remote-input-bt-watch-proof.json')
assert http['passed'] and http['nativeHandlerCases']==17 and http['screenExitReleasedListener'] and http['pendingReadCancelled'] and http['portClosed']
assert http['qrDecoded']=='http://192.168.1.2:12345/#请将手机和手表连上同一个WiFi再扫码'
assert http['result']['state']=='passed' and http['result']['settingsUnchanged'] and http['result']['subscriptionsNotCreated']
assert bt['state']=='passed' and bt['connections']==2 and bt['actions']==5 and bt['adds']==0 and bt['subscriptionsUnchanged'] and bt['legacyRemoteInputVerified']
assert [p['value'] for p in bt['prompts']]==['https://example.invalid/中文.xml?one=1&two=2','https://example.invalid/cancel.xml']
for log,needle in [('remote-input-sdk-services.log','34 pass'),('remote-input-runtime-test.log','OK (4 tests)'),('remote-input-ui-test.log','OK (1 test)'),('remote-input-bt-phone-test.log','OK (1 test)')]:assert needle in (out/log).read_text()
phoneBt=json.loads(re.search(r'remoteInputBluetoothProof=(\{[^\n]+\})',(out/'remote-input-bt-phone-test.log').read_text())[1]);assert phoneBt['watchId']==bt['watchId'] and phoneBt['bonded'] and phoneBt['acceptedUrls']==2 and phoneBt['rejectedEmptyUrl']
assert all(read('remote-input-runtime-cleanup.json').values())
assert not adb('e3aca8af','shell','pm','list','packages','dev.podjs.tests.remoteinput')
for pkg,info in read('remote-input-runtime-before.json')['existingPackages'].items():
 if pkg!=installed['package']:assert adb('e3aca8af','shell','sha256sum',adb('e3aca8af','shell','pm','path',pkg).removeprefix('package:')).split()[0]==info['sha256']
for pkg,info in read('remote-input-phone-before.json')['originalPackages'].items():assert adb('RFCX70EGH6K','shell','sha256sum',adb('RFCX70EGH6K','shell','pm','path',pkg).removeprefix('package:')).split()[0]==info['sha256']
assert proof['readerPreviewProbed'] and proof['readerPreviewRequests']==7
from PIL import Image
captures={}
for name in ['remote-input-ready.png','remote-input-qr.png']:
 assert Image.open(out/name).size==(466,466);captures[name]=sha(out/name)
files=['pod.config.json','src/ui/RemoteInputScreen.tsx','src/ui/QRCode.tsx','src/ui/qr-pixels.ts','src/ui/screen.tsx','src/sync/application-actions.ts','src/sync/application-host.ts','tests/remote-input.test.ts','scripts/verification/collect-remote-input-receipt.py']
files.extend(str(p.relative_to(root)) for p in (root/'src/remote-input').glob('*.ts'))
for folder in ['tests/android-remote-input','tests/android-remote-input-phone','tests/runtime-remote-input','tests/runtime-remote-input-bt']:
 files.extend(str(p.relative_to(root)) for p in (root/folder).rglob('*') if p.is_file() and p.suffix in ['.java','.tsx','.json'])
sources={p:sha(root/p) for p in files}
for p in ['packages/framework/package.json','packages/framework/src/bytes.ts','packages/framework/src/services.ts','packages/framework/src/targets.ts','platforms/android/runtime/src/main/cpp/jni_bridge.cpp',*['platforms/android/runtime/src/main/java/dev/podjs/runtime/'+n+'.java' for n in ['PodByteStreamServices','PodServices']]]:sources[str(sdk/p)]=sha(sdk/p)
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'sourceHashes':sources,'appTests':486,'sdkServiceTests':34,'nativeTcpTests':4,'httpProof':http,'bondedBluetoothProof':bt,'captureHashes':captures,'proofHashes':{n:sha(out/n) for n in ['remote-input-http-proof.json','remote-input-bt-watch-proof.json','remote-input-bt-phone-test.log']},'deployedDexAndLibrariesMatchHttpFixture':True,'applicationTablesPreserved':len(before['tables']),'protectedNonDatabaseFilesPreserved':len(non_db(before))-1,'onlyWorkManagerTimestampChanged':True,'mainReadOnlyProbe':proof,'mainProbeUsedAdbRelay':True,'remoteInputHttpEntryMigrated':True,'remoteInputBluetoothMigrated':True,'fixtureCleanup':read('remote-input-runtime-cleanup.json'),'deploymentCleanup':read('remote-input-deploy-cleanup.json'),'wifiLanVerified':False,'nativePhoneUiVerified':False,'physicalGestureAcceptance':False,'nativeUiPixelEqualityVerified':False,'fullMigrationVerified':False}
(out/'remote-input-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:receipt[k] for k in ['installed','appTests','nativeTcpTests','applicationTablesPreserved','protectedNonDatabaseFilesPreserved','fullMigrationVerified']}))
