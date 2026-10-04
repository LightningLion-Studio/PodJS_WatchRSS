#!/usr/bin/env python3
"""Bind native sharing intents, GPU QR decoding, settings, deployed runtime, and data preservation evidence."""
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('settings-parity-deploy-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'settings-parity-runtime-app.apk') as fixture:
 for n in ['main.js','main.pak']:assert hashlib.sha256(z.read('assets/'+n)).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch'/n)
 for n in fixture.namelist():
  if n.endswith('.so') or n.endswith('.dex'):assert z.read(n)==fixture.read(n),n
 assert 'system.share' in json.loads(z.read('assets/pod.manifest.json'))['capabilities']
 for abi in ['arm64-v8a','armeabi-v7a']:assert b'system.share' in z.read('lib/'+abi+'/libpodjs_android.so')
phone=read('settings-parity-deploy-phone-installed.json');assert sha(out/phone['artifact'])==phone['sha256']
log=(out/'settings-parity-deploy-probe-phone.log').read_text();assert 'OK (1 test)' in log
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',log)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay'] and proof['tokenUsageProbed'] and proof['tokenUsageRequests']==3 and proof['tokenUsageRecords']==0 and proof['readerManifestProbed'] and proof['readerPresets']==2
before=read('settings-parity-deploy-before.json');after=read('settings-parity-deploy-after.json');assert before['tables']==after['tables'];assert before['tables']['llm_token_usage']['rows']==0
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'settings-parity-deploy-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):(folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={table:db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert a==b
assert all(read('settings-parity-deploy-cleanup.json').values());assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('settings-parity-deploy-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')==read('settings-parity-deploy-phone-before.json')['wifi']
for side in ['before','active','resumed']:assert len(read('settings-parity-deploy-network-'+side+'.json'))==2
assert read('settings-parity-deploy-network-stopped.json')==[]
for state in [(out/'settings-parity-deploy-permissions-before.txt').read_text(),(out/'settings-parity-deploy-permissions-after.txt').read_text(),adb('e3aca8af','shell','dumpsys','package',installed['package'])]:
 for permission in ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']:assert re.search(r'android.permission.'+permission+r': granted=false',state)
assert 'FATAL EXCEPTION' not in (out/'settings-parity-deploy-session.log').read_text()
for log,needle in [('share-action-gates-app-tests.log','501 pass'),('settings-parity-main-build.log','pod: built android-watch'),('settings-parity-main-phone-gradle.log','BUILD SUCCESSFUL'),('settings-parity-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'settings-parity-typecheck.log').read_text().strip()=='$ tsc --noEmit'
assert any(installed['package']+'/' in line for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line)

owned=read('settings-parity-owned-installed.json')
for kind,package in [('app','dev.podjs.tests.settingsparity'),('test','dev.podjs.tests.settingsparity.test')]:assert sha(out/f'settings-parity-runtime-{kind}.apk')==owned[package]
sharing=read('settings-parity-native-proof.json');assert sharing['passed'] and len(sharing['cases'])==18 and sharing['qrDecodedCases']==6 and sharing['bridgeDispatchVerified'] and sharing['cancelledBeforeLaunchVerified'] and not sharing['recipientSelected']
ui=read('settings-parity-ui-proof.json');assert ui['state']=='passed' and ui['unsupportedRowHidden'] and ui['qrDecodedFromGpuFrame'] and len(ui['captured'])==7
for log,needle in [('system-share-sdk-services.log','32 pass'),('settings-parity-native-test.log','OK (2 tests)')]:assert needle in (out/log).read_text()
cleanup=read('settings-parity-runtime-cleanup.json');assert cleanup['originalHashesUnchanged'] and cleanup['ownedPackagesRemoved'];assert not adb('e3aca8af','shell','pm','list','packages','dev.podjs.tests.settingsparity')
for pkg,info in read('settings-parity-runtime-before.json')['existingPackages'].items():
 if pkg!=installed['package']:assert adb('e3aca8af','shell','sha256sum',adb('e3aca8af','shell','pm','path',pkg).removeprefix('package:')).split()[0]==info['sha256']
for package,digest in read('settings-parity-deploy-phone-originals.json').items():assert adb('RFCX70EGH6K','shell','sha256sum',adb('RFCX70EGH6K','shell','pm','path',package).removeprefix('package:')).split()[0]==digest
assert proof['readerPreviewProbed'] and proof['readerPreviewRequests']==7
from PIL import Image
captures={}
for stage in ui['captured']:
 name='settings-parity-'+stage+'.png';assert Image.open(out/name).size==(466,466);captures[name]=sha(out/name)
files=['src/ui/ShareQrScreen.tsx','src/ui/QRCode.tsx','src/ui/qr-pixels.ts','src/ui/SettingsScreen.tsx','src/ui/RssScreens.tsx','src/ui/bili/index.tsx','src/ui/douyin/index.tsx','src/ui/screen.tsx','tests/system-share.test.ts','scripts/verification/collect-settings-parity-receipt.py','scripts/verification/generate-system-share-cases.ts']
files.extend(str(p.relative_to(root)) for p in (root/'src/sharing').glob('*.ts'))
for folder in ['tests/android-settings-parity','tests/runtime-settings-parity','tests/system-share-assets']:
 files.extend(str(p.relative_to(root)) for p in (root/folder).rglob('*') if p.is_file() and p.suffix in ['.java','.tsx','.json','.rgba'])
sources={p:sha(root/p) for p in files}
for p in ['packages/framework/src/services.ts','packages/framework/src/targets.ts','packages/framework/tests/services.test.ts','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodSharingServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/main/cpp/jni_bridge.cpp']:sources[str(sdk/p)]=sha(sdk/p)
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'sourceHashes':sources,'appTests':501,'sdkServiceTests':32,'nativeRuntimeTests':2,'nativeSharingProof':sharing,'uiProof':ui,'captureHashes':captures,'deployedDexAndLibrariesMatchFixture':True,'applicationTablesPreserved':len(before['tables']),'protectedNonDatabaseFilesPreserved':len(non_db(before))-1,'onlyWorkManagerTimestampChanged':True,'mainReadOnlyProbe':proof,'mainProbeUsedAdbRelay':True,'settingsPlaceholdersRemoved':True,'settingsBeianFooterDeployed':True,'settingsFooterNavigationEndToEndVerified':False,'wholeSettingsPagePixelEqualityVerified':False,'shareButtonKotlinWhitespaceGateDeployed':True,'systemShareRoutingDeployed':True,'unicodeQrSharingDeployed':True,'qrGpuFrameDecodeVerified':True,'qrDecoderCharsetHint':'UTF-8','crossScannerCharsetDetectionVerified':False,'systemShareSettingDeviceGateVerified':True,'supportedSettingUiUsesInjectedSupport':True,'fixtureCleanup':cleanup,'deploymentCleanup':read('settings-parity-deploy-cleanup.json'),'realChooserUiVerified':False,'actionPageReturnEndToEndVerified':False,'nativeUiPixelEqualityVerified':False,'physicalGestureAcceptance':False,'fullMigrationVerified':False}
(out/'settings-parity-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:receipt[k] for k in ['installed','appTests','nativeRuntimeTests','applicationTablesPreserved','protectedNonDatabaseFilesPreserved','fullMigrationVerified']}))
