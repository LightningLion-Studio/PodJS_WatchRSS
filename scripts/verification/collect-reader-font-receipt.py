#!/usr/bin/env python3
"""Bind font rendering, native preview pixels and data preservation to the installed build."""
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('reader-font-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'reader-font-runtime-app.apk') as prior:
 assert hashlib.sha256(z.read('assets/main.js')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.js')
 assert hashlib.sha256(z.read('assets/main.pak')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.pak')
 for n in prior.namelist():
  if n.endswith('.so'):assert z.read(n)==prior.read(n)
 assert 'net.discovery' in json.loads(z.read('assets/pod.manifest.json'))['capabilities']
for source,digest in read('ip-network-deployment-receipt.json')['sourceHashes'].items():
 if source.startswith(str(sdk)+'/') and source not in [str(sdk/'platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java'),str(sdk/'packages/framework/src/services.ts')]:assert sha(Path(source))==digest
phone=read('reader-font-phone-installed.json');assert sha(out/phone['artifact'])==phone['sha256']
log=(out/'reader-font-probe-phone.log').read_text();assert 'OK (1 test)' in log
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',log)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay'] and proof['tokenUsageProbed'] and proof['tokenUsageRequests']==3 and proof['tokenUsageRecords']==0 and proof['readerManifestProbed'] and proof['readerPresets']==2
before=read('reader-font-before.json');after=read('reader-font-after.json');assert before['tables']==after['tables'];assert before['tables']['llm_token_usage']['rows']==0
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'reader-font-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):(folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={table:db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert a==b
assert all(read('reader-font-cleanup.json').values());assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('reader-font-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')==read('reader-font-phone-before.json')['wifi']
for side in ['before','active','resumed']:assert len(read('reader-font-network-'+side+'.json'))==2
assert read('reader-font-network-stopped.json')==[]
for state in [(out/'reader-font-permissions-before.txt').read_text(),(out/'reader-font-permissions-after.txt').read_text(),adb('e3aca8af','shell','dumpsys','package',installed['package'])]:
 for permission in ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']:assert re.search(r'android.permission.'+permission+r': granted=false',state)
assert 'FATAL EXCEPTION' not in (out/'reader-font-session.log').read_text()
for log,needle in [('reader-font-app-test.log','471 pass'),('reader-font-main-build.log','pod: built android-watch'),('reader-font-phone-gradle.log','BUILD SUCCESSFUL'),('reader-font-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'reader-font-typecheck.log').read_text().strip()=='$ tsc --noEmit'
oracle=json.loads((root/'tests/fixtures/token-usage-native.json').read_text());assert len(oracle['cases'])==32 and sha(Path(oracle['source']))==oracle['sourceSha256']
for name,digest in oracle['androidSourceHashes'].items():assert sha(Path('/home/wilf/Android/Sdk/sources/android-36/org/json')/name)==digest
assert any(installed['package']+'/' in line for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line)
files=['src/reader/font-assets.ts','src/reader/platform-layout.ts','src/reader/platform-title.ts','src/reader/measured-text.ts','src/reader/preset.ts','src/reader/system-text.ts','src/reader/speech-highlight-layout.ts','src/ui/reader-fonts.ts','src/ui/reader-title.ts','src/ui/ReaderBody.tsx','src/ui/ReaderScreen.tsx','src/ui/ReaderPreviewScreen.tsx','tests/reader-fonts.test.ts','tests/runtime-reader-fonts/src/main.tsx','tests/runtime-reader-fonts/pod.config.json','tests/android-reader-fonts/ReaderFontUiTest.java','tests/android-reader-fonts/ReaderFontNativeTest.java','tests/android-reader-fonts/ReaderNativePreviewReference.java']
sdkFiles=['packages/framework/src/services.ts','packages/framework/src/text.tsx','packages/framework/tests/services.test.ts','packages/framework/tests/system-text.isolated.ts','crates/podjs-runtime/src/lib.rs','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodFontServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodTextLayoutServices.java','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodTextRasterServices.java','platforms/android/runtime/src/main/cpp/gpu_draw_list.cpp','platforms/android/runtime/src/main/cpp/gpu_draw_list_test.cpp']
for folder in ['vendor/pocketjs/engine/core/src','vendor/pocketjs/contracts/spec']:
 sdkFiles += [str(p.relative_to(sdk)) for p in (sdk/folder).rglob('*') if p.is_file() and p.suffix in ['.rs','.ts']]
native=read('reader-font-native-proof.json');assert len(native['cases'])==9 and all(c['pixelExact'] for c in native['cases']) and native['customCasesDifferFromSystem']>=4
assert all(native[k] for k in ['replacementInvalidatesCache','pathEscapeRejected','decoratedPixelsExact']) and native['largestLineHeightPx']==960 and native['largestFontSizePx']==320
runtime=read('reader-font-ui-proof.json');assert runtime['result']['state']=='passed' and runtime['result']['presetStorageUnchanged'] and all(v==0 for v in runtime['result']['systemTextResources'].values())
assert runtime['noSyntheticInput'] and runtime['transferChangedPixels']==0 and runtime['missingFontChangedPixels']==0
for kind in ['system','serif']:assert runtime['preview-'+kind+'NativeChangedPixels']==0
assert runtime['previewChangedPixels']>1500 and runtime['articleChangedPixels']>1500
fixture=read('reader-font-runtime-app-installed.json');assert sha(out/fixture['artifact'])==fixture['sha256'];assert all(read('reader-font-runtime-cleanup.json').values())
for package in ['dev.podjs.tests.readerfonts','dev.podjs.tests.readerfonts.test']:assert not adb('e3aca8af','shell','pm','list','packages',package)
assert 'OK (2 tests)' in (out/'reader-font-runtime-test.log').read_text()
for filename,needle in [('reader-font-text-lifecycle-test.log','3 pass'),('reader-font-sdk-services-test.log','29 pass'),('reader-font-subpixel-core-test.log','153 passed'),('reader-font-sdk-rust-test.log','test result: ok.')]:assert needle in (out/filename).read_text()
gpu=read('reader-font-gpu-test.json');assert gpu['passed'] and gpu['exitCode']==0
for source,digest in gpu['sourceHashes'].items():assert sha(Path(source))==digest
from PIL import Image,ImageChops
captures={}
for kind in ['system','serif']:
 actual=out/('reader-font-preview-'+kind+'.png');expected=out/('reader-font-native-preview-'+kind+'.png')
 a=Image.open(actual).convert('RGBA');b=Image.open(expected).convert('RGBA');assert a.size==b.size==(466,466)
 assert ImageChops.difference(a.crop((0,80,466,466)).convert('RGB'),b.crop((0,80,466,466)).convert('RGB')).getbbox() is None
 captures[actual.name]=sha(actual);captures[expected.name]=sha(expected)
assert proof['readerPreviewProbed'] and proof['readerPreviewRequests']==7
original=read('reader-preview-after.json');assert original['tables']==after['tables']
assert {k:v for k,v in non_db(original).items() if k!='no_backup/androidx.work.workdb'}=={k:v for k,v in non_db(after).items() if k!='no_backup/androidx.work.workdb'}
for package,info in read('reader-font-runtime-before.json')['existingPackages'].items():
 if package==installed['package']:continue
 path=adb('e3aca8af','shell','pm','path',package).removeprefix('package:');assert adb('e3aca8af','shell','sha256sum',path).split()[0]==info['sha256']
assert native['nativeReferenceApkSha256']==read('reader-font-runtime-before.json')['existingPackages']['com.lightningstudio.watchrss.reference']['sha256']
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'phoneFixture':phone,'proof':proof,'sourceHashes':{**{p:sha(root/p) for p in files},**{str(sdk/p):sha(sdk/p) for p in sdkFiles}},'appTests':471,'textLifecycleTests':3,'sdkServicesTests':29,'pocketCoreTests':153,'watchRuntimeFixture':fixture,'watchRuntimeProof':runtime,'nativeFontProof':native,'nativeComparisonImageHashes':captures,'gpuDecoderProof':gpu,'readerCustomFontsDeployed':True,'nativePreviewParagraphPixelsExact':{'profiles':['default-system','NotoSerifCJK-face0'],'width':466,'height':466,'comparedRegion':{'x':0,'y':80,'width':466,'height':386},'pixelsPerProfile':179876,'allPresetsOrDevicesVerified':False},'noAdditionalTextTempFiles':True,'applicationTablesPreserved':len(before['tables']),'nonDatabaseFilesPreserved':len(non_db(before))-1,'workManagerOnlyChange':'Preference.last_force_stop_ms','nativeLibrariesMatchVerifiedFontFixture':True,'readerResourcePhoneTransportVerified':False,'imageVideoBackgroundRenderingVerified':False,'wirelessVerified':False,'fullMigrationVerified':False,'cleanup':read('reader-font-cleanup.json')}
(out/'reader-font-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:receipt[k] for k in ['appTests','applicationTablesPreserved','nonDatabaseFilesPreserved','readerCustomFontsDeployed','nativePreviewParagraphPixelsExact','wirelessVerified']}))
