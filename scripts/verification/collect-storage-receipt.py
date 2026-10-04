#!/usr/bin/env python3
"""Collect the storage increment only after its device harness has completed."""
from pathlib import Path
import datetime,hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts';sdk=Path('/home/wilf/data/PodJS/podjs-watch')
def sha(data):return hashlib.sha256(data).hexdigest()
def adb(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args])
result=json.loads((out/'storage-guest-kv.json').read_text())['storage-guest-result']
assert result['state']=='passed',result
assert '390 pass' in (out/'storage-all-unit.log').read_text() and '0 fail' in (out/'storage-all-unit.log').read_text()
assert (out/'storage-typecheck.log').read_text().strip()=='$ tsc --noEmit'
assert 'BUILD SUCCESSFUL' in (out/'storage-main-gradle.log').read_text()
assert 'BUILD SUCCESSFUL' in (out/'storage-guest-text-gradle.log').read_text()
guestInstalled=json.loads((out/'storage-guest-installed.json').read_text());assert guestInstalled['sha256']==guestInstalled['installedSha256']==sha((out/'storage-guest.apk').read_bytes())
for flag in ['productionFactory','oversizedQueryRejected','inlineBody','chunkBody','originalBody','nulAndSupplementaryText','metadataOnlyReceive','replacement']:assert result[flag] is True
oracle=json.loads((out/'storage-oracle-kv.json').read_text())['library-repository-result'];assert oracle['state']=='passed'
assert [oracle[k] for k in ['nativeSources','nativeDeletions','nativeReplacements']]==[16,13,6]
cleanup=json.loads((out/'storage-guest-cleanup.json').read_text());assert not any(cleanup['counts'].values()) and not cleanup['remainingBodyFiles']
packages={}
for package,artifact in [('com.lightningstudio.watchrss.podjs','storage-main.apk'),('dev.podjs.tests.syncstate','storage-oracle.apk')]:
 path=adb('shell','pm','path',package).decode().strip().removeprefix('package:');digest=sha((out/artifact).read_bytes());assert adb('shell','sha256sum',path).decode().split()[0]==digest
 with zipfile.ZipFile(out/artifact) as z:
  assets={name:sha(z.read(next(k for k in z.namelist() if k.endswith('/'+name)))) for name in ['main.js','main.pak']}
 packages[package]={'artifact':artifact,'sha256':digest,'installedPath':path,'assets':assets}
before=json.loads((out/'storage-main-before.json').read_text());after=json.loads((out/'storage-main-after.json').read_text())
changedTables=[k for k,v in before['tables'].items() if after['tables'].get(k)!=v]
changedFiles=[k for k,v in before['files'].items() if not k.startswith('databases/') and after['files'].get(k)!=v]
assert not changedTables,changedTables
assert not changedFiles,changedFiles
comparison={'beforeArchiveSha256':before['archiveSha256'],'afterArchiveSha256':after['archiveSha256'],'existingFileCount':len(before['files']),'existingTableCount':len(before['tables']),'changedExistingTables':changedTables,'changedExistingNonDatabaseFiles':changedFiles,'addedTables':sorted(set(after['tables'])-set(before['tables'])),'limitation':'The actual main library was empty; populated behavior is covered separately by the isolated fixture.'}
(out/'storage-main-data-comparison.json').write_text(json.dumps(comparison,indent=2)+'\n')
pid=adb('shell','pidof','com.lightningstudio.watchrss.podjs').decode().strip();assert pid
resumed=[l.strip() for l in adb('shell','dumpsys','activity','activities').decode().splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
files=['src/sync/sql-text.ts','src/sync/local-manifest.ts','src/sync/article-receiver.ts','src/sync/deletion-store.ts','src/sync/source-store.ts','src/sync/library-repository.ts','src/services.ts','src/core/repository.ts','src/reader/original-cache.ts','src/sync/protocol.ts','tests/runtime-storage/main.tsx','tests/sync/sql-text.test.ts','docs/sync-storage.md']
receipt={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'serial':'e3aca8af','packages':packages,'guest':result,'guestCleanup':cleanup,'guestHistoricalInstall':guestInstalled,'oracle':oracle,'tests':{'application':390,'assertions':46512,'typecheck':'passed'},'dataPreservation':comparison,'main':{'pid':pid,'resumed':resumed},'sourceHashes':{f:sha((root/f).read_bytes()) for f in files},'limitations':['Full repository is not wired into main radio/IP sessions.','Elapsed device time is whole fixture time, not throughput.','Separate oracle harness replays 35 captured native cases; native implementation itself was not rerun in this increment.','The guest APK predates the independent RSS surrogate-boundary fix; main APK includes it.','Physical interaction, visual parity, power lifecycle and offline media remain pending.']}
(out/'storage-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'guest':result,'dataPreservation':comparison,'mainSha256':packages['com.lightningstudio.watchrss.podjs']['sha256']},indent=2))
