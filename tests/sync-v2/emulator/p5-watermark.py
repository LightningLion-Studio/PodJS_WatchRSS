"""Retain only public synthetic-author counters across owned emulator runs."""
import hashlib,json,os,re,sys
from pathlib import Path
fixture,target,received,archive=map(Path,sys.argv[1:])
f=json.loads(fixture.read_text());assert f['syntheticOnly'] is True and f['platform']=='watch'
expected=hashlib.sha256(json.dumps([f['scope'],f['deviceId'],f['signingKey']['publicKeyBase64Url']],sort_keys=True,separators=(',',':')).encode()).hexdigest()
archive.mkdir(parents=True,exist_ok=True)
def read(p):
 try:
  v=json.loads(p.read_text());assert re.fullmatch('[a-f0-9]{64}',v['author']) and re.fullmatch('(0|[1-9][0-9]{0,19})',v['sequence']) and int(v['sequence'])<=18446744073709551615
  return {'author':v['author'],'sequence':v['sequence']}
 except (OSError,ValueError,KeyError,AssertionError,TypeError):return None
def write(p,v):
 p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix('.next');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as out:json.dump(v,out);out.flush();os.fsync(out.fileno())
 os.replace(tmp,p);fd=os.open(p.parent,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
for p in [target,received,archive/(expected+'.json')]:
 v=read(p)
 if v:
  destination=target if v['author']==expected else archive/(v['author']+'.json');old=read(destination)
  if old is None or old['author']!=v['author'] or int(v['sequence'])>int(old['sequence']):write(destination,v)
if target.exists() and (read(target) is None or read(target)['author']!=expected):target.unlink()
