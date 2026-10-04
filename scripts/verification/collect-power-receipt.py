#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts'
def read(n):return json.loads((out/n).read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
def watch(*a):return subprocess.check_output(['adb','-s','e3aca8af',*a],text=True).strip()
guest=read('power-background-guest-kv.json')['application-power-result'];assert guest['state']=='passed' and not guest['errors']
for k in ['appliedAckReceived','activeDisplayAndAudio','backgroundTransfer','screenReleasedAfterProbe','mediaHandoffGrace','disposedResources','articleRowsUnchanged']:assert guest[k] is True
assert guest['closedListeners']>0 and guest['testResponseAckTimeoutMs']==30000
for n in ['power-main-phone-probe.log','power-background-phone-probe.log']:assert 'OK (1 test)' in (out/n).read_text()
assert 'OK (2 tests)' in (out/'power-native-tests.log').read_text()
for n,count in [('power-all-unit.log',396),('power-framework-tests.log',61)]:s=(out/n).read_text();assert f'{count} pass' in s and '0 fail' in s
assert (out/'power-app-typecheck.log').read_text().strip()=='$ tsc --noEmit'
for n in ['power-main-gradle.log','power-background-guest-gradle.log']:assert 'BUILD SUCCESSFUL' in (out/n).read_text()
artifacts={}
for kind,apk in [('main','power-main.apk'),('background-guest','power-guest.apk'),('host-test','power-host-test.apk'),('phone-test','power-peer-test.apk')]:
 data=(out/apk).read_bytes();installed=read(f'power-{kind}-installed.json');assert sha(data)==installed['sha256'];artifacts[kind]={'file':apk,**installed}
 for_live=kind in ['main','background-guest']
 if for_live:
  path=watch('shell','pm','path',installed['package']).removeprefix('package:');assert watch('shell','sha256sum',path).split()[0]==installed['sha256']
for kind in ['main','background-guest']:
 with zipfile.ZipFile(out/artifacts[kind]['file']) as z:artifacts[kind]['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
assert artifacts['main']['nativeLibraries']==artifacts['background-guest']['nativeLibraries']
a=read('power-main-before.json');b=read('power-main-after.json');assert a['tables']==b['tables']
assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
probe=json.loads(re.search(r'probeResponse=(\{[^\n]+\})',(out/'power-main-phone-probe.log').read_text())[1])
with tarfile.open(out/'power-main-before.tar') as t,tempfile.TemporaryDirectory() as tmp:
 for m in t.getmembers():
  if m.isfile() and m.name.startswith('databases/'):Path(tmp,Path(m.name).name).write_bytes(t.extractfile(m).read())
 db=sqlite3.connect(str(Path(tmp)/'podjs.sqlite'));identity=db.execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0];assert identity==probe['deviceId']
def window(n):
 s=(out/n).read_text();blocks=re.split(r'(?=  Window #\d+)',s);return next(x for x in blocks if 'Window{' in x and 'com.lightningstudio.watchrss.podjs/dev.podjs.androidwatch.MainActivity' in x.splitlines()[0])
assert 'KEEP_SCREEN_ON' in window('power-main-probe-window.txt') and 'KEEP_SCREEN_ON' not in window('power-main-after-probe-window.txt')
pid=watch('shell','pidof','com.lightningstudio.watchrss.podjs');resumed=[l.strip() for l in watch('shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in l];assert pid and any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
sources=['src/sync/application-foreground.ts','src/sync/application-host.ts','src/main.tsx','tests/runtime-application-power/main.tsx','tests/android-power-peer/WatchRssPowerPeerTest.java']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'tests':{'app':396,'framework':61,'native':2,'typecheck':'passed'},'background':guest,'backgroundSwitch':read('power-background-switch.json'),'mainProbe':probe,'mainIdentityMatchesBeforeDatabase':True,'mainWindowFlagDuringProbe':True,'mainWindowFlagClearedAfterProbe':True,'dataPreservation':{'files':len(a['files']),'tables':len(a['tables']),'allTableDigestsEqual':True,'allNonDatabaseFilesEqual':True,'beforeArchiveSha256':a['archiveSha256'],'afterArchiveSha256':b['archiveSha256']},'main':{'pid':pid,'resumed':resumed},'sourceHashes':{n:sha((root/n).read_bytes()) for n in sources},'limits':['Read-only probe, not full article exchange; actual main library empty.','Background test alone uses 30-second ACK timeout with a 15-second peer delay; production default remains 10 seconds.','Initial background result without ACK assertion is invalid and retained separately.','IP upgrade, non-library actions, reader assets/presets, Android 12+ permission UI, physical screen-off and visual parity remain pending.']}
(out/'power-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'background':guest,'dataPreservation':r['dataPreservation'],'main':r['main']},indent=2))
