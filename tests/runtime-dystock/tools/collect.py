#!/usr/bin/env python3
"""Collect only closed native diagnostics; stop on the first detail event or account backoff."""
import json,re,subprocess,time,sys
from pathlib import Path
ROOT=Path(sys.argv[1]).resolve()
ADB='/home/wilf/Android/Sdk/platform-tools/adb'
SERIAL='emulator-5560'
PATTERN=re.compile(r'^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+[IWEFD]\s+(DYBENCH|PodMediaCache|PodVideoTiming|PodVideoFailure)\s*:\s*(.*)$')
BACKOFF=re.compile(r'(?:http_status|httpStatus)=(?:403|429)\b|category=http_(?:403|429)\b|challenge=(?:true|1)\b|error_code=(?:challenge|cooldown|forbidden)\b')
def stop_reason(message):
 fields=dict(re.findall(r'([A-Za-z_]+)=([^\s]+)',message))
 if fields.get('code')=='douyin_request' and fields.get('category')=='detail':return 'detail_request'
 if BACKOFF.search(message):return 'account_backoff'
 return None

def collect():
 if (ROOT/'ABORT.json').exists():
  print('STOPPED: prior abort retained; collector was not started',flush=True)
  return
 proc=subprocess.Popen([ADB,'-s',SERIAL,'logcat','-v','epoch','-T','1','DYBENCH:I','PodMediaCache:I','PodVideoTiming:I','PodVideoFailure:I','*:S'],stdout=subprocess.PIPE,text=True)
 try:
  with (ROOT/'events.jsonl').open('a',buffering=1) as output:
   for line in proc.stdout:
    match=PATTERN.match(line)
    if not match:continue
    epoch,pid,tid,tag,message=match.groups()
    try:phase=json.loads((ROOT/'phase.json').read_text())
    except (FileNotFoundError,json.JSONDecodeError):phase={'run':0,'phase':'setup'}
    phase.setdefault('action',phase.get('phase','unlabelled'))
    row={'epoch':float(epoch),'host_monotonic':time.monotonic(),'pid':int(pid),'tid':int(tid),'tag':tag,'message':message,**phase}
    output.write(json.dumps(row,separators=(',',':'))+'\n')
    reason=stop_reason(message)
    if reason:
     (ROOT/'ABORT.json').write_text(json.dumps({'reason':reason,'action':row['action'],'account_backoff':bool(BACKOFF.search(message)),'event':row},indent=2)+'\n')
     subprocess.run([ADB,'-s',SERIAL,'shell','am','force-stop','com.lightningstudio.watchrss.podjs'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
     print('STOPPED: '+reason+'; action='+str(row['action'])+'; no more Douyin requests',flush=True)
     break
 finally:
  proc.terminate()
  try:proc.wait(timeout=5)
  except subprocess.TimeoutExpired:proc.kill()

if __name__=='__main__':collect()
