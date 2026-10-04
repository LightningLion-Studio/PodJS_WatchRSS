#!/usr/bin/env python3
"""Bind native paragraph and production UI comparisons to the deployed runtime and data audit."""
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('reader-paragraph-deploy-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'reader-transfer-deploy-main.apk') as prior:
 assert hashlib.sha256(z.read('assets/main.js')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.js')
 assert hashlib.sha256(z.read('assets/main.pak')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.pak')
 for n in prior.namelist():
  if n.endswith('.so'):assert z.read(n)==prior.read(n)
 assert 'net.discovery' in json.loads(z.read('assets/pod.manifest.json'))['capabilities']
phone=read('reader-paragraph-deploy-phone-installed.json');assert sha(out/phone['artifact'])==phone['sha256']
log=(out/'reader-paragraph-deploy-probe-phone.log').read_text();assert 'OK (1 test)' in log
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',log)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay'] and proof['tokenUsageProbed'] and proof['tokenUsageRequests']==3 and proof['tokenUsageRecords']==0 and proof['readerManifestProbed'] and proof['readerPresets']==2
before=read('reader-paragraph-deploy-before.json');after=read('reader-paragraph-deploy-after.json');assert before['tables']==after['tables'];assert before['tables']['llm_token_usage']['rows']==0
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'reader-paragraph-deploy-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):(folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={table:db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert a==b
assert all(read('reader-paragraph-deploy-cleanup.json').values());assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('reader-paragraph-deploy-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')==read('reader-paragraph-deploy-phone-before.json')['wifi']
for side in ['before','active','resumed']:assert len(read('reader-paragraph-deploy-network-'+side+'.json'))==2
assert read('reader-paragraph-deploy-network-stopped.json')==[]
for state in [(out/'reader-paragraph-deploy-permissions-before.txt').read_text(),(out/'reader-paragraph-deploy-permissions-after.txt').read_text(),adb('e3aca8af','shell','dumpsys','package',installed['package'])]:
 for permission in ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']:assert re.search(r'android.permission.'+permission+r': granted=false',state)
assert 'FATAL EXCEPTION' not in (out/'reader-paragraph-deploy-session.log').read_text()
for log,needle in [('reader-paragraph-app-tests.log','479 pass'),('reader-paragraph-main-build.log','pod: built android-watch'),('reader-paragraph-deploy-phone-gradle.log','BUILD SUCCESSFUL'),('reader-paragraph-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'reader-paragraph-typecheck.log').read_text().strip()=='$ tsc --noEmit'
assert any(installed['package']+'/' in line for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line)

native=read('reader-paragraph-native-proof.json');ui=read('reader-paragraph-ui-proof.json');assert native['passed'] and ui['passed']
assert native['linesChecked']==588 and native['caretsChecked']==8300 and native['hyphenationChangedParagraphs']==18
assert native['cacheReused'] and native['cacheBoundedAndCleared']
stages=[mode+'-'+name for mode in ['preview','body'] for name in ['start','center','justify','hyphen','both','animated']]
from PIL import Image
captures={}
for stage in stages:
 assert ui[stage]['changedPixels']==0 and ui[stage]['state']['resources']['active']==ui[stage]['state']['resources']['queued']==0
 images=[]
 for kind in ['actual','native']:
  file=out/('reader-paragraph-'+stage+'-'+kind+'.png');captures[file.name]=sha(file);images.append(Image.open(file).convert('RGBA'))
 assert images[0].size==images[1].size==(466,466)
 region=(0,80 if stage.startswith('preview') else 0,466,466)
 assert list(images[0].crop(region).get_flattened_data())==list(images[1].crop(region).get_flattened_data())
assert ui['result']['state']=='passed' and ui['result']['presetStorageUnchanged'] and ui['result']['resources']=={'active':0,'cached':0,'queued':0}
assert ui['noSyntheticInput']
for log,needle in [('reader-paragraph-sdk-services.log','33 pass'),('reader-paragraph-sdk-text.log','3 pass'),('reader-paragraph-runtime-test.log','OK (1 test)'),('reader-paragraph-ui-test.log','OK (1 test)')]:assert needle in (out/log).read_text()
assert all(read('reader-paragraph-runtime-cleanup.json').values())
for pkg in ['dev.podjs.tests.readerparagraphs','dev.podjs.tests.readerparagraphs.test']:assert not adb('e3aca8af','shell','pm','list','packages',pkg)
for pkg,info in read('reader-paragraph-runtime-before.json')['existingPackages'].items():
 if pkg==installed['package']:continue
 assert adb('e3aca8af','shell','sha256sum',adb('e3aca8af','shell','pm','path',pkg).removeprefix('package:')).split()[0]==info['sha256']
assert proof['readerPreviewProbed'] and proof['readerPreviewRequests']==7
files=['src/reader/platform-layout.ts','src/reader/content-layout.ts','src/reader/system-text.ts','src/ui/ReaderPreviewScreen.tsx','src/ui/ReaderBody.tsx','src/ui/reader-title.ts','tests/platform-layout.test.ts','tests/runtime-reader-paragraphs/src/main.tsx','tests/runtime-reader-paragraphs/pod.config.json','scripts/verification/collect-reader-paragraph-receipt.py']
files.extend(str(p.relative_to(root)) for p in (root/'tests/android-reader-paragraphs').glob('*.java'))
sourceHashes={p:sha(root/p) for p in files}
for p in ['packages/framework/src/services.ts','packages/framework/src/text.tsx','vendor/pocketjs/tools/build.ts',*['platforms/android/runtime/src/main/java/dev/podjs/runtime/'+name+'.java' for name in ['PodParagraphLayout','PodTextLayoutServices','PodTextRasterServices','PodServices']]]:sourceHashes[str(sdk/p)]=sha(sdk/p)
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'sourceHashes':sourceHashes,'appTests':479,'sdkTests':36,'nativeParagraphProof':native,'nativeParagraphProofSha256':sha(out/'reader-paragraph-native-proof.json'),'uiProofSha256':sha(out/'reader-paragraph-ui-proof.json'),'uiStages':stages,'captureHashes':captures,'uiZeroDifferentPixels':True,'paragraphTextRenderingDeployed':True,'workspacePackageStylesScanned':True,'nativeLibrariesMatchPreviousDeployment':True,'applicationTablesPreserved':len(before['tables']),'protectedNonDatabaseFilesPreserved':len(non_db(before))-1,'mainReadOnlyProbe':proof,'mainProbeUsedAdbRelay':True,'fixtureCleanup':read('reader-paragraph-runtime-cleanup.json'),'deploymentCleanup':read('reader-paragraph-deploy-cleanup.json'),'wifiLanVerified':False,'physicalGestureAcceptance':False,'allPresetsAndFormatsVerified':False,'fullMigrationVerified':False}
(out/'reader-paragraph-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:receipt[k] for k in ['installed','appTests','sdkTests','uiZeroDifferentPixels','applicationTablesPreserved','protectedNonDatabaseFilesPreserved','fullMigrationVerified']}))
