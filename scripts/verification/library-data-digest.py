#!/usr/bin/env python3
"""Summarize a stopped application's data archive without printing content."""
from pathlib import Path
import tarfile,sqlite3,hashlib,json,base64,argparse,tempfile
parser=argparse.ArgumentParser();parser.add_argument('archive');parser.add_argument('output');args=parser.parse_args()
with tarfile.open(args.archive) as tar,tempfile.TemporaryDirectory() as temp:
 files={}
 for member in tar.getmembers():
  if not member.isfile():continue
  name=member.name.removeprefix('./')
  data=tar.extractfile(member).read();files[name]=hashlib.sha256(data).hexdigest()
  if name in ['databases/podjs.sqlite','databases/podjs.sqlite-journal','databases/podjs.sqlite-wal','databases/podjs.sqlite-shm']:(Path(temp)/Path(name).name).write_bytes(data)
 db=sqlite3.connect(Path(temp)/'podjs.sqlite');tables={}
 for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
  columns=[r[1] for r in db.execute('PRAGMA table_info("'+table.replace('"','""')+'")')];rows=db.execute('SELECT * FROM "'+table.replace('"','""')+'"').fetchall();encoded=sorted(json.dumps(row,ensure_ascii=True,separators=(',',':'),default=lambda v:{'base64':base64.b64encode(v).decode()}) for row in rows);tables[table]={'columns':columns,'rows':len(rows),'sha256':hashlib.sha256('\n'.join(encoded).encode()).hexdigest()}
 Path(args.output).write_text(json.dumps({'archiveSha256':hashlib.sha256(Path(args.archive).read_bytes()).hexdigest(),'files':files,'tables':tables},indent=2)+'\n');print('Digest saved:',len(files),'files,',len(tables),'tables')
