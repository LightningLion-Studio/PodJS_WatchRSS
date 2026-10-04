#!/usr/bin/env python3
import subprocess,json,time
from pathlib import Path
out=Path(__file__).resolve().parents[2]/'artifacts'
def watch(*a):return subprocess.check_output(['adb','-s','e3aca8af',*a],text=True).strip()
def state():return json.loads(watch('shell','run-as','dev.podjs.tests.syncstate','cat','files/podjs/podjs-kv.json'))
end=time.monotonic()+25
while time.monotonic()<end:
 r=state().get('note-peer-result',{})
 if r.get('phase')=='listening':break
 if r.get('state')=='failed':raise RuntimeError(r)
 time.sleep(.25)
else:raise RuntimeError('Listener observation expired; inspect existing guest')
address=watch('shell','settings','get','secure','bluetooth_address');assert address not in ['','null']
with (out/'note-peer-phone.log').open('w') as log:
 client=subprocess.Popen(['adb','-s','RFCX70EGH6K','shell','am','instrument','-w','-e','class','dev.podjs.runtime.WatchRssNotePeerTest','-e','watchAddress',address,'dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner'],stdout=log,stderr=subprocess.STDOUT)
 print('Phone instrumentation running',client.pid,flush=True)
 client.wait(timeout=180)
assert client.returncode==0 and 'OK (1 test)' in (out/'note-peer-phone.log').read_text(),(out/'note-peer-phone.log').read_text()[-2500:]
end=time.monotonic()+25
while time.monotonic()<end:
 v=state();r=v.get('note-peer-result',{})
 if r.get('state') in ['passed','failed']:
  (out/'note-peer-guest-kv.json').write_text(json.dumps(v,ensure_ascii=True)+'\n');print(r,flush=True);assert r['state']=='passed';break
 time.sleep(.25)
else:raise RuntimeError('Guest completion observation expired; inspect existing process')
