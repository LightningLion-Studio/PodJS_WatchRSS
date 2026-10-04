#!/usr/bin/env python3
"""Bind persistent cache, native policy, image, and settings evidence to the deployed runtime and data audit."""
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('managed-cache-deploy-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'managed-cache-runtime-app.apk') as fixture:
 for n in ['main.js','main.pak']:assert hashlib.sha256(z.read('assets/'+n)).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch'/n)
 for n in fixture.namelist():
  if n.endswith('.so') or n.endswith('.dex'):assert z.read(n)==fixture.read(n),n
 assert 'data.files.chunks' in json.loads(z.read('assets/pod.manifest.json'))['capabilities']
 for abi in ['arm64-v8a','armeabi-v7a']:assert b'net.tcp' in z.read('lib/'+abi+'/libpodjs_android.so')
phone=read('managed-cache-deploy-phone-installed.json');assert sha(out/phone['artifact'])==phone['sha256']
log=(out/'managed-cache-deploy-probe-phone.log').read_text();assert 'OK (1 test)' in log
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',log)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay'] and proof['tokenUsageProbed'] and proof['tokenUsageRequests']==3 and proof['tokenUsageRecords']==0 and proof['readerManifestProbed'] and proof['readerPresets']==2
before=read('managed-cache-deploy-before.json');after=read('managed-cache-deploy-after.json');assert before['tables']==after['tables'];assert before['tables']['llm_token_usage']['rows']==0
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'managed-cache-deploy-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):(folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={table:db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert a==b
assert all(read('managed-cache-deploy-cleanup.json').values());assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('managed-cache-deploy-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')==read('managed-cache-deploy-phone-before.json')['wifi']
for side in ['before','active','resumed']:assert len(read('managed-cache-deploy-network-'+side+'.json'))==2
assert read('managed-cache-deploy-network-stopped.json')==[]
for state in [(out/'managed-cache-deploy-permissions-before.txt').read_text(),(out/'managed-cache-deploy-permissions-after.txt').read_text(),adb('e3aca8af','shell','dumpsys','package',installed['package'])]:
 for permission in ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']:assert re.search(r'android.permission.'+permission+r': granted=false',state)
assert 'FATAL EXCEPTION' not in (out/'managed-cache-deploy-session.log').read_text()
for log,needle in [('managed-cache-app-tests.log','495 pass'),('managed-cache-main-build.log','pod: built android-watch'),('managed-cache-main-phone-gradle.log','BUILD SUCCESSFUL'),('managed-cache-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'managed-cache-typecheck.log').read_text().strip()=='$ tsc --noEmit'
assert any(installed['package']+'/' in line for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line)

for kind in ['app','test']:
 fixtureReceipt=read('managed-cache-runtime-'+kind+'-installed.json');assert sha(out/fixtureReceipt['artifact'])==fixtureReceipt['sha256']
cache=read('managed-cache-proof.json');assert cache['passed'] and cache['activityReopenReusedDisk'] and cache['imageRegionEqual'] and cache['pendingDownloadsCancelled'] and cache['corruptCacheRepaired']
assert len(cache['nativePolicy']['evictions'])==10 and len(cache['nativePolicy']['labels'])==9 and len(cache['nativePolicy']['prefetch'])==3
assert cache['firstRun']['offlinePreserved'] and cache['firstRun']['readerAssetPreserved'] and cache['firstRun']['leaseProtected'] and cache['firstRun']['evictionAfterRelease']
assert cache['firstRun']['resources']==cache['warmRun']['resources']=={'active':0,'cached':0,'queued':0}
assert cache['httpRequests']=={'/0.png':4,'/1.png':1,'/2.png':1,'/3.png':1,'/4.png':1,'/5.png':1,'/slow0':1,'/slow1':1}
for log,needle in [('managed-cache-sdk-services.log','34 pass'),('managed-cache-ui-test.log','OK (2 tests)')]:assert needle in (out/log).read_text()
assert all(read('managed-cache-runtime-cleanup.json').values());assert not adb('e3aca8af','shell','pm','list','packages','dev.podjs.tests.managedcache')
for pkg,info in read('managed-cache-runtime-before.json')['existingPackages'].items():
 if pkg!=installed['package']:assert adb('e3aca8af','shell','sha256sum',adb('e3aca8af','shell','pm','path',pkg).removeprefix('package:')).split()[0]==info['sha256']
for package,digest in read('managed-cache-deploy-phone-originals.json').items():assert adb('RFCX70EGH6K','shell','sha256sum',adb('RFCX70EGH6K','shell','pm','path',package).removeprefix('package:')).split()[0]==digest
assert proof['readerPreviewProbed'] and proof['readerPreviewRequests']==7
from PIL import Image
captures={}
for stage in ['cold-image','tiled-image','warm-image','repaired-image','cache-min','cache-max','media-off','media-four','media-all','keep-off','keep-on']:
 name='managed-cache-cache-'+stage+'.png';assert Image.open(out/name).size==(466,466);captures[name]=sha(out/name)
a=Image.open(out/'managed-cache-cache-cold-image.png').convert('RGBA');b=Image.open(out/'managed-cache-cache-warm-image.png').convert('RGBA');region=(132,132,332,332);assert list(a.crop(region).get_flattened_data())==list(b.crop(region).get_flattened_data())
files=['src/ui/RemoteImage.tsx','src/ui/TiledImage.tsx','src/ui/ReaderBody.tsx','src/ui/ReaderScreen.tsx','src/ui/SettingsScreen.tsx','src/ui/advanced-cache-settings.tsx','src/ui/screen.tsx','tests/managed-cache.test.ts','tests/image.isolated.ts','scripts/verification/collect-managed-cache-receipt.py']
files.extend(str(p.relative_to(root)) for p in (root/'src/cache').glob('*.ts'))
for folder in ['tests/android-managed-cache','tests/runtime-managed-cache']:
 files.extend(str(p.relative_to(root)) for p in (root/folder).rglob('*') if p.is_file() and p.suffix in ['.java','.tsx','.json'])
sources={p:sha(root/p) for p in files}
for p in ['packages/framework/src/services.ts','packages/framework/tests/services.test.ts','platforms/android/runtime/src/main/java/dev/podjs/runtime/PodDeviceServices.java']:sources[str(sdk/p)]=sha(sdk/p)
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'sourceHashes':sources,'appTests':495,'sdkServiceTests':34,'nativeRuntimeTests':2,'cacheProof':cache,'captureHashes':captures,'proofSha256':sha(out/'managed-cache-proof.json'),'deployedDexAndLibrariesMatchFixture':True,'applicationTablesPreserved':len(before['tables']),'protectedNonDatabaseFilesPreserved':len(non_db(before))-1,'onlyWorkManagerTimestampChanged':True,'mainReadOnlyProbe':proof,'mainProbeUsedAdbRelay':True,'persistentImageCacheDeployed':True,'inlineImagePrefetchDeployed':True,'cacheAndKeepAliveControlsDeployed':True,'fixtureCleanup':read('managed-cache-runtime-cleanup.json'),'deploymentCleanup':read('managed-cache-deploy-cleanup.json'),'nativeUiPixelEqualityVerified':False,'physicalGestureAcceptance':False,'videoCacheProducersMigrated':False,'manualCacheClearMigrated':False,'systemShareSettingMigrated':False,'fullMigrationVerified':False}
(out/'managed-cache-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:receipt[k] for k in ['installed','appTests','nativeRuntimeTests','applicationTablesPreserved','protectedNonDatabaseFilesPreserved','fullMigrationVerified']}))
