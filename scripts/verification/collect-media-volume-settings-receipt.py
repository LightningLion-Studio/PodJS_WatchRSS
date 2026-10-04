#!/usr/bin/env python3
"""Bind deployed settings controls to native option policy and isolated UI captures."""
import datetime,hashlib,json,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';prefix='media-volume-settings';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args],text=True).strip()
installed=read(prefix+'-deploy-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
assert adb('shell','sha256sum',adb('shell','pm','path',installed['package']).removeprefix('package:')).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'reader-paragraph-deploy-main.apk') as old:
 for name in old.namelist():
  if name.endswith('.so') or name.endswith('.dex'):assert z.read(name)==old.read(name),name
 for name in ['main.js','main.pak']:assert hashlib.sha256(z.read('assets/'+name)).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch'/name)
proof=read(prefix+'-volume-ui-proof.json');assert proof['passed'] and proof['noSyntheticInput'];assert len(proof['nativePolicyCases'])==25
stages=['control-on','control-off','guard-unavailable','guard-on','guard-off','unlimited','mute','ten','hundred']
from PIL import Image
captures={}
for stage in stages:
 assert proof[stage]['stage']==stage and proof[stage]['state']=='running'
 path=out/(prefix+'-volume-'+stage+'.png');assert Image.open(path).size==(466,466);captures[path.name]=sha(path)
assert proof['guard-unavailable']['settings']['mediaVolumeGuard'] and not proof['guard-unavailable']['settings']['mediaVolumeControl']
assert proof['result']['state']=='passed'
for suffix,needle in [('tests.log','481 pass'),('ui-test.log','OK (1 test)'),('main-build.log','pod: built android-watch'),('main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/(prefix+'-'+suffix)).read_text()
assert (out/(prefix+'-typecheck.log')).read_text().strip()=='$ tsc --noEmit'
before=read(prefix+'-deploy-before.json');after=read(prefix+'-deploy-after.json');assert before['tables']==after['tables']
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed<= {'no_backup/androidx.work.workdb'},changed
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'{prefix}-deploy-{side}.tar') as archive:
   for m in archive.getmembers():
    if m.isfile() and m.name.startswith('no_backup/androidx.work.workdb'):(folder/Path(m.name).name).write_bytes(archive.extractfile(m).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={t:db.execute('SELECT * FROM "'+t.replace('"','""')+'" ORDER BY rowid').fetchall() for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>=a[0][1]
 else:assert a==b
assert all(read(prefix+'-runtime-cleanup.json').values()) and all(read(prefix+'-deploy-cleanup.json').values())
assert not adb('shell','pm','list','packages','dev.podjs.tests.volumesettings')
for pkg,info in read(prefix+'-runtime-before.json')['existingPackages'].items():
 if pkg!=installed['package']:assert adb('shell','sha256sum',adb('shell','pm','path',pkg).removeprefix('package:')).split()[0]==info['sha256']
assert any(installed['package']+'/' in l for l in adb('shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in l)
files=['src/ui/SettingsScreen.tsx','src/ui/media-volume-settings.tsx','src/media/start-volume.ts','src/settings/store.ts','tests/start-volume.test.ts','tests/settings.test.ts','tests/runtime-media-volume-settings/src/main.tsx','tests/runtime-media-volume-settings/pod.config.json','tests/android-media-volume-settings/VolumeSettingsUiTest.java','scripts/verification/collect-media-volume-settings-receipt.py']
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'sourceHashes':{p:sha(root/p) for p in files},'appTests':481,'nativePolicyCases':25,'nativePolicyOutputs':75,'productionUiCaptureStates':9,'captureHashes':captures,'uiProofSha256':sha(out/(prefix+'-volume-ui-proof.json')),'nativeCodeUnchanged':True,'applicationTablesPreserved':len(before['tables']),'protectedNonDatabaseFilesPreserved':len(non_db(before))-1,'onlyWorkManagerTimestampChanged':True,'settingsControlsDeployed':True,'systemVolumeChangedByTest':False,'physicalGestureAcceptance':False,'nativeUiPixelEqualityVerified':False,'remoteInputHttpEntryMigrated':False,'fullMigrationVerified':False}
(out/(prefix+'-deployment-receipt.json')).write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:receipt[k] for k in ['installed','appTests','nativePolicyCases','applicationTablesPreserved','protectedNonDatabaseFilesPreserved','fullMigrationVerified']}))
