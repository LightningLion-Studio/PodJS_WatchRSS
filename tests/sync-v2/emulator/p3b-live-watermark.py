#!/usr/bin/env python3
"""Only this isolated P3B synthetic author's durable reservation floor."""
import json,sys,os
from pathlib import Path
os.umask(0o077)
fixture=json.loads(Path('/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/integration-p3b/watch.json').read_text())
p=Path(sys.argv[1]);value={'deviceId':fixture['deviceId'],'sequence':'0'}
if p.exists():
 old=json.loads(p.read_text());assert old['deviceId']==value['deviceId'];value=old
if len(sys.argv)>2 and Path(sys.argv[2]).exists():
 for event in json.loads(Path(sys.argv[2]).read_text()):
  if event.get('phase')=='author-reserved' and int(event['deviceSequence'])>int(value['sequence']):value['sequence']=event['deviceSequence']
p.parent.mkdir(parents=True,exist_ok=True);temp=p.with_suffix('.pending')
with temp.open('w') as out:out.write(json.dumps(value,indent=2)+'\n');out.flush();os.fsync(out.fileno())
temp.chmod(0o600);os.replace(temp,p)
fd=os.open(p.parent,os.O_RDONLY)
try:os.fsync(fd)
finally:os.close(fd)
