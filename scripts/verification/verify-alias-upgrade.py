#!/usr/bin/env python3
"""Compare stopped main-app backups, allowing only the documented identity migration."""
from pathlib import Path
import tarfile, sqlite3, tempfile, json, hashlib, uuid
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts'
def unpack(name):
 with tarfile.open(OUT/name) as archive:
  return {m.name:archive.extractfile(m).read() for m in archive.getmembers() if m.isfile()}
def open_db(data, directory):
 directory.mkdir()
 for name,raw in data.items():
  if name.startswith('databases/'):
   (directory/Path(name).name).write_bytes(raw)
 return sqlite3.connect(directory/'podjs.sqlite')
before=unpack('alias-userdata-before.tar');after=unpack('alias-userdata-after.tar')
with tempfile.TemporaryDirectory() as directory:
 dbs=[open_db(data,Path(directory)/str(i)) for i,data in enumerate([before,after])]
 tables=lambda db:[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
 oldtables=tables(dbs[0]);counts={}
 for table in oldtables:
  rows=[db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall() for db in dbs]
  if table=='sync_local_identity':
   assert rows[0]==[], 'This audit expects the captured pre-upgrade empty identity table'
   identity=rows[1]
   assert len(identity)==1
  else:
   assert rows[0]==rows[1],f'Existing table changed: {table}'
   counts[table]=len(rows[0])
 columns=[r[1] for r in dbs[1].execute('PRAGMA table_info(sync_local_identity)')]
 identity=dict(zip(columns,identity[0]))
 device=identity['device_id'];assert str(uuid.UUID(device,version=4))==device
 newtables=[t for t in tables(dbs[1]) if t not in oldtables]
 assert set(newtables)=={'sync_article_aliases','article_saved_entry_times'}
 for table in newtables:assert dbs[1].execute('SELECT COUNT(*) FROM '+table).fetchone()[0]==0
 assert dbs[1].execute('PRAGMA integrity_check').fetchone()[0]=='ok'
 for db in dbs:db.close()
kv='files/podjs/podjs-kv.json';oldkv=json.loads(before[kv]);newkv=json.loads(after[kv])
changes={k:{'before':oldkv.get(k),'after':newkv.get(k)} for k in set(oldkv)|set(newkv) if oldkv.get(k)!=newkv.get(k)}
assert not changes or (set(changes)=={'page'} and changes['page']['after']=='home'), changes
oldfiles={k:v for k,v in before.items() if k.startswith('files/') and k!=kv}
newfiles={k:v for k,v in after.items() if k.startswith('files/') and k!=kv}
assert oldfiles==newfiles, 'Persistent files changed'
result={'existingTablesUnchanged':counts,'newTables':newtables,'createdIdentity':identity,'kvChanges':changes,'persistentFilesUnchanged':len(oldfiles),'integrity':'ok','limitation':'Installed main article tables were empty; populated upgrade and rollback were tested separately.', 'backups':{name:hashlib.sha256((OUT/name).read_bytes()).hexdigest() for name in ['alias-userdata-before.tar','alias-userdata-after.tar']}}
(OUT/'alias-data-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
