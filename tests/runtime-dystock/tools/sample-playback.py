#!/usr/bin/env python3
import subprocess,json,time,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
result=subprocess.run(['/home/wilf/Android/Sdk/platform-tools/adb','-s','emulator-5560','shell','dumpsys','activity','provider','com.lightningstudio.watchrss.podjs/com.lightningstudio.watchrss.debug.DebugLogProvider','--douyin-playback'],capture_output=True,text=True,timeout=12)
output={'sampled_at':time.time(),'slots':[],'available':False}
for line in result.stdout.splitlines():
 line=line.strip()
 if line.startswith('Slots=['):
  try:slots=json.loads(line[6:])
  except json.JSONDecodeError:continue
  allowed=['role','bound','state','positionMs','durationMs','width','height','prewarming','presented','hasRenderedFirstFrame','targetBufferBytes']
  output['slots']=[{k:slot[k] for k in allowed if k in slot} for slot in slots];output['available']=True
if len(sys.argv)>2:(root/sys.argv[2]).write_text(json.dumps(output,indent=2)+'\n')
print(json.dumps(output))
