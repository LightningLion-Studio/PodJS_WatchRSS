#!/usr/bin/env python3
"""Bind physical Bluetooth resource transfer, preset preservation and deployed runtime evidence."""
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('reader-transfer-deploy-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'reader-transfer-app.apk') as prior:
 assert hashlib.sha256(z.read('assets/main.js')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.js')
 assert hashlib.sha256(z.read('assets/main.pak')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.pak')
 for n in prior.namelist():
  if n.endswith('.so'):assert z.read(n)==prior.read(n)
 assert 'net.discovery' in json.loads(z.read('assets/pod.manifest.json'))['capabilities']
for source,digest in read('ip-network-deployment-receipt.json')['sourceHashes'].items():
 if source.startswith(str(sdk)+'/') and source not in [str(sdk/p) for p in ['platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/main/cpp/jni_bridge.cpp','packages/framework/src/services.ts']]:assert sha(Path(source))==digest
phone=read('reader-transfer-deploy-phone-installed.json');assert sha(out/phone['artifact'])==phone['sha256']
log=(out/'reader-transfer-deploy-probe-phone.log').read_text();assert 'OK (1 test)' in log
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',log)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay'] and proof['tokenUsageProbed'] and proof['tokenUsageRequests']==3 and proof['tokenUsageRecords']==0 and proof['readerManifestProbed'] and proof['readerPresets']==2
before=read('reader-transfer-deploy-before.json');after=read('reader-transfer-deploy-after.json');assert before['tables']==after['tables'];assert before['tables']['llm_token_usage']['rows']==0
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'reader-transfer-deploy-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):(folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={table:db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert a==b
assert all(read('reader-transfer-deploy-cleanup.json').values());assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('reader-transfer-deploy-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')==read('reader-transfer-deploy-phone-before.json')['wifi']
for side in ['before','active','resumed']:assert len(read('reader-transfer-deploy-network-'+side+'.json'))==2
assert read('reader-transfer-deploy-network-stopped.json')==[]
for state in [(out/'reader-transfer-deploy-permissions-before.txt').read_text(),(out/'reader-transfer-deploy-permissions-after.txt').read_text(),adb('e3aca8af','shell','dumpsys','package',installed['package'])]:
 for permission in ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']:assert re.search(r'android.permission.'+permission+r': granted=false',state)
assert 'FATAL EXCEPTION' not in (out/'reader-transfer-deploy-session.log').read_text()
for log,needle in [('reader-transfer-app-test.log','477 pass'),('reader-transfer-main-build.log','pod: built android-watch'),('reader-transfer-deploy-phone-gradle.log','BUILD SUCCESSFUL'),('reader-transfer-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'reader-transfer-typecheck.log').read_text().strip()=='$ tsc --noEmit'
oracle=json.loads((root/'tests/fixtures/token-usage-native.json').read_text());assert len(oracle['cases'])==32 and sha(Path(oracle['source']))==oracle['sourceSha256']
for name,digest in oracle['androidSourceHashes'].items():assert sha(Path('/home/wilf/Android/Sdk/sources/android-36/org/json')/name)==digest
assert any(installed['package']+'/' in line for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line)
# The production media/font runtime is unchanged from the native-comparison deployment.
background=read('reader-background-deployment-receipt.json')
for source,digest in background['sourceHashes'].items():assert sha(Path(source) if source.startswith('/') else root/source)==digest
phoneTransfer=read('reader-transfer-phone-proof.json');ui=read('reader-transfer-ui-proof.json')
assert phoneTransfer['passed'] and phoneTransfer['bondedRfcomm'] and not phoneTransfer['adbRelay'] and phoneTransfer['connections']==2
assert all(phoneTransfer[k] for k in ['duplicateFirstChunk','resumedAfterDisconnect','exactPull','peerClosedAfterCompletion']) and phoneTransfer['missingResources']==0
assert all(ui[k] for k in ['passed','targetAbsentUntilComplete','presetStorageUnchanged','resourcesReleased','noSyntheticInput'])
assert ui['partialBytes']==1048576 and ui['fontChangedPixels']>1500 and ui['imageChangedPixels']>10000 and ui['videoChangedPixels']>1000 and ui['handoffChangedPixels']==ui['partialChangedPixels']==0
assert ui['video']['muted'] and ui['video']['frames']>0
mapping={'font':'fonts','background':'backgrounds','variant':'variants'}
for path,value in phoneTransfer['sourceFiles'].items():
 kind,name=path.split('/',1);assert ui['receivedFiles'][mapping[kind]+'/'+name]==value
assert len(phoneTransfer['sourceFiles'])==5
font=read('reader-transfer-font-provenance.json');assert font['fontSha256']==sha(root/'tests/android-reader-transfer-assets/reader-serif.otf')==phoneTransfer['sourceFiles']['font/reader-serif.otf']['sha256']
assert font['subsetTextSourceSha256']==sha(root/font['subsetTextSource'])
assert sha(root/'tests/android-reader-transfer-assets/clip.mp4')==phoneTransfer['sourceFiles']['variant/clip.mp4']['sha256']
for side in ['watch','phone']:assert 'OK (1 test)' in (out/f'reader-transfer-{side}-test.log').read_text()
assert '1 fail' in (out/'reader-transfer-regression-before.log').read_text() and '8 pass' in (out/'reader-transfer-regression-after.log').read_text()
fixture=read('reader-transfer-app-installed.json');assert sha(out/fixture['artifact'])==fixture['sha256']
phoneFixture=read('reader-transfer-phone-installed.json');assert sha(out/phoneFixture['artifact'])==phoneFixture['sha256']
with zipfile.ZipFile(out/phoneFixture['artifact']) as z:
 for name in ['reader-serif.otf','clip.mp4','preset.json']:assert hashlib.sha256(z.read('assets/'+name)).hexdigest()==sha(root/'tests/android-reader-transfer-assets'/name)
initial=read('reader-transfer-main-before.json');isolated=read('reader-transfer-main-after-isolation.json');assert initial['files']==isolated['files'] and initial['tables']==isolated['tables']
cleanup=read('reader-transfer-runtime-cleanup.json');assert cleanup['onlyOwnedPackagesRemoved'] and cleanup['originalPackagesUnchanged'] and cleanup['mainFilesByteExactDuringIsolation']==191 and cleanup['noRelayUsed']
for package in ['dev.podjs.tests.readertransfer','dev.podjs.tests.readertransfer.test']:assert not adb('e3aca8af','shell','pm','list','packages',package)
for package,info in read('reader-transfer-runtime-before.json')['existingPackages'].items():
 if package==installed['package']:continue
 path=adb('e3aca8af','shell','pm','path',package).removeprefix('package:');assert adb('e3aca8af','shell','sha256sum',path).split()[0]==info['sha256']
assert proof['readerPreviewProbed'] and proof['readerPreviewRequests']==7
assert background['installed']['sha256']==read('reader-transfer-runtime-before.json')['existingPackages'][installed['package']]['sha256']
original=read('reader-background-after.json');assert original['tables']==after['tables']
assert {k:v for k,v in non_db(original).items() if k!='no_backup/androidx.work.workdb'}=={k:v for k,v in non_db(after).items() if k!='no_backup/androidx.work.workdb'}
from PIL import Image,ImageChops
captures={}
def changed(a,b):
 aa=Image.open(out/a).convert('RGBA').crop((0,80,466,466));bb=Image.open(out/b).convert('RGBA').crop((0,80,466,466));return sum(x!=y for x,y in zip(aa.get_flattened_data(),bb.get_flattened_data()))
assert changed('reader-transfer-baseline.png','reader-transfer-font.png')==ui['fontChangedPixels']
assert changed('reader-transfer-font.png','reader-transfer-image.png')==ui['imageChangedPixels']
for name in ['handoff','partial']:assert changed('reader-transfer-font.png','reader-transfer-'+name+'.png')==0
for path in out.glob('reader-transfer-*.png'):captures[path.name]=sha(path)
files=['scripts/verification/collect-reader-transfer-receipt.py','src/reader/preset-store.ts','src/sync/reader-actions.ts','src/sync/reader-manifest.ts','src/sync/reader-resources.ts','src/sync/reader-resources-host.ts','src/sync/session.ts','src/sync/application-host.ts','src/sync/application-actions.ts','src/ui/ReaderBackground.tsx','src/ui/ReaderPreviewScreen.tsx','tests/sync/reader-sync.test.ts','tests/fixtures/reader-sync-native.json','tests/runtime-reader-transfer/src/main.tsx','tests/runtime-reader-transfer/pod.config.json','tests/android-reader-transfer-watch/ReaderTransferUiTest.java','tests/android-reader-transfer-watch/ReaderTransferDevice.java','tests/android-reader-transfer-phone/ReaderTransferPhoneTest.java','tests/android-reader-transfer-assets.gradle']
sourceHashes={p:sha(root/p) for p in files};nativePhone=Path('/home/wilf/data/OPPO_Develop/Android_WatchRSS_Phone/app/src/main/java/com/lightningstudio/watchrss/phone/connection/bluetooth/ReaderPresetSyncPayload.kt');sourceHashes[str(nativePhone)]=sha(nativePhone)
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'sourceHashes':sourceHashes,'backgroundRuntimeReceiptSha256':sha(out/'reader-background-deployment-receipt.json'),'appTests':477,'presetRepresentationFixDeployed':True,'originalPrimaryFilesExactDuringIsolation':191,'applicationTablesPreservedAfterDeployment':len(before['tables']),'protectedNonDatabaseFilesPreservedAfterDeployment':len(non_db(before))-1,'watchFixture':fixture,'phoneFixture':phoneFixture,'phoneTransferProof':phoneTransfer,'watchUiProof':ui,'captureHashes':captures,'fontProvenance':font,'renderableReaderAssetsOverBondedBluetoothVerified':True,'resourceTransferUsedAdbRelay':False,'mainReadOnlyProbe':proof,'mainProbeUsedAdbRelay':True,'nativeLibrariesMatchTransferFixture':True,'wifiLanVerified':False,'nativeCompanionUiVerified':False,'allPresetsAndFormatsVerified':False,'physicalGestureAcceptance':False,'fullMigrationVerified':False,'fixtureCleanup':cleanup,'deploymentCleanup':read('reader-transfer-deploy-cleanup.json')}
(out/'reader-transfer-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:receipt[k] for k in ['appTests','presetRepresentationFixDeployed','originalPrimaryFilesExactDuringIsolation','applicationTablesPreservedAfterDeployment','renderableReaderAssetsOverBondedBluetoothVerified','resourceTransferUsedAdbRelay','wifiLanVerified']}))
