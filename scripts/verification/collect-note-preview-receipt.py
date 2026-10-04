#!/usr/bin/env python3
from pathlib import Path
import datetime,hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parents[2];out=root/'artifacts'
def read(n):return json.loads((out/n).read_text())
def sha(b):return hashlib.sha256(b).hexdigest()
a=read('note-preview-main-before.json');b=read('note-preview-main-after.json');assert a['tables']==b['tables'];assert {k:v for k,v in a['files'].items() if not k.startswith('databases/')}=={k:v for k,v in b['files'].items() if not k.startswith('databases/')}
g=read('note-preview-guest-kv.json')['note-preview-result'];assert g['state']=='passed' and g['nativeCases']==30 and g['visualAcceptance'] is False
for k in ['thumbnailDecodedAndUploaded','tiledOverviewDecodedAndUploaded','sourceRetainedAcrossUnmounts','detailMounted','ownedRowsAndFilesRemoved']:assert g[k]
native=json.loads((root/'tests/fixtures/note-preview-native.json').read_text());source=root.parent/native['source'];assert sha(source.read_bytes())==native['sourceSha256'];assert sha(source.read_text()[source.read_text().index('internal sealed interface WatchNotePreviewBlock'):].encode())==native['parserSha256']
assert '407 pass' in (out/'note-preview-all-unit.log').read_text() and '0 fail' in (out/'note-preview-all-unit.log').read_text();assert (out/'note-preview-typecheck.log').read_text().strip()=='$ tsc --noEmit'
artifacts={}
for kind,pkg in [('main','com.lightningstudio.watchrss.podjs'),('guest','dev.podjs.tests.syncstate')]:
 data=read(f'note-preview-{kind}-installed.json');apk=out/f'note-preview-{kind}.apk';assert sha(apk.read_bytes())==data['sha256'];assert 'BUILD SUCCESSFUL' in (out/f'note-preview-{kind}-gradle.log').read_text()
 path=subprocess.check_output(['adb','-s','e3aca8af','shell','pm','path',pkg],text=True).strip().removeprefix('package:');assert subprocess.check_output(['adb','-s','e3aca8af','shell','sha256sum',path],text=True).split()[0]==data['sha256']
 with zipfile.ZipFile(apk) as z:data['nativeLibraries']={n:sha(z.read(n)) for n in z.namelist() if n.endswith('.so')}
 artifacts[kind]=data
assert artifacts['main']['nativeLibraries']==artifacts['guest']['nativeLibraries']
resumed=[l.strip() for l in subprocess.check_output(['adb','-s','e3aca8af','shell','dumpsys','activity','activities'],text=True).splitlines() if 'mResumedActivity' in l];assert any('com.lightningstudio.watchrss.podjs/' in l for l in resumed)
sources=['src/notes/preview.ts','src/notes/presentation.ts','src/ui/NotePreview.tsx','src/ui/NotesScreen.tsx','src/ui/RemoteImage.tsx','src/ui/TiledImage.tsx','src/ui/ImagePreviewScreen.tsx','src/ui/screen.tsx','tests/fixtures/note-preview-native.json','tests/runtime-note-preview/main.tsx']
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':artifacts,'tests':{'app':407,'typecheck':'passed','nativePreviewCases':30},'nativeOracle':{'sourceSha256':native['sourceSha256'],'parserSha256':native['parserSha256'],'runtime':native['runtime']},'guest':g,'preservation':{'tables':len(a['tables']),'files':len(a['files']),'allTableDigestsEqual':True,'allNonDatabaseFilesEqual':True},'resumed':resumed,'sourceHashes':{p:sha((root/p).read_bytes()) for p in sources},'limits':['Callbacks establish image decode/upload and retention, not visual acceptance.','Native inline spans, exact preset metrics, table decoration, edit anchor mapping and full gestures remain incomplete or unverified.','Large tables are not row-virtualized.','Paired-phone full synchronization and wider migration remain pending.']}
(out/'note-preview-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'tests':r['tests'],'guest':g,'preservation':r['preservation']},indent=2))
