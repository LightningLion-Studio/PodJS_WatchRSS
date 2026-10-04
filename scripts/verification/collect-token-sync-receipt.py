#!/usr/bin/env python3
"""Bind token export source, native oracle and read-only phone proof to this deployment."""
import datetime,hashlib,json,re,sqlite3,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def read(name):return json.loads((out/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def adb(serial,*args):return subprocess.check_output(['adb','-s',serial,*args],text=True).strip()
installed=read('token-sync-main-installed.json');apk=out/installed['artifact'];assert sha(apk)==installed['sha256']
path=adb(installed['serial'],'shell','pm','path',installed['package']).removeprefix('package:');assert adb(installed['serial'],'shell','sha256sum',path).split()[0]==installed['sha256']
with zipfile.ZipFile(apk) as z,zipfile.ZipFile(out/'ip-recovery-main.apk') as prior:
 assert hashlib.sha256(z.read('assets/main.js')).hexdigest()==sha(sdk/'dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.js')
 assert z.read('assets/main.pak')==prior.read('assets/main.pak')
 for n in prior.namelist():
  if n.endswith('.so'):assert z.read(n)==prior.read(n)
 assert 'net.discovery' in json.loads(z.read('assets/pod.manifest.json'))['capabilities']
for source,digest in read('ip-network-deployment-receipt.json')['sourceHashes'].items():
 if source.startswith(str(sdk)+'/'):assert sha(Path(source))==digest
phone=read('token-sync-phone-installed.json');assert sha(out/phone['artifact'])==phone['sha256']
log=(out/'token-sync-probe-phone.log').read_text();assert 'OK (1 test)' in log
proof=json.loads(re.search(r'ipMainProbeProof=(\{[^\n]+\})',log)[1]);assert proof['authenticated'] and proof['bootstrapAccepted'] and proof['readOnly'] and proof['probes']==2 and proof['adbRelay'] and proof['tokenUsageProbed'] and proof['tokenUsageRequests']==3 and proof['tokenUsageRecords']==0
before=read('token-sync-before.json');after=read('token-sync-after.json');assert before['tables']==after['tables'];assert before['tables']['llm_token_usage']['rows']==0
non_db=lambda d:{k:v for k,v in d['files'].items() if not k.startswith('databases/')}
changed={k for k in non_db(before).keys()|non_db(after).keys() if non_db(before).get(k)!=non_db(after).get(k)};assert changed=={'no_backup/androidx.work.workdb'}
work={}
with tempfile.TemporaryDirectory() as tmp:
 for side in ['before','after']:
  folder=Path(tmp)/side;folder.mkdir()
  with tarfile.open(out/f'token-sync-{side}.tar') as archive:
   for member in archive.getmembers():
    if member.isfile() and (member.name.startswith('no_backup/androidx.work.workdb') or member.name.startswith('databases/podjs.sqlite')):(folder/Path(member.name).name).write_bytes(archive.extractfile(member).read())
  db=sqlite3.connect(folder/'androidx.work.workdb');work[side]={table:db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()}
  assert sqlite3.connect(folder/'podjs.sqlite').execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]==proof['watchId']
assert work['before'].keys()==work['after'].keys()
for table,a in work['before'].items():
 b=work['after'][table]
 if table=='Preference':assert len(a)==len(b)==1 and a[0][0]==b[0][0]=='last_force_stop_ms' and b[0][1]>a[0][1]
 else:assert a==b
assert all(read('token-sync-cleanup.json').values());assert not adb('RFCX70EGH6K','shell','pm','list','packages','dev.podjs.runtime.test')
relay=read('token-sync-relay.json');assert relay['removed'] and not relay['active'];assert adb('RFCX70EGH6K','forward','--list')==relay['forwardBefore'];assert adb('e3aca8af','reverse','--list')==relay['reverseBefore'];assert adb('e3aca8af','shell','settings','get','global','wifi_on')==read('token-sync-phone-before.json')['wifi']
for side in ['before','active','resumed']:assert len(read('token-sync-network-'+side+'.json'))==2
assert read('token-sync-network-stopped.json')==[]
for state in [(out/'token-sync-permissions-before.txt').read_text(),(out/'token-sync-permissions-after.txt').read_text(),adb('e3aca8af','shell','dumpsys','package',installed['package'])]:
 for permission in ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']:assert re.search(r'android.permission.'+permission+r': granted=false',state)
assert 'FATAL EXCEPTION' not in (out/'token-sync-session.log').read_text()
for log,needle in [('token-sync-app-test.log','452 pass'),('token-sync-build.log','pod: built android-watch'),('token-sync-gradle.log','BUILD SUCCESSFUL'),('token-sync-main-gradle.log','BUILD SUCCESSFUL')]:assert needle in (out/log).read_text()
assert (out/'token-sync-typecheck.log').read_text().strip()=='$ tsc --noEmit'
oracle=json.loads((root/'tests/fixtures/token-usage-native.json').read_text());assert len(oracle['cases'])==32 and sha(Path(oracle['source']))==oracle['sourceSha256']
for name,digest in oracle['androidSourceHashes'].items():assert sha(Path('/home/wilf/Android/Sdk/sources/android-36/org/json')/name)==digest
assert any(installed['package']+'/' in line for line in adb('e3aca8af','shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in line)
files=['src/sync/token-usage.ts','src/sync/application-actions.ts','src/sync/application-host.ts','src/services.ts','tests/sync/token-usage.test.ts','tests/fixtures/token-usage-native.json','scripts/reference/capture-token-usage.py','scripts/verification/run-ip-main-probe.py','tests/android-ip-peer/WatchRssIpMainProbeTest.java']
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'installed':installed,'phoneFixture':phone,'proof':proof,'sourceHashes':{p:sha(root/p) for p in files},'appTests':452,'nativeOracleCases':32,'applicationTablesPreserved':len(before['tables']),'nonDatabaseFilesPreserved':len(non_db(before))-1,'workManagerOnlyChange':'Preference.last_force_stop_ms','nativeLibrariesAndAssetsUnchanged':True,'tokenUsageExportDeployed':True,'nonemptyTokenHistoryVerifiedOnDevice':False,'wirelessVerified':False,'fullMigrationVerified':False,'cleanup':read('token-sync-cleanup.json')}
(out/'token-sync-deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:receipt[k] for k in ['appTests','nativeOracleCases','applicationTablesPreserved','nonDatabaseFilesPreserved','tokenUsageExportDeployed','nonemptyTokenHistoryVerifiedOnDevice','wirelessVerified']}))
