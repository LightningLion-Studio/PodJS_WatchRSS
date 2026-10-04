#!/usr/bin/env python3
from pathlib import Path
import tarfile,sqlite3,tempfile,json,hashlib
p=Path(__file__).resolve().parents[2]/'artifacts'
def unpack(name):
 with tarfile.open(p/name) as t:return {m.name:t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
before=unpack('article-receive-userdata-before.tar');after=unpack('article-receive-userdata-after.tar')
with tempfile.TemporaryDirectory() as tmp:
 paths=[Path(tmp)/'before.db',Path(tmp)/'after.db']
 for path,data in zip(paths,[before,after]):path.write_bytes(data['databases/podjs.sqlite'])
 dbs=[sqlite3.connect(f'file:{path}?immutable=1',uri=True) for path in paths]
 oldtables=[r[0] for r in dbs[0].execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")];counts={}
 for table in oldtables:
  quoted='"'+table.replace('"','""')+'"';rows=[db.execute('SELECT * FROM '+quoted+' ORDER BY rowid').fetchall() for db in dbs];assert rows[0]==rows[1],f'Changed existing table {table}';counts[table]=len(rows[0])
 newtables=[r[0] for r in dbs[1].execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") if r[0] not in oldtables]
 assert {'article_reading_state','article_sync_content','sync_local_identity','sync_article_ids','sync_saved_states'}<=set(newtables)
 integrity=dbs[1].execute('PRAGMA integrity_check').fetchone()[0];assert integrity=='ok'
 for db in dbs:db.close()
kv='files/podjs/podjs-kv.json';oldkv,newkv=json.loads(before[kv]),json.loads(after[kv])
changed=[k for k in set(oldkv)|set(newkv) if oldkv.get(k)!=newkv.get(k)]
assert changed==['page'] and oldkv['page']=='saved' and newkv['page']=='home',f'Unexpected KV changes: {changed}'
files=[k for k in before if k.startswith('files/podjs/files/')]
for name in files:assert after.get(name)==before[name],f'Changed file {name}'
result={'existingTableRowsUnchanged':counts,'addedTables':newtables,'onlyKvChange':{'key':'page','before':'saved','after':'home','reason':'existing app startup selects home'},'otherKvUnchanged':True,'existingFileCountUnchanged':len(files),'integrity':integrity,'beforeBackupSha256':hashlib.sha256((p/'article-receive-userdata-before.tar').read_bytes()).hexdigest(),'afterBackupSha256':hashlib.sha256((p/'article-receive-userdata-after.tar').read_bytes()).hexdigest()}
(p/'article-receive-data-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
